const express = require("express");
const cors = require("cors");
const cheerio = require("cheerio");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { BrowserEngine } = require("./browser/browser-engine");
const { VpnManager } = require("./network/vpn");
const { createShield } = require("./network/shield");
const { createWebSearch } = require("./services/websearch");
const { installBrandRoutes, isReservedOriginPath, brandNotFoundHtml } = require("./services/brand");
const VEYRA_VERSION = require("../package.json").version;
const { SessionManager } = require("./core/session-manager");
const { AuthStore } = require("./core/auth");
const { WorkerPool } = require("./core/worker-pool");
const { MongoStore } = require("./core/mongo-store");
const youtubeCompat = require("./browser/youtube");
const mediaErrors = require("./browser/media-errors");
const { isMainThread } = require("worker_threads");
const { NeuralRobotPool } = require("./services/neural-robots");
const { NeuralCrawlerModel } = require("./services/neural-crawler");
const { NeuralLearningWorker } = require("./services/neural-learning");
const { ChallengeSolver } = require("./browser/challenge-solver");
const { CastServer, InternetConnectionManager } = require("./network/cast-server");
const { AIAnswerEngine } = require("./services/ai-answer");
const { RenewingManager } = require("./services/renewing-system");
const fullPage = require("./browser/full-page.js");
const { FailoverController } = require("./browser/browser-failover.js");
const { SnapshotStore } = require("./browser/snapshot-store.js");


const IS_THREAD_WORKER = !isMainThread && process.env.VEYRA_THREAD_WORKER === "1";
const { fetch: undiciFetch, Agent: UndiciAgent } = require("undici");
const veyraConfigModule = require("./config");


const VEYRA_CONFIG = veyraConfigModule.applyToProcessEnv(veyraConfigModule.loadConfig());

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


function detectCgroupMemoryLimitBytes() {
  const candidates = ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, "utf8").trim();
      if (!raw || raw === "max") continue;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 64 * 1024 * 1024 && n < 1024 * 1024 * 1024 * 1024) return n;
    } catch {}
  }
  const hint = Number(process.env.MEMORY_LIMIT_MB);
  if (Number.isFinite(hint) && hint > 0) return hint * 1024 * 1024;
  return 0;
}
function detectedMemoryMb() { const b = detectCgroupMemoryLimitBytes(); return b ? Math.round(b / 1024 / 1024) : 0; }


const RESOURCE_PROFILE = VEYRA_CONFIG.resourceProfile;
const MEMORY_LIMIT_MB = numberEnv("MEMORY_LIMIT_MB", detectedMemoryMb() || VEYRA_CONFIG.plan.ramMb || 0, 0, 262144);
const PROFILE_CAPS = veyraConfigModule.LEGACY_CAPS;
function detectResourceProfile() { return RESOURCE_PROFILE; }
function capForProfile(profile, values) { return values[profile] ?? values.balanced; }
const P = VEYRA_CONFIG.caps;




const LEAN_MODE = boolEnv("VEYRA_LEAN_MODE", VEYRA_CONFIG.plan.key === "free");
const MB = 1024 * 1024;
const CFG = Object.freeze({
  leanMode: LEAN_MODE,
  
  
  leanAutoBrowser: boolEnv("LEAN_AUTO_BROWSER", false),
  
  
  youtubeFastProxyOnly: boolEnv("YT_FAST_PROXY_ONLY", LEAN_MODE),
  youtubeMaxHeight: numberEnv("YT_MAX_HEIGHT", 360, 144, 1080),
  processRole: enumEnv("PROCESS_ROLE", "web", ["web", "worker", "all"]),
  
  
  
  logicalRobots: numberEnv("CRAWLER_ROBOTS", 10000, 1, 10000),
  requestedMaxActiveFetches: numberEnv("MAX_ACTIVE_FETCHES", numberEnv("MAX_GLOBAL_CONCURRENCY", P.maxActiveFetches, 1, 256), 1, 256),
  maxActiveFetches: Math.min(numberEnv("MAX_ACTIVE_FETCHES", numberEnv("MAX_GLOBAL_CONCURRENCY", P.maxActiveFetches, 1, 256), 1, 256), P.maxActiveFetches),
  globalConcurrency: Math.min(numberEnv("MAX_ACTIVE_FETCHES", numberEnv("MAX_GLOBAL_CONCURRENCY", P.maxActiveFetches, 1, 256), 1, 256), P.maxActiveFetches),
  perHostConcurrency: numberEnv("CRAWLER_PER_HOST_CONCURRENCY", numberEnv("MAX_PER_HOST_CONCURRENCY", 8, 1, 32), 1, 32),
  robotTaskCapacity: numberEnv("ROBOT_TASK_CAPACITY", 4, 1, 16),
  robotActiveTasks: numberEnv("ROBOT_ACTIVE_TASKS", 4, 1, 8),
  robotHelpEnabled: boolEnv("ROBOT_HELP_ENABLED", true),
  robotHelpThreshold: numberEnv("ROBOT_HELP_THRESHOLD", 2, 1, 16),
  robotHelpCooldownMs: numberEnv("ROBOT_HELP_COOLDOWN_MS", 250, 0, 10000),
  robotHelpScanLimit: numberEnv("ROBOT_HELP_SCAN_LIMIT", 24, 1, 128),
  robotWorksetSize: numberEnv("ROBOT_WORKSET_SIZE", 10000, 8, 10000),
  robotQueueCapacity: numberEnv("ROBOT_QUEUE_CAPACITY", 8, 2, 32),
  robotStealBatch: numberEnv("ROBOT_STEAL_BATCH", 2, 1, 8),
  robotStealOnIdle: boolEnv("ROBOT_STEAL_ON_IDLE", true),
  robotBundleSize: numberEnv("ROBOT_BUNDLE_SIZE", 4, 1, 8),
  robotDispatchBatch: numberEnv("ROBOT_DISPATCH_BATCH", 1024, 64, 8192),
  robotHelpMaxInFlight: numberEnv("ROBOT_HELP_MAX_INFLIGHT", 64, 1, 256),
  adaptiveHostConcurrency: boolEnv("ADAPTIVE_HOST_CONCURRENCY", true),
  minPerHostConcurrency: numberEnv("MIN_PER_HOST_CONCURRENCY", 2, 1, 32),
  hostSuccessRamp: numberEnv("HOST_SUCCESS_RAMP", 4, 1, 100),
  hostErrorPenalty: numberEnv("HOST_ERROR_PENALTY", 2, 1, 10),
  criticalResourceBudget: numberEnv("CRITICAL_RESOURCE_BUDGET", 48, 8, 256),
  maxBrowserDiscovered: numberEnv("MAX_BROWSER_DISCOVERED", 2500, 100, 20000),
  maxBrowserDiscoveredHosts: Math.min(numberEnv("MAX_BROWSER_DISCOVERED_HOSTS", 24, 2, 100), P.maxCrossOriginResources > 0 ? 100 : 2),
  maxDiscoveryPerPage: numberEnv("MAX_DISCOVERY_PER_PAGE", 5000, 100, 20000),
  maxScriptDiscovery: numberEnv("MAX_SCRIPT_DISCOVERY", 4000, 100, 20000),
  maxJsonUrlDiscovery: numberEnv("MAX_JSON_URL_DISCOVERY", 2000, 50, 10000),
  maxBroadScanChars: numberEnv("MAX_BROAD_SCAN_CHARS", 1500000, 10000, 10000000),
  maxSrcsetCandidates: numberEnv("MAX_SRCSET_CANDIDATES", 100, 10, 500),
  browserMaxActiveFetches: Math.min(numberEnv("BROWSER_MAX_ACTIVE_FETCHES", P.browserMaxActiveFetches, 1, 64), P.browserMaxActiveFetches),
  browserPerHostConcurrency: numberEnv("BROWSER_PER_HOST_CONCURRENCY", 8, 1, 32),
  browserEnabled: boolEnv("BROWSER_ENABLED", true),
  browserHeadless: boolEnv("BROWSER_HEADLESS", true),
  maxBrowserSessions: Math.min(numberEnv("MAX_BROWSER_SESSIONS", P.browserSessions, 1, 16), P.browserSessions),
  maxBrowserPages: Math.min(numberEnv("MAX_BROWSER_PAGES", P.browserPages, 1, 32), P.browserPages),
  maxBrowserContexts: Math.min(numberEnv("MAX_BROWSER_CONTEXTS", P.browserContexts, 1, 16), P.browserContexts),
  browserIdleTimeoutMs: numberEnv("BROWSER_IDLE_TIMEOUT_MS", LEAN_MODE ? 90000 : 300000, 10000, 86400000),
  browserSessionTtlMs: numberEnv("BROWSER_SESSION_TTL_MS", 1800000, 60000, 86400000),
  browserNavigationTimeoutMs: numberEnv("BROWSER_NAVIGATION_TIMEOUT_MS", LEAN_MODE ? 20000 : 30000, 5000, 120000),
  browserPageTimeoutMs: numberEnv("BROWSER_PAGE_TIMEOUT_MS", LEAN_MODE ? 12000 : 30000, 5000, 120000),
  browserEvictIdleOnCapacity: boolEnv("BROWSER_EVICT_IDLE_ON_CAPACITY", true),
  browserEvictMinIdleMs: numberEnv("BROWSER_EVICT_MIN_IDLE_MS", 60000, 10000, 86400000),
  browserBackend: enumEnv("BROWSER_BACKEND", "local", ["local", "remote"]),
  browserBackendUrl: process.env.BROWSER_BACKEND_URL || "",
  dnsCacheTtlMs: numberEnv("DNS_CACHE_TTL_MS", 5000, 0, 60000),
  maxPendingQueue: Math.min(numberEnv("MAX_PENDING_QUEUE", P.maxPendingQueue, 50, 20000), P.maxPendingQueue),
  maxPages: Math.min(numberEnv("MAX_PAGES", P.maxPages, 1, 100000), P.maxPages),
  maxResources: Math.min(numberEnv("MAX_RESOURCES", P.maxResources, 1, 250000), P.maxResources),
  maxLinks: Math.min(numberEnv("MAX_LINKS", P.maxLinks, 100, 1000000), P.maxLinks),
  maxScanBytes: numberEnv("MAX_SCAN_BYTES", 512 * 1024 * 1024, 1024 * 1024, 8 * 1024 * 1024 * 1024),
  maxTextBytesPerResource: Math.min(numberEnv("MAX_TEXT_BYTES_PER_RESOURCE", P.maxTextBytesPerResource, 64 * 1024, 16 * 1024 * 1024), P.maxTextBytesPerResource),
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
  maxSitemapFiles: Math.min(numberEnv("MAX_SITEMAP_FILES", P.maxSitemapFiles, 1, 1000), P.maxSitemapFiles),
  maxSitemapUrls: numberEnv("MAX_SITEMAP_URLS", 50000, 100, 500000),
  maxJobAgeMs: numberEnv("MAX_JOB_AGE_MS", 60 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000),
  proxyCacheMs: numberEnv("CACHE_TTL_MS", 10000, 0, 300000),
  maxProxyCacheEntries: numberEnv("MAX_CACHE_ENTRIES", LEAN_MODE ? 60 : 200, 10, 5000),
  searchCacheMs: numberEnv("SEARCH_CACHE_TTL_MS", 30000, 0, 600000),
  maxSearchCacheEntries: numberEnv("MAX_SEARCH_CACHE_ENTRIES", 100, 10, 5000),
  maxRequestLog: numberEnv("MAX_REQUEST_LOG", 500, 50, 5000),
  maxServerLog: numberEnv("MAX_SERVER_LOG", 800, 100, 10000),
  maxClientLog: numberEnv("MAX_CLIENT_LOG", 500, 50, 5000),
  maxSearchQueryChars: numberEnv("MAX_SEARCH_QUERY_CHARS", 256, 32, 1000),
  maxSearchResults: numberEnv("MAX_SEARCH_RESULTS", 20, 1, 50),
  maxProxyBodyBytes: numberEnv("MAX_PROXY_BODY_BYTES", 4 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024),
  maxProxyTextBytes: numberEnv("MAX_PROXY_TEXT_BYTES", 8 * 1024 * 1024, 256 * 1024, 32 * 1024 * 1024),
  maxProxyImageBytes: numberEnv("MAX_PROXY_IMAGE_BYTES", LEAN_MODE ? 2 * MB : 16 * 1024 * 1024, 256 * 1024, 64 * 1024 * 1024),
  maxProxyMediaBytes: numberEnv("MAX_PROXY_MEDIA_BYTES", LEAN_MODE ? 4 * MB : 32 * 1024 * 1024, 512 * 1024, 128 * 1024 * 1024),
  maxProxyOtherBytes: numberEnv("MAX_PROXY_OTHER_BYTES", LEAN_MODE ? 2 * MB : 16 * 1024 * 1024, 256 * 1024, 64 * 1024 * 1024),
  maxFormBodyBytes: numberEnv("MAX_FORM_BODY_BYTES", 1 * 1024 * 1024, 16 * 1024, 8 * 1024 * 1024),
  maxDownloadBytes: numberEnv("MAX_DOWNLOAD_BYTES", 64 * 1024 * 1024, 256 * 1024, 256 * 1024 * 1024),
  maxCacheBodyBytes: Math.min(numberEnv("MAX_CACHE_BODY_BYTES", RESOURCE_PROFILE === "free" ? 1024 * 1024 : 4 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024), RESOURCE_PROFILE === "free" ? 1024 * 1024 : 4 * 1024 * 1024),
  proxySessionTtlMs: numberEnv("PROXY_SESSION_TTL_MS", 30 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000),
  maxProxySessions: numberEnv("MAX_PROXY_SESSIONS", P.maxProxySessions || 500, 10, 5000),
  maxSessionCookies: numberEnv("MAX_SESSION_COOKIES", 50, 5, 500),
  proxyWarmRobots: Math.min(numberEnv("PROXY_WARM_ROBOTS", P.proxyWarmRobots, 1, 1000), P.proxyWarmRobots),
  proxyWarmConcurrency: Math.min(numberEnv("PROXY_WARM_CONCURRENCY", P.proxyWarmConcurrency, 1, 64), P.proxyWarmConcurrency),
  proxyWarmLimit: numberEnv("PROXY_WARM_LIMIT", LEAN_MODE ? 24 : 128, 1, 256),
  proxyWarmPerHost: numberEnv("PROXY_WARM_PER_HOST", LEAN_MODE ? 2 : 4, 1, 16),
  proxyCriticalPreloadLimit: numberEnv("PROXY_CRITICAL_PRELOAD_LIMIT", LEAN_MODE ? 12 : 24, 4, 40),
  proxyWarmHardMs: numberEnv("PROXY_WARM_HARD_MS", LEAN_MODE ? 3500 : 10000, 1500, 30000),
  mediaRequestTimeoutMs: numberEnv("MEDIA_REQUEST_TIMEOUT_MS", 20000, 3000, 120000),
  mediaBodyTimeoutMs: numberEnv("MEDIA_BODY_TIMEOUT_MS", 12000, 2000, 120000),
  proxyInlineWarmScanChars: numberEnv("PROXY_INLINE_WARM_SCAN_CHARS", 800000, 10000, 3000000),
  proxyWarmMaxBinaryBytes: numberEnv("PROXY_WARM_MAX_BINARY_BYTES", 768 * 1024, 64 * 1024, 4 * 1024 * 1024),
  sitemapConcurrency: Math.min(numberEnv("SITEMAP_CONCURRENCY", P.sitemapConcurrency, 1, 32), P.sitemapConcurrency),
  initialResourceBudget: numberEnv("INITIAL_RESOURCE_BUDGET", 64, 16, 256),
  mongoUri: process.env.MONGODB_URI || "",
  mongoDb: process.env.MONGODB_DB || "veyra",
  mongoPoolSize: numberEnv("MONGODB_MAX_POOL_SIZE", 2, 1, 4),
  mongoCacheBodyMaxBytes: numberEnv("MONGODB_CACHE_BODY_MAX_BYTES", 768 * 1024, 16 * 1024, 768 * 1024),
  mongoCacheTtlMs: numberEnv("MONGODB_CACHE_TTL_MS", 15 * 60 * 1000, 10 * 1000, 24 * 60 * 60 * 1000),
  mongoSharedCache: boolEnv("MONGODB_SHARED_CACHE", true),
  userAgent: process.env.VEYRA_USER_AGENT || `VeyraBrowseCrawler/${VEYRA_VERSION} (+https://github.com/HomekidChud/VeyraServer)`,
  frontendOrigins: csvEnv("FRONTEND_ORIGIN", ["*"]),
  
  
  
  frontendUrl: process.env.VEYRA_FRONTEND_URL || "https://homekidchud.github.io/VeyraBrowser/",
  searchProvider: enumEnv("SEARCH_PROVIDER", "local", ["auto", "local", "brave", "bing", "custom", "none"]),
  searchEndpoint: process.env.SEARCH_ENDPOINT || "",
  searchApiKey: process.env.SEARCH_API_KEY || "",
  customSearchAuth: process.env.SEARCH_AUTH_HEADER || "",
  maxIndexDocs: Math.min(numberEnv("MAX_INDEX_DOCS", P.maxIndexDocs, 100, 100000), P.maxIndexDocs),
  maxIndexTextChars: numberEnv("MAX_INDEX_TEXT_CHARS", 12000, 1000, 50000),
  maxSearchQueryTerms: numberEnv("MAX_SEARCH_QUERY_TERMS", 20, 1, 64),
  indexSeeds: csvEnv("INDEX_SEEDS", []),
  indexSeedCrawl: boolEnv("INDEX_SEED_CRAWL", true),
  indexRefreshMs: numberEnv("INDEX_REFRESH_MS", 6 * 60 * 60 * 1000, 0, 30 * 24 * 60 * 60 * 1000),
  indexSnapshotEnabled: boolEnv("INDEX_SNAPSHOT_ENABLED", false),
  indexSnapshotPath: process.env.INDEX_SNAPSHOT_PATH || "/tmp/veyra-search-index.json",
  processBrowserFallback: boolEnv("BROWSER_RENDER_FALLBACK", false),
  logLevel: enumEnv("SERVER_LOG_LEVEL", "info", ["error", "warn", "info", "debug"]),
  sortQueryParams: boolEnv("NORMALIZE_SORT_QUERY_PARAMS", false),
  proxyForwardCompatHeaders: boolEnv("PROXY_FORWARD_COMPAT_HEADERS", true),
  proxyForwardClientHints: boolEnv("PROXY_FORWARD_CLIENT_HINTS", true),
  proxyStreamOversize: boolEnv("PROXY_STREAM_OVERSIZE", true),
  proxyRelativeFallback: boolEnv("PROXY_RELATIVE_FALLBACK", true),
  proxyApiBodyBytes: numberEnv("PROXY_API_BODY_BYTES", 4 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024),
  proxyJsHeavyThreshold: numberEnv("PROXY_JS_HEAVY_THRESHOLD", 4, 1, 20),
  proxyApiRetries: numberEnv("PROXY_API_RETRIES", 1, 0, 3),
  resourceProfile: RESOURCE_PROFILE,
  memoryLimitMb: MEMORY_LIMIT_MB,
  browserCrawlerConcurrency: P.browserCrawlerConcurrency,
  browserKeepWarm: boolEnv("BROWSER_KEEP_WARM", RESOURCE_PROFILE !== "free"),
  
  
  crawlerPageAccelerator: boolEnv("CRAWLER_PAGE_ACCELERATOR", true),
  crawlerPageWarmMs: numberEnv("CRAWLER_PAGE_WARM_MS", LEAN_MODE ? 3500 : 8000, 1500, 60000),
  crawlerPageHardMs: numberEnv("CRAWLER_PAGE_HARD_MS", LEAN_MODE ? 5000 : 10000, 2000, 60000),
  crawlerPageMaxResources: numberEnv("CRAWLER_PAGE_MAX_RESOURCES", LEAN_MODE ? 48 : 128, 16, 2000),
  crawlerPageMinPerHostConcurrency: numberEnv("CRAWLER_PAGE_MIN_PER_HOST_CONCURRENCY", LEAN_MODE ? 2 : 4, 1, 32),
  vpnEnabled: boolEnv("VPN_ENABLED", false),
  vpnMode: enumEnv("VPN_MODE", "proxy", ["proxy", "auto", "wireguard"]),
  vpnKillSwitch: boolEnv("VPN_KILL_SWITCH", true),
  vpnFailover: boolEnv("VPN_FAILOVER", true),
  vpnAlwaysOn: boolEnv("VPN_ALWAYS_ON", false),
  
  maxActiveJobs: numberEnv("MAX_ACTIVE_JOBS", P.maxActiveJobs, 1, 20),
  crawlQueueMax: numberEnv("CRAWL_QUEUE_MAX", 20, 0, 500),
  crawlAbandonMs: numberEnv("CRAWL_ABANDON_MS", 10 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
  
  parseWorkers: numberEnv("CRAWLER_PARSE_WORKERS", P.parseWorkers, 0, 16),
  parseWorkerMinBytes: numberEnv("PARSE_WORKER_MIN_BYTES", 48 * 1024, 0, 64 * 1024 * 1024),
  parseWorkerTimeoutMs: numberEnv("PARSE_WORKER_TIMEOUT_MS", 20000, 1000, 120000),
  parseWorkerHeapMb: numberEnv("PARSE_WORKER_HEAP_MB", MEMORY_LIMIT_MB && MEMORY_LIMIT_MB <= 2048 ? 160 : 384, 64, 4096),
  
  sessionIdleTtlMs: numberEnv("SESSION_IDLE_TTL_MS", numberEnv("PROXY_SESSION_TTL_MS", P.sessionIdleMs, 60 * 1000, 24 * 60 * 60 * 1000), 60 * 1000, 24 * 60 * 60 * 1000),
  sessionMaxAgeMs: numberEnv("SESSION_MAX_AGE_MS", 24 * 60 * 60 * 1000, 10 * 60 * 1000, 7 * 24 * 60 * 60 * 1000),
  
  
  
  adminGate: boolEnv("VEYRA_ADMIN_GATE", true),
  sessionTimeLimitMs: numberEnv("SESSION_TIME_LIMIT_MS", 2 * 60 * 1000, 0, 7 * 24 * 60 * 60 * 1000),
  
  adminSessionTimeLimitMs: 10 * 60 * 1000,
  authSecret: process.env.VEYRA_AUTH_SECRET || "",
  authDataDir: process.env.VEYRA_DATA_DIR || path.join(__dirname, "..", "data"),
  authAllowSignup: boolEnv("VEYRA_ALLOW_SIGNUP", true),
  authTokenTtlMs: numberEnv("VEYRA_AUTH_TOKEN_TTL_MS", 7 * 24 * 60 * 60 * 1000, 10 * 60 * 1000, 90 * 24 * 60 * 60 * 1000),
  adminEmails: String(process.env.VEYRA_ADMIN_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean),
  testMode: boolEnv("VEYRA_TEST_MODE", false),
  sessionMaxCookieBytes: numberEnv("SESSION_MAX_COOKIE_BYTES", 128 * 1024, 4 * 1024, 4 * 1024 * 1024),
  serverIdleSleepMs: numberEnv("SERVER_IDLE_SLEEP_MS", 10 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
  browserWarmIdleMs: numberEnv("BROWSER_WARM_IDLE_MS", 15 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
  devConfigApi: boolEnv("VEYRA_DEV_CONFIG_API", VEYRA_CONFIG.envName === "development"),
  adminToken: process.env.VEYRA_ADMIN_TOKEN || "",
  plan: VEYRA_CONFIG.plan.key,
  vpnDefaultProfile: process.env.VPN_DEFAULT_PROFILE || "",
  vpnProxyServer: process.env.VPN_PROXY_SERVER || "",
  vpnProxyUsername: process.env.VPN_PROXY_USERNAME || "",
  vpnProxyBypass: process.env.VPN_PROXY_BYPASS || "",
  vpnCrawlerProfile: process.env.VPN_CRAWLER_PROFILE || "",
  filterTemplateUrls: boolEnv("FILTER_TEMPLATE_URLS", true),
  maxDiscoveredUrlLength: numberEnv("MAX_DISCOVERED_URL_LENGTH", 4096, 256, 20000),
  maxCrossOriginResources: Math.min(numberEnv("MAX_CROSS_ORIGIN_RESOURCES", P.maxCrossOriginResources, 0, 10000), P.maxCrossOriginResources),
  skipLowValueThirdParty: boolEnv("SKIP_LOW_VALUE_THIRD_PARTY", true),
  playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || "0"
});
try { fs.mkdirSync(CFG.authDataDir, { recursive: true }); } catch {}





const DIRECT_HTTP_AGENT = new UndiciAgent({
  connect: { timeout: 12000, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 },
  keepAliveTimeout: 10000,
  keepAliveMaxTimeout: 30000,
  connections: 24,
  pipelining: 1
});

const shield = createShield(process.env, { lean: CFG.leanMode, log: (level, source, message) => setImmediate(() => serverLog(level, source, message)) });
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(shield.middleware);
installBrandRoutes(app, { frontendUrl: () => CFG.frontendUrl, version: VEYRA_VERSION, isPreviewBot: ua => shield.isPreviewBot(ua), hasProxiedReferer: req => !!proxiedPageFromReferer(req, { allowCookie: false }) });
const allowedOrigins = CFG.frontendOrigins.includes("*") ? true : CFG.frontendOrigins;
app.use(cors({
  origin: allowedOrigins,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  
  
  
  
  exposedHeaders: ["X-Veyra-Request-ID", "X-Veyra-Canonical-URL", "X-Veyra-Challenge", "X-Veyra-Content-Type", "X-Veyra-Session-ID", "X-Veyra-Session-Expires"]
}));


app.use(["/api/resource", "/api/view"], express.raw({ type: () => true, limit: CFG.maxProxyBodyBytes, inflate: true }));
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false, limit: CFG.maxFormBodyBytes }));


app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) sessionManager.activity();
  const m = req.path.match(/^\/api\/crawl\/([^/]+)/);
  if (m) { const j = jobs.get(m[1]); if (j) j.lastPolledAt = Date.now(); }
  next();
});

const jobs = new Map();
const activeByRoot = new Map();
const proxyCache = new Map();
const fetchInflight = new Map();
const searchCache = new Map();
const sessionManager = new SessionManager({
  maxSessions: CFG.maxProxySessions, idleTtlMs: CFG.sessionIdleTtlMs, hardTtlMs: CFG.sessionMaxAgeMs, timeLimitMs: CFG.sessionTimeLimitMs,
  maxCookieBytes: CFG.sessionMaxCookieBytes, serverIdleMs: CFG.serverIdleSleepMs,
  log: (level, source, message) => setImmediate(() => serverLog(level, source, message))
});
const proxySessions = sessionManager.sessions;
const mongoStore = new MongoStore({ uri: CFG.mongoUri, dbName: CFG.mongoDb, maxPoolSize: CFG.mongoPoolSize, cacheBodyMaxBytes: CFG.mongoCacheBodyMaxBytes, cacheTtlMs: CFG.mongoCacheTtlMs });
const neuralModel = new NeuralCrawlerModel({
  savePath: process.env.NEURAL_MODEL_PATH || path.join(CFG.authDataDir, "neural-model.json"),
  saveIntervalMs: numberEnv("NEURAL_MODEL_SAVE_INTERVAL_MS", 60000, 5000, 86400000)
});
neuralModel.load();
const neuralTrainer = new NeuralLearningWorker({
  model: neuralModel, persistence: mongoStore, modelId: "relevance-v1",
  intervalMs: numberEnv("NEURAL_TRAIN_INTERVAL_MS", 5000, 250, 300000),
  batchSize: numberEnv("NEURAL_TRAIN_BATCH_SIZE", 32, 1, 256),
  maxQueue: numberEnv("NEURAL_TRAIN_QUEUE_MAX", 5000, 100, 100000),
  log: (level, source, message) => setImmediate(() => serverLog(level, source, message))
});
const authStore = new AuthStore({
  dataDir: CFG.authDataDir, secret: CFG.authSecret, tokenTtlMs: CFG.authTokenTtlMs,
  adminEmails: CFG.adminEmails, allowSignup: CFG.authAllowSignup, persistence: mongoStore, testMode: CFG.testMode,
  
  log: (level, source, message) => setImmediate(() => serverLog(level, source, message))
});

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
const runtimeGuard = { pressure: false, critical: false, lastNotice: 0 };
function effectiveCrawlerConcurrency(job = null) {
  let limit = CFG.maxActiveFetches;
  
  if (job) { const running = activeCrawlCount(); if (running > 1) limit = Math.max(2, Math.ceil(limit / running)); }
  
  
  if (!job?.pageAccelerator && browserEngine && browserEngine.status().sessions > 0) limit = Math.min(limit, CFG.browserCrawlerConcurrency);
  if (job?.pageAccelerator && CFG.leanMode && browserEngine && browserEngine.status().sessions > 0) limit = Math.min(limit, 1);
  if (runtimeGuard.pressure) limit = Math.min(limit, Math.max(1, Math.floor(limit / 2)));
  if (runtimeGuard.critical) limit = 1;
  return Math.max(1, limit);
}
function clearHotCachesForPressure() {
  const clearSome = (map, maxKeep = 10) => { while (map.size > maxKeep) map.delete(map.keys().next().value); };
  clearSome(proxyCache, Math.min(10, CFG.maxCacheEntries));
  clearSome(searchCache, 10);
  while (dnsPublicCache && dnsPublicCache.size > 500) dnsPublicCache.delete(dnsPublicCache.keys().next().value);
}

const vpnManager = IS_THREAD_WORKER
  ? { dispatcherForSession() { return undefined; }, dispatcherForCrawler() { return undefined; }, status() { return {}; } }
  : new VpnManager((level, source, message) => serverLog(level, source, message));

const browserEngine = new BrowserEngine(
  CFG,
  assertPublicUrl,
  (level, source, message) => serverLog(level, source, message),
  (session, row) => {
    try {
      if (!session?.jobId || !row?.url) return;
      const job = jobs.get(session.jobId);
      if (!job || job.done || job.stopRequested) return;
      const u = normalizeUrl(row.url);
      if (!u) return;
      job.browserDiscoveredCount = Number(job.browserDiscoveredCount || 0);
      job.browserDiscoveredHosts ||= new Set();
      const h = hostOf(u);
      if (job.browserDiscoveredCount >= CFG.maxBrowserDiscovered) return;
      if (!job.browserDiscoveredHosts.has(h) && job.browserDiscoveredHosts.size >= CFG.maxBrowserDiscoveredHosts) return;
      job.browserDiscoveredHosts.add(h);
      job.browserDiscoveredCount += 1;
      const hint = row.resourceType === 'document' ? 'html' : row.resourceType === 'stylesheet' ? 'css' : row.resourceType === 'script' ? 'js' : row.resourceType === 'image' ? 'image' : row.resourceType === 'font' ? 'font' : row.resourceType === 'media' ? 'media' : typeFor(u);
      addLink(job, u, hint, session.canonicalUrl || job.root, row.resourceType === 'document' ? 'browser-navigation' : 'browser-network');
    } catch {}
  },
  vpnManager
);

const workerPool = (!IS_THREAD_WORKER && CFG.parseWorkers > 0 && (require.main === module || process.env.VEYRA_POOL_IN_TESTS === "1"))
  ? new WorkerPool({ size: CFG.parseWorkers, taskTimeoutMs: CFG.parseWorkerTimeoutMs, heapMb: CFG.parseWorkerHeapMb, log: (level, source, message) => serverLog(level, source, message) })
  : null;


const failoverController = IS_THREAD_WORKER ? null : new FailoverController({
  failureThreshold: numberEnv("FAILOVER_FAILURE_THRESHOLD", 3, 1, 10),
  cooldownMs: numberEnv("FAILOVER_COOLDOWN_MS", 60000, 5000, 300000),
  memoryThreshold: floatEnv("FAILOVER_MEMORY_THRESHOLD", 0.80, 0.50, 0.99),
  memoryCritical: floatEnv("FAILOVER_MEMORY_CRITICAL", 0.90, 0.60, 0.99),
  log: (level, source, message) => serverLog(level, source, message)
});



const snapshotStore = IS_THREAD_WORKER ? null : new SnapshotStore({
  mongo: mongoStore,
  log: (level, source, message) => serverLog(level, source, message)
});


if (!IS_THREAD_WORKER) {
  browserEngine.setFailoverCallbacks({
    onCrash: (session, reason) => {
      if (session?.proxySessionId) {
        failoverController.recordBrowserResult(session.proxySessionId, false, reason);
      }
    },
    onStorageState: (proxySessionId, storageState) => {
      
      if (storageState?.cookies && proxySessionId) {
        sessionManager.importPlaywrightCookies(proxySessionId, storageState.cookies);
        
        if (mongoStore.enabled) {
          mongoStore.putSessionCookies(proxySessionId, storageState.cookies).catch(() => {});
        }
      }
    },
    onVerification: (session, challenge) => {
      
      if (session?.proxySessionId) {
        sessionManager.pauseForVerification(session.proxySessionId, challenge?.type || 'challenge');
      }
    }
  });
}


sessionManager.on("expire", (sid, rec, reason) => {
  try { vpnManager.disconnect?.(sid); } catch {}
  
  try { renewingManager?.clearSession(sid); } catch {}
  
  try { for (const j of jobs.values()) if (j.sessionId === sid && !j.done && !j.stopRequested) { if (!j.started) dequeueCrawl(j); j.stopRequested = true; j.stopReason = `session-${reason}`; } } catch {}
  if (reason === "limit") serverLog("info", "SESSION", `Session ${sid.slice(0, 8)}… reached its ${Math.round((rec.timeLimitMs ?? CFG.sessionTimeLimitMs) / 1000)}s time limit and was deleted.`);
  try { scriptDirsBySession.delete(sid); } catch {}
  
  if (failoverController) failoverController.breakers.delete(sid);
  if (snapshotStore) snapshotStore.clearSession(sid);
  
  if (mongoStore.enabled) mongoStore.deleteSessionCookies(sid).catch(() => {});
  return browserEngine.stopForProxySession?.(sid);
});
sessionManager.on("sleep", async () => {
  await browserEngine.shedIdle(0).catch(() => {});
  if (browserEngine.browser && !browserEngine.sessions.size) {
    await browserEngine.browser.close().catch(() => {});
    browserEngine.browser = null; browserEngine.playwright = null;
  }
  proxyCache.clear(); searchCache.clear(); dnsPublicCache.clear();
  for (const j of jobs.values()) if (j.seed && !j.done) j.backgroundPaused = true;
});
sessionManager.on("wake", () => { for (const j of jobs.values()) if (j.seed && !j.done && !runtimeGuard.critical) j.backgroundPaused = false; });
if (!IS_THREAD_WORKER) sessionManager.start();




if (!IS_THREAD_WORKER && mongoStore.enabled) {
  sessionManager.setHydrateFn((sid, rec) => {
    mongoStore.getSessionCookies(sid).then(cookies => {
      if (cookies && cookies.length) {
        sessionManager.importPlaywrightCookies(sid, cookies);
      }
    }).catch(() => {});
  });
}

const browserEngineTimer = IS_THREAD_WORKER ? null : setInterval(() => {
  browserEngine.expireIdle().catch(() => {});
  
  if (failoverController) {
    const activeIds = new Set([...sessionManager.sessions.keys()]);
    failoverController.cleanup(activeIds);
  }
  if (snapshotStore) {
    const activeIds = new Set([...sessionManager.sessions.keys()]);
    snapshotStore.cleanup(activeIds);
  }
}, 30000);
browserEngineTimer?.unref?.();
const runtimeMemoryLimitBytes = MEMORY_LIMIT_MB ? MEMORY_LIMIT_MB * 1024 * 1024 : 0;
const memoryGuardTimer = IS_THREAD_WORKER ? null : setInterval(() => {
  try {
    const rss = process.memoryUsage().rss;
    if (!runtimeMemoryLimitBytes) return;
    const ratio = rss / runtimeMemoryLimitBytes;
    const prev = runtimeGuard.pressure;
    runtimeGuard.pressure = ratio >= 0.78;
    runtimeGuard.critical = ratio >= 0.90;
    
    if (failoverController) failoverController.updateMemory(ratio);
    if (runtimeGuard.pressure) { clearHotCachesForPressure(); sessionManager.shed(runtimeGuard.critical ? "critical" : "pressure"); }
    if (runtimeGuard.critical) {
      browserEngine.shedIdle(20000).catch(() => {});
      for (const job of jobs.values()) if (!job.done) job.backgroundPaused = true;
    } else if (ratio < 0.70) {
      for (const job of jobs.values()) if (!job.done) job.backgroundPaused = !!(job.seed && sessionManager.sleeping);
    }
    if ((runtimeGuard.pressure !== prev || runtimeGuard.critical) && Date.now() - runtimeGuard.lastNotice > 10000) {
      runtimeGuard.lastNotice = Date.now();
      serverLog(runtimeGuard.critical ? "warn" : "info", "SYSTEM", `Memory governor: RSS ${Math.round(rss/1024/1024)}MB / ${MEMORY_LIMIT_MB}MB; crawler concurrency now ${effectiveCrawlerConcurrency()}.`);
    }
  } catch {}
}, 2000);
memoryGuardTimer?.unref?.();




class BrowserTaskScheduler {
  constructor(limit = 24, perHost = 8, maxQueue = 2000) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.perHost = Math.max(1, Number(perHost) || 1);
    this.maxQueue = Math.max(32, Number(maxQueue) || 2000);
    this.active = 0;
    this.queue = [];
    this.inFlight = new Map();
    this.hostActive = new Map();
    this.seq = 0;
    this.running = false;
    this.stats = {
      queued: 0,
      started: 0,
      completed: 0,
      failed: 0,
      deduped: 0,
      rejected: 0
    };
  }

  _hostCount(host) {
    return this.hostActive.get(host) || 0;
  }

  _incHost(host) {
    this.hostActive.set(host, this._hostCount(host) + 1);
  }

  _decHost(host) {
    const next = Math.max(0, this._hostCount(host) - 1);
    if (next) this.hostActive.set(host, next);
    else this.hostActive.delete(host);
  }

  _pickNext() {
    let bestIndex = -1;
    let best = null;
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      if (this._hostCount(item.host) >= this.perHost) continue;
      if (!best || item.priority > best.priority || (item.priority === best.priority && item.seq < best.seq)) {
        best = item;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) return null;
    this.queue.splice(bestIndex, 1);
    return best;
  }

  _pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.active < this.limit && this.queue.length) {
        const item = this._pickNext();
        if (!item) break;
        this.active += 1;
        this._incHost(item.host);
        this.stats.started += 1;
        Promise.resolve()
          .then(() => item.task())
          .then(result => {
            this.stats.completed += 1;
            item.resolve(result);
          }, error => {
            this.stats.failed += 1;
            item.reject(error);
          })
          .finally(() => {
            this.active = Math.max(0, this.active - 1);
            this._decHost(item.host);
            if (this.inFlight.get(item.key) === item.promise) this.inFlight.delete(item.key);
            this._pump();
          });
      }
    } finally {
      this.running = false;
    }
  }

  request(key, task, meta = {}) {
    const k = String(key || `anon-${++this.seq}`);
    const existing = this.inFlight.get(k);
    if (existing) {
      this.stats.deduped += 1;
      return existing;
    }

    if (this.queue.length >= this.maxQueue) {
      this.stats.rejected += 1;
      return Promise.reject(new Error("Browser request queue is full."));
    }

    const host = String(meta.host || hostOf(meta.url || "") || "").toLowerCase() || "unknown";
    const priority = Number.isFinite(Number(meta.priority)) ? Number(meta.priority) : 0;
    let resolvePromise, rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const item = {
      key: k,
      host,
      priority,
      seq: ++this.seq,
      task: typeof task === "function" ? task : async () => task,
      resolve: resolvePromise,
      reject: rejectPromise,
      promise
    };
    this.inFlight.set(k, promise);
    this.queue.push(item);
    this.stats.queued = Math.max(this.stats.queued, this.queue.length);
    this._pump();
    return promise;
  }

  status() {
    return {
      active: this.active,
      queued: this.queue.length,
      inFlight: this.inFlight.size,
      limit: this.limit,
      perHost: this.perHost,
      deduped: this.stats.deduped,
      started: this.stats.started,
      completed: this.stats.completed,
      failed: this.stats.failed,
      rejected: this.stats.rejected,
      hostsActive: this.hostActive.size
    };
  }
}
const browserScheduler = new BrowserTaskScheduler(CFG.browserMaxActiveFetches, CFG.browserPerHostConcurrency, 2000);
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
function isIncognitoSid(sid) {
  const id = String(sid || "");
  if (!id) return false;
  try { return !!sessionManager.peek(id)?.incognito; } catch { return false; }
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
      
      targetHost: target && !isIncognitoSid(req.query?.sid) ? (() => { try { return new URL(target).hostname; } catch { return ""; } })() : ""
    });
  });
  next();
});

function respondError(res, status, message, code, extra = {}) {
  res.status(status).json({ error: String(message), code: String(code), ...extra });
}

const TRACKER_HOSTS = new Set(("doubleclick.net googlesyndication.com googleadservices.com google-analytics.com googletagservices.com adservice.google.com " +
  "pagead2.googlesyndication.com analytics.google.com stats.g.doubleclick.net adnxs.com adsrvr.org amazon-adsystem.com criteo.com criteo.net " +
  "taboola.com outbrain.com scorecardresearch.com quantserve.com hotjar.com hotjar.io mouseflow.com fullstory.com clarity.ms " +
  "moatads.com rubiconproject.com pubmatic.com openx.net casalemedia.com smartadserver.com yieldmo.com media.net sharethrough.com " +
  "adform.net bidswitch.net 3lift.com teads.tv zedo.com revcontent.com mgid.com popads.net propellerads.com exoclick.com " +
  "facebook.net connect.facebook.net ads-twitter.com analytics.twitter.com ads.linkedin.com px.ads.linkedin.com bat.bing.com " +
  "branch.io appsflyer.com adjust.com segment.io segment.com mixpanel.com amplitude.com newrelic.com nr-data.net " +
  "chartbeat.com chartbeat.net parsely.com krxd.net bluekai.com demdex.net omtrdc.net everesttech.net tapad.com").split(/\s+/));
function isTrackerHost(host) {
  let h = String(host || "").toLowerCase();
  while (h.includes(".")) { if (TRACKER_HOSTS.has(h)) return true; h = h.slice(h.indexOf(".") + 1); }
  return false;
}
function sendSessionExpired(req, res, mode, sid) {
  res.setHeader("Cache-Control", "no-store");
  if (mode !== "view") return respondError(res, 410, "This Veyra session reached its time limit and was deleted.", "SESSION_EXPIRED", { sessionId: sid });
  const limit = Math.round(CFG.sessionTimeLimitMs / 1000);
  res.status(410).type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Session ended</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1014;color:#e8eaee;font:15px/1.5 system-ui,sans-serif}main{max-width:420px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#9aa1ad;margin:0}</style></head>
<body><main><h1>Session ended</h1><p>Veyra sessions last ${limit >= 60 ? `${Math.round(limit / 60)} minute${limit >= 120 ? "s" : ""}` : `${limit} seconds`}. This one has been deleted along with its cookies and history. Start a new session to keep browsing.</p></main>
<script>try{top.postMessage({type:"veyra:session-expired",sessionId:${JSON.stringify(sid)}},"*")}catch(e){}</script></body></html>`);
}
function safeMethod(method) { return ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"].includes(String(method || "").toUpperCase()); }


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
function queryStringValue(value) {
  if (Array.isArray(value)) return value.map(x => String(x || "").trim()).find(Boolean) || "";
  return String(value || "").trim();
}
function firstValidUrl(values, base) {
  const list = Array.isArray(values) ? values : [values];
  for (const value of list) {
    const candidate = queryStringValue(value);
    if (!candidate) continue;
    const normalized = normalizeUrl(candidate, base);
    if (normalized) return normalized;
  }
  return null;
}
function unwrapProxyTarget(value, base) {
  let raw = queryStringValue(value);
  if (!raw) return "";
  for (let i = 0; i < 3; i++) {
    try {
      const probe = new URL(raw, base || undefined);
      const isProxy = probe.pathname === "/api/view" || probe.pathname === "/api/resource" || probe.pathname === "/api/download";
      if (isProxy) {
        const embedded = probe.searchParams.get("url") || probe.searchParams.get("target") || probe.searchParams.get("u");
        if (embedded) { raw = embedded; continue; }
        return "";
      }
    } catch {}
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded !== raw && /^https?:\/\//i.test(decoded)) { raw = decoded; continue; }
    } catch {}
    break;
  }
  return raw;
}
function normalizeUrl(value, base) {
  try {
    const raw = unwrapProxyTarget(value, base);
    if (!raw) return null;
    const u = new URL(raw, base);
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
function sameRedirectHost(a, b) {
  try {
    const ah = new URL(a).hostname.toLowerCase().replace(/^www\./, "");
    const bh = new URL(b).hostname.toLowerCase().replace(/^www\./, "");
    return ah === bh;
  } catch { return false; }
}
function crawlOriginAllowed(job, url) {
  try { return job.crawlOrigins?.has(new URL(url).origin) || false; } catch { return false; }
}
function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } }
function pathOf(url) { try { const u = new URL(url); return `${u.pathname || "/"}${u.search || ""}`; } catch { return String(url || ""); } }
function linkKey(type, url) { return `${type}|${url}`; }


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
  
  return sessionManager.touch(sid);
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
  sessionManager.trimCookies(session);
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
function networkErrorCode(err) {
  return String(err?.code || err?.cause?.code || err?.cause?.cause?.code || '').trim().toUpperCase();
}
function networkErrorMessage(err) {
  const code = networkErrorCode(err);
  const raw = String(err?.message || err || 'Network request failed').trim();
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Upstream DNS lookup failed (${code}).`;
  if (code === 'ECONNREFUSED') return 'The destination refused the upstream connection.';
  if (code === 'ECONNRESET') return 'The destination reset the upstream connection.';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') return 'The upstream connection timed out.';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'The Veyra server could not reach the destination network.';
  if (/CERT_|ERR_TLS|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED/i.test(code)) return `The destination TLS certificate could not be verified (${code || 'TLS_ERROR'}).`;
  if (/fetch failed/i.test(raw)) return code ? `The upstream connection failed (${code}).` : 'The upstream connection failed before Veyra received an HTTP response.';
  return raw.slice(0, 500);
}
function isRetryableNetworkError(err) {
  const code = networkErrorCode(err);
  return /^(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT)$/i.test(code) || /fetch failed/i.test(String(err?.message || ''));
}
function decorateUpstreamError(err, url) {
  const e = err instanceof Error ? err : new Error(String(err));
  e.upstreamCode = networkErrorCode(err) || 'UPSTREAM_NETWORK_ERROR';
  e.upstreamPhase = /timed out|timeout|headers_timeout|Response body timed out/i.test(String(err?.message || '')) ? 'timeout' : 'connect';
  e.upstreamMessage = networkErrorMessage(err);
  e.upstreamHost = hostOf(url);
  e.code = /^VPN_/.test(String(e.code || '')) ? e.code : 'UPSTREAM_NETWORK_ERROR';
  return e;
}
function oversizeStream(response, head, reader) {
  
  
  let taken = false;
  return {
    take() {
      if (taken) return null; taken = true;
      const r = reader || response.body?.getReader();
      return { head, reader: r };
    },
    cancel() { if (taken) return; taken = true; try { (reader ? reader.cancel() : response.body?.cancel())?.catch?.(() => {}); } catch {} }
  };
}
async function readBodyLimited(response, limit, keepStream = false, bodyTimeoutMs = CFG.bodyTimeoutMs, signal = null) {
  const len = Number(response.headers.get("content-length"));
  if (Number.isFinite(len) && len > limit) {
    if (keepStream && response.body) return { body: Buffer.alloc(0), bytes: len, truncated: true, tooLarge: true, stream: oversizeStream(response, [], null) };
    try { await response.body?.cancel(); } catch {}
    return { body: Buffer.alloc(0), bytes: len, truncated: true, tooLarge: true };
  }
  const reader = response.body?.getReader();
  if (!reader) {
    if (signal?.aborted) throw Object.assign(new Error("Operation cancelled."), { code: "OPERATION_CANCELLED" });
    const buf = Buffer.from(await withTimeout(response.arrayBuffer(), bodyTimeoutMs, "Response body timed out."));
    return { body: buf.subarray(0, limit), bytes: buf.length, truncated: buf.length > limit, tooLarge: buf.length > limit };
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
    if (signal?.aborted) { try { await reader.cancel(); } catch {} throw Object.assign(new Error("Operation cancelled."), { code: "OPERATION_CANCELLED" }); }
    const { done, value } = await withTimeout(reader.read(), bodyTimeoutMs, "Response body timed out.");
    if (done) break;
    const chunk = Buffer.from(value);
    const keep = Math.max(0, Math.min(chunk.length, limit - total));
    if (keep) chunks.push(chunk.subarray(0, keep));
    total += chunk.length;
    if (total > limit) {
      if (keepStream) {
        
        
        const head = keep ? [...chunks.slice(0, -1), chunk] : [...chunks, chunk];
        return { body: Buffer.alloc(0), bytes: total, truncated: true, tooLarge: true, stream: oversizeStream(response, head, reader) };
      }
      truncated = true; try { await reader.cancel(); } catch {} break;
    }
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
      const upstreamSignal = opts.signal;
      const onAbort = () => controller.abort();
      if (upstreamSignal) {
        if (upstreamSignal.aborted) throw Object.assign(new Error("Operation cancelled."), { code: "OPERATION_CANCELLED" });
        upstreamSignal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        const reqHeaders = new Headers(headers);
        if (sessionId) {
          reqHeaders.delete("cookie");
          const jarCookie = cookieHeader(sessionId, current);
          if (jarCookie) reqHeaders.set("cookie", jarCookie);
        }
        if (cached?.etag) reqHeaders.set("if-none-match", cached.etag);
        if (cached?.lastModified) reqHeaders.set("if-modified-since", cached.lastModified);
        const vpnEnabledForRequest = sessionId
          ? vpnManager.requiresVpnForSession?.(sessionId) ?? false
          : vpnManager.requiresVpnForCrawler?.() ?? false;
        const suppliedDispatcher = opts.dispatcher || (sessionId ? vpnManager.dispatcherForSession(sessionId) : vpnManager.dispatcherForCrawler());
        if (vpnEnabledForRequest && !suppliedDispatcher && vpnManager.killSwitch) {
          const e = Object.assign(new Error('Veyra VPN is unavailable and the kill switch blocked a direct upstream connection.'), { code: 'VPN_KILL_SWITCH' });
          throw e;
        }
        const directMode = !suppliedDispatcher && !vpnEnabledForRequest;
        const dispatcher = suppliedDispatcher || (directMode ? (attempt % 2 === 0 ? DIRECT_HTTP_AGENT : undefined) : undefined);
        const response = await undiciFetch(current, {
          method,
          headers: reqHeaders,
          redirect: "manual",
          signal: controller.signal,
          body: opts.body && method !== "GET" && method !== "HEAD" ? opts.body : undefined,
          ...(dispatcher ? { dispatcher } : {})
        });
        if (sessionId) storeSetCookies(sessionId, current, response);
        clearTimeout(timer);
        if (upstreamSignal) upstreamSignal.removeEventListener("abort", onAbort);
        if (response.status === 304) {
          if (cached) return { ...cached.response, status: cached.response.status || 200, revalidated: true, redirectChain };
          
          
          
          
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
          lastError = Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
          retriesUsed += 1;
          await sleep(backoffMs(attempt, retryAfterMs(response.headers)));
          continue;
        }
        const contentType = response.headers.get("content-type") || "";
        const bodyLimit = typeof opts.limitForContentType === "function" ? opts.limitForContentType(contentType, response.headers) : limit;
        const body = await readBodyLimited(response, bodyLimit, !!opts.streamOversize, opts.bodyTimeoutMs ?? CFG.bodyTimeoutMs, upstreamSignal);
        const upstreamEncoding = response.headers.get("content-encoding") || "";
        const headerLength = response.headers.get("content-length") || "";
        
        
        
        
        
        
        
        
        const contentLength = body.body && !body.truncated && body.body.length
          ? String(body.body.length)
          : (upstreamEncoding ? "" : (method === "HEAD" || !body.truncated ? headerLength : ""));
        return {
          ok: response.ok,
          status: response.status,
          finalUrl: current,
          contentType,
          cacheControl: response.headers.get("cache-control") || "",
          vary: response.headers.get("vary") || "",
          etag: response.headers.get("etag") || "",
          lastModified: response.headers.get("last-modified") || "",
          expires: response.headers.get("expires") || "",
          contentRange: response.headers.get("content-range") || "",
          acceptRanges: response.headers.get("accept-ranges") || "",
          linkHeader: response.headers.get("link") || "",
          contentDisposition: response.headers.get("content-disposition") || "",
          setCookieHeader: response.headers.get("set-cookie") || "",
          contentEncoding: upstreamEncoding,
          contentLength,
          serverHeader: response.headers.get("server") || "",
          cfMitigated: response.headers.get("cf-mitigated") || "",
          xFrameOptions: response.headers.get("x-frame-options") || "",
          contentSecurityPolicy: response.headers.get("content-security-policy") || "",
          bytes: body.bytes,
          truncated: body.truncated,
          tooLarge: body.tooLarge,
          stream: body.stream || null,
          body: body.body,
          redirectChain,
          retries: retriesUsed,
          sessionId: sessionId || ""
        };
      } catch (e) {
        clearTimeout(timer);
        if (upstreamSignal) upstreamSignal.removeEventListener("abort", onAbort);
        
        
        if (e?.code === "OPERATION_CANCELLED" || upstreamSignal?.aborted) throw Object.assign(new Error("Operation cancelled."), { code: "OPERATION_CANCELLED" });
        
        const vpnCause = e?.cause?.code && String(e.cause.code).startsWith("VPN_") ? e.cause : (String(e?.code || "").startsWith("VPN_") ? e : null);
        if (vpnCause) throw Object.assign(new Error(vpnCause.message), { code: vpnCause.code, status: vpnCause.code === "VPN_KILL_SWITCH" ? 503 : 502, upstreamCode: vpnCause.code, upstreamPhase: 'vpn', upstreamMessage: vpnCause.message });
        lastError = decorateUpstreamError(e, current);
        const retryableError = isRetryableNetworkError(e) && attempt < (opts.retries ?? CFG.maxRetries);
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


const webSearch = createWebSearch({
  fetchText: async (url, opts = {}) => {
    const r = await fetchBuffer(url, {
      headers: opts.headers || {}, accept: opts.accept || "application/json", timeout: 12000,
      retries: 1, limit: 2 * 1024 * 1024
    });
    return { ok: r.ok, status: r.status, text: r.body.toString("utf8"), finalUrl: r.finalUrl };
  },
  env: process.env,
  log: (level, source, message) => serverLog(level, source, message)
});

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
  const normalized = normalizeUrl(url);
  const referrerKey = String(opts.referrer || "");
  const sid = String(opts.sessionId || "");
  
  
  
  const userAgentKey = opts.userAgent ? crypto.createHash("sha1").update(String(opts.userAgent)).digest("hex").slice(0, 16) : "default";
  const baseKey = `${method} ${normalized} | ref=${referrerKey} | ua=${userAgentKey}`;
  const key = `${baseKey} | sid=${sid}`;
  const sharedKey = `${method} ${normalized} | ua=${userAgentKey} | sid=*`;
  const canCoalesce = method === "GET" && !opts.noCache && !opts.streamOversize;
  if (canCoalesce) { const existing = fetchInflight.get(key); if (existing) return existing; }
  const work = (async () => {
    let cachedEntry = opts.noCache || method !== "GET" ? null : proxyCache.get(key) || null;
    if (!cachedEntry && method === "GET" && CFG.mongoSharedCache) cachedEntry = proxyCache.get(sharedKey) || null;
    if (!cachedEntry && method === "GET" && mongoStore.enabled) {
      const persisted = await mongoStore.getProxyCache(key);
      if (persisted) { cacheSet(proxyCache, key, persisted, CFG.maxProxyCacheEntries); cachedEntry = persisted; }
    }
    if (!cachedEntry && method === "GET" && CFG.mongoSharedCache && mongoStore.enabled) {
      const persisted = await mongoStore.getProxyCache(sharedKey);
      if (persisted) { cacheSet(proxyCache, sharedKey, persisted, CFG.maxProxyCacheEntries); cachedEntry = persisted; }
    }
    if (cachedEntry && Date.now() - cachedEntry.time <= CFG.proxyCacheMs && !opts.revalidate) return { ...cachedEntry.response, cacheHit: true };
    const result = await fetchBuffer(url, { ...opts, cached: cachedEntry && method === "GET" ? cachedEntry : null });
    if (!opts.noCache && method === "GET") {
      const noStore = /no-store/i.test(result.cacheControl || "");
      const bodyBytes = Buffer.byteLength(result.body || Buffer.alloc(0));
      if (!noStore && !result.truncated && !result.tooLarge && bodyBytes <= CFG.maxCacheBodyBytes) cacheSet(proxyCache, key, { response: result, etag: result.etag, lastModified: result.lastModified }, CFG.maxProxyCacheEntries);
      const shareableType = /(?:text\/css|javascript|font\/|image\/|image\/svg\+xml)/i.test(String(result.contentType || ""));
      const noSessionCookies = !result.setCookieHeader && (!sid || !cookieHeader(sid, normalized));
      const incognito = isIncognitoSid(sid);
      const shared = !incognito && CFG.mongoSharedCache && shareableType && noSessionCookies && !noStore && !result.truncated && !result.tooLarge && bodyBytes <= Math.min(CFG.maxCacheBodyBytes, CFG.mongoCacheBodyMaxBytes);
      if (shared) { const sharedResult = { ...result, sessionId: "" }; cacheSet(proxyCache, sharedKey, { response: sharedResult, etag: result.etag, lastModified: result.lastModified }, CFG.maxProxyCacheEntries); void mongoStore.putProxyCache(sharedKey, result, { url: result.finalUrl || normalized, sessionId: "" }); }
      else if (!sid && !incognito && !noStore && !result.truncated && !result.tooLarge && bodyBytes <= Math.min(CFG.maxCacheBodyBytes, CFG.mongoCacheBodyMaxBytes)) void mongoStore.putProxyCache(key, result, { url: result.finalUrl || normalized, sessionId: "" });
    }
    return result;
  })();
  if (canCoalesce) fetchInflight.set(key, work);
  try { return await work; } finally { if (canCoalesce && fetchInflight.get(key) === work) fetchInflight.delete(key); }
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
  
  if (/unusual traffic from your computer network/.test(text) || (/\/sorry\/index/.test(String(headers.finalUrl || "")) && /captcha/.test(text))) {
    return { type: "unusual-traffic", status, signals: signals + 1, provider: "google" };
  }
  if (titleLike || (signals >= 2 && (status === 403 || status === 429 || status === 503 || text.length < 150000)) || (headerSignal && signals >= 1)) {
    return { type: "security-verification", status, signals };
  }
  return null;
}


class PriorityFrontier {
  constructor(maxSize) {
    this.maxSize = Math.max(1, Number(maxSize) || 1);
    this.seen = new Set();
    this.queued = new Set();
    this.hosts = new Map();
    this.hostHeap = [];
    this.seq = 0;
    this.blockedScratch = [];
  }
  get size() { let n = 0; for (const bucket of this.hosts.values()) n += bucket.heap.length; return n; }
  #greater(a, b) {
    return a.priority > b.priority || (a.priority === b.priority && (a.notBefore || 0) < (b.notBefore || 0)) ||
      (a.priority === b.priority && (a.notBefore || 0) === (b.notBefore || 0) && a.seq < b.seq);
  }
  #up(heap, i) { while (i > 0) { const p = (i - 1) >> 1; if (!this.#greater(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } }
  #down(heap, i) { for (;;) { const l = i * 2 + 1, r = l + 1; let best = i; if (l < heap.length && this.#greater(heap[l], heap[best])) best = l; if (r < heap.length && this.#greater(heap[r], heap[best])) best = r; if (best === i) break; [heap[i], heap[best]] = [heap[best], heap[i]]; i = best; } }
  #pushNode(bucket, node) { bucket.heap.push(node); this.#up(bucket.heap, bucket.heap.length - 1); }
  #popNode(bucket) { const top = bucket.heap[0], last = bucket.heap.pop(); if (bucket.heap.length) { bucket.heap[0] = last; this.#down(bucket.heap, 0); } return top; }
  #pushHostRef(bucket) { const top = bucket.heap[0]; const ref = { host: bucket.host, node: top, priority: top.priority, notBefore: top.notBefore, seq: ++this.seq }; this.hostHeap.push(ref); this.#up(this.hostHeap, this.hostHeap.length - 1); }
  #popHostRef() { const top = this.hostHeap[0], last = this.hostHeap.pop(); if (this.hostHeap.length) { this.hostHeap[0] = last; this.#down(this.hostHeap, 0); } return top; }
  #insert(item, priority, key, notBefore = 0) {
    const host = hostOf(item.url) || '(unknown)';
    const node = { item, priority: Number(priority) || 0, seq: ++this.seq, host, notBefore: Number(notBefore) || 0 };
    let bucket = this.hosts.get(host);
    if (!bucket) { bucket = { host, heap: [] }; this.hosts.set(host, bucket); }
    const wasEmpty = bucket.heap.length === 0;
    this.#pushNode(bucket, node);
    if (wasEmpty || bucket.heap[0] === node) this.#pushHostRef(bucket);
    this.queued.add(key);
    return true;
  }
  add(item, priority, key) {
    if (!item || !key || this.size >= this.maxSize || this.seen.has(key)) return false;
    this.seen.add(key);
    return this.#insert(item, priority, key, item.notBefore || 0);
  }
  requeue(item, priority, key, notBefore = 0) {
    if (!item || !key || this.size >= this.maxSize || this.queued.has(key)) return false;
    return this.#insert({ ...item, notBefore }, priority, key, notBefore);
  }
  takeNext(activeHosts, perHostLimit, hostCooldowns) {
    if (!this.hostHeap.length) return null;
    const blocked = this.blockedScratch; blocked.length = 0;
    const nowMs = Date.now();
    let selected = null;
    while (this.hostHeap.length) {
      const ref = this.#popHostRef();
      const bucket = this.hosts.get(ref.host);
      if (!bucket || !bucket.heap.length || bucket.heap[0] !== ref.node) continue;
      const node = bucket.heap[0];
      const active = activeHosts.get(ref.host) || 0;
      const limit = typeof perHostLimit === "function" ? Math.max(1, Number(perHostLimit(ref.host)) || 1) : Math.max(1, Number(perHostLimit) || 1);
      const cooldown = hostCooldowns.get(ref.host) || 0;
      if (active >= limit || cooldown > nowMs || (node.notBefore || 0) > nowMs) { blocked.push(ref); continue; }
      selected = this.#popNode(bucket);
      this.queued.delete(`${selected.item.type}|${selected.item.url}`);
      if (bucket.heap.length) this.#pushHostRef(bucket); else this.hosts.delete(ref.host);
      break;
    }
    for (const ref of blocked) { this.hostHeap.push(ref); this.#up(this.hostHeap, this.hostHeap.length - 1); }
    return selected?.item || null;
  }
  nextReadyAt() {
    let soonest = 0;
    for (const bucket of this.hosts.values()) {
      const n = bucket.heap[0];
      if (n?.notBefore && (!soonest || n.notBefore < soonest)) soonest = n.notBefore;
    }
    return soonest;
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
  if (kind === "css" || kind === "js" || kind === "font") score += 12;
  if (kind === "image") score += 6;
  const depth = pathDepth(url);
  score -= Math.min(24, depth * 4);
  const u = new URL(url);
  const r = String(reason || "").toLowerCase();
  if (r === "root") score += 1000;
  if (r === "sitemap") score += 250;
  if (r === "canonical") score += 180;
  if (r === "navigation") score += 100;
  if (r === "browser-network" || r === "dynamic") score += 140;
  if (r === "preload" || r === "modulepreload" || r === "render-critical") score += 260;
  if (r === "critical-image") score += 210;
  if (r === "api") score += 150;
  if (r === "lazy") score += 40;
  if (r === "metadata") score += 55;
  if (u.searchParams.size) score -= Math.min(20, u.searchParams.size * 3);
  if (/(?:calendar|day|month|page)=[^&]+/i.test(u.search)) score -= 15;
  return score;
}

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
  const pendingSet = new Set(pending);
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
        if (/\.xml(?:$|\?)/i.test(u) && /sitemap/i.test(u)) { if (!seen.has(u) && !pendingSet.has(u) && pending.length < 250) { pending.push(u); pendingSet.add(u); } continue; }
        if (crawlOriginAllowed(job, u)) { addLink(job, u, "html", sm, "sitemap"); urls += 1; }
        if (urls >= CFG.maxSitemapUrls) break;
      }
    } catch (e) { jobLog(job, "debug", `Sitemap failed: ${sm} — ${e.message}`); }
  }
  while (pending.length && files < CFG.maxSitemapFiles && urls < CFG.maxSitemapUrls && !job.stopRequested) {
    const batch = pending.splice(0, CFG.sitemapConcurrency);
    await Promise.allSettled(batch.map(processSitemap));
  }
  if (files) jobLog(job, "info", `Sitemap pass: ${files} file(s), ${urls} URL(s) discovered.`);
}


function encodePathToken(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64url");
}
function decodePathToken(value) {
  try { return Buffer.from(String(value || ""), "base64url").toString("utf8"); } catch { return ""; }
}
function makeGetFormProxyAction(url, sid) {
  const token = encodePathToken(url);
  const safeSid = encodePathToken(normalizeSessionId(sid || ""));
  return `/api/form-get/${token}/${safeSid}`;
}

function challengeFallbackHtml(url, info, sid = "") {
  const safe = escapeHtml(url);
  let query = "";
  try { const u = new URL(url); const cont = u.searchParams.get("continue"); const src = cont ? new URL(cont) : u; query = src.searchParams.get("q") || src.searchParams.get("query") || ""; } catch {}
  const google = info?.type === "unusual-traffic";
  const title = google ? "Google is asking for a captcha" : "This site requires its own security verification";
  const why = google
    ? "Google blocks searches that come from cloud servers like the one Veyra runs on, and its captcha can't be completed through a proxy. This isn't something Veyra can bypass. Connecting Veyra VPN to a residential exit usually avoids it."
    : `Veyra's server proxy detected a security or bot-verification page (${escapeHtml(info?.type || "verification")}). It was not indexed as site content and Veyra will not attempt to bypass the site's security controls.`;
  const alt = query ? [
    ["Bing", `https://www.bing.com/search?q=${encodeURIComponent(query)}`],
    ["Brave Search", `https://search.brave.com/search?q=${encodeURIComponent(query)}`],
    ["DuckDuckGo", `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`]
  ].map(([n, h]) => `<a class="secondary" href="${escapeHtml(h)}" target="_blank" rel="noopener noreferrer">Open “${escapeHtml(query)}” on ${n}</a>`).join("") : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#10151d;color:#eaf0f6;font:15px/1.5 system-ui,sans-serif}.card{max-width:650px;margin:24px;padding:32px;background:#171e28;border:1px solid #303a48;border-radius:18px;box-shadow:0 20px 60px #0008}.ey{font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:#86a9d5}.card h1{font-size:26px;margin:10px 0}.card p{color:#aab5c4}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}.actions a{display:inline-block;padding:10px 15px;border-radius:9px;text-decoration:none}.primary{background:#4b82c9;color:#fff}.secondary{border:1px solid #3a4657;color:#dce5ef}.secondary:hover{background:#1f2835}</style></head><body><main class="card"><div class="ey">Veyra Browser</div><h1>${escapeHtml(title)}</h1><p>${why}</p><div class="actions"><a class="primary" href="#" id="veyraChromium">Verify in real Chromium</a>${alt}<a class="secondary" href="${safe}" target="_blank" rel="noopener noreferrer">Open directly in a new tab</a><a class="secondary" href="${escapeHtml(makeViewUrl(url, sid))}">Retry through Veyra</a></div><p style="font-size:13px;margin-top:18px">Chromium shows the site's own check so <b>you</b> can complete it. Veyra does not solve, evade, or weaken CAPTCHA/anti-bot checks.</p></main><script>(function(){var m={type:"veyra:challenge",url:${JSON.stringify(String(url)).replace(/</g, "\\u003c")},kind:${JSON.stringify(String(info?.type || "verification"))},auto:${process.env.CHALLENGE_AUTO_HANDOFF == null ? "true" : /^(1|true|yes|on)$/i.test(String(process.env.CHALLENGE_AUTO_HANDOFF)) ? "true" : "false"}};try{if(parent!==window)parent.postMessage(m,"*")}catch(e){}var b=document.getElementById("veyraChromium");if(b)b.onclick=function(e){e.preventDefault();m.auto=false;m.manual=true;try{parent.postMessage(m,"*")}catch(x){}}})();</script></body></html>`;
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
    
    
    
    /(\bimport\s*\(\s*)(["'`])([^"'`$]+)\2(?=\s*[,)])/g,
    /(\bimport\s+(?:[^'"`;()]*?\s+from\s+)?|\bexport\s+[^'"`;()]*?\s+from\s+)(["'])([^"']+)\2(?=\s*(?:;|$|\n|\r|assert\b|with\b))/gm
  ];
  let out = String(text || "");
  
  
  out = out.replace(/navigator\.serviceWorker\.register\s*\(/g, 'navigator.serviceWorker.register=function(){return Promise.reject(new Error("Service workers are not available in Veyra proxy mode."))};navigator.serviceWorker.register(');
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
  const code = `<script data-veyra-runtime>(function(){
  const CANONICAL=${JSON.stringify(original)};
  const SESSION_ID=${JSON.stringify(sid)};
  const API_ORIGIN=${JSON.stringify(process.env.PUBLIC_API_ORIGIN || "")};
  let virtualUrl=CANONICAL;
  window.__VEYRA_PAGE_URL__=CANONICAL;
  window.__VEYRA_PROXY__=true;
  function unwrap(v){
    let raw=String(v||'');
    for(let i=0;i<3;i++){
      try{
        const u=new URL(raw,location.origin);
        if((u.pathname==='/api/view'||u.pathname==='/api/resource'||u.pathname==='/api/download')){
          const embedded=u.searchParams.get('url')||u.searchParams.get('target')||u.searchParams.get('u');
          if(embedded){raw=embedded;continue;}
          return '';
        }
      }catch{}
      try{const decoded=decodeURIComponent(raw);if(decoded!==raw&&/^https?:[/][/]/i.test(decoded)){raw=decoded;continue;}}catch{}
      break;
    }
    return raw;
  }
  function ownOrigin(o){return o===location.origin||(!!API_ORIGIN&&o===API_ORIGIN)}
  const VEYRA_ROUTES=/^[/]api[/](view|resource|download|form-get|open|crawl|search|suggest|browser|debug|session|vpn|status|health)([/?#]|$)/;
  function fixOwn(u){try{if(!ownOrigin(u.origin))return u;
    if(!/^[/]api[/]/.test(u.pathname))return new URL(u.pathname+u.search+u.hash,virtualUrl);
    // location.pathname is "/api/view" on a proxied page, so app code that builds
    // URLs from it yields "/api/view/<rest>"; map that onto the real page path.
    const vp=new URL(virtualUrl);
    if(/^[/]api[/]view[/]/.test(u.pathname))return new URL(vp.pathname.replace(/[/]$/,'')+u.pathname.slice(9)+u.search+u.hash,vp);
    // Other non-Veyra /api/... paths are page-relative specifiers resolved against /api/view.
    if(!VEYRA_ROUTES.test(u.pathname))return new URL(u.pathname.slice(5)+u.search+u.hash,virtualUrl);
  }catch{}return u}
  // Read a Request's real URL via the native getter: some apps (YouTube) hand fetch()
  // a data: Request with a spoofed own 'url' getter to replay a cached response.
  const reqUrlGet=(()=>{try{return Object.getOwnPropertyDescriptor(Request.prototype,'url').get}catch{return null}})();
  function realUrl(v){if(v==null)return '';if(typeof v==='string')return v;try{if(reqUrlGet&&typeof Request!=='undefined'&&v instanceof Request)return reqUrlGet.call(v)}catch{}if(typeof v.url==='string')return v.url;if(typeof v.href==='string')return v.href;return String(v)}
  function toVirtual(raw){if(/^[?#]/.test(raw))return new URL(raw,virtualUrl);const u=new URL(raw,location.href);return ownOrigin(u.origin)?fixOwn(u):u}
  function resolve(v){try{const raw=unwrap(realUrl(v));return (raw===''?new URL(virtualUrl):toVirtual(raw)).href}catch{return String(v||'')}}
  function shouldProxy(v){try{const u=new URL(unwrap(v));return /^https?:$/.test(u.protocol)}catch{return false}}
  function proxy(kind,u){const prefix=API_ORIGIN || location.origin;const base=prefix+(kind==='view'?'/api/view?url=':'/api/resource?url=')+encodeURIComponent(u);const from=encodeURIComponent(new URL(virtualUrl).href);return kind==='view'?base+'&sid='+encodeURIComponent(SESSION_ID):base+'&from='+from+'&sid='+encodeURIComponent(SESSION_ID)}
  function topPost(msg){try{window.top.postMessage(msg,'*')}catch{}}
  function emit(source,url,extra){if(!url)return;topPost({type:'veyra:navigate',url,source,sessionId:SESSION_ID,...extra})}
  let netSeq=0;
  function hdrObj(h){const o={};try{if(!h)return o;if(typeof h.forEach==='function'&&!Array.isArray(h)){h.forEach((v,k)=>{o[k]=String(v).slice(0,2000)});return o}if(Array.isArray(h)){for(const [k,v] of h)o[String(k).toLowerCase()]=String(v).slice(0,2000);return o}for(const k of Object.keys(h))o[k.toLowerCase()]=String(h[k]).slice(0,2000)}catch{}return o}
  function xhrHeaders(x){const o={};try{for(const line of String(x.getAllResponseHeaders()||'').split(/\\r?\\n/)){const i=line.indexOf(':');if(i>0)o[line.slice(0,i).trim().toLowerCase()]=line.slice(i+1).trim().slice(0,2000)}}catch{}return o}
  function net(method,url,status,ms,ok,resp,extra){const id=SESSION_ID.slice(0,6)+'-'+(++netSeq);let responseHeaders={},size=0,mime='';try{if(resp&&typeof resp.getAllResponseHeaders==='function'){responseHeaders=xhrHeaders(resp);try{size=resp.responseType===''||resp.responseType==='text'?String(resp.responseText||'').length:(resp.response&&resp.response.byteLength)||0}catch{}}else if(resp&&resp.headers){responseHeaders=hdrObj(resp.headers)}mime=responseHeaders['x-veyra-content-type']||responseHeaders['content-type']||'';if(!size)size=Number(responseHeaders['content-length']||0)||0;const b=window.__veyraDevtools;if(b&&b.captureBodies&&resp&&resp.headers&&typeof resp.clone==='function')b.recordBody(id,resp);if(b&&b.captureBodies&&resp&&typeof resp.getAllResponseHeaders==='function'){try{const t=resp.responseType===''||resp.responseType==='text'?String(resp.responseText||''):null;if(t!=null)b.recordBody(id,{headers:{get:k=>responseHeaders[String(k).toLowerCase()]||''},clone:()=>({text:()=>Promise.resolve(t)})})}catch{}}}catch{}
    topPost({type:'veyra:browser-network',id,sessionId:SESSION_ID,pageUrl:virtualUrl,method:String(method||'GET').toUpperCase(),url:String(url||''),status:status||0,duration:Math.round(ms||0),ok:!!ok,startedAt:Date.now()-Math.round(ms||0),mime,size,responseHeaders,blocked:responseHeaders['x-veyra-blocked']||'',...(extra||{})})}
  function canonicalizeMaybeProxy(href){try{const raw=unwrap(href);if(!raw)return null;const u=toVirtual(raw);if(!/^https?:$/.test(u.protocol))return null;return u.href}catch{return null}}
  const HP=(typeof History!=='undefined'&&History.prototype)||null;
  const nativeReplaceState=HP?HP.replaceState:history.replaceState;
  function rootProxiedFrame(){try{return window.parent===window||!window.parent.__VEYRA_PROXY__}catch{return true}}
  function remember(next){virtualUrl=next;window.__VEYRA_PAGE_URL__=next;if(rootProxiedFrame())try{document.cookie='veyra_ctx='+encodeURIComponent(next)+'|'+encodeURIComponent(SESSION_ID)+';path=/;max-age=3600;'+(location.protocol==='https:'?'SameSite=None;Secure;Partitioned':'SameSite=Lax')}catch{}}
  function proxyHistory(method,native){return function(state,title,url){
    let next=virtualUrl;try{if(url!=null)next=fixOwn(new URL(unwrap(String(url)),virtualUrl)).href}catch{}
    remember(next);
    try{native.call(this||history,state,title,proxy('view',next))}catch{}
    emit('history.'+method,next);return undefined;
  }}
  // Patch the prototype (not just the instance): apps such as YouTube call
  // History.prototype.pushState directly, which would otherwise move the frame
  // to a bare Veyra-origin URL and break relative paths and reloads.
  try{if(HP){const np=HP.pushState,nr=HP.replaceState;HP.pushState=proxyHistory('pushState',np);HP.replaceState=proxyHistory('replaceState',nr)}else{const np=history.pushState,nr=history.replaceState;history.pushState=proxyHistory('pushState',np);history.replaceState=proxyHistory('replaceState',nr)}}catch{}
  // Watchdog: if anything still escapes (pristine History from another realm),
  // map the escaped path back onto the real site and restore the proxied URL.
  function heal(){try{if(!/^[/]api[/]/.test(location.pathname)){const next=new URL(location.pathname+location.search+location.hash,virtualUrl).href;remember(next);nativeReplaceState.call(history,history.state,'',proxy('view',next));emit('history.heal',next)}}catch{}}
  try{setInterval(heal,300);addEventListener('popstate',()=>{try{const u=canonicalizeMaybeProxy(location.href);if(u&&u!==virtualUrl){remember(u);emit('history.popstate',u)}}catch{}})}catch{}
  try{
    const LP=Location&&Location.prototype;
    if(LP&&LP.assign){const nativeAssign=LP.assign;LP.assign=function(next){const u=canonicalizeMaybeProxy(next);if(u){emit('location.assign',u);return;}return nativeAssign.call(this,next)}}
    if(LP&&LP.replace){const nativeReplace=LP.replace;LP.replace=function(next){const u=canonicalizeMaybeProxy(next);if(u){emit('location.replace',u);return;}return nativeReplace.call(this,next)}}
  }catch{}
  try{navigator.serviceWorker&&navigator.serviceWorker.register&&(navigator.serviceWorker.register=function(){topPost({type:'veyra:browser-required',reason:'service-worker',sessionId:SESSION_ID,pageUrl:virtualUrl});return Promise.reject(new DOMException('This page requires browser service-worker support.','NotSupportedError'))})}catch{}
  try{if(typeof WebSocket==='function'){const NativeWebSocket=WebSocket;window.WebSocket=function(url,protocols){try{const target=resolve(url);if(/^wss?:/i.test(String(target))){topPost({type:'veyra:browser-required',reason:'websocket',sessionId:SESSION_ID,pageUrl:virtualUrl,url:target})}}catch{};throw new Error('This page requires browser WebSocket support; switching to Chromium.');};window.WebSocket.prototype=NativeWebSocket.prototype}}catch{}
  // Empty SPA shell detector (Roblox, browser.lol, etc.): if the main root stays
  // empty after scripts have had a chance to run, ask the parent to switch to Chromium.
  try{(function(){var fired=false;function check(){if(fired)return;try{var root=document.querySelector('#root,#app,#__next,[data-reactroot],#react-root');var body=document.body;var text=(body&&body.innerText||'').replace(/\\s+/g,' ').trim();var kids=body?body.children.length:0;var emptyRoot=root&&!(root.textContent||'').trim()&&root.children.length===0;var sparse=!text||text.length<40&&kids<4;if(emptyRoot||sparse){fired=true;topPost({type:'veyra:browser-required',reason:'empty-spa-shell',sessionId:SESSION_ID,pageUrl:virtualUrl})}}catch{}}setTimeout(check,2500);setTimeout(check,6000)})()}catch{}
  const nativeFetch=window.fetch;if(nativeFetch)window.fetch=function(input,init){
    const started=performance.now(); const method=String(init&&init.method||input&&input.method||'GET').toUpperCase(); const original=realUrl(input); let target=''; let reqX={initiator:'fetch'};try{reqX.requestHeaders=hdrObj(init&&init.headers||(typeof Request!=='undefined'&&input instanceof Request?input.headers:null));if(init&&typeof init.body==='string')reqX.requestBody=init.body.slice(0,20000)}catch{}
    try{target=resolve(input);if(shouldProxy(target)){const ok=r=>{net(method,target,r.status,performance.now()-started,r.ok,r,reqX);return r},bad=e=>{net(method,target,0,performance.now()-started,false,null,{...reqX,error:String(e&&e.message||e)});throw e};const dest=proxy('resource',target);if(typeof Request!=='undefined'&&input instanceof Request){const src=input;const hasBody=!/^(GET|HEAD)$/i.test(src.method)&&!(init&&'body' in init);return (hasBody?src.clone().arrayBuffer():Promise.resolve(undefined)).then(buf=>{const opts={method:src.method,headers:src.headers,credentials:src.credentials,cache:src.cache,redirect:src.redirect,integrity:src.integrity,signal:src.signal};if(buf&&buf.byteLength)opts.body=buf;if(src.keepalive&&!(buf&&buf.byteLength>60000))opts.keepalive=true;return nativeFetch(dest,Object.assign(opts,init||{}))}).then(ok,bad)}if(init&&init.body&&typeof ReadableStream!=='undefined'&&init.body instanceof ReadableStream){return new Response(init.body).arrayBuffer().then(buf=>{const o=Object.assign({},init,{body:buf});delete o.duplex;return nativeFetch(dest,o)}).then(ok,bad)}return nativeFetch(dest,init).then(ok,bad);}}catch{}
    return nativeFetch(input,init).then(r=>{net(method,target||original,r.status,performance.now()-started,r.ok,r,reqX);return r},e=>{net(method,target||original,0,performance.now()-started,false,null,{...reqX,error:String(e&&e.message||e)});throw e});
  };
  try{const nativeXhrOpen=XMLHttpRequest.prototype.open,nativeXhrSend=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(method,url,...rest){this.__veyraMethod=method;this.__veyraTarget=resolve(url);this.__veyraStarted=0;return nativeXhrOpen.call(this,method,shouldProxy(this.__veyraTarget)?proxy('resource',this.__veyraTarget):url,...rest)};XMLHttpRequest.prototype.send=function(body){this.__veyraStarted=performance.now();const x=this;this.addEventListener('loadend',()=>net(x.__veyraMethod||'GET',x.__veyraTarget||'',x.status,performance.now()-x.__veyraStarted,x.status>=200&&x.status<400,x,{initiator:'xhr',requestHeaders:x.__veyraReqHeaders||{},requestBody:typeof body==='string'?body.slice(0,20000):undefined}),{once:true});return nativeXhrSend.call(this,body)};const nativeSetHeader=XMLHttpRequest.prototype.setRequestHeader;XMLHttpRequest.prototype.setRequestHeader=function(k,v){try{(this.__veyraReqHeaders||(this.__veyraReqHeaders={}))[String(k).toLowerCase()]=String(v).slice(0,2000)}catch{}return nativeSetHeader.call(this,k,v)}}catch{}
  try{const NativeEventSource=window.EventSource;if(NativeEventSource)window.EventSource=function(url,options){const target=resolve(url);return new NativeEventSource(shouldProxy(target)?proxy('resource',target):url,options)}}catch{}
  try{const nativeBeacon=navigator.sendBeacon&&navigator.sendBeacon.bind(navigator);if(nativeBeacon)navigator.sendBeacon=function(url,data){try{const target=resolve(url);if(shouldProxy(target)){let body=data;let type='text/plain;charset=UTF-8';if(typeof Blob!=='undefined'&&data instanceof Blob)type=data.type||type;void fetch(proxy('resource',target),{method:'POST',body,keepalive:true,headers:{'content-type':type}});return true}}catch{}return nativeBeacon(url,data)}}catch{}
  function submitTarget(form,submitter){try{return canonicalizeMaybeProxy((submitter&&submitter.getAttribute('data-veyra-formaction'))||(submitter&&submitter.getAttribute('formaction'))||form.getAttribute('data-veyra-action')||form.getAttribute('action')||virtualUrl)}catch{return null}}
  function emitGetForm(form,submitter,source){const target=submitTarget(form,submitter);if(!target)return false;const method=String(form.method||'get').toUpperCase();if(method!=='GET')return false;const fd=new FormData(form,submitter||undefined);const u=new URL(target);for(const [k,v] of fd.entries())if(typeof v==='string')u.searchParams.append(k,v);emit(source||'form.submit',u.href);return true}
  try{const nativeFormSubmit=HTMLFormElement.prototype.submit;HTMLFormElement.prototype.submit=function(){try{if(emitGetForm(this,null,'form.submit'))return;const target=submitTarget(this,null);const method=String(this.method||'get').toUpperCase();if(target&&method==='POST'){const fd=new FormData(this);const entries=[];for(const [k,v] of fd.entries()){if(typeof v!=='string'){topPost({type:'veyra:unsupported',reason:'File uploads are not supported by the server proxy.'});return;}entries.push([k,v])}topPost({type:'veyra:form',url:target,method:'POST',entries,sessionId:SESSION_ID});return;}}catch{}return nativeFormSubmit.call(this)}}catch{}
  try{const nativeRequestSubmit=HTMLFormElement.prototype.requestSubmit;if(nativeRequestSubmit)HTMLFormElement.prototype.requestSubmit=function(submitter){try{if(emitGetForm(this,submitter,'form.requestSubmit'))return;const target=submitTarget(this,submitter);const method=String(this.method||'get').toUpperCase();if(target&&method==='POST'){const entries=[];for(const [k,v] of new FormData(this,submitter).entries()){if(typeof v!=='string'){topPost({type:'veyra:unsupported',reason:'File uploads are not supported by the server proxy.'});return;}entries.push([k,v])}topPost({type:'veyra:form',url:target,method:'POST',entries,sessionId:SESSION_ID});return;}}catch{}return nativeRequestSubmit.call(this,submitter)}}catch{}
  try{const nativeOpen=window.open;window.open=function(url,target,features){const u=canonicalizeMaybeProxy(url);if(u){topPost({type:'veyra:open',url:u,sessionId:SESSION_ID});return null}return nativeOpen.call(window,url,target,features)}}catch{}
  function fmtArg(x,d){d=d||0;if(typeof x==='string')return x;if(x instanceof Error)return (x.name||'Error')+': '+x.message+(x.stack?'\\n'+String(x.stack).split('\\n').slice(1,6).join('\\n'):'');if(typeof Node!=='undefined'&&x instanceof Node)return x.nodeType===1?'<'+x.tagName.toLowerCase()+(x.id?'#'+x.id:'')+(x.className&&typeof x.className==='string'?'.'+x.className.trim().split(/\\s+/).slice(0,3).join('.'):'')+'>':x.nodeName;if(typeof x==='function')return 'ƒ '+(x.name||'anonymous')+'()';try{const seen=new WeakSet();return JSON.stringify(x,(k,v)=>{if(typeof v==='object'&&v){if(seen.has(v))return '[Circular]';seen.add(v)}if(typeof v==='function')return 'ƒ';if(typeof v==='bigint')return String(v)+'n';return v})||String(x)}catch{return String(x)}}
  let consoleBudget=400,consoleWindow=Date.now();
  try{['log','info','debug','warn','error','trace','dir','table','assert','group','groupCollapsed','groupEnd','count','timeEnd'].forEach(level=>{if(typeof console[level]!=='function')return;const native=console[level].bind(console);console[level]=(...args)=>{native(...args);if(level==='assert'){if(args[0])return;args=['Assertion failed:',...args.slice(1)]}const now=Date.now();if(now-consoleWindow>2000){consoleWindow=now;consoleBudget=400}if(--consoleBudget<0)return;let stack='';if(level==='trace'||level==='error'){try{stack=String(new Error().stack||'').split('\\n').slice(2,9).join('\\n')}catch{}}let msg='';try{msg=args.map(x=>fmtArg(x)).join(' ')}catch{}topPost({type:'veyra:page-console',level:level==='assert'?'error':level,sessionId:SESSION_ID,message:msg.slice(0,20000),stack,time:now,pageUrl:virtualUrl})}})}catch{}
  window.addEventListener('error',e=>topPost({type:'veyra:page-error',level:'error',sessionId:SESSION_ID,message:e.message||'Resource error',url:e.filename||'',line:e.lineno||null,column:e.colno||null,stack:e.error&&e.error.stack||'',pageUrl:virtualUrl}),true);
  window.addEventListener('unhandledrejection',e=>topPost({type:'veyra:page-error',level:'error',sessionId:SESSION_ID,message:e.reason&&e.reason.message||String(e.reason||'Unhandled rejection'),stack:e.reason&&e.reason.stack||'',pageUrl:virtualUrl}),true);
  let inspectMode=false, inspectLast=0, inspectSelected=null;
  function inspectPath(el){const parts=[];let n=el;while(n&&n.nodeType===1&&parts.length<7){let s=n.tagName.toLowerCase();if(n.id)s+='#'+n.id.replace(/[^a-zA-Z0-9_-]/g,'-');else{let c=0,p=n;while((p=p.previousElementSibling))if(p.tagName===n.tagName)c++;if(c)s += ':nth-of-type(' + String(c+1) + ')'}parts.unshift(s);n=n.parentElement}return parts.join(' > ')}
  function inspectData(el){if(!el||el.nodeType!==1)return null;const rect=el.getBoundingClientRect();const attrs={};for(const a of [...el.attributes].slice(0,40))attrs[a.name]=a.value;let styles={};let computed={};try{const cs=getComputedStyle(el);for(const k of ['display','position','width','height','margin','padding','color','background','font','font-size','line-height','opacity','z-index','overflow','border','grid-template-columns','grid-template-rows','flex-direction','justify-content','align-items']){styles[k]=cs.getPropertyValue(k)||''}}catch{}try{const cs=getComputedStyle(el);for(let i=0;i<cs.length&&i<140;i++){const k=cs[i];if(/^(margin|padding|font|color|background|display|position|width|height|border|grid|flex|overflow|opacity|z-index)/i.test(k))computed[k]=cs.getPropertyValue(k)}}catch{}const outer=String(el.outerHTML||'').slice(0,16000);const children=[...el.children].slice(0,60).map((c,i)=>({index:i,tag:c.tagName.toLowerCase(),id:c.id||'',classes:String(c.className||'').slice(0,300),path:inspectPath(c)}));const parent=el.parentElement?{tag:el.parentElement.tagName.toLowerCase(),id:el.parentElement.id||'',path:inspectPath(el.parentElement)}:null;return {tag:el.tagName.toLowerCase(),id:el.id||'',classes:String(el.className||'').slice(0,500),attrs,path:inspectPath(el),outerHTML:outer,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},scrollWidth:el.scrollWidth||0,scrollHeight:el.scrollHeight||0,styles,computed,inlineStyle:el.getAttribute('style')||'',parent,children,tree:inspectPath(el)} }
  function inspectEmit(type,el){const data=inspectData(el);if(!data)return;topPost({type,sessionId:SESSION_ID,pageUrl:virtualUrl,...data})}
  window.addEventListener('message',function(ev){const d=ev.data||{};if(!d||d.type!=='veyra:inspect')return;inspectMode=!!d.enabled;if(!inspectMode&&inspectSelected){try{inspectSelected.style.removeProperty('outline')}catch{}inspectSelected=null}topPost({type:'veyra:inspect-state',enabled:inspectMode,sessionId:SESSION_ID,pageUrl:virtualUrl})});
  // DevTools bridge: loaded on demand from the Veyra origin the first time the
  // frontend's DevTools / extensions talk to this page.
  let dtLoading=null;const dtQueue=[];
  function dtReply(msg){try{window.parent.postMessage(msg,'*')}catch{}}
  function dtLoad(){if(window.__veyraDevtools)return Promise.resolve(window.__veyraDevtools);if(dtLoading)return dtLoading;dtLoading=new Promise((resolve,reject)=>{const sc=document.createElement('script');sc.setAttribute('data-veyra-devtools','bridge');sc.src=(API_ORIGIN||location.origin)+'/api/devtools/bridge.js?v=1';sc.onload=()=>{try{resolve(window.installVeyraDevtools(dtReply,{unwrap:x=>{const r=unwrap(x);try{return r?new URL(r,virtualUrl).href:''}catch{return r}},pageUrl:()=>virtualUrl}))}catch(e){reject(e)}};sc.onerror=()=>{dtLoading=null;reject(new Error('Could not load the DevTools bridge.'))};(document.head||document.documentElement).appendChild(sc)});return dtLoading}
  function dtSer(e){return {message:String(e&&e.message||e),stack:String(e&&e.stack||'')}}
  window.addEventListener('message',function(ev){const d=ev.data||{};if(!d||d.type!=='veyra:dt')return;if(ev.source!==window.parent||window.parent===window)return;if(!rootProxiedFrame())return;
    dtLoad().then(b=>b.call(String(d.method||''),d.params||{})).then(result=>{let safe=result;try{safe=JSON.parse(JSON.stringify(result===undefined?null:result))}catch{safe=null}dtReply({type:'veyra:dt-result',id:d.id,ok:true,result:safe,pageUrl:virtualUrl})},e=>dtReply({type:'veyra:dt-result',id:d.id,ok:false,error:dtSer(e),pageUrl:virtualUrl}))});
  // Keyboard shortcuts pressed inside the page are forwarded to the Veyra UI
  // (the parent frame never sees keydown events that happen in this iframe).
  const SC_SHIFT=['i','j','c','v','delete','t','n','b','o','m','r','p','k','tab','pageup','pagedown'];
  const SC_MOD=['t','w','n','l','r','f','p','j','h','d','k','e','u','g','s',',','pageup','pagedown','=','+','-','0','1','2','3','4','5','6','7','8','9','tab'];
  const SC_ALT=['arrowleft','arrowright','home','d','t','w'];
  document.addEventListener('keydown',function(ev){try{if(!rootProxiedFrame())return;const k=String(ev.key||'').toLowerCase();const mod=ev.ctrlKey||ev.metaKey;
    let fwd=false;
    if(k==='f12'||k==='f5'||k==='f6')fwd=true;
    else if(mod&&ev.shiftKey&&SC_SHIFT.includes(k))fwd=true;
    else if(mod&&!ev.shiftKey&&!ev.altKey&&SC_MOD.includes(k))fwd=true;
    else if(ev.altKey&&!mod&&SC_ALT.includes(k))fwd=true;
    if(!fwd)return;
    ev.preventDefault();ev.stopPropagation();
    topPost({type:'veyra:shortcut',key:ev.key,code:ev.code,ctrlKey:ev.ctrlKey,metaKey:ev.metaKey,shiftKey:ev.shiftKey,altKey:ev.altKey,sessionId:SESSION_ID});
  }catch{}},true);
  window.addEventListener('message',function(ev){const d=ev.data||{};if(d.type==='veyra:find'){try{const q=String(d.query||'').slice(0,200);if(!q){window.getSelection()?.removeAllRanges();topPost({type:'veyra:find-result',matches:0,pageUrl:virtualUrl});return;}let text=String(document.body?.innerText||'').slice(0,2000000);const hay=text.toLocaleLowerCase(),needle=q.toLocaleLowerCase();const matches=needle?(hay.split(needle).length-1):0;window.find(q,false,String(d.direction||'forward')==='backward',true,false,false,false);topPost({type:'veyra:find-result',matches,pageUrl:virtualUrl});}catch{}}else if(d.type==='veyra:find-close'){try{window.getSelection()?.removeAllRanges();}catch{}}else if(d.type==='veyra:print'){try{window.print();}catch{}}});
  document.addEventListener('mousemove',function(ev){if(!inspectMode)return;const now=performance.now();if(now-inspectLast<45)return;inspectLast=now;let el=ev.target;if(!(el instanceof Element))return;inspectEmit('veyra:inspect-hover',el)},true);
  document.addEventListener('click',function(ev){if(inspectMode){ev.preventDefault();ev.stopPropagation();let el=ev.target;while(el&&el.nodeType===1&&el.tagName==='HTML')el=el.parentElement;inspectSelected=el;if(el)inspectEmit('veyra:inspect-select',el);return;}
    const a=ev.target&&ev.target.closest?ev.target.closest('a[href],area[href]'):null;if(!a)return;
    const raw=a.getAttribute('href')||'';const u=canonicalizeMaybeProxy(raw);if(!u)return;
    ev.preventDefault();ev.stopPropagation();
    if(String(a.getAttribute('target')||'').toLowerCase()==='_blank')topPost({type:'veyra:open',url:u,sessionId:SESSION_ID});else emit('document-navigation',u);
  },true);
  document.addEventListener('submit',function(ev){
    const form=ev.target;if(!form)return;const method=String(form.method||'get').toUpperCase();
    const target=submitTarget(form,ev.submitter);if(!target)return;
    if(method==='GET'){
      ev.preventDefault();const fd=new FormData(form,ev.submitter||undefined);const u=new URL(target);for(const [k,v] of fd.entries()){if(typeof v==='string')u.searchParams.append(k,v)}emit('document-navigation',u.href);return;
    }
    if(method==='POST'){
      const fd=new FormData(form,ev.submitter||undefined);const entries=[];for(const [k,v] of fd.entries()){if(typeof v!=='string'){topPost({type:'veyra:unsupported',reason:'File uploads are not supported by the server proxy.'});return;}entries.push([k,v])}
      ev.preventDefault();topPost({type:'veyra:form',url:target,method:'POST',entries,sessionId:SESSION_ID});
    }
  },true);
  document.addEventListener('click',function(ev){try{const el=ev.target&&ev.target.closest?ev.target.closest('button[type=submit],input[type=submit],button[formaction]'):null;if(!el||el.disabled)return;const form=el.form;if(!form)return;if(String(form.method||'get').toUpperCase()!=='GET')return;if(submitTarget(form,el)){ev.preventDefault();ev.stopPropagation();emitGetForm(form,el,'form.click')}}catch{}},true);
  window.addEventListener('load',function(){
    try{const icon=document.querySelector('link[rel~=' + JSON.stringify('icon') + '],link[rel~=' + JSON.stringify('shortcut icon') + ']');let favicon=icon&&icon.getAttribute('href')||'';try{if(favicon.startsWith('/api/resource?url='))favicon=new URLSearchParams(favicon.split('?')[1]).get('url')||favicon;else favicon=new URL(favicon,virtualUrl).href}catch{}const title=document.title||new URL(virtualUrl).hostname;emit('document-navigation',virtualUrl,{title,favicon})}catch{emit('document-navigation',virtualUrl)}
  });
  try{history.replaceState(history.state,document.title,proxy('view',virtualUrl))}catch{}
})();</script>`;
  const withoutMetaCsp = String(html).replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, "");
  return withoutMetaCsp.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}>${code}`);
}
function protectInlineScriptBlocks(html) {
  const originals = [];
  const tokenized = String(html || "").replace(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi, (full, body) => {
    const token = `__VEYRA_INLINE_SCRIPT_${originals.length}_${crypto.randomBytes(6).toString("hex")}__`;
    originals.push({ token, body: String(body) });
    return full.slice(0, full.indexOf(">") + 1) + token + "</script>";
  });
  return { html: tokenized, originals };
}
function restoreInlineScriptBlocks(html, originals) {
  let out = String(html || "");
  for (const item of originals || []) out = out.split(item.token).join(item.body);
  return out;
}
function rewriteHtml(html, base, sid = "") {
  const protectedScripts = protectInlineScriptBlocks(html);
  const $ = cheerio.load(protectedScripts.html, { decodeEntities: false });
  const declaredBase = $("base[href]").first().attr("href");
  const effectiveBase = resolveNavigation(declaredBase, base) || base;
  $("base").remove();
  $("meta[http-equiv]").filter((_, el) => String($(el).attr("http-equiv") || "").toLowerCase() === "content-security-policy").remove();
  $("a[href],area[href]").each((_, el) => { const u = resolveNavigation($(el).attr("href"), effectiveBase); if (u) $(el).attr("href", makeViewUrl(u, sid)); });
  $("form[action]").each((_, el) => {
    const raw = $(el).attr("action");
    const u = resolveNavigation(raw, effectiveBase);
    if (!u) return;
    const method = String($(el).attr("method") || "get").toUpperCase();
    
    
    
    
    
    $(el).attr("data-veyra-action", u);
    if (method === "POST") $(el).attr("action", makeViewUrl(u, sid));
    else $(el).attr("action", makeGetFormProxyAction(u, sid));
  });
  $("[formaction]").each((_, el) => {
    const raw = $(el).attr("formaction");
    const u = resolveNavigation(raw, effectiveBase);
    if (!u) return;
    $(el).attr("data-veyra-formaction", u);
    const parentForm = $(el).closest("form");
    const submitMethod = String(parentForm.attr("method") || "get").toUpperCase();
    
    
    
    
    
    $(el).attr("formaction", submitMethod === "POST" ? makeViewUrl(u, sid) : makeGetFormProxyAction(u, sid));
  });
  $("iframe[src]").each((_, el) => { const u = resolveNavigation($(el).attr("src"), effectiveBase); if (u) $(el).attr("src", makeViewUrl(u, sid)); });
  $("object[data]").each((_, el) => { const u = resolveResource($(el).attr("data"), effectiveBase); if (u) $(el).attr("data", makeResourceUrl(u, effectiveBase, sid)); });
  $("link[href]").each((_, el) => {
    const rel = String($(el).attr("rel") || "").toLowerCase();
    if (rel.includes("canonical")) return;
    const raw = $(el).attr("href"); const u = resolveResource(raw, effectiveBase); if (u) { $(el).attr("href", makeResourceUrl(u, effectiveBase, sid)); if ($(el).attr("integrity")) $(el).removeAttr("integrity"); }
  });
  $("script[src]").each((_, el) => { const u = resolveResource($(el).attr("src"), effectiveBase); if (u) { $(el).attr("src", makeResourceUrl(u, effectiveBase, sid)); if ($(el).attr("integrity")) $(el).removeAttr("integrity"); } });
  for (const tag of ["img", "source", "audio", "input", "embed"]) {
    $(`${tag}[src]`).each((_, el) => { const u = resolveResource($(el).attr("src"), effectiveBase); if (u) $(el).attr("src", makeResourceUrl(u, effectiveBase, sid)); });
  }
  $("video[poster]").each((_, el) => { const u = resolveResource($(el).attr("poster"), effectiveBase); if (u) $(el).attr("poster", makeResourceUrl(u, effectiveBase, sid)); });
  $("track[src]").each((_, el) => { const u = resolveResource($(el).attr("src"), effectiveBase); if (u) $(el).attr("src", makeResourceUrl(u, effectiveBase, sid)); });
  
  
  
  $("use, image").each((_, el) => {
    const rawHref = $(el).attr("href");
    const rawXlink = $(el).attr("xlink:href");
    const attr = rawHref != null ? "href" : (rawXlink != null ? "xlink:href" : null);
    if (!attr) return;
    const u = resolveResource($(el).attr(attr) || "", effectiveBase);
    if (u) $(el).attr(attr, makeResourceUrl(u, effectiveBase, sid));
  });
  $("[imagesrcset]").each((_, el) => $(el).attr("imagesrcset", rewriteSrcset($(el).attr("imagesrcset"), effectiveBase, sid)));
  for (const attr of ["data-src", "data-original", "data-lazy-src"]) {
    $(`[${attr}]`).each((_, el) => { const u = resolveResource($(el).attr(attr), effectiveBase); if (u) $(el).attr(attr, makeResourceUrl(u, effectiveBase, sid)); });
  }
  $(`[data-srcset]`).each((_, el) => $(el).attr("data-srcset", rewriteSrcset($(el).attr("data-srcset"), effectiveBase, sid)));
  $("track[src]").each((_, el) => { const u = resolveResource($(el).attr("src"), effectiveBase); if (u) $(el).attr("src", makeResourceUrl(u, effectiveBase, sid)); });
  $("[srcset]").each((_, el) => $(el).attr("srcset", rewriteSrcset($(el).attr("srcset"), effectiveBase, sid)));
  
  
  
  $("meta[name]").filter((_, el) => String($(el).attr("name") || "").toLowerCase() === "referrer").remove();
  $("meta[http-equiv='refresh'],meta[http-equiv='Refresh']").each((_, el) => {
    const raw = $(el).attr("content") || ""; const m = raw.match(/^(\s*\d+\s*;\s*url\s*=\s*)(.+)$/i); if (!m) return;
    const u = resolveNavigation(m[2].trim().replace(/^['"]|['"]$/g, ""), effectiveBase); if (u) $(el).attr("content", `${m[1]}${makeViewUrl(u, sid)}`);
  });
  $("style").each((_, el) => $(el).html(rewriteCssText($(el).html() || "", effectiveBase)));
  $("[style]").each((_, el) => $(el).attr("style", rewriteCssText($(el).attr("style") || "", effectiveBase)));

  
  
  const preloadCandidates = extractWarmUrls(html, effectiveBase, sid).filter(item => item.priority >= 72);
  if (preloadCandidates.length) {
    const preloadMarkup = criticalPreloadHtml(preloadCandidates, effectiveBase, sid);
    if (preloadMarkup) $("head").first().prepend(preloadMarkup);
  }

  return injectRuntime(restoreInlineScriptBlocks($.html(), protectedScripts.originals), base, sid);
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
  void mongoStore.deleteSearchDocument(doc.url);
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
function indexDocument(url, text, precomputedMeta = null) {
  try {
    const meta = precomputedMeta || extractPageMeta(text, url);
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
    void mongoStore.upsertSearchDocument(doc);
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
  const ranked = [...candidateScores.entries()].map(([url, score]) => {
    const neural = neuralModel.scoreUrl(url, { type: "html", internal: true });
    return [url, score + (neural - 0.5) * 0.35, neural];
  }).sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = ranked.length;
  const results = ranked.slice(offset, offset + limit).map(([url, score, neuralScore]) => {
    const doc = searchIndex.get(url);
    return {
      title: doc.title, url: doc.url, snippet: makeSearchSnippet(doc, parsed), displayUrl: doc.displayUrl,
      favicon: doc.favicon || searchFavicon(doc.url), source: "veyra-index", score: Number(score.toFixed(4)), neuralScore: Number(neuralScore.toFixed(4)),
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
function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let left = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j], cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, left + cost); left = above;
    }
  }
  return prev[b.length];
}
function correctSearchQuery(query) {
  const original = String(query || "").trim().slice(0, CFG.maxSearchQueryChars);
  const dictionary = new Set([...termCounts.keys(), ..."university javascript browser search information technology science history definition example domains youtube reddit twitter".split(/\s+/)]);
  const words = original.split(/(\s+)/);
  let changed = false;
  const corrected = words.map(part => {
    if (!/^[A-Za-z]{4,}$/.test(part)) return part;
    const lower = part.toLowerCase(); if (dictionary.has(lower)) return part;
    const candidates = [...dictionary].filter(x => Math.abs(x.length - lower.length) <= 2);
    let best = null, bestDistance = 3;
    for (const candidate of candidates) { const d = editDistance(lower, candidate); if (d < bestDistance) { best = candidate; bestDistance = d; } }
    if (!best) return part;
    changed = true; return /^[A-Z]/.test(part) ? best[0].toUpperCase() + best.slice(1) : best;
  }).join("");
  return { original, corrected: changed ? corrected : original, changed };
}
function searchIndexStats() {
  const domains = new Set([...searchIndex.values()].map(d => d.host).filter(Boolean));
  const latest = [...searchIndex.values()].sort((a,b) => Date.parse(b.indexedAt || 0) - Date.parse(a.indexedAt || 0))[0];
  return { documents: searchIndex.size, terms: invertedIndex.size, domains: domains.size, latestIndexedAt: latest?.indexedAt || null, seeds: CFG.indexSeeds.length, provider: "veyra-index" };
}


function decodeUrlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
function sanitizeDiscoveredUrl(rawUrl, base) {
  let raw = decodeUrlEntities(String(rawUrl ?? "").trim());
  if (!raw) return null;
  raw = raw.replace(/^[\"'`([{]+/, "").replace(/[\"'`\])},;]+$/, "").trim();
  if (!raw || raw.length > CFG.maxDiscoveredUrlLength) return null;
  if (/\s/.test(raw)) return null;
  if (CFG.filterTemplateUrls && /(?:\$\{|\{\{|\}\}|<%|%>|\{[^}]*\}|\bundefined\b|\bnull\b)/i.test(raw)) return null;
  if (/^(?:javascript|data|blob|mailto|tel|about):/i.test(raw)) return null;
  const u = normalizeUrl(raw, base);
  if (!u) return null;
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase();
    if (/\.(?:corp\.goog|corp\.google|internal|local)$/i.test(host)) return null;
    if (host === "localhost" || host === "metadata.google.internal") return null;
    if (/^(?:0|127\.)/.test(host)) return null;
    if (parsed.username || parsed.password) return null;
    
    if (CFG.filterTemplateUrls) {
      const href = parsed.href;
      if (/[?&](?:id|q|url|query|callback|next|redirect)=(?:$|undefined|null)$/i.test(href)) return null;
    }
    return parsed.href;
  } catch { return null; }
}
function lowValueThirdPartyHost(url) {
  if (!CFG.skipLowValueThirdParty) return false;
  const host = hostOf(url).replace(/^www\./, "");
  return /^(?:googletagmanager\.com|google-analytics\.com|doubleclick\.net|connect\.facebook\.net|static\.hotjar\.com|segment\.io)$/.test(host);
}

function addLink(job, rawUrl, hint, source, reason = "discovered") {
  if (job.collector) {
    
    if (job.links.length >= CFG.maxLinks || rawUrl == null) return false;
    const k = `${rawUrl}\u0000${hint}\u0000${source}`;
    if (job.seen.has(k)) return false;
    job.seen.add(k); job.links.push([String(rawUrl), hint, source || null, reason]);
    return true;
  }
  const u = sanitizeDiscoveredUrl(rawUrl, source || job.root); if (!u) return false;
  const type = typeFor(u, hint);
  const internal = crawlOriginAllowed(job, u);
  if (!internal && lowValueThirdPartyHost(u)) {
    const existing = job.links.find(x => x.url === u);
    if (existing) return true;
    
    
    const record = { url: u, path: pathOf(u), type, source: source || job.root, internal: false, captured: false, requestedUrl: u, redirectChain: [], priority: -100, reason: "third-party-skipped" };
    if (job.links.length < CFG.maxLinks) { job.links.push(record); job.counts.links += 1; }
    return true;
  }
  if (!internal && type !== "html") {
    job.crossOriginResources = job.crossOriginResources || 0;
    if (job.crossOriginResources >= CFG.maxCrossOriginResources) return true;
    job.crossOriginResources += 1;
  }
  const key = linkKey(type, u);
  if (job.discovered.has(key) || job.links.length >= CFG.maxLinks) return false;
  job.discovered.add(key);
  const priority = crawlPriority(u, type === "html" ? "html" : type, reason);
  const record = { url: u, path: pathOf(u), type, source: source || job.root, internal, captured: false, requestedUrl: u, redirectChain: [], priority, reason };
  job.links.push(record); job.counts.links += 1;

  
  
  if (type === "html" && !internal) return true;
  if (type === "html") {
    
    
    
    if (job.pageAccelerator && u !== job.root) return true;
    if (job.pagesDiscovered >= CFG.maxPages || !robotsAllowed(u, job.robots)) return true;
    job.pagesDiscovered += 1;
    job.pageFrontier.add({ url: u, type, source: source || null, reason, priority }, priority, key);
    return true;
  }
  const resourceCeiling = job.pageAccelerator ? Math.min(CFG.maxResources, CFG.crawlerPageMaxResources) : CFG.maxResources;
  if (job.resourcesScheduled >= resourceCeiling) return true;
  job.resourcesScheduled += 1;
  const critical = ["preload", "modulepreload", "render-critical", "critical-image", "browser-network", "api"].includes(String(reason).toLowerCase()) ||
    (type === "css" && /(stylesheet)/i.test(String(reason))) ||
    (type === "js" && /(script|module)/i.test(String(reason)));
  const item = { url: u, type, source: source || null, reason, priority, critical };
  const frontier = critical && job.criticalResourceFrontier.size < CFG.criticalResourceBudget ? job.criticalResourceFrontier : job.resourceFrontier;
  frontier.add(item, priority + (critical ? 180 : 0), key);
  return true;
}
function discoverCss(job, text, base) {
  const src = String(text || "");
  let m;
  const urlRe = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
  while ((m = urlRe.exec(src))) addLink(job, m[2], "asset", base, "css-url");
  const importRe = /@import\s+(?:url\(\s*)?(["'])([^"']+)\1/gi;
  while ((m = importRe.exec(src))) addLink(job, m[2], "css", base, "css-import");
}
function discoverJsonUrls(job, text, base) {
  const src = String(text || "").slice(0, CFG.maxJsonUrlDiscovery * 80);
  let found = 0;
  const addCandidate = (raw, hint = "data", reason = "json-discovered") => {
    if (found >= CFG.maxJsonUrlDiscovery) return;
    const value = String(raw || "").trim().replace(/^['"]|['"]$/g, "");
    if (!value || /^data:|^blob:/i.test(value)) return;
    const likely = /^https?:\/\//i.test(value) || /^\/\//.test(value) || /^\/(?:api|graphql|trpc|_next|wp-json|rest|rpc|v\d+|search)(?:\/|\?|$)/i.test(value) || /^(?:\.\.?\/)/.test(value);
    if (!likely) return;
    const before = job.links.length;
    addLink(job, value, hint, base, reason);
    if (job.links.length !== before) found += 1;
  };
  
  
  try {
    const parsed = JSON.parse(src);
    const walk = (value, depth = 0, keyHint = "") => {
      if (found >= CFG.maxJsonUrlDiscovery || depth > 8) return;
      if (typeof value === "string") {
        const hint = /image|logo|icon|thumbnail|poster|avatar/i.test(keyHint) ? "image" : /video|audio|media|stream/i.test(keyHint) ? "media" : /css|style/i.test(keyHint) ? "css" : /script|js|module/i.test(keyHint) ? "js" : /url|href|link|page|canonical|alternate|endpoint|api/i.test(keyHint) ? "html" : "data";
        addCandidate(value, hint, /api|endpoint|graphql|trpc/i.test(keyHint) ? "api" : "json-discovered");
      } else if (Array.isArray(value)) for (const item of value) walk(item, depth + 1, keyHint);
      else if (value && typeof value === "object") for (const [k, v] of Object.entries(value).slice(0, 500)) walk(v, depth + 1, k);
    };
    walk(parsed, 0, "root");
  } catch {}
  
  for (const m of src.matchAll(/(?:"|'|`)(https?:\/\/[^"'`\s<>\\]+|\/\/(?:[^"'`\s<>\\]+)|\/(?:api|graphql|trpc|_next|wp-json|rest|rpc|v\d+)(?:[^"'`\s<>\\]*))(?:"|'|`)/gi)) {
    addCandidate(m[1], /\/images?\//i.test(m[1]) ? "image" : /\/api\/|graphql|trpc/i.test(m[1]) ? "data" : typeFor(m[1]));
    if (found >= CFG.maxJsonUrlDiscovery) break;
  }
}
function discoverJs(job, text, base) {
  const src = String(text || "");
  const patterns = [
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\bimport\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\bexport\s+[^"'`]*?\s+from\s+["'`]([^"'`]+)["'`]/g,
    /\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:axios|got|request)\.(?:get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    /\b(?:new\s+)?EventSource\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    /\bsendBeacon\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    /\bXMLHttpRequest\b[\s\S]{0,160}?\.open\s*\(\s*["'`][A-Z]+["'`]\s*,\s*["'`]([^"'`]+)["'`]/gi,
    /\burl\s*:\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:endpoint|apiUrl|baseUrl|graphqlEndpoint|manifestUrl|playlistUrl|imageUrl|thumbnailUrl|videoUrl)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi,
    /\b(?:window\.open|location(?:\.assign|\.replace)?|location\.href)\s*=?\s*["'`]([^"'`]+)["'`]/g,
    /new\s+URL\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /["'`]((?:https?:)?\/\/[^"'`\s]+|\/(?:api|graphql|trpc|_next\/data|wp-json|rest|rpc)(?:\/|[^"'`\s]*))["'`]/gi
  ];
  let found = 0;
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      if (found >= CFG.maxScriptDiscovery) return;
      const raw = m[1];
      const hint = /(?:api|graphql|trpc|wp-json|rest|rpc|\.json(?:$|[?#]))/i.test(raw) ? "data" : typeFor(raw);
      const before = job.links.length;
      addLink(job, raw, hint, base, /api|graphql|trpc/i.test(raw) ? "api" : "script-discovered");
      if (job.links.length !== before) found += 1;
    }
  }
  discoverJsonUrls(job, src, base);
}
function discoverLinkHeader(job, header, base) {
  const raw = String(header || "");
  for (const part of raw.split(/,(?=\s*<)/)) {
    const m = part.match(/<([^>]+)>\s*(.*)$/); if (!m) continue;
    const params = String(m[2] || "");
    const u = resolveResource(m[1], base); if (!u) continue;
    const rel = (params.match(/\brel\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;]+))/i)?.slice(1).find(Boolean) || "").toLowerCase();
    const as = (params.match(/\bas\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;]+))/i)?.slice(1).find(Boolean) || "").toLowerCase();
    const hint = as === "script" ? "js" : as === "style" ? "css" : as === "font" ? "font" : as === "image" ? "image" : /video|audio/.test(as) ? "media" : typeFor(u);
    const reason = rel.includes("preload") || rel.includes("modulepreload") ? "preload" : rel.includes("canonical") ? "canonical" : "http-link";
    addLink(job, u, hint, base, reason);
  }
}
function discoverDataText(job, text, base) {
  const src = String(text || "");
  discoverJsonUrls(job, src, base);
  let seen = 0;
  for (const m of src.matchAll(/(?:https?:\/\/[^\s"'<>\\]+|\/\/(?:[^\s"'<>\\]+)|\/(?:api|graphql|trpc|_next\/data|wp-json|rest|rpc|v\d+)(?:[/?#][^\s"'<>\\]*)?)/gi)) {
    if (seen >= CFG.maxJsonUrlDiscovery) break;
    const raw = m[0].replace(/[),.;]+$/g, "");
    const hint = /\/images?\/|\.(?:png|jpe?g|gif|webp|svg)(?:$|[?#])/i.test(raw) ? "image" : /\.(?:m3u8|mpd|mp4|webm)(?:$|[?#])|video|audio/i.test(raw) ? "media" : /api|graphql|trpc|wp-json|rest|rpc/i.test(raw) ? "data" : typeFor(raw);
    const before = job.links.length;
    addLink(job, raw, hint, base, /api|graphql|trpc|wp-json|rest|rpc/i.test(raw) ? "api" : "data-discovered");
    if (job.links.length !== before) seen += 1;
  }
}

function discoverHtml(job, text, base, depth = 0) {
  const $ = cheerio.load(String(text || ""), { decodeEntities: false });
  const rawBase = $("base[href]").first().attr("href");
  const effectiveBase = resolveNavigation(rawBase, base) || base;
  const addSet = (raw, hint, reason = "discovered") => {
    const parts = String(raw || "").split(/,\s*/);
    let count = 0;
    for (const candidate of parts) {
      const bits = candidate.trim().split(/\s+/); if (!bits[0]) continue;
      const first = bits[0].replace(/^['"]|['"]$/g, "");
      if (first && !/^data:|^blob:/i.test(first) && !/^\d+(?:px|w|x)$/i.test(first)) { addLink(job, first, hint, effectiveBase, reason); if (++count >= CFG.maxSrcsetCandidates) break; }
    }
  };
  $("a[href],area[href]").each((_, el) => addLink(job, $(el).attr("href"), "html", effectiveBase, "navigation"));
  $("link[href]").each((_, el) => {
    const rel = String($(el).attr("rel") || "").toLowerCase();
    const as = String($(el).attr("as") || "").toLowerCase();
    let hint = rel.includes("stylesheet") ? "css" : as === "script" ? "js" : as === "style" ? "css" : as === "image" ? "image" : as === "font" ? "font" : /video|audio/.test(as) ? "media" : rel.includes("manifest") ? "manifest" : (rel.includes("canonical") || rel.includes("alternate") || rel.includes("amphtml")) ? "html" : typeFor($(el).attr("href"));
    const reason = rel.includes("preload") ? "preload" : rel.includes("modulepreload") ? "modulepreload" : rel.includes("canonical") ? "canonical" : "link";
    addLink(job, $(el).attr("href"), hint, effectiveBase, reason);
  });
  $("script[src]").each((_, el) => addLink(job, $(el).attr("src"), "js", effectiveBase, "script"));
  $("script:not([src])").each((_, el) => {
    const type = String($(el).attr("type") || "").toLowerCase();
    if (type.includes("ld+json") || type.includes("json")) discoverJsonUrls(job, $(el).text(), effectiveBase);
    else discoverJs(job, $(el).text(), effectiveBase);
  });
  $("iframe[src],frame[src]").each((_, el) => addLink(job, $(el).attr("src"), "html", effectiveBase, "frame"));
  $("iframe[srcdoc]").each((_, el) => { if (depth < 1) discoverHtml(job, $(el).attr("srcdoc"), effectiveBase, depth + 1); });
  $("img[src]").each((_, el) => addLink(job, $(el).attr("src"), "image", effectiveBase, "image"));
  $("img,source,video,audio,iframe,script,link,input,object,embed").each((_, el) => {
    const tag = String(el.tagName || "").toLowerCase();
    for (const attr of Object.keys(el.attribs || {})) {
      const value = $(el).attr(attr);
      if (!value || /^data:|^blob:/i.test(value)) continue;
      const name = attr.toLowerCase();
      const interesting = /^(?:href|src|action|poster|data|cite|background|longdesc|profile|manifest|formaction|content)$/.test(name) || /^(?:data-|ng-|v-).*(?:src|href|url|image|video|audio|poster|endpoint|api|route|manifest|file|media)/i.test(name);
      if (!interesting) continue;
      const isMeta = tag === "meta" || tag === "link";
      if (name === "content" && !isMeta) continue;
      const hint = /image|icon|poster|thumbnail/i.test(name) ? "image" : /video|audio|media/i.test(name) ? "media" : /css|style/i.test(name) ? "css" : /script|module|js/i.test(name) ? "js" : /api|endpoint|graphql|trpc/i.test(name) ? "data" : tag === "a" || tag === "area" || name === "action" || name === "formaction" ? "html" : typeFor(value);
      const reason = /api|endpoint|graphql|trpc/i.test(name) ? "api" : /lazy|data-src|data-original|data-lazy/i.test(name) ? "lazy" : "data-attribute";
      addLink(job, value, hint, effectiveBase, reason);
    }
  });
  $("picture source[src],picture source[srcset],source[src],source[srcset]").each((_, el) => {
    if ($(el).attr("src")) addLink(job, $(el).attr("src"), typeFor($(el).attr("src"), "image"), effectiveBase, "source");
    if ($(el).attr("srcset")) addSet($(el).attr("srcset"), "image", "srcset");
  });
  $("img[srcset],source[srcset]").each((_, el) => addSet($(el).attr("srcset"), "image", "srcset"));
  $("video[src]").each((_, el) => addLink(job, $(el).attr("src"), "media", effectiveBase, "media"));
  $("audio[src]").each((_, el) => addLink(job, $(el).attr("src"), "media", effectiveBase, "media"));
  $("video[poster]").each((_, el) => addLink(job, $(el).attr("poster"), "image", effectiveBase, "critical-image"));
  $("track[src]").each((_, el) => addLink(job, $(el).attr("src"), "data", effectiveBase, "track"));
  $("object[data]").each((_, el) => addLink(job, $(el).attr("data"), "asset", effectiveBase, "object"));
  $("object param[value]").each((_, el) => addLink(job, $(el).attr("value"), typeFor($(el).attr("value")), effectiveBase, "object-param"));
  $("embed[src]").each((_, el) => addLink(job, $(el).attr("src"), "asset", effectiveBase, "embed"));
  $("svg image,svg use").each((_, el) => {
    const raw = $(el).attr("href") || $(el).attr("xlink:href") || "";
    addLink(job, raw.split("#")[0], "image", effectiveBase, "svg-reference");
  });
  $("meta[property],meta[name],meta[itemprop]").each((_, el) => {
    const key = String($(el).attr("property") || $(el).attr("name") || $(el).attr("itemprop") || "").toLowerCase();
    const content = $(el).attr("content"); if (!content) return;
    if (/image|logo|thumbnail|icon/.test(key)) addLink(job, content, "image", effectiveBase, "metadata");
    else if (/video|audio|player|stream/.test(key)) addLink(job, content, "media", effectiveBase, "metadata");
    else if (/url|canonical|alternate/.test(key)) addLink(job, content, "html", effectiveBase, "metadata");
  });
  $("link[rel~='icon'],link[rel~='apple-touch-icon'],link[rel~='mask-icon']").each((_, el) => addLink(job, $(el).attr("href"), "image", effectiveBase, "icon"));
  $("form[action],form[formaction],button[formaction],input[formaction]").each((_, el) => addLink(job, $(el).attr("action") || $(el).attr("formaction"), "html", effectiveBase, "navigation"));
  $("meta[http-equiv]").each((_, el) => {
    const kind = String($(el).attr("http-equiv") || "").toLowerCase();
    if (kind === "refresh") { const m = String($(el).attr("content") || "").match(/url\s*=\s*(.+)$/i); if (m) addLink(job, m[1].trim().replace(/^['"]|['"]$/g, ""), "html", effectiveBase, "navigation"); }
  });
  $("template,noscript").each((_, el) => { if (depth < 1) { const inner = String($(el).html() || ""); if (inner) discoverHtml(job, inner, effectiveBase, depth + 1); } });
  $("style").each((_, el) => discoverCss(job, $(el).text(), effectiveBase));
  $(["[style]"].join(",")).each((_, el) => discoverCss(job, $(el).attr("style") || "", effectiveBase));
  
  
  
  $("[data-srcset],[data-lazy-srcset],[data-image-srcset]").each((_, el) => {
    for (const name of ["data-srcset", "data-lazy-srcset", "data-image-srcset"]) {
      const value = $(el).attr(name); if (value) addSet(value, "image", "lazy-srcset");
    }
  });
  $("[data-src],[data-lazy-src],[data-original],[data-original-src],[data-image],[data-image-src],[data-background],[data-background-image],[data-bg]").each((_, el) => {
    for (const name of ["data-src","data-lazy-src","data-original","data-original-src","data-image","data-image-src","data-background","data-background-image","data-bg"]) {
      const value = $(el).attr(name); if (value) {
        const hint = /background|image/i.test(name) ? "image" : /video|media/i.test(name) ? "media" : typeFor(value);
        addLink(job, value, hint, effectiveBase, "lazy-attribute");
      }
    }
  });
  $("link[as='fetch'],link[as='script'],link[as='style'],link[as='font'],link[as='image'],link[as='video'],link[as='audio']").each((_, el) => {
    const href = $(el).attr("href"); if (!href) return;
    const as = String($(el).attr("as") || "").toLowerCase();
    addLink(job, href, as === "script" ? "js" : as === "style" ? "css" : as === "font" ? "font" : as === "image" ? "image" : /video|audio/.test(as) ? "media" : "data", effectiveBase, "preload-runtime");
  });
  $("script[type='importmap'],script[type='application/importmap']").each((_, el) => discoverJsonUrls(job, $(el).text(), effectiveBase));

  
  
  
  const rawPage = String(text || "").slice(0, CFG.maxBroadScanChars);
  let broadFound = 0;
  const urlPattern = /(?:https?:\/\/[^\s<>"'`\\]+|\/\/(?:[^\s<>"'`\\]+)|\/(?:api|graphql|trpc|_next(?:\/data)?|wp-json|rest|rpc|search|v\d+)(?:[/?#][^\s<>"'`\\]*)?)/gi;
  for (const m of rawPage.matchAll(urlPattern)) {
    if (broadFound >= CFG.maxDiscoveryPerPage) break;
    const raw = String(m[0] || "").replace(/[),.;]+$/g, "");
    const hint = /\.(?:png|jpe?g|gif|webp|svg|avif|ico)(?:$|[?#])/i.test(raw) || /\/(?:images?|img|icons?)\//i.test(raw) ? "image"
      : /(?:\.m3u8|\.mpd|\.mp4|\.webm|\.mov|\.m4v)(?:$|[?#])/i.test(raw) ? "media"
      : /(?:api|graphql|trpc|wp-json|rest|rpc|_next\/data)/i.test(raw) ? "data"
      : typeFor(raw);
    const before = job.links.length;
    addLink(job, raw, hint, effectiveBase, "broad-scan");
    if (job.links.length !== before) broadFound += 1;
  }

  
  
  let attrCount = 0;
  $("*").each((_, el) => {
    if (attrCount >= CFG.maxDiscoveryPerPage) return false;
    for (const [name, value] of Object.entries(el.attribs || {})) {
      if (attrCount >= CFG.maxDiscoveryPerPage) break;
      const v = String(value || "").trim();
      if (!v || /^data:|^blob:/i.test(v) || v.length > 2000) continue;
      if (/^(?:https?:)?\/\//i.test(v) || /^\/?(?:\.\.?\/)/.test(v) || /^\/(?:api|graphql|trpc|_next|wp-json|rest|rpc)(?:\/|\?|$)/i.test(v)) {
        const hint = /image|img|icon|thumbnail/i.test(name) ? "image" : /video|audio|media/i.test(name) ? "media" : /api|graphql|trpc|endpoint/i.test(name) ? "data" : typeFor(v);
        const before = job.links.length; addLink(job, v, hint, effectiveBase, "attribute-scan"); if (job.links.length !== before) attrCount += 1;
      }
    }
  });
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

function createJob(root, options = {}) {
  const id = crypto.randomUUID();
  const pageAccelerator = !!options.pageAccelerator;
  const host = (() => { try { return new URL(root).hostname.toLowerCase(); } catch { return ""; } })();
  
  
  
  
  const youtubeAccelerator = pageAccelerator && /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host);
  const pageWarmMs = youtubeAccelerator ? Math.max(CFG.crawlerPageWarmMs, 9000) : CFG.crawlerPageWarmMs;
  const pageHardMs = youtubeAccelerator ? Math.max(CFG.crawlerPageHardMs, 16000) : CFG.crawlerPageHardMs;
  return {
    id, root, url: root, createdAt: now(), pageAccelerator, pageAcceleratorWarmMs: pageWarmMs, pageAcceleratorHardMs: pageHardMs, warmDeadlineAt: pageAccelerator ? Date.now() + pageWarmMs : 0, pageAcceleratorHardDeadlineAt: pageAccelerator ? Date.now() + pageHardMs : 0, fastPhaseComplete: false, finishedAt: null, done: false, stopRequested: false, status: "queued", statusText: "Queued",
    pageFrontier: new PriorityFrontier(CFG.maxPendingQueue), resourceFrontier: new PriorityFrontier(CFG.maxPendingQueue), criticalResourceFrontier: new PriorityFrontier(Math.min(CFG.maxPendingQueue, CFG.criticalResourceBudget * 4)), visited: new Set(), discovered: new Set(), retryCounts: new Map(),
    resources: [], links: [], logs: [], logSeq: 0, sourceDir: path.join(ROOT, id), sourceFiles: 0, textBytesStored: 0,
    activeWorkers: 0, activeHtmlWorkers: 0, activeAssetWorkers: 0, processed: 0, pagesDiscovered: 0, resourcesScheduled: 0, crossOriginResources: 0, sitemapLoading: false, browserDiscoveredCount: 0, browserDiscoveredHosts: new Set(),
    crawlOrigins: new Set([new URL(root).origin]),
    hostPolicy: new Map(),
    robots: null, robotsReady: false, sitemaps: new Set(), challengeHosts: new Set(), hostActive: new Map(), hostCooldowns: new Map(), hostLastRequested: new Map(), hostFailures: new Map(), hostDelayMs: 0, stopReason: null, backgroundPaused: false,
    counts: { htmlPages: 0, css: 0, js: 0, data: 0, assets: 0, links: 0, bytesScanned: 0, bytesStored: 0, bytesDiscarded: 0, requestCount: 0, retries: 0, challenges: 0, errors: 0 },
    controller: new AbortController(),
    dnsCache: new Map(),
    robotPool: null,
    robotEvents: []
  };
}
function publicJob(job) {
  const queued = job.criticalResourceFrontier.size + job.pageFrontier.size + job.resourceFrontier.size;
  return {
    id: job.id, url: job.url, createdAt: job.createdAt, finishedAt: job.finishedAt, done: job.done, pageAccelerator: !!job.pageAccelerator,
    status: job.status, statusText: job.statusText, stopRequested: job.stopRequested,
    scheduler: { started: !!job.started, queuePosition: job.queuePosition || 0, seed: !!job.seed, activeCrawlers: activeCrawlCount(), maxCrawlers: effectiveMaxActiveJobs(), queued: crawlQueue.length },
    maxUrls: CFG.maxResources, maxScanBytes: CFG.maxScanBytes, elapsedMs: Date.now() - Date.parse(job.createdAt),
    counts: { ...job.counts, processed: job.processed, queued, active: job.activeWorkers },
    workers: { html: { active: job.activeHtmlWorkers, max: CFG.maxActiveFetches, queued: job.pageFrontier.size }, asset: { active: job.activeAssetWorkers, max: CFG.maxActiveFetches, queued: job.resourceFrontier.size }, logicalRobots: job.robotFleet || CFG.logicalRobots, networkSlots: effectiveCrawlerConcurrency(), configuredNetworkSlots: CFG.maxActiveFetches, availableNetworkSlots: fetchSemaphore.available, queuedNetworkWaiters: fetchSemaphore.queued },
    limits: { globalConcurrency: CFG.maxActiveFetches, crawlerRobots: CFG.logicalRobots, logicalRobots: CFG.logicalRobots, maxActiveFetches: CFG.maxActiveFetches, perHostConcurrency: CFG.perHostConcurrency, maxPages: CFG.maxPages, maxResources: CFG.maxResources, maxLinks: CFG.maxLinks, maxScanBytes: CFG.maxScanBytes, maxCrossOriginResources: CFG.maxCrossOriginResources },
    searchIndex: searchIndexStats(),
    robotsLoaded: job.robotsReady, sitemapsFound: job.sitemaps.size, sourceFiles: job.sourceFiles, textBytesStored: job.textBytesStored,
    resourceCount: job.resources.length, linkCount: job.links.length, browserDiscovered: job.browserDiscoveredCount || 0, browserDiscoveredHosts: job.browserDiscoveredHosts?.size || 0, criticalQueue: job.criticalResourceFrontier.size, logs: job.logs.slice(-120),
    robotMesh: job.robotPool ? { summary: job.robotPool.report(1).summary } : null,
    queue: { critical: job.criticalResourceFrontier.snapshot().slice(0, 50), pages: job.pageFrontier.snapshot().slice(0, 50), resources: job.resourceFrontier.snapshot().slice(0, 50) }
  };
}
function crawlLimitForContentType(contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("text/html") || type.includes("application/xhtml") || type.includes("text/css") || /javascript|ecmascript|json|xml/.test(type)) return CFG.maxTextBytesPerResource;
  if (type.startsWith("image/") || type.includes("svg")) return CFG.maxProxyImageBytes;
  if (type.startsWith("video/") || type.startsWith("audio/") || type.includes("application/pdf")) return CFG.maxProxyMediaBytes;
  return CFG.maxProxyOtherBytes;
}

function hostConcurrencyLimit(job, host) {
  const ceiling = CFG.perHostConcurrency;
  if (!CFG.adaptiveHostConcurrency) return ceiling;
  const floor = job?.pageAccelerator ? Math.min(ceiling, CFG.crawlerPageMinPerHostConcurrency) : CFG.minPerHostConcurrency;
  const state = job.hostPolicy.get(host) || { limit: ceiling, successes: 0, errors: 0 };
  state.limit = Math.max(floor, Math.min(ceiling, Number(state.limit) || ceiling));
  job.hostPolicy.set(host, state);
  return state.limit;
}
function noteHostSuccess(job, host) {
  if (!CFG.adaptiveHostConcurrency) return;
  const floor = job?.pageAccelerator ? Math.min(CFG.perHostConcurrency, CFG.crawlerPageMinPerHostConcurrency) : CFG.minPerHostConcurrency;
  const state = job.hostPolicy.get(host) || { limit: CFG.perHostConcurrency, successes: 0, errors: 0 };
  state.successes += 1;
  state.errors = Math.max(0, state.errors - 1);
  if (state.successes % CFG.hostSuccessRamp === 0) state.limit = Math.min(CFG.perHostConcurrency, state.limit + 1);
  state.limit = Math.max(floor, state.limit);
  job.hostPolicy.set(host, state);
}
function noteHostError(job, host) {
  if (!CFG.adaptiveHostConcurrency) return;
  const state = job.hostPolicy.get(host) || { limit: CFG.perHostConcurrency, successes: 0, errors: 0 };
  state.errors += 1;
  state.successes = 0;
  const floor = job?.pageAccelerator ? Math.min(CFG.perHostConcurrency, CFG.crawlerPageMinPerHostConcurrency) : CFG.minPerHostConcurrency;
  if (state.errors % CFG.hostErrorPenalty === 0) state.limit = Math.max(floor, state.limit - 1);
  job.hostPolicy.set(host, state);
}

async function fetchResourceProbe(item, opts) {
  const binary = ["image","media","font","asset"].includes(item.type) && !item.critical;
  if (!binary) return fetchCached(item.url, opts);
  
  
  const headOpts = { ...opts, method: "HEAD", body: undefined, retries: Math.min(1, opts.retries ?? 0) };
  const head = await fetchCached(item.url, headOpts);
  if (head.status >= 200 && head.status < 400 && (head.contentType || head.contentLength)) return head;
  const rangeOpts = { ...opts, method: "GET", range: "bytes=0-65535", limit: 64 * 1024, limitForContentType: () => 64 * 1024, retries: Math.min(1, opts.retries ?? 0) };
  return fetchCached(item.url, rangeOpts);
}


function discoverInto(job, kind, text, base, contentType = "") {
  if (kind === "html") discoverHtml(job, text, base);
  else if (kind === "css") discoverCss(job, text, base);
  else if (kind === "js") discoverJs(job, text, base);
  else if (kind === "data") { discoverDataText(job, text, base); if (/json|xml|graphql|javascript|api|ld\+json/i.test(contentType)) discoverJs(job, text, base); }
}
function collectDiscovery(text, kind, base, contentType) {
  const collector = { collector: true, links: [], seen: new Set(), root: base };
  discoverInto(collector, kind, text, base, contentType);
  return { links: collector.links, meta: kind === "html" ? extractPageMeta(text, base) : null };
}
async function discoverContent(job, kind, text, base, contentType = "") {
  if (workerPool?.enabled && text.length >= CFG.parseWorkerMinBytes) {
    try {
      const out = await workerPool.run("discover", [kind, base, contentType], text);
      if (kind === "html") indexDocument(base, text, out.meta);
      for (const [raw, hint, src, reason] of out.links) { if (job.stopRequested) break; addLink(job, raw, hint, src, reason); }
      return;
    } catch (e) { if (workerPool) workerPool.stats.inlineFallbacks += 1; }
  }
  if (kind === "html") indexDocument(base, text);
  discoverInto(job, kind, text, base, contentType);
}
async function rewriteOffThread(op, text, args, inline) {
  if (workerPool?.enabled && text.length >= CFG.parseWorkerMinBytes) {
    try { return await workerPool.run(op, args, text); } catch (e) { if (workerPool) workerPool.stats.inlineFallbacks += 1; }
  }
  return inline(text, ...args);
}
async function processItem(job, item) {
  if (job.stopRequested) return;
  const key = linkKey(item.type, item.url); if (job.visited.has(key)) return;
  job.visited.add(key);
  if (item.type === "html" && (!crawlOriginAllowed(job, item.url) || !robotsAllowed(item.url, job.robots))) return;
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
    const r = await fetchResourceProbe(item, { accept, limit: CFG.maxTextBytesPerResource, limitForContentType: crawlLimitForContentType, timeout: job.pageAccelerator ? Math.min(CFG.requestTimeoutMs, LEAN_MODE ? 3500 : 8000) : CFG.requestTimeoutMs, retries: job.pageAccelerator ? Math.min(1, CFG.maxRetries) : CFG.maxRetries, referrer: item.source || "", dnsCache: job.dnsCache, signal: job.controller.signal, bodyTimeoutMs: job.pageAccelerator ? Math.min(CFG.bodyTimeoutMs, LEAN_MODE ? 4000 : 8000) : CFG.bodyTimeoutMs });
    job.counts.bytesScanned += r.bytes;
    if (r.retries) job.counts.retries += r.retries;
    if (r.truncated || r.tooLarge) { job.counts.bytesDiscarded += r.bytes; jobLog(job, "warn", `Response skipped after size limit: ${item.url}`); return; }
    if (job.counts.bytesScanned > CFG.maxScanBytes) { job.stopRequested = true; job.stopReason = "scan-byte-limit"; return; }
    const lower = r.contentType.toLowerCase();
    const finalUrl = r.finalUrl || item.url;
    if (finalUrl && sameRedirectHost(finalUrl, item.url)) { try { job.crawlOrigins.add(new URL(finalUrl).origin); } catch {} }
    if (r.linkHeader) discoverLinkHeader(job, r.linkHeader, finalUrl);
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
        const resourceLike = item.type !== "html";
        jobLog(job, resourceLike ? "debug" : "warn", resourceLike ? `HTTP ${r.status}; resource unavailable: ${item.url}` : `HTTP ${r.status}; page not indexed: ${item.url}`, { type: item.type, source: item.source || null });
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
    job.hostFailures.set(host, 0); job.hostCooldowns.delete(host); noteHostSuccess(job, host);
    if (type === "html") {
      job.counts.htmlPages += 1; await discoverContent(job, "html", text, resource.url, r.contentType);
      job.counts.bytesStored += Math.min(r.bytes, CFG.maxTextBytesPerResource);
    } else if (type === "css") {
      job.counts.css += 1; await discoverContent(job, "css", text, resource.url, r.contentType);
      job.counts.bytesStored += Math.min(r.bytes, CFG.maxTextBytesPerResource);
    } else if (type === "js") {
      job.counts.js += 1; await discoverContent(job, "js", text, resource.url, r.contentType);
      job.counts.bytesStored += Math.min(r.bytes, CFG.maxTextBytesPerResource);
    } else if (type === "data") {
      job.counts.data += 1;
      job.counts.bytesStored += Math.min(r.bytes, CFG.maxTextBytesPerResource);
      await discoverContent(job, "data", text, resource.url, r.contentType);
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
    noteHostError(job, host);
    const status = Number(e?.status || String(e?.message || "").match(/HTTP (\d+)/)?.[1] || 0);
    const backoff = Math.min(CFG.maxHostBackoffMs, CFG.hostBackoffMs * 2 ** Math.min(5, failures - 1));
    if (status === 429 || status === 503 || status === 502 || status === 504 || status === 500 || /timed out|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(String(e?.message || ""))) {
      job.hostCooldowns.set(host, Date.now() + backoff);
      const retryKey = key;
      const retryCount = (job.retryCounts.get(retryKey) || 0) + 1;
      if (retryCount <= CFG.maxRetries && !job.stopRequested) {
        job.retryCounts.set(retryKey, retryCount);
        job.visited.delete(retryKey);
        const targetFrontier = item.critical ? job.criticalResourceFrontier : item.type === "html" ? job.pageFrontier : job.resourceFrontier;
        targetFrontier.requeue({ ...item }, Number(item.priority || crawlPriority(item.url, item.type, item.reason || "retry")) - retryCount * 4, retryKey, Date.now() + backoff);
        jobLog(job, "debug", `Transient failure; task requeued (${retryCount}/${CFG.maxRetries}): ${item.url}`, { status, retryAtMs: backoff });
      }
    }
    const noisyError = item.type === "html" || status >= 500 || status === 429;
    jobLog(job, status === 429 ? "warn" : (noisyError ? "error" : "debug"), `Fetch failed ${item.url} — ${e.name || "Error"}: ${e.message}`, { retryClass: statusRetryClass(status), type: item.type, source: item.source || null });
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
  totalPending() { return this.pendingLocal() + this.job.criticalResourceFrontier.size + this.job.pageFrontier.size + this.job.resourceFrontier.size + (this.job.sitemapLoading ? 1 : 0); }
  active() { return this.activePromises.size; }
  chooseFrontierTask() {
    if (this.job.criticalResourceFrontier.size) {
      const item = this.job.criticalResourceFrontier.takeNext(this.job.hostActive, host => hostConcurrencyLimit(this.job, host), this.job.hostCooldowns);
      if (item) return item;
    }
    if (this.job.pageFrontier.size) {
      const item = this.job.pageFrontier.takeNext(this.job.hostActive, host => hostConcurrencyLimit(this.job, host), this.job.hostCooldowns);
      if (item) return item;
    }
    return this.job.resourceFrontier.takeNext(this.job.hostActive, host => hostConcurrencyLimit(this.job, host), this.job.hostCooldowns) || null;
  }
  chooseReceiver() {
    
    
    const maxLoad = this.loadLimit();
    for (let load = 0; load <= maxLoad && load < this.taskCapacity; load++) {
      const bucket = this.loadBuckets[load];
      if (!bucket?.size) continue;
      
      
      return bucket.values().next().value || null;
    }
    return null;
  }
  nextReceiver() {
    
    
    for (let load = 0; load < this.taskCapacity; load++) {
      const bucket = this.loadBuckets[load];
      if (!bucket?.size) continue;
      for (const robot of bucket) {
        if (robot.activeTasks < this.activeCapacity && robot.queue.length < this.taskCapacity) return robot;
      }
    }
    return null;
  }
  assignGlobalTasks() {
    let assigned = 0;
    const runtimeLimit = effectiveCrawlerConcurrency(this.job);
    const target = Math.min(CFG.robotDispatchBatch, Math.max(runtimeLimit * 4, 32));
    while (assigned < target) {
      const robot = this.nextReceiver();
      if (!robot) break;
      let bundled = 0;
      const bundleTarget = Math.min(CFG.robotBundleSize, this.taskCapacity - robot.queue.length);
      while (bundled < bundleTarget && assigned < target) {
        const item = this.chooseFrontierTask();
        if (!item) break;
        robot.queue.push(item);
        this.totalQueued += 1;
        robot.lastActionAt = now();
        bundled += 1;
        assigned += 1;
      }
      this.updateLoadBucket(robot);
      this.markShareable(robot);
      this.updateStatus(robot);
      if (!bundled) break;
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
    const candidates = [];
    for (const r of this.helpCandidates) {
      if (r.id === requester.id || r.queue.length < CFG.robotHelpThreshold) continue;
      candidates.push(r);
      if (candidates.length >= CFG.robotHelpScanLimit) break;
    }
    candidates.sort((a, b) => b.queue.length - a.queue.length || b.activeTasks - a.activeTasks || a.errors - b.errors);
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
          this.totalQueued = Math.max(0, this.totalQueued - 1);
          item._helped = true;
          item._helpFrom = target.id;
          requester.queue.push(item);
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
    if ((this.job.hostActive.get(taskHost) || 0) >= hostConcurrencyLimit(this.job, taskHost)) return false;
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
        
        
        if (robot.queue.length <= 1 && robot.activeTasks < this.activeCapacity && !this.job.stopRequested) void this.requestHelp(robot);
      }
    })();
    this.activePromises.add(run);
    run.finally(() => this.activePromises.delete(run)).catch(() => {});
    return true;
  }
  startAvailable() {
    let started = 0;
    
    for (let load = 0; load < this.loadBuckets.length && this.activePromises.size < CFG.maxActiveFetches; load++) {
      const robots = [...(this.loadBuckets[load] || [])];
      for (const robot of robots) {
        while (robot.activeTasks < this.activeCapacity && robot.queue.length && this.activePromises.size < effectiveCrawlerConcurrency(this.job)) {
          const item = robot.queue.shift();
          this.totalQueued = Math.max(0, this.totalQueued - 1);
          this.updateLoadBucket(robot); this.markShareable(robot);
          if (this.startTask(robot, item)) started += 1;
          else { robot.queue.unshift(item); this.totalQueued += 1; this.updateLoadBucket(robot); this.markShareable(robot); break; }
        }
        this.updateStatus(robot);
        if (this.activePromises.size >= effectiveCrawlerConcurrency(this.job)) break;
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
      networkActive: this.active(), networkLimit: CFG.maxActiveFetches, perHostCeiling: CFG.perHostConcurrency, adaptiveHostConcurrency: CFG.adaptiveHostConcurrency,
      helpRequests: this.robots.reduce((n,r) => n + r.helpRequests, 0), helpAccepted: this.robots.reduce((n,r) => n + r.helpAccepted, 0),
      helpDeclined: this.robots.reduce((n,r) => n + r.helpDeclined, 0), helpGiven: this.robots.reduce((n,r) => n + r.helpGiven, 0)
    };
    return { summary, robots: rows, events: this.events.slice(-80) };
  }
  async run() {
    this.running = true;
    while (!this.job.stopRequested) {
      if (this.job.pageAccelerator && this.job.pageAcceleratorHardDeadlineAt && Date.now() >= this.job.pageAcceleratorHardDeadlineAt) {
        this.job.fastPhaseComplete = true;
        this.job.stopRequested = true;
        this.job.stopReason = "page-accelerator-budget";
        this.job.warmDeadlineAt = 0;
        try { this.job.controller.abort(); } catch {}
        this.job.statusText = "Page accelerator time budget reached; stopping background work.";
        this.event("page-accelerator-hard-stop", { hardMs: this.job.pageAcceleratorHardMs || CFG.crawlerPageHardMs });
        break;
      }
      if (this.job.pageAccelerator && this.job.warmDeadlineAt && Date.now() >= this.job.warmDeadlineAt) {
        this.job.fastPhaseComplete = true;
        this.job.warmDeadlineAt = 0;
        if (!this.job.pageAcceleratorHardDeadlineAt || Date.now() >= this.job.pageAcceleratorHardDeadlineAt) {
          this.job.stopRequested = true;
          this.job.stopReason = "page-accelerator-budget";
          try { this.job.controller.abort(); } catch {}
          this.job.statusText = "Page accelerator time budget reached; stopping background work.";
          this.event("page-accelerator-stopped", { warmMs: this.job.pageAcceleratorWarmMs || CFG.crawlerPageWarmMs, hardMs: this.job.pageAcceleratorHardMs || CFG.crawlerPageHardMs });
          break;
        }
        
        
        
        this.job.statusText = "Critical page resources warmed; finishing required assets in the background";
      }
      if (!this.job.robotsReady) { await sleep(5); continue; }
      if (this.job.counts.bytesScanned >= CFG.maxScanBytes) { this.job.stopRequested = true; this.job.stopReason = "scan-byte-limit"; break; }
      this.assignGlobalTasks();
      this.rebalanceLocals();
      this.startAvailable();
      if (runtimeGuard.critical || this.job.backgroundPaused) {
        if (!this.activePromises.size) { await sleep(250); continue; }
        await Promise.race(this.activePromises);
        continue;
      }
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
    if (!job.stopRequested && !job.pageAccelerator) {
      job.sitemapLoading = true;
      void loadSitemaps(job).catch(e => jobLog(job, "debug", `Sitemap pass failed: ${e.message}`)).finally(() => { job.sitemapLoading = false; });
    }
    job.status = "crawling";
    job.statusText = job.pageAccelerator
      ? `Fast page warm-up with ${effectiveCrawlerConcurrency(job)} network workers…`
      : `Exhaustive same-origin crawl with ${CFG.logicalRobots.toLocaleString()} cooperative robots…`;
    await job.robotPool.run();
    job.done = true; job.finishedAt = now();
    if (job.status === "challenge") job.statusText = "Security verification required; crawl stopped.";
    else if (job.stopRequested && job.stopReason === "scan-byte-limit") { job.status = "done"; job.statusText = `Scan budget reached (${bytesLabel(CFG.maxScanBytes)}).`; }
    else if (job.stopRequested && job.stopReason === "resource-limit") { job.status = "done"; job.statusText = `Resource safety limit reached (${CFG.maxResources.toLocaleString()}).`; }
    else if (job.pageAccelerator && job.stopReason === "page-accelerator-budget") { job.status = "done"; job.statusText = `Page accelerator budget reached — ${job.processed.toLocaleString()} resources processed.`; }
    else if (job.pageAccelerator && job.fastPhaseComplete) { job.status = "done"; job.statusText = `Required page assets finished — ${job.processed.toLocaleString()} resources scanned.`; }
    else if (job.stopRequested && job.stopReason === "abandoned") { job.status = "stopped"; job.statusText = "Stopped automatically — nobody has checked this crawl for a while (CRAWL_ABANDON_MS)."; }
    else if (job.stopRequested && job.stopReason === "shutdown") { job.status = "stopped"; job.statusText = "Stopped — server is shutting down."; }
    else if (job.stopRequested) { job.status = "stopped"; job.statusText = "Stopped by user."; }
    else { job.status = "done"; job.statusText = `Complete — ${job.processed.toLocaleString()} resources scanned.`; }
    jobLog(job, job.status === "done" ? "info" : "warn", job.statusText, { robots: job.robotPool.report(12).summary });
    void mongoStore.saveCrawlSummary(job);
  } catch (e) {
    job.done = true; job.finishedAt = now(); job.status = "error"; job.statusText = e.message || "Crawler error"; jobLog(job, "error", e.stack || e.message);
    void mongoStore.saveCrawlSummary(job);
  }
}


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
function effectiveMaxActiveJobs() {
  let n = CFG.maxActiveJobs;
  
  if (runtimeGuard.pressure) n = Math.min(n, Math.max(1, Math.floor(n / 2)));
  if (runtimeGuard.critical) n = 1;
  return n;
}



const crawlQueue = [];
function activeCrawlCount() { let n = 0; for (const j of jobs.values()) if (j.started && !j.done) n += 1; return n; }
function refreshQueuePositions() { crawlQueue.forEach((j, i) => { j.queuePosition = i + 1; j.statusText = `Queued — ${i + 1} ahead in line (${activeCrawlCount()}/${effectiveMaxActiveJobs()} crawlers busy).`; }); }
function startCrawl(job) {
  job.started = true; job.startedAt = now(); job.queuePosition = 0;
  runCrawl(job)
    .catch(e => { job.done = true; job.finishedAt = now(); job.status = "error"; job.statusText = e.message; jobLog(job, "error", e.stack || e.message); })
    .finally(() => { if (!job.done) { job.done = true; job.finishedAt = now(); } pumpCrawlQueue(); });
}
function pumpCrawlQueue() {
  while (crawlQueue.length && activeCrawlCount() < effectiveMaxActiveJobs()) {
    const job = crawlQueue.shift();
    if (job.done || job.stopRequested) continue;
    jobLog(job, "info", "Crawler slot free — starting.");
    startCrawl(job);
  }
  refreshQueuePositions();
}
function scheduleCrawl(job, { seed = false } = {}) {
  job.seed = seed; job.lastPolledAt = Date.now();
  if (activeCrawlCount() < effectiveMaxActiveJobs() && !crawlQueue.some(j => !j.seed || seed)) { startCrawl(job); return "running"; }
  if (crawlQueue.length >= CFG.crawlQueueMax) throw Object.assign(new Error(`All ${effectiveMaxActiveJobs()} crawlers are busy and the queue is full (${CFG.crawlQueueMax}); try again shortly.`), { code: "CRAWLER_CAPACITY_BUSY" });
  job.status = "queued"; job.queuedAt = now();
  if (seed) crawlQueue.push(job);
  else { const firstSeed = crawlQueue.findIndex(j => j.seed); if (firstSeed < 0) crawlQueue.push(job); else crawlQueue.splice(firstSeed, 0, job); }
  refreshQueuePositions();
  return "queued";
}
function dequeueCrawl(job) {
  const i = crawlQueue.indexOf(job);
  if (i >= 0) crawlQueue.splice(i, 1);
  refreshQueuePositions();
  return i >= 0;
}
function sweepAbandonedCrawls() {
  if (!CFG.crawlAbandonMs) return;
  const cutoff = Date.now() - CFG.crawlAbandonMs;
  for (const job of jobs.values()) {
    if (job.done || job.seed || job.stopRequested || (job.lastPolledAt || 0) > cutoff) continue;
    job.stopRequested = true; job.stopReason = "abandoned";
    try { job.controller.abort(); } catch {}
    if (!job.started) { dequeueCrawl(job); job.done = true; job.finishedAt = now(); job.status = "stopped"; job.statusText = "Removed from queue — nobody was waiting for it."; }
    jobLog(job, "warn", `No client has polled this crawl for ${Math.round(CFG.crawlAbandonMs / 60000)} min; stopping it to free Render resources.`);
  }
}
async function pumpIndexSeeds() {
  if (!CFG.indexSeedCrawl || !CFG.indexSeeds.length || sessionManager.sleeping) return;
  const maxActive = effectiveMaxActiveJobs();
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
      const job = createJob(root, { pageAccelerator: CFG.crawlerPageAccelerator }); jobs.set(job.id, job); activeByRoot.set(root, job.id); indexSeedState.set(raw, Date.now());
      jobLog(job, "info", "Index seed crawl queued.", { source: "INDEX", seed: raw });
      scheduleCrawl(job, { seed: true });
    } catch (e) { indexSeedState.set(raw, Date.now()); serverLog("warn", "SEARCH", `Index seed rejected: ${raw} — ${e.message}`); }
  }
}



function browserCapabilitySignals(html = "", headers = {}) {
  const text = String(html || "");
  const lower = text.toLowerCase();
  const scriptCount = (text.match(/<script\b/gi) || []).length;
  const moduleCount = (text.match(/type\s*=\s*["']module["']/gi) || []).length;
  const fetchSignals = (text.match(/fetch\s*\(|xmlhttprequest|websocket|eventsource|indexeddb|localstorage|sessionstorage|serviceworker|history\.pushstate|history\.replacestate/gi) || []).length;
  const shellSignals = /<div[^>]+(?:id|class)=["'][^"']*(?:root|app|__next|__nuxt|svelte)[^"']*["'][^>]*>\s*<\/div>/i.test(text) || ((scriptCount + moduleCount) > 0 && text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').trim().length < 500);
  const spa = /__next|__nuxt|webpack|vite|react|angular|vue|svelte|ng-version|roblox|rbxcdn|rbx\.com/i.test(text);
  
  
  const gameOrRemoteBrowser = /roblox\.com|rbxcdn\.com|browser\.lol|now\.gg|play\.google\.com\/store|geforce\.com\/games/i.test(lower);
  const scriptHeavy = scriptCount >= CFG.proxyJsHeavyThreshold && (fetchSignals >= 1 || moduleCount > 0 || shellSignals);
  const spaHeavy = spa && (fetchSignals >= 2 || shellSignals || moduleCount > 0);
  const heavy = shellSignals || fetchSignals >= 4 || scriptHeavy || spaHeavy || gameOrRemoteBrowser;
  return { scriptCount, moduleCount, fetchSignals, spa, shellSignals, heavy, gameOrRemoteBrowser, contentType: headers['content-type'] || headers['Content-Type'] || '' };
}




const FORCE_BROWSER_HOSTS = new Set([
  "roblox.com", "www.roblox.com", "web.roblox.com", "create.roblox.com",
  "browser.lol", "www.browser.lol",
  "now.gg", "www.now.gg",
  "geforce.com", "play.geforce.com"
]);
function hostNeedsRealBrowser(url) {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (FORCE_BROWSER_HOSTS.has(h) || FORCE_BROWSER_HOSTS.has("www." + h)) return true;
    if (/(^|\.)roblox\.com$/.test(h) || /(^|\.)rbxcdn\.com$/.test(h)) return true;
    if (/(^|\.)browser\.lol$/.test(h)) return true;
  } catch {}
  return false;
}





async function fetchOfficialJson(url, { timeoutMs = 6000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await undiciFetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    return res;
  } finally { clearTimeout(t); }
}

app.post('/api/browser/capability', async (req, res) => {
  const raw = normalizeUrl(String(req.body?.url || ''));
  if (!raw) return respondError(res, 400, 'Invalid URL.', 'INVALID_URL');
  const proxySessionId = String(req.body?.proxySessionId || req.body?.sessionId || "");

  
  
  
  
  if (youtubeCompat.isYoutubeUrl(raw)) {
    if (CFG.youtubeFastProxyOnly) {
      return res.json({ ok: true, url: raw, mode: 'FAST_PROXY', lean: CFG.leanMode, youtubeFastProxyOnly: true });
    }
    const parsed = youtubeCompat.parseYoutubeUrl(raw);
    if (parsed) {
      return res.json({
        ok: true,
        url: raw,
        mode: 'OFFICIAL_EMBED',
        lean: CFG.leanMode,
        youtube: { videoId: parsed.videoId, kind: parsed.kind, embedUrl: youtubeCompat.buildEmbedUrl(parsed, req.get('origin') || undefined) },
      });
    }
    
    
    
  }

  try {
    await assertPublicUrl(raw);
    const result = await fetchCached(raw, { accept: 'text/html,application/xhtml+xml', limit: Math.min(CFG.maxProxyTextBytes, 1024 * 1024), timeout: CFG.requestTimeoutMs, retries: 0, referrer: '' });
    const signals = browserCapabilitySignals(result.body?.toString('utf8') || '', { 'content-type': result.contentType });
    const challenge = detectChallenge(result.body?.toString('utf8') || '', result.contentType, result.status, { server: result.serverHeader, 'cf-mitigated': result.cfMitigated, finalUrl: result.finalUrl });
    
    
    
    
    const lean = CFG.leanMode && !CFG.leanAutoBrowser;
    const forceBrowser = hostNeedsRealBrowser(result.finalUrl || raw) || signals.gameOrRemoteBrowser;
    
    
    
    
    signals.fullPage = fullPage.hasFullPageState(result.body?.toString('utf8') || '');
    let mode = 'FAST_PROXY';
    if (challenge || forceBrowser) mode = 'BROWSER_ENGINE';
    else if (signals.heavy) mode = (lean || signals.fullPage) ? 'ACCELERATED_PROXY' : 'BROWSER_ENGINE';
    
    const failoverInfo = failoverController ? failoverController.breakerStatus(proxySessionId) : null;
    if (mode === 'BROWSER_ENGINE' && failoverInfo && failoverInfo.state === 'open') {
      mode = 'FAST_PROXY';
    }
    const hasSnapshot = snapshotStore ? await snapshotStore.has(proxySessionId, result.finalUrl || raw) : false;
    res.json({ ok: true, url: result.finalUrl || raw, mode, lean: CFG.leanMode, challenge: challenge ? challenge.type : null, forceBrowser: !!forceBrowser, signals, fullPage: signals.fullPage, status: result.status, contentType: result.contentType, failover: failoverInfo, snapshot: hasSnapshot });
  } catch (e) {
    
    const forceBrowser = hostNeedsRealBrowser(raw);
    res.json({ ok: true, url: raw, mode: forceBrowser ? 'BROWSER_ENGINE' : (CFG.leanMode ? 'ACCELERATED_PROXY' : 'BROWSER_ENGINE'), lean: CFG.leanMode, forceBrowser, reason: 'capability_probe_failed', error: e.message });
  }
});





app.post('/api/youtube/resolve', async (req, res) => {
  const raw = normalizeUrl(String(req.body?.url || ''));
  if (!raw || !youtubeCompat.isYoutubeUrl(raw)) return respondError(res, 400, 'Not a YouTube URL.', 'INVALID_URL');
  const parsed = youtubeCompat.parseYoutubeUrl(raw);
  if (!parsed) return respondError(res, 400, 'No playable video ID found in this URL.', 'YOUTUBE_NO_VIDEO_ID');
  const check = await youtubeCompat.checkEmbeddable(parsed.videoId, fetchOfficialJson);
  if (!check.ok) return res.json({ ok: false, code: check.code, videoId: parsed.videoId });
  res.json({
    ok: true,
    videoId: parsed.videoId,
    title: check.title,
    authorName: check.authorName,
    thumbnailUrl: check.thumbnailUrl,
    embedUrl: youtubeCompat.buildEmbedUrl(parsed, req.get('origin') || undefined),
  });
});







const EXT_STORE_FILE = path.join(__dirname, "..", "extension-store.json");
function safeExtensionCss(css) {
  const v = String(css || "");
  if (!v.trim() || v.length > 120000) throw new Error("Extension CSS is empty or exceeds 120 KB.");
  if (/@import\b|url\s*\(|javascript\s*:|expression\s*\(|-moz-binding|behavior\s*:|@font-face|@namespace\b/i.test(v)) throw new Error("Extension CSS may not import, fetch, execute scripts, or load external resources.");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw new Error("Extension CSS contains control characters.");
  let depth = 0; for (let i = 0; i < v.length; i++) { if (v[i] === "{") depth++; else if (v[i] === "}") { depth--; if (depth < 0) throw new Error("Extension CSS braces are unbalanced."); } }
  if (depth !== 0) throw new Error("Extension CSS braces are unbalanced.");
  return v;
}
function validateExtensionPackage(pkg) {
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) throw new Error("Extension package must be an object.");
  const id = String(pkg.id || "").trim(); if (!/^[a-z0-9][a-z0-9-_.]{1,63}$/i.test(id)) throw new Error("Invalid extension id.");
  const name = String(pkg.name || "").trim(); if (!name || name.length > 80) throw new Error("Invalid extension name.");
  const perms = Array.isArray(pkg.permissions) ? pkg.permissions.map(String) : []; if (perms.some(x => x !== "styles")) throw new Error("Only the styles permission is supported.");
  for (const k of ["js","script","scripts","content_scripts","background","service_worker","web_accessible_resources","externally_connectable"]) if (pkg[k]) throw new Error(`Unsupported extension capability: ${k}`);
  const files = pkg.files && typeof pkg.files === "object" ? pkg.files : {}; const css = safeExtensionCss(pkg.css ?? files["style.css"] ?? "");
  const matches = pkg.matches == null ? [] : Array.isArray(pkg.matches) ? pkg.matches.map(String).slice(0, 30) : [];
  if (matches.some(x => x.length > 120 || /[\r\n]/.test(x))) throw new Error("Invalid extension match pattern.");
  const integrity = crypto.createHash("sha256").update(JSON.stringify({ id, version: String(pkg.version || "1.0.0"), matches, css })).digest("hex");
  return { schema: "veyra-extension/v1", id, name, version: String(pkg.version || "1.0.0").slice(0, 20), description: String(pkg.description || "").slice(0, 300), author: String(pkg.author || "").slice(0, 100), publisher: String(pkg.publisher || "").slice(0, 100), permissions: ["styles"], matches, files: { "style.css": css }, published: !!pkg.published, verified: true, integrity };
}
function readExtensionStore() {
  let raw = []; try { raw = JSON.parse(fs.readFileSync(EXT_STORE_FILE, "utf8")); } catch { raw = []; }
  const out = []; for (const pkg of Array.isArray(raw) ? raw : []) { try { out.push(validateExtensionPackage(pkg)); } catch (e) { serverLog("warn", "STORE", `Rejected invalid published extension ${String(pkg?.id || "unknown")}: ${e.message}`); } }
  return out;
}
app.get("/api/extensions/store", (req, res) => res.json({ ok: true, extensions: readExtensionStore() }));
app.get("/api/extensions/store/:id", (req, res) => { const ext = readExtensionStore().find(x => x.id === req.params.id); if (!ext) return respondError(res, 404, "Extension not found.", "EXTENSION_NOT_FOUND"); res.json({ ok: true, extension: ext }); });
app.post("/api/extensions/verify", (req, res) => { try { const extension = validateExtensionPackage(req.body || {}); res.json({ ok: true, safe: true, extension, policy: { scripts: false, cookieAccess: false, networkImports: false, permissions: ["styles"] } }); } catch (e) { res.status(400).json({ ok: false, safe: false, reason: e.message, code: "EXTENSION_SECURITY_REJECTED" }); } });

const vpnErrStatus = code => ({ VPN_DISABLED: 503, VPN_NOT_CONFIGURED: 404, VPN_ALL_DOWN: 503, VPN_KILL_SWITCH: 503, VPN_TEST_FAILED: 502, VPN_NOT_CONNECTED: 409 })[code] || 400;




app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()), plan: VEYRA_CONFIG.plan.label, time: new Date().toISOString() }));
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()), plan: VEYRA_CONFIG.plan.label, time: new Date().toISOString() }));

app.get('/api/vpn/status', (req, res) => {
  res.json({ ok: true, ...vpnManager.status() });
});
app.get('/api/vpn/profiles', (req, res) => res.json({ ok: true, profiles: vpnManager.list(), defaultProfile: vpnManager.defaultProfileId || null }));
app.post('/api/vpn/test', async (req, res) => {
  try {
    const result = await vpnManager.test(String(req.body?.profileId || ''));
    res.json({ ok:true, ...result });
  } catch (e) { respondError(res, vpnErrStatus(e.code), e.message, e.code || 'VPN_TEST_ERROR', { profile: e.profile }); }
});
app.post('/api/vpn/health', async (req, res) => {
  if (!vpnManager.enabled) return respondError(res, 503, 'Veyra VPN is disabled on this server.', 'VPN_DISABLED');
  res.json({ ok: true, results: await vpnManager.checkAll(), profiles: vpnManager.list() });
});
app.post('/api/vpn/connect', async (req, res) => {
  try {
    const sid = normalizeSessionId(req.body?.sessionId || req.body?.sid);
    const requested = String(req.body?.profileId || '');
    
    
    
    
    const candidate = vpnManager.get(requested);
    if (candidate) await vpnManager.test(candidate.id);
    const result = vpnManager.connect(sid, requested, { region: String(req.body?.region || ''), group: String(req.body?.group || '') });
    const ps = sessionRecord(sid); ps.vpnProfileId = result.profile?.id || null;
    res.json({ ok:true, ...result, note:'Every request from this Veyra session (proxy, crawler and Chromium) now leaves through the VPN exit. If the tunnel drops, the kill switch blocks traffic instead of falling back to the server IP.' });
  } catch (e) { respondError(res, vpnErrStatus(e.code), e.message, e.code || 'VPN_CONNECT_ERROR'); }
});
app.post('/api/vpn/disconnect', (req, res) => {
  try {
    const sid = normalizeSessionId(req.body?.sessionId || req.body?.sid);
    vpnManager.disconnect(sid);
    const ps = sessionRecord(sid); ps.vpnProfileId = null;
    res.json({ ok:true, connected:false });
  } catch (e) { respondError(res, 400, e.message, e.code || 'VPN_DISCONNECT_ERROR'); }
});
app.post('/api/vpn/rotate', (req, res) => {
  try {
    const sid = normalizeSessionId(req.body?.sessionId || req.body?.sid);
    const result = vpnManager.rotate(sid);
    sessionRecord(sid).vpnProfileId = result.profile?.id || null;
    res.json({ ok: true, ...result });
  } catch (e) { respondError(res, vpnErrStatus(e.code), e.message, e.code || 'VPN_ROTATE_ERROR'); }
});
app.get('/api/vpn/session', (req, res) => {
  const sid = String(req.query.sid || req.query.sessionId || '');
  res.json({ ok: true, ...vpnManager.sessionInfo(sid) });
});
app.get('/api/vpn/ip', async (req, res) => {
  const sid = String(req.query.sid || req.query.sessionId || '');
  try { res.json({ ok: true, ...(await vpnManager.exitIpForSession(sid)) }); }
  catch (e) { respondError(res, vpnErrStatus(e.code) === 400 ? 502 : vpnErrStatus(e.code), e.message, e.code || 'VPN_IP_ERROR'); }
});




app.get('/api/vpn/list', async (req, res) => {
  try {
    const dbProfiles = mongoStore.enabled ? (await mongoStore.loadVpnProfiles()) : [];
    const envProfiles = vpnManager.list().map(p => ({ ...p, source: 'env' }));
    const envIds = new Set(envProfiles.map(p => p.id));
    
    const db = dbProfiles.filter(p => !envIds.has(p.id)).map(p => {
      const profile = vpnManager.parseProfile(p);
      return profile ? { ...vpnManager.publicProfile(profile), source: 'db' } : null;
    }).filter(Boolean);
    res.json({ ok: true, profiles: [...envProfiles, ...db], envCount: envProfiles.length, dbCount: db.length });
  } catch (e) { respondError(res, 500, e.message, 'VPN_LIST_ERROR'); }
});

app.post('/api/vpn/custom', async (req, res) => {
  const { name, type, server, username, password, region, config, id } = req.body || {};
  if (!name) return respondError(res, 400, 'VPN name is required', 'VPN_NAME_REQUIRED');
  const validTypes = ['socks5', 'http', 'https', 'wireguard'];
  if (!validTypes.includes(type)) return respondError(res, 400, `Invalid VPN type. Supported: ${validTypes.join(', ')}`, 'VPN_INVALID_TYPE');
  
  if (type === 'wireguard' && config) {
    if (!/\[Interface\]/i.test(config) || !/\[Peer\]/i.test(config)) {
      return respondError(res, 400, 'WireGuard config needs [Interface] and [Peer] sections', 'VPN_INVALID_WG_CONFIG');
    }
  }
  if (type !== 'wireguard' && !server) {
    return respondError(res, 400, 'Server address is required for proxy-type VPNs', 'VPN_SERVER_REQUIRED');
  }
  const profileId = id || `custom_${Date.now().toString(36)}`;
  try {
    const profileData = {
      id: profileId,
      name: String(name).slice(0, 100),
      type,
      server: server || '',
      username: username || '',
      password: password || '',
      region: region || '',
      config: type === 'wireguard' ? config : '',
      provider: 'User Custom',
      source: 'db',
      createdAt: new Date().toISOString(),
    };
    const profile = vpnManager.addProfile(profileData);
    if (!profile) return respondError(res, 400, 'Invalid VPN configuration', 'VPN_INVALID_CONFIG');
    
    if (mongoStore.enabled) await mongoStore.saveVpnProfile(profileData);
    serverLog('info', 'VPN', `VPN profile saved: ${name} (${type}) [${mongoStore.enabled ? 'persisted' : 'in-memory only'}]`);
    res.json({ ok: true, profileId, profile: vpnManager.publicProfile(profile), persisted: mongoStore.enabled });
  } catch (e) {
    respondError(res, 400, e.message, 'VPN_ADD_FAILED');
  }
});

app.delete('/api/vpn/custom/:profileId', async (req, res) => {
  const pid = String(req.params.profileId || '');
  if (!pid) return respondError(res, 400, 'Profile ID is required', 'VPN_ID_REQUIRED');
  vpnManager.removeProfile(pid);
  if (mongoStore.enabled) await mongoStore.deleteVpnProfile(pid);
  serverLog('info', 'VPN', `VPN profile deleted: ${pid}`);
  res.json({ ok: true, deleted: pid });
});



function sessionInfo(sid, rec) {
  const expiresAt = sessionManager.expiresAt(rec);
  return { sessionId: sid, active: true, createdAt: new Date(rec.createdAt).toISOString(), lastUsed: new Date(rec.lastUsed).toISOString(),
    timeLimitMs: (rec.timeLimitMs ?? sessionManager.timeLimitMs) || null, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, remainingMs: sessionManager.remainingMs(rec),
    idleExpiresInMs: Math.max(0, CFG.sessionIdleTtlMs - (Date.now() - rec.lastUsed)), cookies: rec.cookies.size, requests: rec.requests,
    serverTime: new Date().toISOString(), incognito: !!rec.incognito, vpn: vpnManager.sessionInfo?.(sid) || null };
}
app.get('/api/sessions', requireAdmin, (req, res) => res.json({ ok: true, ...sessionManager.report(), vpnConnections: vpnManager.status().connections, browser: { sessions: browserEngine.sessions.size, running: !!browserEngine.browser }, failover: failoverController ? failoverController.report() : null, snapshots: snapshotStore ? snapshotStore.report() : null }));

app.post('/api/session', (req, res) => {
  const user = authStore.userFromRequest(req);
  const sid = crypto.randomUUID().replaceAll("-", "");
  const isAdmin = !!(user && authStore.roleFor(user.email) === "admin");
  const limit = isAdmin ? CFG.adminSessionTimeLimitMs : CFG.sessionTimeLimitMs;
  const rec = sessionManager.create(sid, { timeLimitMs: limit });
  rec.userId = user?.id || null;
  rec.role = isAdmin ? "admin" : "user";
  
  rec.incognito = req.body?.incognito === true;
  res.status(201).json({ ok: true, ...sessionInfo(sid, rec), user: user ? authStore.publicUser(user) : null });
});
app.get('/api/session/:sid', (req, res) => {
  const sid = String(req.params.sid);
  if (sessionManager.checkLimit(sid)) return res.json({ ok: true, sessionId: sid, active: false, expired: true, reason: "SESSION_EXPIRED" });
  const rec = sessionManager.peek(sid);
  if (!rec) return res.json({ ok: true, sessionId: sid, active: false });
  res.json({ ok: true, ...sessionInfo(sid, rec) });
});

app.get('/api/session/:sid/cookies', (req, res) => {
  const sid = String(req.params.sid);
  if (sessionManager.checkLimit(sid)) return respondError(res, 410, "Session expired.", "SESSION_EXPIRED");
  const rec = sessionManager.peek(sid);
  if (!rec) return res.json({ ok: true, cookies: [] });
  const host = String(req.query.host || "").toLowerCase();
  const cookies = [...rec.cookies.values()].filter(c => !host || (c.hostOnly ? c.domain === host : cookieDomainMatches(host, c.domain)))
    .map(c => ({ name: c.name, value: c.value, domain: (c.hostOnly ? "" : ".") + c.domain.replace(/^\./, ""), path: c.path, secure: c.secure, expires: c.expiresAt ? new Date(c.expiresAt).toISOString() : "Session", size: c.name.length + String(c.value).length }));
  res.json({ ok: true, cookies });
});
app.delete('/api/session/:sid/cookies', (req, res) => {
  const rec = sessionManager.peek(String(req.params.sid));
  if (!rec) return res.json({ ok: true, deleted: 0 });
  const name = String(req.query.name || ""), domain = String(req.query.domain || "").replace(/^\./, "").toLowerCase();
  let n = 0;
  for (const [k, c] of [...rec.cookies]) if ((!name || c.name === name) && (!domain || c.domain.replace(/^\./, "") === domain)) { rec.cookies.delete(k); n += 1; }
  res.json({ ok: true, deleted: n });
});
app.post('/api/session/:sid/prefs', (req, res) => {
  const sid = String(req.params.sid);
  if (sessionManager.checkLimit(sid)) return respondError(res, 410, "Session expired.", "SESSION_EXPIRED");
  let rec; try { rec = sessionManager.touch(sid); } catch (e) { return respondError(res, e.status || 400, e.message, e.code || "SESSION_ERROR"); }
  rec.prefs = { ...(rec.prefs || {}), ...(typeof req.body?.blockTrackers === "boolean" ? { blockTrackers: req.body.blockTrackers } : {}) };
  res.json({ ok: true, prefs: rec.prefs, blocked: rec.blocked || 0 });
});
const closeSession = (req, res) => { const closed = sessionManager.close(String(req.params.sid)); res.json({ ok: true, closed }); };
app.delete('/api/session/:sid', closeSession);
app.post('/api/session/:sid/close', express.text({ type: () => true, limit: '4kb' }), closeSession);




function authFail(res, e) { respondError(res, e.status || 400, e.message, e.code || "AUTH_ERROR"); }
function clientIp(req) { return String(req.ip || req.socket?.remoteAddress || ""); }
function requireUser(req, res, next) {
  const user = authStore.userFromRequest(req);
  if (!user) return respondError(res, 401, "Sign in to continue.", "AUTH_REQUIRED");
  req.veyraUser = user; next();
}
function isAdminRequest(req) {
  const user = authStore.userFromRequest(req);
  if (user && authStore.roleFor(user.email) === "admin") return true;
  return configEditAllowed(req);
}
function requireAdmin(req, res, next) {
  if (!CFG.adminGate || isAdminRequest(req)) return next();
  respondError(res, 403, "This area is for Veyra administrators only.", "ADMIN_REQUIRED");
}
app.post('/api/auth/signup', (req, res) => { try { res.status(201).json({ ok: true, ...authStore.signup(req.body || {}, clientIp(req)) }); } catch (e) { authFail(res, e); } });
app.post('/api/auth/login', (req, res) => { try { res.json({ ok: true, ...authStore.login(req.body || {}, clientIp(req)) }); } catch (e) { authFail(res, e); } });
app.get('/api/auth/me', requireUser, (req, res) => {
  const user = req.veyraUser;
  const admin = authStore.roleFor(user.email) === "admin";
  res.json({ ok: true, user: authStore.publicUser(user), sessionTimeLimitMs: admin ? CFG.adminSessionTimeLimitMs : CFG.sessionTimeLimitMs });
});
app.patch('/api/auth/me', requireUser, (req, res) => { try { res.json({ ok: true, ...authStore.update(req.veyraUser, req.body || {}) }); } catch (e) { authFail(res, e); } });
app.delete('/api/auth/me', requireUser, (req, res) => { try { authStore.remove(req.veyraUser, req.body?.password); res.json({ ok: true }); } catch (e) { authFail(res, e); } });
app.post('/api/auth/logout', (req, res) => { const user = authStore.userFromRequest(req); if (user && req.body?.everywhere) authStore.logoutEverywhere(user); res.json({ ok: true }); });
app.get('/api/auth/data', requireUser, (req, res) => res.json({ ok: true, data: authStore.getData(req.veyraUser), updatedAt: req.veyraUser.dataUpdatedAt || null }));
app.put('/api/auth/data', requireUser, (req, res) => { try { res.json({ ok: true, ...authStore.setData(req.veyraUser, req.body?.data) }); } catch (e) { authFail(res, e); } });
app.get('/api/auth/config', (req, res) => {
  const user = authStore.userFromRequest(req);
  const admin = !!(user && authStore.roleFor(user.email) === "admin");
  res.json({ ok: true, signupEnabled: CFG.authAllowSignup, sessionTimeLimitMs: admin ? CFG.adminSessionTimeLimitMs : CFG.sessionTimeLimitMs, admin: admin || configEditAllowed(req), testMode: CFG.testMode, testAdmin: CFG.testMode ? authStore.getTestAdminCredentials() : null });
});




function platformData(user) {
  const data = authStore.getData(user) || {};
  const p = data.platform && typeof data.platform === "object" ? data.platform : {};
  if (!Array.isArray(p.workspaces)) p.workspaces = [];
  if (!p.billing || typeof p.billing !== "object") p.billing = { status: "required" };
  return { ...data, platform: p };
}
function savePlatformData(user, data) { authStore.setData(user, data); return data.platform; }
function platformOwner(user) { return authStore.roleFor(user.email) === "admin"; }
function platformPublicKey(k) { return { id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || null, revokedAt: k.revokedAt || null }; }
function platformPublicWorkspace(w) { return { id: w.id, name: w.name, slug: w.slug, description: w.description || "", createdAt: w.createdAt, keys: (w.keys || []).filter(k => !k.revokedAt).map(platformPublicKey) }; }
function platformFindWorkspace(data, id) { return data.platform.workspaces.find(x => x.id === String(id || "")); }
function platformFindKey(workspace, id) { return workspace?.keys?.find(x => x.id === String(id || "")); }
function platformNewKey(name) {
  const raw = `vyr_live_${crypto.randomBytes(24).toString("base64url")}`;
  const now = new Date().toISOString();
  return { raw, key: { id: crypto.randomUUID(), name: String(name || "Default key").trim().slice(0, 80) || "Default key", prefix: raw.slice(0, 16), hash: crypto.createHash("sha256").update(raw).digest("hex"), createdAt: now, lastUsedAt: null, revokedAt: null, usage: { requests: 0, last24h: 0 } } };
}
function platformSlug(name) { return String(name || "workspace").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "workspace"; }
const PLATFORM_PRICING = [
  { id: "owner", name: "Owner", price: 0, unit: "forever", description: "Included for Veyra owners and administrators.", features: ["Unlimited workspaces", "API keys", "Platform documentation"] },
  { id: "developer", name: "Developer", price: 0, unit: "during beta", description: "Free while the API platform is in beta. Billing profile required.", features: ["3 workspaces", "10 API keys per workspace", "Usage dashboard"] },
  { id: "early_access", name: "Early access", price: 2.99, unit: "per month", description: "Priority access while the platform opens in waves.", features: ["Priority queue placement", "Early platform access", "Founder feedback channel"] },
  { id: "team", name: "Team", price: 19, unit: "per month", description: "For small teams shipping on Veyra.", features: ["10 workspaces", "50 API keys per workspace", "Team support"] }
];
const PLATFORM_WAITLIST_FILE = path.join(CFG.authDataDir, "platform-waitlist.json");
function readPlatformWaitlist() { try { const rows = JSON.parse(fs.readFileSync(PLATFORM_WAITLIST_FILE, "utf8")); return Array.isArray(rows) ? rows : []; } catch { return []; } }
function writePlatformWaitlist(rows) { fs.mkdirSync(path.dirname(PLATFORM_WAITLIST_FILE), { recursive: true }); const tmp = `${PLATFORM_WAITLIST_FILE}.tmp`; fs.writeFileSync(tmp, JSON.stringify(rows, null, 2)); fs.renameSync(tmp, PLATFORM_WAITLIST_FILE); if (mongoStore.enabled) void mongoStore.replacePlatformWaitlist(rows); }
if (mongoStore.enabled) void mongoStore.loadPlatformWaitlist().then(rows => { const local = readPlatformWaitlist(); if (rows.length) writePlatformWaitlist(rows); else if (local.length) void mongoStore.replacePlatformWaitlist(local); }).catch(() => {});
function publicWaitlistEntry(x) { return { id: x.id, email: x.email, name: x.name || "", plan: x.plan, status: x.status, position: x.position || null, createdAt: x.createdAt, acceptedAt: x.acceptedAt || null, emailStatus: x.emailStatus || "pending" }; }
async function sendPlatformEmail({ to, subject, html }) {
  const key = String(process.env.RESEND_API_KEY || "").trim(), from = String(process.env.PLATFORM_EMAIL_FROM || "").trim();
  if (!key || !from) { serverLog("info", "PLATFORM_EMAIL", `Email delivery not configured; would send ${subject} to ${to}`); return { sent: false, status: "not_configured" }; }
  try {
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, html }) });
    if (!r.ok) throw new Error(`Resend returned ${r.status}`);
    return { sent: true, status: "sent" };
  } catch (e) { serverLog("warn", "PLATFORM_EMAIL", `Could not send email to ${to}: ${e.message}`); return { sent: false, status: "failed", error: e.message }; }
}
app.post('/api/platform/waitlist', async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase(), name = String(req.body?.name || "").trim().slice(0, 100), plan = req.body?.plan === "early_access" ? "early_access" : "developer";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return respondError(res, 400, "Enter a valid email address.", "WAITLIST_EMAIL_INVALID");
  const rows = readPlatformWaitlist(), existing = rows.find(x => x.email === email);
  if (existing) return res.json({ ok: true, alreadyJoined: true, entry: publicWaitlistEntry(existing), earlyAccessPrice: 2.99 });
  const active = rows.filter(x => x.status === "pending").length;
  const entry = { id: crypto.randomUUID(), email, name, plan, status: "pending", position: active + 1, createdAt: new Date().toISOString(), emailStatus: "pending" };
  rows.push(entry); writePlatformWaitlist(rows);
  const emailResult = await sendPlatformEmail({ to: email, subject: "You’re on the Veyra platform waitlist", html: `<p>Hi ${escapeHtml(name || "there")},</p><p>You’re in the queue for the Veyra Developer Platform. We’ll email you when your access is ready.</p>${plan === "early_access" ? `<p>You selected early access at <strong>$2.99/month</strong>. We’ll include the secure checkout link when your place is ready.</p>` : ""}<p>— The Veyra team</p>` });
  entry.emailStatus = emailResult.status; writePlatformWaitlist(rows);
  res.status(201).json({ ok: true, entry: publicWaitlistEntry(entry), earlyAccessPrice: 2.99, message: "You’re on the list." });
});
app.get('/api/platform/waitlist/status', (req, res) => { const email = String(req.query.email || "").trim().toLowerCase(); const x = readPlatformWaitlist().find(v => v.email === email); res.json({ ok: true, entry: x ? publicWaitlistEntry(x) : null }); });
app.get('/api/platform/waitlist', requireAdmin, (req, res) => { const rows = readPlatformWaitlist(); res.json({ ok: true, total: rows.length, pending: rows.filter(x => x.status === "pending").length, entries: rows.map(publicWaitlistEntry) }); });
app.post('/api/platform/waitlist/:id/accept', requireAdmin, async (req, res) => {
  const rows = readPlatformWaitlist(), x = rows.find(v => v.id === req.params.id); if (!x) return respondError(res, 404, "Waitlist entry not found.", "WAITLIST_NOT_FOUND");
  x.status = "accepted"; x.acceptedAt = new Date().toISOString(); x.emailStatus = "pending"; writePlatformWaitlist(rows);
  const base = String(process.env.PLATFORM_URL || "https://homekidchud.github.io/VeyraBrowser/dev/platform").replace(/\/$/, ""), checkout = String(process.env.PLATFORM_EARLY_ACCESS_URL || "").trim();
  const result = await sendPlatformEmail({ to: x.email, subject: "Your Veyra platform access is ready", html: `<p>Hi ${escapeHtml(x.name || "there")},</p><p>Your Veyra Developer Platform access is ready.</p><p><a href="${escapeHtml(base)}">Open the Veyra platform</a> and sign in to create your workspace.</p>${x.plan === "early_access" ? `<p>Early access is <strong>$2.99/month</strong>. ${checkout ? `<a href="${escapeHtml(checkout)}">Continue to secure checkout</a>.` : "A checkout link will be added by the Veyra team."}</p>` : ""}<p>Keep your API keys private and rotate them regularly.</p>` });
  x.emailStatus = result.status; writePlatformWaitlist(rows); res.json({ ok: true, entry: publicWaitlistEntry(x), email: result });
});
app.get('/api/platform/pricing', (req, res) => res.json({ ok: true, currency: "USD", plans: PLATFORM_PRICING }));
app.get('/api/platform/overview', requireUser, (req, res) => {
  const d = platformData(req.veyraUser), owner = platformOwner(req.veyraUser);
  const waitlist = owner ? readPlatformWaitlist() : [];
  res.json({ ok: true, owner, billing: owner ? { status: "owner_free", provider: null } : d.platform.billing, workspaces: d.platform.workspaces.map(platformPublicWorkspace), limits: owner ? { workspaces: 999, keysPerWorkspace: 999 } : { workspaces: 3, keysPerWorkspace: 10 }, pricing: PLATFORM_PRICING, waitlist: owner ? { total: waitlist.length, pending: waitlist.filter(x => x.status === "pending").length, entries: waitlist.map(publicWaitlistEntry) } : null });
});
app.post('/api/platform/billing/setup', requireUser, (req, res) => {
  if (platformOwner(req.veyraUser)) return res.json({ ok: true, billing: { status: "owner_free", provider: null } });
  const email = String(req.body?.billingEmail || req.veyraUser.email).trim().toLowerCase();
  const company = String(req.body?.company || "").trim().slice(0, 100);
  if (!email.includes("@")) return respondError(res, 400, "Enter a valid billing email.", "BILLING_EMAIL_INVALID");
  const d = platformData(req.veyraUser); d.platform.billing = { status: "configured", provider: "manual-profile", billingEmail: email, company, updatedAt: new Date().toISOString() }; savePlatformData(req.veyraUser, d);
  res.json({ ok: true, billing: d.platform.billing, note: "Billing profile saved. No payment method was collected." });
});
app.post('/api/platform/workspaces', requireUser, (req, res) => {
  const d = platformData(req.veyraUser), owner = platformOwner(req.veyraUser);
  if (!owner && d.platform.workspaces.length >= 3) return respondError(res, 402, "Your Developer plan allows 3 workspaces. Upgrade to create more.", "PLATFORM_PLAN_LIMIT");
  const name = String(req.body?.name || "").trim().slice(0, 80);
  if (name.length < 2) return respondError(res, 400, "Workspace name must be at least 2 characters.", "WORKSPACE_NAME_INVALID");
  const base = platformSlug(name); let slug = base, n = 2; while (d.platform.workspaces.some(w => w.slug === slug)) slug = `${base}-${n++}`;
  const w = { id: crypto.randomUUID(), name, slug, description: String(req.body?.description || "").trim().slice(0, 240), createdAt: new Date().toISOString(), keys: [] };
  d.platform.workspaces.push(w); savePlatformData(req.veyraUser, d); res.status(201).json({ ok: true, workspace: platformPublicWorkspace(w) });
});
app.patch('/api/platform/workspaces/:id', requireUser, (req, res) => {
  const d = platformData(req.veyraUser), w = d.platform.workspaces.find(x => x.id === req.params.id); if (!w) return respondError(res, 404, "Workspace not found.", "WORKSPACE_NOT_FOUND");
  if (req.body?.name != null) { const name = String(req.body.name).trim().slice(0, 80); if (name.length < 2) return respondError(res, 400, "Workspace name is too short.", "WORKSPACE_NAME_INVALID"); w.name = name; }
  if (req.body?.description != null) w.description = String(req.body.description).trim().slice(0, 240);
  savePlatformData(req.veyraUser, d); res.json({ ok: true, workspace: platformPublicWorkspace(w) });
});
app.delete('/api/platform/workspaces/:id', requireUser, (req, res) => {
  const d = platformData(req.veyraUser), before = d.platform.workspaces.length; d.platform.workspaces = d.platform.workspaces.filter(x => x.id !== req.params.id); if (before === d.platform.workspaces.length) return respondError(res, 404, "Workspace not found.", "WORKSPACE_NOT_FOUND"); savePlatformData(req.veyraUser, d); res.json({ ok: true, deleted: true });
});
app.get('/api/platform/workspaces/:id', requireUser, (req, res) => {
  const d = platformData(req.veyraUser), w = platformFindWorkspace(d, req.params.id);
  if (!w) return respondError(res, 404, "Workspace not found.", "WORKSPACE_NOT_FOUND");
  res.json({ ok: true, workspace: platformPublicWorkspace(w), limits: { keysPerWorkspace: platformOwner(req.veyraUser) ? 999 : 10 } });
});
app.get('/api/platform/workspaces/:id/keys', requireUser, (req, res) => {
  const d = platformData(req.veyraUser), w = platformFindWorkspace(d, req.params.id);
  if (!w) return respondError(res, 404, "Workspace not found.", "WORKSPACE_NOT_FOUND");
  const keys = (w.keys || []).filter(k => !k.revokedAt);
  res.json({ ok: true, workspaceId: w.id, keys: keys.map(platformPublicKey), total: keys.length });
});
app.post('/api/platform/workspaces/:id/keys', requireUser, (req, res) => {
  const d = platformData(req.veyraUser), w = d.platform.workspaces.find(x => x.id === req.params.id); if (!w) return respondError(res, 404, "Workspace not found.", "WORKSPACE_NOT_FOUND");
  const owner = platformOwner(req.veyraUser); if (!owner && d.platform.billing.status !== "configured") return respondError(res, 402, "Set up billing before creating API keys.", "BILLING_REQUIRED");
  if (!owner && w.keys.filter(k => !k.revokedAt).length >= 10) return respondError(res, 402, "This workspace reached its API key limit.", "PLATFORM_KEY_LIMIT");
  const created = platformNewKey(req.body?.name); w.keys.push(created.key); savePlatformData(req.veyraUser, d); res.status(201).json({ ok: true, key: created.raw, keyInfo: platformPublicKey(created.key), warning: "Copy this key now. Veyra will not show it again." });
});
app.get('/api/platform/workspaces/:workspaceId/keys/:keyId', requireUser, (req, res) => {
  const d = platformData(req.veyraUser), w = platformFindWorkspace(d, req.params.workspaceId), k = platformFindKey(w, req.params.keyId);
  if (!w) return respondError(res, 404, "Workspace not found.", "WORKSPACE_NOT_FOUND");
  if (!k) return respondError(res, 404, "API key not found.", "API_KEY_NOT_FOUND");
  res.json({ ok: true, key: platformPublicKey(k), usage: k.usage || { requests: 0, last24h: 0 } });
});
app.patch('/api/platform/workspaces/:workspaceId/keys/:keyId', requireUser, (req, res) => {
  const d = platformData(req.veyraUser), w = platformFindWorkspace(d, req.params.workspaceId), k = platformFindKey(w, req.params.keyId);
  if (!w) return respondError(res, 404, "Workspace not found.", "WORKSPACE_NOT_FOUND");
  if (!k || k.revokedAt) return respondError(res, 404, "API key not found.", "API_KEY_NOT_FOUND");
  if (req.body?.name != null) { const name = String(req.body.name).trim().slice(0, 80); if (name.length < 2) return respondError(res, 400, "Key name is too short.", "API_KEY_NAME_INVALID"); k.name = name; }
  savePlatformData(req.veyraUser, d); res.json({ ok: true, key: platformPublicKey(k) });
});
app.post('/api/platform/workspaces/:workspaceId/keys/:keyId/rotate', requireUser, (req, res) => {
  const d = platformData(req.veyraUser), w = platformFindWorkspace(d, req.params.workspaceId), old = platformFindKey(w, req.params.keyId);
  if (!w) return respondError(res, 404, "Workspace not found.", "WORKSPACE_NOT_FOUND");
  if (!old || old.revokedAt) return respondError(res, 404, "API key not found.", "API_KEY_NOT_FOUND");
  old.revokedAt = new Date().toISOString();
  const created = platformNewKey(req.body?.name || old.name); w.keys.push(created.key); savePlatformData(req.veyraUser, d);
  res.status(201).json({ ok: true, key: created.raw, keyInfo: platformPublicKey(created.key), replacedKeyId: old.id, warning: "The previous key was revoked. Copy this replacement now; it will not be shown again." });
});
app.delete('/api/platform/workspaces/:workspaceId/keys/:keyId', requireUser, (req, res) => {
  const d = platformData(req.veyraUser), w = d.platform.workspaces.find(x => x.id === req.params.workspaceId), k = w?.keys?.find(x => x.id === req.params.keyId); if (!k) return respondError(res, 404, "API key not found.", "API_KEY_NOT_FOUND"); k.revokedAt = new Date().toISOString(); savePlatformData(req.veyraUser, d); res.json({ ok: true, revoked: true });
});


app.post('/api/auth/test-login', (req, res) => {
  if (!CFG.testMode) return res.status(403).json({ error: 'Test mode is disabled', ok: false });
  const creds = authStore.getTestAdminCredentials();
  if (!creds) return res.status(403).json({ error: 'Test admin not available', ok: false });
  try {
    const result = authStore.login({ email: creds.email, password: creds.password }, req.ip);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(e.status || 500).json({ error: e.message, ok: false }); }
});



function configEditAllowed(req) {
  if (CFG.adminToken) {
    const got = String(req.get('x-veyra-admin-token') || '').trim();
    return got.length === CFG.adminToken.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(CFG.adminToken));
  }
  const ip = String(req.socket?.remoteAddress || '');
  return CFG.devConfigApi && /^(::1|127\.|::ffff:127\.)/.test(ip);
}
function runtimeConfigSummary() {
  return {
    plan: CFG.plan, leanMode: CFG.leanMode, resourceProfile: CFG.resourceProfile, memoryLimitMb: CFG.memoryLimitMb,
    shield: shield.status(),
    crawlers: { maxActiveJobs: CFG.maxActiveJobs, effectiveMaxActiveJobs: effectiveMaxActiveJobs(), running: activeCrawlCount(), queued: crawlQueue.length, queueMax: CFG.crawlQueueMax, abandonMs: CFG.crawlAbandonMs, robotsPerCrawl: CFG.logicalRobots, maxActiveFetches: CFG.maxActiveFetches, perHostConcurrency: CFG.perHostConcurrency, pageAccelerator: CFG.crawlerPageAccelerator, exhaustiveModeAvailable: true, pageWarmMs: CFG.crawlerPageWarmMs, pageWarmMaxResources: CFG.crawlerPageMaxResources, proxyWarmLimit: CFG.proxyWarmLimit, proxyWarmConcurrency: CFG.proxyWarmConcurrency, proxyWarmPerHost: CFG.proxyWarmPerHost, proxyCriticalPreloadLimit: CFG.proxyCriticalPreloadLimit },
    workers: workerPool ? workerPool.report() : { size: 0, mode: 'inline', configured: CFG.parseWorkers },
    sessions: { maxSessions: CFG.maxProxySessions, idleTtlMs: CFG.sessionIdleTtlMs, maxAgeMs: CFG.sessionMaxAgeMs, maxCookieBytes: CFG.sessionMaxCookieBytes, serverIdleSleepMs: CFG.serverIdleSleepMs },
    browser: { maxSessions: CFG.maxBrowserSessions, maxPages: CFG.maxBrowserPages, keepWarm: CFG.browserKeepWarm, warmIdleMs: CFG.browserWarmIdleMs },
    mongo: mongoStore.status(),
    vpn: { enabled: CFG.vpnEnabled, killSwitch: CFG.vpnKillSwitch, failover: CFG.vpnFailover, alwaysOn: CFG.vpnAlwaysOn }
  };
}
app.get('/api/config', (req, res) => res.json({ ok: true, config: veyraConfigModule.publicSummary(VEYRA_CONFIG), runtime: runtimeConfigSummary(), editable: configEditAllowed(req) }));
app.get('/api/config/plans', (req, res) => res.json({ ok: true, current: CFG.plan, plans: Object.entries(veyraConfigModule.RENDER_PLANS).map(([key, p]) => ({ key, label: p.label, ramMb: p.ramMb, cpu: p.cpu, renderYaml: p.renderYaml, caps: veyraConfigModule.capsFor(p.ramMb, p.cpu) })) }));
app.post('/api/config/validate', (req, res) => { const v = veyraConfigModule.validateConfig(req.body || {}); res.json({ ok: !v.errors.length, ...v }); });
app.put('/api/config', (req, res) => {
  if (!configEditAllowed(req)) return respondError(res, 403, 'Config editing is only available in development from localhost, or with the X-Veyra-Admin-Token header when VEYRA_ADMIN_TOKEN is set. In production, change veyra.config.json in the repo (npm run config -- plan <name>) and redeploy.', 'CONFIG_READ_ONLY');
  try {
    const current = veyraConfigModule.loadRawFile();
    const body = req.body || {};
    const next = { ...current };
    if (body.plan !== undefined) next.plan = body.plan;
    if (body.env && typeof body.env === 'object') next.env = { ...(current.env || {}), ...body.env };
    if (body.caps && typeof body.caps === 'object') next.caps = { ...(current.caps || {}), ...body.caps };
    for (const k of Object.keys(next.env || {})) if (next.env[k] === null) delete next.env[k];
    for (const k of Object.keys(next.caps || {})) if (next.caps[k] === null) delete next.caps[k];
    const validation = veyraConfigModule.saveRawFile(next);
    const yaml = body.plan && body.plan !== 'auto' && body.updateRenderYaml !== false ? veyraConfigModule.setPlanInRenderYaml(veyraConfigModule.resolvePlanName(body.plan) || body.plan) : false;
    const preview = veyraConfigModule.publicSummary(veyraConfigModule.loadConfig());
    res.json({ ok: true, saved: true, renderYamlUpdated: yaml, validation, preview, note: 'Saved. `npm run dev` restarts automatically; otherwise restart the server. On Render, commit + push to redeploy.' });
  } catch (e) { respondError(res, 400, e.message, e.code || 'CONFIG_SAVE_FAILED', { validation: e.validation }); }
});

function requireLiveProxySession(sid) {
  const id = String(sid || "");
  if (!id) throw Object.assign(new Error("A Veyra session is required for a Chromium tab."), { code: "SESSION_REQUIRED", status: 400 });
  if (sessionManager.checkLimit(id)) throw Object.assign(new Error("This Veyra session reached its time limit and was deleted."), { code: "SESSION_EXPIRED", status: 410 });
  const rec = sessionManager.peek(id);
  if (!rec) throw Object.assign(new Error("Veyra session not found. Start a new session."), { code: "SESSION_NOT_FOUND", status: 404 });
  sessionManager.touch(id);
  return rec;
}

async function browserVpnProfileForSession(sid) {
  const id = String(sid || "");
  if (!id || !vpnManager?.playwrightProxy) return null;
  const proxy = await vpnManager.playwrightProxy(id).catch(() => undefined);
  if (!proxy) return null;
  return {
    id: vpnManager.profileForSession?.(id)?.id || null,
    proxy,
    contextHints: vpnManager.browserContextHints?.(id) || {}
  };
}

function browserSessionOrThrow(browserSid) {
  const s = browserEngine.sessions.get(String(browserSid || ""));
  if (!s) throw Object.assign(new Error("Browser session not found."), { code: "BROWSER_SESSION_NOT_FOUND", status: 404 });
  if (s.proxySessionId) requireLiveProxySession(s.proxySessionId);
  return s;
}

app.post('/api/browser/session', async (req, res) => {
  if (!CFG.browserEnabled) return respondError(res, 503, "Chromium browsing is disabled on this server.", "BROWSER_ENGINE_UNAVAILABLE");
  try {
    const proxySessionId = String(req.body?.proxySessionId || req.body?.sessionId || "");
    requireLiveProxySession(proxySessionId);
    
    if (failoverController) {
      const check = failoverController.shouldUseChromium(proxySessionId);
      if (!check.allow) {
        return res.status(429).json({
          ok: false,
          code: "BROWSER_FAILOVER",
          error: `Chromium is in cooldown for this session. Using fast proxy instead.`,
          fallbackMode: "FAST_PROXY",
          retryAfterMs: check.retryAfterMs,
          reason: check.reason
        });
      }
    }
    const url = normalizeUrl(String(req.body?.url || ""));
    if (!url) return respondError(res, 400, "Invalid browser URL.", "INVALID_URL");
    await assertPublicUrl(url);
    const tabId = String(req.body?.tabId || "");
    const jobId = String(req.body?.jobId || "");
    const vpnProfile = await browserVpnProfileForSession(proxySessionId);
    
    
    const storageState = sessionManager.getStorageState(proxySessionId);
    const session = await browserEngine.create(tabId, url, jobId, vpnProfile, { proxySessionId, fastStart: !!req.body?.fastStart, storageState });
    sessionManager.linkBrowser(proxySessionId, session.id);
    
    if (failoverController) failoverController.recordBrowserResult(proxySessionId, true);
    res.status(201).json({ ok: true, session });
  } catch (e) {
    
    const proxySessionId = String(req.body?.proxySessionId || req.body?.sessionId || "");
    if (failoverController && proxySessionId) {
      const errorType = e.code === 'BROWSER_CAPACITY' ? 'capacity' :
        e.code === 'BROWSER_ENGINE_UNAVAILABLE' ? 'unavailable' :
        /timeout/i.test(e.message || '') ? 'timeout' : 'error';
      failoverController.recordBrowserResult(proxySessionId, false, errorType);
    }
    const status = e.status || (e.code === "BROWSER_CAPACITY" ? 429 : e.code === "SESSION_EXPIRED" ? 410 : 502);
    
    if (e.code === "BROWSER_CAPACITY" || e.code === "BROWSER_ENGINE_UNAVAILABLE") {
      return res.status(status).json({
        ok: false, code: e.code, error: e.message,
        fallbackMode: "FAST_PROXY",
        retryAfterMs: e.code === "BROWSER_CAPACITY" ? 5000 : 30000
      });
    }
    respondError(res, status, e.message, e.code || "BROWSER_CREATE_FAILED");
  }
});

app.get('/api/browser/session/:sid', (req, res) => {
  try { const s = browserSessionOrThrow(req.params.sid); res.json({ ok: true, session: browserEngine.public(s) }); }
  catch (e) { respondError(res, e.status || 404, e.message, e.code || "BROWSER_SESSION_NOT_FOUND"); }
});
app.post('/api/browser/session/:sid/navigate', async (req, res) => {
  try {
    const s = browserSessionOrThrow(req.params.sid);
    const url = normalizeUrl(String(req.body?.url || ""));
    if (!url) throw Object.assign(new Error("Invalid browser URL."), { code: "INVALID_URL", status: 400 });
    await browserEngine.navigateSession(s, url, { fast: !!req.body?.fastStart });
    
    if (snapshotStore && s.proxySessionId) {
      try {
        const html = await s.page.content().catch(() => '');
        const title = await s.page.title().catch(() => s.title || '');
        snapshotStore.snapshot(s.proxySessionId, {
          html, url: s.canonicalUrl, title, contentType: 'text/html', status: 200, headers: {}, assets: []
        });
      } catch {}
    }
    res.json({ ok: true, session: browserEngine.public(s) });
  } catch (e) { respondError(res, e.status || 502, e.message, e.code || "BROWSER_NAVIGATION_ERROR"); }
});
app.post('/api/browser/session/:sid/input', async (req, res) => {
  try { browserSessionOrThrow(req.params.sid); const session = await browserEngine.input(req.params.sid, req.body || {}); res.json({ ok: true, session }); }
  catch (e) { respondError(res, e.status || 502, e.message, e.code || "BROWSER_INPUT_ERROR"); }
});
app.post('/api/browser/session/:sid/history', async (req, res) => {
  try { browserSessionOrThrow(req.params.sid); const session = await browserEngine.history(req.params.sid, String(req.body?.direction || "reload")); res.json({ ok: true, session }); }
  catch (e) { respondError(res, e.status || 502, e.message, e.code || "BROWSER_HISTORY_ERROR"); }
});
app.post('/api/browser/session/:sid/stop', async (req, res) => {
  try { browserSessionOrThrow(req.params.sid); const session = await browserEngine.stopNavigation(req.params.sid); res.json({ ok: true, session }); }
  catch (e) { respondError(res, e.status || 502, e.message, e.code || "BROWSER_STOP_ERROR"); }
});
app.delete('/api/browser/session/:sid', async (req, res) => {
  try {
    const s = browserSessionOrThrow(req.params.sid);
    const owner = s.proxySessionId;
    const result = await browserEngine.stop(req.params.sid);
    if (owner) sessionManager.unlinkBrowser(owner, req.params.sid);
    res.json(result);
  } catch (e) { respondError(res, e.status || 404, e.message, e.code || "BROWSER_STOP_ERROR"); }
});
app.get('/api/browser/session/:sid/screenshot', async (req, res) => {
  try { browserSessionOrThrow(req.params.sid); const image = await browserEngine.screenshot(req.params.sid); if (!image) return res.status(503).type('text/plain').send('Chromium screenshot unavailable.'); res.setHeader('Cache-Control', 'no-store'); res.type('jpeg').send(image); }
  catch (e) { respondError(res, e.status || 404, e.message, e.code || "BROWSER_SCREENSHOT_ERROR"); }
});


app.get('/api/search', (req, res) => {
  try {
    const query = String(req.query.q || "").trim().slice(0, CFG.maxSearchQueryChars);
    const offset = Math.max(0, Number(req.query.offset || 0) || 0);
    const limit = Math.min(CFG.maxSearchResults, Math.max(1, Number(req.query.limit || 10) || 10));
    const started = Date.now();
    const result = localSearch(query, offset, limit);
    res.json({ ok: true, ...result, provider: "veyra-index", responseTimeMs: Date.now() - started });
  } catch (e) { respondError(res, 500, e.message, "SEARCH_ERROR"); }
});
app.get('/api/search/stats', (req, res) => res.json({ ok: true, ...searchIndexStats() }));
app.get('/api/search/suggest', (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, CFG.maxSearchQueryChars);
  const limit = Math.min(12, Math.max(1, Number(req.query.limit || 8) || 8));
  res.json({ ok: true, suggestions: localSearchSuggestions(q, limit) });
});
app.get('/api/search/correct', (req, res) => res.json({ ok: true, ...correctSearchQuery(req.query.q || "") }));
app.get('/api/search/web', async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 600);
    if (!q) return res.json({ ok: true, provider: "none", results: [], attempts: [], responseTimeMs: 0 });
    const engine = String(req.query.engine || "").trim().toLowerCase();
    const validEngine = new Set(["google", "brave", "bing", "duckduckgo", ""]);
    const selected = validEngine.has(engine) ? engine : "";
    const offset = Math.max(0, Number(req.query.offset || 0) || 0);
    const lang = String(req.query.lang || "en").slice(0, 16);
    const started = Date.now();
    const result = await webSearch.search(q, { offset, engine: selected, lang });
    res.json({ ok: true, ...result, source: "web", responseTimeMs: Date.now() - started });
  } catch (e) {
    respondError(res, 502, `Veyra web search failed: ${e.message}`, "SEARCH_WEB_ERROR");
  }
});

app.get('/api/browser/status', (req, res) => res.json({ ok: true, ...browserEngine.status(), failover: failoverController ? failoverController.report() : null, snapshots: snapshotStore ? snapshotStore.report() : null, config: { backend: CFG.browserBackend, enabled: CFG.browserEnabled, headless: CFG.browserHeadless, maxSessions: CFG.maxBrowserSessions, maxPages: CFG.maxBrowserPages, maxContexts: CFG.maxBrowserContexts } }));


app.post('/api/browser/retry', async (req, res) => {
  try {
    const proxySessionId = String(req.body?.proxySessionId || req.body?.sessionId || "");
    if (!proxySessionId) return respondError(res, 400, "Missing session id.", "INVALID_SESSION");
    if (failoverController) failoverController.reset(proxySessionId);
    if (sessionManager.isPaused(proxySessionId)) sessionManager.resumeFromVerification(proxySessionId);
    res.json({ ok: true, message: "Circuit breaker reset. Chromium will be retried." });
  } catch (e) { respondError(res, 502, e.message, e.code || "RETRY_FAILED"); }
});


app.post('/api/browser/resume-verification', async (req, res) => {
  try {
    const proxySessionId = String(req.body?.proxySessionId || req.body?.sessionId || "");
    if (!proxySessionId) return respondError(res, 400, "Missing session id.", "INVALID_SESSION");
    sessionManager.resumeFromVerification(proxySessionId);
    res.json({ ok: true, message: "Session resumed from verification." });
  } catch (e) { respondError(res, 502, e.message, e.code || "RESUME_FAILED"); }
});


const aiAnswerEngine = new AIAnswerEngine();
app.post('/api/search/answer', async (req, res) => {
  try {
    const { query, results } = req.body;
    if (!query) return res.json({ hasAnswer: false, reason: 'No query provided' });
    const answer = await aiAnswerEngine.answer(query, results || []);
    res.json(answer);
  } catch (e) { res.json({ hasAnswer: false, reason: e.message }); }
});
app.get('/api/answer/status', (req, res) => res.json(aiAnswerEngine.report()));



const renewingManager = new RenewingManager({ log: (level, source, msg) => serverLog(level, source, msg), billingRequired: true, billingStatus: process.env.ADS_BILLING_STATUS || "not_configured", subscriptionUrl: process.env.ADS_SUBSCRIPTION_URL || "" });
app.get('/api/renew/ads', (req, res) => res.json({ ok: true, ads: renewingManager.getActiveAds() }));
app.get('/api/renew/status/:sessionId', (req, res) => res.json(renewingManager.getSessionStatus(req.params.sessionId)));
app.post('/api/renew/click/:adId', (req, res) => res.json({ ok: renewingManager.recordClick(req.params.adId) }));
app.post('/api/renew/watch/:adId', (req, res) => {
  try {
    const result = renewingManager.watchAd(req.params.adId, req.body.sessionId);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message, ok: false }); }
});
app.post('/api/renew/complete/:watchId', (req, res) => {
  try {
    const result = renewingManager.completeWatch(req.params.watchId);
    
    
    let renewal = null;
    try {
      const watch = renewingManager.getWatch?.(req.params.watchId);
      const sid = watch?.sessionId || String(req.body?.sessionId || "");
      if (sid) renewal = sessionManager.renew(sid, result.rewardMs);
    } catch (e) { return res.status(410).json({ error: `Session expired before the ad finished: ${e.message}`, ok: false, code: "SESSION_EXPIRED" }); }
    res.json({ ok: true, ...result, session: renewal });
  } catch (e) { res.status(400).json({ error: e.message, ok: false }); }
});

app.post('/api/renew/ads', requireAdmin, (req, res) => {
  try { const ad = renewingManager.addAd(req.body); res.json({ ok: true, ad }); }
  catch (e) { res.status(e.code === "ADS_BILLING_REQUIRED" ? 402 : 400).json({ error: e.message, ok: false, code: e.code || "AD_INVALID", subscriptionUrl: e.subscriptionUrl || renewingManager.subscriptionUrl || null }); }
});
app.delete('/api/renew/ads/:id', requireAdmin, (req, res) => {
  const ok = renewingManager.removeAd(req.params.id); res.json({ ok });
});
app.post('/api/renew/ads/:id/toggle', requireAdmin, (req, res) => {
  const ad = renewingManager.toggleAd(req.params.id); res.json({ ok: !!ad, ad });
});
app.get('/api/renew/report', requireAdmin, (req, res) => res.json(renewingManager.report()));

app.get('/api/platform/ads', requireAdmin, (req, res) => res.json({ ok: true, report: renewingManager.report() }));
app.post('/api/platform/ads', requireAdmin, (req, res) => { try { res.status(201).json({ ok: true, ad: renewingManager.addAd(req.body || {}) }); } catch (e) { res.status(e.code === "ADS_BILLING_REQUIRED" ? 402 : 400).json({ ok: false, error: e.message, code: e.code || "AD_INVALID", subscriptionUrl: e.subscriptionUrl || renewingManager.subscriptionUrl || null }); } });
app.post('/api/platform/ads/:id/toggle', requireAdmin, (req, res) => { const ad = renewingManager.toggleAd(req.params.id); if (!ad) return res.status(404).json({ ok: false, error: 'Campaign not found' }); res.json({ ok: true, ad }); });
app.delete('/api/platform/ads/:id', requireAdmin, (req, res) => { const ok = renewingManager.removeAd(req.params.id); if (!ok) return res.status(404).json({ ok: false, error: 'Campaign not found' }); res.json({ ok: true }); });
async function warmRenderedBrowserPage(browserSessionId, sid) {
  const controller = new AbortController();
  const hardTimer = setTimeout(() => controller.abort(), Math.max(500, CFG.proxyWarmHardMs));
  try {
    const rendered = await browserEngine.renderedContent(browserSessionId, 1800);
    if (rendered.html && rendered.url) void warmPageResources(rendered.html, rendered.url, sid, controller.signal);
    const session = browserEngine.sessions.get(browserSessionId);
    if (!session || controller.signal.aborted) return;
    const observed = new Map();
    for (const row of session.network.slice(-160)) {
      if (String(row.method || 'GET').toUpperCase() !== 'GET' || Number(row.status || 0) >= 400) continue;
      const type = String(row.resourceType || '').toLowerCase();
      if (!/script|stylesheet|fetch|xhr|image|font|media|manifest|texttrack/.test(type)) continue;
      const u = normalizeUrl(row.url || '');
      if (!u || observed.has(u)) continue;
      const priority = /stylesheet|script/.test(type) ? 125 : /fetch|xhr/.test(type) ? 118 : /font/.test(type) ? 105 : /image|media/.test(type) ? 90 : 70;
      observed.set(u, { url: u, priority, sid, requestHeaders: row.requestHeaders || {}, type });
      if (observed.size >= Math.min(64, CFG.proxyWarmLimit)) break;
    }
    if (!observed.size) return;
    const rows = [...observed.values()].sort((a, b) => b.priority - a.priority);
    const hostActive = new Map();
    let cursor = 0;
    const worker = async () => {
      while (!controller.signal.aborted && cursor < rows.length) {
        const item = rows[cursor++];
        const host = hostOf(item.url);
        while (!controller.signal.aborted && (hostActive.get(host) || 0) >= CFG.proxyWarmPerHost) await sleep(2);
        if (controller.signal.aborted) break;
        hostActive.set(host, (hostActive.get(host) || 0) + 1);
        try {
          const warmType = warmTypeForUrl(item.url, item.type);
          const common = {
            sessionId: sid, referrer: rendered.url, headers: item.requestHeaders || {}, accept: '*/*',
            timeout: Math.min(CFG.requestTimeoutMs, 7000), bodyTimeoutMs: Math.min(CFG.bodyTimeoutMs, 7000),
            retries: 0, limitForContentType: crawlLimitForContentType, signal: controller.signal
          };
          if (warmType === 'media') {
            await fetchCached(item.url, { ...common, method: 'HEAD', limit: 16 * 1024, noCache: true });
          } else if (warmType === 'image' || warmType === 'font') {
            const head = await fetchCached(item.url, { ...common, method: 'HEAD', limit: 16 * 1024 });
            const length = Number(String(head.contentLength || '').split(',')[0]) || 0;
            if (!length || length <= CFG.proxyWarmMaxBinaryBytes) await fetchCached(item.url, { ...common, limit: CFG.maxTextBytesPerResource });
          } else {
            await fetchCached(item.url, { ...common, limit: CFG.maxTextBytesPerResource });
          }
        } catch {} finally {
          hostActive.set(host, Math.max(0, (hostActive.get(host) || 1) - 1));
        }
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(CFG.proxyWarmConcurrency, rows.length) }, worker));
  } catch (e) {
    if (e?.code !== 'OPERATION_CANCELLED' && e?.name !== 'AbortError') serverLog('debug', 'BROWSER', `Rendered page warm-up skipped: ${e.message}`);
  } finally {
    clearTimeout(hardTimer);
    if (!controller.signal.aborted) controller.abort();
  }
}

function warmTypeForUrl(url, hintedType = "") {
  const hint = String(hintedType || "").toLowerCase();
  if (hint) return hint;
  const pathOnly = String(url || "").split("?")[0].split("#")[0].toLowerCase();
  if (/\.(?:m?js|cjs)(?:$|\.)/.test(pathOnly)) return "js";
  if (/\.css(?:$|\.)/.test(pathOnly)) return "css";
  if (/\.(?:woff2?|ttf|otf|eot)(?:$|\.)/.test(pathOnly)) return "font";
  if (/\.(?:png|jpe?g|webp|avif|gif|bmp|ico|svg|apng)(?:$|\.)/.test(pathOnly)) return "image";
  if (/\.(?:mp4|webm|m3u8|mpd|m4a|mp3|aac|wav|ogg|ogv)(?:$|\.)/.test(pathOnly)) return "media";
  if (/\.(?:json|xml|txt|map)(?:$|\.)/.test(pathOnly)) return "data";
  return "asset";
}

function extractInlineWarmUrls($, base, add) {
  
  let scanned = 0;
  const scanText = (text, priority = 40) => {
    const src = String(text || "").slice(0, CFG.proxyInlineWarmScanChars);
    scanned += src.length;
    const re = /(?:https?:\/\/[^\s"'`<>\)]+|(?:\/|\.\.?\/)[A-Za-z0-9_~:%@+\-./?=#&;]+(?:\.(?:js|mjs|css|json|wasm|woff2?|ttf|otf|png|jpe?g|webp|avif|svg|ico)(?:\?[^\s"'`<>\)]*)?))/gi;
    let m;
    while ((m = re.exec(src)) && scanned <= CFG.proxyInlineWarmScanChars * 2) add(m[0], priority, warmTypeForUrl(m[0]));
  };
  $("style").each((_, el) => scanText($(el).html() || "", 82));
  $("script:not([src])").each((_, el) => scanText($(el).html() || "", 76));
}

function criticalPreloadHtml(candidates, base, sid) {
  const seen = new Set();
  const rows = [];
  for (const item of candidates) {
    if (!item?.url || seen.has(item.url) || rows.length >= CFG.proxyCriticalPreloadLimit) continue;
    seen.add(item.url);
    const p = String(item.url).toLowerCase().split("?")[0];
    let as = "fetch", attrs = "";
    if (item.type === "css" || /\.css$/i.test(p)) as = "style";
    else if (item.type === "js" || /\.(?:js|mjs|cjs)$/i.test(p)) as = "script";
    else if (item.type === "font" || /\.(?:woff2?|ttf|otf|eot)$/i.test(p)) { as = "font"; attrs = " crossorigin"; }
    else if (item.type === "image" || /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|apng)$/i.test(p)) as = "image";
    else continue;
    const href = makeResourceUrl(item.url, base, sid);
    rows.push(`<link rel="preload" href="${escapeHtml(href)}" as="${as}"${attrs} fetchpriority="high">`);
  }
  return rows.join("");
}

function extractWarmUrls(html, base, sid) {
  const $ = cheerio.load(String(html || ""), { decodeEntities: false });
  const out = new Map();
  const add = (raw, priority = 20, type = "asset") => {
    const u = resolveResource(raw, base);
    if (!u) return;
    const safeType = warmTypeForUrl(u, type);
    const current = out.get(u);
    if (!current || priority > current.priority) out.set(u, { url: u, priority, type: safeType });
  };
  $("link[href]").each((_, el) => {
    const rel = String($(el).attr("rel") || "").toLowerCase();
    const as = String($(el).attr("as") || "").toLowerCase();
    if (rel.includes("stylesheet")) add($(el).attr("href"), 120, "css");
    else if (rel.includes("modulepreload")) add($(el).attr("href"), 115, "js");
    else if (rel.includes("preload")) add($(el).attr("href"), as === "font" ? 118 : as === "script" ? 112 : as === "image" ? 108 : 100, warmTypeForUrl($(el).attr("href"), as));
    else if (rel.includes("icon")) add($(el).attr("href"), 65, "image");
    else if (rel.includes("manifest")) add($(el).attr("href"), 62, "data");
  });
  $("script[src]").each((_, el) => add($(el).attr("src"), String($(el).attr("type") || "").toLowerCase() === "module" ? 108 : 92, "js"));
  $("link[as='style'][href], link[type='text/css'][href]").each((_, el) => add($(el).attr("href"), 116, "css"));
  $("img[src]").each((_, el) => add($(el).attr("src"), 86, "image"));
  $("video[poster]").each((_, el) => add($(el).attr("poster"), 72, "image"));
  $("video[src],audio[src],source[src]").each((_, el) => {
    const tag = String(el.tagName || el.name || "").toLowerCase();
    add($(el).attr("src"), tag === "source" ? 55 : 52, "media");
  });
  $("track[src]").each((_, el) => add($(el).attr("src"), 35, "data"));
  $("[srcset]").each((_, el) => {
    const raw = String($(el).attr("srcset") || "");
    const first = raw.split(/,\s*/)[0]?.trim().split(/\s+/)[0];
    if (first) add(first, 82, "image");
  });
  $("[imagesrcset]").each((_, el) => {
    const first = String($(el).attr("imagesrcset") || "").split(/,\s*/)[0]?.trim().split(/\s+/)[0];
    if (first) add(first, 88, "image");
  });
  $("[data-src],[data-original],[data-lazy-src]").each((_, el) => {
    const raw = $(el).attr("data-src") || $(el).attr("data-original") || $(el).attr("data-lazy-src");
    add(raw, 58, warmTypeForUrl(raw));
  });
  extractInlineWarmUrls($, base, (raw, priority, type) => add(raw, priority, type));
  return [...out.values()]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, Math.min(CFG.proxyWarmLimit, 256))
    .map(item => ({ ...item, sid }));
}

async function warmPageResources(html, base, sid, externalSignal = null) {
  if (CFG.proxyWarmLimit <= 0 || !html || !base) return;
  const candidates = extractWarmUrls(html, base, sid);
  if (!candidates.length) return;

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) return;
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const hardTimer = setTimeout(() => controller.abort(), Math.max(500, CFG.proxyWarmHardMs));

  try {
    const hostActive = new Map();
    const queue = candidates.map((item, index) => ({ ...item, index })).sort((a, b) => b.priority - a.priority || a.index - b.index);
    let cursor = 0;
    const next = () => queue[cursor++];
    const worker = async () => {
      while (!controller.signal.aborted) {
        const item = next();
        if (!item) return;
        const host = hostOf(item.url);
        while (!controller.signal.aborted && (hostActive.get(host) || 0) >= CFG.proxyWarmPerHost) await sleep(2);
        if (controller.signal.aborted) return;
        hostActive.set(host, (hostActive.get(host) || 0) + 1);
        let release = null;
        try {
          release = await proxyWarmSemaphore.acquire(controller.signal);
          const common = {
            sessionId: item.sid, referrer: base,
            accept: item.type === 'css' ? 'text/css,*/*;q=0.05' : item.type === 'js' ? 'application/javascript,text/javascript,*/*;q=0.05' : item.type === 'font' ? 'font/*,*/*;q=0.05' : item.type === 'image' ? 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.05' : '*/*;q=0.05',
            limitForContentType: crawlLimitForContentType,
            timeout: Math.min(CFG.requestTimeoutMs, 6000),
            bodyTimeoutMs: Math.min(CFG.bodyTimeoutMs, 6000),
            retries: item.priority >= 100 ? 0 : 1,
            signal: controller.signal
          };
          if (item.type === 'media') {
            await fetchCached(item.url, { ...common, method: 'HEAD', limit: 16 * 1024, noCache: true });
            continue;
          }
          if (item.type === 'image' || item.type === 'font') {
            const head = await fetchCached(item.url, { ...common, method: 'HEAD', limit: 16 * 1024 });
            const length = Number(String(head.contentLength || '').split(',')[0]) || 0;
            if (length && length > CFG.proxyWarmMaxBinaryBytes) continue;
          }
          await fetchCached(item.url, { ...common, limit: CFG.maxTextBytesPerResource });
        } catch (e) {
          if (e?.code === 'OPERATION_CANCELLED' || e?.name === 'AbortError') return;
        } finally {
          if (release) release();
          hostActive.set(host, Math.max(0, (hostActive.get(host) || 1) - 1));
        }
      }
    };
    const workerCount = Math.min(CFG.proxyWarmConcurrency, CFG.proxyWarmRobots, candidates.length, CFG.leanMode ? 2 : candidates.length);
    await Promise.allSettled(Array.from({ length: Math.max(1, workerCount) }, worker));
  } finally {
    clearTimeout(hardTimer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    if (!controller.signal.aborted) controller.abort();
  }
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


function sameSiteFetchMetadata(targetUrl, sourceUrl, mode) {
  try {
    const target = new URL(targetUrl);
    const source = sourceUrl ? new URL(sourceUrl) : null;
    const sameOriginRequest = !!source && source.origin === target.origin;
    return {
      "sec-fetch-site": source ? (sameOriginRequest ? "same-origin" : "cross-site") : "none",
      "sec-fetch-mode": mode === "view" ? "navigate" : "cors",
      "sec-fetch-dest": mode === "view" ? "document" : "empty",
      ...(mode === "view" ? { "sec-fetch-user": "?1" } : {})
    };
  } catch {
    return {};
  }
}

function forwardProxyBrowserHeaders(req, targetUrl, sourceUrl, mode, baseHeaders = {}) {
  const out = { ...baseHeaders };
  
  
  
  try {
    const target = new URL(targetUrl);
    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(target.hostname)) {
      const siteOrigin = `https://${target.hostname.replace(/^m\./i, "www.")}`;
      if (sourceUrl) out.referer = sourceUrl;
      else if (mode !== "view") out.referer = `${siteOrigin}/`;
      if (String(req.method || "GET").toUpperCase() !== "GET" && String(req.method || "GET").toUpperCase() !== "HEAD") out.origin = siteOrigin;
    }
  } catch {}
  if (CFG.proxyForwardCompatHeaders) {
    
    
    
    
    const allow = [
      "accept-language", "dnt", "cache-control", "pragma", "priority",
      "rsc", "next-action", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "next-url", "x-nextjs-data", "x-middleware-prefetch",
      "x-requested-with", "x-csrf-token", "x-xsrf-token",
      "x-goog-visitor-id", "x-goog-api-format-version", "x-goog-pageid",
      "x-youtube-client-name", "x-youtube-client-version", "x-youtube-bootstrap-logged-in",
      "x-origin", "x-yt-ajax-command", "x-youtube-page-cl", "x-youtube-identity-token"
    ];
    
    
    for (const name of allow) {
      const value = req.get(name);
      if (value) out[name] = String(value).slice(0, 20000);
    }
    for (const name of ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "sec-purpose"]) {
      const value = req.get(name);
      if (value) out[name] = String(value).slice(0, 4000);
    }
    
    
    
    const blocked = /^x-(forwarded-|real-ip$|client-ip$|cluster-client-ip$|veyra-|render-|request-id$|request-start$|amzn-|envoy-|b3-|cloud-trace|original-|http-method-override$)/i;
    for (const [rawName, value] of Object.entries(req.headers || {})) {
      const name = rawName.toLowerCase();
      if (!name.startsWith("x-") || blocked.test(name) || out[name] || value == null) continue;
      out[name] = String(Array.isArray(value) ? value.join(", ") : value).slice(0, 20000);
    }
  }
  if (CFG.proxyForwardClientHints) {
    for (const name of [
      "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-ch-ua-arch",
      "sec-ch-ua-bitness", "sec-ch-ua-full-version", "sec-ch-ua-full-version-list",
      "sec-ch-ua-model", "sec-ch-ua-platform-version", "sec-gpc", "ect", "downlink", "rtt",
      "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"
    ]) {
      const value = req.get(name);
      if (value) out[name] = String(value).slice(0, 2000);
    }
    const synthesized = sameSiteFetchMetadata(targetUrl, sourceUrl, mode);
    for (const [k, v] of Object.entries(synthesized)) if (!out[k]) out[k] = v;
  }
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === null || out[k] === "undefined") delete out[k];
  return out;
}

function proxyRefererCanonical(req) {
  const raw = String(req.get("Referer") || req.get("referer") || "").trim();
  if (!raw) return null;
  return normalizeUrl(raw);
}

function proxyAcceptForResource(req, mode) {
  if (req.get("Accept")) return String(req.get("Accept")).slice(0, 1000);
  return mode === "view"
    ? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
    : "*/*";
}

function looksLikeApiResource(url, accept = "", method = "GET") {
  try {
    const u = new URL(url);
    return method !== "GET" || /json|graphql|youtubei|api\//i.test(`${u.pathname}${u.search}`) || /json|graphql/i.test(accept);
  } catch {
    return false;
  }
}






async function streamOversizeResponse(req, res, result, ctx) {
  let handle = result.stream ? result.stream.take() : null;
  if (!handle) {
    
    
    const again = await fetchBuffer(ctx.canonical, { method: ctx.method, headers: ctx.headers, body: ctx.body, referrer: ctx.referrer, sessionId: ctx.sid, retries: 0, limit: 0, limitForContentType: () => 0, streamOversize: true });
    handle = again.stream ? again.stream.take() : null;
    if (!handle) return respondError(res, 502, "Veyra could not stream this resource.", "PROXY_STREAM_ERROR");
    result = again;
  }
  const type = result.contentType || "application/octet-stream";
  res.setHeader("content-type", type);
  res.setHeader("cache-control", ctx.download ? "no-store" : "public, max-age=60");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  if (ctx.download) res.setHeader("content-disposition", `attachment; filename="${safeDownloadFilename(result.finalUrl || ctx.canonical, type)}"`);
  if (result.contentRange) res.setHeader("content-range", result.contentRange);
  if (result.acceptRanges) res.setHeader("accept-ranges", result.acceptRanges);
  
  
  
  
  if (result.contentLength) res.setHeader("content-length", result.contentLength);
  if (result.etag) res.setHeader("ETag", result.etag);
  if (result.lastModified) res.setHeader("Last-Modified", result.lastModified);
  res.setHeader("X-Veyra-Canonical-URL", result.finalUrl || ctx.canonical);
  res.setHeader("X-Veyra-Session-ID", ctx.sid);
  res.setHeader("X-Veyra-Content-Type", type);
  res.setHeader("X-Veyra-Proxy-Mode", "resource-stream");
  res.status(result.status >= 300 && result.status < 400 ? 200 : result.status);
  let closed = false;
  res.on("close", () => { if (!res.writableFinished) { closed = true; try { handle.reader?.cancel().catch(() => {}); } catch {} } });
  const write = (buf) => new Promise((resolve) => { if (closed) return resolve(); if (res.write(buf)) resolve(); else res.once("drain", resolve); });
  try {
    for (const chunk of handle.head) await write(chunk);
    if (handle.reader) {
      while (!closed) {
        const { done, value } = await withTimeout(handle.reader.read(), CFG.bodyTimeoutMs, "Response body timed out.");
        if (done) break;
        await write(Buffer.from(value));
      }
    }
  } catch {
    try { handle.reader?.cancel().catch(() => {}); } catch {}
    if (!res.writableEnded) res.destroy();
    return;
  }
  if (!res.writableEnded) res.end();
}




const PROXY_OWN_PARAMS = new Set(["url", "target", "u", "sid", "from", "download"]);
function mergeStrayProxyParams(req, canonical) {
  if (!canonical || !req.originalUrl) return canonical;
  let extra;
  try { extra = new URL(req.originalUrl, "http://x").searchParams; } catch { return canonical; }
  let target; try { target = new URL(canonical); } catch { return canonical; }
  let changed = false;
  for (const [k, v] of extra) {
    if (PROXY_OWN_PARAMS.has(k) || /^__veyra/i.test(k)) continue;
    if (target.searchParams.getAll(k).includes(v)) continue;
    target.searchParams.set(k, v); changed = true;
  }
  return changed ? target.href : canonical;
}

async function proxyRequest(req, res, mode) {
  const canonical = mergeStrayProxyParams(req, firstValidUrl([req.query.url, req.query.target, req.query.u], req.get('Origin') || undefined)) || proxyRefererCanonical(req);
  const download = String(req.query.download || "") === "1";
  if (!canonical) return respondError(res, 400, "Missing or invalid public HTTP(S) URL.", "INVALID_URL");
  await assertPublicUrl(canonical);
  const accept = proxyAcceptForResource(req, mode);
  const method = req.method.toUpperCase();
  const mediaRequest = mode === "resource" && (
    !!req.get("Range") || /video|audio/i.test(accept) || /googlevideo\.com/i.test(canonical) || /videoplayback/i.test(canonical)
  );
  if (!safeMethod(method)) return respondError(res, 405, "Unsupported proxy method.", "PROXY_METHOD_NOT_ALLOWED");
  const body = method === "GET" || method === "HEAD" ? undefined : (() => {
    if (Buffer.isBuffer(req.body)) return req.body.length ? req.body : undefined;
    if (req.is("application/x-www-form-urlencoded")) return new URLSearchParams(req.body || {}).toString();
    if (req.is("application/json")) return JSON.stringify(req.body || {});
    return typeof req.body === "string" ? req.body : undefined;
  })();
  if (body && Buffer.byteLength(body) > CFG.maxProxyBodyBytes) return respondError(res, 413, "Proxy request body is too large.", "PROXY_BODY_TOO_LARGE");
  const sourceUrl = (() => { try { const u = new URL(String(req.query.from || "")); return /^https?:$/.test(u.protocol) ? u.href : ""; } catch { return ""; } })();
  const referrer = sourceUrl || "";
  const sourceOrigin = sourceUrl ? new URL(sourceUrl).origin : "";
  const sid = normalizeSessionId(req.query.sid);
  if (sessionManager.checkLimit(sid)) return sendSessionExpired(req, res, mode, sid);
  
  
  
  
  
  if (mode === "view") {
    try {
      const u = new URL(canonical);
      if (/^(?:[a-z0-9-]+\.)?accounts\.google\.com$/i.test(u.hostname) && /\/ServiceLogin/i.test(u.pathname) && (u.searchParams.get("passive") === "true" || u.searchParams.has("uilel"))) {
        res.setHeader("X-Veyra-Soft-Blocked", "passive-signin");
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).type("html").send("<!doctype html><title></title>");
      }
    } catch {}
  }
  { const rec = sessionManager.touch(sid); const exp = sessionManager.expiresAt(rec); if (exp) res.setHeader("X-Veyra-Session-Expires", new Date(exp).toISOString());
    
    if (rec.prefs?.blockTrackers && isTrackerHost(new URL(canonical).hostname)) {
      rec.blocked = (rec.blocked || 0) + 1;
      res.setHeader("X-Veyra-Blocked", "tracker"); res.setHeader("Cache-Control", "no-store");
      if (mode === "view") return res.status(200).type("html").send("<!doctype html><title></title>");
      return res.status(204).end();
    } }
  const headers = forwardProxyBrowserHeaders(req, canonical, sourceUrl, mode, {
    accept,
    
    
    ...(req.get("User-Agent") ? { "user-agent": String(req.get("User-Agent")).slice(0, 2000) } : {}),
    ...(req.get("Accept-Language") ? { "accept-language": String(req.get("Accept-Language")).slice(0, 1000) } : {}),
    ...(req.get("Upgrade-Insecure-Requests") ? { "upgrade-insecure-requests": String(req.get("Upgrade-Insecure-Requests")).slice(0, 20) } : {}),
    ...(req.get("Content-Type") ? { "content-type": String(req.get("Content-Type")).slice(0, 500) } : {}),
    ...(req.get("Authorization") ? { authorization: String(req.get("Authorization")).slice(0, 20000) } : {}),
    ...(req.get("Range") ? { range: String(req.get("Range")).slice(0, 200) } : {}),
    ...(referrer ? { referer: referrer } : {}),
    
    ...(sourceOrigin && method !== "GET" && method !== "HEAD" ? { origin: sourceOrigin } : {})
  });
  const limitForContentType = (ct) => {
    const type = String(ct || "").toLowerCase();
    if (type.includes("text/html") || type.includes("application/xhtml") || type.includes("text/css") || /javascript|ecmascript|json|xml|x-component|react-server/i.test(type)) return CFG.maxProxyTextBytes;
    if (type.startsWith("image/") || type.includes("svg")) return CFG.maxProxyImageBytes;
    if (type.startsWith("video/") || type.startsWith("audio/") || type.includes("application/pdf")) return CFG.maxProxyMediaBytes;
    return CFG.maxProxyOtherBytes;
  };
  try {
    const browserKey = `${method} ${canonical}|ref=${referrer}|sid=${sid}|range=${headers.range || ""}|body=${body ? require("crypto").createHash("sha1").update(body).digest("hex") : ""}`;
    const browserPriority = mode === "view" ? 1000 : (looksLikeApiResource(canonical, accept, method) ? 980 : (/css|javascript|font|svg/i.test(accept) ? 900 : /image/i.test(accept) ? 800 : 700));
    const isNextRsc = /text\/x-component|text\/x-react-server-components/i.test(String(accept || "")) || !!req.get("RSC") || !!req.get("Next-Router-State-Tree") || !!req.get("Next-Action") || !!req.get("Next-Url");
    const requestLimit = mediaRequest ? CFG.maxProxyMediaBytes : (looksLikeApiResource(canonical, accept, method) || isNextRsc ? CFG.proxyApiBodyBytes : CFG.maxProxyBodyBytes);
    const retries = mediaRequest ? 1 : (looksLikeApiResource(canonical, accept, method) || isNextRsc ? CFG.proxyApiRetries : CFG.maxRetries);
    const requestUserAgent = req.get("User-Agent") ? String(req.get("User-Agent")).slice(0, 2000) : "";
    const hasAuthorization = !!req.get("Authorization");
    const result = await browserScheduler.request(browserKey, () => fetchCached(canonical, { method, headers, body, referrer, sessionId: sid, requestId: req.veyraRequestId, userAgent: requestUserAgent || undefined, limit: requestLimit, retries, limitForContentType, noCache: method !== "GET" || mediaRequest || hasAuthorization || isNextRsc, timeout: mediaRequest ? CFG.mediaRequestTimeoutMs : CFG.requestTimeoutMs, bodyTimeoutMs: mediaRequest ? CFG.mediaBodyTimeoutMs : CFG.bodyTimeoutMs, streamOversize: mode === "resource" }), { priority: browserPriority + (mediaRequest ? 30 : 0), host: hostOf(canonical), url: canonical });
  
  
  
  const streamable = mode === "resource" || !/html|xhtml/i.test(String(result.contentType || ""));
  if (result.tooLarge && streamable && CFG.proxyStreamOversize && !(download && result.bytes > CFG.maxDownloadBytes)) {
    if (/javascript|ecmascript/i.test(result.contentType || "")) noteScriptDir(sid, result.finalUrl || canonical);
    return streamOversizeResponse(req, res, result, { canonical, method, headers, body, referrer, sid, download });
  }
  if (result.stream) result.stream.cancel();
  if (result.tooLarge || (download && result.bytes > CFG.maxDownloadBytes)) return respondError(res, 413, "The upstream response exceeds Veyra's safety limit.", "RESPONSE_TOO_LARGE");
  const responseCacheControl = String(result.cacheControl || "").toLowerCase();
  const responseVary = String(result.vary || "").toLowerCase();
  const requestHasAuth = !!req.get("Authorization");
  const privateResponse = /(?:^|[\s,])(?:private|no-store)(?:[=\s,]|$)/i.test(responseCacheControl) || /(?:^|[\s,])cookie(?:[\s,]|$)/i.test(responseVary);
  const staticResource = mode === "resource" && !download && !result.setCookieHeader && !requestHasAuth && !privateResponse && !cookieHeader(sid, canonical) && /^(?:text\/css|application\/(?:javascript|x-javascript)|text\/javascript|image\/|font\/)/i.test(result.contentType || "");
  const upstreamHeaders = {
    "content-type": result.contentType || (mode === "view" ? "text/html; charset=utf-8" : "application/octet-stream"),
    "cache-control": download ? "no-store" : mode === "view" ? "no-store" : staticResource ? "public, max-age=60, stale-while-revalidate=300" : "public, max-age=15",
    ...(download ? { "content-disposition": `attachment; filename="${safeDownloadFilename(result.finalUrl || canonical, result.contentType)}"` } : {}),
    "x-content-type-options": "nosniff",
    "referrer-policy": mode === "view" ? "same-origin" : "no-referrer",
    ...(result.contentRange ? { "content-range": result.contentRange } : {}),
    ...(result.acceptRanges ? { "accept-ranges": result.acceptRanges } : {})
  };
  const challenge = mode === "view" ? detectChallenge(result.body.toString("utf8"), result.contentType, result.status, { server: result.serverHeader, "cf-mitigated": result.cfMitigated, finalUrl: result.finalUrl }) : null;
  if (challenge) {
    res.setHeader("X-Veyra-Challenge", "true");
    res.setHeader("X-Veyra-Canonical-URL", canonical);
    return res.status(200).type("html").send(challengeFallbackHtml(canonical, challenge, sid));
  }
  if (mode === "resource" && /javascript|ecmascript/i.test(result.contentType || "")) noteScriptDir(sid, result.finalUrl || canonical);
  let payload = result.body;
  let fullPageEnhanced = false;
  try {
    if (!download && mode === "view" && (/html|xhtml|^$/.test(result.contentType.toLowerCase()))) {
      
      
      
      
      
      
      const enhanced = fullPage.enhanceFullPage(payload.toString("utf8"), result.finalUrl || canonical);
      if (enhanced.enhanced) { payload = Buffer.from(enhanced.html, "utf8"); fullPageEnhanced = true; }
      payload = Buffer.from(await rewriteOffThread("rewriteHtml", payload.toString("utf8"), [result.finalUrl || canonical, sid], rewriteHtml), "utf8");
    }
    else if (!download && mode === "resource" && result.contentType.toLowerCase().includes("text/css")) payload = Buffer.from(await rewriteOffThread("rewriteCss", payload.toString("utf8"), [result.finalUrl || canonical, sid], rewriteCssText), "utf8");
    else if (!download && mode === "resource" && /javascript|ecmascript/.test(result.contentType.toLowerCase())) payload = Buffer.from(await rewriteOffThread("rewriteJs", payload.toString("utf8"), [result.finalUrl || canonical, sid], rewriteJsText), "utf8");
    else if (!download && mode === "resource" && /mpegurl|dash\+xml/i.test(result.contentType.toLowerCase())) payload = Buffer.from(rewriteMediaManifest(payload.toString("utf8"), result.finalUrl || canonical, sid), "utf8");
  } catch (rewriteErr) {
    
    
    
    
    recordRewriteFailure(result.finalUrl || canonical, mode, rewriteErr);
    payload = result.body;
  }
  for (const [k,v] of Object.entries(upstreamHeaders)) if (v) res.setHeader(k, v);
  res.setHeader("X-Veyra-Canonical-URL", result.finalUrl || canonical);
  res.setHeader("X-Veyra-Session-ID", sid);
  res.setHeader("X-Veyra-Content-Type", result.contentType || "application/octet-stream");
  res.setHeader("X-Veyra-Proxy-Mode", mode);
  if (fullPageEnhanced) res.setHeader("X-Veyra-Full-Page", "1");
  if (result.etag) res.setHeader("ETag", result.etag);
  if (result.lastModified) res.setHeader("Last-Modified", result.lastModified);
  const outputStatus = (result.status >= 300 && result.status < 400) ? 200 : result.status;
  const transformedText = (mode === "view" && /html|xhtml|^$/i.test(result.contentType || "")) || (mode === "resource" && /(?:text\/css|javascript|ecmascript)/i.test(result.contentType || ""));
  
  
  if (!transformedText && !result.truncated) {
    const outLength = payload && payload.length ? payload.length : Number(result.contentLength) || 0;
    if (outLength) res.setHeader("content-length", outLength);
  }
  res.status(outputStatus).send(payload);
  if (mode === "view" && !result.truncated && !result.tooLarge && /html|xhtml|^$/i.test(result.contentType || "")) {
    void warmPageResources(result.body.toString("utf8"), result.finalUrl || canonical, sid);
  }
  } finally {
    
  }
}

app.get("/api/form-get/:target/:sid", async (req, res) => {
  try {
    const target = normalizeUrl(decodePathToken(req.params.target || ""));
    if (!target) return respondError(res, 400, "Invalid Veyra GET form target.", "INVALID_FORM_TARGET");
    await assertPublicUrl(target);
    const u = new URL(target);
    
    
    
    for (const [key, value] of Object.entries(req.query || {})) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (typeof item === "string") u.searchParams.append(String(key), item);
      }
    }
    req.query.url = u.href;
    req.query.sid = normalizeSessionId(decodePathToken(req.params.sid || ""));
    const referer = proxyRefererCanonical(req);
    if (referer) req.query.from = referer;
    await proxyRequest(req, res, "view");
  } catch (e) {
    respondError(res, 502, `Veyra could not submit this form: ${e.message}`, "PROXY_FORM_GET_ERROR", { requestId: req.veyraRequestId });
  }
});
app.get("/api/view", async (req, res) => { try { await proxyRequest(req, res, "view"); } catch (e) {
  
  
  const snapSid = normalizeSessionId(req.query.sid);
  const snapUrl = mergeStrayProxyParams(req, firstValidUrl([req.query.url, req.query.target, req.query.u], req.get('Origin') || undefined)) || proxyRefererCanonical(req);
  if (snapshotStore && snapSid && snapUrl) {
    const snap = await snapshotStore.get(snapSid, snapUrl);
    if (snap) {
      res.setHeader("X-Veyra-Snapshot", "1");
      res.setHeader("X-Veyra-Fast-Limited", "1");
      res.setHeader("X-Veyra-Canonical-URL", snap.url);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).type("html").send(snap.html);
    }
  }
  const message = e.upstreamMessage || e.message;
  const upstreamCode = e.upstreamCode || networkErrorCode(e) || null;
  const publicCode = e.code === "VPN_KILL_SWITCH" ? "VPN_KILL_SWITCH" : /^UPSTREAM_[A-Z0-9_]+$/.test(String(e.code || "")) ? e.code : "PROXY_VIEW_ERROR";
  serverLog("warn", "PROXY", `View failed for ${sanitizeLogUrl(req.query?.url || "")} — ${message}`, { requestId: req.veyraRequestId, code: publicCode, upstreamCode, upstreamPhase: e.upstreamPhase || null, targetHost: e.upstreamHost || hostOf(req.query?.url || "") });
  respondError(res, e.code === "VPN_KILL_SWITCH" ? 503 : 502, `Veyra could not load this page: ${message}`, publicCode, { requestId: req.veyraRequestId, legacyCode: "PROXY_VIEW_ERROR", upstreamCode, upstreamPhase: e.upstreamPhase || null });
} });
app.post("/api/view", async (req, res) => { try { await proxyRequest(req, res, "view"); } catch (e) { respondError(res, 502, `Veyra could not submit this form: ${e.message}`, "PROXY_FORM_ERROR", { requestId: req.veyraRequestId }); } });
app.get("/api/resource", async (req, res) => { try { await proxyRequest(req, res, "resource"); } catch (e) {
  const upstreamCode = e.upstreamCode || networkErrorCode(e) || null;
  const code = /^UPSTREAM_[A-Z0-9_]+$/.test(String(e.code || "")) ? e.code : "PROXY_RESOURCE_ERROR";
  respondError(res, e.code === "VPN_KILL_SWITCH" ? 503 : 502, `Veyra resource error: ${e.upstreamMessage || e.message}`, code, { requestId: req.veyraRequestId, upstreamCode, upstreamPhase: e.upstreamPhase || null, targetHost: e.upstreamHost || hostOf(req.query?.url || "") });
} });
app.get("/api/download", async (req, res) => { try { req.query.download = "1"; await proxyRequest(req, res, "resource"); } catch (e) { respondError(res, 502, `Veyra download error: ${e.message}`, "DOWNLOAD_ERROR", { requestId: req.veyraRequestId }); } });
app.post("/api/resource", async (req, res) => { try { await proxyRequest(req, res, "resource"); } catch (e) { respondError(res, 502, `Veyra resource request failed: ${e.message}`, "PROXY_RESOURCE_POST_ERROR", { requestId: req.veyraRequestId }); } });
for (const method of ["put","patch","delete","head","options"]) app[method]("/api/resource", async (req,res)=>{ try { await proxyRequest(req,res,"resource"); } catch(e) { respondError(res,502,`Veyra resource ${method.toUpperCase()} request failed: ${e.message}`,"PROXY_RESOURCE_METHOD_ERROR",{requestId:req.veyraRequestId}); } });

const OPEN_ENGINE_MODES = new Set(["auto", "proxy", "crawler", "exhaustive", "browser", "combined"]);
function normalizeOpenEngineMode(value) {
  const raw = String(value || "auto").trim().toLowerCase();
  return OPEN_ENGINE_MODES.has(raw) ? raw : "auto";
}
function shouldStartCrawlerForEngineMode(mode) {
  return mode === "auto" || mode === "crawler" || mode === "exhaustive" || mode === "combined";
}

app.post("/api/open", async (req, res) => {
  try {
    const root = normalizeUrl(String(req.body?.url || "")); if (!root) return respondError(res, 400, "Please provide a valid public HTTP(S) URL.", "INVALID_URL");
    await assertPublicUrl(root);
    const engineMode = normalizeOpenEngineMode(req.body?.engineMode);
    const crawlerEnabled = shouldStartCrawlerForEngineMode(engineMode);
    const oldId = activeByRoot.get(root); const old = oldId && jobs.get(oldId);
    const wantsPageAccelerator = engineMode !== "exhaustive";
    
    
    
    if (crawlerEnabled && old && !old.done && !old.stopRequested && (!CFG.crawlerPageAccelerator || old.pageAccelerator)) return res.status(202).json({ jobId: old.id, url: root, viewUrl: makeViewUrl(root), engineMode, crawlerEnabled: true });
    if (crawlerEnabled && !old && mongoStore.enabled && engineMode !== "exhaustive") {
      const cached = await mongoStore.getLatestCrawlSummary(root);
      if (cached) return res.status(200).json({ ok: true, jobId: null, url: root, viewUrl: makeViewUrl(root), state: "cached", cached: true, cachedAt: cached.finishedAt || cached.createdAt || null, counts: cached.counts || {}, engineMode, crawlerEnabled: true });
    }
    const openSid = String(req.body?.sessionId || req.body?.sid || "");
    if (openSid && sessionManager.checkLimit(openSid)) return respondError(res, 410, "This Veyra session reached its time limit and was deleted.", "SESSION_EXPIRED");
    if (!crawlerEnabled) return res.status(200).json({ ok: true, jobId: null, url: root, viewUrl: makeViewUrl(root), state: "disabled", engineMode, crawlerEnabled: false });
    
    
    const fullSiteCrawl = engineMode === "exhaustive";
    const job = createJob(root, { pageAccelerator: !fullSiteCrawl && CFG.crawlerPageAccelerator });
    if (/^[A-Za-z0-9_-]{16,80}$/.test(openSid)) job.sessionId = openSid;
    let state;
    try { state = scheduleCrawl(job); } catch (e) { return respondError(res, 503, e.message, e.code || "CRAWLER_CAPACITY_BUSY", { maxActiveJobs: effectiveMaxActiveJobs(), queued: crawlQueue.length }); }
    jobs.set(job.id, job); activeByRoot.set(root, job.id);
    jobLog(job, "info", state === "running" ? "Background crawl started." : `Background crawl queued (position ${job.queuePosition}).`);
    res.status(202).json({ jobId: job.id, url: root, viewUrl: makeViewUrl(root), state: "queued", scheduler: state, queuePosition: job.queuePosition || 0, engineMode, crawlerEnabled: true });
  } catch (e) { respondError(res, 400, e.message, "OPEN_FAILED"); }
});

app.get("/api/crawl/:id", (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); res.json(publicJob(j)); });
app.post("/api/crawl/:id/stop", (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); if (!j.started && !j.done) { dequeueCrawl(j); j.stopRequested = true; j.stopReason = "user"; j.done = true; j.finishedAt = now(); j.status = "stopped"; j.statusText = "Removed from queue."; return res.json(publicJob(j)); } j.stopRequested = true; j.stopReason = "user"; j.status = "stopping"; j.statusText = "Stopping…"; j.controller.abort(); jobLog(j, "warn", "Stop requested."); res.json({ ok: true }); });
app.get("/api/crawl/:id/robots", requireAdmin, (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); if (!j.robotPool) return res.json({ summary: { logicalRobots: j.robotFleet || CFG.logicalRobots, activeRobots: 0, multitaskingRobots: 0, idleRobots: j.robotFleet || CFG.logicalRobots, queuedRobotTasks: 0, globalPageQueue: j.pageFrontier.size, globalResourceQueue: j.resourceFrontier.size, networkActive: fetchSemaphore.active, networkLimit: CFG.maxActiveFetches, helpRequests: 0, helpAccepted: 0, helpDeclined: 0, helpGiven: 0 }, robots: [], events: [] }); const limit = Math.min(100, Math.max(1, Number(req.query.limit || 48) || 48)); res.json(j.robotPool.report(limit)); });
app.get("/api/crawl/:id/resources", (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); res.json({ resources: j.resources.map(r => ({ id: r.id, url: r.url, requestedUrl: r.requestedUrl, type: r.type, status: r.status, contentType: r.contentType, bytes: r.bytes, bytesLabel: r.bytesLabel, truncated: r.truncated, sourceId: r.sourceId })) }); });
app.get("/api/crawl/:id/source/:resourceId", async (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); const id = Number(req.params.resourceId); const r = j.resources[id]; if (!r) return respondError(res, 404, "Resource not found.", "RESOURCE_NOT_FOUND"); res.json({ id: r.id, url: r.url, type: r.type, source: await sourceStore.read(j, r) }); });
app.get("/api/crawl/:id/links", (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); const offset = Math.max(0, Number(req.query.offset || 0) || 0); const limit = Math.min(10000, Math.max(1, Number(req.query.limit || 1000) || 1000)); res.json({ total: j.links.length, offset, limit, links: j.links.slice(offset, offset + limit) }); });
app.get("/api/crawl/:id/export", (req, res) => { const j = jobs.get(req.params.id); if (!j) return respondError(res, 404, "Job not found.", "JOB_NOT_FOUND"); res.setHeader("content-type", "application/json; charset=utf-8"); res.setHeader("content-disposition", `attachment; filename="veyra-${j.id}.json"`); res.send(JSON.stringify({ id:j.id, root:j.root, createdAt:j.createdAt, finishedAt:j.finishedAt, status:j.status, counts:j.counts, links:j.links, resources:j.resources.map(r => ({ id:r.id,url:r.url,type:r.type,status:r.status,contentType:r.contentType,bytes:r.bytes,truncated:r.truncated,redirectChain:r.redirectChain })) }, null, 2)); });












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
  { group: "Core service", key: "resourceProfile", label: "Resource profile", kind: "enum", names: ["RESOURCE_PROFILE"], fallback: "auto", allowed: ["auto", "free", "balanced", "high"] },
  { group: "Core service", key: "memoryLimitMb", label: "Memory limit (MB)", kind: "number", names: ["MEMORY_LIMIT_MB"], fallback: detectedMemoryMb() || 0, min: 0, max: 262144 },
  { group: "Frontend / CORS", key: "frontendOrigin", label: "Allowed frontend origin(s)", kind: "csv", names: ["FRONTEND_ORIGIN"], fallback: ["*"] },
  { group: "Frontend / CORS", key: "publicApiOrigin", label: "Public API origin (for rewritten pages)", kind: "string", names: ["PUBLIC_API_ORIGIN"], fallback: "" },
  { group: "Frontend / CORS", key: "userAgent", label: "Crawler user agent", kind: "string", names: ["VEYRA_USER_AGENT"], fallback: "VeyraBrowseCrawler/8.0 (+https://github.com/)" },
  { group: "Crawler concurrency", key: "logicalRobots", label: "Logical crawler robots", kind: "number", names: ["CRAWLER_ROBOTS"], fallback: 10000, min: 1, max: 10000 },
  { group: "Robot mesh", key: "robotWorksetSize", label: "Robot workset size", kind: "number", names: ["ROBOT_WORKSET_SIZE"], fallback: 10000, min: 8, max: 10000 },
  { group: "Robot mesh", key: "robotQueueCapacity", label: "Robot local queue capacity", kind: "number", names: ["ROBOT_QUEUE_CAPACITY"], fallback: 8, min: 2, max: 32 },
  { group: "Robot mesh", key: "robotStealBatch", label: "Help steal batch", kind: "number", names: ["ROBOT_STEAL_BATCH"], fallback: 4, min: 1, max: 8 },
  { group: "Robot mesh", key: "robotStealOnIdle", label: "Idle robots request help", kind: "bool", names: ["ROBOT_STEAL_ON_IDLE"], fallback: true },
  { group: "Robot mesh", key: "robotBundleSize", label: "Tasks bundled/robot", kind: "number", names: ["ROBOT_BUNDLE_SIZE"], fallback: 4, min: 1, max: 8 },
  { group: "Robot mesh", key: "robotDispatchBatch", label: "Robot dispatch batch", kind: "number", names: ["ROBOT_DISPATCH_BATCH"], fallback: 1024, min: 64, max: 8192 },
  { group: "Robot mesh", key: "robotHelpMaxInFlight", label: "Help requests in flight", kind: "number", names: ["ROBOT_HELP_MAX_INFLIGHT"], fallback: 64, min: 1, max: 256 },
  { group: "Crawler concurrency", key: "adaptiveHostConcurrency", label: "Adaptive per-host concurrency", kind: "bool", names: ["ADAPTIVE_HOST_CONCURRENCY"], fallback: true },
  { group: "Crawler concurrency", key: "minPerHostConcurrency", label: "Minimum per-host concurrency", kind: "number", names: ["MIN_PER_HOST_CONCURRENCY"], fallback: 2, min: 1, max: 32 },
  { group: "Crawler concurrency", key: "criticalResourceBudget", label: "Critical resource budget", kind: "number", names: ["CRITICAL_RESOURCE_BUDGET"], fallback: 48, min: 8, max: 256 },
  { group: "Crawler discovery", key: "maxDiscoveryPerPage", label: "Max discovered URLs/page", kind: "number", names: ["MAX_DISCOVERY_PER_PAGE"], fallback: 5000, min: 100, max: 20000 },
  { group: "Crawler discovery", key: "maxScriptDiscovery", label: "Max script URL discoveries", kind: "number", names: ["MAX_SCRIPT_DISCOVERY"], fallback: 4000, min: 100, max: 20000 },
  { group: "Crawler discovery", key: "maxJsonUrlDiscovery", label: "Max JSON URL discoveries", kind: "number", names: ["MAX_JSON_URL_DISCOVERY"], fallback: 2000, min: 50, max: 10000 },
  { group: "Crawler discovery", key: "maxBroadScanChars", label: "Broad scan characters/page", kind: "number", names: ["MAX_BROAD_SCAN_CHARS"], fallback: 1500000, min: 10000, max: 10000000 },
  { group: "Crawler discovery", key: "maxSrcsetCandidates", label: "Max srcset candidates", kind: "number", names: ["MAX_SRCSET_CANDIDATES"], fallback: 100, min: 10, max: 500 },
  { group: "Crawler discovery", key: "maxBrowserDiscovered", label: "Max browser-discovered URLs", kind: "number", names: ["MAX_BROWSER_DISCOVERED"], fallback: 2500, min: 100, max: 20000 },
  { group: "Crawler discovery", key: "maxBrowserDiscoveredHosts", label: "Max browser-discovered hosts", kind: "number", names: ["MAX_BROWSER_DISCOVERED_HOSTS"], fallback: 24, min: 2, max: 100 },
  { group: "Page accelerator", key: "crawlerPageWarmMs", label: "Page accelerator warm window (ms)", kind: "number", names: ["CRAWLER_PAGE_WARM_MS"], fallback: 3500, min: 1500, max: 60000 },
  { group: "Page accelerator", key: "crawlerPageHardMs", label: "Page accelerator hard wall (ms)", kind: "number", names: ["CRAWLER_PAGE_HARD_MS"], fallback: 5000, min: 2000, max: 60000 },
  { group: "Page accelerator", key: "proxyWarmHardMs", label: "Proxy warm hard wall (ms)", kind: "number", names: ["PROXY_WARM_HARD_MS"], fallback: 3500, min: 1500, max: 30000 },
  { group: "Media", key: "mediaRequestTimeoutMs", label: "Media request timeout (ms)", kind: "number", names: ["MEDIA_REQUEST_TIMEOUT_MS"], fallback: 20000, min: 3000, max: 120000 },
  { group: "Media", key: "mediaBodyTimeoutMs", label: "Media body timeout (ms)", kind: "number", names: ["MEDIA_BODY_TIMEOUT_MS"], fallback: 12000, min: 2000, max: 120000 },
  { group: "Crawler discovery", key: "sitemapConcurrency", label: "Sitemap concurrency", kind: "number", names: ["SITEMAP_CONCURRENCY"], fallback: 8, min: 1, max: 32 },
  { group: "Browser warming", key: "initialResourceBudget", label: "Initial resource warm budget", kind: "number", names: ["INITIAL_RESOURCE_BUDGET"], fallback: 64, min: 16, max: 256 },
  { group: "Crawler concurrency", key: "maxActiveFetches", label: "Active network fetch slots", kind: "number", names: ["MAX_ACTIVE_FETCHES", "MAX_GLOBAL_CONCURRENCY"], fallback: 128, min: 1, max: 256, note: "This is the real simultaneous upstream-request ceiling; CRAWLER_ROBOTS is a larger logical fleet." },
  { group: "Crawler concurrency", key: "perHostConcurrency", label: "Per-host concurrency", kind: "number", names: ["CRAWLER_PER_HOST_CONCURRENCY", "MAX_PER_HOST_CONCURRENCY"], fallback: 8, min: 1, max: 32, note: "Per-origin safety cap; robots.txt Crawl-delay still applies." },
  { group: "Crawler cooperation", key: "robotTaskCapacity", label: "Tasks queued/robot", kind: "number", names: ["ROBOT_TASK_CAPACITY"], fallback: 4, min: 1, max: 16 },
  { group: "Crawler cooperation", key: "robotActiveTasks", label: "Active tasks/robot", kind: "number", names: ["ROBOT_ACTIVE_TASKS"], fallback: 2, min: 1, max: 8 },
  { group: "Crawler cooperation", key: "robotHelpEnabled", label: "Robot help enabled", kind: "bool", names: ["ROBOT_HELP_ENABLED"], fallback: true },
  { group: "Crawler cooperation", key: "robotHelpThreshold", label: "Help backlog threshold", kind: "number", names: ["ROBOT_HELP_THRESHOLD"], fallback: 2, min: 1, max: 16 },
  { group: "Crawler cooperation", key: "robotHelpCooldownMs", label: "Help cooldown (ms)", kind: "number", names: ["ROBOT_HELP_COOLDOWN_MS"], fallback: 250, min: 0, max: 10000 },
  { group: "Crawler cooperation", key: "robotHelpScanLimit", label: "Robots inspected/request", kind: "number", names: ["ROBOT_HELP_SCAN_LIMIT"], fallback: 24, min: 1, max: 128 },
  { group: "Crawler concurrency", key: "hostSuccessRamp", label: "Host success ramp", kind: "number", names: ["HOST_SUCCESS_RAMP"], fallback: 4, min: 1, max: 100 },
  { group: "Crawler concurrency", key: "hostErrorPenalty", label: "Host error penalty", kind: "number", names: ["HOST_ERROR_PENALTY"], fallback: 2, min: 1, max: 10 },
  { group: "Crawler discovery", key: "maxCrossOriginResources", label: "Max cross-origin resources", kind: "number", names: ["MAX_CROSS_ORIGIN_RESOURCES"], fallback: 250, min: 0, max: 10000 },
  { group: "Crawler discovery", key: "filterTemplateUrls", label: "Filter template URLs", kind: "bool", names: ["FILTER_TEMPLATE_URLS"], fallback: true },
  { group: "Crawler discovery", key: "maxDiscoveredUrlLength", label: "Max discovered URL length", kind: "number", names: ["MAX_DISCOVERED_URL_LENGTH"], fallback: 4096, min: 256, max: 20000 },
  { group: "Crawler discovery", key: "skipLowValueThirdParty", label: "Skip low-value third party", kind: "bool", names: ["SKIP_LOW_VALUE_THIRD_PARTY"], fallback: true },
  { group: "Proxy", key: "proxyForwardCompatHeaders", label: "Forward compatibility headers", kind: "bool", names: ["PROXY_FORWARD_COMPAT_HEADERS"], fallback: true },
  { group: "Proxy", key: "proxyForwardClientHints", label: "Forward client hints", kind: "bool", names: ["PROXY_FORWARD_CLIENT_HINTS"], fallback: true },
  { group: "Proxy", key: "proxyRelativeFallback", label: "Recover relative paths via Referer", kind: "bool", names: ["PROXY_RELATIVE_FALLBACK"], fallback: true },
  { group: "Proxy", key: "proxyStreamOversize", label: "Stream oversize resources", kind: "bool", names: ["PROXY_STREAM_OVERSIZE"], fallback: true },
  { group: "Proxy", key: "proxyApiBodyBytes", label: "API body limit", kind: "number", names: ["PROXY_API_BODY_BYTES"], fallback: 4194304, min: 65536, max: 33554432 },
  { group: "Proxy", key: "proxyApiRetries", label: "API retries", kind: "number", names: ["PROXY_API_RETRIES"], fallback: 1, min: 0, max: 3 },
  { group: "Proxy", key: "proxyJsHeavyThreshold", label: "JS-heavy threshold", kind: "number", names: ["PROXY_JS_HEAVY_THRESHOLD"], fallback: 4, min: 1, max: 20 },
  { group: "VPN", key: "vpnEnabled", label: "Veyra VPN enabled", kind: "bool", names: ["VPN_ENABLED"], fallback: false },
  { group: "VPN", key: "vpnMode", label: "VPN mode", kind: "enum", names: ["VPN_MODE"], fallback: "proxy", allowed: ["proxy"] },
  { group: "VPN", key: "vpnDefaultProfile", label: "Default VPN profile", kind: "string", names: ["VPN_DEFAULT_PROFILE"], fallback: "" },
  { group: "VPN", key: "vpnProxyServer", label: "VPN proxy server", kind: "string", names: ["VPN_PROXY_SERVER"], fallback: "", secret: true },
  { group: "VPN", key: "vpnProfileId", label: "Default profile id", kind: "string", names: ["VPN_PROFILE_ID"], fallback: "default" },
  { group: "VPN", key: "vpnProfileName", label: "Default profile name", kind: "string", names: ["VPN_PROFILE_NAME"], fallback: "Veyra VPN" },
  { group: "VPN", key: "vpnProviderName", label: "VPN provider name", kind: "string", names: ["VPN_PROVIDER_NAME"], fallback: "Configured gateway" },
  { group: "VPN", key: "vpnRegion", label: "VPN region", kind: "string", names: ["VPN_REGION"], fallback: "" },
  { group: "VPN", key: "vpnProxyUsername", label: "VPN proxy username", kind: "string", names: ["VPN_PROXY_USERNAME"], fallback: "", secret: true },
  { group: "VPN", key: "vpnProxyPassword", label: "VPN proxy password", kind: "string", names: ["VPN_PROXY_PASSWORD"], fallback: "", secret: true },
  { group: "VPN", key: "vpnProxyBypass", label: "VPN proxy bypass", kind: "string", names: ["VPN_PROXY_BYPASS"], fallback: "" },
  { group: "VPN", key: "vpnProfilesJson", label: "VPN profiles JSON", kind: "string", names: ["VPN_PROFILES_JSON"], fallback: "", secret: true },
  { group: "VPN", key: "vpnCrawlerProfile", label: "VPN crawler profile", kind: "string", names: ["VPN_CRAWLER_PROFILE"], fallback: "" },
  { group: "VPN", key: "vpnRotationIntervalMs", label: "VPN automatic rotation interval (ms)", kind: "number", names: ["VPN_ROTATION_INTERVAL_MS"], fallback: 0, min: 0, max: 86400000 },
  { group: "VPN", key: "vpnRotationSameIpGuard", label: "Avoid reusing known exit IPs during rotation", kind: "bool", names: ["VPN_ROTATION_SAME_IP_GUARD"], fallback: true },
  { group: "VPN", key: "vpnRotationMinGapMs", label: "VPN rotation minimum gap (ms)", kind: "number", names: ["VPN_ROTATION_MIN_GAP_MS"], fallback: 60000, min: 10000, max: 86400000 },
  { group: "Browser engine", key: "browserMaxActiveFetches", label: "Browser fetch slots", kind: "number", names: ["BROWSER_MAX_ACTIVE_FETCHES"], fallback: 24, min: 1, max: 64 },
  { group: "Browser engine", key: "browserPerHostConcurrency", label: "Browser per-host concurrency", kind: "number", names: ["BROWSER_PER_HOST_CONCURRENCY"], fallback: 8, min: 1, max: 32 },
  { group: "Browser engine", key: "browserEnabled", label: "Browser engine enabled", kind: "bool", names: ["BROWSER_ENABLED"], fallback: true },
  { group: "Browser engine", key: "browserBackend", label: "Browser backend", kind: "enum", names: ["BROWSER_BACKEND"], fallback: "local", allowed: ["local", "remote"] },
  { group: "Browser engine", key: "browserBackendUrl", label: "Remote browser backend URL", kind: "string", names: ["BROWSER_BACKEND_URL"], fallback: "" },
  { group: "Browser engine", key: "browserHeadless", label: "Browser headless", kind: "bool", names: ["BROWSER_HEADLESS"], fallback: true },
  { group: "Browser engine", key: "maxBrowserSessions", label: "Max browser sessions", kind: "number", names: ["MAX_BROWSER_SESSIONS"], fallback: 2, min: 1, max: 16 },
  { group: "Browser engine", key: "maxBrowserPages", label: "Max browser pages", kind: "number", names: ["MAX_BROWSER_PAGES"], fallback: 4, min: 1, max: 32 },
  { group: "Browser engine", key: "maxBrowserContexts", label: "Max browser contexts", kind: "number", names: ["MAX_BROWSER_CONTEXTS"], fallback: 4, min: 1, max: 16 },
  { group: "Browser engine", key: "browserIdleTimeoutMs", label: "Browser idle timeout (ms)", kind: "number", names: ["BROWSER_IDLE_TIMEOUT_MS"], fallback: 300000, min: 10000, max: 86400000 },
  { group: "Browser engine", key: "browserSessionTtlMs", label: "Browser session TTL (ms)", kind: "number", names: ["BROWSER_SESSION_TTL_MS"], fallback: 1800000, min: 60000, max: 86400000 },
  { group: "Browser engine", key: "browserNavigationTimeoutMs", label: "Browser navigation timeout (ms)", kind: "number", names: ["BROWSER_NAVIGATION_TIMEOUT_MS"], fallback: 30000, min: 5000, max: 120000 },
  { group: "Browser engine", key: "browserPageTimeoutMs", label: "Browser page timeout (ms)", kind: "number", names: ["BROWSER_PAGE_TIMEOUT_MS"], fallback: 30000, min: 5000, max: 120000 },
  { group: "Browser engine", key: "browserEvictIdleOnCapacity", label: "Evict idle browser session on capacity", kind: "bool", names: ["BROWSER_EVICT_IDLE_ON_CAPACITY"], fallback: true },
  { group: "Browser engine", key: "browserEvictMinIdleMs", label: "Minimum idle before eviction (ms)", kind: "number", names: ["BROWSER_EVICT_MIN_IDLE_MS"], fallback: 60000, min: 10000, max: 86400000 },
  { group: "Browser engine", key: "browserKeepWarm", label: "Keep Chromium warm", kind: "bool", names: ["BROWSER_KEEP_WARM"], fallback: false },
  { group: "Browser engine", key: "playwrightBrowsersPath", label: "Playwright browsers path", kind: "string", names: ["PLAYWRIGHT_BROWSERS_PATH"], fallback: "0" },
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
  { group: "Proxy warming", key: "proxyWarmPerHost", label: "Warm per-host concurrency", kind: "number", names: ["PROXY_WARM_PER_HOST"], fallback: 4, min: 1, max: 16 },
  { group: "Proxy warming", key: "proxyCriticalPreloadLimit", label: "Critical preloads/page", kind: "number", names: ["PROXY_CRITICAL_PRELOAD_LIMIT"], fallback: 18, min: 4, max: 40 },
  { group: "Proxy warming", key: "proxyInlineWarmScanChars", label: "Inline asset scan chars", kind: "number", names: ["PROXY_INLINE_WARM_SCAN_CHARS"], fallback: 800000, min: 10000, max: 3000000 },
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
  { group: "Browser engine", key: "browserEnabled", label: "Browser engine enabled", kind: "bool", names: ["BROWSER_ENABLED"], fallback: true },
  { group: "Browser engine", key: "browserHeadless", label: "Chromium headless", kind: "bool", names: ["BROWSER_HEADLESS"], fallback: true },
  { group: "Browser engine", key: "browserBackend", label: "Browser backend", kind: "enum", names: ["BROWSER_BACKEND"], fallback: "local", allowed: ["local", "remote"] },
  { group: "Browser engine", key: "maxBrowserSessions", label: "Max browser sessions", kind: "number", names: ["MAX_BROWSER_SESSIONS"], fallback: 2, min: 1, max: 16 },
  { group: "Browser engine", key: "maxBrowserPages", label: "Max browser pages", kind: "number", names: ["MAX_BROWSER_PAGES"], fallback: 4, min: 1, max: 32 },
  { group: "Browser engine", key: "maxBrowserContexts", label: "Max browser contexts", kind: "number", names: ["MAX_BROWSER_CONTEXTS"], fallback: 4, min: 1, max: 16 },
  { group: "Browser engine", key: "browserIdleTimeoutMs", label: "Browser idle timeout (ms)", kind: "number", names: ["BROWSER_IDLE_TIMEOUT_MS"], fallback: 300000, min: 10000, max: 86400000 },
  { group: "Browser engine", key: "browserSessionTtlMs", label: "Browser session TTL (ms)", kind: "number", names: ["BROWSER_SESSION_TTL_MS"], fallback: 1800000, min: 60000, max: 86400000 },
  { group: "Browser engine", key: "browserNavigationTimeoutMs", label: "Browser navigation timeout (ms)", kind: "number", names: ["BROWSER_NAVIGATION_TIMEOUT_MS"], fallback: 30000, min: 5000, max: 120000 },
  { group: "Browser engine", key: "browserPageTimeoutMs", label: "Browser page timeout (ms)", kind: "number", names: ["BROWSER_PAGE_TIMEOUT_MS"], fallback: 30000, min: 5000, max: 120000 },
  { group: "Browser engine", key: "browserKeepWarm", label: "Keep Chromium warm", kind: "bool", names: ["BROWSER_KEEP_WARM"], fallback: false },
  { group: "Browser engine", key: "playwrightBrowsersPath", label: "Playwright browsers path", kind: "string", names: ["PLAYWRIGHT_BROWSERS_PATH"], fallback: "0" },
  { group: "Plan / config", key: "veyraPlan", label: "Render plan (VEYRA_PLAN)", kind: "string", names: ["VEYRA_PLAN"], fallback: "auto", note: "free, starter, standard, pro, pro_plus, pro_max, pro_ultra or a new slug like 2c-8g. Overrides veyra.config.json." },
  { group: "Plan / config", key: "renderPlan", label: "Render plan (alias)", kind: "string", names: ["RENDER_PLAN"], fallback: "" },
  { group: "Plan / config", key: "veyraEnv", label: "Config environment", kind: "string", names: ["VEYRA_ENV"], fallback: "" },
  { group: "Plan / config", key: "veyraConfigPath", label: "Config file path", kind: "string", names: ["VEYRA_CONFIG_PATH"], fallback: "veyra.config.json" },
  { group: "Plan / config", key: "veyraCpuLimit", label: "CPU override", kind: "string", names: ["VEYRA_CPU_LIMIT"], fallback: "" },
  { group: "Plan / config", key: "devConfigApi", label: "Dev config API", kind: "bool", names: ["VEYRA_DEV_CONFIG_API"], fallback: false },
  { group: "Plan / config", key: "adminToken", label: "Admin token", kind: "string", names: ["VEYRA_ADMIN_TOKEN"], fallback: "", secret: true },
  { group: "Crawlers / workers", key: "parseWorkers", label: "Parse worker threads", kind: "number", names: ["CRAWLER_PARSE_WORKERS"], fallback: P.parseWorkers, min: 0, max: 16 },
  { group: "Crawlers / workers", key: "parseWorkerMinBytes", label: "Min bytes to use a worker", kind: "number", names: ["PARSE_WORKER_MIN_BYTES"], fallback: 48 * 1024, min: 0, max: 64 * 1024 * 1024 },
  { group: "Crawlers / workers", key: "parseWorkerTimeoutMs", label: "Worker task timeout (ms)", kind: "number", names: ["PARSE_WORKER_TIMEOUT_MS"], fallback: 20000, min: 1000, max: 120000 },
  { group: "Crawlers / workers", key: "parseWorkerHeapMb", label: "Worker heap (MB)", kind: "number", names: ["PARSE_WORKER_HEAP_MB"], fallback: 384, min: 64, max: 4096 },
  { group: "Crawlers / workers", key: "crawlQueueMax", label: "Crawl queue length", kind: "number", names: ["CRAWL_QUEUE_MAX"], fallback: 20, min: 0, max: 500 },
  { group: "Crawlers / workers", key: "crawlAbandonMs", label: "Stop unwatched crawls after (ms)", kind: "number", names: ["CRAWL_ABANDON_MS"], fallback: 10 * 60 * 1000, min: 0, max: 24 * 60 * 60 * 1000 },
  { group: "Sessions", key: "sessionIdleTtlMs", label: "Session idle TTL (ms)", kind: "number", names: ["SESSION_IDLE_TTL_MS"], fallback: P.sessionIdleMs, min: 60000, max: 86400000 },
  { group: "Sessions", key: "sessionMaxAgeMs", label: "Session max age (ms)", kind: "number", names: ["SESSION_MAX_AGE_MS"], fallback: 86400000, min: 600000, max: 604800000 },
  { group: "Sessions", key: "sessionMaxCookieBytes", label: "Cookie bytes per session", kind: "number", names: ["SESSION_MAX_COOKIE_BYTES"], fallback: 131072, min: 4096, max: 4194304 },
  { group: "Sessions", key: "serverIdleSleepMs", label: "Idle mode after (ms, 0=off)", kind: "number", names: ["SERVER_IDLE_SLEEP_MS"], fallback: 600000, min: 0, max: 86400000 },
  { group: "Browser engine", key: "browserWarmIdleMs", label: "Close warm Chromium after idle (ms)", kind: "number", names: ["BROWSER_WARM_IDLE_MS"], fallback: 900000, min: 0, max: 86400000 },
  { group: "VPN", key: "vpnKillSwitch", label: "Kill switch", kind: "bool", names: ["VPN_KILL_SWITCH"], fallback: true },
  { group: "VPN", key: "vpnFailover", label: "Automatic failover", kind: "bool", names: ["VPN_FAILOVER"], fallback: true },
  { group: "VPN", key: "vpnAlwaysOn", label: "Always-on (every session)", kind: "bool", names: ["VPN_ALWAYS_ON"], fallback: false },
  { group: "VPN", key: "vpnSplitBypass", label: "Split tunnel: bypass hosts", kind: "string", names: ["VPN_SPLIT_BYPASS"], fallback: "" },
  { group: "VPN", key: "vpnSplitOnly", label: "Split tunnel: only these hosts", kind: "string", names: ["VPN_SPLIT_ONLY"], fallback: "" },
  { group: "VPN", key: "vpnHealthUrl", label: "Health / exit-IP URL", kind: "string", names: ["VPN_HEALTH_URL"], fallback: "https://api.ipify.org?format=json" },
  { group: "VPN", key: "vpnHealthIntervalMs", label: "Health check interval (ms)", kind: "number", names: ["VPN_HEALTH_INTERVAL_MS"], fallback: 120000, min: 0, max: 86400000 },
  { group: "VPN", key: "vpnFailureThreshold", label: "Failures before marking down", kind: "number", names: ["VPN_FAILURE_THRESHOLD"], fallback: 2, min: 1, max: 20 },
  { group: "VPN", key: "vpnConnectTimeoutMs", label: "Tunnel connect timeout (ms)", kind: "number", names: ["VPN_CONNECT_TIMEOUT_MS"], fallback: 10000, min: 1000, max: 60000 },
  { group: "VPN", key: "vpnSessionIdleMs", label: "VPN session idle (ms)", kind: "number", names: ["VPN_SESSION_IDLE_MS"], fallback: 1800000, min: 60000, max: 86400000 },
  { group: "VPN", key: "vpnWgIdleMs", label: "Stop idle WireGuard after (ms)", kind: "number", names: ["VPN_WG_IDLE_MS"], fallback: 600000, min: 30000, max: 86400000 },
  { group: "VPN", key: "vpnWgConfig", label: "WireGuard config", kind: "string", names: ["VPN_WIREGUARD_CONFIG"], fallback: "", secret: true },
  { group: "VPN", key: "vpnWgConfigB64", label: "WireGuard config (base64)", kind: "string", names: ["VPN_WIREGUARD_CONFIG_B64"], fallback: "", secret: true },
  { group: "VPN", key: "vpnWgConfigFile", label: "WireGuard config file", kind: "string", names: ["VPN_WIREGUARD_CONFIG_FILE"], fallback: "" },
  { group: "VPN", key: "vpnWgId", label: "WireGuard profile id", kind: "string", names: ["VPN_WIREGUARD_ID"], fallback: "wireguard" },
  { group: "VPN", key: "vpnWgName", label: "WireGuard profile name", kind: "string", names: ["VPN_WIREGUARD_NAME"], fallback: "WireGuard" },
  { group: "VPN", key: "vpnWgRegion", label: "WireGuard region", kind: "string", names: ["VPN_WIREGUARD_REGION"], fallback: "" },
  { group: "VPN", key: "vpnWireproxyBin", label: "wireproxy binary", kind: "string", names: ["VPN_WIREPROXY_BIN"], fallback: "bin/wireproxy" },
  { group: "VPN", key: "vpnProfilesFile", label: "VPN profiles file", kind: "string", names: ["VPN_PROFILES_FILE"], fallback: "" },
  { group: "VPN", key: "vpnTimezone", label: "Browser timezone on VPN", kind: "string", names: ["VPN_TIMEZONE"], fallback: "" },
  { group: "VPN", key: "vpnLocale", label: "Browser locale on VPN", kind: "string", names: ["VPN_LOCALE"], fallback: "" },
  { group: "Misc", key: "browserRenderFallback", label: "Browser render fallback", kind: "bool", names: ["BROWSER_RENDER_FALLBACK"], fallback: false },
  { group: "Misc", key: "sortQueryParams", label: "Normalize/sort query params", kind: "bool", names: ["NORMALIZE_SORT_QUERY_PARAMS"], fallback: false }
];




const STATUS_KNOWN_UNUSED = [];

const STATUS_IGNORED_VARS = new Set(["VEYRA_THREAD_WORKER", "VEYRA_POOL_IN_TESTS"]);
const STATUS_WATCHED_PREFIXES = ["VPN_", "SESSION_", "CRAWL_", "PARSE_WORKER_", "SERVER_IDLE_", "RENDER_PLAN", "CRAWLER_", "ROBOT_", "MAX_", "PROXY_", "SEARCH_", "INDEX_", "VEYRA_", "ROBOTS_", "SITEMAP_", "CACHE_", "BROWSER_", "NORMALIZE_", "FRONTEND_", "PUBLIC_", "PORT", "PROCESS_ROLE", "SERVER_LOG_LEVEL", "REQUEST_TIMEOUT_MS", "BODY_TIMEOUT_MS", "DNS_TIMEOUT_MS", "HOST_BACKOFF_MS", "RETRY_BASE_MS", "BING_", "BRAVE_"];

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

  for (const v of vars) {
    const src = VEYRA_CONFIG.applied?.[v.name];
    if (src && v.present) { v.source = src; v.detail = `${v.detail || ""} Value comes from ${src} (a real env var would override it).`.trim(); }
    else if (v.present) v.source = "env";
  }
  const knownNames = new Set(STATUS_VAR_DEFS.flatMap(d => d.names).concat(STATUS_KNOWN_UNUSED));
  const unrecognized = Object.keys(process.env)
    .filter(name => STATUS_WATCHED_PREFIXES.some(p => name.startsWith(p)) && !knownNames.has(name) && !STATUS_IGNORED_VARS.has(name))
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
  if (CFG.resourceProfile === "free" && CFG.requestedMaxActiveFetches > CFG.maxActiveFetches) addIssue("info", `Resource profile "free" reduced MAX_ACTIVE_FETCHES from ${CFG.requestedMaxActiveFetches} to ${CFG.maxActiveFetches} to protect the instance memory budget.`);

  for (const v of vars) if (v.status === "invalid") addIssue("error", `${v.name}="${v.raw}" is invalid for ${v.label} — the server silently fell back to the default (${JSON.stringify(v.effective)}). Fix or remove this variable.`);
  for (const v of vars) if (v.status === "clamped") addIssue("warn", `${v.name}="${v.raw}" for ${v.label} is outside the allowed range — clamped to ${v.effective}.`);

  for (const name of setUnused) addIssue("warn", `${name} is set but this server build never reads it — it has no effect. Remove it or check you're deploying the version of the code that's supposed to use it.`);
  for (const u of unrecognized) addIssue("warn", `${u.name} looks like a Veyra config variable but isn't recognized by this server build (raw value: ${u.raw}). Check for a typo, e.g. did you mean one of: ${STATUS_VAR_DEFS.flatMap(d => d.names).filter(n => n.slice(0, 4) === u.name.slice(0, 4)).join(", ") || "(no close match found)"}.`);

  for (const e of VEYRA_CONFIG.errors) addIssue("error", `Config: ${e}`);
  for (const w of VEYRA_CONFIG.warnings) addIssue("warn", `Config: ${w}`);
  if (CFG.vpnEnabled && !vpnManager.profiles?.size) addIssue("error", "VPN_ENABLED is on but no valid VPN profile was loaded — check VPN_PROFILES_JSON / VPN_PROXY_SERVER / VPN_WIREGUARD_CONFIG.");
  if (CFG.vpnEnabled && [...(vpnManager.profiles?.values() || [])].some(p => p.type === "wireguard") && !vpnManager.wireproxyBin) addIssue("error", "A WireGuard VPN profile is configured but the wireproxy binary is missing — add `node scripts/install-wireproxy.js` to the Render build command.");
  if (CFG.vpnEnabled && !CFG.vpnKillSwitch) addIssue("warn", "VPN_KILL_SWITCH is off — if a tunnel fails, traffic falls back to the Render server IP.");
  if (CFG.adminToken && CFG.adminToken.length < 16) addIssue("warn", "VEYRA_ADMIN_TOKEN is shorter than 16 characters.");
  if (rewriteFailures.length) addIssue("warn", `${rewriteFailures.length} page(s) failed HTML/CSS/JS rewriting since boot and were served unrewritten as a fallback (links on those pages may point outside Veyra). Most recent: ${rewriteFailures[rewriteFailures.length - 1].url} — ${rewriteFailures[rewriteFailures.length - 1].message}`);


  const severityRankNum = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => severityRankNum[a.severity] - severityRankNum[b.severity]);

  return {
    generatedAt: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    runtime: { resourceProfile: CFG.resourceProfile, memoryLimitMb: CFG.memoryLimitMb, requestedCrawlerFetches: CFG.requestedMaxActiveFetches, configuredCrawlerFetches: CFG.maxActiveFetches, effectiveCrawlerFetches: effectiveCrawlerConcurrency(), browserKeepWarm: CFG.browserKeepWarm },
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
    browser: browserEngine.status(),
    failover: failoverController ? failoverController.report() : null,
    snapshots: snapshotStore ? snapshotStore.report() : null,
    config: veyraConfigModule.publicSummary(VEYRA_CONFIG),
    capacity: runtimeConfigSummary(),
    sessions: sessionManager.report(),
    vpn: vpnManager.status(),
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
  html += '<section><h2>Real Browser Engine</h2><table><tbody>'+
    '<tr><td>Enabled</td><td>'+esc(String(d.browser.enabled))+'</td></tr>'+
    '<tr><td>Available</td><td>'+esc(String(d.browser.available))+'</td></tr>'+
    '<tr><td>Sessions</td><td>'+esc(d.browser.sessions+' / '+d.browser.maxSessions)+'</td></tr>'+
    '<tr><td>Pages</td><td>'+esc(d.browser.pages+' / '+d.browser.maxPages)+'</td></tr>'+
    '<tr><td>Contexts</td><td>'+esc(d.browser.contexts+' / '+d.browser.maxContexts)+'</td></tr>'+
    '</tbody></table></section>';
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


app.get("/api/debug/jobs", requireAdmin, (req, res) => {
  res.json({ ok: true, jobs: [...jobs.values()].slice(-100).reverse().map(j => ({
    id: j.id, url: j.url, status: j.status, statusText: j.statusText, done: !!j.done, seed: !!j.seed,
    pageAccelerator: !!j.pageAccelerator, processed: j.counts?.processed ?? 0, linkCount: j.linkCount ?? j.links?.size ?? 0,
    createdAt: j.createdAt, finishedAt: j.finishedAt, sessionId: j.sessionId || null,
  })) });
});
app.get("/api/debug/requests", requireAdmin, (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 120));
  res.json({ ok: true, requests: requestLog.slice(-limit).reverse() });
});
app.get("/api/debug/logs", requireAdmin, (req, res) => {
  const level = String(req.query.level || "").toLowerCase();
  const source = String(req.query.source || "").toLowerCase();
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  
  let logs = source === "browser" ? clientLogBuffer : serverLogs;
  if (["error", "warn", "info", "debug"].includes(level)) logs = logs.filter(l => l.level === level);
  res.json({ ok: true, logs: logs.slice(-limit).reverse() });
});




const clientLogBuffer = [];
app.post("/api/debug/client-log", (req, res) => {
  try {
    const entry = req.body && typeof req.body === "object" ? req.body : {};
    const level = ["error", "warn", "info", "debug"].includes(String(entry.level)) ? String(entry.level) : "info";
    clientLogBuffer.push({ time: new Date().toISOString(), source: "CLIENT", level, message: String(entry.message || "").slice(0, 2000), url: String(entry.url || "").slice(0, 500), sessionId: String(entry.sessionId || "").slice(0, 64) });
    if (clientLogBuffer.length > 500) clientLogBuffer.splice(0, clientLogBuffer.length - 500);
    res.json({ ok: true, buffered: clientLogBuffer.length });
  } catch (e) { respondError(res, 400, "Invalid client log entry.", "CLIENT_LOG_INVALID"); }
});
app.get("/api/debug/client-log", requireAdmin, (req, res) => res.json({ ok: true, logs: clientLogBuffer.slice(-200) }));




app.get("/api/devtools/bridge.js", (req, res) => {
  try {
    const { source } = require("./browser/devtools-bridge");
    res.type("application/javascript").setHeader("Cache-Control", "public, max-age=300").send(`${source}\nwindow.installVeyraDevtools = installVeyraDevtools;\n`);
  } catch (e) { respondError(res, 500, "DevTools bridge unavailable.", "DEVTOOLS_BRIDGE_UNAVAILABLE"); }
});


app.get("/api/debug/system", requireAdmin, (req, res) => {
  const mem = process.memoryUsage();
  res.json({ ok: true, generatedAt: new Date().toISOString(), uptimeSec: Math.floor(process.uptime()),
    version: VEYRA_VERSION, node: process.version,
    memory: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576), heapTotalMb: Math.round(mem.heapTotal / 1048576), externalMb: Math.round(mem.external / 1048576) },
    load: { crawlerJobs: jobs.size, activeCrawls: activeCrawlCount(), queueDepth: crawlQueue.length, browserSessions: browserEngine.sessions.size, vpnConnections: vpnManager.status().connections },
    fullPageProxy: { enabled: true, version: fullPage.VERSION } });
});



const neuralRobotPool = new NeuralRobotPool({ maxWorkers: 8, neuralModel, log: (level, source, msg) => serverLog(level, source, msg) });
app.get("/api/neural/stats", (req, res) => res.json({ ok: true, mongo: mongoStore.status(), model: neuralModel.report(), trainer: neuralTrainer.report() }));
app.post("/api/neural/feedback", async (req, res) => {
  const accepted = await neuralTrainer.enqueuePersistent({
    url: req.body?.url,
    positive: req.body?.positive,
    weight: req.body?.weight,
    context: req.body?.context,
    accepted: req.body?.accepted
  });
  if (!accepted) return res.status(400).json({ ok: false, error: "A public http(s) URL is required." });
  res.json({ ok: true, queued: neuralTrainer.report().queueSize, durable: mongoStore.connected });
});
app.post("/api/neural/reset", (req, res) => { neuralTrainer.queue.length = 0; neuralModel.reset(); neuralModel.save(); res.json({ ok: true }); });
app.get("/api/robots/status", (req, res) => res.json(neuralRobotPool.report()));
app.get("/api/robots/log", (req, res) => res.json(neuralRobotPool.getLog(Math.min(100, Number(req.query.limit) || 50))));
app.post("/api/robots/crawl", async (req, res) => {
  try {
    const seeds = req.body.seeds || (req.body.seed ? [req.body.seed] : []);
    if (!seeds.length) return res.status(400).json({ error: "No seed URLs provided" });
    const query = req.body.query || "";
    const opts = { maxDepth: req.body.maxDepth || 3, maxPages: req.body.maxPages || 50 };
    const result = await neuralRobotPool.startCrawl(seeds, query, opts);
    res.json({ ok: true, results: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/robots/feedback", async (req, res) => {
  try {
    const accepted = await neuralTrainer.enqueuePersistent({ url: req.body.url, positive: !!req.body.clicked, weight: req.body.relevance || 0.5, context: { type: "html", source: "robot" } });
    if (!accepted) return res.status(400).json({ ok: false, error: "A public http(s) URL is required." });
    res.json({ ok: true, queued: neuralTrainer.report().queueSize, durable: mongoStore.connected });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/robots/reset", (req, res) => { neuralRobotPool.resetAll(); res.json({ ok: true }); });



const challengeSolver = new ChallengeSolver({ log: (level, source, msg) => serverLog(level, source, msg) });
app.get("/api/challenge/status", (req, res) => res.json(challengeSolver.report()));
app.post("/api/challenge/solve", async (req, res) => {
  try {
    const { url, html, statusCode, headers } = req.body;
    if (!url) return res.status(400).json({ error: "URL required" });
    const result = await challengeSolver.solve(url, html || "", statusCode || 403, headers || {});
    res.json({ ok: !!result, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/challenge/check", (req, res) => {
  const html = req.query.html || "";
  const statusCode = Number(req.query.statusCode) || 200;
  res.json({ isChallenge: challengeSolver.isChallengePage(html, statusCode), type: challengeSolver.detectChallengeType(html) });
});



let castServer = null;



let internetManager = new InternetConnectionManager();


app.get("/api/cast/stats", (req, res) => res.json(castServer ? castServer.getStats() : { error: "Cast server not available" }));
app.get("/api/cast/sessions", (req, res) => res.json(castServer ? castServer.listSessions() : { error: "Cast server not available" }));
app.post("/api/cast/create", (req, res) => {
  if (!castServer) return res.status(503).json({ error: "Cast server not available" });
  const session = castServer.createSessionViaPoll();
  res.json({ ok: true, sessionId: session.id, pairingCode: session.pairingCode, qrPayload: castServer.buildQrPayload(session.id, session.pairingCode), qrUrl: castServer.buildQrUrl(session.id, session.pairingCode) });
});
app.get("/api/cast/poll/:sessionId", (req, res) => {
  if (!castServer) return res.status(503).json({ error: "Cast server not available" });
  const msgs = castServer.pollSession(req.params.sessionId);
  res.json({ ok: true, messages: msgs });
});
app.post("/api/cast/push/:sessionId", (req, res) => {
  if (!castServer) return res.status(503).json({ error: "Cast server not available" });
  castServer.pushToPoll(req.params.sessionId, req.body);
  res.json({ ok: true });
});
app.post("/api/cast/send/:sessionId", (req, res) => {
  if (!castServer) return res.status(503).json({ error: "Cast server not available" });
  const result = castServer.sendToDevice(req.params.sessionId, req.body || {});
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});
app.post("/api/cast/close/:sessionId", (req, res) => {
  if (!castServer) return res.status(503).json({ error: "Cast server not available" });
  res.json(castServer.closeSession(req.params.sessionId, String(req.body?.reason || "client_closed")));
});

app.post("/api/cast/device/join", (req, res) => {
  if (!castServer) return res.status(503).json({ error: "Cast server not available" });
  const { sessionId, code, deviceId, name, type, connection } = req.body || {};
  const result = castServer.joinDeviceViaPoll(sessionId, code, deviceId, { name, type, connectionType: connection });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});
app.get("/api/cast/device/poll/:deviceId", (req, res) => {
  if (!castServer) return res.status(503).json({ error: "Cast server not available" });
  const result = castServer.pollDevice(req.params.deviceId);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});
app.post("/api/cast/device/push/:deviceId", (req, res) => {
  if (!castServer) return res.status(503).json({ error: "Cast server not available" });
  castServer.pushToDevicePoll(req.params.deviceId, req.body);
  res.json({ ok: true });
});




const internetSessionId = req => String(req.body?.sessionId || req.body?.sid || req.query?.sessionId || req.query?.sid || "ui").trim().slice(0, 128) || "ui";
app.get("/api/internet", (req, res) => {
  if (!internetManager) return res.status(503).json({ ok: false, error: "Internet manager not available", code: "INTERNET_UNAVAILABLE" });
  const sid = internetSessionId(req), selected = internetManager.getProfile(sid);
  res.json({ ok: true, sessionId: sid, selected, currentProfile: selected?.profileId || internetManager.getCurrentProfile(), profiles: internetManager.getAvailableProfiles(), report: internetManager.report() });
});
app.get("/api/internet/report", (req, res) => res.json(internetManager ? { ok: true, ...internetManager.report() } : { ok: false, error: "Internet manager not available", code: "INTERNET_UNAVAILABLE" }));
app.get("/api/internet/profile", (req, res) => res.json(internetManager ? { ok: true, sessionId: internetSessionId(req), profile: internetManager.getProfile(internetSessionId(req)) } : { ok: false, error: "Internet manager not available", code: "INTERNET_UNAVAILABLE" }));
app.post("/api/internet/profile", async (req, res) => {
  if (!internetManager) return res.status(503).json({ ok: false, error: "Internet manager not available", code: "INTERNET_UNAVAILABLE" });
  try {
    const sid = internetSessionId(req), id = String(req.body?.profile || req.body?.profileId || "auto").trim().toLowerCase();
    const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};
    const selected = internetManager.setProfile(sid, id, config);
    
    
    
    if (["auto", "lan"].includes(id)) {
      vpnManager.disconnect(sid);
      res.json({ ok: true, sessionId: sid, profile: selected, transport: { mode: "direct", connected: false } });
      return;
    }
    const transportId = `internet_${crypto.createHash("sha256").update(sid).digest("hex").slice(0, 16)}`;
    const raw = config.wireguard || config.config
      ? { id: transportId, name: `${id} internet`, type: "wireguard", config: String(config.wireguard || config.config), provider: id }
      : { id: transportId, name: `${id} internet`, type: String(config.type || "").toLowerCase(), server: String(config.proxy || config.server || ""), username: String(config.username || ""), password: String(config.password || ""), provider: id };
    const parsed = vpnManager.addProfile(raw);
    if (!parsed) return respondError(res, 400, "A valid proxy URL or WireGuard configuration is required for this internet profile.", "INTERNET_TRANSPORT_REQUIRED");
    const health = await vpnManager.checkProfile(parsed.id);
    const connected = vpnManager.connect(sid, parsed.id, { source: "internet" });
    sessionRecord(sid).vpnProfileId = parsed.id;
    res.json({ ok: true, sessionId: sid, profile: selected, transport: { mode: parsed.type, connected: true, vpn: connected, health } });
  } catch (e) { respondError(res, e.status || vpnErrStatus(e.code), e.message, e.code || "INTERNET_PROFILE_ERROR"); }
});
const testInternet = async (req, res) => {
  if (!internetManager) return res.status(503).json({ ok: false, error: "Internet manager not available", code: "INTERNET_UNAVAILABLE" });
  try {
    const sid = internetSessionId(req), vpn = vpnManager.sessionInfo?.(sid);
    if (vpn?.connected) return res.json({ ok: true, sessionId: sid, transport: "vpn", ...(await vpnManager.exitIpForSession(sid)) });
    res.json({ ok: true, sessionId: sid, transport: "direct", ...internetManager.testConnection(sid) });
  }
  catch (e) { respondError(res, 400, e.message, e.code || "INTERNET_TEST_ERROR"); }
};
app.get("/api/internet/test", testInternet);
app.post("/api/internet/test", testInternet);
app.get("/status", (req, res, next) => {
  if (!CFG.adminGate || isAdminRequest(req)) return next();
  
  
  
  
  const acceptsHtml = /text\/html/i.test(String(req.get("Accept") || ""));
  if (!acceptsHtml) return res.status(403).type("html").send("<!doctype html><title>Veyra</title><body style=\"font:15px system-ui;background:#0e1014;color:#e8eaee;display:grid;place-items:center;min-height:100vh;margin:0\"><p>This page is for Veyra administrators. Open it from the Veyra app while signed in as an admin, or send the X-Veyra-Admin-Token header.</p></body>");
  
  
  
  try {
    const target = new URL(CFG.frontendUrl);
    target.searchParams.set("veyra_route", "/dev");
    return res.redirect(302, target.toString());
  } catch {
    return res.status(403).type("html").send("<!doctype html><title>Veyra</title><body style=\"font:15px system-ui;background:#0e1014;color:#e8eaee;display:grid;place-items:center;min-height:100vh;margin:0\"><p>This page is for Veyra administrators. Open it from the Veyra app while signed in as an admin, or send the X-Veyra-Admin-Token header.</p></body>");
  }
});
app.get("/status", (req, res) => res.type("html").send(statusPage()));

function consolePage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Veyra Console</title><style>body{margin:0;background:#0e1116;color:#e7edf5;font:13px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}header{padding:16px 20px;border-bottom:1px solid #2a313b;position:sticky;top:0;background:#11151b}h1{font:700 18px system-ui;margin:0 0 8px}.bar{display:flex;gap:8px;flex-wrap:wrap}select,button{background:#1a2029;color:#dce5ef;border:1px solid #343d49;border-radius:7px;padding:7px 9px}main{padding:16px 20px}.log{display:grid;grid-template-columns:155px 72px 72px 1fr;gap:10px;padding:7px 8px;border-bottom:1px solid #181e26;white-space:pre-wrap;word-break:break-word}.SERVER{background:#121821}.BROWSER{background:#11171b}.err{color:#ff9f9f}.warn{color:#e9c36f}.info{color:#a9c8f0}.debug{color:#8f9aaa}@media(max-width:800px){.log{grid-template-columns:1fr}.log span{display:block}}</style></head><body><header><h1>Veyra — /console</h1><div class="bar"><select id="source"><option>all</option><option>browser</option><option>server</option></select><select id="level"><option>all</option><option>error</option><option>warn</option><option>info</option><option>debug</option></select><button id="refresh">Refresh</button><button id="auto">Auto: on</button></div></header><main id="log">Loading…</main><script>let on=true;async function load(){try{const s=document.getElementById('source').value,l=document.getElementById('level').value;const r=await fetch('/api/debug/logs?source='+encodeURIComponent(s)+'&level='+encodeURIComponent(l)+'&limit=500');const b=await r.json();document.getElementById('log').innerHTML=(b.logs||[]).map(x=>'<div class="log '+(x.source||'')+'"><span>'+esc(x.time||'')+'</span><span>'+esc(x.source||'')+'</span><span class="'+esc(x.level||'')+'">'+esc(x.level||'')+'</span><span>'+esc(x.message||'')+' '+esc(x.requestId||'')+'</span></div>').join('')||'<p>No logs.</p>'}catch(e){document.getElementById('log').textContent=e.message}}function esc(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]) )}document.getElementById('refresh').onclick=load;document.getElementById('source').onchange=load;document.getElementById('level').onchange=load;document.getElementById('auto').onclick=()=>{on=!on;document.getElementById('auto').textContent='Auto: '+(on?'on':'off')};load();setInterval(()=>on&&load(),2000);</script></body></html>`;
}
app.get("/console", (req, res) => res.type("html").send(consolePage()));






function proxiedPageFromCookie(req) {
  const m = String(req.get("Cookie") || "").match(/(?:^|;\s*)veyra_ctx=([^;]+)/);
  if (!m) return null;
  const [page, sid] = m[1].split("|").map(x => { try { return decodeURIComponent(x); } catch { return ""; } });
  const pageUrl = normalizeUrl(page || "");
  return pageUrl ? { pageUrl, sid: sid || "" } : null;
}
function proxiedPageFromReferer(req, { allowCookie = true } = {}) {
  const raw = String(req.get("Referer") || "");
  const fromCookie = () => allowCookie ? proxiedPageFromCookie(req) : null;
  if (!raw) return fromCookie();
  try {
    const r = new URL(raw);
    if (!/^[/]api[/](view|resource|form-get)/.test(r.pathname)) return fromCookie();
    let page = r.searchParams.get("url") || r.searchParams.get("target") || r.searchParams.get("u") || "";
    if (!page && r.pathname.startsWith("/api/form-get/")) page = decodePathToken(r.pathname.split("/")[3] || "");
    const pageUrl = normalizeUrl(page);
    if (!pageUrl) return null;
    return { pageUrl, sid: r.searchParams.get("sid") || (r.pathname.startsWith("/api/form-get/") ? decodePathToken(r.pathname.split("/")[4] || "") : "") };
  } catch { return null; }
}




const scriptDirsBySession = new Map();
function noteScriptDir(sid, url) {
  if (!sid) return;
  let dir; try { const u = new URL(url); dir = u.origin + u.pathname.replace(/[^/]*$/, ""); } catch { return; }
  const list = (scriptDirsBySession.get(sid) || []).filter(d => d !== dir);
  list.unshift(dir); if (list.length > 8) list.length = 8;
  scriptDirsBySession.delete(sid); scriptDirsBySession.set(sid, list);
  while (scriptDirsBySession.size > 2000) scriptDirsBySession.delete(scriptDirsBySession.keys().next().value);
}
async function resolveEscapedChunk(sid, relative) {
  const dirs = scriptDirsBySession.get(sid) || [];
  for (const dir of dirs.slice(0, 6)) {
    let candidate; try { candidate = normalizeUrl(new URL(relative, dir).href); } catch { continue; }
    if (!candidate) continue;
    try {
      const probe = await fetchCached(candidate, { method: "HEAD", sessionId: sid, retries: 0, limit: 0, timeout: Math.min(CFG.requestTimeoutMs, 6000), noCache: true });
      if (probe.status < 400) return candidate;
    } catch {}
  }
  return null;
}
const VEYRA_API_ROUTES = new Set(["view", "resource", "download", "form-get", "open", "crawl", "search", "suggest", "browser", "debug", "session", "sessions", "config", "vpn", "extensions", "status", "health"]);
app.use(async (req, res, next) => {
  if (!CFG.proxyRelativeFallback || res.headersSent) return next();
  
  
  
  let escaped = req.originalUrl;
  if (req.path.startsWith("/api/")) {
    const first = req.path.slice(5).split("/")[0];
    if (VEYRA_API_ROUTES.has(first)) return next();
    escaped = req.originalUrl.replace(/^[/]api[/]/, "");
  }
  
  
  
  
  
  const dest = String(req.get("Sec-Fetch-Dest") || "").toLowerCase();
  const topLevel = dest === "document" || (!dest && /text\/html/i.test(String(req.get("Accept") || "")) && !req.get("Referer"));
  const reserved = isReservedOriginPath(req.path);
  const ctx = proxiedPageFromReferer(req, { allowCookie: !topLevel && !reserved && !shield.isPreviewBot(req.get("User-Agent")) });
  if (!ctx) return next();
  let target = null;
  if (escaped !== req.originalUrl && /[.](m?js|css|wasm|json|map)([?#]|$)/i.test(req.path)) target = await resolveEscapedChunk(ctx.sid, escaped);
  if (!target) { try { target = normalizeUrl(new URL(escaped, ctx.pageUrl).href); } catch { target = null; } }
  if (!target) return next();
  const mode = dest === "document" || dest === "iframe" || dest === "frame" ? "view" : "resource";
  Object.defineProperty(req, "query", { value: { url: target, sid: ctx.sid, from: ctx.pageUrl }, writable: true, configurable: true });
  try { await proxyRequest(req, res, mode); }
  catch (e) { respondError(res, 502, `Veyra resource error: ${e.message}`, "PROXY_RELATIVE_FALLBACK_ERROR", { requestId: req.veyraRequestId }); }
});



app.use((req, res, next) => {
  if (res.headersSent) return next();
  if (req.path.startsWith("/api/")) return respondError(res, 404, "Unknown Veyra API route.", "NOT_FOUND");
  res.status(404).type("html").send(brandNotFoundHtml(CFG.frontendUrl));
});


app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const isApi = req.path.startsWith("/api/") || req.path === "/health";
  serverLog("error", "HTTP", err.stack || err.message || String(err), { requestId: req.veyraRequestId });
  if (isApi) return respondError(res, 500, "Veyra encountered an internal server error.", "INTERNAL_ERROR", { requestId: req.veyraRequestId });
  res.status(500).type("text/plain").send("Veyra server error.");
});
process.on("uncaughtException", err => { serverLog("error", "SYSTEM", `Uncaught exception: ${err.stack || err}`); });
process.on("unhandledRejection", reason => { serverLog("error", "SYSTEM", `Unhandled rejection: ${reason?.stack || reason}`); });

if (!IS_THREAD_WORKER) setInterval(async () => {
  sweepAbandonedCrawls();
  const cutoff = Date.now() - CFG.maxJobAgeMs;
  for (const [id, job] of jobs) {
    if (job.done && Date.parse(job.finishedAt || job.createdAt) < cutoff) {
      await sourceStore.delete(job);
      jobs.delete(id);
      if (activeByRoot.get(job.root) === id) activeByRoot.delete(job.root);
    }
  }
}, 60000).unref();

async function hydrateSearchFromMongo() {
  if (!mongoStore.enabled) return 0;
  try { const rows = await mongoStore.loadSearchDocuments(CFG.maxIndexDocs); let loaded = 0; for (const row of rows) { if (!row?.url) continue; const doc = { ...row, termFreq: new Map(Object.entries(row.termFreq || {})) }; delete doc._id; addIndexedDocument(doc); loaded += 1; } mongoStore.stats.hydrated += loaded; if (loaded) serverLog("info", "MONGO", `Hydrated ${loaded} search document(s) from MongoDB.`); return loaded; } catch (e) { serverLog("warn", "MONGO", `Search index hydration skipped: ${e.message}`); return 0; }
}

async function hydrateNeuralFromMongo() {
  if (!mongoStore.enabled || !mongoStore.connected) return { model: false, feedback: 0 };
  let modelLoaded = false, feedbackLoaded = 0;
  try {
    const snapshot = await mongoStore.loadNeuralModel("relevance-v1");
    if (snapshot && neuralModel.loadData(snapshot)) modelLoaded = true;
    const queued = await mongoStore.loadQueuedNeuralFeedback(neuralTrainer.maxQueue);
    for (const item of queued) if (neuralTrainer.enqueue(item)) feedbackLoaded += 1;
    if (modelLoaded || feedbackLoaded) serverLog("info", "NEURAL", `Hydrated model=${modelLoaded} and ${feedbackLoaded} queued feedback event(s) from MongoDB.`);
  } catch (e) { serverLog("warn", "NEURAL", `Mongo neural hydration skipped: ${e.message}`); }
  return { model: modelLoaded, feedback: feedbackLoaded };
}

if (require.main === module && CFG.processRole !== "worker") {
  let shuttingDown = false;
  let httpServer = null;
  const hydratePersistence = async () => {
    try {
      // Keep durable state fail-open: an unavailable or slow MongoDB instance must
      // never prevent Render from detecting this process's HTTP listener.
      await authStore.ready;
      await mongoStore.connect();
      await hydrateNeuralFromMongo();
      neuralTrainer.start();

      if (mongoStore.enabled) {
        try {
          const dbProfiles = await mongoStore.loadVpnProfiles();
          let loaded = 0;
          for (const p of dbProfiles) {
            const candidate = vpnManager.parseProfile(p);
            if (candidate && !vpnManager.profiles.has(candidate.id)) {
              vpnManager.addProfile(candidate);
              loaded++;
            }
          }
          serverLog('info', 'VPN', `Loaded ${loaded} VPN profile(s) from MongoDB.`);
        } catch (e) { serverLog('warn', 'VPN', `Failed to load VPN profiles from MongoDB: ${e.message}`); }
      }
      await hydrateSearchFromMongo();
      serverLog("info", "SYSTEM", "Persistence hydration completed.");
    } catch (err) {
      serverLog("warn", "SYSTEM", `Persistence hydration skipped: ${err.stack || err}`);
    }
  };
  const startServer = () => {
    httpServer = app.listen(PORT, "0.0.0.0", () => {
      serverLog("info", "SYSTEM", `Veyra server listening on ${PORT}`);
      serverLog("info", "CONFIG", `Plan ${VEYRA_CONFIG.plan.label} (${CFG.plan}, ${VEYRA_CONFIG.plan.ramMb}MB / ${VEYRA_CONFIG.plan.cpu} CPU, via ${VEYRA_CONFIG.planSource}) — ${CFG.maxActiveJobs} crawlers × ${CFG.maxActiveFetches} fetches, ${CFG.parseWorkers} parse workers, ${CFG.maxProxySessions} sessions, ${CFG.maxBrowserSessions} browser sessions.`);
      serverLog("info", "MONGO", mongoStore.status().configured ? `MongoDB configured (${CFG.mongoDb}); persistence/cache is fail-open.` : "MongoDB not configured; using local/ephemeral persistence where applicable.");
      for (const e of VEYRA_CONFIG.errors) serverLog("error", "CONFIG", e);
      for (const w of VEYRA_CONFIG.warnings) serverLog("warn", "CONFIG", w);
      pumpIndexSeeds().catch(e => serverLog("warn", "SEARCH", `Seed startup failed: ${e.message}`));
      if (CFG.indexRefreshMs > 0) setInterval(() => pumpIndexSeeds().catch(e => serverLog("warn", "SEARCH", `Seed scheduler failed: ${e.message}`)), 30000).unref();
      
      
      try {
        castServer = new CastServer(httpServer, (level, source, msg) => serverLog(level, source, msg), { frontendUrl: CFG.frontendUrl });
        serverLog("info", "CAST", `Cast server upgraded to ${castServer.useWebSocket ? "WebSocket" : "HTTP polling"} mode`);
      } catch (e) { serverLog("warn", "CAST", `Cast WebSocket upgrade kept polling mode: ${e.message}`); }
    });
    httpServer.once("error", err => {
      serverLog("error", "SYSTEM", `HTTP listener failed: ${err.stack || err}`);
      process.exitCode = 1;
    });
    void hydratePersistence();
  };
  startServer();
  
  const shutdown = async signal => {
    if (shuttingDown) return; shuttingDown = true;
    serverLog("info", "SYSTEM", `${signal} received — shutting down.`);
    await neuralTrainer.stop();
    for (const j of jobs.values()) if (!j.done) { j.stopRequested = true; j.stopReason = "shutdown"; j.controller?.abort?.(); }
    const force = setTimeout(() => process.exit(0), 8000); force.unref();
    await Promise.allSettled([
      vpnManager.close?.(),
      workerPool?.close(),
      browserEngine.shedIdle(0).then(() => browserEngine.browser?.close()),
      DIRECT_HTTP_AGENT.close(),
      mongoStore.close()
    ]);
    process.exit(0);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
} else if (require.main === module) {
  pumpIndexSeeds().catch(e => serverLog("warn", "SEARCH", `Seed startup failed: ${e.message}`));
  if (CFG.indexRefreshMs > 0) setInterval(() => pumpIndexSeeds().catch(e => serverLog("warn", "SEARCH", `Seed scheduler failed: ${e.message}`)), 30000).unref();
  serverLog("info", "SYSTEM", "PROCESS_ROLE=worker selected; no HTTP listener started.");
}


const __workerOps = {
  rewriteHtml: (text, base, sid) => rewriteHtml(text, base, sid),
  rewriteCss: (text, base, sid) => rewriteCssText(text, base, sid),
  rewriteJs: (text, base, sid) => rewriteJsText(text, base, sid),
  discover: (text, kind, base, contentType) => collectDiscovery(text, kind, base, contentType)
};

module.exports = { app, mongoStore, mergeStrayProxyParams, detectChallenge, CFG, __workerOps, sessionManager, vpnManager, workerPool, scheduleCrawl, crawlQueue, activeCrawlCount, effectiveMaxActiveJobs, sweepAbandonedCrawls, createJob, jobs, collectDiscovery, VEYRA_CONFIG, Semaphore, normalizeUrl, resolveNavigation, resolveResource, makeViewUrl, makeResourceUrl, rewriteHtml, rewriteCssText, rewriteJsText, rewriteMediaManifest, injectRuntime, detectChallenge, PriorityFrontier, BrowserTaskScheduler, CooperativeRobotPool, robotsAllowed, crawlPriority, crawlLimitForContentType, tokenizeSearch, parseSearchQuery, localSearch, searchIndexStats, indexDocument, localSearchSuggestions, normalizeOpenEngineMode, shouldStartCrawlerForEngineMode };
