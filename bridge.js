// Transport to the DevTools bridge that runs inside each proxied page.
// FAST_PROXY: postMessage to the tab's iframe. BROWSER_ENGINE: server call.
import { api, API_ORIGIN, uid } from "./core.js";

const pending = new Map();
const listeners = new Set();

export function frameFor(tab) { return tab ? document.getElementById("frame-" + tab.id) : null; }
export function isRemote(tab) { return tab?.browserMode === "BROWSER_ENGINE" && !!tab.browserSessionId; }

export function dtCall(tab, method, params = {}, timeoutMs = 8000) {
  if (!tab) return Promise.reject(new Error("No tab."));
  if (isRemote(tab)) {
    return api(`/api/browser/session/${encodeURIComponent(tab.browserSessionId)}/devtools`, { json: { method, params }, timeoutMs: timeoutMs + 2000 }).then(r => r?.result);
  }
  const frame = frameFor(tab);
  if (!frame?.contentWindow || !tab.url) return Promise.reject(new Error("No page is loaded in this tab."));
  return new Promise((resolve, reject) => {
    const id = uid();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("The page did not answer. It may still be loading, or it blocks the Veyra runtime.")); }, timeoutMs);
    pending.set(id, { resolve, reject, timer, tabId: tab.id });
    try { frame.contentWindow.postMessage({ type: "veyra:dt", id, method, params }, API_ORIGIN); }
    catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
  });
}

// Called by app.js for every veyra:dt-* message (origin already verified).
export function handleBridgeMessage(tab, d) {
  if (d.type === "veyra:dt-result") {
    const p = pending.get(d.id); if (!p) return true;
    clearTimeout(p.timer); pending.delete(d.id);
    if (d.ok) p.resolve(d.result); else p.reject(new Error(d.error?.message || d.error || "DevTools call failed."));
    return true;
  }
  if (d.type === "veyra:dt-event") { for (const fn of listeners) { try { fn(tab, d.event, d.data); } catch {} } return true; }
  return false;
}
export function onBridgeEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function rejectTab(tabId) { for (const [id, p] of pending) if (p.tabId === tabId) { clearTimeout(p.timer); pending.delete(id); p.reject(new Error("The page navigated away.")); } }
