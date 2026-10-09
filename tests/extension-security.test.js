"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ExtensionStoreSecurity, ExtensionSecurityError, scanExtensionPackage, signExtensionPackage } = require("../src/services/extension-security");

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
const unsignedScript = { schema: "veyra-extension/v2", id: "unsigned-script", name: "Unsigned script", version: "1.0.0", permissions: ["content_scripts"], matches: ["https://example.com/*"], files: { "content/main.js": "document.body.dataset.test='yes'" } };
assert.throws(() => scanExtensionPackage(unsignedScript), error => error instanceof ExtensionSecurityError && error.code === "EXTENSION_SIGNATURE_REQUIRED");
assert.throws(() => scanExtensionPackage({ ...unsignedScript, matches: ["https://*.example.com/*"] }), error => error instanceof ExtensionSecurityError && error.code === "EXTENSION_MATCH_REQUIRED");
assert.throws(() => scanExtensionPackage({ ...unsignedScript, permissions: ["styles"] }), error => error instanceof ExtensionSecurityError && error.code === "EXTENSION_PERMISSION_FILE_MISMATCH");
assert.throws(() => scanExtensionPackage({ ...unsignedScript, files: { "content/main.js": "new Function('return 1')()" } }), error => error instanceof ExtensionSecurityError && error.code === "EXTENSION_DYNAMIC_CODE_UNSUPPORTED");

const signingPair = crypto.generateKeyPairSync("ed25519");
const unsignedBundle = {
  schema: "veyra-extension/v2", id: "signed-background", name: "Signed background", version: "1.0.0",
  description: "Background storage example", author: "Test publisher", publisher: "Publisher One",
  permissions: ["background", "storage"], matches: ["https://example.com/*"],
  files: { "background.js": "Veyra.storage.set('booted', true);" }, category: "developer", tags: [],
  privacyPolicy: "", dataDisclosure: "Stores one local flag.", networkDisclosure: ""
};
const signedBundle = signExtensionPackage(unsignedBundle, signingPair.privateKey, "publisher-key");
const trustedKey = signingPair.publicKey.export({ format: "pem", type: "spki" });
const verifiedBundle = scanExtensionPackage(signedBundle, { trustedSigningKeys: { "publisher-key": trustedKey } });
assert.equal(verifiedBundle.extension.signing.status, "verified");
assert.equal(verifiedBundle.scan.requiredChecks.includes("human code review required"), true);
assert.equal(verifiedBundle.extension.files["background.js"], signedBundle.files["background.js"]);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-extension-security-"));
const builtInFile = path.join(temp, "built-in.json");
fs.writeFileSync(builtInFile, JSON.stringify([fixture({ id: "catalog-theme", name: "Catalog theme" })]));
const store = new ExtensionStoreSecurity({ dataDir: path.join(temp, "data"), builtInStoreFile: builtInFile, trustedSigningKeys: { "publisher-key": trustedKey } });
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
const scriptPending = store.submit(signedBundle, publisher);
assert.equal(scriptPending.state, "REVIEW_REQUIRED");
assert.equal(scriptPending.package.verification.signing.status, "verified");
assert.throws(() => store.decide(scriptPending.id, "approve", admin, "looks good"), error => error.code === "EXTENSION_REVIEW_NOTE_REQUIRED");
store.decide(scriptPending.id, "approve", admin, "Reviewed signed source and permissions.");
const publishedScript = store.publish(scriptPending.id, admin);
assert.equal(publishedScript.verification.state, "PUBLISHED");
assert.equal(publishedScript.files["background.js"], signedBundle.files["background.js"]);
assert.equal(store.policy().archives, "not supported and rejected; this runtime never extracts untrusted archives");
assert.equal(store.auditEvents().some(event => event.type === "extension.published"), true);

fs.rmSync(temp, { recursive: true, force: true });
console.log("Extension security regression tests passed");
