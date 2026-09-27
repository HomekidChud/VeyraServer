const { execFileSync } = require('child_process');
const { createRequire } = require('module');

if (String(process.env.SKIP_PLAYWRIGHT_INSTALL || '').toLowerCase() === 'true') {
  console.log('[VEYRA] SKIP_PLAYWRIGHT_INSTALL=true; skipping Chromium download.');
  process.exit(0);
}

try {
  const requireFromHere = createRequire(__filename);
  requireFromHere('playwright');
} catch (err) {
  console.warn('[VEYRA] Playwright package is not installed yet; npm will finish dependency installation first.');
  process.exit(0);
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
try {
  console.log('[VEYRA] Installing Playwright Chromium browser binary...');
  execFileSync(npx, ['playwright', 'install', 'chromium'], { stdio: 'inherit' });
  console.log('[VEYRA] Playwright Chromium installed.');
} catch (err) {
  console.warn('[VEYRA] Chromium installation did not complete. Browser mode will report BROWSER_ENGINE_UNAVAILABLE and fall back to FAST_PROXY.');
  console.warn(`[VEYRA] ${err.message}`);
}
