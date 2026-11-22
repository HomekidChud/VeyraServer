"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const { loadCorpus, visualFeatures } = require("../scripts/train-visual-ranker");

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
      rows.push({ file: image, kind: "images", label, split, group, permission: "generated test fixture" },
        { file: video, kind: "videos", label, split, group, permission: "generated test fixture" });
    }
  }
  assert.throws(() => loadCorpus(root, rows.map(row => ({ ...row, group: row.label }))), /crosses/);
  assert.throws(() => loadCorpus(root, [...rows, { ...rows[0] }]), /Duplicate/);
  assert.throws(() => loadCorpus(root, [{ ...rows[0], file: "https://example.test/file.ppm" }, ...rows.slice(1)]));
  const moving = visualFeatures(path.join(root, "warm-1.mp4"), "videos");
  assert.ok(moving.frames > 1 && moving.vector.at(-1) > 0, "different decoded frames affect the features");
  const manifest = path.join(root, "manifest.json"), output = path.join(root, "model.json");
  fs.writeFileSync(manifest, JSON.stringify(rows));
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/train-visual-ranker.js"), manifest, output], { timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr?.toString());
  const report = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(report.trainingExamples, 4);
  assert.equal(report.evaluation.videos.multiFrame, 2);
  for (const kind of ["images", "videos"]) assert.deepEqual([report.evaluation[kind].correct, report.evaluation[kind].total], [2, 2]);
});
