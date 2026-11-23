"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { isGoogleAccountsUrl, requestGoogleAccounts } = require("../src/network/google-accounts-transport");

function fakeRequestFor(responseFactory, captured) {
  return (url, options, onResponse) => {
    captured.url = url.href;
    captured.options = options;
    const request = new EventEmitter();
    request.end = body => {
      captured.body = body;
      const response = responseFactory();
      onResponse(response);
    };
    return request;
  };
}

async function main() {
  assert.equal(isGoogleAccountsUrl("https://accounts.google.com/ServiceLogin"), true);
  assert.equal(isGoogleAccountsUrl("https://sub.accounts.google.com/"), false);
  assert.equal(isGoogleAccountsUrl("http://accounts.google.com/"), false);
  assert.equal(isGoogleAccountsUrl("https://example.com/"), false);

  let called = false;
  await assert.rejects(
    requestGoogleAccounts("https://example.com/", { requestImpl: () => { called = true; } }),
    /only accepts https:\/\/accounts\.google\.com/
  );
  assert.equal(called, false, "non-Google hosts are rejected before opening a socket");

  const captured = {};
  const fakeAgent = { marker: "safe-agent" };
  const redirect = await requestGoogleAccounts(
    "https://accounts.google.com/ServiceLogin",
    {
      method: "POST",
      headers: new Headers({ "user-agent": "Veyra test", "accept-encoding": "gzip, br", "content-type": "application/x-www-form-urlencoded" }),
      body: "identifier=test%40example.com",
      agent: fakeAgent,
      requestImpl: fakeRequestFor(() => {
        const response = new Readable({ read() { this.push("redirect body"); this.push(null); } });
        response.statusCode = 302;
        response.statusMessage = "Found";
        response.headers = {
          location: "https://accounts.google.com/v3/signin/identifier",
          "set-cookie": ["SID=one; Path=/; Secure", "NID=two; Path=/; Secure"]
        };
        return response;
      }, captured)
    }
  );
  assert.equal(captured.url, "https://accounts.google.com/ServiceLogin");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.agent, fakeAgent, "the server can pass its DNS-safe agent");
  assert.equal(captured.options.headers["accept-encoding"], "identity");
  assert.equal(captured.options.headers["user-agent"], "Veyra test");
  assert.equal(captured.body, "identifier=test%40example.com");
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "https://accounts.google.com/v3/signin/identifier");
  assert.deepEqual(redirect.headers.getSetCookie(), ["SID=one; Path=/; Secure", "NID=two; Path=/; Secure"]);
  assert.equal(redirect.body, null, "redirect bodies are drained rather than retained");

  const success = await requestGoogleAccounts(
    "https://accounts.google.com/v3/signin/identifier",
    {
      requestImpl: fakeRequestFor(() => {
        const response = Readable.from([Buffer.from("<html>sign in</html>")]);
        response.statusCode = 200;
        response.statusMessage = "OK";
        response.headers = { "content-type": "text/html; charset=utf-8" };
        return response;
      }, {})
    }
  );
  assert.equal(success.status, 200);
  assert.equal(await new Response(success.body).text(), "<html>sign in</html>");
  console.log("Google Accounts native HTTPS transport tests passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
