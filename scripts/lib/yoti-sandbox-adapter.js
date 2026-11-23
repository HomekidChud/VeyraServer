"use strict";

const { randomUUID } = require("node:crypto");

const BASE = "https://age.yoti.com/sandbox/api/v1/sessions";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SDK_ID = /^[a-zA-Z0-9_-]{14,40}$/;
const TEST_THRESHOLD = 21;
const TEST_TTL_SECONDS = 900;
const METHOD = "AGE_ESTIMATION";
const MOCK_CONFIG = {
  pass: { status: "COMPLETE", age: 25 },
  fail: { status: "FAIL", age: 16 },
};

// Developer tooling only. No production endpoint, signer, or access decision.
function createYotiSandboxAdapter({ sdkId, token, transport = fetch, now = Date.now }) {
  if (!SDK_ID.test(sdkId || "") || typeof token !== "string" || !/^[a-zA-Z0-9._~+/-]+=*$/.test(token)) {
    throw new Error("Configure a Yoti sandbox SDK ID and OAuth bearer with the avs scope.");
  }
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

  async function createSession() {
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
    const expiry = typeof session.expires_at === "string" ? Date.parse(session.expires_at) : NaN;
    if (session.status !== "PENDING" || typeof session.id !== "string" || !UUID.test(session.id) ||
        !Number.isFinite(expiry) || expiry <= now()) {
      throw new Error("Sandbox create: expected a fresh pending session.");
    }
    const url = `${BASE}/${session.id}`;
    function requireFresh() {
      if (expiry <= now()) throw new Error("Sandbox session: expired.");
    }

    return Object.freeze({
      async setSyntheticResult(scenario) {
        if (!Object.hasOwn(MOCK_CONFIG, scenario)) throw new Error("Use a fresh session for a pending result.");
        requireFresh();
        await request("mock", "PUT", `${url}/response-config`, { ...MOCK_CONFIG[scenario], method: METHOD });
      },
      async readResult() {
        requireFresh();
        const result = await request("result", "GET", `${url}/result`);
        requireFresh();
        if (result.id !== session.id || result.reference_id !== reference || result.type !== "OVER") {
          throw new Error("Sandbox result: mismatched session.");
        }
        // OVER returns the threshold, not the estimate. Only COMPLETE can map to a synthetic pass.
        if (result.status === "COMPLETE" && result.method === METHOD && result.age === TEST_THRESHOLD) {
          return { sandboxOutcome: "pass" };
        }
        if (result.status === "FAIL") return { sandboxOutcome: "fail" };
        if (result.status === "PENDING" || result.status === "IN_PROGRESS") {
          return { sandboxOutcome: "pending" };
        }
        throw new Error("Sandbox result: unexpected outcome.");
      },
    });
  }
  return Object.freeze({ createSession });
}

module.exports = { createYotiSandboxAdapter };
