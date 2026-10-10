# Veyra acquisition overhaul report

## Scope

Repository: [HomekidChud/VeyraServer](https://github.com/HomekidChud/VeyraServer)

Commit: `21ea1e5ed376f29010f6d83c0fb85acbaa0aa738`

The existing architecture was preserved. The change adds a shared acquisition layer and routes answer retrieval through it rather than replacing the existing crawler, search index, browser engine, or synthesis layer.

## Implemented

- Added `src/services/acquisition-manager.js` with:
  - bounded asynchronous direct HTTP acquisition and keep-alive connections;
  - per-host concurrency limits, request timeouts, bounded retries, redirect loop protection, and response-size limits;
  - URL canonicalization and duplicate suppression;
  - in-flight request coalescing and TTL response caching;
  - ETag and Last-Modified request validators;
  - content-type validation;
  - robots.txt parsing and enforcement;
  - sitemap and sitemap-index discovery;
  - lightweight HTML, canonical-link, JSON-LD, title, text, and link extraction;
  - search-first candidate acquisition;
  - SSRF protection for private, loopback, link-local, and metadata addresses;
  - acquisition metrics and per-URL records.
- Connected `AIAnswerEngine` to the shared manager.
- When `/api/search/answer` receives no results, it now performs search-first discovery and acquires only the selected candidates before synthesis.
- Added `GET /api/acquisition/status` for operational metrics.
- Chromium is now opt-in through `VEYRA_CHROMIUM_ENABLED`; default is disabled.
- Added an internal browser-engine guard so disabled configuration cannot launch Chromium through a direct caller.
- Removed Chromium installation from the committed `render.yaml` build command and set both `BROWSER_ENABLED=false` and `VEYRA_CHROMIUM_ENABLED=false`.
- Added regression coverage for acquisition caching, parsing, canonicalization, and Chromium-disabled behavior.

## Console and source-view follow-up (2026-10-10)

The operations console now displays provider health and acquisition metrics through read-only diagnostics endpoints. Its source-inspector flow uses the same acquisition boundary rather than a separate fetch implementation. Captures are limited to public HTTP(S) text documents, subject to robots and redirect/DNS checks, 15 seconds and 1 MiB. Sensitive query-parameter URLs are rejected before a shareable link is issued. In-memory source snapshots expire after five minutes and are bounded to 100 entries/8 MiB total. Source text is escaped into an inert viewer; generated `veyra://view_source/<id>/<base64url-link>` values resolve only while their random-ID snapshot remains live. This follow-up does not change Chromium's opt-in default or add dependencies.

The proxied-page runtime now maps `Ctrl+U`/`Cmd+U` to capture and open the current page source. Desktop right-click and mobile long-press show a Veyra page-actions menu (selection/link/media, source, inspect, select-all, reload/history and print). It is a page-level Veyra menu rather than a replica of browser-native chrome or full DevTools; the inspect action uses existing Veyra element metadata.

The latest backend follow-up maps the `veyra://view_source/...` capability to the safe HTTP viewer in the active Veyra session. The separate VeyraBrowser frontend still derives its address field from the HTTP target, so the visible address-bar alias is not complete until that frontend adds a separate display-only URI. Inspect Element opens the existing Developer Tools UI through the Ctrl+Shift+I bridge and selects/highlights the element under the context-menu pointer using the DevTools DOM bridge; without a target it opens DevTools without selecting. The previous page-injected details popup is removed. The source viewer and console display inline Veyra marks with a verified badge.

AI answer strings are normalized to a consistent plain-text paragraph while citations are retained. The local neural URL relevance model now uses AdamW with saved optimizer moments and backward-compatible v1 checkpoint loading. This updates the locally trainable search ranker only; it does not fine-tune the hosted generative answer model, whose weights are not available to this service.

Following a copy-paste regression report, synthesis now receives up to 90,000 characters of full extracted document text within a shared context budget (rather than only five selected sentences per page). Claim verification compares against relevant full-document sentences so supported rewording is not automatically downgraded to extraction. Near-duplicate source suppression now compares full page text. If grounded paraphrase synthesis fails, the default endpoint abstains; raw extracted sentences are available only through the explicit diagnostic fallback flag.

The `tests/source-view.test.js`, AI-answer and neural-crawler suites cover route validation/tampering, inert source rendering, custom-URI navigation hooks, Developer Tools selection dispatch, deterministic answer formatting, AdamW ranking updates and checkpoint compatibility. The full suites are rerun for this follow-up; Chromium remains disabled by default and no live browser UI interaction is claimed.

## Validation

`npm test` passed:

- source syntax validation: 45 JavaScript files;
- auth regression tests;
- AI answer regression tests;
- neural crawler regression tests;
- proxy rewrite regression tests;
- acquisition manager and Chromium opt-in tests.

A local smoke test also confirmed:

- server starts with Chromium disabled;
- `/health` returns successfully;
- `/api/acquisition/status` returns `chromiumEnabled:false`;
- no Veyra browser session is created at startup.

## Deployment

The code commit was pushed to `main` and Render’s auto-deploy completed it as live deployment `dep-db55fdou01pc73eat7l0`.

The live Render environment variables were updated to:

```text
BROWSER_ENABLED=false
VEYRA_CHROMIUM_ENABLED=false
```

At the time of this report, the separate Render environment update was still processing. The Render service metadata exposed to this session continued to show the old dashboard-managed build command (`npm install && npx playwright install chromium && node scripts/install-wireproxy.js`) even though the repository `render.yaml` now removes that install step. The runtime is protected because Chromium is disabled; the dashboard-managed build command should be changed to `npm install && node scripts/install-wireproxy.js` if Render does not reconcile the blueprint automatically.

## Limitations and follow-up

- The existing neural crawler remains the deeper crawl engine; the new manager provides the common HTTP/cache/security/search-first path without deleting it.
- Persistent queue records are represented by the manager’s record map in this first integration. Mongo persistence remains available for the existing search/crawl stores and can be extended with durable acquisition-job records in a subsequent change.
- No before/after production benchmark is claimed because no representative workload or baseline run was supplied. The manager reports request, cache, byte, error, block, and per-engine counters for honest measurements.
- Browser rendering remains available only when explicitly enabled and the runtime image contains Chromium.


## Search-index and source-view follow-up (2026-10-10)

The source-view route now opens in the Veyra fast-proxy browser while retaining its `veyra://` title; its inert HTML viewer only permits configured frontend origins to embed it. Bing can page to 20 HTML results. Search-to-answer returns the full discovery list separately and caps source-page acquisition at eight documents. Relevant external search results enter a bounded background crawl using AcquisitionManager's socket-level address validation, redirect rechecks, robots policy, and size/concurrency limits; crawler workers without the injected safe fetcher fail closed. The console reports AI readiness without secrets, and an API key uses the official OpenAI URL when no custom base is configured. Full current and legacy test suites pass locally; deployment status is not asserted.
