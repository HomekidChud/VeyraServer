"use strict";
const assert = require("assert");
const { createWebSearch } = require("../src/services/websearch");

(async () => {
  const search = createWebSearch({
    env: {},
    fetchText: async () => ({ ok: true, status: 200, text: "" })
  });
  const result = await search.search("Veyra browser", { engine: "google", lang: "en" });
  assert.equal(result.provider, "none");
  assert.equal(result.results.length, 0);
  assert.equal(result.attempts[0].provider, "google");
  assert.equal(result.attempts[0].skipped, "not-configured");
  console.log("Explicit Google configuration regression test passed");
})().catch(error => { console.error(error); process.exit(1); });
