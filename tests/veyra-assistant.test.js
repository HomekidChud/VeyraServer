"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AssistantError, AssistantFeedbackStore, VeyraAssistant } = require("../src/services/veyra-assistant");

const replies = [
  { draft: "First independent draft.", assumptions: ["No external browsing"], risks: ["Context may be incomplete"] },
  { draft: "Second independent draft.", assumptions: ["Question is bounded"], risks: ["Avoid overstating evidence"] },
  { answer: "A concise verified response.", caveats: ["Only user-approved context was considered."], nextSteps: ["Provide more evidence if a fact check is needed."], evidenceStatus: "user-provided-context" }
];
let calls = 0;
const assistant = new VeyraAssistant({
  apiKey: "test-key",
  apiBase: "https://ai.example.test/v1",
  model: "gpt-5-mini",
  fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(replies[calls++]) } }] }) })
});

(async () => {
  assert.equal(assistant.status().available, true);
  await assert.rejects(
    assistant.ask({ question: "Use this", context: { selectedText: "Sensitive text" }, consent: { sendPageContext: false } }, { id: "user-1" }),
    error => error instanceof AssistantError && error.code === "ASSISTANT_CONTEXT_CONSENT_REQUIRED"
  );
  const result = await assistant.ask({
    question: "Help me plan safely.",
    context: { url: "https://example.test", title: "Example", selectedText: "Only this approved text is shared." },
    consent: { sendPageContext: true }
  }, { id: "user-1" });
  assert.equal(calls, 3);
  assert.equal(result.workflow.agents.length, 3);
  assert.equal(result.context.included, true);
  assert.equal(result.context.automaticPageAccess, false);
  assert.match(result.answer, /verified response/i);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-assistant-feedback-"));
  const feedback = new AssistantFeedbackStore({ dataDir: temp, retentionMs: 24 * 60 * 60 * 1000 });
  assert.equal(feedback.record({ user: { id: "user-1" }, taskId: result.taskId, question: "Private question", rating: "helpful", trainingConsent: false }).stored, false);
  const saved = feedback.record({ user: { id: "user-1" }, taskId: result.taskId, question: "Approved question", rating: "helpful", note: "Useful", trainingConsent: true });
  assert.equal(saved.stored, true);
  assert.equal(feedback.status().automaticModelTraining, false);
  fs.rmSync(temp, { recursive: true, force: true });
  console.log("Veyra Assistant regression tests passed");
})().catch(error => { console.error(error); process.exit(1); });
