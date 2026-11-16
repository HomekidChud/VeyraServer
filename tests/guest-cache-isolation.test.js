"use strict";
// Behavioral regression test: guest sessions must never read or write the
// cross-session shared proxy cache, while signed-in sessions keep sharing
// public static assets. Guards the `isGuestSid` gating inside fetchCached.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

for (const name of ["AI_API_KEY", "AI_API_BASE_URL", "OPENAI_API_KEY", "BRAVE_SEARCH_API_KEY", "BING_SEARCH_API_KEY", "GOOGLE_SEARCH_API_KEY", "MONGODB_URI"]) delete process.env[name];
process.env.VEYRA_TEST_MODE = "1";
process.env.VEYRA_CHROMIUM_ENABLED = "false";
process.env.BROWSER_ENABLED = "0";
process.env.SESSION_CACHE_ENABLED = "0";
process.env.ACCESS_GATE = "0";
process.env.MONGODB_SHARED_CACHE = "1"; // default, but pinned for clarity
process.env.DATA_DIR = (() => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-guest-cache-")); return d; })();

const { app, CFG } = require("../src/server");

const ASSET = "https://example.com/shared-bundle.js";
let upstreamCalls = 0;
let upstreamBody = "";

// Mock upstream: counts calls so the test can prove cache hits and misses.
app.locals.veyraProxyFetchBuffer = async () => {
  upstreamCalls += 1;
  upstreamBody = `/* upstream call #${upstreamCalls} ${crypto.randomUUID()} */`;
  return { ok: true, status: 200, contentType: "text/javascript", body: Buffer.from(upstreamBody), cacheControl: "public, max-age=3600", finalUrl: ASSET, bytes: upstreamBody.length };
};

const server = app.listen(0, "127.0.0.1");
server.on("error", (e) => { console.error("SERVER FAIL", e.message); process.exit(1); });
server.on("listening", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const doFetch = (p, o) => fetch(base + p, o);
  try {
    // Two distinct guest sessions.
    const mkSession = async (headers) => (await doFetch("/api/session", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ url: "https://example.com/" }) })).json();
    const guest1 = await mkSession();
    const guest2 = await mkSession();
    assert.ok(guest1.sessionId && guest2.sessionId && guest1.sessionId !== guest2.sessionId, "session created");
    assert.ok(!guest1.user, "guest session has no user");

    const getAsset = (sid) => `/api/view?url=${encodeURIComponent(ASSET)}&sid=${sid}`;

    // Guest 1 fetch: upstream called (cold).
    let r = await doFetch(getAsset(guest1.sessionId));
    assert.equal(r.status, 200);
    let body1 = await r.text();
    assert.equal(upstreamCalls, 1, "first guest fetch hits upstream");
    assert.ok(body1.includes("upstream call #1"));

    // Same guest session refetch: served from the session's own cache.
    r = await doFetch(getAsset(guest1.sessionId));
    body1 = await r.text();
    assert.equal(upstreamCalls, 1, "same-session refetch is cached per session");
    assert.ok(body1.includes("upstream call #1"));

    // Guest 2 (different session, same asset): must NOT be served guest 1's
    // copy from the shared cache — the fetch is upstream again.
    r = await doFetch(getAsset(guest2.sessionId));
    assert.equal(r.status, 200);
    const body2 = await r.text();
    assert.equal(upstreamCalls, 2, "second guest session does not read the shared cache");
    assert.ok(body2.includes("upstream call #2"), "guest 2 got its own upstream copy");

    // Signed-in sessions: test admin login, then a session carrying the token.
    const login = await (await doFetch("/api/auth/test-login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    assert.ok(login.ok && login.token, "test admin login");
    const user1 = await mkSession({ authorization: `Bearer ${login.token}` });
    const user2 = await mkSession({ authorization: `Bearer ${login.token}` });
    assert.ok(user1.sessionId && user2.sessionId && user1.sessionId !== user2.sessionId, "signed-in sessions created");
    assert.ok(user1.user, "signed-in session carries a user");

    r = await doFetch(getAsset(user1.sessionId));
    await r.text();
    assert.equal(upstreamCalls, 3, "signed-in session fetches upstream");

    // Second signed-in session gets the shared copy — sharing is intended
    // for authenticated users only.
    r = await doFetch(getAsset(user2.sessionId));
    assert.equal(r.status, 200);
    const body4 = await r.text();
    assert.equal(upstreamCalls, 3, "signed-in sessions still share the cache");
    assert.ok(body4.includes("upstream call #3"), "signed-in session got the shared copy");

    console.log("guest cache isolation regression tests passed");
    server.close(() => process.exit(0));
  } catch (e) {
    console.error("GUEST CACHE ISOLATION TEST FAIL:", e.message);
    server.close(() => process.exit(1));
  }
});
