"use strict";
// Access Gate tests: unit coverage for the gate module plus a live
// end-to-end pass against the real express app (gate enabled).
process.env.GATE_ENABLED = "true";
process.env.VEYRA_ADMIN_TOKEN = "test-admin-token-123456";
process.env.VEYRA_ENV = "test";
process.env.VEYRA_ADMIN_EMAILS = "staff@example.test";
process.env.VEYRA_SIGNUP_KEY = "fixture-signup-key";
delete process.env.MONGODB_URI;
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AccessGate } = require("../src/core/access-gate");
const { AccessPolicy } = require("../src/core/access-policy");
const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-policy-http-"));
process.env.VEYRA_DATA_DIR = apiDir;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-gate-"));
try {
  // ---- unit: rotation, grace, waitlist, keys, sessions ----
  const gate = new AccessGate({ dataDir: dir, rotateMs: 60 * 1000, graceMs: 120 * 1000, adminToken: "x".repeat(32) });
  const token = gate.currentToken();
  assert.ok(/^[A-Za-z0-9_-]{20,}$/.test(token), "entry token looks random");
  assert.equal(gate.validateEntryToken(token), true);
  assert.equal(gate.validateEntryToken("forged-token"), false);
  gate.rotate();
  assert.equal(gate.validateEntryToken(token), true, "previous token stays valid inside the grace window");
  const session = gate.createSession({ email: "u@example.com" });
  assert.ok(gate.verifySession(session));
  assert.equal(gate.verifySession("forged-session"), null);
  const joined = gate.joinWaitlist("waiter@example.com");
  assert.equal(joined.entry.status, "pending");
  const again = gate.joinWaitlist("waiter@example.com");
  assert.equal(again.alreadyJoined, true);
  assert.throws(() => gate.joinWaitlist("not-an-email"), e => e.code === "GATE_EMAIL_INVALID");
  const accepted = gate.acceptEntry(joined.entry.id);
  assert.ok(/^VY-/.test(accepted.key), "acceptance issues an access key");
  const reissueSame = gate.acceptEntry(joined.entry.id);
  assert.equal(reissueSame.alreadyAccepted, true);
  assert.equal(reissueSame.key, null, "the original key is never shown twice");
  const unlocked = gate.unlockWithKey(accepted.key);
  assert.equal(unlocked.email, "waiter@example.com");
  assert.ok(unlocked.sessionToken);
  assert.throws(() => gate.unlockWithKey("VY-wrongkey"), e => e.code === "GATE_KEY_INVALID");
  gate.rejectEntry(gate.listWaitlist().find(x => x.email === "waiter@example.com").id);
  assert.equal(gate.listWaitlist().length, 0, "rejected entries leave the waitlist");
  console.log("Access Gate unit tests passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- integration: the whole service is blocked until unlocked ----
(async () => {
  const { app, accessGate } = require("../src/server");
  assert.ok(app, "express app exported");
  const gate = accessGate;
  assert.ok(gate, "gate instance reachable from the app");
  await new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  }).then(async server => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const fetchJson = async (path, init = {}) => {
      const r = await fetch(base + path, init);
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text, headers: r.headers };
    };
    // 1. Ungated browser request -> waitlist screen.
    const screen = await fetch(base + "/");
    assert.equal(screen.status, 403);
    assert.match(await screen.text(), /Invite only/);
    // 2. Ungated API request -> JSON gate error.
    const api = await fetchJson("/api/config");
    assert.equal(api.status, 403);
    assert.equal(api.json?.code, "GATE_REQUIRED");
    // 3. Health stays public (Render deploy checks).
    const health = await fetchJson("/health");
    assert.equal(health.status, 200);
    // 4. Invalid invite link -> gate screen.
    const badLink = await fetch(base + "/gate/not-a-real-token");
    assert.equal(badLink.status, 403);
    // 5. Valid rotating invite link -> session cookie + redirect.
    const entry = await fetch(base + `/gate/${gate.currentToken()}`, { redirect: "manual" });
    assert.equal(entry.status, 302);
    const cookie = String(entry.headers.get("set-cookie") || "");
    const sessionCookie = (cookie.match(/veyra_gate=[^;]+/) || [""])[0];
    assert.ok(sessionCookie, "gate session cookie set");
    // 6. Cookie unlocks the app.
    const unlockedPage = await fetch(base + "/api/gate/session", { headers: { cookie: sessionCookie } });
    assert.equal(unlockedPage.status, 200);
    // 7. X-Veyra-Gate header also unlocks (the static frontend flow).
    const headerToken = sessionCookie.split("=")[1];
    const viaHeader = await fetchJson("/api/gate/session", { headers: { "x-veyra-gate": headerToken } });
    assert.equal(viaHeader.status, 200);
    // 8. Admin token bypasses the gate.
    const adminStatus = await fetchJson("/api/gate/status", { headers: { "x-veyra-admin-token": process.env.VEYRA_ADMIN_TOKEN } });
    assert.equal(adminStatus.status, 200);
    // 9. Waitlist join -> accept -> unlock with key.
    const e2eEmail = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const joined = await fetchJson("/api/gate/waitlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e2eEmail }) });
    assert.ok(joined.status === 201 || joined.json?.alreadyJoined === true);
    const list = await fetchJson("/api/gate/admin/waitlist", { headers: { "x-veyra-admin-token": process.env.VEYRA_ADMIN_TOKEN } });
    assert.equal(list.status, 200);
    const entryRow = list.json.entries.find(x => x.email === e2eEmail);
    const accepted = await fetchJson(`/api/gate/admin/waitlist/${entryRow.id}/accept`, { method: "POST", headers: { "x-veyra-admin-token": process.env.VEYRA_ADMIN_TOKEN } });
    assert.equal(accepted.status, 200);
    const unlocked2 = await fetchJson("/api/gate/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: accepted.json.accessKey }) });
    assert.equal(unlocked2.status, 200);
    assert.ok(unlocked2.json.token);
    // 10. Bad keys are rejected.
    const badKey = await fetchJson("/api/gate/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "VY-forged" }) });
    assert.equal(badKey.status, 403);
    // Provision disposable staff and regular accounts with the fixture signup key.
    const account = async (email, admin = false) => {
      const body = { email, password: "FixtureOnly123!", signupKey: process.env.VEYRA_SIGNUP_KEY };
      const r = await fetchJson("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json", "x-veyra-gate": headerToken, ...(admin ? { "x-veyra-admin-token": process.env.VEYRA_ADMIN_TOKEN } : {}) }, body: JSON.stringify(body) });
      assert.equal(r.status, 201);
      return { body, token: r.json.token };
    };
    const attemptedStaff = await fetchJson("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json", "x-veyra-gate": headerToken }, body: JSON.stringify({ email: "staff@example.test", password: "FixtureOnly123!", signupKey: process.env.VEYRA_SIGNUP_KEY }) });
    assert.equal(attemptedStaff.status, 400, "a normal signup key does not enroll staff");
    const staff = await account("staff@example.test", true), member = await account("member@example.test");
    const staffHeaders = { authorization: `Bearer ${staff.token}`, "content-type": "application/json" };
    const memberHeaders = { authorization: `Bearer ${member.token}`, "x-veyra-gate": headerToken };
    const initial = (await fetchJson("/api/gate/admin/policy", { headers: staffHeaders })).json.policy;
    assert.equal(initial.mode, "invite");
    assert.equal(initial.testMode, false);
    assert.equal((await fetchJson("/api/gate/admin/policy", { headers: memberHeaders })).status, 403);
    assert.equal((await fetchJson("/api/gate/admin/checks", { headers: staffHeaders })).json.code, "ACCESS_TEST_MODE_OFF");
    const setPolicy = (payload, headers = staffHeaders) => fetchJson("/api/gate/admin/policy", { method: "PUT", headers, body: JSON.stringify(payload) });
    const desired = { ...initial, mode: "staff", waitlistOpen: false, testMode: true };
    assert.equal((await setPolicy(desired, { ...memberHeaders, "content-type": "application/json" })).status, 403);
    assert.equal((await setPolicy({ ...desired, waitlistOpen: "false" })).status, 400);
    const saved = await setPolicy(desired);
    assert.equal(saved.status, 200);
    assert.equal(saved.json.report.waitlist.total, 1);
    const locked = saved.json.policy;
    assert.equal(locked.revision, initial.revision + 1);
    assert.equal((await setPolicy(desired)).status, 409);
    assert.equal((await fetchJson("/api/config", { headers: memberHeaders })).json.code, "GATE_LOCKED");
    assert.equal((await fetchJson("/api/config", { headers: staffHeaders })).status, 200);
    assert.equal((await fetchJson(`/gate/${gate.currentToken()}`, { redirect: "manual" })).status, 403);
    const post = (route, body) => fetchJson(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post("/api/gate/unlock", { key: accepted.json.accessKey })).json.code, "GATE_LOCKED");
    assert.equal((await post("/api/gate/waitlist", { email: "new@example.test" })).json.code, "GATE_WAITLIST_CLOSED");
    assert.equal((await post("/api/gate/admin/login", member.body)).status, 401);
    assert.equal((await post("/api/gate/admin/login", staff.body)).json.user.role, "admin");
    assert.equal((await post("/api/auth/test-login", {})).status, 403);
    const screenLocked = await fetchJson("/gate");
    assert.match(screenLocked.text, /Staff only/);
    assert.doesNotMatch(screenLocked.text, /<form id="(?:join|unlock)">/);
    const status = await fetchJson("/api/gate/status", { headers: staffHeaders });
    assert.equal(status.json.unlocked, true);
    assert.equal(status.json.testMode, undefined);
    assert.match(status.headers.get("cache-control"), /no-store/);
    assert.equal((await fetchJson("/api/gate/admin/checks", { headers: memberHeaders })).status, 403);
    const checks = (await fetchJson("/api/gate/admin/checks", { headers: staffHeaders })).json.checks;
    assert.deepStrictEqual(checks.map(c => [c.browse, c.waitlist, c.redeemInvite]), [[false, false, false], [false, false, false], [true, false, false]]);
    const reload = new AccessPolicy({ dataDir: apiDir, enabled: false, waitlistOpen: true });
    await reload.ready();
    assert.deepStrictEqual(reload.state, locked);
    // A failed persistence write must not change the effective policy.
    const broken = new AccessPolicy({ dataDir: apiDir, enabled: false, waitlistOpen: true, persistence: {
      enabled: true, async loadAccessPolicy() { return locked; }, async saveAccessPolicy() { throw new Error("Unavailable"); }
    } });
    await assert.rejects(broken.update({ ...locked, mode: "public" }), { code: "ACCESS_POLICY_UNAVAILABLE" });
    assert.deepStrictEqual(broken.state, locked);
    const reopen = await setPolicy({ ...locked, mode: "invite", waitlistOpen: true, testMode: false });
    assert.equal(reopen.status, 200);
    assert.equal((await fetchJson("/api/config", { headers: memberHeaders })).status, 200);
    assert.equal((await fetchJson("/api/config")).status, 403);
    assert.equal((await post("/api/gate/waitlist", { email: "new@example.test" })).status, 201);
    assert.equal((await setPolicy({ ...reopen.json.policy, mode: "public" })).status, 200);
    assert.equal((await fetchJson("/api/config")).status, 200);
    server.close();
    server.closeAllConnections();
    console.log("Access Gate end-to-end tests passed");
  });
})().catch(e => { console.error(e); process.exit(1); });
