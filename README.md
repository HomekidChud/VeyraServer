
## Cross-site handoff (direct sign-in, every site)

When a site's own security check blocks the fast proxy, Veyra hands the page to the user's real browser instead of launching Chromium:

- `GET /api/handoff/login?url=…&sid=…` returns the real-site destination. The popup opens the site **directly** — it never navigates through the API origin, so a blocked or asleep server can't break the handoff. With `Accept: application/json` it responds `{ok, dest}` (the frontend uses this to open the site straight away); a plain navigation still gets a 302. Auth-style pages on known sites (chess.com `returnUrl`, github.com `return_to`, gitlab.com `return_to`) carry a return trip equal to the target page itself, so the site's own login flow lands the user on the exact page they wanted; every other page hands off the exact page as-is, so the flow covers anything a site asks — sign-in, verification, consent, age gates — not just logins.
- **Auto-return**: while a handoff popup is open, the app polls its session's cookie jar for that host. The moment the user's session arrives (the "Bring session back" bookmarklet, the paste form, any import), the challenged tab reloads through the fast proxy — signed in. The bookmarklet also closes the popup itself, so the whole return is one click on the site.
- The challenge interstitial offers a draggable **“Bring session back”** bookmarklet. Clicked on the real site once the user is done, it posts that site's readable cookies to `POST /api/handoff/cookies` (CORS-open, works from any origin) and imports them, with the user's user-agent, into the session jar. HttpOnly cookies can't be read by the bookmarklet; the manual paste form stays for those.
- The frontend also exposes “Sign in on the real site” in the site-info pop for any page, not just challenge screens.

Tests: `node tests/handoff.test.js`.

## Keep-alive

Render can spin down idle services on its free tier. The keep-alive workflow schedules `/health` pings, but a ping is not a substitute for client recovery. The Browser probes `/api/health` when a recoverable connection error interrupts search or session creation, waits for a successful JSON response, then retries. A host-branded HTML page does not establish readiness. If the service is suspended, check its status in the Render dashboard.

The API health routes return JSON and are not the Browser UI. Top-level visits to `/search?q=...` (or `/browse?q=...`) on the API host redirect to the configured `VEYRA_FRONTEND_URL`; search fetches stay on `/api/search/*`. When configuring `FRONTEND_ORIGIN` explicitly, include the web app origin and `https://localhost` for the bundled Android app.

## Acquisition defaults

Veyra uses the shared `AcquisitionManager` for bounded direct HTTP retrieval, conditional validators, response caching, robots policy, search-first discovery, structured document parsing, and sitemap discovery. Chromium is retained for browser sessions but is **disabled by default**:

```bash
VEYRA_CHROMIUM_ENABLED=false
```

Set `VEYRA_CHROMIUM_ENABLED=true` only when browser rendering is explicitly required and Chromium is installed in the runtime image. The normal crawler, search, and answer paths do not launch or download Chromium. Operational status is available at `GET /api/acquisition/status`.

Acquisition is bounded by per-host/global concurrency and the `SEARCH_FIRST_DEADLINE_MS` budget (default 20 seconds, bounded to 250–120000 ms). `GET /api/acquisition/status` reports active/queued work and limits, HTTP outcomes/retries/timeouts/cancellations, cache hit rate, extraction outcomes and p50/p95 extraction latency, request throughput and RSS memory. DNS results are rechecked at socket lookup time and private/reserved addresses are rejected, including when a hostname changes between validation and connection. Retry waits are cancellable; a `Retry-After` value longer than the short per-request retry budget is honored by declining to retry rather than ignoring the server's guidance. Challenge/consent/empty pages are classified and withheld as answer evidence.

When Mongo persistence is enabled, the acquisition manager can reuse public text responses across restarts. The durable cache uses an acquisition-specific key namespace in the existing proxy-cache store; it honors the smaller of upstream freshness (`max-age`) and configured cache TTL. Authenticated/cookie-bearing requests, signed/token credential query URLs, `private`, `no-store`, any `Vary` response, and `Set-Cookie` responses are never shared. The proxy cache also uses a new key version so earlier cache entries are not re-used after the stricter policy change. Mongo persistence is optional and a cache outage does not stop direct retrieval.

## Search-to-answer retrieval

`POST /api/search/answer` combines results from the existing local Veyra index with pages retrieved by the same bounded external web-search service used by `/api/search/web`. External candidates are ranked before fetch using query/title/snippet relevance, domain diversity, freshness when the query is time-sensitive, URL/fetch cost, and optional prior extraction/source quality, retry, novelty and duplicate-risk signals. Canonical URLs are merged with provider provenance retained, and already retrieved/local-index text is reused rather than fetched a second time. Evidence records include exact-text passage offsets, content hashes, extraction status, timestamps and per-sentence claim/source mappings. Synthesis receives bounded full-page extracted text (not only search snippets), rewrites it into a cited overview, and checks claims against the cited documents. If model synthesis fails or a paraphrase cannot be grounded, the default behavior abstains rather than presenting copied excerpts as an AI answer. The extractive diagnostic fallback is opt-in with `AI_ANSWER_ALLOW_EXTRACTIVE_FALLBACK=true`. Citation overlap is a safety heuristic, not semantic proof or a calibrated confidence score.

For supported model endpoints, where to create provider keys, and how to configure a custom API protocol, see [`docs/AI_PROVIDER_SETUP.md`](docs/AI_PROVIDER_SETUP.md). The integration accepts OpenAI-compatible endpoints and custom HTTP JSON request/response templates. For Groq, set only `GROQ_API_KEY`; Veyra detects Groq and chooses an active chat model automatically.

### Search categories and summaries

`GET /api/search/vertical?q=...&type=images|videos|news|shopping|research|discussions` returns attributed results. `type=images&preview=1` returns up to six thumbnail-bearing first-page results with no continuation. It does not contact image providers if `incognito=1`. `type=all` remains available for older clients and returns up to three preview cards per category. Continue a full category using `nextPage` and `nextProvider` (or `provider` when `nextProvider` is absent). Pagination stops when the provider or configured safety limit is exhausted. Empty results and unavailable providers are separate states. Guest and private requests bypass the shared result cache. Searches are still sent to the upstream providers used for the selected category.

- **Images:** The dedicated feed blends Wikimedia Commons, Brave when configured and supported, and images from public reference pages. For example `Python asyncio` can surface an attributed Qt for Python coroutine diagram; images stay scoped to the publisher's source page. The feed deduplicates by image URL. The neural crawler picks up responsive and lazy-loaded images, structured article data, Open Graph images, and captions without fetching the image files as crawl work. Inline thumbnails use a narrower allowlist and never autoload in incognito.
- **Video and news:** Videos includes a small collection of public, oEmbed-verified YouTube watch URLs for tap repairs, dosa, and Python asyncio. This is not unrestricted YouTube search. `BRAVE_SEARCH_API_KEY` enables Brave where the API plan supports the category. Other adapters include PeerTube via Sepia Search and Google News RSS. The optional YouTube Data API fallback is enabled with `VEYRA_YOUTUBE_SEARCH=1` and `YOUTUBE_DATA_API_KEY` and is skipped for mixed previews.
- **Shopping:** Set `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` for eBay Browse API listings (default `VEYRA_EBAY_MARKET=GB`). Without these, configured web providers may surface supported merchant product URLs, but Veyra cannot verify prices, inventory, or coverage. Never add provider keys to frontend code.
- **Research and discussions:** Crossref indexes papers and DOI links; Hacker News supplies community threads. The result labels describe these scopes, not the entire research or discussion web.
- **AI:** Signed-in `POST /api/search/answer` accepts an optional `vertical` category. It rediscovers category URLs server-side and checks summaries against readable pages. Web clients can provide URL hints, but not evidence text. Depth depends on the question and available evidence. If most claims pass and at least two are supported, an otherwise useful draft may be returned without the rejected claims. If there is too little usable evidence, it abstains. Category queries and summaries are not added to the answer-observation store. Optional signed-in helpfulness feedback updates the existing answer-quality scorer from numeric features, not the generative model.
- **Ranking:** `npm run train:vertical-ranker` writes the checked-in category model; `npm run evaluate:vertical-ranker` reports its held-out comparison with provider order. The 24 training and 12 test pairs are hand-written interaction-free fixtures covering the six categories. The test checks the training pipeline, not live search quality. It does not use scraped provider content, queries, or browsing logs, and it does not fine-tune the generative model.

For rollout, deploy this backend first; smoke-test `/health`, `/api/search/web`, one request per category, and the signed-in category answer in staging before deploying the browser client. No database migration is required.

## India search and multilingual discovery

The default `GET /api/search/web?feed=1` search can include paginated Wikipedia article links alongside the other providers. It uses the MediaWiki search API in the detected supported language, respects `site:` scope, and leaves explicit engine selections and category discovery unchanged.

Send `region=IN` to `/api/search/web`, `/api/search/vertical` or `/api/search` to request India-first results. Supported providers receive their India market parameter, with an India relevance boost for local and global result feeds. Crossref, Wikimedia Commons, PeerTube and Hacker News remain global. Requests without the region parameter retain the previous behavior; cached results are separated by region.

In India mode, Shopping first checks a small merchant allowlist (boAt, Headphone Zone, Portronics and Amkette) using the [Shopify Predictive Search API](https://shopify.dev/docs/api/ajax/reference/predictive-search), subject to each merchant's robots rules. Matches must be reported in stock and link to direct product pages. The storefront price is shown only if the merchant's product metadata confirms the same INR amount; missing or inconsistent prices are left blank. Incognito skips the storefront feed. If no listings match, the index and web-discovery fallbacks still apply. This is not a market-wide comparison, and stock and prices should be confirmed with the merchant.

The old `/api/search/deep` route returns `410 Gone`; the Crossref Research category and opt-in summaries are separate and remain available.

Web clients can send `feed=1` and follow `nextOffset` to page through supported external providers and then matching crawler-index documents. Images mixes provider and approved crawler results before continuing through Wikimedia when it has more. Videos can continue into indexed YouTube and Vimeo watch pages. Feeds stop when sources run out or reach their provider limits. Guest and private searches do not queue persistent index crawls. Incognito also skips the live source checks described below. Signed-in search discovery uses the existing index crawler budget and robots rules; loading another batch does not start a new Web crawl.

### Direct source search and evidence

Automatic Web search runs a first-page Fast Proxy lane alongside existing discovery providers. It picks up to six topic- or scope-matched public reference publishers from a maintained catalog and can follow one relevant same-origin link per publisher. It can also read up to six distinct publishers behind normal results to replace search-engine snippets with matching passages from the pages themselves. This provides an independent discovery path where the catalog or crawler index covers the query, not a complete index of the web. If the fast checks time out or are declined, provider links and indexed links still work.

The first automatic page also merges up to three checked-in public reference links matched by keywords, with or without `site:`. For `Python asyncio`, this can produce verified publisher evidence in regular Web search and working links even if general providers are empty in incognito. Catalog-only links contain no excerpt and do not imply a live check. Lookup is read-only, does not contact publishers or write query data, and honors both `site:` and `-site:`.

The `result.evidence` scale is separate from query match. `strong` means a relevant passage was read from a catalog source over HTTPS. `moderate` means a relevant passage was read from another live page. `limited` denotes a previously indexed copy or a readable live page without a matching passage. `unverified` means the page was not checked, was unavailable, or opted out. The scale reports what Veyra could read, not the factual accuracy of a publisher or whether multiple publishers agree.

The lane has separate 2.3-second discovery and 1.6-second evidence deadlines; it skips later pages, explicit engines and incognito. It does not forward raw search queries, cookies, sign-in tokens or referrers to the pages it reads. It honors robots rules, crawl delay, publisher snippet opt-outs and verification challenges without retrying or bypassing them. No documents or user queries are written by this live pass. Set `VEYRA_SOURCE_SEARCH=false` to turn it off.

The cooperative crawler uses XML sitemap structure to distinguish indexes from pages, including extensionless nested sitemap URLs. It follows published [localized sitemap alternates](https://support.google.com/webmasters/answer/189077?hl=en) and HTML `hreflang` links only within the existing crawl scope, subject to robots, challenge and size limits. New pages use Unicode normalization and [word segmentation](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter) where spaces alone are insufficient. Existing index records remain readable; updated tokenization applies when pages are reindexed.

## Google search

Fast Proxy opens the public Google homepage and passes through usable Google results pages. If Google shows a CAPTCHA or a recognized search interstitial instead, the proxy card offers **Search with Veyra** with the same query or a direct-open option. Veyra does not bypass Google's checks.

`GET /api/search/web?q=search:google.com` puts Google's official homepage first. `q=search:google.com <terms>` (or `q=<terms>&prefer=google`) prioritizes Google when configured and falls back to ordinary Veyra sources when it cannot return results. Check `googleIncluded` and the per-result attribution before labeling results as Google. Explicit `engine=google` remains Google-only and reports `not-configured` when no credentials are available.

Existing [Google Custom Search JSON API](https://developers.google.com/custom-search/v1/overview) customers can configure `GOOGLE_SEARCH_API_KEY` and `GOOGLE_SEARCH_CX` as server secrets. The API is closed to new customers and existing users must transition by January 1, 2027; do not make it a prerequisite for Veyra Web search. For a coordinated deployment, release this server before the updated VeyraBrowser client.

## Live web-search provider behavior

`GET /api/search/web` uses the bounded outbound fetch path. Automatic Web search tries up to six general providers by default (`WEB_SEARCH_MAX_PROVIDERS`, range 1–9), plus matching specialty sources, with up to six simultaneous provider tasks by default (`WEB_SEARCH_CONCURRENCY`, range 1–8). `WEB_SEARCH_ORDER` sets general-provider priority, and health observations adjust order within the selected set. Provider calls have an 8-second default timeout (`WEB_SEARCH_PROVIDER_TIMEOUT_MS`), shorter for the new public APIs, with a 12-second overall deadline (`WEB_SEARCH_DEADLINE_MS`). Near the deadline, `WEB_SEARCH_EARLY_CANCEL_WINDOW_MS` (default 1000 ms) and `WEB_SEARCH_EARLY_RESULT_THRESHOLD` (default 40 unique candidates) can end a request early. Failures back off without bypassing CAPTCHAs or retrying blocked engines. The route deduplicates URLs, retains provider provenance, ranks by relevance, and keeps `site:` and `-site:` constraints on returned links. Explicitly selecting a general engine does not silently fan out to others.

- **Native website search:** Matching Web queries can reach MDN, GitHub public repositories, npm, crates.io, Open Library, Wikivoyage, Wiktionary and Wikibooks through fixed public endpoints. Route selection uses topic or an explicit matching `site:` scope, capped at three of these new native sources per request. Wikipedia and Stack Overflow remain available through the existing topic lanes. Queries never set an adapter's upstream origin. An unrecognized `site:` still searches the existing general engines and index, not the target site's forms or private API.
- **Categories:** Research combines Crossref and Europe PMC on the first page, with DOI deduplication. Discussions can combine Hacker News with one relevant Stack Exchange community, including cooking, DIY, travel and mathematics. Space image queries can pull from NASA's Image and Video Library and Wikimedia Commons. Scoped searches only keep matching destination hosts. Existing video and shopping Web discovery can benefit from configured general engines without relaxing watch-page and product validation.
- **Optional metasearch:** Set `VEYRA_SEARXNG_ORIGIN` to an administrator-controlled public HTTPS origin with `/search` JSON enabled, and optionally set `VEYRA_SEARXNG_ENGINES` to a comma-separated list of permitted engines on that instance. Include `searxng` in `WEB_SEARCH_ORDER` if overriding the default. No public community instance is used by default. SearXNG receives the search query, so review its upstream engine policies before enabling it. See the [SearXNG Search API](https://docs.searxng.org/dev/search_api). Existing Brave and Google integrations still require their configured credentials.
- **Pagination and privacy:** Engines that support offset/page-based pagination can contribute beyond the first batch; integrations without compatible continuation (including crates.io and Europe PMC) contribute their first page only. The feed is finite and falls back to the local index when available. Incognito skips the newly added native search lanes and optional SearXNG; it does not disable the existing general Web search providers.

## Diagnostics and tests

For a recent end-to-end GeoFS debugging session (Cesium base-URL and terrain-tile 404s through the proxy) see
[`docs/GEOFS_DEBUG_REPORT.md`](docs/GEOFS_DEBUG_REPORT.md).

Run `npm test` for deterministic regressions, including controlled local Express tests for `/api/search/web`, `/api/search/answer`, and `/api/youtube/resolve`, with external providers, LLM calls, Chromium and Mongo writes disabled. Tests include prompt-injection-in-source coverage and deadline-aware early cancellation. The ranker fixture contains relevant, irrelevant, duplicate and misleading-snippet cases and reports Precision@2 for that fixed fixture only—not production quality. `npm run benchmark:search` compares baseline versus upgraded orchestration using a fixed mock provider delay; it measures scheduling behavior only, not real network speed. `npm run diagnostics:network -- --route=direct` makes one bounded request to each configured public diagnostic endpoint (IPv4/IPv6 address services, Google/Bing/DuckDuckGo) and prints DNS, TLS/HTTP, parsing and block classifications; it does **not** classify the egress as residential. Use `--route=proxy` only when an authorized proxy is configured. The command does not retry or bypass challenges. No diagnostic command writes cookies or authorization headers to its report.

### Relevance model training

- `npm run evaluate:neural` trains a fresh model in memory on 160 synthetic examples across 20 topics and evaluates 48 examples from six held-out topics. It performs no networking or writes, and does not load or update an existing checkpoint. The results test the training path and are not evidence of better live search.
- `NEURAL_PUBLIC_CRAWL_TRAINING` is off by default. Set `NEURAL_PUBLIC_CRAWL_TRAINING=true` in staging to learn from existing crawls on allowlisted public documentation and information routes. No requests are added: fresh, substantial documents are weak positive labels; direct `404` and `410` responses are weak negative labels. Responses served from cache, redirects, private/cache-restricted pages, sign-in and challenge pages, opt-out metadata, unverified robots policy, and transient failures are excluded. A page contributes at most once per 24 hours per process, with a limit of 12 examples per publisher and 75 overall per hour. Dead ends are limited to two per publisher and 12 overall per hour.
- New ranking feedback rows contain coarse numeric features, a fixed source label, a class, a weight, an opaque event ID and operational timestamps. They do not retain URLs, page text, query strings, or arbitrary client context. Both Mongo feedback collections use a 90-day expiry for those rows. Existing checkpoints and legacy records are not rewritten by this change; it does not alter the separate answer-quality model or AI observation storage.
- `/api/neural/stats` indicates whether public crawl training is enabled and reports per-source counts for the current process. Before enabling it in production, review staged signal mix and evaluate ranking on separately labeled public samples. Turning the flag off stops new crawl feedback and pauses any remaining queued crawl feedback on restart; it does not undo prior model updates. Existing browsing feedback routes continue to work without enabling crawl training.

### Answer quality and chatbot staging

- `npm run evaluate:answer-quality` trains a fresh copy of the separate answer-quality scorer on 126 fictional examples and evaluates 54 examples from six held-out topics. It tests ranking a grounded answer above alternatives involving missing, swapped or invented citations, incorrect numbers, unsupported claims, verbatim copying, distracting formatting and incomplete answers. It also reports where the current lexical evidence checker passes or misses flaws. Neither local evaluator modifies weights on disk, calls a model provider or reads chatbot logs.
- Treat this set as a regression fixture, not a release benchmark. To collect real labeled examples, use original or permissioned documents, record the evidence basis and the review label, and hold out entire publishers or topics. A lower loss is not sufficient if useful answers rank worse or the verifier accepts wrong numbers. Run human review on dates, quantities, incomplete answers, and questions without an answer before promotion.
- The relevance ranker finds candidate sources, the answer-quality scorer measures characteristics of cited answers, and the configured language model generates text. Adding data to either small model does not teach it to generate replies. For conversational answers, start with the existing [LLM provider integration](docs/AI_PROVIDER_SETUP.md) and retrieve evidence from approved documents. Evaluate follow-up questions, correct abstention when evidence is missing, and per-claim source accuracy before shipping a chat interface.
- Before enabling public-crawl learning on Render, deploy the reviewed commit to a non-production staging service. Use isolated storage (including a separate Mongo database and model checkpoint) and staging-only secrets; do not copy production chats, browsing data or credentials. Set `NEURAL_PUBLIC_CRAWL_TRAINING=1` only there, confirm `/health` and `/api/neural/stats`, verify per-source counts reflect eligible crawls, and compare against independently labeled examples. Leaving the flag off or redeploying with it off stops new staged crawl updates without resetting any checkpoint. Run the offline evaluators first; they do not require Render.

## YouTube URL resolution

`POST /api/youtube/resolve` uses the existing YouTube parser and public oEmbed metadata endpoint. Watch, Shorts, live, embed, short-link, mobile, timestamp and playlist URLs are supported by parsing/tests, and a mocked Express route test verifies successful metadata and a disabled-embed response. Responses distinguish URL kind and preserve timestamp/playlist fields; `metadataSource` is `youtube-oembed` and `playbackVerified` is always `false`. A successful oEmbed result confirms public metadata/embeddability only; it does not establish that a specific client's player can play the video.

## 8.17.1 compatibility hardening

- API proxy accepts `OPTIONS` in addition to the existing browser methods.
- Explicit target `Authorization` headers are forwarded for API compatibility and force no-cache behavior.
- Redirects remain hop-by-hop validated through the public-destination/SSRF checks.
- The custom extension store serves only verified CSS-only packages.
- Extension verification rejects scripts, background/service-worker capabilities, external CSS imports/resources and unsupported permissions.

## Veyra 8.17.1

## Content-complete adaptive page loading

Browsing crawls are bounded page accelerators. They do not expand same-origin navigation links during first-page acceleration. Critical assets receive bounded preload hints, inline script/style asset literals are warmed without executing page code, and crawler discovery is deferred until the page is usable.

# Veyra Browser backend v8.17.1 — OmniCrawler / hybrid browser

This release keeps the existing Express proxy, crawler, search index, browser scheduler, and browser-engine architecture and strengthens the scheduling/discovery path in place.

## Local Termux authentication

For a private local instance, set both secrets before starting the server. The signup key is a server-side gate: it is never stored in Git, returned by `/api/auth/config`, or logged.

```bash
node scripts/generate-signup-key.js
# Copy the two export lines printed by the command into this shell.
export VEYRA_DATA_DIR="$PWD/data"
export VEYRA_WORK_DIR="$HOME/.veyra-work"
export VEYRA_ALLOW_SIGNUP=true
export BROWSER_ENABLED=false
npm install
npm start
```

Anyone creating an account must enter the value of `VEYRA_SIGNUP_KEY` in the signup form. Leave `VEYRA_SIGNUP_KEY` unset only when you intentionally want open registration. Keep `VEYRA_AUTH_SECRET` stable across restarts or existing login tokens will be invalidated.

For Render, set `VEYRA_AUTH_SECRET`, `VEYRA_SIGNUP_KEY`, and a durable `VEYRA_DATA_DIR`/MongoDB persistence in the Render dashboard. Do not put any of these values in `render.yaml` or commit them.

## Key fixes
- Robust browser/foreground request lane remains independent from the crawler.
- Chromium availability is checked during `npm start`; the check only warns and never downloads or installs a browser. Browser mode remains opt-in.
- Logical crawler robots remain separate from real upstream network slots.
- Robot task bundling fills per-robot queues so robots can multitask instead of receiving a single task at a time.
- Idle robots can request work from overloaded robots; the target robot explicitly accepts or declines.
- Candidate scanning for help requests is bounded and no longer sorts the whole robot fleet on every help request.
- Per-host concurrency adapts downward after repeated errors and ramps back toward the configured ceiling after successful requests.
- Sitemap discovery runs in the background and does not block normal crawl progress.
- Sitemap URL work is deduplicated.
- The search-fed neural crawler keeps processing links discovered by workers that are still fetching, within its page and depth budgets. It excludes pages and images flagged with `noindex` and `noimageindex`, respectively.
- External HTML links are recorded for the Links inspector but are not recursively crawled by the same-origin crawler.
- Same-host `www` redirects are admitted into the crawl origin set.
- Retryable failures are requeued with backoff instead of being permanently lost on the first failed attempt.
- HTML discovery includes DOM resources, responsive images, metadata, JSON/JSON-LD, script strings, inline handlers, framework data attributes, comments/hydration blobs, CSS URLs/imports, manifests and media manifests.
- Browser-engine network responses associated with a crawl job are fed back into the same bounded crawler frontier, so runtime-discovered APIs/resources can contribute to indexing.
- Proxy rewrite runtime retains the real canonical document URL even when a page uses `<base href>`.

## Logical robots vs network slots
`CRAWLER_ROBOTS=1000` means up to 1,000 logical schedulers. `MAX_ACTIVE_FETCHES` is the actual simultaneous upstream request ceiling. `CRAWLER_PER_HOST_CONCURRENCY` and adaptive host policy protect individual origins.

This separation is deliberate. More logical agents improve work distribution; they do not create 1,000 simultaneous sockets.

## Browser engine installation
For Render, the recommended build command is:

```text
npm install && npx playwright install chromium
```

The package runs a browser-binary check on startup. If Chromium is missing, the application reports `BROWSER_ENGINE_UNAVAILABLE`; it does not download Chromium at startup. Install it explicitly in the build image only when browser mode is intentionally enabled.

## Modes
- `FAST_PROXY`: HTTP fetch + minimal URL/resource rewriting.
- `BROWSER_ENGINE`: isolated Playwright/Chromium session for pages that need real browser execution.
- `CRAWLER`: background indexing/discovery.

Security verification remains user-assisted. Veyra does not solve or bypass anti-bot challenges.

## Tests

Run `npm test` in a development checkout to execute the deterministic regression, security and route-integration suites. Tests use mocks and local fixtures; they do not need live provider credentials.


## v8.10.0 stability profile

On constrained Render instances, RESOURCE_PROFILE=free keeps the 1000 logical robot scheduler but clamps actual network concurrency and browser capacity. Chromium is installed during the Render build command, not during a live request. Check /status for resourceProfile, memoryLimitMb, configuredCrawlerLimit, requestedCrawlerLimit, and crawlerLimit.


## GET forms

GET forms are rewritten to `/api/form-get/:target/:sid` so form fields cannot overwrite Veyra proxy control parameters or force a frame-protected destination to load directly inside the iframe.


## v8.11.2 proxy compatibility fixes (YouTube / SPA sites)

- GET requests no longer send `content-type: undefined` (Google/YouTube answered 400).
- Injected runtime no longer has a SyntaxError (template-literal escape loss in the unwrap regex).
- Oversize resources (e.g. YouTube's ~10 MB app bundle) are streamed instead of returning 413. `PROXY_STREAM_OVERSIZE=true` (default).
- Proxy routes relay the raw request body (JSON, protobuf, gzip, text) instead of re-serialising or dropping it.
- `fetch(Request)` bodies are buffered (Chrome can only stream uploads over HTTP/2), the real URL of a Request is read via the native getter (YouTube replays cached responses with `data:` Requests and a spoofed `url`), and `URL` objects are handled.
- Custom `x-*` API headers (`x-goog-api-key`, `x-user-agent`, ...) are relayed; proxy/infrastructure headers are not.
- Relative and location-derived URLs (`/youtubei/...`, `/api/view/<rest>`, `?page=2`) map onto the real site.
- `History.prototype` is patched and a watchdog restores the proxied URL if a page escapes it.
- Relative-path fallback: root-relative requests that bypass the runtime (DOM-inserted `<script>`, audio, CSS) are resolved from the Referer, or from the `veyra_ctx` cookie. Webpack chunks requested as `/api/<chunk>.js` are resolved against recently proxied script directories. `PROXY_RELATIVE_FALLBACK=true` (default).
- The JS rewriter no longer rewrites partial dynamic-import prefixes such as `import("./" + chunk)`.
- YouTube documents are never shared across sessions. Eligible, explicitly public static assets can use the global cache.

### Known limits
- YouTube video playback from a datacenter IP (Render, AWS) is blocked by Google's "Sign in to confirm you're not a bot" check. Route the session through a residential `VPN_PROXY_SERVER` profile if you need playback.
- Apps whose router reads `location.pathname` directly (e.g. Twitch) still see `/api/view`; fully fixing this needs a virtualised `location` (JS rewriting).


## v8.12.0 — config system, real VPN, multiple crawlers, sessions

### Config system (upgrading your Render plan)

Everything that depends on instance size (crawlers, fetch slots, worker threads, browser sessions, session limits) now comes from one place: the plan. `veyra.config.json` is committed with the repo:

```json
{ "plan": "auto", "env": {}, "caps": {}, "environments": { "development": { "env": { "SERVER_LOG_LEVEL": "debug" } }, "production": { "env": {} } } }
```

To upgrade from Free to Standard on Render:

```bash
npm run config -- plan standard   # writes veyra.config.json AND plan: in render.yaml
git commit -am "Render: standard" && git push
```

Or leave `"plan": "auto"`. Veyra reads the container's real RAM and CPU from cgroups and picks the closest Render plan. You can also set `VEYRA_PLAN=pro` in the Render dashboard (no commit needed).

Precedence, highest first: real env vars (Render dashboard) > `environments.<VEYRA_ENV>` > `env` in the file > plan preset. `/status` shows where every value came from.

| Plan | RAM | CPU | Crawlers | Fetch slots | Parse workers | Browser sessions | Proxy sessions |
|---|---|---|---|---|---|---|---|
| free | 512 MB | 0.1 | 1 | 10 | 0 | 1 | 150 |
| starter | 512 MB | 0.5 | 2 | 20 | 0 | 1 | 150 |
| standard | 2 GB | 1 | 3 | 52 | 1 | 2 | 600 |
| pro | 4 GB | 2 | 6 | 104 | 2 | 4 | 1200 |
| pro_plus | 8 GB | 4 | 12 | 208 | 3 | 6 | 2400 |
| pro_max | 16 GB | 4 | 16 | 256 | 3 | 8 | 4800 |
| pro_ultra | 32 GB | 8 | 20 | 256 | 6 | 8 | 5000 |

The newer instance types (`2c-8g`, `4c-32g`, `8c-64g`, `12c-96g`, ...) are included too. See `npm run config -- plans`.

Other CLI commands: `npm run config -- show`, `set MAX_ACTIVE_JOBS=4`, `unset MAX_ACTIVE_JOBS`, `cap parseWorkers=2`, `validate`. For a machine that isn't a Render plan, add it under `"plans": { "mybox": { "ramMb": 3072, "cpu": 1.5, "caps": {...} } }`.

Dev: `npm run dev` (node --watch). In development, `PUT /api/config` from localhost edits the file and the watcher restarts the server. In production the API is read-only unless the `X-Veyra-Admin-Token` header matches `VEYRA_ADMIN_TOKEN`. Render's disk is ephemeral, so commit config changes to git to keep them.

### Multiple crawlers + worker threads

- Up to `MAX_ACTIVE_JOBS` crawls run at the same time, sharing the plan's fetch slots fairly. Extra crawls wait in a queue (`CRAWL_QUEUE_MAX`), and user crawls go ahead of background seed crawls.
- Crawls nobody has polled for `CRAWL_ABANDON_MS` (10 min) are stopped so they don't burn the instance.
- HTML/CSS/JS rewriting and link/index extraction run on a worker-thread pool (`CRAWLER_PARSE_WORKERS`), keeping the main event loop free for page loads. Small bodies (under `PARSE_WORKER_MIN_BYTES`) stay inline. Any worker error falls back to inline, and hung workers are replaced.
- Fixed a crawler crash (`ReferenceError: job is not defined` in the robot pool) that was in earlier versions.

### Sessions (not wasting Render)

- Proxy sessions are kept in an LRU with an idle TTL (`SESSION_IDLE_TTL_MS`), a hard max age and a cookie byte budget (`SESSION_MAX_COOKIE_BYTES`).
- When a session expires, its VPN connection, Chromium sessions and script cache are released too.

### Browsing cache scope

| Setting | Default | Scope |
| --- | --- | --- |
| `SESSION_CACHE_ENABLED` | `true` | Eligible signed-in, non-incognito proxy responses and fallback page snapshots stay in RAM for that session. They are discarded when it ends. |
| `GLOBAL_CACHE_ENABLED` | `true` | Proxy responses are shared only for eligible static assets marked `public`, without redirects, credentials, `Vary`, or `Set-Cookie`. Also controls caching of non-private web search results. |
| `MONGODB_SHARED_CACHE` | `true` | Allows the eligible global proxy cache to use MongoDB when configured. Turning it off leaves the in-process global cache available. |

Guest and incognito proxy traffic bypass these cache scopes, send `Cache-Control: no-store`, and skip background proxy warming. Private web searches skip result caching and indexing, and don't generate AI answers. Session cookies and page snapshots are not persisted or restored from MongoDB. A close request immediately retires the live session and cancels pending proxy work; it also attempts to remove legacy cookie and snapshot rows for that session when MongoDB is available.

These controls apply to Veyra-managed browsing data. They do not erase files you've downloaded, bookmarks deliberately saved outside incognito, older backups, or records kept by sites, search providers, hosting infrastructure, the browser/OS, your network, or a VPN.
- Under memory pressure, idle sessions are shed first.
- Frontend: call `POST /api/session/:sid/close` (works with `navigator.sendBeacon`) on tab close to free resources right away.
- Idle mode: after `SERVER_IDLE_SLEEP_MS` (10 min) with no API traffic, Veyra closes Chromium, drops caches and pauses seed crawls. The next request wakes it. The warm browser also closes after `BROWSER_WARM_IDLE_MS`.
- Endpoints: `GET /api/sessions`, `GET /api/session/:sid`, `POST /api/session/:sid/close`, `DELETE /api/session/:sid`.

### VPN

Per Veyra session: the proxy, the crawler (`VPN_CRAWLER_PROFILE`) and Chromium all leave through the chosen exit. It is not device-wide.

- Profile types:
  - `http`/`https` CONNECT proxies and `socks5` (always remote DNS, so no DNS leaks).
  - `wireguard`, a real WireGuard tunnel run through the userspace [wireproxy](https://github.com/windtf/wireproxy). No root or TUN device is needed, so it works on Render. `node scripts/install-wireproxy.js` downloads it and checks its checksum during the build.
  - OpenVPN is not supported: it needs a TUN device, which Render does not provide.
- Kill switch (`VPN_KILL_SWITCH=true`, default): if the tunnel is down, requests fail with 503 `VPN_KILL_SWITCH`. They never silently fall back to the Render IP.
- Failover (`VPN_FAILOVER=true`): after `VPN_FAILURE_THRESHOLD` failures, the session moves to the next healthy profile in the same `group`/`region`. Health checks run every `VPN_HEALTH_INTERVAL_MS` and report the exit IP and latency.
- Split tunnel: `VPN_SPLIT_BYPASS=cdn.example.com,*.local` goes direct. `VPN_SPLIT_ONLY=youtube.com,googlevideo.com` sends only those hosts through the VPN.
- Always-on (`VPN_ALWAYS_ON=true`): every session uses `VPN_DEFAULT_PROFILE`.
- Sticky/rotating exits: put `{session}` in a residential-proxy username (`user-{session}`). Each Veyra session gets its own sticky IP, and `POST /api/vpn/rotate` gives it a new one.
- Chromium goes through a loopback gateway authenticated per session with an HMAC token. It gets the profile's `timezone`/`locale`, and WebRTC is locked to the proxy (no IP leak).
- Idle VPN sessions and idle WireGuard tunnels are shut down automatically.

```bash
# WireGuard (paste your provider's .conf, base64 to keep newlines):
VPN_ENABLED=true
VPN_WIREGUARD_CONFIG_B64=$(base64 -w0 wg0.conf)
VPN_WIREGUARD_REGION=uk
# Or several exits:
VPN_PROFILES_JSON=[{"id":"uk1","server":"socks5://user-{session}:pw@gw.provider.net:1080","group":"uk","region":"uk","timezone":"Europe/London","locale":"en-GB"},{"id":"uk2","server":"http://u:p@backup.provider.net:8080","group":"uk"},{"id":"wg-us","type":"wireguard","configB64":"...","region":"us"}]
```

Endpoints: `GET /api/vpn/status`, `GET /api/vpn/profiles`, `POST /api/vpn/connect {sessionId, profileId | "auto", region?, group?}`, `POST /api/vpn/disconnect`, `POST /api/vpn/rotate`, `GET /api/vpn/session?sid=`, `GET /api/vpn/ip?sid=` (the real exit IP), `POST /api/vpn/test {profileId}`, `POST /api/vpn/health`.

Coverage for VPN failover, kill switch, split tunnelling and capacity/queue behaviour was verified before release; test files are not shipped in this package.

## v8.13.0 — accounts, session time limits, admin gating

### Accounts

These are the `/api/auth/*` endpoints: signup, login, me, logout-all and sync.

- Passwords are hashed with scrypt, and tokens are HMAC-signed.
- User data lives in `$VEYRA_DATA_DIR/users.json`.

### Session time limit

Every session is hard-deleted after `SESSION_TIME_LIMIT_MS`, which defaults to 300000 (5 minutes). Deletion covers:

- cookies
- the Chromium context
- the VPN tunnel

Expired session IDs are tombstoned, so clients can't reuse them. `POST /api/session` returns `timeLimitMs` and `expiresAt`.

### Admin gating

`/dev`, `/api/config` writes, the session list and console endpoints need an admin.

- An admin is an account listed in `VEYRA_ADMIN_EMAILS`.
- In non-production mode, loopback requests also count as admin.

### Browser access and rollout

The browser admin panel manages a single server's access policy. The policy endpoints require a real administrator account or `VEYRA_ADMIN_TOKEN`; the local development bypass and fixture administrators do not qualify. Existing staff accounts can use **Administrator sign-in** on the gate screen. To enroll a new configured staff email, use the ordinary signup endpoint with the configured admin-token header, plus the normal signup key if required. Regular signup credentials alone cannot enroll a staff email.

| Setting | Behavior |
| --- | --- |
| Public | Anyone can reach the browser API. |
| Invite only | Visitors need a valid invite or existing gate session. |
| Staff only | New browsing requests from visitors and invite holders are denied, including on already-open tabs. Invite redemption and WebSocket streams pause. Previously rendered pages and downloads are not erased. |
| Waitlist signups | Independently accepts or rejects new browser applications without deleting the existing queue. It does not change the developer-platform waitlist. |
| Access test mode | Enables read-only policy checks for staff. It does not create identities, bypass authentication or modify public behavior. This is separate from the development-only `VEYRA_TEST_MODE` auth fixture. |

`GATE_ENABLED` and `GATE_WAITLIST_OPEN` are first-run defaults. After an administrator saves a policy, it takes precedence and survives a restart: the server uses MongoDB if configured, otherwise `access-policy.json` under `VEYRA_DATA_DIR`. Use MongoDB or a persistent disk in hosted environments. If the persisted policy cannot be loaded, the server returns an unavailable status rather than assuming public access. The health endpoint remains available. This console assumes a single application instance; it does not synchronize live decisions across replicas.

### Fixes

- The page runtime injected into proxied pages had double-escaped regexes, so it failed to parse on every page. That broke navigation reporting and DevTools. A regression test now checks that it parses.
- Static pages like example.com were being sent to Chromium; they no longer are. The "thin shell" heuristic now needs scripts to be present.
- Fixed a startup crash (`Cannot access 'logSeq' before initialization`) when a users file already exists.
- DevTools bridge improvements:
  - shorthand CSS properties
  - clean stack traces
  - NodeList previews
  - response status and content type in Network

### New environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SESSION_TIME_LIMIT_MS` | `300000` | Max session lifetime before auto-delete |
| `VEYRA_AUTH_SECRET` | random per boot | Token signing key. **Set this**, or everyone is signed out on restart |
| `VEYRA_DATA_DIR` | `./data` | Where `users.json` is stored. Point it at a Render persistent disk |
| `VEYRA_ALLOW_SIGNUP` | `true` | Set `false` to close registration |
| `VEYRA_ADMIN_EMAILS` | (none) | Comma-separated admin emails for `/dev` and `#console` |

Render's filesystem is ephemeral. Without a persistent disk mounted at `VEYRA_DATA_DIR`, accounts are lost on each deploy.

## YouTube playback eligibility

Set `YOUTUBE_DATA_API_KEY` in the deployment environment to enable `GET /api/media/youtube/:id`. Restrict the key to the YouTube Data API v3; never put it in a client bundle or browser query string. The endpoint uses Google's [Made for Kids status lookup](https://developers.google.com/youtube/data/guides/made_for_kids_status) and returns `ready` only for an explicitly embeddable video that is not Made for Kids. Without a key, or on upstream failure, it returns `unavailable`; ineligible videos return `external`.
