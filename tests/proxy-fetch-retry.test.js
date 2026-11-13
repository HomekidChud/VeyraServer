"use strict";
const assert = require("assert");
const { fetchBuffer } = require("../src/server");

// Minimal stand-in for undici's Response covering the surface fetchBuffer
// reads: status, headers.get(), and a body via arrayBuffer().
class StubHeaders {
  constructor(entries = []) { this.map = new Map(entries.map(([k, v]) => [String(k).toLowerCase(), String(v)])); }
  get(name) { return this.map.has(String(name).toLowerCase()) ? this.map.get(String(name).toLowerCase()) : null; }
}
function stubResponse(status, headers = {}, bodyText = "") {
  return {
    status,
    headers: new StubHeaders(Object.entries(headers)),
    body: null,
    // TextEncoder allocates a standalone (non-pooled) buffer, unlike
    // Buffer.from(), whose .buffer is a shared 8KB pool slice.
    async arrayBuffer() { return new TextEncoder().encode(bodyText).buffer; }
  };
}

// A fake DNS cache so assertPublicUrl never touches the network: the host is
// pre-resolved to a public address inside the cache TTL.
const dnsCache = new Map([
  ["example.com", { time: Date.now(), records: [{ address: "93.184.216.34", family: 4 }] }]
]);

(async () => {
  // Regression: an upstream that fails once with a retryable error, then
  // answers with a redirect, used to throw the stale first-attempt error
  // instead of following the redirect. Any real site that flaps once and
  // then redirects (extremely common) failed to load through the proxy.
  const calls = [];
  let failFirst = true;
  const upstreamFetch = async (url) => {
    calls.push(url);
    if (url === "https://example.com/start") {
      if (failFirst) {
        failFirst = false;
        throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
      }
      return stubResponse(302, { location: "/landing" });
    }
    return stubResponse(200, { "content-type": "text/html" }, "landed");
  };

  const result = await fetchBuffer("https://example.com/start", {
    retries: 1,
    upstreamFetch,
    dnsCache
  });

  assert.equal(result.status, 200, "the redirect target must be fetched");
  assert.equal(result.finalUrl, "https://example.com/landing", "the redirect must be followed");
  assert.ok(Buffer.isBuffer(result.body));
  assert.equal(result.body.toString("utf8"), "landed");
  assert.equal(result.redirectChain.length, 1, "the 302 must be recorded in the redirect chain");
  assert.deepEqual(
    calls,
    ["https://example.com/start", "https://example.com/start", "https://example.com/landing"],
    "the failed attempt must be retried, then the redirect followed"
  );

  // Sanity: a hard failure with no redirect still surfaces the upstream error.
  await assert.rejects(
    fetchBuffer("https://example.com/always-down", {
      retries: 0,
      upstreamFetch: async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }); },
      dnsCache
    }),
    /refused|failed/i
  );

  console.log("Proxy fetch retry/redirect regression tests passed");
})().catch(error => { console.error(error); process.exit(1); });
