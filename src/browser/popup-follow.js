"use strict";
/**
 * Popup following for streamed Chromium sessions.
 *
 * The streamed surface (screenshots), input (click/type/key/wheel), history
 * and navigation all target `session.page`. Before this module, a window the
 * site opened (an OAuth/sign-in popup, a game launcher, a "play in new
 * window" button — all common on browser.lol / now.gg style sites) was added
 * to `session.pages` but never became `session.page`, so it opened invisibly
 * in the background: the user kept seeing and clicking the opener page and
 * could never finish whatever the popup was for.
 *
 * `followPopup` makes the popup the active page (remembering the opener) and
 * `restoreAfterClose` hands control back to the most recent still-open page
 * when the popup closes — which is exactly what a real browser tab strip does
 * when an auth popup finishes and closes itself.
 */

function isOpen(page) {
  try { return !!page && typeof page.isClosed === "function" ? !page.isClosed() : !!page; } catch { return false; }
}

const pendingPopups = new WeakSet();
function httpUrl(page) {
  try {
    const url = new URL(page.url());
    return /^https?:$/.test(url.protocol) ? url.href : "";
  } catch { return ""; }
}

// Chromium may fire "popup" for an about:blank handle before an OAuth
// script sends it to an actual page. Keep showing the opener until then.
function followPopupWhenReady(session, opener, popup, timeoutMs = 120000) {
  if (!isOpen(popup)) return;
  const source = opener.url();
  const close = () => { void popup.close().catch(() => {}); };
  let timer;
  function cleanup() {
    clearTimeout(timer);
    popup.off("framenavigated", onNavigation);
    popup.off("close", cleanup);
  }
  function activate() {
    const url = httpUrl(popup);
    if (!url) return false;
    cleanup();
    if (blockPlaybackPopup(source, url)) { close(); return true; }
    if (session.page === opener && isOpen(opener) && isOpen(popup)) {
      pendingPopups.delete(popup);
      followPopup(session, popup);
      session.canonicalUrl = url;
      if (blockPlaybackPopup(source, "about:blank")) popup.on("framenavigated", frame => {
        if (frame === popup.mainFrame() && blockPlaybackPopup(source, frame.url())) close();
      });
    } else if (isOpen(popup)) void popup.close().catch(() => {});
    return true;
  }
  function onNavigation(frame) {
    if (frame === popup.mainFrame()) activate();
  }
  pendingPopups.add(popup);
  if (activate()) return;
  if (session.page === opener) {
    try { void opener.bringToFront?.().catch(() => {}); } catch {}
  }
  popup.on("framenavigated", onNavigation);
  popup.on("close", cleanup);
  timer = setTimeout(() => { cleanup(); if (isOpen(popup)) void popup.close().catch(() => {}); }, timeoutMs);
  timer.unref?.();
}

// This function is also serialized into the Fast Proxy runtime. Keep it
// self-contained so the streamed and in-frame paths make the same decision.
function blockPlaybackPopup(source, destination, explicitLink = false) {
  const site = /^(?:[a-z0-9-]+\.)*xhamster\.com$/i;
  const watch = /^\/videos\/([^/]+)\/?$/i;
  let opener, from;
  try { opener = new URL(source); from = site.test(opener.hostname) && watch.exec(opener.pathname); } catch {}
  if (!from) return false;
  try {
    const next = new URL(destination, opener);
    if (!/^https?:$/.test(next.protocol) || !site.test(next.hostname)) return !explicitLink;
    const to = watch.exec(next.pathname);
    if (!to) return false;
    const videoId = slug => /(?:^|[-_])(x[hx][a-z0-9]+)$/i.exec(slug)?.[1]?.toLowerCase();
    return from[1] === to[1] || (!!videoId(from[1]) && videoId(from[1]) === videoId(to[1]));
  } catch { return !explicitLink; }
}

// Make `popup` the active page for the session; the previous active page is
// remembered so it can be restored when the popup closes.
function followPopup(session, popup) {
  if (!session || !popup) return false;
  session.pageStack = Array.isArray(session.pageStack) ? session.pageStack : [];
  if (session.page && session.page !== popup) session.pageStack.push(session.page);
  session.page = popup;
  session.screenshot = null;
  session.screenshotAt = 0;
  try { const p = popup.bringToFront?.(); if (p && typeof p.catch === "function") p.catch(() => {}); } catch {}
  return true;
}

// A page closed. If it was the active page, fall back to the most recent
// still-open page (the opener for a finished popup), otherwise any open page.
function restoreAfterClose(session, page) {
  if (!session) return null;
  if (session.pages && typeof session.pages.delete === "function") session.pages.delete(page);
  if (Array.isArray(session.pageStack)) session.pageStack = session.pageStack.filter(p => p !== page && isOpen(p));
  if (session.page !== page) return session.page || null;
  let next = null;
  while (Array.isArray(session.pageStack) && session.pageStack.length) {
    const candidate = session.pageStack.pop();
    if (isOpen(candidate)) { next = candidate; break; }
  }
  if (!next && session.pages) {
    for (const candidate of [...session.pages].reverse()) {
      if (candidate !== page && !pendingPopups.has(candidate) && isOpen(candidate)) { next = candidate; break; }
    }
  }
  if (next) {
    session.page = next;
    session.canonicalUrl = httpUrl(next) || session.canonicalUrl;
    session.screenshot = null;
    session.screenshotAt = 0;
    try { const p = next.bringToFront?.(); if (p && typeof p.catch === "function") p.catch(() => {}); } catch {}
  }
  return next;
}

module.exports = { followPopup, followPopupWhenReady, restoreAfterClose, blockPlaybackPopup };
