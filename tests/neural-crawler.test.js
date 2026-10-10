"use strict";
const assert = require("assert");
const { NeuralRobot } = require("../src/services/neural-robots");
const { NeuralCrawlerModel, NUM_FEATURES } = require("../src/services/neural-crawler");

const robot = new NeuralRobot(0, { neuralModel: null });
const relevant = robot.scorePage({ title: "Photosynthesis process", text: "Photosynthesis converts light, water and carbon dioxide into chemical energy.", metadata: {"og:title":"Photosynthesis"}, links: [] }, "photosynthesis", 1);
const irrelevant = robot.scorePage({ title: "Travel guide", text: "Hotels, flights and holiday destinations.", metadata: {}, links: [] }, "photosynthesis", 1);
assert.ok(relevant > irrelevant, `relevant=${relevant} irrelevant=${irrelevant}`);
assert.ok(relevant >= 0 && relevant <= 1);
assert.ok(irrelevant >= 0 && irrelevant <= 1);

const parsed = robot.parseHtml('<html><head><title>Photosynthesis</title></head><body><nav>Navigation menu Add to word list</nav><main><h1>Photosynthesis</h1><p>Plants use light to make food.</p><a href="/biology">Biology</a></main><footer>Cookie settings</footer></body></html>', 'https://example.com/start');
assert.equal(parsed.title, 'Photosynthesis');
assert.equal(parsed.links[0], 'https://example.com/biology');
assert.match(parsed.text, /Plants use light/);
assert.doesNotMatch(parsed.text, /Navigation menu|Add to word list|Cookie settings/);

const model = new NeuralCrawlerModel({ learningRate: 0.01, weightDecay: 0.001 });
const trainingUrl = "https://developer.mozilla.org/en-US/docs/Web/JavaScript";
const before = model.scoreUrl(trainingUrl, { type: "html" });
for (let i = 0; i < 24; i++) model.train({ url: trainingUrl, positive: true, weight: 1, context: { type: "html" } });
assert.ok(model.scoreUrl(trainingUrl, { type: "html" }) > before, "AdamW feedback should improve the selected URL's ranking score");
const checkpoint = model.serialize();
assert.equal(checkpoint.version, 2);
assert.equal(checkpoint.optimizer.name, "AdamW");
assert.equal(checkpoint.optimizer.step, 24);
const restored = new NeuralCrawlerModel();
assert.equal(restored.loadData(checkpoint), true);
assert.equal(restored.optimizerStep, 24);
assert.deepEqual(Array.from(restored.firstMoment), Array.from(model.firstMoment));
assert.deepEqual(Array.from(restored.secondMoment), Array.from(model.secondMoment));
const legacy = new NeuralCrawlerModel();
assert.equal(legacy.loadData({ version: 1, weights: Array(NUM_FEATURES).fill(0.2), bias: 0.1 }), true, "legacy v1 checkpoints remain loadable");
assert.equal(legacy.optimizerStep, 0);
assert.equal(model.report().optimizer.name, "AdamW");
console.log("Neural crawler regression tests passed");
