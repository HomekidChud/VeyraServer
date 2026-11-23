# Crawler and search regression matrix

**Repository:** `HomekidChud/VeyraServer` on `main`; backup repositories were not touched. `package-lock.json` is unchanged.

**Baseline:** Initial `npm test` could not start because dependencies were absent (`Cannot find module 'cheerio'`). After `npm ci --ignore-scripts --no-audit --no-fund`, the unchanged baseline suite passed.

**Final deterministic command:** `npm test` (source validation, auth, AI answer/provenance, neural crawler, proxy/cache policy, acquisition manager, YouTube, live web-search orchestration mocks, Express route integration and network-diagnostics mocks).

**Additional checks:** `npm run test:legacy`; `npm run benchmark:search`; `git diff --check`; `node scripts/network-diagnostics.js --route=direct`; one actual local Veyra `/api/search/web` request using Bing HTML mode with no API key.

| Area | Expected | Actual result | Status / diagnostic |
|---|---|---|---|
| Source validation | All tracked/source files pass the repository verifier | `Validated 51 JavaScript source files` | PASS (`npm test`) |
| Existing regressions | Existing auth, neural-crawler, proxy and compatibility tests stay green | All included tests passed; legacy suite reported 27 passed, 0 failed | PASS |
| Optional credentials | Missing Google/Brave API credentials skip only those providers | `not-configured`; other eligible providers continue; no fabricated results | PASS (mock) |
| Google diagnostics | Distinguish configuration, response/challenge classes and extraction outcome | Typed classifier covers challenge, consent, forbidden, rate-limit, HTTP, timeout, DNS/TLS, malformed and empty; no Google CSE key was configured | PASS (mock); CSE API unverified |
| Bounded parallel providers | Per-provider and overall deadlines; bounded concurrency; partial results | Parallel overlap, caller cancellation, overall timeout, p50/p95 and total/first-result latency assertions pass | PASS (mock) |
| Adaptive provider health | Learned ordering, safe success/latency metrics, cooldown and Retry-After | Learned order, circuit suppression, explicit Retry-After and bounded percentile diagnostics pass | PASS (mock) |
| Deadline-aware early cancellation | Cancel slower peers only when configured sufficiency threshold is met near deadline; do not count it as provider failure | Controlled useful-result fixture cancels slow peer and reports no provider failure | PASS (mock) |
| Search normalization/provenance | Remove only safe tracking keys; preserve meaningful URL identity and provider attribution | Tracking duplicates collapse; case-sensitive paths, trailing slashes and content parameters remain distinct; credential URLs rejected | PASS (mock) |
| Candidate ranking | Rank relevance, freshness/cost/source-quality/novelty/duplicate-risk signals and retain domain diversity | Fixed labelled fixture includes relevant, irrelevant, misleading and tracking-duplicate rows; Precision@2 = 1.0 on that fixture; only selected candidates are fetched | PASS (mock); not a production-quality estimate |
| Search-first retrieval budget | Bound end-to-end provider-plus-fetch time; honor caller cancellation | 300 ms test budget aborts stalled page acquisition; timing and timeout fields reported | PASS (mock) |
| Robots and discovery | Respect robots; bounded sitemap/index/feed discovery | Disallowed pages never fetch; sitemap index/nested map and RSS/Atom fixtures parse | PASS (mock); no real-site crawl claimed |
| Extraction quality | Distinguish useful, low-information, empty, challenge and consent content | Structured metadata/headings retained; challenge/consent text withheld; extraction counters and p50/p95 timing asserted | PASS (mock) |
| Cache correctness | Respect freshness, validators and private/no-store/auth/cookie/signed-query/Set-Cookie/Vary exclusions | Memory and persistent-adapter tests pass; cache hit/TTL/invalidation policy covered; proxy cache key version advanced | PASS (mock); no live MongoDB integration |
| SSRF and socket DNS | Validate redirects and pin socket-time resolution to public IPs; reject reserved/private destinations | IPv4/IPv6/reserved/mapped/cloud metadata cases and mixed public/private socket lookup pass | PASS (mock); not an exhaustive race campaign |
| Resource limits/analytics | Bound per-host/global work, bytes, retries and report actual metrics | Size, global-concurrency, retry-after, cancellation, requests/completions, HTTP outcomes, extraction, memory RSS and throughput fields tested | PASS (mock) |
| AI-answer grounding | Claims map to cited passages; preserve source IDs/provenance; no unsupported claim leakage | Exact passage offsets, citation verification, conflict/quality fields and offline quoted fallback pass | PASS (mock) |
| Prompt injection | Crawled text is evidence, never instructions | Hostile source passage is passed only within a prompt whose system instruction explicitly treats source text as untrusted; answer still passes claim checks | PASS (mock LLM; no external call) |
| Local answer route | Actual Express route reuses indexed text without unnecessary external fetch | `/api/search/answer` returned grounded local-index citations; providers, LLM and DB writes disabled | PASS (local HTTP integration) |
| Web-search route (mock) | Route response contract and provider provenance are wired | `/api/search/web` exercised through Express with a controlled provider seam | PASS (local HTTP integration) |
| Web-search route (live smoke) | Verify actual Veyra route reaches a provider and returns real results | Final bounded request: HTTP 200, provider `bing`, 10 results, route response 2,663 ms, provider latency 2,661 ms; one-sample p50/p95 both 2,661 ms | PASS for this smoke only; not uptime/quality/performance proof |
| Large-site crawler smoke | Exercise Veyra's actual crawler on a large public site with minimal load | Wikipedia Main Page, one page, robots checked, HTTP 200, page latency 240 ms, route wall time 301 ms, 252,676 bytes, 79 links, zero errors | PASS (single live page; no multi-page/stress claim) |
| Network diagnostic endpoints | Separate IP/DNS/TLS/provider endpoint observations from Veyra behavior | Direct IPv4/DNS worked; no IPv6 route; Google HTML HTTP 200 but 0 extracted links; Bing HTTP 200; DuckDuckGo challenge | PASS for diagnostic execution; see `NETWORK_DIAGNOSTICS.md` |
| YouTube parser and route | Test common video/Shorts URLs and distinguish metadata from playback | Watch, Shorts, live, embed, short-link, mobile, time/playlist and hostile inputs pass; mocked `/api/youtube/resolve` success and disabled-embed routes pass | PASS (mock/local HTTP integration) |
| Browser opt-in | Ordinary routes must not install/launch Chromium when disabled | `BrowserEngine.ensureBrowser()` rejects when disabled; startup checker only tests executable presence and never installs; route test asserts `CFG.browserEnabled === false` | PASS (code path + test) |
| YouTube playback/transcripts | Do not describe metadata as playback/transcript verification | `playbackVerified:false`; no live player, transcript, caption, private, age- or region-restricted playback test | NOT TESTED (accurately scoped) |
| Real-world performance/stress | Compare real network before/after latency, throughput, memory and ranking | One live Bing route response and one single-page Wikipedia crawl were measured; no multi-run live baseline, load/stress, RSS-under-load or production corpus evaluation | NOT TESTED beyond two single-sample smoke checks |
| Persistent DB/deployment | Validate against live Mongo and deployed runtime | Deterministic durable-cache adapter only; no live Mongo or deployment run | NOT TESTED |

**Mock benchmark:** `npm run benchmark:search` runs seven cold-cache comparisons against baseline revision `59286f0150ee7532c44cf141ac5703a0aba99c57`, with three mock providers each delayed 60 ms. Latest output: baseline median/p95-nearest-rank **183.2/190.4 ms**; upgraded **61.6/63 ms**; both made three requests and returned one result. This is a deterministic orchestration measurement, not real network performance.

Mocks establish only the behavior exercised by those fixtures; they do not prove third-party uptime, production relevance, quotas, deployment stability, live Mongo persistence or video playback.
