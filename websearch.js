"use strict";
// Web search providers for Veyra's built-in results page.
//
// Google no longer serves result HTML to clients without JavaScript, and its
// result pages must not be machine-parsed. Google results are therefore
// supported the official way — the Programmable Search (Custom Search JSON)
// API when GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX are set — and the frontend
// can always open google.com itself in the real Chromium engine. Without keys
// the page falls back to providers that publish no-JS HTML endpoints.

const cheerio = require("cheerio");

function cleanText(s, max = 400) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, max); }
function safeHttpUrl(raw) {
  try { const u = new URL(String(raw || "")); return /^https?:$/.test(u.protocol) ? u.href : ""; } catch { return ""; }
}
function displayUrl(u) { try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + (x.pathname === "/" ? "" : x.pathname)).slice(0, 120); } catch { return u; } }
function row(url, title, snippet, source) {
  const href = safeHttpUrl(url); if (!href || !title) return null;
  return { url: href, title: cleanText(title, 300), snippet: cleanText(snippet, 500), displayUrl: displayUrl(href), source };
}

function unwrapDuckDuckGo(href) {
  const h = String(href || "");
  try {
    const u = new URL(h.startsWith("//") ? "https:" + h : h, "https://duckduckgo.com");
    if (/duckduckgo\.com$/.test(u.hostname) && u.pathname === "/l/") return u.searchParams.get("uddg") || "";
    return u.href;
  } catch { return ""; }
}
function unwrapBing(href) {
  try {
    const u = new URL(String(href || ""), "https://www.bing.com");
    if (/bing\.com$/.test(u.hostname) && u.pathname === "/ck/a") {
      const enc = u.searchParams.get("u") || "";
      if (enc.startsWith("a1")) return Buffer.from(enc.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      return "";
    }
    return u.href;
  } catch { return ""; }
}

function parseDuckDuckGoHtml(html) {
  const $ = cheerio.load(String(html || ""));
  const out = [];
  $(".result").each((_, el) => {
    const $el = $(el);
    if ($el.hasClass("result--ad") || $el.find(".badge--ad").length) return;
    const a = $el.find("a.result__a").first();
    const r = row(unwrapDuckDuckGo(a.attr("href")), a.text(), $el.find(".result__snippet").first().text(), "duckduckgo");
    if (r) out.push(r);
  });
  return out;
}
function parseBingHtml(html) {
  const $ = cheerio.load(String(html || ""));
  const out = [];
  $("li.b_algo").each((_, el) => {
    const $el = $(el);
    const a = $el.find("h2 a").first();
    const snippet = $el.find(".b_caption p, p.b_lineclamp2, p.b_lineclamp3, p.b_lineclamp4, p").first().text();
    const r = row(unwrapBing(a.attr("href")), a.text(), snippet, "bing");
    if (r) out.push(r);
  });
  return out;
}
function parseGoogleApi(json) {
  const items = Array.isArray(json?.items) ? json.items : [];
  return items.map(i => row(i.link, i.title, i.snippet, "google")).filter(Boolean);
}

function dedupe(rows) {
  const seen = new Set(); const out = [];
  for (const r of rows) { const k = r.url.replace(/[#?].*$/, "").replace(/\/$/, ""); if (seen.has(k)) continue; seen.add(k); out.push(r); }
  return out;
}

// fetchText(url, { headers, accept }) -> { ok, status, text, finalUrl }
function createWebSearch({ fetchText, env = process.env, log = () => {} }) {
  const googleKey = env.GOOGLE_SEARCH_API_KEY || env.GOOGLE_API_KEY || "";
  const googleCx = env.GOOGLE_SEARCH_CX || env.GOOGLE_CSE_ID || "";
  const order = String(env.WEB_SEARCH_ORDER || "google,duckduckgo,bing").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const cache = new Map(); const TTL = 5 * 60 * 1000; const MAX = 200;
  const failures = new Map(); // provider -> cooldown-until (blocked / captcha)

  const providers = {
    google: {
      available: () => !!(googleKey && googleCx),
      async run(q, { offset, lang }) {
        const u = new URL("https://www.googleapis.com/customsearch/v1");
        u.searchParams.set("key", googleKey); u.searchParams.set("cx", googleCx); u.searchParams.set("q", q);
        u.searchParams.set("num", "10"); if (offset) u.searchParams.set("start", String(Math.min(91, offset + 1)));
        if (lang) u.searchParams.set("hl", lang);
        const r = await fetchText(u.href, { accept: "application/json" });
        if (!r.ok) throw Object.assign(new Error(`Google API HTTP ${r.status}`), { status: r.status });
        return parseGoogleApi(JSON.parse(r.text));
      }
    },
    duckduckgo: {
      available: () => true,
      async run(q, { offset, lang }) {
        const u = new URL("https://html.duckduckgo.com/html/"); u.searchParams.set("q", q);
        if (offset) u.searchParams.set("s", String(offset));
        if (lang) u.searchParams.set("kl", lang === "en" ? "wt-wt" : `${lang}-${lang}`);
        const r = await fetchText(u.href, { accept: "text/html" });
        if (!r.ok) throw Object.assign(new Error(`DuckDuckGo HTTP ${r.status}`), { status: r.status });
        if (/anomaly-modal|challenge-form|bots use DuckDuckGo too/i.test(r.text)) throw Object.assign(new Error("DuckDuckGo asked for a verification"), { status: 429 });
        return parseDuckDuckGoHtml(r.text);
      }
    },
    bing: {
      available: () => true,
      async run(q, { offset, lang }) {
        const u = new URL("https://www.bing.com/search"); u.searchParams.set("q", q);
        if (offset) u.searchParams.set("first", String(offset + 1));
        if (lang) u.searchParams.set("setlang", lang);
        const r = await fetchText(u.href, { accept: "text/html" });
        if (!r.ok) throw Object.assign(new Error(`Bing HTTP ${r.status}`), { status: r.status });
        return parseBingHtml(r.text);
      }
    }
  };

  async function search(query, { offset = 0, engine = "", lang = "" } = {}) {
    const q = cleanText(query, 256);
    if (!q) return { provider: "none", results: [], attempts: [] };
    const want = engine && providers[engine] ? [engine, ...order.filter(p => p !== engine)] : order;
    const key = `${want.join(",")}|${offset}|${lang}|${q.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.time < TTL) return { ...hit.value, cached: true };
    const attempts = [];
    for (const name of want) {
      const p = providers[name];
      if (!p) continue;
      if (!p.available()) { attempts.push({ provider: name, skipped: "not-configured" }); continue; }
      if ((failures.get(name) || 0) > Date.now()) { attempts.push({ provider: name, skipped: "cooldown" }); continue; }
      const started = Date.now();
      try {
        const results = dedupe(await p.run(q, { offset, lang }));
        attempts.push({ provider: name, ms: Date.now() - started, count: results.length });
        if (!results.length) continue;
        const value = { provider: name, results: results.slice(0, 20), attempts, googleConfigured: providers.google.available() };
        cache.set(key, { time: Date.now(), value });
        while (cache.size > MAX) cache.delete(cache.keys().next().value);
        return value;
      } catch (e) {
        attempts.push({ provider: name, ms: Date.now() - started, error: e.message });
        if (e.status === 429 || e.status === 403) failures.set(name, Date.now() + 5 * 60 * 1000);
        log("warn", "SEARCH", `${name} web search failed: ${e.message}`);
      }
    }
    return { provider: "none", results: [], attempts, googleConfigured: providers.google.available() };
  }
  return { search, googleConfigured: () => providers.google.available(), order };
}

module.exports = { createWebSearch, parseDuckDuckGoHtml, parseBingHtml, parseGoogleApi, unwrapBing, unwrapDuckDuckGo };
