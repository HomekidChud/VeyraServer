"use strict";
const assert = require("assert");
const { AcquisitionManager, canonicalUrl, isPrivateAddress, rankSearchCandidates, createSafeLookup } = require("../src/services/acquisition-manager");
const { BrowserEngine } = require("../src/browser/browser-engine");
const { MongoStore } = require("../src/core/mongo-store");

(async () => {
  assert.equal(canonicalUrl("https://example.com/a?utm_source=x&keep=1#frag"), "https://example.com/a?keep=1");
  assert.equal(canonicalUrl("https://example.com/A/?source=docs&keep=Case"), "https://example.com/A/?source=docs&keep=Case");
  assert.equal(canonicalUrl("https://user:pass@example.com/private"), "");
  let calls = 0;
  const manager = new AcquisitionManager({
    assertPublicUrl: async () => {},
    cacheTtlMs: 60_000,
    fetchImpl: async (url) => {
      calls += 1;
      const body = url.endsWith("robots.txt") ? "User-agent: *\nAllow: /" : "<html><title>Veyra</title><main>Hello acquisition world</main></html>";
      return new Response(body, { status: 200, headers: { "content-type": url.endsWith("robots.txt") ? "text/plain" : "text/html" } });
    }
  });
  const first = await manager.fetch("https://example.com/page?utm_medium=test");
  const second = await manager.fetch("https://example.com/page");
  assert.equal(first.status, 200);
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 2, "robots and page should be fetched once each");
  assert.equal(manager.parseDocument(first.body, first.url).title, "Veyra");
  const initialMetrics = manager.report();
  assert.equal(initialMetrics.requests, 2);
  assert.equal(initialMetrics.completedRequests, 2);
  assert.equal(initialMetrics.successfulHttpResponses, 2);
  assert.equal(initialMetrics.cacheHits, 1);
  assert.equal(Number.isFinite(initialMetrics.memoryRssBytes), true);
  assert.equal(Number.isFinite(initialMetrics.requestThroughputPerSecond), true);

  const rich = manager.parseDocument(Buffer.from('<html lang="en"><head><title>Rich page</title><meta name="description" content="Useful summary"><meta name="author" content="A Writer"><link rel="canonical" href="/canonical"><link rel="alternate" type="application/rss+xml" href="/feed.xml"><script type="application/ld+json">{"@type":"Article","headline":"Rich page"}</script></head><body><main><h1>Heading</h1><p>Article text with enough useful details for extraction and reader context. It contains a second sentence with more practical explanation.</p></main></body></html>'), "https://example.com/page");
  assert.equal(rich.canonical, "https://example.com/canonical");
  assert.equal(rich.description, "Useful summary");
  assert.equal(rich.author, "A Writer");
  assert.equal(rich.jsonLd[0].headline, "Rich page");
  assert.deepEqual(rich.feedLinks, ["https://example.com/feed.xml"]);
  assert.equal(rich.headings[0], "Heading");
  assert.equal(rich.extractionStatus, "extracted");
  const challengePage = manager.parseDocument("<html><title>Just a moment...</title><body>Checking your browser before continuing.</body></html>", "https://example.com/challenge");
  const consentPage = manager.parseDocument("<html><title>Before you continue to Example</title><body>Consent required.</body></html>", "https://example.com/consent");
  assert.equal(challengePage.extractionStatus, "challenge");
  assert.equal(challengePage.text, "", "challenge boilerplate must not be retained as answer evidence");
  assert.equal(consentPage.extractionStatus, "consent");
  assert.equal(consentPage.text, "");
  const extractionMetrics = manager.report();
  assert.equal(extractionMetrics.documentsExtracted, 1);
  assert.equal(extractionMetrics.challengePages, 1);
  assert.equal(extractionMetrics.consentPages, 1);
  assert.equal(extractionMetrics.extractionFailures, 2);
  assert.equal(Number.isFinite(extractionMetrics.extractionP50Ms), true);
  assert.equal(Number.isFinite(extractionMetrics.extractionP95Ms), true);

  assert.equal(isPrivateAddress("100.64.0.1"), true);
  assert.equal(isPrivateAddress("198.18.0.2"), true);
  assert.equal(isPrivateAddress("ff02::1"), true);
  assert.equal(isPrivateAddress("::ffff:10.0.0.1"), true);
  assert.equal(isPrivateAddress("::ffff:0808:0808"), false);
  assert.equal(isPrivateAddress("::192.0.2.1"), true);
  assert.equal(isPrivateAddress("64:ff9b::8.8.8.8"), true);
  assert.equal(isPrivateAddress("2001:1::1"), true);
  assert.equal(isPrivateAddress("3fff::1"), true);
  assert.equal(isPrivateAddress("metadata.google.internal"), true);
  assert.equal(isPrivateAddress("168.63.129.16"), true);
  assert.equal(isPrivateAddress("2001:4860:4860::8888"), false);
  assert.equal(isPrivateAddress("8.8.8.8"), false);

  const mongoPolicy = new MongoStore({ uri: "" });
  const publicBody = Buffer.from("cache policy fixture");
  for (const [url, result, meta] of [
    ["https://example.com/item?access_token=secret", { body: publicBody, contentType: "text/plain", status: 200, ok: true, cacheControl: "public, max-age=60" }, {}],
    ["https://example.com/item", { body: publicBody, contentType: "text/plain", status: 200, ok: true, cacheControl: "private, max-age=60" }, {}],
    ["https://example.com/item", { body: publicBody, contentType: "text/plain", status: 200, ok: true, cacheControl: "no-store" }, {}],
    ["https://example.com/item", { body: publicBody, contentType: "text/plain", status: 200, ok: true, vary: "Cookie" }, {}],
    ["https://example.com/item", { body: publicBody, contentType: "text/plain", status: 200, ok: true, setCookieHeader: "sid=secret" }, {}],
    ["https://example.com/item", { body: publicBody, contentType: "text/plain", status: 200, ok: true }, { sessionId: "user-session" }]
  ]) await mongoPolicy.putProxyCache("acquisition:v1:test", { finalUrl: url, ...result }, { url, ttlMs: 30000, ...meta });
  assert.equal(mongoPolicy.stats.writes, 0, "unsafe/private/sensitive responses must be rejected before persistent caching");

  let noStoreCalls = 0;
  const noStore = new AcquisitionManager({ assertPublicUrl: async () => {}, cacheTtlMs: 60000, fetchImpl: async () => { noStoreCalls += 1; return new Response(`response ${noStoreCalls}`, { headers: { "content-type": "text/plain", "cache-control": "no-store" } }); } });
  await noStore.fetch("https://example.com/no-store", { skipRobots: true, retries: 0 });
  await noStore.fetch("https://example.com/no-store", { skipRobots: true, retries: 0 });
  assert.equal(noStoreCalls, 2, "no-store must never be served from shared cache");
  assert.equal(noStore.report().cacheEntries, 0);

  const durableRecords = new Map();
  const durableStore = {
    enabled: true,
    async getProxyCache(key) { const value = durableRecords.get(key); return value && value.expiresAtMs > Date.now() ? value : null; },
    async putProxyCache(key, result, meta) { durableRecords.set(key, { time: Date.now(), expiresAtMs: Date.now() + meta.ttlMs, etag: result.etag, lastModified: result.lastModified, response: { ...result } }); },
    async deleteProxyCache(key) { durableRecords.delete(key); }
  };
  let durableFetches = 0;
  const durableFirst = new AcquisitionManager({ assertPublicUrl: async () => {}, persistence: durableStore, cacheTtlMs: 60000, fetchImpl: async () => { durableFetches += 1; return new Response("<p>durable public page content</p>", { headers: { "content-type": "text/html", "cache-control": "public, max-age=45" } }); } });
  await durableFirst.fetch("https://example.com/durable", { skipRobots: true, retries: 0 });
  await new Promise(resolve => setImmediate(resolve));
  const durableSecond = new AcquisitionManager({ assertPublicUrl: async () => {}, persistence: durableStore, cacheTtlMs: 60000, fetchImpl: async () => { throw new Error("persistent cache miss"); } });
  const persistentHit = await durableSecond.fetch("https://example.com/durable", { skipRobots: true, retries: 0 });
  assert.equal(persistentHit.cacheHit, true);
  assert.equal(durableSecond.report().persistentCacheHits, 1);
  assert.equal(durableFetches, 1, "a valid persisted public response should survive manager restart");
  assert.equal(durableRecords.values().next().value.expiresAtMs - durableRecords.values().next().value.time <= 45010, true, "upstream max-age must cap persistent cache TTL (allowing two clock reads to straddle 10 ms)");

  let authCalls = 0;
  const isolated = new AcquisitionManager({ assertPublicUrl: async () => {}, cacheTtlMs: 60000, fetchImpl: async () => { authCalls += 1; return new Response(`private ${authCalls}`, { headers: { "content-type": "text/plain", "cache-control": "public, max-age=60" } }); } });
  const authFirst = await isolated.fetch("https://example.com/user", { skipRobots: true, retries: 0, headers: { Authorization: "Bearer secret" } });
  const authSecond = await isolated.fetch("https://example.com/user", { skipRobots: true, retries: 0, headers: { Authorization: "Bearer secret" } });
  assert.equal(authCalls, 2, "authenticated content must not be cached or coalesced");
  assert.notEqual(authFirst.body.toString(), authSecond.body.toString());

  let signedCalls = 0;
  const signed = new AcquisitionManager({ assertPublicUrl: async () => {}, cacheTtlMs: 60000, fetchImpl: async () => { signedCalls += 1; return new Response(`signed ${signedCalls}`, { headers: { "content-type": "text/plain", "cache-control": "public, max-age=60" } }); } });
  await signed.fetch("https://example.com/document?access_token=mock-secret", { skipRobots: true, retries: 0 });
  await signed.fetch("https://example.com/document?access_token=mock-secret", { skipRobots: true, retries: 0 });
  assert.equal(signedCalls, 2, "URL query credentials must never enter the shared cache");
  assert.equal(signed.report().cacheEntries, 0);

  const requests = [];
  const feeds = new AcquisitionManager({ assertPublicUrl: async () => {}, fetchImpl: async url => {
    requests.push(url);
    if (url.endsWith("robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith("/news")) return new Response('<html><head><title>News</title><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body><article>News page.</article></body></html>', { headers: { "content-type": "text/html" } });
    if (url.endsWith("/feed.xml")) return new Response('<?xml version="1.0"?><rss version="2.0"><channel><title>News feed</title><item><title>Feed item</title><link>https://example.com/item</link><description>A useful article description</description><pubDate>Fri, 10 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>', { headers: { "content-type": "application/rss+xml" } });
    return new Response("", { status: 404 });
  } });
  const discoveredFeed = await feeds.discoverFeeds("https://example.com/news");
  assert.equal(discoveredFeed.feeds.length, 1);
  assert.equal(discoveredFeed.items[0].title, "Feed item");
  assert.equal(discoveredFeed.items[0].url, "https://example.com/item");
  assert.equal(feeds.report().feedsDiscovered, 1);
  assert(requests.includes("https://example.com/feed.xml"));

  const sitemap = new AcquisitionManager({ assertPublicUrl: async () => {}, fetchImpl: async url => {
    if (url.endsWith("robots.txt")) return new Response("User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap-index.xml", { headers: { "content-type": "text/plain" } });
    if (url.endsWith("sitemap-index.xml")) return new Response('<sitemapindex><sitemap><loc>https://example.com/child.xml</loc></sitemap></sitemapindex>', { headers: { "content-type": "application/xml" } });
    if (url.endsWith("child.xml")) return new Response('<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>', { headers: { "content-type": "application/xml" } });
    if (url.endsWith("sitemap.xml")) return new Response("<urlset></urlset>", { headers: { "content-type": "application/xml" } });
    return new Response("", { status: 404 });
  } });
  const sitemapUrls = await sitemap.discoverSitemaps("https://example.com/home", { maxFiles: 5, maxUrls: 20 });
  assert.deepEqual(sitemapUrls.sort(), ["https://example.com/a", "https://example.com/b"]);

  const candidateRows = [
    { url: "https://irrelevant.example/garden", title: "Garden flowers and plants", snippet: "A seasonal guide to flowers." },
    { url: "https://misleading.example/seo", title: "Sponsored guide", snippet: "Veyra crawler reliability cache", sourceQuality: 0.1, duplicateProbability: 0.2 },
    { url: "https://alpha.example/veyra-search", title: "Veyra crawler cache reliability", snippet: "Veyra crawler reliability improves when cache fetches are bounded." },
    { url: "https://beta.example/guides/cache", title: "Veyra cache reliability for crawlers", snippet: "This guide explains reliable Veyra crawler cache behavior." },
    { url: "https://alpha.example/veyra-search?utm_source=mirror", title: "Duplicate Veyra result", snippet: "A duplicate tracking variant." }
  ];
  const rankedCandidates = rankSearchCandidates("Veyra crawler reliability cache", candidateRows, 2);
  assert.equal(rankedCandidates.length, 2);
  assert.equal(rankedCandidates[0].url, candidateRows[2].url, "strong query/title/snippet match should outrank an unrelated first result");
  assert.notEqual(new URL(rankedCandidates[0].url).hostname, new URL(rankedCandidates[1].url).hostname, "selection should prefer a second independent domain where relevance is comparable");
  const knownRelevant = new Set(["https://alpha.example/veyra-search", "https://beta.example/guides/cache"]);
  const precisionAt2 = rankedCandidates.filter(row => knownRelevant.has(row.url)).length / rankedCandidates.length;
  assert.equal(precisionAt2, 1, "the fixed labelled fixture should achieve Precision@2 = 1, without treating misleading snippets or tracking duplicates as new evidence");
  const pageRequests = [];
  const retrieval = new AcquisitionManager({ assertPublicUrl: async () => {}, cacheTtlMs: 0, fetchImpl: async target => {
    if (target.endsWith("robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    pageRequests.push(target);
    return new Response(`<html><title>${new URL(target).hostname} Veyra crawler</title><main><p>Veyra crawler cache reliability is confirmed by this useful public article passage with enough detailed words to count as an extracted document.</p><p>Additional article context explains bounded response reuse, source distinctions, and why domain diversity improves discovery.</p></main></html>`, { headers: { "content-type": "text/html" } });
  } });
  const retrievalResult = await retrieval.searchFirst("Veyra crawler reliability cache", async () => ({ provider: "mock", results: candidateRows }), { limit: 2 });
  assert.equal(retrievalResult.metrics.selectedCandidates, 2);
  assert.equal(pageRequests.length, 2, "only the bounded highest-utility candidates should be fetched");
  assert.equal(pageRequests.some(target => target.includes("irrelevant.example") || target.includes("misleading.example")), false);
  assert.equal(retrievalResult.metrics.uniqueCandidates, 4, "tracking URL variants should collapse before candidate scheduling");
  assert.equal(retrievalResult.metrics.averageSelectedRelevance > 0, true);
  assert.equal(retrievalResult.metrics.endToEndMs >= retrievalResult.metrics.searchLatencyMs || retrievalResult.metrics.searchLatencyMs === null, true);
  assert.equal(retrieval.report().duplicates, 1, "canonical duplicate removal should be reflected in crawler metrics");

  const deadlineManager = new AcquisitionManager({ searchFirstDeadlineMs: 300, timeoutMs: 5000, assertPublicUrl: async () => {}, fetchImpl: async (url, opts) => {
    if (url.endsWith("robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    return new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
  } });
  const deadlineStart = Date.now();
  const deadlineRetrieval = await deadlineManager.searchFirst("bounded query", async () => ({ results: [{ url: "https://slow.example/article", title: "Relevant result", snippet: "A result for the bounded query." }] }), { limit: 1 });
  assert.equal(deadlineRetrieval.deadlineExceeded, true);
  assert.equal(deadlineRetrieval.metrics.deadlineExpired, true);
  assert(Date.now() - deadlineStart < 1000, "search-first discovery and fetch must honor the single total deadline");

  const publicLookup = createSafeLookup(async () => [{ address: "8.8.8.8", family: 4 }, { address: "2001:4860:4860::8888", family: 6 }]);
  const publicAddresses = await new Promise((resolve, reject) => publicLookup("fixture.example", { all: true }, (error, rows) => error ? reject(error) : resolve(rows)));
  assert.equal(publicAddresses.length, 2, "socket lookups should return only validated public addresses");
  const rebindingLookup = createSafeLookup(async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
  await assert.rejects(() => new Promise((resolve, reject) => rebindingLookup("rebound.example", { all: true }, (error, rows) => error ? reject(error) : resolve(rows))), error => error.code === "SSRF_BLOCKED", "socket-time DNS revalidation must reject a mixed public/private answer");

  const cancellation = new AbortController();
  const cancellable = new AcquisitionManager({ assertPublicUrl: async () => {}, fetchImpl: async (_url, opts) => new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })) });
  const pending = cancellable.fetch("https://example.com/slow", { skipRobots: true, signal: cancellation.signal, retries: 0 });
  setTimeout(() => cancellation.abort(), 10);
  await assert.rejects(pending, error => error.code === "OPERATION_CANCELLED");
  assert.equal(cancellable.report().inflight, 0);

  const robotsBlocked = new AcquisitionManager({ assertPublicUrl: async () => {}, fetchImpl: async url => new Response(url.endsWith("robots.txt") ? "User-agent: *\nDisallow: /blocked" : "should not fetch", { headers: { "content-type": "text/plain" } }) });
  await assert.rejects(() => robotsBlocked.fetch("https://example.com/blocked/page"), error => error.code === "ROBOTS_DISALLOWED");

  const redirectGuard = new AcquisitionManager({ maxRetries: 0, assertPublicUrl: async url => { if (new URL(url).hostname === "127.0.0.1") throw Object.assign(new Error("private redirect"), { code: "SSRF_BLOCKED" }); }, fetchImpl: async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }) });
  await assert.rejects(() => redirectGuard.fetch("https://example.com/redirect", { skipRobots: true, retries: 0 }), error => error.code === "SSRF_BLOCKED");

  const oversized = new AcquisitionManager({ assertPublicUrl: async () => {}, fetchImpl: async () => new Response("x".repeat(70000), { headers: { "content-type": "text/plain" } }) });
  await assert.rejects(() => oversized.fetch("https://example.com/large", { skipRobots: true, maxBytes: 65536, retries: 0 }), error => error.code === "RESPONSE_TOO_LARGE");

  let simultaneous = 0, peakSimultaneous = 0;
  const globallyBounded = new AcquisitionManager({ assertPublicUrl: async () => {}, globalConcurrency: 1, perHostConcurrency: 4, fetchImpl: async () => { simultaneous += 1; peakSimultaneous = Math.max(peakSimultaneous, simultaneous); await new Promise(resolve => setTimeout(resolve, 15)); simultaneous -= 1; return new Response("ok", { headers: { "content-type": "text/plain" } }); } });
  await Promise.all([globallyBounded.fetch("https://one.example/a", { skipRobots: true, retries: 0 }), globallyBounded.fetch("https://two.example/b", { skipRobots: true, retries: 0 })]);
  assert.equal(peakSimultaneous, 1, "global concurrency applies across different hosts");
  assert.equal(globallyBounded.report().activeGlobalRequests, 0);

  let rateLimitCalls = 0;
  const rateLimited = new AcquisitionManager({ assertPublicUrl: async () => {}, maxRetries: 3, fetchImpl: async () => { rateLimitCalls += 1; return new Response("limited", { status: 429, headers: { "content-type": "text/plain", "retry-after": "60" } }); } });
  await assert.rejects(() => rateLimited.fetch("https://example.com/rate-limited", { skipRobots: true, maxRetryAfterMs: 10 }), error => error.status === 429);
  assert.equal(rateLimitCalls, 1, "long Retry-After guidance is respected by not retrying inside the short request budget");

  const disabled = new BrowserEngine({ browserEnabled: false }, async () => {}, () => {});
  await assert.rejects(() => disabled.ensureBrowser(), error => error.code === "BROWSER_ENGINE_UNAVAILABLE");
  console.log("Acquisition manager, query-aware discovery, DNS-rebinding protection, cache isolation, cancellation, global limits, retry guidance, SSRF and Chromium opt-in tests passed");
})().catch(error => { console.error(error); process.exit(1); });
