"use strict";
// Regression tests for the fast-proxy hardening that made YouTube fully load
// inside the app iframe:
//
//   1. Upstream response headers bigger than undici's default 16KB cap used to
//      kill the document fetch with a generic "fetch failed" (YouTube serves
//      Chrome 156 user agents a ~19KB Set-Cookie/permissions-policy block).
//      Every production dispatcher now spreads the shared header cap.
//
//   2. Orphaned subresources: pages inside the app's sandboxed third-party
//      iframe request assets with an origin-only Referer and no cookies
//      (third-party cookie blocking), so no session context can be recovered
//      and the asset 404'd. The escaped-path middleware now remembers the last
//      page each client resolved and resolves these orphans against it as a
//      guest fetch (empty sid — fresh guest session, no session cookies).
//
//   3. The brand landing page used to meta-refresh inside a proxied frame,
//      hijacking the iframe to the production app (which Chrome blocks) and
//      feeding the escape loop. Frames now stay on the landing page.
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { fetch: undiciFetch, Agent } = require("undici");

(async () => {
  // --- 1. shared upstream response-header cap --------------------------------
  const { app, sessionManager, noteClientResolvedPage, orphanedPageContext, UPSTREAM_MAX_HEADER_BYTES } = require("../src/server");
  assert.ok(UPSTREAM_MAX_HEADER_BYTES > 16 * 1024, "the upstream header cap must beat undici's 16KB default");

  // A local upstream serving a response with ~40KB of headers. With undici's
  // default cap the fetch dies with "fetch failed"; with the production cap
  // (the exact options every Veyra dispatcher spreads) it succeeds.
  const bigHeaderServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "x-veyra-big": "a".repeat(40 * 1024) });
    res.end("big headers body");
  });
  await new Promise(resolve => bigHeaderServer.listen(0, "127.0.0.1", resolve));
  const bigUrl = `http://127.0.0.1:${bigHeaderServer.address().port}/`;

  // Default dispatcher: documents the original failure mode.
  await assert.rejects(
    undiciFetch(bigUrl, { dispatcher: new Agent() }),
    /fetch failed|Headers/i,
    "a default undici Agent must still refuse oversized response headers"
  );
  // The production cap: same server, same headers, now loads.
  const capped = await undiciFetch(bigUrl, { dispatcher: new Agent({ maxHeaderSize: UPSTREAM_MAX_HEADER_BYTES }) });
  assert.equal(capped.status, 200, "the shared header cap lets big-header responses through");
  assert.equal(await capped.text(), "big headers body");
  bigHeaderServer.close();

  // Every production dispatcher must spread the shared cap: source-level pin
  // (the socket-level SSRF guard makes a live 127.0.0.1 roundtrip through
  // the real agents impossible by design).
  const root = path.resolve(__dirname, "..");
  for (const [file, marker] of [
    ["src/server.js", "DIRECT_HTTP_AGENT"],
    ["src/network/vpn.js", "dispatcherForSession"],
    ["src/services/acquisition-manager.js", "this.dispatcher"]
  ]) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    assert.ok(/upstreamHeaderCapOptions/.test(src), `${file} must spread upstreamHeaderCapOptions()`);
    assert.ok(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(src), `${file} pins the dispatcher (${marker})`);
  }

  // --- 2. orphaned subresource fallback ---------------------------------------
  const fakeReq = ({ ip = "203.0.113.10", query = {} } = {}) => ({ ip, query, get: () => null });
  noteClientResolvedPage(fakeReq({ ip: "203.0.113.10" }), "https://www.youtube.com/watch?v=x");
  assert.deepEqual(orphanedPageContext(fakeReq({ ip: "203.0.113.10" })), { pageUrl: "https://www.youtube.com/watch?v=x", sid: "" }, "the client's last resolved page becomes the orphan resolution base with a guest sid");
  assert.equal(orphanedPageContext(fakeReq({ ip: "198.51.100.9" })), null, "other clients see no context");
  assert.equal(orphanedPageContext(fakeReq({ ip: "" })), null, "no client key means no context");
  noteClientResolvedPage(fakeReq({ ip: "203.0.113.10" }), ""); // empty page is ignored
  assert.deepEqual(orphanedPageContext(fakeReq({ ip: "203.0.113.10" })), { pageUrl: "https://www.youtube.com/watch?v=x", sid: "" }, "an empty page note is ignored");

  // Live HTTP behavior through the real express app. A private destination
  // makes the proxy fail deterministically with the SSRF guard's message —
  // proving the orphaned request reached the proxy machinery instead of the
  // brand 404.
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const made = sessionManager.create("orphanfallofft" + Date.now().toString(16).padStart(8, "0")).id;
    assert.ok(made, "test session created");

    // a) A resolvable escaped navigation from this client: the exact
    //    __veyra_url/__veyra_sid pair resolves (the proxy attempt then fails
    //    on the private URL — expected), and the page is remembered.
    let r = await fetch(`${base}/games?__veyra_url=${encodeURIComponent("http://127.0.0.1:9/")}&__veyra_sid=${made}`, { headers: { "sec-fetch-dest": "document", accept: "text/html" } });
    let body = await r.text();
    assert.match(body, /Private\/local destinations are blocked/, "the seeded navigation resolved and reached the proxy");

    // b) An orphaned asset request — origin-only-referer shape: no referer, no
    //    cookies, no sid anywhere. Previously the brand 404; now resolved
    //    against the remembered page (guest fetch) and proxied.
    r = await fetch(`${base}/chunk.js`, { headers: { "sec-fetch-dest": "script" } });
    body = await r.text();
    assert.match(body, /Private\/local destinations are blocked/, "the orphaned asset reached the proxy via the remembered page");
    assert.ok(!/Nothing here/.test(body), "the orphaned asset no longer falls to the brand 404");

    // c) Per-client isolation: a different client IP (via X-Forwarded-For;
    //    the app trusts the proxy header) must not resolve the orphan.
    r = await fetch(`${base}/chunk.js`, { headers: { "sec-fetch-dest": "script", "x-forwarded-for": "198.51.100.77" } });
    body = await r.text();
    assert.ok(/Nothing here/.test(body), "a different client's orphaned request still falls through");

    // d) The orphaned fallback must not swallow top-level documents.
    r = await fetch(`${base}/games`, { headers: { "sec-fetch-dest": "document", accept: "text/html", "x-forwarded-for": "203.0.113.10" } });
    body = await r.text();
    assert.ok(!/Private\/local destinations are blocked/.test(body), "top-level documents do not use the orphan fallback");

    // A nested escaped frame keeps its own host in its referer. Its script
    // requests must not resolve against the outer page's veyra_ctx cookie.
    const frameUrl = "http://127.0.0.1:9/game";
    const frameRef = `${base}/game?__veyra_url=${encodeURIComponent(frameUrl)}&__veyra_sid=${made}`;
    r = await fetch(`${base}/assets/nested-module.js`, { headers: {
      "sec-fetch-dest": "script", referer: frameRef,
      cookie: `veyra_ctx=${encodeURIComponent("https://example.invalid/outer")}|${made}`,
    } });
    assert.match(await r.text(), /Private\/local destinations are blocked/, "the nested frame's host wins over the parent cookie");
  } finally {
    server.close();
  }

  // --- 3. brand landing page: no meta-refresh inside frames -------------------
  const server2 = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => { server2.once("listening", resolve); server2.once("error", reject); });
    const base2 = `http://127.0.0.1:${server2.address().port}`;
    const asFrame = await fetch(`${base2}/`, { headers: { "sec-fetch-dest": "iframe" } });
    const frameBody = await asFrame.text();
    assert.equal(asFrame.status, 200, "the frame request still gets the landing page");
    assert.ok(!/http-equiv="refresh"/.test(frameBody), "a frame must not receive the meta-refresh");
    const asTop = await fetch(`${base2}/`);
    const topBody = await asTop.text();
    assert.ok(/http-equiv="refresh"/.test(topBody), "a top-level visit still meta-refreshes to the app");
    const stayed = await fetch(`${base2}/?stay`);
    assert.ok(!/http-equiv="refresh"/.test(await stayed.text()), "?stay still suppresses the refresh");
  } finally {
    server2.close();
  }

  // --- 4. embedded frame reload of the escaped root ---------------------------
  // YouTube's desktop build reloads the escaped root with ?themeRefresh=1,
  // losing every routing param. The runtime's veyra_ctx cookie still names
  // the page + session: an embedded (iframe-dest) reload of a reserved path
  // must re-resolve the real page through the escaped middleware instead of
  // swapping the brand landing in mid-browse.
  const server3 = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => { server3.once("listening", resolve); server3.once("error", reject); });
    const base3 = `http://127.0.0.1:${server3.address().port}`;
    const sid = sessionManager.create("framereloadt" + Date.now().toString(16).padStart(8, "0")).id;
    const ctxCookie = `veyra_ctx=${encodeURIComponent("http://127.0.0.1:9/")}|${encodeURIComponent(sid)}`;

    // a) iframe reload WITH a live-session cookie: the landing route passes
    //    through and the escaped middleware re-resolves the cookie's page
    //    (the private URL then fails the SSRF guard — proving the proxy
    //    machinery handled it, not the landing).
    let r = await fetch(`${base3}/?themeRefresh=1`, { headers: { "sec-fetch-dest": "iframe", cookie: ctxCookie } });
    let body = await r.text();
    assert.match(body, /Private\/local destinations are blocked/, "an embedded frame reload re-resolves the cookie's page instead of showing the landing");

    // b) iframe reload with a cookie naming a DEAD session: the pass-through
    //    happens (cookie present) but recovery fails, so the frame gets the
    //    brand 404 — never the meta-refresh hijack.
    const deadCookie = `veyra_ctx=${encodeURIComponent("http://127.0.0.1:9/")}|deadSession00000000`;
    r = await fetch(`${base3}/?themeRefresh=1`, { headers: { "sec-fetch-dest": "iframe", cookie: deadCookie } });
    body = await r.text();
    assert.ok(!/http-equiv="refresh"/.test(body), "a dead-session frame reload never meta-refreshes");
    assert.ok(!/Veyra server is online/.test(body), "a dead-session frame reload does not get the landing");

    // c) iframe reload with NO cookie: the landing still shows (no hijack).
    r = await fetch(`${base3}/?themeRefresh=1`, { headers: { "sec-fetch-dest": "iframe" } });
    body = await r.text();
    assert.ok(/Veyra server is online/.test(body), "a cookie-less frame reload still gets the landing");

    // d) A top-level visit with the cookie must NOT be diverted: the landing
    //    is for humans typing the origin, cookie or not.
    r = await fetch(`${base3}/?themeRefresh=1`, { headers: { "sec-fetch-dest": "document", accept: "text/html", cookie: ctxCookie } });
    body = await r.text();
    assert.ok(/Veyra server is online/.test(body), "a top-level visit with a veyra_ctx cookie still gets the landing");
  } finally {
    server3.close();
  }

  console.log("fast-proxy-hardening.test.js — all assertions passed");
})().catch(err => { console.error(err); process.exit(1); });
