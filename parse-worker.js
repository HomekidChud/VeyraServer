"use strict";
// Worker-thread entry: loads server.js in "thread worker" mode (no listener,
// no timers, no pools) and exposes its pure rewrite / discovery functions.
const { parentPort } = require("worker_threads");
process.env.VEYRA_THREAD_WORKER = "1";
const server = require("./server");
const ops = server.__workerOps;

parentPort.on("message", msg => {
  const { id, op, args = [], bytes } = msg || {};
  try {
    const fn = ops[op];
    if (!fn) throw new Error(`unknown op ${op}`);
    const text = bytes ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8") : undefined;
    const result = fn(text, ...args);
    if (typeof result === "string") {
      const out = Buffer.from(result, "utf8");
      const ab = new ArrayBuffer(out.length); const view = new Uint8Array(ab); view.set(out);
      parentPort.postMessage({ id, ok: true, bytes: view }, [ab]);
    } else parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e?.message || String(e) });
  }
});
