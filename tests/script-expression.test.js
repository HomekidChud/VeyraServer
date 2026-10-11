"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { rewriteJsText } = require("../src/server");
const samples = [
  'const result = navigator.serviceWorker.register("/worker.js");',
  'async function start(){return navigator.serviceWorker.register("/worker.js")}',
  'async function start(){await navigator.serviceWorker.register("/worker.js")}',
  'const result = Promise.all([navigator.serviceWorker.register("/worker.js")]);',
  'const result = ready ? navigator.serviceWorker.register("/worker.js") : null;',
  'const result = navigator.serviceWorker.register("/worker.js").catch(console.error);',
  'const text = "navigator.serviceWorker.register("; // must stay data',
];
for (const sample of samples) {
  const rewritten = rewriteJsText(sample, "https://example.com/", "test");
  assert.doesNotThrow(() => new vm.Script(rewritten));
  assert.equal(rewritten, sample);
}
console.log("JavaScript expression rewrite: 7 syntax and preservation checks passed.");
