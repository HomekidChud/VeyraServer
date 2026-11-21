"use strict";
const assert = require("node:assert/strict");

/**
 * Regression — OAuth/sign-in popups work through the fast proxy.
 *
 * Sites' sign-in flows (Google GIS, MSAL, appleid, "continue with …")
 * open accounts.google.com (etc.) in a popup and rely on opener
 * semantics: the popup posts its response to window.opener, the opener
 * polls handle.closed, either side may reply via event.source, and the
 * popup closes itself when done. Through the proxy all of that must
 * still work — the popup opens as a proxied Veyra tab and the app relays
 * postMessages between the two frames, dispatching synthetic
 * MessageEvents whose origin is the OTHER side's virtual (real) origin
 * so the site's own origin checks keep passing.
 *
 * This pins the runtime pieces:
 *   1. window.open() posts veyra:popup-open and returns a shim handle
 *      (closed/close/postMessage/location setter), not null.
 *   2. veyra_popup=1 in the frame URL installs the window.opener shim +
 *      window.close patch synchronously at injection time.
 *   3. veyra:popup-role (re-asserted by the app after popup navigations)
 *      installs the same shims.
 *   4. veyra:relay-message dispatches a synthetic MessageEvent with the
 *      relayed origin and a source shim that replies through the relay.
 *   5. veyra:popup-closed flips the opener-side handle to closed=true.
 *   6. The sign-in click/redirect interception still posts veyra:signin
 *      (the app loads the sign-in page through the proxy in-tab).
 */

const { injectRuntime } = require("../src/server");

const out = injectRuntime('<html><head></head><body><a href="/login">Sign in</a></body></html>', "https://poxel.io/", "sess-popup-test");
const runtime = out.match(/<script data-veyra-runtime>([\s\S]*?)<\/script>/)?.[1] || "";
assert.ok(runtime, "the runtime script must be injected");

// 1: window.open returns a shim handle and announces the popup.
assert.match(runtime, /type:'veyra:popup-open'/, "window.open must post veyra:popup-open");
assert.match(runtime, /POPUP_HANDLES\[popupId\]=shim/, "the shim must be registered so .closed can flip later");
assert.match(runtime, /if\(opened\)topPost\(\{type:'veyra:popup-close'/, "the shim's close() notifies the app if it opened a visible tab");
assert.match(runtime, /Object\.defineProperty\(shim,'location'/, "the shim must support w.location = url navigation");
assert.ok(!/topPost\(\{type:'veyra:open',url:u,target:tgt\|\|'_blank'/.test(runtime), "window.open must no longer post the plain veyra:open (anchors keep it)");

// 2: the synchronous URL marker installs the opener shim before site scripts run.
assert.match(runtime, /veyra_popup=1/, "the runtime must read the veyra_popup=1 marker");
assert.match(runtime, /if\(!window\.opener\)window\.opener=popupReplyShim\('to-opener',''\)/, "the marker must install the window.opener shim");
assert.match(runtime, /window\.close=function\(\)\{topPost\(\{type:'veyra:popup-self-close'/, "the marker must patch window.close");

// 3: the app-asserted popup role installs the same shims.
assert.match(runtime, /if\(d\.type==='veyra:popup-role'\)/, "the runtime must handle veyra:popup-role");

// 4: relayed messages dispatch with the other side's virtual origin.
assert.match(runtime, /new MessageEvent\('message',\{data:d\.data,origin:String\(d\.origin\|\|API_ORIGIN\|\|location\.origin\),lastEventId:'',ports:\[\]\}/, "relay dispatch must use the relayed origin");
assert.match(runtime, /if\(d\.from==='opener'\)src=popupReplyShim\('to-opener',''\)/, "a message from the opener must reply to the opener");
assert.match(runtime, /else if\(d\.from==='popup'\)src=popupReplyShim\('to-popup',d\.popupId\|\|''\)/, "a message from the popup must reply to the popup");
assert.match(runtime, /Object\.defineProperty\(ev,'source',\{value:src,configurable:true\}\)/, "the relayed event's source must be shadowed with the reply shim");

// 5: popup-closed flips the handle.
assert.match(runtime, /if\(d\.type==='veyra:popup-closed'&&d\.popupId&&POPUP_HANDLES\[d\.popupId\]\)\{try\{POPUP_HANDLES\[d\.popupId\]\.closed=true;/, "veyra:popup-closed must set handle.closed = true");

// 6: sign-in interception unchanged (in-proxy sign-in).
assert.match(runtime, /type:'veyra:signin'/, "sign-in clicks must still post veyra:signin");

// ---- functional: run the extracted shim/relay functions in isolation ----
function extract(name) {
  const m = runtime.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n  }`));
  assert.ok(m, `function ${name} must exist in the runtime`);
  return m[0];
}
const posts = [];
const scope = {
  topPost: m => posts.push(m),
  API_ORIGIN: "https://api.example",
  virtualUrl: "https://poxel.io/",
  SESSION_ID: "sess-popup-test"
};
const factory = new Function("topPost", "API_ORIGIN", "virtualUrl", "SESSION_ID", "window", `${extract("popupReplyShim")}\n${extract("popupDispatchRelay")}\nreturn {popupReplyShim, popupDispatchRelay};`);
// Minimal DOM shim: collect message listeners and dispatch to them.
const messageListeners = [];
const fakeWindow = {
  addEventListener: (type, fn) => { if (type === "message") messageListeners.push(fn); },
  dispatchEvent: ev => { for (const fn of [...messageListeners]) fn(ev); return true; }
};
const { popupReplyShim, popupDispatchRelay } = factory(scope.topPost, scope.API_ORIGIN, scope.virtualUrl, scope.SESSION_ID, fakeWindow);

// Opener-side shim: postMessage goes to the popup (veyra:popup-message).
const openerHandle = popupReplyShim("to-popup", "vp1");
openerHandle.postMessage({ credential: "abc" }, "https://poxel.io");
assert.equal(posts.at(-1).type, "veyra:popup-message", "opener shim postMessage must post veyra:popup-message");
assert.equal(posts.at(-1).popupId, "vp1");
assert.equal(openerHandle.closed, false, "the handle starts open");

// Popup-side opener shim: postMessage goes to the opener (veyra:popup-to-opener).
const openerShim = popupReplyShim("to-opener", "");
openerShim.postMessage({ code: "oauth-code" }, "https://accounts.google.com");
assert.equal(posts.at(-1).type, "veyra:popup-to-opener", "popup opener shim postMessage must post veyra:popup-to-opener");

// Relay dispatch: synthetic MessageEvent with the relayed origin + source shim.
let received = null;
messageListeners.push(ev => { received = ev; });
// A message FROM the popup (delivered into the opener frame): the source
// shim must reply back toward the popup (veyra:popup-message + popupId).
popupDispatchRelay({ data: { code: "oauth-code" }, origin: "https://accounts.google.com", from: "popup", popupId: "vp9" });
assert.ok(received, "the relay must dispatch a message event");
assert.equal(received.origin, "https://accounts.google.com", "the synthetic event must carry the popup's virtual origin");
assert.equal(received.data.code, "oauth-code", "the synthetic event must carry the relayed data");
received.source.postMessage({ ok: true }, "https://accounts.google.com");
assert.equal(posts.at(-1).type, "veyra:popup-message", "the source shim must reply through the relay");
assert.equal(posts.at(-1).popupId, "vp9", "the reply must carry the popup's id");
// A message FROM the opener (delivered into the popup frame): the source
// shim must reply toward the opener (veyra:popup-to-opener).
received = null;
popupDispatchRelay({ data: { hi: 1 }, origin: "https://poxel.io/", from: "opener" });
assert.ok(received, "the relay must dispatch a message event (opener direction)");
received.source.postMessage({ ok: true }, "https://poxel.io/");
assert.equal(posts.at(-1).type, "veyra:popup-to-opener", "the source shim must reply toward the opener");

console.log("popup relay regression checks passed");
