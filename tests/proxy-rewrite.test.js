const assert = require('assert');
const { rewriteHtml, cacheSafeUrl, cacheSafeResponse } = require('../src/server');

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
assert.match(out, /src="\/api\/resource\?url=https%3A%2F%2Fwww\.geo-fs\.com%2Fprojects%2FCESIUM%2FBuild%2FCesium%2FCesium\.js/);
assert.match(out, /dest="\/api\/resource\?url=https%3A%2F%2Fwww\.geo-fs\.com%2Fjs%2FCesium%2Fbuild%2FCesium\.js/);
assert.doesNotMatch(out, /data-deferredsrc="\/js\/geofs\.js/);
assert.doesNotMatch(out, /dest="js\/Cesium\/build\/Cesium\.js/);
assert.doesNotMatch(out, /api\/resource\?url=https%3A%2F%2Fwww\.geo-fs\.com\/api\/resource/);
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
assert.match(inlineGeoFs, /\/api\/resource\?url=https%3A%2F%2Fweather\.geo-fs\.com%2F/);
assert.match(inlineGeoFs, /\/api\/resource\?url=https%3A%2F%2Fmps\.geo-fs\.com/);
assert.match(inlineGeoFs, /\/api\/resource\?url=https%3A%2F%2Fdata\.geo-fs\.com%2Fosm%2F\{z\}%2F\{x\}%2F\{y\}\.png/);
assert.doesNotMatch(inlineGeoFs, /data\.geo-fs\.com%2Fosm%2F%7Bz%7D/);

// Regression: OSM tile templates (e.g. https://data.geo-fs.com/osm/{z}/{x}/{y}.png)
// must keep the literal {z}/{x}/{y} braces in the /api/resource?url= query. The
// browser's `new URL()` normalizes braces in the path to %7B, and if the runtime
// then re-encodes the URL with encodeURIComponent(), the result is %257B — a
// double-encoding that breaks tile substitution (tile requests fail with
// /osm/%7Bz%7D/%7Bx%7D/%7By%7D.png 404s).
// The runtime proxy() helper must un-encode the braces before building the
// /api/resource?url=... query, and after encodeURIComponent, restore literal braces.
{
  const osmHtml = rewriteHtml('<html><head><script>geofs.osmTileProvider = "https://data.geo-fs.com/osm/{z}/{x}/{y}.png";</script></head></html>', 'https://www.geo-fs.com/geofs.php', 'osm-tpl');
  const match = osmHtml.match(/osmTileProvider = "([^"]+)"/);
  assert.ok(match, 'osmTileProvider was not rewritten');
  const rewritten = match[1];
  assert.match(rewritten, /\/api\/resource\?url=/);
  assert.match(rewritten, /osm%2F\{z\}%2F\{x\}%2F\{y\}\.png/, 'braces must stay literal in the /api/resource query');
  assert.doesNotMatch(rewritten, /%257B/, 'double-encoded braces (%257B) must not appear');
}

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
