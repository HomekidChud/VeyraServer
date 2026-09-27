const { execFileSync } = require('child_process');
const { createRequire } = require('module');
const fs = require('fs');

if (String(process.env.SKIP_PLAYWRIGHT_INSTALL || '').trim().toLowerCase() === 'true') {
  console.log('[VEYRA] SKIP_PLAYWRIGHT_INSTALL=true; skipping Chromium ensure.');
  process.exit(0);
}
let playwright;
try {
  playwright = createRequire(__filename)('playwright');
} catch (e) {
  console.warn('[VEYRA] Playwright is unavailable during startup ensure:', e.message);
  process.exit(0);
}
try {
  const exe = playwright.chromium.executablePath();
  if (exe && fs.existsSync(exe)) process.exit(0);
} catch {}
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
try {
  console.log('[VEYRA] Chromium executable missing; installing Playwright Chromium...');
  execFileSync(npx, ['playwright', 'install', 'chromium'], { stdio: 'inherit' });
  console.log('[VEYRA] Chromium installed.');
} catch (e) {
  console.warn('[VEYRA] Chromium install failed; BROWSER_ENGINE will remain unavailable:', e.message);
}
