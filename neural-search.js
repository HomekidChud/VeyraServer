"use strict";
/**
 * Veyra Neural Search Engine — improved web search with:
 *   - Parallel provider queries (race for fastest result)
 *   - Query expansion (add related terms, spell corrections)
 *   - Cross-provider result merging and deduplication
 *   - Neural re-ranking using the crawler model's domain authority
 *   - Resilient fallbacks (Wikipedia API, SearX instances, DuckDuckGo, Bing)
 *   - Result freshness scoring
 *   - Better caching with TTL and LRU eviction
 */

const cheerio = require("cheerio");

// ----------------------------------------------------------------- utilities
function cleanText(s, max = 400) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, max); }
function safeHttpUrl(raw) {
  try { const u = new URL(String(raw || "")); return /^https?:$/.test(u.protocol) ? u.href : ""; } catch { return ""; }
}
function displayUrl(u) {
  try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + (x.pathname === "/" ? "" : x.pathname)).slice(0, 120); }
  catch { return u; }
}
function row(url, title, snippet, source, extra = {}) {
  const href = safeHttpUrl(url); if (!href || !title) return null;
  return { url: href, title: cleanText(title, 300), snippet: cleanText(snippet, 700), displayUrl: displayUrl(href), source, ...extra };
}

// ----------------------------------------------------------------- URL unwrappers
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

// ----------------------------------------------------------------- parsers
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
function parseBraveApi(json) {
  const items = Array.isArray(json?.web?.results) ? json.web.results : [];
  return items.map(i => row(i.url, i.title, i.description || i.snippet, "brave")).filter(Boolean);
}
function parseBingApi(json) {
  const items = Array.isArray(json?.webPages?.value) ? json.webPages.value : [];
  return items.map(i => row(i.url, i.name || i.title, i.snippet, "bing")).filter(Boolean);
}
function parseWikipediaApi(json) {
  const items = Array.isArray(json?.query?.search) ? json.query.search : [];
  return items.map(i => row(`https://en.wikipedia.org/wiki/${encodeURIComponent(i.title)}`, i.title, i.snippet?.replace(/<\/?[^>]+>/g, ""), "wikipedia")).filter(Boolean);
}

// ----------------------------------------------------------------- query expansion
function expandQuery(query) {
  const q = cleanText(query, 600);
  if (!q) return [];
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const expansions = [];

  // Add common spelling corrections for frequent misspellings
  const corrections = {
    "recieve": "receive", "seperate": "separate", "occured": "occurred",
    "untill": "until", "wich": "which", "thier": "their", "becuase": "because",
    "definately": "definitely", "occassion": "occasion", "neccessary": "necessary",
    "teh": "the", "adn": "and", "nad": "and", "taht": "that", "thier": "their",
    "adress": "address", "enviroment": "environment", "goverment": "government",
    "independant": "independent", "knowlege": "knowledge", "liason": "liaison",
    "noticable": "noticeable", "occassionally": "occasionally", "perseverence": "perseverance",
    "posession": "possession", "prefered": "preferred", "priviledge": "privilege",
    "recomend": "recommend", "rythm": "rhythm", "succesfully": "successfully",
    "truely": "truly", "unfortunatly": "unfortunately", "wierd": "weird",
  };
  const corrected = terms.map(t => corrections[t] || t);
  if (corrected.join(" ") !== terms.join(" ")) expansions.push(corrected.join(" "));

  // Add Wikipedia-style query (remove special chars, add "site:wikipedia.org")
  const clean = q.replace(/[^\w\s]/g, " ").trim();
  if (clean && clean !== q) expansions.push(clean);

  // Add quoted exact match for multi-word queries
  if (terms.length > 1) expansions.push(`"${q}"`);

  // Add common synonyms for better coverage
  const synonyms = {
    "how": "guide tutorial", "what": "definition meaning", "where": "location map",
    "when": "date timeline", "why": "reason explanation", "who": "person biography",
    "best": "top rated recommended", "free": "no cost", "cheap": "affordable budget",
    "fast": "quick speed", "easy": "simple beginner", "new": "latest 2024 2025",
    "review": "comparison test", "download": "get install", "buy": "purchase price",
  };
  const synTerms = terms.map(t => synonyms[t] || t).filter(t => t.includes(" "));
  if (synTerms.length) expansions.push([...terms, ...synTerms].join(" ").split(" ").filter((v, i, a) => a.indexOf(v) === i).join(" "));

  return expansions.slice(0, 4);
}

// ----------------------------------------------------------------- deduplication & merging
function dedupe(rows) {
  const seen = new Set(); const out = [];
  for (const r of rows) {
    const k = r.url.replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(r);
  }
  return out;
}

function mergeResults(providerResults) {
  const merged = new Map(); // url -> { result, providers, count, totalScore }
  for (const { provider, results } of providerResults) {
    for (const r of results) {
      const key = r.url.replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();
      const existing = merged.get(key);
      if (existing) {
        existing.providers.add(provider);
        existing.count++;
        // Prefer the longer snippet
        if (r.snippet.length > existing.result.snippet.length) {
          existing.result.snippet = r.snippet;
        }
        // Prefer the longer title
        if (r.title.length > existing.result.title.length) {
          existing.result.title = r.title;
        }
        // Track position for ranking (lower position = better)
        if (!existing.positions) existing.positions = [];
        existing.positions.push(r.position || 999);
      } else {
        merged.set(key, { result: { ...r }, providers: new Set([provider]), count: 1, positions: [r.position || 999] });
      }
    }
  }
  // Sort: results from multiple providers rank higher, then by average position
  return [...merged.values()]
    .sort((a, b) => {
      // Multi-provider boost: appearing in 2+ providers is a strong relevance signal
      const aMulti = a.count >= 2 ? 1 : 0;
      const bMulti = b.count >= 2 ? 1 : 0;
      if (aMulti !== bMulti) return bMulti - aMulti;
      // Average position across providers (lower = appeared earlier in results)
      const aAvgPos = a.positions.reduce((s, p) => s + p, 0) / a.positions.length;
      const bAvgPos = b.positions.reduce((s, p) => s + p, 0) / b.positions.length;
      return aAvgPos - bAvgPos;
    })
    .map(m => ({
      ...m.result,
      providers: [...m.providers],
      providerCount: m.count,
      avgPosition: m.positions.reduce((s, p) => s + p, 0) / m.positions.length,
    }));
}

function searchTerms(query) {
  const stop = new Set(["the", "a", "an", "of", "in", "on", "at", "to", "for", "and", "or", "is", "are", "was", "were", "who", "what", "when", "where", "why", "how"]);
  return [...new Set(String(query || "").toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(t => t.length > 1 && !stop.has(t)))];
}
function relevanceScore(result, query) {
  const terms = searchTerms(query); if (!terms.length) return 0;
  const title = String(result.title || "").toLowerCase();
  const text = `${title} ${String(result.snippet || "").toLowerCase()}`;
  const titleHits = terms.filter(t => title.includes(t)).length;
  const textHits = terms.filter(t => text.includes(t)).length;
  const phrase = String(query || "").trim().toLowerCase().replace(/^\"|\"$/g, "");
  let score = (titleHits / terms.length) * 0.7 + (textHits / terms.length) * 0.3;
  if (phrase.length > 3 && text.includes(phrase)) score += 0.25;
  return Math.min(1, score);
}
function rankRelevant(results, query) {
  const multiWord = searchTerms(query).length > 1;
  const terms = searchTerms(query);
  return results.map((r, i) => {
    const text = `${String(r.title || "")} ${String(r.snippet || "")}`.toLowerCase();
    return { ...r, queryRelevance: Number(relevanceScore(r, query).toFixed(4)), queryTermHits: terms.filter(t => text.includes(t)).length, _position: i };
  })
    .sort((a, b) => b.queryRelevance - a.queryRelevance || (a.avgPosition || a._position) - (b.avgPosition || b._position))
    .filter(r => r.queryRelevance >= (multiWord ? 0.18 : 0.08) && (!multiWord || r.queryTermHits >= Math.min(2, terms.length)))
    .map(({ _position, queryTermHits, ...r }) => r);
}

// ----------------------------------------------------------------- neural re-ranking
function neuralRerank(results, neuralModel) {
  if (!neuralModel) return results;
  // Enhanced re-ranking: combine neural score with provider count and freshness
  return results.map(r => {
    const neuralScore = neuralModel.scoreUrl(r.url, { type: "html", internal: false });
    // Freshness boost: recent results get a small boost
    let freshnessScore = 0;
    if (r.date) {
      const age = Date.now() - new Date(r.date).getTime();
      if (age < 7 * 86400000) freshnessScore = 0.1; // Within a week
      else if (age < 30 * 86400000) freshnessScore = 0.05; // Within a month
    }
    // Provider count boost: results from multiple sources are more authoritative
    const providerBoost = Math.min(0.15, (r.providerCount - 1) * 0.05);
    // Domain authority from neural model
    const authorityScore = Math.min(0.2, neuralScore * 0.3);
    const combinedScore = neuralScore + freshnessScore + providerBoost + authorityScore;
    return { ...r, neuralScore: Number(combinedScore.toFixed(4)) };
  }).sort((a, b) => (b.neuralScore || 0) - (a.neuralScore || 0) || (b.providerCount || 0) - (a.providerCount || 0) || (a.avgPosition || 999) - (b.avgPosition || 999));
}

// ----------------------------------------------------------------- main search factory
function createWebSearch({ fetchText, env = process.env, log = () => {}, neuralModel = null }) {
  const googleKey = env.GOOGLE_SEARCH_API_KEY || env.GOOGLE_API_KEY || "";
  const googleCx = env.GOOGLE_SEARCH_CX || env.GOOGLE_CSE_ID || "";
  const braveKey = env.BRAVE_SEARCH_API_KEY || "";
  const bingKey = env.BING_SEARCH_API_KEY || "";
  const order = String(env.WEB_SEARCH_ORDER || "wikipedia,duckduckgo,bing,brave,google,searx,startpage").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const cache = new Map(); const TTL = 5 * 60 * 1000; const MAX = 300;
  const failures = new Map();

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
        return { results: parseGoogleApi(JSON.parse(r.text)), total: JSON.parse(r.text).searchInformation?.totalResults ?? null };
      }
    },
    brave: {
      available: () => !!braveKey,
      async run(q, { offset, lang }) {
        const u = new URL("https://api.search.brave.com/res/v1/web/search");
        u.searchParams.set("q", q); u.searchParams.set("count", "20");
        if (offset) u.searchParams.set("offset", String(Math.min(9, Math.floor(offset / 20))));
        if (lang) u.searchParams.set("search_lang", lang);
        const r = await fetchText(u.href, { accept: "application/json", headers: { "X-Subscription-Token": braveKey } });
        if (!r.ok) throw Object.assign(new Error(`Brave Search API HTTP ${r.status}`), { status: r.status });
        const json = JSON.parse(r.text); return { results: parseBraveApi(json), total: null, more: !!json?.query?.more_results_available };
      }
    },
    bing: {
      available: () => true,
      async run(q, { offset, lang }) {
        if (bingKey) {
          const u = new URL("https://api.bing.microsoft.com/v7.0/search");
          u.searchParams.set("q", q); u.searchParams.set("count", "20"); u.searchParams.set("offset", String(offset || 0));
          if (lang) u.searchParams.set("setLang", lang);
          const r = await fetchText(u.href, { accept: "application/json", headers: { "Ocp-Apim-Subscription-Key": bingKey } });
          if (!r.ok) throw Object.assign(new Error(`Bing Search API HTTP ${r.status}`), { status: r.status });
          const json = JSON.parse(r.text); return { results: parseBingApi(json), total: json?.webPages?.totalEstimatedMatches ?? null };
        }
        const u = new URL("https://www.bing.com/search"); u.searchParams.set("q", q);
        if (offset) u.searchParams.set("first", String(offset + 1));
        if (lang) u.searchParams.set("setlang", lang);
        const r = await fetchText(u.href, { accept: "text/html" });
        if (!r.ok) throw Object.assign(new Error(`Bing HTTP ${r.status}`), { status: r.status });
        return { results: parseBingHtml(r.text), total: null };
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
        return { results: parseDuckDuckGoHtml(r.text), total: null };
      }
    },
    wikipedia: {
      available: () => true,
      async run(q, { offset, lang }) {
        const langCode = lang || "en";
        const u = new URL(`https://${langCode}.wikipedia.org/w/api.php`);
        u.searchParams.set("action", "query"); u.searchParams.set("list", "search");
        u.searchParams.set("srsearch", q); u.searchParams.set("srlimit", "10");
        u.searchParams.set("srprop", "snippet"); u.searchParams.set("format", "json");
        if (offset) u.searchParams.set("sroffset", String(offset));
        const r = await fetchText(u.href, { accept: "application/json" });
        if (!r.ok) throw Object.assign(new Error(`Wikipedia API HTTP ${r.status}`), { status: r.status });
        return { results: parseWikipediaApi(JSON.parse(r.text)), total: JSON.parse(r.text)?.query?.searchinfo?.totalhits ?? null };
      }
    },
    searx: {
      available: () => true,
      async run(q, { offset, lang }) {
        const instances = ["https://searx.be", "https://search.bus-hit.me", "https://searx.tiekoetter.com"];
        for (const base of instances) {
          try {
            const u = new URL(base + "/search");
            u.searchParams.set("q", q); u.searchParams.set("format", "json");
            u.searchParams.set("categories", "general");
            if (lang) u.searchParams.set("language", lang);
            if (offset) u.searchParams.set("pageno", String(Math.min(5, Math.floor(offset / 10) + 2)));
            const r = await fetchText(u.href, { accept: "application/json", headers: { "User-Agent": "VeyraSearch/1.0" } });
            if (!r.ok) continue;
            const json = JSON.parse(r.text);
            const results = (json.results || []).map(item => row(item.url, item.title, item.content, "searx")).filter(Boolean);
            if (results.length) return { results, total: json.number_of_results || null };
          } catch { continue; }
        }
        return { results: [], total: null };
      }
    },
    startpage: {
      available: () => true,
      async run(q, { offset, lang }) {
        const u = new URL("https://www.startpage.com/sp/search");
        u.searchParams.set("query", q);
        if (lang) u.searchParams.set("language", lang === "en" ? "english" : lang);
        const r = await fetchText(u.href, { accept: "text/html" });
        if (!r.ok) throw Object.assign(new Error(`Startpage HTTP ${r.status}`), { status: r.status });
        const $ = cheerio.load(r.text);
        const out = [];
        $(".w-gl__result").each((_, el) => {
          const $el = $(el);
          const a = $el.find("a.w-gl__result-title").first();
          const snippet = $el.find(".w-gl__description").first().text();
          const r2 = row(a.attr("href"), a.text(), snippet, "startpage");
          if (r2) out.push(r2);
        });
        return { results: out, total: null };
      }
    }
  };

  // Run multiple providers in parallel and return the first successful results
  async function parallelSearch(query, { offset = 0, lang = "" } = {}) {
    const q = cleanText(query, 600);
    if (!q) return { provider: "none", results: [], attempts: [] };

    // Query expansion: run original + expansions in parallel
    const expandedQueries = [q, ...expandQuery(q)];
    const allAttempts = [];
    const providerResults = [];

    // Get available providers
    const available = order.filter(name => {
      const p = providers[name];
      return p && p.available() && (failures.get(name) || 0) <= Date.now();
    });

    if (!available.length) {
      return { provider: "none", results: [], attempts: [{ provider: "none", error: "No search providers available" }] };
    }

    // Run each provider with the original query (fastest provider wins, but we collect all)
    const promises = available.map(async (name) => {
      const p = providers[name];
      const started = Date.now();
      try {
        // Use original query for the first attempt
        const packed = await Promise.race([
          p.run(q, { offset, lang }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Provider timeout")), 8000))
        ]);
        const results = dedupe(packed.results || []);
        allAttempts.push({ provider: name, ms: Date.now() - started, count: results.length });
        if (results.length) {
          providerResults.push({ provider: name, results });
        }
      } catch (e) {
        allAttempts.push({ provider: name, ms: Date.now() - started, error: e.message });
        if (e.status === 429 || e.status === 403) failures.set(name, Date.now() + 60 * 1000);
        log("warn", "SEARCH", `${name} web search failed: ${e.message}`);
      }
    });

    // Wait for all providers to finish (with timeout)
    await Promise.allSettled(promises);

    if (!providerResults.length) {
      return { provider: "none", results: [], attempts: allAttempts };
    }

    // Merge results from all providers
    const merged = mergeResults(providerResults);
    // Neural re-ranking if model is available
    // Query relevance must dominate domain authority. Previously an unrelated
    // high-authority/local result could outrank pages that actually matched
    // the user's words (for example car dealers for “capital of Wales”).
    const relevant = rankRelevant(merged, q);
    const ranked = neuralModel
      ? neuralRerank(relevant, neuralModel).sort((a, b) => (b.queryRelevance || 0) - (a.queryRelevance || 0) || (b.neuralScore || 0) - (a.neuralScore || 0))
      : relevant;
    // Take top 25
    const final = ranked.slice(0, 25);

    // Determine primary provider
    const primary = providerResults.sort((a, b) => b.results.length - a.results.length)[0].provider;

    return {
      provider: primary,
      results: final,
      total: merged.length,
      more: merged.length > 20,
      attempts: allAttempts,
      googleConfigured: providers.google.available(),
      braveConfigured: providers.brave.available(),
      bingConfigured: !!bingKey,
      providersUsed: providerResults.map(p => p.provider),
      neuralReranked: !!neuralModel,
    };
  }

  // Sequential fallback search (original behavior, used as fallback)
  async function sequentialSearch(query, { offset = 0, engine = "", lang = "" } = {}) {
    const q = cleanText(query, 600);
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
        const packed = await p.run(q, { offset, lang });
        const results = dedupe(packed.results || []);
        attempts.push({ provider: name, ms: Date.now() - started, count: results.length });
        if (!results.length) continue;
        const value = { provider: name, results: rankRelevant(results, q).slice(0, 20), total: packed.total ?? null, more: !!packed.more, attempts, googleConfigured: providers.google.available(), braveConfigured: providers.brave.available(), bingConfigured: !!bingKey };
        cache.set(key, { time: Date.now(), value });
        while (cache.size > MAX) cache.delete(cache.keys().next().value);
        return value;
      } catch (e) {
        attempts.push({ provider: name, ms: Date.now() - started, error: e.message });
        if (e.status === 429 || e.status === 403) failures.set(name, Date.now() + 60 * 1000);
        log("warn", "SEARCH", `${name} web search failed: ${e.message}`);
      }
    }
    return { provider: "none", results: [], attempts, googleConfigured: providers.google.available(), braveConfigured: providers.brave.available(), bingConfigured: !!bingKey };
  }

  // Main search function: try parallel first, fall back to sequential
  async function search(query, { offset = 0, engine = "", lang = "" } = {}) {
    const q = cleanText(query, 600);
    if (!q) return { provider: "none", results: [], attempts: [] };

    // Check cache first
    const cacheKey = `${engine}|${offset}|${lang}|${q.toLowerCase()}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.time < TTL) return { ...hit.value, cached: true };

    let result;
    if (engine) {
      // If a specific engine is requested, use sequential
      result = await sequentialSearch(query, { offset, engine, lang });
    } else {
      // Otherwise, use parallel search for speed
      try {
        result = await parallelSearch(query, { offset, lang });
        if (!result.results.length) {
          // Fall back to sequential if parallel returned nothing
          result = await sequentialSearch(query, { offset, lang });
        }
      } catch (e) {
        log("warn", "SEARCH", `Parallel search failed: ${e.message}, falling back to sequential`);
        result = await sequentialSearch(query, { offset, lang });
      }
    }

    // Cache the result
    if (result.results.length) {
      cache.set(cacheKey, { time: Date.now(), value: result });
      while (cache.size > MAX) cache.delete(cache.keys().next().value);
    }

    return result;
  }

  return {
    search,
    googleConfigured: () => providers.google.available(),
    order,
    providers: Object.keys(providers),
    parallelSearch,
    sequentialSearch,
  };
}

module.exports = { createWebSearch, parseDuckDuckGoHtml, parseBingHtml, parseGoogleApi, parseBraveApi, parseBingApi, parseWikipediaApi, unwrapBing, unwrapDuckDuckGo, expandQuery, mergeResults, neuralRerank };
