const assert = require("assert");
const zlib = require("zlib");
const { maybeCompressProxyPayload, proxyCompressibleContentType } = require("../src/server");

(async () => {
  // Content-type gating: text/JS/JSON payloads are compressible, binaries are not.
  assert.equal(proxyCompressibleContentType("text/html; charset=utf-8"), true);
  assert.equal(proxyCompressibleContentType("text/css"), true);
  assert.equal(proxyCompressibleContentType("application/javascript"), true);
  assert.equal(proxyCompressibleContentType("application/json"), true);
  assert.equal(proxyCompressibleContentType("image/png"), false);
  assert.equal(proxyCompressibleContentType("video/mp4"), false);
  assert.equal(proxyCompressibleContentType(""), false);

  const html = "<!doctype html><body>" + "veyra page bytes ".repeat(2000) + "</body></html>";
  const payload = Buffer.from(html, "utf8");

  // No Accept-Encoding header -> served uncompressed.
  assert.equal(await maybeCompressProxyPayload({ headers: {} }, payload, "text/html"), null);

  // Tiny payloads are not worth compressing.
  assert.equal(await maybeCompressProxyPayload({ headers: { "accept-encoding": "gzip, br" } }, Buffer.from("tiny page"), "text/html"), null);

  // Non-buffer payloads are skipped.
  assert.equal(await maybeCompressProxyPayload({ headers: { "accept-encoding": "gzip" } }, html, "text/html"), null);

  // gzip path round-trips.
  const gz = await maybeCompressProxyPayload({ headers: { "accept-encoding": "gzip" } }, payload, "text/html");
  assert.ok(gz, "gzip compression expected");
  assert.equal(gz.encoding, "gzip");
  assert.ok(gz.body.length < payload.length, "compressed payload must be smaller");
  assert.equal(zlib.gunzipSync(gz.body).toString("utf8"), html, "gzip round-trip must be lossless");

  // Brotli is supported, and the client's preference is respected.
  const br = await maybeCompressProxyPayload({ headers: { "accept-encoding": "br, gzip, deflate" } }, payload, "text/html");
  assert.ok(br, "brotli compression expected");
  assert.equal(br.encoding, "br");
  assert.equal(zlib.brotliDecompressSync(br.body).toString("utf8"), html, "brotli round-trip must be lossless");
  assert.equal((await maybeCompressProxyPayload({ headers: { "accept-encoding": "br;q=0, gzip;q=0.8" } }, payload, "text/html")).encoding, "gzip");
  assert.equal((await maybeCompressProxyPayload({ headers: { "accept-encoding": "br;q=0.1, gzip;q=0.9" } }, payload, "text/html")).encoding, "gzip");
  assert.equal(await maybeCompressProxyPayload({ headers: { "accept-encoding": "br;q=0, gzip;q=0" } }, payload, "text/html"), null);

  // Binary content types are never compressed even when accepted.
  assert.equal(await maybeCompressProxyPayload({ headers: { "accept-encoding": "gzip, br" } }, payload, "image/png"), null);

  console.log("Proxy response compression tests passed");
})().catch(e => { console.error(e); process.exit(1); });
