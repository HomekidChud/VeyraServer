"use strict";
// Veyra VPN — per-session encrypted tunnels for the proxy, crawler and Chromium.
//
// Upstream types:
//   http / https   HTTP CONNECT proxies (https = TLS to the proxy itself)
//   socks5         SOCKS5 with remote DNS (hostnames resolved at the exit)
//   wireguard      Real WireGuard, run in userspace by `wireproxy` (no root
//                  needed, works on Render). Paste a normal wg-quick config.
//
// Features: health checks with exit-IP + latency, automatic failover between
// profiles, kill switch (fail closed instead of leaking the Render IP), sticky
// or rotating exits, split tunnelling (bypass / only lists), always-on mode,
// a local authenticated gateway so Chromium follows the same routing, and
// lazy start / idle stop of WireGuard tunnels so Render isn't kept busy.

const net = require("net");
const tls = require("tls");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns").promises;
const { spawn } = require("child_process");
const { Agent, buildConnector } = require("undici");

function envBool(env, name, fallback) {
  const raw = String(env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}
function envNum(env, name, fallback, min, max) {
  const n = Number(env[name]);
  if (!Number.isFinite(n) || String(env[name] ?? "").trim() === "") return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
function csv(value) { return String(value || "").split(/[,\s;]+/).map(s => s.trim().toLowerCase()).filter(Boolean); }
function vpnError(message, code, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }

// Host pattern matching for bypass/only lists: "example.com" matches the host
// and its subdomains, "*.example.com" subdomains only, "10.0.0.0/8" CIDRs,
// "<local>" plain hostnames without dots.
function hostMatches(host, patterns) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  for (const p of patterns) {
    if (!p) continue;
    if (p === "<local>") { if (!h.includes(".")) return true; continue; }
    if (p.includes("/") && net.isIP(h)) { if (cidrContains(p, h)) return true; continue; }
    if (p.startsWith("*.")) { if (h.endsWith(p.slice(1))) return true; continue; }
    const bare = p.replace(/^\./, "");
    if (h === bare || h.endsWith(`.${bare}`)) return true;
  }
  return false;
}
function cidrContains(cidr, ip) {
  const [range, bitsRaw] = cidr.split("/");
  if (net.isIPv4(range) && net.isIPv4(ip)) {
    const bits = Number(bitsRaw);
    const toInt = a => a.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (toInt(range) & mask) === (toInt(ip) & mask);
  }
  return false;
}
function privateIp(ip) {
  if (net.isIPv4(ip)) return ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4"].some(c => cidrContains(c, ip));
  const v = String(ip).toLowerCase();
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------
const PROFILE_TYPES = ["http", "https", "socks5", "wireguard"];
function parseProfile(raw, fallbackId = "") {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || fallbackId || "").trim().slice(0, 64);
  if (!id || !/^[A-Za-z0-9_.:-]+$/.test(id)) return null;
  let type = String(raw.type || "").trim().toLowerCase();
  let server = String(raw.server || raw.proxy || "").trim();
  let host = "", port = 0, username = String(raw.username || ""), password = String(raw.password || "");
  let wgConfig = "";
  if (!type && (raw.wireguard || raw.config || raw.configFile || raw.configBase64 || raw.configB64)) type = "wireguard";
  if (type === "wireguard" || type === "wg") {
    type = "wireguard";
    wgConfig = String(raw.wireguard || raw.config || "");
    if (!wgConfig && (raw.configBase64 || raw.configB64)) { try { wgConfig = Buffer.from(String(raw.configBase64 || raw.configB64), "base64").toString("utf8"); } catch {} }
    if (!wgConfig && raw.configFile) { try { wgConfig = fs.readFileSync(String(raw.configFile), "utf8"); } catch {} }
    if (!/\[Interface\]/i.test(wgConfig) || !/\[Peer\]/i.test(wgConfig)) return null;
  } else {
    let u;
    try { u = new URL(server); } catch { return null; }
    const proto = u.protocol.replace(":", "").toLowerCase();
    type = type || ({ http: "http", https: "https", socks: "socks5", socks5: "socks5", socks5h: "socks5" })[proto] || "";
    if (!["http", "https", "socks5"].includes(type)) return null;
    host = u.hostname.replace(/^\[|\]$/g, "");
    port = Number(u.port) || (type === "https" ? 443 : type === "http" ? 8080 : 1080);
    if (!username && u.username) username = decodeURIComponent(u.username);
    if (!password && u.password) password = decodeURIComponent(u.password);
    server = `${type}://${host.includes(":") ? `[${host}]` : host}:${port}`;
  }
  return {
    id, type,
    name: String(raw.name || id).trim().slice(0, 100),
    server, host, port,
    username: username.slice(0, 256), password: password.slice(0, 512),
    wgConfig,
    bypass: csv(raw.bypass),
    region: String(raw.region || "").slice(0, 80),
    country: String(raw.country || "").slice(0, 8).toUpperCase(),
    group: String(raw.group || raw.region || "default").slice(0, 64).toLowerCase(),
    provider: String(raw.provider || (type === "wireguard" ? "WireGuard" : "Configured gateway")).slice(0, 120),
    timezone: String(raw.timezone || "").slice(0, 64),
    locale: String(raw.locale || "").slice(0, 32),
    weight: Math.max(1, Math.min(100, Number(raw.weight) || 1)),
    sticky: raw.sticky !== false
  };
}

function loadProfilesFromEnv(env, log) {
  const out = [];
  const pushAll = (list, where) => {
    if (!Array.isArray(list)) { log("warn", "VPN", `${where} must be a JSON array of profiles.`); return; }
    for (const item of list) {
      const p = parseProfile(item);
      if (p) out.push(p); else log("warn", "VPN", `${where}: skipped invalid profile ${JSON.stringify(item?.id || item?.name || "(no id)")}.`);
    }
  };
  const raw = String(env.VPN_PROFILES_JSON || "").trim();
  if (raw) { try { pushAll(JSON.parse(raw), "VPN_PROFILES_JSON"); } catch (e) { log("warn", "VPN", `VPN_PROFILES_JSON invalid: ${e.message}`); } }
  const file = String(env.VPN_PROFILES_FILE || "").trim();
  if (file) { try { pushAll(JSON.parse(fs.readFileSync(file, "utf8")), "VPN_PROFILES_FILE"); } catch (e) { log("warn", "VPN", `VPN_PROFILES_FILE unreadable: ${e.message}`); } }
  const single = parseProfile({
    id: env.VPN_PROFILE_ID || "default", name: env.VPN_PROFILE_NAME || "Veyra VPN",
    server: env.VPN_PROXY_SERVER || "", username: env.VPN_PROXY_USERNAME || "", password: env.VPN_PROXY_PASSWORD || "",
    bypass: env.VPN_PROXY_BYPASS || "", region: env.VPN_REGION || "", provider: env.VPN_PROVIDER_NAME || "Configured gateway",
    timezone: env.VPN_TIMEZONE || "", locale: env.VPN_LOCALE || ""
  });
  if (single && !out.some(p => p.id === single.id)) out.push(single);
  const wgRaw = env.VPN_WIREGUARD_CONFIG || "";
  const wgB64 = env.VPN_WIREGUARD_CONFIG_B64 || "";
  const wgFile = env.VPN_WIREGUARD_CONFIG_FILE || "";
  if (wgRaw || wgB64 || wgFile) {
    const wg = parseProfile({ id: env.VPN_WIREGUARD_ID || "wireguard", name: env.VPN_WIREGUARD_NAME || "WireGuard", type: "wireguard", config: wgRaw.replace(/\\n/g, "\n"), configBase64: wgB64, configFile: wgFile, region: env.VPN_WIREGUARD_REGION || env.VPN_REGION || "", timezone: env.VPN_TIMEZONE || "", locale: env.VPN_LOCALE || "" });
    if (wg && !out.some(p => p.id === wg.id)) out.push(wg);
    else if (!wg) log("warn", "VPN", "VPN_WIREGUARD_CONFIG is set but is not a valid wg-quick config (needs [Interface] and [Peer]).");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Low-level tunnel handshakes
// ---------------------------------------------------------------------------
function socketReader(socket) {
  let buf = Buffer.alloc(0), waiter = null, err = null;
  const pump = () => {
    if (!waiter) return;
    const n = waiter.need(buf);
    if (n >= 0 && buf.length >= n) { const out = buf.subarray(0, n); buf = buf.subarray(n); const w = waiter; waiter = null; w.resolve(out); }
    else if (err) { const w = waiter; waiter = null; w.reject(err); }
  };
  const onData = d => { buf = buf.length ? Buffer.concat([buf, d]) : d; if (buf.length > 65536) err = new Error("Tunnel handshake too large"); pump(); };
  const onErr = e => { err = e; pump(); };
  const onEnd = () => { err = err || new Error("Tunnel closed during handshake"); pump(); };
  socket.on("data", onData); socket.on("error", onErr); socket.on("end", onEnd); socket.on("close", onEnd);
  return {
    read(n) { return new Promise((resolve, reject) => { waiter = { need: () => n, resolve, reject }; pump(); }); },
    readHead() { return new Promise((resolve, reject) => { waiter = { need: b => { const i = b.indexOf("\r\n\r\n"); return i < 0 ? -1 : i + 4; }, resolve, reject }; pump(); }); },
    release() {
      socket.off("data", onData); socket.off("error", onErr); socket.off("end", onEnd); socket.off("close", onEnd);
      if (buf.length) socket.unshift(buf);
    }
  };
}

function rawConnect(host, port, { timeoutMs = 10000, tlsToProxy = false, servername } = {}) {
  return new Promise((resolve, reject) => {
    const opts = { host, port };
    const sock = tlsToProxy ? tls.connect({ ...opts, servername: net.isIP(host) ? undefined : (servername || host), ALPNProtocols: ["http/1.1"] }) : net.connect(opts);
    const t = setTimeout(() => { sock.destroy(); reject(vpnError(`Timed out connecting to ${host}:${port}`, "VPN_TIMEOUT")); }, timeoutMs);
    sock.once(tlsToProxy ? "secureConnect" : "connect", () => { clearTimeout(t); sock.setNoDelay(true); resolve(sock); });
    sock.once("error", e => { clearTimeout(t); reject(e); });
  });
}

async function httpConnectHandshake(sock, target, port, username, password, timeoutMs) {
  const authority = `${target.includes(":") ? `[${target}]` : target}:${port}`;
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, "Proxy-Connection: keep-alive", "User-Agent: VeyraVPN/2"];
  if (username || password) lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  const reader = socketReader(sock);
  const timer = setTimeout(() => sock.destroy(vpnError("VPN gateway did not answer CONNECT in time", "VPN_TIMEOUT")), timeoutMs);
  try {
    sock.write(lines.join("\r\n") + "\r\n\r\n");
    const head = (await reader.readHead()).toString("latin1");
    const status = Number(head.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/)?.[1] || 0);
    if (status === 407) throw vpnError("VPN gateway rejected the credentials (407).", "VPN_AUTH_FAILED");
    if (status < 200 || status >= 300) throw vpnError(`VPN gateway refused CONNECT to ${authority} (HTTP ${status || "?"}).`, "VPN_CONNECT_REFUSED", { status });
  } finally { clearTimeout(timer); reader.release(); }
}

const SOCKS_REPLIES = { 1: "general failure", 2: "connection not allowed", 3: "network unreachable", 4: "host unreachable", 5: "connection refused", 6: "TTL expired", 7: "command not supported", 8: "address type not supported" };
async function socks5Handshake(sock, target, port, username, password, timeoutMs) {
  const reader = socketReader(sock);
  const timer = setTimeout(() => sock.destroy(vpnError("SOCKS5 gateway did not answer in time", "VPN_TIMEOUT")), timeoutMs);
  try {
    const methods = username || password ? [0x00, 0x02] : [0x00];
    sock.write(Buffer.from([0x05, methods.length, ...methods]));
    const [ver, method] = await reader.read(2);
    if (ver !== 0x05) throw vpnError("Upstream is not a SOCKS5 server.", "VPN_PROTOCOL");
    if (method === 0xff) throw vpnError("SOCKS5 gateway accepted none of our auth methods.", "VPN_AUTH_FAILED");
    if (method === 0x02) {
      const u = Buffer.from(username), p = Buffer.from(password);
      sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const [, st] = await reader.read(2);
      if (st !== 0x00) throw vpnError("SOCKS5 gateway rejected the credentials.", "VPN_AUTH_FAILED");
    }
    let addr;
    if (net.isIPv4(target)) addr = Buffer.from([0x01, ...target.split(".").map(Number)]);
    else if (net.isIPv6(target)) {
      const full = expandIpv6(target);
      addr = Buffer.concat([Buffer.from([0x04]), Buffer.from(full.split(":").flatMap(h => [parseInt(h, 16) >> 8, parseInt(h, 16) & 255]))]);
    } else {
      const name = Buffer.from(target); // remote DNS: the exit resolves the name
      if (name.length > 255) throw vpnError("Hostname too long for SOCKS5.", "VPN_PROTOCOL");
      addr = Buffer.concat([Buffer.from([0x03, name.length]), name]);
    }
    sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, Buffer.from([port >> 8, port & 255])]));
    const [v2, rep, , atyp] = await reader.read(4);
    if (v2 !== 0x05) throw vpnError("Malformed SOCKS5 reply.", "VPN_PROTOCOL");
    if (rep !== 0x00) throw vpnError(`SOCKS5 gateway could not reach ${target}:${port} (${SOCKS_REPLIES[rep] || rep}).`, "VPN_CONNECT_REFUSED");
    const len = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : (await reader.read(1))[0];
    await reader.read(len + 2);
  } finally { clearTimeout(timer); reader.release(); }
}
function expandIpv6(ip) {
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const fill = Array(8 - h.length - t.length).fill("0");
  return (ip.includes("::") ? [...h, ...fill, ...t] : h).map(x => x || "0").join(":");
}

// ---------------------------------------------------------------------------
// WireGuard via wireproxy (userspace, no root)
// ---------------------------------------------------------------------------
function findWireproxy(env) {
  const candidates = [env.VPN_WIREPROXY_BIN, path.join(__dirname, "bin", "wireproxy"), "/usr/local/bin/wireproxy", "/usr/bin/wireproxy"].filter(Boolean);
  for (const c of candidates) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {} }
  return "";
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function waitForPort(port, timeoutMs, isAlive) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (!isAlive()) return reject(vpnError("wireproxy exited during start-up (check the WireGuard config).", "VPN_WG_START_FAILED"));
      const s = net.connect({ host: "127.0.0.1", port });
      s.once("connect", () => { s.destroy(); resolve(); });
      s.once("error", () => { s.destroy(); if (Date.now() > until) reject(vpnError("wireproxy did not open its SOCKS port in time.", "VPN_WG_START_FAILED")); else setTimeout(attempt, 150); });
    };
    attempt();
  });
}
class WireGuardTunnel {
  constructor(profile, opts) {
    this.profile = profile;
    this.bin = opts.bin;
    this.log = opts.log;
    this.idleMs = opts.idleMs;
    this.child = null;
    this.port = 0;
    this.state = "stopped";
    this.startPromise = null;
    this.lastUsed = 0;
    this.lastError = "";
    this.restarts = 0;
    this.nextStartAt = 0;
    this.confPath = "";
  }
  buildConfig(port) {
    // Keep the user's [Interface]/[Peer] sections; drop any proxy sections and
    // add a loopback-only SOCKS5 listener that Veyra owns.
    const sections = this.profile.wgConfig.replace(/\r/g, "").split(/^(?=\s*\[)/m);
    const kept = sections.filter(s => /^\s*\[(Interface|Peer)\]/i.test(s)).map(s => s.trim()).join("\n\n");
    return `${kept}\n\n[Socks5]\nBindAddress = 127.0.0.1:${port}\n`;
  }
  async ensure() {
    this.lastUsed = Date.now();
    if (this.state === "running" && this.child && this.child.exitCode === null) return this.port;
    if (this.startPromise) return this.startPromise;
    if (!this.bin) throw vpnError("WireGuard profile configured but the wireproxy binary is missing. Run `node install-wireproxy.js` in the build command.", "VPN_WG_UNAVAILABLE");
    if (Date.now() < this.nextStartAt) throw vpnError(`WireGuard tunnel restarting after failure: ${this.lastError}`, "VPN_WG_BACKOFF");
    this.startPromise = (async () => {
      this.state = "starting";
      try {
        this.port = await freePort();
        this.confPath = path.join(os.tmpdir(), `veyra-wg-${this.profile.id.replace(/[^A-Za-z0-9_-]/g, "_")}-${process.pid}.conf`);
        fs.writeFileSync(this.confPath, this.buildConfig(this.port), { mode: 0o600 });
        const child = spawn(this.bin, ["-c", this.confPath, "-s"], { stdio: ["ignore", "ignore", "pipe"] });
        this.child = child;
        let stderr = "";
        child.stderr.on("data", d => { stderr = (stderr + d.toString()).slice(-2000); });
        child.on("exit", code => {
          if (this.child === child) {
            this.child = null;
            if (this.state !== "stopped") { this.state = "down"; this.lastError = `wireproxy exited (${code}) ${stderr.trim().split("\n").pop() || ""}`.trim(); this.log("warn", "VPN", `WireGuard ${this.profile.id}: ${this.lastError}`); }
          }
        });
        await waitForPort(this.port, 12000, () => child.exitCode === null);
        this.state = "running";
        this.lastError = "";
        this.log("info", "VPN", `WireGuard tunnel ${this.profile.id} up (wireproxy on 127.0.0.1:${this.port}).`);
        return this.port;
      } catch (e) {
        this.state = "down";
        this.lastError = e.message;
        this.restarts += 1;
        this.nextStartAt = Date.now() + Math.min(60000, 2000 * 2 ** Math.min(5, this.restarts - 1));
        this.stop("start failed");
        this.state = "down";
        throw e;
      } finally { this.startPromise = null; }
    })();
    return this.startPromise;
  }
  stop(reason = "stopped") {
    const child = this.child;
    this.child = null;
    this.state = "stopped";
    if (child && child.exitCode === null) { try { child.kill("SIGTERM"); } catch {} this.log("info", "VPN", `WireGuard tunnel ${this.profile.id} stopped (${reason}).`); }
    if (this.confPath) { try { fs.unlinkSync(this.confPath); } catch {} }
  }
  status() { return { state: this.state, port: this.state === "running" ? this.port : null, lastError: this.lastError || null, restarts: this.restarts, lastUsed: this.lastUsed ? new Date(this.lastUsed).toISOString() : null }; }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------
class VpnManager {
  constructor(logger = () => {}, env = process.env) {
    this.log = logger;
    this.env = env;
    this.enabled = envBool(env, "VPN_ENABLED", false);
    this.mode = String(env.VPN_MODE || "proxy").trim().toLowerCase() || "proxy";
    this.killSwitch = envBool(env, "VPN_KILL_SWITCH", true);
    this.failover = envBool(env, "VPN_FAILOVER", true);
    this.alwaysOn = envBool(env, "VPN_ALWAYS_ON", false);
    this.bypass = csv(env.VPN_SPLIT_BYPASS);
    this.only = csv(env.VPN_SPLIT_ONLY);
    this.healthUrl = env.VPN_HEALTH_URL || "https://api.ipify.org?format=json";
    this.healthIntervalMs = envNum(env, "VPN_HEALTH_INTERVAL_MS", 120000, 0, 86400000);
    this.failureThreshold = envNum(env, "VPN_FAILURE_THRESHOLD", 2, 1, 20);
    this.connectTimeoutMs = envNum(env, "VPN_CONNECT_TIMEOUT_MS", 10000, 1000, 60000);
    this.sessionIdleMs = envNum(env, "VPN_SESSION_IDLE_MS", 30 * 60 * 1000, 60000, 86400000);
    this.wgIdleMs = envNum(env, "VPN_WG_IDLE_MS", 10 * 60 * 1000, 30000, 86400000);
    this.defaultProfileId = String(env.VPN_DEFAULT_PROFILE || "").trim();
    this.crawlerProfileId = String(env.VPN_CRAWLER_PROFILE || "").trim();
    this.rotationIntervalMs = envNum(env, "VPN_ROTATION_INTERVAL_MS", 0, 0, 86400000);
    this.rotationSameIpGuard = envBool(env, "VPN_ROTATION_SAME_IP_GUARD", true);
    this.rotationMinGapMs = envNum(env, "VPN_ROTATION_MIN_GAP_MS", 60000, 10000, 86400000);
    this.profiles = new Map();
    this.health = new Map();
    this.connections = new Map();
    this.sessionAgents = new Map();
    this.profileAgents = new Map();
    this.tunnels = new Map();
    this.gateway = null;
    this.gatewayPort = 0;
    this.gatewaySecret = crypto.randomBytes(24).toString("hex");
    this.stats = { tunnelsOpened: 0, tunnelFailures: 0, killSwitchBlocks: 0, failovers: 0, bypassed: 0 };
    this.directConnect = buildConnector({});
    this.wireproxyBin = findWireproxy(env);
    this.loadProfiles();
    this.timer = setInterval(() => this.tick().catch(() => {}), 15000);
    this.timer.unref?.();
  }

  loadProfiles() {
    this.profiles.clear();
    for (const p of loadProfilesFromEnv(this.env, this.log)) {
      this.profiles.set(p.id, p);
      this.health.set(p.id, { healthy: null, failures: 0, checkedAt: 0, latencyMs: null, exitIp: null, lastError: null, successes: 0 });
      if (p.type === "wireguard") this.tunnels.set(p.id, new WireGuardTunnel(p, { bin: this.wireproxyBin, log: this.log, idleMs: this.wgIdleMs }));
    }
    if (!this.defaultProfileId && this.profiles.size) this.defaultProfileId = this.profiles.keys().next().value;
    if (this.profiles.size) this.log("info", "VPN", `Loaded ${this.profiles.size} VPN profile(s): ${[...this.profiles.values()].map(p => `${p.id} (${p.type})`).join(", ")}.`);
  }

  // ---- public views (never include servers or credentials) ----
  publicProfile(profile) {
    if (!profile) return null;
    const h = this.health.get(profile.id) || {};
    return {
      id: profile.id, name: profile.name, protocol: profile.type.toUpperCase(), type: profile.type, region: profile.region, country: profile.country,
      group: profile.group, provider: profile.provider,
      health: { healthy: h.healthy, latencyMs: h.latencyMs, exitIp: h.exitIp, checkedAt: h.checkedAt ? new Date(h.checkedAt).toISOString() : null, lastError: h.lastError, failures: h.failures },
      tunnel: this.tunnels.get(profile.id)?.status() || null
    };
  }
  list() { return [...this.profiles.values()].map(p => this.publicProfile(p)); }
  get(id = "") {
    const key = String(id || "");
    if (key === "auto" || !key) return this.pickProfile({}) || this.profiles.get(this.defaultProfileId) || null;
    return this.profiles.get(key) || null;
  }
  enabledForUse() { return this.enabled && this.profiles.size > 0; }

  // ---- selection / failover ----
  isUsable(id) { const h = this.health.get(id); return !!h && h.healthy !== false; }
  pickProfile({ region = "", group = "", exclude = [] } = {}) {
    const r = String(region || "").toLowerCase(), g = String(group || "").toLowerCase();
    let pool = [...this.profiles.values()].filter(p => !exclude.includes(p.id));
    const inScope = pool.filter(p => (!r || p.region.toLowerCase() === r || p.country.toLowerCase() === r) && (!g || p.group === g));
    if (inScope.length) pool = inScope;
    const usable = pool.filter(p => this.isUsable(p.id));
    const candidates = usable.length ? usable : [];
    if (!candidates.length) return null;
    // Prefer measured-healthy, then lowest latency, weighted random among the best.
    const score = p => { const h = this.health.get(p.id); return (h.healthy === true ? 0 : 500) + (h.latencyMs ?? 400) / p.weight; };
    candidates.sort((a, b) => score(a) - score(b));
    const best = score(candidates[0]);
    const near = candidates.filter(p => score(p) <= best * 1.5 + 50);
    return near[crypto.randomInt(near.length)];
  }

  stickyTag(sid, seq) { return crypto.createHash("sha256").update(`${sid}:${seq}`).digest("hex").slice(0, 12); }
  credentialsFor(profile, conn) {
    const tag = conn ? conn.stickyTag : crypto.randomBytes(6).toString("hex");
    const fill = s => String(s || "").replace(/\{session\}/g, tag).replace(/\{rand\}/g, () => crypto.randomBytes(4).toString("hex"));
    return { username: fill(profile.username), password: fill(profile.password) };
  }

  connect(sessionId, profileId = "", opts = {}) {
    if (!this.enabled) throw vpnError("Veyra VPN is disabled on this server.", "VPN_DISABLED");
    if (!this.profiles.size) throw vpnError("No configured Veyra VPN profile is available.", "VPN_NOT_CONFIGURED");
    const sid = String(sessionId || "").trim();
    if (!sid) throw vpnError("Missing Veyra session id.", "VPN_SESSION_REQUIRED");
    const requested = String(profileId || "").trim();
    let profile = requested && requested !== "auto" ? this.profiles.get(requested) : null;
    if (requested && requested !== "auto" && !profile) throw vpnError(`Unknown VPN profile "${requested}".`, "VPN_NOT_CONFIGURED");
    if (!profile) profile = this.pickProfile({ region: opts.region, group: opts.group }) || this.profiles.get(this.defaultProfileId);
    if (!profile) throw vpnError("Every VPN profile is currently failing health checks.", "VPN_ALL_DOWN");
    const prev = this.connections.get(sid);
    const seq = prev ? prev.seq : 0;
    this.connections.set(sid, {
      sid, profileId: profile.id, requested: requested || "auto", region: opts.region || "", group: opts.group || profile.group,
      connectedAt: Date.now(), lastUsed: Date.now(), seq, stickyTag: this.stickyTag(sid, seq), requests: 0, failovers: 0,
      lastRotatedAt: Date.now(), rotationCount: 0
    });
    this.resetSessionAgent(sid);
    if (this.health.get(profile.id)?.checkedAt === 0) void this.checkProfile(profile.id).catch(() => {});
    return { connected: true, sessionId: sid, profile: this.publicProfile(profile), killSwitch: this.killSwitch, failover: this.failover };
  }
  disconnect(sessionId) {
    const sid = String(sessionId || "").trim();
    this.connections.delete(sid);
    this.resetSessionAgent(sid);
    return { connected: false, sessionId: sid, profile: null };
  }
  rotate(sessionId, opts = {}) {
    const sid = String(sessionId || "").trim();
    const conn = this.connections.get(sid);
    if (!conn) throw vpnError("This session is not connected to the VPN.", "VPN_NOT_CONNECTED");
    const now = Date.now();
    if (now - (conn.lastRotatedAt || 0) < this.rotationMinGapMs && !opts.force) {
      throw vpnError("VPN exit rotation is rate-limited to protect the tunnel and session stability.", "VPN_ROTATION_RATE_LIMIT");
    }
    const oldProfile = this.profiles.get(conn.profileId);
    const oldHealth = oldProfile ? this.health.get(oldProfile.id) : null;
    conn.seq += 1;
    conn.stickyTag = this.stickyTag(sid, conn.seq);
    const exclude = [conn.profileId];
    let others = this.pickProfile({ region: conn.region, group: conn.group, exclude });
    if (this.rotationSameIpGuard && oldHealth?.exitIp) {
      const differentIp = [...this.profiles.values()]
        .filter(p => !exclude.includes(p.id) && this.isUsable(p.id))
        .filter(p => { const h = this.health.get(p.id); return !h?.exitIp || h.exitIp !== oldHealth.exitIp; })
        .sort((a,b) => (this.health.get(a.id)?.latencyMs ?? 9999) - (this.health.get(b.id)?.latencyMs ?? 9999));
      if (differentIp.length) others = differentIp[crypto.randomInt(differentIp.length)];
    }
    // Rotating credentials ({session} / {rand}) requests a fresh identity from
    // the same provider. Otherwise move to a different configured exit. A new
    // public IP is only guaranteed when the upstream provider supplies one.
    if (oldProfile && /\{session\}|\{rand\}/.test(oldProfile.username + oldProfile.password)) {
      conn.profileId = oldProfile.id;
    } else if (others && typeof others === "object") {
      conn.profileId = others.id;
    }
    conn.lastRotatedAt = now;
    conn.rotationCount = (conn.rotationCount || 0) + 1;
    this.resetSessionAgent(sid);
    const profile = this.profiles.get(conn.profileId);
    this.log("info", "VPN", `Rotated VPN exit for session ${sid.slice(0, 8)}… to ${profile?.id || "unknown"}.`);
    return { rotated: true, sessionId: sid, profile: this.publicProfile(profile), rotationCount: conn.rotationCount, previousProfileId: oldProfile?.id || null };
  }
  sessionInfo(sessionId) {
    const conn = this.connections.get(String(sessionId || ""));
    if (!conn) return { connected: false, alwaysOn: this.alwaysOn && this.enabledForUse() };
    return { connected: true, profile: this.publicProfile(this.profiles.get(conn.profileId)), requested: conn.requested, region: conn.region, connectedAt: new Date(conn.connectedAt).toISOString(), lastUsed: new Date(conn.lastUsed).toISOString(), requests: conn.requests, failovers: conn.failovers, rotation: { enabled: this.rotationIntervalMs > 0, intervalMs: this.rotationIntervalMs, count: conn.rotationCount || 0, lastRotatedAt: conn.lastRotatedAt ? new Date(conn.lastRotatedAt).toISOString() : null }, killSwitch: this.killSwitch };
  }
  profileForSession(sessionId) {
    const conn = this.connections.get(String(sessionId || ""));
    return conn ? (this.profiles.get(conn.profileId) || null) : null;
  }

  ensureConnection(sid) {
    let conn = this.connections.get(sid);
    if (!conn && this.alwaysOn && this.enabledForUse()) { try { this.connect(sid, this.defaultProfileId || "auto"); } catch {} conn = this.connections.get(sid); }
    if (!conn && sid === "__crawler__" && this.crawlerProfileId && this.enabledForUse()) { try { this.connect(sid, this.crawlerProfileId); } catch {} conn = this.connections.get(sid); }
    return conn || null;
  }

  // Decide the route for one outbound connection. Returns null for direct.
  route(sid, host) {
    const conn = this.connections.get(sid);
    if (!conn) return null;
    conn.lastUsed = Date.now();
    let profile = this.profiles.get(conn.profileId);
    if (this.bypass.length && hostMatches(host, this.bypass)) { this.stats.bypassed++; return null; }
    if (this.only.length && !hostMatches(host, this.only)) { this.stats.bypassed++; return null; }
    if (profile?.bypass.length && hostMatches(host, profile.bypass)) { this.stats.bypassed++; return null; }
    if (profile && !this.isUsable(profile.id) && this.failover) {
      const alt = this.pickProfile({ region: conn.region, group: conn.group, exclude: [profile.id] }) || this.pickProfile({ exclude: [profile.id] });
      if (alt) {
        this.log("warn", "VPN", `Failover: session ${sid.slice(0, 8)}… moved ${profile.id} → ${alt.id}.`);
        conn.profileId = alt.id; conn.failovers += 1; this.stats.failovers += 1; profile = alt;
      }
    }
    if (!profile || !this.isUsable(profile.id)) {
      if (this.killSwitch) { this.stats.killSwitchBlocks++; throw vpnError("Veyra VPN is down and the kill switch blocked a direct connection (your real server IP was not exposed).", "VPN_KILL_SWITCH"); }
      return null;
    }
    conn.requests += 1;
    return { profile, conn };
  }

  async openTunnel(profile, host, port, conn = null) {
    const target = String(host).replace(/^\[|\]$/g, "");
    const { username, password } = this.credentialsFor(profile, conn);
    let sock;
    try {
      if (profile.type === "wireguard") {
        const tunnel = this.tunnels.get(profile.id);
        const localPort = await tunnel.ensure();
        sock = await rawConnect("127.0.0.1", localPort, { timeoutMs: this.connectTimeoutMs });
        await socks5Handshake(sock, target, port, "", "", this.connectTimeoutMs);
      } else if (profile.type === "socks5") {
        sock = await rawConnect(profile.host, profile.port, { timeoutMs: this.connectTimeoutMs });
        await socks5Handshake(sock, target, port, username, password, this.connectTimeoutMs);
      } else {
        sock = await rawConnect(profile.host, profile.port, { timeoutMs: this.connectTimeoutMs, tlsToProxy: profile.type === "https" });
        await httpConnectHandshake(sock, target, port, username, password, this.connectTimeoutMs);
      }
      this.stats.tunnelsOpened += 1;
      this.notePassive(profile.id, true);
      return sock;
    } catch (e) {
      sock?.destroy();
      this.stats.tunnelFailures += 1;
      // Only count gateway-level failures against the profile, not "site unreachable".
      if (e.code !== "VPN_CONNECT_REFUSED" || profile.type !== "socks5") this.notePassive(profile.id, false, e.message);
      throw e;
    }
  }

  notePassive(id, ok, message = "") {
    const h = this.health.get(id); if (!h) return;
    if (ok) { h.failures = 0; if (h.healthy === false) { h.healthy = true; this.log("info", "VPN", `Profile ${id} recovered.`); } }
    else { h.failures += 1; h.lastError = message; if (h.failures >= this.failureThreshold && h.healthy !== false) { h.healthy = false; this.log("warn", "VPN", `Profile ${id} marked down: ${message}`); } }
  }

  // undici connector that routes every new origin connection.
  makeConnector(resolveRoute) {
    return (opts, callback) => {
      const host = opts.hostname;
      const port = Number(opts.port) || (opts.protocol === "https:" ? 443 : 80);
      let route;
      try { route = resolveRoute(host); } catch (e) { return callback(e, null); }
      if (!route) return this.directConnect(opts, callback);
      this.openTunnel(route.profile, host, port, route.conn).then(sock => {
        if (opts.protocol !== "https:") return callback(null, sock);
        const secure = tls.connect({ socket: sock, servername: net.isIP(host) ? undefined : (opts.servername || host), ALPNProtocols: ["http/1.1"] });
        const t = setTimeout(() => secure.destroy(vpnError("TLS handshake through VPN timed out", "VPN_TIMEOUT")), this.connectTimeoutMs);
        secure.once("secureConnect", () => { clearTimeout(t); callback(null, secure); });
        secure.once("error", e => { clearTimeout(t); callback(e, null); });
      }, e => callback(e, null));
    };
  }
  dispatcherForSession(sessionId) {
    const sid = String(sessionId || "");
    if (!sid || !this.enabled) return undefined;
    if (!this.ensureConnection(sid)) return undefined;
    let agent = this.sessionAgents.get(sid);
    if (!agent) {
      agent = new Agent({ connect: this.makeConnector(host => this.route(sid, host)), keepAliveTimeout: 15000, keepAliveMaxTimeout: 60000, connections: 16 });
      this.sessionAgents.set(sid, agent);
    }
    return agent;
  }
  dispatcherForCrawler() { return this.crawlerProfileId ? this.dispatcherForSession("__crawler__") : undefined; }
  profileDispatcher(profile) {
    let agent = this.profileAgents.get(profile.id);
    if (!agent) {
      agent = new Agent({ connect: this.makeConnector(() => ({ profile, conn: null })), keepAliveTimeout: 5000, connections: 4 });
      this.profileAgents.set(profile.id, agent);
    }
    return agent;
  }
  resetSessionAgent(sid) {
    const agent = this.sessionAgents.get(sid);
    if (agent) { this.sessionAgents.delete(sid); agent.close().catch(() => {}); }
  }

  // ---- health ----
  async probe(dispatcher) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.connectTimeoutMs + 5000);
    try {
      const { fetch } = require("undici");
      const r = await fetch(this.healthUrl, { dispatcher, signal: controller.signal, headers: { "user-agent": "VeyraVPNHealth/2.0", accept: "application/json,text/plain" } });
      const text = (await r.text()).slice(0, 2000);
      let exitIp = null;
      try { exitIp = JSON.parse(text).ip || null; } catch { exitIp = (text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[0-9a-f:]{6,}\b/i) || [null])[0]; }
      return { ok: r.status >= 200 && r.status < 500, status: r.status, exitIp, latencyMs: Date.now() - started };
    } finally { clearTimeout(timer); }
  }
  async checkProfile(id) {
    const profile = this.profiles.get(id);
    if (!profile) throw vpnError(`Unknown VPN profile "${id}".`, "VPN_NOT_CONFIGURED");
    const h = this.health.get(id);
    try {
      const r = await this.probe(this.profileDispatcher(profile));
      Object.assign(h, { healthy: r.ok, checkedAt: Date.now(), latencyMs: r.latencyMs, exitIp: r.exitIp, lastError: r.ok ? null : `HTTP ${r.status}`, failures: r.ok ? 0 : h.failures + 1 });
      if (r.ok) h.successes += 1;
      return { ...r, profile: this.publicProfile(profile) };
    } catch (e) {
      h.failures += 1; h.checkedAt = Date.now(); h.lastError = e.message;
      if (h.failures >= this.failureThreshold || h.healthy === null) h.healthy = false;
      throw vpnError(`VPN gateway test failed: ${e.message}`, "VPN_TEST_FAILED", { profile: this.publicProfile(profile) });
    }
  }
  async test(profileId = "") {
    if (!this.enabled) throw vpnError("Veyra VPN is disabled on this server.", "VPN_DISABLED");
    const p = this.get(profileId);
    if (!p) throw vpnError("No configured Veyra VPN profile is available.", "VPN_NOT_CONFIGURED");
    return this.checkProfile(p.id);
  }
  async checkAll() {
    const out = {};
    await Promise.all([...this.profiles.keys()].map(async id => { try { out[id] = await this.checkProfile(id); } catch (e) { out[id] = { ok: false, error: e.message }; } }));
    return out;
  }
  async exitIpForSession(sid) {
    const d = this.dispatcherForSession(sid);
    if (!d) { const r = await this.probe(undefined); return { vpn: false, ...r }; }
    const conn = this.connections.get(sid);
    const r = await this.probe(d);
    return { vpn: true, profile: this.publicProfile(this.profiles.get(conn?.profileId)), ...r };
  }

  async tick() {
    const now = Date.now();
    // Drop idle VPN sessions and their pooled connections.
    for (const [sid, conn] of this.connections) if (sid !== "__crawler__" && now - conn.lastUsed > this.sessionIdleMs) this.disconnect(sid);
    // Optional scheduled exit rotation. This changes the outbound identity of a
    // live session without extending its session lifetime. We never rotate the
    // crawler pseudo-session automatically. A real new IP depends on the configured
    // upstream provider exposing distinct exits.
    if (this.enabled && this.rotationIntervalMs > 0) {
      for (const [sid, conn] of this.connections) {
        if (sid === "__crawler__") continue;
        if (now - (conn.lastRotatedAt || conn.connectedAt) < this.rotationIntervalMs) continue;
        try { this.rotate(sid, { force: true }); } catch (e) { this.log("warn", "VPN", `Scheduled rotation skipped for ${sid.slice(0, 8)}…: ${e.code || e.message}`); }
      }
    }
    // Health checks only while something is using the VPN (keeps idle Render quiet).
    const inUse = new Set([...this.connections.values()].map(c => c.profileId));
    if (this.enabled && this.healthIntervalMs > 0 && inUse.size) {
      for (const [id, h] of this.health) {
        const due = now - h.checkedAt > (h.healthy === false ? Math.min(30000, this.healthIntervalMs) : this.healthIntervalMs);
        if (due && (inUse.has(id) || h.healthy === false || this.failover)) void this.checkProfile(id).catch(() => {});
      }
    }
    // Stop idle WireGuard tunnels.
    for (const [id, t] of this.tunnels) if (t.state === "running" && !inUse.has(id) && now - t.lastUsed > this.wgIdleMs) t.stop("idle");
  }

  // ---- Chromium gateway ----
  // Chromium cannot do SOCKS5 auth or WireGuard, so it talks to a loopback
  // HTTP proxy that applies exactly the same routing, failover and kill switch.
  gatewayToken(sid) { return crypto.createHmac("sha256", this.gatewaySecret).update(sid).digest("hex").slice(0, 32); }
  async ensureGateway() {
    if (this.gateway) return this.gatewayPort;
    const server = http.createServer((req, res) => this.gatewayHttp(req, res));
    server.on("connect", (req, clientSocket, head) => this.gatewayConnect(req, clientSocket, head));
    server.on("clientError", (_e, socket) => { try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {} });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    server.unref();
    this.gateway = server;
    this.gatewayPort = server.address().port;
    this.log("info", "VPN", `Browser VPN gateway listening on 127.0.0.1:${this.gatewayPort}.`);
    return this.gatewayPort;
  }
  gatewayAuth(req) {
    const m = String(req.headers["proxy-authorization"] || "").match(/^Basic\s+(.+)$/i);
    if (!m) return null;
    const [sid, token] = Buffer.from(m[1], "base64").toString("utf8").split(":");
    if (!sid || !token || token.length !== 32) return null;
    const expected = this.gatewayToken(sid);
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected)) ? sid : null;
  }
  async gatewayOpen(sid, host, port) {
    const target = String(host).replace(/^\[|\]$/g, "").toLowerCase();
    if (target === "localhost" || (net.isIP(target) && privateIp(target))) throw vpnError("Private destinations are blocked.", "VPN_BLOCKED");
    this.ensureConnection(sid);
    const route = this.route(sid, target);
    if (route) return this.openTunnel(route.profile, target, port, route.conn);
    const { address } = await dns.lookup(target);
    if (privateIp(address)) throw vpnError("Private destinations are blocked.", "VPN_BLOCKED");
    return rawConnect(address, port, { timeoutMs: this.connectTimeoutMs });
  }
  gatewayConnect(req, clientSocket, head) {
    const sid = this.gatewayAuth(req);
    if (!sid) { clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="veyra"\r\nContent-Length: 0\r\n\r\n'); return; }
    const m = String(req.url || "").match(/^\[?([^\]]+?)\]?:(\d+)$/);
    if (!m) { clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
    clientSocket.on("error", () => {});
    this.gatewayOpen(sid, m[1], Number(m[2])).then(upstream => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
      upstream.pipe(clientSocket); clientSocket.pipe(upstream);
    }, e => { try { clientSocket.end(`HTTP/1.1 ${e.code === "VPN_KILL_SWITCH" ? 503 : 502} ${e.code || "Bad Gateway"}\r\nContent-Length: 0\r\n\r\n`); } catch {} });
  }
  gatewayHttp(req, res) {
    const sid = this.gatewayAuth(req);
    if (!sid) { res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="veyra"' }); return res.end(); }
    let u; try { u = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
    if (u.protocol !== "http:") { res.writeHead(400); return res.end(); }
    const headers = { ...req.headers }; delete headers["proxy-authorization"]; delete headers["proxy-connection"];
    const upstreamReq = http.request({
      host: u.hostname, port: Number(u.port) || 80, method: req.method, path: u.pathname + u.search, headers,
      createConnection: (_o, cb) => { this.gatewayOpen(sid, u.hostname, Number(u.port) || 80).then(s => cb(null, s), e => cb(e)); }
    }, upstream => { res.writeHead(upstream.statusCode || 502, upstream.headers); upstream.pipe(res); });
    upstreamReq.on("error", e => { if (!res.headersSent) res.writeHead(e.code === "VPN_KILL_SWITCH" ? 503 : 502); res.end(); });
    req.pipe(upstreamReq);
  }
  async playwrightProxy(sessionId) {
    const sid = String(sessionId || "");
    if (!sid || !this.enabled || !this.ensureConnection(sid)) return undefined;
    const port = await this.ensureGateway();
    return { server: `http://127.0.0.1:${port}`, username: sid, password: this.gatewayToken(sid) };
  }
  browserContextHints(sessionId) {
    const p = this.profileForSession(sessionId);
    return p ? { timezoneId: p.timezone || undefined, locale: p.locale || undefined } : {};
  }

  status() {
    return {
      enabled: this.enabled, mode: this.mode, configured: this.profiles.size > 0, killSwitch: this.killSwitch, failover: this.failover, alwaysOn: this.alwaysOn,
      split: { bypass: this.bypass, only: this.only }, profiles: this.list(), connections: this.connections.size, defaultProfile: this.defaultProfileId || null,
      crawlerProfile: this.crawlerProfileId || null, rotation: { enabled: this.rotationIntervalMs > 0, intervalMs: this.rotationIntervalMs, sameIpGuard: this.rotationSameIpGuard }, wireproxy: this.wireproxyBin ? "installed" : "missing", gateway: this.gateway ? "listening" : "idle",
      healthIntervalMs: this.healthIntervalMs, stats: { ...this.stats }
    };
  }
  async close() {
    clearInterval(this.timer);
    for (const a of [...this.sessionAgents.values(), ...this.profileAgents.values()]) await a.close().catch(() => {});
    this.sessionAgents.clear(); this.profileAgents.clear(); this.connections.clear();
    for (const t of this.tunnels.values()) t.stop("shutdown");
    if (this.gateway) { this.gateway.close(); this.gateway = null; }
  }
}

module.exports = { VpnManager, parseProfile, hostMatches, socks5Handshake, httpConnectHandshake, WireGuardTunnel, loadProfilesFromEnv, privateIp };
