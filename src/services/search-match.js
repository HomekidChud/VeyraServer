"use strict";

const { parseSiteScope } = require("./search-site-scope");
const artifact = require("./search-match-weights.json");
const common = new Set("a an and are as at by for from how in is of on or the to was with".split(" "));
const segmenter = new Intl.Segmenter("und", { granularity: "word" });
function words(value) {
  const text = String(value ?? "").slice(0, 3200).normalize("NFKC").toLowerCase().replace(/[_-]/g, " ");
  if (!/[^\x00-\x7f]/.test(text)) return text.match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) || [];
  const tokens = [];
  for (const part of segmenter.segment(text)) if (part.isWordLike) tokens.push(part.segment);
  return tokens;
}

function prepareQuery(query) {
  const tokens = words(parseSiteScope(query).text);
  const topic = tokens.filter(word => !common.has(word));
  return [...new Set(topic.length ? topic : tokens)].slice(0, 24);
}
function pathText(value) {
  try {
    const { hostname, pathname } = new URL(value);
    try { return `${hostname} ${decodeURIComponent(pathname)}`; } catch { return `${hostname} ${pathname}`; }
  } catch { return ""; }
}
function features(terms, row, category) {
  const titleWords = words(row.title), title = new Set(titleWords);
  const description = new Set(words([row.snippet, row.description, row.alt, row.caption].filter(Boolean).join(" ")));
  const path = new Set(words(pathText(row.sourcePageUrl || row.url)));
  const coverage = set => terms.filter(term => set.has(term)).length / Math.max(1, terms.length);
  const core = coverage(description), media = category === "images" || category === "videos";
  const phrase = +(terms.length > 1 && ` ${titleWords.join(" ")} `.includes(` ${terms.join(" ")} `));
  return [coverage(title), core, coverage(path), coverage(new Set([...title, ...description, ...path])), phrase, media ? core : 0];
}
const heuristic = ([title, description, path, evidence, phrase, media]) =>
  .47 * title + .16 * description + .07 * path + .19 * evidence + .11 * phrase + .07 * media;
const predict = (vector, model = artifact) =>
  1 / (1 + Math.exp(-(model.bias + vector.reduce((sum, value, i) => sum + value * model.weights[i], 0))));

function matchPercent(vector, model = artifact) {
  // Guard the learned component with independent evidence: a provider result
  // is not a positive label, and unrelated entries do not get a model floor.
  if (!vector[3]) return 1;
  return Math.max(1, Math.min(100, Math.round(100 * (.75 * heuristic(vector) + .25 * predict(vector, model)))));
}
// The search engine has already ordered and paginated these rows. A badge
// describes lexical match; it must not replace the engine's ranking.
function annotateMatchBatch(query, rows, category) {
  const terms = prepareQuery(query);
  const candidates = (Array.isArray(rows) ? rows : []).filter(row => row && typeof row === "object" && !Array.isArray(row));
  const direct = category === "web" && candidates.find(row => row.source === "veyra-navigation" && row.navigation === "official-site");
  // Retain the numeric field for old clients; the official destination has
  // its own badge, not a claim that other results are poor text matches.
  return candidates.map(row => ({ ...row, matchPercent: row === direct ? 100 : matchPercent(features(terms, row, category)) }));
}

module.exports = { prepareQuery, features, heuristic, predict, matchPercent, annotateMatchBatch, matchModelVersion: artifact.version };
