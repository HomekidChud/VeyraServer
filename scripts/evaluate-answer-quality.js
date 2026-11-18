"use strict";

const { AIAnswerEngine, AnswerQualityModel } = require("../src/services/ai-answer");
const corpus = require("../tests/fixtures/answer-quality-corpus");

// Scores are trained in memory only. The evidence-overlap checker stays fixed
// and is evaluated separately against authored labels, not used as ground truth.
function vectorize(cases) {
  const engine = new AIAnswerEngine({ allowExtractiveFallback: false });
  return cases.map(scenario => {
    const intent = engine.detectIntent(scenario.question).type;
    return { ...scenario, candidates: scenario.candidates.map(candidate => {
      const verified = engine.verifyAnswer(candidate.text, scenario.evidence);
      const cited = new Set([...verified.answer.matchAll(/\[(S\d+)\]/g)].map(match => match[1]));
      const grounding = { verifiedClaims: verified.supported, unsupportedClaims: verified.unsupported };
      const features = engine.qualityModel.features({
        answer: candidate.text, grounding, intent, sources: scenario.evidence.filter(source => cited.has(source.id))
      });
      return { ...candidate, features, overlapPassed: verified.supported > 0 && verified.unsupported === 0 };
    }) };
  });
}

const rounded = value => Number(value.toFixed(4));

function evaluate(model, scenarios) {
  const slices = new Map();
  let count = 0, pairCount = 0, wins = 0, loss = 0;
  for (const { candidates } of scenarios) {
    const reference = model.predict(candidates.find(candidate => candidate.helpful).features);
    for (const row of candidates) {
      const raw = model.predict(row.features);
      const score = Math.max(1e-9, Math.min(1 - 1e-9, raw));
      loss -= Math.log(row.helpful ? score : 1 - score);
      count += 1;
      if (!slices.has(row.kind)) slices.set(row.kind, { count: 0, wins: 0, overlapPassed: 0 });
      const slice = slices.get(row.kind);
      slice.count += 1;
      slice.overlapPassed += Number(row.overlapPassed);
      if (!row.helpful) {
        const credit = Math.abs(reference - raw) < 1e-12 ? 0.5 : Number(reference > raw);
        slice.wins += credit;
        pairCount += 1;
        wins += credit;
      }
    }
  }
  return {
    logLoss: rounded(loss / count),
    pairAccuracy: rounded(wins / pairCount),
    pairCount,
    byCase: Object.fromEntries([...slices].map(([kind, slice]) => [kind, {
      examples: slice.count,
      ...(kind === "grounded" ? {} : { pairAccuracy: rounded(slice.wins / slice.count) }),
      overlapPassed: slice.overlapPassed
    }]))
  };
}

function run() {
  const scenarios = vectorize(corpus);
  const train = scenarios.filter(row => row.split === "train");
  const holdout = scenarios.filter(row => row.split === "holdout");
  const trainingRows = train.flatMap(row => row.candidates);
  const model = new AnswerQualityModel();
  const before = evaluate(model, holdout);
  // Reproducible order, mixed across cases and classes, without random globals.
  let seed = 793;
  for (let epoch = 0; epoch < 12; epoch++) {
    const order = [...trainingRows];
    for (let i = order.length - 1; i > 0; i--) {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const row of order) model.train(row.features, row.helpful);
  }
  return {
    dataset: "Authored fictional evidence and deterministic variants. No networking, user data or checkpoint writes.",
    trainingTopics: train.length,
    holdoutTopics: holdout.length,
    trainingExamples: trainingRows.length,
    holdoutExamples: holdout.reduce((n, row) => n + row.candidates.length, 0),
    optimizerUpdates: model.step,
    before,
    after: evaluate(model, holdout)
  };
}

if (require.main === module) console.log(JSON.stringify(run(), null, 2));
module.exports = { run };
