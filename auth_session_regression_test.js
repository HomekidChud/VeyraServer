"use strict";
// Accounts, 2-minute session limit, admin gating and the DevTools bridge.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

let passed = 0;
const check = async (name, fn) => { await fn(); passed += 1; console.log(`ok - ${name}`); };

(async () => {
  const { AuthStore } = require("./auth");
  const { SessionManager } = require("./session-manager");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-auth-"));

  await check("auth: signup hashes passwords, login verifies, tokens round-trip", async () => {
    const a = new AuthStore({ dataDir: dir, secret: "s".repeat(32), adminEmails: ["boss@x.io"] });
    const r = a.signup({ email: "Me@X.io", password: "hunter22a", name: "Me" });
    assert.strictEqual(r.user.email, "me@x.io");
    assert.strictEqual(r.user.role, "user");
    assert.ok(!JSON.stringify(r.user).includes("hunter"));
    assert.strictEqual(a.userFromToken(r.token).email, "me@x.io");
    assert.throws(() => a.login({ email: "me@x.io", password: "wrongpass1" }), /match/);
    assert.ok(a.login({ email: "me@x.io", password: "hunter22a" }).token);
    assert.throws(() => a.signup({ email: "me@x.io", password: "hunter22a" }), /already exists/);
    assert.throws(() => a.signup({ email: "bad", password: "hunter22a" }), /valid email/);
    assert.throws(() => a.signup({ email: "w@x.io", password: "short" }), /8 characters/);
    assert.strictEqual(a.signup({ email: "boss@x.io", password: "hunter22a" }).user.role, "admin");
    await a.writing;
    const stored = fs.readFileSync(path.join(dir, "users.json"), "utf8");
    assert.ok(stored.includes("scrypt$") && !stored.includes("hunter22a"));
  });

  await check("auth: tampered / revoked tokens are rejected", async () => {
    const a = new AuthStore({ dataDir: dir, secret: "s".repeat(32) });
    const { token } = a.login({ email: "me@x.io", password: "hunter22a" });
    const [v, p, sig] = token.split(".");
    assert.strictEqual(a.userFromToken(`${v}.${p}.${sig.slice(0, -2)}xx`), null);
    const other = new AuthStore({ dataDir: dir, secret: "t".repeat(32) });
    assert.strictEqual(other.userFromToken(token), null, "different secret");
    a.logoutEverywhere(a.userFromToken(token));
    assert.strictEqual(a.userFromToken(token), null, "sign out everywhere");
  });

  await check("session limit: hard 2-minute lifetime, tombstoned ids can't be reused", async () => {
    let now = 1000000;
    const expired = [];
    const m = new SessionManager({ timeLimitMs: 120000, now: () => now });
    m.on("expire", (sid, rec, reason) => expired.push([sid, reason]));
    const rec = m.create("a".repeat(32));
    assert.strictEqual(m.remainingMs(rec), 120000);
    now += 60000; m.touch("a".repeat(32));
    assert.strictEqual(m.remainingMs(m.peek("a".repeat(32))), 60000, "activity does not extend the limit");
    now += 60001;
    assert.strictEqual(m.checkLimit("a".repeat(32)), true);
    assert.deepStrictEqual(expired, [["a".repeat(32), "limit"]]);
    assert.throws(() => m.touch("a".repeat(32)), e => e.code === "SESSION_EXPIRED");
    m.create("b".repeat(32)); now += 130000; await m.sweep();
    assert.strictEqual(m.has("b".repeat(32)), false, "sweeper deletes expired sessions");
    assert.strictEqual(m.stats.expiredLimit, 2);
  });

  await check("devtools bridge: source is script-safe", () => {
    const { source } = require("./devtools-bridge");
    assert.ok(!/<\/script/i.test(source), "no closing script tag");
    assert.ok(source.includes("dom.document") && source.includes("runtime.evaluate") && source.includes("network.enable"));
  });

  // --- live server --------------------------------------------------------
  const port = 4300 + Math.floor(Math.random() * 500);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-srv-"));
  const child = spawn(process.execPath, ["server.js"], { cwd: __dirname, env: { ...process.env, PORT: String(port), VEYRA_ENV: "production", VEYRA_DEV_CONFIG_API: "false", SESSION_TIME_LIMIT_MS: "3000", VEYRA_ADMIN_EMAILS: "root@veyra.test", VEYRA_DATA_DIR: data, BROWSER_ENGINE_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", d => { log += d; }); child.stderr.on("data", d => { log += d; });
  const B = `http://127.0.0.1:${port}`;
  const j = async (p, opts = {}) => { const r = await fetch(B + p, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } }); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body }; };
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`${B}/api/health`); break; } catch { await new Promise(r => setTimeout(r, 150)); } }

    await check("server: /api/session returns a countdown deadline", async () => {
      const r = await j("/api/session", { method: "POST" });
      assert.strictEqual(r.status, 201);
      assert.strictEqual(r.body.timeLimitMs, 3000);
      assert.ok(Date.parse(r.body.expiresAt) > Date.now());
      const info = await j(`/api/session/${r.body.sessionId}`);
      assert.strictEqual(info.body.active, true);
      await new Promise(res => setTimeout(res, 3300));
      const after = await j(`/api/session/${r.body.sessionId}`);
      assert.strictEqual(after.body.active, false);
      assert.strictEqual(after.body.expired, true);
      const view = await fetch(`${B}/api/resource?url=${encodeURIComponent("https://example.com/")}&sid=${r.body.sessionId}`);
      assert.strictEqual(view.status, 410);
      assert.strictEqual((await view.json()).code, "SESSION_EXPIRED");
    });

    await check("server: debug / status / sessions are admin-only in production", async () => {
      assert.strictEqual((await j("/api/debug/system")).status, 403);
      assert.strictEqual((await j("/api/sessions")).status, 403);
      assert.strictEqual((await fetch(`${B}/status`)).status, 403);
      assert.strictEqual((await j("/api/debug/client-log", { method: "POST", body: "{}" })).status < 400, true, "client-log stays open");
      const user = await j("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "u@veyra.test", password: "passw0rd!" }) });
      assert.strictEqual(user.status, 201);
      assert.strictEqual((await j("/api/debug/system", { headers: { authorization: `Bearer ${user.body.token}` } })).status, 403);
      const admin = await j("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "root@veyra.test", password: "passw0rd!" }) });
      assert.strictEqual(admin.body.user.role, "admin");
      assert.strictEqual((await j("/api/debug/system", { headers: { authorization: `Bearer ${admin.body.token}` } })).status, 200);
      const me = await j("/api/auth/me", { headers: { authorization: `Bearer ${user.body.token}` } });
      assert.strictEqual(me.body.user.email, "u@veyra.test");
      assert.strictEqual((await j("/api/auth/me")).status, 401);
      const cfg = await j("/api/auth/config", { headers: { authorization: `Bearer ${admin.body.token}` } });
      assert.strictEqual(cfg.body.admin, true);
    });

    await check("server: synced settings round-trip for signed-in users", async () => {
      const { body } = await j("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "u@veyra.test", password: "passw0rd!" }) });
      const h = { authorization: `Bearer ${body.token}` };
      assert.strictEqual((await j("/api/auth/data", { method: "PUT", headers: h, body: JSON.stringify({ data: { theme: "light" } }) })).status, 200);
      assert.strictEqual((await j("/api/auth/data", { headers: h })).body.data.theme, "light");
    });

    await check("server: DevTools bridge script is served and runtime loads it on demand", async () => {
      const r = await fetch(`${B}/api/devtools/bridge.js`);
      assert.strictEqual(r.status, 200);
      const src = await r.text();
      assert.ok(src.includes("window.installVeyraDevtools = installVeyraDevtools"));
      new Function(src);
    });
    await check("server: injected page runtime is valid JavaScript", async () => {
      const s = await (await fetch(`${B}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
      const html = require("./server.js").injectRuntime("<html><head></head><body><p>x</p></body></html>", "https://example.com/", s.sessionId);
      const scripts = [...html.matchAll(/<script data-veyra-runtime[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
      assert.ok(scripts.length >= 1, "runtime script injected");
      for (const code of scripts) new Function(code);
    });
    await check("proxy: params a page appends to the proxy URL are merged into the target (Google sei loop)", async () => {
      const { mergeStrayProxyParams } = require("./server.js");
      const req = { originalUrl: "/api/view?url=" + encodeURIComponent("https://www.google.com/search?q=hi") + "&sid=abc&sei=XYZ&from=x" };
      assert.strictEqual(mergeStrayProxyParams(req, "https://www.google.com/search?q=hi"), "https://www.google.com/search?q=hi&sei=XYZ");
      const same = { originalUrl: "/api/view?url=" + encodeURIComponent("https://a.test/?q=1") + "&sid=abc" };
      assert.strictEqual(mergeStrayProxyParams(same, "https://a.test/?q=1"), "https://a.test/?q=1");
    });
    await check("proxy: Google unusual-traffic wall is detected as a challenge", async () => {
      const { detectChallenge } = require("./server.js");
      const c = detectChallenge("<html><body>Our systems have detected unusual traffic from your computer network.</body></html>", "text/html", 429, {});
      assert.strictEqual(c && c.type, "unusual-traffic");
      assert.strictEqual(detectChallenge("<html><body>hello</body></html>", "text/html", 200, {}), null);
    });
  } finally {
    child.kill("SIGTERM");
  }
  console.log(`\n${passed} auth/session checks passed`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
