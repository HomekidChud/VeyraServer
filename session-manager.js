"use strict";
// Veyra session manager — keeps per-user state small so a Render instance
// isn't wasted on abandoned tabs.
//
// * O(1) LRU of proxy sessions (Map insertion order) with a hard cap.
// * Idle TTL sweeper: expired sessions release cookies, VPN tunnels, Chromium
//   contexts and script-dir caches through registered hooks.
// * Explicit close (frontend calls it on tab close via sendBeacon).
// * Memory governor integration: under pressure idle sessions are shed early.
// * Server idle mode: when no API traffic arrives for SERVER_IDLE_SLEEP_MS the
//   server "sleeps" — Chromium closes, caches drop, background seed crawls
//   pause — and wakes on the next request.

class SessionManager {
  constructor(opts = {}) {
    this.maxSessions = opts.maxSessions || 500;
    this.idleTtlMs = opts.idleTtlMs || 30 * 60 * 1000;
    this.hardTtlMs = opts.hardTtlMs || 24 * 60 * 60 * 1000;
    this.maxCookieBytes = opts.maxCookieBytes || 128 * 1024;
    this.sweepMs = opts.sweepMs || 30000;
    this.serverIdleMs = opts.serverIdleMs ?? 10 * 60 * 1000;
    this.log = opts.log || (() => {});
    this.now = opts.now || (() => Date.now());
    this.sessions = new Map();
    this.hooks = { expire: [], sleep: [], wake: [] };
    this.stats = { created: 0, expiredIdle: 0, expiredCap: 0, expiredPressure: 0, closedByClient: 0, sleeps: 0, wakes: 0 };
    this.lastActivity = this.now();
    this.sleeping = false;
    this.timer = null;
  }
  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => { this.sweep().catch(e => this.log("warn", "SESSION", `Sweep failed: ${e.message}`)); }, this.sweepMs);
    this.timer.unref?.();
    return this;
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  on(event, fn) { (this.hooks[event] ||= []).push(fn); return this; }

  // Record API activity (wakes the server from idle mode).
  activity() {
    this.lastActivity = this.now();
    if (this.sleeping) {
      this.sleeping = false;
      this.stats.wakes += 1;
      this.log("info", "SESSION", "Server woke from idle mode.");
      for (const fn of this.hooks.wake) { try { fn(); } catch {} }
    }
  }

  // Get or create; moves the record to the MRU end of the Map.
  touch(sid) {
    const t = this.now();
    let rec = this.sessions.get(sid);
    if (rec && (t - rec.lastUsed > this.idleTtlMs || t - rec.createdAt > this.hardTtlMs)) {
      this.expire(sid, "idle");
      rec = null;
    }
    if (!rec) {
      rec = { id: sid, createdAt: t, lastUsed: t, cookies: new Map(), vpnProfileId: null, browserSessions: new Set(), requests: 0, bytesOut: 0 };
      this.sessions.set(sid, rec);
      this.stats.created += 1;
      this.enforceCap();
    } else {
      this.sessions.delete(sid);
      this.sessions.set(sid, rec);
    }
    rec.lastUsed = t;
    rec.requests += 1;
    return rec;
  }
  peek(sid) { return this.sessions.get(sid) || null; }
  has(sid) { return this.sessions.has(sid); }
  get size() { return this.sessions.size; }

  enforceCap() {
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (!oldest) break;
      this.expire(oldest, "cap");
    }
  }

  // Keep a session's cookie jar under maxCookieBytes (drop oldest first).
  trimCookies(rec) {
    let bytes = 0;
    for (const c of rec.cookies.values()) bytes += c.name.length + String(c.value).length + c.domain.length + 16;
    while (bytes > this.maxCookieBytes && rec.cookies.size) {
      const key = rec.cookies.keys().next().value;
      const c = rec.cookies.get(key);
      bytes -= c.name.length + String(c.value).length + c.domain.length + 16;
      rec.cookies.delete(key);
    }
    return bytes;
  }

  linkBrowser(sid, browserSessionId) { const rec = this.sessions.get(sid); if (rec) rec.browserSessions.add(browserSessionId); }
  unlinkBrowser(sid, browserSessionId) { const rec = this.sessions.get(sid); if (rec) rec.browserSessions.delete(browserSessionId); }

  expire(sid, reason = "idle") {
    const rec = this.sessions.get(sid);
    if (!rec) return false;
    this.sessions.delete(sid);
    if (reason === "idle") this.stats.expiredIdle += 1;
    else if (reason === "cap") this.stats.expiredCap += 1;
    else if (reason === "pressure") this.stats.expiredPressure += 1;
    else if (reason === "client") this.stats.closedByClient += 1;
    rec.cookies.clear();
    for (const fn of this.hooks.expire) { try { const r = fn(sid, rec, reason); if (r?.catch) r.catch(() => {}); } catch {} }
    return true;
  }
  close(sid) { return this.expire(sid, "client"); }

  // Idle expiry + server idle mode.
  async sweep() {
    const t = this.now();
    let n = 0;
    // Map is LRU-ordered, so stop at the first session that is still fresh.
    for (const [sid, rec] of this.sessions) {
      if (t - rec.lastUsed <= this.idleTtlMs && t - rec.createdAt <= this.hardTtlMs) break;
      this.expire(sid, "idle"); n += 1;
    }
    if (!this.sleeping && this.serverIdleMs > 0 && t - this.lastActivity > this.serverIdleMs) {
      this.sleeping = true;
      this.stats.sleeps += 1;
      this.log("info", "SESSION", `No API traffic for ${Math.round((t - this.lastActivity) / 60000)} min — entering idle mode (closing Chromium, dropping caches, pausing seed crawls).`);
      for (const fn of this.hooks.sleep) { try { await fn(); } catch {} }
    }
    return n;
  }

  // Memory governor: level "pressure" sheds sessions idle > 2 min,
  // "critical" sheds everything idle > 20 s.
  shed(level) {
    const t = this.now();
    const minIdle = level === "critical" ? 20000 : 120000;
    let n = 0;
    for (const [sid, rec] of [...this.sessions]) if (t - rec.lastUsed > minIdle) { this.expire(sid, "pressure"); n += 1; }
    if (n) this.log("warn", "SESSION", `Memory ${level}: released ${n} idle session(s).`);
    return n;
  }

  report() {
    const t = this.now();
    let cookies = 0, browsers = 0, oldest = 0;
    for (const rec of this.sessions.values()) { cookies += rec.cookies.size; browsers += rec.browserSessions.size; oldest = Math.max(oldest, t - rec.createdAt); }
    return {
      active: this.sessions.size, max: this.maxSessions, idleTtlMs: this.idleTtlMs, hardTtlMs: this.hardTtlMs,
      cookies, browserSessions: browsers, oldestSessionAgeMs: oldest,
      sleeping: this.sleeping, serverIdleMs: this.serverIdleMs, idleForMs: t - this.lastActivity, stats: { ...this.stats }
    };
  }
}

module.exports = { SessionManager };
