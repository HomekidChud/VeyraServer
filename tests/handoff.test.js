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

    // 1: login handoff redirects.
    let r = await fetch(`${base}/api/handoff/login?url=${encodeURIComponent("https://www.chess.com/register")}&sid=handofftestsid1234`, { redirect: "manual" });
    assert.equal(r.status, 302, "login handoff must redirect");
    let loc = String(r.headers.get("location") || "");
    assert.match(loc, /^https:\/\/www\.chess\.com\/login\?returnUrl=/, "chess.com must go to its real login page");
    const decoded = decodeURIComponent(decodeURIComponent(loc));
    assert.match(decoded, /\/api\/handoff\/return\?sid=handofftestsid1234&url=https:\/\/www\.chess\.com\/register/, "the return trip must carry the session and the original target");

    r = await fetch(`${base}/api/handoff/login?url=${encodeURIComponent("https://unknown.example/deep/path")}`, { redirect: "manual" });
    loc = String(r.headers.get("location") || "");
    assert.equal(loc, "https://unknown.example/", "unknown hosts must fall back to the site homepage");

    r = await fetch(`${base}/api/handoff/login?url=javascript:alert(1)`, { redirect: "manual" });
    assert.equal(r.status, 400, "non-http(s) targets must be rejected");

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
    assert.match(src, /Log in directly & come back/, "the interstitial must link the login handoff");
    assert.match(src, /Bring your session into Veyra/, "the interstitial must offer the session import");
    assert.match(src, /veyra_handoff/, "the app return parameter must be wired");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log("VeyraServer direct-login handoff checks passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
