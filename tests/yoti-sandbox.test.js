"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runSandboxCase } = require("../scripts/yoti-sandbox-smoke");
const { createYotiSandboxAdapter } = require("../scripts/lib/yoti-sandbox-adapter");
const fixtures = require("./fixtures/yoti-sandbox-results.json");

const SDK = "198c5cb8-d8d1-4070-97c2-301720fe0ab1";
const SESSION = "813b9f67-de9a-464e-bb46-40b4465c691f";
const BASE = "https://age.yoti.com/sandbox/api/v1/sessions";
const NOW = Date.parse("2026-07-25T20:12:00Z");

function harness({ scenario = "pass", alterSession, alterResult, rejectAt, now, initialState = scenario } = {}) {
  let reference;
  let state = initialState;
  const calls = [];
  const options = {
    sdkId: SDK,
    token: "synthetic-test-token",
    now: now || (() => NOW),
    async transport(url, options) {
      calls.push([url, options]);
      if (rejectAt === options.method) throw new Error("Untrusted upstream details");
      if (options.method === "POST") {
        reference = JSON.parse(options.body).reference_id;
        const session = { id: SESSION, status: "PENDING", expires_at: new Date(NOW + 900000).toISOString() };
        return Response.json(alterSession ? alterSession(session) : session);
      }
      if (options.method === "PUT") {
        state = JSON.parse(options.body).status === "FAIL" ? "fail" : "pass";
        return Response.json({ message: "Response config set successfully" });
      }
      const result = { ...fixtures[state], id: SESSION, reference_id: reference };
      return Response.json(alterResult ? alterResult(result) : result);
    },
  };
  return { calls, run: () => runSandboxCase({ ...options, scenario }), options };
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

test("a fresh pending session is only created and read, never mutated or polled automatically", async () => {
  const { calls, run } = harness({ scenario: "pending" });
  assert.equal(await run(), undefined);
  assert.deepEqual(calls.map(([url, { method }]) => [url, method]), [
    [BASE, "POST"], [`${BASE}/${SESSION}/result`, "GET"],
  ]);
});

test("adapter emits only explicit synthetic outcomes, including pending before a later result", async () => {
  for (const scenario of ["pass", "fail"]) {
    const { options } = harness({ initialState: "pending" });
    const session = await createYotiSandboxAdapter(options).createSession();
    assert.deepEqual(await session.readResult(), { sandboxOutcome: "pending" });
    await session.setSyntheticResult(scenario);
    assert.deepEqual(await session.readResult(), { sandboxOutcome: scenario });
  }
});

test("in-progress stays pending even when success fields are present", async () => {
  const { options } = harness({ alterResult: (r) => ({ ...r, status: "IN_PROGRESS" }) });
  const session = await createYotiSandboxAdapter(options).createSession();
  assert.deepEqual(await session.readResult(), { sandboxOutcome: "pending" });
});

test("a pending read still requires the original reference", async () => {
  const { run } = harness({ scenario: "pending", alterResult: (r) => ({ ...r, reference_id: SESSION }) });
  await assert.rejects(run(), /mismatched session/);
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
    await assert.rejects(harness({ alterResult: (r) => ({ ...r, ...patch }) }).run(), /unexpected outcome|mismatched session/);
  });
}

test("refuses a malformed session ID before sending any further requests", async () => {
  const { calls, run } = harness({ alterSession: (r) => ({ ...r, id: "../../api" }) });
  await assert.rejects(run(), /fresh pending session/);
  assert.equal(calls.length, 1);
});

test("rejects an otherwise matching result after local expiry", async () => {
  let clockReads = 0;
  const { calls, run } = harness({ now: () => NOW + (clockReads++ >= 3 ? 900000 : 0) });
  await assert.rejects(run(), /expired/);
  assert.equal(calls.at(-1)[1].method, "GET");
});

test("does not make a read or mock request once the session has expired", async () => {
  let elapsed = 0;
  const { calls, options } = harness({ now: () => NOW + elapsed });
  const session = await createYotiSandboxAdapter(options).createSession();
  elapsed = 900000;
  await assert.rejects(session.readResult(), /expired/);
  await assert.rejects(session.setSyntheticResult("pass"), /expired/);
  assert.equal(calls.length, 1);
});

test("rejects a provider outage without logging its details", async () => {
  await assert.rejects(harness({ rejectAt: "GET" }).run(), { message: "Sandbox result: transport failed." });
});

test("rejects missing credentials before reaching the network", async () => {
  await assert.rejects(runSandboxCase({ scenario: "pass", transport: () => assert.fail("unexpected request") }),
    /Configure a Yoti sandbox SDK ID/);
});
