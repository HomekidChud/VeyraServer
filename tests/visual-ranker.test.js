"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const { loadCorpus, visualFeatures } = require("../scripts/train-visual-ranker");
const { digest } = require("../scripts/media-rights-ledger");

const script = path.resolve(__dirname, "../scripts/train-visual-ranker.js");
const run = (args, env = process.env) => spawnSync(process.execPath, [script, ...args], { timeout: 30_000, env });
function ledgerFor(root, rows) {
  return { schemaVersion: 1, ledgerId: "synthetic-v1", denylist: [], assets: rows.map(row => ({
    assetId: row.assetId, group: row.group, sha256: digest(fs.readFileSync(path.join(root, row.file))),
    creator: "Synthetic QA", sourceType: "self-produced", origin: "internal:tests/synthetic",
    license: { identifier: "generated-test-fixture", version: "1" },
    review: { status: "approved", reviewer: "test-fixture", reviewedOn: "2020-01-01",
      evidenceRefs: ["internal:tests/generated"], thirdPartyRights: "none" },
    allowedUses: ["training", "evaluation"], territories: ["worldwide"], expiresOn: null,
    attribution: { required: false, text: "" }
  })) };
}

test("CLI validates all file digests without FFmpeg and rejects a denied or changed asset before writing a model", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-rights-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows = Array.from({ length: 4 }, (_, index) => ({
    assetId: `fixture-${index}`, group: `group-${index}`, file: `${index}.ppm`, label: index % 2 ? "warm" : "cool",
    kind: "images", split: index < 2 ? "train" : "holdout"
  }));
  for (const [index, row] of rows.entries()) fs.writeFileSync(path.join(root, row.file), `fixture bytes ${index}`);
  const manifest = path.join(root, "manifest.json");
  const ledger = path.join(root, "rights.json");
  const output = path.join(root, "model.json");
  const rights = ledgerFor(root, rows);
  fs.writeFileSync(manifest, JSON.stringify(rows));
  fs.writeFileSync(ledger, JSON.stringify(rights));
  const noDecoder = { ...process.env, PATH: root };
  const preflight = run(["--check-rights", manifest, ledger], noDecoder);
  assert.equal(preflight.status, 0, preflight.stderr?.toString());
  assert.equal(JSON.parse(preflight.stdout).approved, 4);
  assert.equal(fs.existsSync(output), false);
  const legacy = run([manifest, output], noDecoder);
  assert.equal(legacy.status, 1);
  assert.match(legacy.stderr.toString(), /Usage/);
  rights.denylist.push({ assetId: rows.at(-1).assetId, reasonRef: "internal:removals/test" });
  fs.writeFileSync(ledger, JSON.stringify(rights));
  const denied = run([manifest, ledger, output], noDecoder);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr.toString(), /denylist/);
  assert.equal(fs.existsSync(output), false);
  rights.denylist.length = 0;
  fs.writeFileSync(ledger, JSON.stringify(rights));
  fs.appendFileSync(path.join(root, rows.at(-1).file), "tampered");
  const changed = run([manifest, ledger, output], noDecoder);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr.toString(), /mismatched rights record/);
  assert.equal(fs.existsSync(output), false);
});

test("offline classifier learns from actual image pixels and sampled video frames", t => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("install FFmpeg to exercise media decoding");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-vision-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows = [];
  for (const [label, base] of [["cool", "blue"], ["warm", "red"]]) {
    for (const [split, i] of [["train", 0], ["holdout", 1]]) {
      const image = `${label}-${i}.ppm`, video = `${label}-${i}.mp4`;
      const group = `${label}-${i}`;
      const color = label === "warm" ? [255 - i * 8, 12 + i, 34] : [23, 12 + i, 255 - i * 8];
      fs.writeFileSync(path.join(root, image), Buffer.concat([Buffer.from("P6\n32 32\n255\n"),
        Buffer.from(Array.from({ length: 1024 }, () => color).flat())]));
      const clip = spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", `color=${base}:s=32x32:r=4:d=${i + 5}`,
        "-vf", "drawbox=x=0:y=0:width=5:height=5:color=white:t=fill:enable='gte(t,2)'", "-c:v", "mpeg4", path.join(root, video)],
      { timeout: 15_000 });
      assert.equal(clip.status, 0, clip.stderr?.toString());
      rows.push({ assetId: `${group}-image`, file: image, kind: "images", label, split, group },
        { assetId: `${group}-video`, file: video, kind: "videos", label, split, group });
    }
  }
  assert.throws(() => loadCorpus(root, rows), /ledger is required/);
  assert.throws(() => loadCorpus(root, rows.map(row => ({ ...row, group: row.label })), () => {}), /crosses/);
  assert.throws(() => loadCorpus(root, [...rows, { ...rows[0] }], () => {}), /Duplicate/);
  assert.throws(() => loadCorpus(root, [{ ...rows[0], file: "https://example.test/file.ppm" }, ...rows.slice(1)], () => {}));
  const moving = visualFeatures(path.join(root, "warm-1.mp4"), "videos");
  assert.ok(moving.frames > 1 && moving.vector.at(-1) > 0, "different decoded frames affect the features");
  const manifest = path.join(root, "manifest.json"), output = path.join(root, "model.json"), ledger = path.join(root, "rights.json");
  fs.writeFileSync(manifest, JSON.stringify(rows));
  fs.writeFileSync(ledger, JSON.stringify(ledgerFor(root, rows)));
  const result = run([manifest, ledger, output]);
  assert.equal(result.status, 0, result.stderr?.toString());
  const report = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(report.rights.ledgerSha256, digest(fs.readFileSync(ledger)));
  assert.deepEqual(report.rights.assetIds, rows.map(row => row.assetId).sort());
  assert.doesNotMatch(JSON.stringify(report), /internal:|fixture-author/);
  assert.doesNotMatch(result.stdout.toString(), /assetIds|internal:/);
  assert.equal(report.trainingExamples, 4);
  assert.equal(report.evaluation.videos.multiFrame, 2);
  for (const kind of ["images", "videos"]) assert.deepEqual([report.evaluation[kind].correct, report.evaluation[kind].total], [2, 2]);
});
