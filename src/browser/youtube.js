"use strict";



















const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

function safeParseUrl(raw) {
  try { return new URL(String(raw)); } catch { return null; }
}

function hostIsYoutube(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^www\./, "");
  return h === "youtube.com" || h === "m.youtube.com" || h === "music.youtube.com" || h === "youtube-nocookie.com";
}

function hostIsShortLink(hostname) {
  return String(hostname || "").toLowerCase().replace(/^www\./, "") === "youtu.be";
}

/**
 * Returns true for any URL this module should reason about at all
 * (used by callers to decide whether to run YouTube-specific logic).
 */
function isYoutubeUrl(raw) {
  const u = safeParseUrl(raw);
  if (!u || !/^https?:$/.test(u.protocol)) return false;
  return hostIsYoutube(u.hostname) || hostIsShortLink(u.hostname);
}

/**
 * Extracts and validates a YouTube video ID from a URL, handling:
 *   /watch?v=ID            (plus extra, unrelated query params — untouched)
 *   /shorts/ID
 *   /live/ID
 *   /embed/ID
 *   youtu.be/ID
 *   /redirect?...&q=<url containing one of the above>  (single level only;
 *     we do not follow this recursively or fetch the network)
 * Returns { videoId, kind, startSeconds, list, index } or null.
 * Never treats an arbitrary path/URL string as a video ID: the ID must pass
 * VIDEO_ID_RE, matching YouTube's actual ID format.
 */
function parseYoutubeUrl(raw, { depth = 0 } = {}) {
  const u = safeParseUrl(raw);
  if (!u || !/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  let id = "";
  let kind = "watch";

  if (hostIsShortLink(host)) {
    id = decodeURIComponent(u.pathname.split("/").filter(Boolean)[0] || "");
    kind = "short-link";
  } else if (hostIsYoutube(host)) {
    const segs = u.pathname.split("/").filter(Boolean);
    if (u.pathname === "/watch") {
      id = u.searchParams.get("v") || "";
      kind = "watch";
    } else if (segs[0] === "shorts") { id = segs[1] || ""; kind = "shorts"; }
    else if (segs[0] === "live") { id = segs[1] || ""; kind = "live"; }
    else if (segs[0] === "embed") { id = segs[1] || ""; kind = "embed"; }
    else if (segs[0] === "redirect" && depth === 0) {
      
      
      
      
      const nested = u.searchParams.get("q") || u.searchParams.get("url") || "";
      if (nested) return parseYoutubeUrl(nested, { depth: depth + 1 });
      return null;
    } else {
      return null;
    }
  } else {
    return null;
  }

  if (!id || !VIDEO_ID_RE.test(id)) return null;

  const startRaw = u.searchParams.get("start") || u.searchParams.get("t") || "";
  const startMatch = /^(\d+)(?:s)?$/i.exec(startRaw);
  const startSeconds = startMatch ? Math.max(0, Math.min(1e7, Number(startMatch[1]))) : null;

  return {
    videoId: id,
    kind,
    startSeconds,
    list: /^[A-Za-z0-9_-]{2,64}$/.test(u.searchParams.get("list") || "") ? u.searchParams.get("list") : null,
    index: /^\d{1,4}$/.test(u.searchParams.get("index") || "") ? Number(u.searchParams.get("index")) : null,
  };
}

/**
 * Builds the official youtube-nocookie.com IFrame embed URL. `origin` should
 * be Veyra's own origin (for the embed API's origin/referrer checks) — never
 * a spoofed third-party origin.
 */
function buildEmbedUrl(parsed, origin) {
  if (!parsed || !parsed.videoId) return null;
  const params = new URLSearchParams({
    enablejsapi: "1",
    playsinline: "1",
    rel: "0",
  });
  if (origin) { params.set("origin", origin); params.set("widget_referrer", origin); }
  if (parsed.startSeconds != null) params.set("start", String(parsed.startSeconds));
  if (parsed.list) params.set("list", parsed.list);
  if (parsed.index != null) params.set("index", String(parsed.index));
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(parsed.videoId)}?${params.toString()}`;
}

/**
 * Calls YouTube's public, documented, unauthenticated oEmbed endpoint to
 * check whether a video is embeddable at all, without loading any player.
 * This is the same endpoint any website is meant to call before embedding a
 * video (https://oembed.com / https://www.youtube.com/oembed) — it is not a
 * private API and returns only public metadata (title/author/thumbnail).
 *
 * Returns one of:
 *   { ok: true, title, authorName, thumbnailUrl }
 *   { ok: false, code: 'YOUTUBE_EMBED_DISABLED' }   video is private/removed/embed-restricted
 *   { ok: false, code: 'YOUTUBE_UNAVAILABLE' }       oEmbed itself failed/timed out
 *
 * `fetchImpl` is injected so this stays unit-testable without real network
 * access; server.js passes its own hardened fetch wrapper (SSRF-checked,
 * timeout-bound) in production.
 */
async function checkEmbeddable(videoId, fetchImpl, { timeoutMs = 6000 } = {}) {
  if (!videoId || !VIDEO_ID_RE.test(videoId)) return { ok: false, code: "YOUTUBE_EMBED_DISABLED" };
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
  try {
    const res = await fetchImpl(oembedUrl, { timeoutMs });
    if (!res || res.status === 401 || res.status === 403 || res.status === 404) {
      return { ok: false, code: "YOUTUBE_EMBED_DISABLED" };
    }
    if (res.status && res.status >= 400) return { ok: false, code: "YOUTUBE_UNAVAILABLE" };
    const data = typeof res.json === "function" ? await res.json() : res.body;
    if (!data || typeof data !== "object") return { ok: false, code: "YOUTUBE_UNAVAILABLE" };
    return { ok: true, title: data.title || "", authorName: data.author_name || "", thumbnailUrl: data.thumbnail_url || "" };
  } catch (e) {
    if (e && e.name === "AbortError") return { ok: false, code: "YOUTUBE_UNAVAILABLE" };
    return { ok: false, code: "YOUTUBE_UNAVAILABLE" };
  }
}

/**
 * Heuristic classification of a fetched youtube.com watch/shorts page shell
 * when we only have the HTML (no oEmbed call), used to decide whether the
 * *page* itself is blocked before we even get to the player. This never
 * tries to defeat what it detects — it just names it accurately so the
 * caller can hand off to Chromium / the official embed / a clear message.
 */
function classifyWatchPageBlock(html = "") {
  const text = String(html || "").toLowerCase();
  if (/consent\.youtube\.com|before you continue to youtube/.test(text)) return "YOUTUBE_CONSENT_REQUIRED";
  if (/sign in to confirm your age|inappropriate for some users/.test(text)) return "YOUTUBE_AGE_GATE";
  if (/unusual traffic from your computer network|recaptcha/.test(text)) return "TARGET_BLOCKED";
  if (/this video is private/.test(text)) return "YOUTUBE_PRIVATE";
  if (/video unavailable/.test(text) && /this video is no longer available|has been removed/.test(text)) return "YOUTUBE_REMOVED";
  return null;
}

module.exports = {
  VIDEO_ID_RE,
  isYoutubeUrl,
  parseYoutubeUrl,
  buildEmbedUrl,
  checkEmbeddable,
  classifyWatchPageBlock,
};
