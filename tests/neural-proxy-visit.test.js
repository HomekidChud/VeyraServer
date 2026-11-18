"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createProxyVisitTrainer, allowsTraining, publicVisitUrl } = require("../src/services/neural-proxy-visit");
const { createPublicCrawlTrainer, responseTrainingPolicy } = require("../src/services/neural-training-data");
const { NeuralCrawlerModel } = require("../src/services/neural-crawler");
const { NeuralLearningWorker } = require("../src/services/neural-learning");
const stage = require("../scripts/staging-ranker-baseline");

const url = "https://docs.python.org/3/library/keyword.html";
const other = "https://nodejs.org/api/stream.html";
const a = "The reference document explains each argument with a concrete example and describes the expected result. ".repeat(4);
const b = "A second confirmation shows the allowed options and the default behavior for the application. ".repeat(4);
const html = `<title>Reference guide</title><main><h1>Overview</h1><p>${a}</p><p>${b}</p></main>`;
const robots = "User-agent: *\nDisallow: /private/\n";
const classify = (target, content, type, headers) => ({
  status: 200, finalUrl: target, contentType: type, body: Buffer.from(content), trainingPolicy: responseTrainingPolicy(new Headers(headers))
});

async function unit() {
  const prod = { RENDER_SERVICE_ID: "prod", VEYRA_DATA_DIR: stage.STAGING_DIR };
  const nonMongo = { ...prod, RENDER_SERVICE_ID: stage.STAGING_ID };
  assert.equal(stage.stagingIsolation(prod), false);
  assert.equal(stage.stagingIsolation(nonMongo, true), false);
  assert.equal(stage.stagingIsolation({ ...nonMongo, MONGO_URI: "mongodb://fixture" }), false);
  assert.equal(stage.stagingIsolation(nonMongo), true);
  for (const target of [`${url}?`, `${url}#`, `${url}?token=x`, `${url}#heading`, url.replace("https:", "http:"),
    url.replace("docs.python.org", "localhost"), url.replace("keyword.html", "%6beyword.html"),
    url.replace("keyword.html", "profile/details"), url.replace("keyword.html", "bundle.js"),
    url.replace("keyword.html", "../keyword.html")]) assert.equal(publicVisitUrl(target), null, target);
  assert(publicVisitUrl(url));
  assert(publicVisitUrl(other));
  assert.equal(allowsTraining("User-agent: *\nDisallow: /*/keyword.html$", "/3/library/keyword.html"), false);
  assert.equal(allowsTraining("User-agent: *\nDisallow: /*/keyword.html$", "/3/library/keyword.html/other"), true);
  assert.equal(allowsTraining("User-agent: First\nDisallow: /3/\nUser-agent: *\nAllow: /3/", "/3/library/keyword.html"), false);
  assert.equal(allowsTraining("User-agent: *\nDisallow: /%33/", "/3/library/keyword.html"), false);
  assert.equal(allowsTraining("<html>not a policy</html>", "/3/library/keyword.html"), false);
  assert.equal(allowsTraining(robots, "/3/library/keyword.html"), true);

  const model = new NeuralCrawlerModel(), worker = new NeuralLearningWorker({ model });
  const learn = createPublicCrawlTrainer({ model, enqueue: row => worker.enqueue(row) });
  const requests = [];
  let enabled = false;
  const visit = createProxyVisitTrainer({ enabled: () => enabled, learn, fetchPage: async (target, opts) => {
    requests.push(target);
    assert.equal(opts.maxRedirects, 0);
    assert.equal(opts.retries, 0);
    assert.equal(opts.headers, undefined);
    assert.equal(opts.sessionId, undefined);
    assert(opts.signal instanceof AbortSignal);
    if (target.endsWith("/robots.txt")) return classify(target, robots, "text/plain");
    return classify(target, html, "text/html");
  } });
  assert.equal(await visit(url), "disabled");
  enabled = true;
  assert.equal(await visit(`${url}?token=secret`), "unsupported");
  assert.deepEqual(requests, []);
  assert.deepEqual(await Promise.all([visit(url), visit(other)]), ["queued", "limited"]);
  assert.equal(await visit(url), "duplicate");
  assert.deepEqual(requests, ["https://docs.python.org/robots.txt", url]);
  assert.equal(await learn({ requestedUrl: url, fetchedUrl: url, status: 200, page: { title: "Guide", text: a + b, headings: ["Header"], passages: [a, b] },
    robotsVerified: true, ...responseTrainingPolicy(new Headers()) }), false, "scheduled crawls cannot duplicate a visit");
  const row = worker.queue[0];
  assert.equal(row.source, "public-proxy-visit");
  assert.equal(row.weight, 0.15);
  assert.doesNotMatch(JSON.stringify(row), /docs\.python|keyword|reference|secret/i);
  assert.equal(worker.processBatch(), 1);
  assert.equal(worker.report().bySource["public-proxy-visit"], 1);

  for (const [stage, change, expectedFetches] of [
    ["robots", r => ({ ...r, status: 404 }), 1],
    ["robots", r => ({ ...r, body: Buffer.from("User-agent: *\nDisallow: /*.html$") }), 1],
    ["robots", r => ({ ...r, redirectChain: ["redirect"] }), 1],
    ["page", r => ({ ...r, status: 404 }), 2],
    ["page", r => ({ ...r, contentType: "application/json" }), 2],
    ["page", r => ({ ...r, contentDisposition: "attachment" }), 2],
    ["page", r => ({ ...r, cacheHit: true }), 2],
    ["page", r => ({ ...r, truncated: true }), 2],
    ["page", r => ({ ...r, trainingPolicy: responseTrainingPolicy(new Headers({ "set-cookie": "fixture=1" })) }), 2],
    ["page", r => ({ ...r, trainingPolicy: responseTrainingPolicy(new Headers({ vary: "Authorization" })) }), 2],
    ["page", r => ({ ...r, trainingPolicy: responseTrainingPolicy(new Headers({ "cache-control": "private, no-store" })) }), 2],
    ["page", r => ({ ...r, trainingPolicy: responseTrainingPolicy(new Headers({ "x-robots-tag": "Veyra: noai" })) }), 2],
    ["page", r => ({ ...r, body: Buffer.from(`<meta name="robots" content="noindex"><meta name="robots" content="index">${html}`) }), 2],
    ["page", r => ({ ...r, body: Buffer.from(`<input type="PASSWORD">${html}`) }), 2],
    ["page", r => ({ ...r, body: Buffer.from(`<title>Just a moment</title>${html}`) }), 2],
    ["page", r => ({ ...r, body: Buffer.alloc(524289) }), 2]
  ]) {
    let requests = 0;
    const sample = createProxyVisitTrainer({ enabled: () => true, learn: async () => { assert.fail("ineligible result cannot train"); },
      fetchPage: async target => {
        requests++;
        const isRobots = target.endsWith("/robots.txt");
        const r = isRobots ? classify(target, robots, "text/plain") : classify(target, html, "text/html");
        return stage === (isRobots ? "robots" : "page") ? change(r) : r;
      } });
    assert.equal(await sample(url), "ineligible");
    assert.equal(requests, expectedFetches);
  }
  const budget = createProxyVisitTrainer({ enabled: () => true, learn, fetchPage: async () => { throw Error("offline"); } });
  for (let i = 0; i < 4; i++) assert.equal(await budget(url.replace("keyword", `sample-${i}`)), i < 3 ? "unavailable" : "limited");
}

async function routes() {
  const dir = mkdtempSync(join(tmpdir(), "veyra-proxy-stage-test-"));
  const key = "1".repeat(64);
  const originalLookup = require("node:dns").promises.lookup;
  const originalIsolation = stage.stagingIsolation;
  process.env.VEYRA_DATA_DIR = dir;
  process.env.VEYRA_ADMIN_TOKEN = key;
  process.env.NEURAL_PUBLIC_CRAWL_TRAINING = process.env.NEURAL_FAST_PROXY_VISIT_TRAINING = "true";
  delete process.env.MONGODB_URI;
  delete process.env.MONGO_URI;
  writeFileSync(join(dir, "access-policy.json"), JSON.stringify({ mode: "staff", waitlistOpen: false, testMode: false, revision: 1 }));
  // Simulate the staging identity with a temporary directory, without
  // touching the real fixed staging path or using any deployed credentials.
  stage.stagingIsolation = (env, mongo) => env.VEYRA_DATA_DIR === dir && !mongo;
  require("node:dns").promises.lookup = async () => [{ address: "151.101.0.223", family: 4 }];
  const { app, accessGate } = require("../src/server");
  let upstream = 0;
  app.locals.veyraTrainingUpstream = async (target, opts) => {
    upstream++;
    for (const forbidden of ["cookie", "authorization", "x-veyra-admin-token", "referer"]) assert.equal(opts.headers.has(forbidden), false);
    assert.equal(opts.redirect, "manual");
    if (target.endsWith("/robots.txt")) return new Response(robots, { headers: { "content-type": "text/plain" } });
    if (target === other) return new Response(null, { status: 302, headers: { location: url } });
    return new Response(html, { headers: { "content-type": "text/html" } });
  };
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (body, headers = {}, qs = "") => fetch(base + "/api/neural/staging/fast-proxy-visit" + qs, {
      method: "POST", headers: { "content-type": "application/json", "x-veyra-admin-token": key, ...headers }, body: JSON.stringify(body)
    });
    const payload = { publicTraining: true, url };
    assert.equal((await request(payload, { "x-veyra-admin-token": "invalid" })).status, 403);
    for (const candidate of [{ url }, { ...payload, publicTraining: false }, { ...payload, sid: "existing" }, { ...payload, incognito: true }]) {
      assert.equal((await request(candidate)).status, 400);
    }
    for (const header of ["cookie", "authorization", "proxy-authorization", "origin", "referer"]) {
      assert.equal((await request(payload, { [header]: "private-context" })).status, 400);
    }
    assert.equal((await request(payload, {}, "?sid=existing")).status, 400);
    assert.equal((await request({ ...payload, url: `${url}?token=secret` })).status, 400);
    assert.equal(upstream, 0);
    const first = await request(payload);
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.deepEqual(await first.json(), { ok: true, outcome: "queued" });
    assert.deepEqual(await (await request(payload)).json(), { ok: true, outcome: "duplicate" });
    assert.deepEqual(await (await request({ ...payload, url: other })).json(), { ok: true, outcome: "ineligible" });
    assert.equal(upstream, 4, "a redirect does not create another upstream request");
    const stats = await (await fetch(base + "/api/neural/stats", { headers: { "x-veyra-admin-token": key } })).json();
    assert.equal(stats.trainer.fastProxyVisitTraining, true);
    assert.equal(stats.trainer.queueSize, 1);
    accessGate.policy.state.mode = "public";
    assert.equal((await request(payload)).status, 404);
    assert.equal(upstream, 4);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    require("node:dns").promises.lookup = originalLookup;
    stage.stagingIsolation = originalIsolation;
    rmSync(dir, { recursive: true, force: true });
  }
}

unit().then(routes).then(() => console.log("Fast Proxy staging visits: opt-in, isolation, proxy transport, publisher policy, queue and dedup passed"))
  .catch(error => { console.error(error); process.exitCode = 1; });
