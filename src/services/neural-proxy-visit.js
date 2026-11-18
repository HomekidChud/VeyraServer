"use strict";

const { createHmac, randomBytes } = require("node:crypto");
const cheerio = require("cheerio");
const { allowedPublicRoute } = require("./neural-training-data");

const HOUR = 3_600_000;
const ROBOTS_BYTES = 128 * 1024;
const PAGE_BYTES = 512 * 1024;
const USER_AGENT = "VeyraNeuralBot/1.0 (+https://veyra.app/bot)";

function publicVisitUrl(value) {
  const url = allowedPublicRoute(value);
  if (!url || url.href !== value || /[?#]/.test(value) || !/^\/[a-z\d._/-]+$/i.test(url.pathname)) return null;
  if (/(?:^|\/)(?:api|user|users|profile|dashboard|settings|auth|reset-password|share|subscription|members)(?:\/|$)/i.test(url.pathname.replace(/^\/api\//, "/")) ||
      /\.(?!html?(?:$|\/))[a-z\d]+$/i.test(url.pathname)) return null;
  return url;
}

// Conservative robots policy for visits: any matching Disallow wins, even
// when it was written for another agent or an Allow would override it.
function allowsTraining(text, path) {
  let listedAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const row = /^([a-z0-9_-]+)\s*:\s*(.*)$/i.exec(line);
    if (!row) return false;
    const [, name, value] = row;
    if (/^user-agent$/i.test(name) && value) listedAgent = true;
    if (!/^disallow$/i.test(name) || !value) continue;
    if (!value.startsWith("/") || /[%\s]/.test(value)) return false;
    const end = value.endsWith("$");
    const pattern = end ? value.slice(0, -1) : value;
    const parts = pattern.split("*");
    const first = parts.shift();
    if (!path.startsWith(first)) continue;
    if (!parts.length) {
      if (!end || path === first) return false;
      continue;
    }
    const last = end ? parts.pop() : "";
    if (!path.endsWith(last)) continue;
    const until = path.length - last.length;
    let cursor = first.length;
    for (const part of parts) {
      const i = path.indexOf(part, cursor);
      if (i === -1 || i + part.length > until) { cursor = until + 1; break; }
      cursor = i + part.length;
    }
    if (cursor <= until) return false;
  }
  return listedAgent;
}

function safeResponse(response, url, type, maxBytes) {
  const policy = response?.trainingPolicy;
  return response?.status === 200 && response.finalUrl === url && !response.redirectChain?.length &&
    !response.cacheHit && !response.truncated && !response.tooLarge && !response.stream && !response.contentDisposition &&
    type.test(response.contentType || "") && Buffer.isBuffer(response.body) && response.body.length <= maxBytes &&
    policy?.headerInformation === true && !policy.setCookie && !policy.challenge &&
    !/\b(?:private|no-store)\b/i.test(policy.cacheControl) && !/\b(?:noindex|none|noai|notrain)\b/i.test(policy.robots);
}

function extractPublicDocument(body) {
  const $ = cheerio.load(body.toString("utf8"));
  if ($("input").toArray().some(el => /^password$/i.test($(el).attr("type") || "")) ||
      $("meta[http-equiv]").toArray().some(el => /^refresh$/i.test($(el).attr("http-equiv") || "")) ||
      $("meta[name],meta[property]").toArray().some(el => /\b(?:noai|notrain|noindex|none)\b/i.test($(el).attr("content") || "") &&
        /(?:robots|bot|crawler|ai|train)/i.test($(el).attr("name") || $(el).attr("property") || ""))) return null;
  $("script,style,noscript,svg,template,nav,header,footer,aside,form").remove();
  const clean = value => value.replace(/\s+/g, " ").trim();
  const title = clean($("title").first().text() || $("h1").first().text());
  const text = clean($("main,article").first().text() || $("body").text()).slice(0, 5000);
  if (/checking your browser|captcha|unusual traffic|just a moment|verify (?:that )?you are human|consent required/i.test(title + " " + text.slice(0, 500))) return null;
  const headings = $("h1,h2,h3").toArray().slice(0, 20).map(el => clean($(el).text()).slice(0, 240));
  const passages = $("p,li").toArray().slice(0, 80).map(el => clean($(el).text()).slice(0, 500)).filter(value => value.length >= 45);
  return { title, text, headings, passages };
}

function createProxyVisitTrainer({ fetchPage, learn, enabled, clock = Date.now }) {
  const secret = randomBytes(32);
  const seen = new Map(), hostAttempts = new Map();
  let working = false, slot = -1, attempts = 0;
  const fetchPublic = (url, accept, limit, signal) => fetchPage(url, {
    accept, limit, signal, userAgent: USER_AGENT, trainingObservation: true, retries: 0, maxRedirects: 0,
    timeout: 5000, bodyTimeoutMs: 5000
  });

  return async function visit(value) {
    const target = publicVisitUrl(value);
    if (!enabled()) return "disabled";
    if (!target) return "unsupported";
    const now = clock(), hour = Math.floor(now / HOUR);
    if (hour !== slot) { slot = hour; attempts = 0; hostAttempts.clear(); }
    const key = createHmac("sha256", secret).update(target.href).digest("hex");
    if (now - (seen.get(key) ?? -Infinity) < 24 * HOUR) return "duplicate";
    const hostCount = hostAttempts.get(target.hostname) || 0;
    if (working || attempts >= 12 || hostCount >= 3) return "limited";
    attempts += 1;
    hostAttempts.set(target.hostname, hostCount + 1);
    seen.delete(key);
    seen.set(key, now);
    if (seen.size > 600) seen.delete(seen.keys().next().value);
    working = true;
    try {
      const signal = AbortSignal.timeout(12000);
      const robotsUrl = `${target.origin}/robots.txt`;
      const robots = await fetchPublic(robotsUrl, "text/plain", ROBOTS_BYTES, signal);
      if (!safeResponse(robots, robotsUrl, /^text\/plain(?:\s*;|$)/i, ROBOTS_BYTES) ||
          !allowsTraining(robots.body.toString("utf8"), target.pathname)) return "ineligible";
      const html = await fetchPublic(target.href, "text/html,application/xhtml+xml", PAGE_BYTES, signal);
      if (!safeResponse(html, target.href, /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i, PAGE_BYTES)) return "ineligible";
      const page = extractPublicDocument(html.body);
      if (!page) return "ineligible";
      if (!enabled() || signal.aborted) return "disabled";
      const accepted = await learn({
        requestedUrl: target.href, fetchedUrl: target.href, status: 200,
        page, robotsVerified: true, ...html.trainingPolicy
      }, true);
      return accepted ? "queued" : "skipped";
    } catch {
      return "unavailable";
    } finally {
      working = false;
    }
  };
}

module.exports = { publicVisitUrl, allowsTraining, createProxyVisitTrainer };
