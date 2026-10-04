const { createRequire } = require('module');
const fs = require('fs');
try {
  const playwright = createRequire(__filename)('playwright');
  const exe = playwright.chromium.executablePath();
  if (exe && fs.existsSync(exe)) { console.log('[VEYRA] Chromium executable present.'); process.exit(0); }
  console.warn('[VEYRA] Chromium executable is missing. Browser engine will be unavailable until the build installs Chromium.');
} catch (e) {
  console.warn('[VEYRA] Playwright/Chromium check failed:', e.message);
}
