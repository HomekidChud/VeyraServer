"use strict";

const { isIP } = require("node:net");

function cleanText(value, limit) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function publicImageUrl(value, base) {
  if (typeof value !== "string" || !value.trim() || value.length > 1600) return "";
  try {
    const url = new URL(value.trim(), base);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !url.hostname.includes(".") || isIP(url.hostname) || /(?:^|\.)(?:localhost|local|internal)$/i.test(url.hostname)) return "";
    if (/(?:^|[./_-])(?:favicon|tracking|pixel|spacer|transparent|placeholder|avatar|sprite|logo)(?:[./_-]|$)/i.test(url.pathname)) return "";
    for (const name of [...url.searchParams.keys()]) {
      if (/^(?:utm_|fbclid$|gclid$)/i.test(name)) url.searchParams.delete(name);
      else if (/(?:token|secret|password|session|signature|credential|authorization|access[_-]?key|api[_-]?key|^auth$|^key$|^sig$|^code$|^jwt$|^x-amz-|^x-goog-)/i.test(name)) return "";
    }
    url.hash = "";
    return url.href.length <= 1600 ? url.href : "";
  } catch { return ""; }
}

function readCrawlPageData($, base) {
  const images = new Map(), structured = [], jsonLd = [], directives = [];
  let imageBytes = 0;
  function image(raw, label, width, height) {
    const url = publicImageUrl(raw, base);
    if (!url || (+width > 0 && +width < 48) || (+height > 0 && +height < 48)) return false;
    const title = cleanText(label, 200);
    if (images.has(url)) {
      const existing = images.get(url);
      if (!existing.title && title) existing.title = title;
      return true;
    }
    if (images.size >= 20 || imageBytes + url.length > 8000) return false;
    imageBytes += url.length;
    images.set(url, { url, title });
    return true;
  }
  $('meta[name="robots" i], meta[name="veyraneuralbot" i], meta[name="veyrascan" i]').each((_, element) => {
    const value = $(element).attr("content") || "";
    for (const name of ["noindex", "nofollow", "noimageindex", "none"]) {
      if (new RegExp(`\\b${name}\\b`, "i").test(value) && !directives.includes(name)) directives.push(name);
    }
  });
  $("meta[name], meta[property]").slice(0, 200).each((_, element) => {
    const node = $(element), name = (node.attr("property") || node.attr("name") || "").toLowerCase();
    const value = node.attr("content");
    if (/^(?:og:image(?::(?:url|secure_url))?|twitter:image(?::src)?)$/.test(name)) {
      const alt = name.startsWith("og:") ? 'meta[property="og:image:alt"]' : 'meta[name="twitter:image:alt"]';
      image(value, $(alt).first().attr("content"));
    }
  });
  $('link[rel~="image_src"]').slice(0, 10).each((_, node) => image($(node).attr("href")));

  const nodes = [];
  $('script[type="application/ld+json"]').slice(0, 8).each((_, element) => {
    const source = $(element).text();
    if (source.length > 24000) return;
    try { const value = JSON.parse(source); jsonLd.push(value); nodes.push(value); } catch {}
  });
  for (let i = 0; i < nodes.length && i < 30; i++) {
    const node = nodes[i];
    if (Array.isArray(node)) { nodes.push(...node.slice(0, 12)); continue; }
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node["@graph"])) nodes.push(...node["@graph"].slice(0, 12));
    if (node.mainEntity && typeof node.mainEntity === "object") nodes.push(node.mainEntity);
    const type = [node["@type"]].flat().filter(value => typeof value === "string").join(" ");
    if (/\b(?:NewsArticle|Article|BlogPosting|TechArticle|Report|ScholarlyArticle|WebPage)\b/i.test(type)) {
      for (const [value, limit] of [[node.headline, 300], [node.description, 600], [node.articleBody, 5000]]) {
        const text = cleanText(value, limit);
        if (text) structured.push(text);
      }
    }
    if (/\bImageObject\b/i.test(type)) image(node.contentUrl || node.url || node.thumbnailUrl, node.caption || node.name, node.width, node.height);
    for (const raw of [node.image, node.primaryImageOfPage, node.thumbnailUrl].flat().slice(0, 8)) {
      if (typeof raw === "string") image(raw, node.headline || node.name);
      else if (raw) image(raw.contentUrl || raw.url || raw.thumbnailUrl, raw.caption || raw.name || node.headline, raw.width, raw.height);
    }
  }

  // Search the content first. Scan the remaining document for galleries that
  // live outside <main>, but skip obvious browser chrome and decorative assets.
  const elements = $("main img, article img, figure img").slice(0, 160).toArray();
  for (const el of $("img").slice(0, 240).toArray()) if (!elements.includes(el)) elements.push(el);
  for (const el of elements) {
    if (images.size >= 20) break;
    const img = $(el);
    if (img.closest("header,footer,nav,aside,[aria-hidden=true]").length || img.attr("role") === "presentation") continue;
    const label = img.attr("alt") || img.closest("figure").find("figcaption").first().text() || img.attr("title");
    const sources = img.parent("picture").children("source").slice(0, 6).toArray().map(source => $(source)).concat(img);
    const candidates = [];
    for (const source of sources) for (const attribute of ["srcset", "data-srcset", "data-lazy-srcset"]) {
      const list = source.attr(attribute);
      if (!list || list.length > 8000 || /^\s*data:/i.test(list)) continue;
      for (const part of list.split(",").slice(0, 16)) {
        const [url, size] = part.trim().split(/\s+/, 2);
        if (url) candidates.push({ url, size: Number.parseFloat(size) * (size?.endsWith("x") ? 1000 : 1) || 0 });
      }
    }
    candidates.sort((a, b) => b.size - a.size);
    candidates.push(...["data-src", "data-lazy-src", "data-original", "src"].map(attribute => ({ url: img.attr(attribute) })));
    for (const candidate of candidates) if (image(candidate.url, label, img.attr("width"), img.attr("height"))) break;
  }
  return { images: [...images.values()], structured: [...new Set(structured)].join(" ").slice(0, 6000), jsonLd, directives };
}

module.exports = { readCrawlPageData, publicImageUrl };
