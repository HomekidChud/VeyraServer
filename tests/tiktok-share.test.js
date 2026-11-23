"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveTikTokShare } = require("../src/services/tiktok-share");

test("reads only allowlisted short-link HEADs, stopping before the post", async () => {
  const seen = [];
  const result = await resolveTikTokShare("https://vm.tiktok.com/AbC/?track=secret#fragment", { request: async (url, options) => {
    assert.equal(options.method, "HEAD");
    assert.equal(options.redirect, "manual");
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers, undefined);
    seen.push(url);
    return new Response(null, { status: 302, headers: { Location: seen.length === 1
      ? "https://m.tiktok.com/t/NewCode/?tracking=123" : "/@artist/photo/1234567890123456/?track=post" } });
  } });
  assert.deepEqual(seen, ["https://vm.tiktok.com/AbC/", "https://m.tiktok.com/t/NewCode/"]);
  assert.deepEqual(result, { state: "resolved", url: "https://www.tiktok.com/@artist/photo/1234567890123456" });
});

test("never follows other hosts, challenge paths, downgraded URLs or loops", async () => {
  for (const value of ["https://vt.tiktok.com.evil.test/AbC/", "http://vt.tiktok.com/AbC/",
    "https://name@www.tiktok.com/t/AbC/", "https://www.tiktok.com:123/t/AbC/", "/t/AbC/",
    "https://www.tiktok.com/@artist/video/1234567890123456"]) {
    assert.deepEqual(await resolveTikTokShare(value, { request: async () => assert.fail(value) }), { state: "invalid" });
  }
  for (const location of ["https://example.com/AbC/", "/challenge?continue=/AbC", "http://vm.tiktok.com/AbC",
    "https://vm.tiktok.com/AbC/"]) {
    let hits = 0;
    const result = await resolveTikTokShare("https://vm.tiktok.com/AbC/", { request: async () => {
      hits++;
      return new Response(null, { status: 301, headers: { Location: location } });
    } });
    assert.deepEqual(result, { state: "unavailable" });
    assert.equal(hits, 1);
  }
});

test("limits redirect hops and respects caller cancellation", async () => {
  let hits = 0;
  const request = async () => new Response(null, { status: 302, headers: { Location: `/hop${++hits}` } });
  assert.deepEqual(await resolveTikTokShare("https://vt.tiktok.com/start", { request }), { state: "unavailable" });
  assert.equal(hits, 3);
  assert.deepEqual(await resolveTikTokShare("https://vt.tiktok.com/start", { request, signal: AbortSignal.abort() }), { state: "unavailable" });
  assert.equal(hits, 3);
});
