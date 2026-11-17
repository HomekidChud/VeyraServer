"use strict";
// Regression tests for the expanded public platform API (/api/v1):
// status, verify, keys listing/detail, hourly usage buckets, search,
// suggestions and the URL-fetch endpoint. Live end-to-end pass against the
// real express app with an isolated stub for upstream fixture responses.
process.env.VEYRA_ENV = "test";
process.env.VEYRA_TEST_MODE = "true";
process.env.VEYRA_FRONTEND_URL = "https://example.com/web/";
process.env.VEYRA_DATA_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "veyra-devapi-"));
const assert = require("assert");

(async () => {
  const upstream = require("undici");
  const originalFetch = upstream.fetch;
  const fixtureBase = "https://93.184.216.34";
  const textLimit = 256 * 1024;
  const fixtures = new Map([
    [fixtureBase + "/json-null", () => new Response("null", { headers: { "content-type": "application/json" } })],
    [fixtureBase + "/json-too-long", () => new Response("null", { headers: { "content-type": "application/json", "content-length": "100000000" } })],
    [fixtureBase + "/text-too-long", () => new Response("é".repeat(textLimit), { headers: { "content-type": "text/plain" } })],
    [fixtureBase + "/exact-limit", () => new Response("a".repeat(textLimit), { headers: { "content-type": "text/plain" } })],
  ]);
  upstream.fetch = async url => {
    const fixture = fixtures.get(String(url));
    assert.ok(fixture, `Unexpected upstream URL: ${url}`);
    return fixture();
  };
  let app;
  try { ({ app } = require("../src/server")); }
  finally { upstream.fetch = originalFetch; }
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchJson = async (path, init = {}) => {
    const r = await fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };

  try {
    // ---- public status endpoint (no key) ----
    const status = await fetchJson("/api/v1/status");
    assert.equal(status.status, 200);
    assert.equal(status.json.ok, true);
    assert.equal(status.json.api, "veyra");
    assert.ok(status.json.version, "status reports the API version");
    assert.equal(status.json.rateLimit.max, 120, "status documents the rate limit");
    assert.equal(status.json.docs, "https://example.com/web/dev/platform/");

    // ---- key required everywhere else ----
    for (const path of ["/api/v1/verify", "/api/v1/keys", "/api/v1/usage/hours", "/api/v1/search?q=x", "/api/v1/suggest?q=x"]) {
      const r = await fetchJson(path);
      assert.equal(r.status, 401, `${path} requires a key`);
      assert.equal(r.json.code, "PLATFORM_KEY_REQUIRED");
    }
    const fetchNoKey = await fetchJson("/api/v1/fetch", { method: "POST", body: JSON.stringify({ url: "https://example.com/" }) });
    assert.equal(fetchNoKey.status, 401, "fetch requires a key");

    // ---- sign up, set up billing, create a workspace + key ----
    const email = `devapi-${Date.now()}@example.com`, password = "DevApiTest2026!";
    const signup = await fetchJson("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password, name: "Dev Api" }) });
    assert.equal(signup.status, 201);
    const token = signup.json.token;
    const authHeaders = { Authorization: `Bearer ${token}` };
    const billing = await fetchJson("/api/platform/billing/setup", { method: "POST", headers: authHeaders, body: JSON.stringify({ billingEmail: email }) });
    assert.equal(billing.status, 200);
    const created = await fetchJson("/api/platform/workspaces", { method: "POST", headers: authHeaders, body: JSON.stringify({ name: "Api Test Workspace" }) });
    assert.equal(created.status, 201);
    const ws = created.json.workspace;
    const keyCreated = await fetchJson(`/api/platform/workspaces/${ws.id}/keys`, { method: "POST", headers: authHeaders, body: JSON.stringify({ name: "Test key" }) });
    assert.equal(keyCreated.status, 201);
    const key = keyCreated.json.key;

    // ---- verify ----
    const verify = await fetchJson("/api/v1/verify", { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(verify.status, 200);
    assert.equal(verify.json.valid, true);
    assert.equal(verify.json.workspace.slug, "api-test-workspace");
    assert.ok(verify.json.usage.requests >= 1, "verify counts towards usage");

    // ---- keys listing + detail ----
    const keys = await fetchJson("/api/v1/keys", { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(keys.status, 200);
    assert.equal(keys.json.total, 1);
    assert.equal(keys.json.keys[0].name, "Test key");
    assert.ok(!keys.json.keys[0].hash, "hashed secrets never leave the server");
    const keyDetail = await fetchJson(`/api/v1/keys/${keys.json.keys[0].id}`, { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(keyDetail.status, 200);
    assert.equal(keyDetail.json.key.last4, key.slice(-4));
    const keyMissing = await fetchJson("/api/v1/keys/00000000-0000-4000-8000-000000000000", { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(keyMissing.status, 404);
    assert.equal(keyMissing.json.code, "API_KEY_NOT_FOUND");

    // ---- usage + hourly buckets ----
    const usage = await fetchJson("/api/v1/usage", { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(usage.status, 200);
    assert.ok(usage.json.usage.requests >= 3, "each authenticated call is counted");
    const hours = await fetchJson("/api/v1/usage/hours", { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(hours.status, 200);
    assert.equal(Object.keys(hours.json.hours).length, 24, "exactly 24 hourly buckets");
    const currentHour = new Date().toISOString().slice(0, 13) + ":00:00Z";
    assert.ok(hours.json.hours[currentHour] >= 1, "the current hour includes this request");

    // ---- search + suggest (index may be empty; envelope must be right) ----
    const search = await fetchJson("/api/v1/search?q=veyra", { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(search.status, 200);
    assert.ok(Array.isArray(search.json.results), "search returns a results array");
    const searchNoQuery = await fetchJson("/api/v1/search", { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(searchNoQuery.status, 400);
    assert.equal(searchNoQuery.json.code, "SEARCH_QUERY_REQUIRED");
    const suggest = await fetchJson("/api/v1/suggest?q=vey", { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(suggest.status, 200);
    assert.ok(Array.isArray(suggest.json.suggestions));

    // ---- fetch endpoint: validation + SSRF guard (network-free) ----
    const fetchBad = await fetchJson("/api/v1/fetch", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ url: "not a url" }) });
    assert.equal(fetchBad.status, 400);
    assert.equal(fetchBad.json.code, "FETCH_URL_INVALID");
    const fetchPrivate = await fetchJson("/api/v1/fetch", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ url: "http://127.0.0.1:9/" }) });
    assert.equal(fetchPrivate.status, 502);
    assert.equal(fetchPrivate.json.code, "FETCH_FAILED");
    assert.match(fetchPrivate.json.error, /Private\/local destinations are blocked/, "the fetch endpoint reuses the proxy's SSRF guards");

    const postFetch = (path, format = "text") => fetchJson("/api/v1/fetch", {
      method: "POST", headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ url: fixtureBase + path, format }),
    });
    const nullJson = await postFetch("/json-null", "json");
    assert.equal(nullJson.status, 200);
    assert.equal(nullJson.json.json, null, "JSON null is a valid result");
    const tooLongJson = await postFetch("/json-too-long", "json");
    assert.equal(tooLongJson.status, 422);
    assert.equal(tooLongJson.json.code, "FETCH_NOT_JSON");
    assert.match(tooLongJson.json.error, /size limit/);
    const tooLongText = await postFetch("/text-too-long");
    assert.equal(tooLongText.status, 200);
    assert.equal(tooLongText.json.truncated, true, "the limit is measured in bytes, not characters");
    const exactText = await postFetch("/exact-limit");
    assert.equal(exactText.status, 200);
    assert.equal(exactText.json.body.length, textLimit);
    assert.equal(exactText.json.truncated, false, "a complete result at exactly the limit is not truncated");

    // ---- usage counted across all endpoints ----
    const verify2 = await fetchJson("/api/v1/verify", { headers: { Authorization: `Bearer ${key}` } });
    assert.ok(verify2.json.usage.requests > verify.json.usage.requests, "usage grows with every call");
  } finally {
    server.close();
  }

  console.log("dev-platform-api.test.js — all assertions passed");
})().catch(err => { console.error(err); process.exit(1); });
