"use strict";
const assert = require("assert");
const { createWebSearch } = require("./neural-search");
const { AIAnswerEngine } = require("./ai-answer");
const { VpnManager } = require("./vpn");

(async () => {
  const search = createWebSearch({
    env: { WEB_SEARCH_ORDER: "wikipedia" },
    fetchText: async url => ({ ok: true, text: JSON.stringify({ query: { searchinfo: { totalhits: 2 }, search: [
      { title: "Capital One", snippet: "Capital One financial services." },
      { title: "Capital of Wales", snippet: "Cardiff is the capital and largest city of Wales." }
    ] } }) }),
  });
  const found = await search.search("capital of Wales", { engine: "wikipedia", lang: "en" });
  assert.strictEqual(found.results[0].title, "Capital of Wales", "relevance ranking should prefer the matching title");
  assert(found.results.every(r => r.title !== "Capital One"), "unrelated results should be filtered");

  const ai = new AIAnswerEngine();
  const evidence = ai.buildEvidence("what is the capital of Wales", { type: "definition", subject: "capital of Wales" }, [], [
    { url: "https://example.com/css", title: "CSS", snippet: "ssrcss-1-Weather{font-family:Arial; display:block}" },
    { url: "https://example.com/nav", title: "Nav", snippet: "Jump to content Tools Tools move to sidebar hide Actions Read Edit View history" },
    { url: "https://example.com/cardiff", title: "Capital of Wales", snippet: "Cardiff is the capital of Wales." }
  ]);
  assert.strictEqual(evidence.length, 1, "CSS and navigation snippets must not become evidence");
  assert.strictEqual(evidence[0].title, "Capital of Wales");

  const vpn = new VpnManager(() => {}, { VPN_ENABLED: "1", VPN_PROXY_SERVER: "socks5://127.0.0.1:9" });
  const profile = vpn.get();
  vpn.health.get(profile.id).healthy = false;
  assert.throws(() => vpn.connect("fixed-bug-test", "auto"), /failing health checks/);
  assert.throws(() => vpn.connect("fixed-bug-test", profile.id), /unhealthy/);
  vpn.close();

  console.log("fixed-bug regressions: 3 passed");
})().catch(err => { console.error(err); process.exit(1); });
