#!/usr/bin/env node
"use strict";
/**
 * VeyraVPN Node — run this on your own machine (VPS, home server, Raspberry Pi)
 * to create an authenticated SOCKS5 proxy that Veyra Browser can import as a VPN profile.
 *
 * Your traffic exits through YOUR machine's IP — not a datacenter. This is the
 * honest way to get a residential/private IP for Veyra.
 *
 * Quick start:
 *   node veyra-node.js
 *
 * Then paste the temporary code printed by this script into:
 *   Veyra Browser → Settings → Veyra VPN → Paste Veyra Node code
 *
 * Or import the JSON config Veyra generates automatically.
 *
 * Options:
 *   --port=1080        SOCKS5 port (default 1080)
 *   --user=veyra       username (default: veyra)
 *   --pass=<token>     password (default: auto-generated)
 *   --name=My Node     profile name
 *   --region=UK        region label
 *   --public-ip=1.2.3.4 override automatic public-IP detection
 *   --print-json      print Veyra import JSON and exit
 *   --code-minutes=10 enrollment-code lifetime (default: 10 minutes)
 *
 * No dependencies — pure Node.js, runs anywhere Node 18+ is installed.
 */

const net = require("net");
const crypto = require("crypto");
const os = require("os");
const https = require("https");

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, ...v] = a.replace(/^--/, "").split("=");
  return [k, v.join("=") || true];
}));

const PORT = Math.max(1, Math.min(65535, Number(args.port) || 1080));
const USER = args.user || "veyra";
const PASS = args.pass || crypto.randomBytes(12).toString("base64url");
const NAME = args.name || "VeyraVPN Node";
const REGION = args.region || "";
const PUBLIC_IP_OVERRIDE = String(args["public-ip"] || "").trim();
const PRINT_JSON = args["print-json"] || args.json || false;
const CODE_MINUTES = Math.max(1, Math.min(60, Number(args["code-minutes"]) || 10));

// ---- Helpers ----

function formatHost(ip, port) {
  // IPv6 addresses need brackets in host:port format
  if (ip.includes(":")) return `[${ip}]:${port}`;
  return `${ip}:${port}`;
}

function fetchPublicIP() {
  return new Promise(resolve => {
    const req = https.get("https://api64.ipify.org?format=json", res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data).ip); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
  });
}

function makeNodeCode(config, publicIP) {
  const payload = {
    v: 1,
    nonce: crypto.randomBytes(8).toString("hex"),
    expiresAt: Date.now() + CODE_MINUTES * 60 * 1000,
    name: config.name,
    type: config.type,
    server: config.server,
    username: config.username,
    password: config.password,
    region: config.region || "",
    publicIp: publicIP || ""
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const checksum = crypto.createHash("sha256").update(body).digest("hex").slice(0, 16);
  return `VNODE1.${body}.${checksum}`;
}

// ---- SOCKS5 server ----
const STATES = { AUTH: 0, AUTH2: 1, REQ: 2, CONNECTING: 3, PIPE: 4 };

function newSession() {
  return { state: STATES.AUTH, buf: Buffer.alloc(0), target: null, port: null, remote: null };
}

function handleAuth(session, sock) {
  if (session.buf.length < 2) return;
  const ver = session.buf[0];
  const nMethods = session.buf[1];
  if (ver !== 0x05) { sock.end(); return; }
  if (session.buf.length < 2 + nMethods) return;
  const methods = session.buf.subarray(2, 2 + nMethods);
  session.buf = session.buf.subarray(2 + nMethods);

  // Always require username/password (method 0x02) — never offer no-auth
  if (!methods.includes(0x02)) {
    sock.write(Buffer.from([0x05, 0xFF])); // No acceptable methods
    sock.end();
    return;
  }
  sock.write(Buffer.from([0x05, 0x02])); // Select username/password
  session.state = STATES.AUTH2;
}

function handleAuth2(session, sock) {
  if (session.buf.length < 2) return;
  const ver = session.buf[0];
  if (ver !== 0x01) { sock.end(); return; }
  const uLen = session.buf[1];
  if (session.buf.length < 3 + uLen) return;
  const username = session.buf.subarray(2, 2 + uLen).toString();
  const pLen = session.buf[2 + uLen];
  if (session.buf.length < 3 + uLen + pLen) return;
  const password = session.buf.subarray(3 + uLen, 3 + uLen + pLen).toString();
  session.buf = session.buf.subarray(3 + uLen + pLen);

  if (username !== USER || password !== PASS) {
    sock.write(Buffer.from([0x01, 0x01])); // Auth failed
    sock.end();
    return;
  }
  sock.write(Buffer.from([0x01, 0x00])); // Auth success
  session.state = STATES.REQ;
}

function handleRequest(session, sock) {
  if (session.buf.length < 4) return;
  const ver = session.buf[0];
  const cmd = session.buf[1];
  const atyp = session.buf[3];

  if (ver !== 0x05 || cmd !== 0x01) { // Only CONNECT
    sock.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    sock.end();
    return;
  }

  let target, port, headerLen;
  if (atyp === 0x01) { // IPv4
    if (session.buf.length < 10) return;
    target = session.buf.subarray(4, 8).join(".");
    port = session.buf.readUInt16BE(8);
    headerLen = 10;
  } else if (atyp === 0x03) { // Domain
    if (session.buf.length < 5) return;
    const dLen = session.buf[4];
    if (session.buf.length < 5 + dLen + 2) return;
    target = session.buf.subarray(5, 5 + dLen).toString();
    port = session.buf.readUInt16BE(5 + dLen);
    headerLen = 5 + dLen + 2;
  } else if (atyp === 0x04) { // IPv6
    if (session.buf.length < 22) return;
    const parts = [];
    for (let i = 4; i < 20; i += 2) parts.push(((session.buf[i] << 8) | session.buf[i+1]).toString(16).padStart(4, "0"));
    target = parts.join(":");
    port = session.buf.readUInt16BE(20);
    headerLen = 22;
  } else {
    sock.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    sock.end();
    return;
  }

  session.buf = session.buf.subarray(headerLen);
  // Set CONNECTING state immediately so the while loop doesn't re-enter
  // handleRequest before the async net.connect callback fires.
  session.state = STATES.CONNECTING;

  // Connect to the target
  const remote = net.connect(port, target, () => {
    sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    session.state = STATES.PIPE;
    // Pipe both ways
    sock.pipe(remote);
    remote.pipe(sock);
  });
  remote.on("error", () => {
    if (session.state === STATES.PIPE) return; // already piped, let close handle it
    sock.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    sock.end();
  });
  sock.on("error", () => { try { remote.destroy(); } catch {} });
  remote.on("close", () => { try { sock.end(); } catch {} });
  sock.on("close", () => { try { remote.destroy(); } catch {} });
}

const server = net.createServer(sock => {
  const session = newSession();
  // Idle timeout: drop connections that never authenticate or send a request
  sock.setTimeout(30000, () => { sock.end(); });
  sock.on("data", data => {
    // Reset idle timeout on activity
    sock.setTimeout(120000);
    session.buf = session.buf.length ? Buffer.concat([session.buf, data]) : data;
    if (session.buf.length > 65536) { sock.end(); return; }

    // Process all complete messages in the buffer (handles pipelined data)
    let progress = true;
    while (progress && session.buf.length > 0 && session.state < STATES.CONNECTING) {
      progress = false;

      if (session.state === STATES.AUTH) {
        const before = session.buf.length;
        handleAuth(session, sock);
        progress = session.buf.length !== before;
      }
      if (session.state === STATES.AUTH2) {
        const before = session.buf.length;
        handleAuth2(session, sock);
        progress = session.buf.length !== before;
      }
      if (session.state === STATES.REQ) {
        const before = session.buf.length;
        handleRequest(session, sock);
        progress = session.buf.length !== before;
      }
    }
  });
  sock.on("error", () => {});
});

// Listen on :: for dual-stack IPv4+IPv6 (ipv6Only defaults to false in Node.js)
server.listen(PORT, "::", async () => {
  // Get local IPs for display (both IPv4 and IPv6)
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      if (!iface.internal) ips.push({ name, address: iface.address, family: iface.family });
    }
  }

  // Auto-detect public IP
  if (PUBLIC_IP_OVERRIDE && !net.isIP(PUBLIC_IP_OVERRIDE)) throw new Error("--public-ip must be a valid IPv4 or IPv6 address");
  const publicIP = PUBLIC_IP_OVERRIDE || await fetchPublicIP();
  const hostAddr = publicIP ? formatHost(publicIP, PORT) : `<your-public-ip>:${PORT}`;
  // Veyra's parseProfile expects a full URL with protocol prefix (socks5://host:port)
  const serverAddr = `socks5://${hostAddr}`;

  const veyraConfig = {
    name: NAME,
    type: "socks5",
    server: serverAddr,
    username: USER,
    password: PASS,
    region: REGION,
    note: publicIP ? "Auto-detected public IP." : "Replace <your-public-ip> with your public IP. Run 'curl ifconfig.me' to find it.",
  };
  const nodeCode = makeNodeCode(veyraConfig, publicIP);

  if (PRINT_JSON) {
    console.log(JSON.stringify(veyraConfig, null, 2));
    process.exit(0);
  }

  console.log("");
  console.log("  ╔══════════════════════════════════════════╗");
  console.log("  ║         VeyraVPN Node is running          ║");
  console.log("  ╚══════════════════════════════════════════╝");
  console.log("");
  console.log(`  Port:     ${PORT}`);
  console.log(`  Username: ${USER}`);
  console.log(`  Password: ${PASS}`);
  if (publicIP) {
    console.log(`  Public IP: ${publicIP}`);
    console.log(`  Dual-stack: IPv4 + IPv6`);
  }
  console.log("");
  console.log("  Local IPs:");
  for (const ip of ips) console.log(`    ${ip.name} (${ip.family}): ${formatHost(ip.address, PORT)}`);
  console.log("");
  console.log(`  Temporary Veyra Node code (expires in ${CODE_MINUTES} minutes):`);
  console.log(`  ${nodeCode}`);
  console.log("");
  console.log("  Paste it in Veyra Settings → Veyra VPN → Paste Veyra Node code.");
  console.log("  Treat this code like a password; anyone with it can use this node until it expires.");
  console.log("");
  console.log("  To add this to Veyra Browser:");
  console.log("    1. In Veyra: VPN -> Add Profile");
  console.log("    2. Type: SOCKS5");
  console.log(`    3. Server: ${serverAddr}`);
  console.log(`    4. Username: ${USER}`);
  console.log(`    5. Password: ${PASS}`);
  console.log("");
  console.log("  Or import this JSON config:");
  console.log(JSON.stringify(veyraConfig, null, 2));
  console.log("");
  console.log("  Press Ctrl+C to stop.");
  console.log("");
});
