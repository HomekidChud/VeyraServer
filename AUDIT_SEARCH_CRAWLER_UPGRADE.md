# Search and crawler upgrade report

**Target:** `HomekidChud/VeyraServer` on `main`; backup repositories were ignored. **Date:** 2026-10-10.

## Outcome

Implemented code changes in the existing live application. `/api/search/web` retains one bounded concurrent provider orchestration path, now with learned provider ordering, safe health metrics, cooldowns, per-provider/overall deadlines, caller cancellation, and configured early cancellation when enough results are available near the deadline. `/api/search/answer` merges local-index and external results, ranks answer-retrieval candidates using relevance and quality/diversity/cost/freshness signals, reuses acquired text, and enforces a total search-first deadline. The acquisition layer has global/per-host gates, DNS socket-time validation, destination/redirect checks, safe persistent-cache integration and extraction-quality classification/metrics. YouTube resolution explicitly distinguishes metadata from playback. Chromium remains disabled unless explicitly configured and installed in the deployment image.

The answer response includes evidence IDs, exact stored-passage offsets, provider/extraction provenance, claim/source overlap results, conflict caveats, evidence-quality basis, and timing for answer generation and total HTTP route handling. Challenge/consent pages are not used as evidence. Current behavior abstains when grounded paraphrase synthesis is unavailable; a verbatim extractive diagnostic fallback is opt-in with `AI_ANSWER_ALLOW_EXTRACTIVE_FALLBACK=true`. Citation overlap remains a heuristic rather than semantic proof.

## Verification and measured observations

Initial `npm test` could not start because dependencies were absent. `npm ci --ignore-scripts --no-audit --no-fund` installed the existing locked dependencies; the unchanged baseline suite then passed.

The final `npm test` passed source validation (`Validated 51 JavaScript source files`) and the auth, AI-answer/provenance/offline-fallback/prompt-injection, neural-crawler, proxy/cache, acquisition/security/deadline/analytics, YouTube, adaptive web-search, controlled Express-route and network-diagnostic mock suites. `npm run test:legacy` also passed (27 passed, 0 failed). `git diff --check` passed.

`npm run benchmark:search` compared baseline revision `59286f0150ee7532c44cf141ac5703a0aba99c57` with the upgraded orchestrator over seven cold-cache mock runs. Three providers each waited 60 ms; two returned empty responses and Brave returned one result. Latest median/p95-nearest-rank was **183.2/190.4 ms** before and **61.6/63 ms** after. Both made three provider calls and returned one result. This measures orchestration scheduling only, not real-world performance.

`node scripts/network-diagnostics.js --route=direct` made one bounded request per configured endpoint. IPv4 and DNS worked; IPv6 returned `ENETUNREACH`; no proxy or expected egress was configured. Google HTML returned HTTP 200 with zero extracted result links, Bing returned HTTP 200, and DuckDuckGo returned a challenge. Google CSE credentials were absent, so its API was not tested. Connectivity alone does not classify residential IP allocation.

A separate live smoke used the actual local Express `/api/search/web` route with Bing HTML mode and no API key: **HTTP 200**, provider `bing`, **10 results**, **2,663 ms** total route time and **2,661 ms** measured provider latency (a one-sample p50/p95). This is one successful route request, not an uptime, relevance or performance comparison.

## Changed files

Source: `src/server.js`, `src/services/websearch.js`, `src/services/acquisition-manager.js`, `src/services/ai-answer.js`, `src/core/mongo-store.js`, `src/browser/youtube.js`.

Tests/tools/config: `tests/websearch.test.js`, `tests/acquisition-manager.test.js`, `tests/ai-answer.test.js`, `tests/proxy-rewrite.test.js`, `tests/search-route.test.js`, `tests/youtube.test.js`, `tests/network-diagnostics.test.js`, `scripts/network-diagnostics.js`, `scripts/bench-search-orchestration.js`, `package.json`.

Reports/docs: `README.md`, `CRAWLER_AUDIT.md`, `CRAWLER_TEST_MATRIX.md`, `GOOGLE_DIAGNOSTICS.md`, `YOUTUBE_TEST_REPORT.md`, `NETWORK_DIAGNOSTICS.md`, `REGRESSION_REPORT.md`, `AUDIT_SEARCH_CRAWLER_UPGRADE.md`.

No dependency was added; `package-lock.json` is unchanged. No commit, push, PR or deployment was performed.

## Configuration

Existing provider settings remain supported. Web search adds `WEB_SEARCH_DEADLINE_MS` (default 12 seconds), `WEB_SEARCH_EARLY_RESULT_THRESHOLD` (default 20) and `WEB_SEARCH_EARLY_CANCEL_WINDOW_MS` (default 1 second). Acquisition search-first discovery uses `SEARCH_FIRST_DEADLINE_MS` (default 20 seconds). Provider-order, concurrency, timeouts, credentials, cache TTL, and Chromium opt-in are documented in `README.md`. No API secret was added to source or `.env.example`.

## AI copy-paste follow-up (2026-10-10)

The user-reported extractive answer was traced to an always-enabled local fallback combined with a synthesis packet containing only a few ranked sentences per document and a citation gate that rejected paraphrases. The current path passes bounded full extracted page text (up to a 90,000-character aggregate) to the model, asks for a source-grounded original overview, validates claims against full-document sentences, and rejects sentences that are nearly verbatim. Similarity-based source deduplication now compares full page content, preserving pages with complementary details. If synthesis is unavailable or unverified, the endpoint abstains by default; extractive fallback requires explicit diagnostic opt-in.

Current verification after this change: `npm test` passed with 54 JavaScript source files validated; `npm run test:legacy` passed (27 passed, 0 failed); `git diff --check` passed. The suite mocks model calls and proves prompt coverage, paraphrase acceptance, unsupported-claim rejection, source-retention and abstention; it does not constitute a live model quality evaluation.

## Not completed / not verified

There was no multi-run real-network baseline/upgrade latency/throughput/memory benchmark, labelled production ranking evaluation, load/stress run or deployment test. Ranking Precision@2 = 1.0 applies only to a small fixed deterministic fixture. Durable cache behavior was verified with an adapter, not a live MongoDB service. One live Veyra Bing route request succeeded, but API credentials/quotas and an external-provider-backed `/api/search/answer` run were not tested. DNS socket-pinning has deterministic mixed-answer coverage but no exhaustive race campaign.

The existing broad background-indexing crawler scheduler was retained; the added multi-signal ranking is wired into the live answer-candidate retrieval path rather than every background indexing queue. The alternate `neural-search.js` implementation remains outside the single active live-provider path. No live YouTube playback, transcript/caption or restricted-video result was verified; the route reports `playbackVerified: false`.
