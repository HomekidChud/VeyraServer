"use strict";
/**
 * 8.20.0 regression — YouTube CDN bundles must never 302 out of the fast proxy.
 *
 * The old `youtubeDirectStaticAssets` optimization sent a Location header for
 * `youtube.com/s/...` and `youtube.com/player/...` assets. In the fast-proxy
 * iframe those cross-origin redirects are blocked by the browser, leaving
 * scripts at HTTP status 0 and the page stuck on its skeleton forever
 * (custom elements never upgrade). The default is now off, and even when
 * explicitly enabled, the Referer must match YouTube's own origin.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");

// The default must be off so iframe-based fast-proxy loads always get the body.
assert.match(
  source,
  /youtubeDirectStaticAssets:\s*boolEnv\("YT_DIRECT_STATIC_ASSETS",\s*false\)/,
  "YT_DIRECT_STATIC_ASSETS default must be false — redirecting the iframe to YouTube's CDN leaves scripts at HTTP 0."
);

// Every early 302 site-direct path must be Referer-guarded so the fast-proxy
// iframe cannot be bounced to a cross-origin URL. Locate each `x-veyra-direct-asset`
// header write and inspect the surrounding lines for the guard.
const lines = source.split("\n");
const directAssetLineIdx = lines
  .map((line, i) => (line.includes('"x-veyra-direct-asset"') ? i : -1))
  .filter(i => i !== -1);
assert.ok(directAssetLineIdx.length > 0, "expected at least one x-veyra-direct-asset header write to exist");
for (const i of directAssetLineIdx) {
  const window = lines.slice(Math.max(0, i - 12), i + 3).join("\n");
  assert.ok(
    /status\(302\)\.end\(\)/.test(window),
    "the x-veyra-direct-asset header write at line " + i + " must be paired with a 302 redirect."
  );
  assert.ok(
    /refererOrigin\s*===\s*new URL\(canonical\)\.origin/.test(window) || /ytDirectRefererOk/.test(window),
    "the YouTube direct-asset 302 near line " + i + " must be guarded by a same-origin Referer check so iframe loads get the bundle inline."
  );
}

// render.yaml must ship the same default for the deployed Render instance.
const render = fs.readFileSync(path.join(__dirname, "..", "render.yaml"), "utf8");
assert.match(
  render,
  /YT_DIRECT_STATIC_ASSETS\s*\n\s*value:\s*"false"/,
  "render.yaml must set YT_DIRECT_STATIC_ASSETS=false so the deployed fast proxy serves YouTube bundles inline."
);

console.log("VeyraServer YouTube direct-asset guard checks passed");
