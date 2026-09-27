// Veyra browser shell: tabs, navigation, sessions, page runtime messages.
import {
  API, API_ORIGIN, APP_BASE, $, qsa, esc, hostOf, pathOf, displayUrl, uid, fmtBytes, fmtClock, timeAgo, letterIcon,
  settings, saveSettings, load, save, api, proxyUrl, addLog, logs, netLog, toast, hooks, auth, isAdmin,
  engineUrl, engineName, openFloating, closeFloating, ctxMenu, rawFetch, copyText, VERSION
} from "./core.js";
import { dtCall, frameFor, isRemote, handleBridgeMessage, rejectTab } from "./bridge.js";
import { initUI } from "./ui.js";
import { initDevtools } from "./devtools.js";

// ---------------------------------------------------------------- state
const oldBookmarks = load("veyra-bookmarks", []);
export const state = {
  tabs: [], activeId: null, seq: 0, closed: [],
  bookmarks: (Array.isArray(oldBookmarks) ? oldBookmarks : []).map(b => typeof b === "string" ? { id: uid(), url: b, title: hostOf(b) || b, time: Date.now() } : b).filter(b => b && b.url),
  history: load("veyra-history", []).filter(x => x && typeof x === "object"),
  downloads: load("veyra-downloads", []).filter(x => x && typeof x === "object"),
  downloadControllers: new Map(),
  session: null, sessionTimer: null, sessionWarned: {}, sessionEnding: false, serverLimitMs: 120000, capabilityCache: new Map(),
  vpn: { status: null, connected: false, profile: null }
};
const INTERNAL = {
  newtab: { title: "New tab", icon: "i-home", path: "/browse" },
  search: { title: "Veyra Search", icon: "i-search", path: "/search" },
  calculator: { title: "Calculator", icon: "i-calc", path: "/calculator" },
  downloads: { title: "Downloads", icon: "i-download", path: "/downloads" },
  history: { title: "History", icon: "i-history", path: "/history" },
  extensions: { title: "Extensions", icon: "i-puzzle", path: "/extensions" },
  settings: { title: "Settings", icon: "i-settings", path: "/settings" },
  vpn: { title: "Veyra VPN", icon: "i-vpn", path: "/vpn" },
  resources: { title: "Page resources", icon: "i-file", path: "/resources" },
  links: { title: "All links", icon: "i-link", path: "/links" },
  console: { title: "Veyra console", icon: "i-terminal", path: "/console", admin: true },
  dev: { title: "Veyra dev", icon: "i-code", path: "/dev", admin: true }
};
const saveHistory = () => save("veyra-history", state.history.slice(0, settings.historyMax || 1000));
const saveDownloads = () => save("veyra-downloads", state.downloads.slice(0, settings.downloadsMax || 200));
const saveBookmarks = () => { save("veyra-bookmarks", state.bookmarks); hooks.scheduleSync?.(); };

// ---------------------------------------------------------------- tabs
function makeTab(extra = {}) {
  return {
    id: "t" + (++state.seq), title: "New tab", favicon: "", url: "", view: "newtab", section: "", history: [], histIndex: -1,
    jobId: null, done: true, poll: null, loading: false, browserMode: "FAST_PROXY", browserSessionId: "", browserPoll: null, browserStatus: "",
    resources: [], links: [], selectedResource: -1, console: [], network: [], zoom: settings.zoomDefault || 1, pinned: false,
    searchQuery: "", searchData: null, calcExpression: "", sourceTabId: null, remoteLogIds: new Set(), openedAt: Date.now(), ...extra
  };
}
export const activeTab = () => state.tabs.find(t => t.id === state.activeId) || null;
const tabById = id => state.tabs.find(t => t.id === id) || null;

function tabIconHtml(t) {
  if (t.loading) return `<span class="spin"></span>`;
  if (t.view !== "page") return `<svg><use href="#${INTERNAL[t.view]?.icon || "i-globe"}"/></svg>`;
  if (t.favicon && state.session) return `<img src="${esc(proxyUrl(t.favicon, "resource", state.session.id))}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('b'),{textContent:'${esc(letterIcon(t.url).letter)}'}))">`;
  const li = letterIcon(t.url); return `<b style="display:grid;place-items:center;width:16px;height:16px;border-radius:4px;background:${li.color};color:#fff;font-size:10px">${esc(li.letter)}</b>`;
}
export function renderTabs() {
  const list = $("tabsList"); if (!list) return;
  const ordered = [...state.tabs.filter(t => t.pinned), ...state.tabs.filter(t => !t.pinned)];
  if (ordered.some((t, i) => t !== state.tabs[i])) state.tabs = ordered;
  list.innerHTML = state.tabs.map(t => `<div class="tab ${t.id === state.activeId ? "active" : ""} ${t.pinned ? "pinned" : ""}" role="tab" aria-selected="${t.id === state.activeId}" data-tab="${t.id}" draggable="true" title="${esc(t.title)}${t.url ? "\n" + esc(t.url) : ""}">
    <span class="tab-fav">${tabIconHtml(t)}</span><span class="tab-title">${esc(t.title || "New tab")}</span>${t.browserMode === "BROWSER_ENGINE" && t.view === "page" ? `<span class="tab-badge" title="Real Chromium tab">CR</span>` : ""}
    <button class="tab-close" data-close="${t.id}" title="Close tab" aria-label="Close tab"><svg><use href="#i-x"/></svg></button></div>`).join("");
  list.querySelectorAll(".tab").forEach(el => {
    el.onmousedown = e => { if (e.button === 1) { e.preventDefault(); closeTab(el.dataset.tab); } };
    el.onclick = e => { if (!e.target.closest("[data-close]")) switchTab(el.dataset.tab); };
    el.oncontextmenu = e => { e.preventDefault(); tabContextMenu(el.dataset.tab, e.clientX, e.clientY); };
    el.ondragstart = e => { e.dataTransfer.setData("text/veyra-tab", el.dataset.tab); el.classList.add("dragging"); };
    el.ondragend = () => el.classList.remove("dragging");
    el.ondragover = e => e.preventDefault();
    el.ondrop = e => { e.preventDefault(); const from = e.dataTransfer.getData("text/veyra-tab"); moveTab(from, el.dataset.tab); };
  });
  list.querySelectorAll("[data-close]").forEach(b => b.onclick = e => { e.stopPropagation(); closeTab(b.dataset.close); });
  list.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  document.title = (activeTab()?.title && activeTab().view !== "newtab" ? activeTab().title + " · " : "") + "Veyra";
}
function moveTab(fromId, toId) { if (!fromId || fromId === toId) return; const a = state.tabs.findIndex(t => t.id === fromId), b = state.tabs.findIndex(t => t.id === toId); if (a < 0 || b < 0) return; const [t] = state.tabs.splice(a, 1); state.tabs.splice(b, 0, t); renderTabs(); }
function tabContextMenu(id, x, y) {
  const t = tabById(id); if (!t) return; const i = state.tabs.indexOf(t);
  ctxMenu(x, y, [
    { label: "New tab to the right", action: () => newTab({ index: i + 1 }) },
    "-",
    { label: "Reload", kbd: "Ctrl+R", action: () => { switchTab(id); reload(); } },
    { label: "Duplicate", action: () => duplicateTab(t) },
    { label: t.pinned ? "Unpin" : "Pin", action: () => { t.pinned = !t.pinned; renderTabs(); } },
    { label: "Copy address", disabled: !t.url, action: () => copyText(t.url) },
    "-",
    { label: "Close", kbd: "Ctrl+W", action: () => closeTab(id) },
    { label: "Close other tabs", disabled: state.tabs.length < 2, action: () => state.tabs.filter(x => x.id !== id && !x.pinned).forEach(x => closeTab(x.id, { silent: true })) },
    { label: "Close tabs to the right", disabled: i === state.tabs.length - 1, action: () => state.tabs.slice(i + 1).forEach(x => closeTab(x.id, { silent: true })) },
    { label: "Reopen closed tab", kbd: "Ctrl+Shift+T", disabled: !state.closed.length, action: reopenClosedTab }
  ]);
}
export function switchTab(id) {
  const t = tabById(id); if (!t) return;
  state.activeId = id; renderTabs(); renderActive({ push: true, replace: true });
}
export function newTab({ url = "", view = "", index = -1, background = false, section = "" } = {}) {
  const t = makeTab(); if (index >= 0) state.tabs.splice(index, 0, t); else state.tabs.push(t);
  if (!background) state.activeId = t.id;
  renderTabs();
  if (url) go(url, { tab: t });
  else if (view) openInternal(view, { tab: t, section });
  else if (settings.homepage) go(settings.homepage, { tab: t });
  else { t.view = "newtab"; if (!background) renderActive({ push: true }); }
  if (!background) setTimeout(() => { if (activeTab() === t && t.view === "newtab") $("ntpInput")?.focus(); }, 30);
  return t;
}
function duplicateTab(t) { const i = state.tabs.indexOf(t); if (t.view === "page" && t.url) newTab({ url: t.url, index: i + 1 }); else newTab({ view: t.view, index: i + 1, section: t.section }); }
function teardownTab(t) {
  if (t.poll) clearInterval(t.poll); t.poll = null; clearTimeout(t.browserPoll);
  if (t.browserSessionId) stopBrowserSession(t).catch(() => {});
  if (t.jobId && !t.done) stopJob(t.jobId).catch(() => {});
  rejectTab(t.id); frameFor(t)?.remove();
}
export function closeTab(id, { silent = false } = {}) {
  const idx = state.tabs.findIndex(t => t.id === id); if (idx < 0) return;
  const t = state.tabs[idx];
  if (!silent && settings.confirmCloseWithCrawl && t.jobId && !t.done && !confirm("This tab is still being indexed. Close it anyway?")) return;
  if (t.view === "page" && t.url) { state.closed.push({ url: t.url, title: t.title, index: idx }); if (state.closed.length > 25) state.closed.shift(); }
  else if (t.view !== "newtab") state.closed.push({ view: t.view, title: t.title, index: idx, section: t.section });
  teardownTab(t); hooks.dt?.onTabClosed(t);
  state.tabs.splice(idx, 1);
  if (!state.tabs.length) { const nt = makeTab(); state.tabs.push(nt); state.activeId = nt.id; }
  else if (state.activeId === id) state.activeId = state.tabs[Math.min(idx, state.tabs.length - 1)].id;
  renderTabs(); renderActive({ push: true, replace: true });
}
export function reopenClosedTab() { const c = state.closed.pop(); if (!c) return toast("No recently closed tabs"); if (c.url) newTab({ url: c.url, index: Math.min(c.index, state.tabs.length) }); else newTab({ view: c.view, section: c.section, index: Math.min(c.index, state.tabs.length) }); }
export function cycleTab(delta) { if (state.tabs.length < 2) return; const i = state.tabs.findIndex(t => t.id === state.activeId); switchTab(state.tabs[(i + delta + state.tabs.length) % state.tabs.length].id); }
export function selectTabIndex(n) { const t = n === 9 ? state.tabs[state.tabs.length - 1] : state.tabs[n - 1]; if (t) switchTab(t.id); }

// ---------------------------------------------------------------- routing
function routeUrl(path, query = "") { return `${APP_BASE}${path}${query}`; }
function currentRoute() { const p = location.pathname.slice(APP_BASE.length) || "/"; return p.replace(/\/+$/, "") || "/"; }
function routeForTab(t) {
  if (!t) return ["/browse", ""];
  if (t.view === "page") return ["/browse", t.url ? `?url=${encodeURIComponent(t.url)}` : ""];
  if (t.view === "search") return ["/search", t.searchQuery ? `?q=${encodeURIComponent(t.searchQuery)}` : ""];
  if (t.view === "calculator") return ["/calculator", t.calcExpression ? `?q=${encodeURIComponent(t.calcExpression)}` : ""];
  if (t.view === "settings") return [t.section ? `/settings/${t.section}` : "/settings", ""];
  if (t.view === "console") return ["/browse", "#console"];
  return [INTERNAL[t.view]?.path || "/browse", ""];
}
function syncRoute({ replace = false } = {}) {
  const [p, q] = routeForTab(activeTab()); const next = routeUrl(p, q);
  if (next === location.pathname + location.search + location.hash) return;
  try { history[replace ? "replaceState" : "pushState"]({ veyra: true }, "", next); } catch {}
}
export function showLanding(on) {
  $("landing").classList.toggle("hidden", !on); $("app").classList.toggle("hidden", on);
  document.body.style.overflow = on ? "" : "hidden";
  if (on) { closeFloating(); hooks.renderLanding?.(); document.title = "Veyra — browse through a clean session"; }
}
export function goRoute(path, { push = true } = {}) {
  const url = new URL(path, location.origin + APP_BASE + "/");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (push) try { history.pushState({ veyra: true }, "", APP_BASE + p + url.search + url.hash); } catch {}
  applyRoute();
}
function applyRoute() {
  const route = currentRoute(); const params = new URLSearchParams(location.search);
  if (route === "/" && location.hash !== "#console") { showLanding(true); return; }
  showLanding(false);
  if (!state.tabs.length) { const t = makeTab(); state.tabs.push(t); state.activeId = t.id; renderTabs(); }
  const t = activeTab();
  const reuse = x => x.view === "newtab" || x.view === "page" && !x.url;
  if (location.hash === "#console") return openInternal("console", { push: false });
  const [, first, second] = route.split("/");
  const view = { browse: "newtab", search: "search", calculator: "calculator", downloads: "downloads", history: "history", extensions: "extensions", settings: "settings", vpn: "vpn", dev: "dev", console: "console", resources: "resources", links: "links" }[first];
  if (!view) { goRoute("/browse", { push: false }); return; }
  if (view === "newtab") {
    const u = params.get("url"); const q = params.get("q");
    if (u) { if (!(t.view === "page" && t.url === u)) go(u, { tab: reuse(t) ? t : null, push: false }); else renderActive({ push: false }); }
    else if (q) go(q, { tab: reuse(t) ? t : null, push: false });
    else renderActive({ push: false });
    return;
  }
  if (view === "search") { showSearch(params.get("q") || "", { push: false }); return; }
  if (view === "calculator") { openInternal("calculator", { push: false, calc: params.get("q") || "" }); return; }
  openInternal(view, { push: false, section: second || "" });
}
window.addEventListener("popstate", () => applyRoute());

// ---------------------------------------------------------------- views
export function openInternal(view, { tab = null, push = true, section = "", calc = "" } = {}) {
  if (INTERNAL[view]?.admin && !isAdmin()) {
    toast("That page is only available to Veyra administrators", { kind: "warn" });
    if (currentRoute() === "/dev" || location.hash === "#console") { try { history.replaceState({}, "", routeUrl("/browse")); } catch {} }
    renderActive({ push: false }); return;
  }
  let t = tab || activeTab();
  // Like chrome://settings: reuse the tab if it's already on that page, otherwise
  // open a new tab when the current one shows a website.
  const existing = state.tabs.find(x => x.view === view && !["resources", "links", "calculator"].includes(view));
  if (!tab && existing && existing !== t) { t = existing; state.activeId = t.id; }
  else if (!tab && t && t.view === "page" && t.url) {
    const src = t; t = makeTab({ sourceTabId: src.id }); state.tabs.splice(state.tabs.indexOf(src) + 1, 0, t); state.activeId = t.id;
  }
  if (["resources", "links"].includes(view) && !t.sourceTabId) { const src = state.tabs.find(x => x.view === "page" && x.url && x !== t); t.sourceTabId = src?.id || null; }
  if (t.view === "page") teardownTab(t);
  t.view = view; t.section = section || (view === "settings" ? t.section : ""); t.title = INTERNAL[view].title; t.url = ""; t.favicon = ""; t.loading = false; t.browserMode = "FAST_PROXY"; t.browserSessionId = "";
  if (view === "calculator" && calc) t.calcExpression = calc;
  pushTabHistory(t, `veyra:${view}${section ? "/" + section : ""}`);
  renderTabs(); renderActive({ push });
}
function pushTabHistory(t, entry) { if (t.history[t.histIndex] === entry) return; t.history = t.history.slice(0, t.histIndex + 1); t.history.push(entry); t.histIndex = t.history.length - 1; }

export function renderActive({ push = true, replace = false } = {}) {
  const t = activeTab(); if (!t) return;
  qsa(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + t.view));
  if (t.view === "page") showFrameForTab(t); else setLoading(false);
  updateAddress(); updateNavButtons(); updateIdentity();
  const r = {
    newtab: () => hooks.renderNewTab?.(), search: () => renderSearch(), calculator: () => renderCalculator(),
    downloads: renderDownloads, history: renderHistory, extensions: () => hooks.renderExtensions?.(), settings: () => hooks.renderSettings?.(t.section),
    vpn: renderVpnPanel, resources: renderResources, links: renderLinks, console: renderConsole, dev: renderDev
  }[t.view]; r?.();
  if (t.view !== "dev") clearInterval(state.devTimer);
  if (!$("findBar").classList.contains("hidden") && t.view !== "page") closeFind();
  $("readerView").classList.toggle("hidden", !(t.view === "page" && t.readerOpen));
  hooks.renderSidePanel?.(t);
  hooks.dt?.onTabChanged(t);
  if (push) syncRoute({ replace });
}
function updateAddress() {
  const t = activeTab(); const input = $("address"); if (!t || document.activeElement === input) return;
  input.value = t.view === "page" ? (t.url || "") : t.view === "search" ? t.searchQuery : t.view === "newtab" ? "" : `veyra://${t.view}${t.section ? "/" + t.section : ""}`;
}
function updateNavButtons() {
  const t = activeTab(); if (!t) return;
  $("backBtn").disabled = !(t.histIndex > 0 || (isRemote(t)));
  $("forwardBtn").disabled = !(t.histIndex < t.history.length - 1 || isRemote(t));
}
export function updateIdentity() {
  const t = activeTab(); const chip = $("siteChip"), text = $("siteChipText"); if (!t) return;
  chip.className = "site-chip";
  let icon = "i-search", label = "";
  if (t.view === "page" && t.url) {
    const secure = /^https:/.test(t.url);
    icon = state.vpn.connected ? "i-vpn" : secure ? "i-lock" : "i-info";
    chip.classList.add(state.vpn.connected ? "vpn" : secure ? "secure" : "warn");
    label = state.vpn.connected ? "VPN" : t.browserMode === "BROWSER_ENGINE" ? "Chromium" : "";
  } else if (t.view !== "newtab") { icon = "i-shield"; label = "Veyra"; chip.classList.add("secure"); }
  chip.innerHTML = `<svg><use href="#${icon}"/></svg><span id="siteChipText">${esc(label)}</span>`;
  const bm = t.url && state.bookmarks.some(b => b.url === t.url);
  $("starBtn").classList.toggle("on", !!bm); $("starBtn").disabled = !(t.view === "page" && t.url);
  $("zoomChip").classList.toggle("hidden", !(t.view === "page" && t.zoom !== 1)); $("zoomChip").textContent = Math.round(t.zoom * 100) + "%";
  $("statusLeft").textContent = t.view === "page" ? (t.loading ? `Loading ${hostOf(t.url)}…` : t.url ? `${t.browserMode === "BROWSER_ENGINE" ? "Chromium" : "Fast proxy"} · ${hostOf(t.url)}` : "Ready") : INTERNAL[t.view]?.title || "Ready";
  $("statusRight").textContent = `${state.vpn.connected ? `VPN · ${state.vpn.profile?.name || "connected"} · ` : ""}${auth.user ? auth.user.email : "Guest"} · v${VERSION}`;
  hooks.renderBookmarksBar?.();
}

export function setLoading(on, pct = 0, message = "Loading…") {
  const t = activeTab(); const line = $("loadProgress"), box = $("frameLoader"), btn = $("reloadBtn");
  if (t) t.loading = !!on && t.view === "page";
  line.style.width = on ? `${Math.max(6, Math.min(100, pct))}%` : "0%";
  box.classList.toggle("hidden", !on); $("frameLoaderText").textContent = message;
  btn.innerHTML = `<svg><use href="#${on ? "i-stop" : "i-reload"}"/></svg>`; btn.title = on ? "Stop loading" : "Reload";
  btn.dataset.loading = on ? "1" : "";
  renderTabsSoon();
}
let tabsRaf = 0; function renderTabsSoon() { if (tabsRaf) return; tabsRaf = requestAnimationFrame(() => { tabsRaf = 0; renderTabs(); }); }

// ---------------------------------------------------------------- frames
function getOrCreateFrame(t) {
  let f = frameFor(t); if (f) return f;
  f = document.createElement("iframe"); f.id = "frame-" + t.id; f.name = "veyraFrame_" + t.id; f.className = "tab-frame"; f.title = "Page content";
  f.setAttribute("allow", "fullscreen; autoplay; clipboard-read; clipboard-write; picture-in-picture; encrypted-media");
  f.addEventListener("load", () => onFrameLoad(t));
  $("frameWrap").insertBefore(f, $("frameLoader"));
  return f;
}
function onFrameLoad(t) {
  if (!state.tabs.includes(t) || t.view !== "page") return;
  if (activeTab() === t) setLoading(false); else t.loading = false;
  renderTabsSoon(); updateIdentity();
  // Re-apply zoom and extensions each time the document changes.
  setTimeout(() => { if (t.zoom !== 1) dtCall(t, "ext.zoom", { zoom: t.zoom }, 4000).catch(() => {}); hooks.applyExtensionsToTab?.(t); hooks.dt?.onPageLoaded(t); pushKeybindings(t); }, 120);
}
function ensureRemoteSurface() {
  let v = $("remoteSurface"); if (v) return v;
  v = document.createElement("div"); v.id = "remoteSurface"; v.className = "browser-surface"; v.tabIndex = 0;
  v.innerHTML = `<img id="remoteImg" alt="Remote Chromium page" style="width:100%;height:100%;object-fit:contain;display:block;user-select:none" draggable="false">`;
  $("frameWrap").insertBefore(v, $("frameLoader"));
  const img = v.querySelector("img");
  const pos = e => { const r = img.getBoundingClientRect(); return { x: Math.max(0, Math.min(1365, (e.clientX - r.left) * 1365 / r.width)), y: Math.max(0, Math.min(820, (e.clientY - r.top) * 820 / r.height)) }; };
  const send = async (payload) => { const t = activeTab(); if (!t?.browserSessionId) return; try { await api(`/api/browser/session/${encodeURIComponent(t.browserSessionId)}/input`, { json: payload }); refreshRemote(t, true); } catch (e) { addLog("warn", `Chromium input failed: ${e.message}`); } };
  img.addEventListener("click", e => { v.focus(); if (hooks.dt?.pickingRemote(e, pos(e))) return; send({ type: "click", ...pos(e), button: "left" }); });
  img.addEventListener("dblclick", e => send({ type: "dblclick", ...pos(e) }));
  img.addEventListener("contextmenu", e => { e.preventDefault(); send({ type: "click", ...pos(e), button: "right" }); });
  img.addEventListener("wheel", e => { e.preventDefault(); send({ type: "wheel", ...pos(e), deltaY: e.deltaY, deltaX: e.deltaX }); }, { passive: false });
  img.addEventListener("mousemove", e => hooks.dt?.hoverRemote(pos(e)));
  v.addEventListener("keydown", e => { if (e.ctrlKey || e.metaKey || e.altKey || e.key === "F12") return; e.preventDefault(); send({ type: "key", key: e.key }); });
  return v;
}
function showFrameForTab(t) {
  const remote = isRemote(t);
  const f = remote ? null : (t.url || frameFor(t) ? getOrCreateFrame(t) : null);
  qsa("#frameWrap .tab-frame").forEach(el => el.classList.toggle("frame-active", el === f));
  const surf = ensureRemoteSurface(); surf.classList.toggle("frame-active", remote);
  if (remote) refreshRemote(t, true);
  setLoading(!!t.loading, 50, `Loading ${hostOf(t.url)}…`);
}

// ---------------------------------------------------------------- sessions (2-minute limit)
export async function ensureSession() {
  const s = state.session;
  if (s && s.expiresAt - Date.now() > 800) return s;
  if (s) await endSession("timer");
  const body = await api("/api/session", { json: {} });
  const limit = Number(body.timeLimitMs) || 0;
  state.serverLimitMs = limit;
  state.session = { id: body.sessionId, startedAt: Date.now(), limitMs: limit, expiresAt: limit ? Date.now() + Number(body.remainingMs ?? limit) : Infinity };
  state.sessionWarned = {};
  addLog("info", `Session ${body.sessionId.slice(0, 8)} started${limit ? ` (${fmtClock(limit)} limit)` : ""}.`);
  startSessionTimer();
  if (settings.blockTrackers) api(`/api/session/${state.session.id}/prefs`, { json: { blockTrackers: true } }).catch(() => {});
  if (settings.vpnAutoProfile) connectVpn(settings.vpnAutoProfile, { quiet: true }).catch(() => {});
  hooks.onSessionChanged?.();
  return state.session;
}
function startSessionTimer() { clearInterval(state.sessionTimer); state.sessionTimer = setInterval(tickSession, 250); tickSession(); }
export function sessionRemaining() { const s = state.session; return s ? Math.max(0, s.expiresAt - Date.now()) : 0; }
function tickSession() {
  const pill = $("sessionPill"), txt = $("sessionTime"); const s = state.session;
  if (!s) { pill.className = "session-pill idle"; txt.textContent = state.serverLimitMs ? fmtClock(state.serverLimitMs) : "—"; pill.title = `No session yet. A ${fmtClock(state.serverLimitMs)} session starts when you open a website.`; return; }
  if (s.expiresAt === Infinity) { pill.className = "session-pill live"; txt.textContent = "Live"; pill.title = "Session has no time limit"; return; }
  const left = s.expiresAt - Date.now();
  txt.textContent = fmtClock(left);
  pill.className = "session-pill " + (left <= 10000 ? "crit" : left <= 30000 ? "warn" : "live");
  pill.title = `Session ends in ${fmtClock(left)}. Everything in it is deleted when the timer hits 0:00.`;
  if (settings.sessionWarnings) {
    if (left <= 30000 && !state.sessionWarned[30]) { state.sessionWarned[30] = 1; toast("30 seconds left in this session", { kind: "warn" }); }
    if (left <= 10000 && !state.sessionWarned[10]) { state.sessionWarned[10] = 1; toast("10 seconds left. The session will be deleted", { kind: "err" }); }
  }
  hooks.onSessionTick?.(left, s);
  if (left <= 0) endSession("timer");
}
export async function endSession(reason = "timer") {
  const s = state.session; if (!s || state.sessionEnding) return;
  state.sessionEnding = true;
  try {
    state.session = null; clearInterval(state.sessionTimer);
    // Close every website tab: frames, crawl jobs, Chromium sessions.
    const pageTabs = state.tabs.filter(t => t.view === "page");
    for (const t of pageTabs) { teardownTab(t); hooks.dt?.onTabClosed(t); }
    state.tabs = state.tabs.filter(t => t.view !== "page");
    if (!state.tabs.length) state.tabs.push(makeTab());
    if (!tabById(state.activeId)) state.activeId = state.tabs[0].id;
    state.closed = state.closed.filter(c => !c.url);
    if (settings.clearOnSessionEnd) { state.history = state.history.filter(h => h.sid !== s.id); saveHistory(); }
    state.vpn.connected = false; state.vpn.profile = null;
    try { navigator.sendBeacon?.(`${API}/api/session/${encodeURIComponent(s.id)}/close`, "") || api(`/api/session/${encodeURIComponent(s.id)}/close`, { method: "POST" }).catch(() => {}); } catch {}
    addLog("info", `Session ${s.id.slice(0, 8)} ended (${reason}).`);
    renderTabs(); renderActive({ push: true, replace: true }); tickSession(); hooks.onSessionChanged?.();
    if (reason === "manual") toast("Session ended and deleted");
    else if (settings.autoRestartSession) toast("Session expired. A new one starts when you open a site");
    else {
      $("sessionOverText").textContent = reason === "server"
        ? "The server reports this session has expired. Veyra deleted its cookies, tabs, Chromium context and VPN tunnel."
        : `Your ${fmtClock(s.limitMs)} are up. Veyra deleted the session on the server: cookies, tabs, Chromium context and VPN tunnel.`;
      $("sessionOverlay").classList.remove("hidden"); $("sessionRestart").focus();
    }
  } finally { state.sessionEnding = false; }
}
hooks.onSessionExpired = reason => { if (state.session) endSession(reason); };
window.addEventListener("pagehide", () => { const s = state.session; if (s) try { navigator.sendBeacon(`${API}/api/session/${encodeURIComponent(s.id)}/close`, ""); } catch {} });

// ---------------------------------------------------------------- input classification + navigation
function looksLikeCalc(v) { return /[0-9]/.test(v) && /[+\-*/%^()]/.test(v) && /^[\d\s+\-*/%^().,]+$/.test(v); }
export function classify(input) {
  const v = String(input || "").trim(); if (!v) return null;
  const internal = v.match(/^veyra:\/\/([a-z]+)(?:\/([a-z-]+))?/i);
  if (internal) return INTERNAL[internal[1].toLowerCase()] ? { kind: "internal", view: internal[1].toLowerCase(), section: internal[2] || "" } : { kind: "search", query: v };
  if (/^(?:javascript|data|blob|file|chrome|about):/i.test(v)) return { kind: "unsupported", value: v };
  if (/^https?:\/\//i.test(v)) return { kind: "url", url: v };
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(v)) return { kind: "url", url: "http://" + v };
  if (!/\s/.test(v) && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(v)) return { kind: "url", url: "https://" + v };
  if (looksLikeCalc(v)) return { kind: "calc", expression: v };
  return { kind: "search", query: v };
}
export async function go(input, { tab = null, push = true, newTab: inNew = false } = {}) {
  const r = classify(input); if (!r) return;
  if (inNew) { newTab({ url: input }); return; }
  if (r.kind === "internal") { openInternal(r.view, { tab, section: r.section, push }); return; }
  if (r.kind === "unsupported") { toast("Veyra only opens http and https addresses", { kind: "warn" }); return; }
  if (r.kind === "calc") { openInternal("calculator", { tab, calc: r.expression, push }); return; }
  if (r.kind === "search") {
    const ext = engineUrl(r.query);
    if (ext) return navigate(ext, { tab, push, record: { kind: "search", title: `${r.query} - ${engineName()}` } });
    return showSearch(r.query, { tab, push });
  }
  let url; try { url = new URL(r.url).href; } catch { toast("That address isn't valid", { kind: "err" }); return; }
  return navigate(url, { tab, push });
}
export async function navigate(url, { tab = null, push = true, pushHist = true, record = null } = {}) {
  let t = tab || activeTab(); if (!t) return;
  if (t.view !== "page") { t.view = "page"; t.title = hostOf(url) || "Loading"; }
  state.activeId === t.id || (state.activeId = t.id);
  if (pushHist) pushTabHistory(t, url);
  await loadInTab(t, url, { loadFrame: true, record });
  if (push && activeTab() === t) syncRoute();
}
async function capability(url) {
  if (settings.runtime === "proxy") return "FAST_PROXY";
  if (settings.runtime === "browser") return "BROWSER_ENGINE";
  const host = hostOf(url); const c = state.capabilityCache.get(host); if (c) return c;
  try { const r = await api("/api/browser/capability", { json: { url }, timeoutMs: 8000 }); const m = r?.mode || "FAST_PROXY"; state.capabilityCache.set(host, m); return m; } catch { return "FAST_PROXY"; }
}
async function loadInTab(t, url, { loadFrame = true, record = null } = {}) {
  if (settings.autoStopPrevious && t.jobId && !t.done) stopJob(t.jobId).catch(() => {});
  if (t.poll) clearInterval(t.poll); t.poll = null; clearTimeout(t.browserPoll);
  Object.assign(t, { url, view: "page", title: t.title && t.url && hostOf(t.url) === hostOf(url) ? t.title : hostOf(url), jobId: null, done: false, resources: [], links: [], selectedResource: -1, remoteLogIds: new Set(), readerOpen: false, loading: true });
  if (!settings.preserveLog) { t.console = []; t.network = []; }
  rejectTab(t.id); hooks.dt?.onNavigate(t);
  const active = activeTab() === t;
  if (active) { renderActive({ push: false }); setLoading(true, 12, "Starting a clean session…"); }
  let session;
  try { session = await ensureSession(); }
  catch (e) { t.loading = false; if (activeTab() === t) setLoading(false); return renderError(t, "server", e); }
  if (!state.tabs.includes(t) || t.url !== url) return;
  recordHistory(record?.kind || "page", url, record?.title || hostOf(url), session.id);
  if (activeTab() === t) setLoading(true, 22, "Choosing the page engine…");
  const mode = await capability(url);
  if (!state.tabs.includes(t) || t.url !== url) return;
  if (mode === "FAST_PROXY" && t.browserSessionId) await stopBrowserSession(t);
  // Background crawl/index job (tied to the session so it stops when the session ends).
  api("/api/open", { json: { url, sessionId: session.id } }).then(b => { if (!state.tabs.includes(t) || t.url !== url) { if (b?.jobId) stopJob(b.jobId); return; } t.jobId = b?.jobId || null; if (t.jobId) startPolling(t); }).catch(e => { if (e.code !== "SESSION_EXPIRED") addLog("debug", `Background index skipped: ${e.message}`); });
  if (mode === "BROWSER_ENGINE") {
    try { await startBrowserSession(t, url); renderTabs(); return; }
    catch (e) { if (e.code === "SESSION_EXPIRED") return; addLog("warn", `Chromium unavailable, using fast proxy: ${e.message}`); t.browserMode = "FAST_PROXY"; t.browserSessionId = ""; if (!settings.browserFallback) return renderError(t, "server", e); }
  }
  t.browserMode = "FAST_PROXY";
  if (activeTab() === t) setLoading(true, 45, `Fetching ${hostOf(url)}…`);
  if (loadFrame) { const f = getOrCreateFrame(t); f.removeAttribute("srcdoc"); f.src = proxyUrl(url, "view", session.id); }
  if (activeTab() === t) showFrameForTab(t);
  renderTabs(); updateIdentity();
}
export function recordHistory(kind, url, title, sid = state.session?.id) {
  if (!url) return; const prev = state.history[0];
  if (prev && prev.url === url) { prev.time = new Date().toISOString(); if (title) prev.title = title; saveHistory(); return; }
  state.history.unshift({ id: uid(), time: new Date().toISOString(), kind, url, title: String(title || hostOf(url) || url).slice(0, 240), sid });
  if (state.history.length > (settings.historyMax || 1000)) state.history.length = settings.historyMax || 1000;
  saveHistory();
}
function renderError(t, kind, error) {
  t.view = "page"; t.loading = false;
  const titles = { server: "Veyra couldn't reach its server", unsupported: "This page can't be opened in Veyra", invalid: "That address isn't valid" };
  const f = getOrCreateFrame(t);
  f.srcdoc = `<!doctype html><meta charset="utf-8"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:#f6f7f9;color:#1b1f27}main{max-width:520px;padding:32px}h1{font-size:24px;margin:0 0 8px}p{color:#5b6372}code{font-size:12px;color:#8a93a3}button{margin-top:14px;height:38px;padding:0 18px;border-radius:99px;border:0;background:#3d6fd6;color:#fff;font-weight:600;cursor:pointer}</style><main><h1>${esc(titles[kind] || "The page could not be displayed")}</h1><p>${esc(error?.message || "Unknown error")}</p>${error?.requestId ? `<code>Request ${esc(error.requestId)}</code><br>` : ""}<button onclick="parent.postMessage({type:'veyra:local-retry'},'*')">Try again</button></main>`;
  if (activeTab() === t) { showFrameForTab(t); setLoading(false); }
  addLog("error", `Open failed: ${error?.message}`, { requestId: error?.requestId });
}

// Crawl job polling (resources, links and server logs for the dev console).
function startPolling(t) { if (t.poll) clearInterval(t.poll); pollJob(t); t.poll = setInterval(() => pollJob(t), 1200); }
async function pollJob(t) {
  if (!state.tabs.includes(t) || !t.jobId) { if (t.poll) clearInterval(t.poll); return; }
  try {
    const b = await api(`/api/crawl/${encodeURIComponent(t.jobId)}`, { timeoutMs: 8000 });
    for (const x of b.logs || []) { if (t.remoteLogIds.has(x.id)) continue; t.remoteLogIds.add(x.id); logs.push({ time: new Date(x.time).getTime(), level: x.level, message: `[${hostOf(t.url)}] ${x.message}` }); }
    if (activeTab()?.view === "console") renderConsole();
    if (b.done) { clearInterval(t.poll); t.poll = null; t.done = true; await Promise.all([loadResources(t), loadLinks(t)]); }
  } catch (e) { if (e.status === 404 || e.code === "SESSION_EXPIRED") { clearInterval(t.poll); t.poll = null; } }
}
async function stopJob(id) { try { await api(`/api/crawl/${encodeURIComponent(id)}/stop`, { method: "POST" }); } catch {} }
async function loadResources(t) { if (!t?.jobId) return; try { const b = await api(`/api/crawl/${encodeURIComponent(t.jobId)}/resources`); t.resources = b.resources || []; if (activeTab()?.view === "resources") renderResources(); } catch {} }
async function loadLinks(t) { if (!t?.jobId) return; try { const b = await api(`/api/crawl/${encodeURIComponent(t.jobId)}/links?offset=0&limit=2000`); t.links = b.links || []; if (activeTab()?.view === "links") renderLinks(); } catch {} }

// ---------------------------------------------------------------- Chromium engine
async function refreshRemote(t, loop = false) {
  if (!t?.browserSessionId || !state.tabs.includes(t)) return;
  clearTimeout(t.browserPoll);
  try {
    const r = await api(`/api/browser/session/${encodeURIComponent(t.browserSessionId)}`, { timeoutMs: 8000 });
    const s = r.session; const prev = t.url;
    t.url = s.canonicalUrl || t.url; t.title = s.title || hostOf(t.url); t.browserStatus = s.status; t.loading = false;
    if (t.url && prev && t.url !== prev) { pushTabHistory(t, t.url); recordHistory("page", t.url, t.title); }
    if (activeTab() === t && t.view === "page") {
      const img = $("remoteImg"); if (img) img.src = `${API}/api/browser/session/${encodeURIComponent(t.browserSessionId)}/screenshot?ts=${Date.now()}`;
      setLoading(false); updateAddress(); updateIdentity();
      if (s.status === "VERIFICATION_REQUIRED") $("statusLeft").textContent = "The site is asking for verification. Click inside the page to complete it.";
    }
    renderTabsSoon();
  } catch (e) { if (e.code === "BROWSER_SESSION_NOT_FOUND") { t.browserSessionId = ""; return; } }
  if (loop && activeTab() === t && t.view === "page") t.browserPoll = setTimeout(() => refreshRemote(t, true), document.hidden ? 3000 : 900);
}
async function startBrowserSession(t, url) {
  const sid = state.session?.id || "";
  if (t.browserSessionId) {
    try { const b = await api(`/api/browser/session/${encodeURIComponent(t.browserSessionId)}/navigate`, { json: { url } }); t.browserMode = "BROWSER_ENGINE"; t.url = b.session.canonicalUrl || url; if (activeTab() === t) showFrameForTab(t); t.loading = false; return; }
    catch (e) { if (e.code !== "BROWSER_SESSION_NOT_FOUND") { await stopBrowserSession(t); throw e; } t.browserSessionId = ""; }
  }
  const b = await api("/api/browser/session", { json: { tabId: t.id, url, proxySessionId: sid } });
  t.browserMode = "BROWSER_ENGINE"; t.browserSessionId = b.session.id; t.url = b.session.canonicalUrl || url; t.loading = false;
  frameFor(t)?.remove();
  if (activeTab() === t) { showFrameForTab(t); setLoading(false); }
  hooks.dt?.onPageLoaded(t); hooks.applyExtensionsToTab?.(t);
}
async function stopBrowserSession(t) { if (!t?.browserSessionId) return; const id = t.browserSessionId; t.browserSessionId = ""; clearTimeout(t.browserPoll); try { await api(`/api/browser/session/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch {} }
async function remoteHistory(t, direction) { try { await api(`/api/browser/session/${encodeURIComponent(t.browserSessionId)}/history`, { json: { direction } }); await refreshRemote(t, true); return true; } catch { return false; } }

// ---------------------------------------------------------------- toolbar actions
export async function back() {
  const t = activeTab(); if (!t) return;
  if (isRemote(t) && t.view === "page" && await remoteHistory(t, "back")) return;
  if (t.histIndex <= 0) return; t.histIndex--; await restoreHistoryEntry(t);
}
export async function forward() {
  const t = activeTab(); if (!t) return;
  if (isRemote(t) && t.view === "page" && await remoteHistory(t, "forward")) return;
  if (t.histIndex >= t.history.length - 1) return; t.histIndex++; await restoreHistoryEntry(t);
}
async function restoreHistoryEntry(t) {
  const e = t.history[t.histIndex]; if (!e) return;
  if (e.startsWith("veyra:search:")) return showSearch(e.slice(13), { tab: t, pushHist: false });
  if (e.startsWith("veyra:")) { const [view, section] = e.slice(6).split("/"); const idx = t.histIndex; openInternal(view, { tab: t, section }); t.histIndex = idx; t.history.length = Math.max(t.history.length, idx + 1); updateNavButtons(); return; }
  await navigate(e, { tab: t, pushHist: false });
}
export async function reload({ hard = false } = {}) {
  const t = activeTab(); if (!t) return;
  if ($("reloadBtn").dataset.loading === "1" && !hard) return stopLoad();
  if (t.view === "page" && t.url) {
    if (isRemote(t)) { if (await remoteHistory(t, "reload")) return; }
    if (hard) state.capabilityCache.delete(hostOf(t.url));
    return loadInTab(t, t.url, { loadFrame: true });
  }
  if (t.view === "search") return runSearch(t.searchQuery);
  renderActive({ push: false });
}
export async function stopLoad() {
  const t = activeTab(); if (!t) return;
  if (t.browserSessionId) api(`/api/browser/session/${encodeURIComponent(t.browserSessionId)}/stop`, { method: "POST" }).catch(() => {});
  try { frameFor(t)?.contentWindow?.stop?.(); } catch {}
  setLoading(false); toast("Stopped loading");
}
export function goHome() { const t = activeTab(); if (!t) return; if (settings.homepage) return go(settings.homepage); if (t.view === "page") teardownTab(t); Object.assign(t, { view: "newtab", url: "", title: "New tab", favicon: "", browserMode: "FAST_PROXY", browserSessionId: "", loading: false }); pushTabHistory(t, "veyra:newtab"); renderTabs(); renderActive(); }
export function pageCommand(type, payload = {}, t = activeTab()) { const f = frameFor(t); if (!f?.contentWindow || !t?.url) return false; try { f.contentWindow.postMessage({ type, ...payload }, API_ORIGIN); return true; } catch { return false; } }
export function printPage() { const t = activeTab(); if (t?.view !== "page" || !t.url) { window.print(); return; } if (isRemote(t)) { window.open(`${API}/api/browser/session/${encodeURIComponent(t.browserSessionId)}/screenshot`, "_blank", "noopener"); return; } if (!pageCommand("veyra:print")) toast("This page can't be printed yet", { kind: "warn" }); }
export function setZoom(z, t = activeTab()) {
  if (!t || t.view !== "page") { const s = Math.max(.8, Math.min(1.4, Number(z) || 1)); settings.fontScale = s; saveSettings(); document.documentElement.style.setProperty("--ui-scale", s); toast(`Veyra UI ${Math.round(s * 100)}%`); return; }
  t.zoom = Math.round(Math.max(.25, Math.min(5, Number(z) || 1)) * 100) / 100;
  dtCall(t, "ext.zoom", { zoom: t.zoom }, 4000).catch(e => toast(e.message, { kind: "warn" }));
  updateIdentity(); hooks.onZoom?.(t.zoom);
}
const ZOOM_STEPS = [.25, .33, .5, .67, .75, .8, .9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
export function zoomStep(dir) { const t = activeTab(); const cur = t?.view === "page" ? t.zoom : settings.fontScale || 1; if (dir === 0) return setZoom(1); const next = dir > 0 ? ZOOM_STEPS.find(z => z > cur + .001) : [...ZOOM_STEPS].reverse().find(z => z < cur - .001); setZoom(next ?? cur); }

// ---------------------------------------------------------------- bookmarks
export function toggleBookmark() {
  const t = activeTab(); if (!t?.url) return;
  const i = state.bookmarks.findIndex(b => b.url === t.url);
  if (i >= 0) { const [b] = state.bookmarks.splice(i, 1); saveBookmarks(); toast("Bookmark removed", { action: () => { state.bookmarks.splice(i, 0, b); saveBookmarks(); updateIdentity(); }, actionLabel: "Undo" }); }
  else { state.bookmarks.push({ id: uid(), url: t.url, title: t.title || hostOf(t.url), time: Date.now() }); saveBookmarks(); toast("Bookmarked"); }
  updateIdentity();
}

// ---------------------------------------------------------------- find in page
export function openFind() {
  const t = activeTab(); if (t?.view !== "page" || !t.url) { toast("Open a website to search inside it"); return; }
  if (isRemote(t)) { toast("Find isn't available in Chromium tabs yet", { kind: "warn" }); return; }
  $("findBar").classList.remove("hidden"); $("findInput").focus(); $("findInput").select(); if ($("findInput").value) findQuery($("findInput").value);
}
function findQuery(q, direction = "forward") { pageCommand("veyra:find", { query: q, direction }); if (!q) $("findCount").textContent = "0/0"; }
export function closeFind() { $("findBar").classList.add("hidden"); pageCommand("veyra:find-close"); }

// ---------------------------------------------------------------- Veyra Search
export function showSearch(query = "", { tab = null, push = true, pushHist = true } = {}) {
  let t = tab || activeTab(); if (!t) return;
  if (t.view === "page") teardownTab(t);
  Object.assign(t, { view: "search", title: query ? `${query} - Veyra Search` : "Veyra Search", url: "", favicon: "", searchQuery: query, searchData: null, loading: false, browserSessionId: "" });
  if (pushHist) pushTabHistory(t, "veyra:search:" + query);
  if (query) recordHistory("search", `veyra://search?q=${encodeURIComponent(query)}`, `${query} - Veyra Search`);
  renderTabs(); renderActive({ push });
  if (query) runSearch(query);
}
async function runSearch(query, offset = 0) {
  const t = activeTab(); if (!t || t.view !== "search") return; t.searchQuery = query;
  $("searchStat").textContent = "Searching…"; $("searchMeta").textContent = "";
  if (!offset) $("searchResults").innerHTML = Array.from({ length: 4 }, () => `<div class="result"><div class="skel" style="height:16px;width:55%;border-radius:4px;background:var(--surface-3)"></div><div style="height:10px"></div><div style="height:12px;width:85%;border-radius:4px;background:var(--surface-2)"></div></div>`).join("");
  try {
    const b = await api(`/api/search?q=${encodeURIComponent(query)}&offset=${offset}&limit=10`);
    if (offset && t.searchData) t.searchData.results.push(...(b.results || [])); else t.searchData = b;
    renderSearch();
  } catch (e) { $("searchStat").textContent = "Search failed"; $("searchMeta").textContent = e.message; $("searchResults").innerHTML = `<div class="empty"><b>Veyra Search couldn't finish</b><span>${esc(e.message)}</span><button class="btn ghost sm" id="searchRetry">Try again</button></div>`; $("searchRetry").onclick = () => runSearch(query); }
}
function highlightTerms(text, q) { const s = esc(text); const words = String(q).split(/\s+/).filter(w => w.length > 1 && !/:/.test(w)).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); return words.length ? s.replace(new RegExp(`(${words.join("|")})`, "gi"), "<mark>$1</mark>") : s; }
function renderSearch() {
  const t = activeTab(); if (!t || t.view !== "search") return;
  $("searchInput").value = t.searchQuery;
  const d = t.searchData;
  if (!t.searchQuery) { $("searchResults").innerHTML = ""; $("searchStat").textContent = "Veyra Search"; $("searchMeta").textContent = "Search pages Veyra has indexed. Operators like site: and intitle: work too."; $("searchMore").classList.add("hidden"); loadIndexStats(); setTimeout(() => $("searchInput").focus(), 20); return; }
  if (!d) return;
  $("searchStat").textContent = `${d.total == null ? (d.results?.length || 0) + "+" : Number(d.total).toLocaleString()} results`;
  $("searchMeta").textContent = `${d.responseTimeMs ?? "—"} ms${d.cached ? " · cached" : ""}`;
  $("searchResults").innerHTML = (d.results || []).map(r => `<article class="result"><div class="r-url">${esc(displayUrl(r.displayUrl || r.url))}</div><a class="r-title" href="${esc(r.url)}" data-open="${esc(r.url)}">${highlightTerms(r.title || r.url, t.searchQuery)}</a><p>${highlightTerms(r.snippet || "No description available.", t.searchQuery)}</p></article>`).join("")
    || `<div class="empty"><svg><use href="#i-search"/></svg><b>No indexed pages match “${esc(t.searchQuery)}”</b><span>Veyra only returns pages it has actually indexed. Open a site to add it, or search the web instead.</span><button class="btn ghost sm" id="searchWeb">Search DuckDuckGo for it</button></div>`;
  $("searchResults").querySelectorAll("[data-open]").forEach(a => a.onclick = e => { e.preventDefault(); if (e.ctrlKey || e.metaKey || e.button === 1) newTab({ url: a.dataset.open, background: true }); else navigate(a.dataset.open); });
  $("searchWeb")?.addEventListener("click", () => navigate(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(t.searchQuery)}`));
  const more = d.total == null ? (d.results?.length || 0) >= 10 : (d.results?.length || 0) < d.total;
  $("searchMore").classList.toggle("hidden", !more); $("searchMore").onclick = () => runSearch(t.searchQuery, d.results.length);
  loadIndexStats();
}
async function loadIndexStats() { try { const b = await api("/api/search/stats", { timeoutMs: 6000 }); $("searchCoverage").textContent = `Veyra Index: ${Number(b.documents || 0).toLocaleString()} pages · ${Number(b.domains || 0).toLocaleString()} domains`; } catch { $("searchCoverage").textContent = ""; } }
let suggestTimer = 0;
function loadSuggestions(q) { clearTimeout(suggestTimer); suggestTimer = setTimeout(async () => { if (!q.trim()) return; try { const b = await api(`/api/search/suggest?q=${encodeURIComponent(q)}&limit=8`, { timeoutMs: 4000 }); $("searchSuggestions").innerHTML = (b.suggestions || []).map(s => `<option value="${esc(s)}">`).join(""); } catch {} }, 160); }
export async function omniSuggest(q) {
  if (!settings.suggestions || !q.trim()) return [];
  try { const b = await api(`/api/search/suggest?q=${encodeURIComponent(q)}&limit=5`, { timeoutMs: 3000 }); return b.suggestions || []; } catch { return []; }
}

// ---------------------------------------------------------------- calculator (no eval)
function tokenize(s) {
  const out = []; let i = 0; s = String(s).replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/,/g, "");
  while (i < s.length) { const c = s[i]; if (/\s/.test(c)) { i++; continue; } if (/[0-9.]/.test(c)) { let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++; const raw = s.slice(i, j); if ((raw.match(/\./g) || []).length > 1 || raw === ".") throw new Error("Invalid number."); out.push({ t: "n", v: Number(raw) }); i = j; continue; } if ("+-*/%^()".includes(c)) { out.push({ t: "o", v: c }); i++; continue; } throw new Error(`Unsupported character “${c}”.`); }
  out.push({ t: "e" }); return out;
}
export function evaluate(expr) {
  const tk = tokenize(expr); let p = 0; const peek = () => tk[p], take = () => tk[p++];
  const unary = () => { if (peek().v === "-") { take(); return -unary(); } if (peek().v === "+") { take(); return unary(); } return power(); };
  const power = () => { let b = primary(); if (peek().v === "^") { take(); b = Math.pow(b, unary()); } return b; };
  const primary = () => { const x = take(); if (x.t === "n") { if (peek().v === "%" && (tk[p + 1].t === "e" || ["+", "-", ")"].includes(tk[p + 1].v))) { take(); return x.v / 100; } return x.v; } if (x.v === "(") { const v = expr0(); if (take().v !== ")") throw new Error("Missing closing parenthesis."); return v; } throw new Error("Expected a number."); };
  const term = () => { let v = unary(); while (["*", "/", "%"].includes(peek().v)) { const o = take().v, r = unary(); if (o === "/" && r === 0) throw new Error("Division by zero."); v = o === "*" ? v * r : o === "/" ? v / r : v % r; } return v; };
  const expr0 = () => { let v = term(); while (["+", "-"].includes(peek().v)) { const o = take().v, r = term(); v = o === "+" ? v + r : v - r; } return v; };
  const v = expr0(); if (peek().t !== "e") throw new Error("Unexpected token."); if (!Number.isFinite(v)) throw new Error("Result isn't finite."); return v;
}
const fmtNum = v => Number.isInteger(v) ? v.toLocaleString("en-GB") : String(Number(v.toPrecision(12)));
function renderCalculator() {
  const t = activeTab(); if (!t) return; const input = $("calcInput");
  if (document.activeElement !== input) input.value = t.calcExpression || "";
  const v = input.value.trim(); t.calcExpression = v;
  if (!v) { $("calcResult").textContent = "0"; $("calcStatus").textContent = "Supports + − × ÷ % ^, parentheses and negative numbers."; return; }
  try { $("calcResult").textContent = fmtNum(evaluate(v)); $("calcStatus").textContent = "Calculated on your device."; } catch (e) { $("calcResult").textContent = "—"; $("calcStatus").textContent = e.message; }
}
function setupCalculator() {
  const keys = ["C", "(", ")", "÷", "7", "8", "9", "×", "4", "5", "6", "−", "1", "2", "3", "+", "%", "0", ".", "="];
  $("calcKeys").innerHTML = keys.map(k => `<button class="${"÷×−+%()".includes(k) ? "op" : k === "=" ? "eq" : ""}" data-k="${k}">${k}</button>`).join("");
  $("calcKeys").onclick = e => { const k = e.target.closest("[data-k]")?.dataset.k; if (!k) return; const input = $("calcInput");
    if (k === "C") input.value = ""; else if (k === "=") { try { input.value = String(evaluate(input.value)); } catch {} } else input.value += k;
    activeTab().calcExpression = input.value; renderCalculator(); input.focus(); };
  $("calcInput").oninput = () => { activeTab().calcExpression = $("calcInput").value; renderCalculator(); syncRoute({ replace: true }); };
  $("calcInput").onkeydown = e => { if (e.key === "Enter") { try { $("calcInput").value = String(evaluate($("calcInput").value)); renderCalculator(); } catch {} } };
}

// ---------------------------------------------------------------- downloads
export async function startDownload(url, name = "") {
  if (!/^https?:\/\//i.test(url || "")) return;
  let session; try { session = await ensureSession(); } catch (e) { toast(e.message, { kind: "err" }); return; }
  const item = { id: uid(), time: new Date().toISOString(), url, name: name || decodeURIComponent(pathOf(url).split("/").pop().split("?")[0] || hostOf(url)) || "download", status: "starting", received: 0, total: 0 };
  state.downloads.unshift(item); saveDownloads(); renderDownloads(); hooks.onDownloadsChanged?.();
  if (settings.downloadsOpenOnStart) toast(`Downloading ${item.name}`, { action: () => openInternal("downloads"), actionLabel: "Show" });
  const controller = new AbortController(); state.downloadControllers.set(item.id, controller);
  try {
    const res = await rawFetch(proxyUrl(url, "download", session.id), { signal: controller.signal });
    if (!res.ok) { let m = `HTTP ${res.status}`; try { m = (await res.json()).error || m; } catch {} throw new Error(m); }
    item.total = Number(res.headers.get("content-length") || 0);
    const cd = res.headers.get("content-disposition") || ""; const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i); if (m) try { item.name = decodeURIComponent(m[1]); } catch {}
    const reader = res.body?.getReader(); const chunks = [];
    if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); item.received += value.byteLength; item.status = "downloading"; renderDownloadsSoon(); }
    else { const buf = new Uint8Array(await res.arrayBuffer()); chunks.push(buf); item.received = buf.byteLength; }
    const blob = new Blob(chunks, { type: res.headers.get("content-type") || "application/octet-stream" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: item.name }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    item.status = "complete"; item.total = item.total || item.received;
  } catch (e) { item.status = e.name === "AbortError" ? "cancelled" : "failed"; item.error = e.message; if (e.name !== "AbortError") toast(`Download failed: ${e.message}`, { kind: "err" }); }
  finally { state.downloadControllers.delete(item.id); saveDownloads(); renderDownloads(); hooks.onDownloadsChanged?.(); }
}
let dlRaf = 0; function renderDownloadsSoon() { if (dlRaf) return; dlRaf = requestAnimationFrame(() => { dlRaf = 0; renderDownloads(); }); }
function renderDownloads() {
  const box = $("downloadsList"); if (!box || activeTab()?.view !== "downloads") return;
  const q = $("downloadsFilter").value.toLowerCase();
  const list = state.downloads.filter(d => !q || (d.name + d.url).toLowerCase().includes(q));
  if (!list.length) { box.innerHTML = `<div class="empty"><svg><use href="#i-download"/></svg><b>${q ? "No matching downloads" : "No downloads yet"}</b><span>Files you save through Veyra show up here.</span></div>`; return; }
  box.innerHTML = list.map(d => { const pct = d.total ? Math.round(d.received / d.total * 100) : 0; const live = state.downloadControllers.has(d.id);
    return `<div class="row-item"><svg><use href="#i-file"/></svg><div class="ri-main"><b>${esc(d.name)}</b><span>${esc(displayUrl(d.url))}</span>${live ? `<div class="progress"><i style="width:${d.total ? pct : 30}%"></i></div>` : ""}</div>
    <span class="pill ${d.status === "complete" ? "ok" : d.status === "failed" ? "err" : d.status === "cancelled" ? "" : "accent"}">${live ? (d.total ? pct + "%" : fmtBytes(d.received)) : esc(d.status)}${d.status === "complete" && d.total ? " · " + fmtBytes(d.total) : ""}</span>
    <time>${esc(timeAgo(d.time))}</time>
    ${live ? `<button class="btn ghost sm" data-cancel="${d.id}">Cancel</button>` : `<button class="icon-btn sm" title="Download again" data-again="${d.id}"><svg><use href="#i-reload"/></svg></button><button class="icon-btn sm" title="Remove from list" data-rm="${d.id}"><svg><use href="#i-x"/></svg></button>`}</div>`; }).join("");
  box.onclick = e => { const b = e.target.closest("button"); if (!b) return; const d = state.downloads.find(x => x.id === (b.dataset.cancel || b.dataset.again || b.dataset.rm)); if (!d) return;
    if (b.dataset.cancel) state.downloadControllers.get(d.id)?.abort(); else if (b.dataset.again) startDownload(d.url, d.name); else { state.downloads.splice(state.downloads.indexOf(d), 1); saveDownloads(); renderDownloads(); } };
}

// ---------------------------------------------------------------- history page
function renderHistory() {
  const box = $("historyList"); if (!box) return;
  const q = $("historyFilter").value.toLowerCase();
  const list = state.history.filter(h => !q || (h.title + " " + h.url).toLowerCase().includes(q)).slice(0, 600);
  if (!list.length) { box.innerHTML = `<div class="empty"><svg><use href="#i-history"/></svg><b>${q ? "Nothing matches" : "Your history is empty"}</b><span>${settings.clearOnSessionEnd ? "History from a session is removed when it ends. You can change this in Settings > Privacy." : "Pages you visit show up here."}</span></div>`; return; }
  let lastDay = ""; let html = "";
  for (const h of list) {
    const day = new Date(h.time).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    if (day !== lastDay) { html += `<div class="list-group">${esc(day)}</div>`; lastDay = day; }
    const li = letterIcon(h.url);
    html += `<div class="row-item"><time>${new Date(h.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><b style="display:grid;place-items:center;width:20px;height:20px;border-radius:5px;background:${li.color};color:#fff;font-size:11px;flex:none">${esc(li.letter)}</b><div class="ri-main" style="cursor:pointer" data-open="${esc(h.url)}"><b>${esc(h.title)}</b><span>${esc(displayUrl(h.url))}</span></div><button class="icon-btn sm" title="Remove" data-rm="${h.id}"><svg><use href="#i-x"/></svg></button></div>`;
  }
  box.innerHTML = html;
  box.onclick = e => { const o = e.target.closest("[data-open]"); if (o) { go(o.dataset.open.startsWith("veyra://search?q=") ? decodeURIComponent(o.dataset.open.split("q=")[1]) : o.dataset.open, { newTab: e.ctrlKey || e.metaKey }); return; } const r = e.target.closest("[data-rm]"); if (r) { state.history = state.history.filter(h => h.id !== r.dataset.rm); saveHistory(); renderHistory(); } };
}
export function clearBrowsingData({ history = true, downloads = false, cookies = false, cache = false, since = 0 } = {}) {
  const cutoff = since ? Date.now() - since : 0;
  if (history) { state.history = cutoff ? state.history.filter(h => new Date(h.time).getTime() < cutoff) : []; saveHistory(); }
  if (downloads) { state.downloads = cutoff ? state.downloads.filter(h => new Date(h.time).getTime() < cutoff) : []; saveDownloads(); }
  if (cookies && state.session) api(`/api/session/${state.session.id}/cookies`, { method: "DELETE" }).catch(() => {});
  if (cache) state.capabilityCache.clear();
  if (activeTab()?.view === "history") renderHistory();
}

// ---------------------------------------------------------------- resources & links
function sourceTab() { const t = activeTab(); return tabById(t?.sourceTabId) || state.tabs.find(x => x.view === "page" && x.url) || null; }
async function renderResources() {
  const src = sourceTab(); const box = $("resourceList");
  if (!src) { box.innerHTML = `<div class="empty">Open a website first, then choose View source resources.</div>`; $("sourceCode").innerHTML = ""; return; }
  activeTab().title = `Resources · ${hostOf(src.url)}`; renderTabsSoon();
  // Live list from the page itself (document, scripts, styles) + the crawler's captures.
  let live = null; try { live = await dtCall(src, "sources.list", {}, 5000); } catch {}
  const rows = [{ id: "doc", type: "html", url: src.url, label: "Document (live DOM)" }];
  if (live) { live.scripts.forEach(s => rows.push({ id: `script:${s.index}`, type: "js", url: s.url, inline: s.inline, index: s.index, kind: "script", label: s.inline ? `inline script #${s.index + 1}` : "" })); live.styles.forEach(s => rows.push({ id: `style:${s.index}`, type: "css", url: s.url, inline: s.inline, index: s.index, kind: "style", label: s.inline ? `inline style #${s.index + 1}` : "" })); }
  for (const r of src.resources || []) if (!rows.some(x => x.url === r.url)) rows.push({ id: `crawl:${r.id}`, type: String(r.type || "file").slice(0, 4), url: r.url, crawlId: r.id, meta: `${r.status} · ${r.bytesLabel || ""}` });
  const q = $("resFilter").value.toLowerCase();
  src._resRows = rows;
  box.innerHTML = rows.filter(r => !q || (r.url + r.label + r.type).toLowerCase().includes(q)).map(r => `<button class="res-item ${src._resSel === r.id ? "on" : ""}" data-id="${esc(r.id)}"><span class="res-type">${esc(r.type)}</span><span class="n" title="${esc(r.url)}">${esc(r.label || pathOf(r.url) || r.url)}</span></button>`).join("") || `<div class="empty">No resources match.</div>`;
  box.onclick = e => { const b = e.target.closest("[data-id]"); if (b) selectResource(src, b.dataset.id); };
  if (!src._resSel) selectResource(src, "doc");
}
function highlightCode(text, type) {
  const lines = String(text).split("\n").slice(0, 20000);
  const hl = type === "html" ? s => esc(s).replace(/(&lt;\/?)([a-zA-Z][\w-]*)/g, '$1<span class="tk-t">$2</span>').replace(/([\w-:]+)=(&quot;.*?&quot;)/g, '<span class="tk-a">$1</span>=<span class="tk-s">$2</span>')
    : type === "css" ? s => esc(s).replace(/([\w-]+)(\s*:)(?!\/\/)/g, '<span class="tk-a">$1</span>$2').replace(/(\/\*.*?\*\/)/g, '<span class="tk-c">$1</span>')
    : type === "js" ? s => esc(s).replace(/\b(const|let|var|function|return|if|else|for|while|new|class|import|export|from|await|async|try|catch|throw|this|typeof|null|undefined|true|false)\b/g, '<span class="tk-k">$1</span>').replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;)/g, '<span class="tk-s">$1</span>').replace(/(\/\/.*)$/, '<span class="tk-c">$1</span>')
    : esc;
  return lines.map(l => `<span class="ln">${hl(l) || " "}</span>`).join("");
}
// Token-aware pretty printer: keeps strings, template literals, comments and regex literals intact,
// and never breaks inside (...) so for(;;) headers stay on one line.
export function prettyPrint(text, type) {
  text = String(text || "");
  if (type === "json") try { return JSON.stringify(JSON.parse(text), null, 2); } catch {}
  if (type === "html") return text.replace(/>\s*</g, ">\n<");
  if (type !== "js" && type !== "css") return text;
  const js = type === "js"; const o = []; let ind = 0, paren = 0, i = 0, lastSig = ""; const parenStack = [];
  const WORD = /[\w$]+/y, REST = /\s*([;,)\]]|else\b|catch\b|finally\b|while\b)/y;
  const tail = () => o.length ? o[o.length - 1] : "";
  const trimEnd = () => { while (o.length && /^\s*$/.test(tail())) o.pop(); if (o.length) o[o.length - 1] = tail().replace(/\s+$/, ""); };
  const nl = () => { trimEnd(); o.push("\n" + "  ".repeat(ind)); };
  const regexOk = () => !lastSig || /[(,=:[!&|?{};+\-*%<>~^]$/.test(lastSig) || /^(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(lastSig);
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === "/" && n === "*") { const e = text.indexOf("*/", i + 2); const end = e < 0 ? text.length : e + 2; o.push(text.slice(i, end)); i = end; continue; }
    if (js && c === "/" && n === "/") { const e = text.indexOf("\n", i); const end = e < 0 ? text.length : e; o.push(text.slice(i, end)); i = end; nl(); while (/\s/.test(text[i] || "")) i++; continue; }
    if (c === '"' || c === "'" || (js && c === "`")) { let j = i + 1; while (j < text.length && text[j] !== c) { if (text[j] === "\\") j++; j++; } o.push(text.slice(i, j + 1)); lastSig = c; i = j + 1; continue; }
    if (js && c === "/" && regexOk()) { let j = i + 1, cls = false; while (j < text.length && text[j] !== "\n") { const d = text[j]; if (d === "\\") { j += 2; continue; } if (d === "[") cls = true; else if (d === "]") cls = false; else if (d === "/" && !cls) break; j++; } j++; while (/[a-z]/i.test(text[j] || "")) j++; o.push(text.slice(i, j)); lastSig = "/re/"; i = j; continue; }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { let hadNl = false; while (/\s/.test(text[i] || "")) { if (text[i] === "\n") hadNl = true; i++; } if (hadNl && paren === 0 && !/\n\s*$/.test(tail())) nl(); else if (!/\s$/.test(tail())) o.push(" "); continue; }
    if (c === "(" || c === "[") { paren++; o.push(c); lastSig = c; i++; continue; }
    if (c === ")" || c === "]") { paren = Math.max(0, paren - 1); o.push(c); lastSig = c; i++; continue; }
    if (c === "{") { trimEnd(); if (/[\w)\]"'`]$/.test(tail())) o.push(" "); o.push("{"); ind++; parenStack.push(paren); paren = 0; nl(); lastSig = c; i++; continue; }
    if (c === "}") { ind = Math.max(0, ind - 1); paren = parenStack.length ? parenStack.pop() : 0; nl(); o.push("}"); lastSig = c; i++; if (paren === 0) { REST.lastIndex = i; const rest = REST.exec(text); if (!rest) nl(); else if (/^[a-z]/.test(rest[1])) { o.push(" "); i += rest[0].length - rest[1].length; } } continue; }
    if (c === ";") { o.push(";"); lastSig = c; i++; if (paren === 0) nl(); continue; }
    WORD.lastIndex = i; const w = WORD.exec(text); if (w) { o.push(w[0]); lastSig = w[0]; i += w[0].length; continue; }
    o.push(c); lastSig = c; i++;
  }
  return o.join("").replace(/\n[ \t]*\n+/g, "\n").trim();
}
async function selectResource(src, id) {
  src._resSel = id; qsa("#resourceList .res-item").forEach(b => b.classList.toggle("on", b.dataset.id === id));
  const r = (src._resRows || []).find(x => x.id === id); if (!r) return;
  $("sourceTitle").textContent = r.label || pathOf(r.url) || r.url; $("sourceMeta").textContent = r.url + (r.meta ? ` · ${r.meta}` : "");
  $("sourceCode").innerHTML = `<span class="ln muted">Loading…</span>`;
  let text = "";
  try {
    if (r.id === "doc") text = await dtCall(src, "sources.document", {}, 8000);
    else if (r.inline) text = await dtCall(src, "sources.inline", { kind: r.kind, index: r.index }, 8000);
    else if (r.crawlId != null && src.jobId) text = (await api(`/api/crawl/${encodeURIComponent(src.jobId)}/source/${encodeURIComponent(r.crawlId)}`)).source || "";
    else if (state.session) { const res = await rawFetch(proxyUrl(r.url, "resource", state.session.id)); text = await res.text(); }
    else text = "The session has ended, so this file can no longer be fetched.";
  } catch (e) { text = `Couldn't load this resource: ${e.message}`; }
  src._resText = text; src._resType = r.type;
  $("sourceCode").innerHTML = highlightCode(text, r.type);
}
async function renderLinks() {
  const src = sourceTab(); const body = $("linkBody");
  if (!src) { body.innerHTML = `<tr><td colspan="4" class="muted">Open a website first, then choose View all links.</td></tr>`; return; }
  activeTab().title = `Links · ${hostOf(src.url)}`; renderTabsSoon();
  let live = []; try { live = await dtCall(src, "ext.links", {}, 5000) || []; } catch {}
  const map = new Map();
  for (const l of live) if (/^https?:/i.test(l.href)) map.set(l.href, { url: l.href, text: l.text, source: src.url, from: "page" });
  for (const l of src.links || []) if (!map.has(l.url)) map.set(l.url, { url: l.url, text: l.type, source: l.source, from: "crawl" });
  const q = $("linkFilter").value.toLowerCase(), scope = $("linkScope").value, host = hostOf(src.url);
  const rows = [...map.values()].filter(l => (!q || (l.url + l.text).toLowerCase().includes(q)) && (scope === "all" || (scope === "internal") === (hostOf(l.url) === host)));
  src._links = rows;
  $("linkSummary").textContent = `${rows.length.toLocaleString()} links on ${host}${src.links?.length ? ` · ${src.links.length.toLocaleString()} found by the crawler` : ""}`;
  body.innerHTML = rows.slice(0, 3000).map(l => `<tr><td><a href="${esc(l.url)}" data-open="${esc(l.url)}">${esc(displayUrl(l.url))}</a></td><td>${esc(l.text || "")}</td><td class="muted">${esc(pathOf(l.source || ""))}</td><td><button class="icon-btn sm" title="Open in new tab" data-new="${esc(l.url)}"><svg><use href="#i-external"/></svg></button></td></tr>`).join("") || `<tr><td colspan="4" class="muted">No links match.</td></tr>`;
  body.onclick = e => { const a = e.target.closest("[data-open]"); if (a) { e.preventDefault(); navigate(a.dataset.open); } const n = e.target.closest("[data-new]"); if (n) newTab({ url: n.dataset.new, background: true }); };
}

// ---------------------------------------------------------------- admin: Veyra console + /dev
function renderConsole() {
  if (!isAdmin()) return;
  const f = $("consoleFilter").value, q = $("consoleSearch").value.toLowerCase();
  const rows = logs.filter(x => (f === "all" || x.level === f) && (!q || x.message.toLowerCase().includes(q))).slice(-1500);
  $("consoleLog").innerHTML = rows.map(x => `<div class="log-row ${esc(x.level)}"><time>${new Date(x.time).toLocaleTimeString([], { hour12: false })}</time><span class="lv">${esc(x.level)}</span><span class="msg">${esc(x.message)}</span></div>`).join("") || `<div class="empty">No log entries.</div>`;
  $("consoleLog").scrollTop = $("consoleLog").scrollHeight;
}
hooks.onLog = debounceRaf(() => { if (activeTab()?.view === "console") renderConsole(); });
function debounceRaf(fn) { let r = 0; return () => { if (r) return; r = requestAnimationFrame(() => { r = 0; fn(); }); }; }
async function renderDev() {
  if (!isAdmin()) return;
  const box = $("devPanel");
  if (!box.dataset.ready) {
    box.dataset.ready = "1";
    box.innerHTML = `<header class="page-head row"><div><h1>Veyra dev</h1><p class="muted">Server diagnostics. Admin only.</p></div><div class="head-actions"><label class="switch-row"><span>Auto refresh</span><input type="checkbox" class="switch" id="devAuto" checked></label><button class="btn ghost" id="devRefresh">Refresh</button></div></header>
      <div class="dev-grid" id="devStats"></div>
      <div class="s-section"><h2>Sessions</h2><div class="table-wrap"><table class="table"><thead><tr><th>Session</th><th>Age</th><th>Remaining</th><th>Requests</th><th>Cookies</th><th>User</th></tr></thead><tbody id="devSessions"></tbody></table></div></div>
      <div class="s-section"><h2>Crawl jobs</h2><div class="table-wrap"><table class="table"><thead><tr><th>Job</th><th>Host</th><th>Status</th><th>Processed</th><th>Links</th><th></th></tr></thead><tbody id="devJobs"></tbody></table></div></div>
      <div class="s-section"><h2>Recent server requests</h2><div class="table-wrap" style="max-height:340px"><table class="table"><thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>ms</th></tr></thead><tbody id="devReqs"></tbody></table></div></div>
      <div class="s-section"><h2>Runtime config</h2><pre class="json-view" id="devConfig"></pre></div>`;
    $("devRefresh").onclick = renderDev; $("devAuto").onchange = renderDev;
  }
  clearInterval(state.devTimer);
  if ($("devAuto").checked) state.devTimer = setInterval(() => { if (activeTab()?.view === "dev") refreshDev(); else clearInterval(state.devTimer); }, Math.max(1000, settings.devRefreshMs || 1500));
  refreshDev();
}
async function refreshDev() {
  const [sys, sess, jobs, reqs, cfg] = await Promise.allSettled([api("/api/debug/system"), api("/api/sessions"), api("/api/debug/jobs"), api("/api/debug/requests?limit=120"), api("/api/config")]);
  if (sys.status === "rejected") { $("devStats").innerHTML = `<div class="stat-card"><span>Error</span><b>${esc(sys.reason.message)}</b></div>`; return; }
  const s = sys.value, se = sess.value || {};
  const cards = [["Uptime", `${Math.round(s.uptimeSec / 60)} min`], ["Memory (RSS)", fmtBytes(s.memory?.rss)], ["Heap", `${fmtBytes(s.memory?.heapUsed)} / ${fmtBytes(s.memory?.heapTotal)}`], ["Active jobs", s.jobs?.active ?? "—"], ["Sessions", se.size ?? se.active ?? (se.sessions || []).length ?? "—"], ["Session limit", se.timeLimitMs ? fmtClock(se.timeLimitMs) : "none"], ["Chromium sessions", se.browser?.sessions ?? s.browser?.sessions ?? 0], ["VPN connections", se.vpnConnections ?? 0], ["Search pages", Number(s.searchIndexEntries || 0).toLocaleString()], ["Proxy cache", s.proxyCacheEntries ?? 0], ["Node", s.nodeVersion], ["Role", s.processRole]];
  $("devStats").innerHTML = cards.map(([a, b]) => `<div class="stat-card"><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join("");
  $("devSessions").innerHTML = (se.sessions || se.list || []).slice(0, 100).map(x => `<tr><td class="mono">${esc(String(x.id || x.sessionId || "").slice(0, 12))}</td><td>${x.ageMs != null ? fmtClock(x.ageMs) : esc(x.createdAt || "")}</td><td>${x.remainingMs != null ? fmtClock(x.remainingMs) : "—"}</td><td>${esc(x.requests ?? "")}</td><td>${esc(x.cookies ?? "")}</td><td>${esc(x.userId || "guest")}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No active sessions.</td></tr>`;
  $("devJobs").innerHTML = (jobs.value?.jobs || []).map(j => `<tr><td class="mono">${esc(j.id.slice(0, 8))}</td><td>${esc(hostOf(j.url))}</td><td>${esc(j.status)}</td><td>${esc(j.counts?.processed ?? "")}</td><td>${esc(j.linkCount ?? "")}</td><td>${j.done ? "" : `<button class="btn ghost sm" data-stop="${esc(j.id)}">Stop</button>`}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No jobs.</td></tr>`;
  $("devJobs").onclick = e => { const b = e.target.closest("[data-stop]"); if (b) stopJob(b.dataset.stop).then(refreshDev); };
  $("devReqs").innerHTML = (reqs.value?.requests || []).slice(0, 120).map(r => `<tr><td>${new Date(r.time || r.startedAt || Date.now()).toLocaleTimeString([], { hour12: false })}</td><td>${esc(r.method)}</td><td class="mono" style="max-width:520px">${esc(r.path || r.url)}</td><td>${esc(r.status)}</td><td>${esc(r.ms ?? r.durationMs ?? "")}</td></tr>`).join("");
  $("devConfig").textContent = JSON.stringify(cfg.value?.config || cfg.value || {}, null, 2);
}

// ---------------------------------------------------------------- VPN (session wide)
export async function refreshVpnStatus() {
  try {
    const st = await api("/api/vpn/status", { timeoutMs: 8000 }); state.vpn.status = st;
    if (state.session) { const si = await api(`/api/vpn/session?sid=${encodeURIComponent(state.session.id)}`, { timeoutMs: 8000 }); state.vpn.connected = !!si.connected; state.vpn.profile = si.profile || null; state.vpn.info = si; }
    else { state.vpn.connected = false; state.vpn.profile = null; }
  } catch (e) { state.vpn.error = e.message; }
  $("vpnBtn").classList.toggle("on", state.vpn.connected); updateIdentity();
  return state.vpn;
}
export async function connectVpn(profileId, { quiet = false } = {}) {
  const s = await ensureSession();
  const r = await api("/api/vpn/connect", { json: { sessionId: s.id, profileId } });
  state.vpn.connected = true; state.vpn.profile = r.profile || null;
  if (!quiet) toast(`VPN connected · ${r.profile?.name || profileId}`);
  reloadPagesAfterVpn(); $("vpnBtn").classList.toggle("on", true); updateIdentity();
}
export async function disconnectVpn() {
  if (!state.session) return;
  await api("/api/vpn/disconnect", { json: { sessionId: state.session.id } });
  state.vpn.connected = false; state.vpn.profile = null; toast("VPN disconnected"); reloadPagesAfterVpn(); $("vpnBtn").classList.toggle("on", false); updateIdentity();
}
function reloadPagesAfterVpn() { for (const t of state.tabs) if (t.view === "page" && t.url) { if (isRemote(t)) { stopBrowserSession(t).then(() => loadInTab(t, t.url)); } else if (activeTab() === t) loadInTab(t, t.url); else t.needsReload = true; } }
async function renderVpnPanel() {
  const box = $("vpnPanel"); box.innerHTML = `<div class="empty"><div class="spinner"></div></div>`;
  const v = await refreshVpnStatus(); const st = v.status;
  if (!st) { box.innerHTML = `<div class="empty"><svg><use href="#i-vpn"/></svg><b>Veyra VPN is unavailable</b><span>${esc(v.error || "")}</span></div>`; return; }
  const profiles = st.profiles || [];
  const cur = v.profile;
  box.innerHTML = `<div class="vpn-hero"><div class="vpn-orb ${v.connected ? "on" : ""}"><svg><use href="#i-vpn"/></svg></div><div><h2>${v.connected ? "Protected" : "Not connected"}</h2><p class="muted">${v.connected ? `Traffic in this session leaves through <b>${esc(cur?.name || "")}</b>${cur?.region ? ` · ${esc(cur.region)}` : ""}${cur?.health?.exitIp ? ` · exit ${esc(cur.health.exitIp)}` : ""}.` : !st.enabled ? "The VPN is turned off on this server." : !profiles.length ? "No VPN exits are configured on the server yet." : "Choose an exit below. Every tab in this session will use it."}</p></div><span class="spacer"></span>${v.connected ? `<button class="btn ghost" id="vpnRotate">Rotate exit</button><button class="btn danger" id="vpnOff">Disconnect</button>` : ""}</div>
    <div class="s-section"><h2>Exits</h2><p class="muted">${st.killSwitch ? "Kill switch is on: if a tunnel drops, requests are blocked instead of leaking through the server's own IP." : "Kill switch is off on this server."}${st.failover ? " Failover moves you to a healthy exit automatically." : ""}</p>
    <div class="vpn-list">${profiles.map(p => `<div class="vpn-row ${cur?.id === p.id ? "on" : ""}"><span class="pill ${p.health?.healthy === false ? "err" : p.health?.healthy ? "ok" : ""}">${esc(p.protocol || p.type)}</span><div class="n"><b>${esc(p.name)}</b><small>${esc([p.region, p.country, p.provider].filter(Boolean).join(" · ") || "Server exit")}${p.health?.latencyMs ? ` · ${p.health.latencyMs} ms` : ""}</small></div>${cur?.id === p.id ? `<span class="pill ok">Connected</span>` : `<button class="btn ghost sm" data-connect="${esc(p.id)}" ${st.enabled ? "" : "disabled"}>Connect</button>`}<button class="btn ghost sm" data-test="${esc(p.id)}">Test</button></div>`).join("") || `<div class="empty"><span>Set VPN_PROFILES_JSON, WIREGUARD_CONFIG or VPN_PROXY_SERVER on Render to add exits.</span></div>`}</div></div>
    <div class="s-section"><h2>Automatic connection</h2><div class="s-card"><div class="s-row"><div class="s-label"><b>Connect new sessions automatically</b><span>Uses the chosen exit as soon as a session starts.</span></div><div class="s-ctl"><select class="input" id="vpnAuto"><option value="">Off</option>${profiles.map(p => `<option value="${esc(p.id)}" ${settings.vpnAutoProfile === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div></div></div></div>`;
  box.onclick = async e => { const b = e.target.closest("button"); if (!b) return; b.disabled = true;
    try {
      if (b.dataset.connect) await connectVpn(b.dataset.connect);
      else if (b.dataset.test) { const r = await api("/api/vpn/test", { json: { profileId: b.dataset.test }, timeoutMs: 20000 }); toast(`Exit responded${r.exitIp ? ` · IP ${r.exitIp}` : ""}${r.latencyMs ? ` · ${r.latencyMs} ms` : ""}`); }
      else if (b.id === "vpnOff") await disconnectVpn();
      else if (b.id === "vpnRotate") { const r = await api("/api/vpn/rotate", { json: { sessionId: state.session.id } }); toast(`Now using ${r.profile?.name || "a new exit"}`); reloadPagesAfterVpn(); }
    } catch (err) { toast(err.message, { kind: "err" }); }
    renderVpnPanel(); };
  $("vpnAuto").onchange = e => { settings.vpnAutoProfile = e.target.value; saveSettings(); toast(e.target.value ? "New sessions will connect automatically" : "Automatic VPN off"); };
}
export { renderVpnPanel };

// ---------------------------------------------------------------- page messages
function tabForSource(src) {
  for (const t of state.tabs) { const f = frameFor(t); if (!f) continue; let w = src; for (let i = 0; i < 6 && w; i++) { if (w === f.contentWindow) return t; try { if (w === w.parent) break; w = w.parent; } catch { break; } } }
  return null;
}
async function handleMessage(e) {
  const d = e.data; if (!d || typeof d !== "object" || typeof d.type !== "string" || !d.type.startsWith("veyra:")) return;
  if (d.type === "veyra:local-retry") { const t = tabForSource(e.source); if (t) { switchTab(t.id); reload(); } return; }
  if (e.origin !== API_ORIGIN) return;
  const t = tabForSource(e.source) || activeTab(); if (!t) return;
  if (d.type === "veyra:dt-result" || d.type === "veyra:dt-event") { handleBridgeMessage(t, d); return; }
  if (d.type === "veyra:session-expired") { if (state.session && (!d.sessionId || d.sessionId === state.session.id)) endSession("server"); return; }
  if (d.type === "veyra:shortcut") { hooks.handleForwardedShortcut?.(d); return; }
  if (d.type === "veyra:page-console" || d.type === "veyra:page-error") {
    const entry = { time: d.time || Date.now(), level: d.level || "log", message: String(d.message || ""), stack: d.stack || "", url: d.url || "", line: d.line, column: d.column, pageUrl: d.pageUrl, kind: d.type === "veyra:page-error" ? "exception" : "console" };
    t.console.push(entry); if (t.console.length > 2000) t.console.splice(0, t.console.length - 2000);
    hooks.dt?.onConsole(t, entry);
    if (entry.level === "error") addLog("warn", `[page:${hostOf(d.pageUrl || t.url)}] ${entry.message.slice(0, 400)}`);
    return;
  }
  if (d.type === "veyra:browser-network") { t.network.push(d); if (t.network.length > 1500) t.network.splice(0, t.network.length - 1500); hooks.dt?.onNetwork(t, d); return; }
  if (d.type === "veyra:find-result") { const n = Number(d.matches || 0); $("findCount").textContent = n ? `${n} match${n === 1 ? "" : "es"}` : "No matches"; return; }
  if (d.type === "veyra:unsupported") { toast(d.reason || "That action isn't supported through the proxy", { kind: "warn" }); return; }
  if (d.type === "veyra:open" && d.url) { const u = canonical(d.url); if (u) newTab({ url: u, index: state.tabs.indexOf(t) + 1 }); return; }
  if (d.type === "veyra:form" && d.url) { submitForm(t, d); return; }
  if (d.type === "veyra:retry") { if (activeTab() === t) reload(); return; }
  if (d.type === "veyra:navigate" && d.url) {
    const target = canonical(d.url); if (!target) return;
    if (d.title) t.title = String(d.title).slice(0, 200); if (d.favicon) t.favicon = canonical(d.favicon) || "";
    if (String(d.source).startsWith("history.")) { t.url = target; if (d.source === "history.pushState") pushTabHistory(t, target); else if (t.history.length) t.history[t.histIndex] = target; }
    else if (d.source === "document-navigation") {
      const same = t.url && t.url.split("#")[0] === target.split("#")[0];
      if (!same) { pushTabHistory(t, target); t.url = target; recordHistory("page", target, t.title); if (t.jobId && !t.done) stopJob(t.jobId); t.jobId = null; if (!settings.preserveLog) { t.console = []; t.network = []; } hooks.dt?.onNavigate(t); if (state.session) api("/api/open", { json: { url: target, sessionId: state.session.id } }).then(b => { t.jobId = b?.jobId || null; if (t.jobId) startPolling(t); }).catch(() => {}); }
      else { const h = state.history.find(x => x.url === target); if (h && d.title) { h.title = t.title; saveHistory(); } }
    } else { t.url = target; }
    if (activeTab() === t) { updateAddress(); updateIdentity(); syncRoute({ replace: true }); }
    renderTabsSoon();
  }
}
function canonical(value) {
  let raw = String(value || "").trim();
  for (let i = 0; i < 3; i++) {
    try { const u = new URL(raw, API); if (u.origin === API_ORIGIN && /^\/api\/(view|resource|download)$/.test(u.pathname)) { const inner = u.searchParams.get("url"); if (inner) { raw = inner; continue; } } return /^https?:$/.test(u.protocol) ? u.href : ""; }
    catch { return ""; }
  }
  return "";
}
function submitForm(t, msg) {
  if (!state.session) return;
  const f = getOrCreateFrame(t); const form = document.createElement("form"); form.method = "POST"; form.action = proxyUrl(msg.url, "view", state.session.id); form.target = f.name; form.style.display = "none";
  for (const [n, v] of msg.entries || []) form.appendChild(Object.assign(document.createElement("input"), { type: "hidden", name: n, value: v }));
  document.body.appendChild(form); form.submit(); form.remove(); if (activeTab() === t) setLoading(true, 50, "Submitting…");
}
function pushKeybindings(t) { const list = hooks.forwardableCombos?.(); if (list) pageCommand("veyra:keys", { combos: list }, t); }
window.addEventListener("message", e => { handleMessage(e).catch(err => addLog("error", `Message handling failed: ${err.message}`)); });

// ---------------------------------------------------------------- wiring
function wire() {
  $("newTabBtn").onclick = () => newTab();
  $("backBtn").onclick = back; $("forwardBtn").onclick = forward; $("reloadBtn").onclick = () => reload(); $("homeBtn").onclick = goHome;
  $("starBtn").onclick = toggleBookmark; $("zoomChip").onclick = () => setZoom(1);
  $("downloadBtn").onclick = () => openInternal("downloads");
  $("vpnBtn").onclick = () => hooks.openVpnPopover?.($("vpnBtn"));
  $("sessionPill").onclick = () => hooks.openSessionPopover?.($("sessionPill"));
  $("sessionRestart").onclick = async () => { $("sessionOverlay").classList.add("hidden"); try { await ensureSession(); toast("New session started"); } catch (e) { toast(e.message, { kind: "err" }); } const last = state.history.find(h => h.kind === "page"); if (last) { /* offer the last page again */ toast(`Open ${hostOf(last.url)} again?`, { action: () => go(last.url), actionLabel: "Open", ms: 6000 }); } };
  $("sessionHome").onclick = () => { $("sessionOverlay").classList.add("hidden"); goHome(); };
  $("searchForm").onsubmit = e => { e.preventDefault(); const q = $("searchInput").value.trim(); const t = activeTab(); pushTabHistory(t, "veyra:search:" + q); t.searchQuery = q; t.title = q ? `${q} - Veyra Search` : "Veyra Search"; renderTabs(); syncRoute(); runSearch(q); };
  $("searchInput").oninput = e => loadSuggestions(e.target.value);
  $("downloadsFilter").oninput = renderDownloads; $("clearDownloadsBtn").onclick = () => { for (const c of state.downloadControllers.values()) c.abort(); state.downloads = []; saveDownloads(); renderDownloads(); };
  $("historyFilter").oninput = renderHistory; $("clearHistoryBtn").onclick = () => hooks.openClearData?.();
  $("resFilter").oninput = () => renderResources();
  $("sourceCopy").onclick = () => copyText(sourceTab()?._resText || "");
  $("sourcePretty").onclick = () => { const s = sourceTab(); if (!s?._resText) return; s._resText = prettyPrint(s._resText, s._resType); $("sourceCode").innerHTML = highlightCode(s._resText, s._resType); };
  $("linkFilter").oninput = debounceRaf(renderLinks); $("linkScope").onchange = renderLinks; $("linkCopy").onclick = () => copyText((sourceTab()?._links || []).map(l => l.url).join("\n"));
  $("consoleFilter").onchange = renderConsole; $("consoleSearch").oninput = renderConsole; $("clearConsole").onclick = () => { logs.length = 0; renderConsole(); };
  $("copyConsole").onclick = () => copyText(logs.map(x => `[${new Date(x.time).toISOString()}] ${x.level.toUpperCase()} ${x.message}`).join("\n"));
  $("findInput").oninput = e => findQuery(e.target.value);
  $("findInput").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); findQuery(e.target.value, e.shiftKey ? "backward" : "forward"); } else if (e.key === "Escape") { e.preventDefault(); closeFind(); } };
  $("findNext").onclick = () => findQuery($("findInput").value, "forward"); $("findPrev").onclick = () => findQuery($("findInput").value, "backward"); $("findClose").onclick = closeFind;
  document.addEventListener("click", e => { const a = e.target.closest("[data-go]"); if (a) { e.preventDefault(); $("authDialog").open && $("authDialog").close(); goRoute(a.dataset.go); } const r = e.target.closest("a[data-route]"); if (r) { e.preventDefault(); goRoute(r.dataset.route); } });
  setupCalculator();
  window.addEventListener("error", e => addLog("error", `UI error: ${e.message}`));
  window.addEventListener("unhandledrejection", e => addLog("error", `Unhandled: ${e.reason?.message || e.reason}`));
  document.addEventListener("visibilitychange", () => { const t = activeTab(); if (!document.hidden && t?.needsReload && t.url) { t.needsReload = false; loadInTab(t, t.url); } });
}

// Public API used by ui.js and devtools.js
export const B = {
  state, INTERNAL, activeTab, tabById, newTab, closeTab, switchTab, cycleTab, selectTabIndex, reopenClosedTab, duplicateTab, go, navigate, openInternal,
  renderActive, renderTabs, updateIdentity, showSearch, back, forward, reload, stopLoad, goHome, toggleBookmark, openFind, closeFind, printPage, setZoom, zoomStep,
  ensureSession, endSession, sessionRemaining, startDownload, clearBrowsingData, recordHistory, refreshVpnStatus, connectVpn, disconnectVpn, renderVpnPanel,
  omniSuggest, classify, goRoute, showLanding, pageCommand, evaluate, prettyPrint, highlightCode, saveBookmarks, saveHistory, getOrCreateFrame, setLoading
};
hooks.B = B;

// On startup: open a page or restore last tabs (only for a bare /browse entry)
function applyStartup(params) {
  if (currentRoute() !== "/browse" || params.get("url") || params.get("q") || location.hash) return;
  if (settings.startup === "url" && settings.startupUrl) { go(settings.startupUrl, { tab: activeTab(), push: false }); return; }
  if (settings.startup === "continue") {
    const urls = load("veyra-last-tabs", []).filter(u => /^https?:/.test(u)).slice(0, 8);
    urls.forEach((u, i) => i === 0 ? go(u, { tab: activeTab(), push: false }) : newTab({ url: u, background: true }));
  }
}
setInterval(() => { if (settings.startup === "continue") save("veyra-last-tabs", state.tabs.filter(t => t.view === "page" && t.url).map(t => t.url)); }, 3000);

async function boot() {
  try {
    wire();
    const params = new URLSearchParams(location.search);
    const r = params.get("veyra_route"); if (r) try { history.replaceState({}, "", APP_BASE + (r.startsWith("/") ? r : "/" + r)); } catch {}
    const t = makeTab(); state.tabs.push(t); state.activeId = t.id;
    initUI(B); initDevtools(B);
    renderTabs(); tickSession();
    applyRoute();
    applyStartup(params);
    api("/api/auth/config", { timeoutMs: 10000 }).then(c => { auth.config = c; auth.admin = !!c.admin; state.serverLimitMs = Number(c.sessionTimeLimitMs) || 0; tickSession(); hooks.onAuthChanged?.(); if ((currentRoute() === "/dev" || location.hash === "#console") && !isAdmin()) applyRoute(); if (activeTab()?.view === "newtab") hooks.renderNewTab?.(); }).catch(e => addLog("warn", `Backend unreachable: ${e.message}`));
    addLog("info", `Veyra ${VERSION} ready · API ${API}`);
  } catch (e) { $("fatalOverlay").classList.remove("hidden"); $("fatalMessage").textContent = e.stack || e.message; console.error(e); }
}
boot();
