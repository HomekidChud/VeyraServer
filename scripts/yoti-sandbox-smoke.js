"use strict";

const { createYotiSandboxAdapter } = require("./lib/yoti-sandbox-adapter");
const SCENARIOS = ["pending", "pass", "fail"];

async function runSandboxCase({ scenario, ...options }) {
  if (!SCENARIOS.includes(scenario)) throw new Error("Unknown sandbox scenario.");
  const session = await createYotiSandboxAdapter(options).createSession();
  if (scenario !== "pending") await session.setSyntheticResult(scenario);
  const { sandboxOutcome } = await session.readResult();
  if (sandboxOutcome !== scenario) throw new Error("Sandbox result: unexpected outcome.");
}

if (require.main === module) {
  (async () => {
    const credentials = {
      sdkId: process.env.YOTI_SANDBOX_SDK_ID,
      token: process.env.YOTI_SANDBOX_ACCESS_TOKEN,
    };
    for (const scenario of SCENARIOS) {
      await runSandboxCase({ ...credentials, scenario });
      console.log(`Yoti sandbox: synthetic ${scenario} matched.`);
    }
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { runSandboxCase };
