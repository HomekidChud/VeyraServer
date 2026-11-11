function escapeHtml(s) { return String(s ?? String()).replace(/[&<>"']/g, m => String.fromCharCode(38) + "#" + m.charCodeAt(0) + ";"); }
"use strict";
// Veyra Access Gate — invite-only front door for the whole service.
//
// Every request that does not carry a valid gate session gets the waitlist
// screen instead of the app. Entry points:
//   1. Rotating invite links:  /gate/<random-token>   (token rotates on a timer)
//   2. Waitlist acceptance:    admin accepts an email -> access key -> /api/gate/unlock
//   3. Owner tokens:           GATE_OWNER_TOKENS (never rotate; the owner's personal links)
//   4. Admin token header:    x-veyra-admin-token (same token as the rest of the admin API)
//
// A gate session is a random bearer token. It is returned in the response body
// (the static frontend stores it and sends it as the X-Veyra-Gate header) and
// set as an httpOnly cookie for same-origin flows. Sessions and the waitlist
// are persisted to data/gate.json and mirrored to MongoDB when available.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

function newToken(bytes = 24) { return crypto.randomBytes(bytes).toString("base64url"); }
function newAccessKey() { return `VY-${crypto.randomBytes(9).toString("base64url")}`; }
function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function constantTimeEqual(a = "", b = "") {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

class AccessGate {
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.dataDir = opts.dataDir || path.join(__dirname, "..", "..", "data");
    this.file = path.join(this.dataDir, "gate.json");
    this.log = opts.log || (() => {});
    this.frontendUrl = String(opts.frontendUrl || "");
    this.rotateMs = Math.max(30 * 1000, Number(opts.rotateMs) || 10 * 60 * 1000);
    this.graceMs = Math.max(this.rotateMs, Number(opts.graceMs) || this.rotateMs * 2);
    this.sessionTtlMs = Math.max(60 * 1000, Number(opts.sessionTtlMs) || 30 * 24 * 60 * 60 * 1000);
    this.cookieName = String(opts.cookieName || "veyra_gate");
    this.waitlistOpen = opts.waitlistOpen !== false;
    this.maxWaitlist = Math.max(10, Number(opts.maxWaitlist) || 100000);
    this.maxSessions = Math.max(10, Number(opts.maxSessions) || 20000);
    this.ownerTokens = new Set(String(opts.ownerTokens || "").split(",").map(s => s.trim()).filter(Boolean));
    this.adminToken = String(opts.adminToken || "");
    this.testMode = !!opts.testMode;
    this.persistence = opts.persistence || null;

    // Rotating entry tokens: newest first, pruned by the grace window.
    this.tokens = [{ token: newToken(), createdAt: Date.now() }];

    this.waitlist = [];   // { id, email, status, keyHash?, keyIssuedAt?, createdAt, acceptedAt? }
    this.sessions = new Map();  // token -> { email, createdAt, expiresAt, origin }
    this.joinLimiter = new Map();  // ip -> { count, resetAt }

    this.load();
    this.rotateTimer = setInterval(() => this.rotate(), this.rotateMs);
    this.rotateTimer.unref?.();
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  /* ---------- persistence ---------- */
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(raw.tokens)) {
        const now = Date.now();
        for (const t of raw.tokens.slice().reverse()) {
          if (t?.token && now - t.createdAt <= this.graceMs) this.tokens.unshift({ token: t.token, createdAt: t.createdAt });
        }
      }
      if (Array.isArray(raw.waitlist)) this.waitlist = raw.waitlist.slice(0, this.maxWaitlist);
      if (raw.sessions && typeof raw.sessions === "object") {
        const now = Date.now();
        for (const [token, s] of Object.entries(raw.sessions)) {
          if (!s?.email || (s.expiresAt && s.expiresAt < now)) continue;
          this.sessions.set(token, s);
        }
      }
      this.log("info", "GATE", `Loaded gate state: ${this.waitlist.length} waitlist entries, ${this.sessions.size} sessions.`);
    } catch (e) {
      if (e.code !== "ENOENT") this.log("warn", "GATE", `Could not read ${this.file}: ${e.message}`);
    }
  }
  save() {
    const snapshot = {
      version: 1,
      tokens: this.tokens.slice(0, 8),
      waitlist: this.waitlist,
      sessions: Object.fromEntries([...this.sessions.entries()].slice(-5000)),
    };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log("warn", "GATE", `Could not save gate state: ${e.message}`);
    }
    if (this.persistence?.enabled) {
      void Promise.resolve(this.persistence.replaceGateState?.(snapshot)).catch(() => {});
    }
  }
  async hydrateFromPersistence() {
    if (!this.persistence?.enabled || !this.persistence.loadGateState) return;
    try {
      const raw = await this.persistence.loadGateState();
      if (!raw) return;
      if (Array.isArray(raw.waitlist) && raw.waitlist.length) this.waitlist = raw.waitlist;
      if (raw.sessions && typeof raw.sessions === "object") {
        const now = Date.now();
        for (const [token, s] of Object.entries(raw.sessions)) {
          if (!s?.email || (s.expiresAt && s.expiresAt < now)) continue;
          this.sessions.set(token, s);
        }
      }
      this.log("info", "GATE", `Hydrated gate state from MongoDB (${this.sessions.size} sessions).`);
    } catch (e) {
      this.log("warn", "GATE", `MongoDB gate hydration skipped: ${e.message}`);
    }
  }

  /* ---------- rotating invite links ---------- */
  rotate(force = false) {
    const previous = this.currentToken();
    this.tokens.unshift({ token: newToken(), createdAt: Date.now() });
    this.tokens = this.tokens.filter(t => Date.now() - t.createdAt <= this.graceMs).slice(0, 8);
    this.save();
    this.log("info", "GATE", `Invite link rotated${force ? " (manual)" : ""}. Previous links stay valid for ${Math.round(this.graceMs / 60000)} min.`);
    return { previous, current: this.currentToken() };
  }
  currentToken() { return this.tokens[0]?.token || ""; }
  tokenHistory() { return this.tokens.map(t => ({ token: t.token, createdAt: new Date(t.createdAt).toISOString() })); }
  validateEntryToken(candidate) {
    if (!candidate) return false;
    for (const t of this.tokens) if (constantTimeEqual(candidate, t.token)) return true;
    for (const t of this.ownerTokens) if (constantTimeEqual(candidate, t)) return true;
    return false;
  }
  isAdminRequest(req) {
    if (!this.adminToken) return false;
    const got = String(req?.get?.("x-veyra-admin-token") || req?.headers?.["x-veyra-admin-token"] || "").trim();
    return constantTimeEqual(got, this.adminToken);
  }

  /* ---------- sessions ---------- */
  createSession({ email = "", origin = "" } = {}) {
    this.cleanup();
    const token = newToken(24);
    this.sessions.set(token, { email: String(email || "invite").slice(0, 190), origin: String(origin).slice(0, 80), createdAt: Date.now(), expiresAt: Date.now() + this.sessionTtlMs });
    if (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
    this.save();
    return token;
  }
  verifySession(candidate) {
    if (!candidate) return null;
    const s = this.sessions.get(String(candidate));
    if (!s) return null;
    if (s.expiresAt && s.expiresAt < Date.now()) { this.sessions.delete(String(candidate)); this.save(); return null; }
    return s;
  }
  sessionFromRequest(req) {
    const header = String(req?.get?.("x-veyra-gate") || req?.headers?.["x-veyra-gate"] || "").trim();
    if (header) { const s = this.verifySession(header); if (s) return s; }
    const cookie = String(req?.headers?.cookie || "");
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${this.cookieName}=([^;]+)`));
    if (m) { const s = this.verifySession(decodeURIComponent(m[1])); if (s) return s; }
    return null;
  }
  revokeSession(candidate) { const had = this.sessions.delete(String(candidate || "")); if (had) this.save(); return had; }

  /* ---------- waitlist ---------- */
  limited(key, max, windowMs) {
    const now = Date.now();
    const entry = this.joinLimiter.get(key);
    if (!entry || entry.resetAt < now) { this.joinLimiter.set(key, { count: 1, resetAt: now + windowMs }); return false; }
    entry.count += 1;
    if (this.joinLimiter.size > 10000) this.joinLimiter.clear();
    return entry.count > max;
  }
  joinWaitlist(email) {
    const clean = String(email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(clean)) throw Object.assign(new Error("Enter a valid email address."), { status: 400, code: "GATE_EMAIL_INVALID" });
    const existing = this.waitlist.find(x => x.email === clean);
    if (existing) return { entry: this.publicEntry(existing), alreadyJoined: true };
    if (!this.waitlistOpen) throw Object.assign(new Error("The waitlist is currently closed."), { status: 403, code: "GATE_WAITLIST_CLOSED" });
    if (this.waitlist.length >= this.maxWaitlist) throw Object.assign(new Error("The waitlist is full."), { status: 403, code: "GATE_WAITLIST_FULL" });
    const entry = { id: crypto.randomUUID(), email: clean, status: "pending", createdAt: new Date().toISOString() };
    this.waitlist.push(entry);
    this.save();
    return { entry: this.publicEntry(entry), alreadyJoined: false };
  }
  waitlistStatus(email) {
    const clean = String(email || "").trim().toLowerCase();
    const entry = this.waitlist.find(x => x.email === clean);
    if (!entry) return null;
    return this.publicEntry(entry);
  }
  listWaitlist() { return this.waitlist.map(x => this.publicEntry(x)); }
  acceptEntry(id) {
    const entry = this.waitlist.find(x => x.id === String(id || ""));
    if (!entry) throw Object.assign(new Error("Waitlist entry not found."), { status: 404, code: "GATE_ENTRY_NOT_FOUND" });
    if (entry.status === "accepted" && entry.keyHash) return { entry: this.publicEntry(entry), key: null, alreadyAccepted: true };
    entry.status = "accepted";
    entry.acceptedAt = new Date().toISOString();
    entry.keyIssuedAt = entry.acceptedAt;
    const key = newAccessKey();
    entry.keyHash = sha256(key);
    this.save();
    return { entry: this.publicEntry(entry), key, alreadyAccepted: false };
  }
  rejectEntry(id) {
    const i = this.waitlist.findIndex(x => x.id === String(id || ""));
    if (i === -1) throw Object.assign(new Error("Waitlist entry not found."), { status: 404, code: "GATE_ENTRY_NOT_FOUND" });
    const [removed] = this.waitlist.splice(i, 1);
    this.save();
    return { entry: this.publicEntry(removed) };
  }
  reissueKey(id) {
    const entry = this.waitlist.find(x => x.id === String(id || ""));
    if (!entry) throw Object.assign(new Error("Waitlist entry not found."), { status: 404, code: "GATE_ENTRY_NOT_FOUND" });
    entry.status = "accepted";
    entry.keyIssuedAt = new Date().toISOString();
    const key = newAccessKey();
    entry.keyHash = sha256(key);
    this.save();
    return { entry: this.publicEntry(entry), key };
  }
  unlockWithKey(key) {
    const clean = String(key || "").trim();
    if (!clean) throw Object.assign(new Error("Enter your access key."), { status: 400, code: "GATE_KEY_REQUIRED" });
    const hash = sha256(clean);
    const entry = this.waitlist.find(x => x.keyHash === hash && x.status === "accepted");
    if (!entry) throw Object.assign(new Error("That access key is not valid."), { status: 403, code: "GATE_KEY_INVALID" });
    return { email: entry.email, sessionToken: this.createSession({ email: entry.email, origin: "access-key" }) };
  }
  publicEntry(x) {
    return { id: x.id, email: x.email, status: x.status, position: this.waitlist.filter(w => w.status === "pending").indexOf(x) + 1 || null, createdAt: x.createdAt, acceptedAt: x.acceptedAt || null, keyIssuedAt: x.keyIssuedAt || null, hasKey: !!x.keyHash };
  }

  /* ---------- middleware ---------- */
  isPublicPath(pathname) {
    if (pathname === "/health" || pathname === "/api/health") return true;
    if (pathname === "/gate" || pathname.startsWith("/gate/")) return true;
    if (pathname === "/api/gate/status" || pathname === "/api/gate/config") return true;
    if (pathname === "/api/gate/waitlist" || pathname === "/api/gate/unlock") return true;
    return false;
  }
  middleware() {
    return (req, res, next) => {
      if (!this.enabled) return next();
      if (req.method === "OPTIONS") return next();
      let pathname = "/";
      try { pathname = new URL(req.originalUrl || req.url || "/", "http://x").pathname; } catch {}
      if (this.isPublicPath(pathname)) return next();
      if (this.isAdminRequest(req)) return next();
      if (this.sessionFromRequest(req)) return next();
      // Gated: browsers get the waitlist screen, API callers get a JSON 403.
      if (pathname.startsWith("/api/") || pathname.startsWith("/ws")) {
        res.status(403).json({ ok: false, error: "Veyra is invite-only. Join the waitlist or enter your access key.", code: "GATE_REQUIRED" });
        return;
      }
      res.status(403).type("html").send(this.screenHtml());
    };
  }

  /* ---------- the waitlist screen ---------- */
  screenHtml() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Veyra — Invite only</title>
<style>
:root{--bg:#0d0f13;--panel:#14171d;--line:#232732;--text:#e8eaf0;--muted:#9aa3b2;--accent:#5b8cff}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
main{width:100%;max-width:460px}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:26px}
.logo svg{width:30px;height:30px;color:var(--text)}
.logo b{font-size:20px;letter-spacing:.5px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:26px}
.badge{display:inline-flex;align-items:center;gap:6px;background:rgba(91,140,255,.12);color:var(--accent);border:1px solid rgba(91,140,255,.35);font-size:12px;font-weight:600;padding:4px 10px;border-radius:99px;margin-bottom:14px}
h1{font-size:22px;margin-bottom:8px}
p{color:var(--muted);margin-bottom:18px}
label{display:block;font-size:13px;color:var(--muted);margin:14px 0 6px}
input{width:100%;background:#0d0f13;border:1px solid var(--line);border-radius:9px;color:var(--text);padding:10px 12px;font:inherit;outline:none}
input:focus{border-color:var(--accent)}
button{width:100%;margin-top:16px;background:var(--accent);color:#fff;border:0;border-radius:9px;padding:11px;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.msg{margin-top:12px;font-size:13px;min-height:20px;color:var(--muted)}
.msg.ok{color:#57c993}.msg.err{color:#e0656f}
footer{margin-top:18px;text-align:center;color:#5c6472;font-size:12px}
</style>
</head>
<body>
<main>
<div class="logo"><svg viewBox="0 0 32 32" fill="none"><path d="M7 8.5l9 16 9-16" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="25" cy="8.5" r="2.4" fill="#5b8cff"/></svg><b>Veyra</b></div>
<div class="card">
<span class="badge">🔒 Invite only</span>
<h1>Veyra is in early access</h1>
<p>Access is by invitation. Join the waitlist and we will email you an access key when a spot opens, or enter your key if you already have one.</p>
<form id="join">
<label for="email">Email address</label>
<input id="email" type="email" placeholder="you@example.com" autocomplete="email" required>
<button type="submit" id="joinBtn">Join the waitlist</button>
<div class="msg" id="joinMsg"></div>
</form>
<form id="unlock">
<label for="key">Access key</label>
<input id="key" type="text" placeholder="VY-…" autocomplete="off">
<button type="submit" id="unlockBtn">Unlock Veyra</button>
<div class="msg" id="unlockMsg"></div>
</form>
</div>
<footer>Links to Veyra rotate constantly — only current invite links work.</footer>
</main>
<script>
(function(){
var API="";
try{var m=document.querySelector('meta[name="veyra-api"]');API=m?m.content:"";}catch(e){}
function msg(el,text,cls){el.textContent=text;el.className="msg "+(cls||"");}
function post(path,body){
return fetch(API+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return{status:r.status,body:j};});});
}
document.getElementById("join").addEventListener("submit",function(e){
e.preventDefault();
var email=document.getElementById("email").value.trim(),btn=document.getElementById("joinBtn"),el=document.getElementById("joinMsg");
btn.disabled=true;msg(el,"Joining…");
post("/api/gate/waitlist",{email:email}).then(function(r){
if(r.status===201&&r.body.ok){msg(el,"You're on the list — position #"+((r.body.entry&&r.body.entry.position)||"?")+". We'll email your key when a spot opens.","ok");}
else if(r.body&&r.body.alreadyJoined){msg(el,"You're already on the list — position #"+((r.body.entry&&r.body.entry.position)||"?")+".","ok");}
else{msg(el,(r.body&&r.body.error)||"Could not join the waitlist.","err");}
}).catch(function(){msg(el,"Could not reach Veyra. Try again.","err");}).finally(function(){btn.disabled=false;});
});
document.getElementById("unlock").addEventListener("submit",function(e){
e.preventDefault();
var key=document.getElementById("key").value.trim(),btn=document.getElementById("unlockBtn"),el=document.getElementById("unlockMsg");
btn.disabled=true;msg(el,"Checking…");
post("/api/gate/unlock",{key:key}).then(function(r){
if(r.status===200&&r.body&&r.body.ok&&r.body.token){
try{localStorage.setItem("veyra-gate",r.body.token);}catch(e){}
var target=r.body.redirect||"/";
window.location.replace(target+(target.indexOf("?")===-1?"?gate=":"&gate=")+encodeURIComponent(r.body.token));
return;
}
msg(el,(r.body&&r.body.error)||"That key is not valid.","err");
}).catch(function(){msg(el,"Could not reach Veyra. Try again.","err");}).finally(function(){btn.disabled=false;});
});
})();
</script>
</body>
</html>`;
  }

  cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [token, s] of this.sessions) if (s.expiresAt && s.expiresAt < now) { this.sessions.delete(token); changed = true; }
    for (const [ip, entry] of this.joinLimiter) if (entry.resetAt < now) this.joinLimiter.delete(ip);
    if (changed) this.save();
  }
  report() {
    return {
      enabled: this.enabled,
      waitlistOpen: this.waitlistOpen,
      waitlist: { total: this.waitlist.length, pending: this.waitlist.filter(x => x.status === "pending").length, accepted: this.waitlist.filter(x => x.status === "accepted").length },
      sessions: this.sessions.size,
      rotateMs: this.rotateMs,
      graceMs: this.graceMs,
      nextRotationMs: Math.max(0, this.rotateMs - (Date.now() - this.tokens[0].createdAt)),
      currentLinkValidUntil: new Date(Date.now() + Math.max(0, this.graceMs - (Date.now() - this.tokens[0].createdAt))).toISOString(),
    };
  }
}

module.exports = { AccessGate, newToken, sha256 };
