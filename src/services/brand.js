"use strict";







const fs = require("fs");
const path = require("path");

const BRAND_DIR = path.join(__dirname, "..", "..", "brand");
const ASSETS = {
  "/favicon.ico": ["favicon.ico", "image/x-icon"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
  "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"],
  "/apple-touch-icon-precomposed.png": ["apple-touch-icon.png", "image/png"],
  "/icon-192.png": ["icon-192.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
  "/og.png": ["og.png", "image/png"]
};
const RESERVED = new Set(["/", ...Object.keys(ASSETS), "/robots.txt", "/manifest.json", "/site.webmanifest", "/manifest.webmanifest", "/browserconfig.xml", "/.well-known/security.txt", "/humans.txt", "/sitemap.xml", "/ads.txt"]);
const cache = new Map();
function asset(file) {
  if (!cache.has(file)) { try { cache.set(file, fs.readFileSync(path.join(BRAND_DIR, file))); } catch { cache.set(file, null); } }
  return cache.get(file);
}
function isReservedOriginPath(p) {
  const s = String(p || "");
  return RESERVED.has(s) || /^\/apple-touch-icon[\w-]*\.png$/i.test(s) || /^\/favicon[\w-]*\.(?:ico|png|svg)$/i.test(s) || /^\/android-chrome-[\w-]+\.png$/i.test(s) || /^\/mstile-[\w-]+\.png$/i.test(s);
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function originOf(req) { return `${req.protocol}://${req.get("host")}`; }

function meta(req, { title, description, frontend }) {
  const origin = originOf(req);
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<meta name="description" content="${esc(description)}"><meta name="theme-color" content="#0d0f13"><meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.json">
<meta property="og:type" content="website"><meta property="og:site_name" content="Veyra Browser"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(origin)}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:url" content="${esc(frontend)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${esc(origin)}/og.png">`;
}
const STYLE = `<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(1200px 600px at 80% -10%,#1a2440,transparent),#0d0f13;color:#e8ecf3;font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:520px;padding:40px 28px;text-align:center}img{width:72px;height:72px;border-radius:18px;box-shadow:0 10px 40px #0008}h1{font-size:28px;margin:18px 0 6px;letter-spacing:-.02em}p{color:#a5b0c4;margin:0 0 22px}a.btn{display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 20px;border-radius:999px;background:#8fb0f0;color:#0d0f13;font-weight:700;text-decoration:none}a.btn:focus-visible{outline:2px solid #fff;outline-offset:3px}small{display:block;margin-top:22px;color:#6f7a8e}small a{color:#8fb0f0}</style>`;

function landingHtml(req, frontend, version) {
  const redirect = !("stay" in (req.query || {}));
  return `<!doctype html><html lang="en"><head>${meta(req, { title: "Veyra Browser", description: "Private cloud browsing in a clean, self-deleting session — fast proxy, real Chromium, incognito and VPN.", frontend })}
${redirect ? `<meta http-equiv="refresh" content="2;url=${esc(frontend)}">` : ""}${STYLE}</head><body><main>
<img src="/icon-192.png" alt="" width="72" height="72"><h1>Veyra server is online</h1>
<p>This is the Veyra Browser API. Open the browser app to start a private session.</p>
<a class="btn" href="${esc(frontend)}">Open Veyra Browser</a>
<small>v${esc(version)} · <a href="/health">health</a> · <a href="/status">status</a></small>
</main></body></html>`;
}
function previewHtml(req, frontend) {
  return `<!doctype html><html lang="en"><head>${meta(req, { title: "Opened with Veyra Browser", description: "This link was shared from a private Veyra Browser session. Open Veyra to browse it in a clean cloud session.", frontend })}${STYLE}</head><body><main><img src="/icon-192.png" alt="" width="72" height="72"><h1>Veyra Browser</h1><p>Shared from a private Veyra session.</p><a class="btn" href="${esc(frontend)}">Open Veyra Browser</a></main></body></html>`;
}
function brandNotFoundHtml(frontend) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found · Veyra</title><meta name="robots" content="noindex"><link rel="icon" href="/favicon.svg" type="image/svg+xml">${STYLE}</head><body><main><img src="/icon-192.png" alt="" width="72" height="72"><h1>Nothing here</h1><p>This address isn't part of the Veyra server.</p><a class="btn" href="${esc(frontend)}">Open Veyra Browser</a></main></body></html>`;
}

function installBrandRoutes(app, { frontendUrl, version = "", isPreviewBot = () => false, hasProxiedReferer = () => false }) {
  const front = () => (typeof frontendUrl === "function" ? frontendUrl() : frontendUrl) || "https://homekidchud.github.io/VeyraBrowser/";
  
  
  const passThrough = req => hasProxiedReferer(req);

  app.get("/", (req, res, next) => {
    if (passThrough(req)) return next();
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("html").send(landingHtml(req, front(), version));
  });
  for (const [route, [file, type]] of Object.entries(ASSETS)) {
    app.get(route, (req, res, next) => {
      if (passThrough(req)) return next();
      const buf = asset(file); if (!buf) return next();
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.type(type).send(buf);
    });
  }
  app.get(/^\/(?:apple-touch-icon[\w-]*|android-chrome-[\w-]+|mstile-[\w-]+|favicon-[\w-]+)\.png$/i, (req, res, next) => {
    if (passThrough(req)) return next();
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("image/png").send(asset("icon-192.png"));
  });
  const manifest = (req, res, next) => {
    if (passThrough(req)) return next();
    res.type("application/manifest+json").json({ name: "Veyra Browser", short_name: "Veyra", start_url: front(), display: "standalone", background_color: "#0d0f13", theme_color: "#0d0f13", icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png" }] });
  };
  app.get(["/manifest.json", "/site.webmanifest", "/manifest.webmanifest"], manifest);
  app.get("/robots.txt", (req, res, next) => {
    if (passThrough(req)) return next();
    res.type("text/plain").send("User-agent: *\nDisallow: /api/\nDisallow: /status\nDisallow: /console\nAllow: /$\n");
  });
  app.get("/.well-known/security.txt", (req, res) => res.type("text/plain").send("Contact: https://github.com/HomekidChud/VeyraServer/issues\nPreferred-Languages: en\n"));
  
  
  app.get(["/api/view", "/api/form-get/:a/:b"], (req, res, next) => {
    if (!isPreviewBot(req.get("User-Agent"))) return next();
    res.setHeader("Cache-Control", "public, max-age=600");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(previewHtml(req, front()));
  });
}

module.exports = { installBrandRoutes, isReservedOriginPath, brandNotFoundHtml, landingHtml, RESERVED };
