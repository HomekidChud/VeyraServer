"use strict";
// Separate from npm test: this integration requires installed Chromium.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { app, sessionManager, rewriteHtml } = require("../src/server");
const { cookieCapability } = require("../src/proxy-cookies");
const crypto = require("node:crypto");
let checks = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
(async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`, sid = "browser-runtime-qa-123";
  const rec = sessionManager.create(sid), canonical = "https://example.com/app/";
  const bytes = "window.__signedAssetLoaded=true;";
  const integrity = "sha384-" + crypto.createHash("sha384").update(bytes).digest("base64");
  const cookieContext = { cookies: [], token: cookieCapability(sid, canonical, Date.now() + 60000) };
  const html = rewriteHtml("<!doctype html><html><head></head><body><h1>Runtime fixture</h1></body></html>", canonical, sid)
    .replace("/*__VEYRA_COOKIE_CONTEXT__*/null", JSON.stringify(cookieContext));
  const browser = await chromium.launch({ headless: true, channel: "chromium",
    ...(process.env.VEYRA_QA_CHROMIUM ? { executablePath: process.env.VEYRA_QA_CHROMIUM } : {}) });
  try {
    const page = await browser.newPage();
    await page.route("**/api/view?**", route => route.fulfill({ contentType: "text/html", body: html }));
    const received = [];
    await page.route("**/api/resource?**", async route => {
      const request = route.request(), u = new URL(request.url());
      received.push({ url: u.searchParams.get("url"), integrity: u.searchParams.get("integrity"),
        token: request.headers()["x-veyra-cookie-capability"], cookies: [...rec.cookies.values()].map(c => c.name + "=" + c.value) });
      await route.fulfill({ contentType: u.searchParams.get("url").endsWith(".js") ? "application/javascript" : "application/json",
        body: u.searchParams.get("url").endsWith(".js") ? bytes : '{"ok":true}' });
    });
    await page.goto(`${base}/api/view?url=${encodeURIComponent(canonical)}&sid=${sid}`);
    check(await page.evaluate(() => window.__VEYRA_LOCATION__.pathname), "/app/");
    check(await page.evaluate(() => document.URL), canonical);
    const source = await page.evaluate(integrity => {
      const script = document.createElement("script");
      script.src = "https://cdn.example.com/chunks/" + "entry.js";
      script.integrity = integrity; // Real loaders often set integrity AFTER src.
      document.body.append(script);
      return { publicSource: script.src };
    }, integrity);
    check(source.publicSource, "https://cdn.example.com/chunks/entry.js");
    await page.waitForFunction(() => window.__signedAssetLoaded === true);
    check(received[0].url, "https://cdn.example.com/chunks/entry.js");
    check(received[0].integrity, integrity);
    await page.evaluate(async () => {
      document.cookie = "scriptCookie=one; Path=/; Secure";
      await fetch("/check");
    });
    check(received.at(-1).cookies.includes("scriptCookie=one"), true);
    check(!!received.at(-1).token, true);
    check(await page.evaluate(() => document.cookie), "scriptCookie=one");
    await page.evaluate(async () => {
      document.cookie = "xhrCookie=two; Path=/";
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest(); xhr.open("GET", "/check-xhr");
        xhr.onload = resolve; xhr.onerror = reject; xhr.send();
      });
    });
    check(received.at(-1).cookies.includes("xhrCookie=two"), true);
    const jsonResult = await page.evaluate(() => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); xhr.open("GET", "/json-xhr"); xhr.responseType = "json";
      xhr.onload = () => resolve(xhr.response); xhr.onerror = reject; xhr.send();
    }));
    check(jsonResult, { ok: true });
    await page.evaluate(async () => {
      document.cookie = "scriptCookie=gone; Path=/; Max-Age=0";
      await fetch("/after-delete");
    });
    check(received.at(-1).cookies.some(c => c.startsWith("scriptCookie=")), false);
    check(await page.evaluate(() => document.cookie.includes("scriptCookie=")), false);
    const count = received.length;
    await page.evaluate(async () => {
      const xhr = new XMLHttpRequest(); xhr.open("GET", "/aborted");
      xhr.send(); xhr.abort(); await Promise.resolve(); await Promise.resolve();
    });
    check(received.length, count);
    console.log(`Proxy runtime Chromium: ${checks} URL, loader, SRI, fetch/XHR cookie and abort checks passed.`);
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
