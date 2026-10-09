"use strict";
const assert = require("assert");
const { AIAnswerEngine, extractReadable, evidenceText, normalizeUrl } = require("../src/services/ai-answer");

const noisy = `<!doctype html><html><head><title>Hi - Dictionary</title><script>alert(1)</script></head><body>
<header>Navigation menu Sign in</header><main><h1>hi</h1><button>Add to word list</button><p>Hi is an informal greeting used to say hello.</p><p>Hi is an informal greeting used to say hello.</p><div>Audio player Play pronunciation</div></main><footer>Related words Social media</footer></body></html>`;
const extracted = extractReadable(noisy, "https://dictionary.example/hi");
assert.match(extracted.text, /informal greeting/i);
assert.doesNotMatch(extracted.text, /Add to word list|Audio player|Navigation menu|Social media/i);
assert.equal(extracted.duplicateRatio > 0, true);
assert.equal(normalizeUrl("https://example.com/a/?utm_source=x#part"), "https://example.com/a");
assert.equal(evidenceText("window.__CONFIG__ = {}; Add to word list"), "");

const engine = new AIAnswerEngine();
const evidence = engine.buildEvidence("What is hi?", engine.detectIntent("What is hi?"), [
  { url: "https://cambridge.example/hi", title: "Cambridge Dictionary", sourceIdentity: "cambridge.example", rank: 1, extractionQuality: 1, sentences: ["Hi is an informal greeting used to say hello."] },
  { url: "https://copy.example/hi", title: "Copied page", sourceIdentity: "copy.example", rank: 2, extractionQuality: 1, sentences: ["Hi is an informal greeting used to say hello."] },
  { url: "https://merriam.example/hi", title: "Merriam-Webster", sourceIdentity: "merriam.example", rank: 3, extractionQuality: 1, sentences: ["Hi is a friendly way to greet someone."] }
], []);
assert.equal(evidence.length, 2, "near-identical evidence must not count as independent");
assert.equal(evidence[0].id, "S1");
const local = engine.localSynthesis("What is hi?", engine.detectIntent("What is hi?"), evidence);
assert.ok(local.sourceIds.length >= 2, "local synthesis should combine independent evidence when available");
const verified = engine.verifyAnswer(local.answer, evidence);
assert.equal(verified.unsupported, 0);
const quality = engine.evidenceQuality(evidence, evidence.slice(0, 1), verified, engine.detectIntent("What is hi?"));
assert.ok(quality.score >= 0 && quality.score <= 1);
assert.match(quality.label, /evidence|verify/i);
console.log("AI answer regression tests passed");
