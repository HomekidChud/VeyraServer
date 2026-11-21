"use strict";
// Regression — the streamed Chromium view must follow the page a site
// opens (and go back when it closes).
//
// Pre-fix, a popup opened by a remote-Chromium page was added to
// session.pages but session.page never changed, so the screenshot stream,
// all input and the status URL kept targeting the opener. On popup-driven
// flows (OAuth sign-in, cloud-app launchers, "open in new window"
// buttons — browser.lol / now.gg / MSN-game style) the popup opened
// invisibly in the background and the user could never finish it.
//
// Post-fix (popup-follow.js wired into both browser engines):
//   - followPopup makes the popup session.page and remembers the opener;
//   - restoreAfterClose returns control to the opener when the popup
//     closes, falling back to any still-open page;
//   - a closed non-active page changes nothing.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { followPopup, followPopupWhenReady, restoreAfterClose } = require("../src/browser/popup-follow");

function fakePage(url, closed = false) {
  return {
    url: () => url,
    isClosed: () => closed,
    bringToFront: () => Promise.resolve(),
    on: () => {},
  };
}

// A session shaped like the engine's internal session object.
function fakeSession(page) {
  return { page, pages: new Set([page]), screenshot: "stale", screenshotAt: 123, console: [] };
}

// 1. A popup becomes the active page and the opener is remembered.
const opener = fakePage("https://browser.lol/");
const session = fakeSession(opener);
const popup = fakePage("https://accounts.google.com/o/oauth2/v2/auth");
const followed = followPopup(session, popup);
assert.equal(followed, true, "followPopup must report success");
assert.equal(session.page, popup, "the popup must become the active page");
assert.deepEqual(session.pageStack, [opener], "the opener must be remembered for restore");
assert.equal(session.screenshot, null, "the stale screenshot must be dropped");

// 2. When the popup closes, control returns to the opener.
const next = restoreAfterClose(session, popup);
assert.equal(next, opener, "closing the popup must restore the opener");
assert.equal(session.page, opener, "the opener must become the active page again");
assert.ok(!session.pages.has(popup), "the closed popup must leave the page set");

// 3. A closed non-active page changes nothing.
const other = fakePage("https://now.gg/play");
session.pages.add(other);
const still = restoreAfterClose(session, other);
assert.equal(still, opener, "closing a background page must not switch the active page");
assert.equal(session.page, opener);

// 4. Chains: opener -> popup -> nested popup; closing the nested popup
// returns to the popup, closing the popup returns to the opener.
const s2 = fakeSession(opener);
const p2 = fakePage("https://login.example.com/");
const p3 = fakePage("https://accounts.google.com/signup");
s2.pages.add(p2); s2.pages.add(p3);
followPopup(s2, p2);
followPopup(s2, p3);
assert.equal(s2.page, p3);
restoreAfterClose(s2, p2); // a background popup closing must not switch
assert.equal(s2.page, p3, "closing the background popup must not switch");
// p2 already closed in the background, so closing p3 skips straight back to
// the still-open opener.
assert.equal(restoreAfterClose(s2, p3), opener, "closing the nested popup returns to the last open page (the opener)");

// 5. Dead pages in the stack are skipped.
const s3 = fakeSession(opener);
const dead = fakePage("https://gone.example/", true);
const alive = fakePage("https://alive.example.com/");
s3.pages.add(dead); s3.pages.add(alive);
followPopup(s3, dead);
followPopup(s3, alive);
assert.equal(s3.page, alive);
const back = restoreAfterClose(s3, alive);
assert.equal(back, opener, "dead remembered pages are skipped when restoring");

// 6. The engines wire the module in: a popup must call followPopup and the
// close handler must call restoreAfterClose (checked against the real
// source so the wiring cannot silently regress).
const fs = require("fs");
for (const engine of ["src/browser/browser-engine.js", "src/browser/optimized-browser-engine.js"]) {
  const src = fs.readFileSync(require.resolve("../" + engine.replace("src/", "src/")), "utf8");
  assert.match(src, /require\('\.\/popup-follow'\)/, `${engine} must require popup-follow`);
  assert.match(src, /followPopupWhenReady\(session, page, popup\)/, `${engine} must wait for a popup to navigate`);
  assert.match(src, /restoreAfterClose\(session, page\)/, `${engine} must restore after a page closes`);
}

// 7. The engine-level behavior with a fake playwright page: the popup
// handler must actually switch session.page. attachPage is engine-internal
// wiring over Playwright events; drive it through the popup handler.
const { BrowserEngine } = require("../src/browser/browser-engine");
const engine = new BrowserEngine({ browserEnabled: false, maxBrowserPages: 5 }, () => {}, () => {}, () => {}, null);
const fakePlaywrightPage = {
  url: () => "https://browser.lol/",
  isClosed: () => false,
  bringToFront: () => Promise.resolve(),
  on: (name, h) => { (events[name] ||= []).push(h); },
  once: () => {},
};
const sessionLike = fakeSession(fakePlaywrightPage);
const events = {};
engine.attachPage(sessionLike, fakePlaywrightPage);
const popupPage = {
  url: () => "https://accounts.google.com/o/oauth2/v2/auth",
  isClosed: () => false,
  bringToFront: () => Promise.resolve(),
  on: (n, h) => { (events[n] ||= []).push(h); },
  off: () => {},
  once: () => {},
};
sessionLike.pages.add(popupPage);
// Snapshot the handler list first: the popup handler registers the popup's
// own handlers into the same capture as it runs.
const popupHandlers = [...(events.popup || [])];
const closeBeforePopup = events.close ? events.close.length : 0;
for (const h of popupHandlers) h(popupPage);
assert.equal(sessionLike.page, popupPage, "the popup handler must make the popup the active page");
// Now the popup closes: the popup's own close handler (registered when the
// popup handler attached it) must restore the opener.
const popupCloseHandlers = events.close.slice(closeBeforePopup);
assert.ok(popupCloseHandlers.length > 0, "the popup must have its own close handler");
for (const h of popupCloseHandlers) h(popupPage);
assert.equal(sessionLike.page, fakePlaywrightPage, "closing the popup must restore the opener");
function placeholder(initial = "about:blank") {
  let current = initial;
  let closed = false;
  const frame = { url: () => current };
  return Object.assign(new EventEmitter(), {
    url: () => current, mainFrame: () => frame, isClosed: () => closed,
    async close() { closed = true; this.emit("close"); },
    navigate(url, child = false) {
      if (!child) current = url;
      this.emit("framenavigated", child ? {} : frame);
    },
  });
}
const blank = placeholder();
const s4 = fakeSession(opener);
s4.canonicalUrl = opener.url();
s4.pages.add(blank);
followPopupWhenReady(s4, opener, blank);
assert.equal(s4.page, opener, "an about:blank popup must not replace a playing page");
assert.equal(s4.canonicalUrl, opener.url());
blank.navigate("https://login.example.com", true);
assert.equal(s4.page, opener, "only the popup's main frame can promote it");
blank.navigate("https://login.example.com/");
assert.equal(s4.page, blank, "an OAuth popup becomes visible after its delayed navigation");
assert.equal(s4.canonicalUrl, "https://login.example.com/");
assert.equal(restoreAfterClose(s4, blank), opener);
assert.equal(s4.canonicalUrl, opener.url());

const stale = placeholder();
const otherWindow = fakePage("https://example.com/active");
s4.pages.add(stale);
s4.pages.add(otherWindow);
followPopupWhenReady(s4, opener, stale);
followPopup(s4, otherWindow);
stale.navigate("https://example.com/late");
assert.equal(s4.page, otherWindow, "a delayed popup must not steal focus from a different active window");
assert.equal(stale.isClosed(), true);

const abandoned = placeholder();
followPopupWhenReady(s4, otherWindow, abandoned, 1);
abandoned.once("close", () => {
  assert.equal(s4.page, otherWindow);
  console.log("remote popup-follow regression tests passed");
});
// Keep the test process alive for the helper's unref'ed expiry timer.
setTimeout(() => assert.equal(abandoned.isClosed(), true, "a blank page must expire"), 10);

const watch = fakePage("https://xhamster.com/videos/sample-xhA123");
const watchSession = fakeSession(watch);
const sameVideo = placeholder("https://www.xhamster.com/videos/different-slug-xha123?utm_source=ad");
followPopupWhenReady(watchSession, watch, sameVideo);
assert.equal(sameVideo.isClosed(), true);
assert.equal(watchSession.page, watch);

const staged = placeholder();
followPopupWhenReady(watchSession, watch, staged);
staged.navigate("https://example.com/ad");
assert.equal(staged.isClosed(), true);
assert.equal(watchSession.page, watch);

const independent = placeholder("https://xhamster.com/videos/sample-xhB456");
watchSession.pages.add(independent);
independent.once("close", () => restoreAfterClose(watchSession, independent));
followPopupWhenReady(watchSession, watch, independent);
assert.equal(watchSession.page, independent);
independent.navigate(watch.url(), true);
assert.equal(independent.isClosed(), false);
independent.navigate(watch.url());
assert.equal(independent.isClosed(), true);
assert.equal(watchSession.page, watch);
