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
  <script defer src="/projects/CESIUM/Build/Cesium/Cesium.js" obfuscation="update" dest="js/Cesium/build/Cesium.js"></script>
</body></html>`;
const out = rewriteHtml(html, 'https://www.geo-fs.com/geofs.php', 'proxy-test');

assert.match(out, /data-deferredsrc="\/api\/resource\?url=https%3A%2F%2Fwww\.geo-fs\.com%2Fjs%2Fgeofs\.js%3Fkc%3D3910/);
assert.match(out, /src="\/api\/resource\?url=https%3A%2F%2Fwww\.geo-fs\.com%2Fprojects%2FCESIUM%2FBuild%2FCesium%2FCesium\.js/);
assert.match(out, /dest="\/api\/resource\?url=https%3A%2F%2Fwww\.geo-fs\.com%2Fjs%2FCesium%2Fbuild%2FCesium\.js/);
assert.doesNotMatch(out, /data-deferredsrc="\/js\/geofs\.js/);
assert.doesNotMatch(out, /dest="js\/Cesium\/build\/Cesium\.js/);
assert.doesNotMatch(out, /api\/resource\?url=https%3A%2F%2Fwww\.geo-fs\.com%2Fapi\/resource/);

console.log('Proxy rewrite regression tests passed');
