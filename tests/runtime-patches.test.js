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

// Site code that derives API hosts from location.hostname (Roblox's RealTime
// gateway builder: hostname minus "www." prefixed with "apis.") produces
// <sub>.<proxy-host> URLs under the proxy. On a public proxy host those DNS
// names don't exist and every request 502s (Roblox special-cases localhost
// in its own bundle, so local testing hides it). The runtime must remap the
// proxy-host suffix back onto the virtual site's host.
assert.match(out, /function fixDerivedHost\(u\)\{/);
assert.match(out, /return cleanVeyraParams\(fixDerivedHost\(ownOrigin\(u\.origin\)\?fixOwn\(u\):u\)\)\}/);

// Behavioral check: run the emitted fixDerivedHost/toVirtual with a fake
// proxy-origin location (like the Render deployment) and confirm derived
// hosts are remapped while real site URLs pass through untouched.
{
  const script = out.match(/<script data-veyra-runtime>([\s\S]*?)<\/script>/)[1];
  const fnSrc = script.slice(script.indexOf('function fixDerivedHost'), script.indexOf('function resolve('));
  const toVirtual = new Function('location', 'virtualUrl', 'URL', 'cleanVeyraParams', 'ownOrigin', 'fixOwn',
    fnSrc + '\nreturn toVirtual;')(
    { hostname: 'veyraserver-xscy.onrender.com', origin: 'https://veyraserver-xscy.onrender.com', protocol: 'https:', href: 'https://veyraserver-xscy.onrender.com/api/view?url=x' },
    'https://www.roblox.com/', URL, (u) => u, () => false, (u) => u);
  assert.equal(toVirtual('https://apis.veyraserver-xscy.onrender.com/rotating-client-service/v1/prelude/latest').href,
    'https://apis.roblox.com/rotating-client-service/v1/prelude/latest');
  assert.equal(toVirtual('https://chat.veyraserver-xscy.onrender.com/v1/connect').href,
    'https://chat.roblox.com/v1/connect');
  assert.equal(toVirtual('https://apis.roblox.com/already-fine').href,
    'https://apis.roblox.com/already-fine');
  assert.equal(toVirtual('https://apis.veyraserver-xscy.onrender.com/x?a=1&b=2').href,
    'https://apis.roblox.com/x?a=1&b=2');
}

console.log('runtime patch regression checks passed');
