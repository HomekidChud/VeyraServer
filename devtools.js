// Veyra DevTools: Elements, Console, Sources, Network, Application, Performance.
// Talks to the in-page bridge (devtools-bridge.js on the server) through dtCall().
import { $, esc, hostOf, pathOf, fmtBytes, fmtMs, settings, saveSettings, hooks, toast, api, proxyUrl, rawFetch, copyText, isMac } from "./core.js";
import { dtCall, onBridgeEvent, isRemote } from "./bridge.js";

let B, root, openState = false, panel = "elements";
const PANELS = [["elements", "Elements"], ["console", "Console"], ["sources", "Sources"], ["network", "Network"], ["application", "Application"], ["performance", "Performance"]];
const tab = () => B.activeTab();
const onPage = t => t?.view === "page" && !!t.url;
const dtState = t => t._dt || (t._dt = { nodes: new Map(), open: new Set(), sel: null, rootIds: [], docLoaded: false, conHistory: [], conHistIdx: -1, netSel: null, netFilter: "all", resEntries: [], srcOpen: [], srcActive: null, appSel: "local", netEnabled: false, stylesTab: "styles", forced: new Set() });
const call = (method, params, ms) => dtCall(tab(), method, params, ms);
const debounceRaf = fn => { let r = 0; return (...a) => { if (r) return; r = requestAnimationFrame(() => { r = 0; fn(...a); }); }; };

// ============================================================ shell
function build() {
  root = $("devtools");
  root.innerHTML = `<div class="dt-resize" id="dtResize"></div>
  <div class="dt-bar">
    <button class="icon-btn" id="dtPick" title="Select an element in the page to inspect it (${isMac ? "⌘⇧C" : "Ctrl+Shift+C"})"><svg><use href="#i-inspect"/></svg></button>
    <button class="icon-btn" id="dtDevice" title="Toggle device toolbar"><svg><use href="#i-app"/></svg></button>
    <span class="dt-sep"></span>
    <div class="dt-tabs" role="tablist">${PANELS.map(([id, l]) => `<button class="dt-tab" data-panel="${id}" role="tab">${l}<span class="cnt hidden" id="dtCnt-${id}"></span></button>`).join("")}</div>
    <span class="dt-sep"></span>
    <button class="icon-btn" id="dtDock" title="Dock side"><svg><use href="#i-dock-right"/></svg></button>
    <button class="icon-btn" id="dtClose" title="Close DevTools (F12)"><svg><use href="#i-x"/></svg></button>
  </div>
  <div class="dt-body">
    <section class="dt-panel" id="dt-elements"></section>
    <section class="dt-panel dt-col" id="dt-console"></section>
    <section class="dt-panel" id="dt-sources"></section>
    <section class="dt-panel dt-col" id="dt-network"></section>
    <section class="dt-panel" id="dt-application"></section>
    <section class="dt-panel dt-col" id="dt-performance"></section>
  </div>`;
  root.querySelector(".dt-tabs").onclick = e => { const b = e.target.closest("[data-panel]"); if (b) show(b.dataset.panel); };
  $("dtClose").onclick = close; $("dtPick").onclick = () => togglePick(); $("dtDevice").onclick = toggleDevice;
  $("dtDock").onclick = () => { settings.devtoolsDock = settings.devtoolsDock === "right" ? "bottom" : "right"; saveSettings(); applyDock(); };
  wireResize(); buildElements(); buildConsole(); buildSources(); buildNetwork(); buildApplication(); buildPerformance();
  root.addEventListener("keydown", e => { if (e.key === "Escape" && panel !== "console") { e.stopPropagation(); show("console"); setTimeout(() => $("conInput").focus(), 0); } });
}
function applyDock() {
  const right = settings.devtoolsDock === "right";
  $("workspace").classList.toggle("dock-right", right && openState);
  $("dtDock").innerHTML = `<svg><use href="#${right ? "i-dock-bottom" : "i-dock-right"}"/></svg>`; $("dtDock").title = right ? "Dock to bottom" : "Dock to right";
  const size = settings.devtoolsSize?.[right ? "right" : "bottom"];
  root.style.height = right ? "" : size ? size + "px" : ""; root.style.width = right ? (size ? size + "px" : "") : "";
}
function wireResize() {
  $("dtResize").addEventListener("pointerdown", e => {
    e.preventDefault(); const right = settings.devtoolsDock === "right"; const ws = $("workspace").getBoundingClientRect();
    const shield = document.createElement("div"); shield.style.cssText = `position:fixed;inset:0;z-index:99;cursor:${right ? "ew" : "ns"}-resize`; document.body.appendChild(shield);
    const move = ev => { const v = right ? Math.max(280, Math.min(ws.width - 200, ws.right - ev.clientX)) : Math.max(120, Math.min(ws.height - 80, ws.bottom - ev.clientY)); if (right) root.style.width = v + "px"; else root.style.height = v + "px"; settings.devtoolsSize = { ...(settings.devtoolsSize || {}), [right ? "right" : "bottom"]: Math.round(v) }; };
    const up = () => { shield.remove(); removeEventListener("pointermove", move); removeEventListener("pointerup", up); saveSettings(); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  });
}
export function open(p = panel) {
  if (!root) build();
  openState = true; root.classList.remove("hidden"); applyDock(); show(p);
}
export function close() { openState = false; root?.classList.add("hidden"); $("workspace").classList.remove("dock-right"); setPicking(false); const t = tab(); if (onPage(t)) call("dom.highlight", {}).catch(() => {}); stopPerfMonitor(); }
export function toggle() { openState ? close() : open(); }
function show(p) {
  panel = p; root.querySelectorAll(".dt-tab").forEach(b => b.classList.toggle("on", b.dataset.panel === p));
  root.querySelectorAll(".dt-panel").forEach(s => s.classList.toggle("on", s.id === "dt-" + p));
  if (p !== "elements" && onPage(tab())) call("dom.highlight", {}).catch(() => {});
  refreshPanel();
}
function refreshPanel() {
  if (!openState) return; const t = tab();
  if (p("performance")) { if (!onPage(t)) stopPerfMonitor(); }
  ({ elements: renderElements, console: renderConsole, sources: renderSources, network: renderNetwork, application: renderApplication, performance: renderPerformance })[panel]?.();
  updateCounts();
}
const p = id => panel === id;
function emptyMsg(msg = "Open a website in this tab to inspect it.") { return `<div class="dt-empty">${esc(msg)}</div>`; }
function updateCounts() {
  const t = tab(); const errs = t?.console?.filter(c => c.level === "error").length || 0; const warns = t?.console?.filter(c => c.level === "warn").length || 0;
  const el = $("dtCnt-console"); if (!el) return; el.classList.toggle("hidden", !errs && !warns); el.classList.toggle("w", !errs); el.textContent = errs || warns;
}
function dtMenu(x, y, items) {
  document.querySelector(".dt-ctx")?.remove();
  const m = document.createElement("div"); m.className = "dt-ctx";
  m.innerHTML = items.map((it, i) => it === "-" ? "<hr>" : `<button data-i="${i}">${esc(it.label)}</button>`).join("");
  document.body.appendChild(m); m.style.left = Math.min(x, innerWidth - m.offsetWidth - 6) + "px"; m.style.top = Math.min(y, innerHeight - m.offsetHeight - 6) + "px";
  m.onclick = e => { const b = e.target.closest("[data-i]"); if (b) { m.remove(); items[Number(b.dataset.i)].action(); } };
  setTimeout(() => addEventListener("pointerdown", function h(e) { if (!m.contains(e.target)) { m.remove(); removeEventListener("pointerdown", h, true); } }, true), 0);
}

// ============================================================ Elements
function buildElements() {
  $("dt-elements").innerHTML = `<div class="dt-split">
    <div class="dt-col" style="flex:1.4;min-width:0"><div class="dt-sub"><input class="dt-input" id="elSearch" placeholder="Find by string, selector" style="flex:1"><span class="muted" id="elSearchCount"></span><button class="icon-btn" id="elSearchPrev" title="Previous"><svg style="transform:rotate(-90deg)"><use href="#i-chevron"/></svg></button><button class="icon-btn" id="elSearchNext" title="Next"><svg style="transform:rotate(90deg)"><use href="#i-chevron"/></svg></button><button class="icon-btn" id="elRefresh" title="Refresh tree"><svg><use href="#i-reload"/></svg></button></div>
      <div class="dt-pane el-tree" id="elTree" tabindex="0"></div><div class="crumbs" id="elCrumbs"></div></div>
    <div class="dt-gutter" id="elGutter"></div>
    <div class="dt-col" id="elSide" style="flex:1;min-width:200px;border-left:0">
      <div class="st-tabs" id="stTabs"><button data-st="styles" class="on">Styles</button><button data-st="computed">Computed</button><button data-st="layout">Layout</button><button data-st="props">Properties</button></div>
      <div class="dt-pane" id="stBody" style="flex:1"></div></div></div>`;
  const tree = $("elTree");
  tree.onclick = e => {
    const tw = e.target.closest(".el-tw"); const line = e.target.closest(".el-line"); if (!line) return;
    const id = Number(line.dataset.id);
    if (tw && !tw.classList.contains("none")) { toggleNode(id); return; }
    selectNode(id);
  };
  tree.ondblclick = e => { const line = e.target.closest(".el-line"); if (!line) return; const id = Number(line.dataset.id); const an = e.target.closest("[data-attr]"); const tx = e.target.closest(".t-txt"); const tg = e.target.closest(".t-tag.name");
    if (an) editAttr(id, an.dataset.attr, an); else if (tx) editText(id, tx); else if (tg) editAsHTML(id); else toggleNode(id); };
  tree.onmousemove = debounceRaf(e => { const line = e.target.closest?.(".el-line"); const id = line ? Number(line.dataset.id) : null; if (id !== tree._hover) { tree._hover = id; call("dom.highlight", id ? { id } : {}).catch(() => {}); } });
  tree.onmouseleave = () => { tree._hover = null; const s = dtState(tab()).sel; call("dom.highlight", s ? { id: s } : {}).catch(() => {}); };
  tree.oncontextmenu = e => { const line = e.target.closest(".el-line"); if (!line) return; e.preventDefault(); const id = Number(line.dataset.id); selectNode(id); nodeMenu(id, e.clientX, e.clientY); };
  tree.onkeydown = e => {
    const s = dtState(tab()); if (!s.sel) return; const lines = [...tree.querySelectorAll(".el-line")]; const i = lines.findIndex(l => Number(l.dataset.id) === s.sel);
    if (e.key === "ArrowDown") { e.preventDefault(); lines[i + 1] && selectNode(Number(lines[i + 1].dataset.id)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); lines[i - 1] && selectNode(Number(lines[i - 1].dataset.id)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); if (!s.open.has(s.sel)) toggleNode(s.sel, true); else lines[i + 1] && selectNode(Number(lines[i + 1].dataset.id)); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); if (s.open.has(s.sel)) toggleNode(s.sel, false); else { const par = s.nodes.get(s.sel)?.parent; if (par) selectNode(par); } }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeNode(s.sel); }
    else if (e.key === "h" || e.key === "H") { call("dom.hide", { id: s.sel }).catch(err => toast(err.message, { kind: "err" })); }
    else if (e.key === "F2") { editAsHTML(s.sel); }
  };
  $("elRefresh").onclick = () => loadDocument(true);
  const search = async (dir) => { const q = $("elSearch").value.trim(); const s = dtState(tab()); if (!q) { $("elSearchCount").textContent = ""; return; }
    if (s.searchQ !== q) { s.searchQ = q; s.searchRes = await call("dom.search", { query: q }).catch(() => []); s.searchIdx = -1; }
    if (!s.searchRes?.length) { $("elSearchCount").textContent = "0 of 0"; return; }
    s.searchIdx = (s.searchIdx + dir + s.searchRes.length) % s.searchRes.length; $("elSearchCount").textContent = `${s.searchIdx + 1} of ${s.searchRes.length}`; revealPath(s.searchRes[s.searchIdx].path); };
  $("elSearch").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); search(e.shiftKey ? -1 : 1); } };
  $("elSearchNext").onclick = () => search(1); $("elSearchPrev").onclick = () => search(-1);
  $("stTabs").onclick = e => { const b = e.target.closest("[data-st]"); if (!b) return; dtState(tab()).stylesTab = b.dataset.st; $("stTabs").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); renderSide(); };
  gutterDrag($("elGutter"), $("elSide"));
}
function gutterDrag(g, side) { g.addEventListener("pointerdown", e => { e.preventDefault(); const start = e.clientX, w = side.getBoundingClientRect().width; const mv = ev => { side.style.flex = `0 0 ${Math.max(180, w - (ev.clientX - start))}px`; }; const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); }; addEventListener("pointermove", mv); addEventListener("pointerup", up); }); }
function storeNodes(s, n, parent) { const prev = s.nodes.get(n.id); s.nodes.set(n.id, { ...prev, ...n, parent: parent ?? prev?.parent ?? null, children: n.children ? n.children.map(c => c.id) : prev?.children ?? null }); if (n.children) n.children.forEach(c => storeNodes(s, c, n.id)); }
async function loadDocument(force = false) {
  const t = tab(); if (!onPage(t)) { $("elTree").innerHTML = emptyMsg(); $("stBody").innerHTML = ""; $("elCrumbs").innerHTML = ""; return; }
  const s = dtState(t);
  if (!s.docLoaded || force) {
    $("elTree").innerHTML = `<div class="dt-empty">Loading the DOM…</div>`;
    try {
      const doc = await call("dom.document", { depth: 3 }, 10000);
      s.nodes.clear(); storeNodes(s, doc, null); s.rootIds = doc.children.map(c => c.id); s.docLoaded = true;
      if (!force || !s.open.size) { s.open = new Set(); for (const id of s.rootIds) { const n = s.nodes.get(id); if (n?.name === "html") { s.open.add(id); for (const c of n.children || []) { const cn = s.nodes.get(c); if (cn?.name === "body") s.open.add(c); } } } }
      if (s.sel && !s.nodes.has(s.sel)) s.sel = null;
      if (!s.sel) { const body = [...s.nodes.values()].find(n => n.name === "body"); s.sel = body?.id || null; }
    } catch (e) { $("elTree").innerHTML = emptyMsg(`Couldn't read this page's DOM: ${e.message}`); return; }
  }
  renderTree(); renderSide();
}
function attrHtml(k, v) { return ` <span data-attr="${esc(k)}"><span class="t-an">${esc(k)}</span>${v !== "" ? `=<span class="t-av">"${esc(v.length > 120 ? v.slice(0, 120) + "…" : v)}"</span>` : ""}</span>`; }
function nodeLine(s, n, depth) {
  const pad = `style="padding-left:${depth * 14 + 4}px"`; const sel = s.sel === n.id ? " sel" : "";
  if (n.type === 3) return `<div class="el-node"><span class="el-line${sel}" data-id="${n.id}" ${pad}><span class="el-tw none"></span>"<span class="t-txt">${esc(n.text)}</span>"</span></div>`;
  if (n.type === 8) return `<div class="el-node"><span class="el-line${sel}" data-id="${n.id}" ${pad}><span class="el-tw none"></span><span class="t-cm">&lt;!--${esc(n.text)}--&gt;</span></span></div>`;
  if (n.type === 10) return `<div class="el-node"><span class="el-line${sel}" data-id="${n.id}" ${pad}><span class="el-tw none"></span><span class="t-cm">&lt;!DOCTYPE ${esc(n.name)}&gt;</span></span></div>`;
  if (n.type === 11) { const open = s.open.has(n.id); return `<div class="el-node ${open ? "open" : ""}"><span class="el-line${sel}" data-id="${n.id}" ${pad}><span class="el-tw ${n.childCount ? "" : "none"}"></span><span class="t-cm">#shadow-root (${esc(n.mode)})</span></span>${open ? (n.children || []).map(c => s.nodes.get(c)).filter(Boolean).map(c => nodeLine(s, c, depth + 1)).join("") : ""}</div>`; }
  const open = s.open.has(n.id); const kids = (n.children || []).map(c => s.nodes.get(c)).filter(Boolean);
  const inlineText = n.childCount === 1 && kids.length === 1 && kids[0].type === 3 && kids[0].text.length < 80;
  const openTag = `<span class="t-tag">&lt;<span class="t-tag name">${esc(n.name)}</span></span>${(n.attrs || []).map(([k, v]) => attrHtml(k, v)).join("")}<span class="t-tag">&gt;</span>`;
  const closeTag = `<span class="t-tag">&lt;/${esc(n.name)}&gt;</span>`;
  const dollar = s.sel === n.id ? `<span class="dollar">== $0</span>` : "";
  if (inlineText) return `<div class="el-node"><span class="el-line${sel}" data-id="${n.id}" ${pad}><span class="el-tw none"></span>${openTag}<span class="t-txt" data-text="${kids[0].id}">${esc(kids[0].text)}</span>${closeTag}${dollar}</span></div>`;
  if (!n.childCount) return `<div class="el-node"><span class="el-line${sel}" data-id="${n.id}" ${pad}><span class="el-tw none"></span>${openTag}${/^(img|br|hr|input|meta|link|source|area|base|col|embed|param|track|wbr)$/.test(n.name) ? "" : closeTag}${dollar}</span></div>`;
  if (!open) return `<div class="el-node"><span class="el-line${sel}" data-id="${n.id}" ${pad}><span class="el-tw"></span>${openTag}<span class="t-dim">…</span>${closeTag}${dollar}</span></div>`;
  return `<div class="el-node open"><span class="el-line${sel}" data-id="${n.id}" ${pad}><span class="el-tw"></span>${openTag}${dollar}</span>${kids.map(c => nodeLine(s, c, depth + 1)).join("")}${kids.length < n.childCount ? `<span class="el-line" style="padding-left:${(depth + 1) * 14 + 18}px"><span class="t-dim">…loading</span></span>` : ""}<span class="el-line" data-id="${n.id}" style="padding-left:${depth * 14 + 18}px">${closeTag}</span></div>`;
}
function renderTree() {
  const t = tab(); if (!onPage(t)) return; const s = dtState(t); const tree = $("elTree"); const top = tree.scrollTop;
  tree.innerHTML = s.rootIds.map(id => s.nodes.get(id)).filter(Boolean).map(n => nodeLine(s, n, 0)).join("") || emptyMsg("The document is empty.");
  tree.scrollTop = top; renderCrumbs();
}
function renderCrumbs() {
  const s = dtState(tab()); const out = []; let id = s.sel;
  while (id) { const n = s.nodes.get(id); if (!n) break; if (n.type === 1) out.unshift(n); id = n.parent; }
  $("elCrumbs").innerHTML = out.map(n => { const cls = (n.attrs || []).find(a => a[0] === "class")?.[1]?.trim().split(/\s+/).slice(0, 2).join("."); const nid = (n.attrs || []).find(a => a[0] === "id")?.[1]; return `<button data-id="${n.id}" class="${n.id === s.sel ? "on" : ""}">${esc(n.name)}${nid ? "#" + esc(nid) : ""}${cls ? "." + esc(cls) : ""}</button>`; }).join("");
  $("elCrumbs").onclick = e => { const b = e.target.closest("[data-id]"); if (b) selectNode(Number(b.dataset.id)); };
  $("elCrumbs").scrollLeft = 1e6;
}
async function toggleNode(id, force) {
  const s = dtState(tab()); const n = s.nodes.get(id); if (!n) return;
  const openIt = force ?? !s.open.has(id);
  if (!openIt) { s.open.delete(id); renderTree(); return; }
  s.open.add(id);
  if (!n.children || n.children.length < n.childCount) { try { const r = await call("dom.children", { id, depth: 1 }); n.children = r.children.map(c => c.id); r.children.forEach(c => storeNodes(s, c, id)); } catch (e) { toast(e.message, { kind: "err" }); } }
  renderTree();
}
async function revealPath(path) {
  const s = dtState(tab()); if (!path?.length) return;
  if (!s.docLoaded) await loadDocument();
  for (const id of path.slice(0, -1)) { const n = s.nodes.get(id); if (!n) { await loadDocument(true); break; } s.open.add(id); if (!n.children || n.children.length < n.childCount || !path.every((x, i) => i === 0 || s.nodes.has(x) || !s.nodes.has(path[i - 1]))) { try { const r = await call("dom.children", { id, depth: 1 }); n.children = r.children.map(c => c.id); r.children.forEach(c => storeNodes(s, c, id)); } catch {} } }
  await selectNode(path[path.length - 1]);
  $("elTree").querySelector(`.el-line.sel`)?.scrollIntoView({ block: "center" });
}
async function selectNode(id) {
  const s = dtState(tab()); s.sel = id; renderTree();
  call("dom.select", { id }).catch(() => {}); call("dom.highlight", { id }).catch(() => {});
  $("elTree").querySelector(".el-line.sel")?.scrollIntoView({ block: "nearest" });
  renderSide();
}
async function refreshNode(id) { const s = dtState(tab()); try { const n = await call("dom.node", { id }); const cur = s.nodes.get(id); storeNodes(s, { ...n, children: cur?.children && !n.children ? undefined : n.children }, cur?.parent); if (s.open.has(id)) { const r = await call("dom.children", { id, depth: 1 }); s.nodes.get(id).children = r.children.map(c => c.id); r.children.forEach(c => storeNodes(s, c, id)); } } catch { } }
function inlineEditor(anchor, value, done, { multiline = false } = {}) {
  const ed = document.createElement(multiline ? "textarea" : "input"); ed.className = "el-edit"; ed.value = value;
  if (multiline) { ed.style.cssText = "width:calc(100% - 20px);min-height:120px;display:block;margin:4px 10px;font:12px/1.5 var(--font-mono)"; }
  anchor.replaceWith(ed); ed.focus(); ed.select();
  let finished = false; const finish = ok => { if (finished) return; finished = true; done(ok ? ed.value : null); };
  ed.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); renderTree(); } };
  ed.onblur = () => finish(true);
  return ed;
}
function editAttr(id, name, el) {
  const s = dtState(tab()); const n = s.nodes.get(id); const v = (n.attrs || []).find(a => a[0] === name)?.[1] ?? "";
  inlineEditor(el, `${name}="${v}"`, async val => {
    if (val == null) return renderTree();
    try { await call("dom.removeAttribute", { id, name }); const m = [...val.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g)]; let last; for (const x of m) last = await call("dom.setAttribute", { id, name: x[1], value: x[2] ?? x[3] ?? x[4] ?? "" }); const nn = last || await call("dom.node", { id }); storeNodes(s, { ...nn, children: undefined }, n.parent); } catch (e) { toast(e.message, { kind: "err" }); }
    renderTree(); renderSide();
  });
}
function editText(id, el) { const s = dtState(tab()); const tid = Number(el.dataset.text) || id; const n = s.nodes.get(tid); inlineEditor(el, n?.text ?? el.textContent, async val => { if (val != null) { try { await call("dom.setText", { id: tid, text: val }); if (n) n.text = val; } catch (e) { toast(e.message, { kind: "err" }); } } renderTree(); }); }
async function editAsHTML(id) {
  const s = dtState(tab()); const html = await call("dom.outerHTML", { id }).catch(e => { toast(e.message, { kind: "err" }); return null; }); if (html == null) return;
  const line = $("elTree").querySelector(`.el-line[data-id="${id}"]`); if (!line) return;
  inlineEditor(line, html, async val => { if (val == null || val === html) return renderTree(); try { const r = await call("dom.setOuterHTML", { id, html: val }); if (r.parentId) { await refreshNode(r.parentId); s.sel = r.id || r.parentId; } } catch (e) { toast(e.message, { kind: "err" }); } renderTree(); renderSide(); }, { multiline: true });
}
async function removeNode(id) {
  const s = dtState(tab()); try { const r = await call("dom.remove", { id }); const par = s.nodes.get(r.parentId); if (par?.children) { par.children = par.children.filter(c => c !== id); par.childCount = Math.max(0, par.childCount - 1); } s.nodes.delete(id); s.sel = r.parentId; renderTree(); renderSide(); } catch (e) { toast(e.message, { kind: "err" }); }
}
function nodeMenu(id, x, y) {
  dtMenu(x, y, [
    { label: "Edit as HTML", action: () => editAsHTML(id) },
    { label: "Add attribute", action: async () => { const r = prompt("Attribute (name=value)"); if (!r) return; const [k, ...v] = r.split("="); try { await call("dom.setAttribute", { id, name: k.trim(), value: v.join("=").replace(/^["']|["']$/g, "") }); await refreshNode(id); renderTree(); } catch (e) { toast(e.message, { kind: "err" }); } } },
    { label: "Delete element", action: () => removeNode(id) },
    { label: "Hide element", action: () => call("dom.hide", { id }) },
    "-",
    { label: "Copy outerHTML", action: async () => copyText(await call("dom.outerHTML", { id })) },
    { label: "Copy selector", action: async () => copyText((await call("dom.select", { id })).selector) },
    { label: "Copy JS path", action: async () => copyText(`document.querySelector(${JSON.stringify((await call("dom.select", { id })).selector)})`) },
    "-",
    { label: "Scroll into view", action: () => call("dom.scrollIntoView", { id }) },
    { label: "Store as global variable", action: async () => { await call("dom.select", { id }); const r = await call("runtime.evaluate", { expression: "window.temp1 = $0, temp1" }); pushConsole({ level: "res", kind: "res", preview: r.value, message: "temp1" }); show("console"); } },
    { label: "Expand recursively", action: async () => { const s = dtState(tab()); const walk = async (nid, d) => { if (d > 4) return; await toggleNode(nid, true); for (const c of s.nodes.get(nid)?.children || []) if (s.nodes.get(c)?.type === 1 && s.nodes.get(c).childCount) await walk(c, d + 1); }; await walk(id, 0); } },
    { label: "Collapse children", action: () => { const s = dtState(tab()); const walk = nid => { s.open.delete(nid); for (const c of s.nodes.get(nid)?.children || []) walk(c); }; walk(id); s.open.add(id); renderTree(); } }
  ]);
}
// ---- side pane: styles / computed / layout / properties
const COLOR_RE = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(?:red|blue|green|white|black|gray|grey|orange|purple|yellow|transparent)\b/i;
function declHtml(k, v, imp, over, where) {
  const sw = COLOR_RE.exec(v); const val = esc(v).replace(esc(sw?.[0] || "\u0000"), sw ? `<span class="st-swatch" style="background:${esc(sw[0])}"></span>${esc(sw[0])}` : "");
  return `<div class="st-decl ${over ? "over" : ""}" data-k="${esc(k)}" data-where="${esc(where)}"><input type="checkbox" checked title="Toggle"><span class="p" contenteditable="plaintext-only" spellcheck="false">${esc(k)}</span>:<span class="v" contenteditable="plaintext-only" spellcheck="false">${val}</span>${imp ? `<span class="imp">!important</span>` : ""};</div>`;
}
async function renderSide() {
  const t = tab(); const s = t && dtState(t); const body = $("stBody"); if (!body) return;
  if (!onPage(t) || !s.sel) { body.innerHTML = emptyMsg("Select an element."); return; }
  const n = s.nodes.get(s.sel); if (!n || n.type !== 1) { body.innerHTML = emptyMsg(n?.type === 3 ? "Text node" : "Select an element."); return; }
  const id = s.sel; const which = s.stylesTab;
  $("stTabs").querySelectorAll("button").forEach(x => x.classList.toggle("on", x.dataset.st === which));
  try {
    if (which === "styles") {
      const r = await call("css.styles", { id, inherited: true }); if (s.sel !== id) return;
      const filter = s.styleFilter || "";
      const keep = ([k]) => !filter || k.includes(filter);
      body.innerHTML = `<div class="st-tools"><input class="dt-input" id="stFilter" placeholder="Filter" value="${esc(filter)}"><button class="dt-chip ${s.showStates ? "on" : ""}" id="stHov">:hov</button><button class="dt-chip ${s.showCls ? "on" : ""}" id="stCls">.cls</button><button class="dt-chip" id="stAdd" title="New style rule">+</button></div>
        ${s.showStates ? `<div class="st-states">${["hover", "active", "focus", "focus-within", "focus-visible", "visited", "target"].map(x => `<label class="dt-chk"><input type="checkbox" data-state="${x}" ${s.forced.has(id + ":" + x) ? "checked" : ""}>:${x}</label>`).join("")}</div>` : ""}
        ${s.showCls ? `<div class="st-states"><input class="dt-input" id="clsAdd" placeholder="Add new class" style="flex:1">${((n.attrs || []).find(a => a[0] === "class")?.[1] || "").split(/\s+/).filter(Boolean).map(c => `<label class="dt-chk"><input type="checkbox" checked data-cls="${esc(c)}">.${esc(c)}</label>`).join("")}</div>` : ""}
        <div class="st-rule" data-where="inline"><div class="sel">element.style {</div>${r.inline.filter(keep).map(([k, v, imp]) => declHtml(k, v, imp, false, "inline")).join("")}<div class="st-add" data-where="inline">+ add property</div><div>}</div></div>
        ${r.rules.map(rule => { const props = rule.props.filter(keep); if (filter && !props.length) return ""; return `<div class="st-rule" data-rule="${rule.ruleId}">${rule.media ? `<div class="media">${esc(rule.media)}</div>` : ""}<span class="src" title="${esc(rule.href || rule.source)}">${esc(rule.source || "")}</span><div class="sel">${rule.selector.split(",").map(x => rule.matched.includes(x.trim()) ? esc(x.trim()) : `<span class="nm">${esc(x.trim())}</span>`).join(", ")} {</div>${props.map(([k, v, imp, over]) => declHtml(k, v, imp, over, "rule:" + rule.ruleId)).join("")}<div class="st-add" data-where="rule:${rule.ruleId}">+ add property</div><div>}</div></div>`; }).join("")}
        ${(r.inherited || []).map(h => `<div class="st-inh">Inherited from <b>${esc(h.from)}</b></div>${h.rules.map(rule => `<div class="st-rule"><span class="src">${esc(rule.source)}</span><div class="sel">${esc(rule.selector)} {</div>${rule.props.filter(keep).map(([k, v, imp, over]) => declHtml(k, v, imp, over, "rule:" + rule.ruleId)).join("")}<div>}</div></div>`).join("")}`).join("")}
        ${r.blockedSheets ? `<div class="dt-note">${r.blockedSheets} cross-origin stylesheet${r.blockedSheets === 1 ? "" : "s"} can't be read by the page.</div>` : ""}`;
      wireStyles(id, r);
    } else if (which === "computed") {
      const list = await call("css.computed", { id }); if (s.sel !== id) return;
      body.innerHTML = `<div class="st-tools"><input class="dt-input" id="cmpFilter" placeholder="Filter" value="${esc(s.cmpFilter || "")}"><label class="dt-chk"><input type="checkbox" id="cmpAll" ${s.cmpAll ? "checked" : ""}>Show all</label></div><div id="cmpList"></div>`;
      const DEF = /^(auto|normal|none|0px|0s|visible|static|baseline|start|stretch|0|1|ease|running|repeat|scroll|inline|border-box|currentcolor|rgba\(0, 0, 0, 0\)|medium|separate|show|content-box|padding-box|ltr|nowrap|row|horizontal-tb)$/;
      const draw = () => { const f = $("cmpFilter").value.toLowerCase(); s.cmpFilter = f; $("cmpList").innerHTML = list.filter(([k, v]) => (!f || k.includes(f) || v.toLowerCase().includes(f)) && (s.cmpAll || f || !DEF.test(v.trim()))).map(([k, v]) => `<div class="computed-row"><span class="p">${esc(k)}</span><span class="v">${COLOR_RE.test(v) ? `<span class="st-swatch" style="background:${esc(COLOR_RE.exec(v)[0])}"></span>` : ""}${esc(v)}</span></div>`).join(""); };
      $("cmpFilter").oninput = draw; $("cmpAll").onchange = e => { s.cmpAll = e.target.checked; draw(); }; draw();
    } else if (which === "layout") {
      const b = await call("css.boxModel", { id }); if (s.sel !== id) return;
      const v = x => { const n2 = parseFloat(x); return !n2 ? "–" : Math.round(n2 * 100) / 100; };
      const layer = (cls, lbl, vals, inner) => `<div class="bm-layer ${cls}"><span class="lbl">${lbl}</span><span class="t">${v(vals[0])}</span><span class="l">${v(vals[3])}</span><div class="in">${inner}</div><span class="r">${v(vals[1])}</span><span class="b">${v(vals[2])}</span></div>`;
      body.innerHTML = `<div class="boxmodel">${b.position !== "static" ? layer("", "position", b.offsets, layer("bm-margin", "margin", b.margin, layer("bm-border", "border", b.border, layer("bm-padding", "padding", b.padding, `<div class="bm-content">${Math.round(b.content[0] * 100) / 100} × ${Math.round(b.content[1] * 100) / 100}</div>`)))) : layer("bm-margin", "margin", b.margin, layer("bm-border", "border", b.border, layer("bm-padding", "padding", b.padding, `<div class="bm-content">${Math.round(b.content[0] * 100) / 100} × ${Math.round(b.content[1] * 100) / 100}</div>`)))}</div>
        <div class="computed-row"><span class="p">box-sizing</span><span class="v">${esc(b.boxSizing)}</span></div><div class="computed-row"><span class="p">position</span><span class="v">${esc(b.position)}</span></div><div class="computed-row"><span class="p">rendered size</span><span class="v">${Math.round(b.width)} × ${Math.round(b.height)}</span></div><div class="computed-row"><span class="p">page offset</span><span class="v">${Math.round(b.x)}, ${Math.round(b.y)}</span></div>`;
    } else if (which === "props") {
      const r = await call("runtime.evaluate", { expression: "$0" }); if (s.sel !== id) return;
      body.innerHTML = `<div style="padding:6px 10px;font:12px/1.6 var(--font-mono)">${obHtml(r.value, true)}</div>`; wireObjects(body);
    }
  } catch (e) { body.innerHTML = emptyMsg(e.message); }
}
function wireStyles(id, r) {
  const s = dtState(tab()); const body = $("stBody");
  $("stFilter").oninput = e => { s.styleFilter = e.target.value.trim(); clearTimeout(s._sf); s._sf = setTimeout(renderSide, 200); };
  $("stHov").onclick = () => { s.showStates = !s.showStates; renderSide(); }; $("stCls").onclick = () => { s.showCls = !s.showCls; renderSide(); };
  $("stAdd").onclick = async () => { const sel = (await call("dom.select", { id })).selector; const decl = prompt(`New rule for ${sel}\nEnter declarations (e.g. color: red; outline: 1px solid)`); if (!decl) return; const key = "rule-" + Date.now(); const prev = s.addedCss || ""; s.addedCss = prev + `\n${sel}{${decl}}`; await call("ext.css", { key: "devtools-added", css: s.addedCss }); renderSide(); };
  body.querySelectorAll("[data-state]").forEach(c => c.onchange = async () => { const k = id + ":" + c.dataset.state; c.checked ? s.forced.add(k) : s.forced.delete(k); await call("css.forceState", { id, state: c.dataset.state, on: c.checked }).catch(e => toast(e.message, { kind: "err" })); renderSide(); });
  body.querySelectorAll("[data-cls]").forEach(c => c.onchange = async () => { await call("css.toggleClass", { id, name: c.dataset.cls, force: c.checked }); await refreshNode(id); renderTree(); renderSide(); });
  const clsAdd = $("clsAdd"); if (clsAdd) clsAdd.onkeydown = async e => { if (e.key === "Enter") { e.preventDefault(); for (const c of clsAdd.value.split(/\s+/).filter(Boolean)) await call("css.toggleClass", { id, name: c, force: true }); await refreshNode(id); renderTree(); renderSide(); } };
  const apply = async (where, name, value) => { if (!name) return; try { if (where === "inline") await call("css.setInline", { id, name, value }); else await call("css.setRule", { ruleId: Number(where.split(":")[1]), name, value }); } catch (e) { toast(e.message, { kind: "err" }); } };
  body.querySelectorAll(".st-decl").forEach(d => {
    const where = d.dataset.where, k0 = d.dataset.k; const pEl = d.querySelector(".p"), vEl = d.querySelector(".v"); const chk = d.querySelector("input");
    const vOrig = vEl.textContent + (d.querySelector(".imp") ? " !important" : "");
    chk.onchange = async () => { d.classList.toggle("off", !chk.checked); await apply(where, k0, chk.checked ? vOrig : ""); };
    const commit = async () => { const k = pEl.textContent.trim(), v = vEl.textContent.trim().replace(/;$/, ""); if (k !== k0) await apply(where, k0, ""); await apply(where, k, v); setTimeout(renderSide, 30); };
    [pEl, vEl].forEach(el => { el.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter" || e.key === "Tab" && el === pEl) { e.preventDefault(); if (el === pEl) vEl.focus(); else el.blur(); } if (e.key === "Escape") { e.preventDefault(); renderSide(); } if (el === vEl && (e.key === "ArrowUp" || e.key === "ArrowDown")) { const m = vEl.textContent.match(/(-?\d*\.?\d+)([a-z%]*)/i); if (m) { e.preventDefault(); const step = e.shiftKey ? 10 : e.altKey ? .1 : 1; const nv = Math.round((parseFloat(m[1]) + (e.key === "ArrowUp" ? step : -step)) * 10) / 10; vEl.textContent = vEl.textContent.replace(m[0], nv + m[2]); apply(where, pEl.textContent.trim(), vEl.textContent.trim()); } } }; el.addEventListener("blur", () => { if (el.textContent !== el._orig) commit(); }); el._orig = el.textContent; });
  });
  body.querySelectorAll(".st-add").forEach(a => a.onclick = () => {
    const d = document.createElement("div"); d.className = "st-decl"; d.innerHTML = `<span class="p" contenteditable="plaintext-only"></span>:<span class="v" contenteditable="plaintext-only"></span>;`; a.before(d);
    const pEl = d.querySelector(".p"), vEl = d.querySelector(".v"); pEl.focus();
    pEl.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter" || e.key === "Tab" || e.key === ":") { e.preventDefault(); vEl.focus(); } if (e.key === "Escape") d.remove(); };
    vEl.onkeydown = async e => { e.stopPropagation(); if (e.key === "Enter" || e.key === ";") { e.preventDefault(); await apply(a.dataset.where, pEl.textContent.trim(), vEl.textContent.trim()); renderSide(); } if (e.key === "Escape") d.remove(); };
  });
}
function renderElements() { const t = tab(); if (!onPage(t)) { $("elTree").innerHTML = emptyMsg(); $("stBody").innerHTML = ""; $("elCrumbs").innerHTML = ""; return; } const s = dtState(t); if (!s.docLoaded) loadDocument(); else { renderTree(); renderSide(); } }

// ---- picker
let picking = false;
async function setPicking(on) {
  picking = on; $("dtPick")?.classList.toggle("on", on); $("dtPick")?.setAttribute("aria-pressed", on);
  const t = tab(); if (!onPage(t)) return;
  if (isRemote(t)) { $("remoteSurface")?.classList.toggle("picking", on); if ($("remoteImg")) $("remoteImg").style.cursor = on ? "crosshair" : ""; return; }
  try { await call("dom.pick", { enabled: on }); } catch (e) { if (on) toast(e.message, { kind: "warn" }); picking = false; $("dtPick")?.classList.remove("on"); }
}
function togglePick() { if (!onPage(tab())) return toast("Open a website to inspect it"); setPicking(!picking); }
export function inspect() { if (!onPage(tab())) return toast("Open a website to inspect it"); open("elements"); setPicking(true); }
async function onPicked(t, data) { if (t !== tab()) return; picking = false; $("dtPick")?.classList.remove("on"); if (!openState) open("elements"); else show("elements"); await revealPath(data.path); }

// ============================================================ Console
const LEVEL_ICON = { error: "✕", warn: "!", info: "i", debug: "·", log: "", cmd: "›", res: "‹" };
function buildConsole() {
  $("dt-console").innerHTML = `<div class="dt-sub"><button class="icon-btn" id="conClear" title="Clear console (${isMac ? "⌘K" : "Ctrl+L"})"><svg><use href="#i-ban"/></svg></button><span class="dt-sep"></span><input class="dt-input" id="conFilter" placeholder="Filter" style="flex:1;max-width:260px"><div class="dt-chips" id="conLevels">${[["all", "All levels"], ["error", "Errors"], ["warn", "Warnings"], ["info", "Info"], ["log", "Logs"], ["debug", "Verbose"]].map(([k, l]) => `<button class="dt-chip ${k === "all" ? "on" : ""}" data-lv="${k}">${l}</button>`).join("")}</div><span class="dt-sep"></span><label class="dt-chk"><input type="checkbox" id="conPreserve">Preserve log</label><label class="dt-chk"><input type="checkbox" id="conGroup" checked>Group similar</label><span class="muted" id="conHidden" style="margin-left:auto"></span></div>
    <div class="con-list" id="conList"></div>
    <div style="position:relative"><div class="con-comp hidden" id="conComp"></div></div>
    <div class="con-input"><span class="ico">›</span><textarea id="conInput" rows="1" spellcheck="false" placeholder="Run JavaScript in the page. Enter to run, Shift+Enter for a new line"></textarea></div>`;
  $("conPreserve").checked = !!settings.preserveLog; $("conPreserve").onchange = e => { settings.preserveLog = e.target.checked; saveSettings(); };
  $("conClear").onclick = () => { const t = tab(); if (t) t.console = []; renderConsole(); updateCounts(); };
  $("conFilter").oninput = debounceRaf(renderConsole); $("conGroup").onchange = renderConsole;
  $("conLevels").onclick = e => { const b = e.target.closest("[data-lv]"); if (!b) return; $("conLevels").querySelectorAll(".dt-chip").forEach(x => x.classList.toggle("on", x === b)); renderConsole(); };
  const inp = $("conInput");
  inp.oninput = () => { inp.style.height = "auto"; inp.style.height = Math.min(160, inp.scrollHeight) + "px"; completeSoon(); };
  inp.onkeydown = e => {
    e.stopPropagation(); const comp = $("conComp"); const s = dtState(tab() || {});
    if (!comp.classList.contains("hidden")) {
      const items = [...comp.children]; let i = items.findIndex(x => x.classList.contains("on"));
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); i = (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; items.forEach((x, j) => x.classList.toggle("on", j === i)); return; }
      if (e.key === "Tab" || e.key === "Enter" && i >= 0) { e.preventDefault(); applyCompletion(items[Math.max(0, i)].textContent); return; }
      if (e.key === "Escape") { comp.classList.add("hidden"); return; }
    }
    if ((e.ctrlKey && e.key === "l") || (e.metaKey && e.key === "k")) { e.preventDefault(); $("conClear").click(); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const code = inp.value; if (!code.trim()) return; inp.value = ""; inp.style.height = "auto"; comp.classList.add("hidden"); runConsole(code); return; }
    if (e.key === "ArrowUp" && !inp.value.slice(0, inp.selectionStart).includes("\n")) { if (!s.conHistory?.length) return; e.preventDefault(); s.conHistIdx = Math.min(s.conHistory.length - 1, s.conHistIdx + 1); inp.value = s.conHistory[s.conHistory.length - 1 - s.conHistIdx]; }
    else if (e.key === "ArrowDown" && !inp.value.slice(inp.selectionEnd).includes("\n")) { if (s.conHistIdx < 0) return; e.preventDefault(); s.conHistIdx--; inp.value = s.conHistIdx < 0 ? "" : s.conHistory[s.conHistory.length - 1 - s.conHistIdx]; }
    else if (e.key === "Tab") { e.preventDefault(); completeNow(true); }
  };
  $("conList").addEventListener("click", e => { const u = e.target.closest("[data-src]"); if (u) { e.preventDefault(); openSource(u.dataset.src, Number(u.dataset.line) || 0); } });
  wireObjects($("conList"));
}
function pushConsole(entry) { const t = tab(); if (!t) return; t.console.push({ time: Date.now(), ...entry }); renderConsoleSoon(); }
async function runConsole(code) {
  const t = tab(); if (!onPage(t)) { pushConsole({ level: "error", kind: "res", message: "No page is loaded in this tab." }); return; }
  const s = dtState(t); s.conHistory.push(code); if (s.conHistory.length > 100) s.conHistory.shift(); s.conHistIdx = -1;
  pushConsole({ level: "cmd", kind: "cmd", message: code });
  try { const r = await call("runtime.evaluate", { expression: code }, 15000); pushConsole({ level: r.exception ? "error" : "res", kind: "res", preview: r.value, message: r.value?.text || "" }); }
  catch (e) { pushConsole({ level: "error", kind: "res", message: e.message }); }
}
let compTimer = 0; function completeSoon() { clearTimeout(compTimer); compTimer = setTimeout(() => completeNow(false), 160); }
async function completeNow(force) {
  const inp = $("conInput"); const before = inp.value.slice(0, inp.selectionStart); const m = before.match(/([\w$][\w$.]*)$/); const comp = $("conComp");
  if (!m || (!force && !m[1].includes(".") && m[1].length < 2)) { comp.classList.add("hidden"); return; }
  const prefix = m[1]; let list = []; try { list = await call("runtime.completions", { prefix }, 2000); } catch {}
  const last = prefix.split(".").pop(); list = list.filter(x => x !== last).slice(0, 40);
  if (!list.length) { comp.classList.add("hidden"); return; }
  comp.innerHTML = list.map((x, i) => `<div class="${i === 0 ? "on" : ""}">${esc(x)}</div>`).join(""); comp.classList.remove("hidden"); comp.style.bottom = "0px"; comp.style.left = "28px";
  comp.onmousedown = e => { e.preventDefault(); const d = e.target.closest("div"); if (d) applyCompletion(d.textContent); };
}
function applyCompletion(word) { const inp = $("conInput"); const pos = inp.selectionStart; const before = inp.value.slice(0, pos).replace(/([\w$]*)$/, word); inp.value = before + inp.value.slice(pos); inp.selectionStart = inp.selectionEnd = before.length; $("conComp").classList.add("hidden"); inp.focus(); }
function obHtml(pv, expandable = true) {
  if (!pv) return `<span class="ob-u">undefined</span>`;
  switch (pv.type) {
    case "string": return `<span class="ob-s">"${esc(pv.text)}"</span>`;
    case "number": case "bigint": return `<span class="ob-n">${esc(pv.text)}</span>`;
    case "boolean": return `<span class="ob-b">${esc(pv.text)}</span>`;
    case "null": case "undefined": return `<span class="ob-u">${esc(pv.text)}</span>`;
    case "symbol": return `<span class="ob-s">${esc(pv.text)}</span>`;
    case "function": return expandable ? `<span class="ob" data-obj="${pv.objectId}"><span class="ob-t ob-f">${esc(pv.text)}</span></span>` : `<span class="ob-f">${esc(pv.text)}</span>`;
    case "node": return `<span class="ob-node" data-node='${esc(JSON.stringify(pv.path || []))}' title="Reveal in Elements">${esc(pv.text)}</span>`;
    case "error": return `<span class="ob" data-obj="${pv.objectId}"><span class="ob-t" style="color:var(--err)">${esc(pv.text)}</span></span>${pv.stack ? `<span class="stack">${esc(pv.stack.split("\n").slice(1, 6).join("\n"))}</span>` : ""}`;
    default: {
      let txt = esc(pv.text || pv.className || "Object");
      if (pv.entries && pv.subtype === "array") txt = `${esc(pv.className || "Array")}(${pv.length}) [${pv.entries.map(e => obHtml(e, false)).join(", ")}${pv.length > pv.entries.length ? ", …" : ""}]`;
      return expandable && pv.objectId ? `<span class="ob" data-obj="${pv.objectId}"><span class="ob-t">${txt}</span></span>` : `<span>${txt}</span>`;
    }
  }
}
function wireObjects(container) {
  container.addEventListener("click", async e => {
    const nd = e.target.closest("[data-node]"); if (nd) { open("elements"); revealPath(JSON.parse(nd.dataset.node)); return; }
    const t = e.target.closest(".ob-t"); if (!t) return; const ob = t.parentElement; if (!ob?.dataset.obj) return;
    if (ob.classList.toggle("open")) {
      let kids = ob.querySelector(":scope > .ob-kids"); if (kids) return;
      kids = document.createElement("span"); kids.className = "ob-kids"; kids.textContent = "…"; ob.appendChild(kids);
      try { const props = await call("runtime.properties", { objectId: Number(ob.dataset.obj) }); kids.innerHTML = props.map(pr => `<div><span class="ob-k ${pr.name.startsWith("[[") ? "np" : ""}">${esc(pr.name)}</span>: ${obHtml(pr.value)}</div>`).join("") || `<span class="ob-u">No properties</span>`; }
      catch (err) { kids.textContent = err.message; }
    } else ob.querySelector(":scope > .ob-kids")?.remove();
  });
}
const renderConsoleSoon = debounceRaf(() => { if (openState && p("console")) renderConsole(); updateCounts(); });
function linkify(s) { return esc(s).replace(/(https?:\/\/[^\s)"'<]+?)(?::(\d+))?(?::(\d+))?(?=[\s)"'<]|$)/g, (m, u, l) => `<a href="#" data-src="${u}" data-line="${l || 0}" style="color:var(--text-2)">${u.length > 90 ? u.slice(0, 90) + "…" : u}${l ? ":" + l : ""}</a>`); }
function renderConsole() {
  const t = tab(); const list = $("conList"); if (!list) return;
  if (!t) { list.innerHTML = ""; return; }
  const lv = $("conLevels").querySelector(".on")?.dataset.lv || "all"; const q = $("conFilter").value.toLowerCase(); const group = $("conGroup").checked;
  const all = t.console || []; const rows = []; let hidden = 0;
  for (const c of all) {
    const isRepl = c.kind === "cmd" || c.kind === "res";
    if (!isRepl && lv !== "all" && c.level !== lv) { hidden++; continue; }
    if (q && !String(c.message).toLowerCase().includes(q)) { hidden++; continue; }
    const last = rows[rows.length - 1];
    if (group && last && !isRepl && last.c.level === c.level && last.c.message === c.message && last.c.kind === c.kind) { last.n++; continue; }
    rows.push({ c, n: 1 });
  }
  $("conHidden").textContent = hidden ? `${hidden} hidden` : "";
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.innerHTML = rows.slice(-1500).map(({ c, n }) => {
    const cls = c.kind === "cmd" ? "cmd" : c.kind === "res" ? (c.level === "error" ? "error res" : "res") : c.level;
    const body = c.preview ? obHtml(c.preview) : c.kind === "cmd" ? esc(c.message) : linkify(String(c.message));
    const meta = c.kind === "exception" ? `${pathOf(c.url || "")}${c.line ? ":" + c.line : ""}` : "";
    return `<div class="con-row ${esc(cls)}"><span class="ico">${LEVEL_ICON[c.kind === "cmd" ? "cmd" : c.kind === "res" && c.level !== "error" ? "res" : c.level] ?? ""}</span>${n > 1 ? `<span class="cnt">${n}</span>` : ""}<span class="body">${c.kind === "exception" ? "Uncaught " : ""}${body}${c.stack && c.kind !== "res" ? `<span class="stack">${linkify(String(c.stack).split("\n").slice(c.kind === "exception" ? 1 : 0, 7).join("\n"))}</span>` : ""}</span>${meta ? `<a class="meta" href="#" data-src="${esc(c.url)}" data-line="${c.line || 0}">${esc(meta)}</a>` : `<span class="meta">${new Date(c.time).toLocaleTimeString([], { hour12: false })}</span>`}</div>`;
  }).join("") || `<div class="dt-empty">${onPage(t) ? "Console messages from the page will appear here." : "Open a website to use the console."}</div>`;
  if (atBottom) list.scrollTop = list.scrollHeight;
}

// ============================================================ Sources
function buildSources() {
  $("dt-sources").innerHTML = `<div class="src-tree" id="srcTree"></div><div class="dt-col"><div class="src-tabsbar" id="srcTabs"></div><div class="dt-sub"><input class="dt-input" id="srcFind" placeholder="Find in file" style="max-width:220px"><span class="muted" id="srcFindCount"></span><span style="flex:1"></span><button class="dt-chip" id="srcPretty" title="Pretty print">{ }</button><button class="dt-chip" id="srcCopy">Copy</button><button class="dt-chip" id="srcOpen">Open in tab</button><button class="icon-btn" id="srcReload" title="Refresh list"><svg><use href="#i-reload"/></svg></button></div><pre class="dt-code" id="srcCode"></pre><div class="net-foot" id="srcFoot"></div></div>`;
  $("srcTree").onclick = e => { const b = e.target.closest("[data-key]"); if (b) openFile(b.dataset.key); };
  $("srcTabs").onclick = e => { const x = e.target.closest("[data-close]"); const s = dtState(tab()); if (x) { e.stopPropagation(); s.srcOpen = s.srcOpen.filter(k => k !== x.dataset.close); if (s.srcActive === x.dataset.close) s.srcActive = s.srcOpen[s.srcOpen.length - 1] || null; renderSources(); return; } const b = e.target.closest("[data-key]"); if (b) openFile(b.dataset.key); };
  $("srcReload").onclick = () => { const s = dtState(tab()); s.srcList = null; renderSources(); };
  $("srcPretty").onclick = () => { const s = dtState(tab()); const f = s.srcFiles?.[s.srcActive]; if (!f) return; f.pretty = !f.pretty; drawFile(); };
  $("srcCopy").onclick = () => { const s = dtState(tab()); const f = s.srcFiles?.[s.srcActive]; if (f) copyText(f.pretty ? B.prettyPrint(f.text, f.type) : f.text); };
  $("srcOpen").onclick = () => { const s = dtState(tab()); const f = s.srcFiles?.[s.srcActive]; if (f?.url) B.newTab({ url: f.url }); };
  $("srcFind").oninput = debounceRaf(drawFile);
}
async function renderSources() {
  const t = tab(); if (!onPage(t)) { $("srcTree").innerHTML = emptyMsg(); $("srcCode").innerHTML = ""; $("srcTabs").innerHTML = ""; return; }
  const s = dtState(t);
  if (!s.srcList) { $("srcTree").innerHTML = `<div class="dt-empty">Loading…</div>`; try { s.srcList = await call("sources.list", {}); } catch (e) { $("srcTree").innerHTML = emptyMsg(e.message); return; } }
  const L = s.srcList; const files = [{ key: "doc", url: L.document.url, type: "html", label: pathOf(L.document.url).split("/").pop() || "(index)" }];
  L.scripts.forEach(x => files.push({ key: `script:${x.index}`, url: x.url, inline: x.inline, kind: "script", index: x.index, type: "js", label: x.inline ? `(inline script ${x.index + 1})` : pathOf(x.url).split("/").pop() || x.url }));
  L.styles.forEach(x => files.push({ key: `style:${x.index}`, url: x.url, inline: x.inline, kind: "style", index: x.index, type: "css", label: x.inline ? `(inline style ${x.index + 1})` : pathOf(x.url).split("/").pop() || x.url }));
  s.srcIndex = Object.fromEntries(files.map(f => [f.key, f]));
  const byHost = {}; for (const f of files) { const h = f.inline ? hostOf(L.document.url) : hostOf(f.url) || "(page)"; (byHost[h] ||= []).push(f); }
  $("srcTree").innerHTML = Object.entries(byHost).map(([h, fs]) => `<div class="src-host"><svg><use href="#i-globe"/></svg>${esc(h)}</div>${fs.map(f => `<button class="src-file ${s.srcActive === f.key ? "on" : ""}" data-key="${esc(f.key)}" title="${esc(f.url)}"><span class="res-type">${f.type}</span>${esc(f.label)}</button>`).join("")}`).join("");
  $("srcTabs").innerHTML = s.srcOpen.map(k => `<button data-key="${esc(k)}" class="${k === s.srcActive ? "on" : ""}">${esc(s.srcIndex[k]?.label || k)}<span data-close="${esc(k)}">✕</span></button>`).join("");
  if (!s.srcActive) { $("srcCode").innerHTML = `<span class="ln muted">Select a file on the left to view its source.</span>`; $("srcFoot").textContent = `${files.length} files`; }
  else drawFile();
}
async function openFile(key, line = 0) {
  const s = dtState(tab()); const f = s.srcIndex?.[key]; if (!f) return;
  if (!s.srcOpen.includes(key)) s.srcOpen.push(key); s.srcActive = key; s.srcLine = line; s.srcFiles ||= {};
  if (!s.srcFiles[key]) {
    $("srcCode").innerHTML = `<span class="ln muted">Loading…</span>`;
    let text = "";
    try {
      if (key === "doc") text = await call("sources.document", {}, 10000);
      else if (f.inline) text = await call("sources.inline", { kind: f.kind, index: f.index });
      else if (B.state.session) { const r = await rawFetch(proxyUrl(f.url, "resource", B.state.session.id)); text = await r.text(); }
      else text = "// The session ended, so this file can't be fetched.";
    } catch (e) { text = `// Couldn't load: ${e.message}`; }
    s.srcFiles[key] = { text, type: f.type, url: f.url, pretty: f.type !== "html" && text.length > 400 && text.split("\n").length < 6 };
  }
  renderSources();
}
export async function openSource(url, line = 0) {
  open("sources"); const s = dtState(tab()); if (!s.srcList) await renderSources();
  const f = Object.values(s.srcIndex || {}).find(x => x.url && (x.url === url || x.url.split("?")[0] === url.split("?")[0]));
  if (f) openFile(f.key, line); else if (url) { s.srcIndex[url] = { key: url, url, type: /\.css/.test(url) ? "css" : "js", label: pathOf(url).split("/").pop() }; openFile(url, line); }
}
function drawFile() {
  const s = dtState(tab()); const f = s.srcFiles?.[s.srcActive]; if (!f) return;
  const text = f.pretty ? (f._pretty ||= B.prettyPrint(f.text, f.type)) : f.text;
  let html = B.highlightCode(text.length > 1500000 ? text.slice(0, 1500000) : text, f.type);
  const q = $("srcFind").value; let hits = 0;
  if (q) { const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"); html = html.replace(/(<span class="ln">)(.*?)(<\/span>)(?=<span class="ln">|$)/g, (m, a, body, c) => { if (!re.test(body.replace(/<[^>]+>/g, ""))) return m; re.lastIndex = 0; hits++; return `<span class="ln hl">${body}${c}`; }); }
  $("srcCode").innerHTML = html; $("srcFindCount").textContent = q ? `${hits} lines` : "";
  $("srcFoot").textContent = `${f.url || "inline"} · ${text.split("\n").length.toLocaleString()} lines · ${fmtBytes(f.text.length)}${f.pretty ? " · pretty printed" : ""}`;
  $("srcPretty").classList.toggle("on", !!f.pretty);
  if (s.srcLine) { const el = $("srcCode").children[s.srcLine - 1]; if (el) { el.classList.add("hl"); el.scrollIntoView({ block: "center" }); } s.srcLine = 0; }
  else if (q) $("srcCode").querySelector(".hl")?.scrollIntoView({ block: "center" });
}

// ============================================================ Network
const NET_TYPES = [["all", "All"], ["xhr", "Fetch/XHR"], ["doc", "Doc"], ["css", "CSS"], ["js", "JS"], ["img", "Img"], ["media", "Media"], ["font", "Font"], ["ws", "WS"], ["other", "Other"]];
function netType(e) {
  const m = String(e.mime || e.contentType || "").toLowerCase(), full = String(e.url || "").toLowerCase(), u = full.split("?")[0], it = e.initiatorType || e.resourceType || "";
  if (it === "link" && !m && /[?&](only=styles|type=css)|\.css(\?|$)|stylesheet|\/css/.test(full)) return "css";
  if (it === "link" && !m && /\.m?js(\?|$)|only=scripts/.test(full)) return "js";
  if (e.kind === "xhr" || it === "fetch" || it === "xmlhttprequest" || it === "xhr") return "xhr";
  if (it === "document" || /html/.test(m)) return "doc";
  if (it === "websocket") return "ws";
  if (/css/.test(m) || it === "css" && /\.css$/.test(u) || it === "stylesheet" || /\.css$/.test(u)) return "css";
  if (/javascript|ecmascript/.test(m) || it === "script" || /\.m?js$/.test(u)) return "js";
  if (/^image\//.test(m) || it === "img" || it === "image" || /\.(png|jpe?g|gif|webp|avif|svg|ico)$/.test(u)) return "img";
  if (/^(video|audio)\//.test(m) || it === "media" || it === "video" || it === "audio") return "media";
  if (/font/.test(m) || it === "font" || /\.(woff2?|ttf|otf)$/.test(u)) return "font";
  return "other";
}
function netRows(t) {
  const s = dtState(t); const rows = [];
  for (const n of t.network || []) {
    if (n.remote) { rows.push(n); continue; }
    rows.push({ id: n.id, kind: "xhr", method: n.method, url: n.url, status: n.status, ok: n.ok, duration: n.duration, startedAt: n.startedAt, mime: n.mime, size: n.size, responseHeaders: n.responseHeaders || {}, requestHeaders: n.requestHeaders || {}, requestBody: n.requestBody, blocked: n.blocked, error: n.error, initiator: n.initiator || "fetch" });
  }
  for (const r of s.resEntries) rows.push(r);
  return rows.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}
function buildNetwork() {
  $("dt-network").innerHTML = `<div class="dt-sub"><button class="icon-btn" id="netRec" title="Recording"><svg style="color:var(--err)"><use href="#i-circle"/></svg></button><button class="icon-btn" id="netClear" title="Clear"><svg><use href="#i-ban"/></svg></button><span class="dt-sep"></span><input class="dt-input" id="netFilter" placeholder="Filter (text, -exclude, status:404, method:POST)" style="flex:1;max-width:320px"><label class="dt-chk"><input type="checkbox" id="netPreserve">Preserve log</label><label class="dt-chk"><input type="checkbox" id="netBodies">Capture bodies</label><button class="dt-chip" id="netHar" title="Export HAR">Export HAR</button></div>
    <div class="dt-sub"><div class="dt-chips" id="netTypes">${NET_TYPES.map(([k, l]) => `<button class="dt-chip ${k === "all" ? "on" : ""}" data-nt="${k}">${l}</button>`).join("")}</div></div>
    <div class="dt-split"><div class="dt-pane" style="flex:1" id="netWrap"><table class="net-table"><colgroup><col style="width:34%"><col style="width:9%"><col style="width:8%"><col style="width:12%"><col style="width:9%"><col style="width:9%"><col></colgroup><thead><tr><th data-sort="name">Name</th><th data-sort="status">Status</th><th data-sort="type">Type</th><th>Initiator</th><th data-sort="size">Size</th><th data-sort="time">Time</th><th>Waterfall</th></tr></thead><tbody id="netBody"></tbody></table></div>
    <div class="net-detail hidden" id="netDetail" style="width:48%"><div class="st-tabs" id="ndTabs"><button class="icon-btn sm" id="ndClose" title="Close" style="width:26px"><svg><use href="#i-x"/></svg></button><button data-nd="headers" class="on">Headers</button><button data-nd="payload">Payload</button><button data-nd="preview">Preview</button><button data-nd="response">Response</button><button data-nd="timing">Timing</button></div><div class="dt-pane" id="ndBody"></div></div></div>
    <div class="net-foot" id="netFoot"></div>`;
  $("netPreserve").checked = !!settings.preserveLog; $("netPreserve").onchange = e => { settings.preserveLog = e.target.checked; saveSettings(); };
  $("netBodies").checked = settings.captureBodies !== false; $("netBodies").onchange = e => { settings.captureBodies = e.target.checked; saveSettings(); const t = tab(); if (onPage(t)) { dtState(t).netEnabled = false; enableNetwork(t); } };
  $("netClear").onclick = () => { const t = tab(); if (!t) return; t.network = []; dtState(t).resEntries = []; dtState(t).netSel = null; renderNetwork(); };
  $("netRec").onclick = () => { const s = dtState(tab()); s.netPaused = !s.netPaused; $("netRec").querySelector("svg").style.color = s.netPaused ? "var(--muted)" : "var(--err)"; };
  $("netFilter").oninput = debounceRaf(renderNetwork);
  $("netTypes").onclick = e => { const b = e.target.closest("[data-nt]"); if (!b) return; dtState(tab()).netFilter = b.dataset.nt; $("netTypes").querySelectorAll(".dt-chip").forEach(x => x.classList.toggle("on", x === b)); renderNetwork(); };
  $("netBody").onclick = e => { const r = e.target.closest("tr[data-i]"); if (!r) return; const s = dtState(tab()); s.netSel = r.dataset.i; s.ndTab ||= "headers"; renderNetwork(); };
  $("netBody").oncontextmenu = e => { const r = e.target.closest("tr[data-i]"); if (!r) return; e.preventDefault(); const row = netRows(tab()).find(x => rowKey(x) === r.dataset.i); if (!row) return;
    dtMenu(e.clientX, e.clientY, [{ label: "Open in new tab", action: () => B.newTab({ url: row.url }) }, "-", { label: "Copy URL", action: () => copyText(row.url) }, { label: "Copy as cURL", action: () => copyText(asCurl(row)) }, { label: "Copy as fetch", action: () => copyText(asFetch(row)) }, { label: "Copy response", action: async () => { const b = await call("network.body", { id: row.id }).catch(() => null); copyText(b?.text || ""); } }, "-", { label: "Clear network log", action: () => $("netClear").click() }]); };
  $("ndTabs").onclick = e => { const b = e.target.closest("[data-nd]"); if (b) { dtState(tab()).ndTab = b.dataset.nd; renderNetDetail(); } if (e.target.closest("#ndClose")) { dtState(tab()).netSel = null; renderNetwork(); } };
  $("netHar").onclick = exportHar;
  root.querySelector(".net-table thead").onclick = e => { const th = e.target.closest("[data-sort]"); if (!th) return; const s = dtState(tab()); s.netSort = s.netSort === th.dataset.sort ? th.dataset.sort + ":desc" : th.dataset.sort; renderNetwork(); };
}
const rowKey = r => String(r.id ?? r.url + "@" + r.startedAt);
async function enableNetwork(t) {
  const s = dtState(t); if (s.netEnabled || !onPage(t) || isRemote(t)) return; s.netEnabled = true;
  try {
    const list = await dtCall(t, "network.enable", { bodies: settings.captureBodies !== false });
    const origin = performance.timeOrigin || Date.now();
    s.resEntries = (list || []).filter(r => !["fetch", "xmlhttprequest"].includes(r.initiatorType)).map(r => resRow(r, s));
    if (p("network")) renderNetwork();
  } catch { s.netEnabled = false; }
}
function resRow(r, s) { const base = s.navStart || Date.now() - (r.startTime || 0) - 5; s.navStart ||= base; return { id: "res-" + r.startTime + "-" + r.url.slice(-40), kind: "res", method: "GET", url: r.url, status: r.status || 200, ok: true, duration: r.duration, startedAt: base + r.startTime, size: r.transferSize || r.encodedBodySize, decoded: r.decodedBodySize, initiatorType: r.initiatorType, initiator: r.initiatorType, protocol: r.protocol, mime: "", responseHeaders: {}, requestHeaders: {} }; }
function parseNetFilter(q) { const out = { text: [], not: [], status: null, method: null, domain: null }; for (const part of q.split(/\s+/).filter(Boolean)) { const m = part.match(/^(-?)(status|method|domain|larger-than):(.+)$/i); if (m) out[m[2].toLowerCase()] = m[3]; else if (part.startsWith("-")) out.not.push(part.slice(1).toLowerCase()); else out.text.push(part.toLowerCase()); } return out; }
function renderNetwork() {
  const t = tab(); const body = $("netBody"); if (!body) return;
  if (!onPage(t)) { body.innerHTML = `<tr><td colspan="7" class="dt-empty">Open a website to record network activity.</td></tr>`; $("netFoot").textContent = ""; $("netDetail").classList.add("hidden"); return; }
  enableNetwork(t); if (isRemote(t)) pollRemote();
  const s = dtState(t); const f = parseNetFilter($("netFilter").value);
  let rows = netRows(t).filter(r => (s.netFilter === "all" || netType(r) === s.netFilter) && f.text.every(x => r.url.toLowerCase().includes(x)) && !f.not.some(x => r.url.toLowerCase().includes(x)) && (!f.status || String(r.status) === f.status) && (!f.method || r.method.toUpperCase() === f.method.toUpperCase()) && (!f.domain || hostOf(r.url).includes(f.domain)));
  if (s.netSort) { const [k, d] = s.netSort.split(":"); const val = r => k === "name" ? r.url : k === "status" ? r.status : k === "type" ? netType(r) : k === "size" ? r.size || 0 : r.duration || 0; rows = [...rows].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * (d ? -1 : 1)); }
  const all = netRows(t); const t0 = Math.min(...all.map(r => r.startedAt || Infinity)); const t1 = Math.max(...all.map(r => (r.startedAt || 0) + (r.duration || 0))); const span = Math.max(1, t1 - t0);
  const COLORS = { xhr: "#d9a441", doc: "#4f8ff7", css: "#9b7df2", js: "#e6c84f", img: "#4fbf8f", media: "#e56a9a", font: "#e59a4f", ws: "#7fb2c9", other: "#8a93a3" };
  body.innerHTML = rows.slice(-1500).map(r => { const ty = netType(r); const k = rowKey(r); const name = pathOf(r.url).split("/").filter(Boolean).pop() || hostOf(r.url); return `<tr data-i="${esc(k)}" class="${k === s.netSel ? "sel" : ""} ${r.blocked ? "blocked" : !r.ok || r.status >= 400 || r.error ? "fail" : ""}" title="${esc(r.url)}"><td><span class="nm"><i style="background:${COLORS[ty]}"></i>${esc(name.length > 80 ? name.slice(0, 80) + "…" : name)}</span></td><td>${r.blocked ? "blocked" : r.error ? "(failed)" : r.status || "—"}</td><td>${ty === "xhr" ? (r.initiator === "xhr" ? "xhr" : "fetch") : ty}</td><td>${esc(r.initiator || "")}</td><td>${r.size ? fmtBytes(r.size) : r.kind === "res" ? "(cache)" : "—"}</td><td>${r.duration != null ? fmtMs(r.duration) : "—"}</td><td><div class="wf"><i style="left:${((r.startedAt - t0) / span * 100).toFixed(2)}%;width:${Math.max(.3, (r.duration || 0) / span * 100).toFixed(2)}%;background:${COLORS[ty]}"></i></div></td></tr>`; }).join("") || `<tr><td colspan="7" class="dt-empty">${all.length ? "No requests match the filter." : "Recording network activity… Reload the page to capture everything."}</td></tr>`;
  const bytes = rows.reduce((a, r) => a + (r.size || 0), 0);
  $("netFoot").innerHTML = `<span>${rows.length}${rows.length !== all.length ? ` / ${all.length}` : ""} requests</span><span>${fmtBytes(bytes)} transferred</span><span>Finish: ${fmtMs(span)}</span>${all.filter(r => r.blocked).length ? `<span>${all.filter(r => r.blocked).length} blocked</span>` : ""}`;
  $("netDetail").classList.toggle("hidden", !s.netSel); if (s.netSel) renderNetDetail();
}
const netRenderSoon = debounceRaf(() => { if (openState && p("network")) renderNetwork(); });
function kv(obj) { const e = Object.entries(obj || {}); return e.length ? `<dl class="hdr-kv">${e.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : `<div class="hdr-kv muted" style="display:block">None captured</div>`; }
async function renderNetDetail() {
  const t = tab(); const s = dtState(t); const r = netRows(t).find(x => rowKey(x) === s.netSel); const box = $("ndBody"); if (!r) { box.innerHTML = emptyMsg("Request not found."); return; }
  const which = s.ndTab || "headers"; $("ndTabs").querySelectorAll("[data-nd]").forEach(b => b.classList.toggle("on", b.dataset.nd === which));
  if (which === "headers") box.innerHTML = `<details class="hdr-sec" open><summary>General</summary>${kv({ "Request URL": r.url, "Request Method": r.method, "Status Code": r.blocked ? `blocked (${r.blocked})` : r.error ? `failed: ${r.error}` : r.status, "Type": netType(r), ...(r.protocol ? { Protocol: r.protocol } : {}), "Via": isRemote(t) ? "Veyra Chromium" : "Veyra proxy" })}</details><details class="hdr-sec" open><summary>Response headers</summary>${kv(Object.fromEntries(Object.entries(r.responseHeaders || {}).filter(([k]) => !k.startsWith("x-veyra-"))))}</details><details class="hdr-sec" open><summary>Request headers</summary>${kv(r.requestHeaders)}</details>${Object.keys(r.responseHeaders || {}).some(k => k.startsWith("x-veyra-")) ? `<details class="hdr-sec"><summary>Veyra</summary>${kv(Object.fromEntries(Object.entries(r.responseHeaders).filter(([k]) => k.startsWith("x-veyra-"))))}</details>` : ""}`;
  else if (which === "payload") { let q = {}; try { q = Object.fromEntries(new URL(r.url).searchParams); } catch {} box.innerHTML = `${Object.keys(q).length ? `<details class="hdr-sec" open><summary>Query string parameters</summary>${kv(q)}</details>` : ""}${r.requestBody ? `<details class="hdr-sec" open><summary>Request payload</summary><pre class="dt-code" style="padding:6px 12px">${esc(tryPretty(r.requestBody))}</pre></details>` : ""}` || emptyMsg("This request has no payload."); }
  else if (which === "timing") { const d = r.duration || 0; box.innerHTML = `<div style="padding:10px 0">${[["Queued at", `${new Date(r.startedAt).toLocaleTimeString([], { hour12: false })}.${String(r.startedAt % 1000 | 0).padStart(3, "0")}`], ["Total duration", fmtMs(d)]].map(([a, b]) => `<div class="timing-row"><span>${a}</span><span></span><span>${b}</span></div>`).join("")}<div class="timing-row"><span>Request + response</span><div class="bar"><i style="left:0;width:100%;background:var(--accent)"></i></div><span>${fmtMs(d)}</span></div>${r.decoded ? `<div class="timing-row"><span>Decoded size</span><span></span><span>${fmtBytes(r.decoded)}</span></div>` : ""}<p class="dt-note" style="border:0">Timings are measured in the page, so they include the hop through Veyra's server.</p></div>`; }
  else {
    box.innerHTML = `<div class="dt-empty">Loading…</div>`;
    let b = null; if (r.kind === "xhr" && !isRemote(t)) b = await call("network.body", { id: r.id }).catch(() => null);
    if (!b && r.url && B.state.session && r.method === "GET") { try { const res = await rawFetch(proxyUrl(r.url, "resource", B.state.session.id)); const ct = res.headers.get("content-type") || ""; b = /json|text|xml|javascript|css|html|svg/.test(ct) ? { type: ct, text: await res.text(), note: "Re-fetched through Veyra (the original body wasn't captured)." } : { type: ct, text: null, note: `Binary response (${ct || "unknown type"})`, image: /^image\//.test(ct) }; } catch {} }
    if (s.netSel !== rowKey(r) || (s.ndTab || "headers") !== which) return;
    if (!b) { box.innerHTML = emptyMsg(settings.captureBodies === false ? "Turn on Capture bodies, then reload the page." : "The response body wasn't captured for this request."); return; }
    if (which === "preview") {
      if (b.image || netType(r) === "img") { box.innerHTML = `<div style="padding:16px;text-align:center"><img src="${esc(proxyUrl(r.url, "resource", B.state.session?.id))}" style="max-width:100%;max-height:260px;background:repeating-conic-gradient(#8883 0 25%,transparent 0 50%) 0 0/16px 16px"></div>`; return; }
      let json = null; try { json = JSON.parse(b.text); } catch {}
      if (json !== null) { box.innerHTML = `<div style="padding:6px 12px;font:12px/1.6 var(--font-mono)">${jsonTree(json, 0)}</div>`; box.querySelectorAll(".ob-t").forEach(x => x.onclick = () => x.parentElement.classList.toggle("open")); return; }
      if (/html/.test(b.type)) { box.innerHTML = `<iframe sandbox style="width:100%;height:100%;border:0;background:#fff" srcdoc="${esc(b.text || "")}"></iframe>`; return; }
    }
    box.innerHTML = `${b.note ? `<div class="dt-note">${esc(b.note)}</div>` : ""}${b.text != null ? `<pre class="dt-code">${B.highlightCode(b.text.length > 300000 ? b.text.slice(0, 300000) : tryPretty(b.text), /json/.test(b.type) ? "js" : /css/.test(b.type) ? "css" : /html|xml/.test(b.type) ? "html" : /javascript/.test(b.type) ? "js" : "txt")}</pre>` : ""}`;
  }
}
function tryPretty(t) { try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return String(t); } }
function jsonTree(v, d) {
  if (v === null) return `<span class="ob-u">null</span>`; if (typeof v === "string") return `<span class="ob-s">"${esc(v.length > 500 ? v.slice(0, 500) + "…" : v)}"</span>`; if (typeof v === "number") return `<span class="ob-n">${v}</span>`; if (typeof v === "boolean") return `<span class="ob-b">${v}</span>`;
  const arr = Array.isArray(v); const keys = Object.keys(v); const label = arr ? `Array(${v.length})` : `{${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""}}`;
  return `<span class="ob ${d < 1 ? "open" : ""}"><span class="ob-t">${esc(label)}</span><span class="ob-kids">${keys.slice(0, 500).map(k => `<div><span class="ob-k">${esc(k)}</span>: ${jsonTree(v[k], d + 1)}</div>`).join("")}</span></span>`;
}
function asCurl(r) { return [`curl ${JSON.stringify(r.url)}`, r.method !== "GET" ? `-X ${r.method}` : "", ...Object.entries(r.requestHeaders || {}).map(([k, v]) => `-H ${JSON.stringify(`${k}: ${v}`)}`), r.requestBody ? `--data-raw ${JSON.stringify(String(r.requestBody))}` : ""].filter(Boolean).join(" \\\n  "); }
function asFetch(r) { return `fetch(${JSON.stringify(r.url)}, ${JSON.stringify({ method: r.method, headers: r.requestHeaders || {}, ...(r.requestBody ? { body: String(r.requestBody) } : {}) }, null, 2)});`; }
function exportHar() {
  const t = tab(); if (!t) return; const rows = netRows(t);
  const har = { log: { version: "1.2", creator: { name: "Veyra DevTools", version: "8.13" }, pages: [{ id: "page_1", title: t.url, startedDateTime: new Date(rows[0]?.startedAt || Date.now()).toISOString(), pageTimings: {} }], entries: rows.map(r => ({ pageref: "page_1", startedDateTime: new Date(r.startedAt || Date.now()).toISOString(), time: r.duration || 0, request: { method: r.method, url: r.url, httpVersion: r.protocol || "HTTP/1.1", headers: Object.entries(r.requestHeaders || {}).map(([name, value]) => ({ name, value: String(value) })), queryString: [], cookies: [], headersSize: -1, bodySize: r.requestBody ? String(r.requestBody).length : 0, ...(r.requestBody ? { postData: { mimeType: "", text: String(r.requestBody) } } : {}) }, response: { status: r.status || 0, statusText: "", httpVersion: r.protocol || "HTTP/1.1", headers: Object.entries(r.responseHeaders || {}).map(([name, value]) => ({ name, value: String(value) })), cookies: [], content: { size: r.size || 0, mimeType: r.mime || "" }, redirectURL: "", headersSize: -1, bodySize: r.size || -1 }, cache: {}, timings: { send: 0, wait: r.duration || 0, receive: 0 } })) } };
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([JSON.stringify(har, null, 2)], { type: "application/json" })), download: `${hostOf(t.url) || "veyra"}.har` }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Chromium tabs: pull console + network logs from the server.
let remoteTimer = 0;
async function pollRemote() {
  clearTimeout(remoteTimer); const t = tab(); if (!openState || !isRemote(t)) return;
  try {
    const r = await dtCall(t, "logs.get", {});
    const s = dtState(t); s.remoteSeen ||= new Set();
    for (const c of r.console || []) { const k = "c" + c.time + c.message.slice(0, 40); if (s.remoteSeen.has(k)) continue; s.remoteSeen.add(k); t.console.push({ time: c.time, level: c.level === "warning" ? "warn" : c.level, message: c.message, kind: "console" }); }
    const byUrl = new Map();
    for (const n of r.network || []) { const k = n.method + n.url; if (n.type === "request") byUrl.set(k, { ...n, start: n.time }); else { const q = byUrl.get(k) || {}; byUrl.delete(k); const id = "r" + n.time + n.url.slice(-30); if (s.remoteSeen.has(id)) continue; s.remoteSeen.add(id); t.network.push({ remote: true, id, method: n.method, url: n.url, status: n.status || 0, ok: n.type === "response" && n.status < 400, error: n.error, duration: q.start ? n.time - q.start : null, startedAt: q.start || n.time, resourceType: n.resourceType, initiator: n.resourceType, responseHeaders: n.headers || {}, requestHeaders: {}, mime: n.headers?.["content-type"] || "" }); } }
    const ev = await dtCall(t, "events.drain", {}).catch(() => []);
    for (const e of ev || []) bridgeEvent(t, e.event, e.data);
    renderConsoleSoon(); netRenderSoon();
  } catch {}
  remoteTimer = setTimeout(pollRemote, 1500);
}

// ============================================================ Application
function buildApplication() {
  $("dt-application").innerHTML = `<nav class="app-nav" id="appNav"><h5>Storage</h5><button data-app="local"><svg><use href="#i-layers"/></svg>Local storage</button><button data-app="session"><svg><use href="#i-layers"/></svg>Session storage</button><button data-app="cookies"><svg><use href="#i-app"/></svg>Cookies</button><button data-app="server-cookies"><svg><use href="#i-shield"/></svg>Veyra cookie jar</button><button data-app="indexeddb"><svg><use href="#i-layers"/></svg>IndexedDB</button><button data-app="caches"><svg><use href="#i-layers"/></svg>Cache storage</button><h5>Page</h5><button data-app="frame"><svg><use href="#i-info"/></svg>Frame &amp; document</button><button data-app="session-info"><svg><use href="#i-timer"/></svg>Veyra session</button></nav>
    <div class="dt-col"><div class="dt-sub" id="appTools"></div><div class="dt-pane" style="flex:1" id="appBody"></div><div class="kv-preview hidden" id="appPreview"></div></div>`;
  $("appNav").onclick = e => { const b = e.target.closest("[data-app]"); if (b) { dtState(tab()).appSel = b.dataset.app; renderApplication(); } };
}
async function renderApplication() {
  const t = tab(); const s = t && dtState(t); if (!$("appBody")) return;
  $("appNav").querySelectorAll("[data-app]").forEach(b => b.classList.toggle("on", b.dataset.app === s?.appSel));
  const body = $("appBody"), tools = $("appTools"), prev = $("appPreview"); prev.classList.add("hidden");
  if (!onPage(t)) { tools.innerHTML = ""; body.innerHTML = emptyMsg(); return; }
  const which = s.appSel;
  try {
    if (which === "local" || which === "session") {
      const list = await call("storage.list", { kind: which });
      tools.innerHTML = `<button class="icon-btn" id="appRefresh" title="Refresh"><svg><use href="#i-reload"/></svg></button><button class="icon-btn" id="appAdd" title="Add item"><svg><use href="#i-plus"/></svg></button><button class="icon-btn" id="appDel" title="Delete selected"><svg><use href="#i-x"/></svg></button><button class="icon-btn" id="appClearAll" title="Clear all"><svg><use href="#i-ban"/></svg></button><input class="dt-input" id="appFilter" placeholder="Filter" value="${esc(s.appFilter || "")}"><span class="muted">${esc(hostOf(t.url))} · ${list.length} items</span>`;
      const f = (s.appFilter || "").toLowerCase();
      body.innerHTML = `<table class="kv-table"><colgroup><col style="width:35%"><col></colgroup><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${list.filter(([k, v]) => !f || (k + v).toLowerCase().includes(f)).map(([k, v]) => `<tr data-k="${esc(k)}" class="${s.appRow === k ? "sel" : ""}"><td contenteditable="plaintext-only" data-f="k">${esc(k)}</td><td contenteditable="plaintext-only" data-f="v">${esc(v)}</td></tr>`).join("")}</tbody></table>`;
      const kind = which; const refresh = () => renderApplication();
      $("appRefresh").onclick = refresh; $("appFilter").oninput = e => { s.appFilter = e.target.value; clearTimeout(s._af); s._af = setTimeout(refresh, 200); };
      $("appAdd").onclick = async () => { const k = prompt("Key"); if (k == null) return; await call("storage.set", { kind, key: k, value: prompt("Value") ?? "" }); s.appRow = k; refresh(); };
      $("appDel").onclick = async () => { if (s.appRow == null) return; await call("storage.remove", { kind, key: s.appRow }); s.appRow = null; refresh(); };
      $("appClearAll").onclick = async () => { if (confirm(`Clear all ${kind}Storage for ${hostOf(t.url)}?`)) { await call("storage.clear", { kind }); refresh(); } };
      body.querySelectorAll("tr[data-k]").forEach(tr => {
        tr.onclick = () => { s.appRow = tr.dataset.k; body.querySelectorAll("tr").forEach(x => x.classList.toggle("sel", x === tr)); const v = list.find(x => x[0] === tr.dataset.k)?.[1] || ""; prev.classList.remove("hidden"); prev.innerHTML = /^[\[{]/.test(v.trim()) ? (() => { try { return jsonTree(JSON.parse(v), 0); } catch { return esc(v); } })() : esc(v); prev.querySelectorAll(".ob-t").forEach(x => x.onclick = () => x.parentElement.classList.toggle("open")); };
        tr.querySelectorAll("td").forEach(td => { td.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); td.blur(); } if (e.key === "Escape") refresh(); }; td.onblur = async () => { const k0 = tr.dataset.k; const k = tr.querySelector('[data-f="k"]').textContent, v = tr.querySelector('[data-f="v"]').textContent; const old = list.find(x => x[0] === k0)?.[1]; if (k === k0 && v === old) return; if (k !== k0) await call("storage.remove", { kind, key: k0 }); await call("storage.set", { kind, key: k, value: v }); s.appRow = k; refresh(); }; });
      });
    } else if (which === "cookies") {
      const list = await call("storage.cookies", {});
      tools.innerHTML = `<button class="icon-btn" id="appRefresh" title="Refresh"><svg><use href="#i-reload"/></svg></button><span class="muted">Cookies visible to the page's JavaScript (document.cookie). HttpOnly cookies live in the Veyra cookie jar.</span>`;
      $("appRefresh").onclick = renderApplication;
      body.innerHTML = `<table class="kv-table"><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>${list.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("") || `<tr><td colspan="2" class="muted">No script-readable cookies.</td></tr>`}</tbody></table>`;
    } else if (which === "server-cookies") {
      const sid = B.state.session?.id;
      tools.innerHTML = `<button class="icon-btn" id="appRefresh" title="Refresh"><svg><use href="#i-reload"/></svg></button><button class="icon-btn" id="appClearAll" title="Delete cookies for this site"><svg><use href="#i-ban"/></svg></button><label class="dt-chk"><input type="checkbox" id="appAllHosts" ${s.allHosts ? "checked" : ""}>All sites in session</label><span class="muted">Server-side jar for session ${esc(sid?.slice(0, 8) || "—")}</span>`;
      $("appRefresh").onclick = renderApplication; $("appAllHosts").onchange = e => { s.allHosts = e.target.checked; renderApplication(); };
      if (!sid) { body.innerHTML = emptyMsg("No active session."); return; }
      const r = await api(`/api/session/${sid}/cookies${s.allHosts ? "" : `?host=${encodeURIComponent(hostOf(t.url))}`}`);
      $("appClearAll").onclick = async () => { await api(`/api/session/${sid}/cookies?domain=${encodeURIComponent(hostOf(t.url).replace(/^www\./, ""))}`, { method: "DELETE" }); await api(`/api/session/${sid}/cookies?domain=${encodeURIComponent(hostOf(t.url))}`, { method: "DELETE" }); renderApplication(); };
      body.innerHTML = `<table class="kv-table"><colgroup><col style="width:18%"><col style="width:28%"><col style="width:16%"><col style="width:8%"><col style="width:6%"><col style="width:16%"><col style="width:8%"></colgroup><thead><tr><th>Name</th><th>Value</th><th>Domain</th><th>Path</th><th>Secure</th><th>Expires</th><th></th></tr></thead><tbody>${r.cookies.map(c => `<tr><td>${esc(c.name)}</td><td title="${esc(c.value)}">${esc(c.value)}</td><td>${esc(c.domain || hostOf(t.url))}</td><td>${esc(c.path)}</td><td>${c.secure ? "✓" : ""}</td><td>${esc(c.expires)}</td><td><button class="dt-chip" data-del="${esc(c.name)}" data-dom="${esc((c.domain || hostOf(t.url)).replace(/^\./, ""))}">Delete</button></td></tr>`).join("") || `<tr><td colspan="7" class="muted">No cookies stored for this site yet.</td></tr>`}</tbody></table>`;
      body.onclick = async e => { const b = e.target.closest("[data-del]"); if (b) { await api(`/api/session/${sid}/cookies?name=${encodeURIComponent(b.dataset.del)}&domain=${encodeURIComponent(b.dataset.dom)}`, { method: "DELETE" }); renderApplication(); } };
    } else if (which === "indexeddb") {
      const list = await call("storage.indexedDB", {}); tools.innerHTML = `<button class="icon-btn" id="appRefresh"><svg><use href="#i-reload"/></svg></button>`; $("appRefresh").onclick = renderApplication;
      body.innerHTML = `<table class="kv-table"><thead><tr><th>Database</th><th>Version</th></tr></thead><tbody>${list.map(d => `<tr><td>${esc(d.name)}</td><td>${esc(d.version)}</td></tr>`).join("") || `<tr><td colspan="2" class="muted">No IndexedDB databases.</td></tr>`}</tbody></table>`;
    } else if (which === "caches") {
      const list = await call("storage.caches", {}); tools.innerHTML = `<button class="icon-btn" id="appRefresh"><svg><use href="#i-reload"/></svg></button>`; $("appRefresh").onclick = renderApplication;
      body.innerHTML = `<table class="kv-table"><thead><tr><th>Cache name</th></tr></thead><tbody>${list.map(n => `<tr><td>${esc(n)}</td></tr>`).join("") || `<tr><td class="muted">No Cache Storage entries.</td></tr>`}</tbody></table>`;
    } else if (which === "frame") {
      const i = await call("page.info", {}); tools.innerHTML = `<button class="icon-btn" id="appRefresh"><svg><use href="#i-reload"/></svg></button>`; $("appRefresh").onclick = renderApplication;
      body.innerHTML = `<details class="hdr-sec" open><summary>Document</summary>${kv({ URL: i.url, Title: i.title, "Ready state": i.readyState, "Content type": i.contentType, Charset: i.charset, Mode: i.compatMode, "DOM nodes": i.nodes })}</details><details class="hdr-sec" open><summary>Viewport</summary>${kv({ Width: i.viewport.width, Height: i.viewport.height, "Device pixel ratio": i.viewport.dpr })}</details><details class="hdr-sec"><summary>Navigator</summary>${kv({ "User agent": i.userAgent, Engine: isRemote(t) ? "Chromium (server)" : "Fast proxy (your browser)" })}</details>`;
    } else if (which === "session-info") {
      tools.innerHTML = ""; const ss = B.state.session;
      body.innerHTML = ss ? `<details class="hdr-sec" open><summary>Veyra session</summary>${kv({ ID: ss.id, "Time left": `${Math.ceil(B.sessionRemaining() / 1000)} s`, "Limit": ss.limitMs ? `${ss.limitMs / 1000} s` : "none", VPN: B.state.vpn.connected ? B.state.vpn.profile?.name || "on" : "off", "Tracker blocking": settings.blockTrackers ? "on" : "off" })}</details>` : emptyMsg("No active session.");
    }
  } catch (e) { body.innerHTML = emptyMsg(e.message); }
}

// ============================================================ Performance
let perfTimer = 0; const perfSamples = [];
function buildPerformance() {
  $("dt-performance").innerHTML = `<div class="dt-sub"><button class="icon-btn" id="perfReload" title="Reload and measure"><svg><use href="#i-reload"/></svg></button><button class="dt-chip" id="perfRefresh">Refresh metrics</button><label class="dt-chk"><input type="checkbox" id="perfLive">Live monitor</label></div><div class="perf-wrap" id="perfBody"></div>`;
  $("perfRefresh").onclick = renderPerformance; $("perfReload").onclick = () => { B.reload(); setTimeout(renderPerformance, 3000); };
  $("perfLive").onchange = e => e.target.checked ? startPerfMonitor() : stopPerfMonitor();
}
function grade(v, good, mid) { return v == null ? "" : v <= good ? "good" : v <= mid ? "mid" : "bad"; }
async function renderPerformance() {
  const t = tab(); const box = $("perfBody"); if (!box) return;
  if (!onPage(t)) { box.innerHTML = emptyMsg(); return; }
  try {
    const [m, info] = await Promise.all([call("perf.metrics", {}), call("page.info", {})]);
    const fcp = m.paints["first-contentful-paint"]; const T = m.timing;
    const cards = [["Time to first byte", T.ttfb, 800, 1800], ["First contentful paint", fcp, 1800, 3000], ["Largest contentful paint", m.lcp, 2500, 4000], ["DOM content loaded", T.domContentLoaded, 2000, 4000], ["Load event", T.load, 3000, 6000]];
    const phases = [["Redirect", T.redirect, "#8a93a3"], ["DNS", T.dns, "#7fb2c9"], ["Connect", T.connect, "#e59a4f"], ["Waiting (TTFB)", T.ttfb, "#4fbf8f"], ["Download", T.download, "#4f8ff7"], ["DOM interactive", T.domInteractive, "#9b7df2"], ["Load", T.load, "#e6c84f"]];
    const maxP = Math.max(1, ...phases.map(x => x[1] || 0));
    const types = Object.entries(m.resources.byType || {}).sort((a, b) => b[1].bytes - a[1].bytes); const maxB = Math.max(1, ...types.map(x => x[1].bytes));
    box.innerHTML = `<div class="perf-h">Page load · ${esc(hostOf(t.url))}</div><div class="perf-grid">${cards.map(([l, v, g, md]) => `<div class="perf-card"><span>${l}</span><b class="${grade(v, g, md)}">${v ? fmtMs(v) : "—"}</b></div>`).join("")}<div class="perf-card"><span>DOM nodes</span><b class="${grade(info.nodes, 1500, 3000)}">${info.nodes.toLocaleString()}</b></div><div class="perf-card"><span>Resources</span><b>${m.resources.count}</b></div>${m.memory ? `<div class="perf-card"><span>JS heap</span><b>${fmtBytes(m.memory.used)}</b></div>` : ""}</div>
      <div class="perf-h">Navigation timing</div><div class="perf-bars">${phases.map(([l, v, c]) => `<div class="perf-bar"><span>${l}</span><div class="t"><i style="width:${((v || 0) / maxP * 100).toFixed(1)}%;background:${c}"></i></div><span>${v ? fmtMs(v) : "0 ms"}</span></div>`).join("")}</div>
      <div class="perf-h">Resources by type</div><div class="perf-bars">${types.map(([k, v]) => `<div class="perf-bar"><span>${esc(k)}</span><div class="t"><i style="width:${(v.bytes / maxB * 100).toFixed(1)}%;background:var(--accent)"></i></div><span>${v.count} · ${fmtBytes(v.bytes)}</span></div>`).join("") || `<p class="muted">No resource timing entries.</p>`}</div>
      <div class="perf-h">Live monitor</div><canvas class="perf-canvas" id="perfCanvas"></canvas><p class="muted" style="font-size:11.5px">Samples DOM node count${m.memory ? " and JS heap" : ""} every second while "Live monitor" is on.</p>`;
    drawPerf();
  } catch (e) { box.innerHTML = emptyMsg(e.message); }
}
function startPerfMonitor() { stopPerfMonitor(); perfSamples.length = 0; const tick = async () => { const t = tab(); if (!openState || !onPage(t)) return; try { const [i, m] = await Promise.all([call("page.info", {}, 3000), call("perf.metrics", {}, 3000)]); perfSamples.push({ t: Date.now(), nodes: i.nodes, heap: m.memory?.used || 0 }); if (perfSamples.length > 120) perfSamples.shift(); drawPerf(); } catch {} perfTimer = setTimeout(tick, 1000); }; tick(); }
function stopPerfMonitor() { clearTimeout(perfTimer); perfTimer = 0; const c = $("perfLive"); if (c) c.checked = false; }
function drawPerf() {
  const c = $("perfCanvas"); if (!c) return; const dpr = devicePixelRatio || 1; const w = c.clientWidth, h = c.clientHeight; c.width = w * dpr; c.height = h * dpr; const g = c.getContext("2d"); g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement); g.clearRect(0, 0, w, h);
  if (perfSamples.length < 2) { g.fillStyle = css.getPropertyValue("--muted"); g.font = "12px sans-serif"; g.fillText("Turn on Live monitor to chart DOM nodes and memory.", 12, h / 2); return; }
  const line = (key, color) => { const max = Math.max(1, ...perfSamples.map(s => s[key])); g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath(); perfSamples.forEach((s, i) => { const x = i / (perfSamples.length - 1) * (w - 8) + 4, y = h - 8 - (s[key] / max) * (h - 20); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); return max; };
  const mn = line("nodes", css.getPropertyValue("--accent").trim() || "#4f8ff7"); const last = perfSamples[perfSamples.length - 1];
  if (last.heap) line("heap", "#4fbf8f");
  g.fillStyle = css.getPropertyValue("--text-2"); g.font = "11px sans-serif"; g.fillText(`DOM nodes ${last.nodes.toLocaleString()} (max ${mn.toLocaleString()})${last.heap ? ` · heap ${fmtBytes(last.heap)}` : ""}`, 8, 14);
}

// ============================================================ device toolbar
const DEVICES = [["Responsive", 0, 0], ["iPhone SE", 375, 667], ["iPhone 14", 390, 844], ["Pixel 7", 412, 915], ["Galaxy S20", 360, 800], ["iPad Mini", 768, 1024], ["iPad Air", 820, 1180], ["Laptop", 1280, 800], ["Desktop HD", 1920, 1080]];
let device = null;
function toggleDevice() {
  const wrap = $("frameWrap"); const pageView = $("view-page");
  if (device) { device = null; wrap.classList.remove("device"); $("deviceBar")?.remove(); pageView.classList.remove("with-device"); qsaFrames().forEach(f => { f.style.width = ""; f.style.height = ""; }); $("dtDevice").classList.remove("on"); return; }
  device = { w: 390, h: 844, name: "iPhone 14" }; $("dtDevice").classList.add("on");
  const bar = document.createElement("div"); bar.className = "device-bar"; bar.id = "deviceBar";
  bar.innerHTML = `<select class="dt-input" id="devPreset">${DEVICES.map(([n]) => `<option ${n === device.name ? "selected" : ""}>${n}</option>`).join("")}</select><input class="dt-input" id="devW" value="${device.w}"> × <input class="dt-input" id="devH" value="${device.h}"><button class="dt-chip" id="devRotate" title="Rotate">⟳ Rotate</button><span class="muted" id="devScale"></span>`;
  pageView.insertBefore(bar, pageView.firstChild); pageView.classList.add("with-device"); wrap.classList.add("device");
  $("devPreset").onchange = e => { const d = DEVICES.find(x => x[0] === e.target.value); device.name = d[0]; if (d[1]) { device.w = d[1]; device.h = d[2]; } else { const r = wrap.getBoundingClientRect(); device.w = Math.round(r.width - 32); device.h = Math.round(r.height - 32); } applyDevice(); };
  $("devW").onchange = e => { device.w = Math.max(200, Number(e.target.value) || 390); device.name = "Responsive"; applyDevice(); };
  $("devH").onchange = e => { device.h = Math.max(200, Number(e.target.value) || 844); device.name = "Responsive"; applyDevice(); };
  $("devRotate").onclick = () => { [device.w, device.h] = [device.h, device.w]; applyDevice(); };
  applyDevice();
}
const qsaFrames = () => [...document.querySelectorAll("#frameWrap .tab-frame")];
function applyDevice() {
  if (!device) return; $("devW").value = device.w; $("devH").value = device.h; $("devPreset").value = DEVICES.some(d => d[0] === device.name) ? device.name : "Responsive";
  qsaFrames().forEach(f => { f.style.width = device.w + "px"; f.style.height = device.h + "px"; });
  const r = $("frameWrap").getBoundingClientRect(); $("devScale").textContent = device.w > r.width || device.h > r.height ? "Scroll to see the whole viewport" : "";
}

// ============================================================ bridge events + hooks
function bridgeEvent(t, event, data) {
  if (event === "dom.select") { onPicked(t, data); return; }
  if (event === "dom.picking") { if (t === tab()) { picking = !!data.enabled; $("dtPick")?.classList.toggle("on", picking); } return; }
  if (event === "dom.pickCancelled") { if (t === tab()) { picking = false; $("dtPick")?.classList.remove("on"); } return; }
  if (event === "dom.hover") return;
  if (event === "dom.changed") { const s = dtState(t); if (!s.docLoaded || t !== tab() || !openState || !p("elements")) return; clearTimeout(s._ch); s._ch = setTimeout(async () => { const ids = data.ids.filter(id => s.nodes.has(id) && s.open.has(id)).slice(0, 25); for (const id of ids) await refreshNode(id); if (ids.length) renderTree(); if (data.ids.includes(s.sel)) renderSide(); }, 200); return; }
  if (event === "network.resource") { if (["fetch", "xmlhttprequest"].includes(data.initiatorType)) return; const s = dtState(t); if (s.netPaused) return; s.resEntries.push(resRow(data, s)); if (s.resEntries.length > 1500) s.resEntries.splice(0, 300); if (t === tab()) netRenderSoon(); }
}
onBridgeEvent(bridgeEvent);

export function initDevtools(b) {
  B = b;
  // Make the page view a column when the device toolbar is showing.
  const st = document.createElement("style"); st.textContent = `#view-page.with-device.active{display:flex;flex-direction:column}#view-page.with-device .page-split{flex:1;min-height:0;height:auto}#dtPick.on,#dtDevice.on{color:var(--accent);background:var(--accent-soft)}.remote-picking{cursor:crosshair}`; document.head.appendChild(st);
  hooks.dt = {
    toggle, open, close, inspect,
    cancelPicking: () => { if (!picking) return false; setPicking(false); return true; },
    onTabChanged: t => { if (!openState) return; setPicking(false); if (device) applyDevice(); refreshPanel(); },
    onTabClosed: t => { if (t._dt) t._dt = null; },
    onNavigate: t => { const s = t._dt; if (s) { Object.assign(s, { nodes: new Map(), open: new Set(), sel: null, rootIds: [], docLoaded: false, netEnabled: false, srcList: null, srcFiles: {}, srcOpen: [], srcActive: null, remoteSeen: new Set(), forced: new Set(), addedCss: "", navStart: 0 }); if (!settings.preserveLog) { s.resEntries = []; s.netSel = null; } } if (t === tab() && openState) refreshPanel(); },
    onPageLoaded: t => { if (t === tab() && openState) { if (device) applyDevice(); refreshPanel(); if (isRemote(t)) pollRemote(); } },
    onConsole: (t, entry) => { if (t === tab()) renderConsoleSoon(); },
    onNetwork: (t, d) => { const s = dtState(t); if (s.netPaused) { t.network.pop(); return; } if (t === tab()) netRenderSoon(); },
    pickingRemote: (e, pos) => { if (!picking) return false; const t = tab(); call("dom.nodeAt", { x: pos.x, y: pos.y }).then(r => { setPicking(false); if (r) onPicked(t, r); }).catch(() => setPicking(false)); return true; },
    hoverRemote: debounceRaf(pos => { if (picking) call("dom.nodeAt", { x: pos.x, y: pos.y }).catch(() => {}); })
  };
}
