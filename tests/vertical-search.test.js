"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { createVerticalSearch, safeUrl } = require("../src/services/vertical-search");
const checkpoint = require("../src/services/vertical-ranker-weights.json");
const { trainModel, evaluate } = require("../scripts/train-vertical-ranker");
const fixture = require("./fixtures/vertical-ranking");

function mock(routes, { env = {}, results = [], indexedImages, indexedVideos } = {}) {
  const calls = [];
  const service = createVerticalSearch({
    env,
    indexedImages,
    indexedVideos,
    async fetchText(rawUrl, options) {
      const url = new URL(rawUrl);
      calls.push({ url, options });
      const value = routes[url.host];
      assert.ok(value, `Unexpected provider ${url.host}`);
      const data = typeof value === "function" ? value(url, options) : value;
      if (data.status) return { ok: false, status: data.status };
      return { ok: true, text: typeof data === "string" ? data : JSON.stringify(data) };
    },
    async webSearch(query, options) {
      assert.equal(options.engine, undefined);
      calls.push({ query, options });
      return { results, more: true };
    }
  });
  return { calls, ...service };
}

test("image fallback validates artwork, license, provenance, cache and scoped pagination", async () => {
  const commons = (url) => {
    assert.equal(url.searchParams.get("gsrnamespace"), "6");
    return {
      query: { pages: [{ title: "File:Welsh lake.jpg", imageinfo: [{ mime: "image/jpeg", descriptionurl: "https://commons.wikimedia.org/wiki/File:Lake.jpg", thumburl: "https://thumb.wikimedia.org/fixture.jpg", extmetadata: { LicenseShortName: { value: "CC BY 4.0" } } }] }] },
      continue: { gsroffset: 12 }
    };
  };
  const service = mock({ "api.search.brave.com": { status: 429 }, "commons.wikimedia.org": commons,
    "api.openverse.org": { results: [] } }, { env: { BRAVE_SEARCH_API_KEY: "fixture" } });
  const first = await service.search("images", "Welsh lake", { noCache: false });
  assert.equal(first.provider, "wikimedia");
  assert.equal(first.results[0].license, "CC BY 4.0");
  assert.match(first.results[0].thumbnail, /^https:\/\/thumb\.wikimedia\.org\//);
  assert.equal(first.nextPage, 1);
  assert.equal(service.calls.length, 2);
  await service.search("images", "Welsh lake", { noCache: false });
  assert.equal(service.calls.length, 2);
  await service.search("images", "Welsh lake", { noCache: true });
  assert.equal(service.calls.length, 3);
  await service.search("images", "Welsh lake", { page: 1, provider: first.provider });
  assert.equal(service.calls.at(-1).url.searchParams.get("gsroffset"), "12");
  const scope = await service.search("images", "site:elsewhere.example Welsh lake");
  assert.equal(scope.status, "empty");
  assert.equal(service.calls.at(-1).url.searchParams.get("gsrsearch"), "Welsh lake");
  await service.search("images", "site: Welsh lake");
  assert.equal(service.calls.length, 5);
});

test("sparse Commons results can switch to relevant, credited Openverse photos", async () => {
  const photo = { id: "e211d652-746e-4c8a-b955-30d114360b8f", title: "Desk cable management",
    foreign_landing_url: "https://www.flickr.com/photos/example/1", url: "https://live.staticflickr.com/example.jpg",
    mature: false, license: "by", license_version: "2.0", creator: "A. Photographer" };
  const service = mock({
    "commons.wikimedia.org": { query: { pages: [{ title: "File:Different topic.jpg", imageinfo: [
      { mime: "image/jpeg", descriptionurl: "https://commons.wikimedia.org/wiki/File:Different.jpg", thumburl: "https://thumb.wikimedia.org/other.jpg" }
    ] }] } },
    "api.openverse.org": url => {
      assert.equal(url.searchParams.has("mature"), false, "Openverse rejects the legacy parameter alongside the sensitivity switch");
      assert.equal(url.searchParams.get("unstable__include_sensitive_results"), "false");
      return { page_count: 2, results: [photo, { ...photo, mature: true }, { ...photo, unstable__sensitivity: ["fixture"], url: "https://live.staticflickr.com/sensitive.jpg" },
        { ...photo, title: "Someone at a press conference", url: "https://live.staticflickr.com/other.jpg" }] };
    }
  }, { indexedImages: () => [] });
  const d = await service.search("images", "desk cable management");
  assert.equal(d.provider, "openverse");
  assert.equal(d.nextPage, 1);
  assert.deepEqual(d.results.map(r => [r.title, r.source, r.license, r.thumbnail]), [[photo.title, "A. Photographer · Openverse", "CC BY 2.0", `https://api.openverse.org/v1/images/${photo.id}/thumb/`]]);
  await service.search("images", "desk cable management", { provider: d.provider, page: d.nextPage });
  assert.equal(service.calls.at(-1).url.searchParams.get("page"), "2");
});

test("the requested subject, not generic action words, controls video results", async () => {
  const service = mock({ "sepiasearch.org": { total: 2, data: [
    { name: "Fix leaking car seals", url: "https://video.example/w/car-seals", nsfw: false, privacy: { id: 1 } },
    { name: "Repair a leaking tap", url: "https://video.example/w/plumbing", nsfw: false, privacy: { id: 1 } }
  ] } });
  assert.deepEqual((await service.search("videos", "fix a leaking tap", { provider: "peertube" })).results.map(r => r.title), ["Repair a leaking tap"]);
});

test("verified videos surface direct, scoped watch links without a paid provider", async () => {
  const service = mock({ "sepiasearch.org": { total: 0, data: [] } });
  for (const [q, count] of [["how to fix a leaking tap", 3], ["dripping faucet", 3], ["how to make crispy dosa", 4], ["डोसा", 4]]) {
    const page = await service.search("videos", q);
    assert.equal(page.provider, "verified-videos");
    assert.equal(page.results.length, count);
    assert.ok(page.results.every(r => /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(r.url) && r.source && r.thumbnail));
  }
  assert.equal(service.calls.length, 0);
  assert.equal((await service.search("videos", "site:youtube.com instant crispy dosa")).results.length, 2);
  assert.equal((await service.search("videos", "-site:youtube.com dosa")).results.length, 0);
  assert.equal((await service.search("videos", "dosa rap song")).results.length, 0);
});

test("India catalog accepts in-stock direct product listings and verifies INR without trusting search prices", async () => {
  const calls = [];
  const good = { title: "Adapto 65B", type: "Adaptor", url: "/products/adapto-65b?_pos=1", available: true, price: "1299.00",
    body: "<h2>65W Power Adapter</h2><p>Includes a Type-C PD port for laptops.</p>" };
  const service = createVerticalSearch({
    env: {}, fetchText: async () => { throw new Error("unused"); },
    webSearch: async () => ({ results: [] }),
    async fetchIndiaCatalog(rawUrl, { kind }) {
      const url = new URL(rawUrl);
      calls.push([kind, url]);
      assert.equal(url.hostname, "www.portronics.com", "site scope limits which merchant receives the query");
      if (kind === "product") return '<meta itemprop="priceCurrency" content="INR"><meta itemprop="price" content="1299">';
      assert.equal(url.searchParams.get("q"), "USB-C 65W charger");
      return JSON.stringify({ resources: { results: { products: [
        good, { ...good, url: "/products/no-stock", available: false }, { ...good, url: "https://outside.example/products/forged" },
        { ...good, title: "Konnect Dash Max", url: "/products/konnect-dash-max", type: "Cable" },
        { ...good, title: "67W USB-C Charger", url: "/products/ch-67" },
        { ...good, title: "Car Power", type: "Car Charger", url: "/products/car-power" },
        { ...good, title: "Adapto 65M", url: "/products/adapto-65m", price: "1249.00" }
      ] } } });
    }
  });
  const query = "site:portronics.com USB-C 65W charger";
  const page = await service.search("shopping", query, { region: "IN" });
  assert.equal(page.provider, "india-storefronts");
  const listings = new Map(page.results.map(r => [r.url, r.price]));
  assert.deepEqual(listings.get("https://www.portronics.com/products/adapto-65b"), { value: "1299.00", currency: "INR" });
  assert.equal(listings.get("https://www.portronics.com/products/adapto-65m"), null);
  assert.equal(listings.size, 2);
  assert.equal(page.nextPage, null);
  const preview = await service.search("shopping", query, { region: "IN", preview: true });
  assert.ok(preview.results.length && preview.results.every(row => row.price === null));
  assert.equal(calls.length, 4);
  await service.search("shopping", query, { region: "IN", privateSearch: true });
  await service.search("shopping", query, {});
  assert.equal(calls.length, 4, "incognito and non-India searches do not call storefronts");
});

test("News breaks topical ties in favor of recent coverage and collapses duplicate headlines", async () => {
  const rss = (title, date, url) => `<item><title>${title}</title><pubDate>${date}</pubDate><link>${url}</link></item>`;
  const service = mock({ "news.google.com": `<rss version="2.0"><channel>${
    rss("India space launch historical report", "Fri, 12 Jul 2019 01:00:00 GMT", "https://news.example/old")}${
    rss("India space launch update", new Date(Date.now() - 3600000).toUTCString(), "https://news.example/new")}${
    rss("India Space Launch Update!", new Date(Date.now() - 7200000).toUTCString(), "https://news.example/copy")
  }</channel></rss>` });
  const d = await service.search("news", "India space launch", { region: "IN" });
  assert.deepEqual(d.results.map(r => r.url), ["https://news.example/new", "https://news.example/old"]);
});

test("deduplicates and paginates images from both providers and the local crawler", async () => {
  const asset = i => `https://images-assets.nasa.gov/photo-${i}.jpg`;
  const nasa = "https://www.nasa.gov/gallery";
  const service = mock({
    "api.search.brave.com": url => {
      assert.equal(url.searchParams.get("safesearch"), "strict");
      return { results: Array.from({ length: 48 }, (_, i) => ({ title: `Planet Brave ${i}`, url: `${nasa}/${i}`, properties: { url: asset(i) } })) };
    },
    "commons.wikimedia.org": url => {
      const size = Number(url.searchParams.get("gsrlimit")), offset = Number(url.searchParams.get("gsroffset"));
      assert.equal(size, offset ? 12 : 48);
      return { ...(!offset ? { continue: { gsroffset: 48 } } : {}), query: { pages: Array.from({ length: size }, (_, index) => {
        const i = index + offset;
        return { index, title: `File:Planet Commons ${i}.jpg`,
          imageinfo: [{ mime: "image/jpeg", url: asset(i + (offset ? 100 : 47)), descriptionurl: `https://commons.wikimedia.org/wiki/Fixture_${i}`, thumburl: `https://thumb.wikimedia.org/${i}.jpg` }] };
      }) } };
    }
  }, { env: { BRAVE_SEARCH_API_KEY: "fixture" }, indexedImages: () => [
    { url: asset(99), imageUrl: asset(99), title: "Planet archive photo", sourcePageUrl: nasa, thumbnail: asset(99) },
    { url: asset(100), imageUrl: asset(100), title: "Planet archive closeup", sourcePageUrl: nasa, thumbnail: asset(100) }
  ] });
  const rows = [];
  let page = await service.search("images", "Planet", { noCache: false });
  assert.equal(page.provider, "image-mix");
  let pages = 0;
  while (++pages <= 11) {
    rows.push(...page.results);
    if (page.nextPage == null) break;
    page = await service.search("images", "Planet", { page: page.nextPage, provider: page.nextProvider || page.provider, noCache: false });
  }
  assert.equal(pages, 10);
  assert.equal(page.nextPage, null, "the feed stops when Commons has no continuation");
  assert.equal(rows.length, 109);
  assert.equal(new Set(rows.map(row => row.imageUrl)).size, 109);
  assert.deepEqual(new Set(rows.map(row => row.provider)), new Set(["brave", "wikimedia", "veyra-crawler"]));
  assert.equal(service.calls.length, 3, "cached hybrid pages reuse their feeds, then Commons continues at offset 48");
  assert.equal(service.calls.at(-1).url.searchParams.get("gsroffset"), "48");
  assert.equal(rows.find(row => row.imageUrl === asset(99)).sourcePageUrl, nasa);
  assert.equal(rows.find(row => row.imageUrl === asset(99)).thumbnail, asset(99));
  const scoped = await service.search("images", "site:nasa.gov Planet");
  assert.ok(scoped.results.every(row => new URL(row.sourcePageUrl || row.url).hostname.endsWith("nasa.gov")));
});

test("Videos can continue from a provider into existing crawl-index watch pages", async () => {
  const service = mock({ "sepiasearch.org": { total: 1, data: [{
    url: "https://video.example/w/abc123", name: "Jaipur walk", nsfw: false, privacy: { id: 1 }
  }] } }, { indexedVideos: (_q, offset, limit, region) => {
    assert.equal(offset, 0);
    assert.equal(region, "IN");
    const rows = [{ url: "https://www.youtube.com/watch?v=abcdefghijk", title: "Jaipur fort walk" },
      { url: "https://video.example/unknown", title: "Unverified watch page" }];
    return { total: 2, results: rows.slice(0, limit) };
  } });
  const first = await service.search("videos", "Jaipur", { region: "IN" });
  assert.equal(first.provider, "peertube");
  assert.equal(first.nextProvider, "veyra-crawler");
  const next = await service.search("videos", "Jaipur", { region: "IN", provider: first.nextProvider, page: first.nextPage });
  assert.equal(next.provider, "veyra-crawler");
  assert.deepEqual(next.results.map(row => row.url), ["https://www.youtube.com/watch?v=abcdefghijk"]);
  assert.equal(next.nextPage, null);
});

test("agency previews use exact hosts and publisher renditions collapse without changing the URLs", async () => {
  const sourcePageUrl = "https://science.nasa.gov/gallery";
  const nasa = "https://assets.science.nasa.gov";
  const esa = "https://media.esa.int/legacy/web/images/2022/gallery/259791/image-thumb__259791";
  const nasaPreview = `${nasa}/content/dam/science/webb/planet.png/jcr:content/renditions/cq5dam.web.1280.1280.png`;
  const esaPreview = `${esa}__social_share/planet.jpg`;
  const oversized = `${nasa}/dynamicimage/assets/science/webb/other.png?w=8423&h=14589&fit=clip`;
  const lookalike = nasaPreview.replace(".gov", ".gov.example.com");
  const lookalikeEsa = esaPreview.replace("esa.int", "esa.int.example.com");
  const service = mock({ "commons.wikimedia.org": {} }, { indexedImages: () => [
    nasaPreview, `${nasa}/dynamicimage/assets/science/webb/planet.png?w=720&h=1280&fit=clip`,
    esaPreview, `${esa}__fit_large/planet.webp`, oversized, lookalike, lookalikeEsa,
  ].map(url => ({ url, imageUrl: url, title: "Planet", sourcePageUrl, thumbnail: url })) });
  const { results } = await service.search("images", "Planet");
  assert.equal(results.length, 5);
  for (const url of [nasaPreview, esaPreview]) {
    const row = results.find(item => item.url === url);
    assert.equal(row?.thumbnail, url);
    assert.equal(row?.sourcePageUrl, sourcePageUrl);
  }
  for (const url of [oversized, lookalike, lookalikeEsa]) {
    assert.equal(results.find(item => item.url === url)?.thumbnail, "");
  }
});

test("a stalled provider body times out and leaves time for a fallback", async () => {
  const service = createVerticalSearch({
    env: { BRAVE_SEARCH_API_KEY: "fixture" },
    providerTimeoutMs: 30,
    async fetchText(rawUrl, { signal }) {
      if (new URL(rawUrl).hostname === "api.search.brave.com") {
        await assert.rejects(delay(1000, null, { signal }), { name: "AbortError" });
        assert.equal(signal.reason.name, "TimeoutError");
        throw signal.reason;
      }
      return { ok: true, text: '<rss><channel><item><title>Fallback report</title><link>https://news.google.com/rss/articles/fixture</link></item></channel></rss>' };
    },
    async webSearch() { assert.fail("Web discovery is not needed for news"); }
  });
  const result = await service.search("news", "report");
  assert.equal(result.provider, "google-news-rss");
  assert.equal(result.results[0].title, "Fallback report");
});

test("eBay supplies real listing fields; discovery fallback never invents prices", async () => {
  const service = mock({
    "api.ebay.com": (url, options) => {
      if (url.pathname.includes("oauth2")) {
        assert.equal(options.method, "POST");
        return { access_token: "fixture-token", expires_in: 7200 };
      }
      assert.equal(options.headers["X-EBAY-C-MARKETPLACE-ID"], "EBAY_GB");
      assert.equal(options.headers.Authorization, "Bearer fixture-token");
      return { itemSummaries: [{ title: "Camera", itemWebUrl: "https://www.ebay.co.uk/itm/123", image: { imageUrl: "https://i.ebayimg.com/fixture" }, condition: "Used", price: { value: "65.00", currency: "GBP" } }, { title: "Bad host", itemWebUrl: "https://ebay.co.uk.example/itm/234" }], next: "unused" };
    }
  }, { env: { EBAY_CLIENT_ID: "fixture", EBAY_CLIENT_SECRET: "fixture" } });
  const one = await service.search("shopping", "Camera");
  assert.equal(one.results.length, 1);
  assert.deepEqual(one.results[0].price, { value: "65.00", currency: "GBP" });
  assert.equal(one.nextPage, 1);
  await service.search("shopping", "Camera", { page: one.nextPage, provider: one.provider });
  assert.equal(service.calls.length, 3, "OAuth token is reused");
  assert.equal(service.calls.at(-1).url.searchParams.get("offset"), "12");

  const fallback = mock({}, { results: [
    { url: "https://www.amazon.co.uk/dp/B0123ABCDE", title: "Camera", price: { value: "3", currency: "GBP" } },
    { url: "https://www.amazon.co.uk/s?k=camera", title: "Store search" },
    { url: "https://amazon.co.uk.example/dp/B0123ABCDE", title: "Non-merchant domain" }
  ] });
  const discovery = await fallback.search("shopping", "Camera");
  assert.equal(discovery.results.length, 1);
  assert.equal(discovery.results[0].price, null);
  assert.equal(fallback.calls[0].options.noCache, true);
});

test("opt-in YouTube, keyless PeerTube, and constrained web-video discovery", async () => {
  const service = mock({
    "www.googleapis.com": { items: [{ id: { videoId: "abcDEF12345" }, snippet: { title: "Repair tutorial", channelTitle: "Workshop", thumbnails: { medium: { url: "https://i.ytimg.com/fixture" } } } }] },
    "sepiasearch.org": { total: 20, data: [
      { name: "Repair on PeerTube", url: "https://video.example/w/abcdef", nsfw: false, privacy: { id: 1 }, duration: 87, account: { displayName: "Workshop" } },
      { name: "Private video", url: "https://video.example/w/private", nsfw: false, privacy: { id: 3 } },
      { name: "Unsafe link", url: "javascript:void(0)", nsfw: false, privacy: { id: 1 } }
    ] }
  }, { env: { YOUTUBE_DATA_API_KEY: "fixture", VEYRA_YOUTUBE_SEARCH: "1" } });
  assert.equal((await service.search("videos", "repair")).provider, "youtube");
  const preview = await service.search("videos", "repair", { preview: true });
  assert.equal(preview.provider, "peertube");
  assert.deepEqual(preview.results.map(r => [r.duration, r.source]), [["1:27", "Workshop"]]);
  assert.equal(preview.nextPage, 1);
  assert.equal(service.calls.length, 2);
  const fallback = mock({ "sepiasearch.org": { status: 503 } }, { results: [{ url: "https://www.youtube.com/watch?v=abcDEF12345", title: "Watch" }, { url: "https://www.youtube.com/results?search_query=watch", title: "Search" }] });
  const videos = await fallback.search("videos", "watch");
  assert.equal(videos.results.length, 1);
  assert.equal(videos.results[0].thumbnail, "https://i.ytimg.com/vi/abcDEF12345/hqdefault.jpg");
  assert.equal((await fallback.search("videos", "watch", { page: 1, provider: "peertube" })).status, "unavailable");
});

test("normalizes Brave, RSS, DOI, and Hacker News feeds without unsafe links", async () => {
  const service = mock({
    "api.search.brave.com": { results: [{ title: "<b>A report</b><script>bogus()</script>", url: "https://publisher.example/report", description: "On <em>topic</em>" }] },
    "news.google.com": '<rss><channel><item><title>City update</title><link>https://news.google.com/rss/articles/fixture</link><source>Local news</source></item></channel></rss>',
    "api.crossref.org": { message: { items: [{ DOI: "10.3232/a/b", title: ["Article"], published: { "date-parts": [[2025, 3, 1]] } }], "total-results": 14 } },
    "hn.algolia.com": { hits: [{ objectID: "42", title: "Community thread" }, { objectID: "not-a-number", title: "Skip" }], nbPages: 2 }
  }, { env: { BRAVE_SEARCH_API_KEY: "fixture" } });
  const brave = await service.search("news", "City");
  assert.equal(brave.results[0].title, "A report");
  assert.equal(brave.results[0].snippet, "On topic");
  assert.equal((await service.search("news", "City", { provider: "google-news-rss" })).results[0].source, "Local news");
  assert.equal((await service.search("research", "Article")).results[0].url, "https://doi.org/10.3232/a/b");
  assert.equal((await service.search("discussions", "Thread")).results[0].url, "https://news.ycombinator.com/item?id=42");
  for (const bad of ["javascript:alert(1)", "https://a:b@merchant.example/thing", "http://127.0.0.1/test", "http://box.local/test", "https://merchant.example:1234/test"]) assert.equal(safeUrl(bad), "");
});

test("federates research sources, deduplicates DOI aliases and honors a publisher scope", async () => {
  const service = mock({
    "api.crossref.org": { message: { items: [{ DOI: "10.1234/A", title: ["Malaria vaccine study"] }], "total-results": 20 } },
    "www.ebi.ac.uk": { resultList: { result: [
      { doi: "10.1234/a", id: "123", source: "MED", title: "Malaria vaccine study" },
      { doi: "10.1234/b", id: "124", source: "MED", title: "Malaria vaccine efficacy" },
      { id: "../123", source: "MED", title: "Malaria vaccine unsafe URL" },
      { id: "125", source: "MED", title: "Unrelated article" }
    ] } }
  });
  const page = await service.search("research", "malaria vaccine");
  assert.equal(page.provider, "research-mix");
  assert.equal(page.results.length, 2);
  assert.deepEqual(new Set(page.results.map(x => x.provider)), new Set(["crossref", "europe-pmc"]));
  assert.equal(page.nextPage, 1);
  const next = await service.search("research", "malaria vaccine", { page: 1, provider: page.provider });
  assert.ok(next.results.every(x => x.provider === "crossref"));
  const scoped = await service.search("research", "site:europepmc.org malaria vaccine");
  assert.equal(scoped.results.length, 2);
  assert.ok(scoped.results.every(x => x.url.startsWith("https://europepmc.org/article/MED/")));
});

test("searches an eligible Stack Exchange community alongside HN, except in incognito", async () => {
  const service = mock({
    "api.stackexchange.com": { has_more: true, items: [
      { link: "https://cooking.stackexchange.com/questions/7/dosa", title: "Dosa batter fermentation", tags: ["fermentation"] },
      { link: "https://cooking.stackexchange.com.invalid/questions/7/dosa", title: "Dosa batter lookalike" }
    ] },
    "hn.algolia.com": { hits: [{ objectID: "12", title: "A guide to dosa batter" }], nbPages: 1 }
  });
  const page = await service.search("discussions", "dosa batter");
  assert.equal(page.provider, "discussion-mix");
  assert.deepEqual(new Set(page.results.map(x => x.provider)), new Set(["stack-exchange", "hacker-news"]));
  assert.equal(page.nextPage, 1);
  assert.equal((await service.search("discussions", "site:cooking.stackexchange.com dosa batter")).results.length, 1);
  const count = service.calls.filter(call => call.url?.hostname === "api.stackexchange.com").length;
  assert.equal((await service.search("discussions", "dosa batter", { privateSearch: true })).provider, "hacker-news");
  assert.equal(service.calls.filter(call => call.url?.hostname === "api.stackexchange.com").length, count);
});

test("NASA Images results cite the item page and use only NASA-hosted image previews", async () => {
  const service = mock({
    "images-api.nasa.gov": { collection: { metadata: { total_hits: 20 }, items: [
      { data: [{ nasa_id: "PIA00001", media_type: "image", title: "Jupiter plume" }], links: [{ href: "https://images-assets.nasa.gov/image/PIA00001/preview.jpg", rel: "preview" }] },
      { data: [{ nasa_id: "TEST", media_type: "image", title: "Jupiter lookalike" }], links: [{ href: "https://images-assets.nasa.gov.invalid/image/test.jpg", rel: "preview" }] },
      { data: [{ nasa_id: "TEST", media_type: "video", title: "Jupiter video" }], links: [{ href: "https://images-assets.nasa.gov/image/test.jpg", rel: "preview" }] }
    ] } }
  });
  const page = await service.search("images", "site:images.nasa.gov Jupiter");
  assert.equal(page.provider, "nasa-library");
  assert.equal(page.results.length, 1);
  assert.equal(page.results[0].url, "https://images.nasa.gov/details/PIA00001");
  assert.equal(page.nextPage, 1);
});

test("checked-in category weights are reproducible from topic-disjoint hand-labeled data", () => {
  assert.deepEqual(checkpoint, trainModel());
  assert.equal(new Set([...fixture.train, ...fixture.holdout].map(row => row[1].toLowerCase())).size, fixture.train.length + fixture.holdout.length);
  assert.ok(evaluate(checkpoint.weights).correct > evaluate([0, 0, 0, 1]).correct);
});
