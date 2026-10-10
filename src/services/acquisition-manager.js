"use strict";

const crypto = require("crypto");
const net = require("net");
const dns = require("dns").promises;
const { URL } = require("url");
const { fetch: undiciFetch, Agent } = require("undici");
const cheerio = require("cheerio");

function ipv4Number(value) { return String(value).split(".").reduce((n, part) => (n * 256n) + BigInt(Number(part)), 0n); }
function ipv4In(address, network, bits) { const mask = (0xffffffffn << BigInt(32 - bits)) & 0xffffffffn; return (ipv4Number(address) & mask) === (ipv4Number(network) & mask); }
function ipv6Number(address) {
  let value = String(address).toLowerCase();
  const ipv4Tail = value.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Tail && net.isIP(ipv4Tail[1]) === 4) {
    const parts = ipv4Tail[1].split(".").map(Number);
    const high = ((parts[0] << 8) | parts[1]).toString(16), low = ((parts[2] << 8) | parts[3]).toString(16);
    value = value.slice(0, -ipv4Tail[1].length) + `${high}:${low}`;
  }
  const pieces = value.split("::");
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(":") : []; const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((pieces.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(pieces.length === 2 ? missing : 0).fill("0"), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[a-f0-9]{1,4}$/.test(group))) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(parseInt(group, 16)), 0n);
}
function ipv6In(address, network, bits) {
  const value = ipv6Number(address), base = ipv6Number(network);
  if (value == null || base == null) return false;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return (value & mask) === (base & mask);
}
const TRACKING = /^(utm_[^=]+|fbclid|gclid|mc_cid|mc_eid)$/i;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error("Operation cancelled."), { code: "OPERATION_CANCELLED" }));
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(Object.assign(new Error("Operation cancelled."), { code: "OPERATION_CANCELLED" })); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
function retryDelay(response, attempt, maxRetryAfterMs = 5000) {
  const header = response?.headers?.get?.("retry-after");
  if (header) {
    const seconds = Number(header);
    const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(parsed) && parsed >= 0) return parsed > maxRetryAfterMs ? null : parsed;
  }
  return 150 * 2 ** attempt + Math.random() * 100;
}
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonicalUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (!/^https?:$/.test(u.protocol)) return "";
    if (u.username || u.password) return "";
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
    u.hostname = u.hostname.toLowerCase();
    return u.pathname === "/" && !u.search ? u.origin : u.href;
  } catch { return ""; }
}
function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } }
function isPrivateAddress(address) {
  let value = String(address || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local")) return true;
  if (value === "metadata.google.internal" || value === "metadata.azure.internal" || value === "168.63.129.16") return true;
  if (value.startsWith("::ffff:")) {
    const tail = value.slice(7);
    if (net.isIP(tail) === 4) value = tail;
    else {
      const groups = tail.split(":");
      if (groups.length >= 2) { const hex = groups.slice(-2).map(x => parseInt(x, 16)); value = `${hex[0] >> 8}.${hex[0] & 255}.${hex[1] >> 8}.${hex[1] & 255}`; }
    }
  }
  if (net.isIP(value) === 4) {
    const blocked = [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]];
    return blocked.some(([network, bits]) => ipv4In(value, network, bits));
  }
  if (net.isIP(value) === 6) {
    const blocked = [["::", 96],["fc00::",7],["fe80::",10],["ff00::",8],["100::",64],["2001::",23],["2001:db8::",32],["2001:20::",28],["2002::",16],["3fff::",20],["64:ff9b::",96]];
    return blocked.some(([network, bits]) => ipv6In(value, network, bits));
  }
  return false;
}
function createSafeLookup(resolve = dns.lookup) {
  return (hostname, options, callback) => {
    const opts = typeof options === "function" ? {} : (options || {});
    const cb = typeof options === "function" ? options : callback;
    Promise.resolve().then(() => resolve(hostname, { all: true, verbatim: true })).then(rows => {
      const addresses = (Array.isArray(rows) ? rows : rows ? [rows] : []).filter(row => row && net.isIP(row.address));
      if (!addresses.length) throw Object.assign(new Error("DNS returned no usable address."), { code: "DNS_LOOKUP_FAILED" });
      if (addresses.some(row => isPrivateAddress(row.address))) throw Object.assign(new Error("DNS resolved to a prohibited private or reserved address."), { code: "SSRF_BLOCKED" });
      const preferred = opts.family ? addresses.filter(row => row.family === opts.family) : addresses;
      const list = preferred.length ? preferred : addresses;
      if (opts.all) cb(null, list.map(row => ({ address: row.address, family: row.family })));
      else cb(null, list[0].address, list[0].family);
    }).catch(error => cb(error));
  };
}
function retryable(status) { return status === 408 || status === 425 || status === 429 || status >= 500; }
function parseFeed(xml, feedUrl) {
  const $ = cheerio.load(String(xml || ""), { xmlMode: true, decodeEntities: true });
  const atom = /<feed[\s>]/i.test(String(xml || ""));
  const title = String($(atom ? "feed > title" : "channel > title").first().text() || "").replace(/\s+/g, " ").trim().slice(0, 240);
  const items = [];
  $(atom ? "feed > entry" : "channel > item").each((index, el) => {
    if (index >= 100) return false;
    const item = $(el); let href = "";
    if (atom) { const candidates = item.find("link[href]").toArray(); const link = candidates.find(x => !$(x).attr("rel") || $(x).attr("rel") === "alternate") || candidates[0]; href = link ? $(link).attr("href") : ""; }
    else href = item.children("link").first().text() || item.find("guid[isPermaLink='true']").first().text();
    try { href = canonicalUrl(new URL(String(href || ""), feedUrl).href); } catch { href = ""; }
    if (!href) return;
    const content = item.children("description").first().text() || item.find("content\\:encoded, content").first().text() || item.children("summary").first().text();
    const desc = cheerio.load(String(content || "")).root().text().replace(/\s+/g, " ").trim().slice(0, 1200);
    const date = String(item.children("pubDate, published, updated, dc\\:date").first().text() || "").trim();
    const author = String(item.children("author, dc\\:creator").first().text() || item.find("author > name").first().text() || "").trim().slice(0, 160);
    items.push({ url: href, title: String(item.children("title").first().text() || href).replace(/\s+/g, " ").trim().slice(0, 240), description: desc, publishedAt: date || null, author: author || null, feedUrl });
  });
  return { title, feedUrl, type: atom ? "atom" : "rss", items };
}

const SEARCH_STOP = new Set("a an and are as at be by for from how in is it of on or the to was were what when where which who why with does do did can could should would".split(" "));
function searchTokens(value) { return [...new Set((String(value || "").toLowerCase().match(/[a-z0-9]{2,}/g) || []).filter(token => !SEARCH_STOP.has(token)))]; }
function percentileValue(values, q) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]; }
function rankSearchCandidates(query, rows, limit = 8) {
  const queryTokens = searchTokens(query);
  const latestIntent = /\b(latest|recent|today|current|newest|news|this week|this month)\b/i.test(String(query || ""));
  const unique = new Map();
  for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
    const url = canonicalUrl(row?.canonicalUrl || row?.url); if (!url || unique.has(url)) continue;
    const title = searchTokens(row.title), snippet = searchTokens(row.snippet || row.description);
    const titleMatches = queryTokens.filter(token => title.includes(token));
    const snippetMatches = queryTokens.filter(token => snippet.includes(token));
    const titleCoverage = titleMatches.length / Math.max(1, queryTokens.length);
    const snippetCoverage = snippetMatches.length / Math.max(1, queryTokens.length);
    let score = 10 * titleCoverage + 5 * snippetCoverage + 2 / Math.max(1, Number(row.rank) || index + 1);
    const parsed = new URL(url), depth = parsed.pathname.split("/").filter(Boolean).length;
    score -= Math.min(1.5, depth * 0.12) + Math.min(1.2, parsed.searchParams.size * 0.3);
    const priorQuality = Number(row.extractionQuality ?? row.previousExtractionQuality);
    if (Number.isFinite(priorQuality)) score += Math.max(-1, Math.min(1, (priorQuality - 0.5) * 2));
    const sourceQuality = Number(row.sourceQuality);
    if (Number.isFinite(sourceQuality)) score += Math.max(-1, Math.min(1, (sourceQuality - 0.5) * 2));
    const duplicateRisk = Number(row.duplicateProbability);
    if (Number.isFinite(duplicateRisk)) score -= Math.max(0, Math.min(1, duplicateRisk)) * 2;
    const retryHistory = Number(row.retryCount ?? row.retryHistory);
    if (Number.isFinite(retryHistory)) score -= Math.min(1.5, Math.max(0, retryHistory) * 0.3);
    const fetchCost = Number(row.fetchCostMs);
    if (Number.isFinite(fetchCost)) score -= Math.min(1.5, Math.max(0, fetchCost) / 5000);
    const infoGain = Number(row.expectedInformationGain);
    if (Number.isFinite(infoGain)) score += Math.max(0, Math.min(1, infoGain)) * 1.5;
    if (/\.(?:gov|edu)$/i.test(parsed.hostname)) score += 0.25; // small source-type hint, never a credibility claim
    if (latestIntent && row.publishedAt) {
      const ageDays = (Date.now() - Date.parse(row.publishedAt)) / 86400000;
      if (Number.isFinite(ageDays)) score += ageDays <= 30 ? 1 : ageDays <= 365 ? 0.25 : -Math.min(1, Math.max(0, (ageDays - 365) / 3650));
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    unique.set(url, { ...row, url, canonicalUrl: url, _score: score, _host: host, _queryTokens: [...new Set([...titleMatches, ...snippetMatches])] });
  }
  const pool = [...unique.values()], selected = [], hostCounts = new Map(), covered = new Set();
  const max = Math.max(1, Math.min(40, Number(limit) || 8));
  while (pool.length && selected.length < max) {
    let bestIndex = 0, bestUtility = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const item = pool[i], newTerms = item._queryTokens.filter(token => !covered.has(token)).length;
      const diversity = (hostCounts.get(item._host) || 0) === 0 ? 1.1 : -0.7 * hostCounts.get(item._host);
      const utility = item._score + diversity + Math.min(1.5, newTerms * 0.35);
      if (utility > bestUtility) { bestUtility = utility; bestIndex = i; }
    }
    const [item] = pool.splice(bestIndex, 1); hostCounts.set(item._host, (hostCounts.get(item._host) || 0) + 1); item._queryTokens.forEach(token => covered.add(token));
    selected.push({ ...item, relevanceScore: Math.round(item._score * 100) / 100, selectionUtility: Math.round(bestUtility * 100) / 100 });
  }
  return selected.map(({ _score, _host, _queryTokens, ...item }) => item);
}

class HostLimiter {
  constructor(limit) { this.limit = Math.max(1, limit); this.active = 0; this.waiters = []; }
  async run(fn, signal) {
    if (signal?.aborted) throw Object.assign(new Error("Operation cancelled."), { code: "OPERATION_CANCELLED" });
    if (this.active >= this.limit) await new Promise((resolve, reject) => {
      const waiter = { resolve: () => { signal?.removeEventListener("abort", onAbort); resolve(); }, reject };
      const onAbort = () => { this.waiters = this.waiters.filter(x => x !== waiter); reject(Object.assign(new Error("Operation cancelled."), { code: "OPERATION_CANCELLED" })); };
      this.waiters.push(waiter); signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (signal?.aborted) throw Object.assign(new Error("Operation cancelled."), { code: "OPERATION_CANCELLED" });
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
    this.dnsLookup = opts.dnsLookup || dns.lookup;
    this.assertPublicUrl = opts.assertPublicUrl || (async url => this._assertPublicUrl(url));
    this.userAgent = opts.userAgent || "VeyraAcquisition/1.0 (+https://github.com/HomekidChud/VeyraServer)";
    this.timeoutMs = Math.max(1000, Number(opts.timeoutMs || 12000));
    this.maxBytes = Math.max(64 * 1024, Number(opts.maxBytes || 4 * 1024 * 1024));
    this.maxRedirects = Math.max(0, Number(opts.maxRedirects ?? 5));
    this.maxRetries = Math.max(0, Number(opts.maxRetries ?? 2));
    this.perHostConcurrency = Math.max(1, Number(opts.perHostConcurrency || 4));
    this.globalConcurrency = Math.max(1, Math.min(256, Number(opts.globalConcurrency) || 16));
    this.cacheTtlMs = Math.max(0, Number(opts.cacheTtlMs ?? 15 * 60 * 1000));
    this.cacheMax = Math.max(10, Number(opts.cacheMax || 500));
    this.persistence = opts.persistence || null;
    this.searchFirstDeadlineMs = Math.max(250, Math.min(120000, Number(opts.searchFirstDeadlineMs) || 20000));
    this.cache = new Map();
    this.robots = new Map();
    this.hosts = new Map();
    this.globalLimiter = new HostLimiter(this.globalConcurrency);
    this.inflight = new Map();
    this.records = new Map();
    this.recordedErrors = new WeakSet();
    this.startedAt = Date.now();
    this.stats = { requests: 0, completedRequests: 0, successfulHttpResponses: 0, httpFailures: 0, retries: 0, timeouts: 0, cancellations: 0, redirects: 0, cacheHits: 0, persistentCacheHits: 0, conditionalHits: 0, cacheWrites: 0, bytes: 0, errors: 0, blocked: 0, documentsExtracted: 0, lowInformationExtractions: 0, emptyExtractions: 0, challengePages: 0, consentPages: 0, extractionFailures: 0, extractionCount: 0, extractionDurationMs: 0, extractionSamplesMs: [], duplicates: 0, feedsDiscovered: 0, byEngine: {}, errorsByCode: {}, recentErrors: [] };
    this.safeLookup = createSafeLookup(this.dnsLookup);
    this.dispatcher = opts.dispatcher || new Agent({ connections: Math.max(2, this.perHostConcurrency), pipelining: 1, keepAliveTimeout: 10_000, connect: { lookup: this.safeLookup } });
  }
  _limiter(host) { if (!this.hosts.has(host)) this.hosts.set(host, new HostLimiter(this.perHostConcurrency)); return this.hosts.get(host); }
  _record(engine, patch = {}) { this.stats.byEngine[engine] = (this.stats.byEngine[engine] || 0) + 1; return { engine, ...patch }; }
  _error(error, url = "") {
    if (error && typeof error === "object") { if (this.recordedErrors.has(error)) return; this.recordedErrors.add(error); }
    this.stats.errors += 1;
    const code = String(error?.code || error?.name || "ACQUISITION_ERROR").replace(/[^A-Za-z0-9_:-]/g, "_").slice(0, 80);
    this.stats.errorsByCode[code] = (this.stats.errorsByCode[code] || 0) + 1;
    const message = error?.status ? `HTTP ${Number(error.status)}` : `Acquisition failed (${code})`;
    this.stats.recentErrors.push({ code, message, host: hostOf(url) });
    if (this.stats.recentErrors.length > 20) this.stats.recentErrors.shift();
  }
  async _assertPublicUrl(url) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error("Only HTTP(S) URLs are permitted."), { code: "INVALID_URL" });
    if (isPrivateAddress(u.hostname)) throw Object.assign(new Error("Private, loopback, link-local, and metadata addresses are blocked."), { code: "SSRF_BLOCKED" });
    const addresses = await this.dnsLookup(u.hostname, { all: true, verbatim: true });
    if (addresses.some(row => isPrivateAddress(row.address))) throw Object.assign(new Error("The URL resolves to a private or link-local address."), { code: "SSRF_BLOCKED" });
    return addresses;
  }
  async _robotsAllowed(url, signal) {
    const u = new URL(url), key = u.origin;
    let rules = this.robots.get(key);
    if (!rules) {
      try {
        const response = await this._request(`${u.origin}/robots.txt`, { engine: "robots", maxBytes: 256 * 1024, retries: 0, skipRobots: true, signal });
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
      if (opts.signal?.aborted) throw Object.assign(new Error("Operation cancelled."), { code: "OPERATION_CANCELLED" });
      if (visited.has(url)) throw new Error("Redirect loop detected."); visited.add(url);
      await this.assertPublicUrl(url);
      const host = hostOf(url);
      const outcome = await this._limiter(host).run(() => this.globalLimiter.run(async () => {
        let lastError;
        for (let attempt = 0; attempt <= (opts.retries ?? this.maxRetries); attempt += 1) {
          const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), opts.timeoutMs || this.timeoutMs);
          const onAbort = () => controller.abort();
          if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
          try {
            this.stats.requests += 1;
            const response = await this.fetchImpl(url, { dispatcher: this.dispatcher, redirect: "manual", signal: controller.signal, headers: { "User-Agent": this.userAgent, Accept: opts.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.1", "Accept-Encoding": "gzip, deflate, br", ...(opts.headers || {}) } });
            clearTimeout(timer);
            if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
            this.stats.completedRequests += 1;
            if (response.status >= 200 && response.status < 300 || response.status === 304) this.stats.successfulHttpResponses += 1;
            if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
              this.stats.redirects += 1;
              const next = canonicalUrl(new URL(response.headers.get("location"), url).href); if (!next) throw new Error("Invalid redirect target.");
              return { redirect: next };
            }
            if (response.status === 304) {
              return { ok: true, status: 304, url, finalUrl: url, redirectChain, body: Buffer.alloc(0), contentType: String(response.headers.get("content-type") || ""), etag: response.headers.get("etag") || "", lastModified: response.headers.get("last-modified") || "", cacheControl: response.headers.get("cache-control") || "", headers: response.headers, engine: opts.engine || "direct-http" };
            }
            const type = String(response.headers.get("content-type") || "").toLowerCase();
            if (response.status < 200 || response.status >= 300) {
              this.stats.httpFailures += 1;
              if (!retryable(response.status) || attempt >= (opts.retries ?? this.maxRetries)) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
              const delay = retryDelay(response, attempt, opts.maxRetryAfterMs ?? 5000);
              if (delay == null) throw Object.assign(new Error(`HTTP ${response.status}; Retry-After exceeds the configured retry budget.`), { status: response.status, noRetry: true });
              this.stats.retries += 1;
              await sleep(delay, opts.signal); continue;
            }
            if (!opts.allowBinary && type && !/(html|xhtml|text\/|json|xml|rss|atom|javascript|css|svg)/i.test(type)) throw Object.assign(new Error(`Unsupported content type: ${type}`), { code: "CONTENT_TYPE_UNSUPPORTED", status: response.status });
            const chunks = []; let bytes = 0; for await (const chunk of response.body) { bytes += chunk.length; if (bytes > (opts.maxBytes || this.maxBytes)) throw Object.assign(new Error("Response exceeds the configured size limit."), { code: "RESPONSE_TOO_LARGE" }); chunks.push(Buffer.from(chunk)); }
            const body = Buffer.concat(chunks); this.stats.bytes += body.length;
            return { ok: true, status: response.status, url, finalUrl: url, redirectChain, body, contentType: type, etag: response.headers.get("etag") || "", lastModified: response.headers.get("last-modified") || "", cacheControl: response.headers.get("cache-control") || "", headers: response.headers, engine: opts.engine || "direct-http" };
          } catch (error) {
            clearTimeout(timer); if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
            if (opts.signal?.aborted || controller.signal.aborted && error?.name === "AbortError") { const code = opts.signal?.aborted ? "OPERATION_CANCELLED" : "FETCH_TIMEOUT"; this.stats[code === "FETCH_TIMEOUT" ? "timeouts" : "cancellations"] += 1; throw Object.assign(new Error("Operation cancelled or timed out."), { code, cause: error }); }
            lastError = error;
            if (attempt >= (opts.retries ?? this.maxRetries) || error.noRetry || error.code === "SSRF_BLOCKED" || error.code === "CONTENT_TYPE_UNSUPPORTED") break;
            this.stats.retries += 1;
            await sleep(150 * 2 ** attempt + Math.random() * 100, opts.signal);
          }
        }
        if (lastError) { this._error(lastError, url); throw lastError; }
      }, opts.signal), opts.signal);
      if (outcome?.redirect) { redirectChain.push(url); url = outcome.redirect; continue; }
      return outcome;
    }
    throw new Error("Too many redirects.");
  }
  async fetch(url, opts = {}) {
    const key = canonicalUrl(url); if (!key) throw Object.assign(new Error("Invalid HTTP(S) URL."), { code: "INVALID_URL" });
    const method = String(opts.method || "GET").toUpperCase();
    const requestHeaders = opts.headers || {};
    const sensitiveQuery = [...new URL(key).searchParams.keys()].some(name => /(?:token|secret|password|session|signature|credential|authorization|accesskey|api[_-]?key|(?:^|[_-])key(?:$|[_-])|(?:^|[_-])sig(?:$|[_-])|^(?:auth|code|jwt)$)/i.test(name));
    const userSpecific = !!opts.private || !!opts.sessionId || sensitiveQuery || Object.keys(requestHeaders).some(name => /^(authorization|cookie|proxy-authorization)$/i.test(name));
    const canCache = method === "GET" && !opts.noCache && !userSpecific;
    const canCoalesce = canCache && !opts.signal;
    let cached = canCache ? this.cache.get(key) : null;
    if (!cached && canCache && this.persistence?.getProxyCache) {
      let persisted = null;
      try { persisted = await this.persistence.getProxyCache(`acquisition:v1:${key}`); } catch {}
      if (persisted?.response?.body) {
        const result = { ...persisted.response, etag: persisted.etag || persisted.response.etag || "", lastModified: persisted.lastModified || persisted.response.lastModified || "", cacheControl: persisted.response.cacheControl || "" };
        cached = { result, expiresAt: Number(persisted.expiresAtMs || (Number(persisted.time || Date.now()) + this.cacheTtlMs)), hash: hash(result.body), persistent: true };
        this.cache.set(key, cached);
      }
    }
    if (cached && cached.expiresAt > Date.now() && !opts.revalidate) { this.stats.cacheHits += 1; if (cached.persistent) this.stats.persistentCacheHits += 1; return { ...cached.result, cacheHit: true, engine: "cache" }; }
    if (canCoalesce && this.inflight.has(key)) return this.inflight.get(key);
    const work = (async () => {
      if (!opts.skipRobots) { const policy = await this._robotsAllowed(key, opts.signal); if (!policy.allowed) { this.stats.blocked += 1; throw Object.assign(new Error("robots.txt disallows this URL."), { code: "ROBOTS_DISALLOWED" }); } }
      const headers = { ...(opts.headers || {}) }; if (cached?.result?.etag) headers["If-None-Match"] = cached.result.etag; if (cached?.result?.lastModified) headers["If-Modified-Since"] = cached.result.lastModified;
      let result;
      try { result = await this._request(key, { ...opts, headers }); }
      catch (e) { this._error(e, key); this.records.set(key, { url: key, lastAttempted: Date.now(), status: "failed", error: e.code || e.message }); throw e; }
      if (result.status === 304 && cached) { this.stats.conditionalHits += 1; result = { ...cached.result, cacheHit: true, revalidated: true }; }
      const cacheControl = String(result.cacheControl || "").toLowerCase();
      const vary = String(result.headers?.get?.("vary") || "").trim();
      const hasSetCookie = !!result.headers?.get?.("set-cookie");
      const varySensitive = vary === "*" || /(?:^|,)\s*(?:cookie|authorization)\s*(?:,|$)/i.test(vary);
      const responseCacheable = canCache && this.cacheTtlMs > 0 && !/\b(?:no-store|private)\b/.test(cacheControl) && !varySensitive && !hasSetCookie;
      const contentHash = hash(result.body);
      if (responseCacheable) {
        const directive = cacheControl.match(/(?:s-maxage|max-age)\s*=\s*"?(\d+)/i);
        const ttl = /\bno-cache\b/.test(cacheControl) ? 0 : directive ? Math.min(this.cacheTtlMs, Number(directive[1]) * 1000) : this.cacheTtlMs;
        const entry = { result, expiresAt: Date.now() + ttl, hash: contentHash }; this.cache.set(key, entry); while (this.cache.size > this.cacheMax) this.cache.delete(this.cache.keys().next().value);
        if (ttl > 0 && this.persistence?.putProxyCache) {
          const persistentResult = { ...result, ok: true, body: result.body, status: result.status, finalUrl: result.finalUrl || key };
          try { void Promise.resolve(this.persistence.putProxyCache(`acquisition:v1:${key}`, persistentResult, { url: key, ttlMs: ttl })).then(() => { this.stats.cacheWrites += 1; }).catch(() => {}); } catch {}
        } else if (ttl === 0 && this.persistence?.deleteProxyCache) { try { void Promise.resolve(this.persistence.deleteProxyCache(`acquisition:v1:${key}`)).catch(() => {}); } catch {} }
      } else if (canCache) {
        this.cache.delete(key);
        if (this.persistence?.deleteProxyCache) { try { void Promise.resolve(this.persistence.deleteProxyCache(`acquisition:v1:${key}`)).catch(() => {}); } catch {} }
      }
      this.records.set(key, { url: key, lastAttempted: Date.now(), lastSuccessful: Date.now(), etag: result.etag, lastModified: result.lastModified, contentHash, status: "complete", engine: opts.engine || "direct-http" });
      return this._record(opts.engine || "direct-http", result);
    })();
    if (canCoalesce) this.inflight.set(key, work);
    try { return await work; } finally { if (canCoalesce && this.inflight.get(key) === work) this.inflight.delete(key); }
  }
  parseDocument(body, url) {
    const extractionStartedAt = Date.now();
    const html = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || ""); const $ = cheerio.load(html, { decodeEntities: true });
    const title = String($("title").first().text() || $("h1").first().text() || "").replace(/\s+/g, " ").trim().slice(0, 240);
    const meta = name => String($(`meta[name='${name}'],meta[property='${name}']`).first().attr("content") || "").replace(/\s+/g, " ").trim().slice(0, 1000);
    const description = meta("description") || meta("og:description");
    const author = meta("author") || meta("article:author");
    const publishedAt = meta("article:published_time") || meta("datePublished") || meta("date");
    const language = String($("html").attr("lang") || meta("og:locale") || "").slice(0, 32);
    const canonical = canonicalUrl($("link[rel='canonical']").attr("href") ? new URL($("link[rel='canonical']").attr("href"), url).href : url);
    const links = []; $("a[href]").each((i, el) => { if (i >= 200) return false; try { const value = canonicalUrl(new URL($(el).attr("href"), url).href); if (value) links.push(value); } catch {} });
    const headings = $("h1,h2,h3").toArray().slice(0, 60).map(el => $(el).text().replace(/\s+/g, " ").trim()).filter(Boolean).map(x => x.slice(0, 240));
    const feedLinks = $("link[rel~='alternate'][type*='rss'],link[rel~='alternate'][type*='atom']").toArray().slice(0, 8).map(el => { try { return canonicalUrl(new URL($(el).attr("href"), url).href); } catch { return ""; } }).filter(Boolean);
    const jsonLd = []; $("script[type='application/ld+json']").each((i, el) => { if (i < 8) try { jsonLd.push(JSON.parse($(el).text())); } catch {} });
    $("script,style,noscript,svg,template,nav,header,footer,aside,form").remove();
    const extractedText = $.root().text().replace(/\s+/g, " ").trim().slice(0, 90000);
    const pageSignals = `${title} ${description} ${extractedText}`.toLowerCase();
    const extractionStatus = /before you continue to|consent\.google\.com|consent required/.test(pageSignals) ? "consent" : /captcha|unusual traffic|verify (?:that )?you are human|checking your browser|just a moment\.\.\.|automated requests|attention required|cloudflare ray id/.test(pageSignals) ? "challenge" : extractedText.length ? (extractedText.length < 120 ? "low-information" : "extracted") : "empty";
    const text = extractionStatus === "challenge" || extractionStatus === "consent" ? "" : extractedText;
    this.stats.extractionCount += 1;
    if (extractionStatus === "extracted") this.stats.documentsExtracted += 1;
    else if (extractionStatus === "low-information") this.stats.lowInformationExtractions += 1;
    else if (extractionStatus === "empty") this.stats.emptyExtractions += 1;
    else { this.stats.extractionFailures += 1; this.stats[extractionStatus === "challenge" ? "challengePages" : "consentPages"] += 1; }
    const extractionMs = Date.now() - extractionStartedAt;
    this.stats.extractionDurationMs += extractionMs;
    this.stats.extractionSamplesMs = [...this.stats.extractionSamplesMs, extractionMs].slice(-100);
    return { url, canonical, title, description, author: author || null, publishedAt: publishedAt || null, language: language || null, headings, text, links: [...new Set(links)], feedLinks, jsonLd, extractionStatus, contentHash: hash(text) };
  }
  async discoverSitemaps(seedUrl, opts = {}) {
    const seed = canonicalUrl(seedUrl); if (!seed) return [];
    const maxFiles = Math.max(1, Math.min(100, Number(opts.maxFiles) || 20));
    const maxUrls = Math.max(1, Math.min(10000, Number(opts.maxUrls) || 1000));
    const policy = await this._robotsAllowed(seed, opts.signal).catch(() => ({ sitemaps: [] }));
    const queue = [...new Set([...(policy.sitemaps || []), `${new URL(seed).origin}/sitemap.xml`])];
    const visitedSitemaps = new Set(); const urls = new Set();
    while (queue.length && visitedSitemaps.size < maxFiles && urls.size < maxUrls) {
      if (opts.signal?.aborted) throw Object.assign(new Error("Operation cancelled."), { code: "OPERATION_CANCELLED" });
      const sitemapUrl = canonicalUrl(queue.shift()); if (!sitemapUrl || visitedSitemaps.has(sitemapUrl)) continue;
      visitedSitemaps.add(sitemapUrl);
      let response; try { response = await this.fetch(sitemapUrl, { engine: "sitemap", maxBytes: 2 * 1024 * 1024, signal: opts.signal }); } catch (e) { if (e.code === "OPERATION_CANCELLED") throw e; continue; }
      const xml = response.body.toString("utf8"); const $ = cheerio.load(xml, { xmlMode: true });
      const isIndex = /<sitemapindex(?:\s|>)/i.test(xml);
      const locations = $(isIndex ? "sitemap > loc" : "url > loc").toArray().map(el => canonicalUrl($(el).text().trim())).filter(Boolean);
      for (const location of locations) {
        if (isIndex) { if (!visitedSitemaps.has(location) && !queue.includes(location) && queue.length + visitedSitemaps.size < maxFiles) queue.push(location); }
        else { urls.add(location); if (urls.size >= maxUrls) break; }
      }
    }
    return [...urls].filter(url => url !== seed).slice(0, maxUrls);
  }
  async discoverFeeds(seedUrl, opts = {}) {
    const seed = canonicalUrl(seedUrl); if (!seed) return { feeds: [], items: [] };
    let page; try { page = await this.fetch(seed, { engine: "feed-discovery", maxBytes: opts.maxPageBytes || 1024 * 1024, signal: opts.signal }); }
    catch (error) { return { feeds: [], items: [], error: error.code || "FEED_DISCOVERY_FAILED" }; }
    const parsedPage = this.parseDocument(page.body, page.finalUrl || seed);
    const candidates = [...new Set(parsedPage.feedLinks || [])].slice(0, Math.max(1, Math.min(8, Number(opts.maxFeeds) || 4)));
    const feeds = [];
    for (const feedUrl of candidates) {
      if (opts.signal?.aborted) throw Object.assign(new Error("Operation cancelled."), { code: "OPERATION_CANCELLED" });
      try {
        const response = await this.fetch(feedUrl, { engine: "feed", accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.1", maxBytes: opts.maxFeedBytes || 2 * 1024 * 1024, signal: opts.signal });
        const feed = parseFeed(response.body.toString("utf8"), response.finalUrl || feedUrl);
        if (feed.items.length) { feeds.push(feed); this.stats.feedsDiscovered += feed.items.length; }
      } catch (error) { if (error.code === "OPERATION_CANCELLED") throw error; }
    }
    return { feeds, items: feeds.flatMap(feed => feed.items).slice(0, opts.maxItems || 100), page: { url: parsedPage.url, title: parsedPage.title } };
  }
  async searchFirst(query, search, opts = {}) {
    const startedAt = Date.now(), deadlineMs = Math.max(250, Math.min(120000, Number(opts.deadlineMs) || this.searchFirstDeadlineMs));
    const controller = new AbortController(); let callerCancelled = false, deadlineExpired = false, timeToFirstPageMs = null;
    const abortForCaller = () => { callerCancelled = true; controller.abort(); };
    if (opts.signal?.aborted) abortForCaller(); else opts.signal?.addEventListener("abort", abortForCaller, { once: true });
    const deadlineTimer = setTimeout(() => { deadlineExpired = true; controller.abort(); }, deadlineMs);
    try {
    const result = await search(query, { lang: opts.lang || "en", offset: Math.max(0, Number(opts.offset) || 0), limit: Math.max(1, Math.min(50, Number(opts.limit) || 20)), signal: controller.signal });
    const rows = Array.isArray(result?.results) ? result.results : [];
    const uniqueCount = new Set(rows.map(row => canonicalUrl(row?.canonicalUrl || row?.url)).filter(Boolean)).size;
    this.stats.duplicates += Math.max(0, rows.length - uniqueCount);
    const candidates = rankSearchCandidates(query, rows, opts.fetchLimit || opts.limit || 8).map(row => [row.url, row]);
    const settled = await Promise.allSettled(candidates.map(async ([url, source]) => {
      const fetchStartedAt = Date.now();
      const page = await this.fetch(url, { engine: "search-first", signal: controller.signal });
      const document = this.parseDocument(page.body, page.finalUrl || url);
      if (timeToFirstPageMs == null) timeToFirstPageMs = Date.now() - startedAt;
      return { ...document, source: { url: source.url, provider: source.source || source.provider || result.provider || null, providers: source.providers || [], rank: source.rank || null }, engine: page.engine, fetchDurationMs: Date.now() - fetchStartedAt, fetchedAt: new Date().toISOString() };
    }));
    const pages = settled.filter(item => item.status === "fulfilled").map(item => item.value);
    const failed = settled.filter(item => item.status === "rejected");
    return { query, provider: result?.provider || "none", candidates: rows, selectedCandidates: candidates.map(([, row]) => ({ url: row.url, provider: row.source || row.provider || null, relevanceScore: row.relevanceScore, selectionUtility: row.selectionUtility })), pages, cancelled: callerCancelled, deadlineExceeded: deadlineExpired, metrics: { candidates: rows.length, uniqueCandidates: uniqueCount, selectedCandidates: candidates.length, fetched: pages.length, extracted: pages.filter(page => page.extractionStatus === "extracted").length, empty: pages.filter(page => page.extractionStatus === "empty").length, lowInformation: pages.filter(page => page.extractionStatus === "low-information").length, challenges: pages.filter(page => page.extractionStatus === "challenge").length, consentPages: pages.filter(page => page.extractionStatus === "consent").length, failed: failed.length, cacheHits: pages.filter(page => page.engine === "cache").length, averageSelectedRelevance: candidates.length ? Math.round(candidates.reduce((sum, [, row]) => sum + row.relevanceScore, 0) / candidates.length * 100) / 100 : 0, searchLatencyMs: Number(result?.responseTimeMs) || null, timeToFirstPageMs, endToEndMs: Date.now() - startedAt, deadlineMs, callerCancelled, deadlineExpired } };
    } finally { clearTimeout(deadlineTimer); opts.signal?.removeEventListener("abort", abortForCaller); }
  }
  report() { const limiters = [...this.hosts.values()], uptimeMs = Math.max(1, Date.now() - this.startedAt), { extractionSamplesMs, ...metrics } = this.stats; return { ...metrics, uptimeMs, requestThroughputPerSecond: Math.round(metrics.completedRequests / (uptimeMs / 1000) * 100) / 100, cacheHitRate: Math.round((metrics.cacheHits / Math.max(1, metrics.cacheHits + metrics.completedRequests)) * 1000) / 1000, averageExtractionMs: metrics.extractionCount ? Math.round(metrics.extractionDurationMs / metrics.extractionCount * 100) / 100 : null, extractionP50Ms: percentileValue(extractionSamplesMs, 0.5), extractionP95Ms: percentileValue(extractionSamplesMs, 0.95), extractionSampleCount: extractionSamplesMs.length, memoryRssBytes: process.memoryUsage().rss, searchFirstDeadlineMs: this.searchFirstDeadlineMs, cacheEntries: this.cache.size, records: this.records.size, hosts: this.hosts.size, inflight: this.inflight.size, activeRequests: limiters.reduce((n, host) => n + host.active, 0), queuedRequests: limiters.reduce((n, host) => n + host.waiters.length, 0), activeGlobalRequests: this.globalLimiter.active, queuedGlobalRequests: this.globalLimiter.waiters.length, robotsEntries: this.robots.size, limits: { perHostConcurrency: this.perHostConcurrency, globalConcurrency: this.globalConcurrency, timeoutMs: this.timeoutMs, maxBytes: this.maxBytes, maxRedirects: this.maxRedirects, maxRetries: this.maxRetries }, persistentCache: !!this.persistence?.enabled, chromiumEnabled: false, fetchMode: "direct-http" }; }
}

module.exports = { AcquisitionManager, canonicalUrl, isPrivateAddress, parseFeed, rankSearchCandidates, createSafeLookup };
