"use strict";
/**
 * Veyra Snapshot Store — v8.19.0
 *
 * Safety net: after a successful Chromium page load, snapshot the HTML and
 * critical asset metadata. If Chromium dies, serve the last good snapshot
 * instantly (read-only) while it recovers.
 *
 * Also feeds crawl results into the fast proxy cache.
 *
 * Snapshots are:
 *   - Per proxy session, per canonical URL
 *   - Read-only recovery documents (not interactive)
 *   - Bounded in size and count (LRU eviction)
 *   - Never persisted to disk — in-memory only
 */

const MAX_SNAPSHOTS = 200;          // per session
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;  // 2 MB per snapshot
const MAX_ASSET_SNAPSHOTS = 50;    // critical assets per snapshot
const MAX_ASSET_BYTES = 256 * 1024;  // per asset body

class SnapshotStore {
  constructor(opts = {}) {
    this.maxSnapshots = opts.maxSnapshots || MAX_SNAPSHOTS;
    this.maxSnapshotBytes = opts.maxSnapshotBytes || MAX_SNAPSHOT_BYTES;
    this.maxAssets = opts.maxAssets || MAX_ASSET_SNAPSHOTS;
    this.maxAssetBytes = opts.maxAssetBytes || MAX_ASSET_BYTES;
    this.log = opts.log || (() => {});
    this.mongo = opts.mongo || null; // MongoDB backing store (optional)
    // sessions Map: proxySid → Map<canonicalUrl, snapshot>
    this.sessions = new Map();
    this.stats = { stored: 0, served: 0, servedFromMongo: 0, evicted: 0, expired: 0, mongoWrites: 0, mongoHits: 0, mongoMisses: 0 };
  }

  _getSession(proxySid) {
    let m = this.sessions.get(proxySid);
    if (!m) {
      m = new Map();
      this.sessions.set(proxySid, m);
    }
    return m;
  }

  // Snapshot a page after successful load.
  // entry: { html, url, title, contentType, status, headers, assets: [{url, contentType, body}] }
  snapshot(proxySid, entry) {
    if (!proxySid || !entry || !entry.url) return false;
    const html = String(entry.html || '').slice(0, this.maxSnapshotBytes);
    if (!html) return false;

    const store = this._getSession(proxySid);

    // LRU: delete + re-insert to move to end
    store.delete(entry.url);

    const snapshot = {
      url: entry.url,
      html,
      title: String(entry.title || '').slice(0, 500),
      contentType: entry.contentType || 'text/html',
      status: entry.status || 200,
      headers: entry.headers || {},
      capturedAt: Date.now(),
      assets: []
    };

    // Store critical assets (CSS, JS, images) that were loaded
    if (Array.isArray(entry.assets)) {
      for (const asset of entry.assets.slice(0, this.maxAssets)) {
        if (!asset || !asset.url || !asset.body) continue;
        const body = Buffer.isBuffer(asset.body) ? asset.body : Buffer.from(String(asset.body));
        if (body.length > this.maxAssetBytes) continue;
        snapshot.assets.push({
          url: asset.url,
          contentType: asset.contentType || 'application/octet-stream',
          body: body,
          etag: asset.etag || null,
          capturedAt: Date.now()
        });
      }
    }

    store.set(entry.url, snapshot);

    // Enforce cap (LRU eviction)
    while (store.size > this.maxSnapshots) {
      const oldest = store.keys().next().value;
      if (!oldest) break;
      store.delete(oldest);
      this.stats.evicted++;
    }

    this.stats.stored++;
    // Persist to MongoDB (fire-and-forget, gzipped)
    if (this.mongo) {
      this.stats.mongoWrites++;
      this.mongo.putSnapshot(proxySid, snapshot).catch(() => {});
    }
    return true;
  }

  // Retrieve the last good snapshot for a URL in a session.
  // Falls back to MongoDB if not in memory.
  async get(proxySid, url) {
    if (!proxySid || !url) return null;
    const store = this.sessions.get(proxySid);
    if (store) {
      const snap = store.get(url);
      if (snap) {
        // LRU refresh
        store.delete(url);
        store.set(url, snap);
        this.stats.served++;
        return snap;
      }
    }
    // Fall back to MongoDB
    if (this.mongo) {
      const snap = await this.mongo.getSnapshot(proxySid, url);
      if (snap) {
        this.stats.servedFromMongo++;
        this.stats.mongoHits++;
        // Hydrate in-memory cache
        const memStore = this._getSession(proxySid);
        memStore.set(url, snap);
        return snap;
      }
      this.stats.mongoMisses++;
    }
    return null;
  }

  // Get any snapshot for a session (the most recent one)
  async getLatest(proxySid) {
    if (!proxySid) return null;
    const store = this.sessions.get(proxySid);
    if (store && store.size) {
      const entries = [...store.values()];
      return entries[entries.length - 1] || null;
    }
    // Fall back to MongoDB
    if (this.mongo) {
      return await this.mongo.getLatestSnapshot(proxySid);
    }
    return null;
  }

  // Get a cached asset body for the proxy cache
  getAsset(proxySid, url) {
    if (!proxySid || !url) return null;
    const store = this.sessions.get(proxySid);
    if (!store) return null;
    for (const snap of store.values()) {
      const asset = snap.assets.find(a => a.url === url);
      if (asset) return asset;
    }
    return null;
  }

  // Check if a snapshot exists for this URL
  async has(proxySid, url) {
    if (!proxySid || !url) return false;
    const store = this.sessions.get(proxySid);
    if (store && store.has(url)) return true;
    if (this.mongo) {
      const snap = await this.mongo.getSnapshot(proxySid, url);
      return !!snap;
    }
    return false;
  }

  // Feed a crawl result into the store (for the crawler safety net)
  feedCrawlResult(proxySid, { url, html, title, contentType, assets }) {
    if (!proxySid || !url || !html) return false;
    return this.snapshot(proxySid, { url, html, title, contentType, status: 200, headers: {}, assets: assets || [] });
  }

  // Remove all snapshots for a session (on session expiry)
  clearSession(proxySid) {
    const store = this.sessions.get(proxySid);
    if (!store) return 0;
    const n = store.size;
    this.sessions.delete(proxySid);
    this.stats.expired += n;
    // Also clear from MongoDB
    if (this.mongo) this.mongo.clearSnapshots(proxySid).catch(() => {});
    return n;
  }

  // Clean up sessions not in the active set
  cleanup(activeSessionIds) {
    const active = new Set(activeSessionIds);
    let removed = 0;
    for (const key of this.sessions.keys()) {
      if (!active.has(key)) {
        removed += this.sessions.get(key).size;
        this.sessions.delete(key);
      }
    }
    this.stats.expired += removed;
    return removed;
  }

  report() {
    let totalSnapshots = 0, totalAssets = 0;
    for (const store of this.sessions.values()) {
      totalSnapshots += store.size;
      for (const snap of store.values()) totalAssets += snap.assets.length;
    }
    return {
      sessions: this.sessions.size,
      totalSnapshots,
      totalAssets,
      mongoEnabled: !!this.mongo,
      stats: { ...this.stats }
    };
  }
}

module.exports = { SnapshotStore };
