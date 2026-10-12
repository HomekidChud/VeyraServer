"use strict";
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
(async () => {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve(__dirname, ".."), stdio: "ignore",
    env: { ...process.env, PORT: String(port), MONGODB_URI: "", MONGO_URL: "", FRONTEND_URL: "https://example.com/veyra/" },
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (route, method = "GET", body, token) => {
    const response = await fetch(base + route, { method, headers: {
      "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
    return { status: response.status, data: await response.json() };
  };
  let checks = 0;
  const check = (a, b) => { assert.deepEqual(a, b); checks++; };
  try {
    const deadline = Date.now() + 15000;
    for (;;) {
      try { await call("/api/cast/stats"); break; }
      catch (e) { if (Date.now() > deadline || child.exitCode !== null) throw e; await new Promise(r => setTimeout(r, 50)); }
    }
    const created = await call("/api/cast/create", "POST", {});
    check(created.status, 200);
    check(created.data.qrUrl, "");
    check(JSON.stringify(created.data).includes("qrserver.com"), false);
    const { sessionId: id, browserToken, pairingCode } = created.data;
    check((await call(`/api/cast/poll/${id}`)).status, 403);
    check((await call(`/api/cast/close/${id}`, "POST", {}, "wrong")).status, 403);
    check((await call(`/api/cast/poll/${id}`, "GET", null, browserToken)).status, 200);
    const joined = await call("/api/cast/device/join", "POST", { code: pairingCode, deviceId: "test-phone", connectionType: "wifi", networkStrength: 0 });
    check(joined.data.ok, true);
    const token = joined.data.deviceToken;
    check((await call("/api/cast/device/poll/test-phone")).status, 403);
    check((await call("/api/cast/device/poll/test-phone", "GET", null, browserToken)).status, 403);
    check((await call("/api/cast/device/push/test-phone", "POST", { type: "frame", data: "data:image/jpeg;base64,aGVsbG8=" }, token)).status, 200);
    const frames = await call(`/api/cast/poll/${id}`, "GET", null, browserToken);
    check(frames.data.messages.some(m => m.type === "frame"), true);
    check((await call(`/api/cast/push/${id}`, "POST", { type: "frame" })).status, 410);
    const other = (await call("/api/cast/create", "POST", {})).data;
    const otherJoin = (await call("/api/cast/device/join", "POST", { code: other.pairingCode, deviceId: "second-phone" })).data;
    check(otherJoin.ok, true);
    check((await call(`/api/cast/poll/${other.sessionId}`, "GET", null, browserToken)).status, 403);
    await call("/api/cast/device/push/test-phone", "POST", { type: "frame", data: "data:image/jpeg;base64,aGVsbG8=" }, token);
    const otherMessages = await call(`/api/cast/poll/${other.sessionId}`, "GET", null, other.browserToken);
    check(otherMessages.data.messages.some(m => m.type === "frame"), false);
    await call(`/api/cast/close/${other.sessionId}`, "POST", {}, other.browserToken);
    check((await call("/api/cast/device/push/test-phone", "POST", { type: "session_created" }, token)).status, 400);
    const listing = await call("/api/cast/sessions");
    check(JSON.stringify(listing.data).includes(id), false);
    check(JSON.stringify(listing.data).includes(pairingCode), false);
    check((await call(`/api/cast/close/${id}`, "POST", {}, browserToken)).status, 200);
    check((await call("/api/cast/device/poll/test-phone", "GET", null, token)).status, 403);
    console.log(`Casting HTTP integration: ${checks} authorization and routing checks passed.`);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000))]);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
