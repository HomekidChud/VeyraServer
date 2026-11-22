"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { compileLedger, digest } = require("../scripts/media-rights-ledger");

const day = "2026-11-22";
const sha256 = digest("synthetic fixture");
const item = { assetId: "image-fixture", sha256, group: "fixture-production", split: "train" };

function fixture() {
  return {
    schemaVersion: 1, ledgerId: "generated-test-v1", denylist: [],
    assets: [{
      assetId: item.assetId, sha256, group: item.group, creator: "Synthetic test",
      sourceType: "self-produced", origin: "internal:tests/fixture",
      license: { identifier: "owned-test-fixture", version: "1" },
      review: { status: "approved", reviewer: "fixture-author", reviewedOn: day,
        evidenceRefs: ["internal:tests/generated-by-test"], thirdPartyRights: "none" },
      allowedUses: ["training", "evaluation"], territories: ["worldwide"], expiresOn: null,
      attribution: { required: false, text: "" }
    }]
  };
}

test("preflight requires approved bytes, matching production groups and split-specific permissions", () => {
  const rights = fixture();
  const check = compileLedger(rights, day);
  assert.doesNotThrow(() => check(item));
  assert.doesNotThrow(() => check({ ...item, split: "holdout" }));
  assert.throws(() => check({ ...item, assetId: "unknown" }), /Missing or mismatched/);
  assert.throws(() => check({ ...item, sha256: digest("changed") }), /Missing or mismatched/);
  assert.throws(() => check({ ...item, group: "different-group" }), /Missing or mismatched/);
  rights.assets[0].allowedUses = ["training"];
  assert.throws(() => compileLedger(rights, day)({ ...item, split: "holdout" }), /don't cover evaluation/);
  rights.assets[0].allowedUses = ["evaluation"];
  assert.throws(() => compileLedger(rights, day)(item), /don't cover training/);
});

test("approval, clearance, dates, territory and revocation fail closed", () => {
  for (const [alter, error] of [
    [record => { record.review.status = "pending"; }, /not approved/],
    [record => { record.review.status = "revoked"; }, /not approved/],
    [record => { record.review.reviewedOn = "2026-11-23"; }, /not approved/],
    [record => { record.review.reviewedOn = "2026-02-30"; }, /Invalid rights record/],
    [record => { record.review.thirdPartyRights = "unresolved"; }, /not approved/],
    [record => { record.review.thirdPartyRights = "cleared"; }, /Invalid rights record/],
    [record => { record.expiresOn = "2026-11-21"; }, /expired/],
    [record => { record.territories = ["GB"]; }, /Territory restriction/],
    [record => { record.origin = "https://name:pass@example.test/"; }, /Invalid rights record/],
    [record => { record.review.evidenceRefs = []; }, /Invalid rights record/],
    [record => { record.attribution.required = true; }, /Invalid rights record/]
  ]) {
    const rights = fixture();
    alter(rights.assets[0]);
    assert.throws(() => compileLedger(rights, day)(item), error);
  }
  const rights = fixture();
  rights.denylist = [{ assetId: item.assetId, reasonRef: "internal:removals/01" }];
  assert.throws(() => compileLedger(rights, day)(item), /denylist/);
  assert.throws(() => compileLedger(rights, day)({ ...item, assetId: "another-id" }), /denylist/);
  rights.denylist = [{ sha256, reasonRef: "internal:removals/02" }];
  assert.throws(() => compileLedger(rights, day)(item), /denylist/);
  rights.denylist = [{ reasonRef: "internal:removals/03" }];
  assert.throws(() => compileLedger(rights, day), /Invalid rights denylist/);
});

test("duplicate IDs, duplicate byte hashes and missing versions are invalid", () => {
  const rights = fixture();
  rights.assets.push({ ...rights.assets[0], assetId: "other-id" });
  assert.throws(() => compileLedger(rights, day), /Duplicate/);
  rights.assets[1] = { ...rights.assets[0], sha256: digest("other bytes") };
  assert.throws(() => compileLedger(rights, day), /Duplicate/);
  rights.schemaVersion = 2;
  assert.throws(() => compileLedger(rights, day), /schemaVersion 1/);
});
