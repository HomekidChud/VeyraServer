"use strict";

const { parseSiteScope } = require("./search-site-scope");
const GOOGLE_WEB_HOST = /^(?:www\.)?google\.(?:com|co\.uk|co\.in)$/i;

function searchEntry(value) {
  const input = String(value || "").trim();
  const command = /^search:\s*/i.exec(input);
  const text = command ? input.slice(command[0].length) : input;
  const google = command && /^(?:www\.)?google\.com\s+(\S[\s\S]*)$/i.exec(text);
  const site = command && /^([\p{L}\p{M}\p{N}.-]+)(?:\s+([\s\S]+))?$/u.exec(text);
  if (site && !/^(?:www\.)?google\.com$/i.test(site[1])) {
    const [domain] = parseSiteScope(`site:${site[1]}`).include;
    if (domain && /\.[a-z][a-z0-9-]*$/.test(domain) && !/\.(?:localhost|local|internal|lan)$/.test(domain)) {
      return { query: `site:${domain}${site[2] ? ` ${site[2]}` : ""}`, domain, preferGoogle: false };
    }
  }
  return { query: google ? google[1] : text, preferGoogle: Boolean(google) };
}

function googleProxySearchQuery(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port || !GOOGLE_WEB_HOST.test(url.hostname)) return "";
    if (!/^\/(?:search|webhp)?$/.test(url.pathname)) return "";
    return (url.searchParams.get("q") || "").trim().slice(0, 575);
  } catch { return ""; }
}

module.exports = { searchEntry, googleProxySearchQuery };
