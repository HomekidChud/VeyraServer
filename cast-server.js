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
const { WebSocketServer, WebSocket } = require("ws");

// ---------------------------------------------------------------- utilities
function genPairingCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function genDeviceId() { return `veyra-dev_${crypto.randomBytes(8).toString("hex")}`; }
function now() { return Date.now(); }

// ---------------------------------------------------------------- device session
class DeviceSession {
  constructor(id, browserWs) {
    this.id = id;
    this.pairingCode = genPairingCode();
    this.browserWs = browserWs;
    this.deviceWs = null;
    this.deviceId = null;
    this.deviceName = "";
    this.deviceType = "";
    this.createdAt = now();
    this.pairedAt = null;
    this.status = "waiting"; // waiting | paired | streaming | disconnected
    this.frameCount = 0;
    this.bytesTransferred = 0;
    this.lastFrameAt = 0;
    this.quality = "auto"; // low | medium | high | auto
    this.fps = 30;
    this.inputEnabled = true;
    this.audioEnabled = false;
    this.connectionType = "unknown"; // wifi | cellular | lan | custom
    this.networkStrength = 0;
  }

  pair(deviceWs, deviceId, deviceInfo) {
    this.deviceWs = deviceWs;
    this.deviceId = deviceId || genDeviceId();
    this.deviceName = deviceInfo?.name || "Unknown Device";
    this.deviceType = deviceInfo?.type || "phone";
    this.connectionType = deviceInfo?.connectionType || "wifi";
    this.networkStrength = deviceInfo?.networkStrength || 100;
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

// ---------------------------------------------------------------- cast server
class CastServer {
  constructor(server, log = () => {}) {
    this.log = log;
    this.sessions = new Map();
    this.devices = new Map();
    this.wss = new WebSocketServer({ server, path: "/ws/cast" });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    this.cleanupInterval.unref?.();
    this.stats = { totalSessions: 0, totalDevices: 0, activeStreams: 0, framesRelayed: 0 };
  }

  onConnection(ws, req) {
    const url = new URL(req.url, "http://localhost");
    const role = url.searchParams.get("role");
    const sessionId = url.searchParams.get("session");
    const code = url.searchParams.get("code");
    const deviceId = url.searchParams.get("deviceId");

    if (role === "browser") {
      this.handleBrowser(ws, sessionId);
    } else if (role === "device") {
      this.handleDevice(ws, sessionId, code, deviceId, req);
    } else {
      ws.close(4001, "Missing or invalid role");
    }
  }

  handleBrowser(ws, sessionId) {
    let session = sessionId ? this.sessions.get(sessionId) : null;
    if (!session) {
      sessionId = sessionId || `cast_${crypto.randomBytes(6).toString("hex")}`;
      session = new DeviceSession(sessionId, ws);
      this.sessions.set(sessionId, session);
      this.stats.totalSessions++;
    } else {
      session.browserWs = ws;
    }

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "start_streaming") {
          session.status = "streaming";
          session.sendToDevice({ type: "start_streaming", quality: session.quality, fps: session.fps });
          this.stats.activeStreams++;
        } else if (msg.type === "stop_streaming") {
          session.status = "paired";
          session.sendToDevice({ type: "stop_streaming" });
          this.stats.activeStreams = Math.max(0, this.stats.activeStreams - 1);
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
      if (session.status === "streaming") this.stats.activeStreams = Math.max(0, this.stats.activeStreams - 1);
      session.disconnect("browser_closed");
      this.sessions.delete(sessionId);
    });

    // Send session info + QR data
    const qrPayload = `veyra://casteddevice:/${sessionId}?code=${session.pairingCode}`;
    ws.send(JSON.stringify({
      type: "session_created",
      sessionId,
      pairingCode: session.pairingCode,
      qrPayload,
      qrUrl: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrPayload)}`,
      timestamp: now(),
    }));
  }

  handleDevice(ws, sessionId, code, deviceId, req) {
    const session = this.sessions.get(sessionId);
    if (!session) { ws.close(4002, "Invalid session"); return; }
    if (code !== session.pairingCode) { ws.close(4003, "Invalid pairing code"); return; }

    const deviceInfo = {
      name: new URL(req.url, "http://localhost").searchParams.get("name") || "Phone",
      type: new URL(req.url, "http://localhost").searchParams.get("type") || "phone",
      connectionType: new URL(req.url, "http://localhost").searchParams.get("connection") || "wifi",
      networkStrength: parseInt(new URL(req.url, "http://localhost").searchParams.get("strength") || "100"),
    };

    session.pair(ws, deviceId, deviceInfo);
    this.devices.set(session.deviceId, session);
    this.stats.totalDevices++;

    // Notify browser
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
        // Could be binary frame data or JSON control message
        if (Buffer.isBuffer(data) || typeof data === "string") {
          const str = data.toString();
          // Check if it's a JSON control message
          if (str.startsWith("{")) {
            const msg = JSON.parse(str);
            if (msg.type === "frame") {
              session.relayFrame(msg.data);
              this.stats.framesRelayed++;
            } else if (msg.type === "network_update") {
              session.connectionType = msg.connectionType || session.connectionType;
              session.networkStrength = msg.networkStrength ?? session.networkStrength;
              session.sendToBrowser({ type: "network_update", connectionType: session.connectionType, networkStrength: session.networkStrength });
            } else if (msg.type === "device_info") {
              session.deviceName = msg.name || session.deviceName;
              session.sendToBrowser({ type: "device_info", name: msg.name, battery: msg.battery, screen: msg.screen });
            }
          } else {
            // Binary frame data (raw JPEG/WebP)
            session.relayFrame(str);
            this.stats.framesRelayed++;
          }
        }
      } catch (e) { this.log("warn", "CAST", `Device message error: ${e.message}`); }
    });

    ws.on("close", () => {
      session.status = "disconnected";
      session.sendToBrowser({ type: "device_disconnected", reason: "device_closed", timestamp: now() });
    });
  }

  cleanup() {
    const cutoff = now() - 5 * 60 * 1000; // 5 minutes
    for (const [id, session] of this.sessions) {
      if (session.status === "disconnected" && session.createdAt < cutoff) {
        this.sessions.delete(id);
      }
      if (session.status === "waiting" && now() - session.createdAt > 10 * 60 * 1000) {
        session.disconnect("timeout");
        this.sessions.delete(id);
      }
    }
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
    for (const session of this.sessions.values()) session.disconnect("server_shutdown");
    this.wss.close();
  }
}

// ---------------------------------------------------------------- internet connection profiles
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
    this.connections = new Map(); // sessionId -> profileId
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
    this.connections.set(sessionId, profileId);
    this.currentProfile = profileId;
    this.stats.totalConnections++;

    const profile = INTERNET_PROFILES.find(p => p.id === profileId);
    if (!profile) return null;

    // Build connection config
    const connectionConfig = {
      profileId,
      type: profile.type,
      sessionId,
      configured: false,
      status: "disconnected",
      ...config,
    };

    // Apply type-specific config
    if (profile.type === "wireless") {
      connectionConfig.ssid = config.ssid || "";
      connectionConfig.password = config.password || "";
      connectionConfig.security = config.security || "wpa2";
      connectionConfig.frequency = config.frequency || "auto"; // 2.4ghz | 5ghz | auto
    } else if (profile.type === "mobile") {
      connectionConfig.apn = config.apn || "";
      connectionConfig.carrier = config.carrier || "";
      connectionConfig.pin = config.pin || "";
      connectionConfig.networkType = config.networkType || "4g"; // 3g | 4g | 5g | lte
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

    connectionConfig.status = "connecting";
    this.profiles.set(sessionId, connectionConfig);

    // Simulate connection process
    setTimeout(() => {
      const p = this.profiles.get(sessionId);
      if (p) {
        p.status = "connected";
        p.configured = true;
        p.connectedAt = Date.now();
      }
    }, 500);

    return connectionConfig;
  }

  getProfile(sessionId) { return this.profiles.get(sessionId); }
  getCurrentProfile() { return this.currentProfile; }
  getAvailableProfiles() { return INTERNET_PROFILES; }

  testConnection(sessionId) {
    const profile = this.profiles.get(sessionId);
    if (!profile) return { ok: false, error: "No connection configured" };
    return {
      ok: profile.status === "connected",
      profile: profile.profileId,
      latency: Math.floor(Math.random() * 50) + 10,
      bandwidth: Math.floor(Math.random() * 50) + 20,
      status: profile.status,
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
