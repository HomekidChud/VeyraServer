"use strict";

const { allowsSiteUrl } = require("./search-site-scope");
const { canonicalKey, isTopicalResult, rankResultsByRelevance } = require("./websearch");

const HOME_PAGES = [
  ["TikTok", "https://www.tiktok.com/", ["tiktok", "tik tok", "tiktok.com", "www.tiktok.com"]],
  ["Google", "https://www.google.com/", ["google", "google.com", "www.google.com"]],
  ["YouTube", "https://www.youtube.com/", ["youtube", "you tube", "youtube.com", "www.youtube.com"]],
  ["Instagram", "https://www.instagram.com/", ["instagram", "instagram.com", "www.instagram.com"]],
  ["GitHub", "https://github.com/", ["github", "github.com", "www.github.com"]],
];
const HOME_ALIASES = new Map(HOME_PAGES.flatMap(([title, url, aliases]) =>
  aliases.map(alias => [alias, Object.freeze({ title, url, canonicalUrl: canonicalKey(url),
    displayUrl: new URL(url).hostname, source: "veyra-navigation", navigation: "official-site" })])));
function navigationResult(scope) {
  if (scope.active) return null;
  const topic = scope.text.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
  return HOME_ALIASES.get(topic) || null;
}

// Editorial link metadata only. None of these match terms or titles are sent
// to publishers as search queries, and no previous user searches are used.
const PAGES = [
  ["https://docs.python.org/3/library/asyncio.html", "asyncio: Asynchronous I/O", "python async await concurrency coroutine"],
  ["https://docs.python.org/3/library/asyncio-task.html", "asyncio coroutines and tasks", "python asyncio task group taskgroup gather create task cancellation"],
  ["https://docs.python.org/3/library/asyncio-eventloop.html", "asyncio event loop", "python asyncio event loop asyncio run callback scheduling"],
  ["https://docs.python.org/3/library/pathlib.html", "Python pathlib", "python pathlib filesystem paths file directory"],
  ["https://docs.python.org/3/library/dataclasses.html", "Python dataclasses", "python dataclass decorator default factory field"],
  ["https://docs.python.org/3/library/json.html", "Python JSON encoder and decoder", "python json load dump serialization"],
  ["https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map", "JavaScript Array.map()", "javascript js mdn array map mapping"],
  ["https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Grid_layout", "CSS grid layout", "css mdn grid columns rows layout"],
  ["https://nodejs.org/api/fs.html", "Node.js file system", "node js filesystem fs read write file"],
  ["https://science.nasa.gov/mars/", "Mars", "nasa mars planet exploration"],
  ["https://science.nasa.gov/mission/mars-2020-perseverance/", "Mars 2020: Perseverance Rover", "nasa mars rover perseverance mission"],
  ["https://www.gov.uk/apply-renew-passport", "Apply for or renew a UK passport", "uk british passports passport renewal application gov"],
  ["https://www.usgs.gov/programs/earthquake-hazards", "USGS Earthquake Hazards Program", "usgs earthquake seismic hazard"],
];

function referenceResults(scope, limit = 3) {
  // A bare publisher name should not return every entry in its catalog.
  const broad = /^(?:python|javascript|js|css|mdn|node(?:\.?js)?|nasa|uk|gov|usgs)$/i;
  const topic = scope.text.trim();
  if (!topic || broad.test(topic) || !/[\p{L}\p{N}]/u.test(topic)) return [];
  const rows = PAGES.filter(([url]) => allowsSiteUrl(scope, url)).flatMap(([url, title, terms]) => {
    const candidate = { url, title, snippet: terms };
    return isTopicalResult(topic, candidate, { requireTitle: true }) ? [candidate] : [];
  });
  return rankResultsByRelevance(topic, rows).filter(row => row.relevance > 0).slice(0, limit).map(({ url, title }) => ({
    url, title, canonicalUrl: canonicalKey(url), snippet: "", source: "veyra-reference", providers: ["veyra-reference"]
  }));
}

module.exports = { referenceResults, navigationResult };
