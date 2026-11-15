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
      if (candidate !== page && isOpen(candidate)) { next = candidate; break; }
    }
  }
  if (next) {
    session.page = next;
    session.screenshot = null;
    session.screenshotAt = 0;
    try { const p = next.bringToFront?.(); if (p && typeof p.catch === "function") p.catch(() => {}); } catch {}
  }
  return next;
}

module.exports = { followPopup, restoreAfterClose };
