"use strict";

const { languageTag, queryLanguage } = require("./search-language");

const india = value => typeof value === "string" && value.toUpperCase() === "IN";
const indiaLanguage = (query, preferred) => queryLanguage(query, languageTag(preferred) || "en-IN");

function indiaAffinity(row) {
  try {
    if (new URL(row.sourcePageUrl || row.url).hostname.endsWith(".in")) return 1;
  } catch {}
  return /\b(?:india|indian)\b|भारत|भारतीय|₹/iu.test(`${row.title || ""} ${row.source || ""} ${row.snippet || ""}`) ? 0.55 : 0;
}

function inrPrice(price) {
  const value = String(price?.value ?? "");
  return price?.currency === "INR" && /^\d{1,12}(?:\.\d{1,2})?$/.test(value) && Number(value) > 0
    ? { value, currency: "INR" } : null;
}

function isIndianProductUrl(value) {
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return false;
    const from = host => u.hostname === host || u.hostname.endsWith(`.${host}`);
    return (from("amazon.in") && /\/(?:dp|gp\/product)\/[A-Z0-9]{10}(?:\/|$)/i.test(u.pathname)) ||
      (from("flipkart.com") && /\/p\/itm[a-z0-9]+\/?$/i.test(u.pathname)) ||
      ((from("croma.com") || from("reliancedigital.in")) && /\/p\/\d+\/?$/.test(u.pathname)) ||
      (from("myntra.com") && /\/\d+\/buy\/?$/.test(u.pathname));
  } catch { return false; }
}

module.exports = { india, indiaLanguage, indiaAffinity, inrPrice, isIndianProductUrl };
