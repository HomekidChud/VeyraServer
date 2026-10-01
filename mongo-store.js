"use strict";
// Optional MongoDB persistence/cache layer. Low-pool, asynchronous and fail-open.
const zlib = require("zlib");
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
          this.db.collection("proxy_cache").createIndex({ key: 1 }, { unique: true }).catch(() => {}),
          this.db.collection("proxy_cache").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {}),
          this.db.collection("search_documents").createIndex({ url: 1 }, { unique: true }).catch(() => {}),
          this.db.collection("search_documents").createIndex({ host: 1 }).catch(() => {}),
          this.db.collection("crawl_runs").createIndex({ finishedAt: -1 }).catch(() => {}),
          this.db.collection("crawl_runs").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {}),
          this.db.collection("vpn_profiles").createIndex({ id: 1 }, { unique: true }).catch(() => {})
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
  async upsertUser(user) { if (!user?.id) return; const doc = JSON.parse(JSON.stringify(user)); this.stats.writes += 1; void this.withDb(db => db.collection("users").updateOne({ id: doc.id }, { $set: doc }, { upsert: true })); }
  async deleteUser(id) { if (!id) return; this.stats.writes += 1; void this.withDb(db => db.collection("users").deleteOne({ id: String(id) })); }
  async getProxyCache(key) {
    if (!key) return null; this.stats.reads += 1;
    const doc = await this.withDb(db => db.collection("proxy_cache").findOne({ key }, { projection: { _id: 0 } }));
    if (!doc?.bodyGzip || (doc.expiresAt && Date.parse(doc.expiresAt) <= Date.now())) return null;
    try {
      this.stats.hits += 1; const body = zlib.gunzipSync(Buffer.from(doc.bodyGzip, "base64"));
      return { time: Number(doc.createdAtMs || Date.now()), response: { ok: doc.ok !== false, status: Number(doc.status || 200), finalUrl: doc.finalUrl || doc.url, contentType: doc.contentType || "application/octet-stream", contentEncoding: doc.contentEncoding || "", cacheControl: doc.cacheControl || "", etag: doc.etag || "", lastModified: doc.lastModified || "", expires: doc.expires || "", contentRange: doc.contentRange || "", acceptRanges: doc.acceptRanges || "", linkHeader: doc.linkHeader || "", contentDisposition: doc.contentDisposition || "", setCookieHeader: "", contentLength: doc.contentLength || "", serverHeader: doc.serverHeader || "", cfMitigated: doc.cfMitigated || "", xFrameOptions: doc.xFrameOptions || "", contentSecurityPolicy: doc.contentSecurityPolicy || "", bytes: body.length, truncated: false, tooLarge: false, stream: null, body, redirectChain: Array.isArray(doc.redirectChain) ? doc.redirectChain : [], retries: 0, sessionId: doc.sessionId || "", revalidated: false, cacheHit: true, mongoCacheHit: true }, etag: doc.etag || "", lastModified: doc.lastModified || "" };
    } catch { return null; }
  }
  async putProxyCache(key, result, meta = {}) {
    if (!key || !result?.body || result.body.length > this.cacheBodyMaxBytes) return;
    const type = String(result.contentType || "").toLowerCase(); if (!(type.includes("text/") || /javascript|json|xml|svg|css|font/.test(type))) return;
    const cacheControl = String(result.cacheControl || ""); if (/no-store|private/i.test(cacheControl)) return;
    const now = Date.now(); const bodyGzip = zlib.gzipSync(Buffer.from(result.body), { level: 4 }).toString("base64");
    const doc = { key, url: result.finalUrl || meta.url || "", ok: !!result.ok, status: result.status, contentType: result.contentType || "", contentEncoding: result.contentEncoding || "", cacheControl, etag: result.etag || "", lastModified: result.lastModified || "", expires: result.expires || "", contentRange: result.contentRange || "", acceptRanges: result.acceptRanges || "", linkHeader: result.linkHeader || "", contentDisposition: result.contentDisposition || "", contentLength: result.contentLength || "", serverHeader: result.serverHeader || "", cfMitigated: result.cfMitigated || "", xFrameOptions: result.xFrameOptions || "", contentSecurityPolicy: result.contentSecurityPolicy || "", redirectChain: result.redirectChain || [], sessionId: meta.sessionId || "", createdAtMs: now, expiresAt: new Date(now + this.cacheTtlMs), bodyGzip };
    this.stats.writes += 1; void this.withDb(db => db.collection("proxy_cache").updateOne({ key }, { $set: doc }, { upsert: true }));
  }
  async loadSearchDocuments(limit = 20000) { const rows = await this.withDb(db => db.collection("search_documents").find({}, { projection: { _id: 0 } }).sort({ indexedAt: -1 }).limit(Math.max(1, Number(limit) || 1000)).toArray()); return Array.isArray(rows) ? rows : []; }
  async upsertSearchDocument(doc) { if (!doc?.url) return; const safe = { ...doc, termFreq: Object.fromEntries(doc.termFreq instanceof Map ? doc.termFreq.entries() : Object.entries(doc.termFreq || {})) }; delete safe._id; this.stats.writes += 1; void this.withDb(db => db.collection("search_documents").updateOne({ url: safe.url }, { $set: safe }, { upsert: true })); }
  async deleteSearchDocument(url) { if (!url) return; this.stats.writes += 1; void this.withDb(db => db.collection("search_documents").deleteOne({ url })); }
  async saveCrawlSummary(job) { if (!job?.id) return; const doc = { id: String(job.id), root: job.root, createdAt: job.createdAt, startedAt: job.startedAt || null, finishedAt: job.finishedAt || null, status: job.status, statusText: job.statusText, pageAccelerator: !!job.pageAccelerator, counts: job.counts || {}, resourceCount: job.resources?.length || 0, linkCount: job.links?.length || 0, expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) }; this.stats.writes += 1; void this.withDb(db => db.collection("crawl_runs").updateOne({ id: doc.id }, { $set: doc }, { upsert: true })); }

  // ---- VPN profile persistence ----
  // Stored separately from env-var profiles. Env profiles are always loaded on
  // startup; Mongo profiles are layered on top and survive restarts.
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
  status() { return { configured: !!this.uri, enabled: this.enabled, connected: this.connected, db: this.dbName, poolSize: this.maxPoolSize, cacheBodyMaxBytes: this.cacheBodyMaxBytes, cacheTtlMs: this.cacheTtlMs, retryAfter: this.retryAfter || null, disabledReason: this.disabledReason || null, stats: { ...this.stats } }; }
  async close() { this.connected = false; try { await this.client?.close(); } catch {} this.client = null; this.db = null; }
}
module.exports = { MongoStore };
