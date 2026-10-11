"use strict";

const crypto = require("node:crypto");
const MAX_READER_TEXT_CHARS = 80000;
const MAX_READER_LINKS = 100;
const MAX_YOUTUBE_ITEMS = 36;
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const SENSITIVE_QUERY_KEY = /(?:token|secret|password|session|signature|credential|authorization|accesskey|api[_-]?key|(?:^|[_-])key(?:$|[_-])|(?:^|[_-])sig(?:$|[_-])|^(?:auth|code|jwt)$)/i;
const YOUTUBE_RENDERER_KEYS = new Set(["videoRenderer", "gridVideoRenderer", "compactVideoRenderer", "playlistVideoRenderer", "reelItemRenderer"]);

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function safeHttpUrl(value, base) {
  try {
    const url = new URL(String(value || ""), base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
    for (const key of url.searchParams.keys()) if (SENSITIVE_QUERY_KEY.test(key)) return "";
    url.hash = "";
    return url.href;
  } catch { return ""; }
}

function linkRows(input, baseUrl, limit = MAX_READER_LINKS) {
  const rows = [];
  const seen = new Set();
  for (const item of Array.isArray(input) ? input : []) {
    const rawUrl = typeof item === "string" ? item : item?.url || item?.href || "";
    const url = safeHttpUrl(rawUrl, baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const text = String(typeof item === "object" ? item?.text || item?.title || "" : "").replace(/\s+/g, " ").trim().slice(0, 240);
    rows.push({ url, text: text || url });
    if (rows.length >= limit) break;
  }
  return rows;
}

function balancedJsonAt(source, start, maxChars = 4 * 1024 * 1024) {
  if (source[start] !== "{") return "";
  let depth = 0, quoted = false, escaped = false;
  const end = Math.min(source.length, start + maxChars);
  for (let i = start; i < end; i++) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  return "";
}

function youtubeInitialData(html) {
  const source = String(html || "").slice(0, 6 * 1024 * 1024);
  let cursor = 0;
  while ((cursor = source.indexOf("ytInitialData", cursor)) >= 0) {
    const markerEnd = cursor + "ytInitialData".length;
    const assignment = source.slice(markerEnd, markerEnd + 100).match(/^\s*(?:["']?\s*\]\s*)?=\s*/);
    cursor = markerEnd;
    if (!assignment) continue;
    let start = markerEnd + assignment[0].length;
    while (/\s/.test(source[start] || "")) start++;
    const json = balancedJsonAt(source, start);
    if (!json) continue;
    try {
      const data = JSON.parse(json);
      if (data && typeof data === "object") return data;
    } catch {}
  }
  return null;
}

function textValue(value) {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (!value || typeof value !== "object") return "";
  if (typeof value.simpleText === "string") return value.simpleText.replace(/\s+/g, " ").trim();
  if (Array.isArray(value.runs)) return value.runs.map(run => String(run?.text || "")).join("").replace(/\s+/g, " ").trim();
  return "";
}

function youtubeItemsFromHtml(html, limit = MAX_YOUTUBE_ITEMS) {
  const data = youtubeInitialData(html);
  if (!data) return [];
  const stack = [{ value: data, key: "" }];
  const seen = new Set();
  const items = [];
  let visited = 0;
  while (stack.length && visited < 120000 && items.length < limit) {
    const { value, key } = stack.pop();
    visited++;
    if (!value || typeof value !== "object") continue;
    const candidate = YOUTUBE_RENDERER_KEYS.has(key) ? value : null;
    if (candidate && YOUTUBE_VIDEO_ID.test(String(candidate.videoId || ""))) {
      const videoId = String(candidate.videoId);
      const title = textValue(candidate.title) || textValue(candidate.headline);
      const thumbnailRows = Array.isArray(candidate.thumbnail?.thumbnails) ? candidate.thumbnail.thumbnails : [];
      const rawThumbnail = thumbnailRows.length ? thumbnailRows[thumbnailRows.length - 1]?.url : "";
      const thumbnailUrl = /^https:\/\/(?:i\.ytimg\.com|yt3\.ggpht\.com)\//i.test(String(rawThumbnail || "")) ? String(rawThumbnail).slice(0, 2048) : "";
      if (title && !seen.has(videoId)) {
        seen.add(videoId);
        const channel = textValue(candidate.shortBylineText) || textValue(candidate.longBylineText) || textValue(candidate.ownerText);
        const details = [textValue(candidate.viewCountText), textValue(candidate.publishedTimeText)].filter(Boolean).join(" · ");
        items.push({ videoId, title: title.slice(0, 300), channel: channel.slice(0, 160), details: details.slice(0, 160), thumbnailUrl, url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` });
      }
    }
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], key: "" });
    } else {
      const entries = Object.entries(value);
      for (let i = entries.length - 1; i >= 0; i--) stack.push({ value: entries[i][1], key: entries[i][0] });
    }
  }
  return items;
}

function scrapePayload({ requestedUrl, finalUrl, page, response, youtubeVideos = [], youtubeVideo = null, embedUrl = "", message = "" }) {
  const url = safeHttpUrl(finalUrl || requestedUrl, requestedUrl) || safeHttpUrl(requestedUrl);
  const links = linkRows(page?.links, url);
  const video = youtubeVideo && typeof youtubeVideo === "object" ? {
    title: String(youtubeVideo.title || "").slice(0, 300),
    authorName: String(youtubeVideo.authorName || "").slice(0, 160),
    thumbnailUrl: /^https:\/\/(?:i\.ytimg\.com|yt3\.ggpht\.com)\//i.test(String(youtubeVideo.thumbnailUrl || "")) ? String(youtubeVideo.thumbnailUrl).slice(0, 2048) : "",
  } : null;
  const text = String(page?.text || "").slice(0, MAX_READER_TEXT_CHARS);
  return {
    ok: true,
    url,
    title: String(video?.title || page?.title || "Untitled page").slice(0, 300),
    description: String(page?.description || "").slice(0, 1200),
    author: String(page?.author || "").slice(0, 240),
    publishedAt: String(page?.publishedAt || "").slice(0, 120),
    language: String(page?.language || "").slice(0, 32),
    headings: (Array.isArray(page?.headings) ? page.headings : []).slice(0, 40).map(item => String(item || "").slice(0, 240)).filter(Boolean),
    text,
    links,
    feedLinks: linkRows(page?.feedLinks, url, 8).map(row => row.url),
    youtubeVideos: (Array.isArray(youtubeVideos) ? youtubeVideos : []).slice(0, MAX_YOUTUBE_ITEMS),
    youtubeVideo: video,
    embedUrl: safeHttpUrl(embedUrl),
    extractionStatus: String(page?.extractionStatus || (text ? "extracted" : youtubeVideos.length ? "extracted" : "empty")).slice(0, 40),
    contentType: String(response?.contentType || "text/html; charset=utf-8").slice(0, 120),
    httpStatus: Number(response?.status) || 200,
    fetchDurationMs: Math.max(0, Number(response?.durationMs) || 0),
    message: String(message || "").slice(0, 500),
    engine: "bounded-http-reader",
  };
}

function renderReaderHtml(payload, { sessionId = "", nonce = crypto.randomBytes(18).toString("base64") } = {}) {
  const pageTitle = escapeHtml(payload?.title || "HTTP Reader");
  const sourceUrl = safeHttpUrl(payload?.url) || "";
  const sourceLink = sourceUrl ? `<a class="source" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceUrl)}</a>` : "";
  const message = payload?.message ? `<p class="note">${escapeHtml(payload.message)}</p>` : "";
  const description = payload?.description ? `<p class="description">${escapeHtml(payload.description)}</p>` : "";
  const byline = [payload?.author, payload?.publishedAt].filter(Boolean).map(value => escapeHtml(value)).join(" · ");
  const bylineHtml = byline ? `<p class="byline">${byline}</p>` : "";
  const text = String(payload?.text || "");
  const content = text ? `<section aria-label="Extracted page text"><pre>${escapeHtml(text)}</pre></section>` : "";
  const links = linkRows(payload?.links, sourceUrl).slice(0, 40).map(item => `<li><a data-veyra-target="${escapeHtml(item.url)}" href="${escapeHtml(item.url)}">${escapeHtml(item.text)}</a></li>`).join("");
  const linksHtml = links ? `<section class="links"><h2>Page links</h2><ul>${links}</ul></section>` : "";
  const videos = (Array.isArray(payload?.youtubeVideos) ? payload.youtubeVideos : []).slice(0, MAX_YOUTUBE_ITEMS).map(item => {
    const videoUrl = safeHttpUrl(item?.url);
    if (!videoUrl) return "";
    const details = [item?.channel, item?.details].filter(Boolean).map(value => escapeHtml(value)).join(" · ");
    return `<li><a data-veyra-target="${escapeHtml(videoUrl)}" href="${escapeHtml(videoUrl)}">${escapeHtml(item?.title || "YouTube video")}</a>${details ? `<small>${details}</small>` : ""}</li>`;
  }).join("");
  const videosHtml = videos ? `<section class="links"><h2>Videos available in page HTML</h2><ul>${videos}</ul></section>` : "";
  const embedUrl = safeHttpUrl(payload?.embedUrl);
  const embed = embedUrl ? `<section class="player"><iframe src="${escapeHtml(embedUrl)}" title="${pageTitle}" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></section>` : "";
  const status = escapeHtml(payload?.extractionStatus || "extracted");
  const emptyMessage = !text && !videos && !embed && !payload?.message ? `<p class="note">This page did not expose enough static text for HTTP-only extraction. It may require JavaScript or user interaction. Veyra will not bypass sign-in, consent, or anti-bot checks.</p>` : "";
  const script = `<script nonce="${escapeHtml(nonce)}">(()=>{const sid=${JSON.stringify(String(sessionId || "").slice(0, 128))};document.addEventListener("click",e=>{const a=e.target&&e.target.closest&&e.target.closest("a[data-veyra-target]");if(!a)return;const url=a.getAttribute("data-veyra-target");if(!url)return;e.preventDefault();try{parent.postMessage({type:"veyra:navigate",source:"document-navigation",url,sessionId:sid},"*")}catch{location.href=url}})})();</script>`;
  return {
    nonce,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pageTitle} · Veyra HTTP Reader</title><style> :root{color-scheme:dark;background:#111318;color:#e9edf4;font:16px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:#111318;color:#e9edf4}main{max-width:900px;margin:0 auto;padding:clamp(20px,5vw,52px)}.eyebrow{margin:0 0 12px;color:#9aa5b6;font-size:12px;letter-spacing:.14em;text-transform:uppercase}h1{font-size:clamp(28px,5vw,44px);line-height:1.15;margin:0 0 12px;overflow-wrap:anywhere}.source{display:inline-block;color:#9fb9ff;font-size:13px;overflow-wrap:anywhere}.description{color:#c6ceda;font-size:18px;margin:22px 0}.byline{color:#9aa5b6;font-size:13px;margin:10px 0}.note{border-left:2px solid #9fb9ff;padding:10px 14px;color:#c6ceda;background:#171b23;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;color:#e2e6ee;background:#171b23;border-radius:10px;padding:20px;margin:24px 0}h2{font-size:16px;margin:26px 0 10px;color:#cbd4e2}.links ul{list-style:none;padding:0;margin:0}.links li{padding:10px 0;border-bottom:1px solid #2a303b}.links a{color:#a9c1ff;text-decoration:none}.links a:hover{text-decoration:underline}.links small{display:block;color:#8f9aaa;margin-top:3px}.player{margin:22px 0;aspect-ratio:16/9;background:#08090c;border-radius:10px;overflow:hidden}.player iframe{width:100%;height:100%;border:0}@media(max-width:600px){main{padding:22px 16px}pre{padding:14px}}</style></head><body><main><p class="eyebrow">Veyra · HTTP reader · ${status}</p><h1>${pageTitle}</h1>${sourceLink}${bylineHtml}${description}${message}${embed}${videosHtml}${content}${linksHtml}${emptyMessage}</main>${script}</body></html>`,
  };
}

module.exports = {
  MAX_READER_TEXT_CHARS,
  MAX_READER_LINKS,
  safeHttpUrl,
  linkRows,
  youtubeInitialData,
  youtubeItemsFromHtml,
  scrapePayload,
  renderReaderHtml,
};
