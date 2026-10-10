# Regression report

## Baseline

The repository was `HomekidChud/VeyraServer` on `main`; backup repositories were not touched. The initial `npm test` could not load because dependencies were absent (`Cannot find module 'cheerio'`). `npm ci --ignore-scripts --no-audit --no-fund` installed the existing lockfile dependencies; the **unmodified baseline then passed** source validation, auth, AI-answer, neural-crawler, proxy-rewrite, acquisition-manager, YouTube and websearch scripts.

The original working tree was clean. The attached instructions explicitly required preservation of the existing `package-lock.json`; it remains unmodified. No GitHub push, PR or deployment was performed.

## Implemented changes

- `src/services/websearch.js`: bounded/adaptive concurrent providers, per-provider/overall deadlines, cancellation, sufficient-result early cancellation, safe p50/p95 health, circuit cooldowns, Retry-After handling, URL identity and provenance.
- `src/services/acquisition-manager.js`: cancellable per-host/global gates and total search-first deadlines; retry guidance; IPv4/IPv6 special-use/metadata/credential URL defenses and socket-time DNS revalidation; structured extraction/discovery, challenge/consent suppression, multi-signal candidate ranking and request/cache/extraction/resource metrics. `src/server.js`/`src/core/mongo-store.js` reject credential-query, private/no-store, Set-Cookie, Vary and session-specific persistence and version proxy cache keys.
- `src/core/mongo-store.js`: expose persistent-cache expiry, TTL-capped writes and key-specific deletion.
- `src/server.js`: provider deadlines/cancellation into the hardened fetch adapter; socket-level safe lookup; local-index plus external retrieval in `/api/search/answer`; reuse fetched/indexed text; stage/whole-route timings; safe diagnostics/errors; structured YouTube resolver metadata/error fields.
- `src/services/ai-answer.js`: bounded local-text reuse, source/passage IDs, exact-text offsets, per-sentence cited-source maps, conservative conflict warning, and default abstention rather than copied excerpts when model synthesis is unavailable. Claim overlap remains a heuristic, not semantic verification.
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

A final single live Veyra route smoke on `/api/search/web` with Bing HTML mode returned HTTP 200 and 10 results; route time was **2,663 ms**, provider latency **2,661 ms**. A one-page `https://en.wikipedia.org/wiki/Main_Page` crawl through `/api/robots/crawl` (one-page cap; robots respected; Chromium/Mongo disabled) returned HTTP 200 with zero errors: **240 ms** page fetch/parse, **301 ms** total route time, **252,676 bytes**, 79 links and 5,000 extracted text characters. These are single-sample sandbox timings, not a load test or deployed-site response times; see `NETWORK_DIAGNOSTICS.md`.

## Console and source-view follow-up (2026-10-10)

- `/console` now provides Overview, Logs and View Source tabs. Overview includes crawler/index state plus live provider health from `/api/search/diagnostics` and acquisition queue, cache, throughput, extraction and resource metrics from `/api/acquisition/status`. The existing admin authorization on the logs API is unchanged; diagnostics expose health counters, not provider credentials.
- `POST /api/view-source` uses the existing `AcquisitionManager` fetch path and explicit public-address checks. Robots policy, redirect/DNS protections, a 15-second maximum request timeout and 1 MiB response bound apply. Only text document content types are accepted; URLs with credential/signature query parameters are rejected.
- Source snapshots are held in memory for at most five minutes, capped at 100 entries and 8 MiB aggregate. The URI is `veyra://view_source/<144-bit-random-id>/<base64url-link>`; the final segment encodes the normalized source URL. Expired/invalid links return 404. The viewer presents fetched bytes as inert text (never inserts source HTML), emits a restrictive CSP and disables external resources. Browser-session navigation resolves the custom scheme internally with `page.setContent`, not an external network navigation.
- Proxied pages now handle `Ctrl+U` (also `Cmd+U` on Mac) by capturing the current page's raw HTTP source and opening Veyra's source view. Right-click and mobile long-press open a touch-sized page-actions menu with selection/link/media copy/open actions, page source, inspect element, select all, reload, back/forward and print. It is a Veyra page menu, not the browser's native chrome/DevTools menu; inspect uses the existing element metadata bridge.
- Follow-up repair routes menu navigation through the existing Veyra navigation message, emits the source `veyra://` URI directly, implements an in-page Inspect Element details panel, and gives source and console pages Veyra marks/verified badges. Tests assert supported event names, URI dispatch and branded output.
- `tests/source-view.test.js` covers URI validation/tampering, inert `</script>` handling, console/provider diagnostics UI script parsing, private and credential URL rejection, content-type rejection, bounded fetch options, injected keyboard/touch-menu script compilation and local Express routes. No live desktop/mobile browser interaction was run; Chromium remains opt-in. No dependency was added.

## Not verified / remaining limitations

- No multi-run real-network baseline-vs-upgrade search/crawl benchmark, labelled ranking evaluation, throughput/latency comparison, memory stress run or deployment test; the one Bing request and one Wikipedia page crawl are smoke checks only, alongside the mock orchestration microbenchmark above.
- No live MongoDB integration test; persistent-cache survival was tested through a deterministic storage adapter. Persistence remains optional.
- Only one live Veyra Bing HTML search route request and one public Wikipedia page crawl were run; no provider API credential/quota check, external-provider-backed answer route or multi-page site crawl was performed.
- DNS pinning and mixed public/private socket-answer tests passed; no exhaustive concurrent DNS-rebinding race campaign was conducted.
- No real YouTube playback, transcript, caption or private/age/region-restricted playback validation. oEmbed remains metadata/embeddability only.
- `src/services/neural-search.js` remains a separate implementation; the production answer path now combines the existing local Veyra index with the one live `websearch.js` orchestration path rather than importing the duplicate implementation.

## Follow-up repair: source navigation, DevTools and answer consistency (2026-10-10)

- View Page Source now captures the current proxied URL and POSTs the resulting `veyra://view_source/...` URI directly to the active browser-session navigation endpoint. The session's canonical/display URL remains the custom URI; the UI no longer depends on a host shell to interpret a repeated URL or send the user to a Render hostname.
- Inspect Element now opens the existing Developer Tools interface through Veyra's Ctrl+Shift+I shortcut bridge. When invoked on a page element, the bridge resolves the target at the context-menu pointer location, calls the existing DOM select/highlight methods, and emits the normal `dom.select` event. Invoked without a page target, it opens DevTools without a selection. The prior in-page details popup is removed.
- AI answer output is normalized to a consistent single plain-text paragraph (no headings, Markdown emphasis, bullets or numbering) while preserving source citations. The extractive diagnostic fallback is opt-in; it is not the default answer path.
- The lightweight, locally trainable neural URL relevance ranker now uses AdamW with persisted first/second moments and decoupled weight decay. Checkpoint version 2 stores optimizer state; version 1 checkpoints still load. This is not fine-tuning of the hosted generative model: Veyra's answer LLM remains an inference API, and its weights are not available to this repository's trainer.
- Focused source-view, answer-format and AdamW convergence/restore tests passed. Full current and legacy suites plus `git diff --check` are run before the follow-up is pushed. Live browser-UI interaction and production answer-quality evaluation remain unverified; Chromium stays opt-in.

## Follow-up: full-document paraphrase and copy-paste regression (2026-10-10)

- Root cause: answer synthesis was given only up to five ranked sentences per source; a strict 60% lexical overlap verifier rejected valid rewordings; the always-on local fallback then returned the selected source sentences verbatim. A duplicate check based only on the lead sentence also discarded pages with complementary details.
- Synthesis now receives a bounded aggregate (up to 90,000 characters) of full extracted page text, proportionally divided across selected sources, plus ranked evidence passages. Exploratory queries receive a longer 120-220-word overview. The prompt requires original phrasing, synthesis across documents, and citations on factual claims.
- Claim checks now compare against relevant sentences across the full extracted text with multi-anchor overlap thresholds; near-duplicate detection compares documents instead of only their top sentence. Exact/near-verbatim answer sentences are rejected.
- Verbatim fallback is disabled by default. When an original paraphrase cannot be grounded or the model is unavailable, the endpoint returns a no-answer reason rather than disguising a copy of the page as Veyra AI. An explicitly enabled diagnostic fallback remains available through `AI_ANSWER_ALLOW_EXTRACTIVE_FALLBACK=true`.
- Regression coverage asserts full-document context reaches the model, a grounded paraphrase is accepted, unsupported claims are rejected, fallback abstains by default, and complementary same-topic sources are retained.

See `AUDIT_SEARCH_CRAWLER_UPGRADE.md`, `CRAWLER_AUDIT.md`, `CRAWLER_TEST_MATRIX.md`, `GOOGLE_DIAGNOSTICS.md`, `YOUTUBE_TEST_REPORT.md` and `NETWORK_DIAGNOSTICS.md` for scope and details.


## Follow-up: live source-view routing, AI readiness, 20-result search and safe indexing (2026-10-10)

- Fixed View Source to navigate through the active fast-proxy browser event to Veyra's same-origin inert source document, preserving the `veyra://view_source/...` address as the visible title. The old Chromium-only route is not used. The viewer CSP now permits only the configured frontend origin(s) as frame ancestors while keeping scripts, network connections, images and plugins restricted.
- The console now reports AI-answer readiness and model name without exposing API keys. AI requests use the official OpenAI API base by default when `OPENAI_API_KEY` is present; Render declares the key as an optional unsynced secret. No key was available/added by this code change, so production AI remains dependent on Render secret configuration.
- Bing HTML retrieval paginates two ten-result pages for a 20-result request; API-key retrieval receives the requested count. The web endpoint and local index endpoint default to 20, with configurable server cap. Search-to-answer retains all discovered external results separately from the at-most-eight pages fetched for grounding.
- Relevant external search candidates are scheduled for bounded background indexing. Neural crawler workers now fail closed without an injected safe fetcher; production wires them through AcquisitionManager, which validates DNS/IP at socket connection, rechecks redirects and enforces robots/body/concurrency controls.
- Verification: full `npm test`, `npm run test:legacy`, and `git diff --check` passed. Focused tests include offline two-page Bing HTML fixtures, API-base readiness, source-view CSP, 20-result propagation, separate search-results payload, indexing queue scheduling, robots rules and fail-closed crawler fetching. No production deployment is claimed by these local results.
