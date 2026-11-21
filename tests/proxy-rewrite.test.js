const assert = require('assert');
const { rewriteHtml, rewriteJsText, cacheSafeUrl, cacheSafeResponse } = require('../src/server');
const { parse: parseImports } = require('es-module-lexer');

// Compact ESM chunks must retain their original upstream module base even
// when loaded at /api/resource?url=... through another module's import().
{
  const literal = 'const note = \'import "./not-a-module.js"\'';
  const js = [
    'import"./side-effect.js";import{a}from"./dep.js";export*from"../parent.js";',
    'export {a as b} from "./named.js";',
    'const load=()=>import(`./lazy.js`);const data=()=>import("./data.json",{with:{type:"json"}});',
    'import mapping from "import-map-key";const runtime=()=>import(`./${mapping}.js`);',
    'const quoted=()=>import("./name\'s.js");',
    literal,
  ].join('\n');
  const base = 'https://example.com/packs/app.js';
  const out = rewriteJsText(js, base, 'module-session');
  assert.ok(out.includes(literal), 'module-like text in a string is not rewritten');
  assert.ok(out.includes('import(`./${mapping}.js`)'), 'computed import is unchanged');
  assert.ok(out.includes('import mapping from "import-map-key"'), 'bare import-map key survives');
  assert.ok(out.includes(',{with:{type:"json"}})'), 'dynamic import options survive');
  const proxied = parseImports(out)[0].filter(item => item.specifier?.startsWith('/api/resource?'));
  const targets = proxied.map(item => {
    const params = new URL(item.specifier, base).searchParams;
    assert.equal(params.get('from'), 'https://example.com/');
    assert.equal(params.get('sid'), 'module-session');
    return params.get('url');
  });
  assert.deepEqual(targets, ['./side-effect.js', './dep.js', '../parent.js', './named.js',
    './lazy.js', './data.json', "./name's.js"].map(p => new URL(p, base).href));
  const sibling = rewriteJsText('import{a}from"./dep.js"', 'https://example.com/packs/other.js', 'module-session');
  assert.equal(parseImports(sibling)[0][0].specifier, proxied[1].specifier, 'sibling modules share one dependency instance');
}

// Bare-origin string literals must stay verbatim in rewritten JS: apps parse
// them with new URL(...) and compare hostnames (browser.lol's app-origin
// constant gates Google One Tap; a relative /api/resource form makes the
// parse throw and crashes hydration). Same-origin literals WITH a path keep
// being rewritten so bundled asset URLs stay same-origin.
{
  const js = `62477,e=>{"use strict";e.s(["f",0,"https://browser.lol"])},1,e=>{fetch("https://browser.lol/img/x.png")}`;
  const out = rewriteJsText(js, 'https://browser.lol/_next/static/chunks/app.js', 'sid1');
  assert.match(out, /"https:\/\/browser\.lol"/);
  assert.doesNotMatch(out, /"\/api\/resource\?url=https%3A%2F%2Fbrowser\.lol%2F&/);
  assert.match(out, /"\/api\/resource\?url=https%3A%2F%2Fbrowser\.lol%2Fimg%2Fx\.png/);
}

// Browserling's runtime joins stylesheet filenames to an absolute base.
// The directory must stay intact until the computed link href is set.
{
  const site = 'https://www.browserling.com';
  const base = `${site}/css/new-browse-page/`;
  const js = `const styles="${base}"; link.href=styles+"menu.css"; fetch("${base}fixed.css");`;
  const out = rewriteJsText(js, `${site}/js/new-browse-page/bundle.js`, 'css-test');
  assert.ok(out.includes(`const styles="${base}"; link.href=styles+"menu.css"`));
  assert.ok(out.includes(`fetch("/api/resource?url=${encodeURIComponent(`${base}fixed.css`)}&`));
}
// srcFix's script flag is a real parameter now (it used to be a free variable
// that threw ReferenceError and silently disabled the whole script-form
// logic): same-origin script URLs keep their path, other origins get proxied.
// Behavioral coverage lives in tests/srcfix-script-forms.test.js, which runs
// the real emitted srcFix from injectRuntime in a fake proxy environment.

assert.equal(cacheSafeUrl('https://example.com/public?page=2'), true);
assert.equal(cacheSafeUrl('https://example.com/private?access_token=secret'), false);
assert.equal(cacheSafeUrl('https://user:pass@example.com/public'), false);
assert.equal(cacheSafeResponse({ ok: true, status: 200, cacheControl: 'public, max-age=60' }, 'https://example.com/public'), true);
for (const response of [
  { ok: true, status: 200, cacheControl: 'private, max-age=60' },
  { ok: true, status: 200, cacheControl: 'no-store' },
  { ok: true, status: 200, vary: 'Accept-Language' },
  { ok: true, status: 200, setCookieHeader: 'sid=secret' },
  { ok: true, status: 503 },
  { ok: true, status: 200, truncated: true }
]) assert.equal(cacheSafeResponse(response, 'https://example.com/public'), false);

const html = `<!doctype html><html><head></head><body>
  <script data-deferredsrc="/js/geofs.js?kc=3910"></script>
  <img data-deferredsrc="images/planes/c172.png">
  <script defer src="/projects/CESIUM/Build/Cesium/Cesium.js" obfuscation="update" dest="js/Cesium/build/Cesium.js"></script>
</body></html>`;
const out = rewriteHtml(html, 'https://www.geo-fs.com/geofs.php', 'proxy-test');

assert.match(out, /data-deferredsrc="\/api\/resource\?url=https%3A%2F%2Fwww\.geo-fs\.com%2Fjs%2Fgeofs\.js%3Fkc%3D3910/);
assert.match(out, /data-deferredsrc="\/api\/resource\?url=https%3A%2F%2Fwww\.geo-fs\.com%2Fimages%2Fplanes%2Fc172\.png/);
// Same-origin <script src> keeps its real path: Turbopack-style chunk loaders
// key lazy chunk registrations by the raw src attribute, and query-form
// /api/resource URLs break that match so hydration hangs (browser.lol).
// The escaped-path fallback middleware serves path-form script srcs.
assert.match(out, /src="\/projects\/CESIUM\/Build\/Cesium\/Cesium\.js"/);
assert.doesNotMatch(out, /src="\/api\/resource\?url=https%3A%2F%2Fwww\.geo-fs\.com%2Fprojects/);
assert.match(out, /dest="\/api\/resource\?url=https%3A%2F%2Fwww\.geo-fs\.com%2Fjs%2FCesium%2Fbuild%2FCesium\.js/);
assert.doesNotMatch(out, /data-deferredsrc="\/js\/geofs\.js/);
assert.doesNotMatch(out, /dest="js\/Cesium\/build\/Cesium\.js/);
assert.doesNotMatch(out, /api\/resource\?url=https%3A%2F%2Fwww\.geo-fs\.com\/api\/resource/);

// /cdn-cgi/ (Cloudflare challenge platform) scripts are the ONE same-origin
// exception: the proxy host (Render) is itself behind Cloudflare, whose edge
// answers path-form /cdn-cgi/ requests with its own copy — the site's managed
// challenge would load the wrong domain's challenge platform and never
// complete (poxel.io). Script tags AND script preloads for /cdn-cgi/ must be
// rewritten to the proxied query form, while ordinary chunk paths stay native.
{
  const cf = rewriteHtml(
    '<html><head>' +
    '<link rel="preload" as="script" href="/cdn-cgi/challenge-platform/scripts/jsd/main.js">' +
    '<link rel="preload" as="script" href="/_next/static/chunks/x.js">' +
    '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=r1"></script>' +
    '<script src="/_next/static/chunks/y.js"></script>' +
    '</head></html>',
    'https://poxel.io/', 'cf-test');
  // challenge-platform script + preload are proxied
  assert.match(cf, /src="\/api\/resource\?url=https%3A%2F%2Fpoxel\.io%2Fcdn-cgi%2Fchallenge-platform%2Fh%2Fb%2Forchestrate/);
  assert.match(cf, /href="\/api\/resource\?url=https%3A%2F%2Fpoxel\.io%2Fcdn-cgi%2Fchallenge-platform%2Fscripts%2Fjsd%2Fmain\.js/);
  assert.doesNotMatch(cf, /src="\/cdn-cgi\//);
  assert.doesNotMatch(cf, /href="\/cdn-cgi\//);
  // ordinary same-origin script + preload keep the path form (Turbopack)
  assert.match(cf, /src="\/_next\/static\/chunks\/y\.js"/);
  assert.match(cf, /href="\/_next\/static\/chunks\/x\.js"/);
}
const alias = rewriteHtml('<html><body><img src="/images/icons/favicon.ico"></body></html>', 'https://geofs.com/geofs.php', 'proxy-alias');
assert.match(alias, /https%3A%2F%2Fwww\.geo-fs\.com%2Fimages%2Ficons%2Ffavicon\.ico/);
const inlineGeoFs = rewriteHtml(`<html><head><script>
  geofs.srtmServer = "https://data.geo-fs.com/srtm/";
  geofs.weatherServer = "https://weather.geo-fs.com/";
  geofs.multiplayerHost = "https://mps.geo-fs.com";
  geofs.osmTileProvider = "https://data.geo-fs.com/osm/{z}/{x}/{y}.png";
</script></head></html>`, 'https://www.geo-fs.com/geofs.php?v=3.9', 'inline-geofs');
// srtmServer (used by Cesium's CesiumTerrainProvider as a *base* for tile
// templates with a "?v=" query) must STAY ABSOLUTE. The runtime fetch/XHR
// patch wraps each tile request. Rewriting it to /api/resource?url=... makes
// Cesium's getDerivedResource replace the whole query string and produce
// 404s at /api/resource/<z>/<x>/<y>.terrain.
assert.match(inlineGeoFs, /geofs\.srtmServer\s*=\s*"https:\/\/data\.geo-fs\.com\/srtm\/"/);
assert.doesNotMatch(inlineGeoFs, /srtmServer[^;]*\/api\/resource\?url=/);
// Bare-origin server constants ("https://weather.geo-fs.com/", "https://mps.geo-fs.com")
// stay verbatim: loaders concatenate paths onto them (a query-string proxy URL
// would corrupt the concatenation), and app code parses them with new URL()
// (browser.lol's app-origin constant). Real fetches are proxied by the runtime
// fetch/XHR wrappers instead.
assert.match(inlineGeoFs, /geofs\.weatherServer\s*=\s*"https:\/\/weather\.geo-fs\.com\/"/);
assert.match(inlineGeoFs, /geofs\.multiplayerHost\s*=\s*"https:\/\/mps\.geo-fs\.com"/);
assert.doesNotMatch(inlineGeoFs, /weatherServer[^;]*\/api\/resource\?url=/);
assert.doesNotMatch(inlineGeoFs, /multiplayerHost[^;]*\/api\/resource\?url=/);
assert.match(inlineGeoFs, /\/api\/resource\?url=https%3A%2F%2Fdata\.geo-fs\.com%2Fosm%2F\{z\}%2F\{x\}%2F\{y\}\.png/);
assert.doesNotMatch(inlineGeoFs, /data\.geo-fs\.com%2Fosm%2F%7Bz%7D/);

// Regression: the rewritten Cesium <script src> ends with "Cesium.js" followed by
// the proxy's own query params, so Cesium's /((?:.*\/)|^)Cesium\.js(?:\?|#|$)/
// regex no longer matches its own <script src>. buildModuleUrl then falls back
// to location.origin + "/" + undefined and requests Assets/... become 404s
// (/undefined/Assets/approximateTerrainHeights.json).
// The fix injects <script>window.CESIUM_BASE_URL = "...";</script> before any
// Cesium.js script so buildModuleUrl uses a real upstream base.
{
  const out2 = rewriteHtml(html, 'https://www.geo-fs.com/geofs.php', 'cesium-base');
  // Verify CESIUM_BASE_URL is injected for the dest-based Cesium.js script
  // and points at the real parent directory of Cesium.js.
  assert.match(out2, /window\.CESIUM_BASE_URL\s*=\s*"https:\/\/www\.geo-fs\.com\/js\/Cesium\/build\/"/);
  assert.match(out2, /window\.CESIUM_BASE_URL\s*=\s*"https:\/\/www\.geo-fs\.com\/projects\/CESIUM\/Build\/Cesium\/"/);
}
// Do NOT inject CESIUM_BASE_URL on pages that don't load Cesium.js.
{
  const nonCesium = rewriteHtml('<html><body><script src="https://example.com/app.js"></script></body></html>', 'https://example.com/', 'no-cesium');
  assert.doesNotMatch(nonCesium, /window\.CESIUM_BASE_URL/);
}

console.log('Proxy rewrite regression tests passed');
