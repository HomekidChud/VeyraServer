"use strict";

// Serialized into the proxy page runtime; keep this function self-contained.
function watchEmptyProxyShell(doc, view, onBlank) {
  function looksEmpty() {
    const body = doc.body;
    if (!body || doc.readyState === "loading") return false;
    const text = (body.innerText || "").replace(/\s+/g, " ").trim();
    if (text.length >= 40) return false;
    for (const el of body.querySelectorAll("canvas,video,iframe,svg,img")) {
      if (el.tagName === "IMG" && !el.naturalWidth) continue;
      const { width, height } = el.getBoundingClientRect();
      const style = view.getComputedStyle(el);
      if (width >= 32 && height >= 18 && style.visibility === "visible" && style.opacity !== "0") return false;
    }
    const root = body.querySelector("#root,#app,#__next,[data-reactroot],#react-root");
    const emptyRoot = root && !root.textContent?.trim() && root.children.length === 0;
    return emptyRoot || !text || body.children.length < 4;
  }
  view.setTimeout(() => {
    try {
      if (looksEmpty()) view.setTimeout(() => {
        try { if (looksEmpty()) onBlank(); } catch {}
      }, 3500);
    } catch {}
  }, 2500);
}

module.exports = { watchEmptyProxyShell };
