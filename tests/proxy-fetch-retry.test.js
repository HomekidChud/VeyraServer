"use strict";
const assert = require("assert");
const { once } = require("node:events");
const { app, fetchBuffer, sessionManager } = require("../src/server");

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

  for (const status of [301, 302, 303, 307, 308]) {
    const steps = [];
    const final = await fetchBuffer("https://example.com/submit", {
      method: "POST", body: "field=fixture", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Bearer fixture" },
      retries: 0, dnsCache,
      upstreamFetch: async (url, request) => {
        steps.push(request);
        return steps.length === 1 ? stubResponse(status, { location: "https://93.184.216.34/result" }) : stubResponse(200, {}, "done");
      },
    });
    const keepPost = status === 307 || status === 308;
    assert.equal(final.status, 200);
    assert.equal(steps[0].method, "POST");
    assert.equal(steps[1].method, keepPost ? "POST" : "GET", `HTTP ${status} uses the standard redirect method`);
    assert.equal(steps[1].body, keepPost ? "field=fixture" : undefined);
    assert.equal(steps[1].headers.has("content-type"), keepPost);
    assert.equal(steps[1].headers.has("authorization"), false, "cross-origin redirects do not forward bearer credentials");
  }

  // Sanity: a hard failure with no redirect still surfaces the upstream error.
  await assert.rejects(
    fetchBuffer("https://example.com/always-down", {
      retries: 0,
      upstreamFetch: async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }); },
      dnsCache
    }),
    /refused|failed/i
  );

  // Exercise the real HTTP redirect into the path-shaped document lane.
  // A fixture supplies network outcomes without sending requests to a site.
  const sid = "escapedretryfixture1234";
  sessionManager.touch(sid);
  const callsByPath = new Map();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  app.locals.veyraProxyFetchBuffer = async target => {
    const path = new URL(target).pathname;
    const count = (callsByPath.get(path) || 0) + 1;
    callsByPath.set(path, count);
    if (path === "/denied") return { status: 403, finalUrl: target, contentType: "text/html", body: Buffer.from("<html><head></head><body>Denied by site</body></html>") };
    if (path !== "/" || count === 1) {
      throw Object.assign(new Error("fixture connection closed"), {
        code: "UPSTREAM_NETWORK_ERROR", upstreamCode: path === "/certificate" ? "CERT_HAS_EXPIRED" : "ECONNRESET"
      });
    }
    return { status: 200, finalUrl: target, contentType: "text/html", body: Buffer.from("<html><head></head><body>Recovered document</body></html>") };
  };
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { "sec-fetch-dest": "iframe", accept: "text/html" };
    const getDoc = path => fetch(`${base}/api/view?${new URLSearchParams({ url: "https://example.com" + path, sid })}`, { headers });
    const recovered = await getDoc("/");
    assert.equal(recovered.status, 200);
    assert.equal(new URL(recovered.url).pathname, "/");
    assert.match(await recovered.text(), /Recovered document/);
    assert.equal(callsByPath.get("/"), 2);

    const failed = await getDoc("/offline");
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).upstreamCode, "ECONNRESET");
    assert.equal(callsByPath.get("/offline"), 2, "retry is bounded");

    const denied = await getDoc("/denied");
    assert.equal(denied.status, 403);
    await denied.text();
    assert.equal(callsByPath.get("/denied"), 1, "respect the upstream denial");

    const cert = await getDoc("/certificate");
    assert.equal(cert.status, 502);
    await cert.json();
    assert.equal(callsByPath.get("/certificate"), 1, "do not retry a certificate failure");

    const post = new URL("/submit", base);
    post.search = new URLSearchParams({ __veyra_url: "https://example.com/submit", __veyra_sid: sid });
    const submitted = await fetch(post, { method: "POST", headers });
    assert.equal(submitted.status, 502);
    await submitted.json();
    assert.equal(callsByPath.get("/submit"), 1, "never retry a form submission in this lane");
  } finally {
    delete app.locals.veyraProxyFetchBuffer;
    await new Promise(resolve => server.close(resolve));
  }

  console.log("Proxy fetch retry, redirects, and escaped document regression tests passed");
})().catch(error => { console.error(error); process.exit(1); });
