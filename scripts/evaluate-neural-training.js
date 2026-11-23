"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { NeuralCrawlerModel } = require("../src/services/neural-crawler");
const { trainingFeatures, trainingUrl } = require("../src/services/neural-training-data");
const EPOCHS = 5;

// Synthetic URL profiles, not genuine visits or a production quality dataset.
// Entire topics are withheld, rather than splitting variants of a topic.
const TRAIN_TOPICS = [
  "javascript", "geometry", "marine-biology", "car-maintenance", "medicines",
  "school-finance", "climate-policy", "uk-history", "local-transit", "geology",
  "music-theory", "tax-forms", "open-hardware", "cooking", "web-accessibility",
  "public-health", "employment-law", "rail-archives", "astronomy", "language"
];
const HOLDOUT_TOPICS = ["ecology", "electronics", "sports-medicine", "pensions", "aeronautics", "medieval-art"];

function examples(topics) {
  return topics.flatMap((topic, i) => {
    const document = [
      `/docs/${topic}`, `/learning/tutorial/${topic}/reference`, `/course/${topic}/step-one`, `/reports/${topic}/chapter-one`
    ];
    const deadEnd = [
      `/archive/${topic}/1998/missing`, `/broken/resources/${topic}/v1/removed`, `/catalogue/${topic}/legacy/unavailable`, `/docs/archive/${topic}/v0/gone`
    ];
    return document.flatMap((positivePath, j) => [
      { topic, url: `https://fixture-${topic}.invalid${positivePath}`, internal: (i + j) % 2 === 0, positive: true },
      { topic, url: `https://fixture-${topic}.invalid${deadEnd[j]}`, internal: (i + j) % 2 === 0, positive: false }
    ]);
  });
}

function buildExamples(topics) {
  const baseline = new NeuralCrawlerModel();
  return examples(topics).map(({ topic, url, positive, internal }) => ({
    topic, positive, features: trainingFeatures(baseline.extractFeatures(url, { type: "html", internal }))
  }));
}

function evaluate(model, rows) {
  let loss = 0, pairs = 0, wins = 0;
  for (let i = 0; i < rows.length; i += 2) {
    const plus = model.score(rows[i].features), minus = model.score(rows[i + 1].features);
    const eps = 1e-9;
    loss -= Math.log(Math.max(eps, plus)) + Math.log(Math.max(eps, 1 - minus));
    wins += plus === minus ? 0.5 : Number(plus > minus);
    pairs += 1;
  }
  return { logLoss: Number((loss / rows.length).toFixed(4)), pairAccuracy: Number((wins / pairs).toFixed(4)) };
}

function fit(training, holdout) {
  const model = new NeuralCrawlerModel();
  const before = evaluate(model, holdout);
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    for (const row of training) model.train({ features: row.features, positive: row.positive, weight: 1 });
  }
  return { model, metrics: {
    trainingExamples: training.length, holdoutExamples: holdout.length, optimizerUpdates: model.optimizerStep,
    before, after: evaluate(model, holdout)
  } };
}

function run() {
  return {
    dataset: "Synthetic fixture only; no networking, production data or model writes.",
    ...fit(buildExamples(TRAIN_TOPICS), buildExamples(HOLDOUT_TOPICS)).metrics
  };
}

function runDataset(dataset) {
  if (dataset?.schemaVersion !== 1 || typeof dataset.datasetId !== "string" || !/^[a-z0-9-]{1,60}$/.test(dataset.datasetId) ||
      !Array.isArray(dataset.pairs) || dataset.pairs.length > 20000) {
    throw new Error("Expected a version 1 dataset with a lowercase datasetId and up to 20,000 pairs");
  }
  const model = new NeuralCrawlerModel();
  const splits = { train: [], holdout: [] };
  const assignment = { publisher: new Map(), topic: new Map(), host: new Map() };
  const seenUrls = new Set();
  const field = value => typeof value === "string" && /^[a-z0-9-]{1,80}$/.test(value);
  for (const [index, pair] of dataset.pairs.entries()) {
    if (!pair || !["train", "holdout"].includes(pair.split) || !field(pair.publisher) || !field(pair.topic) ||
        !["owned", "licensed", "explicit-permission"].includes(pair.rights) ||
        typeof pair.rightsReference !== "string" || !pair.rightsReference.trim() || pair.rightsReference.length > 200) {
      throw new Error(`Pair ${index + 1}: invalid split, publisher, topic or rights record`);
    }
    const assign = (group, key) => {
      if (assignment[group].has(key) && assignment[group].get(key) !== pair.split) {
        throw new Error(`Pair ${index + 1}: ${group} appears in both splits`);
      }
      assignment[group].set(key, pair.split);
    };
    assign("publisher", pair.publisher);
    assign("topic", pair.topic);
    for (const [key, positive] of [["useful", true], ["deadEnd", false]]) {
      const example = pair[key], url = trainingUrl(example?.url);
      if (!url || url.protocol !== "https:" || url.href.includes("?") || url.href.includes("#") || typeof example.internal !== "boolean") {
        throw new Error(`Pair ${index + 1}: ${key} needs a clean public HTTPS URL and a boolean internal field`);
      }
      assign("host", url.hostname.replace(/^www\./, ""));
      if (seenUrls.has(url.href)) throw new Error(`Pair ${index + 1}: duplicate URL`);
      seenUrls.add(url.href);
      const raw = model.extractFeatures(url.href, { type: "html", internal: example.internal });
      raw[8] = 0.5; raw[9] = 0.5; // Do not learn from click, visit or prior model state.
      splits[pair.split].push({ features: trainingFeatures(raw), positive });
    }
  }
  if (!splits.train.length || !splits.holdout.length) throw new Error("Both train and holdout need labelled pairs");
  const trained = fit(splits.train, splits.holdout);
  const report = { datasetId: dataset.datasetId, datasetSchemaVersion: 1, ...trained.metrics };
  return { report, checkpoint: { ...trained.model.serialize(), offlineTraining: report } };
}

function main(args) {
  const { values } = parseArgs({ args, options: { dataset: { type: "string" }, "candidate-out": { type: "string" } } });
  if (Object.hasOwn(values, "dataset") && !values.dataset) throw new Error("Missing dataset path");
  if (!values.dataset) {
    if (Object.hasOwn(values, "candidate-out")) throw new Error("--candidate-out requires a permissioned --dataset");
    return run();
  }
  if (fs.statSync(values.dataset).size > 25 * 1024 * 1024) throw new Error("Dataset file exceeds 25 MiB");
  const { report, checkpoint } = runDataset(JSON.parse(fs.readFileSync(values.dataset, "utf8")));
  if (Object.hasOwn(values, "candidate-out")) {
    const output = values["candidate-out"];
    if (!output || !output.endsWith(".candidate.json") ||
        (process.env.NEURAL_MODEL_PATH && path.resolve(output) === path.resolve(process.env.NEURAL_MODEL_PATH))) {
      throw new Error("Use a separate, new .candidate.json path, not the live checkpoint");
    }
    fs.writeFileSync(output, `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  return { ...report, candidateWritten: Object.hasOwn(values, "candidate-out") };
}

if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { TRAIN_TOPICS, HOLDOUT_TOPICS, run, runDataset, main };
