"use strict";

/**
 * Veyra WebSocket Relay — proxies browser WebSocket connections through VeyraServer
 * so real-time sites (multiplayer games, chat, live feeds) work in Fast proxy mode
 * without Chromium.
 *
 * Route: HTTP Upgrade on GET /api/ws?url=<encoded wss://...>&sid=<session>&from=<virtual page>
 *
 * Design:
 *   1. The browser-facing wrapper in the fast-proxy HTML rewrite constructs a
 *      WebSocket to this relay instead of connecting directly to the destination.
 *   2. The relay authenticates the session, validates the public target, then opens a
 *      WebSocket to the target using the `ws` library with a custom `createConnection`
 *      that routes the underlying TCP socket through the session's configured VPN
 *      exit (SOCKS5/WireGuard/HTTP) when one is bound, otherwise direct with
 *      socket-time DNS protection.
 *   3. Both sides are `ws` objects, so framing, fragmentation, control frames and
 *      close-code semantics are handled correctly by `ws`. We only relay decoded
 *      payloads bidirectionally with bounded buffers.
 *   4. The upstream Origin is derived from the virtual page URL, and the session's
 *      cookie jar is consulted for the target host, exactly like /api/resource.
 */

const dns = require("dns");
const net = require("net");
const tls = require("tls");

let WebSocketServer = null, WebSocket = null;
try { ({ WebSocketServer, WebSocket } = require("ws")); } catch {}

const MAX_FRAME_BYTES = 4 * 1024 * 1024;          // 4 MiB per relayed message
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;      // 32 MiB total buffered per leg
const HANDSHAKE_TIMEOUT_MS = 15000;               // upstream handshake deadline
const MAX_RELAY_SESSIONS = 256;                  // concurrent WS relays per Express process

const RELAY_PATH = "/api/ws";

function isPublicIp(addr) {
  const ip = String(addr || "");
  if (!net.isIP(ip)) return false;
  if (net.isIPv4(ip)) {
    const [a0, a1, , a3] = ip.split(".").map(Number);
    if (a0 === 10 || a0 === 127 || a0 === 0 || a0 === 255) return false;
    if (a0 === 169 && a1 === 254) return false;
    if (a0 === 172 && a1 >= 16 && a1 <= 31) return false;
    if (a0 === 192 && a1 === 168) return false;
    if (a0 === 100 && a1 >= 64 && a1 <= 127) return false;
    if (a0 === 192 && a1 === 0 && a3 === 0) return false;
    if (a0 === 198 && (a1 === 18 || a1 === 19)) return false;
    if (a0 >= 224) return false;
    return true;
  }
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return false;
  if (v.startsWith("::ffff:")) return isPublicIp(v.slice(7));
  if (v.startsWith("fe80:") || v.startsWith("fc") || v.startsWith("fd")) return false;
  return true;
}

function parseWsTarget(raw) {
  const target = String(raw || "").trim();
  if (!target) throw Object.assign(new Error("Missing WebSocket target URL."), { code: "INVALID_URL" });
  let u;
  try { u = new URL(target); } catch { throw Object.assign(new Error("Invalid WebSocket target URL."), { code: "INVALID_URL" }); }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") throw Object.assign(new Error("Only ws: and wss: targets are supported."), { code: "INVALID_URL" });
  if (u.username || u.password) throw Object.assign(new Error("WebSocket targets with embedded credentials are not supported."), { code: "INVALID_URL" });
  if (u.hash) throw Object.assign(new Error("WebSocket targets with a fragment are not supported."), { code: "INVALID_URL" });
  const port = Number(u.port || (u.protocol === "wss:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error("Invalid WebSocket port."), { code: "INVALID_URL" });
  return { url: u, host: u.hostname, port, secure: u.protocol === "wss:", path: u.pathname + u.search };
}

/**
 * Returns a socket factory `(opts, cb) => socket` suitable for `ws`'s
 * `createConnection` option. Routes the TCP connection through the session's VPN
 * exit (if bound) or direct with socket-time DNS protection. For `wss:` we hand
 * `ws` an already-TLS-wrapped socket via `perMessageDeflate:false` + `createConnection`.
 */
/**
 * Resolve a raw TCP socket to the target, routed through the session's VPN exit
 * when one is bound, else direct with socket-time DNS protection.
 * For `wss:` the returned socket is already TLS-wrapped (ALPN http/1.1).
 */
async function openUpstreamSocket({ vpnManager, sid, host, port, secure, connectTimeoutMs, allowLoopback = false }) {
  let sock;
  const route = vpnManager?.route?.(sid, host) || null;
  if (route) {
    sock = await vpnManager.openTunnel(route.profile, host, port, route.conn);
  } else if (allowLoopback) {
    sock = await new Promise((res, rej) => {
      const s2 = net.connect({ host, port });
      const t = setTimeout(() => { s2.destroy(); rej(Object.assign(new Error(`Timed out connecting to ${host}:${port}`), { code: "WS_CONNECT_TIMEOUT" })); }, connectTimeoutMs);
      s2.once("connect", () => { clearTimeout(t); res(s2); });
      s2.once("error", e => { clearTimeout(t); rej(e); });
    });
  } else {
    // Direct connect with socket-time DNS protection (reject private/reserved targets).
    const addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
    if (!addrs.length) throw Object.assign(new Error("Target did not resolve."), { code: "WS_TARGET_UNRESOLVED" });
    for (const a of addrs) if (!isPublicIp(a.address)) throw Object.assign(new Error("WebSocket target resolved to a private or reserved address."), { code: "SSRF_BLOCKED" });
    sock = await new Promise((res, rej) => {
      const s2 = net.connect({ host, port });
      const t = setTimeout(() => { s2.destroy(); rej(Object.assign(new Error(`Timed out connecting to ${host}:${port}`), { code: "WS_CONNECT_TIMEOUT" })); }, connectTimeoutMs);
      s2.once("connect", () => { clearTimeout(t); res(s2); });
      s2.once("error", e => { clearTimeout(t); rej(e); });
    });
  }
  sock.setNoDelay(true);
  if (!secure) return sock;
  const tlsSock = tls.connect({ socket: sock, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ["http/1.1"] });
  await new Promise((res, rej) => {
    const t = setTimeout(() => { tlsSock.destroy(); rej(Object.assign(new Error("TLS handshake to WebSocket target timed out"), { code: "WS_TLS_TIMEOUT" })); }, connectTimeoutMs);
    tlsSock.once("secureConnect", () => { clearTimeout(t); res(); });
    tlsSock.once("error", e => { clearTimeout(t); rej(e); });
  });
  return tlsSock;
}

class WsRelay {
  constructor(deps = {}) {
    this.log = deps.log || (() => {});
    this.sessionManager = deps.sessionManager;                  // { checkLimit(sid), touch(sid) }
    this.vpnManager = deps.vpnManager;                          // { route(sid,host), openTunnel(...) }
    this.forwardHeaders = deps.forwardHeaders || (() => ({}));   // virtual-page-aware header mapper (cookies, UA)
    this.maxFrameBytes = deps.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.maxBufferedBytes = deps.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
    this.handshakeTimeoutMs = deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.connectTimeoutMs = deps.connectTimeoutMs ?? 12000;
    this.maxSessions = deps.maxSessions ?? MAX_RELAY_SESSIONS;
    this.allowLoopback = !!deps.allowLoopback; // tests/dev only — NEVER enable in production
    this.active = new Set();
    this.stats = { opened: 0, closed: 0, messagesRelayed: 0, bytesRelayed: 0, failures: 0 };
  }

  /**
   * Attach to an HTTP(S) server. Returns the WebSocketServer, or null if `ws` is missing.
   */
  attach(server) {
    if (!WebSocketServer || !server) return null;
    this.wss = new WebSocketServer({ server, path: RELAY_PATH });
    this.wss.on("connection", (ws, req) => { this.onConnection(ws, req).catch(e => this.log("warn", "WS-RELAY", `Handler error: ${e.message}`)); });
    this.wss.on("error", err => this.log("warn", "WS-RELAY", `Server error: ${err.message}`));
    return this.wss;
  }

  async onConnection(ws, req) {
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { try { ws.close(4001, "Invalid request"); } catch {} return; }
    const sid = String(url.searchParams.get("sid") || "").trim();
    const targetRaw = String(url.searchParams.get("url") || "");
    const fromRaw = String(url.searchParams.get("from") || "");
    const finish = (code, reason) => { try { if (ws.readyState === ws.OPEN) ws.close(code, String(reason || "").slice(0, 120)); } catch {} };

    // -- session auth ----------------------------------------------------
    if (!sid) return finish(4001, "Missing session");
    if (!this.sessionManager) return finish(500, "Session manager not configured");
    if (this.sessionManager.checkLimit?.(sid)) return finish(4008, "Session expired");
    try { this.sessionManager.touch?.(sid); } catch (e) { return finish(500, `Session lookup failed: ${e.message}`); }

    // -- target validation ------------------------------------------------
    let target;
    try { target = parseWsTarget(targetRaw); }
    catch (e) { this.stats.failures++; return finish(4001, e.message); }

    // Resolve the virtual page URL (for Origin and cookie forwarding) but do NOT trust it for routing.
    let fromUrl = "";
    try { const u = new URL(fromRaw); if (/^https?:$/.test(u.protocol)) fromUrl = u.href; } catch {}

    if (this.active.size >= this.maxSessions) { this.stats.failures++; return finish(4009, "Too many concurrent WebSocket relays"); }

    // -- upstream WebSocket via `ws` with a pre-warmed VPN-routed or direct socket --
    const subprotocols = (req.headers["sec-websocket-protocol"] || "").split(/,\s*/).filter(Boolean);
    const upstreamOrigin = (fromUrl && (() => { try { return new URL(fromUrl).origin; } catch { return ""; } })()) || "";
    const upstreamHeaders = this.forwardHeaders({ sid, target: target.url.href, fromUrl, origin: upstreamOrigin });

    let upstream;
    let rawSock = null;
    const state = { ws, sid, target, fromUrl, upstream: null, closed: false, bufferedDown: 0, bufferedUp: 0 };
    this.active.add(state);
    this.stats.opened++;

    const closeBoth = (code = 1000, reason = "") => {
      if (state.closed) return;
      state.closed = true;
      this.active.delete(state);
      this.stats.closed++;
      try { if (state.upstream && state.upstream.readyState !== WebSocket.CLOSED) state.upstream.close(code, String(reason || "").slice(0, 120)); } catch {}
      try { state.upstream?.terminate?.(); } catch {}
      try { rawSock?.destroy?.(); } catch {}
      finish(code, reason);
    };

    // Phase 1: resolve the raw socket (SOCKS5/WG/HTTP tunnel or direct).
    try {
      rawSock = await openUpstreamSocket({
        vpnManager: this.vpnManager,
        sid, host: target.host, port: target.port,
        secure: target.secure,
        connectTimeoutMs: this.connectTimeoutMs,
        allowLoopback: this.allowLoopback,
      });
    } catch (e) {
      this.stats.failures++;
      this.log("warn", "WS-RELAY", `Upstream connect to ${target.host}:${target.port} failed: ${e.code || e.message}`);
      return closeBoth(1011, `Upstream connection failed (${e.code || "CONNECT_FAILED"})`);
    }

    // Phase 2: hand `ws` the pre-warmed socket via createConnection.
    try {
      upstream = new WebSocket(target.url.href, subprotocols, {
        createConnection: () => rawSock,
        handshakeTimeout: this.handshakeTimeoutMs,
        perMessageDeflate: false, // avoid CPU/memory cost of per-connection compression
        headers: {
          ...(upstreamOrigin ? { origin: upstreamOrigin } : {}),
          ...upstreamHeaders,
        },
      });
      state.upstream = upstream;
    } catch (e) {
      this.stats.failures++;
      this.log("warn", "WS-RELAY", `Upstream WebSocket construction failed: ${e.code || e.message}`);
      return closeBoth(1011, `Upstream connection failed (${e.code || "CONNECT_FAILED"})`);
    }

    // -- wire handlers eagerly; buffer browser → upstream until the upstream opens --
    const pendingUpstreamSends = [];
    ws.on("message", (data, isBinary) => {
      if (state.closed) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length > this.maxFrameBytes) { closeBoth(1009, "Message exceeds relay limit"); return; }
      if (upstream.readyState !== WebSocket.OPEN) {
        // The upstream WebSocket has not completed its handshake yet. Buffer rather
        // than drop — some sites send an initial hello immediately after open.
        pendingUpstreamSends.push({ buf, isBinary });
        if (pendingUpstreamSends.reduce((n, x) => n + x.buf.length, 0) > this.maxBufferedBytes) {
          closeBoth(1009, "Relay buffer exceeded before upstream opened");
        }
        return;
      }
      try {
        state.bufferedUp += buf.length;
        if (state.bufferedUp > this.maxBufferedBytes) { closeBoth(1009, "Relay buffer exceeded"); return; }
        upstream.send(buf, { binary: isBinary }, () => { state.bufferedUp = Math.max(0, state.bufferedUp - buf.length); });
        this.stats.messagesRelayed++;
        this.stats.bytesRelayed += buf.length;
      } catch (e) {
        closeBoth(1011, `Relay send failed: ${e.message}`);
      }
    });
    ws.on("close", (code, reason) => {
      if (state.closed) return;
      state.closed = true;
      this.active.delete(state);
      this.stats.closed++;
      try { upstream.close(code, String(reason || "").slice(0, 120)); } catch {}
      try { rawSock?.destroy?.(); } catch {}
    });
    ws.on("error", () => { if (!state.closed) closeBoth(1011, "Browser WebSocket error"); });

    // -- upstream handshake -----------------------------------------------
    const handshakeTimer = setTimeout(() => closeBoth(1011, "Upstream handshake timed out"), this.handshakeTimeoutMs + this.connectTimeoutMs);
    upstream.once("open", () => {
      clearTimeout(handshakeTimer);
      this.log("info", "WS-RELAY", `Upstream to ${target.host} opened (proto=${upstream.protocol || ""}).`);
      try { ws.protocol = String(upstream.protocol || ""); } catch {}
      // Flush anything the page sent before the upstream completed its handshake.
      while (pendingUpstreamSends.length) {
        const { buf, isBinary } = pendingUpstreamSends.shift();
        try { upstream.send(buf, { binary: isBinary }); } catch (e) { closeBoth(1011, `Relay send failed: ${e.message}`); return; }
      }
      // -- upstream → browser ----------------------------------------------
      upstream.on("message", (data, isBinary) => {
        if (state.closed || wsClosed(ws)) return;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length > this.maxFrameBytes) { closeBoth(1009, "Message exceeds relay limit"); return; }
        state.bufferedDown += buf.length;
        if (state.bufferedDown > this.maxBufferedBytes) { closeBoth(1009, "Relay buffer exceeded"); return; }
        try { ws.send(buf, { binary: isBinary }, () => { state.bufferedDown = Math.max(0, state.bufferedDown - buf.length); }); } catch { return; }
        this.stats.messagesRelayed++;
        this.stats.bytesRelayed += buf.length;
      });
      upstream.on("close", (code, reason) => { if (!state.closed) closeBoth(code, reason); });
      upstream.on("error", err => { if (!state.closed) closeBoth(1011, `Upstream error: ${err.code || err.message}`); });
      upstream.on("ping", data => { try { if (ws.readyState === ws.OPEN) ws.ping(data); } catch {} });
      upstream.on("pong", data => { try { if (ws.readyState === ws.OPEN) ws.pong(data); } catch {} });
    });
    upstream.once("error", err => {
      clearTimeout(handshakeTimer);
      if (state.closed) return;
      this.stats.failures++;
      this.log("warn", "WS-RELAY", `Upstream ${target.host} failed: ${err.code || err.message}`);
      const code = err.code === "WS_CONNECT_TIMEOUT" || err.code === "WS_TARGET_UNRESOLVED" || err.code === "SSRF_BLOCKED" ? 1011 : 1011;
      closeBoth(code, `Upstream connection failed (${err.code || err.message})`);
    });
    upstream.once("unexpected-response", (req, res) => {
      clearTimeout(handshakeTimer);
      this.log("warn", "WS-RELAY", `Upstream ${target.host} rejected upgrade: HTTP ${res.statusCode}`);
      closeBoth(1011, `Upstream rejected upgrade (HTTP ${res.statusCode})`);
    });
    upstream.once("close", (code, reason) => {
      clearTimeout(handshakeTimer);
      if (!state.closed) closeBoth(code, reason);
    });
  }

  status() { return { ...this.stats, active: this.active.size, path: RELAY_PATH, available: !!WebSocketServer }; }
}

function wsClosed(ws) {
  return !ws || ws.readyState === undefined || ws.readyState === 3;
}

module.exports = { WsRelay, RELAY_PATH, isPublicIp, parseWsTarget, wsClosed, openUpstreamSocket, WebSocketServer, WebSocket };
