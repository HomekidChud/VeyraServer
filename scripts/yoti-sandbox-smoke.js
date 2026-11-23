"use strict";

const { randomUUID } = require("node:crypto");

const BASE = "https://age.yoti.com/sandbox/api/v1/sessions";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SDK_ID = /^[a-zA-Z0-9_-]{14,40}$/;
const TEST_THRESHOLD = 21;
const TEST_TTL_SECONDS = 900;
const METHOD = "AGE_ESTIMATION";
const FIXTURES = {
  pass: { status: "COMPLETE", age: 25 },
  fail: { status: "FAIL", age: 16 },
};

// Developer-only smoke test. Never import into an HTTP route or publish an access decision.
async function runSandboxCase({ sdkId, token, scenario, transport = fetch, now = Date.now }) {
  if (!SDK_ID.test(sdkId || "") || typeof token !== "string" || !/^[a-zA-Z0-9._~+/-]+=*$/.test(token)) {
    throw new Error("Configure a Yoti sandbox SDK ID and OAuth bearer with the avs scope.");
  }
  if (!Object.hasOwn(FIXTURES, scenario)) throw new Error("Unknown sandbox scenario.");

  async function request(step, method, url, body) {
    let res;
    try {
      res = await transport(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Yoti-SDK-Id": sdkId,
        },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(`Sandbox ${step}: transport failed.`);
    }
    if (!res.ok) throw new Error(`Sandbox ${step}: HTTP ${res.status}.`);
    try {
      const value = await res.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      throw new Error(`Sandbox ${step}: invalid JSON object.`);
    }
  }

  const reference = randomUUID();
  const session = await request("create", "POST", BASE, {
    type: "OVER",
    ttl: TEST_TTL_SECONDS,
    age_estimation: { allowed: true, threshold: TEST_THRESHOLD, level: "PASSIVE", retry_limit: 1 },
    digital_id: { allowed: false },
    doc_scan: { allowed: false },
    credit_card: { allowed: false },
    mobile: { allowed: false },
    yoti_key: { allowed: false },
    reference_id: reference,
  });
  const expiry = Date.parse(session.expires_at);
  if (session.status !== "PENDING" || typeof session.id !== "string" || !UUID.test(session.id) ||
      !Number.isFinite(expiry) || expiry <= now()) {
    throw new Error("Sandbox create: expected a fresh pending session.");
  }

  const mock = FIXTURES[scenario];
  const url = `${BASE}/${session.id}`;
  await request("mock", "PUT", `${url}/response-config`, { ...mock, method: METHOD });
  const result = await request("result", "GET", `${url}/result`);
  // For OVER, the documented result's age is the threshold, not the estimate.
  // A failed check may omit success fields; do not infer success from any age value.
  if (expiry <= now() || result.id !== session.id || result.reference_id !== reference ||
      result.type !== "OVER" || result.status !== mock.status ||
      (scenario === "pass" && (result.method !== METHOD || result.age !== TEST_THRESHOLD))) {
    throw new Error("Sandbox result: expired, mismatched or unexpected outcome.");
  }
  // No raw response, session identifiers, credentials, age claim, or production proof leaves this runner.
}

if (require.main === module) {
  (async () => {
    const credentials = {
      sdkId: process.env.YOTI_SANDBOX_SDK_ID,
      token: process.env.YOTI_SANDBOX_ACCESS_TOKEN,
    };
    for (const scenario of ["pass", "fail"]) {
      await runSandboxCase({ ...credentials, scenario });
      console.log(`Yoti sandbox: synthetic ${scenario} matched.`);
    }
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { runSandboxCase };
