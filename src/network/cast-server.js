"use strict";
/**
 * Veyra Device Casting Server — WebSocket relay for phone-to-browser mirroring.
 *
 * Architecture:
 *   1. Browser generates a pairing code (6 digits) + QR code
 *   2. QR contains: veyra://casteddevice:/<sessionId>?code=<pairingCode>
 *   3. Phone scans QR, connects to server via WebSocket
 *   4. Server pairs phone with browser session
 *   5. Phone streams screen frames (JPEG/WebP) to server
 *   6. Server relays frames to browser in real-time
 *   7. Browser can also send touch/input events back to phone
 *
 * Also handles:
 *   - Internet connection profiles (LAN, WiFi, Cellular, Custom)
 *   - Network quality monitoring
 *   - Connection type negotiation
 */

const crypto = require("crypto");
const http = require("http");


let WebSocketServer = null, WebSocket = null;
try { ({ WebSocketServer, WebSocket } = require("ws")); } catch {
  console.warn("[CAST] ws library not found — using HTTP polling fallback");
}


function genPairingCode() { return String(crypto.randomInt(100000, 1000000)); }
function genDeviceId() { return `veyra-dev_${crypto.randomBytes(8).toString("hex")}`; }
function now() { return Date.now(); }


class DeviceSession {
  constructor(id, browserWs) {
    this.id = id;
    this.pairingCode = genPairingCode();
    this.browserWs = browserWs;
    this.deviceWs = null;
    this.browserToken = crypto.randomBytes(32).toString("hex");
    this.deviceToken = null;
    this.lastActivity = now();
    this.deviceId = null;
    this.deviceName = "";
    this.deviceType = "";
    this.createdAt = now();
    this.pairedAt = null;
    this.status = "waiting"; 
    this.frameCount = 0;
    this.bytesTransferred = 0;
    this.lastFrameAt = 0;
    this.quality = "auto"; 
    this.fps = 30;
    this.inputEnabled = true;
    this.audioEnabled = false;
    this.connectionType = "unknown"; 
    this.networkStrength = 0;
  }

  pair(deviceWs, deviceId, deviceInfo) {
    this.deviceWs = deviceWs;
    this.deviceId = deviceId || genDeviceId();
    this.deviceName = deviceInfo?.name || "Unknown Device";
    this.deviceType = deviceInfo?.type || "phone";
    this.connectionType = deviceInfo?.connectionType || "wifi";
    this.networkStrength = Math.max(0, Math.min(100, Number(deviceInfo?.networkStrength ?? 100) || 0));
    this.pairedAt = now();
    this.status = "paired";
  }

  isReady() { return this.browserWs && this.deviceWs && this.status === "streaming"; }

  relayFrame(frameData) {
    if (!this.browserWs || this.browserWs.readyState !== WebSocket.OPEN) return;
    this.frameCount++;
    this.bytesTransferred += frameData.length;
    this.lastFrameAt = now();
    this.browserWs.send(JSON.stringify({
      type: "frame",
      data: frameData,
      sequence: this.frameCount,
      timestamp: now(),
    }));
  }

  relayInput(input) {
    if (!this.deviceWs || this.deviceWs.readyState !== WebSocket.OPEN) return;
    if (!this.inputEnabled) return;
    this.deviceWs.send(JSON.stringify({
      type: "input",
      ...input,
      timestamp: now(),
    }));
  }

  sendToBrowser(msg) {
    if (!this.browserWs || this.browserWs.readyState !== WebSocket.OPEN) return;
    this.browserWs.send(JSON.stringify(msg));
  }

  sendToDevice(msg) {
    if (!this.deviceWs || this.deviceWs.readyState !== WebSocket.OPEN) return;
    this.deviceWs.send(JSON.stringify(msg));
  }

  disconnect(reason = "unknown") {
    this.status = "disconnected";
    this.sendToBrowser({ type: "device_disconnected", reason, timestamp: now() });
    this.sendToDevice({ type: "browser_disconnected", reason, timestamp: now() });
    if (this.browserWs?.readyState === WebSocket.OPEN) this.browserWs.close(1000, "session ended");
    if (this.deviceWs?.readyState === WebSocket.OPEN) this.deviceWs.close(1000, "session ended");
  }

  stats() {
    const fps = this.lastFrameAt ? Math.min(this.fps, 1000 / Math.max(1, now() - this.lastFrameAt)) : 0;
    return {
      id: this.id,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      deviceType: this.deviceType,
      status: this.status,
      pairingCode: this.pairingCode,
      paired: !!this.pairedAt,
      duration: this.pairedAt ? now() - this.pairedAt : 0,
      frameCount: this.frameCount,
      bytesTransferred: this.bytesTransferred,
      connectionType: this.connectionType,
      networkStrength: this.networkStrength,
      quality: this.quality,
      fps: Math.round(fps),
      inputEnabled: this.inputEnabled,
      audioEnabled: this.audioEnabled,
    };
  }
}


class CastServer {
  constructor(server, log = () => {}, opts = {}) {
    this.log = log;
    this.frontendUrl = typeof opts.frontendUrl === "string" && /^https:\/\//.test(opts.frontendUrl) ? opts.frontendUrl : "";
    this.sessions = new Map();
    this.devices = new Map();
    this.pollingBuffers = new Map();  
    this.maxSessions = Math.max(1, Math.min(256, Number(opts.maxSessions) || 64));
    
    
    
    
    const isRealServer = !!(server && typeof server.on === "function" && typeof server.listen === "function");
    this.useWebSocket = !!WebSocketServer && isRealServer;

    if (this.useWebSocket) {
      this.wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false });
      this.httpServer = server;
      this.upgradeHandler = (req, socket, head) => {
        let pathname;
        try { pathname = new URL(req.url, "http://localhost").pathname; } catch { return; }
        if (pathname !== "/ws/cast") return;
        this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit("connection", ws, req));
      };
      server.on("upgrade", this.upgradeHandler);
      this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    }
    
    
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    this.cleanupInterval.unref?.();
    this.stats = { totalSessions: 0, totalDevices: 0, activeStreams: 0, framesRelayed: 0, mode: this.useWebSocket ? "websocket" : "polling" };
  }

  
  createSessionViaPoll() {
    if (this.sessions.size >= this.maxSessions) throw new Error("Casting session capacity reached. Close an existing receiver.");
    const sessionId = `cast_${crypto.randomBytes(6).toString("hex")}`;
    const session = new DeviceSession(sessionId, null);
    this.wireSession(session);
    session.usePolling = true;
    this.sessions.set(sessionId, session);
    this.pollingBuffers.set(sessionId, []);
    this.stats.totalSessions++;
    return session;
  }

  pollSession(sessionId) {
    const buf = this.pollingBuffers.get(sessionId);
    if (!buf) return [];
    const msgs = buf.splice(0, buf.length);
    return msgs;
  }

  pushToPoll(sessionId, msg) {
    const buf = this.pollingBuffers.get(sessionId);
    if (buf) {
      if (msg.type === "frame") {
        for (let i = buf.length - 1; i >= 0; i--) if (buf[i].type === "frame") buf.splice(i, 1);
      }
      buf.push(msg);
      if (buf.length > 20) buf.shift();
    }
  }

  sendToBrowser(session, msg) {
    if (session.browserWs && session.browserWs.readyState === 1) {
      if (msg.type === "frame" && session.browserWs.bufferedAmount > 512 * 1024) return;
      session.browserWs.send(JSON.stringify(msg));
    } else if (session.usePolling) {
      this.pushToPoll(session.id, msg);
    }
  }

  sendToDeviceMsg(session, msg) {
    if (session.deviceWs && session.deviceWs.readyState === 1) {
      session.deviceWs.send(JSON.stringify(msg));
    } else if (session.deviceId) {
      this.pushToDevicePoll(session.deviceId, msg);
    }
  }

  
  onConnection(ws, req) {
    if (!this.useWebSocket) return;
    const url = new URL(req.url, "http://localhost");
    const role = url.searchParams.get("role");
    const sessionId = url.searchParams.get("session");
    const code = url.searchParams.get("code");
    const deviceId = url.searchParams.get("deviceId");

    if (role === "browser") {
      if (sessionId && !this.authorizeBrowser(sessionId, url.searchParams.get("token"))) { ws.close(4003, "Invalid browser capability"); return; }
      this.handleBrowser(ws, sessionId);
    } else if (role === "device") {
      this.handleDevice(ws, sessionId, code, deviceId, req);
    } else {
      ws.close(4001, "Missing or invalid role");
    }
  }

  handleBrowser(ws, sessionId) {
    let session = sessionId ? this.sessions.get(sessionId) : null;
    if (sessionId && !session) { ws.close(4002, "Invalid session"); return; }
    if (!session) {
      if (this.sessions.size >= this.maxSessions) { ws.close(4008, "Casting capacity reached"); return; }
      sessionId = sessionId || `cast_${crypto.randomBytes(6).toString("hex")}`;
      session = new DeviceSession(sessionId, ws);
      this.wireSession(session);
      this.sessions.set(sessionId, session);
      this.stats.totalSessions++;
    } else {
      const old = session.browserWs;
      session.browserWs = ws;
      try { if (old && old !== ws) old.close(1000, "browser_replaced"); } catch {}
    }

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "start_streaming" && session.deviceId) {
          if (session.status !== "streaming") this.stats.activeStreams++;
          session.status = "streaming";
          session.sendToDevice({ type: "start_streaming", quality: session.quality, fps: session.fps });
        } else if (msg.type === "stop_streaming") {
          if (session.status === "streaming") this.stats.activeStreams = Math.max(0, this.stats.activeStreams - 1);
          session.status = session.deviceId ? "paired" : "waiting";
          session.sendToDevice({ type: "stop_streaming" });
        } else if (msg.type === "input") {
          session.relayInput(msg.input);
        } else if (msg.type === "set_quality") {
          session.quality = msg.quality || "auto";
          session.fps = msg.fps || 30;
          session.sendToDevice({ type: "set_quality", quality: session.quality, fps: session.fps });
        } else if (msg.type === "set_input") {
          session.inputEnabled = !!msg.enabled;
        } else if (msg.type === "set_audio") {
          session.audioEnabled = !!msg.enabled;
          session.sendToDevice({ type: "set_audio", enabled: session.audioEnabled });
        } else if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", timestamp: now() }));
        }
      } catch (e) { this.log("warn", "CAST", `Browser message error: ${e.message}`); }
    });

    ws.on("close", () => {
      if (session.browserWs !== ws) return;
      this.closeSession(session.id, "browser_closed");
    });

    
    const qrPayload = this.buildQrPayload(sessionId, session.pairingCode);
    ws.send(JSON.stringify({
      type: "session_created",
      sessionId,
      browserToken: session.browserToken,
      pairingCode: session.pairingCode,
      qrPayload,
      qrUrl: this.buildQrUrl(sessionId, session.pairingCode),
      timestamp: now(),
    }));
  }

  
  
  
  buildQrPayload(sessionId, pairingCode) {
    if (this.frontendUrl) {
      const base = this.frontendUrl.endsWith("/") ? this.frontendUrl : this.frontendUrl + "/";
      return `${base}cast?session=${encodeURIComponent(sessionId)}&code=${encodeURIComponent(pairingCode)}`;
    }
    return `veyra://casteddevice:/${sessionId}?code=${pairingCode}`;
  }
  buildQrUrl(sessionId, pairingCode) {
    return ""; // The browser already generates QR images locally.
  }

  handleDevice(ws, sessionId, code, deviceId, req) {
    const session = this.sessions.get(sessionId);
    if (!session) { ws.close(4002, "Invalid session"); return; }
    if (code !== session.pairingCode) { ws.close(4003, "Invalid pairing code"); return; }
    if (session.status === "disconnected") { ws.close(4002, "Session closed"); return; }
    if (deviceId && this.devices.has(deviceId) && this.devices.get(deviceId) !== session) { ws.close(4003, "Device already paired"); return; }
    this.detachDevice(session);

    const deviceInfo = {
      name: new URL(req.url, "http://localhost").searchParams.get("name") || "Phone",
      type: new URL(req.url, "http://localhost").searchParams.get("type") || "phone",
      connectionType: new URL(req.url, "http://localhost").searchParams.get("connection") || "wifi",
      networkStrength: parseInt(new URL(req.url, "http://localhost").searchParams.get("strength") || "100"),
    };

    session.pair(ws, deviceId, deviceInfo);
    this.devices.set(session.deviceId, session);
    this.stats.totalDevices++;

    
    session.sendToBrowser({
      type: "device_paired",
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      deviceType: session.deviceType,
      connectionType: session.connectionType,
      networkStrength: session.networkStrength,
      timestamp: now(),
    });

    ws.on("message", (data) => {
      try {
        if (session.deviceWs !== ws) return;
        
        if (Buffer.isBuffer(data) || typeof data === "string") {
          const str = data.toString();
          
          if (str.startsWith("{")) {
            const msg = JSON.parse(str);
            this.receiveDeviceMessage(session.deviceId, msg);
          } else {
            
            this.receiveDeviceMessage(session.deviceId, { type: "frame", data: str });
          }
        }
      } catch (e) { this.log("warn", "CAST", `Device message error: ${e.message}`); }
    });

    ws.on("close", () => {
      if (session.deviceWs !== ws) return;
      this.detachDevice(session);
      session.status = "waiting";
      session.sendToBrowser({ type: "device_disconnected", reason: "device_closed", timestamp: now() });
    });
  }

  cleanup() {
    const cutoff = now() - 5 * 60 * 1000; 
    for (const [id, session] of this.sessions) {
      if ((session.status === "disconnected" && session.lastActivity < cutoff) ||
        (session.status === "waiting" && now() - session.lastActivity > 10 * 60 * 1000) ||
        (["paired", "streaming"].includes(session.status) && now() - session.lastActivity > 5 * 60 * 1000))
        this.closeSession(id, "timeout");
    }
  }

  
  joinDeviceViaPoll(sessionId, code, deviceId, deviceInfo) {
    const session = sessionId ? this.sessions.get(sessionId) :
      [...this.sessions.values()].find(s => s.pairingCode === String(code));
    if (!session) return { ok: false, error: "Invalid session" };
    if (code !== session.pairingCode) return { ok: false, error: "Invalid pairing code" };
    if (session.status === "disconnected") return { ok: false, error: "Session closed" };
    if (deviceId && this.devices.has(deviceId) && this.devices.get(deviceId) !== session) return { ok: false, error: "Device already paired" };
    this.detachDevice(session);
    
    
    session.deviceId = deviceId || genDeviceId();
    session.deviceName = deviceInfo?.name || "Phone";
    session.deviceType = deviceInfo?.type || "phone";
    session.connectionType = deviceInfo?.connectionType || deviceInfo?.connection || "wifi";
    session.networkStrength = Math.max(0, Math.min(100, Number(deviceInfo?.networkStrength ?? 100) || 0));
    session.pairedAt = now();
    session.status = "paired";
    session.usePolling = true;
    session.lastActivity = now();
    session.deviceToken = crypto.randomBytes(32).toString("hex");
    
    
    if (!this.pollingBuffers.has(`device:${session.deviceId}`)) {
      this.pollingBuffers.set(`device:${session.deviceId}`, []);
    }
    
    this.devices.set(session.deviceId, session);
    this.stats.totalDevices++;
    
    
    this.sendToBrowser(session, {
      type: "device_paired",
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      deviceType: session.deviceType,
      connectionType: session.connectionType,
      networkStrength: session.networkStrength,
      timestamp: now(),
    });
    
    return { ok: true, deviceId: session.deviceId, deviceToken: session.deviceToken, session: session.stats() };
  }
  
  pollDevice(deviceId) {
    const session = this.devices.get(deviceId);
    if (!session) return { ok: false, error: "Device not found" };
    session.lastActivity = now();
    const key = `device:${deviceId}`;
    const buf = this.pollingBuffers.get(key);
    if (!buf) return { ok: true, messages: [] };
    const msgs = buf.splice(0, buf.length);
    return { ok: true, messages: msgs };
  }
  
  pushToDevicePoll(deviceId, msg) {
    const key = `device:${deviceId}`;
    if (!this.pollingBuffers.has(key)) this.pollingBuffers.set(key, []);
    const buf = this.pollingBuffers.get(key);
    buf.push(msg);
    if (buf.length > 20) buf.shift();
  }

  
  
  sendToDevice(sessionId, msg) {
    const session = this.sessions.get(String(sessionId));
    if (!session || session.status === "disconnected") return { ok: false, error: "Session not found" };
    if (!["start_streaming", "stop_streaming", "set_quality", "set_input", "set_audio", "input"].includes(msg?.type)) return { ok: false, error: "Unsupported browser command" };
    if (msg.type === "start_streaming" && !session.deviceId) return { ok: false, error: "Pair a device first" };
    if (msg.type === "start_streaming") {
      if (session.status !== "streaming") this.stats.activeStreams++;
      session.status = "streaming";
    } else if (msg.type === "stop_streaming") {
      if (session.status === "streaming") this.stats.activeStreams = Math.max(0, this.stats.activeStreams - 1);
      session.status = session.deviceId ? "paired" : "waiting";
    } else if (msg.type === "set_input") session.inputEnabled = !!msg.enabled;
    if (msg.type === "input" && !session.inputEnabled) return { ok: false, error: "Input is disabled" };
    session.lastActivity = now();
    this.sendToDeviceMsg(session, msg);
    return { ok: true };
  }

  closeSession(sessionId, reason = "client_closed") {
    const id = String(sessionId);
    const session = this.sessions.get(id);
    if (!session) return { ok: true, closed: false };
    if (session.status === "disconnected") return { ok: true, closed: false };
    if (session.status === "streaming") this.stats.activeStreams = Math.max(0, this.stats.activeStreams - 1);
    session.status = "disconnected";
    this.sendToBrowser(session, { type: "device_disconnected", reason, timestamp: now() });
    this.sendToDeviceMsg(session, { type: "browser_disconnected", reason, timestamp: now() });
    try { if (session.browserWs?.readyState === WebSocket.OPEN) session.browserWs.close(1000, reason); } catch {}
    try { if (session.deviceWs?.readyState === WebSocket.OPEN) session.deviceWs.close(1000, reason); } catch {}
    if (session.deviceId) {
      this.devices.delete(session.deviceId);
      this.pollingBuffers.delete(`device:${session.deviceId}`);
    }
    this.pollingBuffers.delete(id);
    this.sessions.delete(id);
    return { ok: true, closed: true };
  }

  getStats() {
    return {
      ...this.stats,
      activeSessions: this.sessions.size,
      waitingSessions: [...this.sessions.values()].filter(s => s.status === "waiting").length,
      streamingSessions: [...this.sessions.values()].filter(s => s.status === "streaming").length,
      pairedDevices: this.devices.size,
    };
  }

  listSessions() {
    return [...this.sessions.values()].map(s => s.stats());
  }

  close() {
    clearInterval(this.cleanupInterval);
    for (const id of [...this.sessions.keys()]) this.closeSession(id, "server_shutdown");
    this.wss?.close();
    if (this.httpServer && this.upgradeHandler) this.httpServer.off("upgrade", this.upgradeHandler);
  }

  wireSession(session) {
    while ([...this.sessions.values()].some(s => s.pairingCode === session.pairingCode)) session.pairingCode = genPairingCode();
    session.sendToBrowser = msg => this.sendToBrowser(session, msg);
    session.sendToDevice = msg => this.sendToDeviceMsg(session, msg);
    session.relayInput = input => { if (session.inputEnabled) this.sendToDeviceMsg(session, { type: "input", ...input, timestamp: now() }); };
  }

  detachDevice(session) {
    const old = session.deviceWs;
    session.deviceWs = null;
    if (session.status === "streaming") this.stats.activeStreams = Math.max(0, this.stats.activeStreams - 1);
    if (session.deviceId) {
      this.devices.delete(session.deviceId);
      this.pollingBuffers.delete(`device:${session.deviceId}`);
    }
    session.deviceId = null;
    session.deviceToken = null;
    session.lastActivity = now();
    try { old?.close(1000, "device_replaced"); } catch {}
  }

  tokenMatches(expected, supplied) {
    return typeof expected === "string" && typeof supplied === "string" &&
      Buffer.byteLength(expected) === Buffer.byteLength(supplied) &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
  }
  authorizeBrowser(id, token) { return this.tokenMatches(this.sessions.get(String(id))?.browserToken, token); }
  authorizeDevice(id, token) { return this.tokenMatches(this.devices.get(String(id))?.deviceToken, token); }

  receiveDeviceMessage(deviceId, msg) {
    const s = this.devices.get(String(deviceId));
    if (!s) return { ok: false, error: "Device not found" };
    if (!["frame", "network_update", "device_info", "stream_ended"].includes(msg?.type))
      return { ok: false, error: "Unsupported device message" };
    if (msg.type === "frame") {
      if (typeof msg.data !== "string" || msg.data.length > 400000 ||
        !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(msg.data))
        return { ok: false, error: "Expected an image data URL under 400 KB" };
      if (s.status !== "streaming") this.stats.activeStreams++;
      s.status = "streaming";
      s.frameCount++; s.bytesTransferred += msg.data.length; s.lastFrameAt = now(); this.stats.framesRelayed++;
      msg = { type: "frame", data: msg.data, sequence: s.frameCount, timestamp: now() };
    } else if (msg.type === "network_update") {
      s.connectionType = String(msg.connectionType || s.connectionType).slice(0, 30);
      s.networkStrength = Math.max(0, Math.min(100, Number(msg.networkStrength) || 0));
      msg = { type: msg.type, connectionType: s.connectionType, networkStrength: s.networkStrength };
    } else if (msg.type === "stream_ended") {
      if (s.status === "streaming") this.stats.activeStreams = Math.max(0, this.stats.activeStreams - 1);
      s.status = "paired";
    } else if (msg.type === "device_info") {
      s.deviceName = String(msg.name || s.deviceName).slice(0, 80);
      msg = { type: msg.type, name: s.deviceName, battery: Math.max(0, Math.min(100, Number(msg.battery) || 0)), screen: msg.screen };
    }
    s.lastActivity = now();
    this.sendToBrowser(s, msg);
    return { ok: true };
  }
}


const INTERNET_PROFILES = [
  { id: "auto", name: "Automatic", desc: "Veyra selects the best available connection", icon: "auto" },
  { id: "lan", name: "Local Area Network", desc: "Connect via LAN/Ethernet. Fastest, most stable.", icon: "lan", type: "wired" },
  { id: "wifi", name: "Wi-Fi", desc: "Connect via Wi-Fi network. Requires SSID + password.", icon: "wifi", type: "wireless" },
  { id: "cellular", name: "Cellular / Mobile", desc: "Connect via mobile data (4G/5G). Requires APN settings.", icon: "cellular", type: "mobile" },
  { id: "custom", name: "Custom Connection", desc: "Manually configure proxy, DNS, and routing.", icon: "custom", type: "custom" },
  { id: "bridge", name: "Bridge Mode", desc: "Share the phone's internet connection with Veyra.", icon: "bridge", type: "bridge" },
  { id: "mesh", name: "Mesh Network", desc: "Connect through multiple nodes for redundancy.", icon: "mesh", type: "mesh" },
];

class InternetConnectionManager {
  constructor() {
    this.currentProfile = "auto";
    this.profiles = new Map();
    this.connections = new Map(); 
    this.stats = {
      totalConnections: 0,
      currentBandwidth: 0,
      latency: 0,
      packetLoss: 0,
      uptime: 0,
    };
    this.startTime = Date.now();
  }

  setProfile(sessionId, profileId, config = {}) {
    const sid = String(sessionId || "").trim();
    const id = String(profileId || "auto").trim().toLowerCase();
    const profile = INTERNET_PROFILES.find(p => p.id === id);
    if (!sid) throw Object.assign(new Error("A session id is required."), { code: "INTERNET_SESSION_REQUIRED" });
    if (!profile) throw Object.assign(new Error(`Unknown internet profile "${id}".`), { code: "INTERNET_PROFILE_INVALID" });
    this.connections.set(sid, id);
    this.currentProfile = id;
    this.stats.totalConnections++;

    
    const connectionConfig = {
      profileId: id,
      type: profile.type,
      sessionId: sid,
      configured: false,
      status: "disconnected",
      ...config,
    };

    
    if (profile.type === "wireless") {
      connectionConfig.ssid = config.ssid || "";
      connectionConfig.password = config.password || "";
      connectionConfig.security = config.security || "wpa2";
      connectionConfig.frequency = config.frequency || "auto"; 
    } else if (profile.type === "mobile") {
      connectionConfig.apn = config.apn || "";
      connectionConfig.carrier = config.carrier || "";
      connectionConfig.pin = config.pin || "";
      connectionConfig.networkType = config.networkType || "4g"; 
    } else if (profile.type === "custom") {
      connectionConfig.proxy = config.proxy || "";
      connectionConfig.dns = config.dns || [];
      connectionConfig.gateway = config.gateway || "";
      connectionConfig.subnet = config.subnet || "";
      connectionConfig.dnsServers = config.dnsServers || ["1.1.1.1", "8.8.8.8"];
    } else if (profile.type === "bridge") {
      connectionConfig.bridgeInterface = config.bridgeInterface || "";
      connectionConfig.sharedFrom = config.sharedFrom || "phone";
    }

    
    
    connectionConfig.status = "selected";
    connectionConfig.configured = Object.keys(config || {}).length > 0 || id === "auto";
    connectionConfig.selectedAt = Date.now();
    this.profiles.set(sid, connectionConfig);

    return connectionConfig;
  }

  getProfile(sessionId) { return this.profiles.get(String(sessionId || "").trim()) || null; }
  getCurrentProfile() { return this.currentProfile; }
  getAvailableProfiles() { return INTERNET_PROFILES; }

  testConnection(sessionId) {
    const profile = this.profiles.get(sessionId);
    if (!profile) return { ok: false, error: "No connection configured" };
    return {
      ok: !!profile,
      profile: profile.profileId,
      latency: null,
      bandwidth: null,
      status: profile ? profile.status : "not_selected",
      note: profile ? "Profile selection is recorded; host network routing is unchanged." : "Select a profile first.",
    };
  }

  disconnect(sessionId) {
    const profile = this.profiles.get(sessionId);
    if (profile) {
      profile.status = "disconnected";
      this.connections.delete(sessionId);
    }
  }

  report() {
    return {
      currentProfile: this.currentProfile,
      availableProfiles: INTERNET_PROFILES,
      activeConnections: [...this.profiles.values()].filter(p => p.status === "connected").length,
      stats: { ...this.stats, uptime: Date.now() - this.startTime },
      connections: [...this.profiles.entries()].map(([sid, p]) => ({
        sessionId: sid.slice(0, 8) + "...",
        profile: p.profileId,
        type: p.type,
        status: p.status,
        configured: p.configured,
      })),
    };
  }
}

module.exports = { CastServer, DeviceSession, InternetConnectionManager, INTERNET_PROFILES, genPairingCode, genDeviceId };
