// Regression tests for srcFix's script flag (the `sc` third parameter).
//
// Background (browser.lol Turbopack hydration): srcFix used to be declared
// `function srcFix(v,kind)` while every call site passed a third `script`
// argument. The extra argument was dropped, and the body's `if(sc)` read a
// free variable — a silent ReferenceError in the injected runtime (the try/catch
// swallowed it) that disabled ALL script-form logic, so same-origin scripts
// were rewritten to /api/resource?url=... query form. Turbopack chunk
// loaders key lazy chunk registrations by the raw src string; the query form
// breaks the key match and hydration hangs forever with 0 React fibers.
//
// These tests run the REAL emitted srcFix (from injectRuntime) in a fake
// proxy-location environment, exactly like the runtime patch tests:
//   - same-origin script URLs (absolute and relative) keep their path form
//   - cross-origin script URLs get proxied
//   - already-proxified URLs pass through
//   - non-script resources still get the query form for same-origin srcs
const assert = require('assert');
const { injectRuntime } = require('../src/server');

const out = injectRuntime('<html><head><title>t</title></head><body><h1>hi</h1></body></html>', 'https://browser.lol/', 'sess-srcfix');
const script = out.match(/<script data-veyra-runtime>([\s\S]*?)<\/script>/)[1];

// Extract the srcFix body: from its declaration to the FIX_ATTRS table.
const fnSrc = script.slice(script.indexOf('function srcFix(v,kind,sc){'), script.indexOf('// Runtime-created resources'));

// The proxy() helper builds /api/resource or /api/view URLs; srcFix closes
// over it. Provide it so we can assert what came out.
const PROXY_BASE = 'https://veyraserver-xscy.onrender.com';
const fakeLocation = {
  href: `${PROXY_BASE}/api/view?url=${encodeURIComponent('https://browser.lol/')}`,
  origin: PROXY_BASE,
  hostname: 'veyraserver-xscy.onrender.com',
  protocol: 'https:',
};

const srcFix = new Function('location', 'virtualUrl', 'URL', 'proxy', 'VAPI', 'fixDerivedHost', 'cleanVeyraParams',
  fnSrc + '\nreturn srcFix;')(
  fakeLocation,
  'https://browser.lol/',
  URL,
  (kind, href) => `${PROXY_BASE}/api/${kind === 'view' ? 'view' : 'resource'}?url=${encodeURIComponent(href)}`,
  /^\/api\/(view|resource|download)\/?$/,
  (u) => u,
  (u) => u,
);

// 1. Same-origin ABSOLUTE script URL keeps its verbatim form — Turbopack keys
//    chunk registrations by this exact string (module 94318's `new URL(f)`).
assert.equal(srcFix('https://browser.lol/_next/static/chunks/x.js', 'resource', true),
  'https://browser.lol/_next/static/chunks/x.js',
  'same-origin absolute script URLs must stay verbatim');

// 2. Same-origin RELATIVE script URL keeps its path form — not a query URL.
assert.equal(srcFix('/_next/static/chunks/x.js?v=7', 'resource', true),
  '/_next/static/chunks/x.js?v=7',
  'same-origin relative script URLs must keep their path (escaped-path middleware serves them)');

// 3. Cross-origin script URL gets proxied.
const cross = srcFix('https://cdn.browser.lol/assets/app.js', 'resource', true);
assert.equal(cross, `${PROXY_BASE}/api/resource?url=${encodeURIComponent('https://cdn.browser.lol/assets/app.js')}`,
  'cross-origin script URLs must be proxied');

// 4. Already-proxified URLs pass through untouched (no double-wrapping).
const proxied = `${PROXY_BASE}/api/resource?url=${encodeURIComponent('https://browser.lol/img/x.png')}`;
assert.equal(srcFix(proxied, 'resource', true), proxied, 'already-proxified URLs must pass through');

// 5. The script flag must not leak into non-script resources: a same-origin
//    image still gets the query form (only scripts need the path form).
const img = srcFix('https://browser.lol/img/logo.png', 'resource', false);
assert.equal(img, `${PROXY_BASE}/api/resource?url=${encodeURIComponent('https://browser.lol/img/logo.png')}`,
  'same-origin non-script resources keep the query form');

// 6. data:/blob:/about: URLs are returned as-is.
assert.equal(srcFix('data:image/svg+xml;base64,AAA', 'resource', true), 'data:image/svg+xml;base64,AAA');
assert.equal(srcFix('blob:https://browser.lol/x', 'resource', true), 'blob:https://browser.lol/x');

// 7. Static pin: the emitted runtime declares srcFix with the real `sc`
//    parameter and every call site passes the script flag.
assert.match(script, /function srcFix\(v,kind,sc\)\{/);
assert.match(script, /srcFix\(v,kind,name==='script'\)/);

// 8. /cdn-cgi/ (Cloudflare challenge platform) is reserved by Cloudflare's
//    own edge on the proxy host (Render is behind Cloudflare): a path-form
//    /cdn-cgi/ script src is answered by Render's edge with the WRONG
//    domain's challenge-platform copy, so a site's managed challenge can
//    never complete (poxel.io). Both absolute and root-relative /cdn-cgi/
//    script srcs must go through the proxy instead of staying path-form.
{
  const orch = '/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=a5ba14526c3d5ef1';
  const abs = srcFix(`https://browser.lol${orch}`, 'resource', true);
  assert.equal(abs, `${PROXY_BASE}/api/resource?url=${encodeURIComponent(`https://browser.lol${orch}`)}`,
    'absolute /cdn-cgi/ script URLs must be proxied, not kept verbatim');
  const rel = srcFix(orch, 'resource', true);
  assert.equal(rel, `${PROXY_BASE}/api/resource?url=${encodeURIComponent(`https://browser.lol${orch}`)}`,
    'relative /cdn-cgi/ script URLs must be proxied, not kept in path form');
}

// 9. The Turbopack path-form exception still applies OUTSIDE /cdn-cgi/ —
//    regular same-origin chunk paths keep their path form (test 2 covers the
//    relative case; this pins the branch ordering so the /cdn-cgi/ guard
//    cannot swallow the general case).
assert.equal(srcFix('/_next/static/chunks/y.js', 'resource', true), '/_next/static/chunks/y.js',
  'non-/cdn-cgi/ same-origin scripts still keep their path form');

console.log('srcFix script-form regression tests passed');
