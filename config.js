"use strict";
// Veyra configuration system.
//
// Precedence (highest wins):
//   1. Real environment variables (Render dashboard / shell)
//   2. veyra.config.json  -> environments[<VEYRA_ENV|NODE_ENV>].env
//   3. veyra.config.json  -> env
//   4. Plan preset (derived from the Render instance type)
//
// Pick the plan with VEYRA_PLAN / RENDER_PLAN, or "plan" in veyra.config.json.
// "auto" detects RAM + CPU from cgroups (what Render actually gives the
// container) and picks the closest Render instance type.
//
// CLI (run `node config.js help`):
//   node config.js plans                list Render plans and derived limits
//   node config.js show                 effective config for this machine
//   node config.js plan standard        switch plan (updates veyra.config.json + render.yaml)
//   node config.js set KEY=VALUE        set an env default in veyra.config.json
//   node config.js unset KEY            remove it
//   node config.js validate             validate veyra.config.json

const fs = require("fs");
const os = require("os");
const path = require("path");

const CONFIG_PATH = process.env.VEYRA_CONFIG_PATH || path.join(__dirname, "veyra.config.json");
const RENDER_YAML_PATH = path.join(__dirname, "render.yaml");

// Render web service instance types (render.com/docs/compute-plans).
// "renderYaml" is the value written to render.yaml's `plan:` field.
const RENDER_PLANS = {
  free:        { label: "Free",        ramMb: 512,   cpu: 0.1, renderYaml: "free" },
  starter:     { label: "Starter",     ramMb: 512,   cpu: 0.5, renderYaml: "starter",   aliases: ["0.5c-512mb"] },
  standard:    { label: "Standard",    ramMb: 2048,  cpu: 1,   renderYaml: "standard",  aliases: ["1c-2g"] },
  pro:         { label: "Pro",         ramMb: 4096,  cpu: 2,   renderYaml: "pro",       aliases: ["2c-4g"] },
  "2c-8g":     { label: "2 CPU / 8 GB",  ramMb: 8192,  cpu: 2, renderYaml: "2c-8g" },
  "2c-16g":    { label: "2 CPU / 16 GB", ramMb: 16384, cpu: 2, renderYaml: "2c-16g" },
  pro_plus:    { label: "Pro Plus",    ramMb: 8192,  cpu: 4,   renderYaml: "pro plus",  aliases: ["4c-8g", "pro-plus", "proplus"] },
  pro_max:     { label: "Pro Max",     ramMb: 16384, cpu: 4,   renderYaml: "pro max",   aliases: ["4c-16g", "pro-max", "promax"] },
  "4c-32g":    { label: "4 CPU / 32 GB", ramMb: 32768, cpu: 4, renderYaml: "4c-32g" },
  "8c-16g":    { label: "8 CPU / 16 GB", ramMb: 16384, cpu: 8, renderYaml: "8c-16g" },
  pro_ultra:   { label: "Pro Ultra",   ramMb: 32768, cpu: 8,   renderYaml: "pro ultra", aliases: ["8c-32g", "pro-ultra", "proultra"] },
  "8c-64g":    { label: "8 CPU / 64 GB", ramMb: 65536, cpu: 8, renderYaml: "8c-64g" },
  "12c-24g":   { label: "12 CPU / 24 GB", ramMb: 24576, cpu: 12, renderYaml: "12c-24g" },
  "12c-48g":   { label: "12 CPU / 48 GB", ramMb: 49152, cpu: 12, renderYaml: "12c-48g" },
  "12c-96g":   { label: "12 CPU / 96 GB", ramMb: 98304, cpu: 12, renderYaml: "12c-96g" }
};

// Legacy resource profiles (kept so RESOURCE_PROFILE=free|balanced|high still works).
const LEGACY_CAPS = {
  free: {
    maxActiveFetches: 10, browserMaxActiveFetches: 4, browserSessions: 1, browserPages: 1, browserContexts: 1,
    maxPendingQueue: 600, maxPages: 2500, maxResources: 6000, maxLinks: 30000, maxCacheEntries: 50,
    maxIndexDocs: 5000, maxCrossOriginResources: 250, sitemapConcurrency: 2, maxSitemapFiles: 20,
    proxyWarmConcurrency: 4, proxyWarmRobots: 16, browserCrawlerConcurrency: 3,
    maxTextBytesPerResource: 1024 * 1024, maxImageBytes: 6 * 1024 * 1024, maxMediaBytes: 8 * 1024 * 1024,
    maxActiveJobs: 1, parseWorkers: 0, maxProxySessions: 150, sessionIdleMs: 10 * 60 * 1000
  },
  balanced: {
    maxActiveFetches: 32, browserMaxActiveFetches: 12, browserSessions: 2, browserPages: 4, browserContexts: 4,
    maxPendingQueue: 1200, maxPages: 10000, maxResources: 20000, maxLinks: 100000, maxCacheEntries: 150,
    maxIndexDocs: 20000, maxCrossOriginResources: 500, sitemapConcurrency: 4, maxSitemapFiles: 50,
    proxyWarmConcurrency: 8, proxyWarmRobots: 32, browserCrawlerConcurrency: 8,
    maxTextBytesPerResource: 2 * 1024 * 1024, maxImageBytes: 12 * 1024 * 1024, maxMediaBytes: 24 * 1024 * 1024,
    maxActiveJobs: 3, parseWorkers: 1, maxProxySessions: 400, sessionIdleMs: 30 * 60 * 1000
  },
  high: {
    maxActiveFetches: 128, browserMaxActiveFetches: 24, browserSessions: 4, browserPages: 8, browserContexts: 4,
    maxPendingQueue: 3000, maxPages: 25000, maxResources: 50000, maxLinks: 250000, maxCacheEntries: 500,
    maxIndexDocs: 50000, maxCrossOriginResources: 1000, sitemapConcurrency: 8, maxSitemapFiles: 100,
    proxyWarmConcurrency: 12, proxyWarmRobots: 64, browserCrawlerConcurrency: 16,
    maxTextBytesPerResource: 2 * 1024 * 1024, maxImageBytes: 16 * 1024 * 1024, maxMediaBytes: 32 * 1024 * 1024,
    maxActiveJobs: 6, parseWorkers: 2, maxProxySessions: 1000, sessionIdleMs: 30 * 60 * 1000
  }
};
const CAP_KEYS = Object.keys(LEGACY_CAPS.free);
// Hard ceilings matching the numberEnv() max values in server.js.
const CAP_CEILINGS = {
  maxActiveFetches: 256, browserMaxActiveFetches: 64, browserSessions: 16, browserPages: 32, browserContexts: 16,
  maxPendingQueue: 20000, maxPages: 100000, maxResources: 250000, maxLinks: 1000000, maxCacheEntries: 5000,
  maxIndexDocs: 100000, maxCrossOriginResources: 10000, sitemapConcurrency: 32, maxSitemapFiles: 1000,
  proxyWarmConcurrency: 64, proxyWarmRobots: 1000, browserCrawlerConcurrency: 64,
  maxTextBytesPerResource: 16 * 1024 * 1024, maxImageBytes: 64 * 1024 * 1024, maxMediaBytes: 128 * 1024 * 1024,
  maxActiveJobs: 20, parseWorkers: 16, maxProxySessions: 5000, sessionIdleMs: 24 * 60 * 60 * 1000
};

function legacyProfileFor(ramMb) {
  if (ramMb && ramMb <= 768) return "free";
  if (ramMb && ramMb <= 2048) return "balanced";
  return "high";
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// Derive crawler / browser / session limits from an instance's RAM and CPU.
function capsFor(ramMb, cpu) {
  const legacy = legacyProfileFor(ramMb);
  const base = { ...LEGACY_CAPS[legacy] };
  const gb = ramMb / 1024;
  const scale = Math.max(1, gb / 4); // growth beyond the 4 GB "high" profile
  const out = { ...base };
  out.maxActiveFetches = Math.max(10, Math.min(Math.round(cpu * 40 + gb * 6), Math.round(gb * 40)));
  out.browserSessions = ramMb <= 512 ? 1 : ramMb <= 2048 ? 2 : ramMb <= 4096 ? 4 : ramMb <= 8192 ? 6 : 8;
  out.browserPages = ramMb <= 512 ? 1 : out.browserSessions * 2;
  out.browserContexts = out.browserSessions;
  out.browserMaxActiveFetches = ramMb <= 512 ? 4 : clamp(Math.round(6 + cpu * 6), 6, 64);
  out.browserCrawlerConcurrency = clamp(Math.round(cpu * 6), 3, 64);
  // Parse workers keep HTML/JS parsing off the main thread so proxying stays
  // responsive while crawling. 512 MB instances cannot afford extra isolates.
  out.parseWorkers = ramMb <= 512 ? 0 : clamp(cpu <= 1 ? 1 : cpu <= 2 ? 2 : Math.floor(cpu * 0.75), 0, 16);
  out.maxActiveJobs = ramMb <= 512 ? (cpu >= 0.5 ? 2 : 1) : clamp(Math.round(cpu * 2 + gb / 2), 3, 20);
  out.maxProxySessions = clamp(Math.round(gb * 300), 150, 5000);
  out.sessionIdleMs = cpu < 0.5 ? 10 * 60 * 1000 : 30 * 60 * 1000;
  if (gb > 4) {
    for (const k of ["maxPendingQueue", "maxPages", "maxResources", "maxLinks", "maxCacheEntries", "maxIndexDocs", "maxCrossOriginResources", "maxSitemapFiles"]) out[k] = Math.round(base[k] * scale);
    out.sitemapConcurrency = Math.round(base.sitemapConcurrency * Math.min(2, scale));
    out.proxyWarmConcurrency = Math.round(base.proxyWarmConcurrency * Math.min(2, scale));
    out.proxyWarmRobots = Math.round(base.proxyWarmRobots * Math.min(4, scale));
  }
  for (const k of CAP_KEYS) out[k] = clamp(Math.round(out[k]), k === "parseWorkers" ? 0 : 1, CAP_CEILINGS[k]);
  return out;
}

function resolvePlanName(name, customPlans = {}) {
  const n = String(name || "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!n) return "";
  if (customPlans[n]) return n;
  if (RENDER_PLANS[n]) return n;
  for (const [key, p] of Object.entries(RENDER_PLANS)) if ((p.aliases || []).includes(n) || (p.aliases || []).includes(n.replace(/_/g, "-"))) return key;
  return null;
}

function readCgroup(file) { try { return fs.readFileSync(file, "utf8").trim(); } catch { return ""; } }
function detectMemoryMb() {
  const explicit = Number(process.env.MEMORY_LIMIT_MB);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  for (const file of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    const raw = readCgroup(file);
    if (!raw || raw === "max") continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n < 1024 ** 5) return Math.round(n / 1024 / 1024);
  }
  return 0;
}
function detectCpu() {
  const explicit = Number(process.env.VEYRA_CPU_LIMIT);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const v2 = readCgroup("/sys/fs/cgroup/cpu.max");
  if (v2) { const [q, p] = v2.split(/\s+/); if (q !== "max" && Number(q) > 0 && Number(p) > 0) return Math.round((Number(q) / Number(p)) * 100) / 100; }
  const q1 = Number(readCgroup("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")), p1 = Number(readCgroup("/sys/fs/cgroup/cpu/cpu.cfs_period_us"));
  if (q1 > 0 && p1 > 0) return Math.round((q1 / p1) * 100) / 100;
  return 0;
}
function closestPlan(ramMb, cpu) {
  let best = null, bestScore = Infinity;
  for (const [key, p] of Object.entries(RENDER_PLANS)) {
    const score = Math.abs(Math.log2(p.ramMb / ramMb)) * 2 + (cpu ? Math.abs(Math.log2(p.cpu / cpu)) : 0);
    if (score < bestScore) { bestScore = score; best = key; }
  }
  return best;
}

function readConfigFile(file = CONFIG_PATH) {
  if (!fs.existsSync(file)) return { data: {}, exists: false, error: null };
  try {
    // require() (not readFileSync) so `node --watch server.js` restarts on edits.
    const resolved = require.resolve(file);
    delete require.cache[resolved];
    return { data: require(resolved) || {}, exists: true, error: null };
  } catch (e) {
    return { data: {}, exists: true, error: `Could not parse ${path.basename(file)}: ${e.message}` };
  }
}

function validateConfig(data) {
  const errors = [], warnings = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) return { errors: ["Config root must be a JSON object."], warnings };
  const known = new Set(["$comment", "plan", "env", "caps", "plans", "environments"]);
  for (const k of Object.keys(data)) if (!known.has(k)) warnings.push(`Unknown top-level key "${k}" (ignored).`);
  const custom = data.plans && typeof data.plans === "object" ? data.plans : {};
  for (const [name, p] of Object.entries(custom)) {
    if (!p || typeof p !== "object") { errors.push(`plans.${name} must be an object.`); continue; }
    if (!(Number(p.ramMb) > 0)) errors.push(`plans.${name}.ramMb must be a positive number.`);
    if (!(Number(p.cpu) > 0)) errors.push(`plans.${name}.cpu must be a positive number.`);
    if (p.caps) checkCaps(p.caps, `plans.${name}.caps`);
  }
  if (data.plan !== undefined && data.plan !== "auto" && !resolvePlanName(data.plan, custom)) errors.push(`plan "${data.plan}" is not a Render plan. Use one of: auto, ${Object.keys(RENDER_PLANS).join(", ")}${Object.keys(custom).length ? ", " + Object.keys(custom).join(", ") : ""}.`);
  checkEnv(data.env, "env");
  if (data.caps) checkCaps(data.caps, "caps");
  if (data.environments !== undefined) {
    if (typeof data.environments !== "object") errors.push("environments must be an object.");
    else for (const [name, e] of Object.entries(data.environments)) {
      if (!e || typeof e !== "object") { errors.push(`environments.${name} must be an object.`); continue; }
      if (e.plan !== undefined && e.plan !== "auto" && !resolvePlanName(e.plan, custom)) errors.push(`environments.${name}.plan "${e.plan}" is not a known plan.`);
      checkEnv(e.env, `environments.${name}.env`);
      if (e.caps) checkCaps(e.caps, `environments.${name}.caps`);
    }
  }
  return { errors, warnings };
  function checkEnv(env, where) {
    if (env === undefined) return;
    if (!env || typeof env !== "object" || Array.isArray(env)) { errors.push(`${where} must be an object of ENV_NAME: value.`); return; }
    for (const [k, v] of Object.entries(env)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(k)) errors.push(`${where}.${k}: env names must be UPPER_SNAKE_CASE.`);
      if (!["string", "number", "boolean"].includes(typeof v)) errors.push(`${where}.${k} must be a string, number or boolean.`);
      if (/PASSWORD|SECRET|PRIVATE_KEY|API_KEY|TOKEN/.test(k) && v !== "") warnings.push(`${where}.${k} looks like a secret — keep secrets in Render env vars, not in a committed file.`);
    }
  }
  function checkCaps(caps, where) {
    if (typeof caps !== "object" || Array.isArray(caps)) { errors.push(`${where} must be an object.`); return; }
    for (const [k, v] of Object.entries(caps)) {
      if (!CAP_KEYS.includes(k)) warnings.push(`${where}.${k} is not a known cap (known: ${CAP_KEYS.join(", ")}).`);
      else if (!(Number(v) >= 0)) errors.push(`${where}.${k} must be a number >= 0.`);
    }
  }
}

// Build the effective configuration. Pure apart from reading env/files; call
// applyToProcessEnv() to push the layered defaults into process.env.
function loadConfig({ env = process.env, file = CONFIG_PATH } = {}) {
  const { data, exists, error } = readConfigFile(file);
  const validation = error ? { errors: [error], warnings: [] } : validateConfig(data);
  const safe = validation.errors.length ? {} : data;
  const customPlans = Object.fromEntries(Object.entries(safe.plans || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const envName = String(env.VEYRA_ENV || env.NODE_ENV || (env.RENDER ? "production" : "development")).toLowerCase();
  const envLayer = (safe.environments && safe.environments[envName]) || {};

  const detected = { ramMb: detectMemoryMb(), cpu: detectCpu(), onRender: !!env.RENDER };
  const requested = env.VEYRA_PLAN || env.RENDER_PLAN || envLayer.plan || safe.plan || "auto";
  let planKey = requested === "auto" ? "" : resolvePlanName(requested, customPlans);
  let planSource = requested === "auto" ? "auto-detect" : env.VEYRA_PLAN ? "VEYRA_PLAN" : env.RENDER_PLAN ? "RENDER_PLAN" : envLayer.plan ? `environments.${envName}.plan` : "veyra.config.json";
  if (planKey === null) { validation.errors.push(`Plan "${requested}" is not recognised; falling back to auto-detect.`); planKey = ""; planSource = "auto-detect"; }

  let plan;
  if (planKey && customPlans[planKey]) {
    const p = customPlans[planKey];
    plan = { key: planKey, label: p.label || planKey, ramMb: Number(p.ramMb), cpu: Number(p.cpu), custom: true };
  } else if (planKey) {
    plan = { key: planKey, ...RENDER_PLANS[planKey] };
  } else if (detected.ramMb) {
    const key = closestPlan(detected.ramMb, detected.cpu);
    plan = { key, ...RENDER_PLANS[key], detected: true };
    // On a non-Render box (local dev with a cgroup), use the real numbers.
    if (!detected.onRender) plan = { key: "local", label: "Local machine", ramMb: detected.ramMb, cpu: detected.cpu || os.cpus().length, detected: true };
  } else {
    plan = { key: "local", label: "Local machine", ramMb: Math.round(os.totalmem() / 1024 / 1024), cpu: os.cpus().length, detected: true };
  }

  // RESOURCE_PROFILE=free|balanced|high keeps the old fixed caps.
  const legacyExplicit = String(env.RESOURCE_PROFILE || "").trim().toLowerCase();
  let caps;
  let resourceProfile;
  if (["free", "balanced", "high"].includes(legacyExplicit) && !env.VEYRA_PLAN && !env.RENDER_PLAN) {
    caps = { ...LEGACY_CAPS[legacyExplicit] };
    resourceProfile = legacyExplicit;
  } else {
    caps = capsFor(plan.ramMb, plan.cpu);
    resourceProfile = legacyProfileFor(plan.ramMb);
  }
  const capSources = Object.fromEntries(CAP_KEYS.map(k => [k, "plan"]));
  const applyCaps = (obj, label) => { for (const [k, v] of Object.entries(obj || {})) if (CAP_KEYS.includes(k) && Number(v) >= 0) { caps[k] = clamp(Number(v), 0, CAP_CEILINGS[k]); capSources[k] = label; } };
  if (plan.custom) applyCaps(customPlans[plan.key].caps, `plans.${plan.key}.caps`);
  applyCaps(safe.caps, "veyra.config.json caps");
  applyCaps(envLayer.caps, `environments.${envName}.caps`);

  // Env-var defaults layered below the real environment.
  const envDefaults = {}, envSources = {};
  const put = (obj, label) => { for (const [k, v] of Object.entries(obj || {})) { envDefaults[k] = String(v); envSources[k] = label; } };
  put({
    MAX_ACTIVE_JOBS: caps.maxActiveJobs,
    CRAWLER_PARSE_WORKERS: caps.parseWorkers,
    MAX_PROXY_SESSIONS: caps.maxProxySessions,
    SESSION_IDLE_TTL_MS: caps.sessionIdleMs,
    MEMORY_LIMIT_MB: detected.ramMb || plan.ramMb
  }, `plan:${plan.key}`);
  put(safe.env, "veyra.config.json env");
  put(envLayer.env, `environments.${envName}.env`);

  return {
    file, fileExists: exists, envName, requestedPlan: requested, planSource, plan, detected, resourceProfile,
    caps, capSources, envDefaults, envSources, errors: validation.errors, warnings: validation.warnings
  };
}

function applyToProcessEnv(cfg, env = process.env) {
  const applied = {}, overriddenByEnv = {};
  for (const [k, v] of Object.entries(cfg.envDefaults)) {
    if (env[k] === undefined || env[k] === "") { env[k] = v; applied[k] = cfg.envSources[k]; }
    else overriddenByEnv[k] = true;
  }
  cfg.applied = applied;
  cfg.overriddenByEnv = overriddenByEnv;
  return cfg;
}

function publicSummary(cfg) {
  const mask = k => /PASSWORD|SECRET|PRIVATE_KEY|API_KEY|TOKEN|PROFILES_JSON/.test(k);
  return {
    file: path.basename(cfg.file), fileExists: cfg.fileExists, environment: cfg.envName,
    plan: { key: cfg.plan.key, label: cfg.plan.label, ramMb: cfg.plan.ramMb, cpu: cfg.plan.cpu, source: cfg.planSource, detected: !!cfg.plan.detected },
    detected: cfg.detected, resourceProfile: cfg.resourceProfile,
    caps: cfg.caps, capSources: cfg.capSources,
    envDefaults: Object.fromEntries(Object.entries(cfg.envDefaults).map(([k, v]) => [k, { value: mask(k) ? "(hidden)" : v, source: cfg.envSources[k], overriddenByEnv: !!(cfg.overriddenByEnv || {})[k] }])),
    errors: cfg.errors, warnings: cfg.warnings
  };
}

// ---- file editing helpers (CLI + dev API) ----
function loadRawFile(file = CONFIG_PATH) {
  if (!fs.existsSync(file)) return { plan: "auto", env: {} };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function saveRawFile(data, file = CONFIG_PATH) {
  const v = validateConfig(data);
  if (v.errors.length) throw Object.assign(new Error(v.errors.join(" ")), { code: "CONFIG_INVALID", validation: v });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return v;
}
function setPlanInRenderYaml(planKey, file = RENDER_YAML_PATH) {
  if (!fs.existsSync(file)) return false;
  const yamlPlan = RENDER_PLANS[planKey]?.renderYaml;
  if (!yamlPlan) return false;
  let text = fs.readFileSync(file, "utf8");
  if (/^\s+plan:\s*.*$/m.test(text)) text = text.replace(/^(\s+)plan:\s*.*$/m, `$1plan: ${yamlPlan}`);
  else text = text.replace(/^(\s+)runtime:\s*node\s*$/m, `$1runtime: node\n$1plan: ${yamlPlan}`);
  fs.writeFileSync(file, text);
  return true;
}

function fmtBytes(n) { return n >= 1048576 ? `${Math.round(n / 1048576)}MB` : `${Math.round(n / 1024)}KB`; }
function cli(argv) {
  const [cmd = "show", ...rest] = argv;
  if (cmd === "help" || cmd === "--help") {
    console.log("Usage: node config.js <plans|show|plan <name>|set KEY=VALUE|unset KEY|cap KEY=VALUE|validate>");
    return 0;
  }
  if (cmd === "plans") {
    console.log("plan          RAM     CPU   fetches  crawlers  parseWorkers  browserSessions  sessions");
    for (const [k, p] of Object.entries(RENDER_PLANS)) {
      const c = capsFor(p.ramMb, p.cpu);
      console.log(`${k.padEnd(13)} ${(p.ramMb >= 1024 ? p.ramMb / 1024 + "GB" : p.ramMb + "MB").padEnd(7)} ${String(p.cpu).padEnd(5)} ${String(c.maxActiveFetches).padEnd(8)} ${String(c.maxActiveJobs).padEnd(9)} ${String(c.parseWorkers).padEnd(13)} ${String(c.browserSessions).padEnd(16)} ${c.maxProxySessions}`);
    }
    return 0;
  }
  if (cmd === "show") {
    const cfg = loadConfig();
    const s = publicSummary(cfg);
    console.log(`Plan: ${s.plan.label} (${s.plan.key}) — ${s.plan.ramMb}MB RAM, ${s.plan.cpu} CPU [from ${s.plan.source}]`);
    console.log(`Environment: ${s.environment}   Config file: ${s.fileExists ? cfg.file : "(none)"}`);
    console.log("Caps:");
    for (const [k, v] of Object.entries(s.caps)) console.log(`  ${k.padEnd(26)} ${/Bytes/.test(k) ? fmtBytes(v) : v}${s.capSources[k] !== "plan" ? `   (${s.capSources[k]})` : ""}`);
    console.log("Env defaults (real env vars win):");
    for (const [k, v] of Object.entries(s.envDefaults)) console.log(`  ${k.padEnd(26)} ${v.value}   (${v.source}${process.env[k] !== undefined ? ", overridden by env" : ""})`);
    for (const e of s.errors) console.log(`ERROR: ${e}`);
    for (const w of s.warnings) console.log(`warn: ${w}`);
    return s.errors.length ? 1 : 0;
  }
  if (cmd === "validate") {
    const { data, error } = readConfigFile();
    const v = error ? { errors: [error], warnings: [] } : validateConfig(data);
    for (const e of v.errors) console.log(`ERROR: ${e}`);
    for (const w of v.warnings) console.log(`warn: ${w}`);
    if (!v.errors.length) console.log("veyra.config.json is valid.");
    return v.errors.length ? 1 : 0;
  }
  const data = loadRawFile();
  if (cmd === "plan") {
    const name = rest[0];
    const key = name === "auto" ? "auto" : resolvePlanName(name, data.plans || {});
    if (!key) { console.error(`Unknown plan "${name}". Run: node config.js plans`); return 1; }
    data.plan = key;
    saveRawFile(data);
    const yaml = key !== "auto" && setPlanInRenderYaml(key);
    console.log(`Plan set to ${key}.${yaml ? " render.yaml updated too." : ""} Commit and push to redeploy.`);
    return 0;
  }
  if (cmd === "set" || cmd === "cap") {
    const field = cmd === "set" ? "env" : "caps";
    data[field] ||= {};
    for (const pair of rest) {
      const i = pair.indexOf("="); if (i < 1) { console.error(`Expected KEY=VALUE, got "${pair}"`); return 1; }
      const k = pair.slice(0, i), raw = pair.slice(i + 1);
      data[field][k] = field === "caps" ? Number(raw) : raw;
    }
    saveRawFile(data);
    console.log(`Updated ${field} in veyra.config.json.`);
    return 0;
  }
  if (cmd === "unset") {
    for (const k of rest) { if (data.env) delete data.env[k]; if (data.caps) delete data.caps[k]; }
    saveRawFile(data);
    console.log("Removed.");
    return 0;
  }
  console.error(`Unknown command "${cmd}". Run: node config.js help`);
  return 1;
}

module.exports = {
  RENDER_PLANS, LEGACY_CAPS, CAP_KEYS, CAP_CEILINGS, CONFIG_PATH,
  capsFor, resolvePlanName, closestPlan, loadConfig, applyToProcessEnv, validateConfig, publicSummary,
  loadRawFile, saveRawFile, setPlanInRenderYaml, detectMemoryMb, detectCpu
};

if (require.main === module) process.exitCode = cli(process.argv.slice(2));
