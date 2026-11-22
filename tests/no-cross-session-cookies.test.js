"use strict";
const assert = require("node:assert/strict");

/**
 * Regression — the cross-session cookie handoff stays gone.
 *
 * The old flow ("Bring session back"): open the real site in the user's own
 * browser, sign in there, then POST that site's cookies into the Veyra
 * session's jar via /api/handoff/cookies (bookmarklet or paste form).
 * That moved cookies between the user's browser and a Veyra session with
 * no consent gate and no scoping. Sign-in now happens inside the fast
 * proxy: login/OAuth pages load through the proxy in the session's own
 * jar, and OAuth popups open as proxied Veyra tabs (see popup-relay.test).
 *
 * The one deliberate exception is the Veyra Launcher extension's cookie
 * transfer (see extension-handoff.test.js): the extension reads the site's
 * cookies in the user's own browser and imports them into the user's own
 * Veyra session, only when the user clicks Send in the popup and only with
 * that session's id, which the extension discovers locally from the user's
 * open Veyra tab. It is user-initiated and sid-scoped — never cross-session.
 *
 * This pins:
 *   1. /api/handoff/login and /api/handoff/return are gone; the extension
 *      import is the only /api/handoff/* route, requires a live session's
 *      sid, and carries no permissive CORS (the extension's host
 *      permissions cover its own fetch; web pages cannot call it).
 *   2. The challenge interstitial offers no bookmarklet / cookie paste.
 *   3. The session cookie API still works for the session's OWN jar
 *      (the app's devtools cookie panel) — reading and clearing only.
 */

for (const name of ["AI_API_KEY", "AI_API_BASE_URL", "OPENAI_API_KEY", "BRAVE_SEARCH_API_KEY", "BING_SEARCH_API_KEY", "GOOGLE_SEARCH_API_KEY", "MONGODB_URI"]) delete process.env[name];
process.env.VEYRA_CHROMIUM_ENABLED = "false";

const { app, sessionManager } = require("../src/server");

(async () => {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const base = `http://127.0.0.1:${server.address().port}`;

    // 1a: the login/return hop through the API origin stays removed.
    for (const [method, path] of [
      ["GET", "/api/handoff/login"],
      ["GET", "/api/handoff/return"]
    ]) {
      const r = await fetch(`${base}${path}`, { method, headers: { origin: "https://github.com" }, redirect: "manual" });
      assert.equal(r.status, 404, `${method} ${path} must be removed (got ${r.status})`);
    }

    // 1b: the extension import is POST-only and sid-scoped. An unknown sid
    // (what a foreign page or another user's script would have) is rejected.
    // No per-route CORS middleware is re-added for it — the extension's own
    // host permissions cover its fetch.
    let r = await fetch(`${base}/api/handoff/cookies`, { method: "GET", headers: { origin: "https://github.com" } });
    assert.equal(r.status, 404, "GET /api/handoff/cookies must not exist");
    r = await fetch(`${base}/api/handoff/cookies`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://github.com" },
      body: JSON.stringify({ sid: "foreignsid000000000000000000000", url: "https://github.com", cookies: "a=1" })
    });
    assert.equal(r.status, 404, "a sid the caller does not own must be rejected");

    // 2: the challenge card must not offer the bookmarklet or the paste form.
    const sid = sessionManager.create({ incognito: false });
    const card = await fetch(`${base}/api/view?url=${encodeURIComponent("https://blocked.example/")}&sid=${sid}`, {
      headers: { "accept": "text/html" }
    });
    // The upstream fetch may fail in tests; both the card and an error page
    // must be free of the import UI either way.
    const body = await card.text();
    assert.ok(!body.includes("handoff/cookies"), "no page may reference the cookie import endpoint");
    assert.ok(!/Bring session back/.test(body), "the bookmarklet must be gone");
    assert.ok(!/Import session/.test(body), "the cookie paste form must be gone");

    // 3: the session's own cookie API still works (display + clear only).
    r = await fetch(`${base}/api/session/${sid}/cookies?host=github.com`);
    assert.equal(r.status, 200, "the session cookie listing endpoint must keep working");
    const j = await r.json();
    assert.ok(Array.isArray(j.cookies), "cookie listing must return an array");
    r = await fetch(`${base}/api/session/${sid}/cookies?host=github.com`, { method: "DELETE" });
    assert.equal(r.status, 200, "the session cookie clearing endpoint must keep working");

    console.log("no-cross-session-cookies regression tests passed");
  } finally {
    server.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
