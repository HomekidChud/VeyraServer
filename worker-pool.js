"use strict";
// Worker-thread pool for CPU-heavy work (HTML/JS/CSS rewriting for the proxy
// and link discovery / index extraction for the crawlers). Keeps the main
// event loop free so page loads stay fast while several crawlers run.
//
// Size comes from CRAWLER_PARSE_WORKERS (plan preset). 0 = run inline.
// Large text is sent as transferable bytes (zero-copy). Hung or crashed
// workers are replaced automatically; callers fall back to inline work on
// any pool error so a worker problem never breaks a request.

const path = require("path");
const { Worker } = require("worker_threads");

function toTransferable(text) {
  const buf = Buffer.from(String(text), "utf8");
  // Buffer.from(string) may use the shared pool slab — copy into our own
  // ArrayBuffer so transferring it can't detach anybody else's memory.
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return new Uint8Array(ab);
}

class WorkerPool {
  constructor(opts = {}) {
    this.size = Math.max(0, opts.size | 0);
    this.script = opts.script || path.join(__dirname, "parse-worker.js");
    this.taskTimeoutMs = opts.taskTimeoutMs || 20000;
    this.maxQueue = opts.maxQueue || 200;
    this.heapMb = opts.heapMb || 0;
    this.log = opts.log || (() => {});
    this.workers = [];
    this.queue = [];
    this.pending = new Map();
    this.seq = 0;
    this.stats = { completed: 0, failed: 0, timeouts: 0, restarts: 0, inlineFallbacks: 0, queuedPeak: 0 };
    this.closed = false;
    for (let i = 0; i < this.size; i++) this.spawn(i);
  }
  get enabled() { return this.size > 0 && !this.closed && this.workers.some(w => w && w.ready !== false); }
  spawn(index) {
    const resourceLimits = this.heapMb ? { maxOldGenerationSizeMb: this.heapMb } : undefined;
    const worker = new Worker(this.script, { resourceLimits, env: { ...process.env, VEYRA_THREAD_WORKER: "1" } });
    const slot = { worker, busy: null, index, ready: true, done: 0 };
    worker.unref();
    worker.on("message", msg => this.onMessage(slot, msg));
    worker.on("error", e => { this.log("warn", "WORKERS", `Worker ${index} error: ${e.message}`); });
    worker.on("exit", code => {
      if (this.workers[index] !== slot) return;
      if (slot.busy) this.finish(slot, { id: slot.busy.id, ok: false, error: `worker exited (${code})` });
      if (!this.closed) { this.stats.restarts += 1; this.spawn(index); }
    });
    this.workers[index] = slot;
    this.drain();
  }
  onMessage(slot, msg) {
    if (!msg || typeof msg.id !== "number") return;
    this.finish(slot, msg);
  }
  finish(slot, msg) {
    const task = this.pending.get(msg.id);
    if (slot.busy && slot.busy.id === msg.id) slot.busy = null;
    if (task) {
      this.pending.delete(msg.id);
      clearTimeout(task.timer);
      if (msg.ok) {
        this.stats.completed += 1;
        let result = msg.result;
        if (msg.bytes) result = Buffer.from(msg.bytes.buffer, msg.bytes.byteOffset, msg.bytes.byteLength).toString("utf8");
        task.resolve(result);
      } else { this.stats.failed += 1; task.reject(new Error(msg.error || "worker task failed")); }
    }
    this.drain();
  }
  run(op, args = [], text = null) {
    if (!this.enabled) return Promise.reject(Object.assign(new Error("worker pool disabled"), { code: "POOL_DISABLED" }));
    if (this.queue.length >= this.maxQueue) { this.stats.inlineFallbacks += 1; return Promise.reject(Object.assign(new Error("worker pool queue full"), { code: "POOL_BUSY" })); }
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const task = { id, op, args, text, resolve, reject, timer: null };
      this.pending.set(id, task);
      this.queue.push(task);
      this.stats.queuedPeak = Math.max(this.stats.queuedPeak, this.queue.length);
      this.drain();
    });
  }
  drain() {
    for (const slot of this.workers) {
      if (!slot || slot.busy || !this.queue.length) continue;
      const task = this.queue.shift();
      if (!this.pending.has(task.id)) continue;
      slot.busy = task;
      task.timer = setTimeout(() => {
        this.stats.timeouts += 1;
        this.log("warn", "WORKERS", `Worker ${slot.index} timed out on ${task.op}; restarting it.`);
        this.finish(slot, { id: task.id, ok: false, error: "worker task timed out" });
        slot.worker.terminate().catch(() => {});
      }, this.taskTimeoutMs);
      task.timer.unref?.();
      const msg = { id: task.id, op: task.op, args: task.args };
      const transfer = [];
      if (task.text != null) { msg.bytes = toTransferable(task.text); transfer.push(msg.bytes.buffer); }
      task.text = null;
      try { slot.worker.postMessage(msg, transfer); } catch (e) { this.finish(slot, { id: task.id, ok: false, error: e.message }); }
    }
  }
  report() {
    return { size: this.size, busy: this.workers.filter(w => w?.busy).length, queued: this.queue.length, taskTimeoutMs: this.taskTimeoutMs, heapMbPerWorker: this.heapMb || null, stats: { ...this.stats } };
  }
  async close() {
    this.closed = true;
    for (const t of this.pending.values()) { clearTimeout(t.timer); t.reject(new Error("pool closed")); }
    this.pending.clear(); this.queue = [];
    await Promise.all(this.workers.map(w => w?.worker.terminate().catch(() => {})));
  }
}

module.exports = { WorkerPool };
