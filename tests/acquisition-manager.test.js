"use strict";
const assert = require("assert");
const { AcquisitionManager, canonicalUrl } = require("../src/services/acquisition-manager");
const { BrowserEngine } = require("../src/browser/browser-engine");

(async () => {
  assert.equal(canonicalUrl("https://example.com/a?utm_source=x&keep=1#frag"), "https://example.com/a?keep=1");
  let calls = 0;
  const manager = new AcquisitionManager({
    assertPublicUrl: async () => {},
    cacheTtlMs: 60_000,
    fetchImpl: async (url) => {
      calls += 1;
      const body = url.endsWith("robots.txt") ? "User-agent: *\nAllow: /" : "<html><title>Veyra</title><main>Hello acquisition world</main></html>";
      return new Response(body, { status: 200, headers: { "content-type": url.endsWith("robots.txt") ? "text/plain" : "text/html" } });
    }
  });
  const first = await manager.fetch("https://example.com/page?utm_medium=test");
  const second = await manager.fetch("https://example.com/page");
  assert.equal(first.status, 200);
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 2, "robots and page should be fetched once each");
  assert.equal(manager.parseDocument(first.body, first.url).title, "Veyra");

  const disabled = new BrowserEngine({ browserEnabled: false }, async () => {}, () => {});
  await assert.rejects(() => disabled.ensureBrowser(), error => error.code === "BROWSER_ENGINE_UNAVAILABLE");
  console.log("Acquisition manager and Chromium opt-in tests passed");
})().catch(error => { console.error(error); process.exit(1); });
