"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createSourceSearch, defaultEvidence, sourcePageUrl } = require("../src/services/source-search");
const { parseSiteScope } = require("../src/services/search-site-scope");

const query = parseSiteScope("orbital imaging");
const sample = "Orbital imaging uses remote instruments to capture details about the surface at different times of day.";
const html = (content, opts = {}) => ({
  body: `<html><head>${opts.meta || ""}</head><main><h1>${opts.title || "Orbital imaging"}</h1>${content}</main></html>`,
  finalUrl: opts.finalUrl
});

test("direct checks discard destinations with credentials, queries, private literals and account paths", () => {
  for (const url of ["http://127.0.0.1/", "https://[::1]/", "https://sub.localhost/", "https://example.org:8080/page",
    "https://user:pass@example.org/page", "https://example.org/page?q=search", "https://example.org/account/profile",
    "https://example.org/%61pi/view", "https://example.org./foo"]) assert.equal(sourcePageUrl(url), "", url);
  assert.equal(sourcePageUrl("https://www.example.org/page?utm_source=provider#part"), "https://www.example.org/page");
});

test("short discovery deadline returns already-read pages and aborts slow sites", async () => {
  const seeds = ["https://fast.example/space", "https://slow.example/space"].map(url => [url, /orbital/]);
  let slowSignal;
  const service = createSourceSearch({ seeds, discoverMs: 100, readPage: async (url, { signal }) => {
    if (url.includes("slow")) {
      slowSignal = signal;
      return new Promise(() => {}); // A stalled reader must not hold the response.
    }
    return html(`<p>${sample}</p>`);
  } });
  const results = await service.discover(query);
  assert.deepEqual(results.map(row => [row.url, row.evidence.level]), [[seeds[0][0], "strong"]]);
  assert.equal(slowSignal.aborted, true);
});

test("discovery stops after six publishers and one same-origin hop each", async () => {
  const seeds = Array.from({ length: 9 }, (_, index) => [`https://publisher${index}.example/space`, /orbital/]);
  const fetched = [];
  const service = createSourceSearch({ seeds, readPage: async url => {
    fetched.push(url);
    if (url.endsWith("/space")) return html('<a href="/child">Orbital imaging</a><a href="https://outside.example/">Orbital imaging</a>');
    return html(`<p>${sample}</p><a href="/grandchild">Orbital imaging</a>`);
  } });
  const result = await service.discover(query);
  assert.equal(result.length, 6);
  assert.equal(fetched.length, 12);
  assert(fetched.every(url => /(?:space|child)$/.test(url)));
});

test("keyword discovery reads the matching reference directly and still needs a topical passage", async () => {
  const asyncio = "https://docs.python.org/3/library/asyncio.html";
  const sample = "The asyncio library lets you write concurrent code using asynchronous tasks, coroutines, and the async/await syntax.";
  for (const [query, expected] of [["Python asyncio", [asyncio]], ["site:docs.python.org asyncio", [asyncio]],
    ["Python asyncio -site:docs.python.org", []], ["site:elsewhere.example asyncio", []]]) {
    const visits = [];
    const service = createSourceSearch({ async readPage(url) {
      visits.push(url);
      return html(`<p>${sample}</p>`, { title: "asyncio: Asynchronous I/O" });
    } });
    const results = await service.discover(parseSiteScope(query));
    assert.deepEqual(visits, expected);
    assert.deepEqual(results.map(row => [row.url, row.evidence.basis, row.snippet]),
      expected.map(url => [url, "catalog-passage", sample]));
  }
  const noMatch = createSourceSearch({ readPage: async () => html("<p>This page explains how to contact the team and where to request accessibility documentation for their website.</p>", { title: "asyncio" }) });
  assert.deepEqual(await noMatch.discover(parseSiteScope("Python asyncio")), []);
});

test("a link, hidden match, or provider snippet alone does not establish live evidence", async () => {
  const urls = Array.from({ length: 6 }, (_, n) => `https://source${n}.example/orbital-imaging`);
  const rows = urls.map(url => ({ url, title: "Orbital imaging", snippet: sample }));
  const service = createSourceSearch({ seeds: [], readPage: async url => {
    switch (urls.indexOf(url)) {
      case 0: return html(`<div data-nosnippet><p>${sample}</p></div><p>This documentation describes the administrative branch and its contact details.</p>`);
      case 1: return html(`<p>${sample}</p>`, { meta: '<meta name="robots" content="noindex">' });
      case 2: return html(`<p>${sample}</p>`, { finalUrl: "https://elsewhere.example/orbital-imaging" });
      case 3: return html(`<p>${sample}</p>`, { meta: '<meta name="robots" content="follow, index, max-snippet:-1">' });
      case 4: return html(`<p>${sample}</p>`, { title: "Verify you are human" });
      case 5: return html(`<p>${sample}</p>`, { meta: '<meta name="robots" content="max-snippet:30">' });
    }
  } });
  const enriched = await service.enrich(query, rows);
  assert.deepEqual(enriched.map(row => (row.evidence || defaultEvidence(row)).basis),
    ["no-passage", "excerpt-restricted", "not-checked", "page-passage", "not-checked", "excerpt-restricted"]);
  assert.equal(enriched[1].snippet, "");
  assert.equal(enriched[5].snippet, "");
  assert.equal(enriched[3].evidence.level, "moderate");
  assert.deepEqual(defaultEvidence({ source: "veyra-index" }), { level: "limited", basis: "indexed-copy" });
});
