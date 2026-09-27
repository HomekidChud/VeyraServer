const fs = require('fs');
const path = require('path');
const s = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
function ok(name, cond) { if (!cond) throw new Error(`FAIL ${name}`); console.log('PASS', name); }
ok('logical robot bundle config exists', s.includes('ROBOT_BUNDLE_SIZE'));
ok('adaptive host policy exists', s.includes('hostConcurrencyLimit(job, host)') && s.includes('noteHostSuccess(job, host)') && s.includes('noteHostError(job, host)'));
ok('frontier accepts dynamic host limits', s.includes('typeof perHostLimit === "function"'));
ok('external HTML links are recorded', s.includes('if (type === "html" && !internal) return true;'));
ok('background sitemap loading', s.includes('void loadSitemaps(job)'));
ok('browser discoveries return to crawler', s.includes('job.browserDiscoveredCount') && s.includes('browser-network'));
ok('broad page scan exists', s.includes('broad-scan') && s.includes('MAX_BROAD_SCAN_CHARS'));
ok('GET form actions preserve target', s.includes('data-veyra-action') && s.includes('GET form submissions replace the URL query component'));
ok('proxy referrer recovery is validated', s.includes('function proxyRefererCanonical') && s.includes('proxyRefererCanonical(req)'));

ok('retryable crawl failures requeue', s.includes('targetFrontier.requeue'));
ok('render critical resources have a dedicated frontier', s.includes('criticalResourceFrontier'));
ok('status includes new robot bundle configuration', s.includes('robotBundleSize'));
ok('browser binary ensure script is wired', fs.existsSync(path.join(__dirname, 'ensure-browser.js')) && fs.existsSync(path.join(__dirname, 'render.yaml')));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname,'package.json'),'utf8'));
ok('prestart browser ensure is wired', pkg.scripts && pkg.scripts.prestart === 'node ensure-browser.js');
console.log('Veyra static regression checks passed');
