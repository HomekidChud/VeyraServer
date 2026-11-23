"use strict";

const { canonicalKey } = require("./websearch");
const { safeUrl } = require("./vertical-search");

const STRATEGY = "wide-v1";
const BUDGET_MS = 6000;
const FIRST_PASS_MS = 3400;
const SHORTLIST = 24;
const MAX_PER_BATCH = 24;
const WEB_SECOND_PASS = 2;
const VERTICAL_SECOND_PASS = 1;
const SCHOLARLY = /\b(?:scholarly|peer[- ]reviewed|clinical trials?|systematic reviews?|meta[- ]analys(?:is|es)|research papers?|arxiv|crossref|pubmed|europe pmc)\b/i;
const COMPLEX = /\b(?:compare|versus|vs\.?|difference between|trade[- ]?offs?|pros and cons)\b/i;
const FRESH = /\b(?:latest|recent|today|yesterday|tomorrow|current(?:ly)?|newest|20\d{2})\b/i;
const RELEASE_DATE = /^([\p{L}\p{N}][\p{L}\p{M}\p{N} .’'-]{1,85}?) (?:release date|launch date)[?？]?$/iu;
const WHEN_RELEASED = /^when (?:does|did|will) ([\p{L}\p{N}][\p{L}\p{M}\p{N} .’'-]{1,85}?) (?:(?:get |be )?released|come out|launch|release)[?？]?$/iu;

function discoveryPlan(scope, maxLength = 600) {
  const topic = scope.text.trim();
  const complex = COMPLEX.test(topic) || topic.split(/\s+/).length >= 11;
  // Never drop quoted phrases, negated terms or an explicit search operator.
  if (!topic || /["“”]|(?:^|\s)-\S|\b(?:AND|OR|NOT)\b|\b\w+:/u.test(topic)) return { complex, variants: [] };
  const prefix = [...scope.include.map(host => `site:${host}`), ...scope.exclude.map(host => `-site:${host}`)].join(" ");
  const keyword = topic.replace(/^(?:(?:what|who|when|where|how|why)\s+(?:is|are|was|were|do|does|did|can|should|has|have|will)\s+|please\s+(?:explain|compare)\s+)/i, "")
    .replace(/[?？]+$/u, "").trim();
  const compare = !FRESH.test(topic) && /^(?:compare\s+)?(.+?)\s+(?:vs\.?|versus)\s+(.+)$/i.exec(keyword);
  // Availability evidence can be newer than any scheduled launch date.
  const release = (topic.match(WHEN_RELEASED) || topic.match(RELEASE_DATE))?.[1];
  const alternatives = compare ? compare.slice(1) : release
    ? [`${release} official release date announcement`, `${release} launch availability`] : [keyword];
  const key = text => text.toLowerCase().replace(/[?？]+$/u, "").trim();
  const seen = new Set([key(topic)]);
  const variants = [];
  for (const alternative of alternatives) {
    const value = alternative.trim(), query = [prefix, value].filter(Boolean).join(" ");
    if (!value || value.length < 3 || query.length > maxLength || seen.has(key(value))) continue;
    seen.add(key(value));
    variants.push(query);
  }
  return { complex: complex || !!release, variants: variants.slice(0, 2) };
}

const publisherKey = url => new URL(url).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
const WEIGHTS = { original: 1.15, reference: 1.15, hints: 1, index: 1, crawler: 0.95, research: 0.9, alternate: 0.8, next: 0.75 };

function fuse(batches, allowSource) {
  const parent = new Map();
  const root = key => {
    if (!parent.has(key)) parent.set(key, key);
    while (parent.get(key) !== key) {
      parent.set(key, parent.get(parent.get(key)));
      key = parent.get(key);
    }
    return key;
  };
  const join = (a, b) => parent.set(root(b), root(a));
  const entries = [];
  for (const [batch, { lane, rows }] of batches.entries()) {
    for (let rank = 0; rank < Math.min(MAX_PER_BATCH, rows.length); rank++) {
      const row = rows[rank];
      const url = safeUrl(row?.url);
      if (!url || !allowSource(row) || (row.canonicalUrl && !safeUrl(row.canonicalUrl))) continue;
      const canonical = canonicalKey(row.canonicalUrl || url);
      if (!canonical) continue;
      const doi = typeof row.doi === "string" && /^10\.\d{4,9}\/[^\s?#%]{1,500}$/i.test(row.doi) ? row.doi.toLowerCase() : "";
      join(canonicalKey(url), canonical);
      if (doi) join(canonical, `doi:${doi}`);
      entries.push({ batch, lane, rank, row, url, canonical });
    }
  }
  // Resolve aliases before scoring so a late URL/DOI match can join two
  // previously separate groups without counting the same batch twice.
  const merged = new Map();
  for (const { batch, lane, rank, row, url, canonical } of entries) {
    const id = root(canonical);
    const record = merged.get(id) || { score: 0, counted: new Set(), preference: -1, row: null };
    if (!record.counted.has(batch)) {
      record.score += WEIGHTS[lane] / (30 + rank + 1);
      record.counted.add(batch);
    }
    const indexed = (lane === "index" || lane === "hints") && typeof row.contentText === "string" && row.contentText.length >= 120;
    const preference = indexed ? 2 : publisherKey(url) === "doi.org" ? 0 : 1;
    if (preference > record.preference) {
      const provider = row.provider || row.source;
      record.preference = preference;
      record.row = { url, canonicalUrl: canonical,
        ...(indexed ? { contentText: row.contentText.slice(0, 30_000), retrievedAt: row.retrievedAt || row.indexedAt, provider: "veyra-index" } :
          typeof provider === "string" ? { provider: provider.slice(0, 64) } : {}),
        ...(typeof row.title === "string" && row.title ? { title: row.title.slice(0, 240) } : {}),
        ...(typeof row.publishedAt === "string" && row.publishedAt ? { publishedAt: row.publishedAt.slice(0, 40) } : {}) };
    }
    merged.set(id, record);
  }
  const ranked = [...merged.values()].sort((a, b) => b.score - a.score);
  const counts = new Map(), diverse = [], repeated = [];
  for (const { row } of ranked) {
    const host = publisherKey(row.url);
    const count = counts.get(host) || 0;
    counts.set(host, count + 1);
    (count === 0 ? diverse : repeated).push(row);
  }
  const results = [...diverse, ...repeated].slice(0, SHORTLIST);
  return { results, unique: merged.size, hosts: counts.size, shortlistedHosts: new Set(results.map(row => publisherKey(row.url))).size };
}

async function discoverAnswerSources({ query, scope, seeds = [], indexed = [], references = [],
  search, research, crawl, vertical = "", allowSource, signal, budgetMs = BUDGET_MS }) {
  signal?.throwIfAborted();
  const start = Date.now(), deadline = AbortSignal.timeout(budgetMs);
  const budget = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const plan = discoveryPlan(scope, vertical ? 400 : 600);
  const batches = [{ lane: "hints", rows: seeds }, { lane: "index", rows: indexed }, { lane: "reference", rows: references }];
  const stats = [];
  async function run(tasks, roundSignal) {
    if (!tasks.length) return [];
    const settled = new Array(tasks.length);
    await new Promise(resolve => {
      let finished = false, grace;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(grace);
        roundSignal.removeEventListener("abort", onAbort);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      // Built-in providers return partial results on abort. Give their
      // cancellation handlers one short window; a stuck adapter cannot hold
      // the whole overview open. Caller cancellation never waits for grace.
      const onAbort = () => { grace = setTimeout(done, 50); };
      if (signal?.aborted || roundSignal.aborted) return done();
      signal?.addEventListener("abort", done, { once: true });
      roundSignal.addEventListener("abort", onAbort, { once: true });
      void Promise.all(tasks.map(async ({ lane, lookup, topic, continuation }, i) => {
        let batch = { lane, status: "unavailable", rows: [] };
        try {
          const value = await lookup(topic, roundSignal, continuation);
          batch = { lane, status: value?.status || (value?.results?.length ? "ok" : roundSignal.aborted ? "cancelled" : "empty"),
            rows: Array.isArray(value?.results) ? value.results : [], continuation: value?.continuation };
        } catch {}
        if (!finished) settled[i] = batch;
      })).then(done);
    });
    signal?.throwIfAborted();
    for (const [i, item] of settled.entries()) {
      const batch = item || { lane: tasks[i].lane, status: "cancelled", rows: [] };
      batches.push(batch);
      stats.push({ lane: batch.lane, status: batch.status, returned: Math.min(MAX_PER_BATCH, batch.rows.length) });
    }
    return settled;
  }
  const original = search ? [{ lane: "original", lookup: search, topic: query }] : [];
  if (research && SCHOLARLY.test(scope.text)) original.push({ lane: "research", lookup: research, topic: query });
  if (crawl && !vertical) original.push({ lane: "crawler", lookup: crawl, topic: query });
  const initial = search
    ? AbortSignal.any([budget, AbortSignal.timeout(Math.min(FIRST_PASS_MS, budgetMs))]) : budget;
  const [first] = await run(original, initial);
  let merged = fuse(batches, allowSource);
  // A single-site query is intentionally not diverse. Sparse categories can
  // reformulate within their own vertical, never fall over to generic Web.
  const thin = (scope.include.length || vertical) ? merged.unique < (vertical ? 10 : 8) : merged.hosts < 8;
  if (!budget.aborted && search && (thin || plan.complex)) {
    const followups = plan.variants.slice(0, vertical ? VERTICAL_SECOND_PASS : WEB_SECOND_PASS).map(topic => ({ lane: "alternate", lookup: search, topic }));
    if (!followups.length && thin && first?.continuation) followups.push({ lane: "next", lookup: search, topic: query, continuation: first.continuation });
    await run(followups, budget);
    merged = fuse(batches, allowSource);
  }
  return { results: merged.results, diagnostics: {
    strategy: STRATEGY, candidates: merged.unique, candidateHosts: merged.hosts, shortlisted: merged.results.length,
    shortlistedHosts: merged.shortlistedHosts, batches: stats,
    seedLinks: seeds.length, indexMatches: indexed.length, referenceLinks: references.length, deadlineExceeded: deadline.aborted,
    latencyMs: Date.now() - start
  } };
}

module.exports = { discoverAnswerSources, discoveryPlan, STRATEGY, SHORTLIST };
