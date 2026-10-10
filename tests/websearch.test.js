"use strict";
const assert = require("assert");
const { createWebSearch, classifyGoogleResponse } = require("../src/services/websearch");

(async () => {
  const unconfigured = createWebSearch({ env: {}, fetchText: async () => ({ ok: true, status: 200, text: "" }) });
  const google = await unconfigured.search("Veyra browser", { engine: "google", lang: "en" });
  assert.equal(google.provider, "none");
  assert.equal(google.results.length, 0);
  assert.deepEqual(google.attempts[0], { provider: "google", skipped: "not-configured" });

  assert.equal(classifyGoogleResponse({ status: 429 }), "rate-limited");
  assert.equal(classifyGoogleResponse({ status: 403 }), "forbidden");
  assert.equal(classifyGoogleResponse({ status: 200, text: "unusual traffic from your computer network" }), "challenge");
  assert.equal(classifyGoogleResponse({ status: 200, text: "" }), "empty");
  assert.equal(classifyGoogleResponse({ error: "malformed-response" }), "malformed-response");
  assert.equal(classifyGoogleResponse({ error: "ENOTFOUND" }), "dns-error");
  assert.equal(classifyGoogleResponse({ error: "CERT_HAS_EXPIRED" }), "tls-error");

  let active = 0, peak = 0;
  const parallel = createWebSearch({ env: { WEB_SEARCH_ORDER: "duckduckgo,bing,brave", BRAVE_SEARCH_API_KEY: "test-key", WEB_SEARCH_CONCURRENCY: "3" }, fetchText: async url => {
    active += 1; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 30)); active -= 1;
    if (url.includes("duckduckgo")) return { ok: true, status: 200, text: '<div class="result"><a class="result__a" href="https://example.com/story?utm_source=test">Example story</a><a class="result__snippet">Short snippet.</a></div>' };
    if (url.includes("bing.com")) return { ok: true, status: 200, text: '<li class="b_algo"><h2><a href="https://example.com/story">Example story</a></h2><div class="b_caption"><p>A longer snippet from Bing.</p></div></li>' };
    return { ok: true, status: 200, text: JSON.stringify({ web: { results: [{ url: "https://another.example/page", title: "Other", description: "Another result" }] } }) };
  } });
  const result = await parallel.search("example story");
  assert(peak > 1, "independent providers should run concurrently");
  assert.equal(result.providersUsed.length, 3);
  assert.equal(result.results.length, 2, "tracking variants of the same URL should deduplicate");
  assert.deepEqual(result.results[0].providers, ["duckduckgo", "bing"]);
  assert.equal(result.results[0].snippet, "A longer snippet from Bing.");
  assert.equal(result.attempts.length, 3);

  const identities = createWebSearch({ env: { WEB_SEARCH_ORDER: "duckduckgo" }, fetchText: async () => ({ ok: true, status: 200, text: [
    '<div class="result"><a class="result__a" href="https://example.com/Case">Upper path</a></div>',
    '<div class="result"><a class="result__a" href="https://example.com/case">Lower path</a></div>',
    '<div class="result"><a class="result__a" href="https://example.com/story/">Trailing slash</a></div>',
    '<div class="result"><a class="result__a" href="https://example.com/story">No trailing slash</a></div>',
    '<div class="result"><a class="result__a" href="https://example.com/page?source=docs">Content parameter</a></div>',
    '<div class="result"><a class="result__a" href="https://alice:secret@example.com/private">Credentials must be rejected</a></div>'
  ].join("") }) });
  const identityResult = await identities.search("url identity");
  assert.equal(identityResult.results.length, 5, "case-sensitive paths, trailing slashes and content parameters must remain distinct; credential URLs must be discarded");

  const timeout = createWebSearch({ env: { WEB_SEARCH_ORDER: "duckduckgo", WEB_SEARCH_PROVIDER_TIMEOUT_MS: "250" }, fetchText: async (_url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  }) });
  const timed = await timeout.search("timeout test");
  assert.equal(timed.provider, "none");
  assert.equal(timed.attempts[0].error, "timeout");
  assert.equal(timeout.diagnostics().providers.duckduckgo.circuitState, "open");

  const adaptive = createWebSearch({ env: { WEB_SEARCH_ORDER: "brave,bing,duckduckgo,google", WEB_SEARCH_MAX_PROVIDERS: "2", WEB_SEARCH_CONCURRENCY: "1", WEB_SEARCH_CACHE_TTL_MS: "0", BRAVE_SEARCH_API_KEY: "mock", BING_SEARCH_API_KEY: "mock" }, fetchText: async url => {
    if (url.includes("api.search.brave.com")) { await new Promise(resolve => setTimeout(resolve, 35)); return { ok: true, status: 200, text: JSON.stringify({ web: { results: [{ url: "https://brave.example/story", title: "Brave fixture", description: "Mock result" }] } }) }; }
    if (url.includes("api.bing.microsoft.com")) { await new Promise(resolve => setTimeout(resolve, 1)); return { ok: true, status: 200, text: JSON.stringify({ webPages: { value: [{ url: "https://bing.example/story", name: "Bing fixture", snippet: "Mock result" }] } }) }; }
    throw new Error("unexpected provider in adaptive fixture");
  } });
  await adaptive.search("calibrate bing", { engine: "bing" });
  await adaptive.search("calibrate brave", { engine: "brave" });
  const adapted = await adaptive.search("adaptive route ordering");
  assert.equal(adapted.attempts.find(attempt => !attempt.skipped).provider, "bing", "better observed success/latency should outrank the configured first provider");
  assert.equal(adapted.diagnostics.providers.bing.successfulRequests, 2);
  assert.equal(Number.isFinite(adapted.diagnostics.providers.bing.latencyP50Ms), true);
  assert.equal(Number.isFinite(adapted.diagnostics.providers.bing.latencyP95Ms), true);
  assert.equal(adaptive.diagnostics().adaptiveOrdering, true);

  const fallback = createWebSearch({ env: { WEB_SEARCH_ORDER: "google,brave,bing", WEB_SEARCH_MAX_PROVIDERS: "1", BRAVE_SEARCH_API_KEY: "mock" }, fetchText: async url => ({ ok: true, status: 200, text: JSON.stringify({ web: { results: [{ url: "https://fallback.example/result", title: "Fallback", description: "Available provider" }] } }) }) });
  const fallbackResult = await fallback.search("fallback when Google unconfigured");
  assert.equal(fallbackResult.attempts[0].skipped, "not-configured");
  assert.equal(fallbackResult.provider, "brave", "an unconfigured first provider must not consume the network-provider quota");

  const breaker = createWebSearch({ env: { WEB_SEARCH_ORDER: "duckduckgo,bing", WEB_SEARCH_MAX_PROVIDERS: "2", WEB_SEARCH_CONCURRENCY: "1", WEB_SEARCH_CACHE_TTL_MS: "0", BING_SEARCH_API_KEY: "mock" }, fetchText: async url => {
    if (url.includes("duckduckgo")) return { ok: false, status: 503, text: "", retryAfterMs: 3000 };
    return { ok: true, status: 200, text: JSON.stringify({ webPages: { value: [{ url: "https://breaker.example/result", name: "Recovered", snippet: "Bing remains usable" }] } }) };
  } });
  const failedProvider = await breaker.search("breaker fixture", { engine: "duckduckgo" });
  assert.equal(failedProvider.attempts[0].error, "upstream-error");
  assert.equal(breaker.diagnostics().providers.duckduckgo.circuitState, "open");
  assert(breaker.diagnostics().providers.duckduckgo.cooldownMsRemaining > 2500, "bounded Retry-After guidance should inform cooldown even for HTTP 503");
  const recovered = await breaker.search("fallback after provider outage");
  assert.equal(recovered.provider, "bing");
  assert.equal(recovered.attempts.some(attempt => attempt.provider === "duckduckgo" && attempt.skipped === "cooldown"), true);

  const deadline = createWebSearch({ env: { WEB_SEARCH_ORDER: "duckduckgo", WEB_SEARCH_PROVIDER_TIMEOUT_MS: "5000", WEB_SEARCH_DEADLINE_MS: "250", WEB_SEARCH_CACHE_TTL_MS: "0" }, fetchText: async (_url, opts) => new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })) });
  const deadlineStarted = Date.now();
  const deadlineResult = await deadline.search("overall deadline fixture");
  assert.equal(deadlineResult.deadlineExceeded, true);
  assert.equal(deadlineResult.attempts[0].error, "overall-deadline");
  assert(Date.now() - deadlineStarted < 1500, "overall deadline should bound aggregate wait");

  let slowPeerAborted = false;
  const sufficient = createWebSearch({ env: { WEB_SEARCH_ORDER: "duckduckgo,bing", WEB_SEARCH_MAX_PROVIDERS: "2", WEB_SEARCH_CONCURRENCY: "2", WEB_SEARCH_PROVIDER_TIMEOUT_MS: "5000", WEB_SEARCH_DEADLINE_MS: "1000", WEB_SEARCH_EARLY_CANCEL_WINDOW_MS: "1000", WEB_SEARCH_EARLY_RESULT_THRESHOLD: "1", WEB_SEARCH_CACHE_TTL_MS: "0" }, fetchText: async (url, opts) => {
    if (url.includes("duckduckgo")) return { ok: true, status: 200, text: '<div class="result"><a class="result__a" href="https://sufficient.example/result">One useful result</a><a class="result__snippet">A controlled sufficient-result fixture.</a></div>' };
    return new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => { slowPeerAborted = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true }));
  } });
  const sufficientResult = await sufficient.search("sufficient partial results");
  assert.equal(sufficientResult.earlyCancelled, true);
  assert.equal(sufficientResult.results.length, 1);
  assert.equal(Number.isFinite(sufficientResult.responseTimeMs), true);
  assert.equal(Number.isFinite(sufficientResult.timeToFirstResultMs), true);
  assert.equal(sufficientResult.diagnostics.earlyResultThreshold, 1);
  assert.equal(slowPeerAborted, true, "an unnecessary peer should be cancelled once the configured sufficiency threshold is met near the deadline");
  assert.equal(sufficient.diagnostics().providers.bing.failures, 0, "intentional sufficient-results cancellation is not a provider failure");

  const callerAbort = new AbortController();
  const cancellableSearch = createWebSearch({ env: { WEB_SEARCH_ORDER: "duckduckgo", WEB_SEARCH_CACHE_TTL_MS: "0" }, fetchText: async (_url, opts) => new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })) });
  const cancelledPromise = cancellableSearch.search("caller cancellation fixture", { signal: callerAbort.signal });
  setTimeout(() => callerAbort.abort(), 5);
  const cancelledResult = await cancelledPromise;
  assert.equal(cancelledResult.cancelled, true);
  assert.equal(cancellableSearch.diagnostics().providers.duckduckgo.failures, 0, "caller cancellation is not provider health failure");

  const malformed = createWebSearch({ env: { WEB_SEARCH_ORDER: "google", GOOGLE_SEARCH_API_KEY: "mock", GOOGLE_SEARCH_CX: "mock" }, fetchText: async () => ({ ok: true, status: 200, text: "{" }) });
  const badPayload = await malformed.search("malformed", { engine: "google" });
  assert.equal(badPayload.attempts[0].error, "malformed-response");
  assert.equal(badPayload.attempts[0].classification, "malformed-response");

  console.log("Live web search regression tests passed (credentials, Google classification, bounded/adaptive parallelism, circuit cooldown, deadlines, cancellation, dedupe)");
})().catch(error => { console.error(error); process.exit(1); });
