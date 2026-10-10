"use strict";

const crypto = require("crypto");
const net = require("net");
const dns = require("dns").promises;
const { URL } = require("url");
const { fetch: undiciFetch, Agent } = require("undici");
const cheerio = require("cheerio");

const PRIVATE_V4 = /^(?:0|10|127|169\.254|192\.0\.2|198\.51\.100|203\.0\.113|224|240)(?:\.|$)|^172\.(?:1[6-9]|2\d|3[01])\.|^192\.168\./;
const TRACKING = /^(utm_[^=]+|fbclid|gclid|mc_cid|mc_eid|ref|source)$/i;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonicalUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (!/^https?:$/.test(u.protocol)) return "";
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
    u.hostname = u.hostname.toLowerCase();
    return u.href.replace(/\/$/, "");
  } catch { return ""; }
}
function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } }
function isPrivateAddress(address) {
  const value = String(address || "").replace(/^::ffff:/i, "");
  if (value === "localhost" || PRIVATE_V4.test(value)) return true;
  if (net.isIP(value) === 6) {
    const normalized = value.toLowerCase();
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || /^(?:fe[89ab]):/i.test(normalized) || normalized.startsWith("2001:db8:");
  }
  return false;
}
function retryable(status) { return status === 408 || status === 425 || status === 429 || status >= 500; }

class HostLimiter {
  constructor(limit) { this.limit = Math.max(1, limit); this.active = 0; this.waiters = []; }
  async run(fn) {
    if (this.active >= this.limit) await new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    this.active += 1;
    try { return await fn(); } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next.resolve();
    }
  }
}

class AcquisitionManager {
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || undiciFetch;
    this.assertPublicUrl = opts.assertPublicUrl || (async url => this._assertPublicUrl(url));
    this.userAgent = opts.userAgent || "VeyraAcquisition/1.0 (+https://github.com/HomekidChud/VeyraServer)";
    this.timeoutMs = Math.max(1000, Number(opts.timeoutMs || 12000));
    this.maxBytes = Math.max(64 * 1024, Number(opts.maxBytes || 4 * 1024 * 1024));
    this.maxRedirects = Math.max(0, Number(opts.maxRedirects ?? 5));
    this.maxRetries = Math.max(0, Number(opts.maxRetries ?? 2));
    this.perHostConcurrency = Math.max(1, Number(opts.perHostConcurrency || 4));
    this.cacheTtlMs = Math.max(0, Number(opts.cacheTtlMs ?? 15 * 60 * 1000));
    this.cacheMax = Math.max(10, Number(opts.cacheMax || 500));
    this.cache = new Map();
    this.robots = new Map();
    this.hosts = new Map();
    this.inflight = new Map();
    this.records = new Map();
    this.stats = { requests: 0, cacheHits: 0, conditionalHits: 0, bytes: 0, errors: 0, blocked: 0, byEngine: {}, errorsByCode: {}, recentErrors: [] };
    this.dispatcher = opts.dispatcher || new Agent({ connections: Math.max(2, this.perHostConcurrency), pipelining: 1, keepAliveTimeout: 10_000 });
  }
  _limiter(host) { if (!this.hosts.has(host)) this.hosts.set(host, new HostLimiter(this.perHostConcurrency)); return this.hosts.get(host); }
  _record(engine, patch = {}) { this.stats.byEngine[engine] = (this.stats.byEngine[engine] || 0) + 1; return { engine, ...patch }; }
  _error(error, url = "") {
    const code = String(error?.code || error?.name || "ACQUISITION_ERROR").slice(0, 80);
    this.stats.errorsByCode[code] = (this.stats.errorsByCode[code] || 0) + 1;
    this.stats.recentErrors.push({ code, message: String(error?.message || error || "Acquisition failed").slice(0, 180), host: hostOf(url) });
    if (this.stats.recentErrors.length > 20) this.stats.recentErrors.shift();
  }
  async _assertPublicUrl(url) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error("Only HTTP(S) URLs are permitted."), { code: "INVALID_URL" });
    if (isPrivateAddress(u.hostname)) throw Object.assign(new Error("Private, loopback, link-local, and metadata addresses are blocked."), { code: "SSRF_BLOCKED" });
    const addresses = await dns.lookup(u.hostname, { all: true, verbatim: true });
    if (addresses.some(row => isPrivateAddress(row.address))) throw Object.assign(new Error("The URL resolves to a private or link-local address."), { code: "SSRF_BLOCKED" });
  }
  async _robotsAllowed(url) {
    const u = new URL(url), key = u.origin;
    let rules = this.robots.get(key);
    if (!rules) {
      try {
        const response = await this._request(`${u.origin}/robots.txt`, { engine: "robots", maxBytes: 256 * 1024, retries: 0, skipRobots: true });
        rules = this._parseRobots(response.body.toString("utf8"));
      } catch { rules = { allows: () => true, sitemaps: [] }; }
      this.robots.set(key, rules);
    }
    return { allowed: rules.allows(u.pathname + u.search), sitemaps: rules.sitemaps };
  }
  _parseRobots(text) {
    let applies = false; const disallow = []; const allow = []; const sitemaps = [];
    for (const line of String(text).split(/\r?\n/)) {
      const [rawKey, ...rest] = line.split(":"); const key = String(rawKey || "").trim().toLowerCase(); const value = rest.join(":").trim();
      if (key === "user-agent") applies = value === "*" || /veyra/i.test(value);
      else if (applies && key === "disallow" && value) disallow.push(value);
      else if (applies && key === "allow" && value) allow.push(value);
      else if (key === "sitemap" && canonicalUrl(value)) sitemaps.push(canonicalUrl(value));
    }
    return { sitemaps, allows(path) { if (!applies) return true; const denied = disallow.filter(x => path.startsWith(x)).sort((a, b) => b.length - a.length)[0]; const permitted = allow.filter(x => path.startsWith(x)).sort((a, b) => b.length - a.length)[0]; return !denied || !!(permitted && permitted.length >= denied.length); } };
  }
  async _request(rawUrl, opts = {}) {
    let url = canonicalUrl(rawUrl); if (!url) throw Object.assign(new Error("Invalid HTTP(S) URL."), { code: "INVALID_URL" });
    const visited = new Set(); let redirectChain = [];
    for (let redirect = 0; redirect <= this.maxRedirects; redirect += 1) {
      if (visited.has(url)) throw new Error("Redirect loop detected."); visited.add(url);
      await this.assertPublicUrl(url);
      const host = hostOf(url);
      const outcome = await this._limiter(host).run(async () => {
        let lastError;
        for (let attempt = 0; attempt <= (opts.retries ?? this.maxRetries); attempt += 1) {
          const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), opts.timeoutMs || this.timeoutMs);
          try {
            this.stats.requests += 1;
            const response = await this.fetchImpl(url, { dispatcher: this.dispatcher, redirect: "manual", signal: controller.signal, headers: { "User-Agent": this.userAgent, Accept: opts.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.1", "Accept-Encoding": "gzip, deflate, br", ...(opts.headers || {}) } });
            clearTimeout(timer);
            if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
              const next = canonicalUrl(new URL(response.headers.get("location"), url).href); if (!next) throw new Error("Invalid redirect target.");
              return { redirect: next };
            }
            if (response.status === 304) {
              return { ok: true, status: 304, url, finalUrl: url, redirectChain, body: Buffer.alloc(0), contentType: String(response.headers.get("content-type") || ""), etag: response.headers.get("etag") || "", lastModified: response.headers.get("last-modified") || "", cacheControl: response.headers.get("cache-control") || "", headers: response.headers, engine: opts.engine || "direct-http" };
            }
            const type = String(response.headers.get("content-type") || "").toLowerCase();
            if (response.status < 200 || response.status >= 300) { if (!retryable(response.status) || attempt >= (opts.retries ?? this.maxRetries)) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status }); await sleep(150 * 2 ** attempt + Math.random() * 100); continue; }
            if (!opts.allowBinary && type && !/(html|xhtml|text\/|json|xml|rss|atom|javascript|css|svg)/i.test(type)) throw Object.assign(new Error(`Unsupported content type: ${type}`), { code: "CONTENT_TYPE_UNSUPPORTED", status: response.status });
            const chunks = []; let bytes = 0; for await (const chunk of response.body) { bytes += chunk.length; if (bytes > (opts.maxBytes || this.maxBytes)) throw Object.assign(new Error("Response exceeds the configured size limit."), { code: "RESPONSE_TOO_LARGE" }); chunks.push(Buffer.from(chunk)); }
            const body = Buffer.concat(chunks); this.stats.bytes += body.length;
            return { ok: true, status: response.status, url, finalUrl: url, redirectChain, body, contentType: type, etag: response.headers.get("etag") || "", lastModified: response.headers.get("last-modified") || "", cacheControl: response.headers.get("cache-control") || "", headers: response.headers, engine: opts.engine || "direct-http" };
          } catch (error) { clearTimeout(timer); lastError = error; if (attempt >= (opts.retries ?? this.maxRetries) || error.code === "SSRF_BLOCKED" || error.code === "CONTENT_TYPE_UNSUPPORTED") break; await sleep(150 * 2 ** attempt + Math.random() * 100); }
        }
        if (lastError) { this.stats.errors += 1; this._error(lastError, url); throw lastError; }
      });
      if (outcome?.redirect) { redirectChain.push(url); url = outcome.redirect; continue; }
      return outcome;
    }
    throw new Error("Too many redirects.");
  }
  async fetch(url, opts = {}) {
    const key = canonicalUrl(url); if (!key) throw Object.assign(new Error("Invalid HTTP(S) URL."), { code: "INVALID_URL" });
    const cached = !opts.noCache ? this.cache.get(key) : null;
    if (cached && cached.expiresAt > Date.now() && !opts.revalidate) { this.stats.cacheHits += 1; return { ...cached.result, cacheHit: true, engine: "cache" }; }
    if (this.inflight.has(key)) return this.inflight.get(key);
    const work = (async () => {
      if (!opts.skipRobots) { const policy = await this._robotsAllowed(key); if (!policy.allowed) { this.stats.blocked += 1; throw Object.assign(new Error("robots.txt disallows this URL."), { code: "ROBOTS_DISALLOWED" }); } }
      const headers = { ...(opts.headers || {}) }; if (cached?.result?.etag) headers["If-None-Match"] = cached.result.etag; if (cached?.result?.lastModified) headers["If-Modified-Since"] = cached.result.lastModified;
      let result;
      try { result = await this._request(key, { ...opts, headers }); }
      catch (e) { this._error(e, key); this.records.set(key, { url: key, lastAttempted: Date.now(), status: "failed", error: e.code || e.message }); throw e; }
      if (result.status === 304 && cached) { this.stats.conditionalHits += 1; result = { ...cached.result, cacheHit: true, revalidated: true }; }
      const entry = { result, expiresAt: Date.now() + this.cacheTtlMs, hash: hash(result.body) }; this.cache.set(key, entry); while (this.cache.size > this.cacheMax) this.cache.delete(this.cache.keys().next().value);
      this.records.set(key, { url: key, lastAttempted: Date.now(), lastSuccessful: Date.now(), etag: result.etag, lastModified: result.lastModified, contentHash: entry.hash, status: "complete", engine: opts.engine || "direct-http" });
      return this._record(opts.engine || "direct-http", result);
    })();
    this.inflight.set(key, work); try { return await work; } finally { this.inflight.delete(key); }
  }
  parseDocument(body, url) {
    const html = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || ""); const $ = cheerio.load(html, { decodeEntities: true });
    const title = String($("title").first().text() || $("h1").first().text() || "").replace(/\s+/g, " ").trim().slice(0, 240);
    const canonical = canonicalUrl($("link[rel='canonical']").attr("href") ? new URL($("link[rel='canonical']").attr("href"), url).href : url);
    const links = []; $("a[href]").each((i, el) => { if (i >= 200) return false; try { const value = canonicalUrl(new URL($(el).attr("href"), url).href); if (value) links.push(value); } catch {} });
    $("script,style,noscript,svg,template,nav,header,footer,aside,form").remove();
    const text = $.root().text().replace(/\s+/g, " ").trim().slice(0, 90000);
    const jsonLd = []; $("script[type='application/ld+json']").each((i, el) => { if (i < 8) try { jsonLd.push(JSON.parse($(el).text())); } catch {} });
    return { url, canonical, title, text, links: [...new Set(links)], jsonLd, contentHash: hash(text) };
  }
  async discoverSitemaps(seedUrl, opts = {}) {
    const seed = canonicalUrl(seedUrl); if (!seed) return [];
    const policy = await this._robotsAllowed(seed).catch(() => ({ sitemaps: [] })); const candidates = [...new Set([...(policy.sitemaps || []), `${new URL(seed).origin}/sitemap.xml`])]; const found = new Set(); const queue = candidates.slice(0, opts.maxFiles || 20);
    while (queue.length && found.size < (opts.maxUrls || 1000)) { const source = queue.shift(); if (found.has(source)) continue; found.add(source); let response; try { response = await this.fetch(source, { engine: "sitemap", maxBytes: 2 * 1024 * 1024 }); } catch { continue; } const xml = response.body.toString("utf8"); for (const match of xml.matchAll(/<loc[^>]*>\s*([^<]+)\s*<\/loc>/gi)) { const value = canonicalUrl(match[1]); if (!value) continue; if (/sitemap/i.test(xml.slice(Math.max(0, match.index - 100), match.index + 100))) queue.push(value); else if (found.size < (opts.maxUrls || 1000)) found.add(value); } }
    return [...found].filter(x => x !== seed).slice(0, opts.maxUrls || 1000);
  }
  async searchFirst(query, search, opts = {}) {
    const result = await search(query, { lang: opts.lang || "en" }); const rows = Array.isArray(result?.results) ? result.results : []; const urls = [...new Set(rows.map(row => canonicalUrl(row.url)).filter(Boolean))].slice(0, opts.limit || 8);
    const pages = await Promise.allSettled(urls.map(url => this.fetch(url, { engine: "search-first" }).then(page => ({ ...this.parseDocument(page.body, page.finalUrl), source: rows.find(row => canonicalUrl(row.url) === url) || null, engine: page.engine }))));
    return { query, provider: result?.provider || "none", candidates: rows, pages: pages.filter(x => x.status === "fulfilled").map(x => x.value), metrics: { candidates: rows.length, fetched: pages.filter(x => x.status === "fulfilled").length } };
  }
  report() { return { ...this.stats, cacheEntries: this.cache.size, records: this.records.size, hosts: this.hosts.size, inflight: this.inflight.size }; }
}

module.exports = { AcquisitionManager, canonicalUrl, isPrivateAddress };
