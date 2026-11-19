"use strict";
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test } = require("node:test");
const { createYouTubeEligibility } = require("../src/services/youtube-eligibility");
const id = "42TV0hS59OA";
const response = status => ({ ok: true, json: async () => ({ items: [{ id, status }] }) });

test("checks only the fixed official Data API and deduplicates concurrent video checks", async () => {
  let calls = 0;
  const check = createYouTubeEligibility({ key: "fixture", request: async (url, options) => {
    calls++;
    assert.equal(url.origin + url.pathname, "https://www.googleapis.com/youtube/v3/videos");
    assert.equal(url.searchParams.get("id"), id);
    assert.equal(url.searchParams.get("part"), "id,status");
    assert.equal(url.searchParams.has("key"), false);
    assert.equal(options.headers["x-goog-api-key"], "fixture");
    assert.equal(options.redirect, "error");
    return response({ embeddable: true, madeForKids: false });
  } });
  assert.equal(await check("arbitrary url"), "invalid");
  assert.deepEqual(await Promise.all([check(id), check(id), check(id)]), ["ready", "ready", "ready"]);
  assert.equal(await check(id), "ready");
  assert.equal(calls, 1);
});

test("unsafe or unknown eligibility never enables the iframe", async () => {
  for (const [status, expected] of [
    [{ embeddable: true, madeForKids: true }, "external"],
    [{ embeddable: false, madeForKids: false }, "external"],
    [{ embeddable: true }, "unavailable"],
    [{ madeForKids: false }, "unavailable"],
    [null, "unavailable"]
  ]) {
    const check = createYouTubeEligibility({ key: "fixture", request: async () => response(status) });
    assert.equal(await check(id), expected);
  }
  assert.equal(await createYouTubeEligibility({ key: "", request: () => assert.fail("must stay offline") })(id), "unavailable");
  assert.equal(await createYouTubeEligibility({ key: "fixture", request: async () => ({ ok: false }) })(id), "unavailable");
});

test("fresh lookups are bounded across clients and the budget renews", async () => {
  let tick = 0, calls = 0;
  const check = createYouTubeEligibility({ key: "fixture", now: () => tick, request: async () => {
    calls++;
    return { ok: true, json: async () => ({ items: [] }) };
  } });
  for (let i = 0; i < 350; i++) assert.equal(await check(String(i).padStart(11, "0")), "external");
  assert.equal(await check(id), "unavailable");
  assert.equal(await check("00000000000"), "external");
  assert.equal(calls, 350);
  tick = 3_600_000;
  assert.equal(await check(id), "external");
  assert.equal(calls, 351);
});

test("the HTTP route works with no key and rejects invalid video IDs", async () => {
  process.env.YOUTUBE_DATA_API_KEY = "";
  const { app } = require("../src/server");
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}/api/media/youtube/`;
    const response = await fetch(base + id);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { state: "unavailable" });
    assert.equal((await fetch(base + "not-an-id")).status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
