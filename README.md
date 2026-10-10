
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

## Google search

Google's public HTML search often challenges cloud datacenter IPs. Veyra does not bypass that challenge or rotate IPs to evade it. The preferred solution is the official Google Programmable Search JSON API: set `GOOGLE_SEARCH_API_KEY` and `GOOGLE_SEARCH_CX` as secret Render environment variables. No residential IP is needed for that API path. If those variables are absent, an explicit `engine=google` request reports `not-configured` instead of silently returning another provider's results; ordinary search may still use the configured Bing, Brave, or other permitted provider.

If direct Google pages are required, use a legitimate residential or mobile egress service that you control or are authorized to use, configure it as a Veyra VPN profile, and respect Google's terms and rate limits. Do not use rotating proxies to evade CAPTCHA, bans, authentication, or access controls.

## Live web-search provider behavior

`GET /api/search/web` uses the shared hardened direct-fetch path and concurrently queries up to three providers by default (`WEB_SEARCH_MAX_PROVIDERS`, range 1–4; `WEB_SEARCH_CONCURRENCY`, range 1–4). Each provider has an 8-second default deadline (`WEB_SEARCH_PROVIDER_TIMEOUT_MS`, range 250–30000 ms), with an additional 12-second overall request deadline (`WEB_SEARCH_DEADLINE_MS`, range 250–60000 ms). `WEB_SEARCH_ORDER` sets the initial order; subsequent requests adapt order using bounded success-rate and latency history. If at least `WEB_SEARCH_EARLY_RESULT_THRESHOLD` (default 20) unique results arrive within `WEB_SEARCH_EARLY_CANCEL_WINDOW_MS` (default 1000 ms) of the deadline, slower peer calls are cancelled without counting as provider failures. Rate-limit/transport failures receive cooldowns informed by bounded `Retry-After`; safe diagnostics include p50/p95 latency, EWMA, success rate and circuit state without API keys. Search results are URL-deduplicated while preserving provider provenance; only successful non-empty result sets are cached (`WEB_SEARCH_CACHE_TTL_MS`, default 30000, maximum 600000). Brave requires `BRAVE_SEARCH_API_KEY`, Google requires both `GOOGLE_SEARCH_API_KEY` (or `GOOGLE_API_KEY`) and `GOOGLE_SEARCH_CX` (or `GOOGLE_CSE_ID`); Bing's HTML mode needs no key, while its API mode uses `BING_SEARCH_API_KEY`. A provider failure is recorded as a typed attempt and does not fabricate a result or prevent other providers from returning partial results. CAPTCHA/challenge responses are not retried as a way to get around the block.

## Diagnostics and tests

Run `npm test` for deterministic regressions, including controlled local Express tests for `/api/search/web`, `/api/search/answer`, and `/api/youtube/resolve`, with external providers, LLM calls, Chromium and Mongo writes disabled. Tests include prompt-injection-in-source coverage and deadline-aware early cancellation. The ranker fixture contains relevant, irrelevant, duplicate and misleading-snippet cases and reports Precision@2 for that fixed fixture only—not production quality. `npm run benchmark:search` compares baseline versus upgraded orchestration using a fixed mock provider delay; it measures scheduling behavior only, not real network speed. `npm run diagnostics:network -- --route=direct` makes one bounded request to each configured public diagnostic endpoint (IPv4/IPv6 address services, Google/Bing/DuckDuckGo) and prints DNS, TLS/HTTP, parsing and block classifications; it does **not** classify the egress as residential. Use `--route=proxy` only when an authorized proxy is configured. The command does not retry or bypass challenges. No diagnostic command writes cookies or authorization headers to its report.

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
- Cookie-free YouTube HTML can use a short shared cache (`YT_DOCUMENT_CACHE=true`, default), while cookie-bearing or authenticated sessions remain isolated.

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
