// Regression: YouTube (and other Google frontends) return HTTP 400 when a GET
// carries "content-type: undefined". Also guards the injected runtime script
// against template-literal escape loss that produced a SyntaxError in the page.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
process.env.PROCESS_ROLE = process.env.PROCESS_ROLE || 'web';
const { injectRuntime } = require('./server.js');
function ok(name, cond) { if (!cond) throw new Error(`FAIL ${name}`); console.log('PASS', name); }

const html = injectRuntime('<html><head></head><body></body></html>', 'https://www.youtube.com/', 'abc123');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
ok('runtime script injected', scripts.length > 0);
for (const [i, code] of scripts.entries()) {
  let err = null; try { new vm.Script(code); } catch (e) { err = e; }
  ok(`injected runtime script #${i} parses (${err ? err.message : 'ok'})`, !err);
}
ok('unwrap regex survives template literal', html.includes('/^https?:[/][/]/i'));

const s = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
ok('no undefined content-type forwarded', !s.includes('"content-type": req.get("Content-Type") || undefined'));
ok('forwarded headers strip undefined values', s.includes('out[k] === undefined'));
console.log('Proxy header regression checks passed');
process.exit(0);
