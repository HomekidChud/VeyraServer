const express = require("express");
const cors = require("cors");
const cheerio = require("cheerio");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const app = express();
const PORT = numberEnv("PORT", 10000, 1, 65535);

function numberEnv(name, fallback, min, max) {
  const raw = process.env[name];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
function floatEnv(name, fallback, min, max) {
  const raw = process.env[name];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function boolEnv(name, fallback) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}
function csvEnv(name, fallback = []) {
  const raw = String(process.env[name] ?? "").trim();
  return raw ? raw.split(",").map(x => x.trim()).filter(Boolean) : fallback;
}
function enumEnv(name, fallback, allowed) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  return allowed.includes(raw) ? raw : fallback;
}

const CFG = Object.freeze({
  processRole: enumEnv("PROCESS_ROLE", "web", ["web", "worker", "all"]),
  // CRAWLER_ROBOTS/CRAWLER_PER_HOST_CONCURRENCY are the preferred names.
  // Legacy MAX_GLOBAL_CONCURRENCY/MAX_PER_HOST_CONCURRENCY remain fallbacks.
  globalConcurrency: numberEnv("CRAWLER_ROBOTS", numberEnv("MAX_GLOBAL_CONCURRENCY", 12, 1, 64), 1, 64),
  perHostConcurrency: numberEnv("CRAWLER_PER_HOST_CONCURRENCY", numberEnv("MAX_PER_HOST_CONCURRENCY", 3, 1, 16), 1, 16),
  maxPendingQueue: numberEnv("MAX_PENDING_QUEUE", 1500, 50, 20000),
  maxPages: numberEnv("MAX_PAGES", 10000, 1, 100000),
  maxResources: numberEnv("MAX_RESOURCES", 20000, 1, 250000),
  maxLinks: numberEnv("MAX_LINKS", 100000, 100, 1000000),
  maxScanBytes: numberEnv("MAX_SCAN_BYTES", 512 * 1024 * 1024, 1024 * 1024, 8 * 1024 * 1024 * 1024),
  maxTextBytesPerResource: numberEnv("MAX_TEXT_BYTES_PER_RESOURCE", 2 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024),
  maxSourceFiles: numberEnv("MAX_SOURCE_FILES", 20000, 100, 250000),
  requestTimeoutMs: numberEnv("REQUEST_TIMEOUT_MS", 15000, 1000, 120000),
  bodyTimeoutMs: numberEnv("BODY_TIMEOUT_MS", 15000, 1000, 120000),
  dnsTimeoutMs: numberEnv("DNS_TIMEOUT_MS", 4000, 500, 30000),
  maxRedirects: numberEnv("MAX_REDIRECTS", 6, 0, 15),
  maxRetries: numberEnv("MAX_RETRIES", 2, 0, 5),
  retryBaseMs: numberEnv("RETRY_BASE_MS", 400, 50, 10000),
  hostBackoffMs: numberEnv("HOST_BACKOFF_MS", 1200, 100, 60000),
  maxHostBackoffMs: numberEnv("MAX_HOST_BACKOFF_MS", 30000, 1000, 300000),
  robotsTimeoutMs: numberEnv("ROBOTS_TIMEOUT_MS", 8000, 1000, 60000),
  sitemapTimeoutMs: numberEnv("SITEMAP_TIMEOUT_MS", 12000, 1000, 60000),
  maxSitemapFiles: numberEnv("MAX_SITEMAP_FILES", 50, 1, 1000),
  maxSitemapUrls: numberEnv("MAX_SITEMAP_URLS", 50000, 100, 500000),
  maxJobAgeMs: numberEnv("MAX_JOB_AGE_MS", 60 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000),
  proxyCacheMs: numberEnv("CACHE_TTL_MS", 10000, 0, 300000),
  maxProxyCacheEntries: numberEnv("MAX_CACHE_ENTRIES", 200, 10, 5000),
  searchCacheMs: numberEnv("SEARCH_CACHE_TTL_MS", 30000, 0, 600000),
  maxSearchCacheEntries: numberEnv("MAX_SEARCH_CACHE_ENTRIES", 100, 10, 5000),
  maxRequestLog: numberEnv("MAX_REQUEST_LOG", 500, 50, 5000),
  maxServerLog: numberEnv("MAX_SERVER_LOG", 800, 100, 10000),
  maxClientLog: numberEnv("MAX_CLIENT_LOG", 500, 50, 5000),
  maxSearchQueryChars: numberEnv("MAX_SEARCH_QUERY_CHARS", 256, 32, 1000),
  maxSearchResults: numberEnv("MAX_SEARCH_RESULTS", 20, 1, 50),
  maxProxyBodyBytes: numberEnv("MAX_PROXY_BODY_BYTES", 4 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024),
  maxProxyTextBytes: numberEnv("MAX_PROXY_TEXT_BYTES", 8 * 1024 * 1024, 256 * 1024, 32 * 1024 * 1024),
  maxProxyImageBytes: numberEnv("MAX_PROXY_IMAGE_BYTES", 16 * 1024 * 1024, 256 * 1024, 64 * 1024 * 1024),
  maxProxyMediaBytes: numberEnv("MAX_PROXY_MEDIA_BYTES", 32 * 1024 * 1024, 512 * 1024, 128 * 1024 * 1024),
  maxProxyOtherBytes: numberEnv("MAX_PROXY_OTHER_BYTES", 16 * 1024 * 1024, 256 * 1024, 64 * 1024 * 1024),
  maxFormBodyBytes: numberEnv("MAX_FORM_BODY_BYTES", 1 * 1024 * 1024, 16 * 1024, 8 * 1024 * 1024),
  userAgent: process.env.VEYRA_USER_AGENT || "VeyraBrowseCrawler/8.0 (+https://github.com/)",
  frontendOrigins: csvEnv("FRONTEND_ORIGIN", ["*"]),
  searchProvider: enumEnv("SEARCH_PROVIDER", "local", ["auto", "local", "brave", "bing", "custom", "none"]),
  searchEndpoint: process.env.SEARCH_ENDPOINT || "",
  searchApiKey: process.env.SEARCH_API_KEY || "",
  customSearchAuth: process.env.SEARCH_AUTH_HEADER || "",
  maxIndexDocs: numberEnv("MAX_INDEX_DOCS", 20000, 100, 100000),
  maxIndexTextChars: numberEnv("MAX_INDEX_TEXT_CHARS", 8000, 1000, 50000),
  maxSearchQueryTerms: numberEnv("MAX_SEARCH_QUERY_TERMS", 20, 1, 64),
  indexSeeds: csvEnv("INDEX_SEEDS", []),
  indexSeedCrawl: boolEnv("INDEX_SEED_CRAWL", true),
  indexRefreshMs: numberEnv("INDEX_REFRESH_MS", 6 * 60 * 60 * 1000, 0, 30 * 24 * 60 * 60 * 1000),
  indexSnapshotEnabled: boolEnv("INDEX_SNAPSHOT_ENABLED", false),
  indexSnapshotPath: process.env.INDEX_SNAPSHOT_PATH || "/tmp/veyra-search-index.json",
  processBrowserFallback: boolEnv("BROWSER_RENDER_FALLBACK", false),
  logLevel: enumEnv("SERVER_LOG_LEVEL", "info", ["error", "warn", "info", "debug"]),
  sortQueryParams: boolEnv("NORMALIZE_SORT_QUERY_PARAMS", false)
});

const allowedOrigins = CFG.frontendOrigins.includes("*") ? true : CFG.frontendOrigins;
app.use(cors({
  origin: allowedOrigins,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-Veyra-Request-ID"],
  exposedHeaders: ["X-Veyra-Request-ID", "X-Veyra-Canonical-URL", "X-Veyra-Challenge", "X-Veyra-Content-Type"]
}));
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false, limit: CFG.maxFormBodyBytes }));

const jobs = new Map();
const activeByRoot = new Map();
const proxyCache = new Map();
const searchCache = new Map();
const searchIndex = new Map();
const invertedIndex = new Map();
const termCounts = new Map();
const serverLogs = [];
const clientLogs = [];
const requestLog = [];
let requestLogSeq = 0;
let logSeq = 0;
const serverStartedAt = Date.now();
const ROOT = path.join("/tmp", "veyra-browse-jobs");
fs.mkdirSync(ROOT, { recursive: true });

const sourceStore = {
  async write(job, resourceId, text) {
    if (job.sourceFiles >= CFG.maxSourceFiles) return null;
    const remaining = Math.max(0, CFG.maxScanBytes - job.textBytesStored);
    if (!remaining) return null;
    const safe = String(text).slice(0, Math.min(CFG.maxTextBytesPerResource, remaining));
    const file = path.join(job.sourceDir, `${resourceId}.txt`);
    await fsp.writeFile(file, safe, "utf8");
    job.sourceFiles += 1;
    job.textBytesStored += Buffer.byteLength(safe);
    return file;
  },
  async read(job, resource) {
    if (!resource?.sourceFile) return resource?.inlinePreview || "";
    try { return await fsp.readFile(resource.sourceFile, "utf8"); }
    catch { return resource.inlinePreview || ""; }
  },
  async delete(job) {
    try { await fsp.rm(job.sourceDir, { recursive: true, force: true }); } catch {}
  }
};

function now() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function bytesLabel(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function severityRank(level) { return ({ error: 0, warn: 1, info: 2, debug: 3 })[level] ?? 2; }
function shouldLog(level) { return severityRank(level) <= severityRank(CFG.logLevel); }
function sanitizeLogUrl(value) {
  try {
    const u = new URL(value);
    u.username = "";
    u.password = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/token|key|auth|session|cookie|code|sig|signature|secret/i.test(key)) u.searchParams.set(key, "[redacted]");
    }
    return u.href.slice(0, 500);
  } catch { return String(value || "").slice(0, 500); }
}
function serverLog(level, component, message, meta = {}) {
  if (!shouldLog(level)) return;
  const entry = { id: ++logSeq, time: now(), level, component, message: String(message).slice(0, 2000), ...meta };
  serverLogs.push(entry);
  if (serverLogs.length > CFG.maxServerLog) serverLogs.splice(0, serverLogs.length - CFG.maxServerLog);
  if (level === "error") console.error(`[${entry.time}] [${level}] [${component}] ${entry.message}`);
  else if (level === "warn") console.warn(`[${entry.time}] [${level}] [${component}] ${entry.message}`);
  else if (level === "info") console.log(`[${entry.time}] [${level}] [${component}] ${entry.message}`);
}
function jobLog(job, level, message, meta = {}) {
  const entry = { id: ++job.logSeq, time: now(), level, message: String(message).slice(0, 2000), ...meta };
  job.logs.push(entry);
  if (job.logs.length > 250) job.logs.splice(0, job.logs.length - 250);
  serverLog(level, "CRAWLER", message, { jobId: job.id, ...meta });
}
function requestLogAdd(entry) {
  requestLog.push({ id: ++requestLogSeq, ...entry });
  if (requestLog.length > CFG.maxRequestLog) requestLog.splice(0, requestLog.length - CFG.maxRequestLog);
}
function clientLogAdd(entry) {
  clientLogs.push(entry);
  if (clientLogs.length > CFG.maxClientLog) clientLogs.splice(0, clientLogs.length - CFG.maxClientLog);
}

app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  const requestId = String(req.get("X-Veyra-Request-ID") || crypto.randomUUID()).slice(0, 80);
  req.veyraRequestId = requestId;
  res.setHeader("X-Veyra-Request-ID", requestId);
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const target = req.query?.url ? sanitizeLogUrl(req.query.url) : "";
    requestLogAdd({
      requestId,
      time: now(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Math.round(ms * 10) / 10,
      targetHost: target ? (() => { try { return new URL(target).hostname; } catch { return ""; } })() : ""
    });
  });
  next();
});

function respondError(res, status, message, code, extra = {}) {
  res.status(status).json({ error: String(message), code: String(code), ...extra });
}
function safeMethod(method) { return ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(String(method || "").toUpperCase()); }

// URL resolution and canonicalization.
function normalizedSearch(url) {
  const u = new URL(url);
  const tracking = /^(utm_[^=]+|fbclid|gclid|mc_cid|mc_eid|msclkid|yclid|dclid)$/i;
  for (const k of [...u.searchParams.keys()]) if (tracking.test(k)) u.searchParams.delete(k);
  if (CFG.sortQueryParams) {
    const pairs = [...u.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    u.search = "";
    for (const [k, v] of pairs) u.searchParams.append(k, v);
  }
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  u.hash = "";
  return u.href;
}
function normalizeUrl(value, base) {
  try {
    const u = new URL(String(value || ""), base);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return normalizedSearch(u.href);
  } catch { return null; }
}
function resolveNavigation(value, documentUrl) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw || /^(?:data|blob|mailto|javascript|tel|about):/i.test(raw)) return null;
  try {
    const u = new URL(raw, documentUrl);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.href;
  } catch { return null; }
}
function resolveResource(value, documentUrl) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.startsWith("#") || /^(?:data|blob|mailto|javascript|tel|about):/i.test(raw)) return null;
  return resolveNavigation(raw, documentUrl);
}
function makeViewUrl(url) { return `/api/view?url=${encodeURIComponent(url)}`; }
function makeResourceUrl(url, referrer = "") {
  const q = `/api/resource?url=${encodeURIComponent(url)}`;
  try {
    const r = new URL(referrer);
    return `${q}&from=${encodeURIComponent(`${r.origin}${r.pathname}`)}`;
  } catch { return q; }
}
function typeFor(url, hint = "") {
  const p = String(url).toLowerCase().split("?")[0];
  if (hint === "css" || /\.css$/i.test(p)) return "css";
  if (hint === "js" || /\.(?:js|mjs|cjs)$/i.test(p)) return "js";
  if (hint === "asset") return "asset";
  return "html";
}
function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}
function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } }
function pathOf(url) { try { const u = new URL(url); return `${u.pathname || "/"}${u.search || ""}`; } catch { return String(url || ""); } }
function linkKey(type, url) { return `${type}|${url}`; }

// Security / SSRF.
function ipv4Private(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
}
function ipv6Private(ip) {
  const x = ip.toLowerCase();
  return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || /^fe[89ab]/.test(x) || x.startsWith("::ffff:");
}
function assertIpPublic(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return !ipv4Private(ip);
  if (kind === 6) return !ipv6Private(ip);
  return true;
}
async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
    ]);
  } finally { clearTimeout(timer); }
}
async function assertPublicUrl(url) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error("Only HTTP(S) URLs are allowed.");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal") {
    throw new Error("Private/local destinations are blocked.");
  }
  if (net.isIP(host) && !assertIpPublic(host)) throw new Error("Private/local destinations are blocked.");
  const records = await withTimeout(dns.lookup(host, { all: true, verbatim: true }), CFG.dnsTimeoutMs, "DNS lookup timed out.");
  if (!records.length) throw new Error("Destination could not be resolved.");
  if (records.some(x => !assertIpPublic(x.address))) throw new Error("Private/local destinations are blocked.");
}

// HTTP fetching with streaming limits, validators, redirect re-validation, and controlled retries.
function retryableStatus(status) { return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504; }
function retryAfterMs(headers) {
  const raw = headers.get("retry-after");
  if (!raw) return 0;
  const n = Number(raw);
  if (Number.isFinite(n)) return Math.max(0, Math.min(30000, n * 1000));
  const t = Date.parse(raw);
  return Number.isFinite(t) ? Math.max(0, Math.min(30000, t - Date.now())) : 0;
}
function backoffMs(attempt, retryAfter = 0) {
  if (retryAfter) return retryAfter;
  return Math.min(10000, CFG.retryBaseMs * 2 ** attempt + Math.random() * CFG.retryBaseMs);
}
async function readBodyLimited(response, limit) {
  const len = Number(response.headers.get("content-length"));
  if (Number.isFinite(len) && len > limit) {
    try { await response.body?.cancel(); } catch {}
    return { body: Buffer.alloc(0), bytes: len, truncated: true, tooLarge: true };
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await withTimeout(response.arrayBuffer(), CFG.bodyTimeoutMs, "Response body timed out."));
    return { body: buf.subarray(0, limit), bytes: buf.length, truncated: buf.length > limit, tooLarge: buf.length > limit };
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await withTimeout(reader.read(), CFG.bodyTimeoutMs, "Response body timed out.");
    if (done) break;
    const chunk = Buffer.from(value);
    const keep = Math.max(0, Math.min(chunk.length, limit - total));
    if (keep) chunks.push(chunk.subarray(0, keep));
    total += chunk.length;
    if (total > limit) { truncated = true; try { await reader.cancel(); } catch {} break; }
  }
  return { body: Buffer.concat(chunks), bytes: total, truncated, tooLarge: truncated };
}
async function fetchBuffer(url, opts = {}) {
  let current = normalizeUrl(url);
  if (!current) throw new Error("Invalid HTTP(S) URL.");
  const maxRedirects = opts.maxRedirects ?? CFG.maxRedirects;
  const limit = opts.limit ?? CFG.maxTextBytesPerResource;
  const method = String(opts.method || "GET").toUpperCase();
  const headers = new Headers(opts.headers || {});
  headers.set("user-agent", opts.userAgent || CFG.userAgent);
  if (!headers.has("accept")) headers.set("accept", opts.accept || "text/html,application/xhtml+xml,application/xml,text/css,application/javascript,text/javascript,*/*;q=0.05");
  if (opts.range && !headers.has("range")) headers.set("range", String(opts.range).slice(0, 200));
  const redirectChain = [];
  let cached = opts.cached || null;
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    await assertPublicUrl(current);
    let lastError = null;
    let retriesUsed = 0;
    for (let attempt = 0; attempt <= (opts.retries ?? CFG.maxRetries); attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeout ?? CFG.requestTimeoutMs);
      try {
        const reqHeaders = new Headers(headers);
        if (cached?.etag) reqHeaders.set("if-none-match", cached.etag);
        if (cached?.lastModified) reqHeaders.set("if-modified-since", cached.lastModified);
        const response = await fetch(current, {
          method,
          headers: reqHeaders,
          redirect: "manual",
          signal: controller.signal,
          body: opts.body && method !== "GET" && method !== "HEAD" ? opts.body : undefined
        });
        clearTimeout(timer);
        if (response.status >= 300 && response.status < 400) {
          const loc = response.headers.get("location");
          if (!loc) throw new Error(`HTTP ${response.status} redirect without Location`);
          const next = resolveNavigation(loc, current);
          if (!next) throw new Error("Invalid redirect destination.");
          redirectChain.push({ url: current, status: response.status });
          current = next;
          cached = null;
          break;
        }
        if (response.status === 304 && cached) {
          return { ...cached.response, status: cached.response.status || 200, revalidated: true, redirectChain };
        }
        if (retryableStatus(response.status) && attempt < (opts.retries ?? CFG.maxRetries)) {
          lastError = new Error(`HTTP ${response.status}`);
          retriesUsed += 1;
          await sleep(backoffMs(attempt, retryAfterMs(response.headers)));
          continue;
        }
        const contentType = response.headers.get("content-type") || "";
        const bodyLimit = typeof opts.limitForContentType === "function" ? opts.limitForContentType(contentType, response.headers) : limit;
        const body = await readBodyLimited(response, bodyLimit);
        return {
          ok: response.ok,
          status: response.status,
          finalUrl: current,
          contentType,
          contentEncoding: response.headers.get("content-encoding") || "",
          cacheControl: response.headers.get("cache-control") || "",
          etag: response.headers.get("etag") || "",
          lastModified: response.headers.get("last-modified") || "",
          expires: response.headers.get("expires") || "",
          contentRange: response.headers.get("content-range") || "",
          acceptRanges: response.headers.get("accept-ranges") || "",
          contentLength: response.headers.get("content-length") || "",
          serverHeader: response.headers.get("server") || "",
          cfMitigated: response.headers.get("cf-mitigated") || "",
          xFrameOptions: response.headers.get("x-frame-options") || "",
          contentSecurityPolicy: response.headers.get("content-security-policy") || "",
          bytes: body.bytes,
          truncated: body.truncated,
          tooLarge: body.tooLarge,
          body: body.body,
          redirectChain,
          retries: retriesUsed
        };
      } catch (e) {
        clearTimeout(timer);
        lastError = e;
        const retryableError = attempt < (opts.retries ?? CFG.maxRetries);
        if (!retryableError) break;
        retriesUsed += 1;
        await sleep(backoffMs(attempt));
      }
    }
    if (lastError) throw lastError;
    if (redirect === maxRedirects) break;
  }
  throw new Error("Too many redirects.");
}
function cacheGet(map, key, ttl) {
  const item = map.get(key);
  if (!item) return null;
  if (ttl >= 0 && Date.now() - item.time > ttl) { map.delete(key); return null; }
  return item;
}
function cacheSet(map, key, value, maxEntries) {
  map.set(key, { time: Date.now(), ...value });
  while (map.size > maxEntries) map.delete(map.keys().next().value);
}
async function fetchCached(url, opts = {}) {
  const method = String(opts.method || "GET").toUpperCase();
  const referrerKey = String(opts.referrer || "");
  const key = `${method} ${normalizeUrl(url)} | ref=${referrerKey}`;
  const cachedEntry = opts.noCache || method !== "GET" ? null : proxyCache.get(key) || null;
  if (cachedEntry && Date.now() - cachedEntry.time <= CFG.proxyCacheMs && !opts.revalidate) {
    return { ...cachedEntry.response, cacheHit: true };
  }
  const result = await fetchBuffer(url, { ...opts, cached: cachedEntry && method === "GET" ? cachedEntry : null });
  if (!opts.noCache && method === "GET") {
    const noStore = /no-store/i.test(result.cacheControl || "");
    if (!noStore && !result.truncated && !result.tooLarge) {
      cacheSet(proxyCache, key, { response: result, etag: result.etag, lastModified: result.lastModified }, CFG.maxProxyCacheEntries);
    }
  }
  return result;
}

function statusRetryClass(status) {
  if (status === 429) return "throttled";
  if (status >= 500) return "server-error";
  if (status === 403) return "forbidden";
  if (status >= 400) return "client-error";
  return "ok";
}
function detectChallenge(body, contentType, status, headers = {}) {
  const ct = String(contentType || "").toLowerCase();
  if (!ct.includes("html") && !ct.includes("text/plain")) return null;
  const text = String(body || "").slice(0, 100000).toLowerCase();
  const signals = [
    /performing security verification/, /security verification/, /checking your browser/, /verify you are human/,
    /attention required!/, /captcha/, /cf-chl-/, /challenge-platform/, /just a moment/
  ].filter(re => re.test(text)).length;
  const titleLike = /<title>\s*(?:just a moment|attention required|security verification|verify you are human)/i.test(text);
  const headerSignal = /challenge/i.test(String(headers["cf-mitigated"] || "")) || /challenge/i.test(String(headers["server"] || ""));
  if (titleLike || (signals >= 2 && (status === 403 || status === 429 || status === 503 || text.length < 150000)) || (headerSignal && signals >= 1)) {
    return { type: "security-verification", status, signals };
  }
  return null;
}

// Priority frontier avoids array shift() re-indexing and supports bounded, per-host scheduling.
class PriorityFrontier {
  constructor(maxSize) { this.maxSize = maxSize; this.heap = []; this.seen = new Set(); }
  get size() { return this.heap.length; }
  add(item, priority, key) {
    if (this.heap.length >= this.maxSize || this.seen.has(key)) return false;
    this.seen.add(key);
    const node = { item, priority: Number(priority) || 0, seq: this.seen.size };
    this.heap.push(node); this.#up(this.heap.length - 1); return true;
  }
  takeNext(activeHosts, perHostLimit, hostCooldowns) {
    if (!this.heap.length) return null;
    const blocked = [];
    let selected = null;
    while (this.heap.length) {
      const node = this.#pop();
      const host = hostOf(node.item.url);
      const active = activeHosts.get(host) || 0;
      const cooldown = hostCooldowns.get(host) || 0;
      if (active < perHostLimit && cooldown <= Date.now()) { selected = node; break; }
      blocked.push(node);
    }
    for (const node of blocked) { this.heap.push(node); this.#up(this.heap.length - 1); }
    return selected?.item || null;
  }
  snapshot() { return this.heap.slice().sort((a,b) => b.priority - a.priority).map(x => x.item); }
  #greater(a, b) { return a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq); }
  #up(i) { while (i > 0) { const p = (i - 1) >> 1; if (!this.#greater(this.heap[i], this.heap[p])) break; [this.heap[i], this.heap[p]] = [this.heap[p], this.heap[i]]; i = p; } }
  #down(i) { for (;;) { const l = i * 2 + 1, r = l + 1; let best = i; if (l < this.heap.length && this.#greater(this.heap[l], this.heap[best])) best = l; if (r < this.heap.length && this.#greater(this.heap[r], this.heap[best])) best = r; if (best === i) break; [this.heap[i], this.heap[best]] = [this.heap[best], this.heap[i]]; i = best; } }
  #pop() { const top = this.heap[0], last = this.heap.pop(); if (this.heap.length) { this.heap[0] = last; this.#down(0); } return top; }
}
function pathDepth(url) { try { return new URL(url).pathname.split("/").filter(Boolean).length; } catch { return 0; } }
function crawlPriority(url, kind, reason = "discovered") {
  let score = kind === "html" ? 70 : 35;
  const depth = pathDepth(url);
  score -= Math.min(24, depth * 4);
  const u = new URL(url);
  if (reason === "root") score += 1000;
  if (reason === "sitemap") score += 250;
  if (reason === "canonical") score += 180;
  if (reason === "navigation") score += 100;
  if (u.searchParams.size) score -= Math.min(20, u.searchParams.size * 3);
  if (/(?:calendar|day|month|page)=[^&]+/i.test(u.search)) score -= 15;
  return score;
}

// Robots handling is conservative: use the most-specific matching user-agent group and support Crawl-delay.
function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":"); if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      const agent = value.toLowerCase();
      if (!current || current.closed) { current = { agents: [], allow: [], disallow: [], crawlDelayMs: 0, sitemaps: [], closed: false }; groups.push(current); }
      current.agents.push(agent);
    } else if (current) {
      if (key === "allow" && value) current.allow.push(value);
      else if (key === "disallow" && value) current.disallow.push(value);
      else if (key === "crawl-delay" && Number.isFinite(Number(value))) current.crawlDelayMs = Math.min(60000, Math.max(0, Number(value) * 1000));
      else if (key === "sitemap" && value) current.sitemaps.push(value);
    }
    if (key !== "user-agent") current.closed = true;
  }
  return groups;
}
function robotsMatchGroup(groups) {
  const agent = CFG.userAgent.toLowerCase();
  const exact = groups.filter(g => g.agents.some(a => a !== "*" && agent.includes(a))).sort((a,b) => b.agents.join("").length - a.agents.join("").length);
  if (exact.length) return exact[0];
  return groups.find(g => g.agents.includes("*")) || null;
}
function pathMatchesRule(pathname, rule) {
  if (!rule) return false;
  const escaped = String(rule).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  try { return new RegExp(`^${escaped}`).test(pathname); } catch { return false; }
}
function robotsAllowed(url, robots) {
  if (!robots) return true;
  try {
    const group = robots.group;
    if (!group) return true;
    const u = new URL(url);
    const target = `${u.pathname}${u.search}` || "/";
    const disallow = group.disallow.filter(Boolean).map(x => ({ rule: x, len: x.length })).sort((a,b) => b.len - a.len);
    const allow = group.allow.filter(Boolean).map(x => ({ rule: x, len: x.length })).sort((a,b) => b.len - a.len);
    const d = disallow.find(x => pathMatchesRule(target, x.rule));
    const a = allow.find(x => pathMatchesRule(target, x.rule));
    if (a && (!d || a.len >= d.len)) return true;
    return !d;
  } catch { return true; }
}

async function loadRobots(job) {
  try {
    const robotsUrl = new URL("/robots.txt", job.root).href;
    const r = await fetchCached(robotsUrl, { timeout: CFG.robotsTimeoutMs, limit: 512 * 1024, accept: "text/plain,*/*;q=0.1" });
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    const text = r.body.toString("utf8");
    const groups = parseRobots(text);
    const group = robotsMatchGroup(groups);
    const sitemaps = [];
    for (const line of text.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)) {
      const u = normalizeUrl(line[1], robotsUrl); if (u) sitemaps.push(u);
    }
    for (const g of groups) for (const sm of (g.sitemaps || [])) { const u = normalizeUrl(sm, robotsUrl); if (u) sitemaps.push(u); }
    job.robots = { groups, group, sitemaps: [...new Set(sitemaps)] };
    job.robotsReady = true;
    if (group?.crawlDelayMs) job.hostDelayMs = Math.max(job.hostDelayMs, group.crawlDelayMs);
    for (const sm of job.robots.sitemaps) job.sitemaps.add(sm);
    jobLog(job, "debug", "robots.txt processed", { crawlDelayMs: job.hostDelayMs });
  } catch (e) {
    job.robots = { groups: [], group: null, sitemaps: [] };
    job.robotsReady = true;
    jobLog(job, "debug", `robots.txt unavailable: ${e.message}`);
  }
}
async function loadSitemaps(job) {
  const pending = [...new Set([
    ...job.sitemaps,
    normalizeUrl("/sitemap.xml", job.root),
    normalizeUrl("/sitemap_index.xml", job.root)
  ].filter(Boolean))];
  const seen = new Set();
  let files = 0, urls = 0;
  async function processSitemap(sm) {
    if (seen.has(sm) || files >= CFG.maxSitemapFiles || urls >= CFG.maxSitemapUrls || job.stopRequested) return;
    seen.add(sm); files += 1;
    try {
      const r = await fetchCached(sm, { timeout: CFG.sitemapTimeoutMs, limit: 8 * 1024 * 1024, accept: "application/xml,text/xml,text/plain,*/*;q=0.1" });
      if (r.status >= 400 || r.tooLarge) throw new Error(`HTTP ${r.status}`);
      const xml = r.body.toString("utf8");
      for (const match of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
        const u = normalizeUrl(match[1], sm); if (!u) continue;
        if (/\.xml(?:$|\?)/i.test(u) && /sitemap/i.test(u)) { if (!seen.has(u) && pending.length < 250) pending.push(u); continue; }
        if (sameOrigin(u, job.root)) { addLink(job, u, "html", sm, "sitemap"); urls += 1; }
        if (urls >= CFG.maxSitemapUrls) break;
      }
    } catch (e) { jobLog(job, "debug", `Sitemap failed: ${sm} — ${e.message}`); }
  }
  while (pending.length && files < CFG.maxSitemapFiles && urls < CFG.maxSitemapUrls && !job.stop) {
    const batch = pending.splice(0, 4);
    await Promise.allSettled(batch.map(processSitemap));
  }
  if (files) jobLog(job, "info", `Sitemap pass: ${files} file(s), ${urls} URL(s) discovered.`);
}

function challengeFallbackHtml(url, info) {
  const safe = escapeHtml(url);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Veyra verification fallback</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#10151d;color:#eaf0f6;font:15px/1.5 system-ui,sans-serif}.card{max-width:650px;margin:24px;padding:32px;background:#171e28;border:1px solid #303a48;border-radius:18px;box-shadow:0 20px 60px #0008}.ey{font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:#86a9d5}.card h1{font-size:26px;margin:10px 0}.card p{color:#aab5c4}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}.actions a{display:inline-block;padding:10px 15px;border-radius:9px;text-decoration:none}.primary{background:#4b82c9;color:#fff}.secondary{border:1px solid #3a4657;color:#dce5ef}</style></head><body><main class="card"><div class="ey">Veyra Browser</div><h1>This site requires its own security verification</h1><p>Veyra's server proxy detected a security or bot-verification page (${escapeHtml(info?.type || "verification")}). It was not indexed as site content and Veyra will not attempt to bypass the site's security controls.</p><div class="actions"><a class="primary" href="${safe}" target="_blank" rel="noopener noreferrer">Open site directly</a><a class="secondary" href="${makeViewUrl(url)}">Retry through Veyra</a></div></main></body></html>`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }

function rewriteCssText(text, base) {
  const src = String(text || "");
  const withUrls = src.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, quote, value) => {
    const u = resolveResource(value.trim(), base);
    return u ? `url("${makeResourceUrl(u, base)}")` : m;
  });
  return withUrls.replace(/@import\s+(?:url\(\s*)?(["'])([^"']+)\1\s*\)?/gi, (m, quote, value) => {
    const u = resolveResource(value.trim(), base);
    return u ? `@import "${makeResourceUrl(u, base)}"` : m;
  });
}
function rewriteJsText(text, base) {
  const patterns = [
    /(\bimport\s*\(\s*|\bimport\s+(?:[^'"`]*?\s+from\s+)?|\bexport\s+[^'"`]*?\s+from\s+)(["'`])([^"'`]+)\2/g
  ];
  let out = String(text || "");
  for (const re of patterns) {
    out = out.replace(re, (m, prefix, quote, spec) => {
      const u = resolveResource(spec, base);
      return u ? `${prefix}${quote}${makeResourceUrl(u, base)}${quote}` : m;
    });
  }
  return out;
}
function rewriteSrcset(raw, base) {
  return String(raw || "").split(",").map(candidate => {
    const parts = candidate.trim().split(/\s+/);
    if (!parts[0]) return candidate;
    const u = resolveResource(parts[0], base);
    if (u) parts[0] = makeResourceUrl(u, base);
    return parts.join(" ");
  }).join(", ");
}
function injectRuntime(html, original) {
  const code = `<script>(function(){
  const CANONICAL=${JSON.stringify(original)};
  const API_ORIGIN=${JSON.stringify(process.env.PUBLIC_API_ORIGIN || "")};
  let virtualUrl=CANONICAL;
  window.__VEYRA_PAGE_URL__=CANONICAL;
  window.__VEYRA_PROXY__=true;
  function unwrap(v){try{const raw=String(v||'');if(raw==='/api/view'||raw==='/api/resource')return virtualUrl;const u=new URL(raw,location.origin);if((u.pathname==='/api/view'||u.pathname==='/api/resource')&&u.searchParams.get('url'))return u.searchParams.get('url');return raw}catch{return String(v||'')}}
  function resolve(v){try{return new URL(unwrap(typeof v==='string'?v:v&&v.url||''),virtualUrl).href}catch{return String(v||'')}}
  function shouldProxy(v){try{const u=new URL(unwrap(v));return /^https?:$/.test(u.protocol)}catch{return false}}
  function proxy(kind,u){const prefix=API_ORIGIN || location.origin;const base=prefix+(kind==='view'?'/api/view?url=':'/api/resource?url=')+encodeURIComponent(u);return kind==='view'?base:base+'&from='+encodeURIComponent(new URL(virtualUrl).origin+new URL(virtualUrl).pathname)}
  function topPost(msg){try{window.top.postMessage(msg,'*')}catch{}}
  function emit(source,url,extra){if(!url)return;topPost({type:'veyra:navigate',url,source,...extra})}
  function canonicalizeMaybeProxy(href){try{const u=new URL(unwrap(href),virtualUrl);if(!/^https?:$/.test(u.protocol))return null;return u.href}catch{return null}}
  function proxyHistory(method){const native=history[method].bind(history);return function(state,title,url){
    let next=virtualUrl;try{if(url!=null)next=new URL(unwrap(String(url)),virtualUrl).href}catch{}
    virtualUrl=next;window.__VEYRA_PAGE_URL__=next;
    try{native(state,title,proxy('view',next))}catch{}
    emit('history.'+method,next);return undefined;
  }}
  try{history.pushState=proxyHistory('pushState');history.replaceState=proxyHistory('replaceState')}catch{}
  try{navigator.serviceWorker&&navigator.serviceWorker.register&&(navigator.serviceWorker.register=()=>Promise.reject(new Error('Service workers are disabled inside the Veyra proxy.')))}catch{}
  const nativeFetch=window.fetch;if(nativeFetch)window.fetch=function(input,init){
    try{const target=resolve(input);if(shouldProxy(target)){if(typeof Request!=='undefined'&&input instanceof Request){return nativeFetch(new Request(proxy('resource',target),input),init)}return nativeFetch(proxy('resource',target),init);}}
    catch{}return nativeFetch(input,init)
  };
  try{const nativeOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...rest){const target=resolve(url);return nativeOpen.call(this,method,shouldProxy(target)?proxy('resource',target):url,...rest)}}catch{}
  try{const NativeEventSource=window.EventSource;if(NativeEventSource)window.EventSource=function(url,options){const target=resolve(url);return new NativeEventSource(shouldProxy(target)?proxy('resource',target):url,options)}}catch{}
  try{const nativeOpen=window.open;window.open=function(url,target,features){const u=canonicalizeMaybeProxy(url);if(u){topPost({type:'veyra:open',url:u});return null}return nativeOpen.call(window,url,target,features)}}catch{}
  try{['log','info','debug','warn','error'].forEach(level=>{const native=console[level].bind(console);console[level]=(...args)=>{native(...args);topPost({type:'veyra:page-console',level,message:args.map(x=>typeof x==='string'?x:(()=>{try{return JSON.stringify(x)}catch{return String(x)}})()).join(' '),pageUrl:virtualUrl})}})}catch{}
  window.addEventListener('error',e=>topPost({type:'veyra:page-error',level:'error',message:e.message||'Resource error',url:e.filename||'',line:e.lineno||null,column:e.colno||null,stack:e.error&&e.error.stack||'',pageUrl:virtualUrl}),true);
  window.addEventListener('unhandledrejection',e=>topPost({type:'veyra:page-error',level:'error',message:e.reason&&e.reason.message||String(e.reason||'Unhandled rejection'),stack:e.reason&&e.reason.stack||'',pageUrl:virtualUrl}),true);
  document.addEventListener('click',function(ev){
    const a=ev.target&&ev.target.closest?ev.target.closest('a[href],area[href]'):null;if(!a)return;
    const raw=a.getAttribute('href')||'';const u=canonicalizeMaybeProxy(raw);if(!u)return;
    ev.preventDefault();ev.stopPropagation();
    if(String(a.getAttribute('target')||'').toLowerCase()==='_blank')topPost({type:'veyra:open',url:u});else emit('document-navigation',u);
  },true);
  document.addEventListener('submit',function(ev){
    const form=ev.target;if(!form||!form.action)return;const method=String(form.method||'get').toUpperCase();
    const target=canonicalizeMaybeProxy(form.getAttribute('action')||virtualUrl);if(!target)return;
    if(method==='GET'){
      ev.preventDefault();const fd=new FormData(form);const u=new URL(target);for(const [k,v] of fd.entries()){if(typeof v==='string')u.searchParams.append(k,v)}emit('document-navigation',u.href);return;
    }
    if(method==='POST'){
      const fd=new FormData(form);const entries=[];for(const [k,v] of fd.entries()){if(typeof v!=='string'){topPost({type:'veyra:unsupported',reason:'File uploads are not supported by the server proxy.'});return;}entries.push([k,v])}
      ev.preventDefault();topPost({type:'veyra:form',url:target,method:'POST',entries});
    }
  },true);
  window.addEventListener('load',function(){
    try{const icon=document.querySelector('link[rel~=' + JSON.stringify('icon') + '],link[rel~=' + JSON.stringify('shortcut icon') + ']');let favicon=icon&&icon.getAttribute('href')||'';try{if(favicon.startsWith('/api/resource?url='))favicon=new URLSearchParams(favicon.split('?')[1]).get('url')||favicon;else favicon=new URL(favicon,virtualUrl).href}catch{}const title=document.title||new URL(virtualUrl).hostname;emit('document-navigation',virtualUrl,{title,favicon})}catch{emit('document-navigation',virtualUrl)}
  });
  try{history.replaceState(history.state,document.title,proxy('view',virtualUrl))}catch{}
})();</script>`;
  const withoutMetaCsp = String(html).replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, "");
  return withoutMetaCsp.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}>${code}`);
}
function rewriteHtml(html, base) {
  const $ = cheerio.load(String(html || ""), { decodeEntities: false });
  $("base").remove();
  $("meta[http-equiv]").filter((_, el) => String($(el).attr("http-equiv") || "").toLowerCase() === "content-security-policy").remove();
  $("a[href],area[href]").each((_, el) => { const u = resolveNavigation($(el).attr("href"), base); if (u) $(el).attr("href", makeViewUrl(u)); });
  $("form[action]").each((_, el) => { const u = resolveNavigation($(el).attr("action"), base); if (u) $(el).attr("action", makeViewUrl(u)); });
  $("iframe[src]").each((_, el) => { const u = resolveNavigation($(el).attr("src"), base); if (u) $(el).attr("src", makeViewUrl(u)); });
  $("object[data]").each((_, el) => { const u = resolveResource($(el).attr("data"), base); if (u) $(el).attr("data", makeResourceUrl(u, base)); });
  $("link[href]").each((_, el) => {
    const rel = String($(el).attr("rel") || "").toLowerCase();
    if (rel.includes("canonical")) return;
    const raw = $(el).attr("href"); const u = resolveResource(raw, base); if (u) { $(el).attr("href", makeResourceUrl(u, base)); if ($(el).attr("integrity")) $(el).removeAttr("integrity"); }
  });
  $("script[src]").each((_, el) => { const u = resolveResource($(el).attr("src"), base); if (u) { $(el).attr("src", makeResourceUrl(u, base)); if ($(el).attr("integrity")) $(el).removeAttr("integrity"); } });
  for (const tag of ["img", "source", "audio", "input", "embed"]) {
    $(`${tag}[src]`).each((_, el) => { const u = resolveResource($(el).attr("src"), base); if (u) $(el).attr("src", makeResourceUrl(u, base)); });
  }
  $("video[poster]").each((_, el) => { const u = resolveResource($(el).attr("poster"), base); if (u) $(el).attr("poster", makeResourceUrl(u, base)); });
  $("track[src]").each((_, el) => { const u = resolveResource($(el).attr("src"), base); if (u) $(el).attr("src", makeResourceUrl(u, base)); });
  $("use[href],use[xlink\:href],image[href],image[xlink\:href]").each((_, el) => {
    const attr = $(el).attr("href") != null ? "href" : "xlink:href";
    const raw = $(el).attr(attr) || "";
    const u = resolveResource(raw, base);
    if (u) $(el).attr(attr, makeResourceUrl(u, base));
  });
  $("[imagesrcset]").each((_, el) => $(el).attr("imagesrcset", rewriteSrcset($(el).attr("imagesrcset"), base)));
  for (const attr of ["data-src", "data-original", "data-lazy-src"]) {
    $(`[${attr}]`).each((_, el) => { const u = resolveResource($(el).attr(attr), base); if (u) $(el).attr(attr, makeResourceUrl(u, base)); });
  }
  $(`[data-srcset]`).each((_, el) => $(el).attr("data-srcset", rewriteSrcset($(el).attr("data-srcset"), base)));
  $("track[src]").each((_, el) => { const u = resolveResource($(el).attr("src"), base); if (u) $(el).attr("src", makeResourceUrl(u, base)); });
  $("use[href],use[xlink\:href],image[href],image[xlink\:href]").each((_, el) => {
    const attr = $(el).attr("href") != null ? "href" : "xlink:href"; const raw = $(el).attr(attr) || "";
    const u = resolveResource(raw, base); if (u) $(el).attr(attr, makeResourceUrl(u, base));
  });
  $("[imagesrcset]").each((_, el) => $(el).attr("imagesrcset", rewriteSrcset($(el).attr("imagesrcset"), base)));
  $("[srcset]").each((_, el) => $(el).attr("srcset", rewriteSrcset($(el).attr("srcset"), base)));
  $("meta[http-equiv='refresh'],meta[http-equiv='Refresh']").each((_, el) => {
    const raw = $(el).attr("content") || ""; const m = raw.match(/^(\s*\d+\s*;\s*url\s*=\s*)(.+)$/i); if (!m) return;
    const u = resolveNavigation(m[2].trim().replace(/^['"]|['"]$/g, ""), base); if (u) $(el).attr("content", `${m[1]}${makeViewUrl(u)}`);
  });
  $("style").each((_, el) => $(el).html(rewriteCssText($(el).html() || "", base)));
  $("[style]").each((_, el) => $(el).attr("style", rewriteCssText($(el).attr("style") || "", base)));
  return injectRuntime($.html(), base);
}

const SEARCH_STOP_WORDS = new Set([
  "a","an","and","are","as","at","be","by","for","from","has","have","how","in","is","it","of","on","or","that","the","this","to","was","what","when","where","which","who","why","with","you","your"
]);
function tokenizeSearch(value) {
  const raw = String(value || "").toLocaleLowerCase();
  const tokens = raw.normalize("NFKC").match(/[\p{L}\p{N}][\p{L}\p{N}'_-]{1,63}/gu) || [];
  return tokens.map(x => x.replace(/^['_-]+|['_-]+$/g, "")).filter(x => x && (x.length > 1 || /\d/.test(x)) && !SEARCH_STOP_WORDS.has(x));
}
function parseSearchQuery(query) {
  const source = String(query || "").trim().slice(0, CFG.maxSearchQueryChars);
  const phrases = [];
  const stripped = source.replace(/"([^\"]{1,160})"/g, (_, phrase) => { phrases.push(phrase.trim().toLocaleLowerCase()); return " "; });
  const filters = { site: "", intitle: "", inurl: "" };
  const negative = [];
  const positiveRaw = [];
  for (const part of stripped.split(/\s+/).filter(Boolean)) {
    if (/^site:[^\s]+$/i.test(part)) filters.site = part.slice(5).toLocaleLowerCase();
    else if (/^intitle:[^\s]+$/i.test(part)) filters.intitle = part.slice(8).toLocaleLowerCase();
    else if (/^inurl:[^\s]+$/i.test(part)) filters.inurl = part.slice(6).toLocaleLowerCase();
    else if (/^-[^\s-]+$/.test(part)) negative.push(...tokenizeSearch(part.slice(1)));
    else positiveRaw.push(part);
  }
  let terms = tokenizeSearch(positiveRaw.join(" "));
  for (const phrase of phrases) terms.push(...tokenizeSearch(phrase));
  terms = [...new Set(terms)].slice(0, CFG.maxSearchQueryTerms);
  const negativeTerms = [...new Set(negative)].slice(0, CFG.maxSearchQueryTerms);
  const normalizedPhrases = [...new Set(phrases)].filter(Boolean).slice(0, 8);
  return { raw: source, terms, negativeTerms, phrases: normalizedPhrases, filters };
}
function searchFieldHas(doc, field, term) { return String(doc[field] || "").toLocaleLowerCase().includes(term); }
function removeIndexedDocument(doc) {
  if (!doc?.termFreq) return;
  for (const term of doc.termFreq.keys()) {
    const postings = invertedIndex.get(term);
    if (postings) {
      postings.delete(doc.url);
      if (!postings.size) invertedIndex.delete(term);
    }
    const count = (termCounts.get(term) || 0) - 1;
    if (count > 0) termCounts.set(term, count); else termCounts.delete(term);
  }
}
function extractPageMeta(text, url) {
  const $ = cheerio.load(String(text || ""), { decodeEntities: false });
  $("script,style,noscript,template").remove();
  const title = String($("title").first().text() || $("h1").first().text() || "").replace(/\s+/g, " ").trim().slice(0, 300) || hostOf(url);
  const description = String($("meta[name='description'],meta[property='og:description']").first().attr("content") || "").replace(/\s+/g, " ").trim().slice(0, 600);
  const headings = String($("h1,h2,h3").map((_, el) => $(el).text()).get().join(" | ") || "").replace(/\s+/g, " ").trim().slice(0, 1200);
  const bodyText = String($("main,article").first().text() || $("body").text() || "").replace(/\s+/g, " ").trim();
  const textContent = (description ? `${description} ` : "") + bodyText;
  const snippet = description || bodyText.slice(0, 600) || title;
  let favicon = "";
  const rawIcon = $("link[rel~='icon'],link[rel='shortcut icon']").first().attr("href");
  if (rawIcon) favicon = resolveResource(rawIcon, url) || "";
  const canonical = resolveNavigation($("link[rel='canonical']").attr("href"), url);
  const lang = String($("html").attr("lang") || "").slice(0, 32);
  const allText = `${title} ${headings} ${textContent} ${url}`;
  const termFreq = new Map();
  for (const term of tokenizeSearch(allText)) termFreq.set(term, (termFreq.get(term) || 0) + 1);
  return {
    title, description, headings, snippet, text: bodyText.slice(0, CFG.maxIndexTextChars), favicon, canonical, lang,
    host: hostOf(canonical || url), path: pathOf(canonical || url), wordCount: Math.max(1, tokenizeSearch(bodyText).length), termFreq
  };
}
function addIndexedDocument(doc) {
  const key = doc.url;
  searchIndex.set(key, doc);
  for (const [term, tf] of doc.termFreq.entries()) {
    let postings = invertedIndex.get(term);
    if (!postings) { postings = new Map(); invertedIndex.set(term, postings); }
    postings.set(key, tf);
    termCounts.set(term, (termCounts.get(term) || 0) + 1);
  }
  while (searchIndex.size > CFG.maxIndexDocs) {
    const oldest = [...searchIndex.values()].sort((a,b) => Date.parse(a.indexedAt || 0) - Date.parse(b.indexedAt || 0))[0];
    if (!oldest) break;
    removeIndexedDocument(oldest); searchIndex.delete(oldest.url);
  }
}
function indexDocument(url, text) {
  try {
    const meta = extractPageMeta(text, url);
    const candidateCanonical = normalizeUrl(meta.canonical || url) || url;
    const canonical = sameOrigin(candidateCanonical, url) ? candidateCanonical : url;
    const existing = searchIndex.get(canonical);
    if (existing) removeIndexedDocument(existing);
    const doc = {
      url: canonical,
      title: meta.title,
      description: meta.description,
      headings: meta.headings,
      snippet: meta.snippet,
      text: meta.text,
      favicon: meta.favicon,
      displayUrl: canonical,
      source: "veyra-index",
      lang: meta.lang,
      host: meta.host,
      path: meta.path,
      wordCount: meta.wordCount,
      indexedAt: now(),
      termFreq: meta.termFreq
    };
    addIndexedDocument(doc);
    invalidateSearchCaches();
    return doc;
  } catch (e) {
    serverLog("warn", "SEARCH", `Indexing failed for ${url}: ${e.message}`);
    return null;
  }
}
function invalidateSearchCaches() { searchCache.clear(); }
function makeSearchSnippet(doc, parsed) {
  const source = String(doc.snippet || doc.text || doc.description || doc.title || "").replace(/\s+/g, " ").trim();
  if (!source) return "No description available.";
  const hay = source.toLocaleLowerCase();
  const hit = parsed.terms.map(t => hay.indexOf(t)).filter(x => x >= 0).sort((a,b) => a-b)[0];
  if (hit == null || hit < 80) return source.slice(0, 260) + (source.length > 260 ? "…" : "");
  const start = Math.max(0, hit - 90), end = Math.min(source.length, start + 300);
  return `${start > 0 ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`;
}
function localSearch(query, offset, limit) {
  const parsed = parseSearchQuery(query);
  const N = searchIndex.size;
  if (!N) return { total: 0, results: [], indexSize: 0, terms: parsed.terms, filters: parsed.filters };
  const candidateScores = new Map();
  const k1 = 1.35, b = 0.75;
  let avgLen = 0;
  for (const doc of searchIndex.values()) avgLen += doc.wordCount || 1;
  avgLen = Math.max(1, avgLen / N);
  const candidateUrls = new Set();
  if (parsed.terms.length) {
    for (const term of parsed.terms) {
      for (const url of (invertedIndex.get(term)?.keys() || [])) candidateUrls.add(url);
    }
  } else {
    for (const doc of [...searchIndex.values()].sort((a,b) => Date.parse(b.indexedAt || 0) - Date.parse(a.indexedAt || 0)).slice(0, 5000)) candidateUrls.add(doc.url);
  }
  for (const url of candidateUrls) {
    const doc = searchIndex.get(url); if (!doc) continue;
    const host = doc.host.toLocaleLowerCase();
    if (parsed.filters.site && !(host === parsed.filters.site || host.endsWith(`.${parsed.filters.site}`))) continue;
    if (parsed.filters.intitle && !searchFieldHas(doc, "title", parsed.filters.intitle)) continue;
    if (parsed.filters.inurl && !String(doc.url).toLocaleLowerCase().includes(parsed.filters.inurl)) continue;
    if (parsed.negativeTerms.some(term => doc.termFreq.has(term) || searchFieldHas(doc, "url", term))) continue;
    let score = 0;
    for (const term of parsed.terms) {
      const postings = invertedIndex.get(term); const tf = postings?.get(doc.url) || 0; const df = postings?.size || 0;
      if (!tf || !df) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const dl = doc.wordCount || 1;
      const denom = tf + k1 * (1 - b + b * dl / avgLen);
      score += idf * ((tf * (k1 + 1)) / denom);
      if (searchFieldHas(doc, "title", term)) score += 3.5 * idf;
      if (searchFieldHas(doc, "headings", term)) score += 1.8 * idf;
      if (searchFieldHas(doc, "url", term)) score += 1.2 * idf;
      if (searchFieldHas(doc, "description", term)) score += 0.9 * idf;
    }
    for (const phrase of parsed.phrases) {
      const phraseText = `${doc.title} ${doc.headings} ${doc.text} ${doc.description}`.toLocaleLowerCase();
      if (phraseText.includes(phrase)) score += 7;
    }
    if (!parsed.terms.length && (doc.title || doc.description)) score += 0.05;
    const ageDays = Math.max(0, (Date.now() - Date.parse(doc.indexedAt || now())) / 86400000);
    score += 0.25 / (1 + ageDays);
    if (score > 0) candidateScores.set(doc.url, score);
  }
  const ranked = [...candidateScores.entries()].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = ranked.length;
  const results = ranked.slice(offset, offset + limit).map(([url, score]) => {
    const doc = searchIndex.get(url);
    return {
      title: doc.title, url: doc.url, snippet: makeSearchSnippet(doc, parsed), displayUrl: doc.displayUrl,
      favicon: doc.favicon || searchFavicon(doc.url), source: "veyra-index", score: Number(score.toFixed(4)),
      indexedAt: doc.indexedAt, lang: doc.lang, domain: doc.host
    };
  });
  return { total, results, indexSize: N, terms: parsed.terms, filters: parsed.filters };
}
function localSearchSuggestions(query, limit = 8) {
  const prefix = String(query || "").trim().toLocaleLowerCase().split(/\s+/).pop() || "";
  const source = prefix ? [...termCounts.keys()].filter(t => t.startsWith(prefix)) : [...termCounts.keys()];
  return source.sort((a,b) => (termCounts.get(b) || 0) - (termCounts.get(a) || 0) || a.localeCompare(b)).slice(0, limit);
}
function searchIndexStats() {
  const domains = new Set([...searchIndex.values()].map(d => d.host).filter(Boolean));
  const latest = [...searchIndex.values()].sort((a,b) => Date.parse(b.indexedAt || 0) - Date.parse(a.indexedAt || 0))[0];
  return { documents: searchIndex.size, terms: invertedIndex.size, domains: domains.size, latestIndexedAt: latest?.indexedAt || null, seeds: CFG.indexSeeds.length, provider: "veyra-index" };
}

function addLink(job, rawUrl, hint, source, reason = "discovered") {
  const u = normalizeUrl(rawUrl, source || job.root); if (!u) return false;
  const type = typeFor(u, hint);
  if (type === "html" && !sameOrigin(u, job.root)) return false;
  const key = linkKey(type, u);
  if (job.discovered.has(key) || job.links.length >= CFG.maxLinks) return false;
  job.discovered.add(key);
  const record = { url: u, path: pathOf(u), type, source: source || job.root, internal: sameOrigin(u, job.root), captured: false, requestedUrl: u, redirectChain: [], priority: crawlPriority(u, type, reason) };
  job.links.push(record); job.counts.links += 1;
  if (type === "html") {
    if (job.pagesDiscovered >= CFG.maxPages || !robotsAllowed(u, job.robots)) return true;
    job.pagesDiscovered += 1;
    job.pageFrontier.add({ url: u, type, source: source || null, reason }, record.priority, key);
  } else if (type === "css" || type === "js") {
    if (job.resourcesScheduled >= CFG.maxResources) return true;
    job.resourcesScheduled += 1;
    job.resourceFrontier.add({ url: u, type, source: source || null, reason }, record.priority, key);
  }
  return true;
}
function discoverCss(job, text, base) {
  const src = String(text || "");
  let m;
  const urlRe = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
  while ((m = urlRe.exec(src))) addLink(job, m[2], "asset", base);
  const importRe = /@import\s+(?:url\(\s*)?(["'])([^"']+)\1/gi;
  while ((m = importRe.exec(src))) addLink(job, m[2], "css", base);
}
function discoverJs(job, text, base) {
  const patterns = [
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\bimport\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\bexport\s+[^"'`]*?\s+from\s+["'`]([^"'`]+)["'`]/g,
    /\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:window\.open|location(?:\.assign|\.replace)?|location\.href)\s*=?\s*["'`]([^"'`]+)["'`]/g
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) addLink(job, m[1], typeFor(m[1]), base);
}
function discoverHtml(job, text, base) {
  const $ = cheerio.load(String(text || ""), { decodeEntities: false });
  $("a[href],area[href]").each((_, el) => addLink(job, $(el).attr("href"), "html", base, "navigation"));
  $("link[href]").each((_, el) => {
    const rel = String($(el).attr("rel") || "").toLowerCase();
    const hint = rel.includes("stylesheet") ? "css" : rel.includes("icon") || rel.includes("preload") || rel.includes("modulepreload") ? "asset" : "html";
    addLink(job, $(el).attr("href"), hint, base, rel.includes("canonical") ? "canonical" : "discovered");
  });
  $("script[src]").each((_, el) => addLink(job, $(el).attr("src"), "js", base));
  $("iframe[src]").each((_, el) => addLink(job, $(el).attr("src"), "html", base));
  $("img[src],source[src],audio[src],video[src],input[src],embed[src],object[data]").each((_, el) => {
    const attr = el.name === "object" ? "data" : "src"; addLink(job, $(el).attr(attr), "asset", base);
  });
  $("form[action]").each((_, el) => addLink(job, $(el).attr("action"), "html", base, "navigation"));
  $("link[rel='canonical']").each((_, el) => addLink(job, $(el).attr("href"), "html", base, "canonical"));
  $("[srcset]").each((_, el) => String($(el).attr("srcset") || "").split(",").forEach(x => addLink(job, x.trim().split(/\s+/)[0], "asset", base)));
  $("style").each((_, el) => discoverCss(job, $(el).text(), base));
  $("[style]").each((_, el) => discoverCss(job, $(el).attr("style") || "", base));
  discoverJs(job, String(text || ""), base);
}

function createJob(root) {
  const id = crypto.randomUUID();
  return {
    id, root, url: root, createdAt: now(), finishedAt: null, done: false, stopRequested: false, status: "queued", statusText: "Queued",
    pageFrontier: new PriorityFrontier(CFG.maxPendingQueue), resourceFrontier: new PriorityFrontier(CFG.maxPendingQueue), visited: new Set(), discovered: new Set(),
    resources: [], links: [], logs: [], logSeq: 0, sourceDir: path.join(ROOT, id), sourceFiles: 0, textBytesStored: 0,
    activeWorkers: 0, activeHtmlWorkers: 0, activeAssetWorkers: 0, processed: 0, pagesDiscovered: 0, resourcesScheduled: 0,
    robots: null, robotsReady: false, sitemaps: new Set(), challengeHosts: new Set(), hostActive: new Map(), hostCooldowns: new Map(), hostLastRequested: new Map(), hostFailures: new Map(), hostDelayMs: 0, stopReason: null,
    counts: { htmlPages: 0, css: 0, js: 0, links: 0, bytesScanned: 0, bytesStored: 0, bytesDiscarded: 0, requestCount: 0, retries: 0, challenges: 0, errors: 0 },
    controller: new AbortController()
  };
}
function publicJob(job) {
  const queued = job.pageFrontier.size + job.resourceFrontier.size;
  return {
    id: job.id, url: job.url, createdAt: job.createdAt, finishedAt: job.finishedAt, done: job.done,
    status: job.status, statusText: job.statusText, stopRequested: job.stopRequested,
    maxUrls: CFG.maxResources, maxScanBytes: CFG.maxScanBytes, elapsedMs: Date.now() - Date.parse(job.createdAt),
    counts: { ...job.counts, processed: job.processed, queued, active: job.activeWorkers },
    workers: { html: { active: job.activeHtmlWorkers, max: CFG.globalConcurrency, queued: job.pageFrontier.size }, asset: { active: job.activeAssetWorkers, max: CFG.globalConcurrency, queued: job.resourceFrontier.size } },
    limits: { globalConcurrency: CFG.globalConcurrency, crawlerRobots: CFG.globalConcurrency, perHostConcurrency: CFG.perHostConcurrency, maxPages: CFG.maxPages, maxResources: CFG.maxResources, maxLinks: CFG.maxLinks, maxScanBytes: CFG.maxScanBytes },
    searchIndex: searchIndexStats(),
    robotsLoaded: job.robotsReady, sitemapsFound: job.sitemaps.size, sourceFiles: job.sourceFiles, textBytesStored: job.textBytesStored,
    resourceCount: job.resources.length, linkCount: job.links.length, logs: job.logs.slice(-120), queue: { pages: job.pageFrontier.snapshot().slice(0, 50), resources: job.resourceFrontier.snapshot().slice(0, 50) }
  };
}
async function processItem(job, item) {
  if (job.stopRequested) return;
  const key = linkKey(item.type, item.url); if (job.visited.has(key)) return;
  job.visited.add(key);
  if (item.type === "html" && (!sameOrigin(item.url, job.root) || !robotsAllowed(item.url, job.robots))) return;
  if (job.counts.bytesScanned >= CFG.maxScanBytes) { job.stopRequested = true; job.stopReason = "scan-byte-limit"; return; }
  const host = hostOf(item.url);
  if (job.challengeHosts.has(host)) return;
  const previousCooldown = job.hostCooldowns.get(host) || 0;
  if (previousCooldown > Date.now()) await sleep(previousCooldown - Date.now());
  const last = job.hostLastRequested.get(host) || 0;
  if (job.hostDelayMs && last + job.hostDelayMs > Date.now()) await sleep(last + job.hostDelayMs - Date.now());
  job.hostLastRequested.set(host, Date.now());
  const accept = item.type === "html" ? "text/html,application/xhtml+xml,application/xml,text/plain;q=0.4,*/*;q=0.05" : "text/css,application/javascript,text/javascript,application/json,*/*;q=0.05";
  try {
    job.counts.requestCount += 1;
    const r = await fetchCached(item.url, { accept, limit: CFG.maxTextBytesPerResource, timeout: CFG.requestTimeoutMs, retries: CFG.maxRetries });
    job.counts.bytesScanned += r.bytes;
    if (r.retries) job.counts.retries += r.retries;
    if (r.truncated || r.tooLarge) { job.counts.bytesDiscarded += r.bytes; jobLog(job, "warn", `Response skipped after size limit: ${item.url}`); return; }
    if (job.counts.bytesScanned > CFG.maxScanBytes) { job.stopRequested = true; job.stopReason = "scan-byte-limit"; return; }
    const lower = r.contentType.toLowerCase();
    const challenge = detectChallenge(r.body.toString("utf8"), r.contentType, r.status, { server: r.serverHeader, "cf-mitigated": r.cfMitigated });
    if (challenge) {
      job.counts.challenges += 1;
      job.challengeHosts.add(host);
      job.status = "challenge";
      if (item.url === job.root) job.stopRequested = true;
      jobLog(job, "warn", `Security verification detected; crawl branch stopped: ${item.url}`);
      return;
    }
    if (!r.ok) {
      job.counts.errors += 1;
      if ([400,401,403,404,405,410,422].includes(r.status)) {
        jobLog(job, "warn", `HTTP ${r.status}; page not indexed: ${item.url}`);
        return;
      }
      const httpError = new Error(`HTTP ${r.status}`); httpError.status = r.status; throw httpError;
    }
    let type = item.type;
    if (lower.includes("text/html") || lower.includes("application/xhtml+xml")) type = "html";
    else if (lower.includes("text/css")) type = "css";
    else if (lower.includes("javascript") || lower.includes("ecmascript")) type = "js";
    else if (type === "asset") return;
    if (!['html', 'css', 'js'].includes(type)) return;
    if (job.resources.length >= CFG.maxResources) { job.stopRequested = true; job.stopReason = "resource-limit"; return; }
    const text = r.body.toString("utf8");
    const id = job.resources.length;
    const sourceFile = await sourceStore.write(job, id, text);
    const resource = {
      id, url: r.finalUrl || item.url, requestedUrl: item.url, type, status: r.status, contentType: r.contentType,
      bytes: r.bytes, bytesLabel: bytesLabel(r.bytes), truncated: r.truncated, sourceFile, inlinePreview: sourceFile ? "" : text.slice(0, 8000), sourceId: item.source || null,
      redirectChain: r.redirectChain || [], revalidated: !!r.revalidated
    };
    job.resources.push(resource);
    const link = job.links.find(x => x.url === item.url || x.url === resource.url); if (link) { link.captured = true; link.redirectChain = resource.redirectChain; link.url = resource.url; }
    job.hostFailures.set(host, 0); job.hostCooldowns.delete(host);
    if (type === "html") {
      job.counts.htmlPages += 1; indexDocument(resource.url, text); discoverHtml(job, text, resource.url);
    } else if (type === "css") { job.counts.css += 1; discoverCss(job, text, resource.url); }
    else { job.counts.js += 1; discoverJs(job, text, resource.url); }
    job.counts.bytesStored += Math.min(r.bytes, CFG.maxTextBytesPerResource);
    if (job.processed && job.processed % 100 === 0) jobLog(job, "debug", `Processed ${job.processed.toLocaleString()} resources; ${bytesLabel(job.counts.bytesScanned)} scanned.`);
  } catch (e) {
    job.counts.errors += 1;
    const failures = (job.hostFailures.get(host) || 0) + 1;
    job.hostFailures.set(host, failures);
    const backoff = Math.min(CFG.maxHostBackoffMs, CFG.hostBackoffMs * 2 ** Math.min(5, failures - 1));
    job.hostCooldowns.set(host, Date.now() + backoff);
    jobLog(job, "error", `Fetch failed ${item.url} — ${e.name || "Error"}: ${e.message}`, { retryClass: statusRetryClass(Number(String(e.message).match(/HTTP (\d+)/)?.[1] || 0)) });
  } finally { job.processed += 1; }
}
async function frontierWorker(job) {
  while (!job.stopRequested) {
    if (!job.robotsReady) { await sleep(15); continue; }
    if (job.counts.bytesScanned >= CFG.maxScanBytes) { job.stopRequested = true; job.stopReason = "scan-byte-limit"; break; }
    let type = job.pageFrontier.size ? "html" : "asset";
    let item = type === "html" ? job.pageFrontier.takeNext(job.hostActive, CFG.perHostConcurrency, job.hostCooldowns) : job.resourceFrontier.takeNext(job.hostActive, CFG.perHostConcurrency, job.hostCooldowns);
    if (!item) {
      if (job.pageFrontier.size || job.resourceFrontier.size) {
        item = job.resourceFrontier.takeNext(job.hostActive, CFG.perHostConcurrency, job.hostCooldowns);
        type = item ? "asset" : "html";
      }
    }
    if (!item) {
      if (job.activeWorkers === 0 && !job.pageFrontier.size && !job.resourceFrontier.size) break;
      await sleep(20); continue;
    }
    const host = hostOf(item.url);
    job.activeWorkers += 1; job.hostActive.set(host, (job.hostActive.get(host) || 0) + 1);
    if (type === "html") job.activeHtmlWorkers += 1; else job.activeAssetWorkers += 1;
    try { await processItem(job, item); }
    finally {
      job.activeWorkers -= 1; job.hostActive.set(host, Math.max(0, (job.hostActive.get(host) || 1) - 1));
      if (type === "html") job.activeHtmlWorkers -= 1; else job.activeAssetWorkers -= 1;
    }
  }
}
async function runCrawl(job) {
  job.status = "starting"; job.statusText = "Preparing crawl…";
  await fsp.mkdir(job.sourceDir, { recursive: true });
  addLink(job, job.root, "html", null, "root");
  const workers = Array.from({ length: CFG.globalConcurrency }, () => frontierWorker(job));
  try {
    await loadRobots(job);
    if (!job.stopRequested) await loadSitemaps(job);
    job.status = "crawling"; job.statusText = "Crawling in background…";
    await Promise.allSettled(workers);
    job.done = true; job.finishedAt = now();
    if (job.status === "challenge") job.statusText = "Security verification required; crawl stopped.";
    else if (job.stopRequested && job.stopReason === "scan-byte-limit") { job.status = "done"; job.statusText = `Scan budget reached (${bytesLabel(CFG.maxScanBytes)}).`; }
    else if (job.stopRequested && job.stopReason === "resource-limit") { job.status = "done"; job.statusText = `Resource safety limit reached (${CFG.maxResources.toLocaleString()}).`; }
    else if (job.stopRequested) { job.status = "stopped"; job.statusText = "Stopped by user."; }
    else { job.status = "done"; job.statusText = `Complete — ${job.processed.toLocaleString()} resources processed; frontier exhausted.`; }
    jobLog(job, job.status === "done" || job.status === "crawling" ? "info" : "warn", job.statusText);
  } catch (e) {
    job.done = true; job.finishedAt = now(); job.status = "error"; job.statusText = e.message || "Crawler error"; jobLog(job, "error", e.stack || e.message);
  }
}

// Search abstraction. Local Veyra indexing is first-class; external providers are optional.
function selectedSearchProvider() {
  if (CFG.searchProvider === "auto") {
    if (searchIndex.size) return "local";
    if (process.env.BRAVE_SEARCH_API_KEY || (CFG.searchApiKey && /brave/i.test(CFG.searchEndpoint))) return "brave";
    if (process.env.BING_SEARCH_API_KEY || (CFG.searchApiKey && /bing/i.test(CFG.searchEndpoint))) return "bing";
    return "local";
  }
  return CFG.searchProvider;
}
function searchFavicon(url) { return ""; }
async function externalSearch(provider, query, offset, limit) {
  let endpoint; const headers = { accept: "application/json" };
  const key = provider === "brave" ? (process.env.BRAVE_SEARCH_API_KEY || CFG.searchApiKey) : provider === "bing" ? (process.env.BING_SEARCH_API_KEY || CFG.searchApiKey) : CFG.searchApiKey;
  if (provider === "brave") {
    endpoint = CFG.searchEndpoint || "https://api.search.brave.com/res/v1/web/search";
    headers["X-Subscription-Token"] = key;
  } else if (provider === "bing") {
    endpoint = CFG.searchEndpoint || "https://api.bing.microsoft.com/v7.0/search";
    headers["Ocp-Apim-Subscription-Key"] = key;
  } else {
    if (!CFG.searchEndpoint) throw new Error("SEARCH_ENDPOINT is not configured.");
    endpoint = CFG.searchEndpoint;
    if (key) headers[CFG.customSearchAuth || "X-API-Key"] = key;
  }
  if (!key && provider !== "custom") throw new Error(`${provider} search provider is not configured.`);
  const u = new URL(endpoint); u.searchParams.set("q", query); u.searchParams.set("count", String(limit)); u.searchParams.set("offset", String(offset));
  const r = await fetchBuffer(u.href, { headers, limit: 2 * 1024 * 1024, timeout: 12000, retries: 1, accept: "application/json" });
  if (!r.ok) throw new Error(`Search provider HTTP ${r.status}.`);
  const data = JSON.parse(r.body.toString("utf8"));
  let items = [], total = null;
  if (provider === "brave") { items = data.web?.results || []; total = data.web?.total ?? null; }
  else if (provider === "bing") { items = data.webPages?.value || []; total = data.webPages?.totalEstimatedMatches ?? null; }
  else { items = Array.isArray(data) ? data : data.results || []; total = data.total ?? null; }
  return { total, results: items.map((item, i) => ({ title: String(item.title || item.name || item.heading || "Untitled").slice(0, 300), url: normalizeUrl(item.url || item.link || ""), snippet: String(item.description || item.snippet || item.summary || "").slice(0, 700), displayUrl: String(item.displayUrl || item.url || item.link || "").slice(0, 500), favicon: item.favicon || item.profile?.img || searchFavicon(item.url || item.link || ""), source: provider, score: Number(item.score ?? (limit - i)) })).filter(x => x.url) };
}
async function searchService(query, offset, limit) {
  const provider = selectedSearchProvider();
  const key = `${provider}|${offset}|${limit}|${query.toLowerCase()}`;
  const hit = cacheGet(searchCache, key, CFG.searchCacheMs);
  if (hit) return { ...hit.value, cached: true };
  let result;
  if (provider === "local") result = localSearch(query, offset, limit);
  else if (provider === "none") result = { total: 0, results: [], indexSize: searchIndex.size, terms: [], filters: {}, disabled: true };
  else result = await externalSearch(provider, query, offset, limit);
  const value = { provider, ...result, indexStats: searchIndexStats() };
  cacheSet(searchCache, key, { value }, CFG.maxSearchCacheEntries);
  return value;
}
const indexSeedState = new Map();
async function pumpIndexSeeds() {
  if (!CFG.indexSeedCrawl || !CFG.indexSeeds.length) return;
  const maxActive = numberEnv("MAX_ACTIVE_JOBS", 3, 1, 20);
  const activeCount = [...jobs.values()].filter(j => !j.done && !j.stopRequested).length;
  if (activeCount >= maxActive) return;
  for (const raw of CFG.indexSeeds.slice(0, 50)) {
    if ([...jobs.values()].some(j => !j.done && j.root === normalizeUrl(raw))) continue;
    const lastRun = indexSeedState.get(raw) || 0;
    if (lastRun && CFG.indexRefreshMs > 0 && Date.now() - lastRun < CFG.indexRefreshMs) continue;
    if ([...jobs.values()].filter(j => !j.done && !j.stopRequested).length >= maxActive) break;
    try {
      const root = normalizeUrl(raw); if (!root) continue;
      await assertPublicUrl(root);
      const job = createJob(root); jobs.set(job.id, job); activeByRoot.set(root, job.id); indexSeedState.set(raw, Date.now());
      jobLog(job, "info", "Index seed crawl queued.", { source: "INDEX", seed: raw });
      runCrawl(job).catch(e => { job.done = true; job.finishedAt = now(); job.status = "error"; job.statusText = e.message; jobLog(job, "error", e.stack || e.message); });
    } catch (e) { indexSeedState.set(raw, Date.now()); serverLog("warn", "SEARCH", `Index seed rejected: ${raw} — ${e.message}`); }
  }
}

// Health and debug.
app.get("/health", (req, res) => res.json({ ok: true, service: "veyra", uptimeSec: Math.round(process.uptime()), activeJobs: [...jobs.values()].filter(j => !j.done).length, processRole: CFG.processRole }));
app.get("/api/debug/system", (req, res) => {
  const mem = process.memoryUsage();
  const idx = searchIndexStats();
  res.json({ time: now(), uptimeSec: Math.round(process.uptime()), startedAt: new Date(serverStartedAt).toISOString(), nodeVersion: process.version, platform: process.platform, processRole: CFG.processRole, memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external }, jobs: { total: jobs.size, active: [...jobs.values()].filter(j => !j.done).length, done: [...jobs.values()].filter(j => j.done).length }, proxyCacheEntries: proxyCache.size, searchCacheEntries: searchCache.size, searchIndexEntries: idx.documents, searchIndexTerms: idx.terms, searchIndexDomains: idx.domains, requestsLogged: requestLog.length, logs: serverLogs.length });
});
app.get("/api/debug/config", (req, res) => res.json({ ...CFG, searchApiKey: undefined }));
app.get("/api/debug/jobs", (req, res) => res.json({ jobs: [...jobs.values()].sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(publicJob) }));
app.get("/api/debug/requests", (req, res) => { const limit = Math.min(CFG.maxRequestLog, Math.max(1, Number(req.query.limit || 200))); res.json({ requests: requestLog.slice(-limit).reverse() }); });
app.get("/api/search/stats", (req, res) => { res.json({ ok: true, ...searchIndexStats(), crawlJobs: [...jobs.values()].filter(j => !j.done).length, activeIndexSeeds: [...jobs.values()].filter(j => !j.done && CFG.indexSeeds.includes(j.root)).length }); });
app.get("/api/search/suggest", (req, res) => { const q = String(req.query.q || "").slice(0, 80); const limit = Math.min(12, Math.max(1, Number(req.query.limit || 8) || 8)); res.json({ ok: true, query: q, suggestions: localSearchSuggestions(q, limit) }); });
app.get("/api/debug/logs", (req, res) => {
  const limit = Math.min(CFG.maxServerLog, Math.max(1, Number(req.query.limit || 200)));
  const source = String(req.query.source || "all");
  const level = String(req.query.level || "all");
  const all = source === "browser" ? clientLogs.map(x => ({ ...x, source: "BROWSER" })) : source === "server" ? serverLogs.map(x => ({ ...x, source: "SERVER" })) : [...serverLogs.map(x => ({ ...x, source: "SERVER" })), ...clientLogs.map(x => ({ ...x, source: "BROWSER" }))];
  const rows = all.filter(x => level === "all" || x.level === level).sort((a,b) => Date.parse(a.time || 0) - Date.parse(b.time || 0)).slice(-limit).reverse();
  res.json({ logs: rows });
});
app.post("/api/debug/client-log", (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 50) : [req.body];
  for (const x of events) {
    if (!x || typeof x !== "object") continue;
    clientLogAdd({
      time: String(x.time || now()).slice(0, 40), level: String(x.level || "info").slice(0, 20), source: "BROWSER",
      message: String(x.message || "").slice(0, 2000), url: sanitizeLogUrl(x.url || x.pageUrl || ""), pageUrl: sanitizeLogUrl(x.pageUrl || ""),
      line: Number(x.line) || null, column: Number(x.column) || null, stack: String(x.stack || "").slice(0, 5000), tabId: String(x.tabId || "").slice(0, 100), jobId: String(x.jobId || "").slice(0, 100), requestId: String(x.requestId || "").slice(0, 100)
    });
  }
  res.json({ ok: true, stored: events.length });
});

app.get("/api/search", async (req, res) => {
  const started = performance.now();
  const query = String(req.query.q || "").trim();
  const offset = Math.max(0, Math.min(100000, Number(req.query.offset || 0) || 0));
  const limit = Math.max(1, Math.min(CFG.maxSearchResults, Number(req.query.limit || 10) || 10));
  if (!query) return respondError(res, 400, "Search query is empty.", "SEARCH_EMPTY");
  if (query.length > CFG.maxSearchQueryChars) return respondError(res, 400, "Search query is too long.", "SEARCH_QUERY_TOO_LONG");
  try {
    const result = await searchService(query, offset, limit);
    res.json({ ok: true, query, provider: result.provider, total: result.total, offset, limit, responseTimeMs: Math.round((performance.now() - started) * 10) / 10, cached: !!result.cached, indexSize: result.indexSize ?? result.indexStats?.documents ?? searchIndex.size, indexStats: result.indexStats || searchIndexStats(), terms: result.terms || [], filters: result.filters || {}, results: result.results, disabled: !!result.disabled });
  } catch (e) {
    const status = e.code === "SEARCH_NOT_CONFIGURED" ? 503 : 502;
    respondError(res, status, e.message, e.code || "SEARCH_PROVIDER_ERROR", { indexStats: searchIndexStats() });
  }
});

async function proxyRequest(req, res, mode) {
  const raw = String(req.query.url || "");
  const canonical = normalizeUrl(raw);
  if (!canonical) return respondError(res, 400, "Missing or invalid public HTTP(S) URL.", "INVALID_URL");
  await assertPublicUrl(canonical);
  const accept = String(req.get("Accept") || (mode === "view" ? "text/html,application/xhtml+xml,*/*" : "*/*")).slice(0, 500);
  const method = req.method.toUpperCase();
  if (!safeMethod(method)) return respondError(res, 405, "Unsupported proxy method.", "PROXY_METHOD_NOT_ALLOWED");
  const body = method === "GET" || method === "HEAD" ? undefined : (() => {
    if (req.is("application/x-www-form-urlencoded")) return new URLSearchParams(req.body || {}).toString();
    if (req.is("application/json")) return JSON.stringify(req.body || {});
    return typeof req.body === "string" ? req.body : undefined;
  })();
  if (body && Buffer.byteLength(body) > CFG.maxProxyBodyBytes) return respondError(res, 413, "Proxy request body is too large.", "PROXY_BODY_TOO_LARGE");
  const sourceUrl = (() => { try { const u = new URL(String(req.query.from || "")); return /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname}` : ""; } catch { return ""; } })();
  const referrer = sourceUrl ? new URL(sourceUrl).origin : "";
  const headers = { accept, "content-type": req.get("Content-Type") || undefined, ...(req.get("Range") ? { range: String(req.get("Range")).slice(0, 200) } : {}), ...(referrer ? { referer: referrer } : {}) };
  const limitForContentType = (ct) => {
    const type = String(ct || "").toLowerCase();
    if (type.includes("text/html") || type.includes("application/xhtml") || type.includes("text/css") || /javascript|ecmascript|json|xml/.test(type)) return CFG.maxProxyTextBytes;
    if (type.startsWith("image/") || type.includes("svg")) return CFG.maxProxyImageBytes;
    if (type.startsWith("video/") || type.startsWith("audio/") || type.includes("application/pdf")) return CFG.maxProxyMediaBytes;
    return CFG.maxProxyOtherBytes;
  };
  const result = await fetchCached(canonical, { method, headers, body, referrer, limit: CFG.maxTextBytesPerResource, limitForContentType, noCache: method !== "GET" });
  if (result.tooLarge) return respondError(res, 413, "The upstream response exceeds Veyra's safety limit.", "RESPONSE_TOO_LARGE");
  const upstreamHeaders = {
    "content-type": result.contentType || (mode === "view" ? "text/html; charset=utf-8" : "application/octet-stream"),
    "cache-control": mode === "view" ? "no-store" : "public, max-age=15",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...(result.contentRange ? { "content-range": result.contentRange } : {}),
    ...(result.acceptRanges ? { "accept-ranges": result.acceptRanges } : {})
  };
  const challenge = mode === "view" ? detectChallenge(result.body.toString("utf8"), result.contentType, result.status, { server: result.serverHeader, "cf-mitigated": result.cfMitigated }) : null;
  if (challenge) {
    res.setHeader("X-Veyra-Challenge", "true");
    res.setHeader("X-Veyra-Canonical-URL", canonical);
    return res.status(200).type("html").send(challengeFallbackHtml(canonical, challenge));
  }
  let payload = result.body;
  if (mode === "view" && (/html|xhtml|^$/.test(result.contentType.toLowerCase()))) payload = Buffer.from(rewriteHtml(payload.toString("utf8"), result.finalUrl || canonical), "utf8");
  else if (mode === "resource" && result.contentType.toLowerCase().includes("text/css")) payload = Buffer.from(rewriteCssText(payload.toString("utf8"), result.finalUrl || canonical), "utf8");
  else if (mode === "resource" && /javascript|ecmascript/.test(result.contentType.toLowerCase())) payload = Buffer.from(rewriteJsText(payload.toString("utf8"), result.finalUrl || canonical), "utf8");
  for (const [k,v] of Object.entries(upstreamHeaders)) if (v) res.setHeader(k, v);
  res.setHeader("X-Veyra-Canonical-URL", result.finalUrl || canonical);
  res.setHeader("X-Veyra-Content-Type", result.contentType || "application/octet-stream");
  if (result.etag) res.setHeader("ETag", result.etag);
  if (result.lastModified) res.setHeader("Last-Modified", result.lastModified);
  const outputStatus = result.status >= 400 ? result.status : (result.status === 206 ? 206 : 200);
  const transformedText = (mode === "view" && /html|xhtml|^$/i.test(result.contentType || "")) || (mode === "resource" && /(?:text\/css|javascript|ecmascript)/i.test(result.contentType || ""));
  if (result.contentLength && !transformedText && !result.truncated && outputStatus !== 200) res.setHeader("content-length", result.contentLength);
  res.status(outputStatus).send(payload);
}

app.get("/api/view", async (req, res) => { try { await proxyRequest(req, res, "view"); } catch (e) { respondError(res, 502, `Veyra could not load this page: ${e.message}`, "PROXY_VIEW_ERROR", { requestId: req.veyraRequestId }); } });
app.post("/api/view", async (req, res) => { try { await proxyRequest(req, res, "view"); } catch (e) { respondError(res, 502, `Veyra could not submit this form: ${e.message}`, "PROXY_FORM_ERROR", { requestId: req.veyraRequestId }); } });
app.get("/api/resource", async (req, res) => { try { await proxyRequest(req, res, "resource"); } catch (e) { respondError(res, 502, `Veyra resource error: ${e.message}`, "PROXY_RESOURCE_ERROR", { requestId: req.veyraRequestId }); } });
app.post("/api/resource", async (req, res) => { try { await proxyRequest(req, res, "resource"); } catch (e) { respondError(res, 502, `Veyra resource request failed: ${e.message}`, "PROXY_RESOURCE_POST_ERROR", { requestId: req.veyraRequestId }); } });

app.post("/api/open", async (req, res) => {
  try {
    const root = normalizeUrl(String(req.body?.url || "")); if (!root) return respondError(res, 400, "Please provide a valid public HTTP(S) URL.", "INVALID_URL");
    await assertPublicUrl(root);
    const oldId = activeByRoot.get(root); const old = oldId && jobs.get(oldId);
    if (old && !old.done && !old.stopRequested) return res.status(202).json({ jobId: old.id, url: root, viewUrl: makeViewUrl(root) });
    const activeCount = [...jobs.values()].filter(j => !j.done && !j.stopRequested).length;
    if (activeCount >= numberEnv("MAX_ACTIVE_JOBS", 3, 1, 20)) return respondError(res, 503, "Crawler capacity is busy; try again shortly.", "CRAWLER_CAPACITY_BUSY");
    const job = createJob(root); jobs.set(job.id, job); activeByRoot.set(root, job.id);
    jobLog(job, "info", "Background crawl queued.");
    runCrawl(job).catch(e => { job.done = true; job.finishedAt = now(); job.status = "error"; job.statusText = e.message; jobLog(job, "error", e.stack || e.message); });
    res.status(202).json({ jobId: job.id, url: root, viewUrl: makeViewUrl(root), state: "queued" });
  } catch (e) { respondError(res, 400, e.message, "OPEN_FAILED"); }
});

app.get("/api/crawl/:id", (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); res.json(publicJob(j)); });
app.post("/api/crawl/:id/stop", (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); j.stopRequested = true; j.stopReason = "user"; j.status = "stopping"; j.statusText = "Stopping…"; j.controller.abort(); jobLog(j, "warn", "Stop requested."); res.json({ ok: true }); });
app.get("/api/crawl/:id/resources", (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); res.json({ resources: j.resources.map(r => ({ id: r.id, url: r.url, requestedUrl: r.requestedUrl, type: r.type, status: r.status, contentType: r.contentType, bytes: r.bytes, bytesLabel: r.bytesLabel, truncated: r.truncated, sourceId: r.sourceId })) }); });
app.get("/api/crawl/:id/source/:resourceId", async (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); const id = Number(req.params.resourceId); const r = j.resources[id]; if (!r) return respondError(res, 404, "Resource not found.", "RESOURCE_NOT_FOUND"); res.json({ id: r.id, url: r.url, type: r.type, source: await sourceStore.read(j, r) }); });
app.get("/api/crawl/:id/links", (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); const offset = Math.max(0, Number(req.query.offset || 0) || 0); const limit = Math.min(10000, Math.max(1, Number(req.query.limit || 1000) || 1000)); res.json({ total: j.links.length, offset, limit, links: j.links.slice(offset, offset + limit) }); });
app.get("/api/crawl/:id/export", (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); res.setHeader("content-type", "application/json; charset=utf-8"); res.setHeader("content-disposition", `attachment; filename="veyra-${j.id}.json"`); res.send(JSON.stringify({ id:j.id, root:j.root, createdAt:j.createdAt, finishedAt:j.finishedAt, status:j.status, counts:j.counts, links:j.links, resources:j.resources.map(r => ({ id:r.id,url:r.url,type:r.type,status:r.status,contentType:r.contentType,bytes:r.bytes,truncated:r.truncated,redirectChain:r.redirectChain })) }, null, 2)); });

function consolePage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Veyra Console</title><style>body{margin:0;background:#0e1116;color:#e7edf5;font:13px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}header{padding:16px 20px;border-bottom:1px solid #2a313b;position:sticky;top:0;background:#11151b}h1{font:700 18px system-ui;margin:0 0 8px}.bar{display:flex;gap:8px;flex-wrap:wrap}select,button{background:#1a2029;color:#dce5ef;border:1px solid #343d49;border-radius:7px;padding:7px 9px}main{padding:16px 20px}.log{display:grid;grid-template-columns:155px 72px 72px 1fr;gap:10px;padding:7px 8px;border-bottom:1px solid #181e26;white-space:pre-wrap;word-break:break-word}.SERVER{background:#121821}.BROWSER{background:#11171b}.err{color:#ff9f9f}.warn{color:#e9c36f}.info{color:#a9c8f0}.debug{color:#8f9aaa}@media(max-width:800px){.log{grid-template-columns:1fr}.log span{display:block}}</style></head><body><header><h1>Veyra — /console</h1><div class="bar"><select id="source"><option>all</option><option>browser</option><option>server</option></select><select id="level"><option>all</option><option>error</option><option>warn</option><option>info</option><option>debug</option></select><button id="refresh">Refresh</button><button id="auto">Auto: on</button></div></header><main id="log">Loading…</main><script>let on=true;async function load(){try{const s=document.getElementById('source').value,l=document.getElementById('level').value;const r=await fetch('/api/debug/logs?source='+encodeURIComponent(s)+'&level='+encodeURIComponent(l)+'&limit=500');const b=await r.json();document.getElementById('log').innerHTML=(b.logs||[]).map(x=>'<div class="log '+(x.source||'')+'"><span>'+esc(x.time||'')+'</span><span>'+esc(x.source||'')+'</span><span class="'+esc(x.level||'')+'">'+esc(x.level||'')+'</span><span>'+esc(x.message||'')+' '+esc(x.requestId||'')+'</span></div>').join('')||'<p>No logs.</p>'}catch(e){document.getElementById('log').textContent=e.message}}function esc(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]) )}document.getElementById('refresh').onclick=load;document.getElementById('source').onchange=load;document.getElementById('level').onchange=load;document.getElementById('auto').onclick=()=>{on=!on;document.getElementById('auto').textContent='Auto: '+(on?'on':'off')};load();setInterval(()=>on&&load(),2000);</script></body></html>`;
}
app.get("/console", (req, res) => res.type("html").send(consolePage()));

// Safe JSON/API error handling and process guards.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const isApi = req.path.startsWith("/api/") || req.path === "/health";
  serverLog("error", "HTTP", err.stack || err.message || String(err), { requestId: req.veyraRequestId });
  if (isApi) return respondError(res, 500, "Veyra encountered an internal server error.", "INTERNAL_ERROR", { requestId: req.veyraRequestId });
  res.status(500).type("text/plain").send("Veyra server error.");
});
process.on("uncaughtException", err => { serverLog("error", "SYSTEM", `Uncaught exception: ${err.stack || err}`); });
process.on("unhandledRejection", reason => { serverLog("error", "SYSTEM", `Unhandled rejection: ${reason?.stack || reason}`); });

setInterval(async () => {
  const cutoff = Date.now() - CFG.maxJobAgeMs;
  for (const [id, job] of jobs) {
    if (job.done && Date.parse(job.finishedAt || job.createdAt) < cutoff) {
      await sourceStore.delete(job);
      jobs.delete(id);
      if (activeByRoot.get(job.root) === id) activeByRoot.delete(job.root);
    }
  }
}, 60000).unref();

if (require.main === module && CFG.processRole !== "worker") {
  app.listen(PORT, "0.0.0.0", () => {
    serverLog("info", "SYSTEM", `Veyra server listening on ${PORT}`);
    pumpIndexSeeds().catch(e => serverLog("warn", "SEARCH", `Seed startup failed: ${e.message}`));
    if (CFG.indexRefreshMs > 0) setInterval(() => pumpIndexSeeds().catch(e => serverLog("warn", "SEARCH", `Seed scheduler failed: ${e.message}`)), 30000).unref();
  });
} else if (require.main === module) {
  pumpIndexSeeds().catch(e => serverLog("warn", "SEARCH", `Seed startup failed: ${e.message}`));
  if (CFG.indexRefreshMs > 0) setInterval(() => pumpIndexSeeds().catch(e => serverLog("warn", "SEARCH", `Seed scheduler failed: ${e.message}`)), 30000).unref();
  serverLog("info", "SYSTEM", "PROCESS_ROLE=worker selected; no HTTP listener started.");
}

module.exports = { app, CFG, normalizeUrl, resolveNavigation, resolveResource, makeViewUrl, makeResourceUrl, rewriteHtml, rewriteCssText, rewriteJsText, injectRuntime, detectChallenge, PriorityFrontier, robotsAllowed, crawlPriority, tokenizeSearch, parseSearchQuery, localSearch, searchIndexStats, indexDocument, localSearchSuggestions };
