"use strict";

const { NeuralCrawlerModel } = require("../src/services/neural-crawler");
const { trainingFeatures } = require("../src/services/neural-training-data");

const STAGING_ID = "srv-dbuqerg8v5cc739sq830";
const STAGING_DIR = "/tmp/veyra-neural-staging";
const VERSION = "fixture-baseline-v2";
// Fictional URL scenarios, never fetched. Holdout topic, path templates and
// hostnames are separate. This is a regression screen, not a web relevance KPI.
const TRAIN = [
  "language-runtime", "graphic-design", "municipal-budget", "classical-history", "orbital-motion",
  "folk-music", "road-safety", "household-energy", "soil-health", "garden-planning",
  "geometry", "software-testing", "school-funding", "fossil-catalog", "local-rail",
  "public-library", "museum-media", "pension-basics", "statistics", "film-archive",
  "sports-results", "climate-facts", "weather-maps", "building-access", "recipe-book",
  "electric-vehicles", "water-quality", "coastal-geology", "art-history", "language-learning",
  "forest-survey", "voter-guide", "office-access", "indoor-air", "traffic-planning",
  "economics", "consumer-goods", "leisure-centres", "airports", "disability-services"
];
const HOLDOUT = ["acoustics", "rural-services", "ceramics", "satellites", "atmosphere", "accessibility", "mountain-erosion", "football-rules"];
const TRAIN_PAIRS = [
  ["/docs/:topic", "/archive/:topic/1998/missing"],
  ["/learning/tutorial/:topic/reference", "/broken/resources/:topic/v1/removed"],
  ["/course/:topic/step-one", "/catalogue/:topic/legacy/unavailable"],
  ["/reports/:topic/chapter-one", "/docs/archive/:topic/v0/gone"],
  ["/journal/:topic", "/legacy/print/archive/:topic/edition-1/gone"],
  ["/guide/:topic/examples/setup", "/legacy/data/:topic/v1/entry"],
  ["/resources/:topic", "/assets/backup/legacy/:topic/export/not-found"],
  ["/static/reference/:topic/guide", "/old/archive/:topic/obsolete"]
];
const HOLDOUT_PAIRS = [
  ["/manual/:topic", "/collections/digital/retired/:topic/entry"],
  ["/web/:topic/handbook", "/editions/archive/retired/:topic/revisions/v2/missing"],
  ["/learning/:topic/guide/examples", "/redirect-archive/:topic/obsolete"],
  ["/library/guide/:topic", "/volumes/orphaned/:topic/edition/removed"],
  ["/reference/:topic/step-two", "/docs/retired/:topic/reference/old"],
  ["/reports/:topic/summary", "/records/backups/:topic/2001/unavailable"],
  ["/data/:topic", "/holdings/archive/history/:topic/export/unavailable"],
  ["/study/:topic/instructions", "/materials/retired/:topic/copy"]
];

function stagingIsolation(env, mongoConfigured = false) {
  return env.RENDER_SERVICE_ID === STAGING_ID && env.VEYRA_DATA_DIR === STAGING_DIR &&
    !env.MONGODB_URI && !env.MONGO_URI && !mongoConfigured;
}

function rows(topics, pairs) {
  const model = new NeuralCrawlerModel();
  return topics.flatMap((topic, j) => pairs.flatMap((pair, i) => pair.map((path, k) => {
    const host = `https://fixture-${topic}.invalid`;
    const features = model.extractFeatures(host + path.replace(":topic", topic),
      { type: "html", internal: (i + j) % 2 === 0 });
    // Simulate both familiar and unfamiliar publishers independently of label.
    features[0] = j % 5 === 0 ? 0.9 : 0.1;
    features[8] = features[9] = 0.5;
    return { features: trainingFeatures(features), positive: k === 0 };
  })));
}

function evaluate(model, data) {
  let loss = 0, wins = 0;
  for (let i = 0; i < data.length; i += 2) {
    const positive = model.score(data[i].features), negative = model.score(data[i + 1].features);
    loss -= Math.log(Math.max(1e-9, positive)) + Math.log(Math.max(1e-9, 1 - negative));
    wins += positive === negative ? 0.5 : Number(positive > negative);
  }
  return { logLoss: Number((loss / data.length).toFixed(4)), pairAccuracy: Number((wins / (data.length / 2)).toFixed(4)) };
}

function trainBaseline() {
  const model = new NeuralCrawlerModel();
  const training = rows(TRAIN, TRAIN_PAIRS), holdout = rows(HOLDOUT, HOLDOUT_PAIRS);
  const before = evaluate(model, holdout);
  for (let epoch = 0; epoch < 5; epoch++) {
    for (let i = 0; i < training.length; i += 2) {
      const start = (i + epoch * 22) % training.length;
      for (const row of training.slice(start, start + 2)) model.train({ ...row, weight: 0.7 });
    }
  }
  const after = evaluate(model, holdout);
  const report = { version: VERSION, source: "offline-fixture", trainingExamples: training.length,
    holdoutExamples: holdout.length, optimizerUpdates: model.optimizerStep, before, after };
  return { report, accepted: after.logLoss < before.logLoss && after.pairAccuracy >= 0.65, checkpoint: model.serialize() };
}

function applyStagingBaseline(model, { env = process.env, loaded = false, enabled = false, mongoConfigured = false } = {}) {
  if (loaded || !enabled || !stagingIsolation(env, mongoConfigured)) return null;
  const { report, accepted, checkpoint } = trainBaseline();
  return accepted && model.loadData(checkpoint) ? report : null;
}

if (require.main === module) {
  const { report, accepted } = trainBaseline();
  console.log(JSON.stringify({ ...report, accepted }, null, 2));
  if (!accepted) process.exitCode = 1;
}

module.exports = { STAGING_ID, STAGING_DIR, stagingIsolation, trainBaseline, applyStagingBaseline };
