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
assert.match(inlineGeoFs, /\/api\/resource\?url=https%3A%2F%2Fdata\.geo-fs\.com%2Fsrtm%2F/);
assert.match(inlineGeoFs, /\/api\/resource\?url=https%3A%2F%2Fweather\.geo-fs\.com%2F/);
assert.match(inlineGeoFs, /\/api\/resource\?url=https%3A%2F%2Fmps\.geo-fs\.com/);
assert.match(inlineGeoFs, /\/api\/resource\?url=https%3A%2F%2Fdata\.geo-fs\.com%2Fosm%2F\{z\}%2F\{x\}%2F\{y\}\.png/);
assert.doesNotMatch(inlineGeoFs, /data\.geo-fs\.com%2Fosm%2F%7Bz%7D/);

console.log('Proxy rewrite regression tests passed');
