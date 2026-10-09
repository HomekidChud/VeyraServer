"use strict";












class SessionManager {
  constructor(opts = {}) {
    this.maxSessions = opts.maxSessions || 500;
    this.idleTtlMs = opts.idleTtlMs || 30 * 60 * 1000;
    this.hardTtlMs = opts.hardTtlMs || 24 * 60 * 60 * 1000;
    this.maxCookieBytes = opts.maxCookieBytes || 128 * 1024;
    
    
    this.timeLimitMs = Math.max(0, Number(opts.timeLimitMs || 0));
    this.sweepMs = opts.sweepMs || (this.timeLimitMs ? Math.min(30000, Math.max(2000, Math.floor(this.timeLimitMs / 8))) : 30000);
    this.tombstones = new Map();
    this.maxTombstones = opts.maxTombstones || 20000;
    this.tombstoneTtlMs = opts.tombstoneTtlMs || 6 * 60 * 60 * 1000;
    this.serverIdleMs = opts.serverIdleMs ?? 10 * 60 * 1000;
    this.log = opts.log || (() => {});
    this.now = opts.now || (() => Date.now());
    this.sessions = new Map();
    this.hooks = { expire: [], sleep: [], wake: [] };
    this.stats = { created: 0, expiredLimit: 0, expiredIdle: 0, expiredCap: 0, expiredPressure: 0, closedByClient: 0, sleeps: 0, wakes: 0 };
    this.lastActivity = this.now();
    this.sleeping = false;
    this.timer = null;
    
    
    
    this.pausedSessions = new Map();
  }
  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => { this.sweep().catch(e => this.log("warn", "SESSION", `Sweep failed: ${e.message}`)); }, this.sweepMs);
    this.timer.unref?.();
    return this;
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  on(event, fn) { (this.hooks[event] ||= []).push(fn); return this; }

  
  activity() {
    this.lastActivity = this.now();
    if (this.sleeping) {
      this.sleeping = false;
      this.stats.wakes += 1;
      this.log("info", "SESSION", "Server woke from idle mode.");
      for (const fn of this.hooks.wake) { try { fn(); } catch {} }
    }
  }

  
  touch(sid) {
    const t = this.now();
    let rec = this.sessions.get(sid);
    
    const paused = this.isPaused(sid);
    const recordLimit = rec?.timeLimitMs ?? this.timeLimitMs;
    if (rec && !paused && recordLimit && t - rec.createdAt >= recordLimit) {
      this.expire(sid, "limit");
      rec = null;
    }
    if (rec && !paused && (t - rec.lastUsed > this.idleTtlMs || t - rec.createdAt > this.hardTtlMs)) {
      this.expire(sid, "idle");
      rec = null;
    }
    if (!rec) {
      if (this.isTerminated(sid)) {
        const err = new Error("This Veyra session reached its time limit and was deleted. Start a new session.");
        err.code = "SESSION_EXPIRED"; err.status = 410;
        throw err;
      }
      rec = { id: sid, createdAt: t, lastUsed: t, cookies: new Map(), vpnProfileId: null, browserSessions: new Set(), requests: 0, bytesOut: 0 };
      this.sessions.set(sid, rec);
      this.stats.created += 1;
      this.enforceCap();
      
      if (this._hydrateFn) { try { this._hydrateFn(sid, rec); } catch {} }
    } else {
      this.sessions.delete(sid);
      this.sessions.set(sid, rec);
    }
    rec.lastUsed = t;
    rec.requests += 1;
    return rec;
  }
  peek(sid) { return this.sessions.get(sid) || null; }

  
  create(sid, { timeLimitMs = null } = {}) {
    if (this.sessions.has(sid) || this.isTerminated(sid)) throw Object.assign(new Error("Session id already used."), { code: "SESSION_EXISTS", status: 409 });
    const rec = this.touch(sid);
    rec.timeLimitMs = timeLimitMs == null ? this.timeLimitMs : Math.max(0, Number(timeLimitMs) || 0);
    rec.requests = 0;
    return rec;
  }
  expiresAt(rec) { const limit = rec?.timeLimitMs ?? this.timeLimitMs; return limit ? rec.createdAt + limit + (rec.renewedMs || 0) : null; }
  remainingMs(rec) { const limit = rec?.timeLimitMs ?? this.timeLimitMs; return limit ? Math.max(0, rec.createdAt + limit + (rec.renewedMs || 0) - this.now()) : null; }
  
  
  
  renew(sid, ms) {
    const rec = this.sessions.get(sid);
    if (!rec) throw Object.assign(new Error("Session not found."), { code: "SESSION_NOT_FOUND", status: 404 });
    const limit = rec.timeLimitMs ?? this.timeLimitMs;
    if (!limit) return { renewed: false, reason: "no-limit", remainingMs: this.remainingMs(rec) };
    const add = Math.max(1000, Math.min(60 * 60 * 1000, Number(ms) || 0));
    const newRemaining = Math.min(this.hardTtlMs, this.remainingMs(rec) + add);
    rec.renewedMs = (rec.renewedMs || 0) + Math.max(0, newRemaining - this.remainingMs(rec));
    rec.renewCount = (rec.renewCount || 0) + 1;
    this.log("info", "SESSION", `Session ${sid.slice(0, 8)} renewed by +${Math.round(add / 1000)}s (renewal #${rec.renewCount}).`);
    return { renewed: true, expiresAt: this.expiresAt(rec), remainingMs: this.remainingMs(rec), renewCount: rec.renewCount };
  }
  isTerminated(sid) {
    const at = this.tombstones.get(sid);
    if (at == null) return false;
    if (this.now() - at > this.tombstoneTtlMs) { this.tombstones.delete(sid); return false; }
    return true;
  }
  
  checkLimit(sid) {
    if (!sid) return false;
    if (this.isTerminated(sid)) return true;
    if (this.isPaused(sid)) return false; 
    const rec = this.sessions.get(sid);
    const limit = rec?.timeLimitMs ?? this.timeLimitMs;
    if (rec && limit && this.now() - rec.createdAt >= limit + (rec.renewedMs || 0)) { this.expire(sid, "limit"); return true; }
    return false;
  }
  tombstone(sid) {
    this.tombstones.delete(sid);
    this.tombstones.set(sid, this.now());
    while (this.tombstones.size > this.maxTombstones) this.tombstones.delete(this.tombstones.keys().next().value);
  }
  has(sid) { return this.sessions.has(sid); }
  get size() { return this.sessions.size; }

  enforceCap() {
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (!oldest) break;
      this.expire(oldest, "cap");
    }
  }

  
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

  
  
  setHydrateFn(fn) { this._hydrateFn = fn; }
  
  
  pauseForVerification(sid, reason = 'challenge') {
    if (!sid) return;
    this.pausedSessions.set(sid, { until: 0, reason, startedAt: this.now() });
    this.log("info", "SESSION", `Session ${sid.slice(0, 8)}… paused for verification (${reason}). Expiry suspended.`);
  }
  resumeFromVerification(sid) {
    const p = this.pausedSessions.get(sid);
    if (!p) return false;
    this.pausedSessions.delete(sid);
    
    const rec = this.sessions.get(sid);
    if (rec) rec.lastUsed = this.now();
    this.log("info", "SESSION", `Session ${sid.slice(0, 8)}… resumed from verification.`);
    return true;
  }
  isPaused(sid) {
    if (!sid) return false;
    return this.pausedSessions.has(sid);
  }
  pausedInfo(sid) {
    return this.pausedSessions.get(sid) || null;
  }

  
  
  importPlaywrightCookies(sid, cookies) {
    if (!sid || !Array.isArray(cookies)) return;
    const rec = this.sessions.get(sid);
    if (!rec) return;
    for (const c of cookies) {
      if (!c || !c.name) continue;
      const key = `${c.domain || ''}|${c.path || '/'}|${c.name}`;
      rec.cookies.set(key, {
        name: c.name,
        value: String(c.value || ''),
        domain: String(c.domain || '').toLowerCase(),
        path: c.path || '/',
        secure: !!c.secure,
        hostOnly: !c.domain || c.domain === 'localhost',
        expiresAt: c.expires > 0 ? c.expires * 1000 : 0,
        httpOnly: !!c.httpOnly,
        sameSite: c.sameSite || 'Lax'
      });
    }
    this.trimCookies(rec);
  }
  
  exportPlaywrightCookies(sid) {
    const rec = this.sessions.get(sid);
    if (!rec) return [];
    return [...rec.cookies.values()].map(c => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
      secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite || 'Lax',
      expires: c.expiresAt > 0 ? Math.floor(c.expiresAt / 1000) : -1
    }));
  }
  
  getStorageState(sid) {
    const cookies = this.exportPlaywrightCookies(sid);
    return { cookies, origins: [] };
  }

  linkBrowser(sid, browserSessionId) { const rec = this.sessions.get(sid); if (rec) rec.browserSessions.add(browserSessionId); }
  unlinkBrowser(sid, browserSessionId) { const rec = this.sessions.get(sid); if (rec) rec.browserSessions.delete(browserSessionId); }

  expire(sid, reason = "idle") {
    const rec = this.sessions.get(sid);
    if (!rec) return false;
    this.sessions.delete(sid);
    
    this.pausedSessions.delete(sid);
    if (reason === "limit" || reason === "client") this.tombstone(sid);
    if (reason === "limit") this.stats.expiredLimit += 1;
    else if (reason === "idle") this.stats.expiredIdle += 1;
    else if (reason === "cap") this.stats.expiredCap += 1;
    else if (reason === "pressure") this.stats.expiredPressure += 1;
    else if (reason === "client") this.stats.closedByClient += 1;
    rec.cookies.clear();
    for (const fn of this.hooks.expire) { try { const r = fn(sid, rec, reason); if (r?.catch) r.catch(() => {}); } catch {} }
    return true;
  }
  close(sid) { return this.expire(sid, "client"); }

  
  async sweep() {
    const t = this.now();
    let n = 0;
    if (this.timeLimitMs || [...this.sessions.values()].some(rec => rec.timeLimitMs)) {
      for (const [sid, rec] of [...this.sessions]) {
        const limit = rec.timeLimitMs ?? this.timeLimitMs;
        if (limit && t - rec.createdAt >= limit + (rec.renewedMs || 0)) { this.expire(sid, "limit"); n += 1; }
      }
      for (const [sid, at] of this.tombstones) { if (t - at <= this.tombstoneTtlMs) break; this.tombstones.delete(sid); }
    }
    
    for (const [sid, rec] of this.sessions) {
      if (this.isPaused(sid)) continue; 
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

  
  
  shed(level) {
    const t = this.now();
    const minIdle = level === "critical" ? 20000 : 120000;
    let n = 0;
    for (const [sid, rec] of [...this.sessions]) {
      if (this.isPaused(sid)) continue; 
      if (t - rec.lastUsed > minIdle) { this.expire(sid, "pressure"); n += 1; }
    }
    if (n) this.log("warn", "SESSION", `Memory ${level}: released ${n} idle session(s).`);
    return n;
  }

  report() {
    const t = this.now();
    let cookies = 0, browsers = 0, oldest = 0;
    for (const rec of this.sessions.values()) { cookies += rec.cookies.size; browsers += rec.browserSessions.size; oldest = Math.max(oldest, t - rec.createdAt); }
    return {
      active: this.sessions.size, max: this.maxSessions, timeLimitMs: this.timeLimitMs, tombstones: this.tombstones.size, idleTtlMs: this.idleTtlMs, hardTtlMs: this.hardTtlMs,
      cookies, browserSessions: browsers, oldestSessionAgeMs: oldest,
      sleeping: this.sleeping, serverIdleMs: this.serverIdleMs, idleForMs: t - this.lastActivity, stats: { ...this.stats },
      sessions: [...this.sessions.entries()].slice(-100).reverse().map(([id, rec]) => ({ id: id.slice(0, 8) + "…", sessionId: id, role: rec.role || "user", ageMs: t - rec.createdAt, remainingMs: this.remainingMs(rec), timeLimitMs: rec.timeLimitMs ?? this.timeLimitMs, requests: rec.requests || 0, cookies: rec.cookies.size, browserSessions: rec.browserSessions.size, userId: rec.userId ? String(rec.userId).slice(0, 8) : null, paused: this.isPaused(id) })),
      pausedSessions: this.pausedSessions.size
    };
  }
}

module.exports = { SessionManager };
