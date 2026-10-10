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

The new `tests/source-view.test.js` covers route validation, tampering, content type, private-host rejection, source escaping and UI script parsing. The full suite passed on 2026-10-10 with 53 JavaScript files validated.

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
