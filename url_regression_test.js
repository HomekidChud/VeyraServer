const assert = require('assert');
function queryStringValue(value) {
  if (Array.isArray(value)) return value.map(x => String(x || '').trim()).find(Boolean) || '';
  return String(value || '').trim();
}
function unwrapProxyTarget(value, base) {
  let raw = queryStringValue(value);
  if (!raw) return '';
  for (let i = 0; i < 3; i++) {
    try {
      const probe = new URL(raw, base || undefined);
      if (probe.pathname === '/api/view' || probe.pathname === '/api/resource' || probe.pathname === '/api/download') {
        const embedded = probe.searchParams.get('url') || probe.searchParams.get('target') || probe.searchParams.get('u');
        if (embedded) { raw = embedded; continue; }
        return '';
      }
    } catch {}
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded !== raw && /^https?:\/\//i.test(decoded)) { raw = decoded; continue; }
    } catch {}
    break;
  }
  return raw;
}
function normalizeUrl(value, base) {
  try {
    const raw = unwrapProxyTarget(value, base);
    if (!raw) return null;
    const u = new URL(raw, base);
    if (!['http:','https:'].includes(u.protocol)) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}
const api='https://veyraserver-xscy.onrender.com';
assert.equal(normalizeUrl('https://www.google.com/search?q=SearXNG'), 'https://www.google.com/search?q=SearXNG');
assert.equal(normalizeUrl('/api/view?url=https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3DSearXNG', api), 'https://www.google.com/search?q=SearXNG');
assert.equal(normalizeUrl(encodeURIComponent('https://www.google.com/search?q=hello%20world'), api), 'https://www.google.com/search?q=hello%20world');
function firstValidUrl(values, base) { for (const value of values) { const normalized = normalizeUrl(value, base); if (normalized) return normalized; } return null; }
assert.equal(firstValidUrl(['/api/view?url=', '/api/view?url=https%3A%2F%2Fexample.com%2F'], api), 'https://example.com/');
console.log('Google/search URL regression: PASS');
