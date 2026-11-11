"use strict";
// Access Gate tests: unit coverage for the gate module plus a live
// end-to-end pass against the real express app (gate enabled).
process.env.GATE_ENABLED = "true";
process.env.VEYRA_ADMIN_TOKEN = "test-admin-token-123456";
process.env.VEYRA_ENV = "test";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AccessGate } = require("../src/core/access-gate");

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
    server.close();
    console.log("Access Gate end-to-end tests passed");
  });
})().catch(e => { console.error(e); process.exit(1); });
