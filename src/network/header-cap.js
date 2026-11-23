"use strict";
// Shared upstream response-header cap for every undici dispatcher the proxy
// uses (direct, VPN session, VPN profile, crawler).
//
// undici caps response headers at 16KB by default. Sites serving modern
// Chromium user agents (YouTube serves Chrome 156 a ~19KB Set-Cookie /
// permissions-policy header block) overflow that cap, and the whole document
// fetch dies with a generic "fetch failed" (HeadersOverflowError) — the page
// never loads through the fast proxy. Raise the cap on every dispatcher so
// big-header sites load. Tests assert this constant beats the default and
// that every production agent actually uses it.
const UPSTREAM_MAX_HEADER_BYTES = 128 * 1024;
function upstreamHeaderCapOptions() { return { maxHeaderSize: UPSTREAM_MAX_HEADER_BYTES }; }
module.exports = { UPSTREAM_MAX_HEADER_BYTES, upstreamHeaderCapOptions };
