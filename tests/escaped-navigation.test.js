"use strict";
// Regression: escaped (path-based) proxy navigations.
//
// Sites whose SPA keeps the real site path (MSN Casual Games etc.) navigate
// the iframe to URLs like
//   /en-us/play/games/polytrack/cg-9n02lr0qrbm2?url=<prev page>&sid=<sid>&cgfrom=…
// Once the page itself lives at a path-based URL, the Referer of the next
// navigation is a path URL — not /api/view — so the relative-path fallback
// middleware could not recover the session and every in-page navigation
// (button clicks, reloads) fell through to a 404. These tests pin the
// recovery logic: session from the query/referer/cookie, resolution base
// from the page the referer renders, and Veyra's own routing params
// stripped from the real target URL.
const assert = require("node:assert/strict");

(async () => {
  const { liveSessionId, escapedPageContext, resolveEscapedTarget, sessionManager } = require("../src/server");

  // --- liveSessionId -------------------------------------------------------
  assert.equal(liveSessionId("not-a-sid"), "", "malformed sids are rejected");
  assert.equal(liveSessionId(""), "", "empty sids are rejected");
  const sid = sessionManager.create("escapednavtest" + Date.now().toString(16).padStart(8, "0")).sid || "escapednavtest1234567890";
  // sessionManager.create stores by the sid argument; recover what we passed.
  const made = [...sessionManager.sessions.keys()].find(k => k.startsWith("escapednavtest"));
  assert.ok(made, "test session created");
  assert.equal(liveSessionId(made), made, "a live session id is accepted");
  assert.equal(liveSessionId("deadbeefdeadbeefdeadbeef"), "", "unknown sids are rejected");

  // --- resolveEscapedTarget ------------------------------------------------
  const page = "https://www.msn.com/en-us/play";
  const target = resolveEscapedTarget(`/en-us/play/games/polytrack/cg-9n02lr0qrbm2?url=${encodeURIComponent(page)}&sid=${made}&cgfrom=cg_landing_home_staffpicks`, page);
  assert.ok(target, "escaped path resolves onto the site");
  const t = new URL(target);
  assert.equal(t.origin + t.pathname, "https://www.msn.com/en-us/play/games/polytrack/cg-9n02lr0qrbm2", "path resolves onto the site");
  assert.equal(t.searchParams.get("url"), page, "the site's own url param survives");
  assert.equal(t.searchParams.get("cgfrom"), "cg_landing_home_staffpicks", "the site's own cgfrom param survives");
  assert.ok(!t.searchParams.has("sid"), "Veyra's sid is stripped from the real target");
  // A sid that is NOT a live Veyra session belongs to the site and must stay.
  const siteSid = resolveEscapedTarget("/order?sid=abcdefgh12345678", "https://shop.example/cart");
  assert.equal(siteSid, "https://shop.example/order?sid=abcdefgh12345678", "site-owned sid params are preserved");
  assert.equal(resolveEscapedTarget("/games/x", null), null, "no resolution base means no target");

  // --- escapedPageContext ---------------------------------------------------
  const fakeReq = ({ query = {}, headers = {} } = {}) => ({
    query,
    // Express's req.get is case-insensitive; emulate that.
    get: name => ({ referer: headers.referer, cookie: headers.cookie, host: headers.host, "x-forwarded-proto": headers.proto })[String(name).toLowerCase()],
  });
  // 1. The sid + previous page travel inside the navigation URL itself
  //    (the case the MSN play page produces when it builds game links).
  let ctx = escapedPageContext(fakeReq({ query: { url: page, sid: made }, headers: { host: "veyra.example" } }));
  assert.deepEqual(ctx, { pageUrl: page, sid: made }, "context recovered from the request's own url+sid params");

  // 2. A path-based same-origin referer: its ?url= renders the page the
  //    navigation came from, and its ?sid= is the session.
  ctx = escapedPageContext(fakeReq({
    query: { sid: made },
    headers: { host: "veyra.example", referer: `https://veyra.example/en-us/play/games/polytrack/cg-9n02lr0qrbm2?url=${encodeURIComponent(page)}&sid=${made}&cgfrom=x` },
  }));
  assert.deepEqual(ctx, { pageUrl: page, sid: made }, "context recovered from a path-based referer");

  // 3. The veyra_ctx cookie carries the last virtual page.
  ctx = escapedPageContext(fakeReq({
    query: { sid: made },
    headers: { host: "veyra.example", cookie: `veyra_ctx=${encodeURIComponent(page)}|${made}` },
  }));
  assert.deepEqual(ctx, { pageUrl: page, sid: made }, "context recovered from the veyra_ctx cookie");

  // 4. No session anywhere → no context (the request must fall through, not
  //    proxy with a fabricated session).
  assert.equal(escapedPageContext(fakeReq({ query: { url: page }, headers: { host: "veyra.example" } })), null, "no live session means no context");
  assert.equal(escapedPageContext(fakeReq({ headers: { host: "veyra.example" } })), null, "nothing to recover means no context");

  console.log("escaped-navigation.test.js — all assertions passed");
})().catch(err => { console.error(err); process.exit(1); });
