"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setImmediate: flush } = require("node:timers/promises");
const { NeuralCrawlerModel, NUM_FEATURES } = require("../src/services/neural-crawler");
const { NeuralLearningWorker } = require("../src/services/neural-learning");
const { createPublicCrawlTrainer, responseTrainingPolicy, classifyCrawlObservation, trainingFeatures, trainingUrl } = require("../src/services/neural-training-data");
const { NeuralRobotPool } = require("../src/services/neural-robots");
const { AcquisitionManager } = require("../src/services/acquisition-manager");
const { MongoStore } = require("../src/core/mongo-store");
const { TRAIN_TOPICS, HOLDOUT_TOPICS, run, runDataset, main } = require("../scripts/evaluate-neural-training");

const url = "https://docs.python.org/3/library/overview.html";
const dead = "https://docs.python.org/3/library/old-reference.html";
const missing = "https://docs.python.org/3/library/missing.html";
const p1 = "A sample documentation paragraph explains the required concepts, points to an example and describes the expected result. ".repeat(3);
const p2 = "A second sample paragraph adds an explanation of different parameters and lists the recommended approaches for this fixture. ".repeat(3);
const headers = new Headers({ "content-type": "text/html", "cache-control": "public, max-age=120" });
const goodPage = { title: "Reference guide", text: p1 + p2, headings: ["Overview"], passages: [p1, p2], metadata: {} };
const observation = { requestedUrl: url, fetchedUrl: url, status: 200, page: goodPage, robotsVerified: true, ...responseTrainingPolicy(headers) };

async function verify() {
  assert.equal(classifyCrawlObservation(observation).source, "public-document");
  assert.equal(classifyCrawlObservation({ ...observation, status: 410, requestedUrl: dead, fetchedUrl: dead }).positive, false);
  for (const changed of [
    { requestedUrl: url + "?token=private" }, { fetchedUrl: "https://docs.python.org.evil.invalid/3/library/" },
    { fetchedUrl: "https://docs.python.org/3/private/session" }, { requestedUrl: url.replace("https:", "http:") },
    { fetchedUrl: "https://nodejs.org/api/path.html" }, { status: 429 }, { status: 503 },
    { status: 404, fetchedUrl: missing }, { fetchedUrl: missing }, { redirected: true }, { cached: true },
    { setCookie: true }, { headerInformation: false }, { robotsVerified: false },
    { cacheControl: "private" }, { cacheControl: "no-store" }, { robots: "noindex" }, { challenge: true },
    { page: { ...goodPage, metadata: { robots: "noai" } } }, { page: { ...goodPage, title: "Just a moment…" } },
    { page: { ...goodPage, text: "Not enough" } }, { page: { ...goodPage, passages: [p1, p1] } }
  ]) assert.equal(classifyCrawlObservation({ ...observation, ...changed }), null, JSON.stringify(changed));
  assert.equal(responseTrainingPolicy(new Headers({ vary: "Accept-Encoding, Cookie" })).setCookie, true);
  for (const bad of ["http://127.0.0.1/x", "http://[::1]/x", "https://u:p@docs.python.org/3/", "http://printer.local/", "file:///tmp/a"]) {
    assert.equal(trainingUrl(bad), null);
  }
  for (const bad of [Array(NUM_FEATURES).fill(Infinity), Array(NUM_FEATURES).fill("0.5"), Array(NUM_FEATURES).fill(-0.1), Array(NUM_FEATURES), []]) {
    assert.equal(trainingFeatures(bad), null);
  }

  const model = new NeuralCrawlerModel();
  const writes = [];
  const storage = new MongoStore({ uri: "" });
  storage.connected = true;
  storage.withDb = async cb => cb({ collection(name) { return { async updateOne(_filter, update) { if (update.$setOnInsert) writes.push({ name, doc: update.$setOnInsert }); } }; } });
  const worker = new NeuralLearningWorker({ model, persistence: storage, batchSize: 3 });
  let time = 0;
  const enqueue = createPublicCrawlTrainer({ model, enqueue: row => worker.enqueuePersistent(row), clock: () => time, perHost: 1, globalLimit: 2 });
  assert.equal(await enqueue(observation), true);
  assert.equal(await enqueue(observation), false, "duplicate public URL must not train twice");
  const deadEnd = { ...observation, status: 410, requestedUrl: dead, fetchedUrl: dead };
  assert.equal(await enqueue(deadEnd), false, "publisher budget must be honored");
  time += 3_600_000;
  assert.equal(await enqueue(deadEnd), true);
  assert.equal(await enqueue(observation), false, "dedup survives a change in hourly budget");
  assert.equal(await worker.enqueuePersistent({ url: `${url}?password=example#fragment`, positive: true, source: "browser-feedback", weight: 999, context: { query: "unrelated private text" } }), true);
  assert.equal(await worker.enqueuePersistent({ url, positive: "false" }), false);
  assert.equal(worker.processBatch(), 3);
  assert.deepEqual(worker.report().bySource, { "public-document": 1, "public-dead-end": 1, "browser-feedback": 1 });
  assert.equal(model.optimizerStep, 3);
  assert.equal(model.report().domainCount, 0);
  assert.equal(writes.length, 6, "both existing collections receive only the feature representation");
  for (const { doc } of writes) {
    assert.ok(doc.features.length === NUM_FEATURES);
    assert.doesNotMatch(JSON.stringify(doc), /docs\.python\.org|password|fragment|private text/);
    assert.ok(doc.expiresAt instanceof Date);
  }
  const legacy = worker.normalize({ url: url + "?legacy=1", positive: false, context: { query: "do not retain" } });
  assert.equal(legacy.source, "legacy-feedback");
  assert.equal(Object.hasOwn(legacy, "url"), false);
  assert.equal(Object.hasOwn(legacy, "context"), false);
  assert.equal(worker.normalize({ url, positive: false, context: { type: "ai-result" } }), null, "old unselected-result labels are no longer learned");
  const filters = [];
  const reader = new MongoStore({ uri: "" });
  reader.withDb = async cb => cb({ collection() { return { find(filter) {
    filters.push(filter);
    return { sort: () => ({ limit: () => ({ toArray: async () => [] }) }) };
  } }; } });
  await reader.loadQueuedNeuralFeedback(100);
  await reader.loadQueuedNeuralFeedback(100, { publicCrawlTraining: true });
  assert.deepEqual(filters, [
    { status: "queued", "context.type": { $ne: "ai-result" }, source: { $nin: ["public-document", "public-dead-end"] } },
    { status: "queued", "context.type": { $ne: "ai-result" } }
  ], "the flag also gates resuming queued public examples");

  const sampleBudget = createPublicCrawlTrainer({ model, enqueue: async () => true, clock: () => 1 });
  for (let i = 0; i < 3; i++) {
    const removed = new URL(`removed-${i}.html`, dead).href;
    assert.equal(await sampleBudget({ ...deadEnd, requestedUrl: removed, fetchedUrl: removed }), i < 2);
  }
  const sharedBudget = createPublicCrawlTrainer({ model, enqueue: async () => true, clock: () => 1, globalLimit: 1 });
  assert.equal(await sharedBudget(observation), true);
  const otherHost = "https://nodejs.org/api/path.html";
  assert.equal(await sharedBudget({ ...observation, requestedUrl: otherHost, fetchedUrl: otherHost }), false, "global budget spans publishers");

  const claims = [];
  const robotsBlocked = "https://docs.python.org/3/library/blocked.html";
  const redirected = "https://docs.python.org/3/library/redirect.html";
  const unverifiedHost = "https://nodejs.org/api/path.html";
  const requests = [];
  const fetcher = new AcquisitionManager({ assertPublicUrl: async () => {}, fetchImpl: async pathname => {
    requests.push(pathname);
    if (pathname === "https://docs.python.org/robots.txt") return new Response("User-agent: *\nDisallow: /3/library/blocked.html\n", { headers: { "content-type": "text/plain" } });
    if (pathname === "https://nodejs.org/robots.txt") return new Response("Unavailable", { status: 503, headers });
    if (pathname === dead) return new Response("Gone", { status: 410, headers });
    if (pathname === redirected) return new Response(null, { status: 302, headers: { location: missing } });
    return new Response(`<title>Reference</title><main><h1>Overview</h1><p>${p1}</p><p>${p2}</p></main>`, { status: 200, headers });
  } });
  const pool = new NeuralRobotPool({
    maxWorkers: 1,
    fetchPage: (target, opts) => fetcher.fetch(target, { ...opts, skipRobots: new URL(target).pathname === "/robots.txt", retries: 0, observeCrawlResponses: true }),
    onCrawlObservation: sample => { claims.push(classifyCrawlObservation(sample)?.source); }
  });
  await pool.startCrawl([url], "not an input to training", { maxPages: 1 });
  await pool.startCrawl([dead], "not an input to training", { maxPages: 1 });
  for (const target of [url, robotsBlocked, redirected, unverifiedHost]) {
    await pool.startCrawl([target], "not an input to training", { maxPages: 1 });
  }
  await flush();
  assert.deepEqual(claims, ["public-document", "public-dead-end"], "only fresh, direct 200 and 410 outcomes with verified robots policy qualify");
  assert.ok(!requests.includes(robotsBlocked));

  const cap = new NeuralLearningWorker({ model: new NeuralCrawlerModel(), maxQueue: 100, persistence: { connected: true, enqueueNeuralFeedback: () => flush(true) } });
  const burst = await Promise.all(Array.from({ length: 140 }, () => cap.enqueuePersistent({ url, positive: true })));
  assert.equal(burst.filter(Boolean).length, 100);
  assert.equal(cap.queue.length, 100);
  assert.equal(cap.report().dropped, 40);

  assert.ok(!TRAIN_TOPICS.some(topic => HOLDOUT_TOPICS.includes(topic)));
  const evaluation = run();
  assert.equal(evaluation.trainingExamples, 160);
  assert.equal(evaluation.holdoutExamples, 48);
  assert.ok(evaluation.after.logLoss < evaluation.before.logLoss);
  assert.ok(evaluation.after.pairAccuracy > evaluation.before.pairAccuracy);

  const examplePair = (split, publisher, topic) => ({
    split, publisher, topic, rights: "owned", rightsReference: "approval-internal-fixture",
    useful: { url: `https://${publisher}.example.org/docs/tutorial/reference`, internal: true },
    deadEnd: { url: `https://${publisher}.example.org/archive/legacy/old/missing`, internal: false }
  });
  const splitData = { schemaVersion: 1, datasetId: "synthetic-import-test", pairs: [
    examplePair("train", "train-publisher", "transit"),
    examplePair("holdout", "holdout-publisher", "weather")
  ] };
  const { checkpoint: candidate, report } = runDataset(splitData);
  assert.equal(report.optimizerUpdates, 10);
  assert.equal(report.holdoutExamples, 2);
  assert.equal(new NeuralCrawlerModel().loadData(candidate), true);
  assert.doesNotMatch(JSON.stringify(candidate), /example\.org|approval-internal-fixture|holdout-publisher/);
  for (const change of [
    { publisher: "train-publisher" }, { topic: "transit" }, { rights: "publicly-visible" }, { rightsReference: "" },
    { deadEnd: { url: "https://train-publisher.example.org/a", internal: false } },
    { deadEnd: { url: "https://holdout-publisher.example.org/?token=private", internal: false } },
    { deadEnd: splitData.pairs[1].useful }
  ]) assert.throws(() => runDataset({ ...splitData, pairs: [splitData.pairs[0], { ...splitData.pairs[1], ...change }] }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-offline-training-"));
  try {
    const input = path.join(dir, "dataset.json"), output = path.join(dir, "v1.candidate.json");
    fs.writeFileSync(input, JSON.stringify(splitData));
    assert.equal(main(["--dataset", input]).candidateWritten, false);
    assert.equal(fs.existsSync(output), false);
    assert.equal(main(["--dataset", input, "--candidate-out", output]).candidateWritten, true);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).offlineTraining.datasetId, splitData.datasetId);
    assert.throws(() => main(["--dataset", input, "--candidate-out", output]), { code: "EEXIST" });
    assert.throws(() => main(["--dataset", input, "--candidate-out", path.join(dir, "neural-model.json")]), /live checkpoint/);
    assert.throws(() => main(["--candidate-out", output]), /requires a permissioned/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("Neural training sources, private/noindex filtering, durable feature rows, concurrency budget and offline holdout passed");
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
