"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Regression tests for the Veyra Launcher extension's cookie transfer:
//   1. POST /api/handoff/cookies (re-added for the extension) imports a
//      chrome.cookies-style JSON array — including HttpOnly cookies and
//      domain/path/secure/sameSite attributes — into the session jar and
//      pins the sender's user-agent for the host.
//   2. The sid is required: an unknown or missing sid is rejected, so a
//      transfer can only ever target the caller's own Veyra session and
//      never crosses between two Veyra sessions.
//   3. Raw cookie headers ("a=1; b=2") keep working.

(async () => {
  const { app, sessionManager } = require("../src/server");
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const sid = "exttransfersess0000000000000001";
    sessionManager.touch(sid);

    // 1: cookie JSON array in the format the Launcher extension sends
    // (chrome.cookies objects mapped to Playwright's field names:
    // expirationDate -> expires, sameSite enums -> Playwright values).
    const extCookies = [
      { name: "MSPAuth", value: "httponly-secret", domain: ".msn.com", path: "/", secure: true, httpOnly: true, sameSite: "None", expires: 1893456000 },
      { name: "wl_ide", value: "", domain: ".msn.com", path: "/", secure: false, httpOnly: false, sameSite: "Lax", expires: 0 },
      { name: "anon", value: "abc123", domain: "www.msn.com", path: "/", secure: true, httpOnly: false, sameSite: "Lax", expires: 1893456000 }
    ];
    let r = await fetch(`${base}/api/handoff/cookies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid, url: "https://www.msn.com/en-us/play", cookies: JSON.stringify(extCookies), userAgent: "Mozilla/5.0 (LauncherExt) Chrome/131.0.0.0" })
    });
    let j = await r.json();
    assert.equal(r.status, 200, "extension cookie import must succeed");
    assert.equal(j.ok, true, "import must report ok");
    assert.equal(j.imported, 3, "all captured cookies must be imported");
    const rec = sessionManager.peek(sid);
    const byName = new Map([...rec.cookies.values()].map(c => [c.name, c]));
    assert.equal(byName.get("MSPAuth").value, "httponly-secret", "HttpOnly cookies must be imported");
    assert.equal(byName.get("MSPAuth").httpOnly, true, "httpOnly attribute must be preserved");
    assert.equal(byName.get("MSPAuth").domain, ".msn.com", "cookie domains must be preserved");
    assert.equal(byName.get("MSPAuth").expiresAt, 1893456000 * 1000, "expirationDate must convert to ms");
    assert.equal(byName.get("wl_ide").expiresAt, 0, "session cookies must stay session-scoped");
    assert.equal(byName.get("anon").hostOnly, false, "host-only flag must come from the domain");
    assert.equal(sessionManager.chromiumUaFor(sid, "https://www.msn.com/en-us/play"), "Mozilla/5.0 (LauncherExt) Chrome/131.0.0.0", "the sender's user-agent must be pinned for the host");

    // 2: the sid is a required capability — unknown or missing sids fail.
    r = await fetch(`${base}/api/handoff/cookies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid: "doesnotexist1234567890abcdef", url: "https://www.msn.com/", cookies: "a=b" })
    });
    assert.equal(r.status, 404, "unknown sessions must be rejected");
    j = await r.json();
    assert.equal(j.code, "SESSION_NOT_FOUND", "unknown sid must return SESSION_NOT_FOUND");
    r = await fetch(`${base}/api/handoff/cookies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://www.msn.com/", cookies: "a=b" })
    });
    assert.equal(r.status, 404, "sid-less imports must be rejected (no host routing)");

    // 3: raw cookie header still imports (paste/devtools path).
    r = await fetch(`${base}/api/handoff/cookies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid, url: "https://www.chess.com/home", cookies: "sessionid=rawhdr; other=def" })
    });
    j = await r.json();
    assert.equal(r.status, 200, "raw cookie header import must succeed");
    assert.equal(j.imported, 2, "raw header pairs must import");
    assert.equal(rec.cookies.get("www.chess.com|/|sessionid").value, "rawhdr", "raw cookies must land in the jar");

    // Source-level: the in-proxy sign-in note explains the exception.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
    assert.match(src, /Launcher extension's sid-scoped/, "the removal note must document the extension exception");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log("Launcher extension cookie-transfer checks passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
