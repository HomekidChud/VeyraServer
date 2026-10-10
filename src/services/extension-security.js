"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SCHEMA = "veyra-extension/v2";
const LEGACY_SCHEMA = "veyra-extension/v1";
const MAX_CSS_BYTES = 120 * 1024;
const MAX_EXECUTABLE_BYTES = 80 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
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
  "js", "script", "scripts", "content_scripts", "background", "service_worker", "web_accessible_resources", "externally_connectable", "host_permissions",
  "optional_permissions", "native_messaging", "nativeMessaging", "wasm", "binary"
]);
const EXECUTABLE_PERMISSIONS = new Set(["content_scripts", "background", "storage", "cookies", "network", "tabs"]);
const SCRIPT_FILE_RE = /^(?:background\.js|content\/[a-z0-9][a-z0-9._-]*\.js)$/i;
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

function normalizedMatchesCheck(value) {
  const matches = normalizeMatches(value);
  if (matches.some(pattern => pattern === "<all_urls>" || pattern === "*" || pattern.startsWith("*://") || !pattern.startsWith("https://") || pattern.slice(8).split("/")[0].includes("*"))) {
    throw new ExtensionSecurityError("EXTENSION_MATCH_REQUIRED", "Executable packages require explicit HTTPS hosts and cannot use wildcard site access.");
  }
  return matches;
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
    schema: packageData.schema,
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
  const schema = pkg.schema || LEGACY_SCHEMA;
  if (![SCHEMA, LEGACY_SCHEMA].includes(schema)) throw new ExtensionSecurityError("EXTENSION_SCHEMA_UNSUPPORTED", `Supported schemas are ${LEGACY_SCHEMA} and ${SCHEMA}.`);

  const id = boundedText(pkg.id, "id", 64, { required: true });
  if (!/^[a-z0-9][a-z0-9-_.]{1,63}$/i.test(id)) throw new ExtensionSecurityError("EXTENSION_INVALID_ID", "id must be 2–64 letters, numbers, dashes, underscores, or dots.");
  const name = boundedText(pkg.name, "name", 80, { required: true });
  const version = boundedText(pkg.version || "1.0.0", "version", 32, { required: true });
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/.test(version)) throw new ExtensionSecurityError("EXTENSION_INVALID_VERSION", "version has an unsupported format.");

  const permissions = pkg.permissions == null ? [] : pkg.permissions;
  if (!Array.isArray(permissions) || permissions.length > 8 || permissions.some(permission => String(permission) !== "styles" && !EXECUTABLE_PERMISSIONS.has(String(permission)))) {
    throw new ExtensionSecurityError("EXTENSION_PERMISSION_DENIED", "Supported capabilities: styles, content_scripts, background, storage, cookies, network, and tabs.");
  }
  const normalizedPermissions = [...new Set(permissions.map(String))];
  const executable = normalizedPermissions.some(permission => EXECUTABLE_PERMISSIONS.has(permission));
  if (executable && schema !== SCHEMA) throw new ExtensionSecurityError("EXTENSION_SCHEMA_UPGRADE_REQUIRED", `Executable packages must use ${SCHEMA}.`);
  if (normalizedPermissions.includes("network") && !normalizedPermissions.includes("content_scripts") && !normalizedPermissions.includes("background")) {
    throw new ExtensionSecurityError("EXTENSION_PERMISSION_DEPENDENCY", "network permission requires content_scripts or background.");
  }

  const files = pkg.files == null ? {} : plainObject(pkg.files, "files");
  const fileNames = Object.keys(files);
  const normalizedNames = new Set();
  let executableBytes = 0;
  const normalizedFiles = {};
  for (const nameOfFile of fileNames) {
    const normalizedName = String(nameOfFile).normalize("NFC");
    if (normalizedName !== "style.css" && !(schema === SCHEMA && SCRIPT_FILE_RE.test(normalizedName))) {
      throw new ExtensionSecurityError("EXTENSION_UNSUPPORTED_FILE", `Unsupported package file: ${nameOfFile}. Only style.css, background.js, and content/*.js are accepted.`);
    }
    if (normalizedNames.has(normalizedName)) throw new ExtensionSecurityError("EXTENSION_DUPLICATE_FILE", "Duplicate normalized package file name.");
    normalizedNames.add(normalizedName);
    if (typeof files[nameOfFile] !== "string") throw new ExtensionSecurityError("EXTENSION_INVALID_FILE_CONTENT", `${normalizedName} must be UTF-8 text.`);
    if (normalizedName === "style.css") normalizedFiles[normalizedName] = scanCss(files[nameOfFile]);
    else {
      const code = String(files[nameOfFile] ?? "");
      if (!code.trim()) throw new ExtensionSecurityError("EXTENSION_EMPTY_SCRIPT", `${normalizedName} must not be empty.`);
      const size = byteLength(code);
      if (size > MAX_FILE_BYTES) throw new ExtensionSecurityError("EXTENSION_FILE_TOO_LARGE", `${normalizedName} exceeds ${MAX_FILE_BYTES / 1024} KB.`);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(code)) throw new ExtensionSecurityError("EXTENSION_CONTROL_CHARACTER", `${normalizedName} contains unsupported control characters.`);
      executableBytes += size;
      normalizedFiles[normalizedName] = code;
    }
  }
  if (executableBytes > MAX_EXECUTABLE_BYTES) throw new ExtensionSecurityError("EXTENSION_PACKAGE_TOO_LARGE", `Executable files exceed ${MAX_EXECUTABLE_BYTES / 1024} KB total.`);
  if (pkg.css != null && files["style.css"] != null && String(pkg.css) !== String(files["style.css"])) {
    throw new ExtensionSecurityError("EXTENSION_AMBIGUOUS_CSS", "css and files.style.css must not disagree.");
  }
  if (pkg.css != null && files["style.css"] == null) normalizedFiles["style.css"] = scanCss(pkg.css);
  if (normalizedFiles["style.css"] && !normalizedPermissions.includes("styles")) normalizedPermissions.push("styles");
  const hasBackground = Object.hasOwn(normalizedFiles, "background.js");
  const hasContent = Object.keys(normalizedFiles).some(file => file.startsWith("content/"));
  if (hasBackground !== normalizedPermissions.includes("background")) throw new ExtensionSecurityError("EXTENSION_PERMISSION_FILE_MISMATCH", "background.js requires the background permission, and that permission requires background.js.");
  if (hasContent !== normalizedPermissions.includes("content_scripts")) throw new ExtensionSecurityError("EXTENSION_PERMISSION_FILE_MISMATCH", "content/*.js files require the content_scripts permission, and that permission requires at least one content script.");
  if (hasBackground && !hasContent && (normalizedPermissions.includes("network") || normalizedPermissions.includes("cookies"))) throw new ExtensionSecurityError("EXTENSION_PERMISSION_UNAVAILABLE", "The isolated background runtime does not expose network or cookie APIs; those disclosures only apply to content scripts.");
  const sourceCode = Object.entries(normalizedFiles).filter(([file]) => file.endsWith(".js")).map(([, code]) => code).join("\n");
  if (/\beval\s*\(|\bnew\s+Function\s*\(|\b(?:Worker|SharedWorker|importScripts)\s*\(|\bimport\s*(?:\(|["'])/.test(sourceCode)) {
    throw new ExtensionSecurityError("EXTENSION_DYNAMIC_CODE_UNSUPPORTED", "Store bundles may not evaluate dynamic code, create workers, or import remote/bundled JavaScript at runtime.");
  }
  if (/\bcreateElement\s*\(\s*["']script["']\s*\)|\b(?:script|scriptEl|scriptElement)\s*\.\s*src\s*=|\bdocument\s*\.\s*write\s*\(/i.test(sourceCode)) {
    throw new ExtensionSecurityError("EXTENSION_REMOTE_SCRIPT_LOADING_UNSUPPORTED", "Store bundles may not inject script elements, load external script URLs, or use document.write.");
  }
  if (hasBackground && /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|Worker|SharedWorker)\b/i.test(normalizedFiles["background.js"])) {
    throw new ExtensionSecurityError("EXTENSION_BACKGROUND_API_UNSUPPORTED", "Background scripts run in a network-disabled opaque-origin sandbox; use Veyra.storage APIs only in background.js.");
  }
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/i.test(sourceCode) && !normalizedPermissions.includes("network")) throw new ExtensionSecurityError("EXTENSION_PERMISSION_REQUIRED", "Code with detectable network APIs must declare the network permission.");
  if (/\bdocument\s*(?:\.\s*cookie|\[\s*["']cookie)|\bcookieStore\b/i.test(sourceCode) && !normalizedPermissions.includes("cookies")) throw new ExtensionSecurityError("EXTENSION_PERMISSION_REQUIRED", "Code with detectable cookie access must declare the cookies permission.");
  if (/\b(?:localStorage|sessionStorage|indexedDB)\b/i.test(sourceCode) && !normalizedPermissions.includes("storage")) throw new ExtensionSecurityError("EXTENSION_PERMISSION_REQUIRED", "Code with detectable browser storage access must declare the storage permission.");
  if (!normalizedFiles["style.css"] && !executable) throw new ExtensionSecurityError("EXTENSION_EMPTY_CSS", "A stylesheet or executable capability is required.");
  if (executable && normalizedMatchesCheck(pkg.matches).length === 0) throw new ExtensionSecurityError("EXTENSION_MATCH_REQUIRED", "Executable packages must declare at least one specific https:// site match; wildcard and all-site access are not allowed.");
  const output = {
    schema,
    id,
    name,
    version,
    description: boundedText(pkg.description, "description", 300),
    author: boundedText(pkg.author, "author", 100),
    publisher: boundedText(pkg.publisher, "publisher", 100),
    permissions: normalizedPermissions.sort(),
    matches: normalizeMatches(pkg.matches),
    files: normalizedFiles,
    category: boundedText(pkg.category || "other", "category", 32).toLowerCase() || "other",
    tags: normalizeTags(pkg.tags),
    privacyPolicy: boundedText(pkg.privacyPolicy, "privacyPolicy", 500),
    dataDisclosure: boundedText(pkg.dataDisclosure, "dataDisclosure", 300),
    networkDisclosure: boundedText(pkg.networkDisclosure, "networkDisclosure", 300)
  };
  const canonical = stableJson(canonicalPackage(output));
  output.integrity = { algorithm: "sha256", value: sha256(canonical), canonicalBytes: byteLength(canonical) };
  output.signing = verifySignature(pkg.signature, canonical, options);
  if ((options.requireSignature || executable) && !options.allowUnsignedExecutable && output.signing.status !== "verified") {
    throw new ExtensionSecurityError("EXTENSION_SIGNATURE_REQUIRED", "This store requires an Ed25519 signature from a configured trusted publisher key.");
  }
  return output;
}

function signExtensionPackage(input, privateKey, keyId) {
  if (!privateKey) throw new ExtensionSecurityError("EXTENSION_SIGNING_KEY_REQUIRED", "A publisher Ed25519 private key is required.");
  const normalized = validateExtensionPackage(input, { allowUnsignedExecutable: true });
  const canonical = canonicalPackage(normalized);
  return {
    ...canonical,
    signature: {
      algorithm: "ed25519",
      keyId: boundedText(keyId, "signature.keyId", 120, { required: true }),
      value: crypto.sign(null, Buffer.from(stableJson(canonical)), privateKey).toString("base64")
    }
  };
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
  const executableFiles = Object.entries(extension.files).filter(([name]) => name.endsWith(".js"));
  const findings = [];
  for (const [file, source] of executableFiles) {
    const checks = [
      ["NETWORK_ACCESS", /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/i],
      ["PAGE_DATA_ACCESS", /\b(?:document\.cookie|localStorage|sessionStorage|indexedDB)\b/i],
      ["DYNAMIC_CODE", /\b(?:eval|Function)\s*\(|\bimport\s*\(/i],
      ["OBFUSCATION_HINT", /\batob\s*\(|String\.fromCharCode|\[['"]constructor['"]\]/i]
    ];
    for (const [code, pattern] of checks) if (pattern.test(source)) findings.push({ severity: "REVIEW", code, file, message: `Manual reviewer attention required: ${code.toLowerCase().replaceAll("_", " ")} pattern detected in ${file}.` });
  }
  return {
    extension,
    scan: {
      verdict: "PASS",
      completedAt: new Date().toISOString(),
      engine: "veyra-extension-static-v2",
      scope: executableFiles.length ? "manifest, permission and source-pattern checks only; not malware detection, sandboxing, or proof of benign behavior" : "manifest and CSS static validation",
      findings,
      requiredChecks: ["manifest", "permission declaration", "virtual-file allowlist", "site scope", "SHA-256 integrity", ...(executableFiles.length ? ["trusted Ed25519 signature", "human code review required"] : [])],
      limitations: ["A valid signature proves package integrity and signer-key control, not that code is safe.", "Static pattern checks are heuristic and can miss obfuscated or novel malicious behavior.", "Executable content may access page data and can perform network actions when granted; review every source file and permission before approval."]
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
      const submissionPackage = plainObject(input, "Extension package");
      const normalizedInput = { ...submissionPackage, publisher: submissionPackage.publisher || record.submitter.name };
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
      if (Object.keys(record.package?.files || {}).some(file => file.endsWith(".js")) && reviewerNote.trim().length < 20) {
        throw new ExtensionSecurityError("EXTENSION_REVIEW_NOTE_REQUIRED", "Executable packages require a reviewer note (at least 20 characters) confirming source and permission review.");
      }
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
      executableContent: "veyra-extension/v2 supports signed content/*.js and background.js packages; every release requires separate human review and explicit installation consent",
      permissions: ["styles", ...EXECUTABLE_PERMISSIONS],
      limits: { cssBytes: MAX_CSS_BYTES, executableFileBytes: MAX_FILE_BYTES, executablePackageBytes: MAX_EXECUTABLE_BYTES, matches: MAX_MATCHES, tags: MAX_TAGS },
      states: ["UPLOADED", "VALIDATING", "QUARANTINED", "SCANNING", "REVIEW_REQUIRED", "REJECTED", "APPROVED", "PUBLISHED"],
      signing: { required: this.requireSignature, supportedAlgorithm: "ed25519", configuredTrustedKeys: Object.keys(this.trustedSigningKeys).length },
      dynamicAnalysis: "not available; static findings are heuristic and are not malware detection",
      executablePackageRequirements: ["Ed25519 signature from a configured trusted key", "HTTPS site matches only; wildcard hosts and all-site scope prohibited", "separate human review", "explicit per-install permission consent"]
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
  signExtensionPackage,
  stableJson,
  validateExtensionPackage
};
