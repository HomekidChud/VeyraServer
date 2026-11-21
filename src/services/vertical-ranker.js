"use strict";

const model = require("./vertical-ranker-weights.json");

function tokens(value) {
  return String(value || "").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
}
function features(query, row, index) {
  const q = [...new Set(tokens(query))].slice(0, 30);
  const title = tokens(row.title), body = new Set(tokens(`${row.title} ${row.snippet || ""}`));
  const coverage = set => q.filter(word => set.has(word)).length / Math.max(1, q.length);
  return [coverage(new Set(title)), coverage(body), +(q.length > 1 && ` ${title.join(" ")} `.includes(` ${q.join(" ")} `)), 1 / Math.sqrt(1 + index)];
}
function score(query, row, index, weights = model.weights) {
  return features(query, row, index).reduce((sum, value, i) => sum + value * weights[i], 0);
}
function rankVertical(query, rows) {
  return rows.map((row, index) => ({ row, index, score: score(query, row, index) }))
    .sort((a, b) => b.score - a.score || a.index - b.index).map(item => item.row);
}
module.exports = { features, score, rankVertical, rankerVersion: model.version };
