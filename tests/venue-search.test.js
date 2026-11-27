"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createVenueSearch, validateInput, buildOverpassQuery, parseElements, distanceMeters, CATEGORIES } = require("../src/services/venue-search");

const center = { lat: 51.5, lon: -0.12, radiusMeters: 1000, category: "cafe" };
const fixture = () => ({ elements: [
  { type: "node", id: 1, lat: 51.5001, lon: -0.12, tags: { amenity: "cafe", name: "Alpha Cafe", "addr:street": "Main St", phone: "+1 123", website: "https://alpha.example", opening_hours: "Mo-Fr 09:00-17:00", rating: "4.9", arbitrary: "secret" } },
  { type: "way", id: 2, center: { lat: 51.501, lon: -0.12 }, tags: { amenity: "cafe", name: "Beta" } },
  { type: "relation", id: 3, center: { lat: 51.502, lon: -0.12 }, tags: { amenity: "cafe", name: "Gamma" } },
] });
const response = data => ({ ok: true, text: async () => JSON.stringify(data) });

test("validates bounded coordinates, radius, category and pagination", () => {
  for (const input of [{}, { ...center, lat: 90.01 }, { ...center, lon: -181 }, { ...center, radiusMeters: 0 }, { ...center, radiusMeters: 50001 }, { ...center, radiusMeters: 1.5 }, { ...center, category: "hospital" }, { ...center, offset: -1 }, { ...center, limit: 101 }])
    assert.throws(() => validateInput(input));
  assert.equal(validateInput(center).category, "cafe");
  assert.deepEqual(Object.keys(CATEGORIES).sort(), ["attraction", "bar", "cafe", "fast_food", "gallery", "hotel", "museum", "park", "pub", "restaurant"].sort());
});

test("query uses allowlisted category values and never interpolates user text", () => {
  const q = buildOverpassQuery({ ...center, category: "hotel" });
  assert.match(q, /tourism.*hotel/);
  assert.match(q, /guest_house/);
  assert.doesNotMatch(q, /amenity.*cafe/);
  const injection = 'x"];node(0);out;/*';
  const safe = buildOverpassQuery({ ...center, text: injection });
  assert.doesNotMatch(safe, /node\(0\)|out;\/\*/);
  assert.match(safe, /around:1000,51\.5,-0\.12/);
});

test("normalizes node, way and relation coordinates and safe supplied tags only", () => {
  const rows = parseElements(fixture().elements, center);
  assert.equal(rows.length, 3);
  const node = rows.find(r => r.source.osmType === "node");
  assert.equal(node.name, "Alpha Cafe");
  assert.equal(node.address, "Main St");
  assert.equal(node.phone, "+1 123");
  assert.equal(node.website, "https://alpha.example/");
  assert.equal(node.openingHours, "Mo-Fr 09:00-17:00");
  assert.equal(node.rating, null);
  assert.equal(node.price, null);
  assert.equal(Object.hasOwn(node, "arbitrary"), false);
  assert.deepEqual(node.source, { provider: "openstreetmap", osmType: "node", osmId: 1 });
  assert.equal(rows.find(r => r.source.osmType === "way").lat, 51.501);
  assert.equal(rows.find(r => r.source.osmType === "relation").lon, -0.12);
});

test("drops unnamed, malformed, invalid geo, outside-radius, unsupported and duplicates", () => {
  const items = [
    { type: "node", id: 10, lat: 51.5, lon: -0.12, tags: { amenity: "cafe" } },
    { type: "node", id: 11, lat: 999, lon: 0, tags: { amenity: "cafe", name: "Bad" } },
    { type: "way", id: 12, center: { lat: 51.6, lon: -0.12 }, tags: { amenity: "cafe", name: "Far" } },
    { type: "node", id: 13, lat: 51.5, lon: -0.12, tags: { amenity: "hospital", name: "Wrong category" } },
    { type: "node", id: 14, lat: 51.5, lon: -0.12, tags: { amenity: "cafe", name: "Good" } },
    { type: "node", id: 14, lat: 51.5, lon: -0.12, tags: { amenity: "cafe", name: "Duplicate" } },
  ];
  assert.deepEqual(parseElements(items, center).map(r => r.name), ["Good"]);
});

test("haversine distance is accurate and stable", () => {
  assert.equal(distanceMeters(0, 0, 0, 0), 0);
  assert.ok(Math.abs(distanceMeters(0, 0, 0, 1) - 111195.08) < 2);
});

test("filters text locally and category, sorts by distance then stable ID, and pages", async () => {
  const provider = createVenueSearch({ fetch: async () => response({ elements: [
    { type: "node", id: 20, lat: 51.501, lon: -0.12, tags: { amenity: "cafe", name: "Coffee" } },
    { type: "node", id: 2, lat: 51.501, lon: -0.12, tags: { amenity: "cafe", name: "Coffee Two" } },
    { type: "node", id: 1, lat: 51.5001, lon: -0.12, tags: { amenity: "cafe", name: "Tea" } },
    { type: "node", id: 30, lat: 51.5, lon: -0.12, tags: { amenity: "bar", name: "Coffee Bar" } },
  ] }) });
  let result = await provider.search({ ...center, text: "coffee", limit: 1 });
  assert.equal(result.results[0].name, "Coffee Two");
  assert.equal(result.hasMore, true);
  assert.equal(result.nextOffset, 1);
  result = await provider.search({ ...center, text: "coffee", offset: 1, limit: 1 });
  assert.equal(result.results[0].name, "Coffee");
  assert.equal(result.hasMore, false);
  assert.equal(result.nextOffset, null);
  assert.equal((await provider.search({ ...center, text: "coffee" })).results.length, 2);
  assert.equal((await provider.search({ ...center, category: "bar" })).results[0].name, "Coffee Bar");
});

test("cache hits, expires, stays bounded, and text variants reuse unfiltered results", async () => {
  let now = 1000, calls = 0;
  const originalNow = Date.now; Date.now = () => now;
  try {
    const p = createVenueSearch({ ttlMs: 1000, maxEntries: 1, fetch: async () => { calls++; return response(fixture()); } });
    await p.search({ ...center, text: "Alpha" });
    await p.search({ ...center, text: "Beta" });
    assert.equal(calls, 1);
    assert.equal((await p.search({ ...center, text: "Beta" })).results[0].name, "Beta");
    assert.equal(p.cacheSize(), 1);
    await p.search({ ...center, category: "bar" });
    assert.equal(p.cacheSize(), 1);
    now += 1001;
    await p.search(center);
    assert.equal(calls, 3);
  } finally { Date.now = originalNow; }
});

test("serializes fetches and sends bounded, injected HTTPS provider requests", async () => {
  let running = 0, maxRunning = 0, calls = 0;
  const p = createVenueSearch({ endpoint: "https://overpass.example/api", fetch: async (url, opts) => {
    calls++; running++; maxRunning = Math.max(maxRunning, running);
    assert.equal(url, "https://overpass.example/api");
    assert.equal(opts.method, "POST");
    assert.ok(opts.signal);
    await new Promise(r => setTimeout(r, 10)); running--;
    return response(fixture());
  } });
  await Promise.all([p.search(center), p.search({ ...center, category: "bar" })]);
  assert.equal(maxRunning, 1);
  assert.equal(calls, 2);
});

test("timeout, HTTP failure, malformed response and network failure return structured unavailable errors", async () => {
  const timeout = createVenueSearch({ timeoutMs: 100, fetch: (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" })));
  }) });
  assert.equal((await timeout.search(center)).error.code, "TIMEOUT");
  const http = createVenueSearch({ fetch: async () => ({ ok: false, status: 503 }) });
  assert.equal((await http.search(center)).error.code, "UPSTREAM_ERROR");
  const malformed = createVenueSearch({ fetch: async () => response({ nope: [] }) });
  assert.equal((await malformed.search(center)).error.code, "UPSTREAM_ERROR");
  const network = createVenueSearch({ fetch: async () => { throw new Error("secret detail"); } });
  const error = (await network.search(center)).error;
  assert.equal(error.code, "UNAVAILABLE");
  assert.doesNotMatch(error.message, /secret/);
});

test("caller cancellation aborts the active upstream request", async () => {
  let started;
  const didStart = new Promise(resolve => { started = resolve; });
  const provider = createVenueSearch({ fetch: async (_url, { signal }) => {
    started();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" })), { once: true }));
  } });
  const controller = new AbortController();
  const result = provider.search({ ...center, signal: controller.signal });
  await didStart;
  controller.abort();
  assert.equal((await result).error.code, "CANCELLED");
});

test("response byte limit rejects oversized streams and fallback adapter responses", async () => {
  const oversized = "x".repeat(2 * 1024 * 1024 + 1);
  const text = createVenueSearch({ fetch: async () => ({ ok: true, text: async () => oversized }) });
  assert.equal((await text.search(center)).error.code, "UPSTREAM_ERROR");

  const json = createVenueSearch({ fetch: async () => ({ ok: true, json: async () => ({ elements: [], padding: oversized }) }) });
  assert.equal((await json.search(center)).error.code, "UPSTREAM_ERROR");

  let cancelled = false;
  const streamed = createVenueSearch({ fetch: async () => ({ ok: true, body: { getReader: () => ({
    async read() { return { done: false, value: Buffer.alloc(2 * 1024 * 1024 + 1) }; },
    async cancel() { cancelled = true; }
  }) } }) });
  assert.equal((await streamed.search(center)).error.code, "UPSTREAM_ERROR");
  assert.equal(cancelled, true);
});

test("metadata documents community attribution and modest-use caveat", () => {
  const p = createVenueSearch({ fetch: async () => response({ elements: [] }) });
  assert.match(p.metadata.usageNote, /not application backends/);
  assert.match(p.metadata.attribution.url, /^https:\/\//);
  assert.match(p.metadata.attribution.licenseUrl, /^https:\/\//);
});
