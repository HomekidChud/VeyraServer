"use strict";
const assert = require("node:assert/strict");

process.env.VEYRA_CHROMIUM_ENABLED = "true";
const { app, CFG } = require("../src/server");

(async () => {
  assert.equal(CFG.browserEnabled, true, "the Chromium opt-in should be read from the environment");
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const [acquisitionResponse, browserResponse] = await Promise.all([
      fetch(`${base}/api/acquisition/status`),
      fetch(`${base}/api/browser/status`)
    ]);
    const [acquisition, browser] = await Promise.all([
      acquisitionResponse.json(),
      browserResponse.json()
    ]);
    assert.equal(acquisitionResponse.status, 200);
    assert.equal(acquisition.chromiumEnabled, true, "acquisition status must not overwrite the configured Chromium flag");
    assert.equal(browserResponse.status, 200);
    assert.equal(browser.enabled, true, "the browser status endpoint should agree with acquisition status");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log("VeyraServer Chromium status route checks passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
