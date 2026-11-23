"use strict";
const assert = require("node:assert/strict");

// Verifies the security-check carry-forward wiring:
//   1. Chromium clearance cookies + the exact Chromium user-agent import into
//      the fast-proxy session's cookie jar.
//   2. The proxy looks up the pinned UA per host (subdomains included).
//   3. browser-engine flips a parked VERIFICATION_REQUIRED session back to
//      NORMAL on its next poll and exports cookies + UA through
//      onStorageState, so the tab can return to the fast proxy.

(async () => {
  process.env.VEYRA_CHROMIUM_ENABLED = "true";
  const { BrowserEngine } = require("../src/browser/browser-engine");
  const { SessionManager } = require("../src/core/session-manager");

  const sm = new SessionManager({ log: () => {} });
  const sid = "carryforwardtestsession01";
  sm.touch(sid);

  // 1 + 2: cookie import with the Chromium user-agent.
  sm.importPlaywrightCookies(sid, [
    { name: "cf_clearance", value: "abc123", domain: "protected.example", path: "/", expires: 9999999999, secure: true },
    { name: "sessionid", value: "xyz", domain: ".example.org", path: "/", expires: 9999999999 }
  ], "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");

  assert.equal(sm.chromiumUaFor(sid, "https://protected.example/page"), "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", "exact host should resolve to the Chromium UA");
  assert.equal(sm.chromiumUaFor(sid, "https://www.example.org/search"), "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", "parent-domain cookies should pin the UA for subdomains");
  assert.equal(sm.chromiumUaFor(sid, "https://other.example.net/"), "", "unrelated hosts must not be pinned");
  assert.equal(sm.chromiumUaFor("missing-session", "https://protected.example/"), "", "unknown sessions must not resolve a UA");

  // 3: browser-engine notices the finished check and exports cookies + UA.
  const engine = new BrowserEngine({ browserEnabled: true }, async () => {}, () => {});
  let exported = null;
  engine.setFailoverCallbacks({
    onStorageState: (proxySessionId, state, ua) => { exported = { proxySessionId, cookies: state.cookies, ua }; }
  });
  const fakeSession = {
    id: "bs_test",
    proxySessionId: sid,
    createdAt: Date.now(),
    status: "VERIFICATION_REQUIRED",
    canonicalUrl: "https://protected.example/",
    title: "",
    verification: { url: "https://protected.example/" },
    console: [],
    network: [],
    downloads: [],
    lastUsed: Date.now(),
    tabId: "tab1",
    jobId: "",
    vpnProfileId: null,
    pages: new Set([{}]),
    context: { storageState: async () => ({ cookies: [{ name: "cf_clearance", value: "abc123", domain: "protected.example", path: "/" }] }) },
    page: {
      url: () => "https://protected.example/real-page",
      title: async () => "Protected site",
      evaluate: async () => "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0",
      screenshot: async () => Buffer.from("img")
    }
  };
  engine.sessions.set(fakeSession.id, fakeSession);

  // While the challenge page is still up, the poll must keep the status.
  const realDetect = engine.detectVerification.bind(engine);
  engine.detectVerification = async () => ({ url: "https://protected.example/", title: "Just a moment..." }); // challenge still showing
  const during = await engine.refreshVerification(fakeSession.id);
  assert.equal(during.status, "VERIFICATION_REQUIRED", "an unfinished check must keep the session parked");
  assert.equal(exported, null, "no cookie export while the check is unfinished");

  // The user finishes the check: the page text no longer matches challenge
  // markers, so the poll flips it to NORMAL and syncs cookies + UA.
  engine.detectVerification = async () => null; // challenge cleared
  const after = await engine.refreshVerification(fakeSession.id);
  engine.detectVerification = realDetect;

  assert.equal(after.status, "NORMAL", "a cleared check must flip the session back to NORMAL");
  assert.equal(after.canonicalUrl, "https://protected.example/real-page", "the post-challenge redirect URL must be picked up");
  assert.ok(exported, "clearing the check must export the Chromium storage state");
  assert.equal(exported.proxySessionId, sid, "cookies must export into the linked fast-proxy session");
  assert.equal(exported.ua, "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0", "the exact Chromium user-agent must travel with the cookies");
  assert.ok(exported.cookies.some(c => c.name === "cf_clearance"), "clearance cookies must be exported");

  // The exported state lands in the proxy session jar with the pinned UA.
  sm.importPlaywrightCookies(exported.proxySessionId, exported.cookies, exported.ua);
  assert.equal(sm.chromiumUaFor(sid, "https://protected.example/real-page"), "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0", "the proxy resolves the pinned UA for the verified host");

  console.log("VeyraServer challenge carry-forward checks passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
