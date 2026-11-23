"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, createPublicKey, randomBytes, verify } = require("node:crypto");
const { unicodeWords } = require("./search-language");

const PROFILES = new Map([
  ["pornhub.com", { posters: ["ei.phncdn.com"], id: /^[a-z0-9_-]{3,100}$/i }],
  ["xvideos.com", { posters: ["thumb-cdn77.others-cdn.com", "thumbs-gcore.others-cdn.com"], id: /^video[.a-z0-9]{3,100}$/i }]
]);
const AUDIENCE = "veyra:publisher-search";
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 15_000;
const MAX_GRANTS = 2048;
const CHALLENGE_MS = 10 * 60_000;
const MAX_SNAPSHOT_MS = 24 * 60 * 60_000;
const PAGE_SIZE = 24;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;

function httpsUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\]/u.test(value)) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && !u.hash ? u : null;
  } catch { return null; }
}

function asId(value, profile) {
  return typeof value === "string" && profile.id.test(value) ? value.toLowerCase() : "";
}

function watchUrl(value, domain, id) {
  const u = httpsUrl(value);
  if (!u || ![domain, `www.${domain}`].includes(u.hostname)) return "";
  if (domain === "pornhub.com") {
    const key = u.pathname === "/view_video.php" && u.searchParams.size === 1 ? u.searchParams.get("viewkey") :
      !u.search && /^\/embed\/[\w-]+$/.test(u.pathname) ? u.pathname.split("/")[2] : "";
    return key && key.toLowerCase() === id ? `https://www.pornhub.com/view_video.php?${new URLSearchParams({ viewkey: key })}` : "";
  }
  const [, segment, slug, extra] = u.pathname.split("/");
  return !u.search && segment?.toLowerCase() === id && !!slug && extra === undefined ? u.href : "";
}

function stageCatalog(catalog, now) {
  const { domain, generatedAtMs, expiresAtMs, approval, entries, withdrawnIds } = catalog || {};
  const profile = PROFILES.get(domain);
  if (!profile || !Number.isSafeInteger(generatedAtMs) || !Number.isSafeInteger(expiresAtMs) ||
      generatedAtMs > now || expiresAtMs <= now || expiresAtMs > generatedAtMs + MAX_SNAPSHOT_MS ||
      approval?.status !== "approved" || !/^internal:[a-z0-9][a-z0-9/_-]{5,190}$/i.test(String(approval.evidenceRef || "")) ||
      approval.territories !== "worldwide" || !Array.isArray(approval.uses) ||
      !["search-metadata", "thumbnail-display"].every(use => approval.uses.includes(use)) ||
      !Array.isArray(entries) || entries.length > MAX_ROWS || !Array.isArray(withdrawnIds) || withdrawnIds.length > MAX_ROWS) return null;
  const removed = new Set(withdrawnIds.map(id => asId(id, profile)));
  if (removed.has("")) return null;
  const indexed = new Map();
  const counts = { received: entries.length, indexed: 0, missingThumbnail: 0, unapprovedThumbnail: 0, invalidRecord: 0, withdrawn: 0, duplicates: 0 };
  for (const x of entries) {
    const id = asId(x?.id, profile), url = id && watchUrl(x.url, domain, id);
    const title = typeof x?.title === "string" && x.title.length <= 240 ? x.title.trim() : "";
    if (!url || !title || /[<>\p{Cc}\p{Cf}]/u.test(title)) { counts.invalidRecord++; continue; }
    if (removed.has(id)) { counts.withdrawn++; continue; }
    if (indexed.has(id)) { counts.duplicates++; continue; }
    if (!x.thumbnail) { counts.missingThumbnail++; continue; }
    const poster = httpsUrl(x.thumbnail);
    if (!poster || !profile.posters.includes(poster.hostname) || poster.search || !/\.(?:jpe?g|png|webp)$/i.test(poster.pathname)) {
      counts.unapprovedThumbnail++; continue;
    }
    const tags = typeof x.tags === "string" ? x.tags.slice(0, 500) : "";
    indexed.set(id, {
      row: { title, url, thumbnail: poster.href, source: domain, type: "videos" },
      keywords: new Set(unicodeWords(`${title} ${tags}`))
    });
  }
  counts.indexed = indexed.size;
  return { domain, expiresAtMs, counts, records: [...indexed.values()] };
}

function readBundle(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw Error("invalid-file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_FILE_BYTES) throw Error("invalid-file");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const length = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!length) throw Error("incomplete-file");
      offset += length;
    }
    // A concurrently changed catalog must be replaced atomically and reloaded.
    const current = fs.fstatSync(fd);
    if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) throw Error("unstable-file");
    const value = JSON.parse(bytes.toString("utf8"));
    if (value?.schemaVersion !== 1 || !Array.isArray(value.catalogs) ||
        !value.catalogs.length || value.catalogs.length > PROFILES.size) throw Error("invalid-bundle");
    return value.catalogs;
  } finally { fs.closeSync(fd); }
}

function claimsFromProof(value, key) {
  if (typeof value !== "string" || value.length > 2048) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  try {
    const [header, payload, signature] = parts.map(part => Buffer.from(part, "base64url"));
    const metadata = JSON.parse(header.toString("utf8"));
    if (metadata?.alg !== "EdDSA" || metadata?.typ !== "JWT" || Object.keys(metadata).length !== 2 ||
        signature.length !== 64 || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, signature)) return null;
    return JSON.parse(payload.toString("utf8"));
  } catch { return null; }
}

function createPublisherMedia({ env = process.env, now = Date.now, log = () => {} } = {}) {
  if (env.VEYRA_PUBLISHER_SEARCH !== "1") return null;
  let catalogs, key, launch, issuer;
  try {
    issuer = httpsUrl(env.VEYRA_PUBLISHER_AGE_ISSUER);
    launch = httpsUrl(env.VEYRA_PUBLISHER_AGE_START_URL);
    if (!issuer || !launch || issuer.origin !== launch.origin || issuer.search || launch.search) throw Error("invalid-age-config");
    key = createPublicKey(env.VEYRA_PUBLISHER_AGE_PUBLIC_KEY);
    if (key.asymmetricKeyType !== "ed25519") throw Error("invalid-key");
    const input = readBundle(env.VEYRA_PUBLISHER_CATALOG_PATH);
    catalogs = new Map();
    for (const entry of input) {
      const catalog = stageCatalog(entry, now());
      if (!catalog || catalogs.has(catalog.domain)) throw Error("invalid-catalog");
      catalogs.set(catalog.domain, catalog);
    }
  } catch {
    log("warn", "Publisher search disabled: invalid approval snapshot or age-verifier configuration.");
    return null;
  }
  for (const { domain, counts } of catalogs.values()) log("info", `Publisher catalog loaded ${JSON.stringify({ domain, ...counts })}`);
  const challenges = new Map();
  const accountChallenge = new Map();
  const digest = token => createHash("sha256").update(token).digest("base64url");
  function deleteChallenge(id, state) {
    challenges.delete(id);
    if (accountChallenge.get(state.account) === id) accountChallenge.delete(state.account);
  }
  function issue(account, token) {
    const time = now();
    if (![...catalogs.values()].some(item => item.expiresAtMs > time)) return null;
    for (const [id, state] of challenges) if (state.until <= time) deleteChallenge(id, state);
    if (accountChallenge.has(account)) {
      const existing = accountChallenge.get(account);
      deleteChallenge(existing, challenges.get(existing));
    }
    if (challenges.size >= MAX_GRANTS) return null;
    const nonce = randomBytes(32).toString("base64url");
    challenges.set(nonce, { account, binding: digest(token), issued: Math.floor(time / 1000), until: time + CHALLENGE_MS, verified: false });
    accountChallenge.set(account, nonce);
    const to = new URL(launch);
    to.searchParams.set("nonce", nonce);
    return { nonce, verificationUrl: to.href, expiresInSeconds: CHALLENGE_MS / 1000 };
  }
  function activeChallenge(nonce, account, token, time) {
    if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) return null;
    const state = challenges.get(nonce);
    return state && state.account === account && state.until > time && state.binding === digest(token) ? state : null;
  }
  function accept(account, token, proof) {
    const p = claimsFromProof(proof, key);
    const time = now(), seconds = Math.floor(time / 1000);
    if (!p || p.iss !== issuer.href || p.aud !== AUDIENCE ||
        typeof p.nonce !== "string" || !NONCE_RE.test(p.nonce) ||
        !Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp) ||
        p.iat > seconds || p.exp <= seconds || p.exp <= p.iat || p.exp - p.iat > CHALLENGE_MS / 1000) return false;
    const state = activeChallenge(p.nonce, account, token, time);
    if (!state || p.iat < state.issued) return false;
    if (p.over18 === false) { deleteChallenge(p.nonce, state); return false; }
    if (state.verified || p.over18 !== true) return false;
    state.verified = true;
    state.until = Math.min(state.until, p.exp * 1000);
    return true;
  }
  function search(account, token, { nonce, q, page = 0 } = {}) {
    const time = now();
    if (!activeChallenge(nonce, account, token, time)?.verified) return { status: "age-required" };
    const match = typeof q === "string" && q.length <= 240 && /^(?:search|site):([a-z0-9.-]+)(?:\s+(.+))?$/i.exec(q.trim());
    if (!match || !Number.isSafeInteger(page) || page < 0 || page >= Math.ceil(MAX_ROWS / PAGE_SIZE) ||
        /(?:^|\s)-?site:/i.test(match[2] || "")) return { status: "invalid-query" };
    const domain = match[1].toLowerCase(), catalog = catalogs.get(domain);
    if (!catalog || catalog.expiresAtMs <= time) return { status: "catalog-unavailable" };
    const terms = unicodeWords(match[2] || "");
    const hits = catalog.records.filter(entry => terms.every(term => entry.keywords.has(term)));
    const start = page * PAGE_SIZE;
    return { status: "ok", domain, total: hits.length, page, nextPage: start + PAGE_SIZE < hits.length ? page + 1 : null,
      results: hits.slice(start, start + PAGE_SIZE).map(entry => entry.row) };
  }
  return { issue, accept, search };
}

module.exports = { createPublisherMedia };
