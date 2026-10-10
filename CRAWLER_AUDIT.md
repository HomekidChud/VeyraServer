# Veyra search and crawler architecture audit

**Repository:** `HomekidChud/VeyraServer` (`main`). Backup repositories were excluded. **Date:** 2026-10-10.

## Live architecture and request paths

- `/api/search` uses the in-process local Veyra index (`localSearch`).
- `/api/search/web` uses the live provider orchestrator initialized from `src/services/websearch.js`.
- `/api/search/answer` searches the local index, queries that same live provider path, ranks and fetches external candidates through `AcquisitionManager.searchFirst`, reuses fetched/indexed text, then builds evidence and synthesizes/verifies an answer with `AIAnswerEngine`.
- `/api/youtube/resolve` uses the existing YouTube URL parser and public oEmbed metadata endpoint. oEmbed is not player playback or transcript evidence.
- `src/services/neural-search.js` remains a separate implementation and is not part of the live web-search route. The active route has one provider orchestration path; useful neural URL scoring remains reused for the broader index/frontier behavior.
- `AcquisitionManager` is the direct HTTP acquisition boundary for robots, destination/redirect validation, deadlines/size/retry limits, caching/validators, extraction, feeds and sitemaps. The broader browser/proxy crawler and background task scheduling remain in `src/server.js`.
- Chromium is opt-in. The `prestart` check only inspects the executable and warns; it does not install or launch a browser.

## Problems addressed and implementation

1. **Provider path and latency:** Search requests now use bounded concurrent providers, configurable per-provider/overall deadlines and concurrency, partial results, typed failures, caller cancellation, and a conservative sufficient-results cancellation window near the deadline. Learned success/latency history adapts subsequent provider order. Circuit cooldowns use bounded `Retry-After` guidance. Diagnostics report safe p50/p95, EWMA, success rate and circuit state without credentials.
2. **Search-to-answer wiring:** Local index candidates and external provider results are canonicalized/merged with provider provenance. Fetched text is reused. External candidates are ranked before acquisition using query/title/snippet relevance, freshness when relevant, fetch cost, domain diversity and optional source/extraction quality, novelty, duplicate-risk and retry signals.
3. **Bounded retrieval:** Search-first retrieval has a configurable total default 20-second budget, in addition to the provider's own deadline. Caller cancellation reaches provider and page-fetch work. One labelled mock fixture with relevant, irrelevant, misleading and tracking-duplicate results achieves Precision@2 = 1.0; that fixed fixture is not a quality estimate for real queries.
4. **Acquisition fairness/analytics:** Cancellable per-host and global gates, request/body/redirect/retry limits and retry-after budgeting are enforced. `/api/acquisition/status` reports requests/completions, HTTP outcomes, retries/timeouts/cancellations/redirects, cache counters/hit rate, extraction outcomes/latency percentiles, throughput, RSS and active/queued work.
5. **Destination security:** IPv4/IPv6 special-use, metadata and credential-bearing URLs are rejected. DNS is verified before fetch and revalidated at the socket lookup to mitigate rebinding; redirect destinations are checked hop-by-hop. TLS verification remains enabled.
6. **Cache isolation:** Acquisition/proxy cache paths honor freshness and validators and reject authenticated/cookie/signed-query, private/no-store, `Set-Cookie` and `Vary` responses. Optional durable cache uses the existing Mongo store and a namespaced/versioned key. Persistence failures fail open.
7. **Extraction/evidence:** Structured metadata, canonical URLs, headings, feeds and JSON-LD are preserved. Empty, low-information, challenge and consent pages are differentiated; challenge/consent text is not passed as answer evidence. AI answers return exact-text passage offsets, source/document IDs, provenance, sentence-level claim/source overlap, evidence-quality basis and conservative conflict caveats. The default unavailable-LLM path is visibly quoted and cited. Source text is explicitly framed as untrusted in LLM prompts.
8. **YouTube and diagnostics:** YouTube resolver returns parsed kind/time/playlist fields and stable error codes and always marks `playbackVerified:false`. A bounded diagnostics CLI separates connectivity/provider-page observations from actual Veyra route behavior and does not bypass challenges.

## Console and source-view follow-up (2026-10-10)

- `/console` now has Overview, Logs and View Source workflows. The overview polls `/api/search/diagnostics` and `/api/acquisition/status` for provider circuit/latency, fetch queues, throughput, cache, extraction and resource information; provider secrets are not exposed. The logs API's existing admin gate remains in force.
- The source viewer reuses the existing `AcquisitionManager`, including public-address/DNS and redirect protections and robots handling. It limits captures to 1 MiB, text media types and a 15-second request timeout, and rejects credential/signature query URLs.
- Source snapshots are temporary in-memory capabilities: five-minute TTL, 100 entries and 8 MiB aggregate maximum. `veyra://view_source/<generated-id>/<base64url-link>` is resolved internally by the browser navigation route. The view is inert text under a restrictive CSP; expiry or token mismatch returns 404. No persistence or new dependency is introduced.
- Proxied pages support `Ctrl+U`/`Cmd+U` for current-page source. Right-click on desktop or a long-press on touch displays a Veyra page-actions menu with selection/link/media actions, source, inspect element, select all, reload, back/forward and print. This page-content menu does not reproduce native browser chrome or the full DevTools UI; inspection reuses Veyra's existing metadata bridge.
- Menu navigation now uses the browser's established `veyra:navigate` message path, and source navigation carries the `veyra://view_source/...` URI rather than the public Render URL. Inspect Element opens a Veyra-rendered detail panel with selector, text, HTML and computed-style views plus copy actions. Both console and source viewer have inline Veyra marks and a verified badge.
- Local route and injected-runtime coverage is in `tests/source-view.test.js`. No live desktop/mobile browser interaction was attempted because Chromium remains disabled by default.

## Existing components reused

`websearch.js`, local `localSearch`, existing neural URL scoring, `AcquisitionManager`, `MongoStore.proxy_cache`, DNS/public-URL checks, AI answer extraction/synthesis, the YouTube parser/oEmbed wrapper, browser opt-in and the existing background scheduler were extended/connected rather than replaced. No dependency was added, and `package-lock.json` is unchanged.

## Changed files

- Source: `src/server.js`, `src/services/console-ui.js`, `src/browser/page-actions-runtime.js`, `src/services/websearch.js`, `src/services/acquisition-manager.js`, `src/services/ai-answer.js`, `src/core/mongo-store.js`, `src/browser/youtube.js`.
- Tests/tools/config: `tests/websearch.test.js`, `tests/acquisition-manager.test.js`, `tests/ai-answer.test.js`, `tests/proxy-rewrite.test.js`, `tests/search-route.test.js`, `tests/source-view.test.js`, `tests/youtube.test.js`, `tests/network-diagnostics.test.js`, `scripts/network-diagnostics.js`, `scripts/bench-search-orchestration.js`, `package.json`.
- Documentation: `README.md`, `CRAWLER_AUDIT.md`, `CRAWLER_TEST_MATRIX.md`, `GOOGLE_DIAGNOSTICS.md`, `YOUTUBE_TEST_REPORT.md`, `NETWORK_DIAGNOSTICS.md`, `REGRESSION_REPORT.md`, `AUDIT_SEARCH_CRAWLER_UPGRADE.md`.

## Verification

- `npm ci --ignore-scripts --no-audit --no-fund`; unchanged baseline `npm test`: PASS after dependencies were installed.
- Final `npm test`: PASS; repository verifier validated 51 JavaScript files, and all auth, answer, neural-crawler, proxy, acquisition, YouTube, web-search, controlled Express-route and network-diagnostic suites passed.
- `npm run test:legacy`: PASS; 27 passed, 0 failed.
- `npm run benchmark:search`: seven mock-only cold-cache comparisons; latest baseline median/p95 183.2/190.4 ms and upgraded 61.6/63 ms with three provider requests and one result in both. This is orchestration-only measurement.
- `git diff --check`: PASS.
- Live `node scripts/network-diagnostics.js --route=direct`: direct IPv4/DNS worked; no IPv6 route; Google HTML returned HTTP 200 with zero parsed result links; Bing returned HTTP 200; DuckDuckGo showed a challenge. No residential classification or CSE API test.
- One final live Veyra route smoke through local Express called `/api/search/web?q=VeyraServer+crawler+search+implementation&engine=bing`: HTTP 200, `provider: bing`, 10 results, route response 2,663 ms and provider latency 2,661 ms. This demonstrates one actual Veyra route call and is not an uptime, relevance or baseline comparison.
- `tests/search-route.test.js`: local controlled Express tests exercised `/api/search/web`, `/api/search/answer` and `/api/youtube/resolve`; no external providers/LLM/Mongo were used in that suite.

## Remaining gaps and known limits

- No multi-run real-network baseline/upgrade benchmark, production-labelled ranking set, sustained throughput/latency benchmark, load/memory stress test or deployed-runtime test. Only the single live Bing route request and deterministic mock benchmark were run.
- No live MongoDB integration; persistent-cache behavior is covered through a deterministic storage adapter. Mongo persistence remains optional.
- A Veyra external provider route was smoke-tested once via Bing HTML, but real API credentials/quotas and provider-backed `/api/search/answer` were not tested. The configured Google CSE API was not configured; Google HTML's zero-link result remains a degraded provider observation.
- Socket-level DNS rebinding defense has deterministic tests for mixed public/private answers and one actual public Bing route exercised the production fetch path; no exhaustive concurrent DNS-rebinding race campaign was run.
- The existing broad background-crawler priority scheduler was retained. Multi-signal ranking now governs answer-search candidate selection, but this task did not replace/retune every queue in the independent background indexing scheduler.
- No real YouTube player playback, transcript/caption, or private/age/region-restricted case was tested; oEmbed is metadata only.
- `neural-search.js` remains disconnected from the live web-search provider path intentionally; there is one active live provider orchestration path.

See `CRAWLER_TEST_MATRIX.md`, `GOOGLE_DIAGNOSTICS.md`, `YOUTUBE_TEST_REPORT.md`, `NETWORK_DIAGNOSTICS.md` and `REGRESSION_REPORT.md` for exact commands and scopes.
