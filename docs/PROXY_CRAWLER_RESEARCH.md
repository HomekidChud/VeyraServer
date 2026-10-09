# Fast Proxy and Neural Crawler Upgrade Research

## Sources

- MDN, `ServiceWorkerGlobalScope: fetch event`: https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/fetch_event
  - Service workers can intercept implicit browser requests for HTML subresources, scripts, CSS, and images through `fetch` events and respond from cache or network.
- MDN, `HTTP range requests`: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests
  - Large media and binary assets should preserve `Range`, `206 Partial Content`, `Content-Range`, `Accept-Ranges`, and conditional `If-Range` behavior.
- Cloudflare, `Revalidation`: https://developers.cloudflare.com/cache/concepts/revalidation/
  - `stale-while-revalidate` allows stale content to be served immediately while one asynchronous revalidation refreshes the cache; ETag and Last-Modified reduce full refetches.

## Applied decisions

- The server fast proxy now has a bounded stale-while-revalidate window and coalesced background revalidation to avoid blocking foreground page loads when an origin is slow.
- The proxy preserves range metadata and streaming paths for oversized assets.
- HTML rewriting now covers modern lazy URL attributes and same-origin absolute literals in JavaScript bundles in addition to existing HTML/CSS/module rewriting.
- Neural Robots now accept gzip, Brotli, and deflate HTML, normalize canonical URLs and tracking parameters, apply user-agent-aware robots groups with longest-match Allow precedence, extract JSON-LD and passage candidates, and crawl with a bounded neural-priority concurrent frontier.
