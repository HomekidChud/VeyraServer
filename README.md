# Veyra Browser backend v8.8.2 — OmniCrawler / hybrid browser

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

```text
npm test
npm run test:urls
npm run test:all
```


## v8.10.0 stability profile

On constrained Render instances, RESOURCE_PROFILE=free keeps the 1000 logical robot scheduler but clamps actual network concurrency and browser capacity. Chromium is installed during the Render build command, not during a live request. Check /status for resourceProfile, memoryLimitMb, configuredCrawlerLimit, requestedCrawlerLimit, and crawlerLimit.


## GET forms

GET forms are rewritten to `/api/form-get/:target/:sid` so form fields cannot overwrite Veyra proxy control parameters or force a frame-protected destination to load directly inside the iframe.


## Veyra VPN tunnel

The server supports optional per-session outbound HTTP/HTTPS/SOCKS5 proxy gateways. Set `VPN_ENABLED=true` and configure either a single `VPN_PROXY_SERVER` profile or `VPN_PROFILES_JSON`. The browser context uses the configured gateway; proxy-mode fetches use the matching session dispatcher. This is a Veyra session tunnel, not an operating-system-wide VPN. Credentials remain server-side.


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
