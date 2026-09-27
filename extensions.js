// Veyra extensions: built-in page extensions (run through the page bridge) + developer CSS manifests.
import { $, esc, hostOf, uid, load, save, settings, saveSettings, hooks, toast, openFloating, closeFloating, api, addLog, copyText } from "./core.js";
import { dtCall, isRemote } from "./bridge.js";

let B;
const BUILTIN = [
  { id: "dark", name: "Dark Reader", icon: "i-moon", desc: "Renders every site in a dark theme while keeping images and video natural.", feature: "dark" },
  { id: "adblock", name: "Tracker & ad blocker", icon: "i-ban", desc: "Blocks known tracker requests on the server and hides ad slots in the page.", feature: "adblock", server: true },
  { id: "focus", name: "Focus mode", icon: "i-circle", desc: "Hides sidebars, sticky bars, cookie banners and newsletter pop-ups.", feature: "focus", also: ["nosticky"] },
  { id: "readable", name: "Readable text", icon: "i-book", desc: "Larger text, comfortable line length and spacing on any page.", feature: "readable" },
  { id: "links", name: "Link highlighter", icon: "i-link", desc: "Outlines every link so you can see where you can click.", feature: "links" },
  { id: "grayscale", name: "Grayscale", icon: "i-layers", desc: "Removes colour from pages to cut distraction.", feature: "grayscale" },
  { id: "reader", name: "Reader view", icon: "i-book", desc: "Adds a toolbar action that turns articles into a clean, readable layout.", action: "reader" },
  { id: "stats", name: "Page stats", icon: "i-gauge", desc: "Adds a toolbar action with word count, reading time, images, links and scripts.", action: "stats" },
  { id: "notes", name: "Quick notes", icon: "i-note", desc: "A side panel for notes saved per site. Synced if you're signed in.", action: "notes" },
  { id: "zoom", name: "Default zoom", icon: "i-zoom", desc: "Opens every site at your preferred zoom level.", zoom: true },
  { id: "compact", name: "Compact UI", icon: "i-app", desc: "Tighter tabs and toolbar so pages get more space.", chrome: true }
];
const state = () => load("veyra-extensions", {});
const setState = s => { save("veyra-extensions", s); hooks.scheduleSync?.(); };
const isOn = id => !!state()[id];
const devExts = () => load("veyra-dev-extensions", []);

// Match patterns like "*.example.com", "example.com", "<all_urls>".
function matches(ext, url) {
  const list = Array.isArray(ext.matches) && ext.matches.length ? ext.matches : ["<all_urls>"];
  const h = hostOf(url);
  return list.some(p => { p = String(p).trim().toLowerCase(); if (p === "<all_urls>" || p === "*") return true; p = p.replace(/^\*:\/\//, "").replace(/^https?:\/\//, "").replace(/\/.*$/, ""); if (p.startsWith("*.")) { const base = p.slice(2); return h === base || h.endsWith("." + base); } return h === p || h === "www." + p; });
}
export function validateManifest(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("The manifest must be a JSON object.");
  const id = String(m.id || "").trim(); if (!/^[a-z0-9][a-z0-9-_.]{1,63}$/i.test(id)) throw new Error("id must be 2–64 letters, numbers, dashes or dots.");
  const name = String(m.name || "").trim(); if (!name || name.length > 80) throw new Error("name is required (80 characters max).");
  if (m.js || m.script || m.scripts || m.content_scripts || m.background) throw new Error("Scripts aren't allowed in Veyra extensions. Use css only.");
  const css = String(m.css ?? m.page_css ?? ""); if (!css.trim()) throw new Error("css is required.");
  if (css.length > 200000) throw new Error("css is too large (200 KB max).");
  if (/@import\s+url\(\s*['"]?javascript:/i.test(css) || /expression\s*\(/i.test(css)) throw new Error("That CSS contains unsafe constructs.");
  const matchesList = m.matches == null ? [] : Array.isArray(m.matches) ? m.matches.map(String).slice(0, 50) : (() => { throw new Error("matches must be an array of host patterns."); })();
  return { id, name, version: String(m.version || "1.0.0").slice(0, 20), description: String(m.description || "").slice(0, 300), css, matches: matchesList, enabled: m.enabled !== false, installedAt: Date.now() };
}

// Apply everything that's enabled to one tab (called after each page load).
export async function applyToTab(t) {
  if (!t || t.view !== "page" || !t.url) return;
  const s = state();
  const calls = [];
  for (const e of BUILTIN) if (e.feature) { calls.push(["ext.feature", { name: e.feature, on: !!s[e.id] }]); for (const a of e.also || []) if (s[e.id]) calls.push(["ext.feature", { name: a, on: true }]); }
  for (const d of devExts()) calls.push(["ext.css", { key: d.id, css: d.enabled && matches(d, t.url) ? d.css : "" }]);
  if (s.zoom && settings.zoomDefault && settings.zoomDefault !== 1 && t.zoom === 1) { t.zoom = settings.zoomDefault; calls.push(["ext.zoom", { zoom: t.zoom }]); }
  for (const [m, p] of calls) { try { await dtCall(t, m, p, 4000); } catch (e) { if (!/unsupported|timed out/i.test(e.message)) addLog("debug", `Extension call ${m} failed: ${e.message}`); break; } }
  hooks.onExtensionsApplied?.(t);
}
hooks.applyExtensionsToTab = applyToTab;
const applyAll = () => B.state.tabs.forEach(t => applyToTab(t));

async function toggle(id, on) {
  const s = state(); s[id] = on; setState(s);
  const e = BUILTIN.find(x => x.id === id);
  if (e?.server) { settings.blockTrackers = on; saveSettings(); const sid = B.state.session?.id; if (sid) api(`/api/session/${sid}/prefs`, { json: { blockTrackers: on } }).catch(() => {}); }
  if (e?.chrome) document.body.classList.toggle("compact", on || !!settings.compact);
  if (e?.id === "notes" && !on) closeNotes();
  applyAll(); renderExtensions(); B.renderActive({ push: false });
}

// ---------------------------------------------------------------- actions
export async function readerMode(t = B.activeTab()) {
  if (!(t?.view === "page" && t.url)) return toast("Open an article first");
  if (isRemote(t)) return toast("Reader view isn't available in Chromium tabs", { kind: "warn" });
  const box = $("readerView"); box.classList.remove("hidden"); box.innerHTML = `<div class="reader-bar"><span style="margin-right:auto;opacity:.7">Reader view</span><button id="rdClose">Close</button></div><article><p>Preparing…</p></article>`;
  $("rdClose").onclick = closeReader; t.readerOpen = true;
  try {
    const r = await dtCall(t, "ext.reader", {}, 8000);
    const dark = document.documentElement.dataset.theme === "dark";
    box.classList.toggle("dark", dark);
    const words = (r.blocks || []).reduce((n, b) => n + (b.text ? b.text.split(/\s+/).length : 0), 0);
    box.innerHTML = `<div class="reader-bar"><span style="margin-right:auto;opacity:.7">${esc(hostOf(t.url))} · ${Math.max(1, Math.round(words / 230))} min read</span><button id="rdSmaller">A−</button><button id="rdBigger">A+</button><button id="rdTheme">${dark ? "Light" : "Dark"}</button><button id="rdClose">Close</button></div>
      <article><h1>${esc(r.title || t.title)}</h1>${r.byline ? `<div class="byline">${esc(r.byline)}</div>` : ""}${(r.blocks || []).map(b => b.t === "img" ? `<img src="${esc(b.src)}" alt="" loading="lazy" onerror="this.remove()">` : b.t === "h" || /^h[1-6]$/.test(b.t) ? `<h2>${esc(b.text)}</h2>` : b.t === "blockquote" ? `<blockquote>${esc(b.text)}</blockquote>` : b.t === "li" ? `<p>• ${esc(b.text)}</p>` : b.t === "pre" ? `<pre>${esc(b.text)}</pre>` : `<p>${esc(b.text)}</p>`).join("")}</article>`;
    let size = 1.14; const art = box.querySelector("article");
    $("rdSmaller").onclick = () => { size = Math.max(.9, size - .08); art.style.fontSize = size + "rem"; };
    $("rdBigger").onclick = () => { size = Math.min(1.8, size + .08); art.style.fontSize = size + "rem"; };
    $("rdTheme").onclick = () => { box.classList.toggle("dark"); $("rdTheme").textContent = box.classList.contains("dark") ? "Light" : "Dark"; };
    $("rdClose").onclick = closeReader;
  } catch (e) { box.querySelector("article").innerHTML = `<p>Reader view couldn't read this page: ${esc(e.message)}</p>`; }
}
export function closeReader() { const t = B.activeTab(); if (t) t.readerOpen = false; $("readerView").classList.add("hidden"); $("readerView").innerHTML = ""; }
hooks.closeReader = closeReader;
async function pageStats(anchor) {
  const t = B.activeTab(); if (!(t?.view === "page" && t.url)) return toast("Open a website first");
  try {
    const s = await dtCall(t, "ext.stats", {}, 6000);
    const p = $("popover"); p.innerHTML = `<h4>Page stats</h4><p class="pop-sub">${esc(hostOf(t.url))}</p><dl class="kv">${Object.entries(s).map(([k, v]) => `<dt>${esc(k.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase()))}</dt><dd>${esc(typeof v === "number" ? v.toLocaleString() : v)}</dd>`).join("")}</dl>`;
    openFloating(p, anchor || $("extBtn"));
  } catch (e) { toast(`Couldn't read page stats: ${e.message}`, { kind: "err" }); }
}

// Quick notes side panel
function notesKey(t) { return hostOf(t?.url) || "_"; }
export function openNotes() { const t = B.activeTab(); if (!(t?.view === "page" && t.url)) return toast("Open a website to take notes about it"); t.notesOpen = true; renderSidePanel(t); }
function closeNotes() { B.state.tabs.forEach(t => t.notesOpen = false); $("sidePanel").classList.add("hidden"); }
function renderSidePanel(t) {
  const p = $("sidePanel");
  if (!(t?.view === "page" && t.notesOpen && isOn("notes"))) { p.classList.add("hidden"); return; }
  const notes = load("veyra-notes", {}); const k = notesKey(t);
  p.classList.remove("hidden");
  p.innerHTML = `<header><h3>Notes · ${esc(k)}</h3><div><button class="icon-btn sm" id="noteCopy" title="Copy"><svg><use href="#i-copy"/></svg></button><button class="icon-btn sm" id="noteClose" title="Close"><svg><use href="#i-x"/></svg></button></div></header><textarea id="noteText" placeholder="Notes for ${esc(k)}. Saved automatically."></textarea><small class="muted" style="padding:0 14px 12px" id="noteState">${notes[k] ? `Saved` : ""}</small>`;
  const ta = $("noteText"); ta.value = notes[k] || "";
  let timer; ta.oninput = () => { clearTimeout(timer); $("noteState").textContent = "Saving…"; timer = setTimeout(() => { const n = load("veyra-notes", {}); if (ta.value.trim()) n[k] = ta.value.slice(0, 20000); else delete n[k]; save("veyra-notes", n); hooks.scheduleSync?.(); $("noteState").textContent = "Saved"; }, 400); };
  $("noteClose").onclick = () => { t.notesOpen = false; p.classList.add("hidden"); };
  $("noteCopy").onclick = () => copyText(ta.value);
}
hooks.renderSidePanel = renderSidePanel;

// ---------------------------------------------------------------- UI
function card(e, on, dev = false) {
  return `<article class="ext-card ${on ? "on" : ""}" data-ext="${esc(e.id)}"><div class="ext-top"><span class="ext-ico"><svg><use href="#${e.icon || "i-puzzle"}"/></svg></span><div><h3>${esc(e.name)}</h3><p>${esc(e.desc || e.description || "")}</p></div></div>
    ${e.zoom ? `<label class="field" style="margin:0"><span>Zoom for new pages: <b id="zoomVal">${Math.round((settings.zoomDefault || 1) * 100)}%</b></span><input type="range" min="50" max="200" step="10" value="${Math.round((settings.zoomDefault || 1) * 100)}" id="zoomRange"></label>` : ""}
    ${dev ? `<p class="muted small mono" style="margin:0">${esc(e.version)} · ${esc(e.matches?.length ? e.matches.join(", ") : "all sites")}</p>` : ""}
    <div class="ext-foot">${dev ? `<button class="btn ghost sm" data-edit="${esc(e.id)}">Edit CSS</button><button class="btn ghost sm" data-remove="${esc(e.id)}">Remove</button>` : e.action && on ? `<button class="btn ghost sm" data-run="${esc(e.action)}">${e.action === "reader" ? "Open reader" : e.action === "stats" ? "Show stats" : "Open notes"}</button>` : `<span class="muted small">${e.server ? "Runs on the server + page" : e.chrome ? "Changes Veyra's interface" : "Runs in the page"}</span>`}
      <span class="spacer"></span><input type="checkbox" class="switch" data-toggle="${esc(e.id)}" ${dev ? "data-dev" : ""} ${on ? "checked" : ""} aria-label="Enable ${esc(e.name)}"></div></article>`;
}
export function renderExtensions() {
  const grid = $("extensionsGrid"); if (!grid) return;
  $("extDevMode").checked = !!settings.extensionDeveloperMode; $("extDevBar").classList.toggle("hidden", !settings.extensionDeveloperMode);
  const s = state(); const dev = devExts();
  grid.innerHTML = BUILTIN.map(e => card(e, !!s[e.id])).join("") + dev.map(d => card({ ...d, icon: "i-code" }, d.enabled, true)).join("");
  grid.onchange = e => {
    const sw = e.target.closest("[data-toggle]");
    if (sw) { if ("dev" in sw.dataset) { const list = devExts(); const d = list.find(x => x.id === sw.dataset.toggle); if (d) { d.enabled = sw.checked; save("veyra-dev-extensions", list); hooks.scheduleSync?.(); applyAll(); renderExtensions(); } } else toggle(sw.dataset.toggle, sw.checked); return; }
    if (e.target.id === "zoomRange") { settings.zoomDefault = Number(e.target.value) / 100; saveSettings(); }
  };
  grid.oninput = e => { if (e.target.id === "zoomRange") $("zoomVal").textContent = e.target.value + "%"; };
  grid.onclick = async e => {
    const r = e.target.closest("[data-run]"); if (r) { runAction(r.dataset.run, r); return; }
    const rm = e.target.closest("[data-remove]"); if (rm) { const list = devExts().filter(x => x.id !== rm.dataset.remove); save("veyra-dev-extensions", list); hooks.scheduleSync?.(); B.state.tabs.forEach(t => t.view === "page" && dtCall(t, "ext.css", { key: rm.dataset.remove, css: "" }).catch(() => {})); renderExtensions(); toast("Extension removed"); return; }
    const ed = e.target.closest("[data-edit]"); if (ed) { const list = devExts(); const d = list.find(x => x.id === ed.dataset.edit); const { promptDialog } = await import("./core.js"); const res = await promptDialog({ title: `Edit ${d.name}`, fields: [{ name: "css", label: "CSS", type: "textarea", value: d.css }, { name: "matches", label: "Sites (comma separated, blank for all)", value: (d.matches || []).join(", ") }] }); if (!res) return; try { const v = validateManifest({ ...d, css: res.css, matches: res.matches.split(",").map(x => x.trim()).filter(Boolean) }); Object.assign(d, v); save("veyra-dev-extensions", list); hooks.scheduleSync?.(); applyAll(); renderExtensions(); toast("Extension updated"); } catch (err) { toast(err.message, { kind: "err" }); } }
  };
}
hooks.renderExtensions = renderExtensions;
function runAction(a, anchor) { closeFloating(); if (a === "reader") readerMode(); else if (a === "stats") pageStats(anchor); else if (a === "notes") openNotes(); }
function openPuzzle() {
  const s = state(); const t = B.activeTab(); const onPage = t?.view === "page" && !!t.url;
  const p = $("popover");
  p.innerHTML = `<h4>Extensions</h4><p class="pop-sub">${onPage ? `Acting on ${esc(hostOf(t.url))}` : "Open a website to use page extensions."}</p>
    ${BUILTIN.map(e => `<div class="ext-pop-row"><span class="ext-ico" style="width:30px;height:30px;border-radius:9px"><svg style="width:16px;height:16px"><use href="#${e.icon}"/></svg></span><div class="n"><b>${esc(e.name)}</b></div>${e.action && s[e.id] ? `<button class="btn ghost sm" data-run="${e.action}" ${onPage ? "" : "disabled"}>Run</button>` : ""}<input type="checkbox" class="switch" data-toggle="${e.id}" ${s[e.id] ? "checked" : ""} aria-label="${esc(e.name)}"></div>`).join("")}
    ${devExts().map(d => `<div class="ext-pop-row"><span class="ext-ico" style="width:30px;height:30px;border-radius:9px"><svg style="width:16px;height:16px"><use href="#i-code"/></svg></span><div class="n"><b>${esc(d.name)}</b><small>${t?.url && matches(d, t.url) ? "Runs on this site" : "Not for this site"}</small></div></div>`).join("")}
    <div style="margin-top:10px"><button class="btn ghost sm block" data-go="/extensions">Manage extensions</button></div>`;
  p.onchange = e => { const sw = e.target.closest("[data-toggle]"); if (sw) { toggle(sw.dataset.toggle, sw.checked); setTimeout(openPuzzle, 0); } };
  p.onclick = e => { const r = e.target.closest("[data-run]"); if (r) runAction(r.dataset.run, $("extBtn")); if (e.target.closest("[data-go]")) closeFloating(); };
  openFloating(p, $("extBtn"));
}
async function loadManifestFile(file) {
  try {
    if (file.size > 250000) throw new Error("That file is too large.");
    const m = JSON.parse(await file.text());
    const list = Array.isArray(m) ? m : [m]; const cur = devExts(); let n = 0;
    for (const x of list) { const v = validateManifest(x); const i = cur.findIndex(c => c.id === v.id); if (i >= 0) cur[i] = v; else cur.push(v); n++; }
    save("veyra-dev-extensions", cur.slice(0, 30)); hooks.scheduleSync?.(); applyAll(); renderExtensions(); toast(`Loaded ${n} extension${n === 1 ? "" : "s"}`);
  } catch (e) { toast(`Couldn't load manifest: ${e.message}`, { kind: "err", ms: 6000 }); }
}
export function initExtensions(b) {
  B = b;
  $("extBtn").onclick = () => $("popover").classList.contains("hidden") ? openPuzzle() : closeFloating();
  $("extDevMode").onchange = e => { settings.extensionDeveloperMode = e.target.checked; saveSettings(); renderExtensions(); };
  $("loadExtensionBtn").onclick = () => $("extensionFile").click();
  $("extensionFile").onchange = e => { const f = e.target.files?.[0]; if (f) loadManifestFile(f); e.target.value = ""; };
  $("exportExtensionsBtn").onclick = () => { const blob = new Blob([JSON.stringify(devExts().map(({ installedAt, ...x }) => x), null, 2)], { type: "application/json" }); const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "veyra-extensions.json" }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };
  if (isOn("compact")) document.body.classList.add("compact");
  if (isOn("adblock") && !settings.blockTrackers) { settings.blockTrackers = true; saveSettings(); }
}
export { BUILTIN };
