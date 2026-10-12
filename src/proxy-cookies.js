"use strict";
const crypto = require("node:crypto");
const { CookieJar } = require("tough-cookie");
const key = crypto.randomBytes(32);
function parsedCookie(raw, url, http = true) {
  if (typeof raw !== "string" || raw.length > 4096) throw new Error("Invalid cookie");
  const cookie = new CookieJar(null, { prefixSecurity: "strict" }).setCookieSync(raw, url, { http });
  const expires = cookie.expiryTime();
  return { name: cookie.key, value: cookie.value, domain: cookie.domain, path: cookie.path,
    hostOnly: cookie.hostOnly, secure: cookie.secure, httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite, expiresAt: expires === -Infinity ? 1 : Number.isFinite(expires) ? Math.max(1, expires) : 0 };
}
function scoped(record, url) {
  const u = new URL(url), domain = String(record.domain).replace(/^\./, "").toLowerCase();
  return (!record.secure || u.protocol === "https:") &&
    (record.hostOnly ? u.hostname === domain : u.hostname === domain || u.hostname.endsWith(`.${domain}`)) &&
    (u.pathname === record.path || u.pathname.startsWith(record.path.endsWith("/") ? record.path : `${record.path}/`)) &&
    (!record.expiresAt || record.expiresAt > Date.now());
}
function scriptCookies(session, url) {
  return [...session.cookies.values()].filter(c => !c.httpOnly && scoped(c, url)).map(c => ({ ...c }));
}
function cookieCapability(sid, url, expires) {
  const data = Buffer.from(JSON.stringify({ sid, origin: new URL(url).origin, expires })).toString("base64url");
  return data + "." + crypto.createHmac("sha256", key).update(data).digest("base64url");
}
function authorizeCookieCapability(token, sid, url) {
  try {
    if (typeof token !== "string" || token.length > 2000) return false;
    const [data, signature, extra] = token.split(".");
    if (extra || !data || !signature) return false;
    const expected = crypto.createHmac("sha256", key).update(data).digest("base64url");
    if (Buffer.byteLength(signature) !== Buffer.byteLength(expected) ||
        !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
    const context = JSON.parse(Buffer.from(data, "base64url").toString());
    return context.sid === sid && context.origin === new URL(url).origin && context.expires > Date.now();
  } catch { return false; }
}
function setScriptCookie(session, raw, url) {
  const next = parsedCookie(raw, url, false);
  if (next.secure && new URL(url).protocol !== "https:") throw new Error("Secure cookies require HTTPS");
  // A script cannot replace a matching HttpOnly cookie, even by using a
  // leading-dot spelling of the same domain.
  for (const [oldKey, old] of session.cookies) {
    if (old.name === next.name && old.path === next.path &&
        String(old.domain).replace(/^\./, "") === next.domain) {
      if (old.httpOnly) throw new Error("Script cookie write rejected");
    }
  }
  for (const [oldKey, old] of session.cookies) {
    if (old.name === next.name && old.path === next.path &&
        String(old.domain).replace(/^\./, "") === next.domain) session.cookies.delete(oldKey);
  }
  const name = `${next.domain}|${next.path}|${next.name}`;
  if (!next.expiresAt || next.expiresAt > Date.now()) session.cookies.set(name, next);
  return next;
}
module.exports = { parsedCookie, scriptCookies, cookieCapability, authorizeCookieCapability, setScriptCookie };
