"use strict";
/**
 * 8.20.0 crawler upgrade — POSITIVE behavioral test for the JS-heavy page
 * rendering path. Verifies a real crawl of an SPA fixture actually:
 *   - invokes the renderer,
 *   - indexes the rendered DOM text (not the raw shell),
 *   - discovers the JS-injected internal link,
 *   - increments renderedHtmlPages,
 *   - and falls back cleanly to raw HTML when rendering fails.
 *
 * Uses app.locals.veyraProxyFetchBuffer (upstream fetch stub) and
 * app.locals.veyraCrawlRenderHtml (browser-engine render stub) so no real
 * Chromium or network is needed — just the real crawl execution path.
 */
const assert = require("node:assert/strict");
for (const name of ["AI_API_KEY", "OPENAI_API_KEY", "BRAVE_SEARCH_API_KEY", "BING_SEARCH_API_KEY", "GOOGLE_SEARCH_API_KEY", "MONGODB_URI"]) delete process.env[name];
process.env.VEYRA_CHROMIUM_ENABLED = "false";

const { app, mongoStore, CFG, createJob, jobs, scheduleCrawl, localSearch } = require("../src/server");

(async () => {
  mongoStore.enabled = false; mongoStore.uri = "";

  // SPA fixture: raw HTML has an EMPTY body; JS would render the visible text + a link.
  const SPA_ROOT = "https://spa-crawl-fixture.test/";
  const SPA_SHELL = `<!DOCTYPE html><html><head><title>SPA Crawl Fixture</title>
<script src="/app.js"></script><script type="module">import x from "/mod.js"</script>
</head><body><div id="root"></div></body></html>`;
  const SPA_RENDERED = `<!DOCTYPE html><html><head><title>SPA Crawl Fixture</title></head>
<body><main><h1>Rendered Only Heading</h1>
<p>Unique rendered body text for the veyra crawl fixture that only appears after JavaScript runs.</p>
<a href="/about">About the fixture</a></main></body></html>`;

  // Stub the upstream fetch: the SPA shell is the only HTTP response.
  let upstreamFetches = 0;
  app.locals.veyraProxyFetchBuffer = async (url, opts) => {
    upstreamFetches += 1;
    const u = String(url);
    if (u === SPA_ROOT || u === SPA_ROOT + "about") {
      return {
        ok: true, status: 200, contentType: "text/html; charset=UTF-8",
        body: Buffer.from(SPA_SHELL), finalUrl: u, cacheControl: "no-store",
        contentLength: String(Buffer.byteLength(SPA_SHELL)), redirectChain: [], truncated: false, tooLarge: false,
        setCookieHeader: null, etag: null, lastModified: null,
      };
    }
    return { ok: false, status: 404, contentType: "text/plain", body: Buffer.from("not found"), finalUrl: u, redirectChain: [] };
  };

  // Positive-path render stub: returns the rendered DOM for the root only.
  let renderCalls = 0, stopCalls = 0;
  app.locals.veyraCrawlRenderHtml = async (job, url, rawHtml) => {
    renderCalls += 1;
    if (String(url) !== SPA_ROOT) return null; // only the root renders successfully
    return {
      html: SPA_RENDERED,
      textLen: 140, rawTextLen: 0, renderMs: 42,
      finalUrl: SPA_ROOT, title: "SPA Crawl Fixture",
    };
  };

  // Start the crawl through the real scheduleCrawl → processItem path.
  const job = createJob(SPA_ROOT, { pageAccelerator: false });
  jobs.set(job.id, job);
  const status = scheduleCrawl(job, { seed: false });
  assert.ok(["running", "queued"].includes(status), `crawl should start, got ${status}`);

  // Wait for the crawl to finish (bounded).
  const deadline = Date.now() + 30000;
  while (!job.done && Date.now() < deadline) await new Promise(r => setTimeout(r, 500));
  assert.equal(job.done, true, "crawl should finish within the deadline");

  // 1. The renderer was actually invoked for the SPA root.
  assert.ok(renderCalls >= 1, `renderer should have been called at least once (got ${renderCalls})`);

  // 2. renderedHtmlPages was incremented.
  assert.ok(job.counts.renderedHtmlPages >= 1, `renderedHtmlPages should be >= 1 (got ${job.counts.renderedHtmlPages})`);

  // 3. The search index contains the RENDERED text, not the empty shell.
  const found = localSearch("rendered", 0, 20, { includeText: true });
  assert.ok(Array.isArray(found.results), "localSearch should return a results array");
  const found2 = localSearch("unique rendered body text fixture", 0, 20, { includeText: true });
  const hit = found2.results.find(r => r.url === SPA_ROOT || /spa-crawl-fixture\.test/.test(r.url));
  assert.ok(hit, `search should find the rendered page (got ${JSON.stringify((found2.results || []).map(r => r.url).slice(0, 5))})`);
  assert.match(String(hit.contentText || hit.text || hit.snippet || hit.description || ""), /unique rendered body text|Rendered Only Heading/i, "the indexed text must be the rendered DOM text");

  // 4. The JS-injected internal link was discovered from the rendered DOM.
  const aboutLink = job.links.find(l => l.url === SPA_ROOT + "about");
  assert.ok(aboutLink, `the rendered /about link should be in job.links (got ${JSON.stringify(job.links.map(l => l.url).slice(0, 10))})`);

  // 5. Clean-up: remove the render stub and verify the disabled path (fail-closed fallback).
  app.locals.veyraCrawlRenderHtml = null;
  const job2 = createJob(SPA_ROOT, { pageAccelerator: false });
  jobs.set(job2.id, job2);
  scheduleCrawl(job2, { seed: false });
  const deadline2 = Date.now() + 30000;
  while (!job2.done && Date.now() < deadline2) await new Promise(r => setTimeout(r, 500));
  assert.equal(job2.done, true, "second crawl should finish");
  assert.equal(job2.counts.renderedHtmlPages, 0, "with the renderer stub removed, renderedHtmlPages must stay 0");
  // The raw-HTML fallback still indexes the shell (with no visible text) — that's the pre-upgrade behavior.

  console.log("VeyraServer crawler JS-heavy render POSITIVE behavioral checks passed");
})().catch(e => { console.error(String(e.stack || e.message).slice(0, 800)); process.exit(1); });
