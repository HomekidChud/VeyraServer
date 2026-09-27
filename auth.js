"use strict";
// Veyra accounts — small, dependency-free auth for the frontend's sign in / sign up.
//
// * Passwords: scrypt (N=16384, r=8, p=1) with a per-user 16-byte salt.
// * Tokens: stateless HMAC-SHA256 signed "v1.<payload>.<sig>" bearer tokens.
//   Each user carries a tokenVersion so "sign out everywhere" / password
//   changes revoke every outstanding token.
// * Storage: JSON file (VEYRA_DATA_DIR, default ./data). On Render's free plan
//   the disk is ephemeral, so attach a persistent disk (or accept resets on
//   redeploy). Writes are atomic (tmp + rename) and serialised.
// * Roles: "admin" for emails listed in VEYRA_ADMIN_EMAILS, otherwise "user".
// * Brute-force protection: per-IP and per-email sliding window limits.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

class AuthStore {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || path.join(__dirname, "data");
    this.file = path.join(this.dataDir, "users.json");
    this.secret = opts.secret || "";
    this.ephemeralSecret = !this.secret;
    if (!this.secret) this.secret = crypto.randomBytes(32).toString("hex");
    this.tokenTtlMs = opts.tokenTtlMs || 7 * 24 * 60 * 60 * 1000;
    this.adminEmails = new Set((opts.adminEmails || []).map(e => String(e).trim().toLowerCase()).filter(Boolean));
    this.allowSignup = opts.allowSignup !== false;
    this.maxUsers = opts.maxUsers || 5000;
    this.maxDataBytes = opts.maxDataBytes || 64 * 1024;
    this.log = opts.log || (() => {});
    this.users = new Map();      // id -> user
    this.byEmail = new Map();    // email -> id
    this.attempts = new Map();   // key -> [timestamps]
    this.writing = Promise.resolve();
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const u of raw.users || []) { this.users.set(u.id, u); this.byEmail.set(u.email, u.id); }
      this.log("info", "AUTH", `Loaded ${this.users.size} account(s) from ${this.file}.`);
    } catch (e) {
      if (e.code !== "ENOENT") this.log("warn", "AUTH", `Could not read ${this.file}: ${e.message}`);
    }
  }
  save() {
    const snapshot = JSON.stringify({ version: 1, users: [...this.users.values()] });
    this.writing = this.writing.then(async () => {
      await fs.promises.mkdir(this.dataDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.promises.rename(tmp, this.file);
    }).catch(e => this.log("warn", "AUTH", `Could not save accounts: ${e.message}`));
    return this.writing;
  }

  // ---- rate limiting ------------------------------------------------------
  limited(key, max, windowMs) {
    const t = Date.now();
    const list = (this.attempts.get(key) || []).filter(x => t - x < windowMs);
    list.push(t);
    this.attempts.set(key, list);
    if (this.attempts.size > 20000) this.attempts.delete(this.attempts.keys().next().value);
    return list.length > max;
  }
  guard(ip, email) {
    if (this.limited(`ip:${ip}`, 30, 10 * 60 * 1000) || (email && this.limited(`em:${email}`, 10, 10 * 60 * 1000)))
      throw authError(429, "Too many attempts. Wait a few minutes and try again.", "AUTH_RATE_LIMITED");
  }

  // ---- passwords ----------------------------------------------------------
  hash(password, salt = crypto.randomBytes(16)) {
    const key = crypto.scryptSync(String(password).normalize("NFKC"), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
  }
  verify(password, stored) {
    const [, saltB64, keyB64] = String(stored || "").split("$");
    if (!saltB64 || !keyB64) return false;
    const expect = Buffer.from(keyB64, "base64");
    const got = Buffer.from(this.hash(password, Buffer.from(saltB64, "base64")).split("$")[2], "base64");
    return got.length === expect.length && crypto.timingSafeEqual(got, expect);
  }

  // ---- tokens -------------------------------------------------------------
  sign(user) {
    const payload = Buffer.from(JSON.stringify({ sub: user.id, v: user.tokenVersion || 0, exp: Date.now() + this.tokenTtlMs })).toString("base64url");
    const sig = crypto.createHmac("sha256", this.secret).update(`v1.${payload}`).digest("base64url");
    return `v1.${payload}.${sig}`;
  }
  userFromToken(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return null;
    const expect = crypto.createHmac("sha256", this.secret).update(`v1.${parts[1]}`).digest();
    const got = Buffer.from(parts[2], "base64url");
    if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return null;
    let p; try { p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return null; }
    if (!p || Date.now() > Number(p.exp || 0)) return null;
    const user = this.users.get(p.sub);
    if (!user || (user.tokenVersion || 0) !== p.v) return null;
    return user;
  }
  userFromRequest(req) {
    const h = String(req.get?.("authorization") || "");
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    return m ? this.userFromToken(m[1]) : null;
  }

  // ---- accounts -----------------------------------------------------------
  roleFor(email) { return this.adminEmails.has(email) ? "admin" : "user"; }
  publicUser(u) {
    return { id: u.id, email: u.email, name: u.name, role: this.roleFor(u.email), createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null };
  }
  signup({ email, password, name }, ip = "") {
    if (!this.allowSignup) throw authError(403, "Sign ups are disabled on this server.", "AUTH_SIGNUP_DISABLED");
    email = String(email || "").trim().toLowerCase();
    name = String(name || "").trim().replace(/\s+/g, " ").slice(0, 60);
    this.guard(ip, email);
    if (!EMAIL_RE.test(email)) throw authError(400, "Enter a valid email address.", "AUTH_BAD_EMAIL");
    checkPassword(password);
    if (this.byEmail.has(email)) throw authError(409, "An account with that email already exists. Sign in instead.", "AUTH_EMAIL_TAKEN");
    if (this.users.size >= this.maxUsers) throw authError(503, "This server has reached its account limit.", "AUTH_FULL");
    const now = new Date().toISOString();
    const user = { id: crypto.randomUUID(), email, name: name || email.split("@")[0], password: this.hash(password), tokenVersion: 0, createdAt: now, lastLoginAt: now, data: {} };
    this.users.set(user.id, user); this.byEmail.set(email, user.id);
    this.save();
    this.log("info", "AUTH", `New account ${email}.`);
    return { user: this.publicUser(user), token: this.sign(user) };
  }
  login({ email, password }, ip = "") {
    email = String(email || "").trim().toLowerCase();
    this.guard(ip, email);
    const user = this.users.get(this.byEmail.get(email));
    // Always run scrypt so response time doesn't reveal which emails exist.
    const ok = this.verify(password, user ? user.password : this.hash("x"));
    if (!user || !ok) throw authError(401, "That email and password don't match.", "AUTH_INVALID");
    user.lastLoginAt = new Date().toISOString();
    this.save();
    return { user: this.publicUser(user), token: this.sign(user) };
  }
  logoutEverywhere(user) { user.tokenVersion = (user.tokenVersion || 0) + 1; this.save(); }
  update(user, { name, password, currentPassword }) {
    if (name != null) user.name = String(name).trim().replace(/\s+/g, " ").slice(0, 60) || user.name;
    if (password != null) {
      if (!this.verify(currentPassword, user.password)) throw authError(401, "Current password is incorrect.", "AUTH_INVALID");
      checkPassword(password);
      user.password = this.hash(password);
      user.tokenVersion = (user.tokenVersion || 0) + 1;
    }
    this.save();
    return { user: this.publicUser(user), token: this.sign(user) };
  }
  getData(user) { return user.data || {}; }
  setData(user, data) {
    const json = JSON.stringify(data || {});
    if (Buffer.byteLength(json) > this.maxDataBytes) throw authError(413, "Synced data is too large.", "AUTH_DATA_TOO_LARGE");
    user.data = JSON.parse(json);
    user.dataUpdatedAt = new Date().toISOString();
    this.save();
    return { updatedAt: user.dataUpdatedAt };
  }
  remove(user, password) {
    if (!this.verify(password, user.password)) throw authError(401, "Password is incorrect.", "AUTH_INVALID");
    this.users.delete(user.id); this.byEmail.delete(user.email);
    this.save();
  }
  status() {
    return { accounts: this.users.size, signupEnabled: this.allowSignup, persistentSecret: !this.ephemeralSecret, admins: this.adminEmails.size, file: this.file };
  }
}

function checkPassword(password) {
  const p = String(password || "");
  if (p.length < 8) throw authError(400, "Password must be at least 8 characters.", "AUTH_WEAK_PASSWORD");
  if (p.length > 200) throw authError(400, "Password is too long.", "AUTH_WEAK_PASSWORD");
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) throw authError(400, "Use at least one letter and one number.", "AUTH_WEAK_PASSWORD");
}
function authError(status, message, code) { return Object.assign(new Error(message), { status, code }); }

module.exports = { AuthStore, authError };
