"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runSandboxCase } = require("../scripts/yoti-sandbox-smoke");

const SDK = "198c5cb8-d8d1-4070-97c2-301720fe0ab1";
const SESSION = "813b9f67-de9a-464e-bb46-40b4465c691f";
const BASE = "https://age.yoti.com/sandbox/api/v1/sessions";
const NOW = Date.parse("2026-07-25T20:12:00Z");

function harness({ scenario = "pass", alterSession, alterResult, rejectAt, now } = {}) {
  let reference;
  const calls = [];
  const run = () => runSandboxCase({
    sdkId: SDK,
    token: "synthetic-test-token",
    scenario,
    now: now || (() => NOW),
    async transport(url, options) {
      calls.push([url, options]);
      if (rejectAt === options.method) throw new Error("Untrusted upstream details");
      if (options.method === "POST") {
        reference = JSON.parse(options.body).reference_id;
        const session = { id: SESSION, status: "PENDING", expires_at: new Date(NOW + 900000).toISOString() };
        return Response.json(alterSession ? alterSession(session) : session);
      }
      if (options.method === "PUT") return Response.json({ message: "Response config set successfully" });
      const result = { id: SESSION, reference_id: reference, type: "OVER", status: "FAIL" };
      if (scenario === "pass") Object.assign(result, { status: "COMPLETE", method: "AGE_ESTIMATION", age: 21 });
      return Response.json(alterResult ? alterResult(result) : result);
    },
  });
  return { calls, run };
}

test("sandbox smoke only uses fixed sandbox paths, passive liveness, and dummy ages", async () => {
  const { calls, run } = harness();
  assert.equal(await run(), undefined);
  assert.deepEqual(calls.map(([url, { method }]) => [url, method]), [
    [BASE, "POST"], [`${BASE}/${SESSION}/response-config`, "PUT"], [`${BASE}/${SESSION}/result`, "GET"],
  ]);
  for (const [, options] of calls) {
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer synthetic-test-token");
    assert.equal(options.headers["Yoti-SDK-Id"], SDK);
  }
  const config = JSON.parse(calls[0][1].body);
  assert.equal(config.type, "OVER");
  assert.deepEqual(config.age_estimation, { allowed: true, threshold: 21, level: "PASSIVE", retry_limit: 1 });
  assert.equal(config.doc_scan.allowed, false);
  assert.equal(config.digital_id.allowed, false);
  assert.equal(config.callback, undefined);
  assert.equal(config.notification_url, undefined);
  assert.deepEqual(JSON.parse(calls[1][1].body), { status: "COMPLETE", age: 25, method: "AGE_ESTIMATION" });
});

test("a synthetic threshold failure has no success fields or access decision", async () => {
  const { calls, run } = harness({ scenario: "fail" });
  assert.equal(await run(), undefined);
  assert.deepEqual(JSON.parse(calls[1][1].body), { status: "FAIL", age: 16, method: "AGE_ESTIMATION" });
});

for (const [label, patch] of Object.entries({
  pending: { status: "PENDING" },
  "in progress": { status: "IN_PROGRESS" },
  "threshold failure": { status: "FAIL" },
  cancelled: { status: "CANCELLED" },
  expired: { status: "EXPIRED" },
  error: { status: "ERROR" },
  "unknown state": { status: "NOT_A_DOCUMENTED_STATUS" },
  "wrong session": { id: SDK },
  "old or unrelated reference": { reference_id: SESSION },
  "unapproved method": { method: "DOC_SCAN" },
  "wrong threshold": { age: 18 },
  "exact age instead of threshold": { type: "AGE", age: 25 },
})) {
  test(`rejects ${label} as a synchronous synthetic pass`, async () => {
    await assert.rejects(harness({ alterResult: (r) => ({ ...r, ...patch }) }).run(), /unexpected outcome/);
  });
}

test("refuses a malformed session ID before sending any further requests", async () => {
  const { calls, run } = harness({ alterSession: (r) => ({ ...r, id: "../../api" }) });
  await assert.rejects(run(), /fresh pending session/);
  assert.equal(calls.length, 1);
});

test("rejects an otherwise matching result after local expiry", async () => {
  let clockReads = 0;
  await assert.rejects(harness({ now: () => NOW + clockReads++ * 900000 }).run(), /expired/);
});

test("rejects a provider outage without logging its details", async () => {
  await assert.rejects(harness({ rejectAt: "GET" }).run(), { message: "Sandbox result: transport failed." });
});

test("rejects missing credentials before reaching the network", async () => {
  await assert.rejects(runSandboxCase({ scenario: "pass", transport: () => assert.fail("unexpected request") }),
    /Configure a Yoti sandbox SDK ID/);
});
