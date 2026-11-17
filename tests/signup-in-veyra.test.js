"use strict";
// Regression — sign-up URLs load through Veyra and never trigger the
// sign-in session handoff; sign-in CLICKS are never intercepted.
//
// History: the runtime used to capture-phase intercept clicks on
// sign-in/sign-up controls and post veyra:signin to the app (the old
// "session handoff" choice). That interceptor killed form submissions
// (GitHub's "Continue with Google" submit button was preventDefaulted
// and its form POST never fired) and mis-resolved form actions, so it
// was removed entirely — sign-in controls navigate naturally through
// the fast proxy, and only location.assign/replace (isSigninRedirect)
// still posts veyra:signin, which the app loads in-tab.
//
// What remains asserted here:
//   - the click interceptor is really gone (no signinControl, no
//     capture-phase click listener posting veyra:signin);
//   - isSigninRedirect returns false for signup destinations, so a
//     JS-driven signup redirect loads through the proxy inside Veyra;
//   - isSigninRedirect returns true for genuine sign-in destinations;
//   - the sign-in path pattern does not match signup words.
const assert = require("node:assert/strict");

for (const name of ["AI_API_KEY", "AI_API_BASE_URL", "OPENAI_API_KEY", "BRAVE_SEARCH_API_KEY", "BING_SEARCH_API_KEY", "GOOGLE_SEARCH_API_KEY", "MONGODB_URI"]) delete process.env[name];
process.env.VEYRA_CHROMIUM_ENABLED = "false";

const { injectRuntime } = require("../src/server");

const out = injectRuntime('<html><head></head><body><a href="/signup">Sign up</a><a href="/login">Sign in</a></body></html>', "https://example.com/", "sess-signup-test");
const runtime = out.match(/<script data-veyra-runtime>([\s\S]*?)<\/script>/)?.[1] || "";
assert.ok(runtime, "the runtime script must be injected");
new Function(runtime);

// ---------- the click interception is gone ----------
// No signinControl helper, no capture-phase click listener posting
// veyra:signin. Sign-in controls (anchors AND form submit buttons)
// must navigate naturally: anchors through their rewritten /api/view
// href, forms through the proxy POST.
assert.doesNotMatch(runtime, /signinControl/, "the sign-in click interceptor must be removed");
assert.doesNotMatch(runtime, /document\.addEventListener\('click'[^)]*\),true\)/, "no capture-phase click interceptor may remain");

// Sign-up detection still exists and is separate from sign-in detection
// (isSigninRedirect uses these to keep signup URLs out of the handoff).
assert.match(runtime, /var SIGNUP_TEXT=/, "a SIGNUP_TEXT pattern must exist");
assert.match(runtime, /var SIGNUP_PATH=/, "a SIGNUP_PATH pattern must exist");

// The sign-in path pattern must not contain signup words — otherwise a
// /signup destination would still be routed to the handoff.
const signinPath = runtime.match(/var SIGNIN_AUTH_PATH=([^;]+);/)?.[1] || "";
assert.ok(!/signup|sign-up|register|join|create \(?:an \)?account/.test(signinPath),
  "SIGNIN_AUTH_PATH must not match signup/register paths");

// location.assign/replace sign-in detection is intact.
assert.match(runtime, /var SIGNIN_AUTH_HOST=/, "auth-provider hosts must still be detected");
assert.match(runtime, /type:'veyra:signin'/, "a JS sign-in redirect must still post veyra:signin");
assert.match(runtime, /function isSigninRedirect/, "isSigninRedirect must still exist");
assert.match(runtime, /if\(pathPart&&SIGNUP_PATH\.test\(pathPart\)\)return false;/,
  "isSigninRedirect must return false for signup paths");

// ---------- behavior: exercise the runtime's real isSigninRedirect ----------
// The runtime ships as an IIFE — strip the wrapper so the inner function
// declarations are reachable, then evaluate the body with a stubbed
// environment.
const body = runtime.replace(/^\s*\(function\(\)\{/, "").replace(/\}\)\(\);\s*$/, "");
assert.ok(body.length > 0 && body.length < runtime.length, "the runtime IIFE wrapper must be strippable");
const fn = new Function("window", "document", "location", "history", "navigator", "performance", "self", "top", "parent", "addEventListener", "postMessage", "fetch", "XMLHttpRequest", "EventSource", "FormData", "URL", "URLSearchParams", "Blob", "Request", "Response", "ReadableStream", "History", "Location", "Element", "Node", "CSSStyleSheet", "MutationObserver", "WeakSet", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  body + "\n;return {isSigninRedirect:typeof isSigninRedirect==='function'?isSigninRedirect:null};");
const noop = () => {};
const stubWindow = { addEventListener: noop, postMessage: noop, parent: null, top: null, __VEYRA_PROXY__: true };
const stubDoc = { addEventListener: noop, cookie: "", body: null, documentElement: null, querySelector: () => null };
const api = fn(stubWindow, stubDoc, { href: "https://example.com/", assign: noop, replace: noop, pathname: "/api/view", protocol: "https:", origin: "https://example.com", hostname: "example.com" },
  { pushState: noop, replaceState: noop, state: null }, { userAgent: "test" }, { now: () => 0 }, stubWindow, stubWindow, stubWindow,
  noop, noop, () => Promise.resolve(new Response("")), function () {}, function () {}, function () {}, URL, URLSearchParams, Blob, Request, Response, ReadableStream,
  globalThis.History || Object, globalThis.Location || Object, globalThis.Element || Object, globalThis.Node || Object, globalThis.CSSStyleSheet || Object, globalThis.MutationObserver || Object, WeakSet, () => 0, () => 0, clearTimeout, clearInterval);

assert.equal(typeof api.isSigninRedirect, "function", "isSigninRedirect must be defined in the runtime");
// Sign-up destinations must NOT be treated as sign-in redirects.
for (const u of ["https://example.com/signup", "https://example.com/sign-up?ref=nav", "https://example.com/register", "https://accounts.google.com/signup/v2/webcreateaccount", "https://example.com/en-gb/join"]) {
  assert.equal(api.isSigninRedirect(u), false, `signup destination must not trigger the handoff: ${u}`);
}
// Genuine sign-in destinations must still trigger the handoff.
for (const u of ["https://example.com/login", "https://accounts.google.com/o/oauth2/v2/auth", "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", "https://github.com/login/oauth/authorize"]) {
  assert.equal(api.isSigninRedirect(u), true, `sign-in destination must keep the handoff: ${u}`);
}

console.log("sign-up loads through Veyra regression tests passed");
