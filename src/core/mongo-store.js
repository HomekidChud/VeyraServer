"use strict";

const zlib = require("zlib");
function proxyCacheInputSafe(result, meta) {
  const rawUrl = String(result?.finalUrl || meta?.url || "");
  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
    if ([...url.searchParams.keys()].some(name => /(?:token|secret|password|session|signature|credential|authorization|accesskey|api[_-]?key|(?:^|[_-])key(?:$|[_-])|(?:^|[_-])sig(?:$|[_-])|^(?:auth|code|jwt)$)/i.test(name))) return false;
  } catch { return false; }
  const header = name => { try { return result.headers?.get?.(name) || result.headers?.[name] || ""; } catch { return ""; } };
  const cacheControl = String(result.cacheControl || header("cache-control"));
  const vary = String(result.vary || header("vary")).trim();
  const setCookie = String(result.setCookieHeader || header("set-cookie"));
  const status = Number(result.status || 200);
  return !meta.sessionId && result.ok !== false && status >= 200 && status < 300 && !result.truncated && !result.tooLarge && !/(?:^|,)\s*(?:no-store|private)\b/i.test(cacheControl) && !vary && !setCookie;
}
class MongoStore {
  constructor(opts = {}) {
    this.uri = String(opts.uri || process.env.MONGODB_URI || "").trim();
    this.dbName = String(opts.dbName || process.env.MONGODB_DB || "veyra").trim() || "veyra";
    this.maxPoolSize = Math.max(1, Math.min(4, Number(opts.maxPoolSize || process.env.MONGODB_MAX_POOL_SIZE || 2)));
    this.cacheBodyMaxBytes = Math.max(16 * 1024, Math.min(768 * 1024, Number(opts.cacheBodyMaxBytes || process.env.MONGODB_CACHE_BODY_MAX_BYTES || 512 * 1024)));
    this.cacheTtlMs = Math.max(10_000, Number(opts.cacheTtlMs || process.env.MONGODB_CACHE_TTL_MS || 5 * 60_000));
    this.enabled = !!this.uri;
    this.disabledReason = this.enabled ? "" : "MONGODB_URI not configured";
    this.client = null; this.db = null; this.connected = false; this.connecting = null; this.retryAfter = 0;
    this.stats = { reads: 0, hits: 0, writes: 0, failures: 0, hydrated: 0 };
  }
  async connect() {
    if (!this.enabled) return false;
    if (this.connected) return true;
    if (Date.now() < this.retryAfter) return false;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        let MongoClient;
        try { ({ MongoClient } = require("mongodb")); } catch { this.enabled = false; this.disabledReason = "mongodb package unavailable"; return false; }
        const client = new MongoClient(this.uri, { maxPoolSize: this.maxPoolSize, minPoolSize: 0, maxConnecting: 1, serverSelectionTimeoutMS: 2500, connectTimeoutMS: 3000, socketTimeoutMS: 8000, retryWrites: true, retryReads: true });
        await client.connect(); this.client = client; this.db = client.db(this.dbName);
        await Promise.all([
          this.db.collection("users").createIndex({ id: 1 }, { unique: true }).catch(() => {}),
          this.db.collection("users").createIndex({ email: 1 }, { unique: true }).catch(() => {}),
          this.db.collection("users").createIndex({ storagePath: 1 }, { unique: true, sparse: true }).catch(() => {}),
          this.db.collection("proxy_cache").createIndex({ key: 1 }, { unique: true }).catch(() => {}),
          this.db.collection("proxy_cache").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {}),
          this.db.collection("search_documents").createIndex({ url: 1 }, { unique: true }).catch(() => {}),
          this.db.collection("search_documents").createIndex({ host: 1 }).catch(() => {}),
          this.db.collection("crawl_runs").createIndex({ finishedAt: -1 }).catch(() => {}),
          this.db.collection("crawl_runs").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {}),
          this.db.collection("vpn_profiles").createIndex({ id: 1 }, { unique: true }).catch(() => {}),
          this.db.collection("snapshots").createIndex({ proxySid: 1, url: 1 }, { unique: true }).catch(() => {}),
          this.db.collection("snapshots").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {}),
          this.db.collection("session_cookies").createIndex({ sid: 1 }, { unique: true }).catch(() => {}),
          this.db.collection("session_cookies").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {}),
          this.db.collection("neural_feedback").createIndex({ id: 1 }, { unique: true }).catch(() => {}),
          this.db.collection("neural_feedback").createIndex({ status: 1, createdAt: 1 }).catch(() => {}),
          this.db.collection("neural_feedback").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {}),
          this.db.collection("neural_models").createIndex({ id: 1 }, { unique: true }).catch(() => {}),
          this.db.collection("ai_observations").createIndex({ id: 1 }, { unique: true }).catch(() => {}),
          this.db.collection("ai_observations").createIndex({ createdAt: -1 }).catch(() => {}),
          this.db.collection("ai_feedback").createIndex({ id: 1 }, { unique: true }).catch(() => {}),
          this.db.collection("ai_feedback").createIndex({ status: 1, createdAt: 1 }).catch(() => {}),
          this.db.collection("ai_neural_models").createIndex({ id: 1 }, { unique: true }).catch(() => {})
        ]);
        this.connected = true; this.disabledReason = ""; this.retryAfter = 0; return true;
      } catch (e) {
        this.stats.failures += 1; this.connected = false; this.disabledReason = e?.message || String(e); this.retryAfter = Date.now() + 30_000;
        try { await this.client?.close(); } catch {} this.client = null; this.db = null; return false;
      } finally { this.connecting = null; }
    })();
    return this.connecting;
  }
  async withDb(fn) {
    if (!this.enabled || !(await this.connect()) || !this.db) return null;
    try { return await fn(this.db); }
    catch (e) { this.stats.failures += 1; this.connected = false; this.disabledReason = e?.message || String(e); this.retryAfter = Date.now() + 30_000; try { await this.client?.close(); } catch {} this.client = null; this.db = null; return null; }
  }
  async loadUsers() { const rows = await this.withDb(db => db.collection("users").find({}, { projection: { _id: 0 } }).limit(5000).toArray()); return Array.isArray(rows) ? rows : []; }
  async upsertUser(user) {
    if (!user?.id) return;
    const doc = JSON.parse(JSON.stringify(user));
    // MongoDB has databases, collections, and documents rather than folders.
    // storagePath gives each account the requested veyra/users/<name> layout
    // while keeping the account and its complete data in one atomic document.
    doc.storagePath ||= `users/${String(doc.name || doc.email || "user").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "user"}-${String(doc.id).slice(0, 12)}`;
    doc.userName = doc.name || doc.email?.split("@")[0] || "user";
    this.stats.writes += 1;
    void this.withDb(db => db.collection("users").updateOne({ id: doc.id }, { $set: doc }, { upsert: true }));
  }
  async deleteUser(id) { if (!id) return; this.stats.writes += 1; void this.withDb(db => db.collection("users").deleteOne({ id: String(id) })); }
  async getProxyCache(key) {
    if (!key) return null; this.stats.reads += 1;
    const doc = await this.withDb(db => db.collection("proxy_cache").findOne({ key }, { projection: { _id: 0 } }));
    if (!doc?.bodyGzip || (doc.expiresAt && Date.parse(doc.expiresAt) <= Date.now())) return null;
    try {
      this.stats.hits += 1; const body = zlib.gunzipSync(Buffer.from(doc.bodyGzip, "base64"));
      return { time: Number(doc.createdAtMs || Date.now()), expiresAtMs: doc.expiresAt ? Date.parse(doc.expiresAt) : Number(doc.createdAtMs || Date.now()) + this.cacheTtlMs, response: { ok: doc.ok !== false, status: Number(doc.status || 200), finalUrl: doc.finalUrl || doc.url, contentType: doc.contentType || "application/octet-stream", contentEncoding: doc.contentEncoding || "", cacheControl: doc.cacheControl || "", etag: doc.etag || "", lastModified: doc.lastModified || "", expires: doc.expires || "", contentRange: doc.contentRange || "", acceptRanges: doc.acceptRanges || "", linkHeader: doc.linkHeader || "", contentDisposition: doc.contentDisposition || "", setCookieHeader: "", contentLength: doc.contentLength || "", serverHeader: doc.serverHeader || "", cfMitigated: doc.cfMitigated || "", xFrameOptions: doc.xFrameOptions || "", contentSecurityPolicy: doc.contentSecurityPolicy || "", bytes: body.length, truncated: false, tooLarge: false, stream: null, body, redirectChain: Array.isArray(doc.redirectChain) ? doc.redirectChain : [], retries: 0, sessionId: doc.sessionId || "", revalidated: false, cacheHit: true, mongoCacheHit: true }, etag: doc.etag || "", lastModified: doc.lastModified || "" };
    } catch { return null; }
  }
  async putProxyCache(key, result, meta = {}) {
    if (!key || !result?.body || result.body.length > this.cacheBodyMaxBytes) return;
    const type = String(result.contentType || "").toLowerCase(); if (!(type.includes("text/") || /javascript|json|xml|svg|css|font/.test(type))) return;
    if (!proxyCacheInputSafe(result, meta)) return;
    const cacheControl = String(result.cacheControl || "");
    const now = Date.now(); const bodyGzip = zlib.gzipSync(Buffer.from(result.body), { level: 4 }).toString("base64");
    const ttlMs = Math.min(this.cacheTtlMs, Math.max(0, Number(meta.ttlMs ?? this.cacheTtlMs)));
    if (!ttlMs) return;
    const doc = { key, url: result.finalUrl || meta.url || "", ok: !!result.ok, status: result.status, contentType: result.contentType || "", contentEncoding: result.contentEncoding || "", cacheControl, etag: result.etag || "", lastModified: result.lastModified || "", expires: result.expires || "", contentRange: result.contentRange || "", acceptRanges: result.acceptRanges || "", linkHeader: result.linkHeader || "", contentDisposition: result.contentDisposition || "", contentLength: result.contentLength || "", serverHeader: result.serverHeader || "", cfMitigated: result.cfMitigated || "", xFrameOptions: result.xFrameOptions || "", contentSecurityPolicy: result.contentSecurityPolicy || "", redirectChain: result.redirectChain || [], sessionId: meta.sessionId || "", createdAtMs: now, expiresAt: new Date(now + ttlMs), bodyGzip };
    this.stats.writes += 1; void this.withDb(db => db.collection("proxy_cache").updateOne({ key }, { $set: doc }, { upsert: true }));
  }
  async deleteProxyCache(key) {
    if (!key) return;
    this.stats.writes += 1;
    return this.withDb(db => db.collection("proxy_cache").deleteOne({ key }));
  }
  async loadSearchDocuments(limit = 20000) { const rows = await this.withDb(db => db.collection("search_documents").find({}, { projection: { _id: 0 } }).sort({ indexedAt: -1 }).limit(Math.max(1, Number(limit) || 1000)).toArray()); return Array.isArray(rows) ? rows : []; }
  async upsertSearchDocument(doc) { if (!doc?.url) return; const safe = { ...doc, termFreq: Object.fromEntries(doc.termFreq instanceof Map ? doc.termFreq.entries() : Object.entries(doc.termFreq || {})) }; delete safe._id; this.stats.writes += 1; void this.withDb(db => db.collection("search_documents").updateOne({ url: safe.url }, { $set: safe }, { upsert: true })); }
  async deleteSearchDocument(url) { if (!url) return; this.stats.writes += 1; void this.withDb(db => db.collection("search_documents").deleteOne({ url })); }
  async saveCrawlSummary(job) { if (!job?.id) return; const doc = { id: String(job.id), root: job.root, createdAt: job.createdAt, startedAt: job.startedAt || null, finishedAt: job.finishedAt || null, status: job.status, statusText: job.statusText, pageAccelerator: !!job.pageAccelerator, counts: job.counts || {}, resourceCount: job.resources?.length || 0, linkCount: job.links?.length || 0, expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) }; this.stats.writes += 1; void this.withDb(db => db.collection("crawl_runs").updateOne({ id: doc.id }, { $set: doc }, { upsert: true })); }
  async getLatestCrawlSummary(root) {
    if (!root) return null;
    this.stats.reads += 1;
    const doc = await this.withDb(db => db.collection("crawl_runs").findOne({ root, status: { $in: ["done", "stopped"] } }, { projection: { _id: 0 }, sort: { finishedAt: -1 } }));
    if (!doc || (doc.expiresAt && Date.parse(doc.expiresAt) <= Date.now())) return null;
    this.stats.hits += 1;
    return doc;
  }

  
  async enqueueNeuralFeedback(feedback) {
    if (!feedback?.id || !feedback?.url) return false;
    const doc = {
      id: String(feedback.id), url: String(feedback.url), positive: !!feedback.positive,
      weight: Number(feedback.weight) || 1, context: feedback.context || {}, status: "queued",
      createdAt: new Date(feedback.createdAt || Date.now()), updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
    };
    const result = await this.withDb(async db => {
      await db.collection("neural_feedback").updateOne({ id: doc.id }, { $setOnInsert: doc }, { upsert: true });
      await db.collection("ai_feedback").updateOne({ id: doc.id }, { $setOnInsert: { ...doc, storagePath: `ai/feedback/${doc.id}` } }, { upsert: true });
      return true;
    });
    if (result == null) return false;
    this.stats.writes += 1;
    return true;
  }
  async loadQueuedNeuralFeedback(limit = 5000) {
    const rows = await this.withDb(db => db.collection("neural_feedback").find({ status: "queued" }, { projection: { _id: 0 } }).sort({ createdAt: 1 }).limit(Math.max(1, Number(limit) || 1000)).toArray());
    this.stats.reads += 1;
    return Array.isArray(rows) ? rows : [];
  }
  async markNeuralFeedbackProcessed(id, error = "") {
    if (!id) return;
    this.stats.writes += 1;
    void this.withDb(async db => {
      const update = { $set: { status: error ? "error" : "processed", error: error || null, processedAt: new Date(), updatedAt: new Date() } };
      await db.collection("neural_feedback").updateOne({ id: String(id) }, update);
      await db.collection("ai_feedback").updateOne({ id: String(id) }, update);
    });
  }
  async saveNeuralModel(id, data) {
    if (!id || !data) return;
    const doc = { id: String(id), ...data, updatedAt: new Date() };
    this.stats.writes += 1;
    return this.withDb(async db => {
      await db.collection("neural_models").updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
      await db.collection("ai_neural_models").updateOne({ id: doc.id }, { $set: { ...doc, storagePath: `ai/neural/${doc.id}` } }, { upsert: true });
      return true;
    });
  }
  async loadNeuralModel(id) {
    if (!id) return null;
    this.stats.reads += 1;
    const doc = await this.withDb(async db => (await db.collection("ai_neural_models").findOne({ id: String(id) }, { projection: { _id: 0, id: 0 } })) || (await db.collection("neural_models").findOne({ id: String(id) }, { projection: { _id: 0, id: 0 } })));
    return doc || null;
  }

  async recordAIObservation(observation) {
    if (!observation?.id) return false;
    const safe = JSON.parse(JSON.stringify({
      id: String(observation.id), storagePath: `ai/observations/${String(observation.id)}`,
      query: String(observation.query || "").slice(0, 1000), answer: String(observation.answer || "").slice(0, 6000),
      hasAnswer: !!observation.hasAnswer, generatedBy: String(observation.generatedBy || ""),
      sources: Array.isArray(observation.sources) ? observation.sources.slice(0, 24) : [],
      results: Array.isArray(observation.results) ? observation.results.slice(0, 24) : [],
      pipeline: observation.pipeline || {}, grounding: observation.grounding || {},
      createdAt: new Date(observation.createdAt || Date.now())
    }));
    this.stats.writes += 1;
    const result = await this.withDb(db => db.collection("ai_observations").updateOne({ id: safe.id }, { $set: safe }, { upsert: true }));
    return result != null;
  }
  async enqueueAITraining(feedback) {
    if (!feedback?.id || !feedback?.url) return false;
    const doc = { ...feedback, id: String(feedback.id), storagePath: `ai/feedback/${String(feedback.id)}`, url: String(feedback.url), status: "queued", createdAt: new Date(feedback.createdAt || Date.now()), updatedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) };
    const result = await this.withDb(db => db.collection("ai_feedback").updateOne({ id: doc.id }, { $setOnInsert: doc }, { upsert: true }));
    if (result == null) return false;
    this.stats.writes += 1;
    return true;
  }
  async saveAINeuralModel(id, data) {
    if (!id || !data) return;
    const doc = { id: String(id), storagePath: `ai/neural/${String(id)}`, ...data, updatedAt: new Date() };
    this.stats.writes += 1;
    return this.withDb(db => db.collection("ai_neural_models").updateOne({ id: doc.id }, { $set: doc }, { upsert: true }));
  }

  
  
  
  async loadVpnProfiles() {
    const rows = await this.withDb(db => db.collection("vpn_profiles").find({}, { projection: { _id: 0 } }).limit(500).toArray());
    return Array.isArray(rows) ? rows : [];
  }
  async saveVpnProfile(profile) {
    if (!profile?.id) return;
    const doc = { ...profile, updatedAt: new Date().toISOString() };
    this.stats.writes += 1;
    void this.withDb(db => db.collection("vpn_profiles").updateOne({ id: doc.id }, { $set: doc }, { upsert: true }));
  }
  async deleteVpnProfile(id) {
    if (!id) return;
    this.stats.writes += 1;
    void this.withDb(db => db.collection("vpn_profiles").deleteOne({ id: String(id) }));
  }
  async listVpnProfiles() {
    const rows = await this.withDb(db => db.collection("vpn_profiles").find({}, { projection: { _id: 0, config: 0 } }).limit(500).toArray());
    return Array.isArray(rows) ? rows : [];
  }

  
  
  
  async putSnapshot(proxySid, snapshot) {
    if (!proxySid || !snapshot?.url || !snapshot.html) return;
    const bodyGzip = zlib.gzipSync(Buffer.from(snapshot.html), { level: 4 }).toString("base64");
    const doc = {
      proxySid, url: snapshot.url, title: snapshot.title || "", contentType: snapshot.contentType || "text/html",
      status: snapshot.status || 200, capturedAt: new Date(),
      bodyGzip, expiresAt: new Date(Date.now() + 30 * 60 * 1000) 
    };
    this.stats.writes += 1;
    void this.withDb(db => db.collection("snapshots").updateOne(
      { proxySid, url: snapshot.url }, { $set: doc }, { upsert: true }
    ));
  }
  async getSnapshot(proxySid, url) {
    if (!proxySid || !url) return null;
    this.stats.reads += 1;
    const doc = await this.withDb(db => db.collection("snapshots").findOne(
      { proxySid, url }, { projection: { _id: 0 } }
    ));
    if (!doc?.bodyGzip) return null;
    if (doc.expiresAt && Date.parse(doc.expiresAt) <= Date.now()) return null;
    try {
      this.stats.hits += 1;
      const html = zlib.gunzipSync(Buffer.from(doc.bodyGzip, "base64")).toString("utf8");
      return { url: doc.url, title: doc.title || "", contentType: doc.contentType || "text/html", status: doc.status || 200, html, capturedAt: Date.parse(doc.capturedAt) || Date.now() };
    } catch { return null; }
  }
  async getLatestSnapshot(proxySid) {
    if (!proxySid) return null;
    this.stats.reads += 1;
    const doc = await this.withDb(db => db.collection("snapshots").findOne(
      { proxySid }, { projection: { _id: 0 }, sort: { capturedAt: -1 } }
    ));
    if (!doc?.bodyGzip) return null;
    try {
      this.stats.hits += 1;
      const html = zlib.gunzipSync(Buffer.from(doc.bodyGzip, "base64")).toString("utf8");
      return { url: doc.url, title: doc.title || "", contentType: doc.contentType || "text/html", status: doc.status || 200, html, capturedAt: Date.parse(doc.capturedAt) || Date.now() };
    } catch { return null; }
  }
  async clearSnapshots(proxySid) {
    if (!proxySid) return;
    this.stats.writes += 1;
    void this.withDb(db => db.collection("snapshots").deleteMany({ proxySid }));
  }

  
  
  
  async putSessionCookies(sid, cookies) {
    if (!sid || !Array.isArray(cookies) || !cookies.length) return;
    const doc = { sid, cookies, updatedAt: new Date(), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) };
    this.stats.writes += 1;
    void this.withDb(db => db.collection("session_cookies").updateOne(
      { sid }, { $set: doc }, { upsert: true }
    ));
  }
  async getSessionCookies(sid) {
    if (!sid) return null;
    this.stats.reads += 1;
    const doc = await this.withDb(db => db.collection("session_cookies").findOne(
      { sid }, { projection: { _id: 0 } }
    ));
    if (!doc?.cookies) return null;
    if (doc.expiresAt && Date.parse(doc.expiresAt) <= Date.now()) return null;
    this.stats.hits += 1;
    return doc.cookies;
  }
  async deleteSessionCookies(sid) {
    if (!sid) return;
    this.stats.writes += 1;
    void this.withDb(db => db.collection("session_cookies").deleteOne({ sid }));
  }
  async loadPlatformWaitlist() {
    const rows = await this.withDb(db => db.collection("platform_waitlist").find({}, { projection: { _id: 0 } }).sort({ createdAt: 1 }).limit(100000).toArray());
    return Array.isArray(rows) ? rows : [];
  }
  async replacePlatformWaitlist(rows) {
    if (!Array.isArray(rows)) return;
    this.stats.writes += 1;
    return this.withDb(async db => { const c = db.collection("platform_waitlist"); await c.deleteMany({}); if (rows.length) await c.insertMany(JSON.parse(JSON.stringify(rows))); });
  }
  status() { return { configured: !!this.uri, enabled: this.enabled, connected: this.connected, db: this.dbName, poolSize: this.maxPoolSize, cacheBodyMaxBytes: this.cacheBodyMaxBytes, cacheTtlMs: this.cacheTtlMs, retryAfter: this.retryAfter || null, disabledReason: this.disabledReason || null, stats: { ...this.stats } }; }
  async close() { this.connected = false; try { await this.client?.close(); } catch {} this.client = null; this.db = null; }
}
module.exports = { MongoStore };
