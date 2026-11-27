# Search API v2

API v2 is additive; existing `/api/search`, `/api/search/web`, `/api/search/vertical`, and answer routes retain their existing payloads and behavior.

## `GET /api/v2/search`

Parameters: `q` (required; 0–600 characters), `mode` (`web` default, `index`, or `vertical`), `type` (required supported category only for vertical mode), `limit` (integer 1 through configured `CFG.maxSearchResults`, default 20), and `offset` (non-negative safe integer, default 0). `cursor` is not supported; pagination is offset-based, and `nextOffset` is null when no further page is known. Web/index results expose offset-based pages; vertical providers may return a single provider page. Optional `region`, `lang`, `engine`, `privacy`, `private=1`, and `incognito=1` are passed through with validation/sanitization appropriate to the service. Private/incognito and unauthenticated requests use `Cache-Control: no-store`.

Stable success envelope:

```json
{"ok":true,"version":2,"data":{"results":[{"url":"https://example.org/","title":"Example"}]},"pagination":{"offset":0,"limit":20,"nextOffset":null,"hasMore":false},"meta":{"mode":"web","query":"example","provider":"provider-name","region":null,"generatedAt":"2026-01-01T00:00:00.000Z"}}
```

Vertical responses additionally include `data.type` and `data.status`. Errors use `{ "ok": false, "version": 2, "error": { "code": "INVALID_SEARCH_REQUEST", "message": "..." } }` with appropriate HTTP status.

## `GET /api/v2/search/deep`

Requires `q` (0–600 characters); accepts `region`, `lang`, `engine`, `privacy`, `private`, and `incognito`. Performs bounded multi-stage source discovery and repeated-query fusion. It returns source records in `data.results`, with `data.kind: "discovered_sources"`, `data.summaryGenerated: false`, and safe batch diagnostics in `data.diagnostics`. It does **not** generate an AI answer or summary, does not require login, and does not claim independent verification. Evidence attributes are present only when supplied by a checked source record. Internal candidate arrays and model output are not returned. Site scopes and privacy filters are applied to every stage; execution has a bounded deadline and uses provider-level cancellation.

Example: `GET /api/v2/search/deep?q=compare%20SQLite%20and%20PostgreSQL`

```json
{"ok":true,"version":2,"data":{"kind":"discovered_sources","summaryGenerated":false,"results":[{"url":"https://example.org/guide","canonicalUrl":"https://example.org/guide","title":"Guide"}],"diagnostics":{"strategy":"wide-v1","batches":[{"lane":"original","status":"ok","returned":1}],"deadlineExceeded":false,"latencyMs":120}},"pagination":{"offset":0,"limit":1,"nextOffset":null,"hasMore":false},"meta":{"mode":"deep","query":"compare SQLite and PostgreSQL","provider":"multi-stage-discovery","region":null,"generatedAt":"2026-01-01T00:00:00.000Z"}}
```

Results are best-effort provider/index discoveries, not a complete corpus. Providers may return no results or fail; deep discovery is time-bounded, and its returned sources are not a generated answer nor necessarily independently verified.

## `GET /api/v2/venues/search`

Parameters: required `lat` (-90..90), `lon` (-180..180), and `radiusMeters` (integer 1..50,000); optional `category` (default `cafe`; supported categories are `cafe`, `restaurant`, `bar`, `fast_food`, `pub`, `museum`, `gallery`, `hotel`, `attraction`, and `park`), `q` (name substring, at most 100 characters), `limit` (1..100, default 20), and `offset` (0..10,000, default 0). Private/incognito and unauthenticated calls receive `Cache-Control: no-store`. Success uses the v2 envelope and includes `data.attribution` with OpenStreetMap copyright and ODbL-1.0 licensing links. Venue details are sourced from community-contributed OSM data; ratings and prices are not supplied by this endpoint.

Each result contains an OSM-based `id`, `name`, `category`, `lat`, `lon`, `distanceMeters`, optional supplied `address`, `phone`, `website`, and `openingHours`, plus `source` with the OSM object type and ID. Omitted source tags remain `null`; the API does not geocode, infer business details, or claim a rating/price. Name matching is a bounded local substring filter after the radius/category lookup. Requests have a bounded timeout and 2 MiB response-body cap; nearby category results are cached briefly to reduce upstream load.

The default upstream is the public Overpass API, intended for modest mapper use and not application backends. Deployments should configure `VEYRA_OVERPASS_URL` to an appropriately operated/self-hosted Overpass instance, cache responsibly, and keep request volume within that instance's policy. See the [Overpass API Commons guidance](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html). Returned OSM data must retain visible [OpenStreetMap attribution and ODbL licensing](https://www.openstreetmap.org/copyright). The route does not provide a proxy for heavy unattended usage.
