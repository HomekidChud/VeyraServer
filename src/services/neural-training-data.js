"use strict";

const { isIP } = require("node:net");
const { createHmac, randomBytes } = require("node:crypto");
const { NUM_FEATURES } = require("./neural-crawler");

const SOURCES = Object.freeze({
  "browser-feedback": 3,
  "robot-feedback": 1,
  "public-document": 0.25,
  "public-dead-end": 0.18,
  "public-proxy-visit": 0.15,
  "offline-fixture": 1,
  "legacy-feedback": 1
});

// Deliberately narrow: no bare suffix rules, writable community pages, account
// hosts, search paths or signed links. These match existing crawl traffic only.
const PUBLIC_PATHS = new Map([
  ["developer.mozilla.org", /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?docs\//i],
  ["docs.python.org", /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?3(?:\.\d+)?\//i],
  ["nodejs.org", /^\/(?:docs|api)\//],
  ["www.w3.org", /^\/(?:TR|standards)\//],
  ["www.nhs.uk", /^\/(?:conditions|medicines|live-well)\//],
  ["www.gov.uk", /^\/(?:guidance|government\/publications)\//],
  ["science.nasa.gov", /^\/(?:universe|solar-system|science-research)\//],
  ["www.usgs.gov", /^\/(?:programs|science|publications)\//],
  ["www.ams.org", /^\/(?:publications|journals)\//]
]);

function trainingUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.port ||
        isIP(u.hostname.replace(/^\[|\]$/g, "")) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(u.hostname) ||
        /(?:^|\.)(?:localhost|local|internal|lan|invalid|onion|home|corp|test|example)$/.test(u.hostname)) return null;
    return u;
  } catch { return null; }
}

function allowedPublicRoute(value) {
  const u = trainingUrl(value);
  if (!u || u.protocol !== "https:" || u.search || u.hash || u.pathname.includes("%") ||
      /(?:^|\/)(?:login|log-in|signin|sign-in|account|oauth|session|checkout|private|admin|preview|draft|token)(?:\/|$)/i.test(u.pathname)) return null;
  return PUBLIC_PATHS.get(u.hostname)?.test(u.pathname) ? u : null;
}

function trainingFeatures(values) {
  if (!Array.isArray(values) || values.length !== NUM_FEATURES) return null;
  const vector = Array.from(values);
  return vector.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)
    ? vector.map(n => Math.round(n * 20) / 20)
    : null;
}

function responseTrainingPolicy(headers) {
  if (!headers || typeof headers.get !== "function") return {};
  return {
    headerInformation: true,
    cacheControl: headers.get("cache-control") || "",
    robots: headers.get("x-robots-tag") || "",
    setCookie: !!headers.get("set-cookie") || /(?:^|,)\s*(?:\*|cookie|authorization)\s*(?:,|$)/i.test(headers.get("vary") || ""),
    challenge: !!headers.get("cf-mitigated")
  };
}

function deniedForLearning(observation) {
  const meta = Object.entries(observation.page?.metadata || {});
  const robots = meta.filter(([name]) => /^(robots|veyraneuralbot|googlebot|bingbot)$/i.test(name)).map(([, value]) => value).join(" ");
  return observation.headerInformation !== true || observation.robotsVerified !== true ||
    /(?:\bprivate\b|\bno-store\b)/i.test(observation.cacheControl || "") ||
    /(?:\bnoindex\b|\bnone\b|\bnoai\b)/i.test(`${observation.robots || ""} ${robots}`) ||
    observation.setCookie || observation.challenge;
}

function classifyCrawlObservation(observation = {}) {
  const requested = allowedPublicRoute(observation.requestedUrl);
  const fetched = allowedPublicRoute(observation.fetchedUrl);
  if (!requested || !fetched || requested.href !== fetched.href || observation.cached || observation.redirected || deniedForLearning(observation)) return null;
  if ([404, 410].includes(observation.status)) {
    return { source: "public-dead-end", positive: false, url: fetched, depth: observation.depth };
  }
  const { page } = observation;
  if (observation.status !== 200 || !page?.title || typeof page.text !== "string" ||
      /(?:access denied|just a moment|verify (?:that )?you are human|consent required|sign in to continue|page not found)/i.test(page.title + " " + page.text.slice(0, 140)) ||
      page.text.length < 350 || !Array.isArray(page.headings) || !page.headings.some(h => typeof h === "string" && h.trim()) ||
      !Array.isArray(page.passages) || new Set(page.passages).size < 2) return null;
  return { source: "public-document", positive: true, url: fetched, depth: observation.depth };
}

function createPublicCrawlTrainer({ model, enqueue, clock = Date.now, windowMs = 3_600_000, perHost = 12, globalLimit = 75 } = {}) {
  const seen = new Map(), hosts = new Map(), hostDeadEnds = new Map();
  const dedupSecret = randomBytes(32);
  const maxRemembered = 3000, repeatMs = 24 * 3_600_000;
  let slot = -1, count = 0, deadEnds = 0;
  return async function publicCrawlTraining(observation, fromProxyVisit = false) {
    const example = classifyCrawlObservation(observation);
    if (!example || (fromProxyVisit && !example.positive)) return false;
    const now = clock(), currentSlot = Math.floor(now / windowMs);
    if (currentSlot !== slot) { slot = currentSlot; count = 0; deadEnds = 0; hosts.clear(); hostDeadEnds.clear(); }
    const url = example.url.href, host = example.url.hostname;
    const key = createHmac("sha256", dedupSecret).update(url).digest("hex");
    const hostCount = hosts.get(host) || 0;
    if ((seen.has(key) && now - seen.get(key) < repeatMs) || hostCount >= perHost || count >= globalLimit) return false;
    const hostDeadEndCount = hostDeadEnds.get(host) || 0;
    if (!example.positive && (deadEnds >= 12 || hostDeadEndCount >= 2)) return false;
    const raw = model.extractFeatures(url, { type: "html", internal: Number(example.depth) > 0 });
    // Preserve inference features but avoid capturing a previous model score or
    // a host's user-derived click/visit state in public training rows.
    raw[0] = model.baseAuthority(url);
    raw[8] = 0.5; raw[9] = 0.5;
    const features = trainingFeatures(raw);
    if (!features) return false;
    seen.delete(key); seen.set(key, now);
    if (seen.size > maxRemembered) seen.delete(seen.keys().next().value);
    hosts.set(host, hostCount + 1); count += 1;
    if (!example.positive) { hostDeadEnds.set(host, hostDeadEndCount + 1); deadEnds += 1; }
    const source = fromProxyVisit ? "public-proxy-visit" : example.source;
    return enqueue({ features, positive: example.positive, source, weight: SOURCES[source] });
  };
}

module.exports = { SOURCES, trainingUrl, allowedPublicRoute, trainingFeatures, responseTrainingPolicy, classifyCrawlObservation, createPublicCrawlTrainer };
