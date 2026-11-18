"use strict";

const { NeuralCrawlerModel } = require("../src/services/neural-crawler");
const { trainingFeatures } = require("../src/services/neural-training-data");

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

function run() {
  const training = buildExamples(TRAIN_TOPICS), holdout = buildExamples(HOLDOUT_TOPICS);
  const model = new NeuralCrawlerModel();
  const before = evaluate(model, holdout);
  for (let epoch = 0; epoch < 5; epoch++) {
    for (const row of training) model.train({ features: row.features, positive: row.positive, weight: 1 });
  }
  return {
    dataset: "Synthetic fixture only; no networking, production data or model writes.",
    trainingExamples: training.length, holdoutExamples: holdout.length, optimizerUpdates: model.optimizerStep,
    before, after: evaluate(model, holdout)
  };
}

if (require.main === module) console.log(JSON.stringify(run(), null, 2));
module.exports = { TRAIN_TOPICS, HOLDOUT_TOPICS, run };
