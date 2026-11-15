"use strict";
// Regression — sign-up links load through Veyra, they never trigger the
// sign-in session handoff.
//
// Pre-fix, "Sign up"/"Create account"/"Register" controls and signup URLs
// (e.g. /signup, /register) matched the same SIGNIN_TEXT/SIGNIN_AUTH_PATH
// patterns as "Sign in", so clicking them posted veyra:signin to the app,
// which opened the site's real page in the user's own browser (the "session
// method") instead of loading the signup page inside Veyra.
//
// Post-fix, sign-up has its own patterns (SIGNUP_TEXT/SIGNUP_PATH):
//   - a signup control (label or URL) returns null from signinControl, so
//     the click is not intercepted and the anchor/button navigates through
//     the fast proxy — the signup page loads inside Veyra;
//   - isSigninRedirect returns false for signup paths, so location.assign/
//     replace never routes a signup destination to the handoff;
//   - the sign-in patterns no longer contain signup words, so only genuine
//     sign-in controls keep the handoff (with the existing Shift bypass).
const assert = require("node:assert/strict");

for (const name of ["AI_API_KEY", "AI_API_BASE_URL", "OPENAI_API_KEY", "BRAVE_SEARCH_API_KEY", "BING_SEARCH_API_KEY", "GOOGLE_SEARCH_API_KEY", "MONGODB_URI"]) delete process.env[name];
process.env.VEYRA_CHROMIUM_ENABLED = "false";

const { injectRuntime } = require("../src/server");

const out = injectRuntime('<html><head></head><body><a href="/signup">Sign up</a><a href="/login">Sign in</a></body></html>', "https://example.com/", "sess-signup-test");
const runtime = out.match(/<script data-veyra-runtime>([\s\S]*?)<\/script>/)?.[1] || "";
assert.ok(runtime, "the runtime script must be injected");
new Function(runtime);

// Sign-up detection exists and is separate from sign-in detection.
assert.match(runtime, /var SIGNUP_TEXT=/, "a SIGNUP_TEXT pattern must exist");
assert.match(runtime, /var SIGNUP_PATH=/, "a SIGNUP_PATH pattern must exist");

// The sign-in patterns must no longer contain signup words — otherwise a
// "Sign up" button would still be detected as a sign-in control.
const signinPath = runtime.match(/var SIGNIN_AUTH_PATH=([^;]+);/)?.[1] || "";
const signinText = runtime.match(/var SIGNIN_TEXT=([^;]+);/)?.[1] || "";
assert.ok(!/signup|sign-up|register|join|create \(?:an \)?account/.test(signinPath),
  "SIGNIN_AUTH_PATH must not match signup/register paths");
assert.ok(!/sign up|sign-up|signup|register|join|create/.test(signinText),
  "SIGNIN_TEXT must not match signup labels");

// A signup control is not intercepted: signinControl returns null before the
// handoff posts veyra:signin.
assert.match(runtime, /if\(\(label&&SIGNUP_TEXT\.test\(label\)\)\|\|\(pathPart&&SIGNUP_PATH\.test\(pathPart\)\)\)return null;/,
  "a signup control must return null from signinControl");

// location.assign/replace never hands a signup destination off: the signup
// path check runs first inside isSigninRedirect and returns false.
assert.match(runtime, /if\(pathPart&&SIGNUP_PATH\.test\(pathPart\)\)return false;/,
  "isSigninRedirect must return false for signup paths");

// Genuine sign-in detection is intact.
assert.match(runtime, /var SIGNIN_AUTH_HOST=/, "auth-provider hosts must still be detected");
assert.match(runtime, /type:'veyra:signin'/, "a detected sign-in click must still post veyra:signin");
assert.match(runtime, /ev\.shiftKey\|\|ev\.ctrlKey\|\|ev\.metaKey\|\|ev\.altKey\)/, "modifier clicks must still bypass the handoff");

// The behavior itself: exercise the runtime's real decision helpers against
// signup and signin destinations. The runtime ships as an IIFE — strip the
// wrapper so the inner function declarations are reachable, then evaluate
// the body with a stubbed environment.
const body = runtime.replace(/^\s*\(function\(\)\{/, "").replace(/\}\)\(\);\s*$/, "");
assert.ok(body.length > 0 && body.length < runtime.length, "the runtime IIFE wrapper must be strippable");
const fn = new Function("window", "document", "location", "history", "navigator", "performance", "self", "top", "parent", "addEventListener", "postMessage", "fetch", "XMLHttpRequest", "EventSource", "FormData", "URL", "URLSearchParams", "Blob", "Request", "Response", "ReadableStream", "History", "Location", "Element", "Node", "CSSStyleSheet", "MutationObserver", "WeakSet", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  body + "\n;return {isSigninRedirect:typeof isSigninRedirect==='function'?isSigninRedirect:null,signinControl:typeof signinControl==='function'?signinControl:null};");
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
// A sign-up control must not be detected as a sign-in control.
function control(label, href) {
  const el = { nodeType: 1, tagName: "A", getAttribute: (k) => (k === "href" ? href : ""), textContent: label };
  return api.signinControl([el, { nodeType: 1, tagName: "BODY" }]);
}
assert.equal(control("Sign up", "/signup"), null, "a Sign up link must not be a sign-in control");
assert.equal(control("Create an account", "/register"), null, "a Create account link must not be a sign-in control");
assert.equal(control("Join now", "/join"), null, "a Join now button must not be a sign-in control");
assert.ok(control("Sign in", "/login"), "a Sign in link must stay a sign-in control");
assert.equal(control("Sign up", "/login"), null, "the label wins: a Sign up link loads through Veyra even at a login URL");

console.log("sign-up loads through Veyra regression tests passed");
