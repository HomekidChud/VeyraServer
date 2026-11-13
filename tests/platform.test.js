"use strict";
// Platform tests: API key hashing at rest, usage tracking on the key-authenticated
// public API (/api/v1), rate limiting, and input validation across the developer
// platform routes. Runs a live end-to-end pass against the real express app.
process.env.VEYRA_ENV = "test";
process.env.VEYRA_TEST_MODE = "true";
process.env.VEYRA_DATA_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "veyra-platform-"));
const assert = require("assert");

(async () => {
  const { app } = require("../src/server");
  assert.ok(app, "express app exported");
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
  const authHeaders = token => ({ Authorization: `Bearer ${token}` });

  try {
    // ---- sign up a normal developer account ----
    const email = `dev-${Date.now()}@example.com`, password = "PlatformTest2026!";
    const signup = await fetchJson("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password, name: "Platform Dev" }) });
    assert.equal(signup.status, 201);
    const token = signup.json.token;

    // ---- overview: empty platform ----
    const overview = await fetchJson("/api/platform/overview", { headers: authHeaders(token) });
    assert.equal(overview.status, 200);
    assert.equal(overview.json.workspaces.length, 0);
    assert.equal(overview.json.limits.workspaces, 3);

    // ---- validation: bad workspace names rejected ----
    for (const badName of ["", "a", "x".repeat(81), "!!!"]) {
      const r = await fetchJson("/api/platform/workspaces", { method: "POST", headers: authHeaders(token), body: JSON.stringify({ name: badName }) });
      assert.equal(r.status, 400, `name ${JSON.stringify(badName)} rejected`);
      assert.equal(r.json.code, "WORKSPACE_NAME_INVALID");
    }
    const created = await fetchJson("/api/platform/workspaces", { method: "POST", headers: authHeaders(token), body: JSON.stringify({ name: "My Dev Workspace", description: "keys for the test suite" }) });
    assert.equal(created.status, 201);
    const ws = created.json.workspace;
    assert.equal(ws.slug, "my-dev-workspace");
    assert.equal(ws.keys.length, 0);

    // ---- billing required before key creation (non-owner) ----
    const noBilling = await fetchJson(`/api/platform/workspaces/${ws.id}/keys`, { method: "POST", headers: authHeaders(token), body: JSON.stringify({ name: "First key" }) });
    assert.equal(noBilling.status, 402);
    assert.equal(noBilling.json.code, "BILLING_REQUIRED");

    // ---- billing setup ----
    const billing = await fetchJson("/api/platform/billing/setup", { method: "POST", headers: authHeaders(token), body: JSON.stringify({ billingEmail: email, company: "Dev Co" }) });
    assert.equal(billing.status, 200);

    // ---- validation: bad key names rejected ----
    const badKey = await fetchJson(`/api/platform/workspaces/${ws.id}/keys`, { method: "POST", headers: authHeaders(token), body: JSON.stringify({ name: "?" }) });
    assert.equal(badKey.status, 400);
    assert.equal(badKey.json.code, "API_KEY_NAME_INVALID");

    // ---- create a key: raw secret returned exactly once, only hash+last4 at rest ----
    const keyCreate = await fetchJson(`/api/platform/workspaces/${ws.id}/keys`, { method: "POST", headers: authHeaders(token), body: JSON.stringify({ name: "Production key" }) });
    assert.equal(keyCreate.status, 201);
    const raw = keyCreate.json.key;
    assert.match(raw, /^vyr_live_[A-Za-z0-9_-]{20,}$/);
    assert.equal(keyCreate.json.keyInfo.name, "Production key");
    assert.equal(keyCreate.json.keyInfo.last4, raw.slice(-4));

    const stored = await fetchJson("/api/auth/data", { headers: authHeaders(token) });
    assert.equal(stored.status, 200);
    const storedKey = stored.json.data.platform.workspaces[0].keys[0];
    assert.ok(storedKey.hash && /^[a-f0-9]{64}$/.test(storedKey.hash), "sha256 hash stored");
    assert.equal(storedKey.last4, raw.slice(-4));
    assert.ok(!JSON.stringify(stored.json.data).includes(raw), "raw secret never persisted");
    assert.ok(!storedKey.prefix, "legacy plaintext prefix dropped");

    // ---- key list exposes no secret ----
    const keyList = await fetchJson(`/api/platform/workspaces/${ws.id}/keys`, { headers: authHeaders(token) });
    assert.equal(keyList.status, 200);
    assert.equal(keyList.json.keys.length, 1);
    assert.ok(!JSON.stringify(keyList.json).includes(raw));

    // ---- public API: missing/invalid keys rejected ----
    const noAuth = await fetchJson("/api/v1/me");
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.json.code, "PLATFORM_KEY_REQUIRED");
    const badAuth = await fetchJson("/api/v1/me", { headers: { Authorization: "Bearer vyr_live_not-a-real-key" } });
    assert.equal(badAuth.status, 401);
    assert.equal(badAuth.json.code, "PLATFORM_KEY_INVALID");

    // ---- public API: authenticated call works and counts usage ----
    const me = await fetchJson("/api/v1/me", { headers: { Authorization: `Bearer ${raw}` } });
    assert.equal(me.status, 200);
    assert.equal(me.json.workspace.slug, "my-dev-workspace");
    assert.equal(me.json.usage.requests, 1);
    const usage = await fetchJson("/api/v1/usage", { headers: { Authorization: `Bearer ${raw}` } });
    assert.equal(usage.status, 200);
    assert.equal(usage.json.usage.requests, 2);
    assert.equal(usage.json.usage.last24h, 2);
    assert.ok(Object.keys(usage.json.byHour).length >= 1, "hourly usage buckets returned");

    // ---- usage is visible through the management API ----
    const keyGet = await fetchJson(`/api/platform/workspaces/${ws.id}/keys/${keyCreate.json.keyInfo.id}`, { headers: authHeaders(token) });
    assert.equal(keyGet.status, 200);
    assert.equal(keyGet.json.usage.requests, 2);

    // ---- rotate: new secret once, old one dead ----
    const rotated = await fetchJson(`/api/platform/workspaces/${ws.id}/keys/${keyCreate.json.keyInfo.id}/rotate`, { method: "POST", headers: authHeaders(token), body: JSON.stringify({ name: "Production key v2" }) });
    assert.equal(rotated.status, 201);
    const raw2 = rotated.json.key;
    assert.notEqual(raw2, raw);
    assert.equal(rotated.json.replacedKeyId, keyCreate.json.keyInfo.id);
    const oldDead = await fetchJson("/api/v1/me", { headers: { Authorization: `Bearer ${raw}` } });
    assert.equal(oldDead.status, 401, "rotated-away key is revoked");
    const me2 = await fetchJson("/api/v1/me", { headers: { Authorization: `Bearer ${raw2}` } });
    assert.equal(me2.status, 200);
    assert.equal(me2.json.key.name, "Production key v2");

    // ---- revoke: key dead, gone from list ----
    const revoke = await fetchJson(`/api/platform/workspaces/${ws.id}/keys/${rotated.json.keyInfo.id}`, { method: "DELETE", headers: authHeaders(token) });
    assert.equal(revoke.status, 200);
    assert.equal(revoke.json.revoked, true);
    const revokedDead = await fetchJson("/api/v1/me", { headers: { Authorization: `Bearer ${raw2}` } });
    assert.equal(revokedDead.status, 401, "revoked key is rejected");
    const keyList2 = await fetchJson(`/api/platform/workspaces/${ws.id}/keys`, { headers: authHeaders(token) });
    assert.equal(keyList2.json.keys.length, 0);

    // ---- rename workspace via PATCH ----
    const renamed = await fetchJson(`/api/platform/workspaces/${ws.id}`, { method: "PATCH", headers: authHeaders(token), body: JSON.stringify({ name: "Renamed Workspace" }) });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.workspace.name, "Renamed Workspace");
    assert.equal(renamed.json.workspace.slug, "my-dev-workspace", "slug stays stable after rename");

    // ---- delete workspace ----
    const deleted = await fetchJson(`/api/platform/workspaces/${ws.id}`, { method: "DELETE", headers: authHeaders(token) });
    assert.equal(deleted.status, 200);
    const gone = await fetchJson(`/api/platform/workspaces/${ws.id}/keys`, { headers: authHeaders(token) });
    assert.equal(gone.status, 404);
    assert.equal(gone.json.code, "WORKSPACE_NOT_FOUND");

    // ---- waitlist: validation + per-IP rate limiting ----
    const badEmail = await fetchJson("/api/platform/waitlist", { method: "POST", body: JSON.stringify({ email: "not-an-email" }) });
    assert.equal(badEmail.status, 400);
    assert.equal(badEmail.json.code, "WAITLIST_EMAIL_INVALID");
    const joined = await fetchJson("/api/platform/waitlist", { method: "POST", body: JSON.stringify({ email: "waiter@example.com", name: "Waiter", plan: "early_access" }) });
    assert.equal(joined.status, 201);
    assert.equal(joined.json.entry.status, "pending");
    assert.equal(joined.json.entry.position, 1);
    const status = await fetchJson("/api/platform/waitlist/status?email=waiter@example.com");
    assert.equal(status.status, 200);
    assert.equal(status.json.entry.email, "waiter@example.com");
    // 5/hour per IP on the waitlist POST: requests so far = 2 (bad email + join).
    // Three more invalid-email posts stay under the limit, the next one trips it.
    for (let i = 0; i < 3; i++) {
      const r = await fetchJson("/api/platform/waitlist", { method: "POST", body: JSON.stringify({ email: "not-an-email" }) });
      assert.equal(r.status, 400, "still under the hourly waitlist budget");
    }
    const limited = await fetchJson("/api/platform/waitlist", { method: "POST", body: JSON.stringify({ email: "waiter2@example.com" }) });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.code, "PLATFORM_RATE_LIMITED");

    // ---- error envelope shape stays consistent ----
    assert.ok(limited.json.error && limited.json.code, "respondError envelope { error, code }");

    console.log("Platform tests passed");
    server.close();
  } catch (e) {
    console.error(e);
    server.close();
    process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exit(1); });
