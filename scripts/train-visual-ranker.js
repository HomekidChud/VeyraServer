"use strict";
// Offline only. CPU-baseline visual classifier for an explicitly licensed local corpus.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const SIDE = 24, FRAME_BYTES = SIDE * SIDE * 3, MAX_BYTES = 128 * 1024 * 1024;
const extensions = {
  images: /\.(?:png|jpe?g|webp|ppm)$/i,
  videos: /\.(?:mp4|webm|mov|mkv)$/i
};

function describeFrame(frame) {
  const bins = Array(25).fill(0);
  for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) {
    const i = (y * SIDE + x) * 3;
    for (let c = 0; c < 3; c++) {
      bins[c * 6 + Math.floor(frame[i + c] * 6 / 256)] += 1 / (SIDE * SIDE);
      const region = (y < SIDE / 2 ? 0 : 2) + (x < SIDE / 2 ? 0 : 1);
      bins[18 + region] += frame[i + c] / (255 * SIDE * SIDE * .75);
      if (x) bins[22] += Math.abs(frame[i + c] - frame[i + c - 3]) / (255 * SIDE * SIDE * 3);
      if (y) bins[23] += Math.abs(frame[i + c] - frame[i + c - SIDE * 3]) / (255 * SIDE * SIDE * 3);
    }
    bins[24] += (Math.max(frame[i], frame[i + 1], frame[i + 2]) - Math.min(frame[i], frame[i + 1], frame[i + 2])) / (255 * SIDE * SIDE);
  }
  return bins;
}

function visualFeatures(file, kind) {
  const samples = kind === "videos" ? 8 : 1;
  const scale = `scale=${SIDE}:${SIDE}:flags=area`;
  const formats = kind === "videos" ? "mov,matroska,webm" : "jpeg_pipe,png_pipe,webp_pipe,ppm_pipe";
  const decode = (filter, limit) => spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file",
    "-format_whitelist", formats, "-max_pixels", "16777216", "-filter_threads", "1",
    "-threads", "1", "-i", file, "-t", "16", "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", filter,
    "-frames:v", String(limit), "-pix_fmt", "rgb24", "-threads", "1", "-f", "rawvideo", "pipe:1"],
  { timeout: 15_000, maxBuffer: 128 * 1024 });
  let run = decode(kind === "videos" ? `fps=1/2,${scale}` : scale, samples);
  if (kind === "videos" && run.status === 0 && !run.stdout?.length) run = decode(scale, 1);
  const data = run.stdout;
  if (run.status !== 0 || !data?.length || data.length % FRAME_BYTES) throw new Error("FFmpeg could not extract bounded RGB frames");
  const frames = [];
  for (let i = 0; i < data.length; i += FRAME_BYTES) frames.push(describeFrame(data.subarray(i, i + FRAME_BYTES)));
  const vector = frames[0].map((_, index) => frames.reduce((sum, frame) => sum + frame[index], 0) / frames.length);
  const movement = frames.slice(1).reduce((sum, frame, index) =>
    sum + frame.reduce((delta, value, column) => delta + Math.abs(value - frames[index][column]), 0) / vector.length, 0);
  return { vector: [...vector, movement / Math.max(1, frames.length - 1)], frames: frames.length };
}

function loadCorpus(root, rows) {
  if (!Array.isArray(rows) || rows.length < 4 || rows.length > 1000) throw new Error("Use 4–1000 manifest entries, each with an independent label");
  root = fs.realpathSync(root);
  const seenFiles = new Set(), groups = new Map();
  return rows.map(entry => {
    if (!Object.hasOwn(extensions, entry?.kind) || !["train", "holdout"].includes(entry.split) ||
        typeof entry.file !== "string" || path.isAbsolute(entry.file) || !extensions[entry.kind].test(entry.file) ||
        typeof entry.label !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,79}$/u.test(entry.label) ||
        typeof entry.group !== "string" || !/^[\w-]{1,100}$/.test(entry.group) ||
        typeof entry.permission !== "string" || !entry.permission.trim() || entry.permission.length > 250) throw new Error("Invalid manifest entry");
    const file = fs.realpathSync(path.resolve(root, entry.file));
    const stat = fs.statSync(file);
    const relative = path.relative(root, file);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) ||
        !extensions[entry.kind].test(file) || !stat.isFile() || stat.size > MAX_BYTES) throw new Error("Each file must be inside the corpus, of the declared type and at most 128 MiB");
    const hash = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (seenFiles.has(hash)) throw new Error("Duplicate media detected");
    seenFiles.add(hash);
    if (groups.has(entry.group) && groups.get(entry.group) !== entry.split) throw new Error("One media group crosses the train/holdout boundary");
    groups.set(entry.group, entry.split);
    return { kind: entry.kind, label: entry.label, split: entry.split, file };
  });
}

function probabilities(vector, weights) {
  const logits = weights.map(row => row[vector.length] + vector.reduce((out, value, i) => out + value * row[i], 0));
  const max = Math.max(...logits), exp = logits.map(value => Math.exp(value - max)), total = exp.reduce((a, b) => a + b, 0);
  return exp.map(value => value / total);
}

function trainVisual(examples) {
  const labels = [...new Set(examples.map(row => row.label))].sort();
  if (labels.length < 2 || labels.length > 30) throw new Error("Use 2–30 classes");
  const train = examples.filter(item => item.split === "train"), holdout = examples.filter(item => item.split === "holdout");
  for (const label of labels) {
    if (!train.some(item => item.label === label) || !holdout.some(item => item.label === label)) throw new Error("Every class needs training and held-out assets");
  }
  const weights = labels.map(() => Array(train[0].vector.length + 1).fill(0));
  for (let epoch = 0; epoch < 100; epoch++) for (const row of train) {
    const guess = probabilities(row.vector, weights);
    for (let c = 0; c < labels.length; c++) {
      const error = +(labels[c] === row.label) - guess[c];
      for (let k = 0; k < row.vector.length; k++) weights[c][k] += .07 * (error * row.vector[k] - .003 * weights[c][k]);
      weights[c][row.vector.length] += .07 * error;
    }
  }
  const evaluation = {};
  for (const kind of Object.keys(extensions)) {
    const subset = holdout.filter(row => row.kind === kind);
    evaluation[kind] = { total: subset.length, multiFrame: subset.filter(row => row.frames > 1).length, correct: subset.filter(row => {
      const scores = probabilities(row.vector, weights);
      return labels[scores.indexOf(Math.max(...scores))] === row.label;
    }).length };
  }
  return { model: { version: "visual-baseline-rgb-v1", labels, weights }, trainingExamples: train.length,
    decodedFrames: examples.reduce((sum, row) => sum + row.frames, 0), evaluation };
}

if (require.main === module) {
  const [manifest, output] = process.argv.slice(2);
  if (!manifest || !output || process.argv.length !== 4) throw new Error("Usage: node scripts/train-visual-ranker.js dataset/manifest.json output.json");
  const rows = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const corpus = loadCorpus(path.dirname(manifest), rows);
  const report = trainVisual(corpus.map(({ file, ...row }) => ({ ...row, ...visualFeatures(file, row.kind) })));
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ trainingExamples: report.trainingExamples, decodedFrames: report.decodedFrames, evaluation: report.evaluation }));
}
module.exports = { visualFeatures, loadCorpus, trainVisual };
