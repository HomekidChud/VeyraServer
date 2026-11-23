"use strict";
// Regression: escaped-path serving for site ROOTS.
//
// Roblox's SDUI landing app picks its page config by matching
// location.pathname against its routes ("/" included) and renders nothing
// when nothing matches. Root pages used to stay on /api/view, so
// location.pathname was "/api/view" and the landing app booted into an
// empty container. Roots must escape to "/?__veyra_url=…&__veyra_sid=…"
// like every other path-based navigation, and the brand root route (which
// serves the Veyra landing page at "/") must pass those through instead of
// swallowing them.
const assert = require("node:assert/strict");

(async () => {
  const { app, sessionManager, escapedPathFor } = require("../src/server");

  // --- escapedPathFor: roots are escapable, origin routes are not --------
  assert.ok(escapedPathFor("https://www.roblox.com/"), "site roots are escapable");
  assert.equal(new URL(escapedPathFor("https://www.roblox.com/")).pathname, "/", "the escaped form of a root keeps pathname /");
  assert.ok(escapedPathFor("https://www.roblox.com/?a=1"), "roots with search are escapable");
  assert.equal(escapedPathFor("https://www.roblox.com/api/x"), null, "/api/* site paths never escape");
  assert.equal(escapedPathFor("https://www.roblox.com/favicon.ico"), null, "static assets never escape");
  assert.equal(escapedPathFor("https://www.roblox.com/manifest.json"), null, "reserved origin paths never escape");
  assert.ok(escapedPathFor("https://www.roblox.com/games"), "regular site paths keep escaping");

  // --- HTTP behavior -------------------------------------------------------
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const made = sessionManager.create("escapedroottest" + Date.now().toString(16).padStart(8, "0")).id;
    assert.ok(made, "test session created");
    const docHeaders = { "sec-fetch-dest": "document", accept: "text/html" };

    // 1. A document navigation to a site ROOT must escape to "/?…". The
    //    redirect fires before any upstream fetch, so a public URL keeps
    //    this test network-free.
    let r = await fetch(`${base}/api/view?url=${encodeURIComponent("https://www.roblox.com/")}&sid=${made}`, { headers: docHeaders, redirect: "manual" });
    assert.equal(r.status, 302, "root document navigation must redirect to the escaped form");
    const loc = String(r.headers.get("location") || "");
    const locUrl = new URL(loc, base);
    assert.equal(locUrl.pathname, "/", "the escaped form of a site root lives at pathname /");
    assert.equal(locUrl.searchParams.get("__veyra_url"), "https://www.roblox.com/", "the exact target travels in __veyra_url");
    assert.equal(locUrl.searchParams.get("__veyra_sid"), made, "the live session travels in __veyra_sid");

    // 2. The brand root route must pass escaped-root requests through to
    //    the escaped-path middleware instead of serving the landing page.
    //    A private destination makes the proxy fail deterministically with
    //    the SSRF guard's message — proving the request went through the
    //    escape machinery (resolution + proxy attempt), not the brand page.
    r = await fetch(`${base}/?__veyra_url=${encodeURIComponent("http://127.0.0.1:9/")}&__veyra_sid=${made}`, { headers: docHeaders });
    const body = await r.text();
    assert.notEqual(r.status, 200, "escaped-root requests must not serve the brand landing page");
    assert.ok(!/Veyra Browser<\/title>/.test(body), "the brand landing page must not swallow escaped roots");
    assert.match(body, /Private\/local destinations are blocked/, "the escaped root reached the proxy (SSRF guard fired)");

    // 3. The plain origin root still serves the Veyra landing page.
    r = await fetch(`${base}/`);
    assert.equal(r.status, 200, "plain root still responds");
    assert.match(await r.text(), /Veyra Browser<\/title>/, "plain root still serves the brand landing page");

    // 4. Non-root paths keep escaping exactly as before.
    r = await fetch(`${base}/api/view?url=${encodeURIComponent("https://www.roblox.com/games")}&sid=${made}`, { headers: docHeaders, redirect: "manual" });
    assert.equal(r.status, 302, "non-root document navigation still redirects");
    assert.equal(new URL(String(r.headers.get("location")), base).pathname, "/games", "non-root escaped path keeps the site path");
  } finally {
    server.close();
  }

  console.log("escaped-root.test.js — all assertions passed");
})().catch(err => { console.error(err); process.exit(1); });
