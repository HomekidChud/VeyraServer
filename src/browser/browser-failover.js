"use strict";
/**
 * Veyra Browser Failover Controller — v8.19.0
 *
 * Makes the fast proxy a real second lane, not just a hard-coded fallback.
 *
 * 1. Circuit breaker: per proxy-session failure counter. After `failureThreshold`
 *    Chromium failures (crash, timeout, OOM), the breaker opens and skips
 *    Chromium for `cooldownMs` (~60s), then half-opens to retry.
 * 2. Memory pre-check: when RSS passes ~80% of memoryLimitMb, proactively
 *    route to the fast proxy BEFORE Chromium can crash.
 * 3. Provides `shouldUseChromium(proxySid)` and `recordBrowserResult(proxySid, ok)`
 *    so server.js can consult it before launching Chromium and feed results back.
 *
 * The breaker key is the proxy session id (not hostname) because the
 * requirement is "for that session."
 */

const DEFAULTS = {
  failureThreshold: 3,      
  cooldownMs: 60_000,        
  halfOpenMaxMs: 15_000,     
  memoryThreshold: 0.80,     
  memoryCritical: 0.90,      
  maxMemorySamples: 30,      
};

class FailoverController {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    
    this.breakers = new Map();
    
    this.memoryHistory = [];
    this.currentMemoryRatio = 0;
    this.memoryPressure = false;
    this.memoryCritical = false;
    this.log = opts.log || (() => {});
  }

  
  
  updateMemory(ratio) {
    this.currentMemoryRatio = ratio;
    this.memoryPressure = ratio >= this.cfg.memoryThreshold;
    this.memoryCritical = ratio >= this.cfg.memoryCritical;
    this.memoryHistory.push(ratio);
    if (this.memoryHistory.length > this.cfg.maxMemorySamples) this.memoryHistory.shift();
  }

  
  memoryTrendingUp() {
    if (this.memoryHistory.length < 4) return this.memoryPressure;
    const recent = this.memoryHistory.slice(-4);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const prev = this.memoryHistory.slice(-8, -4);
    const prevAvg = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : avg;
    return avg > prevAvg && avg >= this.cfg.memoryThreshold * 0.9;
  }

  
  _getBreaker(proxySid) {
    let b = this.breakers.get(proxySid);
    if (!b) {
      b = { state: 'closed', failures: 0, successes: 0, openedAt: 0, lastFailure: 0, lastSuccess: 0, trialInProgress: false };
      this.breakers.set(proxySid, b);
    }
    return b;
  }

  
  
  shouldUseChromium(proxySid) {
    
    if (this.memoryCritical) {
      return { allow: false, reason: 'memory_critical', retryAfterMs: 5000 };
    }
    if (this.memoryPressure || this.memoryTrendingUp()) {
      
      
      if (this._breakerOpen(proxySid)) {
        return { allow: false, reason: 'memory_pressure_breaker_open', retryAfterMs: this._remainingCooldown(proxySid) };
      }
    }

    const b = this._getBreaker(proxySid);
    if (b.state === 'open') {
      const elapsed = Date.now() - b.openedAt;
      if (elapsed >= this.cfg.cooldownMs) {
        
        b.state = 'half_open';
        b.trialInProgress = true;
        this.log('info', 'FAILOVER', `Breaker for session ${proxySid?.slice(0, 8)}… half-open (trial request).`);
        return { allow: true, reason: 'half_open_trial', retryAfterMs: 0 };
      }
      return { allow: false, reason: 'breaker_open', retryAfterMs: this._remainingCooldown(proxySid) };
    }
    if (b.state === 'half_open' && b.trialInProgress) {
      
      return { allow: false, reason: 'trial_in_progress', retryAfterMs: this.cfg.halfOpenMaxMs };
    }
    return { allow: true, reason: 'ok', retryAfterMs: 0 };
  }

  _breakerOpen(proxySid) {
    const b = this.breakers.get(proxySid);
    return b && b.state === 'open';
  }

  _remainingCooldown(proxySid) {
    const b = this.breakers.get(proxySid);
    if (!b || b.state !== 'open') return 0;
    return Math.max(0, this.cfg.cooldownMs - (Date.now() - b.openedAt));
  }

  
  recordBrowserResult(proxySid, ok, errorType) {
    const b = this._getBreaker(proxySid);

    if (b.state === 'half_open') {
      b.trialInProgress = false;
      if (ok) {
        b.state = 'closed';
        b.failures = 0;
        b.successes += 1;
        b.lastSuccess = Date.now();
        this.log('info', 'FAILOVER', `Breaker for session ${proxySid?.slice(0, 8)}… closed (trial succeeded).`);
      } else {
        b.failures += 1;
        b.lastFailure = Date.now();
        b.state = 'open';
        b.openedAt = Date.now();
        this.log('warn', 'FAILOVER', `Breaker for session ${proxySid?.slice(0, 8)}… re-opened after trial failure (${errorType || 'unknown'}). Cooldown ${this.cfg.cooldownMs}ms.`);
      }
      return;
    }

    if (ok) {
      b.failures = 0;
      b.successes += 1;
      b.lastSuccess = Date.now();
      
      if (b.state !== 'closed') {
        b.state = 'closed';
        this.log('info', 'FAILOVER', `Breaker for session ${proxySid?.slice(0, 8)}… closed (success).`);
      }
    } else {
      b.failures += 1;
      b.lastFailure = Date.now();
      if (b.failures >= this.cfg.failureThreshold) {
        b.state = 'open';
        b.openedAt = Date.now();
        this.log('warn', 'FAILOVER', `Breaker for session ${proxySid?.slice(0, 8)}… opened after ${b.failures} failures (last: ${errorType || 'unknown'}). Cooldown ${this.cfg.cooldownMs}ms.`);
      } else {
        this.log('info', 'FAILOVER', `Breaker for session ${proxySid?.slice(0, 8)}… failure ${b.failures}/${this.cfg.failureThreshold} (${errorType || 'unknown'}).`);
      }
    }
  }

  
  reset(proxySid) {
    const b = this.breakers.get(proxySid);
    if (b) {
      b.state = 'closed';
      b.failures = 0;
      b.trialInProgress = false;
      this.log('info', 'FAILOVER', `Breaker for session ${proxySid?.slice(0, 8)}… manually reset.`);
    }
  }

  
  shouldUseFastProxy(proxySid) {
    return !this.shouldUseChromium(proxySid).allow;
  }

  
  breakerStatus(proxySid) {
    const b = this.breakers.get(proxySid);
    if (!b) return { state: 'closed', failures: 0, successes: 0, cooldownRemainingMs: 0 };
    return {
      state: b.state,
      failures: b.failures,
      successes: b.successes,
      cooldownRemainingMs: this._remainingCooldown(proxySid),
      lastFailure: b.lastFailure ? new Date(b.lastFailure).toISOString() : null,
      lastSuccess: b.lastSuccess ? new Date(b.lastSuccess).toISOString() : null
    };
  }

  
  cleanup(activeSessionIds) {
    const active = new Set(activeSessionIds);
    let removed = 0;
    for (const key of this.breakers.keys()) {
      if (!active.has(key)) { this.breakers.delete(key); removed++; }
    }
    return removed;
  }

  report() {
    let open = 0, halfOpen = 0, closed = 0;
    for (const b of this.breakers.values()) {
      if (b.state === 'open') open++;
      else if (b.state === 'half_open') halfOpen++;
      else closed++;
    }
    return {
      memoryRatio: Math.round(this.currentMemoryRatio * 100) / 100,
      memoryPressure: this.memoryPressure,
      memoryCritical: this.memoryCritical,
      memoryTrendingUp: this.memoryTrendingUp(),
      breakers: { total: this.breakers.size, open, halfOpen, closed },
      cfg: { ...this.cfg }
    };
  }
}

module.exports = { FailoverController, DEFAULTS };
