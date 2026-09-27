"use strict";
// Config system, session manager, worker pool and crawl scheduler tests.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let passed = 0;
const check = async (name, fn) => { await fn(); passed += 1; console.log(`ok - ${name}`); };
const tmp = (name, body) => { const f = path.join(os.tmpdir(), `veyra-${process.pid}-${name}`); fs.writeFileSync(f, body); return f; };

(async () => {
  const config = require("./config");

  await check("config: every Render plan resolves and caps grow with the plan", () => {
    for (const key of Object.keys(config.RENDER_PLANS)) assert.strictEqual(config.resolvePlanName(key), key);
    assert.strictEqual(config.resolvePlanName("Pro Plus"), "pro_plus");
    assert.strictEqual(config.resolvePlanName("nope"), null);
    const free = config.capsFor(512, 0.1), std = config.capsFor(2048, 1), pro = config.capsFor(4096, 2), big = config.capsFor(32768, 8);
    assert.strictEqual(free.parseWorkers, 0, "no worker threads on 512 MB");
    assert.strictEqual(free.maxActiveJobs, 1);
    assert.ok(std.maxActiveJobs > free.maxActiveJobs && pro.maxActiveJobs > std.maxActiveJobs && big.maxActiveJobs >= pro.maxActiveJobs);
    assert.ok(pro.parseWorkers >= 2 && big.parseWorkers > pro.parseWorkers);
    assert.ok(pro.maxActiveFetches > std.maxActiveFetches);
  });

  await check("config: precedence real env > environments.<env> > file env > plan", () => {
    const file = tmp("prec.json", JSON.stringify({ plan: "standard", env: { MAX_ACTIVE_JOBS: 5, CRAWL_QUEUE_MAX: 9 }, environments: { production: { env: { MAX_ACTIVE_JOBS: 7 } } } }));
    const c = config.loadConfig({ env: { VEYRA_ENV: "production" }, file });
    assert.strictEqual(c.plan.key, "standard");
    assert.strictEqual(c.envDefaults.MAX_ACTIVE_JOBS, "7");
    assert.strictEqual(c.envDefaults.CRAWL_QUEUE_MAX, "9");
    const target = { MAX_ACTIVE_JOBS: "2" };
    config.applyToProcessEnv(c, target);
    assert.strictEqual(target.MAX_ACTIVE_JOBS, "2", "a real env var always wins");
    assert.strictEqual(target.CRAWL_QUEUE_MAX, "9");
    assert.strictEqual(c.applied.CRAWL_QUEUE_MAX, "veyra.config.json env");
    const c2 = config.loadConfig({ env: { VEYRA_PLAN: "pro" }, file });
    assert.strictEqual(c2.plan.key, "pro");
    assert.strictEqual(c2.planSource, "VEYRA_PLAN");
    fs.unlinkSync(file);
  });

  await check("config: caps overrides, custom plans and validation errors", () => {
    const file = tmp("caps.json", JSON.stringify({ plan: "mybox", plans: { mybox: { ramMb: 3072, cpu: 1.5, caps: { maxActiveJobs: 4 } } }, caps: { parseWorkers: 3 } }));
    const c = config.loadConfig({ env: {}, file });
    assert.strictEqual(c.plan.key, "mybox");
    assert.strictEqual(c.caps.maxActiveJobs, 4);
    assert.strictEqual(c.caps.parseWorkers, 3);
    assert.ok(config.validateConfig({ plan: 5 }).errors.length);
    assert.ok(config.validateConfig({ caps: { maxActiveJobs: -1 } }).errors.length);
    assert.ok(config.validateConfig({ env: { A: { nested: true } } }).errors.length);
    assert.strictEqual(config.validateConfig({ plan: "pro", env: { A: 1 }, caps: { parseWorkers: 2 } }).errors.length, 0);
    const bad = tmp("bad.json", "{ not json");
    const cb = config.loadConfig({ env: {}, file: bad });
    assert.ok(cb.errors.length, "broken JSON is reported, not fatal");
    fs.unlinkSync(file); fs.unlinkSync(bad);
  });

  await check("config: CLI `plan` updates veyra.config.json and render.yaml", () => {
    const yaml = tmp("render.yaml", "services:\n  - type: web\n    name: veyra\n    plan: free\n    env: node\n");
    assert.strictEqual(config.setPlanInRenderYaml("pro", yaml), true);
    assert.match(fs.readFileSync(yaml, "utf8"), /plan: pro\n/);
    const f = tmp("save.json", "{}");
    config.saveRawFile({ plan: "standard", env: {}, caps: {} }, f);
    assert.strictEqual(JSON.parse(fs.readFileSync(f, "utf8")).plan, "standard");
    assert.throws(() => config.saveRawFile({ plan: 3 }, f));
    fs.unlinkSync(yaml); fs.unlinkSync(f);
  });

  await check("config: publicSummary masks secrets", () => {
    const file = tmp("secret.json", JSON.stringify({ env: { VEYRA_ADMIN_TOKEN: "super-secret-token-123", VPN_PROXY_PASSWORD: "pw123456" } }));
    const s = JSON.stringify(config.publicSummary(config.loadConfig({ env: {}, file })));
    assert.ok(!s.includes("super-secret-token-123") && !s.includes("pw123456"));
    fs.unlinkSync(file);
  });

  const { SessionManager } = require("./session-manager");
  await check("sessions: LRU cap, idle expiry, hooks, pressure shedding", async () => {
    let t = 1_000_000;
    const expired = [];
    const m = new SessionManager({ maxSessions: 3, idleTtlMs: 60_000, serverIdleMs: 0, now: () => t });
    m.on("expire", (sid, rec, reason) => expired.push(`${sid}:${reason}`));
    m.touch("a"); t += 1; m.touch("b"); t += 1; m.touch("c"); t += 1; m.touch("a"); t += 1; m.touch("d");
    assert.deepStrictEqual([...m.sessions.keys()], ["c", "a", "d"], "least-recently-used 'b' evicted");
    assert.ok(expired.includes("b:cap"));
    t += 61_000; m.touch("d");
    assert.strictEqual(await m.sweep(), 2, "c and a idle-expired");
    assert.deepStrictEqual([...m.sessions.keys()], ["d"]);
    m.touch("e"); t += 130_000; m.touch("f");
    assert.strictEqual(m.shed("pressure"), 2);
    assert.deepStrictEqual([...m.sessions.keys()], ["f"]);
    assert.strictEqual(m.close("f"), true);
    assert.strictEqual(m.size ?? m.sessions.size, 0);
  });

  await check("sessions: cookie jar trimmed to the byte budget", () => {
    const m = new SessionManager({ maxCookieBytes: 4096, serverIdleMs: 0 });
    const rec = m.touch("x");
    for (let i = 0; i < 100; i++) rec.cookies.set(`c${i}`, { name: `c${i}`, value: "v".repeat(200), domain: "example.com", path: "/" });
    m.trimCookies(rec);
    let bytes = 0; for (const c of rec.cookies.values()) bytes += String(c.name).length + String(c.value).length + 40;
    assert.ok(rec.cookies.size < 100 && bytes <= 4096 + 400, `trimmed to ${rec.cookies.size}`);
    assert.ok(rec.cookies.has("c99"), "newest cookies kept");
  });

  await check("sessions: server idle mode sleeps once and wakes on activity", async () => {
    let t = 0, sleeps = 0, wakes = 0;
    const m = new SessionManager({ serverIdleMs: 1000, now: () => t });
    m.on("sleep", () => { sleeps++; }).on("wake", () => { wakes++; });
    t = 500; await m.sweep(); assert.strictEqual(m.sleeping, false);
    t = 2000; await m.sweep(); await m.sweep();
    assert.strictEqual(m.sleeping, true); assert.strictEqual(sleeps, 1);
    m.activity(); assert.strictEqual(m.sleeping, false); assert.strictEqual(wakes, 1);
  });

  // Server-backed checks (worker parity + crawl scheduler).
  process.env.MAX_ACTIVE_JOBS = "2";
  process.env.CRAWL_QUEUE_MAX = "3";
  process.env.CRAWLER_PARSE_WORKERS = "2";
  process.env.INDEX_SEED_CRAWL = "false";
  process.env.SERVER_LOG_LEVEL = "error";
  const server = require("./server");
  const { WorkerPool } = require("./worker-pool");

  await check("worker pool: rewrite + discovery results identical to inline", async () => {
    const pool = new WorkerPool({ size: 2, taskTimeoutMs: 20000 });
    await new Promise(r => setTimeout(r, 300));
    const base = "https://www.example.com/dir/page.html";
    const sid = "sessWorkerParity0001";
    const html = `<!doctype html><html><head><link rel=stylesheet href="/a.css"><script src="app.js"></script></head><body><a href="/x?y=1">x</a><img srcset="a.png 1x, b.png 2x"><form action="/s"><input name=q></form><style>.a{background:url(/bg.png)}</style>${"<p>filler text</p>".repeat(3000)}</body></html>`;
    const css = `@import "/base.css"; .x{background:url('../img/y.png')} @font-face{src:url(f.woff2)}`;
    const js = `import("./chunk.js"); fetch("/api/v1/items"); const u = new URL("/p", location.href);`;
    const ops = server.__workerOps;
    assert.strictEqual(await pool.run("rewriteHtml", [base, sid], html), ops.rewriteHtml(html, base, sid));
    assert.strictEqual(await pool.run("rewriteCss", [base, sid], css), ops.rewriteCss(css, base, sid));
    assert.strictEqual(await pool.run("rewriteJs", [base, sid], js), ops.rewriteJs(js, base, sid));
    assert.deepStrictEqual(await pool.run("discover", ["html", base, "text/html"], html), ops.discover(html, "html", base, "text/html"));
    // Parallel burst.
    const outs = await Promise.all(Array.from({ length: 12 }, (_, i) => pool.run("rewriteCss", [base, sid], css + `/*${i}*/`)));
    assert.strictEqual(outs.length, 12);
    assert.strictEqual(pool.report().stats.completed, 16);
    await pool.close();
  });

  await check("worker pool: hung task times out and the worker is replaced", async () => {
    const script = tmp("hang-worker.js", `const { parentPort } = require("worker_threads"); parentPort.on("message", m => { if (m.op === "hang") { for(;;){} } parentPort.postMessage({ id: m.id, ok: true, result: "pong" }); });`);
    const pool = new WorkerPool({ size: 1, taskTimeoutMs: 400, script });
    await assert.rejects(pool.run("hang", []), /timed out/);
    await new Promise(r => setTimeout(r, 400));
    assert.strictEqual(await pool.run("ping", []), "pong");
    assert.ok(pool.report().stats.restarts >= 1);
    await pool.close(); fs.unlinkSync(script);
  });

  await check("crawl scheduler: runs MAX_ACTIVE_JOBS at once, queues the rest, rejects when full", async () => {
    assert.strictEqual(server.CFG.maxActiveJobs, 2);
    const made = [];
    const mk = (seed) => { const j = server.createJob("https://unreachable.invalid/"); server.jobs.set(j.id, j); made.push(j); return server.scheduleCrawl(j, { seed }); };
    assert.strictEqual(mk(false), "running");
    assert.strictEqual(mk(false), "running");
    assert.strictEqual(mk(true), "queued");
    assert.strictEqual(mk(false), "queued");
    assert.strictEqual(server.crawlQueue[0], made[3], "user crawls jump ahead of background seed crawls");
    mk(false);
    assert.throws(() => mk(false), e => e.code === "CRAWLER_CAPACITY_BUSY");
    assert.ok(server.activeCrawlCount() <= 2);
    // Abandoned crawls (nobody polling) are stopped.
    made[0].lastPolledAt = 0;
    server.sweepAbandonedCrawls();
    assert.strictEqual(made[0].stopReason, "abandoned");
    for (const j of made) { j.stopRequested = true; try { j.controller?.abort(); } catch {} }
  });

  await server.workerPool?.close();
  console.log(`\n${passed} capacity checks passed.`);
  process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
