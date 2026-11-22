"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { prepareQuery, features, heuristic, predict, matchPercent } = require("../src/services/search-match");
const fixture = require("../tests/fixtures/vertical-ranking");

const web = {
  train: [
    ["web", "international space station tracker", "International Space Station tracker", "Stock market tracker"],
    ["web", "Madrid train station", "Madrid Atocha train station map", "Madrid city council"],
    ["index", "javascript array reference", "JavaScript Array reference", "JavaScript conference tickets"],
    ["web", "Wales coastal path", "Wales Coast Path: official walking routes", "Wales news and sport", "Maps for the coastal path across Wales"]
  ],
  holdout: [
    ["web", "public library card renewal", "Renew your public library card", "City parking card renewal"],
    ["index", "python file handling", "Python tutorial: reading and writing files", "Python snakes in the wild", "A guide to file handling and encoding"]
  ]
};
function fixtureGroups(split) {
  return [...fixture[split], ...web[split]].map(([category, query, preferred, other, detail]) => ({
    category, query, results: [
      { relevant: true, title: preferred, snippet: detail }, { relevant: false, title: other }
    ]
  }));
}
function validate(groups) {
  const categories = new Set(["web", "index", "images", "videos", "news", "shopping", "research", "discussions"]);
  if (!Array.isArray(groups) || !groups.length || groups.length > 5000) throw new Error("Expected 1–5000 independently judged query groups");
  const text = (value, max) => typeof value === "string" && !!value.trim() && value.length <= max;
  return groups.map(group => {
    if (!categories.has(group?.category) || !text(group.query, 600) || !Array.isArray(group.results) ||
        group.results.length < 2 || group.results.length > 100) throw new Error("Invalid query group");
    const terms = prepareQuery(group.query);
    if (!terms.length) throw new Error("Query needs searchable terms");
    return group.results.map(row => {
      if (typeof row?.relevant !== "boolean" || !text(row.title, 600)) throw new Error("Each result needs an independent boolean relevance label and title");
      return { vector: features(terms, row, group.category), target: Number(row.relevant) };
    });
  });
}
function train(groups) {
  const examples = validate(groups).flat();
  const model = { version: "search-match-v1", bias: 0, weights: Array(6).fill(0) };
  // A small, reproducible supervised neural scorer (one sigmoid output).
  // Use all rated candidates, not only clicked, top-ranked or positive ones.
  for (let epoch = 0; epoch < 140; epoch++) {
    const gradient = Array(6).fill(0);
    let intercept = 0;
    for (const { vector, target } of examples) {
      const error = target - predict(vector, model);
      intercept += error;
      for (let i = 0; i < vector.length; i++) gradient[i] += error * vector[i];
    }
    model.bias += .8 * intercept / examples.length;
    model.weights = model.weights.map((weight, i) => Math.max(0, weight + .8 * (gradient[i] / examples.length - .01 * weight)));
  }
  return { ...model, bias: +model.bias.toFixed(6), weights: model.weights.map(weight => +weight.toFixed(6)) };
}
function evaluate(groups, calculate) {
  let correct = 0, total = 0;
  for (const rows of validate(groups)) {
    const scores = rows.map(({ vector, target }) => ({ score: calculate(vector), target }));
    for (const positive of scores.filter(row => row.target)) for (const negative of scores.filter(row => !row.target)) {
      total++;
      if (positive.score > negative.score) correct++;
    }
  }
  return { correct, total };
}
function run() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0].startsWith("--") && args[0] !== "--write")) throw new Error("Pass --write for built-in fixtures or a labeled JSON dataset path");
  const custom = args[0] && args[0] !== "--write" ? JSON.parse(fs.readFileSync(args[0], "utf8")) : null;
  const groups = custom ? custom.train : fixtureGroups("train"), holdout = custom ? custom.holdout : fixtureGroups("holdout");
  const key = group => `${group.category}:${prepareQuery(group.query).join(" ")}`;
  const trainingKeys = new Set(groups.map(key));
  if (holdout.some(group => trainingKeys.has(key(group)))) throw new Error("Training and holdout queries must be separate");
  const model = train(groups), learned = evaluate(holdout, vector => matchPercent(vector, model)), baseline = evaluate(holdout, heuristic);
  if (!learned.total || learned.correct < baseline.correct) throw new Error(`Holdout quality gate failed: ${JSON.stringify({ learned, baseline })}`);
  if (args[0] === "--write") fs.writeFileSync(path.join(__dirname, "../src/services/search-match-weights.json"), JSON.stringify(model, null, 2) + "\n");
  console.log(JSON.stringify({ model, labeledResults: validate(groups).flat().length, holdout: learned, metadataBaseline: baseline }, null, 2));
}
if (require.main === module) run();
module.exports = { train, evaluate, fixtureGroups };
