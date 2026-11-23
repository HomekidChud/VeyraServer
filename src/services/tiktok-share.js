"use strict";

const MAIN = new Set(["www.tiktok.com", "tiktok.com", "m.tiktok.com"]);
const SHORT = new Set(["vm.tiktok.com", "vt.tiktok.com"]);
const REDIRECT = new Set([301, 302, 303, 307, 308]);
const RESERVED = /^\/(?:t\/)?(?:challenge|captcha|verify|login|signup|consent)\/?$/i;

function parseLink(value, relativeTo) {
  if (typeof value !== "string" || !value || value.length > 1500) return null;
  let url;
  try { url = new URL(value, relativeTo); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const main = MAIN.has(url.hostname);
  const post = main && /^\/@([A-Za-z0-9_.]{1,32})\/(video|photo)\/([0-9]{15,22})\/?$/.exec(url.pathname);
  if (post) return { kind: "post", url: `https://www.tiktok.com/@${post[1]}/${post[2]}/${post[3]}` };
  const code = main ? /^\/t\/[A-Za-z0-9]{3,40}\/?$/ : /^\/[A-Za-z0-9]{3,40}\/?$/;
  return (main || SHORT.has(url.hostname)) && code.test(url.pathname) && !RESERVED.test(url.pathname)
    ? { kind: "share", url: url.origin + url.pathname } : null;
}

async function resolveTikTokShare(value, { request = fetch, signal } = {}) {
  let target = parseLink(value);
  if (target?.kind !== "share") return { state: "invalid" };
  const deadline = AbortSignal.timeout(4500);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const seen = new Set();
  try {
    for (let hop = 0; hop < 3 && !seen.has(target.url); hop++) {
      requestSignal.throwIfAborted();
      seen.add(target.url);
      // Read only public redirect headers. Never forward browser headers or
      // cookies, read a response body, or request the final post here.
      const response = await request(target.url, { method: "HEAD", redirect: "manual", credentials: "omit", signal: requestSignal });
      if (!REDIRECT.has(response.status)) break;
      const next = parseLink(response.headers.get("location"), target.url);
      if (!next) break;
      if (next.kind === "post") return { state: "resolved", url: next.url };
      target = next;
    }
  } catch {}
  return { state: "unavailable" };
}

module.exports = { resolveTikTokShare };
