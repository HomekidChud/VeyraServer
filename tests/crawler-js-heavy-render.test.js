"use strict";
/**
 * 8.20.0 crawler upgrade — JS-heavy HTML pages must be indexed with rendered DOM
 * text (via the real browser engine) when available, not just the raw un-executed
 * shell. This is the "super mega upgrade" that closes the biggest crawler gap:
 * SPAs (YouTube, React/Vue sites) were indexed as near-empty documents because
 * their HTML body has no visible text before JavaScript runs.
 */
const assert = require("node:assert/strict");
for (const name of ["AI_API_KEY", "OPENAI_API_KEY", "BRAVE_SEARCH_API_KEY", "BING_SEARCH_API_KEY", "GOOGLE_SEARCH_API_KEY", "MONGODB_URI"]) delete process.env[name];
process.env.VEYRA_CHROMIUM_ENABLED = "false";

const { app, mongoStore, CFG, browserCapabilitySignals, canRenderHtmlWithBrowser, renderHtmlWithBrowser, createJob, jobs } = require("../src/server");

(async () => {
  mongoStore.enabled = false; mongoStore.uri = "";

  // 1. A representative JS-heavy page: SPA with empty body and a render script.
  const spaHtml = `<!DOCTYPE html><html><head><title>My React App</title>
<script src="/app.js"></script><script type="module">import x from "/mod.js"</script>
</head><body><div id="root"></div></body></html>`;
  const signals = browserCapabilitySignals(spaHtml, { "content-type": "text/html" });
  assert.equal(signals.shellSignals, true, "an empty-body SPA should be flagged as shell-heavy");
  assert.equal(signals.heavy, true, "the SPA fixture should be classified as JS-heavy");

  // 2. A normal content page should NOT be flagged heavy.
  const staticHtml = `<!DOCTYPE html><html><head><title>Wikipedia: Cats</title></head>
<body><h1>Cat</h1><p>The cat is a domestic species of small carnivorous mammal.</p>
<p>Learn more about domesticated animals and their history.</p></body></html>`;
  const staticSignals = browserCapabilitySignals(staticHtml, { "content-type": "text/html" });
  assert.equal(staticSignals.heavy, false, "a plain static page with real text must not be treated as JS-heavy");

  // 3. The upgrade path must exist and be gated by the browser engine being available.
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "server.js"), "utf8");
  assert.match(src, /renderHtmlWithBrowser/, "the renderHtmlWithBrowser helper must exist");
  assert.match(src, /canRenderHtmlWithBrowser\(job\)/, "processItem must gate on canRenderHtmlWithBrowser");
  assert.match(
    src,
    /if \(signals\.heavy && canRenderHtmlWithBrowser\(job\)\)/,
    "JS-heavy HTML pages must be routed through the browser-rendering upgrade"
  );
  assert.match(src, /renderedHtmlPages \+= 1/, "renderedHtmlPages counter must be incremented so operators can see it in telemetry");
  assert.match(src, /counts: \{ htmlPages: 0, renderedHtmlPages: 0,/, "job.counts must include renderedHtmlPages from the start");

  // 4. The upgrade path must exist and be gated by the browser engine being available.
  const job = createJob("https://spa-fixture.test/", {});
  jobs.set(job.id, job);
  assert.equal(typeof job.counts.renderedHtmlPages, "number", "renderedHtmlPages must be initialized");
  assert.equal(job.counts.renderedHtmlPages, 0);
  //    (this is the Render free-plan case — must NOT try to spawn a browser there).
  assert.equal(CFG.browserEnabled, false, "test fixture must run with Chromium disabled");
  assert.equal(canRenderHtmlWithBrowser(job), false, "canRenderHtmlWithBrowser must be false when Chromium is disabled (fail-closed)");
  const rendered = await renderHtmlWithBrowser(job, "https://spa-fixture.test/", spaHtml);
  assert.equal(rendered, null, "renderHtmlWithBrowser must return null when the browser engine is unavailable");

  console.log("VeyraServer crawler JS-heavy page rendering upgrade checks passed");
})().catch(e => { console.error(String(e.stack || e.message).slice(0, 600)); process.exit(1); });
