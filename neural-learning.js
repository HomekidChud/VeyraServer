"use strict";

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
    this.timer = null;
    this.running = false;
    this.stats = { queued: 0, trained: 0, dropped: 0, batches: 0, lastBatchAt: null, lastError: null };
  }

  normalize(feedback) {
    const url = String(feedback?.url || "").trim();
    if (!/^https?:\/\//i.test(url) || feedback?.accepted === false) return null;
    return {
      id: String(feedback.id || `nf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`),
      url, positive: !!feedback.positive,
      weight: Math.max(0.05, Math.min(5, Number(feedback.weight) || 1)),
      context: feedback.context && typeof feedback.context === "object" ? feedback.context : {},
      queuedAt: Number(feedback.queuedAt || Date.now())
    };
  }
  enqueue(feedback) {
    const item = this.normalize(feedback);
    if (!item) return false;
    if (this.queue.length >= this.maxQueue) { this.queue.shift(); this.stats.dropped += 1; }
    this.queue.push(item);
    this.stats.queued = this.queue.length;
    return true;
  }
  async enqueuePersistent(feedback) {
    const item = this.normalize(feedback);
    if (!item) return false;
    if (this.persistence?.connected && this.persistence.enqueueNeuralFeedback) {
      const stored = await this.persistence.enqueueNeuralFeedback(item);
      if (!stored) this.log("warn", "NEURAL", "Mongo feedback write failed; queued in memory only.");
    }
    return this.enqueue(item);
  }

  processBatch() {
    if (this.running || !this.queue.length) return 0;
    this.running = true;
    let trained = 0;
    try {
      const batch = this.queue.splice(0, this.batchSize);
      for (const feedback of batch) {
        this.model.train(feedback); trained += 1;
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
    return { running: !!this.timer, intervalMs: this.intervalMs, batchSize: this.batchSize, queueSize: this.queue.length, ...this.stats };
  }
}

module.exports = { NeuralLearningWorker };
