"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { watchEmptyProxyShell } = require("../src/browser/proxy-shell");

function fixture() {
  let time = 0;
  const timers = [], signals = [], surfaces = [];
  const body = { innerText: "", children: [], querySelectorAll: () => surfaces, querySelector: () => null };
  const doc = { body, readyState: "complete" };
  const view = {
    getComputedStyle: el => ({ visibility: el.visibility || "visible", opacity: el.opacity || "1" }),
    setTimeout: (fn, delay) => timers.push({ fn, at: time + delay })
  };
  function advance(at) {
    while (timers[0]?.at <= at) {
      const timer = timers.shift();
      time = timer.at;
      timer.fn();
    }
    time = at;
  }
  watchEmptyProxyShell(doc, view, () => signals.push(time));
  return { advance, body, doc, signals, surfaces };
}

test("a consistently blank proxy document emits one signal after the hydration grace period", () => {
  const f = fixture();
  f.advance(5999);
  assert.deepEqual(f.signals, []);
  f.advance(10000);
  assert.deepEqual(f.signals, [6000]);
});

test("late hydration, visible canvas and embedded media are not mistaken for blank pages", () => {
  for (const tagName of ["CANVAS", "VIDEO", "IFRAME", "SVG", "IMG"]) {
    const f = fixture();
    f.advance(3000);
    f.surfaces.push({ tagName, naturalWidth: 240, getBoundingClientRect: () => ({ width: 320, height: 240 }) });
    f.advance(6000);
    assert.deepEqual(f.signals, [], tagName);
  }
  const f = fixture();
  f.advance(3000);
  f.body.innerText = "The single page app has loaded its real content and controls.";
  f.advance(6000);
  assert.deepEqual(f.signals, []);
});

test("a hidden surface, broken image and tracking pixel do not mask a blank page", () => {
  const f = fixture();
  const box = (width, height) => () => ({ width, height });
  f.surfaces.push(
    { visibility: "hidden", getBoundingClientRect: box(640, 480) },
    { opacity: "0", getBoundingClientRect: box(640, 480) },
    { tagName: "IMG", naturalWidth: 0, getBoundingClientRect: box(640, 480) },
    { tagName: "IMG", naturalWidth: 1, getBoundingClientRect: box(1, 1) }
  );
  f.advance(6000);
  assert.deepEqual(f.signals, [6000]);
});
