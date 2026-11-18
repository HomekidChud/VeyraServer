"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { batchFor, createRunner, scheduleAt, start } = require("../scripts/staging-neural-training");

async function main() {
  assert.equal(start({ RENDER_SERVICE_ID: "production" }), false);
  assert.equal(start({ RENDER_SERVICE_ID: "srv-dbuqerg8v5cc739sq830", VEYRA_DATA_DIR: "/tmp/veyra-neural-staging", MONGODB_URI: "mongodb://not-staging" }), false);
  assert.equal(scheduleAt(new Date("2026-11-18T13:30:00Z")).inWindow, true);
  assert.equal(scheduleAt(new Date("2026-11-18T14:00:00Z")).inWindow, false);
  assert.equal(scheduleAt(new Date("2026-07-18T12:30:00Z")).inWindow, true, "the time window follows British Summer Time");
  const batches = Array.from({ length: 8 }, (_, i) => batchFor(i));
  const rotation = batches.flat(2).flatMap(x => x.seeds);
  assert.equal(rotation.length, 90);
  assert.equal(new Set(rotation).size, 90);
  assert(batches.every(day => day.every(x => x.seeds.length <= 4)));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-stage-test-"));
  let date = "2026-11-18T13:20:00Z", enabled = true, queued = 0, trained = 0, crawlCalls = 0;
  const logs = [];
  const options = {
    dataDir, port: 10000, token: "local-fixture-only", now: () => new Date(date), log: x => logs.push(x),
    wait: async () => { trained += queued; queued = 0; },
    fetchImpl: async (url, options) => {
      assert(url.startsWith("http://127.0.0.1:10000/"));
      assert.equal(options.headers["x-veyra-admin-token"], "local-fixture-only");
      if (url.endsWith("/api/neural/stats")) {
        return Response.json({ ok: true, mongo: { configured: false }, trainer: {
          publicCrawlTraining: enabled, trained, queueSize: queued, bySource: { "public-document": trained, unknown: 100 }
        } });
      }
      assert(url.endsWith("/api/neural/index"));
      const {seeds, maxPages, maxDepth} = JSON.parse(options.body);
      assert(seeds.length <= 4);
      assert.equal(maxPages, seeds.length);
      assert.equal(maxDepth, 1);
      crawlCalls++;
      queued += seeds.length;
      return Response.json({ ok: true, results: seeds.map(() => ({ status: "fulfilled" })) });
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
    assert.equal(crawlCalls, 3, "neither overlapping calls nor a restart on the same disk repeats a batch");
    const report = logs.find(x => x.phase === "batch");
    assert.equal(report.trained, trained);
    assert.equal(report.bySource["public-document"], trained);
    assert.equal(report.bySource["public-dead-end"], 0);
    assert(!Object.hasOwn(report.bySource, "unknown"));
    assert(!JSON.stringify(logs).includes("local-fixture-only"));
    assert(!JSON.stringify(logs).includes("https://"));
    enabled = false;
    date = "2026-11-19T13:35:00Z";
    await run();
    assert.equal(crawlCalls, 3, "disabled flag prevents the next batch");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log("Staging daily rotation, source aggregates and isolation checks passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
