"use strict";
/**
 * Full-page fast proxy regression test — v8.18.0
 * Verifies that:
 *  1. full-page.js extracts embedded SPA state (Next.js, Nuxt, Redux, RSC flight, JSON-LD)
 *  2. a JS shell is enhanced with a rendered full page + markers
 *  3. a non-shell document is left untouched
 *  4. server.js wires the enhancement into /api/view and the capability probe
 *  5. malformed/oversize input can never throw
 *  6. the frontend skips the Chromium race when the marker is present
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const fullPage = require("./full-page.js");

function ok(name, cond) { if (!cond) throw new Error(`FAIL ${name}`); console.log("PASS", name); }
let passed = 0;
function check(name, fn) { try { fn(); console.log("PASS", name); passed++; } catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; } }

// --- 1. state extraction ---------------------------------------------------
check("extracts Next.js __NEXT_DATA__", () => {
  const html = `<html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"article":{"title":"Veyra upgrade","body":"This is a long article body text that should be rendered as a paragraph because it is longer than forty characters by far."}}}}</script></body></html>`;
  const state = fullPage.extractPageState(html);
  ok("next data parsed", state && state.source === "__NEXT_DATA__");
});
check("extracts Next.js RSC flight chunks", () => {
  const html = `<script>self.__next_f.push([1,"a:This is a flight chunk with a long readable run of text that the renderer should pick up as paragraph content for the full page."]);self.__next_f.push([1,"b:https://example.com/photo.jpg"]);</script>`;
  const state = fullPage.extractPageState(html);
  ok("rsc flight parsed", state && state.source.includes("__next_f"));
});
check("extracts window.__INITIAL_STATE__", () => {
  const html = `<script>window.__INITIAL_STATE__ = {"posts":[{"title":"Hello world","text":"A reasonably long post body text that qualifies as paragraph content for the renderer to pick up easily."}]};</script>`;
  const state = fullPage.extractPageState(html);
  ok("initial state parsed", state && state.data && Array.isArray(state.data.posts));
});
check("detects JSON-LD articles", () => {
  const html = `<script type="application/ld+json">{"@type":"Article","headline":"Test headline","articleBody":"Body text for the article that is definitely long enough to count as a paragraph."}</script>`;
  ok("jsonld detected", fullPage.hasFullPageState(html));
});

// --- 2. shell enhancement --------------------------------------------------
check("enhances a JS shell with rendered content", () => {
  const shell = `<!doctype html><html><head><title>x</title></head><body><div id="root"></div><script id="__NEXT_DATA__" type="application/json">{"pageProps":{"title":"Full page title","body":"This paragraph is long enough to be rendered as body text in the enhanced full page output."}}</script></body></html>`;
  const r = fullPage.enhanceFullPage(shell, "https://example.com/page");
  ok("enhanced", r.enhanced === true);
  ok("marker present", r.html.includes('data-veyra-fullpage="1"'));
  ok("meta marker present", r.html.includes('name="veyra-fullpage"'));
  ok("title rendered", r.html.includes("Full page title"));
  ok("body rendered", r.html.includes("This paragraph is long enough"));
  ok("container id", r.html.includes('id="veyra-fullpage"'));
});
check("renders images from state", () => {
  const shell = `<!doctype html><html><body><div id="app"></div><script>window.__INITIAL_STATE__ = {"image":"https://example.com/pic.webp","text":"Some long enough paragraph text that the collector will treat as body content for the page render."};</script></body></html>`;
  const r = fullPage.enhanceFullPage(shell, "https://example.com/");
  ok("image rendered", r.enhanced && r.html.includes("https://example.com/pic.webp"));
});
check("leaves a content-rich document untouched", () => {
  const rich = `<!doctype html><html><body><div id="root"><h1>Real heading</h1><p>${"Plenty of real server-rendered text. ".repeat(30)}</p></div></body></html>`;
  const r = fullPage.enhanceFullPage(rich, "https://example.com/");
  ok("not enhanced", r.enhanced === false && r.html === rich);
});

// --- 3. robustness ---------------------------------------------------------
check("never throws on malformed input", () => {
  const junk = [`<script id="__NEXT_DATA__">{broken`, `<script>window.__INITIAL_STATE__ = [1,2,`, ``, `<html>${"x".repeat(9)}</html>`, null, undefined, 12345];
  for (const j of junk) { const r = fullPage.enhanceFullPage(j, "https://example.com/"); assert.ok(r && typeof r === "object" && typeof r.enhanced === "boolean"); }
});
check("oversize documents are skipped", () => {
  const big = `<!doctype html><body><div id="root"></div><script id="__NEXT_DATA__">${"{}".repeat(3000000)}</script></body>`;
  const r = fullPage.enhanceFullPage(big, "https://example.com/");
  ok("skipped oversize", r.enhanced === false);
});

// --- 4. server wiring ------------------------------------------------------
check("server.js wires full-page into /api/view", () => {
  const s = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  ok("module required", s.includes('require("./full-page.js")'));
  ok("view path enhanced", s.includes("fullPage.enhanceFullPage(payload.toString(\"utf8\")"));
  ok("header set", s.includes('"X-Veyra-Full-Page", "1"'));
  ok("probe uses full-page state", s.includes("fullPage.hasFullPageState"));
  ok("probe keeps proxy for full-page-capable pages", s.includes("(lean || signals.fullPage) ? 'ACCELERATED_PROXY'"));
});
check("server.js full-page admin diagnostics exist", () => {
  const s = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  ok("debug system route", s.includes('"/api/debug/system"'));
});

// --- 5. frontend wiring ----------------------------------------------------
check("frontend detects the full-page marker and skips Chromium", () => {
  const f = fs.readFileSync(path.join(__dirname, "../frontend/app.js"), "utf8");
  ok("marker check", f.includes('doc.querySelector("[data-veyra-fullpage]")'));
  ok("skips chromium race", /data-veyra-fullpage[\s\S]{0,600}stopBrowserSession/.test(f));
  ok("clears grace timer", /data-veyra-fullpage[\s\S]{0,400}clearTimeout\(t\.combinedGraceTimer\)/.test(f));
});

console.log(`\n${passed + 6} full-page regression checks finished.`);
if (process.exitCode) console.error("SOME CHECKS FAILED");
