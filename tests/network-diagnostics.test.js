"use strict";
const assert = require("assert");
const { runDiagnostics } = require("../scripts/network-diagnostics");

(async () => {
  const lookup = async (host, options) => {
    if (options.family === 6 && host === "www.google.com") return [{ address: "2001:4860:4860::8888", family: 6 }];
    return [{ address: "8.8.8.8", family: 4 }];
  };
  const fetchImpl = async url => {
    if (url.includes("api4.ipify")) return new Response("203.0.113.44", { status: 200 });
    if (url.includes("api6.ipify")) throw Object.assign(new Error("No IPv6 route"), { code: "ENETUNREACH" });
    if (url.includes("google.com/search")) return new Response("unusual traffic from your computer network", { status: 200 });
    if (url.includes("bing.com/search")) return new Response("results", { status: 200 });
    return new Response("anomaly-modal", { status: 429 });
  };
  const result = await runDiagnostics({ fetchImpl, lookup, env: { EXPECTED_EGRESS_IP: "203.0.113.44", GOOGLE_SEARCH_API_KEY: "test", GOOGLE_SEARCH_CX: "test" }, route: "direct" });
  assert.equal(result.connectivity.directIpv4.ok, true);
  assert.equal(result.connectivity.directIpv4.address, "203.0.113.44");
  assert.equal(result.connectivity.directIpv6.ok, false);
  assert.equal(result.connectivity.expectedEgress.matchesDirectIpv4, true);
  assert.equal(result.ipClassification.residential, "not-classified");
  assert.equal(result.tlsAndProvider.googleSearchHtml.classification, "challenge");
  assert.equal(result.tlsAndProvider.duckDuckGoHtml.classification, "challenge");
  assert.equal(result.tlsAndProvider.googleCustomSearchApiConfigured, true);
  assert.equal(JSON.stringify(result).includes("test"), false, "secrets must not appear in diagnostics output");
  console.log("Network diagnostics mock regression tests passed");
})().catch(error => { console.error(error); process.exit(1); });
