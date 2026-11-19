"use strict";
// Behavioral regression test: guest sessions must never read or write the
// session or shared proxy cache, while signed-in sessions can reuse eligible responses.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

for (const name of ["AI_API_KEY", "AI_API_BASE_URL", "OPENAI_API_KEY", "BRAVE_SEARCH_API_KEY", "BING_SEARCH_API_KEY", "GOOGLE_SEARCH_API_KEY", "MONGODB_URI"]) delete process.env[name];
process.env.VEYRA_TEST_MODE = "1";
process.env.VEYRA_ENV = "test";
process.env.VEYRA_CHROMIUM_ENABLED = "false";
process.env.BROWSER_ENABLED = "0";
process.env.SESSION_CACHE_ENABLED ??= "1";
process.env.GLOBAL_CACHE_ENABLED ??= "1";
process.env.ACCESS_GATE = "0";
process.env.MONGODB_SHARED_CACHE = "1"; // default, but pinned for clarity
process.env.VPN_ENABLED = "1";
process.env.VPN_PROFILES_JSON = JSON.stringify([{ id: "env-vpn-fixture", name: "Configured fixture exit", type: "http", server: "http://fixture.invalid:8080" }]);
process.env.DATA_DIR = (() => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-guest-cache-")); return d; })();

const { app, CFG, mongoStore, sessionManager, BrowserTaskScheduler, vpnManager } = require("../src/server");

const ASSET = "https://example.com/shared-bundle.js";
let upstreamCalls = 0;
let upstreamBody = "";

// Mock upstream: counts calls so the test can prove cache hits and misses.
let delayed = null;
app.locals.veyraProxyFetchBuffer = async (url, opts) => {
  upstreamCalls += 1;
  upstreamBody = `/* upstream call #${upstreamCalls} ${crypto.randomUUID()} */`;
  if (delayed && url.endsWith("/delayed.js")) await delayed(opts.signal);
  return { ok: true, status: 200, contentType: "text/javascript", body: Buffer.from(upstreamBody), cacheControl: url.endsWith("/shared-bundle.js") ? "public, max-age=3600" : "max-age=120", finalUrl: url, bytes: upstreamBody.length };
};
let mongoReads = 0, mongoWrites = 0;
mongoStore.enabled = true;
mongoStore.getProxyCache = async () => { mongoReads += 1; return null; };
mongoStore.putProxyCache = async (key, response, metadata) => { assert.ok(key.endsWith("sid=*")); assert.equal(metadata.sessionId, ""); mongoWrites += 1; };
const legacyDeletes = [];
mongoStore.deleteSessionCookies = async sid => { legacyDeletes.push(["cookies", sid]); };
mongoStore.deleteSessionSnapshots = async sid => { legacyDeletes.push(["snapshots", sid]); };
mongoStore.loadVpnProfiles = async () => [{
  id: "fixture-london", name: "London fixture", country: "GB", type: "socks5",
  server: "socks5://fixture.invalid:1080", username: "fixture-user", password: "fixture-password"
}];

const server = app.listen(0, "127.0.0.1");
server.on("error", (e) => { console.error("SERVER FAIL", e.message); process.exit(1); });
server.on("listening", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const doFetch = (p, o) => fetch(base + p, o);
  try {
    // Two distinct guest sessions.
    const mkSession = async (headers, incognito = false) => (await doFetch("/api/session", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ incognito }) })).json();
    const guest1 = await mkSession();
    const guest2 = await mkSession();
    assert.ok(guest1.sessionId && guest2.sessionId && guest1.sessionId !== guest2.sessionId, "session created");
    assert.ok(!guest1.user, "guest session has no user");
    const privateOpen = await doFetch("/api/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: ASSET, sessionId: guest1.sessionId }) });
    assert.equal(privateOpen.headers.get("cache-control"), "no-store");
    assert.equal((await privateOpen.json()).crawlerEnabled, false);

    const vpnCatalog = await (await doFetch("/api/vpn/profiles")).json();
    assert.ok(vpnCatalog.profiles.some(p => p.id === "env-vpn-fixture"), "VPN-enabled startup loads configured exits");
    assert.equal(vpnCatalog.profiles.find(p => p.id === "fixture-london")?.name, "London fixture");
    assert.ok(vpnManager.get("fixture-london"), "persisted profile can actually be selected");
    assert.doesNotMatch(JSON.stringify(vpnCatalog), /fixture-user|fixture-password|fixture\.invalid/);
    const vpnStatus = await (await doFetch("/api/vpn/status")).json();
    assert.ok(vpnStatus.profiles.some(p => p.id === "fixture-london"));

    const getAsset = (sid, mode = "resource", url = ASSET) => `/api/${mode}?url=${encodeURIComponent(url)}&sid=${sid}`;

    // Guest 1 fetch: upstream called (cold).
    let r = await doFetch(getAsset(guest1.sessionId));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    let body1 = await r.text();
    assert.equal(upstreamCalls, 1, "first guest fetch hits upstream");
    assert.ok(body1.includes("upstream call #1"));

    // Even the same guest does not reuse an earlier response.
    r = await doFetch(getAsset(guest1.sessionId));
    body1 = await r.text();
    assert.equal(upstreamCalls, 2, "same guest session must fetch again");
    assert.ok(body1.includes("upstream call #2"));

    // Guest 2 (different session, same asset): must NOT be served guest 1's
    // copy from the shared cache — the fetch is upstream again.
    r = await doFetch(getAsset(guest2.sessionId));
    assert.equal(r.status, 200);
    const body2 = await r.text();
    assert.equal(upstreamCalls, 3, "second guest session does not read the shared cache");
    assert.ok(body2.includes("upstream call #3"), "guest 2 got its own upstream copy");
    assert.equal(mongoReads + mongoWrites, 0, "guest bypasses MongoDB");

    // Signed-in sessions: test admin login, then a session carrying the token.
    const login = await (await doFetch("/api/auth/test-login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    assert.ok(login.ok && login.token, "test admin login");
    const auth = { authorization: `Bearer ${login.token}` };
    const user1 = await mkSession(auth);
    const user2 = await mkSession(auth);
    assert.ok(user1.sessionId && user2.sessionId && user1.sessionId !== user2.sessionId, "signed-in sessions created");
    assert.ok(user1.user, "signed-in session carries a user");

    r = await doFetch(getAsset(user1.sessionId));
    await r.text();
    assert.equal(upstreamCalls, 4, "signed-in session fetches upstream");

    // Second signed-in session gets the shared copy — sharing is intended
    // for authenticated users only.
    r = await doFetch(getAsset(user2.sessionId));
    assert.equal(r.status, 200);
    const body4 = await r.text();
    assert.equal(upstreamCalls, CFG.globalCacheEnabled ? 4 : 5, "the global switch controls cross-session reuse");
    assert.ok(body4.includes(`upstream call #${CFG.globalCacheEnabled ? 4 : 5}`));
    assert.equal(mongoWrites, CFG.globalCacheEnabled ? 1 : 0);
    const readsAfterShared = mongoReads;
    const callsAfterShared = upstreamCalls;
    const incognito = await mkSession(auth, true);
    assert.equal(incognito.incognito, true);
    for (const [sid, mode] of [[incognito.sessionId, "view"], [incognito.sessionId, "resource"], [guest1.sessionId, "resource"]]) {
      r = await doFetch(getAsset(sid, mode)); await r.text();
      assert.equal(r.headers.get("cache-control"), "no-store");
    }
    assert.equal(upstreamCalls, callsAfterShared + 3, "guest and signed-in incognito cannot read a warm shared cache");
    assert.equal(mongoReads, readsAfterShared);
    assert.equal(mongoWrites, CFG.globalCacheEnabled ? 1 : 0);

    const sessionOnly = "https://example.com/session-bundle.js";
    const read = async (sid, url, mode) => (await doFetch(getAsset(sid, mode, url))).text();
    const userBody = await read(user1.sessionId, sessionOnly);
    const sameSessionAgain = await read(user1.sessionId, sessionOnly);
    assert.equal(sameSessionAgain === userBody, CFG.sessionCacheEnabled, "the session switch controls same-session reuse");
    assert.notEqual(await read(user2.sessionId, sessionOnly), userBody);

    let started, release;
    const ready = new Promise(resolve => { started = resolve; });
    const unblock = new Promise(resolve => { release = resolve; });
    let signal;
    delayed = async s => { signal = s; started(); await unblock; };
    const pending = doFetch(getAsset(guest1.sessionId, "resource", "https://example.com/delayed.js"));
    await ready;
    const rec = sessionManager.peek(guest1.sessionId);
    rec.cookies.set("test", { name: "test", value: "fixture" });
    const close = await doFetch(`/api/session/${guest1.sessionId}/close`, { method: "POST" });
    assert.equal((await close.json()).closed, true);
    release();
    assert.equal(signal.aborted, true, "session close signals in-flight fetches");
    assert.equal((await pending).status, 410, "a late response cannot reappear after close");
    assert.equal((await doFetch(getAsset(guest1.sessionId))).status, 410);
    assert.ok(!sessionManager.peek(guest1.sessionId));
    assert.equal(rec.cookies.size, 0);
    assert.deepEqual(legacyDeletes, [["cookies", guest1.sessionId], ["snapshots", guest1.sessionId]]);

    const queue = new BrowserTaskScheduler(1, 1);
    let finishFirst;
    const first = queue.request("active", () => new Promise(resolve => { finishFirst = resolve; }));
    const controller = new AbortController();
    const queued = queue.request("queued", () => assert.fail("deleted work must not execute"), { signal: controller.signal });
    controller.abort();
    await assert.rejects(queued, { code: "SESSION_EXPIRED" });
    assert.equal(queue.status().queued, 0);
    finishFirst();
    await first;

    console.log("guest cache isolation regression tests passed");
    server.close(() => process.exit(0));
  } catch (e) {
    console.error("GUEST CACHE ISOLATION TEST FAIL:", e.message);
    server.close(() => process.exit(1));
  }
});
