"use strict";

















function installVeyraDevtools(emitFn, opts) {
  if (window.__veyraDevtools) return window.__veyraDevtools;
  opts = opts || {};
  const unwrap = opts.unwrap || (u => u);
  const queue = [];
  function emit(event, data) {
    if (emitFn) { try { emitFn({ type: "veyra:dt-event", event, data }); } catch (e) {} }
    else { queue.push({ event, data, t: Date.now() }); if (queue.length > 500) queue.splice(0, queue.length - 500); }
  }
  const OWN = "data-veyra-devtools";

  
  let nextId = 1;
  const ids = new WeakMap();
  const nodes = new Map();
  function idOf(n) { let id = ids.get(n); if (!id) { id = nextId++; ids.set(n, id); nodes.set(id, typeof WeakRef === "function" ? new WeakRef(n) : { deref: () => n }); } return id; }
  function nodeOf(id) { const r = nodes.get(Number(id)); const n = r && r.deref(); if (!n) throw new Error("Node is no longer in the page. Refresh the Elements panel."); return n; }
  function own(n) { return n && n.nodeType === 1 && (n.hasAttribute(OWN) || n.hasAttribute("data-veyra-runtime")); }
  function kids(n) {
    const out = [];
    const list = n.nodeType === 1 && n.shadowRoot ? [n.shadowRoot, ...n.childNodes] : [...n.childNodes];
    for (const c of list) {
      if (own(c)) continue;
      if (c.nodeType === 3 && !c.nodeValue.trim()) continue;
      if (c.nodeType === 1 || c.nodeType === 3 || c.nodeType === 8 || c.nodeType === 10 || c.nodeType === 11) out.push(c);
    }
    return out;
  }
  function attrPairs(el) { const out = []; for (const a of el.attributes) { if (a.name === "data-veyra-action" || a.name === "data-veyra-formaction") continue; let v = a.value; if (/^(src|href|action|poster|data)$/i.test(a.name)) { try { v = unwrap(v) || v; } catch (e) {} } out.push([a.name, v.length > 2000 ? v.slice(0, 2000) + "…" : v]); } return out; }
  function ser(n, depth) {
    const id = idOf(n);
    if (n.nodeType === 3) return { id, type: 3, text: n.nodeValue.length > 2000 ? n.nodeValue.slice(0, 2000) + "…" : n.nodeValue };
    if (n.nodeType === 8) return { id, type: 8, text: n.nodeValue.slice(0, 500) };
    if (n.nodeType === 10) return { id, type: 10, name: n.name || "html" };
    if (n.nodeType === 11) { const k = kids(n); return { id, type: 11, name: "#shadow-root", mode: n.mode || "open", childCount: k.length, children: depth > 0 ? k.map(c => ser(c, depth - 1)) : null }; }
    if (n.nodeType === 9) { const k = kids(n); return { id, type: 9, name: "#document", childCount: k.length, children: k.map(c => ser(c, depth - 1)) }; }
    const k = kids(n);
    const inline = k.length === 1 && k[0].nodeType === 3 && k[0].nodeValue.length < 80;
    return { id, type: 1, name: n.tagName.toLowerCase(), attrs: attrPairs(n), childCount: k.length,
      children: depth > 0 || inline ? k.map(c => ser(c, inline ? 0 : depth - 1)) : null };
  }
  function pathTo(n) { const out = []; while (n && n !== document) { out.unshift(idOf(n)); n = n.parentNode || n.host; } return out; }
  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return "";
    const parts = []; let n = el;
    while (n && n.nodeType === 1 && parts.length < 6) {
      let s = n.tagName.toLowerCase();
      if (n.id) { s += "#" + CSS.escape(n.id); parts.unshift(s); break; }
      const cls = [...n.classList].slice(0, 2).map(c => "." + CSS.escape(c)).join("");
      s += cls;
      const p = n.parentElement;
      if (p) { const same = [...p.children].filter(c => c.tagName === n.tagName); if (same.length > 1) s += ":nth-of-type(" + (same.indexOf(n) + 1) + ")"; }
      parts.unshift(s); n = p;
    }
    return parts.join(" > ");
  }

  
  let overlay = null;
  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    overlay = document.createElement("div");
    overlay.setAttribute(OWN, "overlay");
    overlay.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    overlay.innerHTML = '<div data-k="m" style="position:fixed;background:rgba(246,178,107,.35)"></div><div data-k="b" style="position:fixed;background:rgba(255,229,153,.4)"></div><div data-k="p" style="position:fixed;background:rgba(147,196,125,.45)"></div><div data-k="c" style="position:fixed;background:rgba(111,168,220,.5)"></div><div data-k="t" style="position:fixed;font:11px/1.4 ui-monospace,Menlo,monospace;background:#1f232b;color:#e8eaee;padding:3px 7px;border-radius:4px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.35)"></div>';
    (document.documentElement || document).appendChild(overlay);
    return overlay;
  }
  function box(x, y, w, h, el) { el.style.left = x + "px"; el.style.top = y + "px"; el.style.width = Math.max(0, w) + "px"; el.style.height = Math.max(0, h) + "px"; }
  function highlight(el) {
    if (!el || el.nodeType !== 1) { if (overlay) overlay.style.display = "none"; return null; }
    const o = ensureOverlay(); o.style.display = "block";
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const n = k => parseFloat(cs[k]) || 0;
    const m = { t: n("marginTop"), r: n("marginRight"), b: n("marginBottom"), l: n("marginLeft") };
    const bd = { t: n("borderTopWidth"), r: n("borderRightWidth"), b: n("borderBottomWidth"), l: n("borderLeftWidth") };
    const p = { t: n("paddingTop"), r: n("paddingRight"), b: n("paddingBottom"), l: n("paddingLeft") };
    const q = k => o.querySelector('[data-k="' + k + '"]');
    box(r.left - m.l, r.top - m.t, r.width + m.l + m.r, r.height + m.t + m.b, q("m"));
    box(r.left, r.top, r.width, r.height, q("b"));
    box(r.left + bd.l, r.top + bd.t, r.width - bd.l - bd.r, r.height - bd.t - bd.b, q("p"));
    box(r.left + bd.l + p.l, r.top + bd.t + p.t, r.width - bd.l - bd.r - p.l - p.r, r.height - bd.t - bd.b - p.t - p.b, q("c"));
    const tip = q("t");
    let label = el.tagName.toLowerCase(); if (el.id) label += "#" + el.id; if (el.classList.length) label += "." + [...el.classList].slice(0, 3).join(".");
    tip.textContent = label + "  " + Math.round(r.width) + " × " + Math.round(r.height);
    const ty = r.top - 26 > 0 ? r.top - 26 : r.bottom + 6;
    tip.style.left = Math.max(4, Math.min(innerWidth - 240, r.left)) + "px"; tip.style.top = Math.max(4, Math.min(innerHeight - 24, ty)) + "px";
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  
  let picking = false, pickLast = 0;
  function pickTarget(ev) { let el = ev.composedPath ? ev.composedPath()[0] : ev.target; if (el && el.nodeType !== 1) el = el.parentElement; return own(el) ? null : el; }
  function onPickMove(ev) { if (!picking) return; const t = performance.now(); if (t - pickLast < 30) return; pickLast = t; const el = pickTarget(ev); if (el) { highlight(el); emit("dom.hover", { id: idOf(el), path: pathTo(el) }); } }
  function onPickClick(ev) { if (!picking) return; ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); const el = pickTarget(ev); setPicking(false); if (el) { highlight(el); emit("dom.select", { id: idOf(el), path: pathTo(el), selector: selectorOf(el) }); } }
  function onPickKey(ev) { if (picking && ev.key === "Escape") { setPicking(false); highlight(null); emit("dom.pickCancelled", {}); } }
  function swallow(ev) { if (picking) { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); } }
  function setPicking(on) {
    picking = !!on;
    const f = picking ? addEventListener : removeEventListener;
    f("mousemove", onPickMove, true); f("click", onPickClick, true); f("keydown", onPickKey, true);
    f("mousedown", swallow, true); f("mouseup", swallow, true); f("pointerdown", swallow, true);
    try { document.documentElement.style.cursor = picking ? "crosshair" : ""; } catch (e) {}
    emit("dom.picking", { enabled: picking });
  }

  
  let mo = null, moTimer = 0, dirty = new Set();
  function watchDom(on) {
    if (on && !mo && typeof MutationObserver === "function") {
      mo = new MutationObserver(list => {
        for (const m of list) { const t = m.target; if (own(t) || (t.parentNode && own(t.parentNode))) continue; const id = ids.get(m.type === "characterData" ? t.parentNode : t); if (id) dirty.add(id); }
        if (dirty.size && !moTimer) moTimer = setTimeout(() => { moTimer = 0; const list2 = [...dirty].slice(0, 200); dirty.clear(); emit("dom.changed", { ids: list2 }); }, 250);
      });
      mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    } else if (!on && mo) { mo.disconnect(); mo = null; }
  }

  
  const rules = new Map(); let nextRule = 1;
  function sheetLabel(sheet) {
    if (!sheet) return "";
    if (sheet.href) { const u = unwrap(sheet.href) || sheet.href; try { const x = new URL(u); return x.pathname.split("/").pop() || x.hostname; } catch (e) { return u; } }
    const owner = sheet.ownerNode; if (owner && owner.tagName === "STYLE") { const all = [...document.querySelectorAll("style")]; return "<style> #" + (all.indexOf(owner) + 1); }
    return "constructed";
  }
  
  function splitDecls(text) { const out = []; let depth = 0, q = "", cur = ""; for (const ch of String(text || "")) { if (q) { if (ch === q) q = ""; cur += ch; continue; } if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; } if (ch === "(") depth++; else if (ch === ")") depth = Math.max(0, depth - 1); if (ch === ";" && !depth) { out.push(cur); cur = ""; continue; } cur += ch; } if (cur.trim()) out.push(cur); return out; }
  const SHORTHANDS = ["background", "margin", "padding", "inset", "border-radius", "border-top", "border-right", "border-bottom", "border-left", "border-width", "border-style", "border-color", "border", "outline", "font", "flex", "flex-flow", "gap", "overflow", "transition", "animation", "list-style", "text-decoration", "grid-template", "grid-area", "place-items", "place-content", "columns", "mask"];
  const NOT_PART = { border: /^border-(radius|collapse|spacing|image|start|end|block|inline)/, background: /^background-blend-mode/, font: /^font-(feature|variation|kerning|optical|display|synthesis-)/ };
  
  function collapseShorthands(style, list) {
    let out = list;
    for (const sh of SHORTHANDS) {
      let v = ""; try { v = style.getPropertyValue(sh); } catch {}
      if (!v) continue;
      const parts = out.filter(([k]) => k.startsWith(sh + "-") && !(NOT_PART[sh] && NOT_PART[sh].test(k)));
      if (parts.length < 2 || out.some(([k]) => k === sh)) continue;
      const at = out.indexOf(parts[0]); const imp = parts.every(p => p[2]);
      out = out.filter(p => !parts.includes(p)); out.splice(at, 0, [sh, v, imp]);
    }
    return out;
  }
  function propsOf(style) {
    const out = [];
    try { for (const d of splitDecls(style.cssText)) { const i = d.indexOf(":"); if (i < 1) continue; let v = d.slice(i + 1).trim(); const imp = /!\s*important\s*$/i.test(v); if (imp) v = v.replace(/!\s*important\s*$/i, "").trim(); out.push([d.slice(0, i).trim(), v, imp]); } } catch {}
    if (out.length) return collapseShorthands(style, out);
    if (!style.length) return out;
    for (let i = 0; i < style.length; i++) { const k = style[i]; out.push([k, style.getPropertyValue(k), style.getPropertyPriority(k) === "important"]); }
    return out;
  }
  function specificity(sel) {
    const s = sel.replace(/:not\(([^)]*)\)/g, " $1").replace(/::?(before|after|first-line|first-letter)/g, "");
    const a = (s.match(/#[\w-]+/g) || []).length, b = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length, c = (s.match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
    return a * 10000 + b * 100 + c;
  }
  function collectRules(el) {
    const out = [];
    function walk(list, sheet, media) {
      for (const rule of list) {
        if (rule.type === 1) {
          let matched = null;
          try { for (const part of rule.selectorText.split(",")) { if (el.matches(part.trim())) { matched = matched || []; matched.push(part.trim()); } } } catch (e) {}
          if (matched) { const rid = nextRule++; rules.set(rid, rule); out.push({ ruleId: rid, selector: rule.selectorText, matched, specificity: Math.max(...matched.map(specificity)), media, source: sheetLabel(sheet), href: sheet && sheet.href ? unwrap(sheet.href) || sheet.href : "", props: propsOf(rule.style), order: out.length }); }
        } else if (rule.cssRules && (rule.type === 4 || rule.type === 12 || rule.type === 0 || rule.type === 19)) {
          if (rule.type === 4 && rule.media && !matchMedia(rule.media.mediaText).matches) continue;
          walk(rule.cssRules, sheet, rule.media ? "@media " + rule.media.mediaText : rule.conditionText ? "@supports " + rule.conditionText : media);
        }
      }
    }
    const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])];
    let blocked = 0;
    for (const sheet of sheets) { let list; try { list = sheet.cssRules; } catch (e) { blocked++; continue; } if (list) walk(list, sheet, ""); }
    out.sort((a, b) => b.specificity - a.specificity || b.order - a.order);
    
    const seen = new Map();
    const inlineProps = propsOf(el.style);
    for (const [k, , imp] of inlineProps) seen.set(k, imp ? 2 : 1);
    for (const r of out) r.props = r.props.map(([k, v, imp]) => { const prev = seen.get(k); const over = prev != null && !(imp && prev < 2); if (!over) seen.set(k, imp ? 2 : 1); return [k, v, imp, over]; });
    return { inline: inlineProps, rules: out.slice(0, 120), blockedSheets: blocked };
  }
  function inherited(el) {
    const INH = /^(color|font|line-height|letter-spacing|text-|white-space|word-spacing|visibility|cursor|direction|list-style|quotes|--)/;
    const out = []; let p = el.parentElement, depth = 0;
    while (p && depth < 4) { const r = collectRules(p).rules.map(x => ({ ...x, props: x.props.filter(([k]) => INH.test(k)) })).filter(x => x.props.length); if (r.length) out.push({ from: selectorOf(p).split(" > ").pop(), id: idOf(p), rules: r.slice(0, 12) }); p = p.parentElement; depth++; }
    return out;
  }

  
  const objects = new Map(); let nextObj = 1;
  function keep(v) { const id = nextObj++; objects.set(id, v); if (objects.size > 3000) objects.delete(objects.keys().next().value); return id; }
  
  function cleanStack(st) { const out = []; for (let l of String(st || "").split("\n")) { if (/^\s*at eval \(<anonymous>\)/.test(l) || /^\s*at (evaluate|runtime\.evaluate|Object\.call) \(.*devtools\/bridge\.js/.test(l)) break; l = l.replace(/at eval \(eval at evaluate \([^)]*\), (<anonymous>:\d+:\d+)\)/, "at $1"); if (/devtools\/bridge\.js/.test(l)) continue; out.push(l); } return out.join("\n"); }
  function preview(v, depth) {
    depth = depth || 0;
    const t = typeof v;
    if (v === null) return { type: "null", text: "null" };
    if (t === "undefined") return { type: "undefined", text: "undefined" };
    if (t === "string") return { type: "string", text: v.length > 10000 ? v.slice(0, 10000) + "…" : v };
    if (t === "number" || t === "boolean" || t === "bigint") return { type: t, text: String(v) + (t === "bigint" ? "n" : "") };
    if (t === "symbol") return { type: "symbol", text: String(v) };
    if (t === "function") { let s = ""; try { s = Function.prototype.toString.call(v); } catch (e) {} return { type: "function", text: "ƒ " + (v.name || "anonymous") + "()", source: s.slice(0, 4000), objectId: keep(v) }; }
    let cls = "Object"; try { cls = (v.constructor && v.constructor.name) || Object.prototype.toString.call(v).slice(8, -1); } catch (e) {}
    if (v instanceof Error) return { type: "error", className: cls, text: (v.name || "Error") + ": " + v.message, stack: cleanStack(v.stack), objectId: keep(v) };
    if (typeof Node !== "undefined" && v instanceof Node) {
      const d = v.nodeType === 1 ? "<" + v.tagName.toLowerCase() + (v.id ? "#" + v.id : "") + (v.classList && v.classList.length ? "." + [...v.classList].slice(0, 3).join(".") : "") + ">" : v.nodeName;
      return { type: "node", className: cls, text: d, nodeId: idOf(v), path: pathTo(v), objectId: keep(v) };
    }
    const res = { type: "object", className: cls, objectId: keep(v) };
    try {
      const listLike = (typeof NodeList !== "undefined" && v instanceof NodeList) || (typeof HTMLCollection !== "undefined" && v instanceof HTMLCollection);
      if (Array.isArray(v) || ArrayBuffer.isView(v) || listLike) { res.subtype = "array"; res.length = v.length; res.text = cls + "(" + v.length + ")"; if (depth < 1) res.entries = [...Array.prototype.slice.call(v, 0, 20)].map(x => preview(x, depth + 1)); }
      else if (v instanceof Map) { res.subtype = "map"; res.text = "Map(" + v.size + ")"; }
      else if (v instanceof Set) { res.subtype = "set"; res.text = "Set(" + v.size + ")"; }
      else if (v instanceof Date) { res.subtype = "date"; res.text = v.toString(); }
      else if (v instanceof RegExp) { res.subtype = "regexp"; res.text = String(v); }
      else if (typeof Promise !== "undefined" && v instanceof Promise) { res.subtype = "promise"; res.text = "Promise"; }
      else { const keys = Object.keys(v).slice(0, 6); res.text = (cls === "Object" ? "" : cls + " ") + "{" + keys.map(k => { let x; try { x = v[k]; } catch (e) { x = "?"; } const p = typeof x === "object" && x ? (Array.isArray(x) ? "Array(" + x.length + ")" : "{…}") : typeof x === "string" ? JSON.stringify(x.slice(0, 40)) : typeof x === "function" ? "ƒ" : String(x); return k + ": " + p; }).join(", ") + (Object.keys(v).length > 6 ? ", …" : "") + "}"; }
    } catch (e) { res.text = cls; }
    return res;
  }
  function properties(objectId) {
    const v = objects.get(Number(objectId)); if (v == null) throw new Error("Object was released.");
    const out = [];
    if (v instanceof Map) { let i = 0; for (const [k, x] of v) { if (i++ > 200) break; out.push({ name: "[" + (i - 1) + "] " + (typeof k === "string" ? k : preview(k).text), value: preview(x, 1) }); } }
    else if (v instanceof Set) { let i = 0; for (const x of v) { if (i > 200) break; out.push({ name: String(i++), value: preview(x, 1) }); } }
    let names = []; try { names = Object.getOwnPropertyNames(v); } catch (e) {}
    for (const k of names.slice(0, 400)) { let x; try { x = v[k]; } catch (e) { x = e; } out.push({ name: k, value: preview(x, 1) }); }
    try { const proto = Object.getPrototypeOf(v); if (proto) out.push({ name: "[[Prototype]]", value: preview(proto, 1) }); } catch (e) {}
    return out;
  }
  let lastResult;
  function evaluate(expr) {
    const scope = { $0: lastSelected ? lastSelected.deref && lastSelected.deref() : undefined, $_: lastResult };
    try { window.$0 = scope.$0; window.$_ = scope.$_; window.$ = window.$ || (s => document.querySelector(s)); window.$$ = window.$$ || (s => [...document.querySelectorAll(s)]); } catch (e) {}
    let value;
    try { value = (0, eval)(String(expr)); }
    catch (e) {
      if (/await/.test(expr) && e instanceof SyntaxError) value = (0, eval)("(async()=>{return (" + expr + ")})()");
      else return Promise.resolve({ exception: true, value: preview(e) });
    }
    return Promise.resolve(value).then(v => { lastResult = v; return { value: preview(value && typeof value.then === "function" ? v : value), awaited: value && typeof value.then === "function" }; }, e => ({ exception: true, value: preview(e) }));
  }
  let lastSelected = null;

  
  let captureBodies = false; const bodies = new Map();
  let po = null;
  function watchResources(on) {
    if (on && !po && typeof PerformanceObserver === "function") {
      try {
        po = new PerformanceObserver(list => { for (const e of list.getEntries()) emit("network.resource", resEntry(e)); });
        po.observe({ type: "resource", buffered: false });
      } catch (e) { po = null; }
    } else if (!on && po) { po.disconnect(); po = null; }
  }
  function resEntry(e) { return { url: unwrap(e.name) || e.name, initiatorType: e.initiatorType, contentType: e.contentType || "", status: e.responseStatus || 0, transferSize: e.transferSize || 0, encodedBodySize: e.encodedBodySize || 0, decodedBodySize: e.decodedBodySize || 0, duration: Math.round(e.duration), startTime: Math.round(e.startTime), status: e.responseStatus || 0, protocol: e.nextHopProtocol || "" }; }
  function recordBody(id, response) {
    if (!captureBodies || !response) return;
    try {
      const type = String(response.headers.get("content-type") || "");
      if (!/json|text|xml|javascript|css|html|x-www-form|graphql/i.test(type)) { bodies.set(id, { type, text: null, note: "Binary response (" + type + ")" }); return; }
      response.clone().text().then(t => { bodies.set(id, { type, text: t.length > 400000 ? t.slice(0, 400000) : t, truncated: t.length > 400000 }); if (bodies.size > 300) bodies.delete(bodies.keys().next().value); }, () => {});
    } catch (e) {}
  }

  
  function store(kind) { return kind === "session" ? sessionStorage : localStorage; }
  function storageList(kind) { const s = store(kind), out = []; for (let i = 0; i < s.length && i < 2000; i++) { const k = s.key(i); const v = s.getItem(k) || ""; out.push([k, v.length > 20000 ? v.slice(0, 20000) + "…" : v]); } return out; }

  
  const ext = { css: new Map(), scripts: new Map(), zoom: 1 };
  function extStyle(key, css) {
    let el = document.querySelector("style[" + OWN + '="ext-' + key + '"]');
    if (!css) { if (el) el.remove(); ext.css.delete(key); return; }
    if (!el) { el = document.createElement("style"); el.setAttribute(OWN, "ext-" + key); (document.head || document.documentElement).appendChild(el); }
    el.textContent = css; ext.css.set(key, css);
  }
  const AD_SELECTORS = ["[id^='google_ads']", "[id^='div-gpt-ad']", "ins.adsbygoogle", "[class*='ad-slot']", "[class*='adslot']", "[class*='AdSlot']", "[data-ad]", "[data-ad-slot]", "[data-adunit]", "[id*='taboola']", "[id*='outbrain']", ".OUTBRAIN", ".trc_related_container", "iframe[src*='doubleclick']", "iframe[src*='googlesyndication']", "[aria-label='Advertisement']", ".sponsored-content", "[class^='ad-container']", "[class*='-ad-wrapper']"];
  const FEATURES = {
    dark: on => extStyle("dark", on ? "html{filter:invert(.92) hue-rotate(180deg)!important;background:#fff!important}img,video,picture,canvas,iframe,svg image,[style*='background-image']{filter:invert(1) hue-rotate(180deg)!important}" : ""),
    adblock: on => extStyle("adblock", on ? AD_SELECTORS.join(",") + "{display:none!important;visibility:hidden!important}" : ""),
    focus: on => extStyle("focus", on ? "aside,[role=complementary],[class*='sidebar'],[class*='Sidebar'],[class*='newsletter'],[class*='cookie'],[id*='cookie'],[class*='popup'],[class*='modal-backdrop']{display:none!important}body{overflow:auto!important}" : ""),
    readable: on => extStyle("readable", on ? "p,li,dd,blockquote{line-height:1.75!important;max-width:72ch!important}body{font-size:112%!important;letter-spacing:.005em}" : ""),
    links: on => extStyle("links", on ? "a[href]{outline:2px solid rgba(122,166,223,.9)!important;outline-offset:1px;border-radius:2px}" : ""),
    grayscale: on => extStyle("grayscale", on ? "html{filter:grayscale(1)!important}" : ""),
    nosticky: on => { if (!on) return; for (const el of document.querySelectorAll("body *")) { const p = getComputedStyle(el).position; if ((p === "fixed" || p === "sticky") && !own(el)) { const r = el.getBoundingClientRect(); if (r.height < innerHeight * .9 || el.tagName !== "MAIN") el.style.setProperty("position", p === "sticky" ? "relative" : "absolute", "important"); } } }
  };
  function readerView() {
    const cands = [...document.querySelectorAll("article, main, [role=main], .post, .article, .content, #content")];
    let best = null, score = 0;
    for (const c of cands.length ? cands : [document.body]) { const s = (c.innerText || "").length - c.querySelectorAll("a").length * 20; if (s > score) { score = s; best = c; } }
    if (!best) best = document.body;
    const title = document.querySelector("h1") ? document.querySelector("h1").innerText : document.title;
    const blocks = [...best.querySelectorAll("h1,h2,h3,p,li,blockquote,pre,img,figure figcaption")].filter(n => n.tagName === "IMG" ? n.naturalWidth > 200 || n.width > 200 : (n.innerText || "").trim().length > 1).slice(0, 800);
    return { title, url: location.href, byline: (document.querySelector("[rel=author],.author,[class*='byline']") || {}).innerText || "", blocks: blocks.map(n => n.tagName === "IMG" ? { t: "img", src: n.currentSrc || n.src, alt: n.alt || "" } : { t: n.tagName.toLowerCase(), text: n.innerText.trim().slice(0, 6000) }) };
  }
  function pageStats() {
    const text = (document.body && document.body.innerText) || "";
    const words = (text.match(/[\p{L}\p{N}’'-]+/gu) || []).length;
    return { words, characters: text.length, readingMinutes: Math.max(1, Math.round(words / 230)), links: document.links.length, images: document.images.length, headings: document.querySelectorAll("h1,h2,h3,h4,h5,h6").length, forms: document.forms.length, scripts: document.scripts.length };
  }

  
  const api = {
    "page.info": () => ({ url: opts.pageUrl ? opts.pageUrl() : location.href, title: document.title, readyState: document.readyState, userAgent: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, nodes: document.getElementsByTagName("*").length, charset: document.characterSet, contentType: document.contentType, compatMode: document.compatMode }),
    "dom.document": p => { watchDom(true); return ser(document, (p && p.depth) || 3); },
    "dom.children": p => { const n = nodeOf(p.id); return { id: p.id, children: kids(n).map(c => ser(c, (p && p.depth) || 1)) }; },
    "dom.node": p => ser(nodeOf(p.id), 1),
    "dom.highlight": p => highlight(p && p.id ? nodeOf(p.id) : null),
    "dom.pick": p => { setPicking(p && p.enabled); return { enabled: picking }; },
    "dom.select": p => { const n = nodeOf(p.id); lastSelected = typeof WeakRef === "function" ? new WeakRef(n) : { deref: () => n }; return { id: p.id, selector: selectorOf(n), path: pathTo(n) }; },
    "dom.nodeAt": p => { const el = document.elementFromPoint(Number(p.x) || 0, Number(p.y) || 0); if (!el || own(el)) return null; highlight(el); return { id: idOf(el), path: pathTo(el), selector: selectorOf(el) }; },
    "dom.setAttribute": p => { nodeOf(p.id).setAttribute(String(p.name), String(p.value == null ? "" : p.value)); return ser(nodeOf(p.id), 0); },
    "dom.removeAttribute": p => { nodeOf(p.id).removeAttribute(String(p.name)); return ser(nodeOf(p.id), 0); },
    "dom.setText": p => { const n = nodeOf(p.id); if (n.nodeType === 3 || n.nodeType === 8) n.nodeValue = String(p.text); else n.textContent = String(p.text); return true; },
    "dom.outerHTML": p => nodeOf(p.id).outerHTML || nodeOf(p.id).nodeValue || "",
    "dom.setOuterHTML": p => { const n = nodeOf(p.id); const parent = n.parentNode; const t = document.createElement("template"); t.innerHTML = String(p.html); const first = t.content.firstChild; n.replaceWith(t.content); return { parentId: parent ? idOf(parent) : null, id: first ? idOf(first) : null }; },
    "dom.remove": p => { const n = nodeOf(p.id); const parent = n.parentNode; n.remove(); highlight(null); return { parentId: parent ? idOf(parent) : null }; },
    "dom.hide": p => { const n = nodeOf(p.id); if (n.style) n.style.visibility = n.style.visibility === "hidden" ? "" : "hidden"; return true; },
    "dom.scrollIntoView": p => { nodeOf(p.id).scrollIntoView({ block: "center", behavior: "smooth" }); return true; },
    "dom.search": p => {
      const q = String(p.query || "").trim(); if (!q) return [];
      let found = [];
      try { found = [...document.querySelectorAll(q)]; } catch (e) {}
      if (!found.length) { const w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT); let n; const lq = q.toLowerCase(); while ((n = w.nextNode()) && found.length < 200) { if (own(n)) continue; if ((n.outerHTML || "").slice(0, 400).toLowerCase().includes(lq)) found.push(n); } }
      return found.filter(n => !own(n)).slice(0, 200).map(n => ({ id: idOf(n), path: pathTo(n), selector: selectorOf(n) }));
    },
    "css.styles": p => { const el = nodeOf(p.id); const r = collectRules(el); r.inherited = p.inherited ? inherited(el) : []; r.selector = selectorOf(el); return r; },
    "css.computed": p => { const cs = getComputedStyle(nodeOf(p.id)); const out = []; for (let i = 0; i < cs.length; i++) out.push([cs[i], cs.getPropertyValue(cs[i])]); return out.sort((a, b) => a[0].localeCompare(b[0])); },
    "css.setInline": p => { const el = nodeOf(p.id); if (p.value == null || p.value === "") el.style.removeProperty(p.name); else el.style.setProperty(p.name, String(p.value).replace(/!important\s*$/, "").trim(), /!important\s*$/.test(p.value) ? "important" : ""); return propsOf(el.style); },
    "css.setRule": p => { const rule = rules.get(Number(p.ruleId)); if (!rule) throw new Error("Rule is stale. Reselect the element."); if (p.value == null || p.value === "") rule.style.removeProperty(p.name); else rule.style.setProperty(p.name, String(p.value).replace(/!important\s*$/, "").trim(), /!important\s*$/.test(p.value) ? "important" : ""); return propsOf(rule.style); },
    "css.toggleClass": p => { nodeOf(p.id).classList.toggle(String(p.name), p.force); return ser(nodeOf(p.id), 0); },
    "css.forceState": p => {
      const st = String(p.state || "").replace(/[^a-z-]/g, ""); if (!/^(hover|focus|active|visited|focus-within|focus-visible|target)$/.test(st)) throw new Error("Unsupported state " + st);
      const el = nodeOf(p.id); el.toggleAttribute("data-veyra-force-" + st, !!p.on);
      
      const out = []; const re = new RegExp(":" + st + "(?![\\w-])", "g");
      const walk = list => { for (const r of list) { if (r.type === 1 && re.test(r.selectorText)) { re.lastIndex = 0; out.push(r.selectorText.replace(re, "[data-veyra-force-" + st + "]") + "{" + r.style.cssText + "}"); } else if (r.cssRules && r.type !== 1) { try { walk(r.cssRules); } catch (e) {} } re.lastIndex = 0; } };
      for (const sh of document.styleSheets) { if (sh.ownerNode && own(sh.ownerNode)) continue; try { walk(sh.cssRules); } catch (e) {} }
      extStyle("force-" + st, document.querySelector("[data-veyra-force-" + st + "]") ? out.join("\n").slice(0, 400000) : "");
      return true;
    },
    "css.boxModel": p => {
      const el = nodeOf(p.id); const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      const g = k => cs.getPropertyValue(k);
      return { position: g("position"), width: r.width, height: r.height, x: r.left + scrollX, y: r.top + scrollY, boxSizing: g("box-sizing"),
        margin: ["top", "right", "bottom", "left"].map(s => g("margin-" + s)), border: ["top", "right", "bottom", "left"].map(s => g("border-" + s + "-width")), padding: ["top", "right", "bottom", "left"].map(s => g("padding-" + s)),
        content: [el.clientWidth - (parseFloat(g("padding-left")) || 0) - (parseFloat(g("padding-right")) || 0), el.clientHeight - (parseFloat(g("padding-top")) || 0) - (parseFloat(g("padding-bottom")) || 0)],
        offsets: ["top", "right", "bottom", "left"].map(s => g(s)) };
    },
    "runtime.evaluate": p => evaluate(p.expression),
    "runtime.properties": p => properties(p.objectId),
    "runtime.release": () => { objects.clear(); return true; },
    "runtime.completions": p => { const path = String(p.prefix || "").split("."); const last = path.pop(); let obj = window; try { for (const k of path) if (k) obj = obj[k]; } catch (e) { return []; } const out = new Set(); let o = obj; let guard = 0; while (o && guard++ < 6) { try { for (const k of Object.getOwnPropertyNames(o)) if (k.startsWith(last)) out.add(k); } catch (e) {} o = Object.getPrototypeOf(o); } return [...out].sort().slice(0, 80); },
    "network.enable": p => { captureBodies = !!(p && p.bodies); watchResources(true); try { return performance.getEntriesByType("resource").slice(-400).map(resEntry); } catch (e) { return []; } },
    "network.disable": () => { captureBodies = false; watchResources(false); return true; },
    "network.body": p => bodies.get(String(p.id)) || null,
    "storage.list": p => storageList(p.kind),
    "storage.set": p => { store(p.kind).setItem(String(p.key), String(p.value)); return storageList(p.kind); },
    "storage.remove": p => { store(p.kind).removeItem(String(p.key)); return storageList(p.kind); },
    "storage.clear": p => { store(p.kind).clear(); return []; },
    "storage.cookies": () => String(document.cookie || "").split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf("="); return [c.slice(0, i), c.slice(i + 1)]; }),
    "storage.indexedDB": () => (indexedDB && indexedDB.databases ? indexedDB.databases().then(l => l.map(d => ({ name: d.name, version: d.version }))) : []),
    "storage.caches": () => (window.caches ? caches.keys() : []),
    "sources.list": () => {
      const scripts = [...document.scripts].filter(s => !own(s)).map((s, i) => ({ kind: "script", index: i, url: s.src ? unwrap(s.src) || s.src : "", inline: !s.src, type: s.type || "text/javascript", size: s.src ? null : (s.textContent || "").length }));
      const styles = [...document.querySelectorAll("link[rel~=stylesheet],style")].filter(s => !own(s)).map((s, i) => ({ kind: "style", index: i, url: s.href ? unwrap(s.href) || s.href : "", inline: !s.href, size: s.href ? null : (s.textContent || "").length }));
      return { document: { url: opts.pageUrl ? opts.pageUrl() : location.href }, scripts, styles };
    },
    "sources.inline": p => { const list = p.kind === "style" ? [...document.querySelectorAll("link[rel~=stylesheet],style")].filter(s => !own(s)) : [...document.scripts].filter(s => !own(s)); const el = list[Number(p.index)]; return el ? el.textContent || "" : ""; },
    "sources.document": () => "<!DOCTYPE html>\n" + document.documentElement.outerHTML.replace(/<script data-veyra-runtime[\s\S]*?<\/script>/, "").replace(/<[^>]+data-veyra-devtools[^>]*>[\s\S]*?<\/(style|div)>/g, ""),
    "perf.metrics": () => {
      const nav = (performance.getEntriesByType("navigation") || [])[0] || {};
      const paints = {}; for (const e of performance.getEntriesByType("paint") || []) paints[e.name] = Math.round(e.startTime);
      const res = performance.getEntriesByType("resource") || [];
      const byType = {}; for (const r of res) { const k = r.initiatorType || "other"; byType[k] = byType[k] || { count: 0, bytes: 0, time: 0 }; byType[k].count++; byType[k].bytes += r.transferSize || r.encodedBodySize || 0; byType[k].time += r.duration; }
      let lcp = null; try { const l = performance.getEntriesByType("largest-contentful-paint"); if (l && l.length) lcp = Math.round(l[l.length - 1].startTime); } catch (e) {}
      const mem = performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null;
      return { timing: { redirect: Math.round((nav.redirectEnd || 0) - (nav.redirectStart || 0)), dns: Math.round((nav.domainLookupEnd || 0) - (nav.domainLookupStart || 0)), connect: Math.round((nav.connectEnd || 0) - (nav.connectStart || 0)), ttfb: Math.round((nav.responseStart || 0) - (nav.requestStart || 0)), download: Math.round((nav.responseEnd || 0) - (nav.responseStart || 0)), domInteractive: Math.round(nav.domInteractive || 0), domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0), load: Math.round(nav.loadEventEnd || 0) }, paints, lcp, resources: { count: res.length, byType }, memory: mem, nodes: document.getElementsByTagName("*").length, now: Math.round(performance.now()) };
    },
    "ext.feature": p => { const f = FEATURES[p.name]; if (!f) throw new Error("Unknown feature " + p.name); f(!!p.on); return true; },
    "ext.css": p => {
      const css = p.css ? String(p.css) : "";
      if (/@import\b|url\s*\(|javascript\s*:|expression\s*\(|-moz-binding|behavior\s*:|@font-face|@namespace\b/i.test(css)) throw new Error("Veyra only allows isolated CSS extensions; imports, URLs and script-capable constructs are blocked.");
      if (css.length > 120000) throw new Error("Extension CSS exceeds the 120 KB safety limit.");
      extStyle("user-" + String(p.key).replace(/[^\w-]/g, ""), css.slice(0, 120000)); return true;
    },
    "ext.script": p => {
      const key = String(p.key || "user").replace(/[^\w-]/g, "");
      const source = String(p.script || "");
      if (source.length > 200000) throw new Error("Userscript exceeds the 200 KB safety limit.");
      const old = ext.scripts.get(key); if (old) old.remove();
      if (!source.trim()) { ext.scripts.delete(key); return true; }
      const values = Object.create(null);
      const gmGet = name => values[String(name)] ?? null;
      const gmSet = (name, value) => { values[String(name)] = value; return value; };
      const gmStyle = css => { if (String(css).length > 120000) throw new Error("GM_addStyle CSS is too large."); extStyle("script-" + key, String(css)); };
      const run = new Function("GM_getValue", "GM_setValue", "GM_addStyle", `${source}\n//# sourceURL=veyra-userscript-${key}.user.js`);
      run(gmGet, gmSet, gmStyle);
      ext.scripts.set(key, { remove: () => {} }); return true;
    },
    "ext.zoom": p => { ext.zoom = Math.max(.25, Math.min(5, Number(p.zoom) || 1)); document.documentElement.style.zoom = ext.zoom === 1 ? "" : String(ext.zoom); return ext.zoom; },
    "ext.reader": () => readerView(),
    "ext.stats": () => pageStats(),
    "ext.selection": () => String(getSelection ? getSelection() : "").slice(0, 20000),
    "ext.links": () => [...document.links].slice(0, 3000).map(a => ({ href: unwrap(a.href) || a.href, text: (a.innerText || a.title || "").trim().slice(0, 140) })),
    "events.drain": () => queue.splice(0, queue.length)
  };
  const bridge = {
    version: 1,
    call(method, params) {
      const fn = api[method];
      if (!fn) return Promise.reject(new Error("Unknown DevTools method " + method));
      try { return Promise.resolve(fn(params || {})); } catch (e) { return Promise.reject(e); }
    },
    emit, preview, recordBody,
    get captureBodies() { return captureBodies; }
  };
  try { Object.defineProperty(window, "__veyraDevtools", { value: bridge, configurable: false, enumerable: false }); } catch (e) { window.__veyraDevtools = bridge; }
  return bridge;
}

if (typeof module !== "undefined") module.exports = { installVeyraDevtools, source: installVeyraDevtools.toString() };
