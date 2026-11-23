"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AuthStore } = require("../src/core/auth");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-auth-"));
try {
  const locked = new AuthStore({ dataDir: dir, secret: "test-auth-secret", signupKey: "local-only-key" });
  assert.throws(() => locked.signup({ email: "a@example.com", password: "Password1", name: "A" }, "127.0.0.1"), e => e.code === "AUTH_SIGNUP_KEY_REQUIRED");
  const created = locked.signup({ email: "a@example.com", password: "Password1", name: "A", signupKey: "local-only-key" }, "127.0.0.1");
  assert.equal(created.user.email, "a@example.com");
  assert.equal(locked.status().signupKeyRequired, true);

  const open = new AuthStore({ dataDir: path.join(dir, "open"), secret: "test-auth-secret" });
  const openCreated = open.signup({ email: "b@example.com", password: "Password1", name: "B" }, "127.0.0.1");
  assert.equal(openCreated.user.email, "b@example.com");
  assert.equal(open.status().signupKeyRequired, false);
  console.log("Auth signup-key regression tests passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
