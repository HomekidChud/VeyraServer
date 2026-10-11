"use strict";
/**
 * 8.20.0 regression — YouTube CDN bundles must never 302 out of the fast proxy.
 *
 * This is a BEHAVIORAL test: it starts the real express app with
 * YT_DIRECT_STATIC_ASSETS=true (the old, broken config) and drives
 * /api/resource with a Veyra-origin Referer. The route must NOT emit the
 * cross-origin 302 — it must serve the upstream body inline — because in the
 * fast-proxy iframe that redirect is refused by the browser, leaving scripts
 * at HTTP 0 and the page stuck on YouTube's skeleton.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Same local/side-effect-free setup as the other route tests.
for (const name of ["AI_API_KEY", "AI_API_BASE_URL", "OPENAI_API_KEY", "BRAVE_SEARCH_API_KEY", "BING_SEARCH_API_KEY", "GOOGLE_SEARCH_API_KEY", "MONGODB_URI"]) delete process.env[name];
process.env.VEYRA_CHROMIUM_ENABLED = "false";
// Explicitly turn ON the old optimization to prove the Referer guard wins.
process.env.YT_DIRECT_STATIC_ASSETS = "true";

const { app, mongoStore, CFG } = require("../src/server");

(async () => {
  assert.equal(CFG.youtubeDirectStaticAssets, true, "the flag should be force-enabled for this test to exercise the guard");
  mongoStore.enabled = false;
  mongoStore.uri = "";

  // Mock the upstream fetch (no real YouTube traffic) — return a small
  // fake JS bundle body that matches what YouTube's CDN serves.
  const upstreamCalls = [];
  app.locals.veyraProxyFetchBuffer = async (url, opts) => {
    upstreamCalls.push({ url, method: String(opts.method || "GET").toUpperCase() });
    return {
      ok: true,
      status: 200,
      contentType: "text/javascript; charset=UTF-8",
      body: Buffer.from("// youtube fake bundle\nconsole.log('ytd-upgrade')\n"),
      finalUrl: url,
      cacheControl: "public, max-age=300",
      contentLength: "38",
      redirectChain: [],
      truncated: false,
      tooLarge: false,
      setCookieHeader: null,
      etag: null,
      lastModified: null,
    };
  };

  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const base = `http://127.0.0.1:${server.address().port}`;

    // 1. YouTube static bundle with a VEYRA-origin Referer (fast-proxy iframe case)
    const resourceUrl = `${base}/api/resource?url=${encodeURIComponent("https://www.youtube.com/s/desktop/0a4db377/jsbin/webcomponents-sd.vflset/webcomponents-sd.js")}&from=${encodeURIComponent("https://www.youtube.com/")}&sid=regression-sid`;
    const r1 = await fetch(resourceUrl, { redirect: "manual", headers: { "Referer": `${base}/api/view?url=https%3A%2F%2Fwww.youtube.com` } });
    const t1 = await r1.text();
    assert.equal(r1.status, 200, `YouTube static bundle must be served inline (HTTP 200), got ${r1.status}`);
    assert.ok(!r1.headers.get("location"), "no cross-origin Location header should be set");
    assert.ok(!/x-veyra-direct-asset/i.test(Array.from(r1.headers.keys()).join(",")), "no x-veyra-direct-asset header should be emitted");
    assert.ok(/youtube fake bundle/.test(t1), "the upstream JS body should be served to the caller");
    assert.equal(upstreamCalls.length, 1, "the upstream fetch should have been used exactly once");
    assert.ok(/webcomponents-sd\.js/.test(upstreamCalls[0].url), "the upstream fetch should target the real bundle URL");

    // 2. A second request for the same bundle with a YOUTUBE-ORIGIN Referer
    //    (native-tab case) IS permitted to 302 when the Referer origin matches
    //    the target — that is the safe same-origin case the guard allows.
    const r2 = await fetch(resourceUrl, { redirect: "manual", headers: { "Referer": "https://www.youtube.com/" } });
    if (CFG.youtubeDirectStaticAssets) {
      assert.equal(r2.status, 302, "the same-origin Referer case is permitted to emit the direct-asset 302 when the flag is on");
      assert.ok(r2.headers.get("location")?.includes("youtube.com"), "the 302 Location should point at YouTube");
    } else {
      assert.equal(r2.status, 200, "with the flag off, the same-origin Referer case should serve inline");
    }

    // 3. The code default must remain off so iframe-based fast-proxy loads always get the body.
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
    assert.match(
      source,
      /youtubeDirectStaticAssets:\s*boolEnv\("YT_DIRECT_STATIC_ASSETS",\s*false\)/,
      "YT_DIRECT_STATIC_ASSETS default must be false in code so iframe loads get the bundle inline."
    );
    assert.ok(
      !/if \([^)]*CFG\.youtubeDirectStaticAssets[^)]*\)\s*\{\s*[^}]*x-veyra-direct-asset[^}]*302/s.test(source),
      "no 302 branch may be gated ONLY by CFG.youtubeDirectStaticAssets — every direct-asset 302 must also pass the same-origin Referer guard."
    );

    // 4. render.yaml must ship the same default for the deployed Render instance.
    const render = fs.readFileSync(path.join(__dirname, "..", "render.yaml"), "utf8");
    assert.match(
      render,
      /YT_DIRECT_STATIC_ASSETS\s*\n\s*value:\s*"false"/,
      "render.yaml must set YT_DIRECT_STATIC_ASSETS=false so the deployed fast proxy serves YouTube bundles inline."
    );

    console.log("VeyraServer YouTube direct-asset behavioral checks passed");
  } finally {
    server.close();
  }
})().catch(e => { console.error(String(e.stack || e.message).slice(0, 600)); process.exit(1); });
