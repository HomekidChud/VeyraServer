"use strict";

const cheerio = require("cheerio");

function cleanText(s, max = 400) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, max); }
function safeHttpUrl(raw) {
  try { const u = new URL(String(raw || "")); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : ""; } catch { return ""; }
}
function displayUrl(value) { try { const u = new URL(value); return (u.hostname.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname)).slice(0, 120); } catch { return value; } }
function row(url, title, snippet, source) {
  const href = safeHttpUrl(url); if (!href || !title) return null;
  return { url: href, canonicalUrl: href.replace(/#.*$/, "").replace(/\/$/, ""), title: cleanText(title, 300), snippet: cleanText(snippet, 700), displayUrl: displayUrl(href), source };
}
function unwrapDuckDuckGo(href) {
  try { const u = new URL(String(href || "").startsWith("//") ? "https:" + href : String(href || ""), "https://duckduckgo.com"); return /(^|\.)duckduckgo\.com$/i.test(u.hostname) && u.pathname === "/l/" ? u.searchParams.get("uddg") || "" : u.href; } catch { return ""; }
}
function unwrapBing(href) {
  try {
    const u = new URL(String(href || ""), "https://www.bing.com");
    if (/(^|\.)bing\.com$/i.test(u.hostname) && u.pathname === "/ck/a") {
      const encoded = u.searchParams.get("u") || "";
      if (!encoded.startsWith("a1")) return "";
      return Buffer.from(encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    }
    return u.href;
  } catch { return ""; }
}
function parseDuckDuckGoHtml(html) {
  const $ = cheerio.load(String(html || "")); const out = [];
  $(".result").each((_, el) => { const box = $(el); if (box.hasClass("result--ad") || box.find(".badge--ad").length) return;
    const a = box.find("a.result__a").first(); const item = row(unwrapDuckDuckGo(a.attr("href")), a.text(), box.find(".result__snippet").first().text(), "duckduckgo"); if (item) out.push(item); });
  return out;
}
function parseBingHtml(html) {
  const $ = cheerio.load(String(html || "")); const out = [];
  $("li.b_algo").each((_, el) => { const box = $(el); const a = box.find("h2 a").first(); const item = row(unwrapBing(a.attr("href")), a.text(), box.find(".b_caption p, p.b_lineclamp2, p.b_lineclamp3, p.b_lineclamp4, p").first().text(), "bing"); if (item) out.push(item); });
  return out;
}
function parseGoogleApi(json) { return (Array.isArray(json?.items) ? json.items : []).map(x => row(x.link, x.title, x.snippet, "google")).filter(Boolean); }
function parseBraveApi(json) { return (Array.isArray(json?.web?.results) ? json.web.results : []).map(x => row(x.url, x.title, x.description || x.snippet, "brave")).filter(Boolean); }
function parseBingApi(json) { return (Array.isArray(json?.webPages?.value) ? json.webPages.value : []).map(x => row(x.url, x.name || x.title, x.snippet, "bing")).filter(Boolean); }
function canonicalKey(url) {
  try { const u = new URL(url); if (u.username || u.password) return ""; u.hash = ""; for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k) || /^(fbclid|gclid|mc_cid|mc_eid)$/i.test(k)) u.searchParams.delete(k); u.hostname = u.hostname.toLowerCase(); return u.pathname === "/" && !u.search ? u.origin : u.href; }
  catch { return ""; }
}
function dedupe(rows) { const seen = new Set(); return rows.filter(r => { const key = canonicalKey(r.url); if (!key || seen.has(key)) return false; seen.add(key); r.canonicalUrl = key; return true; }); }
function classifyGoogleResponse({ status = 0, text = "", error = "" } = {}) {
  const body = String(text || "").slice(0, 10000).toLowerCase();
  if (/captcha|unusual traffic|automated queries|sorry\/index/.test(body)) return "challenge";
  if (/consent\.google|before you continue to google/.test(body)) return "consent";
  const errorText = String(error).toLowerCase();
  if (/malformed/.test(errorText)) return "malformed-response";
  if (/timeout|timed out|abort/.test(errorText)) return "timeout";
  if (/dns|enotfound|eai_again/.test(errorText)) return "dns-error";
  if (/tls|ssl|cert/.test(errorText)) return "tls-error";
  if (/network|econn|enet|ehost/.test(errorText)) return "network-error";
  if (!status && error) return "network-error";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "upstream-error";
  if (status >= 400) return "http-error";
  if (status >= 200 && !text) return "empty";
  return "response";
}
function errorSummary(provider, error) {
  const status = Number(error?.status || 0);
  if (error?.code === "OPERATION_CANCELLED") return { code: "cancelled" };
  const causeCode = String(error?.cause?.code || error?.code || "").toUpperCase();
  const networkCode = /ENOTFOUND|EAI_AGAIN/.test(causeCode) ? "dns-error" : /CERT|TLS|SSL/.test(causeCode) ? "tls-error" : /ECONN|EHOST|ENET/.test(causeCode) ? "network-error" : "";
  const common = status === 429 ? "rate-limited" : status === 403 ? "forbidden" : status >= 500 ? "upstream-error" : error?.name === "AbortError" || error?.code === "FETCH_TIMEOUT" || error?.name === "TimeoutError" ? "timeout" : error instanceof SyntaxError ? "malformed-response" : networkCode || "request-failed";
  if (provider === "google") return { code: common, classification: classifyGoogleResponse({ status, error: common }) };
  return { code: common };
}

function createWebSearch({ fetchText, env = process.env, log = () => {} }) {
  const googleKey = env.GOOGLE_SEARCH_API_KEY || env.GOOGLE_API_KEY || "";
  const googleCx = env.GOOGLE_SEARCH_CX || env.GOOGLE_CSE_ID || "";
  const braveKey = env.BRAVE_SEARCH_API_KEY || "";
  const bingKey = env.BING_SEARCH_API_KEY || "";
  const order = String(env.WEB_SEARCH_ORDER || "brave,bing,duckduckgo,google").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const timeoutMs = Math.max(250, Math.min(30000, Number(env.WEB_SEARCH_PROVIDER_TIMEOUT_MS) || 8000));
  const maxProviders = Math.max(1, Math.min(4, Number(env.WEB_SEARCH_MAX_PROVIDERS) || 3));
  const parallelism = Math.max(1, Math.min(4, Number(env.WEB_SEARCH_CONCURRENCY) || 3));
  const overallDeadlineMs = Math.max(250, Math.min(60000, Number(env.WEB_SEARCH_DEADLINE_MS) || 12000));
  const earlyCancelWindowMs = Math.max(0, Math.min(5000, env.WEB_SEARCH_EARLY_CANCEL_WINDOW_MS == null ? 1000 : Number(env.WEB_SEARCH_EARLY_CANCEL_WINDOW_MS) || 0));
  const earlyResultThreshold = Math.max(1, Math.min(100, Number(env.WEB_SEARCH_EARLY_RESULT_THRESHOLD) || 20));
  const cacheTtlMs = Math.max(0, Math.min(600000, Number(env.WEB_SEARCH_CACHE_TTL_MS) || 30000));
  const cache = new Map(); const MAX_CACHE = 200; const cooldowns = new Map();
  const health = Object.create(null);
  const providers = {
    google: { available: () => !!(googleKey && googleCx), async run(q, { offset, lang, signal }) {
      const u = new URL("https://www.googleapis.com/customsearch/v1"); u.searchParams.set("key", googleKey); u.searchParams.set("cx", googleCx); u.searchParams.set("q", q); u.searchParams.set("num", "10"); if (offset) u.searchParams.set("start", String(Math.min(91, offset + 1))); if (lang) u.searchParams.set("hl", lang);
      const r = await fetchText(u.href, { accept: "application/json", signal, timeoutMs }); if (!r.ok) throw Object.assign(new Error("Google Custom Search API request failed"), { status: r.status, retryAfterMs: r.retryAfterMs });
      const json = JSON.parse(r.text); return { results: parseGoogleApi(json), total: json.searchInformation?.totalResults ?? null };
    } },
    brave: { available: () => !!braveKey, async run(q, { offset, lang, signal }) {
      const u = new URL("https://api.search.brave.com/res/v1/web/search"); u.searchParams.set("q", q); u.searchParams.set("count", "20"); if (offset) u.searchParams.set("offset", String(Math.min(9, Math.floor(offset / 20)))); if (lang) u.searchParams.set("search_lang", lang);
      const r = await fetchText(u.href, { accept: "application/json", headers: { "X-Subscription-Token": braveKey }, signal, timeoutMs }); if (!r.ok) throw Object.assign(new Error("Brave Search API request failed"), { status: r.status, retryAfterMs: r.retryAfterMs }); const json = JSON.parse(r.text); return { results: parseBraveApi(json), total: null, more: !!json?.query?.more_results_available };
    } },
    bing: { available: () => true, async run(q, { offset, lang, signal, limit }) {
      const u = new URL(bingKey ? "https://api.bing.microsoft.com/v7.0/search" : "https://www.bing.com/search"); u.searchParams.set("q", q);
      const requestedLimit = Math.max(1, Math.min(50, Number(limit) || 20));
      if (bingKey) { u.searchParams.set("count", String(requestedLimit)); u.searchParams.set("offset", String(offset || 0)); if (lang) u.searchParams.set("setLang", lang); }
      else {
        if (lang) u.searchParams.set("setlang", lang);
        const pageSize = 10, starts = Array.from({ length: Math.ceil(requestedLimit / pageSize) }, (_, i) => Math.max(0, Number(offset) || 0) + i * pageSize);
        const pages = await Promise.allSettled(starts.map(async resultOffset => {
          const pageUrl = new URL(u.href);
          if (resultOffset > 0) pageUrl.searchParams.set("first", String(resultOffset + 1));
          pageUrl.searchParams.set("count", String(pageSize));
          const response = await fetchText(pageUrl.href, { accept: "text/html", signal, timeoutMs });
          if (!response.ok) throw Object.assign(new Error("Bing search request failed"), { status: response.status, retryAfterMs: response.retryAfterMs });
          return parseBingHtml(response.text);
        }));
        const successful = pages.filter(page => page.status === "fulfilled").flatMap(page => page.value);
        if (!successful.length) throw pages.find(page => page.status === "rejected")?.reason || new Error("Bing returned no result pages");
        const results = dedupe(successful).slice(0, requestedLimit);
        return { results, total: null, more: results.length >= requestedLimit, pagesFetched: pages.filter(page => page.status === "fulfilled").length };
      }
      const r = await fetchText(u.href, { accept: bingKey ? "application/json" : "text/html", headers: bingKey ? { "Ocp-Apim-Subscription-Key": bingKey } : {}, signal, timeoutMs }); if (!r.ok) throw Object.assign(new Error("Bing search request failed"), { status: r.status, retryAfterMs: r.retryAfterMs });
      const json = JSON.parse(r.text); return { results: parseBingApi(json), total: json?.webPages?.totalEstimatedMatches ?? null };
    } },
    duckduckgo: { available: () => true, async run(q, { offset, lang, signal }) {
      const u = new URL("https://html.duckduckgo.com/html/"); u.searchParams.set("q", q); if (offset) u.searchParams.set("s", String(offset)); if (lang) u.searchParams.set("kl", lang === "en" ? "wt-wt" : `${lang}-${lang}`);
      const r = await fetchText(u.href, { accept: "text/html", signal, timeoutMs }); if (!r.ok) throw Object.assign(new Error("DuckDuckGo search request failed"), { status: r.status, retryAfterMs: r.retryAfterMs });
      if (/anomaly-modal|challenge-form|bots use DuckDuckGo too/i.test(r.text)) throw Object.assign(new Error("DuckDuckGo returned a verification challenge"), { status: 429 }); return { results: parseDuckDuckGoHtml(r.text), total: null };
    } }
  };
  function configured(name) { return !!providers[name]?.available(); }
  function healthRecord(name) { return health[name] || { attempted: 0, successfulRequests: 0, nonEmpty: 0, emptyResponses: 0, failures: 0, consecutiveFailures: 0, latencyEwmaMs: null, latencySamplesMs: [], lastStatus: "not-checked", lastCheckedAt: null }; }
  function withLatency(old, ms) { return [...(old.latencySamplesMs || []), ms].slice(-100); }
  function percentile(values, q) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]; }
  function recordSuccess(name, results, ms) {
    const old = healthRecord(name), now = Date.now();
    health[name] = { ...old, attempted: old.attempted + 1, successfulRequests: old.successfulRequests + 1, nonEmpty: old.nonEmpty + (results.length ? 1 : 0), emptyResponses: old.emptyResponses + (results.length ? 0 : 1), failures: old.failures, consecutiveFailures: 0, latencySamplesMs: withLatency(old, ms), latencyEwmaMs: old.latencyEwmaMs == null ? ms : Math.round(old.latencyEwmaMs * 0.7 + ms * 0.3), lastStatus: results.length ? "success" : "empty", lastLatencyMs: ms, lastCheckedAt: now, lastSuccessAt: now };
    cooldowns.delete(name);
  }
  function recordFailure(name, ms, info, error) {
    const old = healthRecord(name), now = Date.now(), consecutiveFailures = old.consecutiveFailures + 1;
    const retryAfter = Number(error?.retryAfterMs);
    const cooldownMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(60000, retryAfter) : error?.status === 429 || error?.status === 403 ? 60000 : consecutiveFailures >= 3 ? 30000 : 10000;
    const until = now + cooldownMs; cooldowns.set(name, until);
    health[name] = { ...old, attempted: old.attempted + 1, failures: old.failures + 1, consecutiveFailures, latencySamplesMs: withLatency(old, ms), latencyEwmaMs: old.latencyEwmaMs == null ? ms : Math.round(old.latencyEwmaMs * 0.7 + ms * 0.3), lastStatus: info.code, lastLatencyMs: ms, lastCheckedAt: now, lastFailureAt: now, breakerOpenUntil: until };
  }
  function healthSummary(name) {
    const item = healthRecord(name), now = Date.now();
    return { configured: configured(name), attempted: item.attempted, successfulRequests: item.successfulRequests, nonEmpty: item.nonEmpty, emptyResponses: item.emptyResponses, failures: item.failures, successRate: item.attempted ? Math.round(item.successfulRequests / item.attempted * 1000) / 1000 : null, consecutiveFailures: item.consecutiveFailures, latencyEwmaMs: item.latencyEwmaMs, latencyP50Ms: percentile(item.latencySamplesMs || [], 0.5), latencyP95Ms: percentile(item.latencySamplesMs || [], 0.95), lastLatencyMs: item.lastLatencyMs ?? null, lastStatus: item.lastStatus, lastCheckedAt: item.lastCheckedAt, cooldownMsRemaining: Math.max(0, (cooldowns.get(name) || 0) - now), circuitState: (cooldowns.get(name) || 0) > now ? "open" : "closed" };
  }
  function providerUtility(name) {
    const item = healthRecord(name);
    if (!item.attempted) return 0.65 * 0.5 + 0.2 * 0.5 + 0.15;
    const reliability = (item.successfulRequests + 1) / (item.attempted + 2);
    const latency = 1 / (1 + Math.max(0, item.latencyEwmaMs || 0) / 2500);
    return 0.65 * reliability + 0.2 * latency + 0.15 / Math.sqrt(item.attempted + 1);
  }
  async function runProvider(name, q, params) {
    const controller = new AbortController(); const started = Date.now();
    let timer, abortListener;
    const abortUpstream = () => controller.abort();
    if (params.signal?.aborted) controller.abort();
    else params.signal?.addEventListener("abort", abortUpstream, { once: true });
    try {
      if (controller.signal.aborted) throw Object.assign(new Error("Operation cancelled."), { code: "OPERATION_CANCELLED" });
      const abortPromise = new Promise((_, reject) => { abortListener = () => reject(Object.assign(new Error("Provider request cancelled"), { name: "AbortError" })); controller.signal.addEventListener("abort", abortListener, { once: true }); });
      const packed = await Promise.race([providers[name].run(q, { ...params, signal: controller.signal }), abortPromise, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error("Provider deadline exceeded"), { name: "AbortError" })); }, timeoutMs); })]);
      const results = dedupe(packed.results || []); const ms = Date.now() - started;
      if (results.length) params.onResults?.(Date.now());
      recordSuccess(name, results, ms);
      return { name, results, total: packed.total ?? null, more: !!packed.more, ms };
    } catch (e) {
      const ms = Date.now() - started;
      if (params.isCancelled?.()) return { name, results: [], ms, error: "cancelled", cancelled: true };
      if (params.isEarlyCancel?.()) return { name, results: [], ms, cancelledAfterSufficientResults: true };
      const info = params.isDeadlineExpired?.() ? { code: "overall-deadline", ...(name === "google" ? { classification: "timeout" } : {}) } : errorSummary(name, e);
      recordFailure(name, ms, info, e);
      log("warn", "SEARCH", `${name} search provider failed (${info.code})`);
      return { name, results: [], ms, error: info.code, classification: info.classification };
    } finally { clearTimeout(timer); if (abortListener) controller.signal.removeEventListener("abort", abortListener); params.signal?.removeEventListener("abort", abortUpstream); }
  }
  async function search(query, { offset = 0, engine = "", lang = "", signal, limit = 20 } = {}) {
    const requestStartedAt = Date.now(); let firstResultAt = null;
    const requestedLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    const q = cleanText(query, 600); if (!q) return { provider: "none", results: [], attempts: [], responseTimeMs: Date.now() - requestStartedAt, timeToFirstResultMs: null };
    const requested = engine && providers[engine] ? [engine] : order.filter(name => providers[name]);
    const key = `${requested.join(",")}|${offset}|${requestedLimit}|${lang}|${q.toLowerCase()}`; const hit = cache.get(key);
    if (hit && Date.now() - hit.time < cacheTtlMs) return { ...hit.value, cached: true, responseTimeMs: Date.now() - requestStartedAt };
    const attempts = []; let eligible = [];
    for (const name of requested) {
      if (!configured(name)) { attempts.push({ provider: name, skipped: "not-configured" }); continue; }
      if ((cooldowns.get(name) || 0) > Date.now()) { attempts.push({ provider: name, skipped: "cooldown" }); continue; }
      eligible.push(name);
    }
    if (!engine) {
      eligible = eligible.slice(0, maxProviders);
      if (eligible.some(name => healthRecord(name).attempted)) {
        const originalOrder = new Map(eligible.map((name, index) => [name, index]));
        eligible.sort((a, b) => providerUtility(b) - providerUtility(a) || originalOrder.get(a) - originalOrder.get(b));
      }
    }
    const requestController = new AbortController();
    let callerCancelled = false, deadlineExpired = false, earlyCancelled = false;
    const observedResultKeys = new Set();
    const deadlineAt = Date.now() + overallDeadlineMs;
    const abortForCaller = () => { callerCancelled = true; requestController.abort(); };
    if (signal?.aborted) abortForCaller(); else signal?.addEventListener("abort", abortForCaller, { once: true });
    const deadlineTimer = setTimeout(() => { deadlineExpired = true; requestController.abort(); }, overallDeadlineMs);
    const settled = new Array(eligible.length); let cursor = 0;
    async function worker() { while (cursor < eligible.length && !requestController.signal.aborted) { const index = cursor++; const item = await runProvider(eligible[index], q, { offset, limit: requestedLimit, lang, signal: requestController.signal, isCancelled: () => callerCancelled, isDeadlineExpired: () => deadlineExpired, isEarlyCancel: () => earlyCancelled, onResults: at => { if (firstResultAt == null) firstResultAt = at; } }); settled[index] = item; for (const result of item.results) { const key = canonicalKey(result.url); if (key) observedResultKeys.add(key); } if (!callerCancelled && !deadlineExpired && !earlyCancelled && observedResultKeys.size >= earlyResultThreshold && deadlineAt - Date.now() <= earlyCancelWindowMs) { earlyCancelled = true; requestController.abort(); } } }
    try { await Promise.all(Array.from({ length: Math.min(parallelism, eligible.length) }, worker)); }
    finally { clearTimeout(deadlineTimer); signal?.removeEventListener("abort", abortForCaller); }
    const successful = settled.filter(Boolean);
    for (const item of successful) attempts.push({ provider: item.name, ms: item.ms, count: item.results.length, ...(item.cancelledAfterSufficientResults ? { skipped: "cancelled-after-sufficient-results" } : {}), ...(item.error ? { error: item.error, ...(item.classification ? { classification: item.classification } : {}) } : {}) });
    const merged = new Map();
    for (const item of successful) for (const result of item.results) {
      const id = canonicalKey(result.url); const existing = merged.get(id);
      if (!existing) merged.set(id, { ...result, providers: [item.name], source: item.name });
      else { if (!existing.providers.includes(item.name)) existing.providers.push(item.name); if (result.snippet.length > existing.snippet.length) existing.snippet = result.snippet; }
    }
    const results = [...merged.values()].slice(0, requestedLimit);
    const source = successful.find(x => x.results.length)?.name || "none";
    const value = { provider: source, results, total: successful.reduce((n, x) => n + (x.total || x.results.length), 0) || null, more: successful.some(x => x.more), attempts, googleConfigured: configured("google"), braveConfigured: configured("brave"), bingConfigured: configured("bing"), providersUsed: successful.filter(x => x.results.length).map(x => x.name), cancelled: callerCancelled, earlyCancelled, deadlineExceeded: deadlineExpired, responseTimeMs: Date.now() - requestStartedAt, timeToFirstResultMs: firstResultAt == null ? null : firstResultAt - requestStartedAt, diagnostics: { providerCount: eligible.length, parallelism: Math.min(parallelism, eligible.length), overallDeadlineMs, earlyCancelWindowMs, earlyResultThreshold, providers: Object.fromEntries(Object.keys(providers).map(name => [name, healthSummary(name)])), google: healthSummary("google") } };
    if (results.length && cacheTtlMs) { cache.set(key, { time: Date.now(), value }); while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value); }
    return value;
  }
  return { search, googleConfigured: () => configured("google"), order, providers: Object.keys(providers), diagnostics: () => ({ adaptiveOrdering: true, maxProviders, parallelism, overallDeadlineMs, providers: Object.fromEntries(Object.keys(providers).map(name => [name, healthSummary(name)])) }) };
}

module.exports = { createWebSearch, parseDuckDuckGoHtml, parseBingHtml, parseGoogleApi, parseBraveApi, parseBingApi, unwrapBing, unwrapDuckDuckGo, classifyGoogleResponse, canonicalKey };
