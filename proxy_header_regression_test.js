// Proxy regression checks for the YouTube / SPA loading fixes.
//  - GET requests must never carry "content-type: undefined" (Google returns 400).
//  - The injected runtime must parse (template-literal escapes lost -> SyntaxError).
//  - fetch() hook: real Request URL (spoofed data: Requests), URL objects,
//    own-origin/relative paths map onto the real site.
//  - JS rewriter must not rewrite partial dynamic-import prefixes.
//  - Oversize resources stream instead of 413; raw request bodies are relayed.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { injectRuntime, rewriteJsText } = require('./server.js');
function ok(name, cond) { if (!cond) throw new Error(`FAIL ${name}`); console.log('PASS', name); }

const s = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
ok('no undefined content-type forwarded', !s.includes('"content-type": req.get("Content-Type") || undefined'));
ok('forwarded headers strip undefined values', s.includes('out[k] === undefined'));
ok('custom x-* API headers are relayed', s.includes('x-goog-api-key') || s.includes('Relay them'));
ok('raw request bodies are relayed for proxy routes', s.includes('express.raw({ type: () => true') && s.includes('Buffer.isBuffer(req.body)'));
ok('oversize resources stream instead of 413', s.includes('function streamOversizeResponse') && s.includes('streamOversize: mode === "resource"'));
ok('relative-path fallback route exists', s.includes('function proxiedPageFromReferer') && s.includes('resolveEscapedChunk'));

const html = injectRuntime('<html><head></head><body></body></html>', 'https://github.com/microsoft/playwright', 'sid1');
const code = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
ok('runtime script injected', !!code);
let parseErr = null; try { new vm.Script(code); } catch (e) { parseErr = e; }
ok(`injected runtime parses${parseErr ? ' (' + parseErr.message + ')' : ''}`, !parseErr);

// Minimal browser-like realm to exercise the fetch hook's URL mapping.
const loc = new URL('http://veyra.test/api/view?url=https%3A%2F%2Fgithub.com%2Fmicrosoft%2Fplaywright&sid=sid1');
let captured = [];
class FakeRequest { constructor(u) { this._u = u; this.method = 'GET'; this.headers = []; } get url() { return this._u; } clone() { return this; } arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)); } }
const win = { location: loc, postMessage() {}, addEventListener() {}, setInterval() {}, performance: { now: () => 0 },
  history: { state: null, replaceState() {}, pushState() {} }, History: function () {}, Location: function () {}, navigator: {},
  document: { cookie: '', addEventListener() {}, title: '' }, URL, URLSearchParams, Request: FakeRequest, Response: class {}, FormData: class {},
  HTMLFormElement: function () {}, XMLHttpRequest: function () {}, console, Promise };
win.History.prototype = { pushState() {}, replaceState() {} }; win.HTMLFormElement.prototype = {}; win.XMLHttpRequest.prototype = { open() {}, send() {} };
win.top = win; win.parent = win; win.window = win; win.self = win;
win.fetch = (u) => { captured.push(String(u && u._u || u)); return Promise.resolve({ status: 200, ok: true }); };
vm.createContext(win); vm.runInContext(code, win);
function mapped(input) { captured = []; win.fetch(input); const u = new URL(captured[0], 'http://veyra.test'); return u.pathname === '/api/resource' ? u.searchParams.get('url') : captured[0]; }
ok('location-derived /api/view/<rest> maps to real page path', mapped('/api/view/latest-commit') === 'https://github.com/microsoft/playwright/latest-commit');
ok('page-relative path resolves against real page', mapped('latest-commit') === 'https://github.com/microsoft/latest-commit');
ok('root-relative path maps to real origin', mapped('/microsoft/playwright/tree') === 'https://github.com/microsoft/playwright/tree');
ok('query-only relative keeps real path', mapped('?tab=x') === 'https://github.com/microsoft/playwright?tab=x');
ok('absolute cross-origin URL is proxied as-is', mapped('https://api.github.com/x') === 'https://api.github.com/x');
ok('URL objects are not collapsed to the page URL', mapped(new URL('https://api.github.com/y')) === 'https://api.github.com/y');
const spoof = new FakeRequest('data:application/json;base64,e30=');
Object.defineProperty(spoof, 'url', { get() { return 'https://www.youtube.com/youtubei/v1/player'; } });
captured = []; win.fetch(spoof);
ok('spoofed-url data: Request is passed through natively', captured[0] === 'data:application/json;base64,e30=');

const base = 'https://cdn.example/assets/app.js';
ok('partial dynamic import prefix left alone', rewriteJsText('import("./"+c)', base, 's') === 'import("./"+c)');
ok('literal dynamic import rewritten', rewriteJsText('import("./chunk.js")', base, 's').includes('/api/resource?url=https%3A%2F%2Fcdn.example%2Fassets%2Fchunk.js'));
ok('static import rewritten', rewriteJsText('import x from "./x.js";', base, 's').includes('cdn.example%2Fassets%2Fx.js'));
ok('string mentioning import( untouched', rewriteJsText('const s="import(" + x', base, 's') === 'const s="import(" + x');

console.log('Proxy regression checks passed');
process.exit(0);
