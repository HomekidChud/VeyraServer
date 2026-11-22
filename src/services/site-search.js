"use strict";

const cheerio = require("cheerio");
const { isIP } = require("node:net");

const USER_AGENT = "VeyraSearch/1.0 (+https://github.com/HomekidChud/VeyraServer)";
const MDN_LOCALES = { en: "en-US", de: "de", es: "es", fr: "fr", ja: "ja", ko: "ko", pt: "pt-BR", ru: "ru", zh: "zh-CN" };

function queryUrl(endpoint, params) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) if (value !== "" && value != null) url.searchParams.set(key, String(value));
  return url.href;
}

function plain(text) {
  if (typeof text !== "string") return "";
  const $ = cheerio.load(text.slice(0, 3000), {}, false);
  $("script,style,iframe").remove();
  return $.root().text().replace(/\s+/g, " ").trim();
}

function exactLink(raw, host, path) {
  try {
    const u = new URL(raw);
    return u.origin === `https://${host}` && !u.username && !u.password && path.test(u.pathname) ? u.href : "";
  } catch { return ""; }
}

function rows(value) {
  if (!Array.isArray(value)) throw new SyntaxError("Invalid search response");
  return value;
}

function searxOrigin(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.port &&
      u.pathname === "/" && !u.search && !u.hash ? u.origin : "";
  } catch { return ""; }
}

function createSiteSearch({ fetchText, env, row, step, timeoutMs }) {
  const origin = searxOrigin(env.VEYRA_SEARXNG_ORIGIN);
  const engines = String(env.VEYRA_SEARXNG_ENGINES || "").split(",").map(name => name.trim())
    .filter(name => /^[\w.-][\w .-]{0,39}$/.test(name)).slice(0, 24).join(",");
  const allowedLocales = new Set(Object.keys(MDN_LOCALES));
  async function get(endpoint, params, signal, headers = {}) {
    const response = await fetchText(queryUrl(endpoint, params), {
      accept: "application/json", headers, signal, maxRedirects: 0, timeoutMs: Math.min(timeoutMs, 3500), userAgent: USER_AGENT
    });
    if (!response.ok) throw Object.assign(new Error("Site search request failed"), { status: response.status, retryAfterMs: response.retryAfterMs });
    return JSON.parse(response.text);
  }
  const native = (hosts, intent, run, options = {}) => ({ native: true, hosts, intent, available: () => true, run, ...options });
  const normalize = (items, id, map) => rows(items).slice(0, step).flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const fields = map(item);
    if (!fields) return [];
    const [url, title, description] = fields;
    return [row(url, plain(title), plain(description), id)].filter(Boolean);
  });
  function wiki(id, intent) {
    const host = `en.${id}.org`;
    return native([host], intent, async (q, { offset, signal }) => {
      const data = await get(`https://${host}/w/api.php`, { action: "query", list: "search", format: "json", formatversion: 2,
        srsearch: q, srnamespace: 0, srprop: "snippet", srlimit: step, sroffset: offset }, signal);
      if (data.error) throw new SyntaxError("Wikimedia search API error");
      return { results: normalize(data.query?.search, id, item => item.ns === 0 && typeof item.title === "string" &&
        [`https://${host}/wiki/${encodeURIComponent(item.title.replaceAll(" ", "_"))}`, item.title, item.snippet]),
      more: data.continue?.sroffset === offset + step };
    });
  }
  return {
    mdn: native(["developer.mozilla.org"], /\b(?:mdn|javascript|web api|css|html|dom api|web components)\b/i,
      async (q, { lang, offset, signal }) => {
        const language = String(lang || "").toLowerCase().split("-")[0];
        const data = await get("https://developer.mozilla.org/api/v1/search", { q, locale: allowedLocales.has(language) ? MDN_LOCALES[language] : "en-US", page: 1 + offset / step }, signal);
        return { results: normalize(data.documents, "mdn", item => /^\/[a-z-]+\/docs\//i.test(item.mdn_url || "") &&
          [`https://developer.mozilla.org${item.mdn_url}`, item.title, item.summary]), more: Number(data.metadata?.total?.value) > offset + step };
      }),
    github: native(["github.com"], /\b(?:github|source code|git repository|open[- ]source (?:project|library|tool)|repositories)\b/i,
      async (q, { offset, signal }) => {
        const data = await get("https://api.github.com/search/repositories", { q, page: 1 + offset / step, per_page: step }, signal,
          { accept: "application/vnd.github+json" });
        return { results: normalize(data.items, "github", item => item.private !== true &&
          [exactLink(item.html_url, "github.com", /^\/[\w.-]+\/[\w.-]+\/?$/), item.full_name, item.description]),
        more: Math.min(Number(data.total_count), 1000) > offset + step };
      }, { minInterval: 6000 }),
    npm: native(["www.npmjs.com"], /\b(?:npm|yarn package|pnpm package|node(?:\.js)? package)\b/i,
      async (q, { offset, signal }) => {
        const data = await get("https://registry.npmjs.org/-/v1/search", { text: q, size: step, from: offset }, signal);
        return { results: normalize(data.objects, "npm", ({ package: item }) => item && typeof item.name === "string" &&
          [/^(?:@[\w.-]+\/)?[\w.-]+$/.test(item.name) ? `https://www.npmjs.com/package/${item.name}` : "", item.name, item.description]),
        more: Number(data.total) > offset + step };
      }),
    "crates-io": native(["crates.io"], /\b(?:crates\.io|rust (?:crate|package|library)|cargo (?:crate|package))\b/i,
      async (q, { offset, signal }) => {
        const data = await get("https://crates.io/api/v1/crates", { q, page: 1 + offset / step, per_page: step }, signal);
        // crates.io uses an opaque seek token for reliable continuation; use its first page
        // rather than guessing a continuation or replaying an untrusted next-page URL.
        return { results: normalize(data.crates, "crates-io", item => /^[\w-]+$/.test(item.id || "") &&
          [`https://crates.io/crates/${item.id}`, item.id, item.description]), more: false };
      }, { firstPage: true }),
    "open-library": native(["openlibrary.org"], /\b(?:open library|books?|novels?|isbn|bibliography|reading list)\b/i,
      async (q, { offset, signal }) => {
        const data = await get("https://openlibrary.org/search.json", { q, offset, limit: step, fields: "key,title,author_name,first_publish_year" }, signal);
        return { results: normalize(data.docs, "open-library", item => /^\/works\/OL\d+W$/.test(item.key || "") &&
          [`https://openlibrary.org${item.key}`, item.title,
          [Array.isArray(item.author_name) ? item.author_name.slice(0, 3).join(", ") : "", item.first_publish_year].filter(Boolean).join(" · ")]),
        more: Number(data.numFound ?? data.num_found) > offset + step };
      }, { minInterval: 1000 }),
    wikivoyage: wiki("wikivoyage", /\b(?:wikivoyage|travel guide|itinerary|places to visit|things to do)\b/i),
    wiktionary: wiki("wiktionary", /\b(?:wiktionary|etymology|definition of|meaning of|dictionary)\b/i),
    wikibooks: wiki("wikibooks", /\b(?:wikibooks|open textbooks?)\b/i),
    searxng: { available: () => Boolean(origin), async run(q, { offset, lang, region, signal }) {
      const data = await get(`${origin}/search`, { q, categories: "general", engines, format: "json", safesearch: 2,
        language: region === "IN" && lang === "en" ? "en-IN" : /^[a-z]{2}(?:-[a-z]{2})?$/i.test(lang || "") ? lang : "",
        pageno: 1 + Math.floor(offset / step) }, signal);
      const items = rows(data.results);
      const results = items.slice(0, 40).flatMap(item => {
        const url = item?.url;
        try {
          const u = new URL(url);
          if (u.port || !u.hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal)$/i.test(u.hostname) || isIP(u.hostname)) return [];
        } catch { return []; }
        const result = row(url, plain(item.title), plain(item.content), "searxng");
        if (!result) return [];
        const upstreamEngines = (Array.isArray(item.engines) ? item.engines : [item.engine]).filter(name =>
          typeof name === "string" && /^[\w .-]{1,40}$/.test(name)).slice(0, 12);
        return [{ ...result, upstreamEngines: [...new Set(upstreamEngines)] }];
      });
      return { results, more: items.length >= step, stride: step };
    } }
  };
}

module.exports = { createSiteSearch };
