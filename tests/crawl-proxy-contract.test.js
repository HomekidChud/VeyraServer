"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { mkdtempSync } = require("node:fs");
const { rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { setTimeout: wait } = require("node:timers/promises");

const workDir = mkdtempSync(join(tmpdir(), "veyra-crawl-contract-"));
delete process.env.MONGODB_URI;
Object.assign(process.env, {
  VEYRA_DATA_DIR: join(workDir, "data"), VEYRA_WORK_DIR: join(workDir, "jobs"),
  GATE_ENABLED: "false", ACCESS_GATE: "0", VEYRA_CHROMIUM_ENABLED: "false",
  SEARCH_PROVIDER: "local", MAX_ACTIVE_JOBS: "1", CRAWLER_ROBOTS: "64",
  VEYRA_USER_AGENT: "VeyraBrowseCrawler/1.0"
});
const { app, jobs, createJob, scheduleCrawl, fetchBuffer, robotsAllowed } = require("../src/server");

const fixture = "https://93.184.216.34"; // Literal public IP; every network response is stubbed.
const cdn = "https://assets.veyra-fixture.test";
const entries = [];
const dateRetry = "Sat, 21 Nov 2026 18:00:00 GMT";
const html = (body = "") => `<!doctype html><title>Crawl fixtures</title><main>${body}</main>`;
const anchors = paths => paths.map(path => `<a href="${path}">${path}</a>`).join("");
const reply = (url, text, contentType = "text/plain", status = 200, extra = {}) => {
  const body = Buffer.from(text);
  return { status, ok: status >= 200 && status < 300, finalUrl: url, body, bytes: body.length,
    contentType, contentLength: String(body.length), cacheControl: "no-store", redirectChain: [], ...extra };
};
function jobAt(url) {
  const job = createJob(url);
  jobs.set(job.id, job);
  scheduleCrawl(job);
  return job;
}
async function until(predicate, message) {
  const deadline = Date.now() + 8000;
  while (!predicate() && Date.now() < deadline) await wait(10);
  assert.ok(predicate(), message);
}

test("proxy and crawler HTTP contracts", { timeout: 30000 }, async () => {
  let policyStatus = 200;
  const pages = ["/one", "/two", "/three", "/four", "/five", "/six"];
  const robots = [
    "User-agent: *", "Disallow: /public",
    "User-agent: Veyra", "Disallow: /hidden-a", "Disallow: /private$", "Disallow: /blocked/",
    "User-agent: Veyra", "Disallow: /hidden-b", "Disallow: /sitemap_index.xml", "Disallow: /encoded~", "Allow: /blocked/ok.js"
  ].join("\n");
  app.locals.veyraProxyFetchBuffer = async (url, options) => {
    const u = new URL(url), p = u.pathname;
    assert.ok([fixture, cdn].includes(u.origin), "no outside network");
    entries.push([u.origin, p, options.method || "GET"]);
    if (p === "/robots.txt") {
      return u.origin === cdn ? reply(url, "User-agent: *\nDisallow: /blocked.js") : reply(url, robots, "text/plain", policyStatus);
    }
    if (p === "/sitemap.xml") {
      await wait(160, null, { signal: options.signal });
      return reply(url, `<urlset><url><loc>${fixture}/late</loc></url></urlset>`, "application/xml");
    }
    if (p === "/root") return reply(url, html(anchors([...pages, "/private", "/private-guide", "/hidden-a", "/hidden-b", "/encoded~", "/public", "/missing"])
      + `<script src="/blocked/never.js"></script><script src="/blocked/ok.js"></script>
        <script src="${cdn}/blocked.js"></script><script src="${cdn}/ok.js"></script>`), "text/html");
    if (p === "/slow") { await wait(10000, null, { signal: options.signal }); }
    if (p === "/api/limited") return reply(url, '{"rate":"limited"}', "application/json", 429, { retryAfter: dateRetry });
    if (p === "/api/example") return reply(url, '{"fixture":true}', "application/json", 200, options.method === "OPTIONS" ? { allow: "GET, HEAD, OPTIONS" } : {});
    if (p.endsWith(".js")) return reply(url, `// ${url}`, "application/javascript");
    if (p === "/missing") return reply(url, "not found", "text/plain", 404);
    if (pages.includes(p)) await wait(50, null, { signal: options.signal });
    return reply(url, html(`Captured path: ${p}`), "text/html");
  };
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = (path, opts) => fetch(base + path, { signal: AbortSignal.timeout(5000), ...opts });
  const post = (path, body) => http(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const state = async job => (await http(`/api/crawl/${job.id}`)).json();
  try {
    const malformed = await http("/api/open", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, "INVALID_REQUEST_BODY");
    const oversized = await post("/api/open", { url: "x".repeat(300 * 1024) });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).code, "REQUEST_BODY_TOO_LARGE");

    const proxyUrl = (type, path = "/api/example") => `/api/${type}?${new URLSearchParams({ url: fixture + path })}`;
    const preflight = await http(proxyUrl("resource"), { method: "OPTIONS", headers: {
      Origin: "http://localhost:10000", "Access-Control-Request-Method": "PATCH"
    } });
    assert.equal(preflight.status, 204);
    assert.equal(entries.length, 0);
    const options = await http(proxyUrl("resource"), { method: "OPTIONS", headers: { Origin: "http://localhost:10000" } });
    assert.equal(options.status, 200);
    assert.equal(options.headers.get("access-control-allow-origin"), "http://localhost:10000");
    assert.equal(options.headers.get("allow"), "GET, HEAD, OPTIONS");
    assert.deepEqual(entries.at(-1), [fixture, "/api/example", "OPTIONS"]);
    await options.arrayBuffer();
    const download = await http(proxyUrl("download"));
    assert.match(download.headers.get("content-disposition"), /^attachment;/i);
    assert.equal(await download.text(), '{"fixture":true}');
    const rate = await http(proxyUrl("resource", "/api/limited"));
    assert.equal(rate.status, 429);
    assert.equal(rate.headers.get("retry-after"), dateRetry);
    await rate.arrayBuffer();

    const open = url => post("/api/open", { url, engineMode: "exhaustive" });
    const accepted = await open(fixture + "/slow");
    assert.equal(accepted.status, 202);
    const running = await accepted.json();
    assert.deepEqual([running.state, running.scheduler, running.queuePosition], ["running", "running", 0]);
    assert.deepEqual(await (await open(fixture + "/slow")).json(), running);
    const queued = await (await open(fixture + "/root")).json();
    assert.deepEqual([queued.state, queued.scheduler, queued.queuePosition], ["queued", "queued", 1]);
    assert.deepEqual(await (await open(fixture + "/root")).json(), queued);
    await until(() => entries.some(([, path]) => path === "/slow"), "slow fetch began");
    assert.equal((await post(`/api/crawl/${running.jobId}/stop`, {})).status, 200);
    const stopped = jobs.get(running.jobId);
    await until(() => stopped.done, "running crawl settled after cancellation");
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.counts.errors, 0);
    assert.ok(!stopped.logs.some(row => row.message?.includes("Fetch failed")));

    const job = jobs.get(queued.jobId);
    await until(() => job.done, "queued crawl ran and captured its resources");
    assert.equal(job.status, "done");
    assert.equal(job.robotPool, null, "completed job releases its worker objects without intervention");
    assert.ok(job.finalRobotReport.summary.logicalRobots > 0);
    assert.equal(job.counts.errors, 1, "only the missing page counts as an error");
    assert.equal(job.pendingSourceFiles, 0);
    const { resources } = await (await http(`/api/crawl/${job.id}/resources`)).json();
    assert.deepEqual(resources.map(row => row.id), resources.map((_, index) => index));
    assert.ok(resources.some(row => row.url === `${fixture}/late`), "late sitemap work is waited on");
    assert.ok(resources.some(row => row.url === `${fixture}/private-guide`), "the end anchor isn't a prefix");
    assert.ok(resources.some(row => row.url === `${fixture}/public`), "an unrelated wildcard group isn't applied");
    assert.ok(resources.some(row => row.url === `${fixture}/blocked/ok.js`), "longer allow rule wins");
    assert.ok(resources.some(row => row.url === `${cdn}/ok.js`));
    for (const row of resources) {
      const source = await (await http(`/api/crawl/${job.id}/source/${row.id}`)).json();
      assert.equal(source.url, row.url);
      if (pages.includes(new URL(row.url).pathname)) assert.ok(source.source.includes(`Captured path: ${new URL(row.url).pathname}`));
    }
    for (const [origin, path] of [[fixture, "/hidden-a"], [fixture, "/hidden-b"], [fixture, "/private"],
      [fixture, "/encoded~"], [fixture, "/blocked/never.js"], [fixture, "/sitemap_index.xml"], [cdn, "/blocked.js"]]) {
      assert.ok(!entries.some(([requestedOrigin, requestedPath]) => requestedOrigin === origin && requestedPath === path), `${origin}${path} must not be fetched`);
    }
    assert.equal(entries.filter(([origin, path]) => origin === cdn && path === "/robots.txt").length, 1);
    await (await post(`/api/crawl/${job.id}/stop`, {})).json();
    assert.equal((await state(job)).status, "done", "stopping a finished crawl leaves it unchanged");

    for (const status of [503, 429, 403]) {
      policyStatus = status;
      const deferred = jobAt(fixture + `/not-during-${status}`);
      await until(() => deferred.done, "unreachable robots settles the crawl");
      assert.equal(deferred.status, "deferred");
      assert.ok(!entries.some(([, path]) => path === `/not-during-${status}`));
    }
  } finally {
    for (const row of jobs.values()) if (!row.done) { row.stopRequested = true; row.controller.abort(); }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await until(() => [...jobs.values()].every(row => row.done), "all fixtures stopped");
    await rm(workDir, { recursive: true, force: true });
  }
});

test("robots wildcards, encoded paths and redirects are checked before a request", async () => {
  const group = { allow: ["/images/public*"], disallow: ["/images/*.jpg$", "/encoded%7E$"] };
  assert.equal(robotsAllowed(`${fixture}/images/a.jpg`, { group }), false);
  assert.equal(robotsAllowed(`${fixture}/images/a.jpg?size=large`, { group }), true);
  assert.equal(robotsAllowed(`${fixture}/images/public/`, { group }), true);
  assert.equal(robotsAllowed(`${fixture}/encoded~`, { group }), false);
  let requests = 0;
  const dnsCache = new Map([["93.184.216.34", { time: Date.now(), records: [{ address: "93.184.216.34", family: 4 }] }]]);
  await assert.rejects(fetchBuffer(`${fixture}/start`, {
    retries: 0, dnsCache,
    upstreamFetch: async () => { requests++; return new Response(null, { status: 302, headers: { location: "/restricted" } }); },
    beforeRedirect: url => { assert.equal(url, `${fixture}/restricted`); throw new Error("Denied by fixture policy"); }
  }), /Denied by fixture policy/);
  assert.equal(requests, 1);
});
