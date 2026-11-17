"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const mode = process.argv[2];
if (!mode) {
  for (const scenario of ["hosted", "local", "locked"]) {
    const result = spawnSync(process.execPath, [__filename, scenario], { stdio: "inherit", timeout: 20000 });
    assert.equal(result.status, 0, `auth HTTP scenario ${scenario} failed: ${result.error || result.signal || ""}`);
  }
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-auth-http-"));
  const origin = "https://veyra-test.example";
  Object.assign(process.env, {
    VEYRA_ENV: "test", NODE_ENV: "test", VEYRA_TEST_MODE: "true",
    VEYRA_DATA_DIR: dir, VEYRA_ADMIN_TOKEN: "local-http-fixture",
    VEYRA_ALLOW_SIGNUP: "true", VEYRA_SIGNUP_KEY: "fixture-signup",
    FRONTEND_ORIGIN: origin, GATE_ENABLED: String(mode === "locked"),
    MONGODB_URI: "", VEYRA_CHROMIUM_ENABLED: "false",
  });
  if (mode === "hosted") process.env.RENDER = "true";
  else delete process.env.RENDER;

  (async () => {
    const { app } = require("../src/server");
    const server = await new Promise(resolve => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (route, { json, method, ...headers } = {}) => {
      const opts = { method: method || (json ? "POST" : "GET"), headers: { Origin: origin, "Content-Type": "application/json", ...headers } };
      if (json) opts.body = JSON.stringify(json);
      const response = await fetch(`${base}/api/auth/${route}`, opts);
      return [response.status, await response.json(), response.headers];
    };
    try {
      if (mode === "locked") {
        const [status, body, headers] = await call("signup", { json: {} });
        assert.equal(status, 403);
        assert.equal(body.code, "GATE_REQUIRED");
        assert.equal(headers.get("access-control-allow-origin"), origin);
        return;
      }
      const [configStatus, config, configHeaders] = await call("config");
      assert.equal(configStatus, 200);
      assert.equal(configHeaders.get("cache-control"), "no-store");
      assert.equal(config.testMode, false);
      assert.equal(config.signupKeyRequired, true);
      assert.ok(!Object.hasOwn(config, "testAdmin"));
      assert.equal((await call("test-login", { json: {} }))[0], 403);

      const adminHeaders = { "X-Veyra-Admin-Token": process.env.VEYRA_ADMIN_TOKEN };
      assert.equal((await call("config", adminHeaders))[1].testMode, mode === "local");
      assert.equal((await call("test-login", { ...adminHeaders, json: {} }))[0], mode === "local" ? 200 : 403);

      const credentials = { email: "http-account@example.test", password: "LocalFixture7!" };
      assert.equal((await call("signup", { json: credentials }))[1].code, "AUTH_SIGNUP_KEY_REQUIRED");
      assert.equal((await call("signup", { json: { ...credentials, signupKey: "fixture-signup" } }))[0], 201);
      const [loginStatus, login] = await call("login", { json: credentials });
      assert.equal(loginStatus, 200);
      assert.equal(login.user.role, "user");
      const session = { Authorization: `Bearer ${login.token}` };
      assert.equal((await call("me", session))[1].user.email, credentials.email);
      assert.equal((await call("logout", { ...session, json: { everywhere: true } }))[0], 200);
      assert.equal((await call("me", session))[0], 401);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  })().then(() => console.log(`Auth HTTP ${mode} checks passed`), error => { console.error(error); process.exitCode = 1; });
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}
