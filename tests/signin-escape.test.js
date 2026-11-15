// Regression tests for the MSN sign-in escape fixes.
//
// MSN's sign-in flow (msn.com/play → MSAL → /common/oauth2/v2.0/authorize)
// escaped the proxy two ways:
//   1. The proxied auth page's own scripts navigate the frame to the real
//      site (window.location = "https://www.msn.com/"), which Chrome blocks
//      inside the app's iframe ("This content is blocked"). Fix: the patched
//      location.assign/replace must route sign-in URLs to the veyra:signin
//      handoff instead of proxying them.
//   2. The app needs to detect frames that already escaped. Fix: the runtime
//      answers an embed-probe with embed-probe-ack; a frame that navigated
//      off the proxy stays silent.
const assert = require('assert');
const { injectRuntime } = require('../src/server');

const out = injectRuntime('<html><head><title>t</title></head><body><h1>hi</h1></body></html>', 'https://www.msn.com/en-us/play', 'sess-msn');

// The sign-in redirect detector exists and reuses the click-handler's
// auth host/path patterns.
assert.match(out, /function isSigninRedirect\(u\)\{/);
assert.match(out, /!!\(host&&SIGNIN_AUTH_HOST\.test\(host\)\)\|\|\!\!\(pathPart&&SIGNIN_AUTH_PATH\.test\(pathPart\)\)/);

// Both navigation patches route auth URLs to the handoff BEFORE proxying
// them, and only when embedded in the app (direct /api/view tabs keep the
// old proxying behaviour).
assert.match(out, /if\(appEmbedded&&isSigninRedirect\(u\)\)\{topPost\(\{type:'veyra:signin',url:u,sessionId:SESSION_ID,pageUrl:virtualUrl\}\);return;\}return nativeAssign\.call\(this,proxy\('view',u\)\)/);
assert.match(out, /if\(appEmbedded&&isSigninRedirect\(u\)\)\{topPost\(\{type:'veyra:signin',url:u,sessionId:SESSION_ID,pageUrl:virtualUrl\}\);return;\}return nativeReplace\.call\(this,proxy\('view',u\)\)/);

// Escape watchdog handshake: the app probes each loaded frame; only a frame
// still running this runtime can answer — and the ack must go to window.top
// (topPost), not ev.source, or the page's own postMessage wrappers can loop
// the ack back into the frame.
assert.match(out, /ev\.data&&ev\.data\.type==='veyra:embed-probe'\)\{topPost\(\{type:'veyra:embed-probe-ack',sessionId:SESSION_ID\}\)\}/);

console.log('sign-in escape regression checks passed');
