// Veyra UI chrome: landing + auth, new tab page, omnibox, menus, popovers, shortcuts, sync.
import {
  API, $, qsa, esc, hostOf, displayUrl, uid, fmtClock, timeAgo, letterIcon, debounce, isMac, settings, saveSettings, load, save,
  api, auth, setAuth, isAdmin, hooks, toast, promptDialog, openFloating, closeFloating, engineName, addLog, copyText, VERSION
} from "./core.js";
import { initExtensions } from "./extensions.js";
import { initSettings } from "./settings.js";

let B;

// ================================================================ theme
export function applyTheme() {
  let t = settings.theme || "dark"; if (t === "system") t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  const root = document.documentElement; root.dataset.theme = t;
  if (settings.accent) root.style.setProperty("--accent", settings.accent); else root.style.removeProperty("--accent");
  root.style.setProperty("--ui-scale", settings.fontScale || 1);
  document.body.classList.toggle("compact", !!settings.compact || !!load("veyra-extensions", {}).compact);
  document.body.classList.toggle("reduce-motion", !!settings.reduceMotion);
  document.body.classList.toggle("focus-rings", !!settings.focusRings);
  document.body.classList.toggle("link-underline", !!settings.linkUnderline);
  $("bookmarksBar").classList.toggle("hidden", !settings.showBookmarksBar);
  $("homeBtn").classList.toggle("hidden", !settings.showHomeButton);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "light" ? "#f6f7f9" : "#0d0f13");
}
matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => settings.theme === "system" && applyTheme());

// ================================================================ shortcuts
// Each command has default combos. "Mod" is Cmd on macOS and Ctrl elsewhere.
export const COMMANDS = [
  { id: "newTab", label: "New tab", group: "Tabs", keys: ["Mod+T", "Alt+T"], run: () => B.newTab() },
  { id: "closeTab", label: "Close tab", group: "Tabs", keys: ["Mod+W", "Alt+W"], run: () => B.closeTab(B.state.activeId) },
  { id: "reopenTab", label: "Reopen closed tab", group: "Tabs", keys: ["Mod+Shift+T"], run: () => B.reopenClosedTab() },
  { id: "nextTab", label: "Next tab", group: "Tabs", keys: ["Mod+Tab", "Mod+PageDown"], run: () => B.cycleTab(1) },
  { id: "prevTab", label: "Previous tab", group: "Tabs", keys: ["Mod+Shift+Tab", "Mod+PageUp"], run: () => B.cycleTab(-1) },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ id: "tab" + n, label: `Go to tab ${n}`, group: "Tabs", keys: [`Mod+${n}`], run: () => B.selectTabIndex(n), hidden: n > 1 })),
  { id: "lastTab", label: "Go to last tab", group: "Tabs", keys: ["Mod+9"], run: () => B.selectTabIndex(9) },
  { id: "address", label: "Focus address bar", group: "Navigation", keys: ["Mod+L", "Alt+D", "F6"], run: focusAddress },
  { id: "reload", label: "Reload", group: "Navigation", keys: ["Mod+R", "F5"], run: () => B.reload() },
  { id: "hardReload", label: "Hard reload", group: "Navigation", keys: ["Mod+Shift+R"], run: () => B.reload({ hard: true }) },
  { id: "back", label: "Back", group: "Navigation", keys: ["Alt+Left"], run: () => B.back() },
  { id: "forward", label: "Forward", group: "Navigation", keys: ["Alt+Right"], run: () => B.forward() },
  { id: "home", label: "Home", group: "Navigation", keys: ["Alt+Home"], run: () => B.goHome() },
  { id: "stop", label: "Stop loading", group: "Navigation", keys: ["Esc"], run: escape },
  { id: "find", label: "Find in page", group: "Page", keys: ["Mod+F"], run: () => B.openFind() },
  { id: "print", label: "Print page", group: "Page", keys: ["Mod+P"], run: () => B.printPage() },
  { id: "bookmark", label: "Bookmark this tab", group: "Page", keys: ["Mod+D"], run: () => B.toggleBookmark() },
  { id: "zoomIn", label: "Zoom in", group: "Page", keys: ["Mod+=", "Mod+Shift+="], run: () => B.zoomStep(1) },
  { id: "zoomOut", label: "Zoom out", group: "Page", keys: ["Mod+-"], run: () => B.zoomStep(-1) },
  { id: "zoomReset", label: "Reset zoom", group: "Page", keys: ["Mod+0"], run: () => B.zoomStep(0) },
  { id: "downloads", label: "Downloads", group: "Veyra", keys: ["Mod+J"], run: () => B.openInternal("downloads") },
  { id: "history", label: "History", group: "Veyra", keys: ["Mod+H"], run: () => B.openInternal("history") },
  { id: "bookmarksBar", label: "Show bookmarks bar", group: "Veyra", keys: ["Mod+Shift+B"], run: () => { settings.showBookmarksBar = !settings.showBookmarksBar; saveSettings(); } },
  { id: "search", label: "Veyra Search", group: "Veyra", keys: ["Mod+K"], run: () => B.showSearch("") },
  { id: "vpn", label: "Veyra VPN", group: "Veyra", keys: ["Mod+Shift+V"], run: () => B.openInternal("vpn") },
  { id: "settings", label: "Settings", group: "Veyra", keys: ["Mod+,"], run: () => B.openInternal("settings") },
  { id: "clearData", label: "Clear browsing data", group: "Veyra", keys: ["Mod+Shift+Delete"], run: () => openClearData() },
  { id: "devtools", label: "Developer tools", group: "Developer", keys: ["Mod+Shift+I", "F12"], run: () => hooks.dt?.toggle() },
  { id: "console", label: "DevTools console", group: "Developer", keys: ["Mod+Shift+J"], run: () => hooks.dt?.open("console") },
  { id: "picker", label: "Inspect element", group: "Developer", keys: ["Mod+Shift+C"], run: () => hooks.dt?.inspect() },
  { id: "viewSource", label: "View source resources", group: "Developer", keys: ["Mod+U"], run: () => B.openInternal("resources") }
];
export const cmd = id => COMMANDS.find(c => c.id === id);
export function keysFor(id) { const o = settings.shortcuts?.[id]; return Array.isArray(o) ? o : cmd(id)?.keys || []; }
export function prettyCombo(c) { return String(c).replace(/Mod/g, isMac ? "⌘" : "Ctrl").replace(/Alt/g, isMac ? "⌥" : "Alt").replace(/Shift\+=/, "Shift+=").replace(/\+(?=.)/g, isMac ? "" : "+").replace(/^⌘(.)/, "⌘$1"); }
export const kbdFor = id => { const k = keysFor(id)[0]; return k ? prettyCombo(k) : ""; };
const CODE_KEYS = { Equal: "=", NumpadAdd: "=", Minus: "-", NumpadSubtract: "-", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backquote: "`", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Escape: "Esc", Numpad0: "0" };
export function comboFromEvent(e) {
  const code = e.code || ""; let key;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^Numpad\d$/.test(code)) key = code.slice(6);
  else if (CODE_KEYS[code]) key = CODE_KEYS[code];
  else if (/^(F\d{1,2}|Tab|PageUp|PageDown|Home|End|Delete|Backspace|Enter|Space|Insert)$/.test(code)) key = code;
  else { const k = String(e.key || ""); key = k.length === 1 ? k.toUpperCase() : ({ Escape: "Esc", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", "+": "=" }[k] || k); }
  if (["Control", "Meta", "Shift", "Alt", "ControlLeft", "ShiftLeft", "AltLeft", "MetaLeft", "ControlRight", "ShiftRight", "AltRight", "MetaRight", "OS"].includes(key) || !key) return "";
  const mod = isMac ? e.metaKey : e.ctrlKey; const parts = [];
  if (mod) parts.push("Mod"); if (isMac && e.ctrlKey) parts.push("Ctrl"); if (!isMac && e.metaKey) parts.push("Meta");
  if (e.altKey) parts.push("Alt"); if (e.shiftKey) parts.push("Shift"); parts.push(key);
  return parts.join("+");
}
function commandForCombo(combo) { if (!combo) return null; return COMMANDS.find(c => keysFor(c.id).includes(combo)) || null; }
function isEditable(el) { return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); }
export let recordingShortcut = null; export function setRecording(fn) { recordingShortcut = fn; }
function runCombo(combo, { fromPage = false, editable = false } = {}) {
  if (!$("landing").classList.contains("hidden")) return false;
  const c = commandForCombo(combo); if (!c) return false;
  const bare = !/Mod|Alt|Ctrl|Meta/.test(combo) && !/^F\d/.test(combo) && combo !== "Esc";
  if (bare) return false;
  if (editable && ["back", "forward"].includes(c.id)) return false;
  if (c.id === "stop" && editable && !fromPage) return false;
  try { c.run(); } catch (err) { addLog("error", `Shortcut ${c.id} failed: ${err.message}`); }
  return true;
}
function onKeyDown(e) {
  if (recordingShortcut) { e.preventDefault(); e.stopPropagation(); const combo = comboFromEvent(e); if (combo) recordingShortcut(combo, e); return; }
  if (e.defaultPrevented) return;
  const combo = comboFromEvent(e);
  if (combo === "Esc") { if (escape()) e.preventDefault(); return; }
  if (runCombo(combo, { editable: isEditable(e.target) })) { e.preventDefault(); e.stopPropagation(); }
}
function escape() {
  if (!$("mainMenu").classList.contains("hidden") || !$("popover").classList.contains("hidden") || !$("ctxMenu").classList.contains("hidden")) { closeFloating(); return true; }
  if (!$("omniPop").classList.contains("hidden")) { hideOmni(); B.updateIdentity(); return true; }
  if (hooks.dt?.cancelPicking?.()) return true;
  if (!$("findBar").classList.contains("hidden")) { B.closeFind(); return true; }
  if ($("reloadBtn").dataset.loading === "1") { B.stopLoad(); return true; }
  const t = B.activeTab(); if (t?.readerOpen) { hooks.closeReader?.(); return true; }
  return false;
}
hooks.handleForwardedShortcut = d => { const combo = comboFromEvent(d); runCombo(combo, { fromPage: true }); };
hooks.forwardableCombos = () => COMMANDS.flatMap(c => keysFor(c.id));
function focusAddress() { const a = $("address"); if (B.activeTab()?.view === "newtab" && document.activeElement !== a) { $("ntpInput")?.focus(); return; } a.focus(); a.select(); }

// ================================================================ landing
const EXPLORE = [
  { url: "https://en.wikipedia.org/wiki/Cardiff", title: "Wikipedia", sub: "The free encyclopedia, fully rewritten through the proxy.", cat: "Reference" },
  { url: "https://news.ycombinator.com", title: "Hacker News", sub: "Tech news and discussion, with working logins and votes.", cat: "News" },
  { url: "https://www.bbc.co.uk/news", title: "BBC News", sub: "Headlines from the UK and around the world.", cat: "News" },
  { url: "https://github.com/trending", title: "GitHub Trending", sub: "Repositories developers are starring today.", cat: "Developer" },
  { url: "https://developer.mozilla.org/en-US/", title: "MDN Web Docs", sub: "Try the DevTools on the docs that explain them.", cat: "Developer" },
  { url: "https://www.youtube.com", title: "YouTube", sub: "Opens in a streamed Chromium tab for full app support.", cat: "Video" },
  { url: "https://www.reddit.com", title: "Reddit", sub: "Communities and threads, in a session that forgets you.", cat: "Social" },
  { url: "https://archive.org", title: "Internet Archive", sub: "Books, films and the Wayback Machine.", cat: "Reference" }
];
const FAQ = [
  ["What is Veyra?", "Veyra is a browser that runs on a server. When you open a site, Veyra's server fetches it, rewrites it so every link and request stays inside Veyra, and shows it to you. Heavy web apps get a real Chromium tab that's streamed to your screen."],
  ["Why do sessions only last two minutes?", "Short sessions keep the server light and keep your traffic disposable. When the timer reaches 0:00, the server deletes the session's cookies, crawl jobs, Chromium context and VPN tunnel. You can start a new one straight away."],
  ["Do I need an account?", "No. Guests can browse freely. An account syncs your settings, bookmarks, shortcuts, new tab tiles and extensions between devices."],
  ["Is Veyra a VPN?", "Veyra VPN sends a session's traffic through WireGuard, SOCKS5 or HTTP exits that the server operator configures. It has region pools, automatic failover and a kill switch. Your own device's connection isn't changed, only what Veyra fetches for you."],
  ["Which sites don't work?", "Most sites work in the fast proxy. Some apps need the Chromium engine, which Veyra picks automatically. Video services that check for residential IP addresses may still refuse playback from a data centre."],
  ["Can I use developer tools?", "Yes. Press F12 or Ctrl+Shift+I for Elements, Console, Sources, Network, Application and Performance panels that work against the proxied page. You can edit CSS and DOM live, run JavaScript and inspect requests."],
  ["What data do you keep?", "Session data is deleted when the session ends. History and downloads live in your own browser's storage and can be cleared at any time. If you sign in, synced settings are stored on the server until you delete your account."]
];
function renderLanding() {
  $("exploreGrid").innerHTML = EXPLORE.map(x => { const li = letterIcon(x.url); return `<button class="explore-card" data-explore="${esc(x.url)}"><span class="ico" style="background:${li.color}">${esc(li.letter)}</span><b>${esc(x.title)}</b><span>${esc(x.sub)}</span><span class="cat">${esc(x.cat)}</span></button>`; }).join("");
  $("faqList").innerHTML = FAQ.map(([q, a], i) => `<details class="faq-item" ${i === 0 ? "open" : ""}><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("");
  renderLandActions();
}
hooks.renderLanding = renderLanding;
function renderLandActions() {
  const box = $("landActions");
  box.innerHTML = auth.user
    ? `<span class="acct-chip"><span class="avatar signed" style="width:28px;height:28px">${esc(initials())}</span>${esc(auth.user.name || auth.user.email)}</span><button class="btn primary" data-go="/browse">Open browser</button>`
    : `<button class="btn ghost" data-auth="login">Sign in</button><button class="btn primary" data-auth="signup">Create account</button>`;
}
const initials = () => { const n = auth.user?.name || auth.user?.email || ""; return (n.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(s => s[0]).join("") || "?").toUpperCase(); };

// ================================================================ auth
let authMode = "login";
export function openAuth(mode = "login") {
  authMode = mode; const dlg = $("authDialog"); const f = $("authForm");
  qsa(".seg button", f).forEach(b => b.classList.toggle("on", b.dataset.mode === mode));
  $("authTitle").textContent = mode === "signup" ? "Create your Veyra account" : "Welcome back";
  $("authSub").textContent = mode === "signup" ? "Sync settings, bookmarks, shortcuts and extensions across devices." : "Sign in to sync your Veyra settings.";
  $("authNameRow").classList.toggle("hidden", mode !== "signup");
  $("authSubmit").textContent = mode === "signup" ? "Create account" : "Sign in";
  f.password.autocomplete = mode === "signup" ? "new-password" : "current-password";
  $("authError").textContent = "";
  if (auth.config && auth.config.signupEnabled === false && mode === "signup") $("authError").textContent = "Sign-ups are turned off on this server.";
  if (!dlg.open) dlg.showModal(); setTimeout(() => (mode === "signup" ? f.name : f.email).focus(), 30);
}
async function submitAuth(e) {
  e.preventDefault(); const f = $("authForm"); const err = $("authError");
  const email = f.email.value.trim(), password = f.password.value, name = f.name.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = "Enter a valid email address."; f.email.focus(); return; }
  if (authMode === "signup" && !(password.length >= 8 && /[a-z]/i.test(password) && /\d/.test(password))) { err.textContent = "Use at least 8 characters with a letter and a number."; f.password.focus(); return; }
  if (!password) { err.textContent = "Enter your password."; f.password.focus(); return; }
  const btn = $("authSubmit"); btn.disabled = true; btn.textContent = authMode === "signup" ? "Creating account…" : "Signing in…"; err.textContent = "";
  try {
    const r = await api(`/api/auth/${authMode}`, { json: authMode === "signup" ? { email, password, name } : { email, password } });
    setAuth(r.token, r.user); auth.admin = r.user?.role === "admin";
    f.reset(); $("authDialog").close();
    await pullSync({ initial: authMode === "login" });
    if (authMode === "signup") await pushSync();
    onAuthChanged();
    toast(authMode === "signup" ? `Welcome to Veyra, ${r.user.name || r.user.email}` : `Signed in as ${r.user.email}`);
    if (!$("landing").classList.contains("hidden")) B.goRoute("/browse");
  } catch (ex) { err.textContent = ex.message; }
  finally { btn.disabled = false; btn.textContent = authMode === "signup" ? "Create account" : "Sign in"; }
}
export async function signOut({ everywhere = false } = {}) {
  try { await api("/api/auth/logout", { json: { everywhere } }); } catch {}
  setAuth("", null); auth.admin = false;
  try { const c = await api("/api/auth/config"); auth.config = c; auth.admin = !!c.admin; } catch {}
  onAuthChanged(); toast("Signed out");
  const v = B.activeTab()?.view; if (v === "dev" || v === "console") B.goHome();
}
function onAuthChanged() {
  const a = $("profileBtn"); a.classList.toggle("signed", !!auth.user);
  $("avatarText").innerHTML = auth.user ? esc(initials()) : `<svg><use href="#i-user"/></svg>`;
  a.title = auth.user ? `${auth.user.name || ""} ${auth.user.email}`.trim() : "Sign in";
  renderLandActions(); B.updateIdentity();
  if (B.activeTab()?.view === "settings") hooks.renderSettings?.(B.activeTab().section);
  if (B.activeTab()?.view === "newtab") renderNewTab();
}
hooks.onAuthChanged = onAuthChanged;

// Settings sync (signed-in users). Admin token and local-only data never leave the device.
let syncing = false;
function syncPayload() { const s = { ...settings }; delete s.adminToken; return { v: 1, settings: s, bookmarks: B.state.bookmarks.slice(0, 300), extensions: load("veyra-extensions", {}), devExtensions: load("veyra-dev-extensions", []).slice(0, 20), notes: load("veyra-notes", {}), savedAt: Date.now() }; }
export async function pushSync() {
  if (!auth.token) return; try { let body = syncPayload(); if (JSON.stringify(body).length > 60000) { body.notes = {}; body.devExtensions = []; } await api("/api/auth/data", { method: "PUT", json: { data: body } }); hooks.lastSync = Date.now(); } catch (e) { addLog("warn", `Sync failed: ${e.message}`); }
}
const pushSoon = debounce(pushSync, 1500);
hooks.scheduleSync = () => { if (auth.token && !syncing) pushSoon(); };
export async function pullSync() {
  if (!auth.token) return;
  try {
    const r = await api("/api/auth/data"); const d = r.data; if (!d || typeof d !== "object") return;
    syncing = true;
    if (d.settings) { const keep = settings.adminToken; Object.assign(settings, d.settings, { adminToken: keep }); save("veyra-settings", settings); }
    if (Array.isArray(d.bookmarks)) { B.state.bookmarks = d.bookmarks.filter(b => b?.url); save("veyra-bookmarks", B.state.bookmarks); }
    if (d.extensions) save("veyra-extensions", d.extensions);
    if (Array.isArray(d.devExtensions)) save("veyra-dev-extensions", d.devExtensions);
    if (d.notes) save("veyra-notes", d.notes);
    applyTheme(); B.renderActive({ push: false }); hooks.lastSync = Date.now();
  } catch (e) { addLog("warn", `Couldn't load synced data: ${e.message}`); }
  finally { syncing = false; }
}
async function verifyAuth() {
  if (!auth.token) return;
  try { const r = await api("/api/auth/me"); setAuth(auth.token, r.user); auth.admin = r.user?.role === "admin" || auth.admin; onAuthChanged(); }
  catch (e) { if (e.status === 401) { setAuth("", null); onAuthChanged(); } }
}

// ================================================================ new tab page
const DEFAULT_TILES = [
  { url: "https://en.wikipedia.org", title: "Wikipedia" }, { url: "https://news.ycombinator.com", title: "Hacker News" },
  { url: "https://github.com", title: "GitHub" }, { url: "https://www.bbc.co.uk/news", title: "BBC News" },
  { url: "https://developer.mozilla.org", title: "MDN" }, { url: "https://www.youtube.com", title: "YouTube" }
];
const tiles = () => Array.isArray(settings.ntpTiles) ? settings.ntpTiles : DEFAULT_TILES;
function renderNewTab() {
  const now = new Date(); const h = now.getHours();
  $("ntpClock").textContent = settings.ntpClock ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const name = auth.user?.name ? `, ${auth.user.name.split(" ")[0]}` : "";
  $("ntpGreeting").textContent = settings.ntpClock ? `${h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"}${name}` : "";
  $("ntpEngine").textContent = engineName();
  const list = tiles();
  $("ntpTiles").classList.toggle("hidden", !settings.ntpShortcuts);
  $("ntpTiles").innerHTML = list.map((t, i) => { const li = letterIcon(t.url); return `<div class="tile" role="link" tabindex="0" data-i="${i}" title="${esc(t.url)}"><span class="tile-ico" style="background:${li.color};color:#fff">${esc(li.letter)}</span><span>${esc(t.title || hostOf(t.url))}</span><button class="icon-btn sm tile-edit" data-edit="${i}" title="Edit shortcut" aria-label="Edit shortcut"><svg><use href="#i-menu"/></svg></button></div>`; }).join("")
    + (list.length < 12 ? `<button class="tile add" id="tileAdd"><span class="tile-ico"><svg><use href="#i-plus"/></svg></span><span>Add shortcut</span></button>` : "");
  $("ntpTiles").onclick = e => {
    const ed = e.target.closest("[data-edit]"); if (ed) { e.stopPropagation(); editTile(Number(ed.dataset.edit), ed); return; }
    if (e.target.closest("#tileAdd")) { editTile(-1); return; }
    const t = e.target.closest(".tile[data-i]"); if (t) B.go(list[Number(t.dataset.i)].url, { newTab: e.ctrlKey || e.metaKey });
  };
  $("ntpTiles").onkeydown = e => { const t = e.target.closest(".tile[data-i]"); if (t && e.key === "Enter") B.go(list[Number(t.dataset.i)].url); };
  $("ntpRecentCard").classList.toggle("hidden", !settings.ntpRecent);
  const recent = B.state.history.filter(x => x.kind === "page").filter((x, i, a) => a.findIndex(y => hostOf(y.url) === hostOf(x.url)) === i).slice(0, 6);
  $("ntpRecent").innerHTML = recent.map(r => { const li = letterIcon(r.url); return `<button class="recent-row" data-url="${esc(r.url)}"><b style="display:grid;place-items:center;width:18px;height:18px;border-radius:5px;background:${li.color};color:#fff;font-size:10px;flex:none">${esc(li.letter)}</b><span class="t">${esc(r.title || hostOf(r.url))}</span><time>${esc(timeAgo(r.time))}</time></button>`; }).join("") || `<p class="muted" style="margin:6px 8px">Sites you visit will show up here.</p>`;
  $("ntpRecent").onclick = e => { const b = e.target.closest("[data-url]"); if (b) B.go(b.dataset.url); };
  renderNtpSession();
}
hooks.renderNewTab = renderNewTab;
function renderNtpSession(left = B?.sessionRemaining()) {
  const box = $("ntpSession"); if (!box || B.activeTab()?.view !== "newtab") return;
  const s = B.state.session, limit = s?.limitMs || B.state.serverLimitMs;
  if (!limit) { box.innerHTML = `<p class="muted">Sessions on this server don't expire.</p>`; return; }
  const frac = s ? left / limit : 1; const off = (125.6 * (1 - frac)).toFixed(1);
  const vpn = B.state.vpn.connected ? `VPN · ${esc(B.state.vpn.profile?.name || "on")}` : "VPN off";
  if (!box.querySelector(".timer-ring") || box.dataset.state !== (s ? "live" : "idle")) {
    box.dataset.state = s ? "live" : "idle";
    box.innerHTML = `<div style="display:flex;gap:16px;align-items:center"><div class="timer-ring"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"/></svg><span></span></div><div><b class="ntp-s-title"></b><p class="muted ntp-s-sub" style="margin:2px 0 8px"></p><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn ghost sm" id="ntpEnd">End session now</button><button class="btn ghost sm" data-go="/vpn">${vpn}</button></div></div></div>`;
    $("ntpEnd").onclick = () => B.endSession("manual");
  }
  const ring = box.querySelector(".timer-ring"); ring.style.setProperty("--off", off); ring.querySelector("span").textContent = fmtClock(s ? left : limit);
  ring.querySelector("circle").style.stroke = s && left <= 10000 ? "var(--err)" : s && left <= 30000 ? "var(--warn)" : "";
  box.querySelector(".ntp-s-title").textContent = s ? "Session running" : "No session yet";
  box.querySelector(".ntp-s-sub").textContent = s ? `ID ${s.id.slice(0, 8)} · deleted at 0:00` : `A ${fmtClock(limit)} session starts when you open a site.`;
  $("ntpEnd").classList.toggle("hidden", !s);
}
hooks.onSessionTick = left => renderNtpSession(left);
hooks.onSessionChanged = () => { if (B.activeTab()?.view === "newtab") renderNewTab(); B.refreshVpnStatus?.().catch(() => {}); };
async function editTile(i, anchor) {
  const list = [...tiles()]; const cur = list[i] || { url: "", title: "" };
  const r = await promptDialog({ title: i < 0 ? "Add shortcut" : "Edit shortcut", ok: i < 0 ? "Add" : "Save", fields: [{ name: "title", label: "Name", value: cur.title }, { name: "url", label: "URL", value: cur.url, placeholder: "https://example.com", required: true }] });
  if (!r) return;
  let url = r.url.trim(); if (!url) return; if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try { new URL(url); } catch { toast("That URL isn't valid", { kind: "err" }); return; }
  const tile = { url, title: r.title.trim() || hostOf(url) };
  if (i < 0) list.push(tile); else list[i] = tile;
  settings.ntpTiles = list; saveSettings(); renderNewTab();
  if (i >= 0) toast("Shortcut saved", { action: async () => { const L = [...tiles()]; L.splice(i, 1); settings.ntpTiles = L; saveSettings(); renderNewTab(); }, actionLabel: "Remove it" });
}

// ================================================================ omnibox
let omniItems = [], omniSel = -1, omniSeq = 0;
function hideOmni() { $("omniPop").classList.add("hidden"); omniItems = []; omniSel = -1; }
async function updateOmni(q) {
  const seq = ++omniSeq; q = q.trim(); if (!q) return hideOmni();
  const low = q.toLowerCase(); const items = [];
  const r = B.classify(q);
  if (r?.kind === "url") items.push({ icon: "i-globe", t: r.url, u: "Open address", v: r.url });
  else if (r?.kind === "calc") { try { items.push({ icon: "i-calc", t: `= ${B.evaluate(q)}`, u: "Calculator", v: q }); } catch {} }
  items.push({ icon: "i-search", t: q, u: `${engineName()} search`, v: q, search: true });
  for (const b of B.state.bookmarks) if ((b.title + b.url).toLowerCase().includes(low) && items.length < 7) items.push({ icon: "i-star", t: b.title, u: displayUrl(b.url), v: b.url });
  const seen = new Set(items.map(i => i.v));
  for (const h of B.state.history) if (h.kind === "page" && !seen.has(h.url) && (h.title + h.url).toLowerCase().includes(low) && items.length < 9) { seen.add(h.url); items.push({ icon: "i-history", t: h.title, u: displayUrl(h.url), v: h.url }); }
  renderOmni(items);
  const sug = await B.omniSuggest(q); if (seq !== omniSeq) return;
  for (const s of sug) if (!seen.has(s) && s.toLowerCase() !== low && items.length < 12) items.push({ icon: "i-search", t: s, u: "Suggestion", v: s, search: true });
  renderOmni(items);
}
function renderOmni(items) {
  omniItems = items; const pop = $("omniPop"); if (!items.length || document.activeElement !== $("address")) return hideOmni();
  pop.innerHTML = items.map((it, i) => `<div class="omni-item ${i === omniSel ? "on" : ""}" role="option" data-i="${i}"><svg><use href="#${it.icon}"/></svg><span class="t">${esc(it.t)}</span><span class="u">${esc(it.u)}</span></div>`).join("");
  pop.classList.remove("hidden");
}
function wireOmnibox() {
  const a = $("address");
  a.addEventListener("focus", () => { a.select(); $("omnibox").classList.add("focus"); });
  a.addEventListener("blur", () => { $("omnibox").classList.remove("focus"); setTimeout(hideOmni, 150); });
  a.addEventListener("input", () => { omniSel = -1; updateOmni(a.value); });
  a.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { if (!omniItems.length) return; e.preventDefault(); omniSel = (omniSel + (e.key === "ArrowDown" ? 1 : -1) + omniItems.length + 1) % (omniItems.length + 1) - (0); if (omniSel >= omniItems.length) omniSel = -1; renderOmni(omniItems); if (omniSel >= 0) a.value = omniItems[omniSel].search ? omniItems[omniSel].v : omniItems[omniSel].v; return; }
    if (e.key === "Enter") { e.preventDefault(); const it = omniItems[omniSel]; const v = it ? it.v : a.value; hideOmni(); a.blur(); if (e.altKey || e.metaKey && !isMac) B.go(v, { newTab: true }); else B.go(v); return; }
    if (e.key === "Escape") { e.preventDefault(); hideOmni(); a.value = ""; B.updateIdentity(); B.renderActive({ push: false }); a.select(); }
  });
  $("omniPop").addEventListener("mousedown", e => { const el = e.target.closest("[data-i]"); if (!el) return; e.preventDefault(); const it = omniItems[Number(el.dataset.i)]; hideOmni(); a.blur(); B.go(it.v); });
  $("ntpForm").onsubmit = e => { e.preventDefault(); const v = $("ntpInput").value.trim(); if (v) { $("ntpInput").value = ""; B.go(v); } };
  $("heroForm").onsubmit = e => { e.preventDefault(); const v = $("heroInput").value.trim(); B.goRoute(v ? `/browse?q=${encodeURIComponent(v)}` : "/browse"); };
}

// ================================================================ bookmarks bar
function renderBookmarksBar() {
  const bar = $("bookmarksBar"); if (!settings.showBookmarksBar) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  bar.innerHTML = B.state.bookmarks.length ? B.state.bookmarks.map((b, i) => { const li = letterIcon(b.url); return `<button class="bm" data-i="${i}" title="${esc(b.title)}\n${esc(b.url)}"><b style="display:grid;place-items:center;width:14px;height:14px;border-radius:4px;background:${li.color};color:#fff;font-size:9px">${esc(li.letter)}</b><span>${esc(b.title || hostOf(b.url))}</span></button>`; }).join("")
    : `<span class="muted" style="font-size:.84em;padding:0 10px">Bookmark pages with ${esc(kbdFor("bookmark"))} and they'll appear here.</span>`;
  bar.onclick = e => { const b = e.target.closest("[data-i]"); if (b) B.go(B.state.bookmarks[Number(b.dataset.i)].url, { newTab: e.ctrlKey || e.metaKey }); };
  bar.onauxclick = e => { const b = e.target.closest("[data-i]"); if (b && e.button === 1) B.newTab({ url: B.state.bookmarks[Number(b.dataset.i)].url, background: true }); };
  bar.oncontextmenu = e => { const el = e.target.closest("[data-i]"); if (!el) return; e.preventDefault(); const i = Number(el.dataset.i), bm = B.state.bookmarks[i];
    import("./core.js").then(({ ctxMenu }) => ctxMenu(e.clientX, e.clientY, [
      { label: "Open in new tab", action: () => B.newTab({ url: bm.url }) },
      { label: "Edit…", action: async () => { const r = await promptDialog({ title: "Edit bookmark", fields: [{ name: "title", label: "Name", value: bm.title }, { name: "url", label: "URL", value: bm.url }] }); if (r) { bm.title = r.title; bm.url = r.url; B.saveBookmarks(); renderBookmarksBar(); } } },
      { label: "Copy link", action: () => copyText(bm.url) }, "-",
      { label: "Delete", action: () => { B.state.bookmarks.splice(i, 1); B.saveBookmarks(); renderBookmarksBar(); B.updateIdentity(); } }])); };
}
hooks.renderBookmarksBar = renderBookmarksBar;

// ================================================================ main menu
function menuItem(icon, label, id, action, { kbd = "", badge = "", disabled = false } = {}) { return { icon, label, id, action, kbd: kbd || (id ? kbdFor(id) : ""), badge, disabled }; }
function openMainMenu() {
  const t = B.activeTab(); const m = $("mainMenu"); const onPage = t?.view === "page" && !!t.url;
  const zoom = onPage ? t.zoom : settings.fontScale || 1;
  const items = [
    menuItem("i-tab", "New tab", "newTab", () => B.newTab()),
    menuItem("i-search", "New Veyra tab", "search", () => B.newTab({ view: "search" }), { kbd: " " }),
    "-",
    menuItem("i-history", "History", "history", () => B.openInternal("history")),
    menuItem("i-download", "Downloads", "downloads", () => B.openInternal("downloads")),
    menuItem("i-star", settings.showBookmarksBar ? "Hide bookmarks bar" : "Show bookmarks bar", "bookmarksBar", () => { settings.showBookmarksBar = !settings.showBookmarksBar; saveSettings(); }),
    "zoom",
    menuItem("i-printer", "Print page", "print", () => B.printPage()),
    menuItem("i-find", "Find in page", "find", () => B.openFind(), { disabled: !onPage }),
    "-",
    menuItem("i-vpn", "Veyra VPN", "vpn", () => B.openInternal("vpn"), { badge: B.state.vpn.connected ? "ON" : "" }),
    menuItem("i-puzzle", "Extensions", "", () => B.openInternal("extensions")),
    menuItem("i-calc", "Open Calculator", "", () => B.openInternal("calculator")),
    menuItem("i-search", "Open Veyra Search", "", () => B.showSearch("")),
    "-",
    menuItem("i-inspect", "Inspect element", "picker", () => hooks.dt?.inspect(), { disabled: !onPage }),
    menuItem("i-code", "Developer tools", "devtools", () => hooks.dt?.toggle()),
    menuItem("i-file", "View source resources", "viewSource", () => B.openInternal("resources"), { disabled: !onPage }),
    menuItem("i-link", "View all links", "", () => B.openInternal("links"), { disabled: !onPage }),
    ...(isAdmin() ? ["-", menuItem("i-terminal", "Open #console", "", () => B.openInternal("console"), { badge: "ADMIN" }), menuItem("i-gauge", "Open /dev", "", () => B.openInternal("dev"), { badge: "ADMIN" })] : []),
    "-",
    menuItem("i-settings", "Settings", "settings", () => B.openInternal("settings")),
    menuItem("i-user", auth.user ? "Sign out" : "Sign in", "", () => auth.user ? signOut() : openAuth("login")),
    menuItem("i-home", "Veyra homepage", "", () => B.goRoute("/"))
  ];
  m.innerHTML = (auth.user ? `<div class="menu-head"><span class="avatar signed">${esc(initials())}</span><div><b>${esc(auth.user.name || "Veyra user")}</b><span>${esc(auth.user.email)}${isAdmin() ? " · admin" : ""}</span></div></div><div class="menu-sep"></div>` : "")
    + items.map((it, i) => it === "-" ? `<div class="menu-sep"></div>` : it === "zoom" ? `<div class="menu-zoom"><span class="lbl">${onPage ? "Zoom" : "Interface size"}</span><button data-z="-1" title="Zoom out (${esc(kbdFor("zoomOut"))})">−</button><output>${Math.round(zoom * 100)}%</output><button data-z="1" title="Zoom in (${esc(kbdFor("zoomIn"))})">+</button><button data-z="0" title="Reset (${esc(kbdFor("zoomReset"))})">⟲</button></div>`
      : `<button class="menu-item" role="menuitem" data-i="${i}" ${it.disabled ? "disabled" : ""}><svg><use href="#${it.icon}"/></svg><span class="lbl">${esc(it.label)}</span>${it.badge ? `<span class="badge">${esc(it.badge)}</span>` : ""}${it.kbd.trim() ? `<kbd>${esc(it.kbd)}</kbd>` : ""}</button>`).join("");
  m.onclick = e => {
    const z = e.target.closest("[data-z]"); if (z) { B.zoomStep(Number(z.dataset.z)); const t2 = B.activeTab(); m.querySelector("output").textContent = Math.round((t2?.view === "page" && t2.url ? t2.zoom : settings.fontScale || 1) * 100) + "%"; return; }
    const b = e.target.closest("[data-i]"); if (!b) return; closeFloating(); items[Number(b.dataset.i)].action();
  };
  openFloating(m, $("menuBtn"));
  m.querySelector(".menu-item")?.focus();
}
function menuKeys(e) {
  const m = e.currentTarget; const btns = [...m.querySelectorAll(".menu-item:not(:disabled)")]; const i = btns.indexOf(document.activeElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); btns[(i + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length]?.focus(); }
}

// ================================================================ popovers
function pop(html, anchor, wire) { const p = $("popover"); p.innerHTML = html; openFloating(p, anchor, { align: anchor.getBoundingClientRect().left < innerWidth / 2 ? "left" : "right" }); wire?.(p); }
async function openSiteInfo() {
  const t = B.activeTab(); const anchor = $("siteChip");
  if (!(t?.view === "page" && t.url)) { pop(`<h4>${esc(B.INTERNAL[t?.view]?.title || "New tab")}</h4><p class="pop-sub">This is a built-in Veyra page. Nothing on it is sent to other sites.</p>`, anchor); return; }
  const host = hostOf(t.url); const s = B.state.session; const secure = /^https:/.test(t.url);
  pop(`<h4>${esc(host)}</h4><p class="pop-sub">${secure ? "Connection between Veyra and this site is encrypted." : "This site doesn't use HTTPS. Don't enter passwords."}</p>
    <dl class="kv"><dt>Engine</dt><dd>${t.browserMode === "BROWSER_ENGINE" ? "Chromium (streamed)" : "Fast proxy"}</dd><dt>Session</dt><dd>${s ? `${esc(s.id.slice(0, 8))} · ${fmtClock(B.sessionRemaining())} left` : "none"}</dd><dt>VPN</dt><dd>${B.state.vpn.connected ? esc(B.state.vpn.profile?.name || "connected") : "off"}</dd><dt>Cookies</dt><dd id="popCookies">…</dd></dl>
    <div class="s-card" style="margin-top:12px"><div class="s-row" style="padding:10px 12px;min-height:0"><div class="s-label"><b>Block trackers</b><span>For this session</span></div><div class="s-ctl"><input type="checkbox" class="switch" id="popTrackers" ${settings.blockTrackers ? "checked" : ""}></div></div></div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn ghost sm" id="popClear">Clear cookies</button><button class="btn ghost sm" id="popDirect">Open directly</button><button class="btn ghost sm" id="popCopy">Copy URL</button></div>`, anchor, p => {
    p.querySelector("#popTrackers").onchange = async e => { settings.blockTrackers = e.target.checked; saveSettings(); if (s) await api(`/api/session/${s.id}/prefs`, { json: { blockTrackers: e.target.checked } }).catch(() => {}); hooks.applyExtensionsToTab?.(t); toast(e.target.checked ? "Trackers blocked. Reload to apply" : "Tracker blocking off", { action: () => B.reload(), actionLabel: "Reload" }); };
    p.querySelector("#popClear").onclick = async () => { if (!s) return; const r = await api(`/api/session/${s.id}/cookies?domain=${encodeURIComponent(host.replace(/^www\./, ""))}`, { method: "DELETE" }).catch(() => null); await api(`/api/session/${s.id}/cookies?domain=${encodeURIComponent(host)}`, { method: "DELETE" }).catch(() => {}); toast(`Cleared ${r?.deleted ?? 0} cookies`); closeFloating(); };
    p.querySelector("#popDirect").onclick = () => { window.open(t.url, "_blank", "noopener"); closeFloating(); };
    p.querySelector("#popCopy").onclick = () => { copyText(t.url); closeFloating(); };
    if (s) api(`/api/session/${s.id}/cookies?host=${encodeURIComponent(host)}`).then(r => { const el = p.querySelector("#popCookies"); if (el) el.textContent = `${r.cookies.length} in use`; }).catch(() => { const el = p.querySelector("#popCookies"); if (el) el.textContent = "—"; });
    else p.querySelector("#popCookies").textContent = "0";
  });
}
function openSessionPop() {
  const s = B.state.session; const limit = s?.limitMs || B.state.serverLimitMs;
  pop(`<h4>${s ? "Session running" : "No active session"}</h4><p class="pop-sub">${limit ? `Sessions last ${fmtClock(limit)}. At 0:00 the server deletes cookies, tabs, Chromium context and the VPN tunnel.` : "Sessions on this server don't have a time limit."}</p>
    ${s ? `<dl class="kv"><dt>ID</dt><dd class="mono">${esc(s.id.slice(0, 12))}…</dd><dt>Time left</dt><dd id="popLeft">${fmtClock(B.sessionRemaining())}</dd><dt>Tabs open</dt><dd>${B.state.tabs.filter(t => t.view === "page").length}</dd><dt>VPN</dt><dd>${B.state.vpn.connected ? esc(B.state.vpn.profile?.name || "on") : "off"}</dd></dl>` : ""}
    <div style="display:flex;gap:8px;margin-top:12px">${s ? `<button class="btn danger sm" id="popEnd">End and delete now</button>` : `<button class="btn primary sm" id="popStart">Start a session</button>`}<button class="btn ghost sm" data-go="/settings/sessions">Session settings</button></div>`, $("sessionPill"), p => {
    p.querySelector("#popEnd")?.addEventListener("click", () => { closeFloating(); B.endSession("manual"); });
    p.querySelector("#popStart")?.addEventListener("click", async () => { closeFloating(); try { await B.ensureSession(); toast("Session started"); } catch (e) { toast(e.message, { kind: "err" }); } });
    const iv = setInterval(() => { const el = p.querySelector("#popLeft"); if (!el || p.classList.contains("hidden")) return clearInterval(iv); el.textContent = fmtClock(B.sessionRemaining()); }, 500);
    p.querySelector("[data-go]")?.addEventListener("click", closeFloating);
  });
}
async function openVpnPop() {
  pop(`<h4>Veyra VPN</h4><p class="pop-sub">Loading…</p>`, $("vpnBtn"));
  const v = await B.refreshVpnStatus(); const st = v.status; const p = $("popover"); if (p.classList.contains("hidden")) return;
  const profiles = st?.profiles || [];
  p.innerHTML = `<h4>Veyra VPN · ${v.connected ? "On" : "Off"}</h4><p class="pop-sub">${!st ? esc(v.error || "Unavailable") : v.connected ? `Using ${esc(v.profile?.name || "")}${v.profile?.region ? ` (${esc(v.profile.region)})` : ""}` : !st.enabled ? "VPN is disabled on this server." : profiles.length ? "Pick an exit for this session." : "No exits configured on the server."}</p>
    <div class="vpn-list">${profiles.slice(0, 6).map(x => `<div class="ext-pop-row"><span class="pill ${x.health?.healthy === false ? "err" : x.health?.healthy ? "ok" : ""}">${esc(x.protocol || x.type || "")}</span><div class="n"><b>${esc(x.name)}</b><small>${esc(x.region || x.country || "")}${x.health?.latencyMs ? ` · ${x.health.latencyMs} ms` : ""}</small></div>${v.profile?.id === x.id ? `<button class="btn ghost sm" data-off>Disconnect</button>` : `<button class="btn ghost sm" data-c="${esc(x.id)}" ${st.enabled ? "" : "disabled"}>Connect</button>`}</div>`).join("")}</div>
    <div style="margin-top:10px"><button class="btn ghost sm block" data-go="/vpn">Open VPN page</button></div>`;
  p.onclick = async e => { const b = e.target.closest("button"); if (!b) return; if (b.dataset.go) { closeFloating(); return; } b.disabled = true; try { if (b.dataset.c) await B.connectVpn(b.dataset.c); else if ("off" in b.dataset) await B.disconnectVpn(); closeFloating(); } catch (err) { toast(err.message, { kind: "err" }); b.disabled = false; } };
}
function openProfilePop() {
  if (!auth.user) {
    pop(`<h4>You're browsing as a guest</h4><p class="pop-sub">Sign in to sync settings, bookmarks, shortcuts, new tab tiles and extensions.</p><div style="display:flex;gap:8px"><button class="btn primary sm" id="ppIn">Sign in</button><button class="btn ghost sm" id="ppUp">Create account</button></div>`, $("profileBtn"), p => { p.querySelector("#ppIn").onclick = () => { closeFloating(); openAuth("login"); }; p.querySelector("#ppUp").onclick = () => { closeFloating(); openAuth("signup"); }; });
    return;
  }
  pop(`<div class="menu-head" style="padding:0 0 10px"><span class="avatar signed">${esc(initials())}</span><div><b>${esc(auth.user.name || "Veyra user")}</b><span>${esc(auth.user.email)}${isAdmin() ? " · admin" : ""}</span></div></div>
    <p class="pop-sub">Sync is on. ${hooks.lastSync ? `Last synced ${esc(timeAgo(hooks.lastSync))}.` : ""}</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn ghost sm" id="ppSync">Sync now</button><button class="btn ghost sm" data-go="/settings/account">Manage account</button><button class="btn ghost sm" id="ppOut">Sign out</button></div>`, $("profileBtn"), p => {
    p.querySelector("#ppSync").onclick = async () => { await pushSync(); toast("Synced"); closeFloating(); };
    p.querySelector("#ppOut").onclick = () => { closeFloating(); signOut(); };
    p.querySelector("[data-go]").addEventListener("click", closeFloating);
  });
}
hooks.openVpnPopover = openVpnPop; hooks.openSessionPopover = openSessionPop;

// ================================================================ clear browsing data
export async function openClearData() {
  const dlg = $("promptDialog"); $("promptTitle").textContent = "Clear browsing data"; $("promptOk").textContent = "Clear data";
  $("promptFields").innerHTML = `<label class="field"><span>Time range</span><select class="input" name="range"><option value="3600000">Last hour</option><option value="86400000">Last 24 hours</option><option value="604800000">Last 7 days</option><option value="0" selected>All time</option></select></label>
    <label class="switch-row" style="justify-content:space-between;margin:10px 0"><span>Browsing history</span><input type="checkbox" class="switch" name="history" checked></label>
    <label class="switch-row" style="justify-content:space-between;margin:10px 0"><span>Download list</span><input type="checkbox" class="switch" name="downloads"></label>
    <label class="switch-row" style="justify-content:space-between;margin:10px 0"><span>Cookies in the current session</span><input type="checkbox" class="switch" name="cookies" checked></label>
    <label class="switch-row" style="justify-content:space-between;margin:10px 0"><span>Engine cache</span><input type="checkbox" class="switch" name="cache" checked></label>`;
  dlg.returnValue = ""; dlg.showModal();
  dlg.addEventListener("close", function done() { dlg.removeEventListener("close", done); if (dlg.returnValue !== "ok") return; const f = n => dlg.querySelector(`[name=${n}]`);
    B.clearBrowsingData({ history: f("history").checked, downloads: f("downloads").checked, cookies: f("cookies").checked, cache: f("cache").checked, since: Number(f("range").value) }); toast("Browsing data cleared"); });
}
hooks.openClearData = openClearData;

// ================================================================ init
export function initUI(b) {
  B = b;
  applyTheme(); hooks.onSettingsChanged = () => { applyTheme(); renderBookmarksBar(); };
  document.addEventListener("keydown", onKeyDown, true);
  wireOmnibox();
  $("menuBtn").onclick = () => $("mainMenu").classList.contains("hidden") ? openMainMenu() : closeFloating();
  $("menuBtn").dataset.floatingAnchor = "";
  $("mainMenu").addEventListener("keydown", menuKeys);
  $("siteChip").onclick = openSiteInfo; $("profileBtn").onclick = openProfilePop;
  $("authForm").addEventListener("submit", submitAuth);
  $("authSubmit").addEventListener("click", e => { e.preventDefault(); submitAuth(e); });
  qsa("#authForm .seg button").forEach(b => b.onclick = () => openAuth(b.dataset.mode));
  document.addEventListener("click", e => { const a = e.target.closest("[data-auth]"); if (a) { e.preventDefault(); openAuth(a.dataset.auth); } const x = e.target.closest("[data-explore]"); if (x) B.goRoute(`/browse?url=${encodeURIComponent(x.dataset.explore)}`); });
  setInterval(() => { if (B.activeTab()?.view === "newtab" && settings.ntpClock) { $("ntpClock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } }, 10000);
  window.addEventListener("beforeunload", e => { if (settings.warnBeforeClose && B.state.tabs.filter(t => t.view === "page").length > 1) { e.preventDefault(); e.returnValue = ""; } });
  initExtensions(B); initSettings(B);
  onAuthChanged(); verifyAuth().then(() => auth.token && pullSync());
  addLog("debug", `UI ready (${COMMANDS.length} commands)`);
}
export { B as browser };
