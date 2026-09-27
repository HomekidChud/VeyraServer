"use strict";
// Veyra Shield — a small, dependency-free edge-protection layer in the spirit of
// what Cloudflare puts in front of an origin:
//   * security response headers (HSTS, nosniff, referrer policy, permissions policy)
//   * per-client token-bucket rate limiting with separate buckets for costly routes
//   * a tiny WAF that drops obvious scanner probes (/.env, /wp-admin, path traversal…)
//   * optional IP deny list (SHIELD_BLOCK_IPS)
//   * link-preview bot detection so chat apps / social cards always see Veyra's
//     own branding instead of whatever website was last proxied.
// It never inspects or alters proxied page bodies.

const PROBE_RE = /(?:^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|\.svn\/|\.hg\/|\.DS_Store$|wp-admin|wp-login\.php|xmlrpc\.php|phpmyadmin|pma\/|cgi-bin\/|boaform|HNAP1|actuator\/|server-status$|\.aws\/|id_rsa|config\.php$|shell\.php|eval-stdin\.php)/i;
const TRAVERSAL_RE = /(?:\.\.[\\/]|%2e%2e(?:%2f|%5c|\/)|%252e%252e|\x00|%00)/i;
const PREVIEW_BOT_RE = /(?:facebookexternalhit|facebot|twitterbot|slackbot|slack-imgproxy|discordbot|telegrambot|whatsapp|linkedinbot|skypeuripreview|redditbot|embedly|pinterestbot|vkshare|iframely|mastodon|bluesky|cardyb|applebot|googlebot|bingbot|duckduckbot|yandexbot|baiduspider|petalbot|google-inspectiontool|snapchat|viber|line-poker|kakaotalk-scrap|zoominfobot|opengraph|metainspector)/i;

function clientIp(req) {
  // Render (and most PaaS) terminate TLS and append the real client to X-Forwarded-For.
  const edge = String(req.get?.("cf-connecting-ip") || req.get?.("true-client-ip") || "").trim();
  if (edge) return edge.replace(/^::ffff:/, "").slice(0, 64);
  const xff = String(req.get?.("x-forwarded-for") || req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return (xff || String(req.socket?.remoteAddress || "")).replace(/^::ffff:/, "").slice(0, 64) || "unknown";
}
function isPreviewBot(ua) { return PREVIEW_BOT_RE.test(String(ua || "")); }

class TokenBuckets {
  constructor({ capacity, refillPerSec, maxKeys = 20000 }) {
    this.capacity = Math.max(1, capacity); this.refill = Math.max(0.01, refillPerSec); this.maxKeys = maxKeys; this.map = new Map();
  }
  take(key, cost = 1, nowMs = Date.now()) {
    let b = this.map.get(key);
    if (!b) {
      b = { tokens: this.capacity, at: nowMs };
      this.map.set(key, b);
      if (this.map.size > this.maxKeys) this.map.delete(this.map.keys().next().value);
    } else {
      b.tokens = Math.min(this.capacity, b.tokens + ((nowMs - b.at) / 1000) * this.refill);
      b.at = nowMs;
    }
    if (b.tokens >= cost) { b.tokens -= cost; return { ok: true, remaining: Math.floor(b.tokens), retryAfterSec: 0 }; }
    return { ok: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((cost - b.tokens) / this.refill)) };
  }
  sweep(nowMs = Date.now()) {
    const fullAfterMs = (this.capacity / this.refill) * 1000;
    for (const [k, b] of this.map) if (nowMs - b.at > fullAfterMs) this.map.delete(k);
  }
}

function num(env, name, fallback, lo, hi) { const n = Number(env[name]); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback; }
function bool(env, name, fallback) { const v = env[name]; if (v == null || v === "") return fallback; return /^(1|true|yes|on)$/i.test(String(v)); }

function createShield(env = process.env, { log = () => {}, lean = false } = {}) {
  const enabled = bool(env, "SHIELD_ENABLED", true);
  const level = String(env.SHIELD_LEVEL || "medium").toLowerCase(); // low | medium | high | under_attack
  const mult = level === "low" ? 2 : level === "high" ? 0.6 : level === "under_attack" ? 0.3 : 1;
  const buckets = {
    // Proxy traffic is bursty (a single page can pull 100+ sub-resources).
    proxy: new TokenBuckets({ capacity: Math.round(num(env, "SHIELD_PROXY_BURST", lean ? 600 : 1200, 50, 100000) * mult), refillPerSec: num(env, "SHIELD_PROXY_RPS", lean ? 60 : 120, 1, 10000) * mult }),
    api: new TokenBuckets({ capacity: Math.round(num(env, "SHIELD_API_BURST", 120, 10, 10000) * mult), refillPerSec: num(env, "SHIELD_API_RPS", 10, 0.5, 1000) * mult }),
    // Expensive: new sessions, Chromium launches, crawls, sign-in attempts.
    heavy: new TokenBuckets({ capacity: Math.round(num(env, "SHIELD_HEAVY_BURST", 30, 3, 1000) * mult), refillPerSec: num(env, "SHIELD_HEAVY_RPS", 0.5, 0.01, 100) * mult }),
    auth: new TokenBuckets({ capacity: Math.round(num(env, "SHIELD_AUTH_BURST", 10, 2, 1000) * mult), refillPerSec: num(env, "SHIELD_AUTH_RPS", 0.1, 0.01, 100) * mult })
  };
  const blockIps = new Set(String(env.SHIELD_BLOCK_IPS || "").split(",").map(s => s.trim()).filter(Boolean));
  const stats = { allowed: 0, rateLimited: 0, wafBlocked: 0, ipBlocked: 0, previewBots: 0, since: new Date().toISOString() };
  const sweep = setInterval(() => { for (const b of Object.values(buckets)) b.sweep(); }, 60000); sweep.unref?.();

  function bucketFor(req) {
    const p = req.path || "";
    const m = req.method;
    if (/^\/api\/auth\/(?:login|signup|password|reset)/.test(p) && m === "POST") return "auth";
    if ((p === "/api/session" && m === "POST") || /^\/api\/browser\/(?:session|open|start)/.test(p) || (p === "/api/open" && m === "POST") || /^\/api\/crawl(?:\/|$)/.test(p) && m === "POST") return "heavy";
    if (/^\/api\/(?:view|resource|form-get|download)/.test(p)) return "proxy";
    if (p.startsWith("/api/")) return "api";
    return "proxy"; // relative-fallback resources land on arbitrary root paths
  }

  function headers(req, res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Veyra-Shield", enabled ? level : "off");
    if (req.secure || /https/i.test(String(req.get("x-forwarded-proto") || ""))) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("Permissions-Policy", "interest-cohort=(), browsing-topics=()");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    // Proxied pages must never be indexed under Veyra's domain (that is what made
    // search engines / link previews show a random site's title and image).
    if (/^\/api\//.test(req.path || "")) res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  }

  function middleware(req, res, next) {
    headers(req, res);
    if (!enabled) return next();
    const ip = clientIp(req);
    if (blockIps.has(ip)) { stats.ipBlocked += 1; return res.status(403).type("text/plain").send("Blocked by Veyra Shield."); }
    let rawPath = String(req.originalUrl || req.url || "").split("?")[0];
    // Only probe Veyra's own paths. /api/view?url=… carries the target in the
    // query string and is validated separately by assertPublicUrl().
    if (PROBE_RE.test(rawPath) || TRAVERSAL_RE.test(rawPath)) {
      const referer = String(req.get("referer") || "");
      if (!/\/api\/(?:view|resource|form-get)/.test(referer)) {
        stats.wafBlocked += 1;
        return res.status(404).type("text/plain").send("Not found.");
      }
    }
    if (req.method === "OPTIONS" || req.path === "/health" || req.path === "/api/shield") return next();
    const name = bucketFor(req);
    const r = buckets[name].take(ip);
    res.setHeader("X-RateLimit-Remaining", String(r.remaining));
    if (!r.ok) {
      stats.rateLimited += 1;
      res.setHeader("Retry-After", String(r.retryAfterSec));
      if (stats.rateLimited % 50 === 1) log("warn", "SHIELD", `Rate limit (${name}) for ${ip.replace(/\d+$/, "x")} — retry in ${r.retryAfterSec}s`);
      return res.status(429).json({ ok: false, code: "RATE_LIMITED", error: `Too many requests. Veyra Shield paused this client for ${r.retryAfterSec}s.`, retryAfterSec: r.retryAfterSec, bucket: name });
    }
    stats.allowed += 1;
    next();
  }

  function status() { return { enabled, level, lean, blockIps: blockIps.size, buckets: Object.fromEntries(Object.entries(buckets).map(([k, b]) => [k, { capacity: b.capacity, refillPerSec: b.refill, tracked: b.map.size }])), stats: { ...stats } }; }
  return { middleware, status, isPreviewBot, clientIp, buckets, stats };
}

module.exports = { createShield, TokenBuckets, isPreviewBot, clientIp, PROBE_RE, TRAVERSAL_RE };
