"use strict";
const assert = require("node:assert/strict");

/**
 * Regression — the "Bring session back" bookmarklet runs on arbitrary real
 * sites (github.com, chess.com, poxel.io, …) and posts that site's readable
 * cookies to /api/handoff/cookies. In production FRONTEND_ORIGIN is a single
 * allowlisted origin (the GitHub Pages app), so those requests are
 * cross-origin from a foreign origin. Without a permissive CORS policy on
 * this one endpoint the browser blocks the bookmarklet's fetch and the
 * return trip of the direct-login handoff silently never works — the user
 * signs in on the real site, comes back to Veyra, and nothing happens.
 *
 * This pins: the handoff cookie endpoint answers foreign origins (preflight
 * and actual POST) while every other endpoint keeps the global allowlist.
 */

for (const name of ["AI_API_KEY", "AI_API_BASE_URL", "OPENAI_API_KEY", "BRAVE_SEARCH_API_KEY", "BING_SEARCH_API_KEY", "GOOGLE_SEARCH_API_KEY", "MONGODB_URI"]) delete process.env[name];
process.env.VEYRA_CHROMIUM_ENABLED = "false";
// Production-like allowlist: only the GitHub Pages app is trusted.
process.env.FRONTEND_ORIGIN = "https://homekidchud.github.io";

const { app } = require("../src/server");

(async () => {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const appOrigin = "https://homekidchud.github.io";
    const foreignOrigin = "https://github.com";

    // Preflight from a foreign origin (exactly what the bookmarklet's
    // content-type: application/json POST triggers) must be allowed.
    let r = await fetch(`${base}/api/handoff/cookies`, {
      method: "OPTIONS",
      headers: { Origin: foreignOrigin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" }
    });
    assert.equal(r.status, 204, "the handoff cookie preflight must succeed");
    assert.equal(r.headers.get("access-control-allow-origin"), foreignOrigin,
      "the handoff cookie preflight must allow the foreign origin the bookmarklet runs on");
    assert.match(String(r.headers.get("access-control-allow-headers") || ""), /content-type/i,
      "the preflight must allow the bookmarklet's JSON content-type header");

    // The actual POST from a foreign origin must carry CORS headers too —
    // even a rejected body (unknown sid) must answer cross-origin, or the
    // browser hides the real error behind "Failed to fetch".
    r = await fetch(`${base}/api/handoff/cookies`, {
      method: "POST",
      headers: { Origin: foreignOrigin, "content-type": "application/json" },
      body: JSON.stringify({ sid: "cors-rejected-sid-0000000000000", url: "https://github.com/", cookies: "a=1" })
    });
    assert.equal(r.headers.get("access-control-allow-origin"), foreignOrigin,
      "the handoff cookie POST must answer the foreign origin (the sid is the only credential)");

    // The app's own origin keeps working through the global policy.
    r = await fetch(`${base}/api/health`, { headers: { Origin: appOrigin } });
    assert.equal(r.headers.get("access-control-allow-origin"), appOrigin,
      "the app origin must keep its global CORS allowlist");

    // Foreign origins on every OTHER endpoint must stay blocked — the
    // permissive policy is scoped to the handoff cookie endpoint only.
    r = await fetch(`${base}/api/health`, { headers: { Origin: foreignOrigin } });
    assert.notEqual(r.headers.get("access-control-allow-origin"), foreignOrigin,
      "other endpoints must not gain the foreign origin (global allowlist must stay intact)");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log("Handoff bookmarklet CORS regression tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
