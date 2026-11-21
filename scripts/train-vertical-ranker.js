"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { features, score } = require("../src/services/vertical-ranker");
const fixture = require("../tests/fixtures/vertical-ranking");

function examples(rows) {
  return rows.map(([category, query, preferred, other, detail], i) => {
    const positive = { title: preferred, snippet: detail }, negative = { title: other };
    const rank = i % 3 === 0 ? 0 : 1;
    return { category, query, positive, negative, rank };
  });
}
function trainModel() {
  const weights = [0, 0, 0, 0.25];
  const rows = examples(fixture.train);
  for (let epoch = 0; epoch < 140; epoch++) {
    for (const { query, positive, negative, rank } of rows) {
      const a = features(query, positive, rank), b = features(query, negative, 1 - rank);
      const delta = a.map((x, i) => x - b[i]);
      const margin = delta.reduce((sum, x, i) => sum + x * weights[i], 0);
      for (let i = 0; i < weights.length; i++) weights[i] = Math.max(i === 3 ? 0.25 : 0, weights[i] + 0.075 * (delta[i] / (1 + Math.exp(margin)) - .025 * weights[i]));
    }
  }
  return { version: "vertical-ranker-v1", weights: weights.map(w => Number(w.toFixed(6))) };
}
function evaluate(weights) {
  const rows = examples(fixture.holdout);
  const correct = rows.filter(({ query, positive, negative, rank }) => {
    const diff = score(query, positive, rank, weights) - score(query, negative, 1 - rank, weights);
    return diff > 0 || (diff === 0 && rank === 0);
  }).length;
  return { correct, total: rows.length };
}
if (require.main === module) {
  const model = trainModel();
  if (process.argv.includes("--write")) fs.writeFileSync(path.join(__dirname, "../src/services/vertical-ranker-weights.json"), JSON.stringify(model, null, 2) + "\n");
  console.log(JSON.stringify({ model, trainingPairs: fixture.train.length, heldOutFixture: evaluate(model.weights), providerOrderFixture: evaluate([0, 0, 0, 1]) }, null, 2));
}
module.exports = { trainModel, evaluate };
