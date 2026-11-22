"use strict";
const fs = require("node:fs");
const { createHash } = require("node:crypto");

const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,99}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const EVIDENCE_REF = /^internal:[a-z0-9][a-z0-9._/-]{0,249}$/i;
const SOURCES = ["self-produced", "commissioned", "cc0", "public-domain"];
const USES = ["training", "evaluation"];
const STATUSES = ["approved", "pending", "denied", "revoked"];
const text = (value, max = 250) => typeof value === "string" && !!value.trim() && value.length <= max;
const match = (value, pattern) => typeof value === "string" && pattern.test(value);
const object = value => !!value && typeof value === "object" && !Array.isArray(value);
const evidence = refs => Array.isArray(refs) && refs.length >= 1 && refs.length <= 20 && refs.every(ref => match(ref, EVIDENCE_REF));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function validDate(value) {
  if (!match(value, /^\d{4}-\d{2}-\d{2}$/)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

function validOrigin(value) {
  if (match(value, EVIDENCE_REF)) return true;
  if (!text(value, 2000) || !value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

function compileLedger(data, today = new Date().toISOString().slice(0, 10)) {
  if (!object(data) || data.schemaVersion !== 1 || !match(data.ledgerId, ID) || !validDate(today)
      || !Array.isArray(data.assets) || data.assets.length < 1 || data.assets.length > 5000
      || !Array.isArray(data.denylist) || data.denylist.length > 5000) throw new Error("Invalid rights ledger (schemaVersion 1 required)");

  const deniedIds = new Set(), deniedHashes = new Set();
  for (const entry of data.denylist) {
    if (!object(entry) || (entry.assetId == null && entry.sha256 == null) || !match(entry.reasonRef, EVIDENCE_REF)
        || (entry.assetId != null && !match(entry.assetId, ID)) || (entry.sha256 != null && !match(entry.sha256, SHA256))) {
      throw new Error("Invalid rights denylist entry");
    }
    if (entry.assetId != null) deniedIds.add(entry.assetId);
    if (entry.sha256 != null) deniedHashes.add(entry.sha256);
  }

  const records = new Map(), hashes = new Set();
  for (const [index, row] of data.assets.entries()) {
    const review = row?.review, license = row?.license, attribution = row?.attribution;
    if (!object(row) || !match(row.assetId, ID) || !match(row.sha256, SHA256) || !match(row.group, ID) || !text(row.creator)
        || !SOURCES.includes(row.sourceType) || !validOrigin(row.origin)
        || !object(license) || !text(license.identifier) || !text(license.version)
        || !object(review) || !STATUSES.includes(review.status) || !text(review.reviewer) || !validDate(review.reviewedOn)
        || !evidence(review.evidenceRefs) || !["none", "cleared", "unresolved"].includes(review.thirdPartyRights)
        || (review.thirdPartyRights === "cleared" && !evidence(review.thirdPartyEvidenceRefs))
        || !Array.isArray(row.allowedUses) || row.allowedUses.length > 2 || !row.allowedUses.every(use => USES.includes(use))
        || !Array.isArray(row.territories) || row.territories.length < 1 || row.territories.length > 250
        || !row.territories.every(region => region === "worldwide" || match(region, /^[A-Z]{2}$/))
        || (row.expiresOn !== null && !validDate(row.expiresOn))
        || !object(attribution) || typeof attribution.required !== "boolean"
        || typeof attribution.text !== "string" || attribution.text.length > 2000
        || (attribution.required && !text(attribution.text, 2000))) {
      throw new Error(`Invalid rights record ${index + 1}`);
    }
    if (records.has(row.assetId) || hashes.has(row.sha256)) throw new Error("Duplicate asset ID or SHA-256 in rights ledger");
    records.set(row.assetId, row);
    hashes.add(row.sha256);
  }
  // A denylisted asset ID also blocks that record's bytes if only the ID was supplied.
  for (const id of deniedIds) if (records.has(id)) deniedHashes.add(records.get(id).sha256);

  return ({ assetId, sha256, group, split }) => {
    const record = records.get(assetId);
    const requireUse = split === "train" ? "training" : split === "holdout" ? "evaluation" : null;
    if (deniedIds.has(assetId) || deniedHashes.has(sha256)) throw new Error(`Rights denylist blocks asset ${assetId}`);
    if (!record || record.sha256 !== sha256 || record.group !== group) throw new Error(`Missing or mismatched rights record for asset ${assetId}`);
    if (record.review.status !== "approved" || record.review.reviewedOn > today || record.review.thirdPartyRights === "unresolved") {
      throw new Error(`Rights review is not approved for asset ${assetId}`);
    }
    if (record.expiresOn && (record.expiresOn < today || record.expiresOn < record.review.reviewedOn)) {
      throw new Error(`Rights expired for asset ${assetId}`);
    }
    if (!requireUse || !record.allowedUses.includes(requireUse)) throw new Error(`Rights don't cover ${requireUse || "the requested split"} for asset ${assetId}`);
    if (record.territories.length !== 1 || record.territories[0] !== "worldwide") throw new Error(`Territory restriction blocks asset ${assetId} in the offline pilot`);
  };
}

function readLedger(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_LEDGER_BYTES) throw new Error("Rights ledger must be a local JSON file at most 8 MiB");
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_LEDGER_BYTES) throw new Error("Rights ledger exceeds 8 MiB");
  let data;
  try { data = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Invalid rights ledger JSON"); }
  return { check: compileLedger(data), sha256: digest(bytes), id: data.ledgerId };
}

module.exports = { ID, compileLedger, readLedger, digest };
