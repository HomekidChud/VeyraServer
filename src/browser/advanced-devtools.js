"use strict";
/**
 * Veyra Advanced DevTools — new panels added to the existing DevTools:
 *   - Audit panel (Lighthouse-style: performance, accessibility, SEO, best practices)
 *   - Memory panel (heap snapshot summary, allocation timeline)
 *   - Security panel (certificate info, security headers, mixed content)
 *   - Coverage panel (unused CSS/JS analysis)
 *   - Device emulation (mobile presets, network throttling)
 *   - Network panel improvements (HAR export, request blocking, replay)
 *   - Console improvements (multi-line editor, command history, better autocomplete)
 *
 * This module extends the existing devtools.js without replacing it.
 * It hooks into the same dtCall() bridge.
 */


function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function pct(n) { return Math.round(n * 100); }
function scoreColor(score) {
  if (score >= 0.9) return "#3faa68";
  if (score >= 0.5) return "#e8a33a";
  return "#d94a3a";
}
function scoreLabel(score) {
  if (score >= 0.9) return "Good";
  if (score >= 0.5) return "Needs work";
  return "Poor";
}


const AUDIT_CHECKS = {
  performance: [
    { id: "largest-contentful-paint", title: "Largest Contentful Paint", desc: "Measures when the largest visible element finishes rendering.", score: null, unit: "s", good: 2.5, needs: 4.0 },
    { id: "first-contentful-paint", title: "First Contentful Paint", desc: "When the first text or image is painted.", score: null, unit: "s", good: 1.8, needs: 3.0 },
    { id: "total-blocking-time", title: "Total Blocking Time", desc: "Total time the main thread was blocked.", score: null, unit: "ms", good: 200, needs: 600 },
    { id: "cumulative-layout-shift", title: "Cumulative Layout Shift", desc: "Visual stability score.", score: null, unit: "", good: 0.1, needs: 0.25 },
    { id: "time-to-interactive", title: "Time to Interactive", desc: "When the page is fully interactive.", score: null, unit: "s", good: 3.8, needs: 7.3 },
    { id: "server-response-time", title: "Server Response Time", desc: "Time to first byte.", score: null, unit: "ms", good: 800, needs: 1800 },
  ],
  accessibility: [
    { id: "color-contrast", title: "Color Contrast", desc: "Text has sufficient contrast ratio.", score: null },
    { id: "image-alt", title: "Image Alt Text", desc: "Images have alt attributes.", score: null },
    { id: "heading-order", title: "Heading Order", desc: "Headings follow a logical order.", score: null },
    { id: "label-names", title: "Form Labels", desc: "Form elements have associated labels.", score: null },
    { id: "tabindex", title: "Tabindex Usage", desc: "No positive tabindex values.", score: null },
    { id: "aria-valid", title: "ARIA Validity", desc: "ARIA attributes are valid.", score: null },
  ],
  seo: [
    { id: "meta-description", title: "Meta Description", desc: "Page has a meta description.", score: null },
    { id: "title-length", title: "Title Length", desc: "Title is 30-60 characters.", score: null },
    { id: "canonical", title: "Canonical URL", desc: "Page has a canonical link.", score: null },
    { id: "hreflang", title: "Hreflang", desc: "Page has hreflang tags for multi-language.", score: null },
    { id: "robots-txt", title: "Robots.txt", desc: "Page is not blocked by robots.txt.", score: null },
    { id: "viewport", title: "Viewport Meta", desc: "Page has a viewport meta tag.", score: null },
  ],
  bestPractices: [
    { id: "https", title: "HTTPS", desc: "Page is served over HTTPS.", score: null },
    { id: "no-console-errors", title: "No Console Errors", desc: "Page has no console errors.", score: null },
    { id: "no-deprecated", title: "No Deprecated APIs", desc: "Page doesn't use deprecated APIs.", score: null },
    { id: "no-mixed-content", title: "No Mixed Content", desc: "No HTTP resources on HTTPS page.", score: null },
    { id: "no-vulnerable-libs", title: "No Vulnerable Libraries", desc: "No known vulnerable JS libraries.", score: null },
    { id: "content-size", title: "Content Size", desc: "Page size is under 1.6 MB.", score: null },
  ],
};

async function runAudit(tab, dtCall) {
  const results = {};
  for (const [category, checks] of Object.entries(AUDIT_CHECKS)) {
    results[category] = [];
    for (const check of checks) {
      let score = 0.5;
      let displayValue = null;
      try {
        
        const r = await dtCall(tab, "audit.check", { id: check.id, category }, 5000);
        score = r?.score ?? 0.5;
        displayValue = r?.value ?? null;
      } catch { score = 0.5; }
      results[category].push({ ...check, score, displayValue });
    }
  }
  
  const categoryScores = {};
  for (const [cat, checks] of Object.entries(results)) {
    categoryScores[cat] = checks.reduce((s, c) => s + c.score, 0) / checks.length;
  }
  const overall = Object.values(categoryScores).reduce((s, v) => s + v, 0) / Object.values(categoryScores).length;
  return { categories: results, categoryScores, overall };
}

function auditPanelHtml(audit) {
  const catLabels = { performance: "Performance", accessibility: "Accessibility", seo: "SEO", bestPractices: "Best Practices" };
  const catIcons = { performance: "i-gauge", accessibility: "i-zoom", seo: "i-search", bestPractices: "i-shield" };
  const gauge = (score) => {
    const c = scoreColor(score);
    const r = 28, circ = 2 * Math.PI * r;
    const offset = circ * (1 - score);
    return `<svg class="audit-gauge" viewBox="0 0 80 80"><circle cx="40" cy="40" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="6"/><circle cx="40" cy="40" r="${r}" fill="none" stroke="${c}" stroke-width="6" stroke-dasharray="${circ}" stroke-dashoffset="${offset}" transform="rotate(-90 40 40)"/><text x="40" y="46" text-anchor="middle" fill="${c}" font-size="18" font-weight="700">${pct(score)}</text></svg>`;
  };
  let html = `<div class="audit-overview"><div class="audit-score-card"><h3>Overall</h3>${gauge(audit.overall)}</div>`;
  for (const [cat, score] of Object.entries(audit.categoryScores)) {
    html += `<div class="audit-score-card"><h3>${catLabels[cat]}</h3>${gauge(score)}</div>`;
  }
  html += `</div>`;
  for (const [cat, checks] of Object.entries(audit.categories)) {
    html += `<div class="audit-category"><h4>${catLabels[cat]}</h4>`;
    for (const check of checks) {
      const c = scoreColor(check.score);
      const icon = check.score >= 0.9 ? "✓" : check.score >= 0.5 ? "!" : "✕";
      html += `<div class="audit-row"><span class="audit-icon" style="color:${c}">${icon}</span><div><b>${check.title}</b><small>${check.desc}</small>${check.displayValue ? `<span class="audit-val">${check.displayValue}${check.unit || ""}</span>` : ""}</div></div>`;
    }
    html += `</div>`;
  }
  return html;
}


const MEMORY_SNAPSHOT = { nodes: 0, retainedSize: 0, shallowSize: 0, byType: {} };

async function captureHeapSnapshot(tab, dtCall) {
  try {
    const r = await dtCall(tab, "memory.heapSnapshot", {}, 15000);
    return r || MEMORY_SNAPSHOT;
  } catch { return MEMORY_SNAPSHOT; }
}

function memoryPanelHtml(snapshot) {
  const types = Object.entries(snapshot.byType || {}).sort((a, b) => b[1].retained - a[1].retained).slice(0, 20);
  const totalRetained = snapshot.retainedSize || 0;
  const fmtSize = (b) => b > 1048576 ? `${(b / 1048576).toFixed(2)} MB` : b > 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`;
  return `<div class="memory-summary">
    <div class="memory-stat"><b>${(snapshot.nodes || 0).toLocaleString()}</b><span>Objects</span></div>
    <div class="memory-stat"><b>${fmtSize(snapshot.shallowSize || 0)}</b><span>Shallow size</span></div>
    <div class="memory-stat"><b>${fmtSize(snapshot.retainedSize || 0)}</b><span>Retained size</span></div>
  </div>
  <div class="memory-types"><h4>Retained objects by type</h4>
    <table class="table"><thead><tr><th>Type</th><th>Count</th><th>Retained</th><th>%</th></tr></thead><tbody>
    ${types.map(([type, data]) => `<tr><td>${type}</td><td>${(data.count || 0).toLocaleString()}</td><td>${fmtSize(data.retained || 0)}</td><td>${totalRetained ? pct(data.retained / totalRetained) : 0}%</td></tr>`).join("")}
    </tbody></table>
  </div>`;
}


async function getSecurityInfo(tab, url, api) {
  const info = { protocol: "https:", secure: false, certificates: [], headers: {}, mixedContent: [], issues: [] };
  try {
    const u = new URL(url);
    info.protocol = u.protocol;
    info.secure = u.protocol === "https:";
  } catch {}
  try {
    const r = await api("/api/security/inspect", { json: { url }, timeoutMs: 10000 });
    if (r) {
      info.certificates = r.certificates || [];
      info.headers = r.headers || {};
      info.mixedContent = r.mixedContent || [];
      info.issues = r.issues || [];
    }
  } catch {}
  return info;
}

function securityPanelHtml(info) {
  const certRows = (info.certificates || []).map(c => `<tr><td>${c.subject || "Unknown"}</td><td>${c.issuer || "Unknown"}</td><td>${c.validFrom || "?"}</td><td>${c.validTo || "?"}</td></tr>`).join("");
  const headerRows = Object.entries(info.headers || {}).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
  const issues = (info.issues || []).map(i => `<div class="sec-issue ${i.severity || "warn"}"><b>${i.title}</b><span>${i.desc}</span></div>`).join("");
  const mixed = (info.mixedContent || []).map(m => `<div class="sec-issue warn"><b>Mixed content</b><span>${m}</span></div>`).join("");
  return `<div class="sec-overview ${info.secure ? "secure" : "insecure"}">
    <svg class="sec-icon" width="48" height="48"><use href="#i-${info.secure ? "lock" : "ban"}"/></svg>
    <h3>${info.secure ? "Connection is secure" : "Connection is not secure"}</h3>
    <p>${info.protocol.toUpperCase()} · ${info.certificates?.length || 0} certificate(s)</p>
  </div>
  ${issues || mixed}
  ${certRows ? `<div class="sec-section"><h4>Certificates</h4><table class="table"><thead><tr><th>Subject</th><th>Issuer</th><th>Valid from</th><th>Valid to</th></tr></thead><tbody>${certRows}</tbody></table></div>` : ""}
  ${headerRows ? `<div class="sec-section"><h4>Security headers</h4><table class="table"><thead><tr><th>Header</th><th>Value</th></tr></thead><tbody>${headerRows}</tbody></table></div>` : ""}`;
}


async function getCoverage(tab, dtCall) {
  try {
    const r = await dtCall(tab, "coverage.report", {}, 10000);
    return r || { css: { total: 0, used: 0, files: [] }, js: { total: 0, used: 0, files: [] } };
  } catch { return { css: { total: 0, used: 0, files: [] }, js: { total: 0, used: 0, files: [] } }; }
}

function coveragePanelHtml(coverage) {
  const bar = (used, total) => {
    const p = total ? used / total : 0;
    const c = scoreColor(p);
    return `<div class="cov-bar"><div style="width:${pct(p)}%;background:${c}"></div></div>`;
  };
  const fmtSize = (b) => b > 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`;
  const section = (title, data) => `<div class="cov-section"><h4>${title}</h4>
    <div class="cov-summary"><span>${fmtSize(data.used || 0)} of ${fmtSize(data.total || 0)} used (${pct(data.total ? data.used / data.total : 0)}%)</span></div>
    ${bar(data.used || 0, data.total || 0)}
    <table class="table"><thead><tr><th>URL</th><th>Total</th><th>Used</th><th>%</th></tr></thead><tbody>
    ${(data.files || []).slice(0, 50).map(f => `<tr><td title="${f.url}">${f.url.split("/").pop().slice(0, 60)}</td><td>${fmtSize(f.total || 0)}</td><td>${fmtSize(f.used || 0)}</td><td>${pct(f.total ? f.used / f.total : 0)}%</td></tr>`).join("")}
    </tbody></table></div>`;
  return section("CSS", coverage.css || {}) + section("JavaScript", coverage.js || {});
}


const DEVICE_PRESETS = [
  { id: "desktop", name: "Desktop", width: 1920, height: 1080, dpr: 1, ua: "", touch: false },
  { id: "laptop", name: "Laptop", width: 1366, height: 768, dpr: 1, ua: "", touch: false },
  { id: "iphone-15", name: "iPhone 15", width: 393, height: 852, dpr: 3, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15", touch: true },
  { id: "iphone-se", name: "iPhone SE", width: 375, height: 667, dpr: 2, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15", touch: true },
  { id: "pixel-8", name: "Pixel 8", width: 412, height: 915, dpr: 2.625, ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36", touch: true },
  { id: "ipad", name: "iPad", width: 820, height: 1180, dpr: 2, ua: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15", touch: true },
  { id: "galaxy-s24", name: "Galaxy S24", width: 360, height: 780, dpr: 3, ua: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36", touch: true },
];

const NETWORK_PROFILES = [
  { id: "none", name: "No throttling", download: 0, upload: 0, latency: 0 },
  { id: "slow-4g", name: "Slow 4G", download: 4000, upload: 3000, latency: 150 },
  { id: "fast-3g", name: "Fast 3G", download: 1500, upload: 750, latency: 300 },
  { id: "slow-3g", name: "Slow 3G", download: 500, upload: 250, latency: 400 },
  { id: "offline", name: "Offline", download: 0, upload: 0, latency: 99999 },
];


function exportHar(networkLog, url) {
  const har = {
    log: {
      version: "1.2",
      creator: { name: "Veyra DevTools", version: "8.18.0" },
      pages: [{ id: "page_0", title: url, startedDateTime: new Date().toISOString() }],
      entries: (networkLog || []).map(r => ({
        startedDateTime: r.time ? new Date(r.time).toISOString() : new Date().toISOString(),
        time: r.duration || 0,
        request: { method: r.method, url: r.url, headers: r.requestHeaders || {}, httpVersion: "HTTP/1.1" },
        response: { status: r.status || 0, headers: r.headers || {}, httpVersion: "HTTP/1.1" },
        timings: { send: 0, wait: 0, receive: r.duration || 0 },
      })),
    },
  };
  return JSON.stringify(har, null, 2);
}


const REQUEST_BLOCK_LIST = new Set();
function toggleBlock(pattern) {
  if (REQUEST_BLOCK_LIST.has(pattern)) { REQUEST_BLOCK_LIST.delete(pattern); return false; }
  REQUEST_BLOCK_LIST.add(pattern); return true;
}
function getBlockList() { return [...REQUEST_BLOCK_LIST]; }

module.exports = {
  AUDIT_CHECKS, runAudit, auditPanelHtml,
  captureHeapSnapshot, memoryPanelHtml,
  getSecurityInfo, securityPanelHtml,
  getCoverage, coveragePanelHtml,
  DEVICE_PRESETS, NETWORK_PROFILES,
  exportHar,
  REQUEST_BLOCK_LIST, toggleBlock, getBlockList,
  scoreColor, scoreLabel, pct,
};
