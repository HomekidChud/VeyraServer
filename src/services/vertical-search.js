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

const TYPES = Object.freeze(["images", "videos", "news", "shopping", "research", "discussions"]);
const PAGE_SIZE = 12;
const LAST_IMAGE_PAGE = 9;
function lastVerticalPage(type, provider) {
  if (provider === "image-mix") return LAST_IMAGE_PAGE;
  if (provider === "brave" || provider === "web-discovery") return 9;
  if (type === "images" && provider === "wikimedia") return 49;
  return ["openverse", "peertube", "veyra-crawler", "google-news-rss", "ebay", "crossref", "hacker-news"].includes(provider) ? 19 : 3;
}
const ENDPOINT = "https://api.search.brave.com/res/v1";
const TIMEOUT = 4400;
const VIDEO_INTENT = new Set("fix repair make install tutorial guide review recipe video watch".split(" "));
function videoTopic(query) {
  const subject = unicodeWords(query).filter(word => !VIDEO_INTENT.has(word));
  return subject.length ? subject.join(" ") : query;
}
const THUMB_HOSTS = new Set(["imgs.search.brave.com", "upload.wikimedia.org", "thumb.wikimedia.org", "i.ebayimg.com", "i.ytimg.com",
  "images-assets.nasa.gov", "science.nasa.gov", "assets.science.nasa.gov", "www.esa.int", "media.esa.int"]);

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
  if (type === "videos") return (matchingHost(u.hostname, ["youtube.com"]) && ((u.pathname === "/watch" && /^[\w-]{11}$/.test(u.searchParams.get("v") || "")) || /^\/shorts\/[\w-]{11}\/?$/.test(u.pathname))) || (matchingHost(u.hostname, ["vimeo.com"]) && /\/\d+\/?$/.test(u.pathname));
  if (type === "shopping" && india(region)) return isIndianProductUrl(url);
  if (type === "shopping") return (matchingHost(u.hostname, ["amazon.com", "amazon.co.uk"]) && /\/(?:dp|gp\/product)\/[A-Z0-9]{10}(?:\/|$)/i.test(u.pathname)) || (matchingHost(u.hostname, ["ebay.com", "ebay.co.uk"]) && /^\/itm\/(?:[^/]+\/)?\d+\/?$/.test(u.pathname)) || (matchingHost(u.hostname, ["etsy.com"]) && /\/listing\/\d+(?:\/|$)/.test(u.pathname));
  return true;
}
function indexedWatchPage(value) {
  return testLink("videos", value) && /^https:/.test(value);
}
function watchThumbnail(value) {
  const u = new URL(value);
  if (!matchingHost(u.hostname, ["youtube.com"])) return "";
  const videoId = u.searchParams.get("v") || /^\/shorts\/([\w-]{11})/.exec(u.pathname)?.[1];
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

function createVerticalSearch({ fetchText, webSearch, indexedImages, indexedVideos, indexedProducts, env = process.env, providerTimeoutMs = TIMEOUT }) {
  const cache = new Map(), cooldown = new Map();
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
    const json = await get(queryUrl(`${ENDPOINT}/${type}/search`, { q, count: type === "images" ? PAGE_SIZE * 4 : PAGE_SIZE, offset, country: region, search_lang: region ? braveLanguage(lang) : lang, safesearch: "strict" }), signal, { headers: { "X-Subscription-Token": braveKey } });
    if (!Array.isArray(json.results)) throw new Error("Invalid results");
    const results = json.results.map(item => row(type, "brave", {
      ...item, source: item.source || item.video?.creator || item.meta_url?.hostname,
      thumbnail: item.thumbnail?.src, snippet: item.description, duration: item.video?.duration,
      imageUrl: item.properties?.url,
      publishedAt: item.page_age || item.video?.published
    }));
    return { provider: "brave", results, whole: type === "images", more: type !== "images" && (json.query?.more_results_available ?? results.length === PAGE_SIZE) };
  }
  async function commons(type, q, { page, signal, count = PAGE_SIZE }) {
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
  async function imageMix(type, q, { signal, lang, region, fullQuery }) {
    const lanes = [["wikimedia", () => commons(type, q, { page: 0, signal, count: 48 })]];
    if (braveKey) lanes.unshift(["brave", () => brave(type, fullQuery, { page: 0, signal, lang, region })]);
    const active = lanes.filter(([name]) => (cooldown.get(`${name}:images`) || 0) <= Date.now());
    const settled = await Promise.allSettled(active.map(([, run]) => run()));
    for (let i = 0; i < settled.length; i++) {
      if ([401, 403, 429].includes(settled[i].reason?.status)) cooldown.set(`${active[i][0]}:images`, Date.now() + 30_000);
    }
    signal?.throwIfAborted();
    const feeds = settled.flatMap(item => item.status === "fulfilled" ? [item.value.results.slice(0, 48)] : []);
    const commonsMore = settled.some(item => item.status === "fulfilled" && item.value.provider === "wikimedia" && item.value.more);
    let local = [];
    try { local = indexedImages(fullQuery, region).slice(0, 24).map(item => row(type, "veyra-crawler", item)); } catch {}
    if (local.some(Boolean)) feeds.push(local);
    if (!feeds.length) throw new Error("No image providers available");
    const results = [];
    for (let i = 0; i < 48; i++) for (const feed of feeds) if (feed[i]) results.push(feed[i]);
    return { provider: "image-mix", results, whole: true, commonsMore };
  }
  async function openverse(type, q, { page, signal }) {
    // Openverse treats its legacy mature parameter and the sensitivity
    // parameter as mutually exclusive. Validate the returned rows as well.
    const json = await get(queryUrl("https://api.openverse.org/v1/images/", { q, page: page + 1, page_size: PAGE_SIZE,
      filter_dead: true, unstable__include_sensitive_results: false }), signal);
    if (!Array.isArray(json.results)) throw new Error("Invalid Openverse response");
    const results = json.results.slice(0, PAGE_SIZE).flatMap(item => {
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
  async function crossref(type, q, { page, signal }) {
    const json = await get(queryUrl("https://api.crossref.org/works", { "query.bibliographic": q, rows: PAGE_SIZE, offset: page * PAGE_SIZE, select: "DOI,title,container-title,publisher,published,type,author", filter: "type:journal-article" }), signal);
    if (!Array.isArray(json.message?.items)) throw new Error("Invalid Crossref response");
    const results = json.message.items.map(item => {
      if (!/^10\.\d{4,9}\/\S{1,500}$/i.test(item.DOI || "")) return null;
      const parts = item.published?.["date-parts"]?.[0];
      const authors = (item.author || []).slice(0, 3).map(a => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean);
      const publishedAt = parts?.length === 3 ? parts.map((n, i) => String(n).padStart(i ? 2 : 4, "0")).join("-") : "";
      return row(type, "crossref", { title: item.title?.[0], url: `https://doi.org/${item.DOI.split("/").map(encodeURIComponent).join("/")}`, source: item["container-title"]?.[0] || item.publisher, snippet: [authors.join(", "), !publishedAt && parts?.[0]].filter(Boolean).join(" · "), publishedAt });
    });
    return { provider: "crossref", results, more: Number(json.message["total-results"]) > (page + 1) * PAGE_SIZE };
  }
  async function discussions(type, q, { page, signal }) {
    const json = await get(queryUrl("https://hn.algolia.com/api/v1/search", { query: q, tags: "story", page, hitsPerPage: PAGE_SIZE }), signal);
    if (!Array.isArray(json.hits)) throw new Error("Invalid Hacker News response");
    const results = json.hits.filter(item => /^\d+$/.test(item.objectID)).map(item => row(type, "hacker-news", { url: `https://news.ycombinator.com/item?id=${item.objectID}`, title: item.title, snippet: item.story_text, source: "Hacker News", publishedAt: item.created_at }));
    return { provider: "hacker-news", results, more: json.nbPages > page + 1 };
  }
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
  async function webCategory(type, q, { page, signal, lang, region, noCache }) {
    // The discovery hint goes to upstreams, but never counts as a match.
    const shopping = type === "shopping" && india(region);
    const topic = type === "videos" ? videoTopic(q) : q;
    const deadline = AbortSignal.timeout(providerTimeoutMs);
    const packed = await webSearch(`${q} ${type === "videos" ? "YouTube video" : shopping ? "buy online India" : "buy online"}`, {
      offset: page * WEB_FEED_STEP, limit: PAGE_SIZE * 2, lang, region, shopping, topic,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline, noCache, feed: true });
    if (packed.attempts?.length && packed.attempts.every(attempt => attempt.error || attempt.skipped)) throw new Error("No provider reached");
    const results = (packed.results || []).filter(item => testLink(type, item.url, region) &&
      isTopicalResult(topic, { ...item, snippet: item.snippet || item.description }, { requireTitle: true })).map(item => {
      const poster = type === "videos" ? watchThumbnail(item.url) : "";
      return row(type, "web-discovery", { url: item.url, title: item.title, source: shopping ? "" : item.source, snippet: shopping ? "" : item.snippet || item.description, thumbnail: poster, price: shopping ? inrPrice(item.price) : null });
    });
    return { provider: "web-discovery", results, more: !!packed.more };
  }
  function crawlerVideoFeed(type, _q, { page, region, fullQuery }) {
    const batch = Math.max(1, page);
    const data = indexedVideos(fullQuery, (batch - 1) * PAGE_SIZE, PAGE_SIZE, region);
    return { provider: "veyra-crawler", results: data.results.filter(item => indexedWatchPage(item.url)).map(item =>
      row(type, "veyra-crawler", { ...item, source: "", thumbnail: watchThumbnail(item.url) })),
    more: batch * PAGE_SIZE < data.total, nextPage: batch + 1 };
  }
  function crawlerProductFeed(type, _q, { page, region, fullQuery }) {
    const data = indexedProducts(fullQuery, page * PAGE_SIZE, PAGE_SIZE, region);
    return { provider: "veyra-crawler", results: data.results.filter(item => testLink(type, item.url, region))
      .map(item => row(type, "veyra-crawler", { title: item.title, url: item.url })), more: (page + 1) * PAGE_SIZE < data.total };
  }
  function adapters(type, page, preview, provider, region) {
    const list = [];
    if (type === "images" && !preview && typeof indexedImages === "function" && (!provider || provider === "image-mix")) list.push(["image-mix", imageMix]);
    else {
      if (braveKey && ["images", "videos", "news"].includes(type)) list.push(["brave", brave]);
      if (type === "images") list.push(["wikimedia", commons]);
    }
    if (type === "images" && !preview) list.push(["openverse", openverse]);
    if (type === "videos" && !page && !preview && env.YOUTUBE_DATA_API_KEY && env.VEYRA_YOUTUBE_SEARCH === "1") list.push(["youtube", youtube]);
    if (type === "videos") list.push(["peertube", peertube]);
    if (type === "news") list.push(["google-news-rss", newsFeed]);
    if (type === "shopping" && !india(region) && env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) list.push(["ebay", ebay]);
    if (type === "videos" && !preview && typeof indexedVideos === "function") list.push(["veyra-crawler", crawlerVideoFeed]);
    if (type === "shopping" && !preview && india(region) && typeof indexedProducts === "function") list.push(["veyra-crawler", crawlerProductFeed]);
    if (type === "videos" || type === "shopping") list.push(["web-discovery", webCategory]);
    if (type === "research") list.push(["crossref", crossref]);
    if (type === "discussions") list.push(["hacker-news", discussions]);
    return list;
  }
  async function search(type, rawQuery, { page = 0, lang = "en", region = "", signal, noCache = true, provider = "", preview = false } = {}) {
    if (!TYPES.includes(type)) throw new Error("Unknown vertical");
    const started = Date.now(), scope = parseSiteScope(rawQuery), q = String(rawQuery).trim().slice(0, 400);
    region = india(region) ? "IN" : "";
    const language = region ? indiaLanguage(scope.text || q, lang) : /^[a-z]{2}$/i.test(lang) ? lang.toLowerCase() : "en";
    const siteFilter = scope.active ? { include: scope.include, exclude: scope.exclude, invalid: scope.invalid } : null;
    const empty = status => ({ type, status, provider: "none", ranking: rankerVersion, results: [], nextPage: null, siteFilter, responseTimeMs: Date.now() - started });
    if (scope.invalid) return empty("invalid-scope");
    if (!q || (scope.active && !scope.text)) return empty("empty");
    const attempts = [];
    let sparseImages;
    const topic = scope.text || q;
    const mediaTopic = type === "videos" ? videoTopic(topic) : topic;
    const ageScore = item => {
      const age = (started - Date.parse(item.publishedAt)) / 86400000;
      return type === "news" && age >= 0 ? 1.8 / (1 + age / 30) : 0;
    };
    for (const [name, run] of adapters(type, page, preview, provider, region)) {
      if (signal?.aborted) return sparseImages || empty("cancelled");
      if (provider && provider !== name) continue;
      if (name === "openverse" && scope.include.length) continue;
      const breaker = `${name}:${name === "brave" ? type : ""}`;
      if ((cooldown.get(breaker) || 0) > Date.now()) { attempts.push("unavailable"); continue; }
      const singleFeed = name === "image-mix" || name === "google-news-rss" || (name === "brave" && type === "images");
      const key = JSON.stringify([name, type, q, language, region, singleFeed ? 0 : page]);
      const saved = noCache || name === "veyra-crawler" ? null : cache.get(key);
      try {
        const providerQuery = name === "brave" ? q : (scope.text || q).slice(0, 400);
        const packed = saved?.until > Date.now() ? saved.packed : await run(type, providerQuery, { page, lang: language, region, signal, noCache, fullQuery: q });
        if (signal?.aborted) return sparseImages || empty("cancelled");
        const seen = new Set();
        const known = packed.results.filter(item => {
          if (!item || !allowsSiteUrl(scope, item.sourcePageUrl || item.url)) return false;
          const topicalMedia = type === "videos" || (type === "images" && unicodeWords(topic).length > 1 && !/[^\u0000-\u007f]/.test(topic));
          if (topicalMedia && !isTopicalResult(mediaTopic, item, { requireTitle: true })) return false;
          const key = type === "images" ? imageIdentity(item.imageUrl || item.thumbnail || item.url)
            : type === "news" ? unicodeWords(item.title).join(" ") || item.url : item.url;
          return !seen.has(key) && seen.add(key);
        });
        const ranked = rankVertical(topic, known, item => (region ? indiaAffinity(item) * 0.35 : 0) + ageScore(item));
        const results = packed.whole ? ranked.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : ranked;
        const hasNext = packed.whole ? ranked.length > (page + 1) * PAGE_SIZE : packed.more;
        if (!results.length && !provider) { attempts.push("empty"); continue; }
        if (!noCache && name !== "veyra-crawler" && results.length && !(saved?.until > Date.now())) {
          cache.set(key, { packed, until: Date.now() + 45_000 });
          if (cache.size > 100) cache.delete(cache.keys().next().value);
        }
        let nextPage = hasNext && page < lastVerticalPage(type, name) ? packed.nextPage ?? page + 1 : null;
        let nextProvider;
        if (nextPage === null && packed.commonsMore) {
          nextPage = 4; nextProvider = "wikimedia"; // First mix already fetched 48 Commons entries.
        }
        if (nextPage === null && type === "videos" && !preview && name !== "veyra-crawler" &&
            typeof indexedVideos === "function" && indexedVideos(q, 0, 1, region).total) {
          nextPage = 1; nextProvider = "veyra-crawler";
        }
        const section = { ...empty(results.length ? "ok" : "empty"), results, provider: packed.provider, nextPage,
          ...(nextProvider ? { nextProvider } : {}), observedAt: new Date().toISOString() };
        if (name === "image-mix" && !provider && !preview && results.length < 6 && !scope.include.length) { sparseImages = section; continue; }
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
