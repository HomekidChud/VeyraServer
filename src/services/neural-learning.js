"use strict";

const { randomUUID } = require("node:crypto");
const { SOURCES, trainingUrl, trainingFeatures } = require("./neural-training-data");

/**
 * Bounded background trainer for Veyra's lightweight relevance model.
 * This is online ranking learning, not foundation-model retraining.
 */
class NeuralLearningWorker {
  constructor({ model, intervalMs = 5000, batchSize = 32, maxQueue = 5000, persistence = null, modelId = "default", log = () => {} } = {}) {
    if (!model || typeof model.train !== "function") throw new Error("A trainable neural model is required.");
    this.model = model;
    this.intervalMs = Math.max(250, Number(intervalMs) || 5000);
    this.batchSize = Math.max(1, Number(batchSize) || 32);
    this.maxQueue = Math.max(100, Number(maxQueue) || 5000);
    this.persistence = persistence;
    this.modelId = String(modelId || "default");
    this.log = log;
    this.queue = [];
    this.pending = 0;
    this.timer = null;
    this.running = false;
    this.stats = { queued: 0, trained: 0, dropped: 0, batches: 0, lastBatchAt: null, lastError: null };
    this.bySource = Object.create(null);
  }

  normalize(feedback) {
    if (typeof feedback?.positive !== "boolean" || feedback.accepted === false || feedback.context?.type === "ai-result") return null;
    const source = Object.hasOwn(SOURCES, feedback.source) ? feedback.source : "legacy-feedback";
    let features;
    if (feedback.features !== undefined) features = trainingFeatures(feedback.features);
    else {
      const url = trainingUrl(feedback.url);
      if (!url) return null;
      url.search = ""; url.hash = "";
      const raw = this.model.extractFeatures(url.href, { type: "html" });
      if (typeof this.model.baseAuthority === "function") raw[0] = this.model.baseAuthority(url.href);
      raw[8] = 0.5; raw[9] = 0.5;
      features = trainingFeatures(raw);
    }
    if (!features) return null;
    const weight = typeof feedback.weight === "number" && Number.isFinite(feedback.weight) && feedback.weight > 0 ? feedback.weight : 1;
    return {
      id: typeof feedback.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(feedback.id) ? feedback.id : `nf_${randomUUID()}`,
      features, positive: feedback.positive, source,
      weight: Math.max(0.05, Math.min(SOURCES[source], weight))
    };
  }
  hasRoom() {
    if (this.queue.length + this.pending < this.maxQueue) return true;
    this.stats.dropped += 1;
    return false;
  }
  enqueueNormalized(item) {
    this.queue.push(item);
    this.stats.queued = this.queue.length;
    return true;
  }
  enqueue(feedback) {
    const item = this.normalize(feedback);
    return !!item && this.hasRoom() && this.enqueueNormalized(item);
  }
  async enqueuePersistent(feedback) {
    const item = this.normalize(feedback);
    if (!item || !this.hasRoom()) return false;
    this.pending += 1;
    try {
      if (this.persistence?.connected && this.persistence.enqueueNeuralFeedback) {
        const stored = await this.persistence.enqueueNeuralFeedback(item);
        if (!stored) this.log("warn", "NEURAL", "Mongo feedback write failed; queued in memory only.");
      }
      return this.enqueueNormalized(item);
    } catch {
      this.log("warn", "NEURAL", "Mongo feedback write failed; queued in memory only.");
      return this.enqueueNormalized(item);
    } finally { this.pending -= 1; }
  }

  processBatch() {
    if (this.running || !this.queue.length) return 0;
    this.running = true;
    let trained = 0;
    try {
      const batch = this.queue.splice(0, this.batchSize);
      for (const feedback of batch) {
        if (this.model.train(feedback) !== false) {
          trained += 1;
          this.bySource[feedback.source] = (this.bySource[feedback.source] || 0) + 1;
        }
        if (feedback.id && this.persistence?.markNeuralFeedbackProcessed) void this.persistence.markNeuralFeedbackProcessed(feedback.id);
      }
      this.stats.trained += trained;
      this.stats.batches += 1;
      this.stats.lastBatchAt = new Date().toISOString();
      this.stats.queued = this.queue.length;
      this.stats.lastError = null;
      this.model.save?.();
      if (this.persistence?.saveNeuralModel) void this.persistence.saveNeuralModel(this.modelId, this.model.serialize?.() || null);
      return trained;
    } catch (e) {
      this.stats.lastError = e?.message || String(e);
      this.log("warn", "NEURAL", `Background training batch failed: ${this.stats.lastError}`);
      return trained;
    } finally { this.running = false; }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.processBatch(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.queue.length) this.processBatch();
    this.model.save?.();
    if (this.persistence?.saveNeuralModel) await this.persistence.saveNeuralModel(this.modelId, this.model.serialize?.() || null);
  }

  report() {
    return { running: !!this.timer, intervalMs: this.intervalMs, batchSize: this.batchSize, queueSize: this.queue.length, ...this.stats, bySource: { ...this.bySource } };
  }
}

module.exports = { NeuralLearningWorker };
