"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SCHEMA = "veyra-extension/v1";
const MAX_CSS_BYTES = 120 * 1024;
const MAX_MATCHES = 30;
const MAX_TAGS = 12;
const MAX_RECORDS = 5000;
const PACKAGE_FIELDS = new Set([
  "schema", "id", "name", "version", "description", "author", "publisher",
  "permissions", "matches", "files", "css", "category", "tags", "updated",
  "privacyPolicy", "dataDisclosure", "networkDisclosure", "signature", "published",
  "verified", "rating", "installs"
]);
const FORBIDDEN_CAPABILITIES = new Set([
  "js", "script", "scripts", "content_scripts", "background", "service_worker",
  "web_accessible_resources", "externally_connectable", "host_permissions",
  "optional_permissions", "native_messaging", "nativeMessaging", "wasm", "binary"
]);
const TERMINAL_STATES = new Set(["REJECTED", "PUBLISHED"]);

class ExtensionSecurityError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ExtensionSecurityError";
    this.code = code;
    this.status = status;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function plainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExtensionSecurityError("EXTENSION_INVALID_OBJECT", `${field} must be an object.`);
  }
  return value;
}

function boundedText(value, field, maximum, { required = false } = {}) {
  const text = String(value ?? "").normalize("NFKC").trim();
  if (required && !text) throw new ExtensionSecurityError("EXTENSION_REQUIRED_FIELD", `${field} is required.`);
  if (text.length > maximum) throw new ExtensionSecurityError("EXTENSION_FIELD_TOO_LONG", `${field} exceeds the ${maximum}-character limit.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new ExtensionSecurityError("EXTENSION_CONTROL_CHARACTER", `${field} contains an unsupported control character.`);
  return text;
}

function normalizeMatches(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new ExtensionSecurityError("EXTENSION_INVALID_MATCHES", "matches must be an array.");
  if (value.length > MAX_MATCHES) throw new ExtensionSecurityError("EXTENSION_TOO_MANY_MATCHES", `An extension can target at most ${MAX_MATCHES} website patterns.`);
  const seen = new Set();
  const normalized = [];
  for (const raw of value) {
    const pattern = boundedText(raw, "match pattern", 120, { required: true }).toLowerCase();
    if (!/^(?:<all_urls>|\*|(?:(?:\*|https?):\/\/)?(?:\*|(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?:\/[^\s]*)?)$/i.test(pattern)) {
      throw new ExtensionSecurityError("EXTENSION_INVALID_MATCH", `Unsupported website pattern: ${pattern}`);
    }
    if (pattern.includes("..") || pattern.includes("\\") || /%2f|%5c/i.test(pattern)) {
      throw new ExtensionSecurityError("EXTENSION_INVALID_MATCH", "Website patterns may not contain traversal or encoded path separators.");
    }
    if (!seen.has(pattern)) {
      seen.add(pattern);
      normalized.push(pattern);
    }
  }
  return normalized;
}

function normalizeTags(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_TAGS) throw new ExtensionSecurityError("EXTENSION_INVALID_TAGS", `tags must contain at most ${MAX_TAGS} labels.`);
  const seen = new Set();
  return value.map(tag => boundedText(tag, "tag", 32, { required: true }).toLowerCase())
    .filter(tag => {
      if (seen.has(tag)) return false;
      seen.add(tag);
      return true;
    });
}

function scanCss(css) {
  const source = String(css || "");
  if (!source.trim()) throw new ExtensionSecurityError("EXTENSION_EMPTY_CSS", "style.css is required.");
  if (byteLength(source) > MAX_CSS_BYTES) throw new ExtensionSecurityError("EXTENSION_CSS_TOO_LARGE", `style.css exceeds the ${MAX_CSS_BYTES / 1024} KB limit.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source)) throw new ExtensionSecurityError("EXTENSION_CONTROL_CHARACTER", "style.css contains unsupported control characters.");

  const normalized = source.normalize("NFC");
  const forbidden = /@\s*(?:import|font-face|namespace)\b|(?:^|[^\w-])url\s*\(|(?:^|[^\w-])expression\s*\(|(?:^|[^\w-])-moz-binding\s*:|(?:^|[^\w-])behavior\s*:|javascript\s*:/i;
  if (forbidden.test(normalized)) {
    throw new ExtensionSecurityError("EXTENSION_CSS_REMOTE_OR_EXECUTABLE", "style.css may not import, fetch, execute code, or load remote resources.");
  }

  let depth = 0;
  let quote = "";
  let comment = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (comment) {
      if (char === "*" && next === "/") { comment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (char === "\\") { index += 1; continue; }
      if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "*") { comment = true; index += 1; continue; }
    if (char === "\"" || char === "'") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth < 0) throw new ExtensionSecurityError("EXTENSION_CSS_SYNTAX", "style.css has unbalanced braces.");
    }
  }
  if (comment || quote || depth !== 0) throw new ExtensionSecurityError("EXTENSION_CSS_SYNTAX", "style.css has unbalanced quotes, comments, or braces.");
  return normalized;
}

function canonicalPackage(packageData) {
  return {
    schema: SCHEMA,
    id: packageData.id,
    name: packageData.name,
    version: packageData.version,
    description: packageData.description,
    author: packageData.author,
    publisher: packageData.publisher,
    permissions: packageData.permissions,
    matches: packageData.matches,
    files: packageData.files,
    category: packageData.category,
    tags: packageData.tags,
    privacyPolicy: packageData.privacyPolicy,
    dataDisclosure: packageData.dataDisclosure,
    networkDisclosure: packageData.networkDisclosure
  };
}

function validateExtensionPackage(input, options = {}) {
  const pkg = plainObject(input, "Extension package");
  for (const field of FORBIDDEN_CAPABILITIES) {
    if (Object.prototype.hasOwnProperty.call(pkg, field)) {
      throw new ExtensionSecurityError("EXTENSION_UNSUPPORTED_CAPABILITY", `Unsupported extension capability: ${field}.`);
    }
  }
  const extra = Object.keys(pkg).filter(key => !PACKAGE_FIELDS.has(key));
  if (extra.length) throw new ExtensionSecurityError("EXTENSION_UNKNOWN_FIELD", `Unsupported manifest field: ${extra[0]}.`);
  if (pkg.schema != null && pkg.schema !== SCHEMA) throw new ExtensionSecurityError("EXTENSION_SCHEMA_UNSUPPORTED", `Only ${SCHEMA} packages are supported.`);

  const id = boundedText(pkg.id, "id", 64, { required: true });
  if (!/^[a-z0-9][a-z0-9-_.]{1,63}$/i.test(id)) throw new ExtensionSecurityError("EXTENSION_INVALID_ID", "id must be 2–64 letters, numbers, dashes, underscores, or dots.");
  const name = boundedText(pkg.name, "name", 80, { required: true });
  const version = boundedText(pkg.version || "1.0.0", "version", 32, { required: true });
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/.test(version)) throw new ExtensionSecurityError("EXTENSION_INVALID_VERSION", "version has an unsupported format.");

  const permissions = pkg.permissions == null ? [] : pkg.permissions;
  if (!Array.isArray(permissions) || permissions.some(permission => String(permission) !== "styles")) {
    throw new ExtensionSecurityError("EXTENSION_PERMISSION_DENIED", "Only the styles capability is supported by this Veyra runtime.");
  }
  if (permissions.length > 1) throw new ExtensionSecurityError("EXTENSION_INVALID_PERMISSIONS", "The styles capability may be declared once at most.");

  const files = pkg.files == null ? {} : plainObject(pkg.files, "files");
  const fileNames = Object.keys(files);
  const normalizedNames = new Set();
  for (const nameOfFile of fileNames) {
    const normalizedName = String(nameOfFile).normalize("NFC");
    if (normalizedName !== "style.css") throw new ExtensionSecurityError("EXTENSION_UNSUPPORTED_FILE", `Unsupported package file: ${nameOfFile}. Only style.css is accepted.`);
    if (normalizedNames.has(normalizedName)) throw new ExtensionSecurityError("EXTENSION_DUPLICATE_FILE", "Duplicate normalized package file name.");
    normalizedNames.add(normalizedName);
  }
  if (pkg.css != null && files["style.css"] != null && String(pkg.css) !== String(files["style.css"])) {
    throw new ExtensionSecurityError("EXTENSION_AMBIGUOUS_CSS", "css and files.style.css must not disagree.");
  }
  const css = scanCss(pkg.css ?? files["style.css"] ?? "");
  const output = {
    schema: SCHEMA,
    id,
    name,
    version,
    description: boundedText(pkg.description, "description", 300),
    author: boundedText(pkg.author, "author", 100),
    publisher: boundedText(pkg.publisher, "publisher", 100),
    permissions: permissions.length ? ["styles"] : [],
    matches: normalizeMatches(pkg.matches),
    files: { "style.css": css },
    category: boundedText(pkg.category || "other", "category", 32).toLowerCase() || "other",
    tags: normalizeTags(pkg.tags),
    privacyPolicy: boundedText(pkg.privacyPolicy, "privacyPolicy", 500),
    dataDisclosure: boundedText(pkg.dataDisclosure, "dataDisclosure", 300),
    networkDisclosure: boundedText(pkg.networkDisclosure, "networkDisclosure", 300)
  };
  const canonical = stableJson(canonicalPackage(output));
  output.integrity = { algorithm: "sha256", value: sha256(canonical), canonicalBytes: byteLength(canonical) };
  output.signing = verifySignature(pkg.signature, canonical, options);
  if (options.requireSignature && output.signing.status !== "verified") {
    throw new ExtensionSecurityError("EXTENSION_SIGNATURE_REQUIRED", "This store requires an Ed25519 signature from a configured trusted publisher key.");
  }
  return output;
}

function verifySignature(signature, canonical, options = {}) {
  if (signature == null) return { status: "not-provided", algorithm: null, keyId: null };
  const raw = plainObject(signature, "signature");
  const algorithm = String(raw.algorithm || "").toLowerCase();
  const keyId = boundedText(raw.keyId, "signature.keyId", 120, { required: true });
  const value = boundedText(raw.value, "signature.value", 12000, { required: true });
  if (algorithm !== "ed25519") throw new ExtensionSecurityError("EXTENSION_SIGNATURE_ALGORITHM", "Only Ed25519 signatures are supported.");
  const keys = options.trustedSigningKeys && typeof options.trustedSigningKeys === "object" ? options.trustedSigningKeys : {};
  const publicKey = keys[keyId];
  if (!publicKey) return { status: "untrusted-key", algorithm, keyId };
  let valid = false;
  try { valid = crypto.verify(null, Buffer.from(canonical), publicKey, Buffer.from(value, "base64")); } catch { valid = false; }
  if (!valid) throw new ExtensionSecurityError("EXTENSION_SIGNATURE_INVALID", "The package signature does not match this exact manifest and stylesheet.");
  return { status: "verified", algorithm, keyId };
}

function scanExtensionPackage(input, options = {}) {
  const extension = validateExtensionPackage(input, options);
  return {
    extension,
    scan: {
      verdict: "PASS",
      completedAt: new Date().toISOString(),
      engine: "veyra-css-static-v1",
      scope: "manifest and CSS static validation; no executable content is accepted or run",
      findings: [],
      requiredChecks: ["manifest", "permissions", "virtual-file allowlist", "CSS isolation", "SHA-256 integrity"],
      limitations: ["No archive, binary, JavaScript, WebAssembly, background worker, or remote resource is supported by this runtime.", "A PASS means the CSS-only policy completed; it is not a claim that arbitrary third-party code is safe."]
    }
  };
}

function safePublicRecord(record) {
  const clone = JSON.parse(JSON.stringify(record));
  delete clone.submitter;
  return clone;
}

class ExtensionStoreSecurity {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(process.cwd(), "data", "extensions");
    this.builtInStoreFile = options.builtInStoreFile || "";
    this.requireSignature = options.requireSignature === true;
    this.trustedSigningKeys = options.trustedSigningKeys || {};
    this.log = options.log || (() => {});
    this.now = options.now || (() => new Date().toISOString());
    this.uploadsPath = path.join(this.dataDir, "quarantined-uploads.json");
    this.publishedPath = path.join(this.dataDir, "published-releases.json");
    this.auditPath = path.join(this.dataDir, "audit-events.json");
    this.uploads = new Map();
    this.published = new Map();
    this.audit = [];
    this._load();
  }

  _loadJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
  }

  _load() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    for (const record of this._loadJson(this.uploadsPath, [])) if (record?.id) this.uploads.set(record.id, record);
    for (const record of this._loadJson(this.publishedPath, [])) if (record?.releaseId) this.published.set(record.releaseId, record);
    this.audit = this._loadJson(this.auditPath, []).filter(event => event && event.id).slice(-MAX_RECORDS);
  }

  _write(file, value) {
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  _persist() {
    this._write(this.uploadsPath, [...this.uploads.values()].slice(-MAX_RECORDS));
    this._write(this.publishedPath, [...this.published.values()].slice(-MAX_RECORDS));
    this._write(this.auditPath, this.audit.slice(-MAX_RECORDS));
  }

  _event(type, actor, targetId, detail = {}) {
    const event = {
      id: crypto.randomUUID(),
      at: this.now(),
      type,
      actor: actor ? { id: String(actor.id || ""), role: String(actor.role || "") } : null,
      targetId,
      detail
    };
    this.audit.push(event);
    if (this.audit.length > MAX_RECORDS) this.audit.splice(0, this.audit.length - MAX_RECORDS);
    return event;
  }

  _transition(record, state, actor, detail = {}) {
    if (TERMINAL_STATES.has(record.state)) throw new ExtensionSecurityError("EXTENSION_STATE_TERMINAL", `This upload is already ${record.state}.`, 409);
    record.state = state;
    record.updatedAt = this.now();
    record.history.push({ at: record.updatedAt, state, actor: actor ? { id: String(actor.id || ""), role: String(actor.role || "") } : null, detail });
    this._event(`extension.${state.toLowerCase()}`, actor, record.id, detail);
  }

  _builtIns() {
    const raw = this._loadJson(this.builtInStoreFile, []);
    const output = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      try {
        const { extension, scan } = scanExtensionPackage(item, { trustedSigningKeys: this.trustedSigningKeys, requireSignature: false });
        output.push({
          ...extension,
          source: "built-in-catalog",
          publisherStatus: "catalog-maintained",
          verification: { integrity: extension.integrity, signing: extension.signing, scan, state: "PUBLISHED" },
          updated: boundedText(item.updated, "updated", 32) || null
        });
      } catch (error) {
        this.log("warn", "STORE", `Rejected invalid built-in extension ${String(item?.id || "unknown")}: ${error.message}`);
      }
    }
    return output;
  }

  listPublished() {
    const builtIns = this._builtIns();
    const dynamic = [...this.published.values()].filter(release => release.state === "PUBLISHED").map(release => release.package);
    const byId = new Map();
    for (const extension of [...builtIns, ...dynamic]) byId.set(extension.id, extension);
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  submit(input, submitter) {
    if (!submitter?.id) throw new ExtensionSecurityError("EXTENSION_AUTH_REQUIRED", "Sign in before submitting an extension.", 401);
    const record = {
      id: crypto.randomUUID(),
      state: "UPLOADED",
      createdAt: this.now(),
      updatedAt: this.now(),
      submitter: { id: String(submitter.id), name: boundedText(submitter.name || "Publisher", "publisher", 100), email: boundedText(submitter.email || "", "email", 190) },
      package: null,
      scan: null,
      review: null,
      history: [{ at: this.now(), state: "UPLOADED", actor: { id: String(submitter.id), role: "publisher" }, detail: { transport: "json-only" } }]
    };
    this.uploads.set(record.id, record);
    this._event("extension.uploaded", { id: submitter.id, role: "publisher" }, record.id, { transport: "json-only" });
    try {
      this._transition(record, "VALIDATING", { id: submitter.id, role: "publisher" });
      const normalizedInput = { ...plainObject(input, "Extension package"), publisher: record.submitter.name };
      const { extension, scan } = scanExtensionPackage(normalizedInput, {
        trustedSigningKeys: this.trustedSigningKeys,
        requireSignature: this.requireSignature
      });
      record.package = {
        ...extension,
        source: "publisher-submission",
        publisherStatus: extension.signing.status === "verified" ? "signing-key-verified" : "unverified-publisher",
        verification: { integrity: extension.integrity, signing: extension.signing, scan, state: "REVIEW_REQUIRED" }
      };
      record.scan = scan;
      this._transition(record, "QUARANTINED", { id: "security-pipeline", role: "system" }, { integrity: extension.integrity.value });
      this._transition(record, "SCANNING", { id: "security-pipeline", role: "system" }, { engine: scan.engine });
      this._transition(record, "REVIEW_REQUIRED", { id: "security-pipeline", role: "system" }, { verdict: scan.verdict });
      this._persist();
      return safePublicRecord(record);
    } catch (error) {
      record.scan = {
        verdict: "REJECTED",
        completedAt: this.now(),
        engine: "veyra-css-static-v1",
        findings: [{ severity: "BLOCKING", code: error.code || "EXTENSION_VALIDATION_FAILED", message: error.message }]
      };
      this._transition(record, "REJECTED", { id: "security-pipeline", role: "system" }, { code: error.code || "EXTENSION_VALIDATION_FAILED" });
      this._persist();
      return { ...safePublicRecord(record), error: { code: error.code || "EXTENSION_VALIDATION_FAILED", message: error.message } };
    }
  }

  listMine(userId) {
    return [...this.uploads.values()].filter(record => record.submitter?.id === String(userId)).map(safePublicRecord).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listForReview() {
    return [...this.uploads.values()].map(record => ({
      ...safePublicRecord(record),
      submitter: { id: record.submitter.id, name: record.submitter.name },
      auditEvents: this.audit.filter(event => event.targetId === record.id).slice(-20)
    })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  decide(id, decision, reviewer, note = "") {
    const record = this.uploads.get(String(id));
    if (!record) throw new ExtensionSecurityError("EXTENSION_UPLOAD_NOT_FOUND", "Extension upload not found.", 404);
    if (!reviewer?.id || reviewer.role !== "admin") throw new ExtensionSecurityError("EXTENSION_REVIEW_FORBIDDEN", "Security reviewer authorization is required.", 403);
    if (record.submitter?.id === String(reviewer.id)) throw new ExtensionSecurityError("EXTENSION_SELF_REVIEW_FORBIDDEN", "A publisher cannot review their own submission.", 403);
    if (record.state !== "REVIEW_REQUIRED") throw new ExtensionSecurityError("EXTENSION_REVIEW_STATE", "Only a completed scan awaiting review can be decided.", 409);
    const normalizedDecision = String(decision || "").toLowerCase();
    const reviewerNote = boundedText(note, "review note", 1000);
    if (normalizedDecision === "approve") {
      this._transition(record, "APPROVED", reviewer, { note: reviewerNote, verdict: record.scan?.verdict || "INCOMPLETE" });
      record.review = { decision: "approved", reviewer: { id: String(reviewer.id), name: boundedText(reviewer.name || "Security reviewer", "reviewer", 100) }, note: reviewerNote, at: this.now() };
    } else if (normalizedDecision === "reject") {
      this._transition(record, "REJECTED", reviewer, { note: reviewerNote });
      record.review = { decision: "rejected", reviewer: { id: String(reviewer.id), name: boundedText(reviewer.name || "Security reviewer", "reviewer", 100) }, note: reviewerNote, at: this.now() };
    } else {
      throw new ExtensionSecurityError("EXTENSION_REVIEW_DECISION", "Review decision must be approve or reject.");
    }
    this._persist();
    return safePublicRecord(record);
  }

  publish(id, reviewer) {
    const record = this.uploads.get(String(id));
    if (!record) throw new ExtensionSecurityError("EXTENSION_UPLOAD_NOT_FOUND", "Extension upload not found.", 404);
    if (!reviewer?.id || reviewer.role !== "admin") throw new ExtensionSecurityError("EXTENSION_PUBLISH_FORBIDDEN", "Store administrator authorization is required.", 403);
    if (record.state !== "APPROVED") throw new ExtensionSecurityError("EXTENSION_PUBLISH_STATE", "Only an approved extension can be published.", 409);
    if (record.scan?.verdict !== "PASS") throw new ExtensionSecurityError("EXTENSION_PUBLISH_SCAN", "A completed PASS scan is required before publication.", 409);
    const duplicate = [...this.published.values()].find(release => release.package?.id === record.package.id && release.package?.version === record.package.version);
    if (duplicate) throw new ExtensionSecurityError("EXTENSION_VERSION_EXISTS", "That extension version is already published.", 409);
    const release = {
      releaseId: crypto.randomUUID(),
      state: "PUBLISHED",
      publishedAt: this.now(),
      uploadId: record.id,
      publisherId: record.submitter.id,
      package: {
        ...record.package,
        verification: { ...record.package.verification, state: "PUBLISHED", publishedAt: this.now(), reviewer: { id: String(reviewer.id), name: boundedText(reviewer.name || "Store administrator", "reviewer", 100) } }
      }
    };
    this.published.set(release.releaseId, release);
    this._transition(record, "PUBLISHED", reviewer, { releaseId: release.releaseId, integrity: record.package.integrity.value });
    this._persist();
    return release.package;
  }

  verify(input) {
    const { extension, scan } = scanExtensionPackage(input, { trustedSigningKeys: this.trustedSigningKeys, requireSignature: false });
    return {
      ...extension,
      source: "local-validation",
      publisherStatus: extension.signing.status === "verified" ? "signing-key-verified" : "local-unverified",
      verification: { integrity: extension.integrity, signing: extension.signing, scan, state: "LOCAL_ONLY" }
    };
  }

  policy() {
    return {
      schema: SCHEMA,
      acceptedTransport: "application/json",
      archives: "not supported and rejected; this runtime never extracts untrusted archives",
      executableContent: "not supported",
      permissions: ["styles"],
      limits: { cssBytes: MAX_CSS_BYTES, matches: MAX_MATCHES, tags: MAX_TAGS },
      states: ["UPLOADED", "VALIDATING", "QUARANTINED", "SCANNING", "REVIEW_REQUIRED", "REJECTED", "APPROVED", "PUBLISHED"],
      signing: { required: this.requireSignature, supportedAlgorithm: "ed25519", configuredTrustedKeys: Object.keys(this.trustedSigningKeys).length },
      dynamicAnalysis: "not available; no package executable content is accepted or run"
    };
  }

  auditEvents(limit = 200) {
    return this.audit.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)));
  }
}

module.exports = {
  ExtensionSecurityError,
  ExtensionStoreSecurity,
  SCHEMA,
  MAX_CSS_BYTES,
  scanCss,
  scanExtensionPackage,
  stableJson,
  validateExtensionPackage
};
