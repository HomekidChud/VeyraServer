"use strict";

function scopeHost(value) {
  const bare = value.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (!/^[\p{L}\p{M}\p{N}.-]+$/u.test(bare)) return "";
  try {
    const hostname = new URL(`https://${bare}`).hostname.replace(/\.$/, "");
    return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostname) ? hostname : "";
  } catch { return ""; }
}

function parseSiteScope(query) {
  const include = [], exclude = [], terms = [];
  let invalid = false;
  for (const token of String(query || "").match(/"[^"]*"|-?site:(?:"[^"]*"(?=\s|$)|[^\s]*)|[^\s]+/gi) || []) {
    const operator = /^(-?)site:(.*)$/i.exec(token);
    if (!operator) { terms.push(token); continue; }
    const host = scopeHost(operator[2].replace(/^"([^"]*)"$/, "$1"));
    if (!host) invalid = true;
    else (operator[1] ? exclude : include).push(host);
  }
  return { include, exclude, invalid, active: invalid || !!(include.length || exclude.length), text: terms.join(" ") };
}

function allowsSiteUrl(scope, url) {
  if (!scope.active) return true;
  if (scope.invalid) return false;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return false;
    const hostname = u.hostname.replace(/\.$/, "");
    const matches = domain => hostname === domain || hostname.endsWith(`.${domain}`);
    return scope.include.every(matches) && !scope.exclude.some(matches);
  } catch { return false; }
}

module.exports = { parseSiteScope, allowsSiteUrl };
