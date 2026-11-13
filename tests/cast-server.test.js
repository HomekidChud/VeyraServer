"use strict";
/**
 * Tests for the device cast server (src/network/cast-server.js).
 *
 * Pure unit tests with fake socket objects — no network, no live endpoints.
 */

const assert = require("node:assert/strict");
const { CastServer } = require("../src/network/cast-server");

// Minimal stand-in for a WebSocket: records handlers and captured sends.
function fakeWs(readyState = 1) {
  const ws = {
    readyState,
    handlers: {},
    sent: [],
    on(event, fn) { this.handlers[event] = fn; },
    send(data) { this.sent.push(data); },
    close() {},
  };
  return ws;
}
const OPEN = 1, CLOSED = 3;

(async () => {
  // CastServer without a real http server runs in HTTP-polling mode, which is
  // all these unit tests need — no sockets are ever opened.
  const cast = new CastServer(null, () => {}, {});

  // 1. Create a polling session and pair an HTTP-polled device.
  const session = cast.createSessionViaPoll();
  const joined = cast.joinDeviceViaPoll(session.id, session.pairingCode, "test-device", { name: "Test Phone", type: "phone", connectionType: "wifi" });
  assert.equal(joined.ok, true, "device join should succeed");

  // 2. A browser on WebSocket receives frames that the HTTP-polled device
  //    pushes (previously they landed only in the polling buffer, which a WS
  //    browser never reads).
  const browserWs = fakeWs(OPEN);
  cast.handleBrowser(browserWs, session.id);
  assert.equal(session.browserWs, browserWs, "handleBrowser should attach the browser socket to the existing session");
  assert.ok(browserWs.sent.length > 0 && JSON.parse(browserWs.sent[0]).type === "session_created",
    "the attached browser should receive the session handshake");

  const pushed = cast.browserPush(session.id, { type: "frame", data: "jpeg-bytes" });
  assert.equal(pushed.ok, true, "device frame push should be accepted");
  const frameMsg = browserWs.sent.map(s => JSON.parse(s)).find(m => m.type === "frame");
  assert.ok(frameMsg, "a WS browser must receive frames pushed by an HTTP device");
  assert.equal(frameMsg.data, "jpeg-bytes");

  // 3. When the browser's WebSocket drops, the session must survive in
  //    polling mode (the device stays paired) instead of being deleted.
  browserWs.readyState = CLOSED;
  browserWs.handlers.close();
  assert.equal(session.browserWs, null, "the dead browser socket should be detached");
  assert.equal(session.usePolling, true, "the session should flip to polling when the browser WS drops");
  assert.ok(cast.sessions.has(session.id), "the session must survive the browser WS drop");

  cast.browserPush(session.id, { type: "frame", data: "after-drop" });
  const polled = cast.pollSession(session.id);
  assert.ok(Array.isArray(polled), "polling the converted session should work");
  assert.ok(polled.some(m => m.type === "frame" && m.data === "after-drop"),
    "frames must flow through the polling buffer after the WS drop");

  // 4. A closed session must not look like an empty one, so the frontend
  //    stops polling it instead of spinning forever.
  const closed = cast.closeSession(session.id);
  assert.equal(closed.closed, true);
  assert.equal(cast.pollSession(session.id), null, "polling a closed session must signal death, not []");
  assert.equal(cast.pollSession("cast_doesnotexist"), null, "polling an unknown session must signal death, not []");

  // 5. Sessions whose browser fell back to polling and went silent are reaped.
  const abandoned = cast.createSessionViaPoll();
  abandoned.status = "streaming";
  abandoned.lastBrowserPollAt = Date.now() - 3 * 60 * 1000;
  cast.cleanup();
  assert.equal(cast.sessions.has(abandoned.id), false, "an abandoned polling session should be reaped by cleanup");

  const active = cast.createSessionViaPoll();
  active.lastBrowserPollAt = Date.now();
  cast.cleanup();
  assert.equal(cast.sessions.has(active.id), true, "an actively-polled session must survive cleanup");

  cast.cleanupInterval?.unref?.();
  console.log("cast-server.test.js — all assertions passed");
})().catch(e => { console.error("cast-server.test.js failed:", e.message); process.exit(1); });
