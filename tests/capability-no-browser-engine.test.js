"use strict";
/**
 * Regression — /api/browser/capability must not return BROWSER_ENGINE when the
 * Chromium browser engine is disabled on this server.
 *
 * This is a BEHAVIORAL test: it starts the real express app with the browser
 * engine disabled and drives /api/browser/capability for the YouTube homepage
 * and a watch URL. Pre-fix, the route returned mode: "BROWSER_ENGINE" for
 * YouTube home even though browserEnabled was false — the client then waited
 * for a Chromium session that could never start and fell back to the skeleton.
 *
 * The route is exercised through the documented injection point
 * `app.locals.veyraProxyFetchBuffer` (a fake upstream with no real network),
 * for both the success path and the failing-probe path.
 */
const assert = require("node:assert/strict");

for (const name of ["AI_API_KEY", "AI_API_BASE_URL", "OPENAI_API_KEY", "BRAVE_SEARCH_API_KEY", "BING_SEARCH_API_KEY", "GOOGLE_SEARCH_API_KEY", "MONGODB_URI"]) delete process.env[name];
process.env.VEYRA_CHROMIUM_ENABLED = "false";
process.env.YT_FAST_PROXY_ONLY = "false";

const { app, CFG } = require("../src/server");

function youtubeHomeHtml() {
  // A minimal YouTube-home-shaped document: heavy, spa, plenty of scripts —
  // enough for browserCapabilitySignals to flag it as a heavy SPA page.
  return `<!doctype html><html><head><title>YouTube</title>${"<script></script>".repeat(50)}</head><body><div id="content">Videos</div></body></html>`;
}

(async () => {
  assert.equal(CFG.browserEnabled, false, "this test must run with the Chromium engine disabled");
  assert.equal(CFG.youtubeFastProxyOnly, false, "this test must reach the capability probe, not the early FAST_PROXY return");

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const capability = async (url) => {
    const r = await fetch(`${base}/api/browser/capability`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": "https://homekidchud.github.io" },
      body: JSON.stringify({ url }),
    });
    assert.equal(r.status, 200, `capability probe must answer 200 for ${url}`);
    return r.json();
  };

  // Success path: a mocked heavy YouTube-home HTML document via the injection point.
  app.locals.veyraProxyFetchBuffer = async () => ({
    ok: true, status: 200, contentType: "text/html; charset=utf-8",
    body: Buffer.from(youtubeHomeHtml(), "utf8"),
    finalUrl: "https://www.youtube.com/", cacheControl: "no-store",
  });

  try {
    let parsed = await capability("https://www.youtube.com/");
    // Mode must never be BROWSER_ENGINE regardless of lean flag, since the engine is disabled.
    assert.equal(parsed.mode, "ACCELERATED_PROXY", "YouTube home must not request BROWSER_ENGINE when Chromium is disabled");
    assert.equal(parsed.forceBrowser, false, "forceBrowser must be false when the browser engine is disabled");

    // Failure path: the upstream probe throws (capability_probe_failed).
    app.locals.veyraProxyFetchBuffer = async () => { throw new Error("upstream unreachable"); };
    parsed = await capability("https://www.youtube.com/");
    assert.equal(parsed.reason, "capability_probe_failed");
    assert.equal(parsed.mode, "ACCELERATED_PROXY", "the catch path must not fall back to BROWSER_ENGINE when Chromium is disabled");
    assert.equal(parsed.forceBrowser, false, "the catch path must gate forceBrowser on browser availability");

    // Video URL preserves the official-embed behavior.
    app.locals.veyraProxyFetchBuffer = null;
    parsed = await capability("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    assert.equal(parsed.mode, "OFFICIAL_EMBED", "watch URLs must keep the official embed path");
    assert.equal(parsed.youtube?.videoId, "dQw4w9WgXcQ");
    assert.ok(parsed.youtube?.embedUrl?.startsWith("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"));
  } finally {
    app.locals.veyraProxyFetchBuffer = null;
    await new Promise(resolve => server.close(resolve));
  }
  console.log("Capability-route disabled-browser-engine regression tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
