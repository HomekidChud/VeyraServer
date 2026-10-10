# Regression report

## Baseline

The repository was `HomekidChud/VeyraServer` on `main`; backup repositories were not touched. The initial `npm test` could not load because dependencies were absent (`Cannot find module 'cheerio'`). `npm ci --ignore-scripts --no-audit --no-fund` installed the existing lockfile dependencies; the **unmodified baseline then passed** source validation, auth, AI-answer, neural-crawler, proxy-rewrite, acquisition-manager, YouTube and websearch scripts.

The original working tree was clean. The attached instructions explicitly required preservation of the existing `package-lock.json`; it remains unmodified. No GitHub push, PR or deployment was performed.

## Implemented changes

- `src/services/websearch.js`: bounded/adaptive concurrent providers, per-provider/overall deadlines, cancellation, sufficient-result early cancellation, safe p50/p95 health, circuit cooldowns, Retry-After handling, URL identity and provenance.
- `src/services/acquisition-manager.js`: cancellable per-host/global gates and total search-first deadlines; retry guidance; IPv4/IPv6 special-use/metadata/credential URL defenses and socket-time DNS revalidation; structured extraction/discovery, challenge/consent suppression, multi-signal candidate ranking and request/cache/extraction/resource metrics. `src/server.js`/`src/core/mongo-store.js` reject credential-query, private/no-store, Set-Cookie, Vary and session-specific persistence and version proxy cache keys.
- `src/core/mongo-store.js`: expose persistent-cache expiry, TTL-capped writes and key-specific deletion.
- `src/server.js`: provider deadlines/cancellation into the hardened fetch adapter; socket-level safe lookup; local-index plus external retrieval in `/api/search/answer`; reuse fetched/indexed text; stage/whole-route timings; safe diagnostics/errors; structured YouTube resolver metadata/error fields.
- `src/services/ai-answer.js`: bounded local-text reuse, source/passage IDs, exact-text offsets, per-sentence cited-source maps, conservative conflict warning, and clearly quoted extractive fallback if the LLM is unavailable. Claim overlap remains a heuristic, not semantic verification.
- `src/browser/youtube.js`, focused tests, `tests/search-route.test.js` (controlled local Express coverage for `/api/search/web`, `/api/search/answer` and `/api/youtube/resolve`), `scripts/network-diagnostics.js`, `scripts/bench-search-orchestration.js`, `README.md`, and the requested reports were updated. `package.json` adds test/diagnostics/benchmark scripts; no dependency was added.

## Verification

Commands run:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
node scripts/network-diagnostics.js --route=direct
npm run benchmark:search
npm run test:legacy
VEYRA_CHROMIUM_ENABLED=false npm run prestart
```

The final `npm test` run completed all scripts successfully: source verifier reported `Validated 51 JavaScript source files`; auth, AI answer/provenance/offline fallback/prompt-injection, neural crawler, proxy rewrite/cache policy, acquisition/discovery/cache/security/deadline/analytics, YouTube, adaptive websearch, local Express route integration and network-diagnostic mock tests passed. `npm run test:legacy` passed with 27 passed, 0 failed. `VEYRA_CHROMIUM_ENABLED=false npm run prestart` exited 0 and warned that Chromium was missing; the checker did not install or launch it. `git diff --check` passed.

The live diagnostic command made one bounded request per endpoint; see `NETWORK_DIAGNOSTICS.md` for exact results. It confirmed direct IPv4, DNS and some HTTP reachability, found no IPv6 route, did not configure a proxy, observed Google HTML HTTP 200 but extracted zero result links, Bing HTTP 200, and a DuckDuckGo challenge. It did **not** call the configured Veyra Google CSE API (not configured) or establish residential IP classification.

`npm run benchmark:search` compared the original Git revision (`59286f0150ee7532c44cf141ac5703a0aba99c57`) with the upgraded orchestrator over seven cold-cache runs. Three mocked providers each waited 60 ms; the first two returned empty responses and Brave returned one result. Both versions made 3 requests and returned 1 result. Latest baseline median/p95-nearest-rank: **183.2/190.4 ms**. Upgraded: **61.6/63 ms**. This reproducible mock-only measurement demonstrates orchestration scheduling behavior; it is not real-network latency or production throughput.

A final single live Veyra route smoke on `/api/search/web` with Bing HTML mode returned HTTP 200 and 10 results; route time was **2,663 ms**, provider latency **2,661 ms**. This is one request, not an uptime or real performance benchmark; see `NETWORK_DIAGNOSTICS.md`.

## Not verified / remaining limitations

- No real-network baseline-vs-upgrade search/crawl benchmark, labelled ranking evaluation, throughput/latency comparison, memory stress run or deployment test; only the mock orchestration microbenchmark above was run.
- No live MongoDB integration test; persistent-cache survival was tested through a deterministic storage adapter. Persistence remains optional.
- Only one live Veyra Bing HTML search route request was run; no provider API credentials/quota check, external-provider-backed answer route or public-site crawl beyond the bounded diagnostics and this one search call was performed.
- DNS pinning and mixed public/private socket-answer tests passed; no exhaustive concurrent DNS-rebinding race campaign was conducted.
- No real YouTube playback, transcript, caption or private/age/region-restricted playback validation. oEmbed remains metadata/embeddability only.
- `src/services/neural-search.js` remains a separate implementation; the production answer path now combines the existing local Veyra index with the one live `websearch.js` orchestration path rather than importing the duplicate implementation.

See `AUDIT_SEARCH_CRAWLER_UPGRADE.md`, `CRAWLER_AUDIT.md`, `CRAWLER_TEST_MATRIX.md`, `GOOGLE_DIAGNOSTICS.md`, `YOUTUBE_TEST_REPORT.md` and `NETWORK_DIAGNOSTICS.md` for scope and details.
