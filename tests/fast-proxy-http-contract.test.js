"use strict";
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.VEYRA_ENV = "test";
process.env.VEYRA_DEV_API_ONLY = "false";
process.env.FRONTEND_ORIGIN = "https://app.example.com";
process.env.MAX_DOWNLOAD_BYTES = String(256 * 1024);
process.env.VEYRA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-proxy-contract-"));
const { app, fetchBuffer, sessionManager } = require("../src/server");
const origin = "https://example.com";
const otherOrigin = "https://example.org";
const dnsCache = new Map(["example.com", "example.org"].map(host => [host, {
  time: Date.now(), records: [{ address: "93.184.216.34", family: 4 }]
}]));

async function upstreamContract() {
  for (const [status, method, redirectedMethod] of [
    [301, "POST", "GET"], [302, "POST", "GET"], [303, "PUT", "GET"],
    [307, "POST", "POST"], [308, "PATCH", "PATCH"], [303, "HEAD", "HEAD"]
  ]) {
    const seen = [];
    const body = method === "HEAD" ? undefined : Buffer.from("colour=plum");
    const headers = body ? { "Content-Type": "application/x-www-form-urlencoded" } : {};
    const result = await fetchBuffer(origin + "/first", {
      dnsCache, method, body, headers,
      upstreamFetch: async (url, req) => {
        seen.push({ method: req.method, body: req.body, contentType: req.headers.get("content-type") });
        return seen.length === 1 ? new Response(null, { status, headers: { location: "/final" } })
          : new Response(method === "HEAD" ? null : "done");
      }
    });
    assert.equal(result.finalUrl, origin + "/final");
    assert.equal(seen[0].method, method);
    assert.equal(seen[1].method, redirectedMethod);
    assert.equal(seen[1].body, method === redirectedMethod ? body : undefined);
    assert.equal(seen[1].contentType, body && method === redirectedMethod ? headers["Content-Type"] : null);
  }

  const observed = [];
  await fetchBuffer(origin + "/start", {
    dnsCache,
    headers: { Authorization: "Bearer synthetic-fixture", "X-API-Key": "fixture-only", Accept: "application/json" },
    upstreamFetch: async (url, req) => {
      observed.push(req.headers);
      if (observed.length === 1) return new Response(null, { status: 302, headers: { location: "/same-origin" } });
      if (observed.length === 2) return new Response(null, { status: 302, headers: { location: otherOrigin + "/final" } });
      return new Response("{}");
    }
  });
  assert.equal(observed[1].get("authorization"), "Bearer synthetic-fixture");
  assert.equal(observed[2].has("authorization"), false);
  assert.equal(observed[2].has("x-api-key"), false);
  assert.equal(observed[2].get("accept"), "application/json");

  let writes = 0;
  const writeResponse = await fetchBuffer(origin + "/submit", {
    dnsCache, method: "POST", body: "colour=plum", retries: 3,
    upstreamFetch: async () => { writes++; return new Response("unavailable", { status: 503 }); }
  });
  assert.equal(writeResponse.status, 503);
  assert.equal(writes, 1);
  await assert.rejects(fetchBuffer(origin + "/submit", {
    dnsCache, method: "PATCH", body: "colour=plum", retries: 3,
    upstreamFetch: async () => { writes++; throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }); }
  }), { code: "UPSTREAM_NETWORK_ERROR" });
  assert.equal(writes, 2, "neither a 503 nor an interrupted connection replays the write");

  const abort = new AbortController();
  let reads = 0;
  let discarded = false;
  await assert.rejects(fetchBuffer(origin + "/retry", {
    dnsCache, signal: abort.signal, retries: 2,
    upstreamFetch: async () => {
      reads++;
      setImmediate(() => abort.abort());
      return new Response(new ReadableStream({ cancel() { discarded = true; } }), { status: 503, headers: { "retry-after": "2" } });
    }
  }), { code: "OPERATION_CANCELLED" });
  assert.equal(reads, 1);
  assert.equal(discarded, true);

  const largeHead = await fetchBuffer(origin + "/head", {
    dnsCache, method: "HEAD", limit: 32,
    upstreamFetch: async () => new Response(null, {
      headers: { "Content-Type": "application/octet-stream", "Content-Length": "1000000" }
    })
  });
  assert.equal(largeHead.tooLarge, false);
  assert.equal(largeHead.contentLength, "1000000");
  assert.equal(largeHead.body.length, 0);
}

async function routeContract() {
  const sid = "http-contract-fixture-01";
  sessionManager.touch(sid);
  const calls = [];
  const css = "body{background:url('/image.svg')}".repeat(80);
  let eventSource;
  let eventCanceled = false;
  app.locals.veyraProxyFetchBuffer = async (url, options) => {
    calls.push({ url, options });
    const at = new URL(url).pathname;
    const common = { finalUrl: url, status: 200, cacheControl: "no-store", body: Buffer.alloc(0) };
    if (options.method === "OPTIONS") return { ...common, status: 204, allow: "GET, HEAD, OPTIONS", contentType: "" };
    if (options.method === "HEAD") return { ...common, contentType: "application/octet-stream", contentLength: "1000000" };
    if (at === "/conditional") return { ...common, status: 304, etag: '"fixture"', contentType: "text/css" };
    if (at === "/partial") return { ...common, status: 206, contentType: "text/css", contentRange: "bytes 0-3071/4096", body: Buffer.from(css.padEnd(3072, " ")) };
    if (at === "/events") return fetchBuffer(url, { ...options, dnsCache, upstreamFetch: async () =>
      new Response(new ReadableStream({
        start(controller) { eventSource = controller; controller.enqueue(Buffer.from("id: 8\ndata: ready\n\n")); },
        cancel() { eventCanceled = true; }
      }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } })
    });
    if (at === "/chunked-download") return fetchBuffer(url, { ...options, dnsCache, limitForContentType: () => 1024, upstreamFetch: async () =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.alloc(200000, 1));
          controller.enqueue(Buffer.alloc(100000, 2));
          controller.close();
        }
      }), { headers: { "Content-Type": "application/octet-stream" } })
    });
    if (at === "/style.css") return { ...common, contentType: "text/css", body: Buffer.from(css) };
    return { ...common, contentType: "text/html", body: Buffer.from("<html><head></head><body>Form received</body></html>") };
  };
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const proxyUrl = (route, upstreamPath) => `${base}/api/${route}?${new URLSearchParams({ url: origin + upstreamPath, sid })}`;
  try {
    const token = value => Buffer.from(value).toString("base64url");
    const form = await fetch(`${base}/api/form-get/${token(origin + "/find?lang=en")}/${token(sid)}?q=red&category=fruit&q=plum&url=notes&download=1`);
    assert.equal(form.status, 200);
    assert.match(await form.text(), /Form received/);
    assert.equal(form.headers.get("content-disposition"), null);
    assert.equal(calls.at(-1).options.sessionId, sid);
    assert.deepEqual([...new URL(calls.at(-1).url).searchParams], [
      ["lang", "en"], ["q", "red"], ["category", "fruit"], ["q", "plum"], ["url", "notes"], ["download", "1"]
    ]);
    const filters = await fetch(proxyUrl("resource", "/filters?q=red") + "&q=red&category=fruit&q=plum&q=plum");
    assert.equal(filters.status, 200);
    await filters.text();
    assert.deepEqual([...new URL(calls.at(-1).url).searchParams], [
      ["q", "red"], ["category", "fruit"], ["q", "plum"], ["q", "plum"]
    ]);

    const download = await fetch(proxyUrl("download", "/style.css"));
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition"), /^attachment;/i);
    assert.equal(await download.text(), css, "downloaded CSS is not rewritten");

    const resource = proxyUrl("resource", "/style.css");
    const preflight = await fetch(resource, {
      method: "OPTIONS", headers: { Origin: "https://app.example.com", "Access-Control-Request-Method": "GET" }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.equal(calls.at(-1).options.method, "GET", "preflight stays at the proxy");
    const options = await fetch(resource, { method: "OPTIONS", headers: { Origin: "https://app.example.com" } });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("allow"), "GET, HEAD, OPTIONS");
    assert.equal(calls.at(-1).options.method, "OPTIONS");

    const full = await fetch(resource, { headers: { Origin: "https://app.example.com", "Accept-Encoding": "gzip" } });
    assert.equal(full.headers.get("content-encoding"), "gzip");
    const vary = full.headers.get("vary").toLowerCase().split(",").map(x => x.trim());
    assert.ok(vary.includes("origin") && vary.includes("accept-encoding"));
    await full.arrayBuffer();

    const partial = await fetch(proxyUrl("resource", "/partial"), { headers: { Range: "bytes=0-3071", "Accept-Encoding": "gzip" } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), "bytes 0-3071/4096");
    assert.equal(partial.headers.get("content-encoding"), null);
    assert.equal(await partial.text(), css.padEnd(3072, " "), "206 offsets describe the original representation");

    const head = await fetch(proxyUrl("resource", "/archive"), { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "1000000");
    assert.equal(await head.text(), "");
    const conditional = await fetch(proxyUrl("resource", "/conditional"), { headers: { "If-None-Match": '"fixture"' } });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.headers.get("etag"), '"fixture"');
    assert.equal(await conditional.text(), "");

    const events = await fetch(proxyUrl("resource", "/events"), {
      signal: AbortSignal.timeout(4000), headers: { Accept: "text/event-stream", "Last-Event-ID": "7" }
    });
    assert.equal(events.status, 200);
    assert.match(events.headers.get("content-type"), /^text\/event-stream/);
    assert.equal(events.headers.get("x-accel-buffering"), "no");
    assert.equal(calls.at(-1).options.headers["last-event-id"], "7");
    const eventsReader = events.body.getReader();
    assert.equal(new TextDecoder().decode((await eventsReader.read()).value), "id: 8\ndata: ready\n\n");
    assert.ok(eventSource, "first event arrived before the upstream was finished");
    await eventsReader.cancel();
    for (let i = 0; i < 30 && !eventCanceled; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(eventCanceled, true, "disconnect releases the upstream event stream");

    // The unknown-length download has already begun when it exceeds the cap.
    // The connection must close; it cannot replace the sent 200 with a 413.
    let bytesSeen = 0;
    await assert.rejects(async () => {
      const chunked = await fetch(proxyUrl("download", "/chunked-download"));
      for await (const chunk of chunked.body) bytesSeen += chunk.byteLength;
    });
    assert.ok(bytesSeen <= 256 * 1024);

    for (const [body, status, code] of [
      ["{", 400, "INVALID_REQUEST_BODY"],
      [JSON.stringify({ text: "x".repeat(256 * 1024) }), 413, "REQUEST_BODY_TOO_LARGE"]
    ]) {
      const invalid = await fetch(`${base}/api/v1/fetch`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      assert.equal(invalid.status, status);
      assert.equal((await invalid.json()).code, code);
    }
  } finally {
    delete app.locals.veyraProxyFetchBuffer;
    await new Promise(resolve => server.close(resolve));
  }
}

(async () => {
  await upstreamContract();
  await routeContract();
  console.log("Fast Proxy HTTP contracts passed: forms, downloads, safe retries, redirects, CORS, ranges, HEAD, 304 and SSE.");
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(process.env.VEYRA_DATA_DIR, { recursive: true, force: true }));
