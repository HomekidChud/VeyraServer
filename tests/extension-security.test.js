"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ExtensionStoreSecurity, ExtensionSecurityError, scanExtensionPackage } = require("../src/services/extension-security");

function fixture(overrides = {}) {
  return {
    schema: "veyra-extension/v1",
    id: "safe-theme",
    name: "Safe theme",
    version: "1.0.0",
    description: "A CSS-only test extension.",
    permissions: ["styles"],
    matches: ["https://example.com/*"],
    files: { "style.css": "body{color:#123}" },
    tags: ["test"],
    ...overrides
  };
}

assert.equal(scanExtensionPackage(fixture()).extension.integrity.algorithm, "sha256");
assert.throws(() => scanExtensionPackage(fixture({ script: "alert(1)" })), error => error instanceof ExtensionSecurityError && error.code === "EXTENSION_UNSUPPORTED_CAPABILITY");
assert.throws(() => scanExtensionPackage(fixture({ files: { "../style.css": "body{}" } })), error => error instanceof ExtensionSecurityError && error.code === "EXTENSION_UNSUPPORTED_FILE");
assert.throws(() => scanExtensionPackage(fixture({ files: { "style.css": "@import url(https://evil.example/a.css);" } })), error => error instanceof ExtensionSecurityError && error.code === "EXTENSION_CSS_REMOTE_OR_EXECUTABLE");
assert.throws(() => scanExtensionPackage(fixture({ matches: ["https://example.com/%2fsecret"] })), error => error instanceof ExtensionSecurityError && error.code === "EXTENSION_INVALID_MATCH");
assert.throws(() => scanExtensionPackage(fixture(), { requireSignature: true }), error => error instanceof ExtensionSecurityError && error.code === "EXTENSION_SIGNATURE_REQUIRED");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-extension-security-"));
const builtInFile = path.join(temp, "built-in.json");
fs.writeFileSync(builtInFile, JSON.stringify([fixture({ id: "catalog-theme", name: "Catalog theme" })]));
const store = new ExtensionStoreSecurity({ dataDir: path.join(temp, "data"), builtInStoreFile: builtInFile });
const publisher = { id: "publisher-1", name: "Publisher One", email: "one@example.test" };
const admin = { id: "admin-1", name: "Admin One", role: "admin" };

const rejected = store.submit(fixture({ id: "bad-theme", files: { "style.css": "body{background:url(https://evil.example/x)}" } }), publisher);
assert.equal(rejected.state, "REJECTED");
assert.equal(rejected.scan.verdict, "REJECTED");
const pending = store.submit(fixture({ id: "review-theme" }), publisher);
assert.equal(pending.state, "REVIEW_REQUIRED");
assert.throws(() => store.decide(pending.id, "approve", { ...publisher, role: "admin" }), error => error.code === "EXTENSION_SELF_REVIEW_FORBIDDEN");
const approved = store.decide(pending.id, "approve", admin, "CSS policy reviewed.");
assert.equal(approved.state, "APPROVED");
const published = store.publish(pending.id, admin);
assert.equal(published.verification.state, "PUBLISHED");
assert.equal(store.listPublished().some(item => item.id === "review-theme"), true);
assert.equal(store.listPublished().some(item => item.id === "catalog-theme"), true);
assert.equal(store.policy().archives, "not supported and rejected; this runtime never extracts untrusted archives");
assert.equal(store.auditEvents().some(event => event.type === "extension.published"), true);

fs.rmSync(temp, { recursive: true, force: true });
console.log("Extension security regression tests passed");
