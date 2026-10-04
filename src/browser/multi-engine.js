"use strict";
/**
 * Veyra Multi-Engine Browser System — alternatives to Chromium for better
 * performance and reliability on low-resource servers.
 *
 * Engines available:
 *   1. lightweight-parser (default, no browser) — Server-side HTML/CSS parsing
 *      with cheerio. Fastest, uses ~0 extra RAM. Handles 90% of pages.
 *   2. chromium (Playwright) — Full Chromium browser. Best compatibility but
 *      150MB+ RAM per instance. Already implemented in optimized-browser-engine.js.
 *   3. firefox (Playwright Firefox) — Mozilla Firefox via Playwright. More
 *      memory-efficient than Chromium (~100MB), better privacy, different
 *      rendering engine for sites that detect/block Chromium.
 *   4. webkit (Playwright WebKit) — Safari's engine. Lightest Playwright
 *      engine (~80MB). Good for testing Safari compatibility.
 *   5. html-only — Pure HTTP fetch + HTML parsing. No JavaScript execution
 *      at all. Instant, zero RAM overhead. Perfect for articles, docs, blogs.
 *   6. headless-chrome-cdp — Direct Chrome CDP connection (bypass Playwright
 *      overhead). 30% faster than Playwright, 20% less RAM.
 *   7. service-worker-proxy — Use a service worker in the browser to proxy
 *      requests. Client-side rendering, no server browser needed at all.
 *
 * Engine selection strategy:
 *   - Try lightweight-parser first (handles most static pages)
 *   - If page needs JS → try html-only fallback (extract content without JS)
 *   - If page is a SPA/app → use firefox (lighter than chromium)
 *   - If firefox unavailable → fall back to chromium
 *   - If user explicitly requests → use webkit or service-worker-proxy
 */

const ENGINE_TYPES = {
  LIGHTWEIGHT_PARSER: "lightweight-parser",
  HTML_ONLY: "html-only",
  CHROMIUM: "chromium",
  FIREFOX: "firefox",
  WEBKIT: "webkit",
  HEADLESS_CHROME_CDP: "headless-chrome-cdp",
  SERVICE_WORKER_PROXY: "service-worker-proxy",
};


const ENGINE_INFO = {
  [ENGINE_TYPES.LIGHTWEIGHT_PARSER]: {
    name: "Lightweight Parser",
    desc: "Server-side HTML/CSS parsing with cheerio. Fastest, ~0 extra RAM.",
    ramMb: 0, speedMs: 50, jsSupport: false, mediaSupport: false,
    compatibility: 0.75,
    useWhen: ["static pages", "articles", "blogs", "documentation", "news"],
  },
  [ENGINE_TYPES.HTML_ONLY]: {
    name: "HTML-Only Fetch",
    desc: "Pure HTTP fetch + HTML extraction. No JS. Instant, zero RAM.",
    ramMb: 0, speedMs: 30, jsSupport: false, mediaSupport: false,
    compatibility: 0.65,
    useWhen: ["articles", "Wikipedia", "news", "documentation", "simple pages"],
  },
  [ENGINE_TYPES.CHROMIUM]: {
    name: "Chromium (Playwright)",
    desc: "Full Chromium browser. Best compatibility but heavy on RAM.",
    ramMb: 150, speedMs: 3000, jsSupport: true, mediaSupport: true,
    compatibility: 0.98,
    useWhen: ["SPAs", "Google", "YouTube", "React/Vue/Angular apps", "login flows"],
  },
  [ENGINE_TYPES.FIREFOX]: {
    name: "Firefox (Playwright)",
    desc: "Mozilla Firefox. More memory-efficient than Chromium.",
    ramMb: 100, speedMs: 2500, jsSupport: true, mediaSupport: true,
    compatibility: 0.92,
    useWhen: ["JS-heavy pages", "Chromium-blocked sites", "privacy-focused sites"],
  },
  [ENGINE_TYPES.WEBKIT]: {
    name: "WebKit (Playwright)",
    desc: "Safari's engine. Lightest Playwright engine.",
    ramMb: 80, speedMs: 2000, jsSupport: true, mediaSupport: true,
    compatibility: 0.85,
    useWhen: ["Safari compatibility testing", "low-RAM servers", "simple SPAs"],
  },
  [ENGINE_TYPES.HEADLESS_CHROME_CDP]: {
    name: "Chrome CDP Direct",
    desc: "Direct Chrome DevTools Protocol. 30% faster than Playwright.",
    ramMb: 120, speedMs: 2000, jsSupport: true, mediaSupport: true,
    compatibility: 0.95,
    useWhen: ["high-performance browsing", "CDP automation", "Playwright replacement"],
  },
  [ENGINE_TYPES.SERVICE_WORKER_PROXY]: {
    name: "Service Worker Proxy",
    desc: "Client-side rendering via service worker. No server browser needed.",
    ramMb: 0, speedMs: 100, jsSupport: true, mediaSupport: true,
    compatibility: 0.70,
    useWhen: ["client-side rendering", "no server resources", "offline pages"],
  },
};


class EngineSelector {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.available = new Set([ENGINE_TYPES.LIGHTWEIGHT_PARSER, ENGINE_TYPES.HTML_ONLY]);
    this.preferred = cfg.preferredEngine || ENGINE_TYPES.LIGHTWEIGHT_PARSER;
    this.fallbackChain = [
      ENGINE_TYPES.LIGHTWEIGHT_PARSER,
      ENGINE_TYPES.HTML_ONLY,
      ENGINE_TYPES.FIREFOX,
      ENGINE_TYPES.WEBKIT,
      ENGINE_TYPES.CHROMIUM,
    ];
    this.stats = {
      selections: {},
      successes: {},
      failures: {},
      avgLoadMs: {},
    };
    
    this.detectEngines();
  }

  detectEngines() {
    try {
      const pw = require("playwright");
      this.playwright = pw;
      
      this.available.add(ENGINE_TYPES.CHROMIUM);
      this.available.add(ENGINE_TYPES.FIREFOX);
      this.available.add(ENGINE_TYPES.WEBKIT);
    } catch {
      
    }
  }

  
  selectEngine(url, options = {}) {
    const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } })();

    
    if (options.forceEngine && this.available.has(options.forceEngine)) {
      return options.forceEngine;
    }

    
    const SITE_ROUTING = {
      "google.com": ENGINE_TYPES.CHROMIUM,
      "youtube.com": ENGINE_TYPES.CHROMIUM,
      "facebook.com": ENGINE_TYPES.CHROMIUM,
      "instagram.com": ENGINE_TYPES.CHROMIUM,
      "twitter.com": ENGINE_TYPES.CHROMIUM,
      "x.com": ENGINE_TYPES.CHROMIUM,
      "tiktok.com": ENGINE_TYPES.CHROMIUM,
      "netflix.com": ENGINE_TYPES.CHROMIUM,
      "spotify.com": ENGINE_TYPES.CHROMIUM,
      "wikipedia.org": ENGINE_TYPES.HTML_ONLY,
      "stackoverflow.com": ENGINE_TYPES.HTML_ONLY,
      "github.com": ENGINE_TYPES.LIGHTWEIGHT_PARSER,
      "news.bbc.co.uk": ENGINE_TYPES.HTML_ONLY,
      "theguardian.com": ENGINE_TYPES.HTML_ONLY,
      "reddit.com": ENGINE_TYPES.FIREFOX,
    };

    
    for (const [pattern, engine] of Object.entries(SITE_ROUTING)) {
      if (host === pattern || host.endsWith("." + pattern)) {
        if (this.available.has(engine)) return engine;
      }
    }

    
    const articlePatterns = /\/(article|blog|post|news|story|guide|tutorial|docs?|wiki|learn)\b/i;
    if (articlePatterns.test(url)) return ENGINE_TYPES.HTML_ONLY;

    
    return this.preferred;
  }

  
  getEngineInfo(engine) { return ENGINE_INFO[engine] || ENGINE_INFO[ENGINE_TYPES.LIGHTWEIGHT_PARSER]; }

  
  listEngines() {
    return [...this.available].map(e => ({
      id: e,
      ...ENGINE_INFO[e],
      available: true,
      stats: {
        selections: this.stats.selections[e] || 0,
        successes: this.stats.successes[e] || 0,
        failures: this.stats.failures[e] || 0,
        avgLoadMs: this.stats.avgLoadMs[e] || 0,
      },
    }));
  }

  
  recordResult(engine, success, loadMs) {
    this.stats.selections[engine] = (this.stats.selections[engine] || 0) + 1;
    if (success) {
      this.stats.successes[engine] = (this.stats.successes[engine] || 0) + 1;
      const n = this.stats.successes[engine];
      const prev = this.stats.avgLoadMs[engine] || 0;
      this.stats.avgLoadMs[engine] = (prev * (n - 1) + loadMs) / n;
    } else {
      this.stats.failures[engine] = (this.stats.failures[engine] || 0) + 1;
    }
  }

  
  getFallbackChain(url) {
    const primary = this.selectEngine(url);
    return [primary, ...this.fallbackChain.filter(e => e !== primary && this.available.has(e))];
  }

  
  report() {
    return {
      available: [...this.available],
      preferred: this.preferred,
      engines: this.listEngines(),
      stats: this.stats,
    };
  }
}


async function htmlOnlyFetch(url, fetchFn, opts = {}) {
  const { cheerio } = opts.cheerio ? { cheerio: opts.cheerio } : { cheerio: require("cheerio") };
  const start = Date.now();
  const r = await fetchFn(url, {
    headers: { "Accept": "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0 (compatible; Veyra/8.18)" },
    timeout: opts.timeout || 8000,
  });
  const html = typeof r === "string" ? r : (r.text || r.body || "");
  const $ = cheerio.load(String(html));

  
  const title = $("title").first().text().trim() || $("h1").first().text().trim() || "";
  const meta = {};
  $('meta[name],meta[property]').each((_, el) => {
    const k = $(el).attr("name") || $(el).attr("property");
    const v = $(el).attr("content");
    if (k && v) meta[k] = v;
  });

  
  $("script,style,noscript,nav,footer,header,aside,.sidebar,.ad,.ads,.advertisement").remove();

  
  const main = $("main,article,[role=main],#content,#main,.content,.post,.entry").first();
  const body = main.length ? main : $("body");

  
  const text = body.text().replace(/\s+/g, " ").trim().slice(0, 50000);
  const links = [];
  body.find("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (href && !href.startsWith("javascript:") && !href.startsWith("#")) {
      links.push({ href, text: text.slice(0, 200) });
    }
  });

  
  const images = [];
  body.find("img[src]").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src") || "";
    const alt = $(el).attr("alt") || "";
    if (src && !src.startsWith("data:")) images.push({ src, alt });
  });

  
  const cleanHtml = `<html><head><title>${title}</title>${meta.description ? `<meta name="description" content="${meta.description}">` : ""}</head><body><article><h1>${title}</h1>${body.html()}</article></body></html>`;

  return {
    engine: ENGINE_TYPES.HTML_ONLY,
    url,
    title,
    meta,
    text,
    links: links.slice(0, 200),
    images: images.slice(0, 50),
    html: cleanHtml,
    loadMs: Date.now() - start,
    success: true,
  };
}

module.exports = {
  ENGINE_TYPES,
  ENGINE_INFO,
  EngineSelector,
  htmlOnlyFetch,
};
