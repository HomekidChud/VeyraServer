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
  // CRAWLER_ROBOTS is the logical crawler fleet. Actual simultaneous network
  // fetches are bounded independently by MAX_ACTIVE_FETCHES.
  logicalRobots: numberEnv("CRAWLER_ROBOTS", 1000, 1, 1000),
  maxActiveFetches: numberEnv("MAX_ACTIVE_FETCHES", numberEnv("MAX_GLOBAL_CONCURRENCY", 128, 1, 256), 1, 256),
  globalConcurrency: numberEnv("MAX_ACTIVE_FETCHES", numberEnv("MAX_GLOBAL_CONCURRENCY", 128, 1, 256), 1, 256),
  perHostConcurrency: numberEnv("CRAWLER_PER_HOST_CONCURRENCY", numberEnv("MAX_PER_HOST_CONCURRENCY", 8, 1, 32), 1, 32),
  robotTaskCapacity: numberEnv("ROBOT_TASK_CAPACITY", 4, 1, 16),
  robotActiveTasks: numberEnv("ROBOT_ACTIVE_TASKS", 4, 1, 8),
  robotHelpEnabled: boolEnv("ROBOT_HELP_ENABLED", true),
  robotHelpThreshold: numberEnv("ROBOT_HELP_THRESHOLD", 2, 1, 16),
  robotHelpCooldownMs: numberEnv("ROBOT_HELP_COOLDOWN_MS", 250, 0, 10000),
  robotHelpScanLimit: numberEnv("ROBOT_HELP_SCAN_LIMIT", 24, 1, 128),
  robotWorksetSize: numberEnv("ROBOT_WORKSET_SIZE", 1000, 8, 1000),
  robotQueueCapacity: numberEnv("ROBOT_QUEUE_CAPACITY", 8, 2, 32),
  robotStealBatch: numberEnv("ROBOT_STEAL_BATCH", 2, 1, 8),
  robotStealOnIdle: boolEnv("ROBOT_STEAL_ON_IDLE", true),
  browserMaxActiveFetches: numberEnv("BROWSER_MAX_ACTIVE_FETCHES", 24, 1, 64),
  browserPerHostConcurrency: numberEnv("BROWSER_PER_HOST_CONCURRENCY", 8, 1, 32),
  dnsCacheTtlMs: numberEnv("DNS_CACHE_TTL_MS", 5000, 0, 60000),
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
  maxDownloadBytes: numberEnv("MAX_DOWNLOAD_BYTES", 64 * 1024 * 1024, 256 * 1024, 256 * 1024 * 1024),
  maxCacheBodyBytes: numberEnv("MAX_CACHE_BODY_BYTES", 4 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024),
  proxySessionTtlMs: numberEnv("PROXY_SESSION_TTL_MS", 30 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000),
  maxProxySessions: numberEnv("MAX_PROXY_SESSIONS", 500, 10, 5000),
  maxSessionCookies: numberEnv("MAX_SESSION_COOKIES", 50, 5, 500),
  proxyWarmRobots: numberEnv("PROXY_WARM_ROBOTS", 64, 1, 1000),
  proxyWarmConcurrency: numberEnv("PROXY_WARM_CONCURRENCY", 12, 1, 64),
  proxyWarmLimit: numberEnv("PROXY_WARM_LIMIT", 64, 1, 256),
  proxyWarmPerHost: numberEnv("PROXY_WARM_PER_HOST", 3, 1, 16),
  userAgent: process.env.VEYRA_USER_AGENT || "VeyraBrowseCrawler/8.5 (+https://github.com/HomekidChud/VeyraServer)",
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
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept", "X-Veyra-Request-ID", "X-Requested-With", "X-CSRF-Token", "X-XSRF-Token", "DNT", "Cache-Control", "Pragma", "Range"],
  exposedHeaders: ["X-Veyra-Request-ID", "X-Veyra-Canonical-URL", "X-Veyra-Challenge", "X-Veyra-Content-Type", "X-Veyra-Session-ID"]
}));
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false, limit: CFG.maxFormBodyBytes }));

const jobs = new Map();
const activeByRoot = new Map();
const proxyCache = new Map();
const searchCache = new Map();
const proxySessions = new Map();

class Semaphore {
  constructor(limit) { this.limit = Math.max(1, limit); this.active = 0; this.waiters = []; }
  get available() { return Math.max(0, this.limit - this.active); }
  get queued() { return this.waiters.length; }
  async acquire(signal) {
    if (signal?.aborted) throw new Error("Operation cancelled.");
    if (this.active < this.limit) { this.active += 1; return () => this.release(); }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      if (signal) {
        waiter.onAbort = () => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error("Operation cancelled."));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }
  release() {
    this.active = Math.max(0, this.active - 1);
    while (this.waiters.length && this.active < this.limit) {
      const waiter = this.waiters.shift();
      if (waiter.signal?.aborted) { waiter.reject(new Error("Operation cancelled.")); continue; }
      this.active += 1;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(() => this.release());
      break;
    }
  }
}
const fetchSemaphore = new Semaphore(CFG.maxActiveFetches);
const proxyWarmSemaphore = new Semaphore(CFG.proxyWarmConcurrency);
const dnsPublicCache = new Map();
const searchIndex = new Map();
const invertedIndex = new Map();
const termCounts = new Map();
const serverLogs = [];
const clientLogs = [];
const requestLog = [];
let requestLogSeq = 0;
let logSeq = 0;
const serverStartedAt = Date.now();
const rewriteFailures = [];
function recordRewriteFailure(url, mode, err) {
  rewriteFailures.push({ time: new Date().toISOString(), url, mode, message: err?.message || String(err) });
  if (rewriteFailures.length > 100) rewriteFailures.splice(0, rewriteFailures.length - 100);
  serverLog("error", "PROXY", `HTML/CSS/JS rewrite failed for ${url} (${mode}): ${err?.message || err} — served the page unrewritten instead of failing the request.`);
}
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
function makeViewUrl(url, sid = "") {
  const q = `/api/view?url=${encodeURIComponent(url)}`;
  return sid ? `${q}&sid=${encodeURIComponent(sid)}` : q;
}
function makeResourceUrl(url, referrer = "", sid = "") {
  const q = `/api/resource?url=${encodeURIComponent(url)}`;
  const parts = [];
  try { const r = new URL(referrer); parts.push(`from=${encodeURIComponent(r.href)}`); } catch {}
  if (sid) parts.push(`sid=${encodeURIComponent(sid)}`);
  return parts.length ? `${q}&${parts.join("&")}` : q;
}
function typeFor(url, hint = "") {
  const p = String(url).toLowerCase().split("?")[0];
  const h = String(hint || "").toLowerCase();
  if (h === "css" || /\.css$/i.test(p)) return "css";
  if (h === "js" || /\.(?:js|mjs|cjs)$/i.test(p)) return "js";
  if (h === "image" || /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|apng|heic|heif)$/i.test(p)) return "image";
  if (h === "media" || /\.(?:mp3|wav|ogg|m4a|aac|flac|mp4|webm|mov|m3u8|ts|m4v)$/i.test(p)) return "media";
  if (h === "font" || /\.(?:woff2?|ttf|otf|eot)$/i.test(p)) return "font";
  if (h === "data" || /(?:^|\/)(?:api|graphql)(?:\/|$)/i.test(p) || /\.(?:json|xml|rss|atom|txt)$/i.test(p)) return "data";
  if (h === "asset" || h === "manifest") return "asset";
  if (h === "html" || /\.(?:html?|xhtml|php|asp|aspx|jsp)$/i.test(p) || !/\.[a-z0-9]{1,8}$/i.test(p)) return "html";
  return "asset";
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
async function assertPublicUrl(url, cache = dnsPublicCache) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error("Only HTTP(S) URLs are allowed.");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal") {
    throw new Error("Private/local destinations are blocked.");
  }
  if (net.isIP(host) && !assertIpPublic(host)) throw new Error("Private/local destinations are blocked.");
  const cached = cache?.get(host);
  if (cached && Date.now() - cached.time <= CFG.dnsCacheTtlMs) {
    if (cached.records.some(x => !assertIpPublic(x.address))) throw new Error("Private/local destinations are blocked.");
    return cached.records;
  }
  const records = await withTimeout(dns.lookup(host, { all: true, verbatim: true }), CFG.dnsTimeoutMs, "DNS lookup timed out.");
  if (!records.length) throw new Error("Destination could not be resolved.");
  if (records.some(x => !assertIpPublic(x.address))) throw new Error("Private/local destinations are blocked.");
  cache?.set(host, { time: Date.now(), records: records.map(x => ({ address: x.address, family: x.family })) });
  while (cache && cache.size > 5000) cache.delete(cache.keys().next().value);
  return records;
}

function normalizeSessionId(value) {
  const sid = String(value || "").trim();
  return /^[A-Za-z0-9_-]{16,80}$/.test(sid) ? sid : crypto.randomUUID().replaceAll("-", "");
}
function sessionRecord(sid) {
  const nowMs = Date.now();
  let session = proxySessions.get(sid);
  if (!session || nowMs - session.lastUsed > CFG.proxySessionTtlMs) {
    session = { createdAt: nowMs, lastUsed: nowMs, cookies: new Map() };
    proxySessions.set(sid, session);
    while (proxySessions.size > CFG.maxProxySessions) {
      const oldest = [...proxySessions.entries()].sort((a,b) => a[1].lastUsed - b[1].lastUsed)[0]?.[0];
      if (!oldest) break;
      proxySessions.delete(oldest);
    }
  }
  session.lastUsed = nowMs;
  return session;
}
function cookieDomainMatches(host, domain) {
  const h = String(host || "").toLowerCase();
  const d = String(domain || "").toLowerCase().replace(/^\./, "");
  return h === d || h.endsWith(`.${d}`);
}
function cookiePathMatches(pathname, cookiePath) {
  const p = pathname || "/", c = cookiePath || "/";
  return p === c || p.startsWith(c.endsWith("/") ? c : `${c}/`);
}
function storeSetCookies(sessionId, url, response) {
  if (!sessionId || typeof response?.headers?.getSetCookie !== "function") return;
  const values = response.headers.getSetCookie();
  if (!values?.length) return;
  const session = sessionRecord(sessionId), u = new URL(url);
  for (const raw of values.slice(0, 50)) {
    const parts = String(raw).split(";").map(x => x.trim());
    const pair = parts.shift();
    const eq = pair?.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
    if (!name || name.length > 128) continue;
    const cookie = { name, value, domain: u.hostname.toLowerCase(), path: "/", secure: false, expiresAt: 0, hostOnly: true };
    for (const attr of parts) {
      const i = attr.indexOf("=");
      const k = (i >= 0 ? attr.slice(0, i) : attr).trim().toLowerCase();
      const v = i >= 0 ? attr.slice(i + 1).trim() : "";
      if (k === "domain" && v) { cookie.domain = v.toLowerCase(); cookie.hostOnly = false; }
      else if (k === "path" && v.startsWith("/")) cookie.path = v.slice(0, 256);
      else if (k === "secure") cookie.secure = true;
      else if (k === "max-age") { const n = Number(v); if (Number.isFinite(n)) cookie.expiresAt = Date.now() + Math.max(0, n) * 1000; }
      else if (k === "expires") { const t = Date.parse(v); if (Number.isFinite(t)) cookie.expiresAt = t; }
    }
    const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
    if (cookie.expiresAt && cookie.expiresAt <= Date.now()) session.cookies.delete(key);
    else session.cookies.set(key, cookie);
  }
  while (session.cookies.size > CFG.maxSessionCookies) {
    const oldest = session.cookies.keys().next().value;
    if (!oldest) break;
    session.cookies.delete(oldest);
  }
}
function cookieHeader(sessionId, url) {
  if (!sessionId) return "";
  const session = sessionRecord(sessionId), u = new URL(url), pairs = [];
  for (const [key, cookie] of [...session.cookies.entries()]) {
    if (cookie.expiresAt && cookie.expiresAt <= Date.now()) { session.cookies.delete(key); continue; }
    if (cookie.secure && u.protocol !== "https:") continue;
    if (cookie.hostOnly ? cookie.domain !== u.hostname.toLowerCase() : !cookieDomainMatches(u.hostname, cookie.domain)) continue;
    if (!cookiePathMatches(u.pathname, cookie.path)) continue;
    pairs.push(`${cookie.name}=${cookie.value}`);
  }
  return pairs.join("; ");
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
  if (!headers.has("accept")) headers.set("accept", opts.accept || "text/html,application/xhtml+xml,application/xml,text/css,application/javascript,text/javascript,image/avif,image/webp,image/apng,image/svg+xml,font/*,video/*,audio/*,*/*;q=0.05");
  if (opts.range && !headers.has("range")) headers.set("range", String(opts.range).slice(0, 200));
  const sessionId = String(opts.sessionId || "");
  const redirectChain = [];
  let cached = opts.cached || null;
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    await assertPublicUrl(current, opts.dnsCache || dnsPublicCache);
    let lastError = null;
    let retriesUsed = 0;
    for (let attempt = 0; attempt <= (opts.retries ?? CFG.maxRetries); attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeout ?? CFG.requestTimeoutMs);
      try {
        const reqHeaders = new Headers(headers);
        if (sessionId) {
          reqHeaders.delete("cookie");
          const jarCookie = cookieHeader(sessionId, current);
          if (jarCookie) reqHeaders.set("cookie", jarCookie);
        }
        if (cached?.etag) reqHeaders.set("if-none-match", cached.etag);
        if (cached?.lastModified) reqHeaders.set("if-modified-since", cached.lastModified);
        const response = await fetch(current, {
          method,
          headers: reqHeaders,
          redirect: "manual",
          signal: controller.signal,
          body: opts.body && method !== "GET" && method !== "HEAD" ? opts.body : undefined
        });
        if (sessionId) storeSetCookies(sessionId, current, response);
        clearTimeout(timer);
        if (response.status === 304) {
          if (cached) return { ...cached.response, status: cached.response.status || 200, revalidated: true, redirectChain };
          // No local cached copy to revalidate against (e.g. cache evicted between the
          // conditional request being formed and this response arriving). Treat as a
          // normal empty-body 200 rather than throwing, so a benign 304 never surfaces
          // as a crawl/proxy failure.
        } else if (response.status >= 300 && response.status < 400) {
          const loc = response.headers.get("location");
          if (!loc) throw new Error(`HTTP ${response.status} redirect without Location`);
          const next = resolveNavigation(loc, current);
          if (!next) throw new Error("Invalid redirect destination.");
          redirectChain.push({ url: current, status: response.status });
          current = next;
          cached = null;
          break;
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
          linkHeader: response.headers.get("link") || "",
          contentDisposition: response.headers.get("content-disposition") || "",
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
          retries: retriesUsed,
          sessionId: sessionId || ""
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
  const key = `${method} ${normalizeUrl(url)} | ref=${referrerKey} | sid=${String(opts.sessionId || "")}`;
  const cachedEntry = opts.noCache || method !== "GET" ? null : proxyCache.get(key) || null;
  if (cachedEntry && Date.now() - cachedEntry.time <= CFG.proxyCacheMs && !opts.revalidate) {
    return { ...cachedEntry.response, cacheHit: true };
  }
  const result = await fetchBuffer(url, { ...opts, cached: cachedEntry && method === "GET" ? cachedEntry : null });
  if (!opts.noCache && method === "GET") {
    const noStore = /no-store/i.test(result.cacheControl || "");
    if (!noStore && !result.truncated && !result.tooLarge && Buffer.byteLength(result.body || Buffer.alloc(0)) <= CFG.maxCacheBodyBytes) {
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
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.seen = new Set();
    this.hosts = new Map();
    this.hostHeap = [];
    this.seq = 0;
    this.blockedScratch = [];
  }
  get size() { let n = 0; for (const bucket of this.hosts.values()) n += bucket.heap.length; return n; }
  #greater(a, b) { return a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq); }
  #up(heap, i) { while (i > 0) { const p = (i - 1) >> 1; if (!this.#greater(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } }
  #down(heap, i) { for (;;) { const l = i * 2 + 1, r = l + 1; let best = i; if (l < heap.length && this.#greater(heap[l], heap[best])) best = l; if (r < heap.length && this.#greater(heap[r], heap[best])) best = r; if (best === i) break; [heap[i], heap[best]] = [heap[best], heap[i]]; i = best; } }
  #pushNode(bucket, node) { bucket.heap.push(node); this.#up(bucket.heap, bucket.heap.length - 1); }
  #popNode(bucket) { const top = bucket.heap[0], last = bucket.heap.pop(); if (bucket.heap.length) { bucket.heap[0] = last; this.#down(bucket.heap, 0); } return top; }
  #pushHostRef(bucket) { const ref = { host: bucket.host, node: bucket.heap[0], seq: ++this.seq }; this.hostHeap.push(ref); this.#up(this.hostHeap, this.hostHeap.length - 1); }
  #popHostRef() { const top = this.hostHeap[0], last = this.hostHeap.pop(); if (this.hostHeap.length) { this.hostHeap[0] = last; this.#down(this.hostHeap, 0); } return top; }
  add(item, priority, key) {
    if (this.size >= this.maxSize || this.seen.has(key)) return false;
    this.seen.add(key);
    const host = hostOf(item.url) || '(unknown)';
    const node = { item, priority: Number(priority) || 0, seq: ++this.seq, host };
    let bucket = this.hosts.get(host);
    if (!bucket) { bucket = { host, heap: [] }; this.hosts.set(host, bucket); }
    const wasEmpty = bucket.heap.length === 0;
    this.#pushNode(bucket, node);
    if (wasEmpty || bucket.heap[0] === node) this.#pushHostRef(bucket);
    return true;
  }
  takeNext(activeHosts, perHostLimit, hostCooldowns) {
    if (!this.hostHeap.length) return null;
    const blocked = this.blockedScratch; blocked.length = 0;
    const nowMs = Date.now();
    let selected = null;
    while (this.hostHeap.length) {
      const ref = this.#popHostRef();
      const bucket = this.hosts.get(ref.host);
      if (!bucket || !bucket.heap.length || bucket.heap[0] !== ref.node) continue; // stale host-head ref
      const active = activeHosts.get(ref.host) || 0;
      const cooldown = hostCooldowns.get(ref.host) || 0;
      if (active >= perHostLimit || cooldown > nowMs) { blocked.push(ref); continue; }
      selected = this.#popNode(bucket);
      if (bucket.heap.length) this.#pushHostRef(bucket); else this.hosts.delete(ref.host);
      break;
    }
    for (const ref of blocked) this.hostHeap.push(ref), this.#up(this.hostHeap, this.hostHeap.length - 1);
    return selected?.item || null;
  }
  snapshot() {
    const items = [];
    for (const bucket of this.hosts.values()) for (const node of bucket.heap) items.push(node);
    return items.sort((a,b) => this.#greater(a,b) ? -1 : this.#greater(b,a) ? 1 : 0).map(x => x.item);
  }
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
  while (pending.length && files < CFG.maxSitemapFiles && urls < CFG.maxSitemapUrls && !job.stopRequested) {
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

function rewriteCssText(text, base, sid = "") {
  const src = String(text || "");
  const withUrls = src.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, quote, value) => {
    const u = resolveResource(value.trim(), base);
    return u ? `url("${makeResourceUrl(u, base, sid)}")` : m;
  });
  return withUrls.replace(/@import\s+(?:url\(\s*)?(["'])([^"']+)\1\s*\)?/gi, (m, quote, value) => {
    const u = resolveResource(value.trim(), base);
    return u ? `@import "${makeResourceUrl(u, base, sid)}"` : m;
  });
}
function rewriteJsText(text, base, sid = "") {
  const patterns = [
    /(\bimport\s*\(\s*|\bimport\s+(?:[^'"`]*?\s+from\s+)?|\bexport\s+[^'"`]*?\s+from\s+)(["'`])([^"'`]+)\2/g
  ];
  let out = String(text || "");
  for (const re of patterns) {
    out = out.replace(re, (m, prefix, quote, spec) => {
      const u = resolveResource(spec, base);
      return u ? `${prefix}${quote}${makeResourceUrl(u, base, sid)}${quote}` : m;
    });
  }
  return out;
}
function rewriteSrcset(raw, base, sid = "") {
  return String(raw || "").split(",").map(candidate => {
    const parts = candidate.trim().split(/\s+/);
    if (!parts[0]) return candidate;
    const u = resolveResource(parts[0], base);
    if (u) parts[0] = makeResourceUrl(u, base, sid);
    return parts.join(" ");
  }).join(", ");
}
function injectRuntime(html, original, sid = "") {
  const code = `<script>(function(){
  const CANONICAL=${JSON.stringify(original)};
  const SESSION_ID=${JSON.stringify(sid)};
  const API_ORIGIN=${JSON.stringify(process.env.PUBLIC_API_ORIGIN || "")};
  let virtualUrl=CANONICAL;
  window.__VEYRA_PAGE_URL__=CANONICAL;
  window.__VEYRA_PROXY__=true;
  function unwrap(v){try{const raw=String(v||'');if(raw==='/api/view'||raw==='/api/resource')return virtualUrl;const u=new URL(raw,location.origin);if((u.pathname==='/api/view'||u.pathname==='/api/resource')&&u.searchParams.get('url'))return u.searchParams.get('url');return raw}catch{return String(v||'')}}
  function resolve(v){try{return new URL(unwrap(typeof v==='string'?v:v&&v.url||''),virtualUrl).href}catch{return String(v||'')}}
  function shouldProxy(v){try{const u=new URL(unwrap(v));return /^https?:$/.test(u.protocol)}catch{return false}}
  function proxy(kind,u){const prefix=API_ORIGIN || location.origin;const base=prefix+(kind==='view'?'/api/view?url=':'/api/resource?url=')+encodeURIComponent(u);const from=encodeURIComponent(new URL(virtualUrl).href);return kind==='view'?base+'&sid='+encodeURIComponent(SESSION_ID):base+'&from='+from+'&sid='+encodeURIComponent(SESSION_ID)}
  function topPost(msg){try{window.top.postMessage(msg,'*')}catch{}}
  function emit(source,url,extra){if(!url)return;topPost({type:'veyra:navigate',url,source,sessionId:SESSION_ID,...extra})}
  function net(method,url,status,ms,ok){topPost({type:'veyra:browser-network',sessionId:SESSION_ID,pageUrl:virtualUrl,method:String(method||'GET').toUpperCase(),url:String(url||''),status:status||0,duration:Math.round(ms||0),ok:!!ok})}
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
    const started=performance.now(); const method=String(init&&init.method||input&&input.method||'GET').toUpperCase(); const original=String(input&&input.url||input||''); let target='';
    try{target=resolve(input);if(shouldProxy(target)){const proxied=(typeof Request!=='undefined'&&input instanceof Request)?new Request(proxy('resource',target),input):proxy('resource',target);return nativeFetch(proxied,init).then(r=>{net(method,target,r.status,performance.now()-started,r.ok);return r},e=>{net(method,target,0,performance.now()-started,false);throw e});}}catch{}
    return nativeFetch(input,init).then(r=>{net(method,target||original,r.status,performance.now()-started,r.ok);return r},e=>{net(method,target||original,0,performance.now()-started,false);throw e});
  };
  try{const nativeXhrOpen=XMLHttpRequest.prototype.open,nativeXhrSend=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(method,url,...rest){this.__veyraMethod=method;this.__veyraTarget=resolve(url);this.__veyraStarted=0;return nativeXhrOpen.call(this,method,shouldProxy(this.__veyraTarget)?proxy('resource',this.__veyraTarget):url,...rest)};XMLHttpRequest.prototype.send=function(body){this.__veyraStarted=performance.now();this.addEventListener('loadend',()=>net(this.__veyraMethod||'GET',this.__veyraTarget||'',this.status,performance.now()-this.__veyraStarted,this.status>=200&&this.status<400),{once:true});return nativeXhrSend.call(this,body)}}catch{}
  try{const NativeEventSource=window.EventSource;if(NativeEventSource)window.EventSource=function(url,options){const target=resolve(url);return new NativeEventSource(shouldProxy(target)?proxy('resource',target):url,options)}}catch{}
  try{const nativeBeacon=navigator.sendBeacon&&navigator.sendBeacon.bind(navigator);if(nativeBeacon)navigator.sendBeacon=function(url,data){try{const target=resolve(url);if(shouldProxy(target)){let body=data;let type='text/plain;charset=UTF-8';if(typeof Blob!=='undefined'&&data instanceof Blob)type=data.type||type;void fetch(proxy('resource',target),{method:'POST',body,keepalive:true,headers:{'content-type':type}});return true}}catch{}return nativeBeacon(url,data)}}catch{}
  try{const nativeFormSubmit=HTMLFormElement.prototype.submit;HTMLFormElement.prototype.submit=function(){try{const method=String(this.method||'get').toUpperCase();const target=canonicalizeMaybeProxy(this.getAttribute('action')||virtualUrl);if(target&&method==='GET'){const fd=new FormData(this);const u=new URL(target);for(const [k,v] of fd.entries())if(typeof v==='string')u.searchParams.append(k,v);emit('form.submit',u.href);return;}if(target&&method==='POST'){const fd=new FormData(this);const entries=[];for(const [k,v] of fd.entries()){if(typeof v!=='string'){topPost({type:'veyra:unsupported',reason:'File uploads are not supported by the server proxy.'});return;}entries.push([k,v])}topPost({type:'veyra:form',url:target,method:'POST',entries,sessionId:SESSION_ID});return;}}catch{}return nativeFormSubmit.call(this)}}catch{}
  try{const nativeRequestSubmit=HTMLFormElement.prototype.requestSubmit;if(nativeRequestSubmit)HTMLFormElement.prototype.requestSubmit=function(submitter){try{const target=canonicalizeMaybeProxy(this.getAttribute('action')||virtualUrl);if(target){const method=String(this.method||'get').toUpperCase();const fd=new FormData(this,submitter);if(method==='GET'){const u=new URL(target);for(const [k,v] of fd.entries())if(typeof v==='string')u.searchParams.append(k,v);emit('form.requestSubmit',u.href);return;}if(method==='POST'){const entries=[];for(const [k,v] of fd.entries()){if(typeof v!=='string'){topPost({type:'veyra:unsupported',reason:'File uploads are not supported by the server proxy.'});return;}entries.push([k,v])}topPost({type:'veyra:form',url:target,method:'POST',entries,sessionId:SESSION_ID});return;}}catch{}return nativeRequestSubmit.call(this,submitter)}}catch{}
  try{const nativeOpen=window.open;window.open=function(url,target,features){const u=canonicalizeMaybeProxy(url);if(u){topPost({type:'veyra:open',url:u,sessionId:SESSION_ID});return null}return nativeOpen.call(window,url,target,features)}}catch{}
  try{['log','info','debug','warn','error'].forEach(level=>{const native=console[level].bind(console);console[level]=(...args)=>{native(...args);topPost({type:'veyra:page-console',level,sessionId:SESSION_ID,message:args.map(x=>typeof x==='string'?x:(()=>{try{return JSON.stringify(x)}catch{return String(x)}})()).join(' '),pageUrl:virtualUrl})}})}catch{}
  window.addEventListener('error',e=>topPost({type:'veyra:page-error',level:'error',sessionId:SESSION_ID,message:e.message||'Resource error',url:e.filename||'',line:e.lineno||null,column:e.colno||null,stack:e.error&&e.error.stack||'',pageUrl:virtualUrl}),true);
  window.addEventListener('unhandledrejection',e=>topPost({type:'veyra:page-error',level:'error',sessionId:SESSION_ID,message:e.reason&&e.reason.message||String(e.reason||'Unhandled rejection'),stack:e.reason&&e.reason.stack||'',pageUrl:virtualUrl}),true);
  let inspectMode=false, inspectLast=0, inspectSelected=null;
  function inspectPath(el){const parts=[];let n=el;while(n&&n.nodeType===1&&parts.length<7){let s=n.tagName.toLowerCase();if(n.id)s+='#'+n.id.replace(/[^a-zA-Z0-9_-]/g,'-');else{let c=0,p=n;while((p=p.previousElementSibling))if(p.tagName===n.tagName)c++;if(c)s += ':nth-of-type(' + String(c+1) + ')'}parts.unshift(s);n=n.parentElement}return parts.join(' > ')}
  function inspectData(el){if(!el||el.nodeType!==1)return null;const rect=el.getBoundingClientRect();const attrs={};for(const a of [...el.attributes].slice(0,40))attrs[a.name]=a.value;let styles={};let computed={};try{const cs=getComputedStyle(el);for(const k of ['display','position','width','height','margin','padding','color','background','font','font-size','line-height','opacity','z-index','overflow','border','grid-template-columns','grid-template-rows','flex-direction','justify-content','align-items']){styles[k]=cs.getPropertyValue(k)||''}}catch{}try{const cs=getComputedStyle(el);for(let i=0;i<cs.length&&i<140;i++){const k=cs[i];if(/^(margin|padding|font|color|background|display|position|width|height|border|grid|flex|overflow|opacity|z-index)/i.test(k))computed[k]=cs.getPropertyValue(k)}}catch{}const outer=String(el.outerHTML||'').slice(0,16000);const children=[...el.children].slice(0,60).map((c,i)=>({index:i,tag:c.tagName.toLowerCase(),id:c.id||'',classes:String(c.className||'').slice(0,300),path:inspectPath(c)}));const parent=el.parentElement?{tag:el.parentElement.tagName.toLowerCase(),id:el.parentElement.id||'',path:inspectPath(el.parentElement)}:null;return {tag:el.tagName.toLowerCase(),id:el.id||'',classes:String(el.className||'').slice(0,500),attrs,path:inspectPath(el),outerHTML:outer,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},scrollWidth:el.scrollWidth||0,scrollHeight:el.scrollHeight||0,styles,computed,inlineStyle:el.getAttribute('style')||'',parent,children,tree:inspectPath(el)} }
  function inspectEmit(type,el){const data=inspectData(el);if(!data)return;topPost({type,sessionId:SESSION_ID,pageUrl:virtualUrl,...data})}
  window.addEventListener('message',function(ev){const d=ev.data||{};if(!d||d.type!=='veyra:inspect')return;inspectMode=!!d.enabled;if(!inspectMode&&inspectSelected){try{inspectSelected.style.removeProperty('outline')}catch{}inspectSelected=null}topPost({type:'veyra:inspect-state',enabled:inspectMode,sessionId:SESSION_ID,pageUrl:virtualUrl})});
  window.addEventListener('message',function(ev){const d=ev.data||{};if(d.type==='veyra:find'){try{const q=String(d.query||'').slice(0,200);if(!q){window.getSelection()?.removeAllRanges();topPost({type:'veyra:find-result',matches:0,pageUrl:virtualUrl});return;}let text=String(document.body?.innerText||'').slice(0,2000000);const hay=text.toLocaleLowerCase(),needle=q.toLocaleLowerCase();const matches=needle?(hay.split(needle).length-1):0;window.find(q,false,String(d.direction||'forward')==='backward',true,false,false,false);topPost({type:'veyra:find-result',matches,pageUrl:virtualUrl});}catch{}}else if(d.type==='veyra:find-close'){try{window.getSelection()?.removeAllRanges();}catch{}}else if(d.type==='veyra:print'){try{window.print();}catch{}}});
  document.addEventListener('mousemove',function(ev){if(!inspectMode)return;const now=performance.now();if(now-inspectLast<45)return;inspectLast=now;let el=ev.target;if(!(el instanceof Element))return;inspectEmit('veyra:inspect-hover',el)},true);
  document.addEventListener('click',function(ev){if(inspectMode){ev.preventDefault();ev.stopPropagation();let el=ev.target;while(el&&el.nodeType===1&&el.tagName==='HTML')el=el.parentElement;inspectSelected=el;if(el)inspectEmit('veyra:inspect-select',el);return;}
    const a=ev.target&&ev.target.closest?ev.target.closest('a[href],area[href]'):null;if(!a)return;
    const raw=a.getAttribute('href')||'';const u=canonicalizeMaybeProxy(raw);if(!u)return;
    ev.preventDefault();ev.stopPropagation();
    if(String(a.getAttribute('target')||'').toLowerCase()==='_blank')topPost({type:'veyra:open',url:u,sessionId:SESSION_ID});else emit('document-navigation',u);
  },true);
  document.addEventListener('submit',function(ev){
    const form=ev.target;if(!form||!form.action)return;const method=String(form.method||'get').toUpperCase();
    const target=canonicalizeMaybeProxy(form.getAttribute('action')||virtualUrl);if(!target)return;
    if(method==='GET'){
      ev.preventDefault();const fd=new FormData(form);const u=new URL(target);for(const [k,v] of fd.entries()){if(typeof v==='string')u.searchParams.append(k,v)}emit('document-navigation',u.href);return;
    }
    if(method==='POST'){
      const fd=new FormData(form);const entries=[];for(const [k,v] of fd.entries()){if(typeof v!=='string'){topPost({type:'veyra:unsupported',reason:'File uploads are not supported by the server proxy.'});return;}entries.push([k,v])}
      ev.preventDefault();topPost({type:'veyra:form',url:target,method:'POST',entries,sessionId:SESSION_ID});
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
function rewriteHtml(html, base, sid = "") {
  const $ = cheerio.load(String(html || ""), { decodeEntities: false });
  $("base").remove();
  $("meta[http-equiv]").filter((_, el) => String($(el).attr("http-equiv") || "").toLowerCase() === "content-security-policy").remove();
  $("a[href],area[href]").each((_, el) => { const u = resolveNavigation($(el).attr("href"), base); if (u) $(el).attr("href", makeViewUrl(u, sid)); });
  $("form[action]").each((_, el) => { const u = resolveNavigation($(el).attr("action"), base); if (u) $(el).attr("action", makeViewUrl(u, sid)); });
  $("iframe[src]").each((_, el) => { const u = resolveNavigation($(el).attr("src"), base); if (u) $(el).attr("src", makeViewUrl(u, sid)); });
  $("object[data]").each((_, el) => { const u = resolveResource($(el).attr("data"), base); if (u) $(el).attr("data", makeResourceUrl(u, base, sid)); });
  $("link[href]").each((_, el) => {
    const rel = String($(el).attr("rel") || "").toLowerCase();
    if (rel.includes("canonical")) return;
    const raw = $(el).attr("href"); const u = resolveResource(raw, base); if (u) { $(el).attr("href", makeResourceUrl(u, base, sid)); if ($(el).attr("integrity")) $(el).removeAttr("integrity"); }
  });
  $("script[src]").each((_, el) => { const u = resolveResource($(el).attr("src"), base); if (u) { $(el).attr("src", makeResourceUrl(u, base, sid)); if ($(el).attr("integrity")) $(el).removeAttr("integrity"); } });
  for (const tag of ["img", "source", "audio", "input", "embed"]) {
    $(`${tag}[src]`).each((_, el) => { const u = resolveResource($(el).attr("src"), base); if (u) $(el).attr("src", makeResourceUrl(u, base, sid)); });
  }
  $("video[poster]").each((_, el) => { const u = resolveResource($(el).attr("poster"), base); if (u) $(el).attr("poster", makeResourceUrl(u, base, sid)); });
  $("track[src]").each((_, el) => { const u = resolveResource($(el).attr("src"), base); if (u) $(el).attr("src", makeResourceUrl(u, base, sid)); });
  // Do not use CSS selectors containing xlink:href here: css-select/Cheerio can
  // throw on the escaped namespace syntax for otherwise valid SVG documents.
  // Walk the SVG elements directly and inspect both href forms.
  $("use, image").each((_, el) => {
    const rawHref = $(el).attr("href");
    const rawXlink = $(el).attr("xlink:href");
    const attr = rawHref != null ? "href" : (rawXlink != null ? "xlink:href" : null);
    if (!attr) return;
    const u = resolveResource($(el).attr(attr) || "", base);
    if (u) $(el).attr(attr, makeResourceUrl(u, base, sid));
  });
  $("[imagesrcset]").each((_, el) => $(el).attr("imagesrcset", rewriteSrcset($(el).attr("imagesrcset"), base, sid)));
  for (const attr of ["data-src", "data-original", "data-lazy-src"]) {
    $(`[${attr}]`).each((_, el) => { const u = resolveResource($(el).attr(attr), base); if (u) $(el).attr(attr, makeResourceUrl(u, base, sid)); });
  }
  $(`[data-srcset]`).each((_, el) => $(el).attr("data-srcset", rewriteSrcset($(el).attr("data-srcset"), base, sid)));
  $("track[src]").each((_, el) => { const u = resolveResource($(el).attr("src"), base); if (u) $(el).attr("src", makeResourceUrl(u, base, sid)); });
  $("[srcset]").each((_, el) => $(el).attr("srcset", rewriteSrcset($(el).attr("srcset"), base, sid)));
  $("meta[http-equiv='refresh'],meta[http-equiv='Refresh']").each((_, el) => {
    const raw = $(el).attr("content") || ""; const m = raw.match(/^(\s*\d+\s*;\s*url\s*=\s*)(.+)$/i); if (!m) return;
    const u = resolveNavigation(m[2].trim().replace(/^['"]|['"]$/g, ""), base); if (u) $(el).attr("content", `${m[1]}${makeViewUrl(u, sid)}`);
  });
  $("style").each((_, el) => $(el).html(rewriteCssText($(el).html() || "", base)));
  $("[style]").each((_, el) => $(el).attr("style", rewriteCssText($(el).attr("style") || "", base)));
  return injectRuntime($.html(), base, sid);
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
  const record = { url: u, path: pathOf(u), type, source: source || job.root, internal: sameOrigin(u, job.root), captured: false, requestedUrl: u, redirectChain: [], priority: crawlPriority(u, type === "html" ? "html" : type, reason) };
  job.links.push(record); job.counts.links += 1;
  if (type === "html") {
    if (job.pagesDiscovered >= CFG.maxPages || !robotsAllowed(u, job.robots)) return true;
    job.pagesDiscovered += 1;
    job.pageFrontier.add({ url: u, type, source: source || null, reason }, record.priority, key);
  } else {
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
  const src = String(text || "");
  const patterns = [
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\bimport\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\bexport\s+[^"'`]*?\s+from\s+["'`]([^"'`]+)["'`]/g,
    /\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:axios|got|request)\.(?:get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    /\burl\s*:\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:endpoint|apiUrl|baseUrl|graphqlEndpoint)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi,
    /\b(?:window\.open|location(?:\.assign|\.replace)?|location\.href)\s*=?\s*["'`]([^"'`]+)["'`]/g,
    /["'`]((?:https?:)?\/\/(?:[^"'`\s]+)|\/(?:api|graphql|_next\/data|trpc)(?:\/|[^"'`\s]*))/gi
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) {
    const raw = m[1];
    const hint = /(?:api|graphql|_next\/data|trpc|\.json(?:$|[?#]))/i.test(raw) ? "data" : typeFor(raw);
    addLink(job, raw, hint, base, "script-discovered");
  }
}
function discoverLinkHeader(job, header, base) {
  const raw = String(header || "");
  for (const part of raw.split(/,(?=<)/)) {
    const m = part.match(/<([^>]+)>\s*(.*)$/); if (!m) continue; const rel = String(m[2] || "");
    const u = resolveResource(m[1], base); if (!u) continue;
    const hint = /rel\s*=\s*["'][^"']*preload[^"']*["']/i.test(rel) && /as\s*=\s*["']script["']/i.test(rel) ? "js" : /as\s*=\s*["']font["']/i.test(rel) ? "font" : /as\s*=\s*["']image["']/i.test(rel) ? "image" : /as\s*=\s*["']video|audio["']/i.test(rel) ? "media" : typeFor(u);
    addLink(job, u, hint, base, "http-link");
  }
}
function discoverDataText(job, text, base) {
  const src = String(text || "");
  for (const m of src.matchAll(/(?:https?:\/\/[^\s"'<>\\]+|\/(?:api|graphql|trpc|_next\/data)(?:[/?#][^\s"'<>\\]*)?)/gi)) {
    const raw = m[0].replace(/[),.;]+$/g, ""); addLink(job, raw, "data", base, "data-discovered");
  }
  if (/application\/(?:json|ld\+json)|text\/(?:plain|xml)/i.test(src.slice(0,200))) discoverJs(job, src, base);
}

function discoverHtml(job, text, base) {
  const $ = cheerio.load(String(text || ""), { decodeEntities: false });
  const addSet = (raw, hint, reason = "discovered") => {
    String(raw || "").split(/,|\s+/).map(x => x.trim()).filter(Boolean).forEach(x => {
      const first = x.replace(/^["']|["']$/g, "");
      if (first && !/^\d+(?:px|w|x)$/i.test(first)) addLink(job, first, hint, base, reason);
    });
  };
  $("a[href],area[href]").each((_, el) => addLink(job, $(el).attr("href"), "html", base, "navigation"));
  $("link[href]").each((_, el) => {
    const rel = String($(el).attr("rel") || "").toLowerCase();
    const as = String($(el).attr("as") || "").toLowerCase();
    let hint = rel.includes("stylesheet") ? "css" : as === "script" ? "js" : as === "image" ? "image" : as === "font" ? "font" : as === "video" || as === "audio" ? "media" : rel.includes("manifest") ? "manifest" : rel.includes("canonical") || rel.includes("alternate") ? "html" : "asset";
    addLink(job, $(el).attr("href"), hint, base, rel.includes("canonical") ? "canonical" : rel.includes("preload") || rel.includes("modulepreload") ? "preload" : "discovered");
  });
  $("script[src]").each((_, el) => addLink(job, $(el).attr("src"), "js", base));
  $("iframe[src],frame[src]").each((_, el) => addLink(job, $(el).attr("src"), "html", base));
  $("img[src]").each((_, el) => addLink(job, $(el).attr("src"), "image", base));
  $("img[data-src],img[data-original],img[data-lazy-src]").each((_, el) => {
    for (const attr of ["data-src","data-original","data-lazy-src"]) if ($(el).attr(attr)) addLink(job, $(el).attr(attr), "image", base, "lazy");
  });
  $("img,source,video,audio,iframe,script,link").each((_, el) => {
    for (const attr of ["data-url","data-href","data-src","data-original","data-lazy","data-lazy-src"]) {
      const raw = $(el).attr(attr); if (!raw || /^data:image|^data:video|^blob:/i.test(raw)) continue;
      addLink(job, raw, typeFor(raw, $(el).prop("tagName") === "IMG" ? "image" : "asset"), base, "data-attribute");
    }
  });
  $("picture source[src],picture source[srcset],source[src],source[srcset]").each((_, el) => {
    if ($(el).attr("src")) addLink(job, $(el).attr("src"), typeFor($(el).attr("src"), "asset"), base);
    if ($(el).attr("srcset")) addSet($(el).attr("srcset"), "image");
  });
  $("video[src],audio[src]").each((_, el) => addLink(job, $(el).attr("src"), "media", base));
  $("video[poster]").each((_, el) => addLink(job, $(el).attr("poster"), "image", base));
  $("track[src]").each((_, el) => addLink(job, $(el).attr("src"), "data", base));
  $("input[src]").each((_, el) => addLink(job, $(el).attr("src"), "asset", base));
  $("embed[src]").each((_, el) => addLink(job, $(el).attr("src"), "asset", base));
  $("object[data]").each((_, el) => addLink(job, $(el).attr("data"), "asset", base));
  $("svg image,svg use").each((_, el) => {
    const raw = $(el).attr("href") || $(el).attr("xlink:href") || "";
    addLink(job, raw.split("#")[0], "image", base, "svg-reference");
  });
  $("meta[property='og:image'],meta[property='og:image:url'],meta[name='twitter:image'],meta[name='twitter:image:src'],meta[itemprop='image'],meta[name='msapplication-tileimage'],meta[property='og:logo']").each((_, el) => addLink(job, $(el).attr("content"), "image", base, "metadata"));
  $("meta[name='twitter:player'],meta[property='og:video'],meta[property='og:video:url'],meta[property='og:audio']").each((_, el) => addLink(job, $(el).attr("content"), "media", base, "metadata"));
  $("link[rel~='icon'],link[rel~='apple-touch-icon'],link[rel~='mask-icon']").each((_, el) => addLink(job, $(el).attr("href"), "image", base, "icon"));
  $("link[rel~='manifest']").each((_, el) => addLink(job, $(el).attr("href"), "asset", base));
  $("form[action],form[formaction]").each((_, el) => addLink(job, $(el).attr("action") || $(el).attr("formaction"), "html", base, "navigation"));
  $("[formaction]").each((_, el) => addLink(job, $(el).attr("formaction"), "html", base, "navigation"));
  $("link[rel='canonical']").each((_, el) => addLink(job, $(el).attr("href"), "html", base, "canonical"));
  $("meta[http-equiv='refresh']").each((_, el) => {
    const raw = String($(el).attr("content") || ""); const m = raw.match(/url\s*=\s*(.+)$/i); if (m) addLink(job, m[1].trim().replace(/^["']|["']$/g, ""), "html", base, "navigation");
  });
  $("[srcset],[imagesrcset],[data-srcset]").each((_, el) => addSet($(el).attr("srcset") || $(el).attr("imagesrcset") || $(el).attr("data-srcset"), "image"));
  $("style").each((_, el) => discoverCss(job, $(el).text(), base));
  $("[style]").each((_, el) => discoverCss(job, $(el).attr("style") || "", base));
  $("template").each((_, el) => {
    const inner = String($(el).html() || ""); if (inner) discoverHtml(job, inner, base);
  });
  // Script/data URL heuristics catch same-origin JSON/GraphQL endpoints and
  // static resources that aren't represented by DOM tags. This is discovery,
  // not execution or security bypassing.
  discoverJs(job, String(text || ""), base);
}
function discoverMediaManifest(job, text, base) {
  const src=String(text||'');
  const isHls=/^#EXTM3U/m.test(src)||/mpegurl|\.m3u8(?:$|[?#])/i.test(base);
  if(isHls){for(const line of src.split(/\r?\n/)){const raw=line.trim();if(!raw||raw.startsWith('#'))continue;const u=resolveResource(raw,base);if(u)addLink(job,u,'media',base,'media-manifest');}return;}
  if(/<MPD[\s>]/i.test(src)||/dash\+xml|\.mpd(?:$|[?#])/i.test(base)){for(const m of src.matchAll(/(?:media|initialization|sourceURL|href)\s*=\s*["']([^"']+)["']/gi)){const u=resolveResource(m[1],base);if(u)addLink(job,u,'media',base,'media-manifest');}for(const m of src.matchAll(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi)){const u=resolveResource(m[1].trim(),base);if(u)addLink(job,u,'media',base,'media-manifest');}}
}
function rewriteMediaManifest(text, base, sid='') {
  const src=String(text||'');
  if(/^#EXTM3U/m.test(src)||/mpegurl|\.m3u8(?:$|[?#])/i.test(base))return src.split(/\r?\n/).map(line=>{const raw=line.trim();if(!raw||raw.startsWith('#'))return line;const u=resolveResource(raw,base);return u?makeResourceUrl(u,base,sid):line;}).join('\n');
  if(/<MPD[\s>]/i.test(src)||/dash\+xml|\.mpd(?:$|[?#])/i.test(base)){const $=cheerio.load(src,{decodeEntities:false,xmlMode:true});$('[media],[initialization],[sourceURL],[href],BaseURL').each((_,el)=>{if(String(el.tagName||'').toLowerCase()==='baseurl'){const raw=$(el).text().trim();const u=resolveResource(raw,base);if(u)$(el).text(makeResourceUrl(u,base,sid));return;}for(const attr of ['media','initialization','sourceURL','href']){const raw=$(el).attr(attr);if(raw){const u=resolveResource(raw,base);if(u)$(el).attr(attr,makeResourceUrl(u,base,sid));}}});return $.xml();}
  return src;
}

function createJob(root) {
  const id = crypto.randomUUID();
  return {
    id, root, url: root, createdAt: now(), finishedAt: null, done: false, stopRequested: false, status: "queued", statusText: "Queued",
    pageFrontier: new PriorityFrontier(CFG.maxPendingQueue), resourceFrontier: new PriorityFrontier(CFG.maxPendingQueue), visited: new Set(), discovered: new Set(),
    resources: [], links: [], logs: [], logSeq: 0, sourceDir: path.join(ROOT, id), sourceFiles: 0, textBytesStored: 0,
    activeWorkers: 0, activeHtmlWorkers: 0, activeAssetWorkers: 0, processed: 0, pagesDiscovered: 0, resourcesScheduled: 0,
    robots: null, robotsReady: false, sitemaps: new Set(), challengeHosts: new Set(), hostActive: new Map(), hostCooldowns: new Map(), hostLastRequested: new Map(), hostFailures: new Map(), hostDelayMs: 0, stopReason: null,
    counts: { htmlPages: 0, css: 0, js: 0, data: 0, assets: 0, links: 0, bytesScanned: 0, bytesStored: 0, bytesDiscarded: 0, requestCount: 0, retries: 0, challenges: 0, errors: 0 },
    controller: new AbortController(),
    dnsCache: new Map(),
    robotPool: null,
    robotEvents: []
  };
}
function publicJob(job) {
  const queued = job.pageFrontier.size + job.resourceFrontier.size;
  return {
    id: job.id, url: job.url, createdAt: job.createdAt, finishedAt: job.finishedAt, done: job.done,
    status: job.status, statusText: job.statusText, stopRequested: job.stopRequested,
    maxUrls: CFG.maxResources, maxScanBytes: CFG.maxScanBytes, elapsedMs: Date.now() - Date.parse(job.createdAt),
    counts: { ...job.counts, processed: job.processed, queued, active: job.activeWorkers },
    workers: { html: { active: job.activeHtmlWorkers, max: CFG.maxActiveFetches, queued: job.pageFrontier.size }, asset: { active: job.activeAssetWorkers, max: CFG.maxActiveFetches, queued: job.resourceFrontier.size }, logicalRobots: job.robotFleet || CFG.logicalRobots, networkSlots: CFG.maxActiveFetches, availableNetworkSlots: fetchSemaphore.available, queuedNetworkWaiters: fetchSemaphore.queued },
    limits: { globalConcurrency: CFG.maxActiveFetches, crawlerRobots: CFG.logicalRobots, logicalRobots: CFG.logicalRobots, maxActiveFetches: CFG.maxActiveFetches, perHostConcurrency: CFG.perHostConcurrency, maxPages: CFG.maxPages, maxResources: CFG.maxResources, maxLinks: CFG.maxLinks, maxScanBytes: CFG.maxScanBytes },
    searchIndex: searchIndexStats(),
    robotsLoaded: job.robotsReady, sitemapsFound: job.sitemaps.size, sourceFiles: job.sourceFiles, textBytesStored: job.textBytesStored,
    resourceCount: job.resources.length, linkCount: job.links.length, logs: job.logs.slice(-120),
    robotMesh: job.robotPool ? { summary: job.robotPool.report(1).summary } : null,
    queue: { pages: job.pageFrontier.snapshot().slice(0, 50), resources: job.resourceFrontier.snapshot().slice(0, 50) }
  };
}
function crawlLimitForContentType(contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("text/html") || type.includes("application/xhtml") || type.includes("text/css") || /javascript|ecmascript|json|xml/.test(type)) return CFG.maxTextBytesPerResource;
  if (type.startsWith("image/") || type.includes("svg")) return CFG.maxProxyImageBytes;
  if (type.startsWith("video/") || type.startsWith("audio/") || type.includes("application/pdf")) return CFG.maxProxyMediaBytes;
  return CFG.maxProxyOtherBytes;
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
  const accept = item.type === "html" ? "text/html,application/xhtml+xml,application/xml,text/plain;q=0.4,*/*;q=0.05" : "text/css,application/javascript,text/javascript,application/json,image/avif,image/webp,image/apng,image/svg+xml,image/*,font/*,video/*,audio/*,*/*;q=0.05";
  try {
    job.counts.requestCount += 1;
    const r = await fetchCached(item.url, { accept, limit: CFG.maxTextBytesPerResource, limitForContentType: crawlLimitForContentType, timeout: CFG.requestTimeoutMs, retries: CFG.maxRetries, referrer: item.source || "", dnsCache: job.dnsCache });
    job.counts.bytesScanned += r.bytes;
    if (r.retries) job.counts.retries += r.retries;
    if (r.truncated || r.tooLarge) { job.counts.bytesDiscarded += r.bytes; jobLog(job, "warn", `Response skipped after size limit: ${item.url}`); return; }
    if (job.counts.bytesScanned > CFG.maxScanBytes) { job.stopRequested = true; job.stopReason = "scan-byte-limit"; return; }
    const lower = r.contentType.toLowerCase();
    if (r.linkHeader) discoverLinkHeader(job, r.linkHeader, r.finalUrl || item.url);
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
    else if (/json|xml|text\/plain|graphql/.test(lower)) type = "data";
    else if (lower.startsWith("image/") || lower.includes("svg")) type = "image";
    else if (lower.startsWith("video/") || lower.startsWith("audio/") || /mpegurl/.test(lower)) type = "media";
    else if (/font\//.test(lower) || /woff|truetype|opentype/.test(lower)) type = "font";
    else type = type || "asset";
    if (!['html', 'css', 'js', 'data', 'asset', 'image', 'media', 'font'].includes(type)) return;
    if (job.resources.length >= CFG.maxResources) { job.stopRequested = true; job.stopReason = "resource-limit"; return; }
    const isTextType = type === "html" || type === "css" || type === "js" || type === "data";
    const text = isTextType ? r.body.toString("utf8") : "";
    const id = job.resources.length;
    const sourceFile = isTextType ? await sourceStore.write(job, id, text) : null;
    const resource = {
      id, url: r.finalUrl || item.url, requestedUrl: item.url, type, status: r.status, contentType: r.contentType,
      bytes: r.bytes, bytesLabel: bytesLabel(r.bytes), truncated: r.truncated, sourceFile, inlinePreview: sourceFile ? "" : (isTextType ? text.slice(0, 8000) : ""), sourceId: item.source || null,
      redirectChain: r.redirectChain || [], revalidated: !!r.revalidated
    };
    job.resources.push(resource);
    const link = job.links.find(x => x.url === item.url || x.url === resource.url); if (link) { link.captured = true; link.redirectChain = resource.redirectChain; link.url = resource.url; }
    job.hostFailures.set(host, 0); job.hostCooldowns.delete(host);
    if (type === "html") {
      job.counts.htmlPages += 1; indexDocument(resource.url, text); discoverHtml(job, text, resource.url);
      job.counts.bytesStored += Math.min(r.bytes, CFG.maxTextBytesPerResource);
    } else if (type === "css") {
      job.counts.css += 1; discoverCss(job, text, resource.url);
      job.counts.bytesStored += Math.min(r.bytes, CFG.maxTextBytesPerResource);
    } else if (type === "js") {
      job.counts.js += 1; discoverJs(job, text, resource.url);
      job.counts.bytesStored += Math.min(r.bytes, CFG.maxTextBytesPerResource);
    } else if (type === "data") {
      job.counts.data += 1;
      job.counts.bytesStored += Math.min(r.bytes, CFG.maxTextBytesPerResource);
      discoverDataText(job, text, resource.url);
      if (/json|xml|graphql|javascript|api|ld\+json/i.test(r.contentType)) discoverJs(job, text, resource.url);
    } else if (type === "image" || type === "media" || type === "font" || type === "asset") {
      job.counts.assets += 1;
      job.counts.bytesStored += Math.min(r.bytes, CFG.maxCacheBodyBytes);
      if (type === "media" && /mpegurl|dash\+xml/i.test(r.contentType || "")) discoverMediaManifest(job, text, resource.url);
    }
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
class CooperativeRobotPool {
  constructor(job) {
    this.job = job;
    this.count = Math.max(1, job.robotFleet || CFG.logicalRobots);
    this.taskCapacity = Math.max(CFG.robotTaskCapacity, CFG.robotQueueCapacity);
    this.activeCapacity = Math.min(CFG.robotActiveTasks, this.taskCapacity);
    this.worksetSize = Math.min(this.count, CFG.robotWorksetSize);
    this.worksetCursor = 0;
    this.robots = Array.from({ length: this.count }, (_, index) => ({
      id: `robot-${String(index + 1).padStart(4, "0")}`,
      status: "idle",
      queue: [],
      activeTasks: 0,
      completed: 0,
      errors: 0,
      helpRequests: 0,
      helpAccepted: 0,
      helpDeclined: 0,
      helpGiven: 0,
      tasksTakenByHelp: 0,
      lastTask: null,
      lastActionAt: now(),
      lastHelpAt: 0,
      lastHelpDecision: null,
      currentHosts: new Set(),
      activeHelpTasks: 0,
      loadBucket: 0,
      countActive: false,
      countMulti: false,
      countIdle: true
    }));
    this.loadBuckets = Array.from({ length: this.taskCapacity + this.activeCapacity + 1 }, () => new Set());
    this.helpCandidates = new Set();
    for (const robot of this.robots) { robot.loadBucket = 0; this.loadBuckets[0].add(robot); }
    this.totalQueued = 0;
    this.activeRobotCount = 0;
    this.multitaskingRobotCount = 0;
    this.idleRobotCount = this.count;
    this.activePromises = new Set();
    this.running = false;
    this.eventSeq = 0;
    this.events = [];
  }
  event(type, data = {}) {
    const e = { id: ++this.eventSeq, time: now(), type, ...data };
    this.events.push(e);
    if (this.events.length > 250) this.events.splice(0, this.events.length - 250);
    return e;
  }
  load(robot) { return robot.activeTasks + robot.queue.length; }
  loadLimit() { return this.taskCapacity + this.activeCapacity; }
  updateLoadBucket(robot) {
    const old = robot.loadBucket ?? this.load(robot);
    const next = this.load(robot);
    if (old === next) return;
    this.loadBuckets[old]?.delete(robot);
    if (!this.loadBuckets[next]) this.loadBuckets[next] = new Set();
    this.loadBuckets[next].add(robot);
    robot.loadBucket = next;
  }
  markShareable(robot) {
    const should = robot.queue.length >= CFG.robotHelpThreshold;
    if (should) this.helpCandidates.add(robot);
    else this.helpCandidates.delete(robot);
  }
  idleRobots(limit = Infinity) {
    const out = [];
    const bucket = this.loadBuckets[0] || new Set();
    for (const r of bucket) { out.push(r); if (out.length >= limit) break; }
    return out;
  }
  availableHelpers(limit = Infinity) {
    const out = [];
    for (let load = 0; load < this.activeCapacity && out.length < limit; load++) {
      for (const robot of this.loadBuckets[load] || []) {
        if (robot.queue.length === 0 && robot.activeTasks < this.activeCapacity) out.push(robot);
        if (out.length >= limit) break;
      }
    }
    return out;
  }
  availableRobots() {
    const out = [];
    for (let load = 0; load < this.loadBuckets.length; load++) {
      for (const r of this.loadBuckets[load] || []) out.push(r);
      if (out.length >= this.count) break;
    }
    return out;
  }
  busyRobots() { return this.robots.filter(r => r.activeTasks > 0 || r.queue.length > 0); }
  pendingLocal() { return this.totalQueued; }
  totalPending() { return this.pendingLocal() + this.job.pageFrontier.size + this.job.resourceFrontier.size; }
  active() { return this.activePromises.size; }
  chooseFrontierTask() {
    if (!this.job.pageFrontier.size && !this.job.resourceFrontier.size) return null;
    // Keep document navigation ahead of secondary assets while still serving assets
    // aggressively once the page frontier is short.
    let type = "html";
    if (!this.job.pageFrontier.size) type = "asset";
    else if (this.job.resourceFrontier.size > this.job.pageFrontier.size * 2) type = "asset";
    let item = type === "html"
      ? this.job.pageFrontier.takeNext(this.job.hostActive, CFG.perHostConcurrency, this.job.hostCooldowns)
      : this.job.resourceFrontier.takeNext(this.job.hostActive, CFG.perHostConcurrency, this.job.hostCooldowns);
    if (!item) {
      const other = type === "html" ? "asset" : "html";
      item = other === "html"
        ? this.job.pageFrontier.takeNext(this.job.hostActive, CFG.perHostConcurrency, this.job.hostCooldowns)
        : this.job.resourceFrontier.takeNext(this.job.hostActive, CFG.perHostConcurrency, this.job.hostCooldowns);
    }
    return item || null;
  }
  chooseReceiver() {
    // Load buckets make 1,000 logical robots cheap: selecting a receiver is O(1-ish)
    // instead of scanning the entire fleet for every assignment.
    const maxLoad = this.loadLimit();
    for (let load = 0; load <= maxLoad && load < this.taskCapacity; load++) {
      const bucket = this.loadBuckets[load];
      if (!bucket?.size) continue;
      // Set insertion order naturally rotates robots as their load changes; no
      // 1,000-element array copy is needed for every assignment.
      return bucket.values().next().value || null;
    }
    return null;
  }
  assignGlobalTasks() {
    let assigned = 0;
    const candidates = [];
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const idx = (this.worksetCursor + i) % n; const r = this.robots[idx];
      if (r.activeTasks < this.activeCapacity || r.queue.length < this.taskCapacity) candidates.push(r);
    }
    candidates.sort((a,b) => this.load(a) - this.load(b) || a.lastActionAt - b.lastActionAt);
    const selected = candidates.slice(0, this.worksetSize);
    if (selected.length) this.worksetCursor = (this.worksetCursor + selected.length) % n;
    while (assigned < CFG.maxActiveFetches * 2 && this.job.pageFrontier.size) {
      let moved = false;
      for (const robot of selected) {
        if (robot.queue.length >= this.taskCapacity) continue;
        const item = this.job.pageFrontier.takeNext(this.job.hostActive, CFG.perHostConcurrency, this.job.hostCooldowns); if (!item) break;
        robot.queue.push(item); this.totalQueued += 1; robot.lastActionAt = now(); this.markShareable(robot); this.updateLoadBucket(robot); assigned += 1; moved = true;
        if (assigned >= CFG.maxActiveFetches * 2) break;
      }
      if (!moved) break;
    }
    while (assigned < CFG.maxActiveFetches * 2 && this.job.resourceFrontier.size) {
      let moved = false;
      for (const robot of selected) {
        if (robot.queue.length >= this.taskCapacity) continue;
        const item = this.job.resourceFrontier.takeNext(this.job.hostActive, CFG.perHostConcurrency, this.job.hostCooldowns); if (!item) break;
        robot.queue.push(item); this.totalQueued += 1; robot.lastActionAt = now(); this.markShareable(robot); this.updateLoadBucket(robot); assigned += 1; moved = true;
        if (assigned >= CFG.maxActiveFetches * 2) break;
      }
      if (!moved) break;
    }
    return assigned;
  }
  decideHelp(target, requester) {
    const backlog = target.queue.length;
    const healthy = target.errors < Math.max(3, target.completed / 25 + 1);
    const cooldownOk = Date.now() - target.lastHelpAt >= CFG.robotHelpCooldownMs;
    const hasShareableWork = backlog >= CFG.robotHelpThreshold;
    const minimumKeep = 1;
    const maximumTransfer = Math.min(CFG.robotStealBatch, Math.max(0, backlog - minimumKeep));
    const accept = CFG.robotHelpEnabled && healthy && cooldownOk && hasShareableWork && maximumTransfer > 0;
    target.lastHelpDecision = { from: requester.id, accepted: accept, backlog, at: now(), keep: minimumKeep, transfer: accept ? maximumTransfer : 0 };
    return accept ? maximumTransfer : 0;
  }
  async requestHelp(requester) {
    if (!CFG.robotHelpEnabled || !CFG.robotStealOnIdle || requester.helpRequests >= 1000 || requester.activeTasks >= this.activeCapacity || requester.queue.length > 0) return false;
    const candidates = [...this.helpCandidates]
      .filter(r => r.id !== requester.id && r.queue.length >= CFG.robotHelpThreshold)
      .sort((a, b) => b.queue.length - a.queue.length || b.activeTasks - a.activeTasks || a.errors - b.errors)
      .slice(0, CFG.robotHelpScanLimit);
    if (!candidates.length) return false;
    requester.helpRequests += 1;
    this.event("help-requested", { requester: requester.id, candidates: candidates.map(r => ({ id: r.id, queuedTasks: r.queue.length })) });
    for (const target of candidates) {
      const accepted = this.decideHelp(target, requester);
      if (accepted) {
        let moved = 0; const tasks = [];
        while (moved < accepted) {
          const item = target.queue.pop();
          if (!item) break;
          item._helped = true;
          item._helpFrom = target.id;
          requester.queue.push(item);
          this.totalQueued = Math.max(0, this.totalQueued);
          tasks.push({ url: item.url, type: item.type, reason: item.reason || "discovered" });
          moved += 1;
        }
        if (!moved) continue;
        this.updateLoadBucket(target);
        this.updateLoadBucket(requester);
        this.markShareable(target);
        this.markShareable(requester);
        requester.helpAccepted += 1;
        requester.tasksTakenByHelp += moved;
        target.helpGiven += moved;
        target.lastHelpAt = Date.now();
        this.event("help-accepted", { requester: requester.id, target: target.id, count: moved, tasks });
        this.updateStatus(target); this.updateStatus(requester);
        return true;
      }
      requester.helpDeclined += 1;
      this.event("help-declined", { requester: requester.id, target: target.id, backlog: target.queue.length, reason: target.lastHelpDecision });
    }
    return false;
  }
  sweepHelpRequests() {
    if (!CFG.robotHelpEnabled || Date.now() - this.lastHelpSweep < CFG.robotHelpCooldownMs) return 0;
    this.lastHelpSweep = Date.now();
    const requests = this.availableHelpers(CFG.robotHelpScanLimit);
    let accepted = 0;
    if (!requests.length || !this.helpCandidates.size) return 0;
    for (const robot of requests) {
      if (!this.helpCandidates.size) break;
      if (this.requestHelp(robot)) accepted += 1;
    }
    return accepted;
  }
  updateStatus(robot) {
    if (robot.activeTasks > 1) robot.status = robot.activeHelpTasks > 0 ? "multitasking-help" : "multitasking";
    else if (robot.activeTasks === 1) robot.status = robot.activeHelpTasks > 0 ? "helping" : "working";
    else if (robot.queue.length) robot.status = "queued";
    else robot.status = "idle";
    const isActive = robot.activeTasks > 0;
    const isMulti = robot.activeTasks > 1;
    const isIdle = robot.activeTasks === 0 && robot.queue.length === 0;
    this.activeRobotCount += Number(isActive) - Number(robot.countActive);
    this.multitaskingRobotCount += Number(isMulti) - Number(robot.countMulti);
    this.idleRobotCount += Number(isIdle) - Number(robot.countIdle);
    robot.countActive = isActive;
    robot.countMulti = isMulti;
    robot.countIdle = isIdle;
  }
  startTask(robot, item) {
    if (!item || robot.activeTasks >= this.activeCapacity) return false;
    const taskHost = hostOf(item.url);
    if ((this.job.hostActive.get(taskHost) || 0) >= CFG.perHostConcurrency) return false;
    const cooldownUntil = this.job.hostCooldowns.get(taskHost) || 0;
    if (cooldownUntil > Date.now()) return false;
    const helped = !!item._helped;
    robot.activeTasks += 1;
    if (helped) robot.activeHelpTasks += 1;
    robot.lastTask = { url: item.url, type: item.type, reason: item.reason || "discovered", startedAt: now(), helped, helpedBy: item._helpFrom || null };
    delete item._helped; delete item._helpFrom;
    robot.lastActionAt = now();
    const host = taskHost;
    robot.currentHosts.add(host);
    this.updateLoadBucket(robot);
    this.markShareable(robot);
    this.updateStatus(robot);
    const run = (async () => {
      this.job.activeWorkers += 1;
      this.job.hostActive.set(host, (this.job.hostActive.get(host) || 0) + 1);
      if (item.type === "html") this.job.activeHtmlWorkers += 1; else this.job.activeAssetWorkers += 1;
      let release = null;
      try {
        release = await fetchSemaphore.acquire(this.job.controller.signal);
        await processItem(this.job, item);
        robot.completed += 1;
      } catch (e) {
        robot.errors += 1;
        if (!this.job.stopRequested && e?.message !== "Operation cancelled.") {
          jobLog(this.job, "debug", `${robot.id} could not process ${item.url}: ${e.message}`);
        }
      } finally {
        if (release) release();
        this.job.activeWorkers = Math.max(0, this.job.activeWorkers - 1);
        this.job.hostActive.set(host, Math.max(0, (this.job.hostActive.get(host) || 1) - 1));
        if (item.type === "html") this.job.activeHtmlWorkers = Math.max(0, this.job.activeHtmlWorkers - 1);
        else this.job.activeAssetWorkers = Math.max(0, this.job.activeAssetWorkers - 1);
        robot.activeTasks = Math.max(0, robot.activeTasks - 1);
        if (helped && robot.activeHelpTasks > 0) robot.activeHelpTasks -= 1;
        robot.currentHosts.delete(host);
        robot.lastActionAt = now();
        robot.lastTask = { ...(robot.lastTask || {}), finishedAt: now() };
        this.updateLoadBucket(robot);
        this.markShareable(robot);
        this.updateStatus(robot);
        // Every time a robot becomes fully free, it immediately inspects the mesh
        // and asks another robot for work. The target explicitly accepts or declines.
        if (robot.queue.length <= 1 && robot.activeTasks < this.activeCapacity && !this.job.stopRequested) void this.requestHelp(robot);
      }
    })();
    this.activePromises.add(run);
    run.finally(() => this.activePromises.delete(run)).catch(() => {});
    return true;
  }
  startAvailable() {
    let started = 0;
    // Starting work from lowest-load buckets keeps work spread across the fleet.
    for (let load = 0; load < this.loadBuckets.length && this.activePromises.size < CFG.maxActiveFetches; load++) {
      const robots = [...(this.loadBuckets[load] || [])];
      for (const robot of robots) {
        while (robot.activeTasks < this.activeCapacity && robot.queue.length && this.activePromises.size < CFG.maxActiveFetches) {
          const item = robot.queue.shift();
          this.totalQueued = Math.max(0, this.totalQueued - 1);
          this.updateLoadBucket(robot); this.markShareable(robot);
          if (this.startTask(robot, item)) started += 1;
          else { robot.queue.unshift(item); this.totalQueued += 1; this.updateLoadBucket(robot); this.markShareable(robot); break; }
        }
        this.updateStatus(robot);
        if (this.activePromises.size >= CFG.maxActiveFetches) break;
      }
    }
    return started;
  }
  rebalanceLocals() {
    if (!CFG.robotHelpEnabled) return;
    this.sweepHelpRequests();
    if (this.helpCandidates.size) {
      for (const robot of this.availableHelpers(CFG.robotHelpScanLimit)) void this.requestHelp(robot);
    }
  }
  report(limit = 48) {
    const rows = this.robots
      .filter(r => r.activeTasks || r.queue.length || r.completed || r.helpRequests)
      .sort((a,b) => this.load(b) - this.load(a) || b.completed - a.completed)
      .slice(0, Math.max(1, Math.min(limit, this.count)))
      .map(r => ({
        id: r.id, status: r.status, activeTasks: r.activeTasks, queuedTasks: r.queue.length,
        completed: r.completed, errors: r.errors, helpRequests: r.helpRequests,
        helpAccepted: r.helpAccepted, helpDeclined: r.helpDeclined, helpGiven: r.helpGiven,
        tasksTakenByHelp: r.tasksTakenByHelp, lastTask: r.lastTask, lastHelpDecision: r.lastHelpDecision,
        hosts: [...r.currentHosts]
      }));
    const summary = {
      logicalRobots: this.count, worksetSize: this.worksetSize, taskCapacity: this.taskCapacity, activeTaskCapacityPerRobot: this.activeCapacity,
      activeRobots: this.activeRobotCount,
      multitaskingRobots: this.multitaskingRobotCount,
      idleRobots: this.idleRobotCount,
      queuedRobotTasks: this.pendingLocal(), globalPageQueue: this.job.pageFrontier.size, globalResourceQueue: this.job.resourceFrontier.size,
      networkActive: this.active(), networkLimit: CFG.maxActiveFetches,
      helpRequests: this.robots.reduce((n,r) => n + r.helpRequests, 0), helpAccepted: this.robots.reduce((n,r) => n + r.helpAccepted, 0),
      helpDeclined: this.robots.reduce((n,r) => n + r.helpDeclined, 0), helpGiven: this.robots.reduce((n,r) => n + r.helpGiven, 0)
    };
    return { summary, robots: rows, events: this.events.slice(-80) };
  }
  async run() {
    this.running = true;
    while (!this.job.stopRequested) {
      if (!this.job.robotsReady) { await sleep(5); continue; }
      if (this.job.counts.bytesScanned >= CFG.maxScanBytes) { this.job.stopRequested = true; this.job.stopReason = "scan-byte-limit"; break; }
      this.assignGlobalTasks();
      this.rebalanceLocals();
      this.startAvailable();
      if (!this.activePromises.size) {
        if (!this.totalPending()) break;
        await sleep(8);
        continue;
      }
      await Promise.race(this.activePromises);
    }
    await Promise.allSettled([...this.activePromises]);
    this.running = false;
  }
}

async function runCrawl(job) {
  job.status = "starting"; job.statusText = "Preparing cooperative robot mesh…";
  await fsp.mkdir(job.sourceDir, { recursive: true });
  addLink(job, job.root, "html", null, "root");
  job.robotFleet = CFG.logicalRobots;
  job.networkSlots = CFG.maxActiveFetches;
  job.robotPool = new CooperativeRobotPool(job);
  try {
    await loadRobots(job);
    if (!job.stopRequested) await loadSitemaps(job);
    job.status = "crawling"; job.statusText = `Crawling with ${CFG.logicalRobots.toLocaleString()} cooperative robots…`;
    await job.robotPool.run();
    job.done = true; job.finishedAt = now();
    if (job.status === "challenge") job.statusText = "Security verification required; crawl stopped.";
    else if (job.stopRequested && job.stopReason === "scan-byte-limit") { job.status = "done"; job.statusText = `Scan budget reached (${bytesLabel(CFG.maxScanBytes)}).`; }
    else if (job.stopRequested && job.stopReason === "resource-limit") { job.status = "done"; job.statusText = `Resource safety limit reached (${CFG.maxResources.toLocaleString()}).`; }
    else if (job.stopRequested) { job.status = "stopped"; job.statusText = "Stopped by user."; }
    else { job.status = "done"; job.statusText = `Complete — ${job.processed.toLocaleString()} resources scanned.`; }
    jobLog(job, job.status === "done" ? "info" : "warn", job.statusText, { robots: job.robotPool.report(12).summary });
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
  res.json({ time: now(), uptimeSec: Math.round(process.uptime()), startedAt: new Date(serverStartedAt).toISOString(), nodeVersion: process.version, platform: process.platform, processRole: CFG.processRole, memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external }, jobs: { total: jobs.size, active: [...jobs.values()].filter(j => !j.done).length, done: [...jobs.values()].filter(j => j.done).length }, proxyCacheEntries: proxyCache.size, searchCacheEntries: searchCache.size, network: { crawlerActive: fetchSemaphore.active, crawlerQueued: fetchSemaphore.queued, crawlerLimit: CFG.maxActiveFetches, logicalRobots: CFG.logicalRobots, warmActive: proxyWarmSemaphore.active, warmQueued: proxyWarmSemaphore.queued, warmLimit: CFG.proxyWarmConcurrency, warmLogicalRobots: CFG.proxyWarmRobots, browserActive: browserScheduler.active, browserQueued: browserScheduler.queue.length, browserLimit: CFG.browserMaxActiveFetches, browserPerHost: CFG.browserPerHostConcurrency }, browser: { ...browserScheduler.status(), sessions: proxySessions.size, cacheEntries: proxyCache.size }, searchIndexEntries: idx.documents, searchIndexTerms: idx.terms, searchIndexDomains: idx.domains, requestsLogged: requestLog.length, logs: serverLogs.length });
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

function extractWarmUrls(html, base, sid) {
  const $ = cheerio.load(String(html || ""), { decodeEntities: false });
  const out = new Set();
  const add = raw => { const u = resolveResource(raw, base); if (u) out.add(u); };
  $("link[href]").each((_, el) => {
    const rel = String($(el).attr("rel") || "").toLowerCase();
    if (rel.includes("stylesheet") || rel.includes("preload") || rel.includes("modulepreload") || rel.includes("icon") || rel.includes("manifest")) add($(el).attr("href"));
  });
  $("script[src]").each((_, el) => add($(el).attr("src")));
  $("img[src],source[src],video[poster],audio[src],input[src],embed[src]").each((_, el) => add($(el).attr(el.name === "video" ? "poster" : "src")));
  $("[srcset]").each((_, el) => { const first = String($(el).attr("srcset") || "").split(",")[0]?.trim().split(/\s+/)[0]; if (first) add(first); });
  $("[imagesrcset],[data-src],[data-original],[data-lazy-src]").each((_, el) => {
    const attr = $(el).attr("imagesrcset") != null ? "imagesrcset" : ($(el).attr("data-src") != null ? "data-src" : ($(el).attr("data-original") != null ? "data-original" : "data-lazy-src"));
    const raw = $(el).attr(attr) || "";
    add(attr.endsWith("srcset") ? raw.split(",")[0]?.trim().split(/\s+/)[0] : raw);
  });
  return [...out].slice(0, Math.min(CFG.proxyWarmLimit, 256)).map(url => ({ url, sid }));
}
async function warmPageResources(html, base, sid) {
  if (CFG.proxyWarmLimit <= 0) return;
  const candidates = extractWarmUrls(html, base, sid);
  const hostActive = new Map();
  let cursor = 0;
  const next = () => candidates[cursor++];
  const worker = async () => {
    while (true) {
      const item = next(); if (!item) return;
      const host = hostOf(item.url);
      while ((hostActive.get(host) || 0) >= CFG.proxyWarmPerHost) await sleep(5);
      hostActive.set(host, (hostActive.get(host) || 0) + 1);
      let release = null;
      try {
        release = await proxyWarmSemaphore.acquire();
        await fetchCached(item.url, { sessionId: item.sid, referrer: base, accept: "text/css,application/javascript,image/avif,image/webp,image/apng,image/svg+xml,image/*,font/*,video/*,audio/*,*/*;q=0.05", limit: CFG.maxTextBytesPerResource, timeout: CFG.requestTimeoutMs });
      } catch {} finally {
        if (release) release();
        hostActive.set(host, Math.max(0, (hostActive.get(host) || 1) - 1));
      }
    }
  };
  const workerCount = Math.min(CFG.proxyWarmConcurrency, CFG.proxyWarmRobots, candidates.length);
  await Promise.allSettled(Array.from({ length: workerCount }, worker));
}

function safeDownloadFilename(url, contentType = "") {
  let base = "download";
  try {
    const u = new URL(url);
    const last = decodeURIComponent((u.pathname || "").split("/").filter(Boolean).pop() || "").trim();
    if (last) base = last.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || base;
  } catch {}
  if (!/\.[a-z0-9]{1,8}$/i.test(base)) {
    const map = { "text/html": ".html", "text/css": ".css", "application/javascript": ".js", "text/javascript": ".js", "application/json": ".json", "image/svg+xml": ".svg", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "application/pdf": ".pdf" };
    const type = String(contentType || "").split(";")[0].toLowerCase();
    if (map[type]) base += map[type];
  }
  return base;
}

async function proxyRequest(req, res, mode) {
  const raw = String(req.query.url || "");
  const canonical = normalizeUrl(raw);
  const download = String(req.query.download || "") === "1";
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
  const sourceUrl = (() => { try { const u = new URL(String(req.query.from || "")); return /^https?:$/.test(u.protocol) ? u.href : ""; } catch { return ""; } })();
  const referrer = sourceUrl || "";
  const sourceOrigin = sourceUrl ? new URL(sourceUrl).origin : "";
  const sid = normalizeSessionId(req.query.sid);
  const headers = { accept, "content-type": req.get("Content-Type") || undefined, ...(req.get("Range") ? { range: String(req.get("Range")).slice(0, 200) } : {}), ...(referrer ? { referer: referrer } : {}), ...(sourceOrigin ? { origin: sourceOrigin } : {}) };
  for (const name of ["accept-language", "x-requested-with", "x-csrf-token", "x-xsrf-token", "dnt", "cache-control", "pragma"]) {
    const value = req.get(name);
    if (value) headers[name] = String(value).slice(0, 2000);
  }
  const limitForContentType = (ct) => {
    const type = String(ct || "").toLowerCase();
    if (type.includes("text/html") || type.includes("application/xhtml") || type.includes("text/css") || /javascript|ecmascript|json|xml/.test(type)) return CFG.maxProxyTextBytes;
    if (type.startsWith("image/") || type.includes("svg")) return CFG.maxProxyImageBytes;
    if (type.startsWith("video/") || type.startsWith("audio/") || type.includes("application/pdf")) return CFG.maxProxyMediaBytes;
    return CFG.maxProxyOtherBytes;
  };
  try {
    const browserKey = `${method} ${canonical}|ref=${referrer}|sid=${sid}|range=${headers.range || ""}|body=${body || ""}`;
    const browserPriority = mode === "view" ? 1000 : (/css|javascript|font|svg/i.test(accept) ? 900 : /image/i.test(accept) ? 800 : 700);
    const result = await browserScheduler.request(browserKey, () => fetchCached(canonical, { method, headers, body, referrer, sessionId: sid, limit: CFG.maxTextBytesPerResource, limitForContentType, noCache: method !== "GET" }), { priority: browserPriority, host: hostOf(canonical), url: canonical });
  if (result.tooLarge || (download && result.bytes > CFG.maxDownloadBytes)) return respondError(res, 413, "The upstream response exceeds Veyra's safety limit.", "RESPONSE_TOO_LARGE");
  const upstreamHeaders = {
    "content-type": result.contentType || (mode === "view" ? "text/html; charset=utf-8" : "application/octet-stream"),
    "cache-control": download ? "no-store" : mode === "view" ? "no-store" : "public, max-age=15",
    ...(download ? { "content-disposition": `attachment; filename="${safeDownloadFilename(result.finalUrl || canonical, result.contentType)}"` } : {}),
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
  try {
    if (!download && mode === "view" && (/html|xhtml|^$/.test(result.contentType.toLowerCase()))) payload = Buffer.from(rewriteHtml(payload.toString("utf8"), result.finalUrl || canonical, sid), "utf8");
    else if (!download && mode === "resource" && result.contentType.toLowerCase().includes("text/css")) payload = Buffer.from(rewriteCssText(payload.toString("utf8"), result.finalUrl || canonical, sid), "utf8");
    else if (!download && mode === "resource" && /javascript|ecmascript/.test(result.contentType.toLowerCase())) payload = Buffer.from(rewriteJsText(payload.toString("utf8"), result.finalUrl || canonical, sid), "utf8");
    else if (!download && mode === "resource" && /mpegurl|dash\+xml/i.test(result.contentType.toLowerCase())) payload = Buffer.from(rewriteMediaManifest(payload.toString("utf8"), result.finalUrl || canonical, sid), "utf8");
  } catch (rewriteErr) {
    // A parser edge case in the HTML/CSS/JS rewriter should degrade the page,
    // not fail the whole request. Serve the untouched upstream body instead —
    // in-page links/resources may point at the original site rather than
    // through Veyra, but the page still loads instead of hard-502ing.
    recordRewriteFailure(result.finalUrl || canonical, mode, rewriteErr);
    payload = result.body;
  }
  for (const [k,v] of Object.entries(upstreamHeaders)) if (v) res.setHeader(k, v);
  res.setHeader("X-Veyra-Canonical-URL", result.finalUrl || canonical);
  res.setHeader("X-Veyra-Session-ID", sid);
  res.setHeader("X-Veyra-Content-Type", result.contentType || "application/octet-stream");
  if (result.etag) res.setHeader("ETag", result.etag);
  if (result.lastModified) res.setHeader("Last-Modified", result.lastModified);
  const outputStatus = (result.status >= 300 && result.status < 400) ? 200 : result.status;
  const transformedText = (mode === "view" && /html|xhtml|^$/i.test(result.contentType || "")) || (mode === "resource" && /(?:text\/css|javascript|ecmascript)/i.test(result.contentType || ""));
  if (result.contentLength && !transformedText && !result.truncated && outputStatus !== 200) res.setHeader("content-length", result.contentLength);
  res.status(outputStatus).send(payload);
  if (mode === "view" && !result.truncated && !result.tooLarge && /html|xhtml|^$/i.test(result.contentType || "")) {
    void warmPageResources(result.body.toString("utf8"), result.finalUrl || canonical, sid);
  }
  } finally {
    // BrowserTaskScheduler owns browser request slots/host limits.
  }
}

app.get("/api/view", async (req, res) => { try { await proxyRequest(req, res, "view"); } catch (e) { respondError(res, 502, `Veyra could not load this page: ${e.message}`, "PROXY_VIEW_ERROR", { requestId: req.veyraRequestId }); } });
app.post("/api/view", async (req, res) => { try { await proxyRequest(req, res, "view"); } catch (e) { respondError(res, 502, `Veyra could not submit this form: ${e.message}`, "PROXY_FORM_ERROR", { requestId: req.veyraRequestId }); } });
app.get("/api/resource", async (req, res) => { try { await proxyRequest(req, res, "resource"); } catch (e) { respondError(res, 502, `Veyra resource error: ${e.message}`, "PROXY_RESOURCE_ERROR", { requestId: req.veyraRequestId }); } });
app.get("/api/download", async (req, res) => { try { req.query.download = "1"; await proxyRequest(req, res, "resource"); } catch (e) { respondError(res, 502, `Veyra download error: ${e.message}`, "DOWNLOAD_ERROR", { requestId: req.veyraRequestId }); } });
app.post("/api/resource", async (req, res) => { try { await proxyRequest(req, res, "resource"); } catch (e) { respondError(res, 502, `Veyra resource request failed: ${e.message}`, "PROXY_RESOURCE_POST_ERROR", { requestId: req.veyraRequestId }); } });
for (const method of ["put","patch","delete","head"]) app[method]("/api/resource", async (req,res)=>{ try { await proxyRequest(req,res,"resource"); } catch(e) { respondError(res,502,`Veyra resource ${method.toUpperCase()} request failed: ${e.message}`,"PROXY_RESOURCE_METHOD_ERROR",{requestId:req.veyraRequestId}); } });

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
app.get("/api/crawl/:id/robots", (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); if (!j.robotPool) return res.json({ summary: { logicalRobots: j.robotFleet || CFG.logicalRobots, activeRobots: 0, multitaskingRobots: 0, idleRobots: j.robotFleet || CFG.logicalRobots, queuedRobotTasks: 0, globalPageQueue: j.pageFrontier.size, globalResourceQueue: j.resourceFrontier.size, networkActive: fetchSemaphore.active, networkLimit: CFG.maxActiveFetches, helpRequests: 0, helpAccepted: 0, helpDeclined: 0, helpGiven: 0 }, robots: [], events: [] }); const limit = Math.min(100, Math.max(1, Number(req.query.limit || 48) || 48)); res.json(j.robotPool.report(limit)); });
app.get("/api/crawl/:id/resources", (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); res.json({ resources: j.resources.map(r => ({ id: r.id, url: r.url, requestedUrl: r.requestedUrl, type: r.type, status: r.status, contentType: r.contentType, bytes: r.bytes, bytesLabel: r.bytesLabel, truncated: r.truncated, sourceId: r.sourceId })) }); });
app.get("/api/crawl/:id/source/:resourceId", async (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); const id = Number(req.params.resourceId); const r = j.resources[id]; if (!r) return respondError(res, 404, "Resource not found.", "RESOURCE_NOT_FOUND"); res.json({ id: r.id, url: r.url, type: r.type, source: await sourceStore.read(j, r) }); });
app.get("/api/crawl/:id/links", (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); const offset = Math.max(0, Number(req.query.offset || 0) || 0); const limit = Math.min(10000, Math.max(1, Number(req.query.limit || 1000) || 1000)); res.json({ total: j.links.length, offset, limit, links: j.links.slice(offset, offset + limit) }); });
app.get("/api/crawl/:id/export", (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); res.setHeader("content-type", "application/json; charset=utf-8"); res.setHeader("content-disposition", `attachment; filename="veyra-${j.id}.json"`); res.send(JSON.stringify({ id:j.id, root:j.root, createdAt:j.createdAt, finishedAt:j.finishedAt, status:j.status, counts:j.counts, links:j.links, resources:j.resources.map(r => ({ id:r.id,url:r.url,type:r.type,status:r.status,contentType:r.contentType,bytes:r.bytes,truncated:r.truncated,redirectChain:r.redirectChain })) }, null, 2)); });

// ---------------------------------------------------------------------------
// /status — configuration diagnostics.
// Re-parses every environment variable the server actually reads (independent
// of the already-frozen CFG object) so it can report, per variable: whether it
// was set, whether the raw value was valid, whether it got clamped into range,
// and what value is actually in effect. It also scans process.env for
// look-alike keys (CRAWLER_/MAX_/PROXY_/SEARCH_/INDEX_/VEYRA_ prefixes) that
// aren't read anywhere in this file, so a typo'd or leftover env var shows up
// instead of silently doing nothing. Finally it runs a small set of
// cross-field rules that call out combinations known to cause runtime errors.
// ---------------------------------------------------------------------------
function diagNumber(names, fallback, min, max) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return { name, raw, present: true, effective: fallback, status: "invalid", detail: `"${raw}" is not a number — falling back to default ${fallback}.` };
    const clamped = Math.min(max, Math.max(min, Math.floor(n)));
    if (clamped !== Math.floor(n)) return { name, raw, present: true, effective: clamped, status: "clamped", detail: `${raw} is outside the allowed range ${min}–${max} — using ${clamped}.` };
    return { name, raw, present: true, effective: clamped, status: "set", detail: `Using ${clamped}.` };
  }
  return { name: names[0], raw: undefined, present: false, effective: fallback, status: "default", detail: `Not set — using default ${fallback}.` };
}
function diagBool(names, fallback) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === "") continue;
    const norm = String(raw).trim().toLowerCase();
    const known = ["1", "true", "yes", "on", "0", "false", "no", "off"];
    const effective = ["1", "true", "yes", "on"].includes(norm);
    if (!known.includes(norm)) return { name, raw, present: true, effective: fallback, status: "invalid", detail: `"${raw}" isn't a recognized boolean — falling back to default ${fallback}.` };
    return { name, raw, present: true, effective, status: "set", detail: `Using ${effective}.` };
  }
  return { name: names[0], raw: undefined, present: false, effective: fallback, status: "default", detail: `Not set — using default ${fallback}.` };
}
function diagEnum(names, fallback, allowed) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === "") continue;
    const norm = String(raw).trim().toLowerCase();
    if (!allowed.includes(norm)) return { name, raw, present: true, effective: fallback, status: "invalid", detail: `"${raw}" isn't one of ${allowed.join(", ")} — falling back to default "${fallback}".` };
    return { name, raw, present: true, effective: norm, status: "set", detail: `Using "${norm}".` };
  }
  return { name: names[0], raw: undefined, present: false, effective: fallback, status: "default", detail: `Not set — using default "${fallback}".` };
}
function diagCsv(names, fallback) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === "") continue;
    const list = raw.split(",").map(x => x.trim()).filter(Boolean);
    return { name, raw, present: true, effective: list, status: "set", detail: `Using [${list.join(", ")}].` };
  }
  return { name: names[0], raw: undefined, present: false, effective: fallback, status: "default", detail: `Not set — using default [${fallback.join(", ")}].` };
}
function diagString(names, fallback, secret = false) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === "") continue;
    return { name, raw: secret ? "(hidden)" : raw, present: true, effective: secret ? "(hidden)" : raw, status: "set", detail: secret ? "A value is set." : `Using "${raw}".` };
  }
  return { name: names[0], raw: undefined, present: false, effective: secret ? "" : fallback, status: fallback ? "default" : "unset", detail: fallback ? `Not set — using default "${fallback}".` : "Not set." };
}

const STATUS_VAR_DEFS = [
  { group: "Core service", key: "port", label: "Port", kind: "number", names: ["PORT"], fallback: 10000, min: 1, max: 65535, note: "Render supplies this automatically; only set it manually for local runs." },
  { group: "Core service", key: "processRole", label: "Process role", kind: "enum", names: ["PROCESS_ROLE"], fallback: "web", allowed: ["web", "worker", "all"] },
  { group: "Core service", key: "logLevel", label: "Log level", kind: "enum", names: ["SERVER_LOG_LEVEL"], fallback: "info", allowed: ["error", "warn", "info", "debug"] },
  { group: "Frontend / CORS", key: "frontendOrigin", label: "Allowed frontend origin(s)", kind: "csv", names: ["FRONTEND_ORIGIN"], fallback: ["*"] },
  { group: "Frontend / CORS", key: "publicApiOrigin", label: "Public API origin (for rewritten pages)", kind: "string", names: ["PUBLIC_API_ORIGIN"], fallback: "" },
  { group: "Frontend / CORS", key: "userAgent", label: "Crawler user agent", kind: "string", names: ["VEYRA_USER_AGENT"], fallback: "VeyraBrowseCrawler/8.0 (+https://github.com/)" },
  { group: "Crawler concurrency", key: "logicalRobots", label: "Logical crawler robots", kind: "number", names: ["CRAWLER_ROBOTS"], fallback: 1000, min: 1, max: 1000 },
  { group: "Robot mesh", key: "robotWorksetSize", label: "Robot workset size", kind: "number", names: ["ROBOT_WORKSET_SIZE"], fallback: 1000, min: 8, max: 1000 },
  { group: "Robot mesh", key: "robotQueueCapacity", label: "Robot local queue capacity", kind: "number", names: ["ROBOT_QUEUE_CAPACITY"], fallback: 8, min: 2, max: 32 },
  { group: "Robot mesh", key: "robotStealBatch", label: "Help steal batch", kind: "number", names: ["ROBOT_STEAL_BATCH"], fallback: 4, min: 1, max: 8 },
  { group: "Robot mesh", key: "robotStealOnIdle", label: "Idle robots request help", kind: "bool", names: ["ROBOT_STEAL_ON_IDLE"], fallback: true },
  { group: "Crawler concurrency", key: "maxActiveFetches", label: "Active network fetch slots", kind: "number", names: ["MAX_ACTIVE_FETCHES", "MAX_GLOBAL_CONCURRENCY"], fallback: 128, min: 1, max: 256, note: "This is the real simultaneous upstream-request ceiling; CRAWLER_ROBOTS is a larger logical fleet." },
  { group: "Crawler concurrency", key: "perHostConcurrency", label: "Per-host concurrency", kind: "number", names: ["CRAWLER_PER_HOST_CONCURRENCY", "MAX_PER_HOST_CONCURRENCY"], fallback: 8, min: 1, max: 32, note: "Per-origin safety cap; robots.txt Crawl-delay still applies." },
  { group: "Crawler cooperation", key: "robotTaskCapacity", label: "Tasks queued/robot", kind: "number", names: ["ROBOT_TASK_CAPACITY"], fallback: 4, min: 1, max: 16 },
  { group: "Crawler cooperation", key: "robotActiveTasks", label: "Active tasks/robot", kind: "number", names: ["ROBOT_ACTIVE_TASKS"], fallback: 2, min: 1, max: 8 },
  { group: "Crawler cooperation", key: "robotHelpEnabled", label: "Robot help enabled", kind: "bool", names: ["ROBOT_HELP_ENABLED"], fallback: true },
  { group: "Crawler cooperation", key: "robotHelpThreshold", label: "Help backlog threshold", kind: "number", names: ["ROBOT_HELP_THRESHOLD"], fallback: 2, min: 1, max: 16 },
  { group: "Crawler cooperation", key: "robotHelpCooldownMs", label: "Help cooldown (ms)", kind: "number", names: ["ROBOT_HELP_COOLDOWN_MS"], fallback: 250, min: 0, max: 10000 },
  { group: "Crawler cooperation", key: "robotHelpScanLimit", label: "Robots inspected/request", kind: "number", names: ["ROBOT_HELP_SCAN_LIMIT"], fallback: 24, min: 1, max: 128 },
  { group: "Browser engine", key: "browserMaxActiveFetches", label: "Browser fetch slots", kind: "number", names: ["BROWSER_MAX_ACTIVE_FETCHES"], fallback: 24, min: 1, max: 64 },
  { group: "Browser engine", key: "browserPerHostConcurrency", label: "Browser per-host concurrency", kind: "number", names: ["BROWSER_PER_HOST_CONCURRENCY"], fallback: 8, min: 1, max: 32 },
  { group: "Security / DNS", key: "dnsCacheTtlMs", label: "DNS public-result cache TTL (ms)", kind: "number", names: ["DNS_CACHE_TTL_MS"], fallback: 5000, min: 0, max: 60000 },
  { group: "Crawl limits", key: "maxActiveJobs", label: "Max active jobs", kind: "number", names: ["MAX_ACTIVE_JOBS"], fallback: 3, min: 1, max: 20 },
  { group: "Crawl limits", key: "maxPendingQueue", label: "Max pending queue", kind: "number", names: ["MAX_PENDING_QUEUE"], fallback: 1500, min: 50, max: 20000 },
  { group: "Crawl limits", key: "maxPages", label: "Max pages", kind: "number", names: ["MAX_PAGES"], fallback: 10000, min: 1, max: 100000 },
  { group: "Crawl limits", key: "maxResources", label: "Max resources", kind: "number", names: ["MAX_RESOURCES"], fallback: 20000, min: 1, max: 250000 },
  { group: "Crawl limits", key: "maxLinks", label: "Max links", kind: "number", names: ["MAX_LINKS"], fallback: 100000, min: 100, max: 1000000 },
  { group: "Crawl limits", key: "maxScanBytes", label: "Max scan bytes", kind: "number", names: ["MAX_SCAN_BYTES"], fallback: 512 * 1024 * 1024, min: 1024 * 1024, max: 8 * 1024 * 1024 * 1024 },
  { group: "Crawl limits", key: "maxTextBytesPerResource", label: "Max text bytes/resource", kind: "number", names: ["MAX_TEXT_BYTES_PER_RESOURCE"], fallback: 2 * 1024 * 1024, min: 64 * 1024, max: 16 * 1024 * 1024 },
  { group: "Crawl limits", key: "maxSourceFiles", label: "Max stored source files", kind: "number", names: ["MAX_SOURCE_FILES"], fallback: 20000, min: 100, max: 250000 },
  { group: "Crawl limits", key: "maxJobAgeMs", label: "Max job age (ms)", kind: "number", names: ["MAX_JOB_AGE_MS"], fallback: 60 * 60 * 1000, min: 60 * 1000, max: 24 * 60 * 60 * 1000 },
  { group: "Network / retries", key: "requestTimeoutMs", label: "Request timeout (ms)", kind: "number", names: ["REQUEST_TIMEOUT_MS"], fallback: 15000, min: 1000, max: 120000 },
  { group: "Network / retries", key: "bodyTimeoutMs", label: "Body timeout (ms)", kind: "number", names: ["BODY_TIMEOUT_MS"], fallback: 15000, min: 1000, max: 120000 },
  { group: "Network / retries", key: "dnsTimeoutMs", label: "DNS timeout (ms)", kind: "number", names: ["DNS_TIMEOUT_MS"], fallback: 4000, min: 500, max: 30000 },
  { group: "Network / retries", key: "maxRedirects", label: "Max redirects", kind: "number", names: ["MAX_REDIRECTS"], fallback: 6, min: 0, max: 15 },
  { group: "Network / retries", key: "maxRetries", label: "Max retries", kind: "number", names: ["MAX_RETRIES"], fallback: 2, min: 0, max: 5 },
  { group: "Network / retries", key: "retryBaseMs", label: "Retry base (ms)", kind: "number", names: ["RETRY_BASE_MS"], fallback: 400, min: 50, max: 10000 },
  { group: "Network / retries", key: "hostBackoffMs", label: "Host backoff (ms)", kind: "number", names: ["HOST_BACKOFF_MS"], fallback: 1200, min: 100, max: 60000 },
  { group: "Network / retries", key: "maxHostBackoffMs", label: "Max host backoff (ms)", kind: "number", names: ["MAX_HOST_BACKOFF_MS"], fallback: 30000, min: 1000, max: 300000 },
  { group: "Network / retries", key: "robotsTimeoutMs", label: "robots.txt timeout (ms)", kind: "number", names: ["ROBOTS_TIMEOUT_MS"], fallback: 8000, min: 1000, max: 60000 },
  { group: "Network / retries", key: "sitemapTimeoutMs", label: "Sitemap timeout (ms)", kind: "number", names: ["SITEMAP_TIMEOUT_MS"], fallback: 12000, min: 1000, max: 60000 },
  { group: "Network / retries", key: "maxSitemapFiles", label: "Max sitemap files", kind: "number", names: ["MAX_SITEMAP_FILES"], fallback: 50, min: 1, max: 1000 },
  { group: "Network / retries", key: "maxSitemapUrls", label: "Max sitemap URLs", kind: "number", names: ["MAX_SITEMAP_URLS"], fallback: 50000, min: 100, max: 500000 },
  { group: "Cache & logs", key: "proxyCacheMs", label: "Proxy cache TTL (ms)", kind: "number", names: ["CACHE_TTL_MS"], fallback: 10000, min: 0, max: 300000 },
  { group: "Cache & logs", key: "maxCacheBodyBytes", label: "Max cached response body bytes", kind: "number", names: ["MAX_CACHE_BODY_BYTES"], fallback: 4 * 1024 * 1024, min: 64 * 1024, max: 16 * 1024 * 1024 },
  { group: "Proxy sessions", key: "proxySessionTtlMs", label: "Proxy session TTL (ms)", kind: "number", names: ["PROXY_SESSION_TTL_MS"], fallback: 30 * 60 * 1000, min: 60 * 1000, max: 24 * 60 * 60 * 1000 },
  { group: "Proxy sessions", key: "maxProxySessions", label: "Max proxy sessions", kind: "number", names: ["MAX_PROXY_SESSIONS"], fallback: 500, min: 10, max: 5000 },
  { group: "Proxy sessions", key: "maxSessionCookies", label: "Max cookies/session", kind: "number", names: ["MAX_SESSION_COOKIES"], fallback: 50, min: 5, max: 500 },
  { group: "Proxy warming", key: "proxyWarmRobots", label: "Proxy warm logical robots", kind: "number", names: ["PROXY_WARM_ROBOTS"], fallback: 64, min: 1, max: 1000 },
  { group: "Proxy warming", key: "proxyWarmConcurrency", label: "Proxy warm network slots", kind: "number", names: ["PROXY_WARM_CONCURRENCY"], fallback: 12, min: 1, max: 64 },
  { group: "Proxy warming", key: "proxyWarmLimit", label: "Resources warmed/page", kind: "number", names: ["PROXY_WARM_LIMIT"], fallback: 64, min: 1, max: 256 },
  { group: "Proxy warming", key: "proxyWarmPerHost", label: "Warm per-host concurrency", kind: "number", names: ["PROXY_WARM_PER_HOST"], fallback: 3, min: 1, max: 16 },
  { group: "Cache & logs", key: "maxProxyCacheEntries", label: "Max proxy cache entries", kind: "number", names: ["MAX_CACHE_ENTRIES"], fallback: 200, min: 10, max: 5000 },
  { group: "Cache & logs", key: "searchCacheMs", label: "Search cache TTL (ms)", kind: "number", names: ["SEARCH_CACHE_TTL_MS"], fallback: 30000, min: 0, max: 600000 },
  { group: "Cache & logs", key: "maxSearchCacheEntries", label: "Max search cache entries", kind: "number", names: ["MAX_SEARCH_CACHE_ENTRIES"], fallback: 100, min: 10, max: 5000 },
  { group: "Cache & logs", key: "maxRequestLog", label: "Max request log entries", kind: "number", names: ["MAX_REQUEST_LOG"], fallback: 500, min: 50, max: 5000 },
  { group: "Cache & logs", key: "maxServerLog", label: "Max server log entries", kind: "number", names: ["MAX_SERVER_LOG"], fallback: 800, min: 100, max: 10000 },
  { group: "Cache & logs", key: "maxClientLog", label: "Max client log entries", kind: "number", names: ["MAX_CLIENT_LOG"], fallback: 500, min: 50, max: 5000 },
  { group: "Proxy safety limits", key: "maxProxyBodyBytes", label: "Max proxy request body bytes", kind: "number", names: ["MAX_PROXY_BODY_BYTES"], fallback: 4 * 1024 * 1024, min: 64 * 1024, max: 32 * 1024 * 1024 },
  { group: "Proxy safety limits", key: "maxProxyTextBytes", label: "Max proxy text bytes", kind: "number", names: ["MAX_PROXY_TEXT_BYTES"], fallback: 8 * 1024 * 1024, min: 256 * 1024, max: 32 * 1024 * 1024 },
  { group: "Proxy safety limits", key: "maxProxyImageBytes", label: "Max proxy image bytes", kind: "number", names: ["MAX_PROXY_IMAGE_BYTES"], fallback: 16 * 1024 * 1024, min: 256 * 1024, max: 64 * 1024 * 1024 },
  { group: "Proxy safety limits", key: "maxProxyMediaBytes", label: "Max proxy media bytes", kind: "number", names: ["MAX_PROXY_MEDIA_BYTES"], fallback: 32 * 1024 * 1024, min: 512 * 1024, max: 128 * 1024 * 1024 },
  { group: "Proxy safety limits", key: "maxProxyOtherBytes", label: "Max proxy other bytes", kind: "number", names: ["MAX_PROXY_OTHER_BYTES"], fallback: 16 * 1024 * 1024, min: 256 * 1024, max: 64 * 1024 * 1024 },
  { group: "Proxy safety limits", key: "maxFormBodyBytes", label: "Max form body bytes", kind: "number", names: ["MAX_FORM_BODY_BYTES"], fallback: 1 * 1024 * 1024, min: 16 * 1024, max: 8 * 1024 * 1024 },
  { group: "Proxy safety limits", key: "maxDownloadBytes", label: "Max download bytes", kind: "number", names: ["MAX_DOWNLOAD_BYTES"], fallback: 64 * 1024 * 1024, min: 256 * 1024, max: 256 * 1024 * 1024 },
  { group: "Search", key: "searchProvider", label: "Search provider", kind: "enum", names: ["SEARCH_PROVIDER"], fallback: "local", allowed: ["auto", "local", "brave", "bing", "custom", "none"] },
  { group: "Search", key: "searchEndpoint", label: "Custom search endpoint", kind: "string", names: ["SEARCH_ENDPOINT"], fallback: "" },
  { group: "Search", key: "searchApiKey", label: "Search API key", kind: "string", names: ["SEARCH_API_KEY"], fallback: "", secret: true },
  { group: "Search", key: "customSearchAuth", label: "Custom search auth header", kind: "string", names: ["SEARCH_AUTH_HEADER"], fallback: "", secret: true },
  { group: "Search", key: "braveKey", label: "Brave Search API key", kind: "string", names: ["BRAVE_SEARCH_API_KEY"], fallback: "", secret: true },
  { group: "Search", key: "bingKey", label: "Bing Search API key", kind: "string", names: ["BING_SEARCH_API_KEY"], fallback: "", secret: true },
  { group: "Search", key: "maxSearchQueryChars", label: "Max search query chars", kind: "number", names: ["MAX_SEARCH_QUERY_CHARS"], fallback: 256, min: 32, max: 1000 },
  { group: "Search", key: "maxSearchResults", label: "Max search results", kind: "number", names: ["MAX_SEARCH_RESULTS"], fallback: 20, min: 1, max: 50 },
  { group: "Search index", key: "maxIndexDocs", label: "Max indexed docs", kind: "number", names: ["MAX_INDEX_DOCS"], fallback: 20000, min: 100, max: 100000 },
  { group: "Search index", key: "maxIndexTextChars", label: "Max index text chars/doc", kind: "number", names: ["MAX_INDEX_TEXT_CHARS"], fallback: 8000, min: 1000, max: 50000 },
  { group: "Search index", key: "maxSearchQueryTerms", label: "Max search query terms", kind: "number", names: ["MAX_SEARCH_QUERY_TERMS"], fallback: 20, min: 1, max: 64 },
  { group: "Search index", key: "indexSeeds", label: "Index seed URLs", kind: "csv", names: ["INDEX_SEEDS"], fallback: [] },
  { group: "Search index", key: "indexSeedCrawl", label: "Auto-crawl index seeds", kind: "bool", names: ["INDEX_SEED_CRAWL"], fallback: true },
  { group: "Search index", key: "indexRefreshMs", label: "Index refresh interval (ms)", kind: "number", names: ["INDEX_REFRESH_MS"], fallback: 6 * 60 * 60 * 1000, min: 0, max: 30 * 24 * 60 * 60 * 1000 },
  { group: "Search index", key: "indexSnapshotEnabled", label: "Index snapshot enabled", kind: "bool", names: ["INDEX_SNAPSHOT_ENABLED"], fallback: false },
  { group: "Search index", key: "indexSnapshotPath", label: "Index snapshot path", kind: "string", names: ["INDEX_SNAPSHOT_PATH"], fallback: "/tmp/veyra-search-index.json" },
  { group: "Misc", key: "browserRenderFallback", label: "Browser render fallback", kind: "bool", names: ["BROWSER_RENDER_FALLBACK"], fallback: false },
  { group: "Misc", key: "sortQueryParams", label: "Normalize/sort query params", kind: "bool", names: ["NORMALIZE_SORT_QUERY_PARAMS"], fallback: false }
];

// Env vars seen in the wild for this project that this build of server.js does
// not read anywhere. Setting these has no effect — flagged explicitly so they
// don't get mistaken for working configuration.
const STATUS_KNOWN_UNUSED = [];
const STATUS_WATCHED_PREFIXES = ["CRAWLER_", "ROBOT_", "MAX_", "PROXY_", "SEARCH_", "INDEX_", "VEYRA_", "ROBOTS_", "SITEMAP_", "CACHE_", "BROWSER_", "NORMALIZE_", "FRONTEND_", "PUBLIC_", "PORT", "PROCESS_ROLE", "SERVER_LOG_LEVEL", "REQUEST_TIMEOUT_MS", "BODY_TIMEOUT_MS", "DNS_TIMEOUT_MS", "HOST_BACKOFF_MS", "RETRY_BASE_MS", "BING_", "BRAVE_"];

function buildStatusReport() {
  const vars = STATUS_VAR_DEFS.map(def => {
    let d;
    if (def.kind === "number") d = diagNumber(def.names, def.fallback, def.min, def.max);
    else if (def.kind === "bool") d = diagBool(def.names, def.fallback);
    else if (def.kind === "enum") d = diagEnum(def.names, def.fallback, def.allowed);
    else if (def.kind === "csv") d = diagCsv(def.names, def.fallback);
    else d = diagString(def.names, def.fallback, !!def.secret);
    return { group: def.group, key: def.key, label: def.label, note: def.note || "", secret: !!def.secret, ...d };
  });

  const knownNames = new Set(STATUS_VAR_DEFS.flatMap(d => d.names).concat(STATUS_KNOWN_UNUSED));
  const unrecognized = Object.keys(process.env)
    .filter(name => STATUS_WATCHED_PREFIXES.some(p => name.startsWith(p)) && !knownNames.has(name))
    .sort()
    .map(name => ({ name, raw: name.includes("KEY") || name.includes("SECRET") || name.includes("AUTH") ? "(hidden)" : process.env[name] }));

  const setUnused = STATUS_KNOWN_UNUSED.filter(name => process.env[name] !== undefined && String(process.env[name]).trim() !== "");

  const byKey = Object.fromEntries(vars.map(v => [v.key, v]));
  const issues = [];
  const addIssue = (severity, message) => issues.push({ severity, message });

  const provider = byKey.searchProvider.effective;
  if (provider === "brave" && !byKey.braveKey.present) addIssue("error", "SEARCH_PROVIDER is \"brave\" but BRAVE_SEARCH_API_KEY is not set — search requests will fail at query time.");
  if (provider === "bing" && !byKey.bingKey.present) addIssue("error", "SEARCH_PROVIDER is \"bing\" but BING_SEARCH_API_KEY is not set — search requests will fail at query time.");
  if (provider === "custom" && !byKey.searchEndpoint.present) addIssue("error", "SEARCH_PROVIDER is \"custom\" but SEARCH_ENDPOINT is not set — search requests will fail at query time.");
  if (provider === "auto" && !byKey.braveKey.present && !byKey.bingKey.present) addIssue("info", "SEARCH_PROVIDER is \"auto\" with no external provider keys set — Veyra will rely entirely on the local index until BRAVE_SEARCH_API_KEY or BING_SEARCH_API_KEY is added.");

  if (!byKey.publicApiOrigin.present) addIssue("warn", "PUBLIC_API_ORIGIN is not set — proxied pages won't reliably know this backend's public URL for their own resource/API calls. Set it to this Render service's URL.");
  if (Array.isArray(byKey.frontendOrigin.effective) && byKey.frontendOrigin.effective.includes("*")) addIssue("warn", "FRONTEND_ORIGIN is not set (defaulting to \"*\") — CORS currently allows any origin. Fine for testing, but set it to your actual frontend URL before relying on this in production.");

  if (byKey.perHostConcurrency.effective > byKey.maxActiveFetches.effective) addIssue("info", `CRAWLER_PER_HOST_CONCURRENCY (${byKey.perHostConcurrency.effective}) is higher than MAX_ACTIVE_FETCHES (${byKey.maxActiveFetches.effective}) — the per-host cap can never actually be reached.`);
  if (byKey.logicalRobots.effective > byKey.maxActiveFetches.effective) addIssue("info", `CRAWLER_ROBOTS (${byKey.logicalRobots.effective}) is a logical fleet larger than MAX_ACTIVE_FETCHES (${byKey.maxActiveFetches.effective}) — extra robots wait for shared network slots instead of opening extra sockets.`);
  if (byKey.robotActiveTasks.effective > byKey.robotTaskCapacity.effective) addIssue("warn", `ROBOT_ACTIVE_TASKS (${byKey.robotActiveTasks.effective}) exceeds ROBOT_TASK_CAPACITY (${byKey.robotTaskCapacity.effective}) — active task capacity will be capped to the task capacity.`);
  if (byKey.robotWorksetSize.effective < Math.min(byKey.logicalRobots.effective, Math.ceil(byKey.maxActiveFetches.effective / Math.max(1, byKey.robotActiveTasks.effective)))) addIssue("info", `ROBOT_WORKSET_SIZE (${byKey.robotWorksetSize.effective}) is smaller than the number of robots needed to fill the network ceiling; additional idle robots will rely more heavily on help handoffs.`);
  if (byKey.browserMaxActiveFetches.effective > byKey.maxActiveFetches.effective) addIssue("info", `BROWSER_MAX_ACTIVE_FETCHES (${byKey.browserMaxActiveFetches.effective}) is larger than crawler MAX_ACTIVE_FETCHES (${byKey.maxActiveFetches.effective}); the browser lane is intentionally independent.`);
  if (process.env.CRAWLER_ROBOTS && process.env.MAX_GLOBAL_CONCURRENCY && process.env.CRAWLER_ROBOTS !== process.env.MAX_GLOBAL_CONCURRENCY) addIssue("info", `Both CRAWLER_ROBOTS (${process.env.CRAWLER_ROBOTS}) and legacy MAX_GLOBAL_CONCURRENCY (${process.env.MAX_GLOBAL_CONCURRENCY}) are set — the robot fleet and network fetch ceiling are intentionally separate in this build.`);
  if (process.env.CRAWLER_PER_HOST_CONCURRENCY && process.env.MAX_PER_HOST_CONCURRENCY && process.env.CRAWLER_PER_HOST_CONCURRENCY !== process.env.MAX_PER_HOST_CONCURRENCY) addIssue("info", `Both CRAWLER_PER_HOST_CONCURRENCY (${process.env.CRAWLER_PER_HOST_CONCURRENCY}) and legacy MAX_PER_HOST_CONCURRENCY (${process.env.MAX_PER_HOST_CONCURRENCY}) are set with different values — CRAWLER_PER_HOST_CONCURRENCY wins.`);

  if (byKey.indexSeedCrawl.effective && (!Array.isArray(byKey.indexSeeds.effective) || byKey.indexSeeds.effective.length === 0)) addIssue("info", "INDEX_SEED_CRAWL is on but INDEX_SEEDS is empty — there's nothing to auto-seed yet; the index will only grow as people browse pages through Veyra.");

  for (const v of vars) if (v.status === "invalid") addIssue("error", `${v.name}="${v.raw}" is invalid for ${v.label} — the server silently fell back to the default (${JSON.stringify(v.effective)}). Fix or remove this variable.`);
  for (const v of vars) if (v.status === "clamped") addIssue("warn", `${v.name}="${v.raw}" for ${v.label} is outside the allowed range — clamped to ${v.effective}.`);

  for (const name of setUnused) addIssue("warn", `${name} is set but this server build never reads it — it has no effect. Remove it or check you're deploying the version of the code that's supposed to use it.`);
  for (const u of unrecognized) addIssue("warn", `${u.name} looks like a Veyra config variable but isn't recognized by this server build (raw value: ${u.raw}). Check for a typo, e.g. did you mean one of: ${STATUS_VAR_DEFS.flatMap(d => d.names).filter(n => n.slice(0, 4) === u.name.slice(0, 4)).join(", ") || "(no close match found)"}.`);

  if (rewriteFailures.length) addIssue("warn", `${rewriteFailures.length} page(s) failed HTML/CSS/JS rewriting since boot and were served unrewritten as a fallback (links on those pages may point outside Veyra). Most recent: ${rewriteFailures[rewriteFailures.length - 1].url} — ${rewriteFailures[rewriteFailures.length - 1].message}`);


  const severityRankNum = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => severityRankNum[a.severity] - severityRankNum[b.severity]);

  return {
    generatedAt: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    processRole: byKey.processRole.effective,
    port: byKey.port.effective,
    crawlerRobotsInEffect: byKey.logicalRobots.effective,
    logicalRobotsInEffect: byKey.logicalRobots.effective,
    maxActiveFetchesInEffect: byKey.maxActiveFetches.effective,
    perHostConcurrencyInEffect: byKey.perHostConcurrency.effective,
    robotWorksetSizeInEffect: byKey.robotWorksetSize.effective,
    robotQueueCapacityInEffect: byKey.robotQueueCapacity.effective,
    counts: {
      error: issues.filter(i => i.severity === "error").length,
      warn: issues.filter(i => i.severity === "warn").length,
      info: issues.filter(i => i.severity === "info").length
    },
    issues,
    groups: STATUS_VAR_DEFS.reduce((acc, def) => { (acc[def.group] ||= []).push(byKey[def.key]); return acc; }, {}),
    unrecognizedVars: unrecognized,
    unusedButSetVars: setUnused,
    recentRewriteFailures: rewriteFailures.slice(-20)
  };
}

function statusPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Veyra Status</title><style>
body{margin:0;background:#0e1116;color:#e7edf5;font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
header{padding:16px 20px;border-bottom:1px solid #2a313b;position:sticky;top:0;background:#11151b;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
h1{font:700 18px system-ui;margin:0}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font:600 12px system-ui;margin-left:8px}
.pill.err{background:#3a1a1a;color:#ff9f9f}.pill.warn{background:#3a2f14;color:#e9c36f}.pill.info{background:#122a3a;color:#8fc3ea}.pill.ok{background:#123a1e;color:#8fea9f}
main{padding:16px 20px;max-width:1100px;margin:0 auto}
section{margin-bottom:22px}
h2{font:700 14px system-ui;margin:0 0 10px;color:#c7d3e0}
.issue{display:flex;gap:10px;padding:9px 10px;border-radius:8px;margin-bottom:6px;align-items:flex-start}
.issue.error{background:#1c1010;border:1px solid #4a2020}
.issue.warn{background:#1c1710;border:1px solid #4a3a18}
.issue.info{background:#0f1a22;border:1px solid #204058}
.badge{font:700 10px system-ui;text-transform:uppercase;padding:2px 7px;border-radius:5px;white-space:nowrap}
.badge.error{background:#ff9f9f;color:#2a0d0d}.badge.warn{background:#e9c36f;color:#2a2005}.badge.info{background:#8fc3ea;color:#08202f}
table{width:100%;border-collapse:collapse;margin-bottom:14px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #1c2229;vertical-align:top}
th{color:#8b97a7;font-weight:600;font-size:11px;text-transform:uppercase}
.status-set{color:#8fea9f}.status-default{color:#8b97a7}.status-clamped{color:#e9c36f}.status-invalid{color:#ff9f9f}
.mono{font-family:inherit}
.empty{color:#5b6675;font-style:italic}
button{background:#1a2029;color:#dce5ef;border:1px solid #343d49;border-radius:7px;padding:7px 11px;cursor:pointer;font:600 12px system-ui}
</style></head><body>
<header><h1>Veyra — /status</h1><div id="pills"></div><button id="refresh">Refresh</button></header>
<main id="app">Loading…</main>
<script>
function esc(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function fmtVal(v){ if (Array.isArray(v)) return v.length ? esc(v.join(', ')) : '<span class="empty">(none)</span>'; if (v === '' || v === undefined || v === null) return '<span class="empty">(empty)</span>'; return esc(String(v)) }
async function load(){
  const r = await fetch('/api/debug/status');
  const d = await r.json();
  document.getElementById('pills').innerHTML =
    '<span class="pill err">'+d.counts.error+' error'+(d.counts.error===1?'':'s')+'</span>'+
    '<span class="pill warn">'+d.counts.warn+' warn'+(d.counts.warn===1?'':'s')+'</span>'+
    '<span class="pill info">'+d.counts.info+' info</span>'+
    '<span class="pill ok">'+d.crawlerRobotsInEffect+' logical robots · '+d.maxActiveFetchesInEffect+' network slots · '+d.perHostConcurrencyInEffect+'/host</span>';
  let html = '';
  html += '<section><h2>Issues</h2>';
  if (!d.issues.length) html += '<p class="empty">No configuration issues detected.</p>';
  else html += d.issues.map(i => '<div class="issue '+i.severity+'"><span class="badge '+i.severity+'">'+i.severity+'</span><div>'+esc(i.message)+'</div></div>').join('');
  html += '</section>';
  for (const [group, items] of Object.entries(d.groups)) {
    html += '<section><h2>'+esc(group)+'</h2><table><thead><tr><th>Variable</th><th>Raw value</th><th>Effective value</th><th>Status</th><th>Detail</th></tr></thead><tbody>';
    for (const v of items) {
      html += '<tr><td class="mono">'+esc(v.name)+(v.note?'<br><span class="empty">'+esc(v.note)+'</span>':'')+'</td><td class="mono">'+(v.present ? (v.secret ? '(hidden)' : fmtVal(v.raw)) : '<span class="empty">(not set)</span>')+'</td><td class="mono">'+fmtVal(v.secret ? (v.present ? '(hidden)' : '') : v.effective)+'</td><td class="status-'+v.status+'">'+esc(v.status)+'</td><td>'+esc(v.detail)+'</td></tr>';
    }
    html += '</tbody></table></section>';
  }
  document.getElementById('app').innerHTML = html;
}
document.getElementById('refresh').onclick = load;
load();
</script>
</body></html>`;
}
app.get("/api/debug/status", (req, res) => res.json(buildStatusReport()));
app.get("/status", (req, res) => res.type("html").send(statusPage()));

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

module.exports = { app, CFG, Semaphore, normalizeUrl, resolveNavigation, resolveResource, makeViewUrl, makeResourceUrl, rewriteHtml, rewriteCssText, rewriteJsText, rewriteMediaManifest, injectRuntime, detectChallenge, PriorityFrontier, BrowserTaskScheduler, CooperativeRobotPool, robotsAllowed, crawlPriority, crawlLimitForContentType, tokenizeSearch, parseSearchQuery, localSearch, searchIndexStats, indexDocument, localSearchSuggestions };
