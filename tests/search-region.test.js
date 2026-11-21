"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { queryLanguage, unicodeWords, braveLanguage } = require("../src/services/search-language");
const { walkSitemap } = require("../src/services/crawl-sitemap");
const { createWebSearch, rankResultsByRelevance } = require("../src/services/websearch");
const { createVerticalSearch } = require("../src/services/vertical-search");

const response = value => ({ ok: true, text: JSON.stringify(value) });

test("Unicode boundaries and multilingual ranking are independent of Deep Search", () => {
  for (const [input, word] of [["Cafe\u0301", "café"], ["हिन्दी", "हिन्दी"], ["السَّلَام", "السَّلَام"],
    ["Ελλάδα", "ελλάδα"], ["КОСМОС", "космос"], ["日本語の検索", "日本語"], ["ภาษาไทย", "ภาษา"], ["Ａ १ ７ 中", "7"]]) {
    assert.ok(unicodeWords(input).includes(word));
    assert.equal(rankResultsByRelevance(word, [
      { title: "Unrelated page", snippet: "None", url: "https://example.in/a" },
      { title: input, snippet: "", url: "https://example.org/b" }
    ], "IN")[0].url, "https://example.org/b");
  }
  assert.equal(queryLanguage("ひらがなと漢字", "en-GB"), "ja");
  assert.equal(queryLanguage("行星", "zh-Hant"), "zh-Hant");
  assert.equal(queryLanguage("ภาษาไทย", "en-GB"), "th");
  assert.equal(queryLanguage("Aide", "fr-CA"), "fr-CA");
  assert.equal(braveLanguage("ja"), "jp");
  assert.equal(braveLanguage("cy-GB"), "");
});

test("sitemap parsing still ignores media locations, reads locale links and stays bounded", () => {
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

test("Web passes India market hints, prefers equally relevant Indian results and isolates caches", async () => {
  const calls = [];
  const service = createWebSearch({ env: {
    WEB_SEARCH_ORDER: "brave,google,bing,duckduckgo",
    BRAVE_SEARCH_API_KEY: "fixture", GOOGLE_SEARCH_API_KEY: "fixture", GOOGLE_SEARCH_CX: "fixture", BING_SEARCH_API_KEY: "fixture"
  }, fetchText: async raw => {
    const url = new URL(raw);
    calls.push(url);
    if (url.hostname === "api.search.brave.com") return response({ web: { results: [
      { url: "https://example.com/railway", title: "रेलवे" }, { url: "https://example.in/railway", title: "रेलवे" }
    ] } });
    if (url.hostname === "www.googleapis.com") return response({ items: [] });
    if (url.hostname === "api.bing.microsoft.com") return response({ webPages: { value: [] } });
    return { ok: true, text: "<body></body>" };
  } });
  const q = "रेलवे", options = { lang: "en-GB", offset: 20, region: "IN" };
  assert.equal((await service.search(q, options)).results[0].url, "https://example.in/railway");
  const params = Object.fromEntries(calls.map(url => [url.hostname, Object.fromEntries(url.searchParams)]));
  assert.equal(params["api.search.brave.com"].country, "IN");
  assert.equal(params["api.search.brave.com"].search_lang, "hi");
  assert.equal(params["api.search.brave.com"].offset, "1");
  assert.equal(params["www.googleapis.com"].gl, "in");
  assert.equal(params["api.bing.microsoft.com"].cc, "IN");
  assert.equal(params["html.duckduckgo.com"].kl, "in-en");
  assert.equal((await service.search(q, options)).cached, true);
  assert.equal((await service.search(q, { ...options, region: ["IN"] })).results[0].url, "https://example.com/railway");
  assert.equal(calls.length, 8);
});

test("Web feed uses provider-specific offsets without repeating first-page-only adapters", async () => {
  const calls = [];
  const service = createWebSearch({ env: {
    WEB_SEARCH_ORDER: "brave,google,bing,duckduckgo",
    BRAVE_SEARCH_API_KEY: "fixture", GOOGLE_SEARCH_API_KEY: "fixture", GOOGLE_SEARCH_CX: "fixture", BING_SEARCH_API_KEY: "fixture"
  }, fetchText: async raw => {
    const url = new URL(raw);
    calls.push(url);
    if (url.hostname === "api.search.brave.com") return response({ query: { more_results_available: true }, web: { results: [
      { url: "https://example.in/railway", title: "Indian railway" },
      { url: "https://example.in/other", title: "Apple orchard" }
    ] } });
    if (url.hostname === "www.googleapis.com") return response({ items: [] });
    if (url.hostname === "api.bing.microsoft.com") return response({ webPages: { value: [] } });
    assert.fail(`Non-paginated provider called: ${url.hostname}`);
  } });
  const result = await service.search("railway", { region: "IN", offset: 20, feed: true });
  assert.deepEqual(result.results.map(row => row.title), ["Indian railway"]);
  assert.equal(result.nextOffset, 30);
  const params = Object.fromEntries(calls.map(url => [url.hostname, url.searchParams]));
  assert.equal(params["api.search.brave.com"].get("count"), "10");
  assert.equal(params["api.search.brave.com"].get("offset"), "2");
  assert.equal(params["www.googleapis.com"].get("start"), "21");
  assert.equal(params["api.bing.microsoft.com"].get("offset"), "20");
  assert.equal((await service.search("railway", { offset: 90, feed: true })).nextOffset, null);
});

test("Web feeds can use relevant Wikipedia articles when the search provider returns unrelated links", async () => {
  const calls = [];
  const service = createWebSearch({ env: { WEB_SEARCH_ORDER: "bing", BING_SEARCH_API_KEY: "fixture" }, fetchText: async raw => {
    const url = new URL(raw);
    calls.push(url);
    if (url.hostname === "api.bing.microsoft.com") {
      return response({ webPages: { value: [{ url: "https://example.in/fruit", name: "Apple orchard" }] } });
    }
    assert.equal(url.hostname, "hi.wikipedia.org");
    assert.equal(url.searchParams.get("srnamespace"), "0");
    assert.equal(url.searchParams.get("srsearch"), "जयपुर");
    const offset = Number(url.searchParams.get("sroffset"));
    return response({ ...(!offset ? { continue: { sroffset: 10 } } : {}), query: { search: [
      { ns: 0, title: offset ? "जयपुर ज़िला" : "जयपुर", snippet: "भारत का <span>जयपुर</span> &amp; राजस्थान" },
      { ns: 2, title: "जयपुर (user page)" }
    ] } });
  } });
  const options = { feed: true, reference: true, region: "IN" };
  const first = await service.search("जयपुर", options);
  assert.equal(first.provider, "wikipedia", "the label follows displayed, not rejected, results");
  assert.deepEqual(first.results.map(r => r.snippet), ["भारत का जयपुर & राजस्थान"]);
  assert.equal(first.nextOffset, 10);
  const next = await service.search("जयपुर", { ...options, offset: first.nextOffset });
  assert.deepEqual(next.results.map(r => r.title), ["जयपुर ज़िला"]);
  assert.equal(next.nextOffset, null);
  await service.search("site:example.in जयपुर", options);
  await service.search("जयपुर", { ...options, engine: "bing" });
  assert.deepEqual(calls.filter(url => url.hostname === "hi.wikipedia.org").map(url => url.searchParams.get("sroffset")), ["0", "10"]);
});

test("India applies to image mix, video and news requests without inventing research market filters", async () => {
  const calls = [];
  const service = createVerticalSearch({ env: { BRAVE_SEARCH_API_KEY: "fixture", VEYRA_YOUTUBE_SEARCH: "1", YOUTUBE_DATA_API_KEY: "fixture" }, indexedImages: () => [], fetchText: async raw => {
    const url = new URL(raw);
    calls.push(url);
    if (url.pathname.includes("/images/search")) return response({ results: [
      { url: "https://example.in/railway", title: "रेलवे", thumbnail: { src: "https://imgs.search.brave.com/railway" } }
    ] });
    if (url.pathname.includes("/videos/search") || url.pathname.includes("/news/search")) return response({ results: [] });
    if (url.hostname === "commons.wikimedia.org") return response({ query: { pages: [] } });
    if (url.pathname.includes("/youtube/")) return response({ items: [{ id: { videoId: "abcdefghijk" }, snippet: { title: "रेलवे" } }] });
    if (url.hostname === "news.google.com") return { ok: true, text: "<rss><channel><item><title>रेलवे</title><link>https://example.in/news</link></item></channel></rss>" };
    if (url.hostname === "api.crossref.org") return response({ message: { items: [{ DOI: "10.1000/railway", title: ["Railway in India"] }] } });
    throw new Error(`Unexpected provider: ${url.hostname}`);
  } });
  const options = { region: "IN", lang: "en-GB" };
  for (const category of ["images", "videos", "news", "research"]) {
    assert.equal((await service.search(category, "रेलवे", options)).results.length, 1, category);
  }
  const params = (testUrl, key) => calls.find(testUrl)?.searchParams.get(key);
  for (const category of ["images", "news", "videos"]) {
    const match = url => url.pathname.endsWith(`/${category}/search`);
    assert.equal(params(match, "country"), "IN");
    assert.equal(params(match, "search_lang"), "hi");
  }
  assert.equal(params(url => url.pathname.includes("/youtube/"), "regionCode"), "IN");
  assert.equal(params(url => url.hostname === "news.google.com", "ceid"), "IN:hi");
  assert.equal(params(url => url.hostname === "api.crossref.org", "region"), null);
  await service.search("news", "railway", options);
  const news = calls.find(url => url.hostname === "news.google.com" && url.searchParams.get("q") === "railway").searchParams;
  assert.equal(news.get("hl"), "en-IN");
  assert.equal(news.get("gl"), "IN");
  assert.equal(news.get("ceid"), "IN:en");
});

test("India Shopping accepts Indian product pages and only explicit INR offers", async () => {
  const amazon = "https://www.amazon.in/dp/B0123ABCDE", flipkart = "https://www.flipkart.com/camera/p/itmabc";
  const googleResult = (link, ...offers) => ({ link, title: "Camera", pagemap: { offer: offers } });
  const web = createWebSearch({ env: { WEB_SEARCH_ORDER: "google", GOOGLE_SEARCH_API_KEY: "fixture", GOOGLE_SEARCH_CX: "fixture" },
    fetchText: async raw => {
      const url = new URL(raw);
      assert.equal(url.searchParams.get("gl"), "in");
      assert.equal(url.searchParams.get("q"), "Camera buy online India");
      return response({ items: [
        googleResult(amazon, { price: "124990.50", pricecurrency: "INR" }),
        googleResult(flipkart, { price: "20", pricecurrency: "GBP" }),
        googleResult("https://www.croma.com/camera/p/123456", { price: "9", pricecurrency: "INR" }, { price: "8", pricecurrency: "INR" }),
        googleResult("https://www.flipkart.com/search?q=camera"),
        googleResult("https://www.amazon.in.example.com/dp/B0123ABCDE"),
        googleResult("https://www.amazon.co.uk/dp/B0123ABCDE")
      ] });
    }
  });
  const service = createVerticalSearch({ webSearch: web.search, env: { EBAY_CLIENT_ID: "fixture", EBAY_CLIENT_SECRET: "fixture" },
    fetchText: async () => assert.fail("India Shopping should not call eBay")
  });
  const { results, provider } = await service.search("shopping", "Camera", { region: "IN" });
  assert.equal(provider, "web-discovery");
  assert.equal(results.length, 3);
  assert.deepEqual(results.find(row => row.url === amazon).price, { value: "124990.50", currency: "INR" });
  assert.equal(results.find(row => row.url === flipkart).price, null);
  assert.equal(results.find(row => row.url.includes("croma")).price, null);
});
