"use strict";

const cheerio = require("cheerio");
const { isTopicalResult } = require("./websearch");

const STORES = Object.freeze({
  "www.boat-lifestyle.com": "boAt",
  "www.headphonezone.in": "Headphone Zone",
  "www.portronics.com": "Portronics",
  "www.amkette.com": "Amkette"
});
const PRODUCT_BYTES = 2 * 1024 * 1024;

function merchantProductUrl(value, host) {
  try {
    const u = host ? new URL(value, `https://${host}/`) : new URL(value);
    if (u.protocol !== "https:" || u.port || u.username || u.password || !Object.hasOwn(STORES, u.hostname) ||
        (host && u.hostname !== host) || !/^\/products\/[a-z0-9][a-z0-9-]{0,180}\/?$/i.test(u.pathname)) return "";
    return `${u.origin}${u.pathname.replace(/\/$/, "")}`;
  } catch { return ""; }
}

function merchandiseText(value, limit = 4000) {
  if (typeof value !== "string") return "";
  const $ = cheerio.load(value.slice(0, 16_000), {}, false);
  $("script,style,iframe,template").remove();
  $("p,div,li,tr,br").after(" ");
  return $.root().text().replace(/\s+/g, " ").trim().slice(0, limit);
}

function specText(value) {
  return value.toLowerCase().replace(/\btype[\s-]*c\b|\busb[\s-]*c\b/g, "usb c").replace(/\b(\d+)\s*w(?:atts?)?\b/g, "$1w");
}

function productMatch(q, item, category) {
  const subject = specText(q).replace(/\b(?:buy|online|india|price|best)\b/g, " ").trim();
  if (!subject) return false;
  const title = specText(item.title), description = specText(item.snippet);
  const wattage = [...subject.matchAll(/\b\d{1,4}w\b/g)].map(x => x[0]);
  if (wattage.some(value => !new RegExp(`\\b${value}\\b`).test(`${title} ${description}`))) return false;
  const wantsCharger = /\b(?:chargers?|adapters?|adaptors?)\b/.test(subject);
  const powerSpecs = value => [...value.matchAll(/\b\d{1,4}w\b/g)].map(x => x[0]);
  const titleWattages = powerSpecs(title);
  const leadingWattages = titleWattages.length || !wantsCharger ? titleWattages : powerSpecs(description.slice(0, 170));
  if (leadingWattages.length && wattage.some(value => !leadingWattages.includes(value))) return false;
  if (wantsCharger && ((category && !/\b(?:chargers?|adapters?|adaptors?)\b/i.test(category)) ||
      !/\b(?:charger|adapter|adaptor|adapto|wall plug)\b/.test(`${title} ${description}`) ||
      (/\bcable\b/.test(title) && !/\b(?:charger|adapter|adaptor)\b/.test(title)) ||
      (!/\bcar\b/.test(subject) && /\bcar (?:charger|socket)\b/i.test(`${category} ${title} ${description}`)))) return false;
  if (/\busb c\b/.test(subject) && !/\busb c\b/.test(`${title} ${description}`)) return false;
  if (/\bheadphones?\b/.test(subject) && (!/\bheadphones?\b/.test(title) ||
      (/\bwireless\b/.test(subject) && !/\b(?:wireless|bluetooth)\b/.test(title)) ||
      (!/\b(?:buds|earbuds|earphones)\b/.test(subject) && /\b(?:earbuds?|earphones|tws)\b/.test(title)))) return false;
  return isTopicalResult(subject.replace(/\badapters?\b/g, "charger"), {
    url: item.url, title: title.replace(/\b(?:adapter|adaptor|adapto)\b/g, "charger"),
    snippet: description.replace(/\b(?:adapter|adaptor)\b/g, "charger").replace(/\bbluetooth\b/g, "wireless")
  });
}

function productPrice(html, advertised) {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(String(advertised ?? "")) || Number(advertised) <= 0) return null;
  const source = String(html).slice(0, PRODUCT_BYTES);
  const metadata = [...source.matchAll(/<meta\b[^>]{0,1000}>|<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script\s*>/gi)]
    .map(m => m[0]).slice(0, 500).join("\n");
  const $ = cheerio.load(metadata);
  const matches = (currency, amount) => currency === "INR" && /^\d{1,10}(?:\.\d{1,2})?$/.test(String(amount ?? "")) && Number(amount) === Number(advertised);
  const meta = (...names) => names.map(name => $(`meta[property="${name}"],meta[itemprop="${name}"]`).first().attr("content")).find(Boolean);
  const visit = (node, depth = 0) => {
    if (depth > 5 || !node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.slice(0, 25).some(part => visit(part, depth + 1));
    if ([node["@type"]].flat().includes("Product")) {
      return [node.offers].flat().slice(0, 15).some(offer => offer && matches(offer.priceCurrency, offer.price ?? offer.lowPrice));
    }
    return visit(node["@graph"], depth + 1);
  };
  let confirmed = matches(meta("product:price:currency", "priceCurrency"), meta("product:price:amount", "price"));
  if (!confirmed) confirmed = $('script[type="application/ld+json"]').slice(0, 8).toArray().some(el => {
    try { return visit(JSON.parse($(el).text())); } catch { return false; }
  });
  return confirmed ? { value: String(advertised), currency: "INR" } : null;
}

function createIndiaCatalog({ fetchCatalog, allowsSiteUrl, limit = 12 }) {
  return async (q, { page, scope, signal, preview }) => {
    const hosts = Object.keys(STORES).filter(host => allowsSiteUrl(scope, `https://${host}/`));
    if (!hosts.length) return { results: [], more: false };
    const settled = await Promise.allSettled(hosts.map(async host => {
      const endpoint = new URL(`https://${host}/search/suggest.json`);
      endpoint.search = new URLSearchParams({ q, "resources[type]": "product", "resources[limit]": "10", "resources[options][unavailable_products]": "hide" });
      const packed = JSON.parse(await fetchCatalog(endpoint.href, { signal, kind: "catalog" }));
      const products = packed.resources?.results?.products;
      if (!Array.isArray(products)) throw new Error("Invalid India storefront response");
      return products.slice(0, 10).flatMap(product => {
        const url = merchantProductUrl(product?.url, host);
        const title = merchandiseText(product?.title, 260), snippet = merchandiseText(product?.body);
        if (!url || !title || product.available !== true || !productMatch(q, { url, title, snippet }, merchandiseText(product.type, 80))) return [];
        return [{ url, title, source: STORES[host], advertised: product.price }];
      });
    }));
    const lanes = settled.flatMap(item => item.status === "fulfilled" ? [item.value] : []);
    if (!lanes.length) throw new Error("India storefronts are temporarily unavailable");
    const seen = new Set(), matches = [];
    for (let i = 0; i < 10; i++) for (const lane of lanes) {
      const item = lane[i];
      if (item && !seen.has(item.url)) { seen.add(item.url); matches.push(item); }
    }
    const selected = matches.slice(page * limit, (page + 1) * limit);
    const results = await Promise.all(selected.map(async ({ advertised, ...item }, i) => {
      if (preview || i >= 4 || !advertised || signal?.aborted) return item;
      try {
        const html = await fetchCatalog(item.url, { signal, kind: "product" });
        return { ...item, price: productPrice(html, advertised) };
      } catch { return item; }
    }));
    return { results, more: matches.length > (page + 1) * limit };
  };
}

module.exports = { createIndiaCatalog, merchantProductUrl, productPrice, PRODUCT_BYTES };
