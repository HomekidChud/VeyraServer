"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { load } = require("cheerio");
const upstream = require("undici");
process.env.GATE_ENABLED = "false";
process.env.VEYRA_ENV = "test";
process.env.VEYRA_CHROMIUM_ENABLED = "false";
process.env.MONGODB_URI = "";

// Simulate only the upstream for a site that permits proxy access. The
// Express proxy still performs the real document, form, redirect and cookie
// processing. No external account or live website is contacted.
const site = "https://93.184.216.34";
const fixturePage = html => new Response(`<!doctype html><html><head><title>Fixture</title></head><body>${html}</body></html>`,
  { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
const form = action => `<form method="post" action="${action}"><input name="csrf" value="fixture-token"><input name="email"><input name="password" type="password"><button>Continue</button></form>`;
const originalFetch = upstream.fetch;
const posts = [];
upstream.fetch = async (url, opts) => {
  const target = new URL(url), headers = new Headers(opts.headers);
  assert.equal(target.origin, site);
  if (opts.method === "POST") {
    const params = new URLSearchParams(String(opts.body));
    assert.equal(params.get("csrf"), "fixture-token");
    assert.equal(params.get("email"), "person@example.invalid");
    assert.equal(params.get("password"), "Disposable7!");
    posts.push(target.pathname);
    return new Response(null, { status: 303, headers: { location: "/account", "set-cookie": "fixture_login=ok; Path=/; Secure; HttpOnly" } });
  }
  if (target.pathname === "/signin") return fixturePage(`${form("/session")}<a id="join" href="/signup">Create account</a>`);
  if (target.pathname === "/signup") return fixturePage(form("/register"));
  if (target.pathname === "/account") return fixturePage(headers.get("cookie")?.includes("fixture_login=ok") ? "<h1>Signed in</h1>" : "<h1>Not signed in</h1>");
  throw new Error(`Unexpected upstream fixture request: ${target.pathname}`);
};
let app, sessionManager, makeViewUrl;
try { ({ app, sessionManager, makeViewUrl } = require("../src/server")); }
finally { upstream.fetch = originalFetch; }

(async () => {
  const server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const open = (link, options) => fetch(new URL(link, base), options);
  const start = () => sessionManager.create(randomUUID()).id;
  const signupId = start(), loginId = start(), guestId = start();
  const getDocument = async (link, options) => {
    const response = await open(link, options);
    const $ = load(await response.text());
    assert.equal(response.status, 200, $("body").text().slice(0, 400));
    return $;
  };
  const submit = async $ => {
    const action = $("form").attr("action");
    const data = new URLSearchParams({ csrf: $("input[name=csrf]").attr("value"), email: "person@example.invalid", password: "Disposable7!" });
    return getDocument(action, { method: "POST", body: data, headers: { Accept: "text/html" } });
  };
  try {
    const $login = await getDocument(makeViewUrl(site + "/signin", signupId));
    const $signup = await getDocument($login("#join").attr("href"));
    assert.equal((await submit($signup))("h1").text(), "Signed in", "signup POST and redirect work inside Fast Proxy");
    assert.equal((await getDocument(makeViewUrl(site + "/account", signupId)))("h1").text(), "Signed in");

    const $signin = await getDocument(makeViewUrl(site + "/signin", loginId));
    assert.equal((await submit($signin))("h1").text(), "Signed in", "login POST and redirect work inside Fast Proxy");
    assert.deepEqual(posts, ["/register", "/session"]);
    assert.equal((await getDocument(makeViewUrl(site + "/account", guestId)))("h1").text(), "Not signed in", "another proxy session cannot see the login cookie");
    console.log("Fast Proxy signup, login, redirects, and cookie isolation passed");
  } finally {
    for (const id of [signupId, loginId, guestId]) sessionManager.close(id);
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
