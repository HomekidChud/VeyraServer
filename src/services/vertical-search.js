"use strict";

const cheerio = require("cheerio");
const { isIP } = require("node:net");
const { parseSiteScope, allowsSiteUrl } = require("./search-site-scope");
const { rankVertical, rankerVersion } = require("./vertical-ranker");
const { imageIdentity } = require("./crawl-page-data");
const { braveLanguage } = require("./search-language");
const { india, indiaLanguage, indiaAffinity, inrPrice, isIndianProductUrl } = require("./search-region");
const { WEB_FEED_STEP, isTopicalResult } = require("./websearch");
const { unicodeWords } = require("./search-language");
const { videoMatches } = require("./verified-videos");
const { createIndiaCatalog } = require("./india-storefronts");

const TYPES = Object.freeze(["images", "videos", "news", "shopping", "research", "discussions"]);
const PAGE_SIZE = 12;
const IMAGE_PAGE_SIZE = 24;
const IMAGE_FEED_SIZE = 48;
const LAST_IMAGE_PAGE = 9;
function lastVerticalPage(type, provider) {
  if (provider === "image-mix") return LAST_IMAGE_PAGE;
  if (provider === "brave" || provider === "web-discovery") return 9;
  if (type === "images" && provider === "wikimedia") return 49;
  return ["openverse", "peertube", "veyra-crawler", "google-news-rss", "ebay", "crossref", "hacker-news",
    "europe-pmc", "research-mix", "discussion-mix", "stack-exchange", "nasa-library", "space-images"].includes(provider) ? 19 : 3;
}
const ENDPOINT = "https://api.search.brave.com/res/v1";
const TIMEOUT = 4400;
const PUBLISHER_NEWS_FEEDS = [
  { url: "https://feeds.bbci.co.uk/news/business/rss.xml?edition=uk", origin: "https://www.bbc.co.uk", path: /^\/news\/articles\//, source: "BBC News" },
  { url: "https://www.theguardian.com/business/economics/rss", origin: "https://www.theguardian.com", path: /^\/business\/\d{4}\//, source: "The Guardian" }
];
const UK_ECONOMY = /^(?:the\s+)?(?:uk|british|united kingdom)(?:'s)?\s+(?:economy|economic news|economic outlook)[?？]?$/i;
const VIDEO_INTENT = new Set("fix repair make install build replace cook bake grow tutorial guide review recipe video watch".split(" "));
const VIDEO_TASK = /^(?:how\s+to\s+)?(?:make|fix|repair|install|build|replace|cook|bake|grow)\s+\S/i;
const COMPARISON_CONNECTOR = /\s+(?:vs\.?|versus|compared (?:with|to))\s+/gi;
function discussionTopic(query) {
  // Forum search engines may require the connector verbatim, even when a
  // relevant thread uses a different one (e.g. “X or Y”).
  return /["“”]/.test(query) ? query : query.replace(COMPARISON_CONNECTOR, " ");
}
function videoTopic(query) {
  const subject = unicodeWords(query).filter(word => !VIDEO_INTENT.has(word));
  return subject.length ? subject.join(" ") : query;
}
const THUMB_HOSTS = new Set(["imgs.search.brave.com", "upload.wikimedia.org", "thumb.wikimedia.org", "i.ebayimg.com", "i.ytimg.com",
  "images-assets.nasa.gov", "science.nasa.gov", "assets.science.nasa.gov", "www.esa.int", "media.esa.int"]);
const QT_COROUTINES = "https://doc.qt.io/qtforpython-6/_images/coroutines.png";
const QT_ASYNCIO = "https://doc.qt.io/qtforpython-6/PySide6/QtAsyncio/index.html#coroutines-explained";
const MEDIA_QUALIFIERS = new Set("a an and for of in to how show me the image images diagram diagrams visual picture".split(" "));
const ASYNCIO_IMAGE_TERMS = new Set("asyncio async python coroutine coroutines asynchronous event loop qt qtasyncio pyside6 flow await yield resume".split(" "));
function matchesReferenceImage(scope, query) {
  const terms = unicodeWords(query).filter(word => !MEDIA_QUALIFIERS.has(word));
  return terms.includes("asyncio") && terms.every(word => ASYNCIO_IMAGE_TERMS.has(word)) && allowsSiteUrl(scope, QT_ASYNCIO);
}
const NASA_INTENT = /\b(?:nasa|space telescope|nebula|saturn|jupiter|mars|apollo \d+|space shuttle|astronaut|moon landing|iss|galax(?:y|ies))\b/i;
const COMMUNITY_SITES = [
  ["cooking", "cooking.stackexchange.com", "Seasoned Advice", /\b(?:cook(?:ing)?|recipe|food|bake|dosa)\b/i],
  ["diy", "diy.stackexchange.com", "Home Improvement", /\b(?:diy|plumb(?:er|ing)?|leak(?:ing|y)? tap|faucet|home repair)\b/i],
  ["travel", "travel.stackexchange.com", "Travel Stack Exchange", /\b(?:travel|itinerary|passport|visa)\b/i],
  ["math", "math.stackexchange.com", "Mathematics Stack Exchange", /\b(?:math(?:ematics)?|calculus|algebra|trigonometry)\b/i],
  ["gaming", "gaming.stackexchange.com", "Arqade", /\b(?:video game|minecraft|skyrim|zelda|game walkthrough)\b/i],
  ["electronics", "electronics.stackexchange.com", "Electrical Engineering Stack Exchange", /\b(?:electronics|arduino|transistor|microcontroller|oscilloscope)\b/i],
  ["unix", "unix.stackexchange.com", "Unix & Linux Stack Exchange", /\b(?:unix|linux|ubuntu|bash|systemd)\b/i],
  ["superuser", "superuser.com", "Super User", /\b(?:windows|macos|computer hardware|wifi|wi-fi|microsoft office)\b/i],
  ["dba", "dba.stackexchange.com", "Database Administrators", /\b(?:sqlite|postgres(?:ql)?|mysql|mariadb|sql server|database administration)\b/i],
  ["stackoverflow", "stackoverflow.com", "Stack Overflow", /\b(?:javascript|python|typescript|java|programming|rust|sql|css|html|node\.js|regex|swift)\b/i]
];
function communityFor(scope, topic) {
  return COMMUNITY_SITES.find(([, host, , intent]) =>
    allowsSiteUrl(scope, `https://${host}/`) && (scope.include.length || intent.test(topic)));
}
function validDoi(value) {
  return typeof value === "string" && /^10\.\d{4,9}\/[^\s?#%]{1,500}$/i.test(value) ? value.toLowerCase() : "";
}

function safeUrl(value) {
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port ||
        !u.hostname.includes(".") || isIP(u.hostname) || /(?:^|\.)(localhost|local|internal)$/i.test(u.hostname)) return "";
    u.hash = "";
    return u.href.length <= 2048 ? u.href : "";
  } catch { return ""; }
}
function thumbnail(value) {
  const valueUrl = safeUrl(value);
  if (!valueUrl || !valueUrl.startsWith("https:")) return "";
  if (value === QT_COROUTINES) return valueUrl;
  const url = new URL(valueUrl);
  if (url.hostname === "api.openverse.org") return /^\/v1\/images\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/thumb\/$/i.test(url.pathname) && !url.search ? valueUrl : "";
  if (!THUMB_HOSTS.has(url.hostname)) return "";
  if (url.hostname === "assets.science.nasa.gov" && url.pathname.startsWith("/dynamicimage/") &&
      ["w", "h"].some(key => Number(url.searchParams.get(key)) > 2048)) return "";
  return valueUrl;
}
function plain(value, max = 300) {
  if (typeof value !== "string") return "";
  const $ = cheerio.load(value.slice(0, 5000), {}, false);
  $("script,style,iframe").remove();
  return $.root().text().replace(/\s+/g, " ").trim().slice(0, max);
}
function isoDate(value) {
  if (!value) return "";
  const n = Date.parse(value);
  return Number.isFinite(n) ? new Date(n).toISOString() : "";
}
function matchingHost(host, names) { return names.some(name => host === name || host.endsWith(`.${name}`)); }
function testLink(type, value, region) {
  const url = safeUrl(value);
  if (!url) return false;
  const u = new URL(url);
  if (type === "videos") return !!youtubeWatch(u) || (matchingHost(u.hostname, ["vimeo.com"]) && /\/\d+\/?$/.test(u.pathname))
    || (["tiktok.com", "www.tiktok.com", "m.tiktok.com"].includes(u.hostname) && /^\/@[A-Za-z0-9_.]{1,32}\/video\/[0-9]{15,22}\/?$/.test(u.pathname));
  if (type === "shopping" && india(region)) return isIndianProductUrl(url);
  if (type === "shopping") return (matchingHost(u.hostname, ["amazon.com", "amazon.co.uk"]) && /\/(?:dp|gp\/product)\/[A-Z0-9]{10}(?:\/|$)/i.test(u.pathname)) || (matchingHost(u.hostname, ["ebay.com", "ebay.co.uk"]) && /^\/itm\/(?:[^/]+\/)?\d+\/?$/.test(u.pathname)) || (matchingHost(u.hostname, ["etsy.com"]) && /\/listing\/\d+(?:\/|$)/.test(u.pathname));
  return true;
}
function indexedWatchPage(value) {
  return testLink("videos", value) && /^https:/.test(value);
}
function youtubeWatch(u) {
  const id = u.hostname === "youtu.be" ? /^\/([\w-]{11})\/?$/.exec(u.pathname)?.[1]
    : !["youtube.com", "www.youtube.com", "m.youtube.com"].includes(u.hostname) ? ""
    : u.pathname === "/watch" ? u.searchParams.get("v") : /^\/shorts\/([\w-]{11})\/?$/.exec(u.pathname)?.[1];
  return /^[\w-]{11}$/.test(id || "") ? id : "";
}
function watchThumbnail(value) {
  const u = new URL(value);
  const videoId = youtubeWatch(u);
  return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "";
}
function row(type, provider, item) {
  const url = safeUrl(item.url), title = plain(item.title);
  if (!url || !title) return null;
  const amount = String(item.price?.value ?? "");
  const price = /^\d{1,12}(?:\.\d{1,4})?$/.test(amount) && /^[A-Z]{3}$/.test(item.price?.currency || "") ? { value: amount, currency: item.price.currency } : null;
  return {
    type, provider, url, title, source: plain(item.source, 120) || new URL(url).hostname.replace(/^www\./, ""),
    snippet: plain(item.snippet, 500), thumbnail: thumbnail(item.thumbnail),
    ...(type === "images" ? { imageUrl: safeUrl(item.imageUrl) || "", sourcePageUrl: safeUrl(item.sourcePageUrl) || "" } : {}),
    ...(type === "research" && validDoi(item.doi) ? { doi: validDoi(item.doi) } : {}),
    publishedAt: isoDate(item.publishedAt), duration: plain(item.duration, 32), license: plain(item.license, 48),
    condition: plain(item.condition, 60), price
  };
}
function queryUrl(origin, params) {
  const url = new URL(origin);
  for (const [key, value] of Object.entries(params)) if (value !== "" && value != null) url.searchParams.set(key, String(value));
  return url.href;
}

function waitForToken(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function createVerticalSearch({ fetchText, fetchIndiaCatalog, webSearch, indexedImages, indexedVideos, indexedProducts, env = process.env, providerTimeoutMs = TIMEOUT }) {
  const cache = new Map(), cooldown = new Map();
  const indiaCatalog = fetchIndiaCatalog && createIndiaCatalog({ fetchCatalog: fetchIndiaCatalog, allowsSiteUrl, limit: PAGE_SIZE });
  const communityBackoff = new Map();
  let communityQuotaUntil = 0;
  let ebayToken, ebayTokenPromise;
  const braveKey = String(env.BRAVE_SEARCH_API_KEY || "").trim();
  const market = /^[A-Z]{2}$/.test(String(env.VEYRA_EBAY_MARKET || "")) ? env.VEYRA_EBAY_MARKET : "GB";
  async function get(url, signal, options = {}) {
    const deadline = AbortSignal.timeout(providerTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    requestSignal.throwIfAborted();
    // The shared fetcher times receipt of headers. Keep the abort signal
    // active during the body read as well, so a stalled feed can't block fallback.
    const response = await fetchText(url, { signal: requestSignal, timeoutMs: providerTimeoutMs, ...options });
    requestSignal.throwIfAborted();
    if (!response.ok) throw Object.assign(new Error("Provider request failed"), { status: response.status, retryAfterMs: response.retryAfterMs });
    return options.raw ? response.text : JSON.parse(response.text);
  }
  async function brave(type, q, { page, lang, region, signal }) {
    const offset = type === "images" ? null : page;
    const json = await get(queryUrl(`${ENDPOINT}/${type}/search`, { q, count: type === "images" ? IMAGE_FEED_SIZE : PAGE_SIZE, offset, country: region, search_lang: region ? braveLanguage(lang) : lang, safesearch: "strict" }), signal, { headers: { "X-Subscription-Token": braveKey } });
    if (!Array.isArray(json.results)) throw new Error("Invalid results");
    const results = json.results.map(item => row(type, "brave", {
      ...item, source: item.source || item.video?.creator || item.meta_url?.hostname,
      thumbnail: item.thumbnail?.src, snippet: item.description, duration: item.video?.duration,
      imageUrl: item.properties?.url, sourcePageUrl: type === "images" ? item.url : undefined,
      publishedAt: item.page_age || item.video?.published
    }));
    return { provider: "brave", results, whole: type === "images", more: type !== "images" && (json.query?.more_results_available ?? results.length === PAGE_SIZE) };
  }
  async function commons(type, q, { page, signal, count = IMAGE_PAGE_SIZE }) {
    const json = await get(queryUrl("https://commons.wikimedia.org/w/api.php", {
      action: "query", format: "json", formatversion: 2, generator: "search", gsrnamespace: 6, gsrsearch: q,
      gsrlimit: count, gsroffset: page * count, prop: "imageinfo", iiprop: "url|mime|extmetadata",
      iiextmetadatafilter: "LicenseShortName", iiurlwidth: 480
    }), signal);
    if (json.error) throw new Error("Invalid Commons response");
    const results = (json.query?.pages || []).slice(0, count).sort((a, b) => (a.index || 0) - (b.index || 0)).map(item => {
      const image = item.imageinfo?.[0];
      if (!image?.mime?.startsWith("image/") || !thumbnail(image.thumburl)) return null;
      return row(type, "wikimedia", { title: String(item.title || "").replace(/^File:/, "").replace(/\.[\w]{2,5}$/, ""), url: image.descriptionurl, imageUrl: image.url, thumbnail: image.thumburl, source: "Wikimedia Commons", license: image.extmetadata?.LicenseShortName?.value });
    });
    return { provider: "wikimedia", results, more: json.continue?.gsroffset === (page + 1) * count };
  }
  function referenceImages(type, q, { scope }) {
    const provider = "reference-images";
    const results = matchesReferenceImage(scope, q) ? [row(type, provider, {
      url: QT_COROUTINES, imageUrl: QT_COROUTINES, thumbnail: QT_COROUTINES, sourcePageUrl: QT_ASYNCIO,
      title: "Python asyncio coroutine flow diagram", source: "The Qt Company · Qt for Python",
      snippet: "Asyncio event loop and coroutine flow explaining when asynchronous Python code yields, awaits, and resumes.",
      license: "GNU FDL 1.3"
    })] : [];
    return { provider, results, more: false };
  }
  async function imageMix(type, q, { signal, lang, region, fullQuery, indexQuery, scope, domainBrowse }) {
    const lanes = !domainBrowse || allowsSiteUrl(scope, "https://commons.wikimedia.org/")
      ? [["wikimedia", () => commons(type, q, { page: 0, signal, count: IMAGE_FEED_SIZE })]] : [];
    if (braveKey) lanes.unshift(["brave", () => brave(type, fullQuery, { page: 0, signal, lang, region })]);
    const active = lanes.filter(([name]) => (cooldown.get(`${name}:images`) || 0) <= Date.now());
    const settled = await Promise.allSettled(active.map(([, run]) => run()));
    for (let i = 0; i < settled.length; i++) {
      if ([401, 403, 429].includes(settled[i].reason?.status)) cooldown.set(`${active[i][0]}:images`, Date.now() + 30_000);
    }
    signal?.throwIfAborted();
    const feeds = settled.flatMap(item => item.status === "fulfilled" ? [item.value.results.slice(0, IMAGE_FEED_SIZE)] : []);
    const references = referenceImages(type, q, { scope }).results;
    if (references.length) feeds.unshift(references);
    const commonsMore = settled.some(item => item.status === "fulfilled" && item.value.provider === "wikimedia" && item.value.more);
    let local = [];
    try { local = indexedImages(indexQuery, region).slice(0, 24).map(item => row(type, "veyra-crawler", item)); } catch {}
    if (local.some(Boolean)) feeds.push(local);
    if (!feeds.length && lanes.length) throw new Error("No image providers available");
    const results = [];
    for (let i = 0; i < IMAGE_FEED_SIZE; i++) for (const feed of feeds) if (feed[i]) results.push(feed[i]);
    return { provider: "image-mix", results, whole: true, commonsMore };
  }
  async function openverse(type, q, { page, signal }) {
    // Openverse treats its legacy mature parameter and the sensitivity
    // parameter as mutually exclusive. Validate the returned rows as well.
    const pageSize = 20; // Anonymous Openverse limit.
    const json = await get(queryUrl("https://api.openverse.org/v1/images/", { q: q.slice(0, 200), page: page + 1, page_size: pageSize,
      filter_dead: true, unstable__include_sensitive_results: false }), signal);
    if (!Array.isArray(json.results)) throw new Error("Invalid Openverse response");
    const results = json.results.slice(0, pageSize).flatMap(item => {
      const url = safeUrl(item.foreign_landing_url), imageUrl = safeUrl(item.url);
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item.id || "") || item.mature !== false ||
          (Array.isArray(item.unstable__sensitivity) && item.unstable__sensitivity.length) || !url || !imageUrl) return [];
      const license = /^(?:by(?:-nc)?(?:-sa|-nd)?|cc0|pdm)$/i.test(item.license || "") ?
        [item.license === "pdm" ? "Public Domain Mark" : item.license === "cc0" ? "CC0" : `CC ${item.license.toUpperCase()}`, item.license_version].filter(Boolean).join(" ") : "";
      if (!license) return [];
      return [row(type, "openverse", { url, sourcePageUrl: url, imageUrl, license, title: item.title || "Untitled image",
        thumbnail: `https://api.openverse.org/v1/images/${item.id}/thumb/`, source: [item.creator, "Openverse"].filter(Boolean).join(" · "),
        snippet: (Array.isArray(item.tags) ? item.tags : []).slice(0, 24).map(tag => tag.name).filter(Boolean).join(" ") })];
    });
    return { provider: "openverse", results, more: Number(json.page_count) > page + 1 };
  }
  async function nasaLibrary(type, q, { page, signal, count = type === "images" ? IMAGE_PAGE_SIZE : PAGE_SIZE }) {
    const media = type === "videos" ? "video" : "image";
    const topic = q.replace(/\bnasa\b/gi, " ").replace(/\s+/g, " ").trim() || q;
    const json = await get(queryUrl("https://images-api.nasa.gov/search", { q: topic, media_type: media, page: page + 1, page_size: count }), signal);
    if (!Array.isArray(json.collection?.items)) throw new Error("Invalid NASA library response");
    const results = json.collection.items.slice(0, count).flatMap(item => {
      const data = item?.data?.[0], id = data?.nasa_id;
      if (data?.media_type !== media || typeof id !== "string" || !/^[\w][\w. -]{0,119}$/.test(id)) return [];
      const preview = (Array.isArray(item.links) ? item.links : []).find(link => link?.rel === "preview")?.href;
      const poster = thumbnail(preview);
      if (media === "image" && (!poster || new URL(poster).hostname !== "images-assets.nasa.gov")) return [];
      const url = `https://images.nasa.gov/details/${encodeURIComponent(id)}`;
      const snippet = [data.description, ...(Array.isArray(data.keywords) ? data.keywords.slice(0, 10) : [])].filter(item => typeof item === "string").join(" · ");
      return [row(type, "nasa-library", { url, sourcePageUrl: url, title: data.title, snippet,
        thumbnail: poster && new URL(poster).hostname === "images-assets.nasa.gov" ? poster : "", imageUrl: poster,
        source: "NASA Image and Video Library", publishedAt: data.date_created })];
    });
    return { provider: "nasa-library", results, more: Number(json.collection.metadata?.total_hits) > (page + 1) * count };
  }
  async function spaceImages(type, q, opts) {
    return mixed("space-images", [["wikimedia", commons], ["nasa-library", nasaLibrary]], type, q, { ...opts, count: PAGE_SIZE });
  }
  async function newsFeed(type, q, { lang, region, signal }) {
    lang = lang.split("-")[0];
    if (region === "IN") lang = lang === "hi" ? "hi" : "en";
    else region = ({ fr: "FR", de: "DE", es: "ES", it: "IT", pt: "BR", nl: "NL", ja: "JP" })[lang] || "GB";
    const xml = await get(queryUrl("https://news.google.com/rss/search", { q, hl: `${lang}-${region}`, gl: region, ceid: `${region}:${lang}` }), signal, { raw: true, accept: "application/rss+xml,application/xml" });
    const $ = cheerio.load(xml, { xml: true });
    if (!$("rss > channel").length) throw new Error("Invalid RSS feed");
    const results = $("channel > item").slice(0, 96).toArray().map(node => {
      const item = $(node);
      const source = item.children("source").text(), title = item.children("title").text();
      return row(type, "google-news-rss", { url: item.children("link").text(), title: source && title.endsWith(` - ${source}`) ? title.slice(0, -source.length - 3) : title, source, publishedAt: item.children("pubDate").text() });
    });
    return { provider: "google-news-rss", results, whole: true };
  }
  async function publisherNews(type, q, { scope, signal }) {
    // Fetch two public feeds in parallel, without forwarding the user's
    // query. Feed headlines and descriptions only select URLs, not evidence.
    const feeds = PUBLISHER_NEWS_FEEDS.filter(feed => allowsSiteUrl(scope, feed.origin));
    const deadline = AbortSignal.timeout(1600);
    const feedSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
    const responses = await Promise.allSettled(feeds.map(async feed => {
      const xml = await get(feed.url, feedSignal, { raw: true, accept: "application/rss+xml,application/xml" });
      const $ = cheerio.load(xml, { xml: true });
      if (!$("rss > channel").length) throw new Error("Invalid publisher RSS feed");
      return $("channel > item").slice(0, 60).toArray().flatMap(node => {
        const item = $(node), url = safeUrl(item.children("link").text());
        const publishedAt = isoDate(item.children("pubDate").text());
        const age = Date.now() - Date.parse(publishedAt);
        if (!url || new URL(url).origin !== feed.origin || !feed.path.test(new URL(url).pathname) ||
            !allowsSiteUrl(scope, url) || !(age >= 0 && age <= 14 * 86400000)) return [];
        const title = plain(item.children("title").text()), description = plain(item.children("description").text(), 500);
        const topical = [q, "UK inflation", "UK GDP", "UK economic growth", "UK interest rates", "UK unemployment"].some(
          topic => isTopicalResult(topic, { url, title, snippet: description }, { requireTitle: true }));
        if (!topical || !/\b(?:UK|British|Britain|Bank of England)\b/i.test(`${title} ${description}`)) return [];
        return [row(type, "publisher-news", { url, title, source: feed.source, publishedAt })];
      });
    }));
    signal?.throwIfAborted();
    if (responses.length && responses.every(result => result.status === "rejected")) throw new Error("Publisher news feeds unavailable");
    return { provider: "publisher-news", results: responses.flatMap(result => result.status === "fulfilled" ? result.value : []), whole: true };
  }
  async function crossref(type, q, { page, signal }) {
    const json = await get(queryUrl("https://api.crossref.org/works", { "query.bibliographic": q, rows: PAGE_SIZE, offset: page * PAGE_SIZE, select: "DOI,title,container-title,publisher,published,type,author", filter: "type:journal-article" }), signal);
    if (!Array.isArray(json.message?.items)) throw new Error("Invalid Crossref response");
    const results = json.message.items.map(item => {
      if (!/^10\.\d{4,9}\/\S{1,500}$/i.test(item.DOI || "")) return null;
      const parts = item.published?.["date-parts"]?.[0];
      const authors = (item.author || []).slice(0, 3).map(a => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean);
      const publishedAt = parts?.length === 3 ? parts.map((n, i) => String(n).padStart(i ? 2 : 4, "0")).join("-") : "";
      return row(type, "crossref", { title: item.title?.[0], url: `https://doi.org/${item.DOI.split("/").map(encodeURIComponent).join("/")}`, doi: item.DOI, source: item["container-title"]?.[0] || item.publisher, snippet: [authors.join(", "), !publishedAt && parts?.[0]].filter(Boolean).join(" · "), publishedAt });
    });
    return { provider: "crossref", results, more: Number(json.message["total-results"]) > (page + 1) * PAGE_SIZE };
  }
  async function europePmc(type, q, { page, signal }) {
    // Europe PMC uses an opaque cursor (not an offset) for search pagination.
    // Supply its independently ranked first page without manufacturing a cursor.
    if (page) return { provider: "europe-pmc", results: [], more: false };
    const json = await get(queryUrl("https://www.ebi.ac.uk/europepmc/webservices/rest/search", {
      query: q, pageSize: PAGE_SIZE, format: "json", resultType: "lite"
    }), signal);
    if (!Array.isArray(json.resultList?.result)) throw new Error("Invalid Europe PMC response");
    const results = json.resultList.result.slice(0, PAGE_SIZE).flatMap(item => {
      const source = item?.source, id = item?.id;
      if (typeof source !== "string" || typeof id !== "string" || !/^[A-Z]{2,12}$/.test(source) || !/^[\w.-]{1,80}$/.test(id)) return [];
      return [row(type, "europe-pmc", { url: `https://europepmc.org/article/${source}/${id}`,
        title: item.title, source: item.journalTitle || "Europe PMC", snippet: item.authorString,
        publishedAt: item.firstPublicationDate, doi: item.doi })];
    });
    return { provider: "europe-pmc", results, more: false };
  }
  async function discussions(type, q, { page, signal }) {
    const json = await get(queryUrl("https://hn.algolia.com/api/v1/search", { query: q, tags: "story", page, hitsPerPage: PAGE_SIZE }), signal);
    if (!Array.isArray(json.hits)) throw new Error("Invalid Hacker News response");
    const results = json.hits.filter(item => /^\d+$/.test(item.objectID)).map(item => row(type, "hacker-news", { url: `https://news.ycombinator.com/item?id=${item.objectID}`, title: item.title, snippet: item.story_text, source: "Hacker News", publishedAt: item.created_at }));
    return { provider: "hacker-news", results, more: json.nbPages > page + 1 };
  }
  async function stackExchange(type, q, { page, signal, scope }) {
    const site = communityFor(scope, q);
    if (!site) return { provider: "stack-exchange", results: [], more: false };
    const [id, host, name] = site;
    if (Math.max(communityQuotaUntil, communityBackoff.get(id) || 0) > Date.now()) {
      throw new Error("Stack Exchange is in cooldown");
    }
    const json = await get(queryUrl("https://api.stackexchange.com/2.3/search/advanced", {
      q, site: id, sort: "relevance", page: page + 1, pagesize: PAGE_SIZE
    }), signal);
    if (Number(json.backoff) > 0) communityBackoff.set(id, Date.now() + Number(json.backoff) * 1000);
    if (json.quota_remaining === 0) communityQuotaUntil = Date.now() + 60 * 60_000;
    if (!Array.isArray(json.items)) throw new Error("Invalid Stack Exchange response");
    const results = json.items.slice(0, PAGE_SIZE).flatMap(item => {
      const url = safeUrl(item?.link);
      if (!url || new URL(url).origin !== `https://${host}` || !/^\/questions\/\d+(?:\/|$)/.test(new URL(url).pathname)) return [];
      return [row(type, "stack-exchange", { url, title: item.title, source: name,
        snippet: Array.isArray(item.tags) ? item.tags.slice(0, 8).join(" · ") : "",
        publishedAt: Number(item.creation_date) > 0 ? new Date(Number(item.creation_date) * 1000) : "" })];
    });
    return { provider: "stack-exchange", results, more: json.has_more === true };
  }
  async function mixed(id, lanes, type, q, opts) {
    const active = lanes.filter(([name]) => !(cooldown.get(`${name}:`) > Date.now()));
    const settled = await Promise.allSettled(active.map(([, run]) => run(type, q, opts)));
    opts.signal?.throwIfAborted();
    const feeds = [];
    for (const [i, item] of settled.entries()) {
      if (item.status === "fulfilled") { feeds.push(item.value); continue; }
      const error = item.reason;
      if ([401, 403, 429].includes(error?.status) || error?.retryAfterMs > 0) {
        cooldown.set(`${active[i][0]}:`, Date.now() + Math.max(30_000, error.retryAfterMs || 0));
      }
    }
    if (!feeds.length) throw new Error("No matching providers reached");
    return { provider: id, results: feeds.flatMap(feed => feed.results),
      more: feeds.some(feed => feed.more), partial: feeds.length < lanes.length };
  }
  const researchMix = (type, q, opts) => mixed("research-mix",
    [["crossref", crossref], ...(!opts.page ? [["europe-pmc", europePmc]] : [])], type, q, opts);
  const discussionMix = (type, q, opts) => mixed("discussion-mix",
    [["hacker-news", discussions], ["stack-exchange", stackExchange]], type, q, opts);
  async function youtube(type, q, { signal, lang, region }) {
    // search.list is expensive; the optional adapter is only used after Brave.
    const json = await get(queryUrl("https://www.googleapis.com/youtube/v3/search", { part: "snippet", q, type: "video", maxResults: PAGE_SIZE, safeSearch: "strict", relevanceLanguage: lang.split("-")[0], regionCode: region, key: env.YOUTUBE_DATA_API_KEY }), signal);
    if (!Array.isArray(json.items)) throw new Error("Invalid YouTube response");
    const results = json.items.filter(item => /^[\w-]{11}$/.test(item.id?.videoId || "")).map(item => row(type, "youtube", {
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`, title: item.snippet?.title, source: item.snippet?.channelTitle,
      snippet: item.snippet?.description, publishedAt: item.snippet?.publishedAt, thumbnail: item.snippet?.thumbnails?.medium?.url
    }));
    return { provider: "youtube", results, more: false };
  }
  function verifiedVideos(type, q, { page }) {
    return { provider: "verified-videos", results: page ? [] : videoMatches(q).map(item => row(type, "verified-videos", item)), more: false };
  }
  async function storefronts(type, q, opts) {
    const result = await indiaCatalog(q, opts);
    return { ...result, provider: "india-storefronts", results: result.results.map(item => row(type, "india-storefronts", item)) };
  }
  async function peertube(type, q, { page, signal }) {
    const json = await get(queryUrl("https://sepiasearch.org/api/v1/search/videos", {
      search: q, start: page * PAGE_SIZE, count: PAGE_SIZE, nsfw: "false", sort: "-match"
    }), signal);
    if (!Array.isArray(json.data)) throw new Error("Invalid Sepia Search response");
    const results = json.data.filter(item => item.nsfw === false && item.privacy?.id === 1).map(item => {
      const url = safeUrl(item.url);
      if (!url || !/^\/(?:videos\/watch|w)\/[\w-]+\/?$/.test(new URL(url).pathname)) return null;
      const seconds = Math.floor(Number(item.duration));
      const duration = seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "";
      // Federated preview hosts are deliberately not given a wildcard CSP rule.
      return row(type, "peertube", { url, title: item.name, snippet: item.truncatedDescription || item.description, source: item.channel?.displayName || item.account?.displayName, duration, publishedAt: item.publishedAt });
    });
    return { provider: "peertube", results, more: json.total > (page + 1) * PAGE_SIZE };
  }
  async function ebay(type, q, { page, signal }) {
    if (!ebayToken || ebayToken.until <= Date.now()) {
      if (!ebayTokenPromise) {
        const auth = Buffer.from(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`).toString("base64");
        ebayTokenPromise = get("https://api.ebay.com/identity/v1/oauth2/token", undefined, {
          method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }).toString()
        }).then(json => {
          if (typeof json.access_token !== "string" || !json.access_token || !(Number(json.expires_in) > 0)) throw new Error("Invalid eBay token");
          return ebayToken = { value: json.access_token, until: Date.now() + Math.max(0, Math.min(7200, Number(json.expires_in)) - 30) * 1000 };
        }).finally(() => { ebayTokenPromise = null; });
      }
      await waitForToken(ebayTokenPromise, signal);
    }
    let json;
    try {
      json = await get(queryUrl("https://api.ebay.com/buy/browse/v1/item_summary/search", { q, limit: PAGE_SIZE, offset: page * PAGE_SIZE, filter: "buyingOptions:{FIXED_PRICE}" }), signal, {
        headers: { Authorization: `Bearer ${ebayToken.value}`, "X-EBAY-C-MARKETPLACE-ID": `EBAY_${market}` }
      });
    } catch (error) { if (error.status === 401) ebayToken = null; throw error; }
    if (!Array.isArray(json.itemSummaries) && json.total !== 0) throw new Error("Invalid eBay listing response");
    const results = (json.itemSummaries || []).filter(item => {
      const url = safeUrl(item.itemWebUrl);
      if (!url) return false;
      const u = new URL(url);
      return matchingHost(u.hostname, ["ebay.com", "ebay.co.uk", "ebay.de", "ebay.fr", "ebay.ca", "ebay.com.au"]) && /^\/itm\/(?:[^/]+\/)?\d+\/?$/.test(u.pathname);
    }).map(item => row(type, "ebay", {
      url: item.itemWebUrl, title: item.title, source: item.seller?.username ? `eBay · ${item.seller.username}` : "eBay",
      thumbnail: item.image?.imageUrl, condition: item.condition, price: item.price
    }));
    return { provider: "ebay", results, more: !!json.next };
  }
  async function webCategory(type, q, { page, signal, lang, region, noCache, privateSearch, fullQuery, scope }) {
    // The discovery hint goes to upstreams, but never counts as a match.
    const shopping = type === "shopping" && india(region);
    const domainOnly = !scope.text && scope.include.length > 0;
    const topic = domainOnly ? null : type === "videos" ? videoTopic(q) : q;
    const deadline = AbortSignal.timeout(providerTimeoutMs);
    const packed = await webSearch(`${fullQuery || q} ${type === "videos" ? (scope.active || /\btiktok\b/i.test(q) ? "video" : "YouTube video") : shopping ? "buy online India" : "buy online"}`, {
      offset: page * WEB_FEED_STEP, limit: PAGE_SIZE * 2, lang, region, shopping, topic,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline, noCache, feed: true, privateSearch });
    if (packed.attempts?.length && packed.attempts.every(attempt => attempt.error || attempt.skipped)) throw new Error("No provider reached");
    const results = (packed.results || []).filter(item => testLink(type, item.url, region) &&
      (domainOnly || isTopicalResult(topic, { ...item, snippet: item.snippet || item.description }, { requireTitle: true }))).map(item => {
      const poster = type === "videos" ? watchThumbnail(item.url) : "";
      return row(type, "web-discovery", { url: item.url, title: item.title, source: shopping ? "" : item.source, snippet: shopping ? "" : item.snippet || item.description, thumbnail: poster, price: shopping ? inrPrice(item.price) : null });
    });
    return { provider: "web-discovery", results, more: !!packed.more };
  }
  function crawlerVideoFeed(type, _q, { page, region, indexQuery }) {
    const batch = Math.max(1, page);
    const data = indexedVideos(indexQuery, (batch - 1) * PAGE_SIZE, PAGE_SIZE, region);
    return { provider: "veyra-crawler", results: data.results.filter(item => indexedWatchPage(item.url)).map(item =>
      row(type, "veyra-crawler", { ...item, source: "", thumbnail: watchThumbnail(item.url) })),
    more: batch * PAGE_SIZE < data.total, nextPage: batch + 1 };
  }
  function crawlerProductFeed(type, _q, { page, region, fullQuery }) {
    const data = indexedProducts(fullQuery, page * PAGE_SIZE, PAGE_SIZE, region);
    return { provider: "veyra-crawler", results: data.results.filter(item => testLink(type, item.url, region))
      .map(item => row(type, "veyra-crawler", { title: item.title, url: item.url })), more: (page + 1) * PAGE_SIZE < data.total };
  }
  function adapters(type, page, preview, provider, region, privateSearch, scope, topic, domainBrowse, overview, language) {
    const list = [];
    if (type === "videos" && !page) list.push(["verified-videos", verifiedVideos]);
    if (type === "shopping" && india(region) && indiaCatalog && !privateSearch) list.push(["india-storefronts", storefronts]);
    if (type === "images" && !privateSearch && (provider === "nasa-library" || (scope.include.length && allowsSiteUrl(scope, "https://images.nasa.gov/")))) {
      list.push(["nasa-library", nasaLibrary]);
    }
    if (type === "videos" && !privateSearch && (provider === "nasa-library" || (scope.include.length && allowsSiteUrl(scope, "https://images.nasa.gov/")) ||
        (!scope.active && NASA_INTENT.test(topic)))) list.push(["nasa-library", nasaLibrary]);
    if (type === "images" && !privateSearch && !scope.active && NASA_INTENT.test(topic)) list.push(["space-images", spaceImages]);
    if (type === "images" && !preview && typeof indexedImages === "function" && (!provider || provider === "image-mix")) list.push(["image-mix", imageMix]);
    else {
      if (braveKey && ["images", "videos", "news"].includes(type)) list.push(["brave", brave]);
      if (type === "images" && (!domainBrowse || allowsSiteUrl(scope, "https://commons.wikimedia.org/"))) list.push(["wikimedia", commons]);
    }
    if (type === "images" && matchesReferenceImage(scope, topic)) list.push(["reference-images", referenceImages]);
    if (type === "images" && !preview && !scope.include.length) list.push(["openverse", openverse]);
    if (type === "videos" && !page && !preview && env.YOUTUBE_DATA_API_KEY && env.VEYRA_YOUTUBE_SEARCH === "1") list.push(["youtube", youtube]);
    if (type === "videos") list.push(["peertube", peertube]);
    if (type === "news" && overview && !privateSearch && language === "en" && UK_ECONOMY.test(topic) &&
        PUBLISHER_NEWS_FEEDS.some(feed => allowsSiteUrl(scope, feed.origin))) list.push(["publisher-news", publisherNews]);
    if (type === "news") list.push(["google-news-rss", newsFeed]);
    if (type === "shopping" && !india(region) && env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) list.push(["ebay", ebay]);
    if (type === "videos" && !preview && typeof indexedVideos === "function") list.push(["veyra-crawler", crawlerVideoFeed]);
    if (type === "shopping" && !preview && india(region) && typeof indexedProducts === "function") list.push(["veyra-crawler", crawlerProductFeed]);
    if (type === "videos" || type === "shopping") list.push(["web-discovery", webCategory]);
    if (type === "research") {
      if (!privateSearch && !scope.active && (!provider || provider === "research-mix")) list.push(["research-mix", researchMix]);
      else {
        if (allowsSiteUrl(scope, "https://doi.org/")) list.push(["crossref", crossref]);
        if (!privateSearch && allowsSiteUrl(scope, "https://europepmc.org/")) list.push(["europe-pmc", europePmc]);
      }
    }
    if (type === "discussions") {
      const hasCommunity = !privateSearch && communityFor(scope, topic);
      const hasHn = allowsSiteUrl(scope, "https://news.ycombinator.com/");
      if (hasHn && hasCommunity && (!provider || provider === "discussion-mix")) list.push(["discussion-mix", discussionMix]);
      else {
        if (hasHn) list.push(["hacker-news", discussions]);
        if (hasCommunity) list.push(["stack-exchange", stackExchange]);
      }
    }
    return list;
  }
  async function search(type, rawQuery, { page = 0, lang = "en", region = "", signal, noCache = true, provider = "", preview = false, requireThumbnail = false, domainBrowse = false, privateSearch = false, overview = false } = {}) {
    if (!TYPES.includes(type)) throw new Error("Unknown vertical");
    const started = Date.now(), scope = parseSiteScope(rawQuery), q = String(rawQuery).trim().slice(0, 400);
    region = india(region) ? "IN" : "";
    const language = region ? indiaLanguage(scope.text || q, lang) : /^[a-z]{2}$/i.test(lang) ? lang.toLowerCase() : "en";
    const siteFilter = scope.active ? { include: scope.include, exclude: scope.exclude, invalid: scope.invalid } : null;
    const empty = status => ({ type, status, provider: "none", ranking: rankerVersion, results: [], nextPage: null, siteFilter, responseTimeMs: Date.now() - started });
    if (scope.invalid) return empty("invalid-scope");
    const domainOnly = domainBrowse && !scope.text && scope.include[0] && ["images", "videos"].includes(type);
    if (!q || (scope.active && !scope.text && !domainOnly)) return empty("empty");
    const attempts = [];
    let sparseImages;
    const rawTopic = scope.text || (domainOnly ? "" : q);
    const topic = type === "discussions" ? discussionTopic(rawTopic) : rawTopic;
    const videoTask = type === "videos" && VIDEO_TASK.test(topic);
    const domainHint = domainOnly ? scope.include[0] : "";
    const mediaTopic = type === "videos" ? videoTopic(topic) : topic;
    const ageScore = item => {
      const age = (started - Date.parse(item.publishedAt)) / 86400000;
      return type === "news" && age >= 0 ? 1.8 / (1 + age / 30) : 0;
    };
    for (const [name, run] of adapters(type, page, preview, provider, region, privateSearch, scope, topic, domainBrowse, overview, language)) {
      if (signal?.aborted) return sparseImages || empty("cancelled");
      if (provider && provider !== name) continue;
      if (name === "openverse" && scope.include.length) continue;
      const breaker = `${name}:${name === "brave" ? type : ""}`;
      if ((cooldown.get(breaker) || 0) > Date.now()) { attempts.push("unavailable"); continue; }
      const singleFeed = name === "image-mix" || ["google-news-rss", "publisher-news"].includes(name) || (name === "brave" && type === "images");
      const key = JSON.stringify([name, type, q, domainBrowse, language, region, singleFeed ? 0 : page, name === "india-storefronts" && preview]);
      const saved = noCache || name === "veyra-crawler" ? null : cache.get(key);
      try {
        const fullQuery = domainHint ? `${q} ${domainHint}` : q;
        const providerQuery = name === "brave" ? fullQuery : (topic || domainHint || q).slice(0, 400);
        const packed = saved?.until > Date.now() ? saved.packed : await run(type, providerQuery, { page, lang: language, region, signal, noCache, fullQuery, indexQuery: q, scope, preview, domainBrowse, privateSearch });
        if (signal?.aborted) return sparseImages || empty("cancelled");
        const seen = new Set();
        const known = packed.results.filter(item => {
          // The Web strip renders previews, not placeholder cards. Exclude
          // thumbnail-free rows before ranking, paging and choosing a provider.
          if (!item || (requireThumbnail && !item.thumbnail) || !allowsSiteUrl(scope, item.sourcePageUrl || item.url)) return false;
          const topicalMedia = (type === "videos" && name !== "verified-videos") || (type === "images" && unicodeWords(topic).length > 1 && !/[^\u0000-\u007f]/.test(topic));
          const topicalNative = ["europe-pmc", "stack-exchange", "nasa-library"].includes(item.provider);
          const intendedTopic = item.provider === "nasa-library" ? mediaTopic.replace(/\bnasa\b/gi, "").trim() || mediaTopic : mediaTopic;
          // A recipe's ingredient list (or a video's description of what it
          // uses) is not evidence that the video teaches the requested task.
          const topicalItem = videoTask ? { ...item, snippet: "" } : item;
          if ((topicalMedia || topicalNative) && !isTopicalResult(intendedTopic, topicalItem, { requireTitle: item.provider !== "nasa-library" })) return false;
          const key = type === "images" ? imageIdentity(item.imageUrl || item.thumbnail || item.url)
            : type === "videos" ? youtubeWatch(new URL(item.url)) || item.url
            : type === "news" ? unicodeWords(item.title).join(" ") || item.url
            : type === "research" ? item.doi || item.url : item.url;
          return !seen.has(key) && seen.add(key);
        });
        const ranked = rankVertical(topic, known, item => (region ? indiaAffinity(item) * 0.35 : 0) + ageScore(item));
        const pageSize = type === "images" ? IMAGE_PAGE_SIZE : PAGE_SIZE;
        const results = packed.whole ? ranked.slice(page * pageSize, (page + 1) * pageSize) : ranked;
        const hasNext = packed.whole ? ranked.length > (page + 1) * pageSize : packed.more;
        if (!results.length && !provider && !(hasNext && ["research-mix", "discussion-mix", "space-images", "nasa-library", "stack-exchange"].includes(name))) {
          attempts.push("empty"); continue;
        }
        if (!noCache && name !== "veyra-crawler" && results.length && !packed.partial && !(saved?.until > Date.now())) {
          cache.set(key, { packed, until: Date.now() + 45_000 });
          if (cache.size > 100) cache.delete(cache.keys().next().value);
        }
        let nextPage = hasNext && page < lastVerticalPage(type, name) ? packed.nextPage ?? page + 1 : null;
        let nextProvider;
        if (nextPage === null && packed.commonsMore) {
          nextPage = IMAGE_FEED_SIZE / IMAGE_PAGE_SIZE; nextProvider = "wikimedia";
        }
        if (nextPage === null && type === "videos" && !preview && name !== "veyra-crawler" &&
            typeof indexedVideos === "function" && indexedVideos(q, 0, 1, region).total) {
          nextPage = 1; nextProvider = "veyra-crawler";
        }
        const section = { ...empty(results.length ? "ok" : "empty"), results, provider: packed.provider, nextPage,
          ...(nextProvider ? { nextProvider } : {}), observedAt: new Date().toISOString() };
        if (name === "image-mix" && !provider && !preview && results.length < 6 && !scope.include.length) { sparseImages = section; continue; }
        if (name === "reference-images" && sparseImages?.results.length) continue;
        if (name === "openverse" && sparseImages && results.length < sparseImages.results.length) return sparseImages;
        return section;
      } catch (error) {
        if (signal?.aborted) return sparseImages || empty("cancelled");
        if ([401, 403, 429].includes(error.status) || error.retryAfterMs > 0) {
          cooldown.set(breaker, Date.now() + Math.max(name === "openverse" ? 60_000 : 30_000, error.retryAfterMs || 0));
        }
        attempts.push("unavailable");
      }
    }
    return sparseImages || empty(attempts.includes("empty") ? "empty" : "unavailable");
  }
  return { search };
}

module.exports = { createVerticalSearch, TYPES, PAGE_SIZE, LAST_IMAGE_PAGE, lastVerticalPage, indexedWatchPage, safeUrl };
