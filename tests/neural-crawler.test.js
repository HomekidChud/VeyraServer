"use strict";
const assert = require("assert");
const { NeuralRobot } = require("../src/services/neural-robots");

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
console.log("Neural crawler regression tests passed");
