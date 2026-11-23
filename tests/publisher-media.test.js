"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, sign } = require("node:crypto");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createPublisherMedia } = require("../src/services/publisher-media");

const catalogDir = mkdtempSync(join(tmpdir(), "veyra-publisher-test-"));
const filename = join(catalogDir, "catalog-test.json");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const config = {
  VEYRA_PUBLISHER_SEARCH: "1",
  VEYRA_PUBLISHER_CATALOG_PATH: filename,
  VEYRA_PUBLISHER_AGE_ISSUER: "https://verify.example.test/",
  VEYRA_PUBLISHER_AGE_START_URL: "https://verify.example.test/check",
  VEYRA_PUBLISHER_AGE_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" })
};
const fixedTime = Date.now();
const domains = ["pornhub.com", "xvideos.com"];
const total = [1945, 2366];
function fixtureRow(domain, index) {
  const first = domain === domains[0], id = first ? `fixture-${index}` : `video.fixture${index}`;
  return {
    id, title: `Synthetic catalog test entry ${index}`, tags: index % 2 === 0 ? "lunar atlas" : "orbital telescope",
    url: first ? `https://www.pornhub.com/embed/${id}` : `https://www.xvideos.com/${id}/synthetic-fixture`,
    thumbnail: `https://${first ? "ei.phncdn.com" : "thumb-cdn77.others-cdn.com"}/synthetic-fixture-${index}.jpg`
  };
}
function snapshot(time, sizes = total) {
  return {
    schemaVersion: 1, catalogs: domains.map((domain, i) => {
      const entries = Array.from({ length: sizes[i] }, (_, n) => fixtureRow(domain, n));
      const make = n => fixtureRow(domain, sizes[i] + n);
      entries.push(entries[0] || make(99), { ...make(1), thumbnail: "" },
        { ...make(2), thumbnail: "https://ei.phncdn.com.lookalike.test/shadow.jpg" },
        { ...make(3), url: "https://www.pornhub.com.lookalike.test/embed/fixture" }, make(4));
      return {
        domain, generatedAtMs: time, expiresAtMs: time + 3_600_000,
        approval: { status: "approved", territories: "worldwide", evidenceRef: "internal:fixture/test-only", uses: ["search-metadata", "thumbnail-display"] },
        withdrawnIds: [make(4).id], entries
      };
    })
  };
}
function proof(nonce, now, overrides = {}, key = privateKey) {
  const iat = Math.floor(now / 1000);
  const enc = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${enc({ alg: "EdDSA", typ: "JWT" })}.${enc({
    iss: config.VEYRA_PUBLISHER_AGE_ISSUER, aud: "veyra:publisher-search", nonce, over18: true,
    iat, exp: iat + 120, ...overrides
  })}`;
  return `${payload}.${sign(null, Buffer.from(payload), key).toString("base64url")}`;
}
const persist = input => writeFileSync(filename, JSON.stringify(input), { mode: 0o600 });

test("disabled, expired or unapproved catalogs and malformed age config fail closed", () => {
  const opts = { now: () => fixedTime };
  assert.equal(createPublisherMedia({ ...opts, env: { ...config, VEYRA_PUBLISHER_SEARCH: "0" } }), null);
  const input = snapshot(fixedTime, [10, 10]);
  input.catalogs[0].approval.uses = ["search-metadata"];
  persist(input);
  assert.equal(createPublisherMedia({ ...opts, env: config }), null);
  const elapsed = fixedTime + 48 * 3_600_000;
  persist(snapshot(fixedTime, [10, 10]));
  assert.equal(createPublisherMedia({ now: () => elapsed, env: config }), null);
  assert.equal(createPublisherMedia({ ...opts, env: { ...config, VEYRA_PUBLISHER_AGE_START_URL: "http://verify.example.test/check" } }), null);
});

test("counts 4,311 synthetic accepted records, filters unsafe URLs, and enforces signed and session-bound age checks", () => {
  persist(snapshot(fixedTime));
  const lines = [];
  let time = fixedTime;
  const catalog = createPublisherMedia({ env: config, now: () => time, log: (level, message) => lines.push({ level, message }) });
  assert.ok(catalog);
  assert.equal(catalog.browserAvailable("pornhub.com"), false, "the Browser surface is separately opt-in");
  const counters = lines.map(line => JSON.parse(line.message.slice("Publisher catalog loaded ".length)));
  assert.deepEqual(counters.map(item => item.indexed), total);
  assert.ok(counters.every(item => item.received === item.indexed + 5 && item.missingThumbnail === 1 &&
    item.unapprovedThumbnail === 1 && item.invalidRecord === 1 && item.withdrawn === 1 && item.duplicates === 1));
  assert.ok(!JSON.stringify(lines).includes("Synthetic catalog test entry"));
  const { nonce, verificationUrl } = catalog.issue("adult-fixture", "fixture-session-token");
  assert.equal(new URL(verificationUrl).searchParams.get("nonce"), nonce);
  const request = q => catalog.search("adult-fixture", "fixture-session-token", { nonce, q });
  const redeem = signed => catalog.accept("adult-fixture", "fixture-session-token", signed);
  assert.equal(request("search:pornhub.com").status, "age-required");
  assert.equal(redeem(proof(nonce, time, { aud: "other-application" })), false);
  assert.equal(redeem(proof(nonce, time, {}, generateKeyPairSync("ed25519").privateKey)), false);
  assert.equal(redeem(proof(nonce, time - 300_000)), false);
  assert.equal(redeem(proof(nonce, time, { over18: "true" })), false);
  assert.equal(request("search:pornhub.com").status, "age-required");
  const signed = proof(nonce, time);
  assert.equal(catalog.accept("different-account", "fixture-session-token", signed), false);
  assert.equal(catalog.accept("adult-fixture", "different-token", signed), false);
  assert.equal(redeem(signed), true);
  assert.equal(redeem(signed), false, "a proof only redeems its challenge once");
  assert.equal(catalog.search("different-account", "fixture-session-token", { nonce, q: "search:pornhub.com" }).status, "age-required");
  assert.equal(catalog.search("adult-fixture", "different-token", { nonce, q: "search:pornhub.com" }).status, "age-required");
  assert.equal(request("search:pornhub.com -site:pornhub.com").status, "invalid-query");
  assert.equal(request("search:pornhub.com.lookalike.test").status, "catalog-unavailable");
  for (const [n, domain] of domains.entries()) {
    const initial = request(`search:${domain}`);
    assert.equal(initial.total, total[n]);
    assert.equal(initial.results.length, 24);
    assert.equal(initial.nextPage, 1);
    assert.equal(initial.expiresInMs, (Math.floor(time / 1000) + 120) * 1000 - time);
    assert.equal(request(`search:${domain} lunar atlas`).total, Math.ceil(total[n] / 2));
    assert.equal(request(`search:${domain} lunar telescope`).total, 0);
    const second = catalog.search("adult-fixture", "fixture-session-token", { nonce, q: `search:${domain}`, page: 1 });
    assert.notEqual(second.results[0].url, initial.results[0].url);
    assert.ok(initial.results.every(row => row.source === domain && new URL(row.url).hostname === `www.${domain}`));
  }
  console.log("Synthetic scoped search audit", JSON.stringify(counters));
  time += 121_000;
  assert.equal(request("search:pornhub.com").status, "age-required");
  const rejected = catalog.issue("adult-fixture", "fixture-session-token").nonce;
  assert.equal(redeem(proof(rejected, time, { over18: false })), false);
  assert.equal(redeem(proof(rejected, time)), false, "underage decision cancels the challenge");
});

test("Express route serves synthetic publisher rows only after sign-in and signed verification", async () => {
  persist(snapshot(Date.now(), [25, 26]));
  Object.assign(process.env, config, {
    VEYRA_DATA_DIR: join(catalogDir, "runtime"), ACCESS_GATE: "0",
    VEYRA_ALLOW_SIGNUP: "1", VEYRA_SIGNUP_KEY: "", VEYRA_CHROMIUM_ENABLED: "false", VEYRA_TEST_MODE: "0",
    VEYRA_PUBLISHER_BROWSER: "1"
  });
  delete process.env.MONGODB_URI;
  const { app } = require("../src/server");
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => server.once("listening", resolve).once("error", reject));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (to, json = {}, token, privacy = "restricted") => fetch(`${base}/api/${to}${to.includes("?") ? "&" : "?"}privacy=${privacy}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(json)
    });
    const guest = await post("search/publisher", { q: "search:pornhub.com", over18: true });
    assert.equal(guest.status, 401);
    assert.equal(guest.headers.get("cache-control"), "private, no-store");
    const signup = await post("auth/signup", { email: "publisher-fixture@example.test", name: "Publisher fixture", password: "Fixture-pass-123!" });
    assert.equal(signup.status, 201);
    const { token } = await signup.json();
    const status = (query, bearer = token, privacy = "restricted") => fetch(`${base}/api/search/publisher/status?${query}&privacy=${privacy}`,
      { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });
    assert.equal((await status("domain=pornhub.com", "")).status, 401);
    assert.equal((await status("domain=pornhub.com&private=1")).status, 404);
    assert.equal((await status("domain=pornhub.com&incognito=1")).status, 404);
    assert.equal((await status("domain=pornhub.com.evil.test")).status, 404);
    for (const mode of ["filtered", "unfiltered", "blocked", "invalid", ""]) {
      assert.equal((await status("domain=pornhub.com", token, mode)).status, 404);
      assert.equal((await post("search/publisher/challenge", {}, token, mode)).status, 404);
    }
    const available = await status("domain=pornhub.com");
    assert.equal(available.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await available.json(), { ok: true });
    const challenge = await post("search/publisher/challenge", {}, token);
    assert.equal(challenge.status, 200);
    const { nonce } = await challenge.json();
    assert.equal((await post("search/publisher", { nonce, q: "search:xvideos.com", over18: true }, token)).status, 403);
    assert.equal((await post("search/publisher/verify", { nonce, over18: true }, token)).status, 403);
    const assertion = proof(nonce, Date.now());
    assert.equal((await post("search/publisher/verify", { assertion })).status, 401);
    assert.equal((await post("search/publisher/verify", { assertion }, token)).status, 200);
    assert.equal((await post("search/publisher", { nonce, q: "search:xvideos.com" }, token, "unfiltered")).status, 404);
    for (const [n, domain] of domains.entries()) {
      const response = await post("search/publisher", { nonce, q: `search:${domain}` }, token);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      const result = await response.json();
      assert.equal(result.total, 25 + n);
      assert.equal(result.results.length, 24);
      assert.ok(result.expiresInMs > 0 && result.expiresInMs <= 120_000);
      assert.ok(result.results.every(row => row.thumbnail));
    }
    assert.equal((await post("search/publisher?incognito=1", { nonce, q: "search:xvideos.com" }, token)).status, 404);
    assert.equal((await post("search/publisher?private=1", { nonce, q: "search:xvideos.com" }, token)).status, 404);
    const publicIndex = await (await fetch(`${base}/api/search?q=Synthetic+catalog+test+entry`)).json();
    assert.ok(publicIndex.results.every(row => !row.title.includes("Synthetic catalog test entry")));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test.after(() => rmSync(catalogDir, { recursive: true, force: true }));
