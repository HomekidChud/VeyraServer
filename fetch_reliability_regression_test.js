const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'server.js');
const s = fs.readFileSync(file, 'utf8');
const checks = [
  ['direct HTTP dispatcher uses IPv4/IPv6 family selection', /autoSelectFamily:\s*true/.test(s)],
  ['direct HTTP dispatcher has connection timeout', /connect:\s*\{\s*timeout:\s*12000/.test(s)],
  ['direct network alternates dispatcher on retries', /attempt % 2 === 0 \? DIRECT_HTTP_AGENT : undefined/.test(s)],
  ['upstream fetch failures preserve cause codes', /function networkErrorCode\(err\)/.test(s) && /e\.upstreamCode = networkErrorCode\(err\)/.test(s)],
  ['transient connection errors are retried', /function isRetryableNetworkError\(err\)/.test(s) && /isRetryableNetworkError\(e\)/.test(s)],
  ['view errors return useful upstream diagnostics', /const upstreamCode = e\.upstreamCode/.test(s) && /legacyCode: "PROXY_VIEW_ERROR"/.test(s) && /upstreamPhase: e\.upstreamPhase/.test(s)],
  ['VPN kill switch cannot fall back to direct fetch', /vpnEnabledForRequest && !suppliedDispatcher && vpnManager\.killSwitch/.test(s)],
  ['direct dispatcher is closed during shutdown', /DIRECT_HTTP_AGENT\.close\(\)/.test(s)],
];
let failed = 0;
for (const [name, ok] of checks) { if (ok) console.log(`PASS ${name}`); else { console.error(`FAIL ${name}`); failed++; } }
if (failed) process.exit(1);
console.log('Veyra fetch reliability regression checks passed');
