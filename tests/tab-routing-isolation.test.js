"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const vm = require("node:vm");
const { app, sessionManager } = require("../src/server");

const sites = new Map([["example.com", "Site Alpha"], ["example.org", "Site Beta"]]);
const sid = "tabroutingfixture123456";

function startFixture(port = 0) {
  sessionManager.touch(sid);
  app.locals.veyraProxyFetchBuffer = async target => {
    const u = new URL(target);
    const label = sites.get(u.hostname) || "Live site";
    const script = u.pathname === "/site-script.js";
    const body = script ? `document.querySelector('output').textContent=${JSON.stringify(label)};`
      : `<!doctype html><html><head><title>${label}</title><script src="/site-script.js" defer></script></head>
         <body><h1>${label}</h1><output>Script pending</output>
         <button onclick="history.pushState({}, '', '/catalog?tag=one&amp;tag=two#grid')">Update history</button>
         <button onclick="location.href='/?reload=1'">Navigate to bare root</button>
         <button onclick="location.reload()">Reload inside site</button></body></html>`;
    return {
      status: 200, finalUrl: target, contentType: script ? "application/javascript" : "text/html",
      body: Buffer.from(body), cacheControl: "no-store"
    };
  };
  return app.listen(port, "127.0.0.1");
}

function checkHistory(html, initialUrl) {
  const location = new URL(initialUrl);
  const original = "https://example.com/";
  const fragment = location.hash;
  const messages = [];
  const noop = () => {};
  const setHistory = (state, title, href) => { location.href = new URL(href, location.href).href; };
  const history = { pushState: setHistory, replaceState: setHistory, state: null };
  const window = { addEventListener: noop, postMessage: message => messages.push(message) };
  window.parent = window.top = window;
  const runtime = html.match(/<script data-veyra-runtime>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(runtime, "the actual response includes the navigation runtime");
  vm.runInNewContext(runtime, {
    URL, URLSearchParams, Request, location, history, window,
    document: { title: "Site Alpha", addEventListener: noop }, addEventListener: noop, setInterval: noop
  });
  assert.equal(location.searchParams.get("__veyra_url"), original + fragment, "boot keeps the document's routing context and browser fragment");

  const path = "/catalog?tag=a%20b&tag=two#grid";
  history.pushState({}, "", path);
  assert.equal(location.pathname, "/catalog");
  assert.equal(location.searchParams.get("__veyra_url"), new URL(path, original).href);
  assert.equal(location.searchParams.get("__veyra_sid"), sid);
  assert.equal(location.hash, "#grid");
  assert.equal(messages.at(-1).url, new URL(path, original).href, "the tab receives only the clean site URL");
  history.replaceState({}, "", "?tag=updated#details");
  assert.equal(location.searchParams.get("__veyra_url"), "https://example.com/catalog?tag=updated#details");
}

async function run() {
  const server = startFixture();
  try {
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { "sec-fetch-dest": "iframe", accept: "text/html" };
    const open = url => fetch(`${base}/api/view?${new URLSearchParams({ url, sid })}`, { headers });
    const alpha = await open("https://example.com/");
    const alphaHtml = await alpha.text();
    assert.match(alphaHtml, /<h1>Site Alpha<\/h1>/);
    checkHistory(alphaHtml, alpha.url + "#intro");
    const beta = await open("https://example.org/");
    assert.match(await beta.text(), /<h1>Site Beta<\/h1>/);
    assert.equal(beta.headers.get("set-cookie"), null, "do not set a session-wide routing cookie");

    let r = await fetch(`${base}/?reload=1`, { headers: { ...headers, referer: alpha.url, cookie: `veyra_ctx=${sid}` } });
    assert.equal(new URL(r.url).searchParams.get("__veyra_url"), "https://example.com/?reload=1", "the bare navigation is marked before its HTML loads");
    assert.equal(r.headers.get("x-veyra-canonical-url"), "https://example.com/?reload=1");
    assert.match(await r.text(), /<h1>Site Alpha<\/h1>/);

    r = await fetch(alpha.url, { headers: { ...headers, referer: beta.url } });
    assert.match(await r.text(), /<h1>Site Alpha<\/h1>/, "an explicit target wins over the referring tab");

    r = await fetch(`${base}/site-script.js`, { headers: { "sec-fetch-dest": "script", referer: alpha.url } });
    assert.match(await r.text(), /Site Alpha/, "relative subresources use their own document");
    r = await fetch(`${base}/site-script.js`, { headers: { "sec-fetch-dest": "script", referer: beta.url } });
    assert.match(await r.text(), /Site Beta/, "another tab can use the same asset pathname");

    r = await fetch(`${base}/?reload=1`, { headers: { ...headers, cookie: `veyra_ctx=${sid}` } });
    assert.equal(r.headers.get("x-veyra-canonical-url"), null);
    assert.match(await r.text(), /Veyra server is online/, "a cookie-only request cannot resolve to either tab");
  } finally {
    await new Promise(resolve => server.close(resolve));
    delete app.locals.veyraProxyFetchBuffer;
  }
  console.log("Fast Proxy tabs retain their own root documents and subresources");
}

if (require.main === module) {
  if (process.argv.includes("--serve")) startFixture(Number(process.env.PORT) || 4312);
  else run().catch(error => { console.error(error); process.exitCode = 1; });
}
