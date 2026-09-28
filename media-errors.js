"use strict";
// Veyra media error classification.
//
// Goal: turn opaque "fetch failed" / generic 502s from the media proxy path
// into one of a small set of accurate, machine-readable codes, so the
// caller (server.js) can apply a bounded, legitimate fallback sequence
// (retry once -> retry with/without Range -> hand off to Chromium/official
// player -> accurate diagnostic) instead of looping forever or lying about
// which side failed.
//
// This module classifies; it does not fetch, retry, decrypt, or bypass
// anything itself.

const MEDIA_CODES = Object.freeze([
  "MEDIA_DNS_ERROR",
  "MEDIA_TIMEOUT",
  "MEDIA_RESET",
  "MEDIA_RANGE_ERROR",
  "MEDIA_REDIRECT_ERROR",
  "MEDIA_TARGET_BLOCKED",
  "MEDIA_UNAVAILABLE",
  "MEDIA_AUTH_REQUIRED",
  "DRM_REQUIRED",
]);

/**
 * Classify a thrown error / failed fetch attempt from the media pipeline.
 * `ctx` may include: { status, headers, requestedRange, redirectCount,
 * maxRedirects, isMediaRequest }.
 */
function classifyMediaFailure(err, ctx = {}) {
  const code = err && err.code;
  const message = String((err && err.message) || err || "");

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { code: "MEDIA_DNS_ERROR", message: "The media host could not be resolved." };
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT" || /timed out/i.test(message)) {
    return { code: "MEDIA_TIMEOUT", message: "The media request timed out before completing." };
  }
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET" || /socket hang up/i.test(message)) {
    return { code: "MEDIA_RESET", message: "The media host reset the connection." };
  }
  if (ctx.redirectCount != null && ctx.maxRedirects != null && ctx.redirectCount > ctx.maxRedirects) {
    return { code: "MEDIA_REDIRECT_ERROR", message: "Too many redirects while fetching this media." };
  }
  if (code === "SSRF_BLOCKED" || code === "REDIRECT_BLOCKED") {
    return { code: "MEDIA_TARGET_BLOCKED", message: "The redirect destination failed Veyra's SSRF/public-URL checks." };
  }

  const status = Number(ctx.status || (err && err.status) || 0);
  if (status === 401 || status === 403) {
    return { code: "MEDIA_AUTH_REQUIRED", message: "The media host requires authentication or rejected this request." };
  }
  if (status === 404 || status === 410) {
    return { code: "MEDIA_UNAVAILABLE", message: "The requested media is no longer available." };
  }
  if (status === 416) {
    return { code: "MEDIA_RANGE_ERROR", message: "The media host rejected the requested byte range." };
  }
  if (status === 429 || status === 451) {
    return { code: "MEDIA_TARGET_BLOCKED", message: "The media host is rate-limiting or blocking this request." };
  }
  if (status >= 500) {
    return { code: "MEDIA_UNAVAILABLE", message: `The media host returned a server error (${status}).` };
  }
  if (ctx.requestedRange && status && status !== 206 && status !== 200) {
    return { code: "MEDIA_RANGE_ERROR", message: `The media host did not honor the Range request (status ${status}).` };
  }
  return { code: "MEDIA_UNAVAILABLE", message: message || "The media request failed for an unknown reason." };
}

/**
 * Given the fallback attempt count for one logical media request, decide
 * the next legitimate step. Never suggests more than a small, fixed number
 * of attempts (no infinite retry loops).
 *
 *   attempt 0 (first failure) -> retry once
 *   attempt 1                 -> retry with corrected Range headers
 *   attempt 2                 -> retry without Range (if safe: not itself
 *                                 a partial-content-only resource)
 *   attempt 3+                -> stop; hand off to Chromium/official player,
 *                                 or return the diagnostic if that's already
 *                                 been tried
 */
function nextMediaFallback(code, attempt = 0) {
  if (code === "DRM_REQUIRED") return { action: "HANDOFF_PLAYER", reason: "DRM_REQUIRED" };
  if (code === "MEDIA_TARGET_BLOCKED" || code === "MEDIA_AUTH_REQUIRED") return { action: "HANDOFF_PLAYER", reason: code };
  if (attempt === 0) return { action: "RETRY" };
  if (attempt === 1 && code === "MEDIA_RANGE_ERROR") return { action: "RETRY_WITH_RANGE" };
  if (attempt === 2 && code === "MEDIA_RANGE_ERROR") return { action: "RETRY_WITHOUT_RANGE" };
  if (attempt <= 2) return { action: "HANDOFF_PLAYER", reason: code };
  return { action: "REPORT", reason: code };
}

// --- DRM signaling detection (HLS / DASH manifests) -----------------------
// We only *detect* DRM signaling to report DRM_REQUIRED and hand off to a
// real player/Chromium. We never parse key material, request license
// servers, or attempt decryption.

function hlsManifestRequiresDrm(manifestText = "") {
  const text = String(manifestText || "");
  const keyLines = text.split(/\r?\n/).filter(l => /^#EXT-X-KEY:/i.test(l));
  if (!keyLines.length) return false;
  return keyLines.some(l => !/METHOD=NONE/i.test(l) && (/METHOD=SAMPLE-AES|METHOD=AES-128/i.test(l) || /KEYFORMAT=/i.test(l)));
}

function dashManifestRequiresDrm(manifestText = "") {
  const text = String(manifestText || "");
  return /<ContentProtection[\s>]/i.test(text);
}

function detectDrmRequired(manifestText, contentType = "") {
  const ct = String(contentType || "").toLowerCase();
  if (/mpegurl|m3u8/.test(ct) || /#EXTM3U/.test(String(manifestText || "").slice(0, 200))) {
    return hlsManifestRequiresDrm(manifestText);
  }
  if (/dash\+xml/.test(ct) || /<MPD[\s>]/i.test(String(manifestText || "").slice(0, 500))) {
    return dashManifestRequiresDrm(manifestText);
  }
  return false;
}

module.exports = {
  MEDIA_CODES,
  classifyMediaFailure,
  nextMediaFallback,
  hlsManifestRequiresDrm,
  dashManifestRequiresDrm,
  detectDrmRequired,
};
