"use strict";
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-browser-entry-"));
process.env.VEYRA_DATA_DIR = dataDir;
process.env.VEYRA_ENV = "test";
process.env.GATE_ENABLED = "false";
process.env.FRONTEND_ORIGIN = "https://homekidchud.github.io,https://localhost";
process.env.VEYRA_FRONTEND_URL = "https://homekidchud.github.io/VeyraBrowser/";
process.env.RENDER_GIT_COMMIT = "a".repeat(40);
delete process.env.MONGODB_URI;

const { app } = require("../src/server");
test("top-level search is sent to the Browser; APIs and proxy frames retain their routes", async () => {
  const listener = app.listen(0, "127.0.0.1");
  try {
    await once(listener, "listening");
    const base = `http://127.0.0.1:${listener.address().port}`;
    const request = (p, init) => fetch(base + p, { redirect: "manual", ...init });
    const html = { Accept: "text/html" };
    for (const p of ["/search", "/search/", "/browse/"]) {
      const entry = await request(`${p}?q=moon+%26+stars&type=images&incognito=1&veyra_route=admin`, { headers: html });
      assert.equal(entry.status, 302);
      const target = new URL(entry.headers.get("location"));
      assert.equal(target.origin + target.pathname, process.env.VEYRA_FRONTEND_URL);
      assert.deepEqual(Object.fromEntries(target.searchParams), { veyra_route: "search", q: "moon & stars", type: "images", incognito: "1" });
      assert.equal(entry.headers.get("cache-control"), "no-store");
      assert.equal(entry.headers.get("referrer-policy"), "no-referrer");
    }
    for (const [p, headers] of [
      ["/search?q=moon", { ...html, "Sec-Fetch-Dest": "iframe" }],
      ["/search?q=moon", { "Sec-Fetch-Dest": "empty" }],
      ["/search?q=moon&__veyra_url=https%3A%2F%2Fexample.com%2F", html],
      ["/browse?url=https%3A%2F%2Fexample.com", html]
    ]) {
      assert.equal((await request(p, { headers })).status, 404);
    }
    for (const p of ["/health", "/api/health"]) {
      const health = await request(p, { headers: html });
      assert.equal(health.status, 200);
      assert.equal(health.headers.get("cache-control"), "no-store");
      const status = await health.json();
      assert.equal(status.ok, true);
      assert.equal(status.revision, "a".repeat(40));
    }
    for (const origin of ["https://homekidchud.github.io", "https://localhost", "https://untrusted.example"]) {
      const preflight = await request("/api/session", {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-veyra-request-id" }
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), origin === "https://untrusted.example" ? null : origin);
    }
    const search = await request("/api/search/web", { headers: { Origin: "https://localhost" } });
    assert.equal(search.status, 200);
    assert.equal(search.headers.get("access-control-allow-origin"), "https://localhost");
    assert.deepEqual((await search.json()).results, []);
  } finally {
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
