## Veyra 8.16.0

## Content-complete adaptive page loading

Browsing crawls are bounded page accelerators. They do not expand same-origin navigation links during first-page acceleration. Critical assets receive bounded preload hints, inline script/style asset literals are warmed without executing page code, and crawler discovery is deferred until the page is usable.

# Veyra Browser backend v8.16.0 — OmniCrawler / hybrid browser

This release keeps the existing Express proxy, crawler, search index, browser scheduler, and browser-engine architecture and strengthens the scheduling/discovery path in place.

## Key fixes
- Robust browser/foreground request lane remains independent from the crawler.
- Chromium installation is checked during both dependency installation and `npm start` so a missing browser binary reports a clear warning instead of silently breaking browser mode.
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

The package also runs a browser-binary check on startup. If Chromium is missing, the application will try to install it once and otherwise fall back gracefully to FAST_PROXY with `BROWSER_ENGINE_UNAVAILABLE` telemetry.

## Modes
- `FAST_PROXY`: HTTP fetch + minimal URL/resource rewriting.
- `BROWSER_ENGINE`: isolated Playwright/Chromium session for pages that need real browser execution.
- `CRAWLER`: background indexing/discovery.

Security verification remains user-assisted. Veyra does not solve or bypass anti-bot challenges.

## Tests

The release package ships without test files. Keep regression tests in your development checkout; they are not needed to run or deploy Veyra.


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
  - `wireguard`, a real WireGuard tunnel run through the userspace [wireproxy](https://github.com/windtf/wireproxy). No root or TUN device is needed, so it works on Render. `node install-wireproxy.js` downloads it and checks its checksum during the build.
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

Every session is hard-deleted after `SESSION_TIME_LIMIT_MS`, which defaults to 120000 (2 minutes). Deletion covers:

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
| `SESSION_TIME_LIMIT_MS` | `120000` | Max session lifetime before auto-delete |
| `VEYRA_AUTH_SECRET` | random per boot | Token signing key. **Set this**, or everyone is signed out on restart |
| `VEYRA_DATA_DIR` | `./data` | Where `users.json` is stored. Point it at a Render persistent disk |
| `VEYRA_ALLOW_SIGNUP` | `true` | Set `false` to close registration |
| `VEYRA_ADMIN_EMAILS` | (none) | Comma-separated admin emails for `/dev` and `#console` |

Render's filesystem is ephemeral. Without a persistent disk mounted at `VEYRA_DATA_DIR`, accounts are lost on each deploy.
