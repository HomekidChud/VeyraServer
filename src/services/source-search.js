"use strict";

const cheerio = require("cheerio");
const { isIP } = require("node:net");
const { allowsSiteUrl } = require("./search-site-scope");
const { canonicalKey, isTopicalResult, rankResultsByRelevance } = require("./websearch");
const { referenceResults } = require("./reference-catalog");

// Keep discovery independent from search engines and never turn a user query
// (including site:) into an outbound URL. These are editorial starting points,
// not a blanket reliability rating for everything on their domains.
const SEEDS = [
  ["https://science.nasa.gov/mars/", /\bmars\b/i],
  ["https://science.nasa.gov/moon/", /\bmoon\b/i],
  ["https://science.nasa.gov/solar-system/", /space|solar system|planet|moon|mars|asteroid|eclipse|orbit|jupiter|saturn/i],
  ["https://www.esa.int/Science_Exploration/Space_Science", /space|planet|moon|mars|asteroid|orbit|telescope/i],
  ["https://www.ncei.noaa.gov/", /climate|weather|ocean|hurricane|temperature|drought/i],
  ["https://www.usgs.gov/programs/earthquake-hazards", /earthquake|seismic|fault line/i],
  ["https://www.nhs.uk/conditions/", /health|symptom|illness|vaccine|flu|diabetes|asthma|infection/i],
  ["https://www.who.int/health-topics", /health|symptom|illness|vaccine|flu|diabetes|asthma|infection/i],
  ["https://www.gov.uk/browse/abroad/passports", /\bpassports?\b/i],
  ["https://www.gov.uk/browse", /uk|wales|britain|government|passport|licence|tax|benefits|visa/i],
  ["https://www.ons.gov.uk/", /uk|wales|census|population|statistics|inflation/i],
  ["https://docs.python.org/3/library/index.html", /\bpython\b/i],
  ["https://nodejs.org/docs/latest/api/", /node\.?js|javascript|npm/i],
  ["https://developer.mozilla.org/en-US/docs/Web", /javascript|typescript|css|html|dom|http|browser|web api/i],
  ["https://www.rfc-editor.org/standards", /rfc|internet standard|http|tls|smtp|dns/i],
  ["https://www.nhm.ac.uk/discover.html", /fossil|dinosaur|biodiversity|species|evolution|geology/i],
  ["https://www.si.edu/explore", /history|museum|artwork|smithsonian|biodiversity/i],
];

function sourcePageUrl(value) {
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port || u.href.length > 1500 ||
        !u.hostname.includes(".") || u.hostname.endsWith(".") || isIP(u.hostname) ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(u.hostname)) return "";
    const path = decodeURIComponent(u.pathname);
    if (/(?:^|\/)(?:api|oauth2?|login|log-?out|sign-?(?:in|out|up)|account|checkout|cart|subscribe|search)(?:[\/.;]|$)/i.test(path)) return "";
    const key = canonicalKey(u.href);
    return key && !new URL(key).search ? new URL(key).href : "";
  } catch { return ""; }
}

function publisher(url) {
  return new URL(url).hostname.replace(/^www\./, "");
}

const clean = (value, max) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
const optOut = /(?:^|[\s,:])(?:none|noindex|nosnippet)(?=$|[\s,;])/i;
const snippetCaps = /(?:^|[\s,])max-snippet\s*:\s*([^\s,;]*)/gi;
const noFollow = /(?:^|[\s,:])(?:none|nofollow)(?=$|[\s,;])/i;

function extractSource(html, url, robotsTag = "") {
  const $ = cheerio.load(html);
  const metaRobots = $("meta[name]").toArray().filter(item => /^(robots|veyrasearch)$/i.test($(item).attr("name") || ""))
    .map(item => $(item).attr("content")).join(" ");
  const policy = `${robotsTag} ${metaRobots}`;
  if (optOut.test(policy) || [...policy.matchAll(snippetCaps)].some(match => match[1] !== "-1")) return { excerptRestricted: true };
  const fallbackTitle = $("title").first().text();
  $("head, script, style, template, noscript, svg, nav, aside, footer, form, .headerlink, [hidden], [aria-hidden=true], [data-nosnippet]").remove();
  const title = clean($("h1").first().text() || fallbackTitle, 240);
  if (!title || /^(?:access denied|just a moment|attention required|security verification|verify you are human|before you continue|consent required)\b/i.test(title)) return null;
  const content = $("main, [role=main], article").first();
  const root = content.length ? content : $("body");
  const passages = [...new Set(root.find("p, li, dd, blockquote, td").toArray().slice(0, 160)
    .flatMap(item => (clean($(item).text(), 2200).match(/.{1,440}(?:\s+|$)|.{1,440}/gu) || [])
      .map(text => text.trim()).filter(text => text.length >= 75)))];
  const links = new Map();
  if (!noFollow.test(policy)) root.find("a[href]").toArray().slice(0, 240).forEach(item => {
    if (/\bnofollow\b/i.test($(item).attr("rel") || "")) return;
    try {
      const link = sourcePageUrl(new URL($(item).attr("href"), url).href);
      const label = clean($(item).text(), 240);
      if (link && label && new URL(link).origin === new URL(url).origin && link !== url) links.set(link, { url: link, title: label });
    } catch {}
  });
  return { title, passages, links: [...links.values()] };
}

function inspect(scope, page, isCatalog) {
  const { title, url, passages } = page;
  // The official docs establish the language; a relevant paragraph need not
  // repeat “Python”, but must still match the subject (e.g. “asyncio”).
  const pythonTopic = new URL(url).hostname === "docs.python.org"
    ? scope.text.replace(/\bpython\b/gi, "").replace(/\s+/g, " ").trim() : "";
  const topic = /[\p{L}\p{N}]/u.test(pythonTopic) ? pythonTopic : scope.text;
  // Require a match in the body independently of the result's title or URL.
  const snippets = passages.map(snippet => ({ snippet }))
    .filter(row => isTopicalResult(topic, row, { snippetOnly: true }));
  if (!snippets.length) return null;
  const snippet = rankResultsByRelevance(topic, snippets)[0].snippet;
  if (!isTopicalResult(topic, { title, url, snippet }, { requireTitle: true })) return null;
  return {
    url, canonicalUrl: canonicalKey(url), title, snippet, displayUrl: `${new URL(url).hostname}${new URL(url).pathname}`.slice(0, 120),
    evidence: { level: isCatalog && url.startsWith("https:") ? "strong" : "moderate",
      basis: isCatalog && url.startsWith("https:") ? "catalog-passage" : "page-passage", checkedAt: page.checkedAt }
  };
}

function defaultEvidence(row) {
  const indexed = row.source === "veyra-index";
  return { level: indexed ? "limited" : "unverified", basis: indexed ? "indexed-copy" : "not-checked" };
}

function createSourceSearch({ readPage, seeds = SEEDS, lookupReferences = referenceResults, discoverMs = 2300, evidenceMs = 1600, cooldownMs = 1500 } = {}) {
  const catalog = seeds.filter(([url]) => sourcePageUrl(url));
  const hosts = new Map();
  const active = new Set();
  let activeCount = 0;

  async function withPublisher(url, signal, fn) {
    const host = publisher(url);
    if (signal.aborted || activeCount >= 12 || active.has(host) || (hosts.get(host) || 0) > Date.now()) return;
    active.add(host);
    activeCount++;
    try { return await fn(); }
    finally {
      active.delete(host);
      activeCount--;
      hosts.delete(host);
      hosts.set(host, Date.now() + cooldownMs);
      if (hosts.size > 512) hosts.delete(hosts.keys().next().value);
    }
  }

  async function runBatch(items, parentSignal, ms, job) {
    const deadline = new AbortController();
    const signal = parentSignal ? AbortSignal.any([parentSignal, deadline.signal]) : deadline.signal;
    if (signal.aborted || !items.length) return [];
    const results = [];
    let onAbort;
    const cutoff = new Promise(resolve => {
      onAbort = resolve;
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const timer = setTimeout(() => deadline.abort(), ms);
    const tasks = items.map(item => Promise.resolve().then(() => job(item, signal, value => {
      if (!signal.aborted) results.push(value);
    })).catch(() => {}));
    try { await Promise.race([Promise.all(tasks), cutoff]); return results; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
  }

  async function read(url, scope, signal) {
    const row = await readPage(url, { signal, allowUrl: target => allowsSiteUrl(scope, target) });
    if (!row || signal.aborted) return null;
    const finalUrl = sourcePageUrl(row.finalUrl || url);
    if (!finalUrl || publisher(finalUrl) !== publisher(url) || !allowsSiteUrl(scope, finalUrl)) return null;
    const page = extractSource(row.body, finalUrl, row.robotsTag);
    return page && { ...page, url: finalUrl, checkedAt: new Date().toISOString() };
  }

  async function discover(scope, { signal } = {}) {
    if (!scope.text || !/[\p{L}\p{N}]/u.test(scope.text)) return [];
    const picked = new Map();
    const matching = catalog.filter(([url, intent]) => allowsSiteUrl(scope, url) && intent.test(scope.text));
    const direct = lookupReferences(scope).map(row => [row.url]);
    for (const [url] of [...direct, ...(scope.include.length ? [...matching, ...catalog] : matching)]) {
      if (allowsSiteUrl(scope, url) && !picked.has(publisher(url))) picked.set(publisher(url), sourcePageUrl(url));
      if (picked.size === 6) break;
    }
    return runBatch([...picked.values()], signal, discoverMs, (url, cutoff, emit) =>
      withPublisher(url, cutoff, async () => {
        const root = await read(url, scope, cutoff);
        if (!root || root.excerptRestricted) return;
        const found = inspect(scope, root, true);
        if (found) emit({ ...found, source: "veyra-crawl", providers: ["veyra-crawl"] });
        const [next] = rankResultsByRelevance(scope.text, root.links.filter(link =>
          allowsSiteUrl(scope, link.url) && isTopicalResult(scope.text, link, { requireTitle: true })));
        if (next && !cutoff.aborted) {
          const child = await read(next.url, scope, cutoff);
          const result = child && !child.excerptRestricted && inspect(scope, child, true);
          if (result && result.canonicalUrl !== found?.canonicalUrl) emit({ ...result, source: "veyra-crawl", providers: ["veyra-crawl"] });
        }
      }));
  }

  async function enrich(scope, rows, { signal, limit = 6 } = {}) {
    if (!scope.text) return rows;
    // A matching catalog URL remains a selected reference whether we reached
    // it in discovery or successfully verified it on the result-check pass.
    const catalogKeys = new Set(lookupReferences(scope).map(row => canonicalKey(row.url)));
    const pick = new Map();
    for (const row of rows) {
      const url = sourcePageUrl(row.url);
      if (!url || row.evidence || row.source === "veyra-index" || !allowsSiteUrl(scope, url) || pick.has(publisher(url))) continue;
      pick.set(publisher(url), { url, row });
      if (pick.size >= limit) break;
    }
    const checks = await runBatch([...pick.values()], signal, evidenceMs, ({ url, row }, cutoff, emit) =>
      withPublisher(url, cutoff, async () => {
        const page = await read(url, scope, cutoff);
        if (!page || canonicalKey(url) !== canonicalKey(page.url)) return;
        if (page.excerptRestricted) {
          emit([row, { ...row, snippet: "", evidence: { level: "unverified", basis: "excerpt-restricted" } }]);
          return;
        }
        const observed = inspect(scope, page, catalogKeys.has(canonicalKey(page.url)));
        // Never swap the link a provider returned for an untrusted canonical.
        emit([row, observed ? { ...row, title: observed.title, snippet: observed.snippet, evidence: observed.evidence } :
          { ...row, evidence: { level: "limited", basis: "no-passage", checkedAt: page.checkedAt } }]);
      }));
    const byRow = new Map(checks);
    return rows.map(row => byRow.get(row) || row);
  }

  return { discover, enrich };
}

module.exports = { createSourceSearch, defaultEvidence, sourcePageUrl };
