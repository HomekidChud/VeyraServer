"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { batchFor, createRunner, scheduleAt, start } = require("../scripts/staging-neural-training");
const { trainBaseline, applyStagingBaseline, STAGING_ID, STAGING_DIR } = require("../scripts/staging-ranker-baseline");
const { NeuralCrawlerModel } = require("../src/services/neural-crawler");

async function main() {
  assert.equal(start({ RENDER_SERVICE_ID: "production" }), false);
  assert.equal(start({ RENDER_SERVICE_ID: "srv-dbuqerg8v5cc739sq830", VEYRA_DATA_DIR: "/tmp/veyra-neural-staging", MONGODB_URI: "mongodb://not-staging" }), false);
  assert.equal(scheduleAt(new Date("2026-11-18T13:30:00Z")).inWindow, true);
  assert.equal(scheduleAt(new Date("2026-11-18T14:00:00Z")).inWindow, true, "a free staging instance can catch up after waking late");
  assert.equal(scheduleAt(new Date("2026-07-18T12:30:00Z")).inWindow, true, "the time window follows British Summer Time");
  const batches = Array.from({ length: 36 }, (_, i) => batchFor(i));
  const rotation = batches.flat(2).flatMap(x => x.seeds);
  assert.equal(new Set(rotation).size, 223);
  assert.equal(new Set(batches.flat().map(d => d.name)).size, 12);
  assert(batches.every(day => day.length === 4 && day.every(x => x.seeds.length >= 1 && x.seeds.length <= 3)));
  assert(batches.every(day => day.reduce((n, d) => n + d.seeds.length, 0) <= 12));

  const baseline = trainBaseline(), model = new NeuralCrawlerModel();
  const stage = { RENDER_SERVICE_ID: STAGING_ID, VEYRA_DATA_DIR: STAGING_DIR };
  assert.equal(baseline.accepted, true);
  assert.equal(baseline.report.trainingExamples, 640);
  assert.equal(baseline.report.holdoutExamples, 128);
  assert.equal(applyStagingBaseline(model, { env: { ...stage, RENDER_SERVICE_ID: "production" }, enabled: true }), null);
  assert.equal(applyStagingBaseline(model, { env: stage, enabled: false }), null);
  assert.equal(applyStagingBaseline(model, { env: stage, enabled: true, mongoConfigured: true }), null);
  assert.equal(applyStagingBaseline(model, { env: stage, enabled: true, loaded: true }), null);
  assert.equal(model.trainingExamples, 0);
  assert.deepEqual(applyStagingBaseline(model, { env: stage, enabled: true }), baseline.report);
  assert.equal(model.trainingExamples, baseline.report.optimizerUpdates);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-stage-test-"));
  let date = "2026-11-18T13:20:00Z", enabled = true, queued = 0, trained = 0, crawlCalls = 0, visits = 0;
  const logs = [];
  const options = {
    dataDir, port: 10000, token: "local-fixture-only", now: () => new Date(date), log: x => logs.push(x),
    wait: async () => { trained += queued; queued = 0; },
    fetchImpl: async (url, options) => {
      assert(url.startsWith("http://127.0.0.1:10000/"));
      assert.equal(options.headers["x-veyra-admin-token"], "local-fixture-only");
      if (url.endsWith("/api/neural/stats")) {
        return Response.json({ ok: true, mongo: { configured: false }, trainer: {
          publicCrawlTraining: enabled, fastProxyVisitTraining: enabled, trained, queueSize: queued,
          bySource: { "public-document": Math.max(0, trained - visits), "public-proxy-visit": trained > 0 ? visits : 0, unknown: 100 }
        } });
      }
      if (url.endsWith("/api/neural/staging/fast-proxy-visit")) {
        assert.deepEqual(JSON.parse(options.body), { url: "https://docs.python.org/3/library/keyword.html", publicTraining: true });
        visits++;
        queued++;
        return Response.json({ ok: true, outcome: "queued" });
      }
      assert(url.endsWith("/api/neural/index"));
      const {seeds, maxPages, maxDepth} = JSON.parse(options.body);
      assert(seeds.length <= 3);
      assert.equal(maxPages, seeds.length);
      assert.equal(maxDepth, 1);
      crawlCalls++;
      queued += seeds.length;
      return Response.json({ ok: true, results: seeds.map((_, i) => ({ status: "fulfilled", stats: { pagesCrawled: Number(i !== 0) } })) });
    }
  };
  try {
    const run = createRunner(options);
    await run();
    assert.equal(logs[0].phase, "ready");
    assert.equal(crawlCalls, 0);
    date = "2026-11-18T13:35:00Z";
    await Promise.all([run(), run()]);
    await createRunner(options)();
    assert.equal(crawlCalls, 4, "neither overlapping calls nor a restart on the same disk repeats a batch");
    const report = logs.find(x => x.phase === "batch");
    assert.equal(report.trained, trained);
    assert(report.datasets.every(row => row.completed === row.attempted - 1), "empty or blocked crawls don't count as completed");
    assert.equal(visits, 1, "the daily runner makes just one explicit canary visit");
    assert.equal(report.proxyVisit, "queued");
    assert.equal(report.bySource["public-document"], trained - 1);
    assert.equal(report.bySource["public-proxy-visit"], 1);
    assert.equal(report.bySource["public-dead-end"], 0);
    assert(!Object.hasOwn(report.bySource, "unknown"));
    assert(!JSON.stringify(logs).includes("local-fixture-only"));
    assert(!JSON.stringify(logs).includes("https://"));
    enabled = false;
    date = "2026-11-19T13:35:00Z";
    await run();
    assert.equal(crawlCalls, 4, "disabled flag prevents the next batch");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log("Staging daily rotation, source aggregates and isolation checks passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
