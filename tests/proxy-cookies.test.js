"use strict";
const assert = require("node:assert/strict");
const { parsedCookie, scriptCookies, cookieCapability, authorizeCookieCapability, setScriptCookie } = require("../src/proxy-cookies");
const { app, sessionManager, __workerOps } = require("../src/server");
process.on("uncaughtException", e => { console.error(e); process.exitCode = 1; });
let checks = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const url = "https://example.com/app/page";
const session = { cookies: new Map() };
const put = raw => setScriptCookie(session, raw, url);
put("visible=yes; Path=/; Secure");
const secret = parsedCookie("secret=hidden; Path=/; HttpOnly; Secure", url);
session.cookies.set("example.com|/|secret", secret);
check(scriptCookies(session, url).map(c => c.name), ["visible"]);
check(scriptCookies(session, "http://example.com/app/page").length, 0);
check(scriptCookies(session, "https://other.com/").length, 0);
check(scriptCookies(session, "https://sub.example.com/").length, 0);
put("domain=yes; Domain=.example.com; Path=/");
check(scriptCookies(session, "https://sub.example.com/").map(c => c.name), ["domain"]);
put("scoped=yes; Path=/app");
check(scriptCookies(session, "https://example.com/application").some(c => c.name === "scoped"), false);
check(scriptCookies(session, url).some(c => c.name === "scoped"), true);
assert.throws(() => put("secret=overwritten; Domain=.example.com; Path=/")); checks++;
assert.throws(() => put("new=hidden; HttpOnly")); checks++;
assert.throws(() => put("bad=x; Domain=com")); checks++;
assert.throws(() => put("bad=x; Domain=other.com")); checks++;
assert.throws(() => put("__Host-bad=x; Secure; Domain=example.com; Path=/")); checks++;
put("visible=gone; Path=/; Max-Age=0");
check(scriptCookies(session, url).some(c => c.name === "visible"), false);
put("scoped=gone; Path=/app; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
check(scriptCookies(session, url).some(c => c.name === "scoped"), false);
check(parsedCookie("default=yes", url).path, "/app");
const sid = "qa-cookie-session-1234";
const token = cookieCapability(sid, url, Date.now() + 60000);
check(authorizeCookieCapability(token, sid, url), true);
check(authorizeCookieCapability(token, sid, "https://example.com/next"), true);
check(authorizeCookieCapability(token, "another-session", url), false);
check(authorizeCookieCapability(token, sid, "https://other.com/"), false);
check(authorizeCookieCapability(token + "x", sid, url), false);
check(authorizeCookieCapability(cookieCapability(sid, url, Date.now() - 1), sid, url), false);
(async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const rec = sessionManager.create(sid);
  rec.cookies.set("example.com|/|secret", secret);
  setScriptCookie(rec, "scoped=specific; Path=/app", url);
  check(__workerOps.cookieHeader(sid, url), "scoped=specific; secret=hidden");
  check(__workerOps.cookieHeader(sid, "https://example.com/application"), "secret=hidden");
  const request = async (body, id = sid) => {
    const r = await fetch(`${base}/api/session/${id}/script-cookie`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: r.status, cache: r.headers.get("cache-control"), data: await r.json() };
  };
  try {
    check((await request({ url, cookie: "one=yes", token: "wrong" })).status, 403);
    check((await request({ url: "https://other.com/", cookie: "one=yes", token })).status, 403);
    const accepted = await request({ url, cookie: "one=yes; Path=/", token });
    check(accepted.status, 200); check(accepted.cache, "no-store");
    check(accepted.data.cookie.httpOnly, false);
    check((await request({ url, cookie: "secret=bad; Path=/", token })).status, 400);
    check((await request({ url, cookie: "new=x; HttpOnly", token })).status, 400);
    check((await request({ url, cookie: "one=x", token }, "missing-session-123")).status, 410);
    check(JSON.stringify(accepted.data).includes("hidden"), false);
    console.log(`Proxy cookies: ${checks} scope, HttpOnly, expiry, capability and HTTP checks passed.`);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
