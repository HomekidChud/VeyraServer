"use strict";
const assert = require("node:assert/strict");
process.env.PROXY_FORWARD_COMPAT_HEADERS = "true";
const { __workerOps } = require("../src/server");
process.on("uncaughtException", e => { console.error(e); process.exitCode = 1; });
const headers = { "client-id": "public-client", "client-integrity": "provider-value",
  "client-session-id": "website-session", "x-veyra-cookie-capability": "private-capability",
  "x-veyra-server-secret": "never-forward", "x-custom-client": "custom" };
const req = { method: "POST", headers, get: key => headers[key.toLowerCase()] };
const forward = target => __workerOps.forwardProxyBrowserHeaders(req, target, "https://www.twitch.tv/", "resource");
const accepted = forward("https://gql.twitch.tv/gql");
for (const key of ["client-id", "client-integrity", "client-session-id"]) assert.equal(accepted[key], headers[key]);
assert.equal(forward("https://other.test/")["client-id"], undefined);
assert.equal(accepted["x-veyra-cookie-capability"], undefined);
assert.equal(accepted["x-veyra-server-secret"], undefined);
assert.equal(accepted["x-custom-client"], "custom");
console.log("Proxy client headers: 7 Twitch scoping and private-header exclusion checks passed.");
