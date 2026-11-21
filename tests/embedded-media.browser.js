"use strict";

// VEYRA_TEST_CHROMIUM_EXECUTABLE=/path/to/chrome node tests/embedded-media.browser.js
// Uses only fixture responses on the local Fast Proxy and a generated test clip.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { test } = require("node:test");
const { chromium } = require("playwright");
process.env.VEYRA_CHROMIUM_ENABLED = "false";
process.env.GATE_ENABLED = "false";
const { app, makeViewUrl } = require("../src/server");

test("Chromium loads dynamic styles and plays a cross-origin video inside a nested embed", async () => {
  const site = "https://93.184.216.34";
  const embed = "https://8.8.8.8";
  const media = "https://1.1.1.1/clip.webm?b=2&a=x%2By&a=3&utm_custom=keep";
  const cssBase = `${site}/css/new-browse-page/`;
  const css = `${cssBase}menu.css`;
  const seen = [];
  const clip = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "color=blue:size=80x60:rate=12", "-t", "3", "-c:v", "libvpx", "-f", "webm", "pipe:1"]);
  app.locals.veyraProxyFetchBuffer = async (target, opts) => {
    seen.push(target);
    const result = (contentType, body) => ({
      status: 200, finalUrl: target, contentType, body: Buffer.from(body), cacheControl: "no-store"
    });
    if (target === `${site}/demo`) return result("text/html", `<!doctype html>
      <h1 id="demo">Browser fixture</h1>
      <iframe id="nested" src="${embed}/player" allow="autoplay; fullscreen"></iframe>
      <script src="/js/demo.js"></script>`);
    if (target === `${site}/js/demo.js`) return result("application/javascript", `
      const dir = "${cssBase}";
      const stylesheet = document.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href = dir + "menu.css";
      document.head.appendChild(stylesheet);`);
    if (target === css) return result("text/css", "#demo { color: rgb(1, 2, 3); }");
    if (target === `${embed}/player`) return result("text/html", `<!doctype html>
      <video muted playsinline preload="none" crossorigin="anonymous" src="${media}"></video>
      <button onclick="document.querySelector('video').play()">Play sample</button>`);
    if (target === media) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(opts.requestHeaders?.range || "");
      if (!range) return result("video/webm", clip);
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), clip.length - 1) : clip.length - 1;
      return { ...result("video/webm", clip.subarray(start, end + 1)), status: 206,
        acceptRanges: "bytes", contentRange: `bytes ${start}-${end}/${clip.length}` };
    }
    return { ...result("text/plain", "Not a fixture"), status: 404 };
  };
  const server = app.listen(0, "127.0.0.1");
  let browser;
  try {
    await once(server, "listening");
    browser = await chromium.launch({ executablePath: process.env.VEYRA_TEST_CHROMIUM_EXECUTABLE || undefined });
    const page = await browser.newPage();
    const direct = [];
    // No traffic from this test may leave the loopback proxy.
    await page.route("**/*", route => {
      if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
      direct.push(route.request().url());
      return route.abort();
    });
    const proxy = `http://127.0.0.1:${server.address().port}`;
    await page.goto(proxy + makeViewUrl(`${site}/demo`, "embed-media-browser-test"));
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#demo")).color === "rgb(1, 2, 3)");
    const player = page.frameLocator("#nested");
    assert.match(await player.locator("video").getAttribute("src"), /^\/api\/resource\?/);
    await player.getByRole("button", { name: "Play sample" }).click();
    const time = await player.locator("video").evaluate(video => new Promise((resolve, reject) => {
      const limit = setTimeout(() => reject(new Error(`Video stalled: ${video.error?.message || video.currentTime}`)), 5000);
      video.addEventListener("timeupdate", () => {
        if (video.currentTime < 0.15) return;
        clearTimeout(limit);
        resolve(video.currentTime);
      });
    }));
    assert.ok(time >= 0.15);
    assert.ok(seen.includes(css));
    assert.ok(!seen.includes(cssBase), "no request for the asset directory");
    assert.ok(seen.includes(media), "the complete signed video URL reached the proxy");
    assert.deepEqual(direct, [], "no asset escaped to a direct browser request");
  } finally {
    delete app.locals.veyraProxyFetchBuffer;
    await browser?.close();
    server.closeAllConnections();
    server.close();
  }
});
