"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Verifies the direct-login handoff:
//   1. /api/handoff/login sends the user to the site's real login page with a
//      return trip back to Veyra (chess.com pattern + generic homepage).
//   2. /api/handoff/return bounces into the Veyra app with the target URL.
//   3. /api/handoff/cookies imports the user's pasted cookies (raw header or
//      JSON array) into the fast-proxy session jar with the user's user-agent.
//   4. The challenge interstitial offers the handoff actions.

(async () => {
  const { app, sessionManager } = require("../src/server");
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const base = `http://127.0.0.1:${server.address().port}`;

    // 1: login handoff redirects — straight to the real site, with the return
    // trip pointing at the app itself (never through the API origin).
    let r = await fetch(`${base}/api/handoff/login?url=${encodeURIComponent("https://www.chess.com/register")}&sid=handofftestsid1234`, { redirect: "manual" });
    assert.equal(r.status, 302, "login handoff must redirect");
    let loc = String(r.headers.get("location") || "");
    assert.match(loc, /^https:\/\/www\.chess\.com\/register\?returnUrl=/, "chess.com must open the exact auth page the user was on");
    const decoded = decodeURIComponent(decodeURIComponent(loc));
    assert.match(decoded, /veyra_handoff=https:\/\/www\.chess\.com\/register/, "the return trip must carry the original target back to the app");
    assert.ok(!loc.includes("127.0.0.1"), "the handoff destination must not route through the API origin");

    r = await fetch(`${base}/api/handoff/login?url=${encodeURIComponent("https://www.chess.com/home")}`, { redirect: "manual" });
    loc = String(r.headers.get("location") || "");
    assert.equal(loc, "https://www.chess.com/home", "non-auth pages must hand off the exact page unchanged");

    r = await fetch(`${base}/api/handoff/login?url=${encodeURIComponent("https://unknown.example/deep/path")}`, { redirect: "manual" });
    loc = String(r.headers.get("location") || "");
    assert.equal(loc, "https://unknown.example/deep/path", "unknown hosts must hand off the exact page (any wall, not just logins)");

    // Known sites: auth pages get the return trip; other pages stay exact.
    r = await fetch(`${base}/api/handoff/login?url=${encodeURIComponent("https://github.com/login")}&sid=handofftestsid1234`, { redirect: "manual" });
    loc = String(r.headers.get("location") || "");
    assert.match(loc, /^https:\/\/github\.com\/login\?return_to=/, "github login must keep its own login page with a return trip");
    const ghDecoded = decodeURIComponent(decodeURIComponent(loc));
    assert.match(ghDecoded, /veyra_handoff=https:\/\/github\.com\/login/, "the github return trip must carry the target back to the app");

    r = await fetch(`${base}/api/handoff/login?url=${encodeURIComponent("https://github.com/org/repo")}`, { redirect: "manual" });
    loc = String(r.headers.get("location") || "");
    assert.equal(loc, "https://github.com/org/repo", "github content pages must hand off the exact page");

    r = await fetch(`${base}/api/handoff/login?url=javascript:alert(1)`, { redirect: "manual" });
    assert.equal(r.status, 400, "non-http(s) targets must be rejected");

    // JSON mode: the frontend asks for the destination so the popup never
    // navigates through the API origin at all.
    r = await fetch(`${base}/api/handoff/login?url=${encodeURIComponent("https://www.chess.com/register")}&sid=handofftestsid1234`, { headers: { accept: "application/json" } });
    const destJson = await r.json();
    assert.equal(r.status, 200, "JSON handoff must succeed");
    assert.equal(destJson.ok, true, "JSON handoff must report ok");
    assert.match(String(destJson.dest || ""), /^https:\/\/www\.chess\.com\/register\?returnUrl=/, "JSON handoff must return the direct site destination");

    // 2: return endpoint bounces into the app with the target.
    r = await fetch(`${base}/api/handoff/return?url=${encodeURIComponent("https://www.chess.com/register")}`, { redirect: "manual" });
    assert.equal(r.status, 302, "return handoff must redirect");
    loc = String(r.headers.get("location") || "");
    assert.match(loc, /veyra_handoff=https%3A%2F%2Fwww\.chess\.com%2Fregister/, "the app URL must carry the original target as veyra_handoff");

    // 3: cookie import into the session jar.
    const sid = "handofftestsession0000000000000001";
    sessionManager.touch(sid);
    r = await fetch(`${base}/api/handoff/cookies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid, url: "https://www.chess.com/register", cookies: "sessionid=abc; other=def", userAgent: "Mozilla/5.0 (TestBrowser) Chrome/131.0.0.0" })
    });
    let j = await r.json();
    assert.equal(r.status, 200, "cookie import must succeed");
    assert.equal(j.imported, 2, "both pasted cookies must be imported");
    const rec = sessionManager.peek(sid);
    const names = [...rec.cookies.values()].map(c => c.name).sort();
    assert.deepEqual(names, ["other", "sessionid"], "cookies must land in the session jar");
    assert.equal(rec.cookies.get("www.chess.com|/|sessionid").value, "abc", "cookie values must be preserved");
    assert.equal(sessionManager.chromiumUaFor(sid, "https://www.chess.com/home"), "Mozilla/5.0 (TestBrowser) Chrome/131.0.0.0", "the user's user-agent must be pinned for the host");

    // JSON array form (as copied from devtools or exported by an extension).
    r = await fetch(`${base}/api/handoff/cookies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid, url: "https://www.chess.com/", cookies: JSON.stringify([{ name: "sessionid", value: "xyz", domain: "www.chess.com", path: "/", secure: true, expires: 9999999999 }]) })
    });
    j = await r.json();
    assert.equal(r.status, 200, "JSON cookie import must succeed");
    assert.equal(rec.cookies.get("www.chess.com|/|sessionid").value, "xyz", "JSON cookies must overwrite the raw ones");

    // Guard rails.
    r = await fetch(`${base}/api/handoff/cookies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid: "doesnotexist1234567890abcdef", url: "https://www.chess.com/", cookies: "a=b" })
    });
    assert.equal(r.status, 404, "unknown sessions must be rejected");
    r = await fetch(`${base}/api/handoff/cookies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid, url: "https://www.chess.com/", cookies: "not a cookie header" })
    });
    assert.equal(r.status, 400, "cookie payloads without pairs must be rejected");

    // 4: the challenge interstitial offers the handoff (source-level wiring).
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
    assert.match(src, /Open this page directly & come back/, "the interstitial must link the generic handoff");
    assert.match(src, /handoffDest/, "the interstitial must link the real site directly, not through the API");
    assert.match(src, /Bring your session into Veyra/, "the interstitial must offer the session import");
    assert.match(src, /Bring session back/, "the interstitial must offer the bookmarklet return for every site");
    assert.match(src, /veyra_handoff/, "the app return parameter must be wired");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log("VeyraServer direct-login handoff checks passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
