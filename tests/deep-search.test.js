"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { once } = require("node:events");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { queryLanguage, unicodeWords, braveLanguage } = require("../src/services/search-language");
const { walkSitemap } = require("../src/services/crawl-sitemap");
const { createWebSearch, rankResultsByRelevance } = require("../src/services/websearch");
const { researchBatch } = require("../src/services/research-search");
const { parseSiteScope } = require("../src/services/search-site-scope");

test("Unicode word boundaries, combining marks and mixed-script ranking", () => {
  for (const [input, word] of [["Cafe\u0301", "café"], ["हिन्दी", "हिन्दी"], ["السَّلَام", "السَّلَام"], ["القمر", "القمر"],
    ["Ελλάδα", "ελλάδα"], ["КОСМОС", "космос"], ["日本語の検索", "日本語"], ["ภาษาไทย", "ภาษา"], ["Ａ १ ７ 中", "7"], ["Ａ १ ７ 中", "१"], ["Ａ १ ７ 中", "中"]]) {
    assert.ok(unicodeWords(input).includes(word), `${input} yields ${word}`);
    assert.equal(rankResultsByRelevance(word, [
      { title: "Unrelated page", snippet: "None", url: "https://example.org/a" },
      { title: input, snippet: "", url: "https://example.org/b" }
    ])[0].url, "https://example.org/b");
  }
  assert.equal(queryLanguage("ひらがなと漢字", "en-GB"), "ja");
  assert.equal(queryLanguage("行星", "zh-Hant"), "zh-Hant");
  assert.equal(queryLanguage("ภาษาไทย", "en-GB"), "th");
  assert.equal(queryLanguage("Aide", "fr-CA"), "fr-CA");
  assert.equal(braveLanguage("ja"), "jp");
  assert.equal(braveLanguage("cy-GB"), "");
});

test("sitemap structure ignores media locations and applies a hard entry ceiling", () => {
  const found = [];
  walkSitemap(`<urlset xmlns:linker="http://www.w3.org/1999/xhtml"><url>
    <loc>https://example.org/sitemap-guide.xml?a=1&amp;b=2</loc>
    <video:video><video:loc>https://example.org/ignored</video:loc></video:video>
    <linker:link rel="alternate" hreflang="fr" href="https://example.org/fr"/>
    <linker:link rel="alternate" hreflang="es" href="https://example.org/es"/>
  </url></urlset>`, (url, kind) => found.push([url, kind]), 2);
  assert.deepEqual(found, [
    ["https://example.org/sitemap-guide.xml?a=1&b=2", "sitemap"],
    ["https://example.org/fr", "locale-alternate"]
  ]);
});

test("Deep Search uses the providers' page strides and omits non-pageable providers after page zero", async () => {
  const seen = [];
  const ws = createWebSearch({ env: {
    WEB_SEARCH_ORDER: "brave,bing,google,duckduckgo", WEB_SEARCH_DEEP_WIKIPEDIA: "0",
    BRAVE_SEARCH_API_KEY: "fixture", BING_SEARCH_API_KEY: "fixture", GOOGLE_SEARCH_API_KEY: "fixture", GOOGLE_SEARCH_CX: "fixture"
  }, fetchText: async raw => {
    const u = new URL(raw);
    const provider = u.hostname.split(".").slice(-2, -1)[0];
    seen.push([provider, Object.fromEntries(u.searchParams)]);
    const page = { url: `https://example.org/${provider}`, title: "搜尋", description: "搜尋資料" };
    const data = provider === "brave" ? { web: { results: [page] }, query: { more_results_available: true } }
      : provider === "microsoft" ? { webPages: { value: [{ ...page, name: page.title, snippet: page.description }] } }
      : { items: [{ title: page.title, link: page.url }], queries: { nextPage: [{}] } };
    return { ok: true, text: JSON.stringify(data) };
  } });
  const result = await ws.search("搜尋", { researchPage: 3, lang: "zh-Hant", limit: 10, noCache: true });
  const byProvider = Object.fromEntries(seen);
  assert.equal(seen.length, 3);
  assert.equal(byProvider.brave.offset, "3");
  assert.equal(byProvider.brave.search_lang, "zh-hant");
  assert.equal(byProvider.microsoft.offset, "30");
  assert.equal(byProvider.googleapis.start, "31");
  assert.equal(result.more, true);
  assert.equal(result.results.length, 3);
});

test("Wikipedia is opt-in by category, bounded to known editions and skipped if outside site scope", async () => {
  const requests = [];
  const service = createWebSearch({ env: { WEB_SEARCH_ORDER: "unconfigured" }, fetchText: async (input, options) => {
    requests.push(input);
    assert.equal(options.maxRedirects, 0);
    return { ok: true, text: JSON.stringify({
      query: { search: [{ title: "太陽 系", snippet: "<b>太陽</b> &amp; 星" }] },
      continue: { sroffset: 30 }
    }) };
  } });
  assert.equal((await service.search("太陽", { lang: "ja" })).results.length, 0);
  assert.equal((await service.search("太陽 site:nasa.gov", { lang: "ja", researchPage: 0 })).results.length, 0);
  assert.equal(requests.length, 0);
  const result = await service.search("太陽 site:ja.wikipedia.org", { lang: "en", researchPage: 2 });
  const endpoint = new URL(requests[0]);
  assert.equal(endpoint.origin, "https://ja.wikipedia.org");
  assert.equal(endpoint.searchParams.get("sroffset"), "20");
  assert.equal(endpoint.searchParams.get("srsearch"), "太陽");
  assert.equal(result.results[0].snippet, "太陽 & 星");
  assert.deepEqual(result.results[0].providers, ["wikipedia"]);
  assert.equal(result.more, true);
});

test("one bounded refinement for thin plain-language results, none for explicitly scoped queries", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const localSearch = () => ({ results: [], total: 0 });
  const webSearch = async (query, opts) => {
    calls.push({ query, opts });
    return { attempts: [{ provider: "bing" }], results: opts.engine ? [{ url: "https://example.org/refined", title: "月の地質", source: "bing" }] : [] };
  };
  const run = query => researchBatch({ query, scope: parseSiteScope(query), page: 0, lang: "ja", signal, localSearch, webSearch });
  const refined = await run("Please find 月の地質");
  assert.deepEqual(calls.map(({ query }) => query), ["Please find 月の地質", "月の地質"]);
  assert.equal(calls[1].opts.engine, "bing");
  assert.ok(calls[1].opts.budgetMs <= calls[0].opts.budgetMs);
  assert.equal(calls[1].opts.signal, signal);
  assert.equal(refined.results.length, 1);
  await run("Please find 月の地質 site:example.org -site:bad.example.org");
  assert.equal(calls.length, 3);
});

test("Deep Search HTTP contract merges sources, preserves scope, and serves partial results without an estimated total", async () => {
  const dir = mkdtempSync(join(tmpdir(), "veyra-deep-"));
  Object.assign(process.env, { VEYRA_DATA_DIR: join(dir, "data"), VEYRA_WORK_DIR: join(dir, "jobs"), GATE_ENABLED: "false",
    ACCESS_GATE: "0", VEYRA_CHROMIUM_ENABLED: "false" });
  delete process.env.MONGODB_URI;
  const { app, indexDocument, jobs } = require("../src/server");
  const calls = [];
  app.locals.veyraWebSearch = { async search(query, options) {
    calls.push({ query, options });
    return {
      results: [
        { url: "https://example.org/ja?utm_source=web#first", title: "日本語の資料", providers: ["bing"] },
        { url: "https://other.example/ja", title: "Out of scope", source: "bing" },
        { url: "https://bad.example.org/ja", title: "Excluded", source: "bing" }
      ], more: true, attempts: [{ provider: "bing" }, { provider: "brave", error: "timeout" }]
    };
  } };
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const get = (query, params = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/search/deep?${new URLSearchParams({ q: query, lang: "en-GB", ...params })}`);
  try {
    indexDocument("https://example.org/ja", `<html lang="ja"><title>日本語</title><main>日本語で検索できます。</main></html>`);
    const q = "日本語で site:example.org -site:bad.example.org";
    const response = await get(q);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const first = await response.json();
    assert.equal(first.ok, true);
    assert.deepEqual(first.results.map(row => row.canonicalUrl), ["https://example.org/ja"]);
    assert.deepEqual(first.results[0].providers, ["bing", "veyra-index"]);
    assert.equal(first.results[0].lang, "ja");
    assert.equal(first.partial, true);
    assert.equal(first.nextPage, 1);
    assert.equal(Object.hasOwn(first, "total"), false);
    assert.equal(calls[0].query, q);
    assert.equal(calls[0].options.lang, "ja");
    assert.equal(calls[0].options.noCache, true);
    const last = await (await get(q, { page: 9 })).json();
    assert.equal(last.nextPage, null);
    assert.equal(last.limitReached, true);
    assert.equal((await get(q, { page: 10 })).status, 400);
    assert.equal((await (await get("moon site:")).json()).siteFilter.invalid, true);
    assert.equal(calls.length, 2);
    assert.equal(jobs.size, 0, "search never starts a crawler");
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
