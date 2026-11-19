"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { join } = require("node:path");
const { after, before, test } = require("node:test");
const { watchVideo } = require("../src/browser/youtube-watch-player");

process.env.VEYRA_ENV = "test";
process.env.GATE_ENABLED = "false";
process.env.YOUTUBE_DATA_API_KEY = "";
const { app, sessionManager, vpnManager } = require("../src/server");
const id = "42TV0hS59OA";
const nextId = "M7lc1UVf-VE";
const sid = "youtube-watch-fixture-01";
const privateSid = "youtube-private-fixture-01";
const url = `https://www.youtube.com/watch?v=${id}&t=1m5s&list=PLUnchecked`;
let server, base, calls = 0, state = "ready", blocked = false, requested;
const markup = `<!doctype html><html><head><title>Watch fixture</title><style>
  body{margin:0} #player-container-inner{width:100%} #movie_player{height:240px;background:#222;color:white}
</style></head><body><header>Original navigation</header><ytd-watch-flexy>
  <div id="player"><div id="player-container-inner"><div id="movie_player">Native player</div></div></div>
  <h1>Original video title</h1><p>Original description</p>
  <button id="next" type="button" onclick="history.pushState({}, '', '/watch?v=${nextId}')">Next video</button>
</ytd-watch-flexy></body></html>`;
function route({ target = url, session = sid, enabled = true } = {}) {
  return `${base}/api/view?url=${encodeURIComponent(target)}&sid=${session}${enabled ? "&__veyra_youtube_inline=1" : ""}`;
}
before(async () => {
  sessionManager.touch(sid);
  sessionManager.touch(privateSid).incognito = true;
  app.locals.veyraYoutubeWatchEligibility = async () => { calls++; return state; };
  app.locals.veyraProxyFetchBuffer = async target => {
    requested = target;
    return { ok: true, status: 200, finalUrl: target, cacheControl: "no-store", contentType: "text/html", body: Buffer.from(blocked ? "<html><head><title>Before you continue to YouTube</title></head></html>" : markup) };
  };
  // The actual shell's local CSP only admits its documented API port.
  server = app.listen(process.env.VEYRA_TEST_BROWSER_WEB_ROOT ? 10000 : 0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));

test("only real HTTPS watch URLs with valid IDs are selected", () => {
  assert.deepEqual(watchVideo(url), { videoId: id, start: 65 });
  for (const target of [
    `https://example.org/watch?v=${id}`, `http://www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com:8443/watch?v=${id}`, `https://www.youtube.com/shorts/${id}`,
    "https://www.youtube.com/watch?v=invalid"
  ]) assert.equal(watchVideo(target), null);
});

test("preserves the opt-in through escaped routing and only attaches an eligible public document", async () => {
  const load = async opts => {
    const response = await fetch(route(opts), { headers: { accept: "text/html" } });
    assert.equal(response.status, 200);
    return response.text();
  };
  const initial = await fetch(route(), { redirect: "manual", headers: { accept: "text/html" } });
  assert.equal(initial.status, 302);
  assert.equal(new URL(initial.headers.get("location")).searchParams.get("__veyra_youtube_inline"), "1");
  assert.match(await load(), /watchNavigate=\(function installWatchPlayer/);
  assert.equal(requested, url, "internal feature flag must never be sent upstream");
  assert.equal(calls, 1);
  assert.doesNotMatch(await load({ enabled: false }), /function installWatchPlayer/);
  assert.doesNotMatch(await load({ session: privateSid }), /function installWatchPlayer/);
  assert.doesNotMatch(await (await fetch(route())).text(), /function installWatchPlayer/, "non-document requests must not mount an embed");
  const differentVideo = new URL(initial.headers.get("location"));
  differentVideo.searchParams.set("v", nextId);
  const redirected = await fetch(differentVideo, { headers: { "sec-fetch-dest": "iframe", accept: "text/html" } });
  assert.equal(redirected.status, 200);
  assert.doesNotMatch(await redirected.text(), /function installWatchPlayer/, "opt-in is bound to the exact matched video");
  const vpnCheck = vpnManager.requiresVpnForSession;
  vpnManager.requiresVpnForSession = () => true;
  try { assert.doesNotMatch(await load(), /function installWatchPlayer/); }
  finally { vpnManager.requiresVpnForSession = vpnCheck; }
  blocked = true;
  try { assert.doesNotMatch(await load(), /function installWatchPlayer/); }
  finally { blocked = false; }
  assert.equal(calls, 1);
  for (const denied of ["external", "unavailable"]) {
    state = denied;
    assert.doesNotMatch(await load(), /function installWatchPlayer/);
  }
  state = "ready";
});

test("Chromium swaps only the player slot and loads one direct official frame on click", {
  skip: !process.env.VEYRA_TEST_CHROMIUM_EXECUTABLE, timeout: 15000
}, async () => {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ executablePath: process.env.VEYRA_TEST_CHROMIUM_EXECUTABLE, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 650 } });
    const embeds = [];
    await page.route("https://www.youtube-nocookie.com/**", async intercepted => {
      embeds.push({ url: new URL(intercepted.request().url()), headers: intercepted.request().headers() });
      await intercepted.fulfill({ contentType: "text/html", body: "<p>Official iframe fixture</p>" });
    });
    await page.goto(route());
    const panel = page.locator("#player-container-inner [data-veyra-watch-player]");
    const button = panel.getByRole("button", { name: "Load YouTube player" });
    await button.waitFor();
    assert.equal(await page.locator("#movie_player").isVisible(), false);
    assert.equal(await page.getByRole("heading", { name: "Original video title" }).isVisible(), true);
    assert.equal(await page.getByText("Original description", { exact: true }).isVisible(), true);
    assert.equal(await panel.locator("iframe").count(), 0);
    await button.evaluate(el => el.click());
    assert.equal(await panel.locator("iframe").count(), 0, "site-script clicks must not connect directly");
    await button.click();
    await panel.frameLocator("iframe").getByText("Official iframe fixture").waitFor();
    assert.equal(embeds.length, 1);
    assert.equal(embeds[0].url.pathname, `/embed/${id}`);
    assert.equal(embeds[0].url.searchParams.get("start"), "65");
    assert.equal(embeds[0].url.searchParams.has("list"), false);
    assert.equal(embeds[0].url.searchParams.has("autoplay"), false);
    assert.equal(embeds[0].headers.referer, `${base}/`);
    const frameBox = await panel.locator("iframe").boundingBox();
    assert.ok(frameBox.width >= 200 && frameBox.height >= 200);
    const link = panel.getByRole("link", { name: "Open on YouTube" });
    const linkBox = await link.boundingBox();
    assert.ok(linkBox && linkBox.y >= frameBox.y + frameBox.height, "the external link never covers the official player");
    const watchUrl = `https://www.youtube.com/watch?v=${id}&t=65`;
    await page.context().route(watchUrl, request => request.fulfill({ contentType: "text/html", body: "<p>External watch fixture</p>" }));
    const [popup] = await Promise.all([page.waitForEvent("popup"), link.click()]);
    await popup.getByText("External watch fixture").waitFor();
    assert.equal(popup.url(), watchUrl);
    await popup.close();
    await page.evaluate(() => history.replaceState({}, "", location.pathname + location.search));
    assert.equal(new URL(page.url()).searchParams.get("__veyra_youtube_inline"), "1");
    await page.reload();
    await button.waitFor();
    await page.setViewportSize({ width: 180, height: 650 });
    await page.getByText("Widen this pane to play here.").waitFor();
    assert.equal(await button.isDisabled(), true);
    assert.equal(await panel.locator("iframe").count(), 0);
    await page.setViewportSize({ width: 375, height: 650 });
    await button.click();
    await panel.frameLocator("iframe").getByText("Official iframe fixture").waitFor();
    await page.getByRole("button", { name: "Next video" }).click();
    await panel.waitFor({ state: "detached" });
    assert.equal(await page.locator("#movie_player").isVisible(), true);
  } finally { await browser.close(); }
});

test("the VeyraBrowser shell keeps watch pages in their tab through video navigation and private mode", {
  skip: !process.env.VEYRA_TEST_CHROMIUM_EXECUTABLE || !process.env.VEYRA_TEST_BROWSER_WEB_ROOT,
  timeout: 30000
}, async () => {
  const express = require("express");
  const { chromium } = require("playwright");
  const frontend = express().use(express.static(process.env.VEYRA_TEST_BROWSER_WEB_ROOT)).listen(0, "127.0.0.1");
  await once(frontend, "listening");
  const shell = `http://127.0.0.1:${frontend.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.VEYRA_TEST_CHROMIUM_EXECUTABLE, headless: true, args: ["--no-sandbox"] });
  const open = async (privateMode, inlineEnabled = true) => {
    const page = await browser.newPage({ viewport: { width: 960, height: 760 } });
    page.setDefaultTimeout(6500);
    if (!inlineEnabled) await page.addInitScript(() => localStorage.setItem("veyra-settings", JSON.stringify({ youtubeInline: false })));
    await page.route("**/*", route => {
      const destination = new URL(route.request().url());
      if (destination.origin === base || destination.origin === shell) return route.continue();
      if (destination.origin === "https://www.youtube-nocookie.com") {
        return route.fulfill({ contentType: "text/html", body: "<body style='margin:0;height:100vh;display:grid;place-items:center;background:#111;color:white;font:16px system-ui'>Official player fixture (no live media)</body>" });
      }
      return route.abort();
    });
    await page.goto(`${shell}/browse/?veyra_api=${encodeURIComponent(base)}&incognito=${privateMode ? "1" : "0"}`);
    const address = page.getByRole("textbox", { name: "Address and search bar" });
    await address.fill(url);
    await address.press("Enter");
    const frame = page.frameLocator("iframe.tab-frame");
    await frame.getByRole("heading", { name: "Original video title" }).waitFor();
    return { page, address, frame };
  };
  try {
    const { page, address, frame } = await open(false);
    const embed = frame.locator("[data-veyra-watch-player] iframe");
    const load = frame.getByRole("button", { name: "Load YouTube player" });
    await load.click();
    await embed.contentFrame().getByText("Official player fixture (no live media)").waitFor();
    const screenshots = process.env.VEYRA_TEST_BROWSER_SCREENSHOTS;
    if (screenshots) await page.screenshot({ path: join(screenshots, "desktop-playing.png") });
    await frame.getByRole("button", { name: "Next video" }).click();
    await page.waitForFunction(id => document.getElementById("address").value.includes(id), nextId);
    await load.click();
    assert.match(await embed.getAttribute("src"), new RegExp(`/embed/${nextId}\\?`));
    await page.locator("#backBtn").click();
    await page.waitForFunction(id => document.getElementById("address").value.includes(id), id);
    await load.waitFor();
    assert.match(await address.inputValue(), /42TV0hS59OA/);
    await page.locator("#forwardBtn").click();
    await page.waitForFunction(id => document.getElementById("address").value.includes(id), nextId);
    await load.waitFor();
    await page.setViewportSize({ width: 375, height: 780 });
    if (screenshots) await page.screenshot({ path: join(screenshots, "mobile-watch.png") });
    await page.close();
    for (const [privateMode, inlineEnabled] of [[true, true], [false, false]]) {
      const result = await open(privateMode, inlineEnabled);
      assert.equal(await result.frame.getByText("Native player", { exact: true }).isVisible(), true);
      assert.equal(await result.frame.locator("[data-veyra-watch-player]").count(), 0);
      await result.page.close();
    }
  } finally {
    await browser.close();
    await new Promise(resolve => frontend.close(resolve));
  }
});
