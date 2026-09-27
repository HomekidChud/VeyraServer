const fs = require("fs");
const path = require("path");
const s = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
function ok(name, cond) { if (!cond) throw new Error(`FAIL ${name}`); console.log("PASS", name); }
ok("/api/open creates bounded page accelerator jobs", s.includes('const job = createJob(root, { pageAccelerator: CFG.crawlerPageAccelerator });'));
ok("page accelerator has a critical phase but continues background warming", s.includes('this.job.pageAccelerator && this.job.warmDeadlineAt') && s.includes('Critical page resources warmed; finishing required assets in the background'));
ok("navigation expansion is disabled in page accelerator", s.includes('if (job.pageAccelerator && u !== job.root) return true;'));
ok("critical preload hints are generated", s.includes('function criticalPreloadHtml') && s.includes('const preloadCandidates = extractWarmUrls'));
ok("inline assets are warmed without executing page code", s.includes('function extractInlineWarmUrls') && s.includes('Scan literals only; never execute the page.'));
console.log("Veyra page accelerator regression checks passed");
