// Regression tests for the injected runtime patches that MSN Games
// (PolyTrack) depends on. Each test pins a marker in the runtime that
// injectRuntime emits into every proxied page.
const assert = require('assert');
const { injectRuntime } = require('../src/server');

const out = injectRuntime('<html><head><title>t</title></head><body><h1>hi</h1></body></html>', 'https://example.com/page', 'sess-test');

// postMessage is an OWN property of each window instance, so the relaxation
// patch must replace window.postMessage itself. The original
// Window.prototype.postMessage patch was silently shadowed and never ran,
// which broke cross-frame SDK handshakes (msstart SDK init timeout).
assert.match(out, /var nativePM=window\.postMessage;/);
assert.match(out, /window\.postMessage=function\(message,targetOrigin,transfer\)/);
assert.match(out, /return nativePM\.call\(this,message,'\*',transfer\)/);
// Must NOT patch on Window.prototype (shadowed by the own property).
assert.doesNotMatch(out, /Window\.prototype\.postMessage\s*=/);

// Workers constructed from blob:/data: URLs (DRACO decoder, meshopt) must go
// to the native Worker constructor. resolve() rewrites a blob: URL to its
// inner http URL, which the proxy then 404s — PolyTrack's geometry decoding
// stalled forever on this.
assert.match(out, /var raw=String\(realUrl\(url\)\|\|''\);/);
assert.match(out, /if\(\/\^\(blob:\|data:\)\/i\.test\(raw\)\)return new NativeWorker\(url,opts\);/);

// Games that gate themselves to their publisher's domains via
// location.hostname (PolyTrack: *.msn.com / *.msnfun.com) halt with an
// "unofficial version" screen on any other host, including the proxy origin.
// The game's own escape hatch for mirrors is set here.
assert.match(out, /if\(!window\.polytrackModConfiguration\)window\.polytrackModConfiguration=\{unblocked:true\}/);

// Sanity: the runtime still anchors the page URL and is injected as a script.
assert.match(out, /<script data-veyra-runtime>/);
assert.match(out, /window\.__VEYRA_PAGE_URL__=CANONICAL;/);

console.log('runtime patch regression checks passed');
