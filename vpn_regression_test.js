"use strict";
// VPN regression tests: SOCKS5 (auth + remote DNS), HTTP CONNECT (auth),
// kill switch, failover, sticky/rotating credentials, split tunnelling, the
// Chromium gateway, and a real WireGuard handshake between two userspace peers
// (skipped if bin/wireproxy is not installed).
const assert = require("assert");
const net = require("net");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { fetch } = require("undici");
const { VpnManager, parseProfile, hostMatches } = require("./vpn");

let passed = 0;
const check = async (name, fn) => { await fn(); passed += 1; console.log(`ok - ${name}`); };
const listen = (server, host = "127.0.0.1") => new Promise(r => server.listen(0, host, () => r(server.address().port)));
const quietLog = () => {};

// Minimal SOCKS5 server: user/pass auth, resolves names itself (remote DNS).
function socksServer({ user = "", pass = "", hosts = {} } = {}) {
  const seen = [];
  const server = net.createServer(sock => {
    sock.once("data", greet => {
      const wantAuth = !!(user || pass);
      if (wantAuth && !greet.slice(2).includes(0x02)) return sock.end(Buffer.from([5, 0xff]));
      sock.write(Buffer.from([5, wantAuth ? 2 : 0]));
      const afterAuth = () => sock.once("data", req => {
        let host, off;
        if (req[3] === 3) { const len = req[4]; host = req.slice(5, 5 + len).toString(); off = 5 + len; seen.push({ atyp: "domain", host }); }
        else { host = [...req.slice(4, 8)].join("."); off = 8; seen.push({ atyp: "ipv4", host }); }
        const port = req.readUInt16BE(off);
        const up = net.connect({ host: hosts[host] || host, port }, () => {
          sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          up.pipe(sock); sock.pipe(up);
        });
        up.on("error", () => sock.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])));
      });
      if (!wantAuth) return afterAuth();
      sock.once("data", auth => {
        const ul = auth[1], u = auth.slice(2, 2 + ul).toString(), pl = auth[2 + ul], p = auth.slice(3 + ul, 3 + ul + pl).toString();
        seen.push({ user: u });
        const ok = u.startsWith(user.replace("{session}", "")) && p === pass;
        sock.write(Buffer.from([1, ok ? 0 : 1]));
        if (ok) afterAuth(); else sock.end();
      });
    });
    sock.on("error", () => {});
  });
  server.seen = seen;
  server.count = host => seen.filter(x => x.host === host).length;
  return server;
}
// Minimal HTTP CONNECT proxy with Basic auth.
function connectProxy({ user, pass, hosts = {} }) {
  const server = http.createServer((q, r) => { r.writeHead(405); r.end(); });
  server.connects = 0;
  server.on("connect", (req, sock) => {
    const auth = String(req.headers["proxy-authorization"] || "");
    if (auth !== `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`) return sock.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    server.connects += 1;
    const [h, p] = req.url.split(":");
    const up = net.connect({ host: hosts[h] || h, port: Number(p) }, () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.pipe(sock); sock.pipe(up); });
    up.on("error", () => sock.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  });
  return server;
}

(async () => {
  const origin = http.createServer((q, r) => r.end(`origin:${q.url}`));
  const originPort = await listen(origin);

  await check("profile parsing: http/https/socks5/socks5h/wireguard + rejects junk", () => {
    assert.strictEqual(parseProfile({ id: "a", server: "http://u:p@proxy.example:3128" }).username, "u");
    assert.strictEqual(parseProfile({ id: "b", server: "socks5h://proxy.example" }).type, "socks5");
    assert.strictEqual(parseProfile({ id: "b", server: "socks5h://proxy.example" }).port, 1080);
    assert.strictEqual(parseProfile({ id: "c", server: "https://proxy.example" }).port, 443);
    assert.strictEqual(parseProfile({ id: "w", config: "[Interface]\nPrivateKey=x\n[Peer]\nPublicKey=y" }).type, "wireguard");
    assert.strictEqual(parseProfile({ id: "x", server: "ftp://nope" }), null);
    assert.strictEqual(parseProfile({ id: "bad id!", server: "http://p:1" }), null);
    assert.strictEqual(parseProfile({ id: "w2", config: "not a config" }), null);
  });

  await check("split-tunnel host matching (suffix, wildcard, CIDR, <local>)", () => {
    assert.ok(hostMatches("www.youtube.com", ["youtube.com"]));
    assert.ok(!hostMatches("notyoutube.com", ["youtube.com"]));
    assert.ok(hostMatches("a.b.example.org", ["*.example.org"]));
    assert.ok(!hostMatches("example.org", ["*.example.org"]));
    assert.ok(hostMatches("10.1.2.3", ["10.0.0.0/8"]));
    assert.ok(hostMatches("intranet", ["<local>"]));
  });

  // SOCKS5 with auth + remote DNS: "origin.vpn" only resolves inside the tunnel.
  const socks = socksServer({ user: "user-{session}", pass: "pw", hosts: { "origin.vpn": "127.0.0.1" } });
  const socksPort = await listen(socks);
  const socksB = socksServer({ hosts: { "origin.vpn": "127.0.0.1" } });
  const socksBPort = await listen(socksB);
  const httpProxy = connectProxy({ user: "hu", pass: "hp", hosts: { "origin.vpn": "127.0.0.1" } });
  const httpProxyPort = await listen(httpProxy);

  const env = {
    VPN_ENABLED: "1", VPN_HEALTH_INTERVAL_MS: "0", VPN_FAILURE_THRESHOLD: "1",
    VPN_PROFILES_JSON: JSON.stringify([
      { id: "s1", server: `socks5://127.0.0.1:${socksPort}`, username: "user-{session}", password: "pw", group: "eu", region: "uk", timezone: "Europe/London", locale: "en-GB" },
      { id: "s2", server: `socks5h://127.0.0.1:${socksBPort}`, group: "eu", region: "uk" },
      { id: "h1", server: `http://127.0.0.1:${httpProxyPort}`, username: "hu", password: "hp", group: "us", region: "us" }
    ])
  };
  const vpn = new VpnManager(quietLog, env);
  const sid = "sessAAAAAAAAAAAAAAAA";

  await check("SOCKS5 tunnel with auth + remote DNS (name resolved at the exit)", async () => {
    vpn.connect(sid, "s1");
    const r = await fetch(`http://origin.vpn:${originPort}/hello`, { dispatcher: vpn.dispatcherForSession(sid) });
    assert.strictEqual(await r.text(), "origin:/hello");
    assert.ok(socks.seen.some(s => s.atyp === "domain" && s.host === "origin.vpn"), "hostname must be sent to the exit, not resolved locally");
  });

  await check("sticky {session} credentials: stable per session, change on rotate", async () => {
    const users = () => socks.seen.filter(s => s.user).map(s => s.user);
    const before = users().at(-1);
    assert.match(before, /^user-[0-9a-f]{12}$/);
    const other = "sessBBBBBBBBBBBBBBBB";
    vpn.connect(other, "s1");
    await (await fetch(`http://origin.vpn:${originPort}/b`, { dispatcher: vpn.dispatcherForSession(other) })).text();
    assert.notStrictEqual(users().at(-1), before, "different sessions get different exits");
    vpn.rotate(sid);
    await (await fetch(`http://origin.vpn:${originPort}/c`, { dispatcher: vpn.dispatcherForSession(sid) })).text();
    assert.notStrictEqual(users().at(-1), before, "rotate gives a new sticky tag");
    assert.strictEqual(vpn.profileForSession(sid).id, "s1", "rotation via credentials keeps the same profile");
    vpn.disconnect(other);
  });

  await check("HTTP CONNECT tunnel with Basic auth", async () => {
    const s = "sessHHHHHHHHHHHHHHHH";
    vpn.connect(s, "h1");
    const r = await fetch(`http://origin.vpn:${originPort}/via-http`, { dispatcher: vpn.dispatcherForSession(s) });
    assert.strictEqual(await r.text(), "origin:/via-http");
    assert.ok(httpProxy.connects >= 1);
    vpn.disconnect(s);
  });

  await check("wrong CONNECT credentials are reported as VPN_AUTH_FAILED", async () => {
    const bad = new VpnManager(quietLog, { VPN_ENABLED: "1", VPN_HEALTH_INTERVAL_MS: "0", VPN_PROXY_SERVER: `http://127.0.0.1:${httpProxyPort}`, VPN_PROXY_USERNAME: "hu", VPN_PROXY_PASSWORD: "wrong" });
    await assert.rejects(bad.openTunnel(bad.get("default"), "origin.vpn", originPort), e => e.code === "VPN_AUTH_FAILED");
    await bad.close();
  });

  await check("health check reports exit IP + latency through the tunnel", async () => {
    const ipSrv = http.createServer((q, r) => r.end(JSON.stringify({ ip: "203.0.113.7" })));
    const ipPort = await listen(ipSrv);
    const m = new VpnManager(quietLog, { ...env, VPN_HEALTH_URL: `http://origin.vpn:${ipPort}/` });
    const r = await m.test("s2");
    assert.strictEqual(r.exitIp, "203.0.113.7");
    assert.ok(r.latencyMs >= 0);
    assert.strictEqual(m.publicProfile(m.get("s2")).health.healthy, true);
    await m.close(); ipSrv.close();
  });

  await check("public profile/status never leaks servers or credentials", () => {
    const text = JSON.stringify(vpn.status());
    for (const secret of ["pw", "hp", String(socksPort), String(httpProxyPort), "127.0.0.1"]) assert.ok(!text.includes(`"${secret}"`) && !text.includes(`:${secret}`), `status leaked ${secret}`);
  });

  await check("failover: dead profile → next healthy profile in the same group", async () => {
    const s = "sessFFFFFFFFFFFFFFFF";
    vpn.connect(s, "s1");
    vpn.notePassive("s1", false, "simulated outage");
    const r = await fetch(`http://origin.vpn:${originPort}/failover`, { dispatcher: vpn.dispatcherForSession(s) });
    assert.strictEqual(await r.text(), "origin:/failover");
    assert.strictEqual(vpn.profileForSession(s).id, "s2", "moved to s2 (same eu group)");
    assert.ok(vpn.stats.failovers >= 1);
    vpn.notePassive("s1", true);
    vpn.disconnect(s);
  });

  await check("kill switch: all exits down → request blocked, never sent direct", async () => {
    const m = new VpnManager(quietLog, { VPN_ENABLED: "1", VPN_HEALTH_INTERVAL_MS: "0", VPN_FAILURE_THRESHOLD: "1", VPN_PROXY_SERVER: "socks5://127.0.0.1:1" });
    const s = "sessKKKKKKKKKKKKKKKK";
    m.connect(s, "default");
    await assert.rejects(fetch(`http://127.0.0.1:${originPort}/leak`, { dispatcher: m.dispatcherForSession(s) }));
    await assert.rejects(fetch(`http://127.0.0.1:${originPort}/leak2`, { dispatcher: m.dispatcherForSession(s) }), e => (e.cause || e).code === "VPN_KILL_SWITCH");
    assert.ok(m.stats.killSwitchBlocks >= 1);
    await m.close();
  });

  await check("kill switch off: falls back to direct when every exit is down", async () => {
    const m = new VpnManager(quietLog, { VPN_ENABLED: "1", VPN_HEALTH_INTERVAL_MS: "0", VPN_FAILURE_THRESHOLD: "1", VPN_KILL_SWITCH: "0", VPN_PROXY_SERVER: "socks5://127.0.0.1:1" });
    const s = "sessDDDDDDDDDDDDDDDD";
    m.connect(s, "default");
    m.notePassive("default", false, "down");
    const r = await fetch(`http://127.0.0.1:${originPort}/direct`, { dispatcher: m.dispatcherForSession(s) });
    assert.strictEqual(await r.text(), "origin:/direct");
    await m.close();
  });

  await check("split tunnel: VPN_SPLIT_BYPASS hosts go direct, others through the tunnel", async () => {
    const m = new VpnManager(quietLog, { ...env, VPN_SPLIT_BYPASS: "127.0.0.1" });
    const s = "sessSSSSSSSSSSSSSSSS";
    m.connect(s, "s2");
    const before = socksB.count("127.0.0.1"), beforeVpn = socksB.count("origin.vpn");
    await (await fetch(`http://127.0.0.1:${originPort}/bypass`, { dispatcher: m.dispatcherForSession(s) })).text();
    assert.strictEqual(socksB.count("127.0.0.1"), before, "bypassed host must not touch the tunnel");
    await (await fetch(`http://origin.vpn:${originPort}/tunnel`, { dispatcher: m.dispatcherForSession(s) })).text();
    assert.strictEqual(socksB.count("origin.vpn"), beforeVpn + 1);
    await m.close();
  });

  await check("always-on mode connects sessions automatically; auto picks by region", async () => {
    const m = new VpnManager(quietLog, { ...env, VPN_ALWAYS_ON: "1", VPN_DEFAULT_PROFILE: "s2" });
    assert.ok(m.dispatcherForSession("sessOOOOOOOOOOOOOOOO"));
    assert.strictEqual(m.profileForSession("sessOOOOOOOOOOOOOOOO").id, "s2");
    const r = m.connect("sessRRRRRRRRRRRRRRRR", "auto", { region: "us" });
    assert.strictEqual(r.profile.id, "h1");
    await m.close();
  });

  await check("crawler VPN profile (VPN_CRAWLER_PROFILE) routes crawler traffic", async () => {
    const m = new VpnManager(quietLog, { ...env, VPN_CRAWLER_PROFILE: "s2" });
    const before = socksB.count("origin.vpn");
    await (await fetch(`http://origin.vpn:${originPort}/crawler`, { dispatcher: m.dispatcherForCrawler() })).text();
    assert.strictEqual(socksB.count("origin.vpn"), before + 1);
    await m.close();
  });

  await check("Chromium gateway: 407 without auth, CONNECT tunnels with session token, browser hints", async () => {
    const proxy = await vpn.playwrightProxy(sid);
    assert.match(proxy.server, /^http:\/\/127\.0\.0\.1:\d+$/);
    const port = Number(proxy.server.split(":").pop());
    const raw = (headers) => new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write(`CONNECT origin.vpn:${originPort} HTTP/1.1\r\nHost: origin.vpn:${originPort}\r\n${headers}\r\n`));
      let buf = ""; s.on("data", d => { buf += d; if (buf.includes("\r\n\r\n")) { if (buf.startsWith("HTTP/1.1 200")) { s.write(`GET /gw HTTP/1.1\r\nHost: origin.vpn\r\nConnection: close\r\n\r\n`); s.removeAllListeners("data"); let body = ""; s.on("data", x => body += x); s.on("end", () => resolve(buf + body)); } else { resolve(buf); s.destroy(); } } });
    });
    assert.match(await raw(""), /^HTTP\/1.1 407/);
    assert.match(await raw(`Proxy-Authorization: Basic ${Buffer.from(`${sid}:wrongwrongwrongwrongwrongwrong12`).toString("base64")}\r\n`), /^HTTP\/1.1 407/);
    const ok = await raw(`Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}\r\n`);
    assert.match(ok, /origin:\/gw/);
    assert.deepStrictEqual(vpn.browserContextHints(sid), { timezoneId: "Europe/London", locale: "en-GB" });
  });

  await check("gateway blocks private destinations for non-tunnelled routes", async () => {
    const m = new VpnManager(quietLog, { ...env, VPN_SPLIT_BYPASS: "localhost,127.0.0.1" });
    m.connect("sessPPPPPPPPPPPPPPPP", "s2");
    await assert.rejects(m.gatewayOpen("sessPPPPPPPPPPPPPPPP", "127.0.0.1", originPort), e => e.code === "VPN_BLOCKED");
    await m.close();
  });

  await check("idle VPN sessions are disconnected by the sweeper", async () => {
    const m = new VpnManager(quietLog, { ...env, VPN_SESSION_IDLE_MS: "60000" });
    m.connect("sessIIIIIIIIIIIIIIII", "s2");
    m.connections.get("sessIIIIIIIIIIIIIIII").lastUsed = Date.now() - 120000;
    await m.tick();
    assert.strictEqual(m.connections.has("sessIIIIIIIIIIIIIIII"), false);
    await m.close();
  });

  // Real WireGuard: two wireproxy peers over loopback UDP.
  const bin = path.join(__dirname, "bin", "wireproxy");
  if (fs.existsSync(bin)) {
    await check("WireGuard: real handshake + HTTP through the encrypted tunnel (wireproxy)", async () => {
      const kp = () => { const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519"); const b = s => Buffer.from(s, "base64url").toString("base64"); return { pub: b(publicKey.export({ format: "jwk" }).x), priv: b(privateKey.export({ format: "jwk" }).d) }; };
      const A = kp(), B = kp();
      const udp = 51000 + Math.floor(Math.random() * 1000);
      const conf = path.join(require("os").tmpdir(), `veyra-wg-peer-${process.pid}.conf`);
      fs.writeFileSync(conf, `[Interface]\nAddress = 10.66.0.2/32\nPrivateKey = ${B.priv}\nListenPort = ${udp}\n\n[Peer]\nPublicKey = ${A.pub}\nAllowedIPs = 10.66.0.1/32\n\n[TCPServerTunnel]\nListenPort = 8080\nTarget = 127.0.0.1:${originPort}\n`);
      const peer = spawn(bin, ["-c", conf, "-s"], { stdio: "ignore" });
      try {
        await new Promise(r => setTimeout(r, 400));
        const m = new VpnManager(quietLog, { VPN_ENABLED: "1", VPN_HEALTH_INTERVAL_MS: "0", VPN_WIREGUARD_CONFIG: `[Interface]\\nAddress = 10.66.0.1/32\\nPrivateKey = ${A.priv}\\n\\n[Peer]\\nPublicKey = ${B.pub}\\nEndpoint = 127.0.0.1:${udp}\\nAllowedIPs = 10.66.0.0/24\\n` });
        m.connect("sessWWWWWWWWWWWWWWWW", "wireguard");
        const r = await fetch("http://10.66.0.2:8080/wg", { dispatcher: m.dispatcherForSession("sessWWWWWWWWWWWWWWWW") });
        assert.strictEqual(await r.text(), "origin:/wg");
        assert.strictEqual(m.tunnels.get("wireguard").status().state, "running");
        m.tunnels.get("wireguard").lastUsed = 0; m.disconnect("sessWWWWWWWWWWWWWWWW");
        m.wgIdleMs = 0; await m.tick();
        assert.strictEqual(m.tunnels.get("wireguard").status().state, "stopped", "idle WireGuard tunnel is stopped to save resources");
        await m.close();
      } finally { peer.kill(); try { fs.unlinkSync(conf); } catch {} }
    });
  } else console.log("skip - WireGuard e2e (run `node install-wireproxy.js` first)");

  await check("missing wireproxy binary gives a clear error", async () => {
    const m = new VpnManager(quietLog, { VPN_ENABLED: "1", VPN_HEALTH_INTERVAL_MS: "0", VPN_WIREPROXY_BIN: "/nonexistent", VPN_WIREGUARD_CONFIG: "[Interface]\\nPrivateKey = x\\n[Peer]\\nPublicKey = y\\nEndpoint = 127.0.0.1:1\\n" });
    m.wireproxyBin = ""; m.tunnels.get("wireguard").bin = "";
    await assert.rejects(m.openTunnel(m.get("wireguard"), "example.com", 80), e => e.code === "VPN_WG_UNAVAILABLE");
    await m.close();
  });

  await vpn.close();
  for (const s of [origin, socks, socksB, httpProxy]) s.close();
  console.log(`\n${passed} VPN checks passed.`);
  process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
