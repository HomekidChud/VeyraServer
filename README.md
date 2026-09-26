# Veyra Browse — Render backend v8

This repository preserves the existing Express architecture and expands it into a bounded browser/proxy/crawler/search service.

## What v8 adds

- Fast `/api/view` initial page proxy independent of crawl completion.
- Explicit canonical/original URL signalling from proxied documents; proxy URLs never become Veyra's visible browsing state.
- Central URL resolution for navigation and resources, including query/fragment/protocol-relative/relative URL handling.
- HTML, CSS, JavaScript, `srcset`, `imagesrcset`, lazy-load attributes, SVG references, media tracks, forms, iframe and module-resource rewriting.
- Runtime handling for anchor navigation, `history.pushState`/`replaceState`, `fetch`, XHR, EventSource, `window.open`, simple POST forms, and service-worker isolation.
- Bounded priority frontier with global and per-host concurrency limits, deduplication, backpressure, timeouts, retries with jitter, and temporary host backoff.
- HTTP caching with ETag/Last-Modified revalidation and a small in-memory hot cache.
- Streaming response-size protection and content-type-aware proxy limits for documents, images, media, fonts and other binary resources; HTTP Range forwarding for media.
- Robots parsing with user-agent matching, allow/disallow precedence, Crawl-delay, sitemap indexes, and concurrent sitemap processing.
- Conservative security-challenge detection with a Veyra fallback; no challenge/CAPTCHA bypassing.
- Veyra Search is now a first-party local search engine with an inverted index, BM25-style relevance scoring, title/heading/URL boosts, phrase matching, negative terms, `site:`, `intitle:` and `inurl:` operators, snippets, pagination, suggestions, and index statistics.
- External search providers (Brave/Bing/custom) remain optional adapters; no provider is required for the core Veyra Index.
- Optional `INDEX_SEEDS` let the server continuously grow and refresh the Veyra index from responsible public crawl roots while respecting robots.txt.
- Bounded source storage through a filesystem abstraction designed to be replaced by object storage later.
- Structured server logs, bounded request logs, client log ingestion, safe debug endpoints, and a backend-only `/console` dashboard.
- `PROCESS_ROLE=web|worker|all` architecture switch. Without external queue infrastructure, the default single-process mode remains supported.
- Safer SSRF checks with DNS validation and redirect re-validation.

## Run

```text
npm install
npm test
npm start
```

The default Render service type remains **Web Service**.

Build command: `npm install`

Start command: `npm start`

## Render environment variables

Core crawler limits:

```text
PROCESS_ROLE=web
MAX_GLOBAL_CONCURRENCY=12
MAX_PER_HOST_CONCURRENCY=3
MAX_PENDING_QUEUE=1500
MAX_PAGES=10000
MAX_RESOURCES=20000
MAX_LINKS=100000
MAX_SCAN_BYTES=536870912
MAX_TEXT_BYTES_PER_RESOURCE=2097152
MAX_PROXY_TEXT_BYTES=8388608
MAX_PROXY_IMAGE_BYTES=16777216
MAX_PROXY_MEDIA_BYTES=33554432
MAX_PROXY_OTHER_BYTES=16777216
REQUEST_TIMEOUT_MS=15000
BODY_TIMEOUT_MS=15000
DNS_TIMEOUT_MS=4000
MAX_RETRIES=2
CACHE_TTL_MS=10000
MAX_JOB_AGE_MS=3600000
```

Search / Veyra Index:

```text
SEARCH_PROVIDER=local
MAX_INDEX_DOCS=20000
MAX_INDEX_TEXT_CHARS=8000
MAX_SEARCH_QUERY_TERMS=20
INDEX_SEEDS=https://example.com,https://developer.mozilla.org
INDEX_SEED_CRAWL=true
INDEX_REFRESH_MS=21600000

SEARCH_API_KEY=
SEARCH_ENDPOINT=
BRAVE_SEARCH_API_KEY=
BING_SEARCH_API_KEY=
```

`local` is the default first-party search mode. Each crawled HTML page contributes title, description, headings, URL, body text and metadata to the inverted index. Search uses relevance scoring instead of hard-coded results. `INDEX_SEEDS` is optional; when populated, Veyra starts background seed crawls and refreshes them after the configured interval.

Supported local query operators:

```text
site:example.com cats
intitle:browser security
inurl:docs crawler
"exact phrase"
space -tracking
```

External providers remain optional adapters. `auto` prefers the local Veyra index once it contains content, otherwise it falls back to a configured external provider.

CORS:

```text
FRONTEND_ORIGIN=https://YOUR-FRONTEND-HOST
```

For local development, use a comma-separated list when needed.

## Public API

- `POST /api/open` — validate a public URL and create/reuse a background crawl job.
- `GET /api/view?url=...` — fast page proxy. Supports HTML navigation and simple form POSTs.
- `GET|POST /api/resource?url=...` — resource/API proxy with CSS/JS rewriting where applicable.
- `GET /api/search?q=...&offset=0&limit=10` — first-party Veyra Search results or an optional external provider.
- `GET /api/search/stats` — index size, domain count, vocabulary size, newest indexed page, and seed activity.
- `GET /api/search/suggest?q=...` — lightweight local query suggestions.
- `GET /api/crawl/:id` — crawl status.
- `POST /api/crawl/:id/stop` — request stop.
- `GET /api/crawl/:id/resources` — captured text resources.
- `GET /api/crawl/:id/source/:resourceId` — source text.
- `GET /api/crawl/:id/links` — paginated discovered links.
- `GET /api/crawl/:id/export` — crawl JSON export.
- `GET /health` — safe health response.
- `GET /console` — backend-only diagnostics dashboard.
- `/api/debug/system`, `/api/debug/config`, `/api/debug/jobs`, `/api/debug/requests`, `/api/debug/logs`, `POST /api/debug/client-log` — safe diagnostics.

## Security boundary

The proxy and crawler intentionally do not forward Veyra browser cookies, Authorization headers, server credentials, or arbitrary client headers. Anonymous public browsing is the supported path. SSRF validation is performed before every upstream request and after redirects. DNS validation reduces rebinding risk, but a generic HTTP proxy cannot make arbitrary third-party websites fully equivalent to a native browser.

Security verification/challenge pages are detected conservatively and shown through a dedicated fallback instead of being indexed as site content. Veyra does not implement challenge solving, CAPTCHA solving, stealth fingerprints, or security-provider circumvention.

## Storage

Sources default to `/tmp/veyra-browse-jobs` and are deleted with expired jobs. This is compatible with ephemeral Render storage. The `sourceStore` abstraction is intentionally isolated so an object-storage implementation can be added later without changing crawler/proxy APIs.


Veyra 8.1.1 patch notes: CRAWLER_ROBOTS and CRAWLER_PER_HOST_CONCURRENCY now control actual crawler worker counts; proxy referrer handling is fixed; proxy history uses canonical unwrapping and absolute Veyra proxy URLs.
