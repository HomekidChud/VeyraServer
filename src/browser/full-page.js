"use strict";
/**
 * Veyra Full-Page Fast Proxy ("proxy+ full page") — v8.18.0
 *
 * Goal: the fast proxy pipeline returns the FULL page for JS-heavy sites
 * without launching Chromium. Chromium is the most compatible engine but the
 * slowest and heaviest (150 MB+ per session, multi-second startup, and it
 * destabilises the 512 MB Render Free profile). This module extracts the
 * server-rendered state that modern sites embed in their initial HTML
 * response and, when the page is just a JS shell, renders that state into a
 * readable full document server-side.
 *
 * Sources of embedded state (in priority order):
 *   1. <script id="__NEXT_DATA__"> JSON        — Next.js Pages Router
 *   2. self.__next_f.push(...) flight chunks   — Next.js App Router (RSC)
 *   3. window.__NUXT__ / __NUXT_DATA__         — Nuxt 2/3
 *   4. window.__INITIAL_STATE__ / __PRELOADED_STATE__ / __APP_STATE__ /
 *      __REDUX_STATE__ / __APOLLO_STATE__ / __INITIAL_PROPS__
 *   5. data-props / data-server-data JSON attributes
 *   6. <script type="application/ld+json">     — structured data (Article etc.)
 *
 * Everything here is intentionally dependency-free (regex + JSON.parse),
 * strictly size-bounded and fully try/catch-guarded: a parsing failure can
 * only mean "no enhancement", never a failed request.
 */

const MAX_HTML_SCAN_BYTES = 4 * 1024 * 1024;   
const MAX_STATE_BYTES = 2 * 1024 * 1024;      
const MAX_RENDER_BYTES = 256 * 1024;          
const MAX_WALK_NODES = 20000;                 
const MAX_ITEMS = { paragraphs: 400, headings: 120, images: 80, links: 200 };


function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function safeJsonParse(text) {
  if (typeof text !== "string" || !text.trim() || text.length > MAX_STATE_BYTES) return null;
  try { return JSON.parse(text); } catch { return null; }
}
function resolveUrl(u, base) {
  try { const abs = new URL(String(u), base); return /^https?:$/.test(abs.protocol) ? abs.href : null; } catch { return null; }
}
function looksLikeImageUrl(v) {
  return typeof v === "string" && /^https?:\/\//i.test(v) && /\.(?:jpe?g|png|webp|gif|avif|svg)(?:[?#]|$)/i.test(v);
}
function cleanText(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, 4000);
}


function extractNextData(html) {
  const m = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  return { source: "__NEXT_DATA__", data: safeJsonParse(m ? m[1] : "") };
}
function extractNuxt(html) {
  let m = /<script[^>]*>\s*window\.__NUXT__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i.exec(html);
  if (m) return { source: "__NUXT__", data: safeJsonParse(m[1]) };
  m = /<script[^>]+id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (m) return { source: "__NUXT_DATA__", data: safeJsonParse(m[1]) };
  return { source: null, data: null };
}
function extractWindowState(html) {
  const names = ["__INITIAL_STATE__", "__PRELOADED_STATE__", "__INITIAL_STATE", "INITIAL_STATE",
    "__APP_STATE__", "__REDUX_STATE__", "__APOLLO_STATE__", "__INITIAL_PROPS__", "__PAGE_PROPS__", "__SVELTE_HMR_DATA__"];
  for (const n of names) {
    const re = new RegExp(`<script[^>]*>\\s*(?:window\\.)?${n}\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;?\\s*(?:<\\/script>|$)`, "i");
    const m = re.exec(html);
    const data = m ? safeJsonParse(m[1]) : null;
    if (data && typeof data === "object") return { source: n, data };
  }
  return { source: null, data: null };
}
function extractDataProps(html) {
  const m = /data-(?:props|server-data|page-data)\s*=\s*"([^"]{2,MAX_STATE_BYTES})"/i.exec(html);
  if (!m) return { source: null, data: null };
  let decoded = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'");
  return { source: "data-props", data: safeJsonParse(decoded) };
}



function extractRscFlight(html) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\s*\[\s*\d+\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]/g;
  let m, guard = 0;
  while ((m = re.exec(html)) && chunks.length < 4000 && guard++ < 20000) {
    try { chunks.push(JSON.parse('"' + m[1] + '"')); } catch { /* skip bad chunk */ }
  }
  if (!chunks.length) return { source: null, data: null };
  const flight = chunks.join("");
  return { source: "__next_f (RSC flight)", data: { __veyraFlightText: flight } };
}
function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m, guard = 0;
  while ((m = re.exec(html)) && out.length < 40 && guard++ < 200) {
    const data = safeJsonParse(m[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, ""));
    if (data) out.push(data);
  }
  return out;
}

/** Best embedded state for a document, or null. */
function extractPageState(html) {
  if (typeof html !== "string" || !html || html.length > MAX_HTML_SCAN_BYTES) return null;
  for (const extract of [extractNextData, extractRscFlight, extractNuxt, extractWindowState, extractDataProps]) {
    try {
      const r = extract(html);
      if (r.data && typeof r.data === "object") return { source: r.source, data: r.data };
    } catch { /* extractor bug must never break the proxy */ }
  }
  return null;
}
/** True when the document carries embedded state we can render. */
function hasFullPageState(html) {
  return extractPageState(html) !== null || extractJsonLd(html).some(d => d && (d.headline || d.articleBody || d.itemListElement));
}


const HEADING_KEYS = /^(title|headline|name|heading|subtitle|label|question)$/i;
const PARAGRAPH_KEYS = /^(text|body|description|content|summary|caption|snippet|answer|articleBody|text_body|markdown|html)$/i;
const IMAGE_KEYS = /(image|thumbnail|avatar|logo|cover|poster|photo|picture)/i;
const LINK_OBJ_KEYS = /^(url|link|href|slug|permalink)$/i;

function collectFromNode(node, out, depth, budget) {
  if (!node || budget.used > MAX_WALK_NODES || out.bytes > MAX_RENDER_BYTES) return;
  budget.used++;
  if (Array.isArray(node)) {
    for (const item of node) collectFromNode(item, out, depth + 1, budget);
    return;
  }
  if (typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (out.bytes > MAX_RENDER_BYTES || budget.used > MAX_WALK_NODES) return;
    if (typeof value === "string") {
      const text = cleanText(value);
      if (!text || text.length < 2) continue;
      if (IMAGE_KEYS.test(key) && looksLikeImageUrl(value)) {
        if (out.images.length < MAX_ITEMS.images) { out.images.push(value); out.bytes += value.length; }
      } else if (looksLikeImageUrl(value)) {
        if (out.images.length < MAX_ITEMS.images) { out.images.push(value); out.bytes += value.length; }
      } else if (PARAGRAPH_KEYS.test(key) && text.length >= 40) {
        if (out.paragraphs.length < MAX_ITEMS.paragraphs) { out.paragraphs.push(text); out.bytes += text.length; }
      } else if (HEADING_KEYS.test(key) && text.length >= 3 && text.length <= 160) {
        if (out.headings.length < MAX_ITEMS.headings) { out.headings.push(text); out.bytes += text.length; }
      } else if (text.length >= 80) {
        if (out.paragraphs.length < MAX_ITEMS.paragraphs) { out.paragraphs.push(text); out.bytes += text.length; }
      }
    } else if (value && typeof value === "object") {
      
      const linkUrl = LINK_OBJ_KEYS.test("") ? null : Object.entries(value).find(([k]) => LINK_OBJ_KEYS.test(k));
      if (linkUrl && typeof linkUrl[1] === "string" && out.links.length < MAX_ITEMS.links) {
        const title = cleanText(value.title || value.name || value.text || linkUrl[1]);
        out.links.push({ url: linkUrl[1], title });
        out.bytes += title.length;
      }
      collectFromNode(value, out, depth + 1, budget);
    }
  }
}

function collectFromFlight(flightText, out) {
  
  
  const text = String(flightText || "");
  const runs = text.match(/[\w\s'’\-.,:;!?()"\u00C0-\u024F]{60,}/g) || [];
  for (const run of runs) {
    const t = cleanText(run);
    if (t.length >= 60 && out.paragraphs.length < MAX_ITEMS.paragraphs) out.paragraphs.push(t);
  }
  const imgs = text.match(/https?:\/\/[^\s"'\\]+?\.(?:jpe?g|png|webp|gif|avif)(?:[?#][^\s"'\\]*)?/gi) || [];
  for (const img of imgs) {
    if (out.images.length >= MAX_ITEMS.images) break;
    if (!out.images.includes(img)) out.images.push(img);
  }
}

function collectFromJsonLd(blocks, out) {
  const visit = (d) => {
    if (!d || typeof d !== "object") return;
    if (Array.isArray(d)) return d.forEach(visit);
    const type = String(d["@type"] || "");
    if (d.headline && out.headings.length < MAX_ITEMS.headings) out.headings.push(cleanText(d.headline));
    if (d.articleBody) {
      const body = cleanText(d.articleBody);
      if (body.length > 40 && out.paragraphs.length < MAX_ITEMS.paragraphs) out.paragraphs.push(body);
    }
    if (d.description) {
      const body = cleanText(d.description);
      if (body.length > 40 && out.paragraphs.length < MAX_ITEMS.paragraphs) out.paragraphs.push(body);
    }
    if (d.image) {
      const imgs = Array.isArray(d.image) ? d.image : [d.image];
      for (const im of imgs) {
        const u = typeof im === "string" ? im : im && im.url;
        if (u && looksLikeImageUrl(u) && out.images.length < MAX_ITEMS.images) out.images.push(u);
      }
    }
    if (type === "ItemList" && Array.isArray(d.itemListElement)) {
      for (const el of d.itemListElement) {
        const item = el && (el.item || el);
        const name = cleanText(item && (item.name || item.title));
        const u = item && (item.url || (typeof item["@id"] === "string" && item["@id"]));
        if (name && u && out.links.length < MAX_ITEMS.links) out.links.push({ url: u, title: name });
      }
    }
    if (d.mainEntityOfPage || d.mainEntity) visit(d.mainEntity || d.mainEntityOfPage);
  };
  blocks.forEach(visit);
}


function renderFullPage(content, baseUrl) {
  const parts = [];
  const seen = new Set();
  const push = (s) => { if (parts.length < 4000 && Buffer.byteLength(parts.join(""), "utf8") < MAX_RENDER_BYTES) parts.push(s); };
  
  const title = content.headings[0];
  if (title) push(`<h1>${esc(title)}</h1>`);
  for (let i = 1; i < content.headings.length && i <= 60; i++) push(`<h2>${esc(content.headings[i])}</h2>`);
  
  for (const p of content.paragraphs.slice(0, MAX_ITEMS.paragraphs)) {
    if (/<script|<iframe|javascript:/i.test(p)) continue;
    const html = /<\/?[a-z][\s\S]*>/i.test(p) ? p : esc(p); 
    push(`<p>${html.slice(0, 8000)}</p>`);
  }
  if (content.images.length) {
    push('<div class="veyra-fp-media">');
    for (const img of content.images.slice(0, 24)) {
      const u = resolveUrl(img, baseUrl);
      if (!u || seen.has(u)) continue;
      seen.add(u);
      push(`<img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer">`);
    }
    push("</div>");
  }
  if (content.links.length) {
    push("<ul>");
    for (const l of content.links.slice(0, 100)) {
      const u = resolveUrl(l.url, baseUrl);
      if (!u) continue;
      push(`<li><a href="${esc(u)}">${esc(l.title || u)}</a></li>`);
    }
    push("</ul>");
  }
  if (!parts.length) return "";
  return `<div id="veyra-fullpage" data-veyra-fullpage="1"><style>#veyra-fullpage{font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e8e8e8;max-width:760px;margin:0 auto;padding:24px 20px;word-wrap:break-word}#veyra-fullpage h1{font-size:1.55em;margin:.4em 0}#veyra-fullpage h2{font-size:1.2em;margin:1em 0 .4em;color:#cfd8dc}#veyra-fullpage p{margin:.6em 0}#veyra-fullpage img{max-width:100%;height:auto;border-radius:8px;margin:6px 0}#veyra-fullpage .veyra-fp-media{display:flex;flex-wrap:wrap;gap:8px}#veyra-fullpage ul{padding-left:20px}#veyra-fullpage a{color:#8ab4f8}</style>${parts.join("\n")}</div>`;
}


function visibleTextLength(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}
function looksLikeShell(html) {
  if (typeof html !== "string" || !html) return false;
  if (html.length > MAX_HTML_SCAN_BYTES) return false;
  const hasAppRoot = /<div[^>]+(?:id|class)=["'][^"']*(?:root|app|__next|__nuxt|svelte|q-wrap)[^"']*["']/i.test(html);
  const scriptCount = (html.match(/<script\b/gi) || []).length;
  
  
  
  return visibleTextLength(html) < 600 && (hasAppRoot || scriptCount > 0);
}

/**
 * Main entry point. Given the raw upstream HTML, return an enhanced HTML
 * string when the page's real content lives in embedded state rather than in
 * visible markup. Never throws.
 *
 * Trigger rule: the collected state text must be substantial AND the visible
 * markup must show little of it — either a classic empty app shell, or a
 * low-text document whose embedded state carries several times more content
 * than the markup shows (typical for CSR apps that ship a nav chrome plus a
 * giant __NEXT_DATA__ blob). Fully server-rendered documents are left alone.
 * @returns {{ html: string, enhanced: boolean, source: string|null }}
 */
function enhanceFullPage(html, baseUrl) {
  const result = { html, enhanced: false, source: null };
  try {
    if (typeof html !== "string" || !html || html.length > MAX_HTML_SCAN_BYTES) return result;
    const visible = visibleTextLength(html);
    if (visible >= 1500 && !looksLikeShell(html)) return result;
    const content = { headings: [], paragraphs: [], images: [], links: [], bytes: 0 };
    const state = extractPageState(html);
    if (state) {
      result.source = state.source;
      if (state.source && state.source.includes("__next_f")) collectFromFlight(state.data.__veyraFlightText, content);
      else collectFromNode(state.data, content, 0, { used: 0 });
    }
    const ld = extractJsonLd(html);
    if (ld.length) { collectFromJsonLd(ld, content); result.source = result.source || "ld+json"; }
    const stateText = content.headings.join(" ").length + content.paragraphs.join(" ").length;
    const meaningful = content.headings.length + content.paragraphs.length + Math.min(content.images.length, 4) >= 2 && stateText >= 80;
    if (!meaningful) return result;
    
    if (!looksLikeShell(html) && stateText < visible * 2) return result;
    const fragment = renderFullPage(content, baseUrl);
    if (!fragment) return result;
    
    
    let injected = html;
    const marker = `<meta name="veyra-fullpage" content="1" data-veyra-fullpage-source="${esc(result.source || "")}">`;
    if (/<\/head>/i.test(injected)) injected = injected.replace(/<\/head>/i, marker + "</head>");
    else if (/<body[^>]*>/i.test(injected)) injected = injected.replace(/<body([^>]*)>/i, (m) => m + marker);
    if (/<\/body>/i.test(injected)) injected = injected.replace(/<\/body>/i, fragment + "</body>");
    else injected += fragment;
    result.html = injected;
    result.enhanced = true;
  } catch { /* enhancement is best-effort only */ }
  return result;
}

module.exports = {
  extractPageState,
  hasFullPageState,
  extractJsonLd,
  looksLikeShell,
  visibleTextLength,
  enhanceFullPage,
  renderFullPage,
  VERSION: "8.18.0",
};
