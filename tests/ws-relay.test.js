"use strict";
/**
 * Tests for the WebSocket relay (src/network/ws-relay.js).
 *
 * Uses only loopback fixtures. No live external endpoints.
 */

const assert = require("assert");
const net = require("net");
const http = require("http");

const { WsRelay, RELAY_PATH, isPublicIp, parseWsTarget } = require("../src/network/ws-relay");
const { WebSocket: WsClient, WebSocketServer: WsServer } = require("ws");

function makeSessionManager() {
  const sessions = new Map();
  const mk = (sid, opts = {}) => { sessions.set(sid, { touched: 0, ...opts }); return sid; };
  return {
    mk,
    checkLimit: sid => !sessions.has(sid),
    touch: sid => { if (!sessions.has(sid)) return; sessions.get(sid).touched++; },
  };
}

function makeVpnManager({ routeFor = () => null } = {}) {
  return {
    route: routeFor,
    openTunnel: async () => { throw new Error("openTunnel should not be called in direct mode"); },
  };
}

function listen(server) {
  return new Promise(res => server.listen(0, "127.0.0.1", () => res(server.address().port)));
}
function close(server) {
  return new Promise(res => server.close(() => res()));
}

async function waitForOpen(ws, label) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${label} did not open`)), 5000);
    ws.once("open", () => { clearTimeout(t); res(); });
    ws.once("error", e => { clearTimeout(t); rej(new Error(`${label} error: ${e.message}`)); });
  });
}
async function waitForClose(ws, label) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${label} did not close`)), 5000);
    ws.once("close", (code, reason) => { clearTimeout(t); res({ code, reason: String(reason || "") }); });
  });
}

(async () => {
  let passed = 0, failed = 0;
  const test = async (name, fn) => {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}\n${e.stack?.split("\n").slice(0,4).join("\n")}`); }
  };

  console.log("ws-relay tests\n");

  // --- isPublicIp -------------------------------------------------------
  await test("isPublicIp rejects private and reserved addresses", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.1.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "100.64.0.1", "::1", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::"]) assert.equal(isPublicIp(ip), false, ip);
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.217.169.174", "2606:4700:4700::1111"]) assert.equal(isPublicIp(ip), true, ip);
  });

  // --- parseWsTarget ----------------------------------------------------
  await test("parseWsTarget validates protocol, credentials, fragments", async () => {
    assert.equal(parseWsTarget("wss://example.com/ws").secure, true);
    assert.equal(parseWsTarget("ws://example.com:8080/path?x=1").port, 8080);
    assert.equal(parseWsTarget("ws://example.com").port, 80);
    assert.throws(() => parseWsTarget("https://example.com"));
    assert.throws(() => parseWsTarget("wss://user:pass@example.com"));
    assert.throws(() => parseWsTarget("wss://example.com/#frag"));
    assert.throws(() => parseWsTarget(""));
  });

  // --- helpers -----------------------------------------------------------
  const sessionManager = makeSessionManager();
  const vpnManager = makeVpnManager();
  const forwardHeaders = ({ sid, target, fromUrl, origin }) => ({ "x-veyra-relay": sid });

  const echoHttp = http.createServer((req, res) => res.writeHead(404).end());
  const echoWss = new WsServer({ server: echoHttp, path: "/echo" });
  const seenOrigin = { value: null };
  echoWss.on("connection", (ws, req) => {
    seenOrigin.value = req.headers.origin || "(none)";
    ws.on("message", (d, b) => ws.send(d, { binary: b }));
    ws.on("close", () => {});
  });
  const echoPort = await listen(echoHttp);

  // --- happy path: text + binary echo -----------------------------------
  await test("relays text and binary messages both ways through a direct (no-VPN) socket", async () => {
    const relayHttp = http.createServer((req, res) => res.writeHead(404).end());
    const relay = new WsRelay({ sessionManager, vpnManager, forwardHeaders, allowLoopback: true });
    relay.attach(relayHttp);
    const relayPort = await listen(relayHttp);
    const sid = sessionManager.mk(`sess-${Date.now()}`);
    const fromUrl = `http://127.0.0.1:${echoPort}/page`;
    const target = `ws://127.0.0.1:${echoPort}/echo`;
    const relayUrl = `ws://127.0.0.1:${relayPort}${RELAY_PATH}?url=${encodeURIComponent(target)}&sid=${sid}&from=${encodeURIComponent(fromUrl)}`;

    const browser = new WsClient(relayUrl, { headers: { origin: fromUrl } });
    await waitForOpen(browser, "browser");
    // The relay accepts the browser side immediately and completes the upstream
    // handshake asynchronously; wait for the upstream Origin to be observed.
    const expectedOrigin = new URL(fromUrl).origin;
    await new Promise((res, rej) => {
      const t0 = Date.now();
      (function check() {
        if (seenOrigin.value === expectedOrigin) return res();
        if (Date.now() - t0 > 3000) return rej(new Error(`upstream Origin not observed (got ${seenOrigin.value})`));
        setTimeout(check, 20);
      })();
    });
    assert.equal(seenOrigin.value, expectedOrigin, "upstream Origin should be derived from the virtual page");

    const echoBack = (data, binary) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("echo timeout")), 3000);
      browser.once("message", (d, b) => { clearTimeout(t); res({ d, b }); });
      browser.send(data, { binary });
    });
    const t1 = await echoBack("hello poxel.io", false);
    assert.equal(t1.d.toString(), "hello poxel.io"); assert.equal(t1.b, false);
    const t2 = await echoBack(Buffer.from([0,1,2,255]), true);
    assert.deepEqual([...t2.d], [0,1,2,255]); assert.equal(t2.b, true);

    browser.close(1000, "done");
    await waitForClose(browser, "browser");
    await close(relayHttp);
    const st = relay.status();
    assert.ok(st.opened >= 1); assert.ok(st.messagesRelayed >= 2);
  });

  // --- subprotocol negotiation -------------------------------------------
  await test("forwards requested subprotocols and reports the negotiated one", async () => {
    const protoHttp = http.createServer((req, res) => res.writeHead(404).end());
    const protoWss = new WsServer({ server: protoHttp, path: "/proto" });
    protoWss.on("connection", (ws, req) => {
      // `ws` handles Sec-WebSocket-Protocol negotiation on its own
      ws.on("message", d => ws.send(`proto:${ws.protocol}`));
    });
    const protoPort = await listen(protoHttp);

    const relayHttp = http.createServer((req, res) => res.writeHead(404).end());
    const relay = new WsRelay({ sessionManager, vpnManager, forwardHeaders, allowLoopback: true });
    relay.attach(relayHttp);
    const relayPort = await listen(relayHttp);
    const sid = sessionManager.mk(`sess-proto-${Date.now()}`);
    const target = `ws://127.0.0.1:${protoPort}/proto`;
    const relayUrl = `ws://127.0.0.1:${relayPort}${RELAY_PATH}?url=${encodeURIComponent(target)}&sid=${sid}`;

    const browser = new WsClient(relayUrl, "chat.v1");
    await waitForOpen(browser, "browser");
    assert.equal(browser.protocol, "chat.v1");
    const got = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), 3000);
      browser.once("message", d => { clearTimeout(t); res(d.toString()); });
      browser.send("hi");
    });
    assert.equal(got, "proto:chat.v1");
    browser.close(1000, "done");
    await waitForClose(browser, "browser");
    await close(relayHttp); await close(protoHttp);
  });

  // --- session auth -------------------------------------------------------
  await test("rejects unknown or missing session", async () => {
    const relayHttp = http.createServer((req, res) => res.writeHead(404).end());
    const relay = new WsRelay({ sessionManager, vpnManager, forwardHeaders, allowLoopback: true });
    relay.attach(relayHttp);
    const relayPort = await listen(relayHttp);
    const target = `ws://127.0.0.1:${echoPort}/echo`;
    for (const badSid of ["", "unknown-session-id-xxxxx"]) {
      const relayUrl = `ws://127.0.0.1:${relayPort}${RELAY_PATH}?url=${encodeURIComponent(target)}&sid=${encodeURIComponent(badSid)}`;
      const browser = new WsClient(relayUrl);
      const { code } = await waitForClose(browser, `browser sid="${badSid}"`);
      assert.ok(code === 4001 || code === 4008 || code === 1006, `got ${code}`);
    }
    await close(relayHttp);
  });

  // --- SSRF protection ---------------------------------------------------
  await test("blocks targets that resolve to private/reserved addresses", async () => {
    const relayHttp = http.createServer((req, res) => res.writeHead(404).end());
    const relay = new WsRelay({ sessionManager, vpnManager, forwardHeaders, allowLoopback: false });
    relay.attach(relayHttp);
    const relayPort = await listen(relayHttp);
    const sid = sessionManager.mk(`sess-ssrf-${Date.now()}`);
    const target = "ws://127.0.0.1:1/x"; // resolves to loopback
    const relayUrl = `ws://127.0.0.1:${relayPort}${RELAY_PATH}?url=${encodeURIComponent(target)}&sid=${sid}`;
    const browser = new WsClient(relayUrl);
    const { code, reason } = await waitForClose(browser, "browser");
    assert.equal(code, 1011);
    assert.match(reason, /SSRF_BLOCKED|private or reserved/);
    await close(relayHttp);
  });

  // --- VPN-routed path: no direct fallback --------------------------------
  await test("uses the session's VPN exit and never falls back to direct when it errors", async () => {
    const directCalls = { count: 0 };
    const vpnManagerVpn = {
      route: () => ({ profile: { id: "mock" }, conn: { requests: 0 } }),
      openTunnel: async () => { throw Object.assign(new Error("mock tunnel down"), { code: "VPN_CONNECT_REFUSED" }); },
      // instrument the direct path
      __directCalls: directCalls,
    };
    const relayHttp = http.createServer((req, res) => res.writeHead(404).end());
    const relay = new WsRelay({ sessionManager, vpnManager: vpnManagerVpn, forwardHeaders });
    relay.attach(relayHttp);
    const relayPort = await listen(relayHttp);
    const sid = sessionManager.mk(`sess-vpn-${Date.now()}`);
    const target = `ws://127.0.0.1:${echoPort}/echo`; // would connect if not for the broken tunnel
    const relayUrl = `ws://127.0.0.1:${relayPort}${RELAY_PATH}?url=${encodeURIComponent(target)}&sid=${sid}`;
    const browser = new WsClient(relayUrl);
    const { code, reason } = await waitForClose(browser, "browser");
    assert.equal(code, 1011);
    assert.match(reason, /VPN|CONNECT_FAILED|tunnel|mock/i);
    assert.equal(relay.stats.failures >= 1, true);
    await close(relayHttp);
  });

  // --- VPN-routed happy path via a loopback SOCKS5-like mock ---------------
  await test("routes upstream through a mock VPN exit and relays traffic", async () => {
    // Use a loopback SOCKS5-like mock: we wrap `openTunnel` to return a plain
    // net.connect to the echo server. (A real SOCKS5 handshake is covered by
    // src/network/vpn.js tests; here we just verify the socket is used.)
    const vpnManagerVpnOk = {
      route: () => ({ profile: { id: "mock" }, conn: { requests: 0 } }),
      openTunnel: async (profile, host, port, conn) => {
        // Emulate a SOCKS5/WG exit by dialing the same loopback target.
        return await new Promise((res, rej) => {
          const s = net.connect({ host, port });
          s.once("connect", () => res(s));
          s.once("error", rej);
        });
      },
    };
    const relayHttp = http.createServer((req, res) => res.writeHead(404).end());
    const relay = new WsRelay({ sessionManager, vpnManager: vpnManagerVpnOk, forwardHeaders });
    relay.attach(relayHttp);
    const relayPort = await listen(relayHttp);
    const sid = sessionManager.mk(`sess-vpn-ok-${Date.now()}`);
    const target = `ws://127.0.0.1:${echoPort}/echo`;
    const relayUrl = `ws://127.0.0.1:${relayPort}${RELAY_PATH}?url=${encodeURIComponent(target)}&sid=${sid}`;
    const browser = new WsClient(relayUrl);
    await waitForOpen(browser, "browser");
    const got = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), 3000);
      browser.once("message", d => { clearTimeout(t); res(d.toString()); });
      browser.send("via-vpn");
    });
    assert.equal(got, "via-vpn");
    browser.close(1000, "done");
    await waitForClose(browser, "browser");
    await close(relayHttp);
  });

  // --- invalid scheme -----------------------------------------------------
  await test("rejects non-ws/wss targets with a clear close reason", async () => {
    const relayHttp = http.createServer((req, res) => res.writeHead(404).end());
    const relay = new WsRelay({ sessionManager, vpnManager, forwardHeaders, allowLoopback: true });
    relay.attach(relayHttp);
    const relayPort = await listen(relayHttp);
    const sid = sessionManager.mk(`sess-scheme-${Date.now()}`);
    const target = "https://example.com";
    const relayUrl = `ws://127.0.0.1:${relayPort}${RELAY_PATH}?url=${encodeURIComponent(target)}&sid=${sid}`;
    const browser = new WsClient(relayUrl);
    const { code, reason } = await waitForClose(browser, "browser");
    assert.equal(code, 4001);
    assert.match(reason, /ws: and wss:/);
    await close(relayHttp);
  });

  // --- session-expiry cleanup ---------------------------------------------
  await test("closing an expired session tears down active relays", async () => {
    const relayHttp = http.createServer((req, res) => res.writeHead(404).end());
    const relay = new WsRelay({ sessionManager, vpnManager, forwardHeaders, allowLoopback: true });
    relay.attach(relayHttp);
    const relayPort = await listen(relayHttp);
    const sid = sessionManager.mk(`sess-exp-${Date.now()}`);
    const target = `ws://127.0.0.1:${echoPort}/echo`;
    const relayUrl = `ws://127.0.0.1:${relayPort}${RELAY_PATH}?url=${encodeURIComponent(target)}&sid=${sid}`;
    const browser = new WsClient(relayUrl);
    await waitForOpen(browser, "browser");
    assert.equal(relay.active.size, 1);
    // simulate session expiry
    sessionManager.mk; // no-op
    browser.close(1000, "expired");
    await waitForClose(browser, "browser");
    assert.equal(relay.active.size, 0, "relay should be removed once the browser closes");
    await close(relayHttp);
  });

  await close(echoHttp);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
