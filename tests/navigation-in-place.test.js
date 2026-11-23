"use strict";
// Regression — a navigation button must not open a new tab when the page
// does not require one.
//
// Pre-fix, every window.open() call from an app-embedded proxied frame
// posted veyra:open with no target, and the app opened a new Veyra tab —
// including window.open(url, '_self'), which is plain in-place navigation,
// and target=_top/_parent links, which replace the whole view. Sites whose
// navigation buttons navigate that way (browser.lol-style shells, MSN
// subdomain apps, many SPA nav buttons) sprayed new tabs.
//
// Post-fix:
//   - window.open(url,'_self') navigates the current frame in place;
//   - window.open(url,'_top'/'_parent') from the root frame navigates in
//     place too (a nested frame still hands it to the app as before);
//   - window.open(url) with no target keeps opening a new Veyra tab;
//   - anchors with target=_top/_parent tell the app the target so it can
//     navigate the tab in place instead of opening a new one.
const assert = require("node:assert/strict");

for (const name of ["AI_API_KEY", "AI_API_BASE_URL", "OPENAI_API_KEY", "BRAVE_SEARCH_API_KEY", "BING_SEARCH_API_KEY", "GOOGLE_SEARCH_API_KEY", "MONGODB_URI"]) delete process.env[name];
process.env.VEYRA_CHROMIUM_ENABLED = "false";

const { injectRuntime } = require("../src/server");

const out = injectRuntime('<html><head></head><body><a href="/games" target="_top">Play</a></body></html>', "https://example.com/page", "sess-nav-test");
const runtime = out.match(/<script data-veyra-runtime>([\s\S]*?)<\/script>/)?.[1] || "";
assert.ok(runtime, "the runtime script must be injected");
new Function(runtime);

// The in-place branch exists and runs before the veyra:open handoff.
const selfBranch = runtime.indexOf("tgt==='_self'");
const openHandoff = runtime.indexOf("type:'veyra:open'");
assert.ok(selfBranch > 0 && openHandoff > 0 && selfBranch < openHandoff,
  "the _self in-place branch must run before the new-tab handoff");

// The anchor click handler passes the target through to the app.
assert.match(runtime, /topPost\(\{type:'veyra:open',url:u,target:tgt,sessionId:SESSION_ID\}\)/,
  "anchors must pass their target to the app so _top/_parent navigate in place");

// ---------- behavior: the real patched window.open ----------
const body = runtime.replace(/^\s*\(function\(\)\{/, "").replace(/\}\)\(\);\s*$/, "");
let assigned = [];
const noop = () => {};
let msgHandlers = [];
const clickHandlers = [];
let openedTabs = [];
const stubWindow = {
  addEventListener: (type, h) => {
    if (type === "message") msgHandlers.push(h);
    if (type === "click") clickHandlers.push(h);
  },
  postMessage: (m) => { openedTabs.push(m); },
  open: () => null,
  parent: null,
  top: null,
  __VEYRA_PROXY__: true,
};
stubWindow.top = stubWindow;
class FakeLocation { constructor() { this.__assigned = []; } assign(u) { this.__assigned.push(String(u)); } replace(u) { this.__assigned.push(String(u)); } }
const fn = new Function("window", "document", "location", "history", "navigator", "performance", "self", "top", "parent", "addEventListener", "postMessage", "fetch", "XMLHttpRequest", "EventSource", "FormData", "URL", "URLSearchParams", "Blob", "Request", "Response", "ReadableStream", "History", "Location", "Element", "Node", "CSSStyleSheet", "MutationObserver", "WeakSet", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  body + "\n;return {open:window.open, rootProxiedFrame:typeof rootProxiedFrame==='function'?rootProxiedFrame:null, proxy:typeof proxy==='function'?proxy:null, canonicalizeMaybeProxy:typeof canonicalizeMaybeProxy==='function'?canonicalizeMaybeProxy:null, appEmbedded:function(){return appEmbedded}};");
const api = fn(stubWindow, stubDoc(), stubLocation(), stubHistory(), { userAgent: "test" }, { now: () => 0 }, stubWindow, stubWindow, stubWindow,
  (type, h) => { if (type === "message") msgHandlers.push(h); }, (m) => { openedTabs.push(m); }, () => Promise.resolve(new Response("")), function () {}, function () {}, function () {}, URL, URLSearchParams, Blob, Request, Response, ReadableStream,
  globalThis.History || Object, FakeLocation, globalThis.Element || Object, globalThis.Node || Object, globalThis.CSSStyleSheet || Object, globalThis.MutationObserver || Object, WeakSet, () => 0, () => 0, clearTimeout, clearInterval);
// The app answers the runtime's embed ping: this frame is app-embedded, so
// popups/new windows route through the app instead of the native window.open.
for (const h of msgHandlers) { try { h({ source: stubWindow, data: { type: "veyra:embed-ack" } }); } catch {} }
function click(isTrusted) {
  const event = { isTrusted, eventPhase: 2 };
  clickHandlers.forEach(h => h(event));
  return event;
}

function stubDoc() { return { addEventListener: noop, cookie: "", body: null, documentElement: null, querySelector: () => null }; }
function stubHistory() { return { pushState: noop, replaceState: noop, state: null }; }
function stubLocation() { return { href: "https://example.com/page", assign: (u) => assigned.push(u), replace: noop, pathname: "/api/view", protocol: "https:", origin: "https://example.com", hostname: "example.com" }; }

// Root frame, app-embedded: window.open(url, '_self') navigates in place
// and never opens a tab.
openedTabs = []; assigned = [];
let ret = api.open("https://example.com/games", "_self");
assert.equal(ret, null, "window.open must return null under the app");
assert.equal(assigned.length, 1, "window.open(url,'_self') must navigate in place");
assert.ok(/api\/view\?url=/.test(assigned[0]), "the in-place navigation must go through the proxy view route");
assert.equal(openedTabs.length, 0, "window.open(url,'_self') must never open a new tab");

// window.open(url, '_top') from the root frame is also in-place.
openedTabs = []; assigned = [];
ret = api.open("https://example.com/games", "_top");
assert.equal(ret, null);
assert.equal(assigned.length, 1, "window.open(url,'_top') from the root frame must navigate in place");
assert.equal(openedTabs.length, 0, "window.open(url,'_top') from the root frame must never open a new tab");

// window.open(url) with no target opens a new proxied Veyra tab and
// returns the popup relay shim (real opener semantics for OAuth flows).
openedTabs = []; assigned = [];
assert.equal(api.open("https://example.com/games"), null, "scripts need a real click for a new tab");
click(false);
assert.equal(api.open("https://example.com/games"), null, "a synthetic click does not grant a popup");
const dispatched = click(true);
dispatched.eventPhase = 0;
assert.equal(api.open("https://example.com/games"), null, "a timer after the click dispatch does not inherit its popup");
click(true);
ret = api.open("https://example.com/games");
assert.ok(ret && typeof ret.postMessage === "function" && ret.closed === false,
  "window.open must return the popup relay shim, not null");
assert.equal(openedTabs.length, 1, "window.open(url) without a target still hands off to the app");
assert.equal(openedTabs[0].type, "veyra:popup-open");
assert.equal(openedTabs[0].target, undefined, "the popup-open message carries no target (the popup IS the tab)");
assert.equal(typeof openedTabs[0].popupId, "string", "the popup-open message carries the popup id");
assert.equal(api.open("https://example.com/duplicate"), null, "an interaction cannot open a second tab");

// The app must be able to tell in-place targets from new-tab targets.
openedTabs = [];
click(true);
ret = api.open("https://example.com/games", "_blank");
assert.equal(openedTabs[0].name, "_blank", "explicit _blank passes its window name through");
// The shim's postMessage relays through the app (veyra:popup-message).
const before = openedTabs.length;
ret.postMessage({ hello: 1 }, "https://example.com");
assert.equal(openedTabs[openedTabs.length - 1].type, "veyra:popup-message", "the shim postMessage must relay to the app");
assert.equal(openedTabs[openedTabs.length - 1].data.hello, 1);
// The shim's close() asks the app to close the popup tab.
ret.close();
assert.equal(openedTabs[openedTabs.length - 1].type, "veyra:popup-close", "the shim close() must ask the app to close the tab");

for (const [blank, setLocation] of [
  [undefined, (h, url) => { h.location = url; }],
  ["about:blank", (h, url) => { h.location.href = url; }],
  [" ", (h, url) => h.location.replace(url)],
  ["", (h, url) => h.location.assign(url)]
]) {
  click(true);
  openedTabs = [];
  const handle = api.open(blank, "signin");
  assert.equal(handle.location.href, "about:blank");
  assert.equal(handle.closed, false);
  assert.equal(openedTabs.length, 0, "a blank window must not open a tab");
  setLocation(handle, "about:blank");
  assert.equal(openedTabs.length, 0);
  setLocation(handle, "https://example.com/signin");
  assert.equal(openedTabs[0]?.type, "veyra:popup-open");
  assert.equal(handle.location.href, "https://example.com/signin");
  setLocation(handle, "https://example.com/next");
  assert.equal(openedTabs[1]?.type, "veyra:popup-navigate");
  assert.equal(openedTabs[1]?.popupId, openedTabs[0]?.popupId);
  handle.close();
  assert.equal(handle.closed, true);
  assert.equal(openedTabs[2]?.type, "veyra:popup-close");
}
click(true);
openedTabs = [];
const cancelled = api.open();
cancelled.close();
cancelled.location.href = "https://example.com/never";
assert.equal(cancelled.closed, true);
assert.equal(openedTabs.length, 0, "closing the placeholder prevents a late tab");

console.log("navigation-in-place regression tests passed");
