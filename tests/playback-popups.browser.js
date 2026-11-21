"use strict";

// Run alongside a VeyraBrowser checkout: node tests/playback-popups.browser.js ../VeyraBrowser/web
// Requires Playwright Chromium and ffmpeg; no external sites or account are used.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const express = require("express");
const { chromium } = require("playwright");

process.env.VEYRA_CHROMIUM_ENABLED = "false";
delete process.env.PUBLIC_API_ORIGIN;
const { app } = require(process.env.POPUP_TEST_SERVER || "../src/server");
const site = "https://example.com";
const player = `<!doctype html><html><head><title>Playback fixture</title></head><body>
 <h1>Playback fixture with a locally generated clip</h1>
 <video muted playsinline preload="auto" src="/clip.webm"></video>
 <button id="play">Play</button><a id="blank" href="#" target="_blank">Empty link</a>
 <a id="details" href="/details" target="_blank">Details in a new tab</a>
 <button id="signin">Sign in</button><button id="same">Details here</button>
 <output id="result"></output>
 <script>
 const show = text => { document.getElementById('result').textContent = text; };
 window.open('/unexpected', '_blank'); // before the embed handshake
 document.getElementById('play').onclick = () => {
   window.open('about:blank', '_blank');
   window.open('  ', '_blank');
   window.open('/unexpected', '_blank');
   setTimeout(() => { window.open('/unexpected?delayed', '_blank'); show('delayed attempt ran'); }, 120);
   document.querySelector('video').play().catch(error => show(error.message));
 };
 document.getElementById('signin').onclick = () => {
   const w = window.open('', 'fixture-signin');
   show(w && !w.closed && w.location.href === 'about:blank' ? 'waiting' : 'no handle');
   if (!w) return;
   setTimeout(() => { w.location.href = '/signin'; }, 500);
   const timer = setInterval(() => { if (w.closed) { clearInterval(timer); show('closed'); } }, 30);
 };
 window.addEventListener('message', e => {
   if (e.origin !== 'https://example.com' || e.data !== 'ready') return;
   e.source.postMessage('reply', e.origin);
 });
 document.getElementById('same').onclick = () => window.open('/details', '_self');
 </script></body></html>`;
const signIn = `<h1>Sign-in window fixture</h1><button id="finish" disabled>Finish</button><script>
 window.addEventListener('message', e => {
   if (e.origin === 'https://example.com' && e.data === 'reply') document.getElementById('finish').disabled = false;
 });
 document.getElementById('finish').onclick = () => window.close();
 window.opener?.postMessage('ready', 'https://example.com');
 </script>`;

async function run() {
  const clip = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "color=blue:size=64x64:rate=10", "-t", "3", "-c:v", "libvpx", "-f", "webm", "pipe:1"]);
  app.locals.veyraProxyFetchBuffer = async (target, opts) => {
    const u = new URL(target);
    assert.equal(u.origin, site, "fixture never fetches an external host");
    assert.equal(u.searchParams.has("veyra_popup"), false, "popup routing metadata is not passed to the site");
    if (u.pathname === "/clip.webm") {
      const range = /bytes=(\d+)-(\d*)/.exec(opts.requestHeaders?.range || "");
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), clip.length - 1) : clip.length - 1;
        return { status: 206, finalUrl: target, contentType: "video/webm", acceptRanges: "bytes",
          contentRange: `bytes ${start}-${end}/${clip.length}`, body: clip.subarray(start, end + 1) };
      }
      return { status: 200, finalUrl: target, contentType: "video/webm", body: clip };
    }
    const html = u.pathname === "/player" ? player : `<!doctype html><html><head><title>Fixture</title></head><body>${
      u.pathname === "/signin" ? signIn : u.pathname === "/details" ? "<h1>Details fixture</h1>" : ""
    }</body></html>`;
    return { status: 200, finalUrl: target, contentType: "text/html", body: Buffer.from(html), cacheControl: "no-store" };
  };
  const shell = express();
  const web = resolve(process.argv[2] || "../VeyraBrowser/web");
  const apiServer = app.listen(Number(process.env.POPUP_TEST_API_PORT) || 0, "127.0.0.1");
  const entry = readFileSync(join(web, "browse", "index.html"), "utf8");
  shell.get("/browse", (_req, res) => res.type("html").send(
    entry.replaceAll("http://127.0.0.1:10000", `http://127.0.0.1:${apiServer.address().port}`)
  ));
  shell.use(express.static(web));
  const shellServer = shell.listen(Number(process.env.POPUP_TEST_SHELL_PORT) || 0, "127.0.0.1");
  let browser;
  try {
    await Promise.all([once(apiServer, "listening"), once(shellServer, "listening")]);
    const url = `http://127.0.0.1:${shellServer.address().port}/browse/?${new URLSearchParams({
      url: `${site}/player`, veyra_api: `http://127.0.0.1:${apiServer.address().port}`
    })}`;
    if (process.env.POPUP_TEST_SERVE === "1") {
      console.log(url);
      await once(process, "SIGINT");
      return;
    }
    browser = await chromium.launch({ executablePath: process.env.POPUP_TEST_CHROME || undefined });
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.addInitScript(() => {
      if (window === window.top) localStorage.setItem("veyra-settings", JSON.stringify({ settingsVersion: 6, runtime: "proxy" }));
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const nativePopups = [];
    context.on("page", p => nativePopups.push(p));
    await page.goto(url);
    const opener = page.frameLocator("#frame-t1");
    const active = () => page.locator('#tabsList [aria-selected="true"]').getAttribute("data-tab");
    const count = () => page.locator('#tabsList [role="tab"]').count();
    await opener.locator("#play").waitFor({ state: "attached" });
    const before = { tabs: await count(), native: nativePopups.length, active: await active() };
    await opener.locator("#play").click({ force: true });
    await opener.getByText("delayed attempt ran").waitFor({ state: "attached" });
    const video = await opener.locator("video").evaluate(async v => {
      if (v.currentTime < 0.1 && !v.error) await Promise.race([
        new Promise(r => v.addEventListener("timeupdate", r, { once: true })), new Promise(r => setTimeout(r, 1000))
      ]);
      return { currentTime: v.currentTime, error: v.error?.message || null };
    });
    const after = { tabs: await count(), native: nativePopups.length, active: await active(), video };
    console.log(JSON.stringify({ before, after }));
    assert.equal(after.tabs, 1);
    assert.equal(after.native, 0);
    assert.equal(after.active, before.active);
    assert.equal(video.error, null);
    assert.ok(video.currentTime > 0);
    await opener.locator("#blank").click();
    assert.equal(await count(), 1);
    assert.equal(await active(), before.active);
    await opener.locator("#signin").click();
    await opener.getByText("waiting", { exact: true }).waitFor({ state: "attached" });
    assert.equal(await count(), 1);
    const finish = page.frameLocator("#frame-t2").locator("#finish");
    await finish.click();
    await opener.getByText("closed", { exact: true }).waitFor();
    assert.equal(await count(), 1);
    assert.equal(await active(), before.active);
    await opener.locator("#same").click();
    await opener.getByRole("heading", { name: "Details fixture" }).waitFor();
    assert.equal(await count(), 1);
    await page.goto(url);
    await opener.locator("#details").click();
    await page.frameLocator("#frame-t2").getByRole("heading", { name: "Details fixture" }).waitFor();
    assert.equal(await count(), 2);
    assert.equal(nativePopups.length, 0);
    console.log("Playback, blank links, delayed sign-in relay, in-place navigation and genuine new-tab links passed.");
  } finally {
    await browser?.close();
    apiServer.closeAllConnections();
    shellServer.closeAllConnections();
    apiServer.close();
    shellServer.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
