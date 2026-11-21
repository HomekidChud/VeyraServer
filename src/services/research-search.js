"use strict";

const { canonicalKey, rankResultsByRelevance } = require("./websearch");
const { allowsSiteUrl } = require("./search-site-scope");

const RESEARCH_BATCHES = 10;
const INDEX_BATCH = 20;
const WEB_BUDGET_MS = 12_000;
const EXPLICIT_SYNTAX = /["\u201c\u201d]|(?:^|\s)[+-]|(?:^|\s)\S+:|\b(?:AND|OR|NOT)\b/u;

function fallbackQuery(query) {
  if (EXPLICIT_SYNTAX.test(query)) return "";
  const shorter = query.replace(/^(?:please (?:find|search for)|can you (?:find|search for)|show me)\s+/iu, "").trim();
  return shorter !== query && /[\p{L}\p{N}]/u.test(shorter) ? shorter : "";
}

// Each request is a stateless, bounded retrieval pass. No query-triggered
// fetches of result pages, background indexing, or cross-user search history.
async function researchBatch({ query, scope, page, lang, signal, localSearch, webSearch }) {
  const deadline = Date.now() + WEB_BUDGET_MS;
  const indexOffset = page * INDEX_BATCH;
  const local = localSearch(query, indexOffset, INDEX_BATCH, { requireTerms: true });
  let web;
  try {
    web = await webSearch(query, { researchPage: page, lang, signal, limit: 10, noCache: true, budgetMs: deadline - Date.now() });
  } catch (error) {
    if (signal.aborted) throw error;
    web = { results: [], attempts: [{ provider: "web", error: "unavailable" }] };
  }
  signal.throwIfAborted();
  let refined = [];
  const followUp = !page && !scope.active && (web.results?.length || 0) + local.results.length < 4 && fallbackQuery(query);
  const engine = web.attempts?.find(attempt => !attempt.skipped && !attempt.error)?.provider;
  if (followUp && engine && deadline - Date.now() >= 500) {
    try {
      const extra = await webSearch(followUp, { researchPage: 0, lang, signal, engine, limit: 10, noCache: true, budgetMs: deadline - Date.now() });
      refined = (extra.results || []).slice(0, 20);
    } catch (error) { if (signal.aborted) throw error; }
  }
  signal.throwIfAborted();
  const merged = new Map();
  for (const result of [...(web.results || []), ...local.results, ...refined]) {
    const url = canonicalKey(result?.url);
    if (!url || !allowsSiteUrl(scope, url) || (result.canonicalUrl && !allowsSiteUrl(scope, result.canonicalUrl))) continue;
    const providers = result.providers?.length ? result.providers : [result.source];
    const existing = merged.get(url);
    if (existing) {
      existing.providers = [...new Set([...existing.providers, ...providers].filter(Boolean))];
      if (result.lang && !existing.lang) existing.lang = result.lang;
    } else {
      const { title, snippet, displayUrl, lang, indexedAt } = result;
      merged.set(url, { url: result.url, canonicalUrl: url, title, snippet, displayUrl, lang, indexedAt,
        providers: [...new Set(providers.filter(Boolean))] });
    }
  }
  const results = rankResultsByRelevance(scope.active ? scope.text : followUp || query, [...merged.values()]);
  const hasNext = web.more || local.total > indexOffset + INDEX_BATCH;
  const nextPage = hasNext && page + 1 < RESEARCH_BATCHES ? page + 1 : null;
  return { provider: "veyra-deep", results, nextPage, page, maxBatches: RESEARCH_BATCHES,
    sources: [...new Set(results.flatMap(row => row.providers))],
    partial: !!web.deadlineExceeded || !!web.attempts?.some(attempt => attempt.error || ["busy", "cooldown"].includes(attempt.skipped)),
    limitReached: !!hasNext && nextPage === null,
    ...(scope.active ? { siteFilter: { include: scope.include, exclude: scope.exclude } } : {}) };
}

module.exports = { RESEARCH_BATCHES, researchBatch };
