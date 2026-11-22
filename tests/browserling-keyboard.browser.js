"use strict";

// VEYRA_TEST_CHROMIUM_EXECUTABLE=/path/to/chrome node --test tests/browserling-keyboard.browser.js
// Exercises the Fast Proxy's keyboard bridge without a Browserling account or guest session.
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test } = require("node:test");
const { chromium } = require("playwright");

process.env.VEYRA_CHROMIUM_ENABLED = "false";
process.env.GATE_ENABLED = "false";
const { app, makeViewUrl } = require("../src/server");

const remotePage = `<!doctype html>
  <input aria-label="Remote URL">
  <div class="view-screen" tabindex="0"><canvas width="160" height="90"></canvas></div>
  <output id="keys"></output>
  <script>
    const screenWrapper = document.querySelector(".view-screen");
    for (const type of ["keydown", "keyup"]) {
      screenWrapper.addEventListener(type, event => {
        if (event.key === "Control") return;
        document.querySelector("#keys").textContent += type + ":" + event.key + " ";
        event.preventDefault();
      });
    }
  </script>`;

test("Browserling's focused remote screen receives shortcuts while other Veyra pages still forward them", async () => {
  const guest = "https://www.browserling.com/browse/win10/chrome156/https%3A%2F%2Fexample.com%2F";
  const cases = [
    { url: guest, remote: true },
    { url: guest.replace("www.", ""), remote: true },
    { url: "https://www.browserling.com/", remote: false },
    { url: "https://example.com/browse/win10/chrome156/", remote: false }
  ];
  app.locals.veyraProxyFetchBuffer = async target => ({
    status: cases.some(({ url }) => target === url) ? 200 : 404,
    finalUrl: target,
    contentType: "text/html",
    body: Buffer.from(remotePage),
    cacheControl: "no-store"
  });
  const server = app.listen(0, "127.0.0.1");
  let browser;
  try {
    await once(server, "listening");
    browser = await chromium.launch({ executablePath: process.env.VEYRA_TEST_CHROMIUM_EXECUTABLE || undefined });
    const page = await browser.newPage();
    page.setDefaultTimeout(3500);
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin !== origin) return route.abort();
      if (new URL(route.request().url()).pathname !== "/keyboard-shell") return route.continue();
      return route.fulfill({ contentType: "text/html", body: `<!doctype html>
        <output id="forwarded"></output><output id="ready"></output>
        <script>
          window.addEventListener("message", event => {
            if (event.data?.type === "veyra:embed-ping") {
              event.source.postMessage({ type: "veyra:embed-ack" }, event.origin);
              document.querySelector("#ready").textContent = "ready";
            }
            if (event.data?.type === "veyra:shortcut") {
              document.querySelector("#forwarded").textContent += event.data.key + " ";
            }
          });
        </script><iframe title="Proxied tab"></iframe>` });
    });
    for (const { url, remote } of cases) {
      await page.goto(`${origin}/keyboard-shell`);
      await page.locator("iframe").evaluate((iframe, src) => { iframe.src = src; }, makeViewUrl(url, "browserling-keyboard-test"));
      await page.waitForFunction(() => document.querySelector("#ready").textContent === "ready");
      const frame = page.frameLocator("iframe");
      const canvas = frame.locator(".view-screen canvas");
      await canvas.click();
      await page.waitForFunction(() => document.querySelector("iframe").contentDocument.activeElement.classList.contains("view-screen"));
      await canvas.press("Control+l");
      if (remote) {
        assert.equal(await frame.locator("#keys").textContent(), "keydown:l keyup:l ", url);
        assert.equal(await page.locator("#forwarded").textContent(), "");
        await frame.getByRole("textbox", { name: "Remote URL" }).press("Control+l");
      }
      await page.waitForFunction(() => document.querySelector("#forwarded").textContent === "l ");
      assert.equal(await frame.locator("#keys").textContent(), remote ? "keydown:l keyup:l " : "keyup:l ", url);
    }
  } finally {
    delete app.locals.veyraProxyFetchBuffer;
    await browser?.close();
    server.closeAllConnections();
    server.close();
  }
});
