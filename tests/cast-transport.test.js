"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { CastServer } = require("../src/network/cast-server");
class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.messages = []; }
  send(raw) { this.messages.push(JSON.parse(raw)); }
  close(code = 1000) { this.readyState = 3; this.closeCode = code; this.emit("close"); }
}
const server = new CastServer(null);
let checks = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const image = "data:image/jpeg;base64,aGVsbG8=";
try {
  const http = new EventEmitter(); http.listen = () => {};
  const wsServer = new CastServer(http);
  let hijacked = false;
  http.emit("upgrade", { url: "/ws/browser" }, { write() { hijacked = true; }, destroy() { hijacked = true; } }, Buffer.alloc(0));
  check(hijacked, false);
  check(wsServer.wss.options.noServer, true);
  wsServer.close();
  check(http.listenerCount("upgrade"), 0);
  const a = server.createSessionViaPoll();
  check(server.authorizeBrowser(a.id, a.browserToken), true);
  check(server.authorizeBrowser(a.id, "wrong"), false);
  check(server.authorizeBrowser(a.id, "é".repeat(32)), false);
  const joined = server.joinDeviceViaPoll("", a.pairingCode, "phone-a", { connectionType: "cellular", networkStrength: 0 });
  check(joined.ok, true);
  check(a.connectionType, "cellular");
  check(a.networkStrength, 0);
  check(server.authorizeDevice("phone-a", joined.deviceToken), true);
  check(server.authorizeDevice("phone-a", a.browserToken), false);
  check(server.pollSession(a.id)[0].type, "device_paired");
  check(server.receiveDeviceMessage("phone-a", { type: "frame", data: image }).ok, true);
  check(server.receiveDeviceMessage("phone-a", { type: "frame", data: image }).ok, true);
  check(server.pollSession(a.id).filter(m => m.type === "frame").length, 1);
  check(server.getStats().activeStreams, 1);
  check(a.frameCount, 2);
  check(server.receiveDeviceMessage("phone-a", { type: "frame", data: "data:text/html;base64,aA==" }).ok, false);
  check(server.receiveDeviceMessage("phone-a", { type: "frame", data: "x".repeat(400001) }).ok, false);
  check(server.receiveDeviceMessage("missing", { type: "frame", data: image }).ok, false);
  check(server.receiveDeviceMessage("phone-a", { type: "session_created" }).ok, false);
  server.sendToDevice(a.id, { type: "start_streaming" });
  server.sendToDevice(a.id, { type: "start_streaming" });
  check(server.getStats().activeStreams, 1);
  check(server.pollDevice("phone-a").messages.length, 2);
  server.sendToDevice(a.id, { type: "stop_streaming" });
  server.sendToDevice(a.id, { type: "stop_streaming" });
  check(server.getStats().activeStreams, 0);
  check(a.status, "paired");
  server.sendToDevice(a.id, { type: "set_input", enabled: false });
  check(server.sendToDevice(a.id, { type: "input", input: {} }).ok, false);
  const b = server.createSessionViaPoll();
  check(server.joinDeviceViaPoll(b.id, b.pairingCode, "phone-a", {}).ok, false);
  check(server.joinDeviceViaPoll(a.id, a.pairingCode, "phone-b", {}).ok, true);
  check(server.devices.has("phone-a"), false);
  check(server.pollingBuffers.has("device:phone-a"), false);
  check(server.authorizeDevice("phone-a", joined.deviceToken), false);
  // Browser WS -> device HTTP commands and frame return.
  const browser = new Socket();
  server.handleBrowser(browser);
  const wsSession = server.sessions.get(browser.messages[0].sessionId);
  check(!!browser.messages[0].browserToken, true);
  const httpDevice = server.joinDeviceViaPoll(wsSession.id, wsSession.pairingCode, "http-phone", {});
  check(httpDevice.ok, true);
  browser.emit("message", JSON.stringify({ type: "start_streaming" }));
  check(server.pollDevice("http-phone").messages[0].type, "start_streaming");
  check(server.receiveDeviceMessage("http-phone", { type: "frame", data: image }).ok, true);
  check(browser.messages.at(-1).type, "frame");
  // Browser HTTP -> device WS, including replacement and old socket close.
  const c = server.createSessionViaPoll(), device = new Socket();
  server.handleDevice(device, c.id, c.pairingCode, "ws-phone", { url: "/ws/cast?name=Test" });
  check(server.pollSession(c.id)[0].type, "device_paired");
  server.sendToDevice(c.id, { type: "start_streaming" });
  check(device.messages.at(-1).type, "start_streaming");
  device.emit("message", JSON.stringify({ type: "frame", data: image }));
  check(server.pollSession(c.id)[0].type, "frame");
  const replacement = new Socket();
  server.handleDevice(replacement, c.id, c.pairingCode, "replacement-phone", { url: "/ws/cast" });
  check(c.status, "paired");
  check(server.devices.has("ws-phone"), false);
  replacement.close();
  check(c.status, "waiting");
  check(server.devices.has("replacement-phone"), false);
  const d = server.createSessionViaPoll();
  server.joinDeviceViaPoll(d.id, d.pairingCode, "stale-phone", {});
  d.lastActivity -= 11 * 60 * 1000;
  server.cleanup();
  check(server.sessions.has(d.id), false);
  check(server.devices.has("stale-phone"), false);
  check(server.pollingBuffers.has(d.id), false);
  server.closeSession(a.id);
  server.closeSession(a.id);
  check(server.pollingBuffers.has("device:phone-b"), false);
  // Distinct sessions remain isolated.
  check(server.sessions.has(b.id), true);
  const limited = new CastServer(null, () => {}, { maxSessions: 1 });
  try { limited.createSessionViaPoll(); assert.throws(() => limited.createSessionViaPoll(), /capacity/); checks++; }
  finally { limited.close(); }
} finally { server.close(); }
check(server.sessions.size, 0);
check(server.devices.size, 0);
check(server.pollingBuffers.size, 0);
check(server.stats.activeStreams, 0);
console.log(`Casting regression suite: ${checks} behavioral checks passed.`);
