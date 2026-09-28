"use strict";
/**
 * Veyra Lightweight Challenge Solver — handles security checks WITHOUT Chromium.
 *
 * Many sites show Cloudflare challenges, CAPTCHAs, or JavaScript-based
 * security checks. Currently Veyra falls back to Chromium for these, which
 * is slow and unreliable. This module provides lightweight alternatives:
 *
 * 1. Cookie-based challenge solving (replay challenge cookies)
 * 2. JavaScript challenge solving (eval the challenge JS in Node, not Chromium)
 * 3. Header-based bypass (proper browser headers that pass most checks)
 * 4. Turnstile/hCaptcha detection (return a helpful message instead of hanging)
 * 5. Meta-refresh redirect following (common in challenge pages)
 *
 * Integration in server.js:
 *   const { ChallengeSolver } = require('./challenge-solver');
 *   const solver = new ChallengeSolver();
 *   // In the fetch pipeline, before falling back to Chromium:
 *   if (solver.isChallengePage(html, statusCode)) {
 *     const solved = await solver.solve(url, html, statusCode, headers);
 *     if (solved) return solved;  // Skip Chromium entirely
 *   }
 */

const https = require("https");
const http = require("http");
const { URL } = require("url");
const vm = require("vm");

class ChallengeSolver {
  constructor(opts = {}) {
    this.userAgent = opts.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    this.cookieJar = new Map();  // domain -> [{name, value, expires}]
    this.challengeCache = new Map();  // url -> {html, expires}
    this.maxRetries = opts.maxRetries || 2;
    this.timeoutMs = opts.timeoutMs || 8000;
    this.log = opts.log || (() => {});

    // Challenge detection patterns
    this.challengePatterns = [
      /Just a moment\.\.\./i,                           // Cloudflare
      /Checking your browser/i,                          // Cloudflare
      /cf-browser-verification/i,                        // Cloudflare
      /cf-challenge-running/i,                           // Cloudflare
      /__cf_chl/i,                                       // Cloudflare
      /challenge-platform/i,                             // Cloudflare Turnstile
      /Please wait while we verify your browser/i,       // Various
      /enable JavaScript/i,                              // Generic JS check
      /noscript.*enable.*javascript/is,                 // Generic
      /DDoS protection/i,                               // Various WAFs
      /Access denied|Access Denied/i,                    // Various WAFs
      /Attention Required/i,                             // Cloudflare
      /Ray ID:/i,                                        // Cloudflare
      /__dd_host/i,                                      // DDos-Guard
      /blazingfast\.ws/i,                                // BlazingFast
      /Sucuri/i,                                         // Sucuri WAF
      /PerimeterX/i,                                     // PerimeterX
      /Shape Security/i,                                // Shape Security
    ];

    // Challenge cookie patterns
    this.challengeCookiePatterns = [
      /cf_clearance/i,
      /__cf_bm/i,
      /__ddgid/i,
      /__ddgmark/i,
      /sucuri_cloudproxy_uuid/i,
      /pxhd/i,    // PerimeterX
      /csrf/i,
    ];
  }

  /**
   * Check if a page is a challenge/security check page.
   */
  isChallengePage(html, statusCode) {
    if (!html) return false;
    // Status codes that often indicate challenges
    if ([403, 429, 503].includes(statusCode)) {
      // Check if it's actually a challenge page vs a real error
      for (const pattern of this.challengePatterns) {
        if (pattern.test(html)) return true;
      }
    }
    // Also check 200 status pages that are actually challenges
    if (statusCode === 200) {
      for (const pattern of this.challengePatterns) {
        if (pattern.test(html)) return true;
      }
      // Check for meta refresh redirects (common in challenges)
      if (/<meta[^>]+http-equiv=["']refresh["'][^>]+url=/i.test(html) && html.length < 5000) {
        return true;
      }
      // Very short pages with just a script
      if (html.length < 3000 && /<script[^>]*>/.test(html) && !/<body[^>]*>[\s\S]{200,}/i.test(html)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Detect what type of challenge this is.
   */
  detectChallengeType(html) {
    if (/cloudflare|cf-challenge|cf-browser|__cf_chl|Ray ID/i.test(html)) return "cloudflare";
    if (/__dd_host|ddos-guard/i.test(html)) return "ddos-guard";
    if (/sucuri/i.test(html)) return "sucuri";
    if (/perimeterx|pxhd/i.test(html)) return "perimeterx";
    if (/blazingfast/i.test(html)) return "blazingfast";
    if (/turnstile|cf-turnstile/i.test(html)) return "turnstile";
    if (/hcaptcha/i.test(html)) return "hcaptcha";
    if (/recaptcha/i.test(html)) return "recaptcha";
    if (/<meta[^>]+http-equiv=["']refresh["']/i.test(html)) return "meta-refresh";
    if (/enable JavaScript/i.test(html)) return "js-required";
    return "unknown";
  }

  /**
   * Attempt to solve a challenge without Chromium.
   * Returns the solved page content, or null if it can't be solved.
   */
  async solve(url, html, statusCode, headers) {
    const challengeType = this.detectChallengeType(html);
    this.log("info", "CHALLENGE", `Detected ${challengeType} challenge on ${url}`);

    switch (challengeType) {
      case "cloudflare":
        return await this.solveCloudflare(url, html, headers);
      case "ddos-guard":
        return await this.solveDdosGuard(url, html, headers);
      case "sucuri":
        return await this.solveSucuri(url, html, headers);
      case "meta-refresh":
        return await this.solveMetaRefresh(url, html, headers);
      case "js-required":
        return await this.solveJsRequired(url, html, headers);
      case "perimeterx":
      case "blazingfast":
      case "turnstile":
      case "hcaptcha":
      case "recaptcha":
        return await this.handleCaptcha(url, html, challengeType, headers);
      default:
        // Try the generic approach: replay with cookies + proper headers
        return await this.solveGeneric(url, html, headers);
    }
  }

  /**
   * Extract cookies from Set-Cookie headers.
   */
  extractCookies(headers, domain) {
    const cookies = [];
    const setCookies = headers["set-cookie"];
    if (!setCookies) return cookies;
    const list = Array.isArray(setCookies) ? setCookies : [setCookies];
    for (const sc of list) {
      const parts = sc.split(";").map(s => s.trim());
      const [nameVal] = parts;
      const eqIdx = nameVal.indexOf("=");
      if (eqIdx < 0) continue;
      const name = nameVal.slice(0, eqIdx);
      const value = nameVal.slice(eqIdx + 1);
      cookies.push({ name, value, domain });
    }
    return cookies;
  }

  /**
   * Store cookies for a domain.
   */
  storeCookies(domain, cookies) {
    const existing = this.cookieJar.get(domain) || [];
    const merged = [...existing];
    for (const c of cookies) {
      const idx = merged.findIndex(e => e.name === c.name);
      if (idx >= 0) merged[idx] = c;
      else merged.push(c);
    }
    this.cookieJar.set(domain, merged);
  }

  /**
   * Get cookies for a domain as a Cookie header string.
   */
  getCookieHeader(domain) {
    const cookies = this.cookieJar.get(domain) || [];
    return cookies.map(c => `${c.name}=${c.value}`).join("; ");
  }

  /**
   * Fetch a URL with full browser-like headers and stored cookies.
   */
  fetchWithHeaders(url, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const domain = u.hostname;
      const lib = u.protocol === "https:" ? https : http;
      const headers = {
        "User-Agent": this.userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Cache-Control": "max-age=0",
        "Cookie": this.getCookieHeader(domain),
        ...extraHeaders,
      };

      const req = lib.get(url, { headers, timeout: this.timeoutMs }, (res) => {
        // Store cookies from response
        const cookies = this.extractCookies(res.headers, domain);
        if (cookies.length) this.storeCookies(domain, cookies);

        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirect = new URL(res.headers.location, url).href;
          return resolve(this.fetchWithHeaders(redirect, extraHeaders));
        }

        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          resolve({
            html: data,
            statusCode: res.statusCode,
            headers: res.headers,
            url: url,
            cookies: cookies,
          });
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    });
  }

  /**
   * Solve Cloudflare challenge.
   * Strategy: extract the challenge JS, run it in a Node VM, get the clearance cookie.
   */
  async solveCloudflare(url, html, headers) {
    try {
      // Store any cookies from the challenge response
      const u = new URL(url);
      const domain = u.hostname;
      const cookies = this.extractCookies(headers, domain);
      if (cookies.length) this.storeCookies(domain, cookies);

      // Look for the challenge form (cf-challenge)
      const formMatch = html.match(/<form[^>]*id=["']cf-form["'][^>]*action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i);
      if (formMatch) {
        const action = formMatch[1];
        const formData = {};
        const inputRegex = /<input[^>]+name=["']([^"']+)["'][^>]+value=["']([^"']*)["']/gi;
        let m;
        while ((m = inputRegex.exec(formMatch[2])) !== null) {
          formData[m[1]] = m[2];
        }
        // Submit the form
        const submitUrl = new URL(action, url).href;
        const result = await this.fetchWithHeaders(submitUrl, {
          "Content-Type": "application/x-www-form-urlencoded",
        });
        if (result.statusCode === 200 && !this.isChallengePage(result.html, result.statusCode)) {
          this.log("info", "CHALLENGE", "Cloudflare form challenge solved");
          return { html: result.html, statusCode: result.statusCode, headers: result.headers, solved: true, method: "cloudflare-form" };
        }
      }

      // Look for JavaScript challenge (var x = ...; setTimeout(...))
      const jsMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
      if (jsMatch && jsMatch[1].length > 50 && jsMatch[1].length < 5000) {
        try {
          const sandbox = {
            window: {},
            document: {
              cookie: "",
              location: { href: url, hostname: domain, protocol: u.protocol + "//" },
              createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
              getElementById: () => null,
            },
            setTimeout: (fn) => { try { fn(); } catch {} },
            setInterval: () => {},
            navigator: { userAgent: this.userAgent, language: "en-US", platform: "Win32" },
            location: { href: url, hostname: domain, protocol: u.protocol + "//" },
            atob: (s) => Buffer.from(s, "base64").toString("binary"),
            btoa: (s) => Buffer.from(s, "binary").toString("base64"),
            String, Math, Date, parseInt, parseFloat, Array, Object, JSON, RegExp, Error,
          };
          vm.createContext(sandbox);
          vm.runInContext(jsMatch[1], sandbox, { timeout: 3000 });

          // Check if the challenge set a cookie
          if (sandbox.document.cookie) {
            const cookieName = sandbox.document.cookie.split("=")[0];
            const cookieValue = sandbox.document.cookie.split("=")[1];
            if (cookieName && cookieValue) {
              this.storeCookies(domain, [{ name: cookieName, value: cookieValue, domain }]);
              this.log("info", "CHALLENGE", `Cloudflare JS challenge solved (cookie: ${cookieName})`);
              // Retry the request with the new cookie
              const result = await this.fetchWithHeaders(url);
              if (result.statusCode === 200 && !this.isChallengePage(result.html, result.statusCode)) {
                return { html: result.html, statusCode: result.statusCode, headers: result.headers, solved: true, method: "cloudflare-js" };
              }
            }
          }
        } catch (e) {
          this.log("warn", "CHALLENGE", `Cloudflare JS challenge failed: ${e.message}`);
        }
      }

      // If we can't solve it, return a helpful message instead of hanging
      return this.makeChallengeMessage(url, "cloudflare");
    } catch (e) {
      this.log("warn", "CHALLENGE", `Cloudflare solve error: ${e.message}`);
      return null;
    }
  }

  /**
   * Solve DDos-Guard challenge.
   */
  async solveDdosGuard(url, html, headers) {
    try {
      const u = new URL(url);
      const domain = u.hostname;
      const cookies = this.extractCookies(headers, domain);
      if (cookies.length) this.storeCookies(domain, cookies);

      // DDos-Guard uses a meta refresh or JS redirect
      const refreshMatch = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"']+)["']/i);
      if (refreshMatch) {
        const refreshUrl = new URL(refreshMatch[1], url).href;
        const result = await this.fetchWithHeaders(refreshUrl);
        if (result.statusCode === 200 && !this.isChallengePage(result.html, result.statusCode)) {
          return { html: result.html, statusCode: result.statusCode, headers: result.headers, solved: true, method: "ddos-guard-refresh" };
        }
      }
      return this.makeChallengeMessage(url, "ddos-guard");
    } catch { return null; }
  }

  /**
   * Solve Sucuri WAF challenge.
   */
  async solveSucuri(url, html, headers) {
    try {
      const u = new URL(url);
      const domain = u.hostname;
      const cookies = this.extractCookies(headers, domain);
      if (cookies.length) this.storeCookies(domain, cookies);

      // Sucuri uses a JS challenge with a cookie
      const cookieMatch = html.match(/sucuri_cloudproxy_uuid["']?\s*[:=]\s*["']([^"']+)["']/i);
      if (cookieMatch) {
        this.storeCookies(domain, [{ name: "sucuri_cloudproxy_uuid", value: cookieMatch[1], domain }]);
        const result = await this.fetchWithHeaders(url);
        if (result.statusCode === 200 && !this.isChallengePage(result.html, result.statusCode)) {
          return { html: result.html, statusCode: result.statusCode, headers: result.headers, solved: true, method: "sucuri-cookie" };
        }
      }
      return this.makeChallengeMessage(url, "sucuri");
    } catch { return null; }
  }

  /**
   * Follow meta-refresh redirects (common in challenge pages).
   */
  async solveMetaRefresh(url, html, headers) {
    const refreshMatch = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"']+)["']/i);
    if (refreshMatch) {
      const refreshUrl = new URL(refreshMatch[1], url).href;
      try {
        const result = await this.fetchWithHeaders(refreshUrl);
        if (!this.isChallengePage(result.html, result.statusCode)) {
          return { html: result.html, statusCode: result.statusCode, headers: result.headers, solved: true, method: "meta-refresh" };
        }
        // If still a challenge, try solving recursively
        return await this.solve(refreshUrl, result.html, result.statusCode, result.headers);
      } catch { return null; }
    }
    return null;
  }

  /**
   * Solve "JavaScript required" — just retry with proper headers.
   */
  async solveJsRequired(url, html, headers) {
    // These sites just check if JS is enabled. Since we're fetching server-side,
    // we can't run their JS, but we can try fetching with a browser UA
    try {
      const result = await this.fetchWithHeaders(url);
      if (!this.isChallengePage(result.html, result.statusCode)) {
        return { html: result.html, statusCode: result.statusCode, headers: result.headers, solved: true, method: "headers-retry" };
      }
      return this.makeChallengeMessage(url, "js-required");
    } catch { return null; }
  }

  /**
   * Handle CAPTCHA challenges (Turnstile, hCaptcha, reCAPTCHA).
   * We can't solve these automatically, but we return a helpful message
   * instead of hanging on a blank page.
   */
  async handleCaptcha(url, html, type, headers) {
    return this.makeChallengeMessage(url, type);
  }

  /**
   * Generic challenge solving attempt.
   */
  async solveGeneric(url, html, headers) {
    try {
      // Store cookies
      const u = new URL(url);
      const domain = u.hostname;
      const cookies = this.extractCookies(headers, domain);
      if (cookies.length) this.storeCookies(domain, cookies);

      // Retry with full browser headers and cookies
      const result = await this.fetchWithHeaders(url);
      if (!this.isChallengePage(result.html, result.statusCode)) {
        return { html: result.html, statusCode: result.statusCode, headers: result.headers, solved: true, method: "generic-retry" };
      }
      return this.makeChallengeMessage(url, "unknown");
    } catch { return null; }
  }

  /**
   * Generate a helpful message page for unsolvable challenges.
   */
  makeChallengeMessage(url, type) {
    const messages = {
      cloudflare: "This site uses Cloudflare protection. Veyra attempted to solve the challenge automatically but couldn't. Try again in a few seconds, or use Chromium mode for this site.",
      "ddos-guard": "This site uses DDoS-Guard protection. Please try again or use Chromium mode.",
      sucuri: "This site uses Sucuri WAF protection. Please try again or use Chromium mode.",
      turnstile: "This site uses Cloudflare Turnstile (CAPTCHA). Veyra can't solve CAPTCHAs automatically. Try again later or use Chromium mode.",
      hcaptcha: "This site uses hCaptcha. Veyra can't solve CAPTCHAs automatically. Try again later or use Chromium mode.",
      recaptcha: "This site uses reCAPTCHA. Veyra can't solve CAPTCHAs automatically. Try again later or use Chromium mode.",
      perimeterx: "This site uses PerimeterX bot protection. Please try again or use Chromium mode.",
      "js-required": "This site requires JavaScript. Veyra tried fetching it as HTML but the content requires a full browser. Try Chromium mode.",
      unknown: "This site appears to have a security check. Veyra attempted to solve it but couldn't. Try again or use Chromium mode.",
    };

    const msg = messages[type] || messages.unknown;
    return {
      html: `<!DOCTYPE html><html><head><title>Security check — Veyra</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;background:#0d0f13;color:#e2e5ea;margin:0;padding:40px;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{max-width:500px;text-align:center;padding:32px;border-radius:16px;background:#1a1d24;border:1px solid #2a2e36}
.icon{width:64px;height:64px;margin:0 auto 16px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#2a3a4a;color:#8fb0f0;font-size:28px}
h1{font-size:1.2rem;margin:0 0 12px;color:#e2e5ea}
p{color:#9ba1ab;font-size:.9rem;line-height:1.5;margin:0 0 20px}
.btn{display:inline-block;padding:10px 24px;border-radius:8px;background:#8fb0f0;color:#0d0f13;text-decoration:none;font-weight:600;font-size:.9rem}
a{color:#8fb0f0}
</style></head><body><div class="card">
<div class="icon">⚠</div>
<h1>Security check detected</h1>
<p>${msg}</p>
<p style="font-size:.8em;color:#6a6f78">Challenge type: ${type} · URL: ${url.replace(/</g, "&lt;")}</p>
<a href="${url.replace(/"/g, "&quot;")}" class="btn">Try again</a>
</div></body></html>`,
      statusCode: 200,
      headers: { "content-type": "text/html" },
      solved: false,
      method: "message",
      challengeType: type,
    };
  }

  /**
   * Get cookies for a domain (for the main fetch pipeline to use).
   */
  getCookies(domain) {
    return this.getCookieHeader(domain);
  }

  /**
   * Clear all stored cookies.
   */
  clearCookies() {
    this.cookieJar.clear();
    this.challengeCache.clear();
  }

  /**
   * Get status report.
   */
  report() {
    return {
      cookieDomains: this.cookieJar.size,
      totalCookies: [...this.cookieJar.values()].reduce((sum, c) => sum + c.length, 0),
      challengeCacheSize: this.challengeCache.size,
      userAgent: this.userAgent,
    };
  }
}

module.exports = { ChallengeSolver };
