"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const cheerio = require("cheerio");
const { verifyIntegrity } = require("../src/proxy-integrity");
const { rewriteHtml } = require("../src/server");
process.on("uncaughtException", e => { console.error(e); process.exitCode = 1; });
const bytes = Buffer.from("window.example = 'original bytes';");
const hash = algorithm => `${algorithm}-${crypto.createHash(algorithm).update(bytes).digest("base64")}`;
let checks = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
for (const algorithm of ["sha256", "sha384", "sha512"]) {
  check(verifyIntegrity(bytes, hash(algorithm)), true);
  check(verifyIntegrity(Buffer.from("changed"), hash(algorithm)), false);
}
check(verifyIntegrity(bytes, hash("sha256") + " sha512-YmFk"), false);
check(verifyIntegrity(bytes, "sha256-YmFk " + hash("sha256")), true);
check(verifyIntegrity(bytes, "unknown-YmFk"), false);
check(verifyIntegrity(bytes, "x".repeat(4097)), false);
const integrity = hash("sha384");
const $ = cheerio.load(rewriteHtml(`<script src="/main.js" integrity="${integrity}" crossorigin="anonymous"></script><link rel="stylesheet" href="/main.css" integrity="${integrity}">`, "https://example.com/", "session"));
for (const [selector, attribute] of [["script[integrity]", "src"], ["link[integrity]", "href"]]) {
  check($(selector).attr("integrity"), integrity);
  check(new URL($(selector).attr(attribute), "https://proxy.test/").searchParams.get("integrity"), integrity);
}
console.log(`Proxy integrity: ${checks} digest, strongest-hash and HTML metadata checks passed.`);
