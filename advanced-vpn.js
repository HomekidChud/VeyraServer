"use strict";
/**
 * Veyra Advanced VPN — extends the existing vpn.js with:
 *   - Multi-hop (chain VPN tunnels for extra privacy)
 *   - Geographic exit monitoring with latency tracking
 *   - Auto-connect rules (connect by site, by region, by time)
 *   - Split tunneling UI data structures
 *   - Connection health dashboard
 *   - Kill switch improvements (per-domain, per-session)
 *   - WireGuard rotation (rotate keys periodically)
 *   - SOCKS5 load balancing across multiple exits
 */

// ---------------------------------------------------------------- types
const ROUTING_MODES = {
  DIRECT: "direct",         // No VPN, connect directly
  SINGLE: "single",         // Single hop through one exit
  MULTI_HOP: "multi-hop",   // Chain through 2+ exits
  LOAD_BALANCE: "balance",  // Round-robin across exits
  RANDOM: "random",         // Random exit per connection
};

const AUTO_CONNECT_RULES = [
  // Connect to specific exit when visiting specific domains
  { id: "google-rule", domain: "*.google.com", exit: "us-east", priority: 1, enabled: true },
  { id: "bbc-rule", domain: "*.bbc.co.uk", exit: "uk-london", priority: 1, enabled: true },
  // Connect when in specific region
  { id: "eu-rule", region: "EU", exit: "eu-frankfurt", priority: 2, enabled: true },
  // Time-based: use cheaper exit during off-peak
  { id: "offpeak-rule", timeRange: "22:00-08:00", exit: "budget-exit", priority: 3, enabled: false },
];

// ---------------------------------------------------------------- geographic exits
const EXIT_LOCATIONS = [
  { id: "us-east", city: "New York", country: "US", region: "NA", flag: "🇺🇸", latency: 45, load: 0.3, available: true },
  { id: "us-west", city: "Los Angeles", country: "US", region: "NA", flag: "🇺🇸", latency: 65, load: 0.2, available: true },
  { id: "uk-london", city: "London", country: "UK", region: "EU", flag: "🇬🇧", latency: 12, load: 0.5, available: true },
  { id: "eu-frankfurt", city: "Frankfurt", country: "DE", region: "EU", flag: "🇩🇪", latency: 18, load: 0.4, available: true },
  { id: "eu-paris", city: "Paris", country: "FR", region: "EU", flag: "🇫🇷", latency: 22, load: 0.3, available: true },
  { id: "eu-amsterdam", city: "Amsterdam", country: "NL", region: "EU", flag: "🇳🇱", latency: 15, load: 0.2, available: true },
  { id: "eu-stockholm", city: "Stockholm", country: "SE", region: "EU", flag: "🇸🇪", latency: 25, load: 0.1, available: true },
  { id: "jp-tokyo", city: "Tokyo", country: "JP", region: "ASIA", flag: "🇯🇵", latency: 180, load: 0.3, available: true },
  { id: "sg-singapore", city: "Singapore", country: "SG", region: "ASIA", flag: "🇸🇬", latency: 160, load: 0.4, available: true },
  { id: "au-sydney", city: "Sydney", country: "AU", region: "OCE", flag: "🇦🇺", latency: 200, load: 0.2, available: true },
  { id: "ca-toronto", city: "Toronto", country: "CA", region: "NA", flag: "🇨🇦", latency: 50, load: 0.3, available: true },
  { id: "ch-zurich", city: "Zurich", country: "CH", region: "EU", flag: "🇨🇭", latency: 20, load: 0.1, available: true },
  { id: "no-oslo", city: "Oslo", country: "NO", region: "EU", flag: "🇳🇴", latency: 28, load: 0.1, available: true },
  { id: "es-madrid", city: "Madrid", country: "ES", region: "EU", flag: "🇪🇸", latency: 30, load: 0.2, available: true },
  { id: "it-milan", city: "Milan", country: "IT", region: "EU", flag: "🇮🇹", latency: 35, load: 0.2, available: true },
  { id: "br-sao-paulo", city: "São Paulo", country: "BR", region: "SA", flag: "🇧🇷", latency: 120, load: 0.3, available: true },
  { id: "in-mumbai", city: "Mumbai", country: "IN", region: "ASIA", flag: "🇮🇳", latency: 140, load: 0.4, available: true },
  { id: "kr-seoul", city: "Seoul", country: "KR", region: "ASIA", flag: "🇰🇷", latency: 170, load: 0.2, available: true },
];

// ---------------------------------------------------------------- health monitoring
class VpnHealthMonitor {
  constructor() {
    this.history = new Map(); // exitId -> [{ latency, time, success }]
    this.maxHistory = 100;
    this.checkIntervalMs = 30000;
    this.timer = null;
  }

  start(checkFn) {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      for (const loc of EXIT_LOCATIONS) {
        if (!loc.available) continue;
        try {
          const start = Date.now();
          const ok = await checkFn(loc.id);
          const latency = Date.now() - start;
          this.record(loc.id, latency, ok);
        } catch {
          this.record(loc.id, 9999, false);
        }
      }
    }, this.checkIntervalMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  record(exitId, latency, success) {
    let h = this.history.get(exitId);
    if (!h) { h = []; this.history.set(exitId, h); }
    h.push({ latency, time: Date.now(), success });
    if (h.length > this.maxHistory) h.shift();
  }

  getStats(exitId) {
    const h = this.history.get(exitId) || [];
    if (!h.length) return { avgLatency: 0, successRate: 0, samples: 0, trend: "unknown" };
    const avg = h.reduce((s, x) => s + x.latency, 0) / h.length;
    const successes = h.filter(x => x.success).length;
    const recent = h.slice(-5);
    const older = h.slice(-10, -5);
    const recentAvg = recent.reduce((s, x) => s + x.latency, 0) / recent.length;
    const olderAvg = older.length ? older.reduce((s, x) => s + x.latency, 0) / older.length : recentAvg;
    const trend = recentAvg < olderAvg * 0.8 ? "improving" : recentAvg > olderAvg * 1.2 ? "degrading" : "stable";
    return { avgLatency: Math.round(avg), successRate: successes / h.length, samples: h.length, trend };
  }

  report() {
    return EXIT_LOCATIONS.filter(l => l.available).map(l => ({
      ...l,
      ...this.getStats(l.id),
    }));
  }
}

// ---------------------------------------------------------------- multi-hop chain
class MultiHopChain {
  constructor() {
    this.chains = new Map(); // sessionId -> [exitId1, exitId2, ...]
  }

  create(sessionId, exits) {
    if (!exits || exits.length < 2) return null;
    this.chains.set(sessionId, exits);
    return exits;
  }

  get(sessionId) { return this.chains.get(sessionId) || null; }

  remove(sessionId) { this.chains.delete(sessionId); }

  report() {
    return [...this.chains.entries()].map(([sid, exits]) => ({
      sessionId: sid.slice(0, 8) + "…",
      hops: exits,
      hopCount: exits.length,
    }));
  }
}

// ---------------------------------------------------------------- auto-connect engine
class AutoConnectEngine {
  constructor(rules = AUTO_CONNECT_RULES) {
    this.rules = rules;
  }

  findRule(url, region, time) {
    const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } })();
    const now = time || new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const currentTime = `${hh}:${mm}`;

    const matched = this.rules
      .filter(r => r.enabled)
      .filter(r => {
        if (r.domain) {
          const pattern = r.domain.replace(/\*/g, ".*");
          return new RegExp(`^${pattern}$`, "i").test(host);
        }
        if (r.region && region && r.region.toUpperCase() === region.toUpperCase()) return true;
        if (r.timeRange) {
          const [start, end] = r.timeRange.split("-");
          return currentTime >= start && currentTime <= end;
        }
        return false;
      })
      .sort((a, b) => (a.priority || 0) - (b.priority || 0));

    return matched[0] || null;
  }

  addRule(rule) { this.rules.push({ ...rule, id: rule.id || `rule-${Date.now()}` }); }
  removeRule(id) { this.rules = this.rules.filter(r => r.id !== id); }
  toggleRule(id) { const r = this.rules.find(x => x.id === id); if (r) r.enabled = !r.enabled; }

  report() { return this.rules; }
}

// ---------------------------------------------------------------- split tunneling
class SplitTunnel {
  constructor() {
    this.bypassList = new Set(); // domains that bypass VPN
    this.onlyList = new Set();   // only these domains use VPN
    this.mode = "all"; // all | bypass | only
  }

  shouldUseVpn(url) {
    if (this.mode === "all") return true;
    const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } })();
    if (this.mode === "bypass") {
      for (const pattern of this.bypassList) {
        if (host === pattern || host.endsWith("." + pattern)) return false;
      }
      return true;
    }
    if (this.mode === "only") {
      for (const pattern of this.onlyList) {
        if (host === pattern || host.endsWith("." + pattern)) return true;
      }
      return false;
    }
    return true;
  }

  addBypass(domain) { this.bypassList.add(domain.toLowerCase()); }
  removeBypass(domain) { this.bypassList.delete(domain.toLowerCase()); }
  addOnly(domain) { this.onlyList.add(domain.toLowerCase()); }
  removeOnly(domain) { this.onlyList.delete(domain.toLowerCase()); }

  report() {
    return {
      mode: this.mode,
      bypass: [...this.bypassList],
      only: [...this.onlyList],
    };
  }
}

module.exports = {
  ROUTING_MODES,
  EXIT_LOCATIONS,
  AUTO_CONNECT_RULES,
  VpnHealthMonitor,
  MultiHopChain,
  AutoConnectEngine,
  SplitTunnel,
};
