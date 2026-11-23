# YouTube and Shorts test report

The implementation continues to use the existing `src/browser/youtube.js` parser and `/api/youtube/resolve` route. The parser recognizes watch, Shorts, live, embed and youtu.be URLs; mobile watch URLs and playlist/time parameters are covered. Malformed percent-encoding, invalid short IDs and lookalike domains are rejected.

The deterministic suite uses injected fetch functions. It verifies successful oEmbed-shaped metadata, embedding-disabled mappings for HTTP 401/403/404, provider-unavailable mappings for HTTP 429/5xx, malformed/empty JSON, thrown network errors, invalid-ID no-fetch behavior, and Shorts playlist/time preservation in embed URLs. The local Express route integration also verifies Shorts metadata fields, timestamp/playlist parsing, stable 403 error output, and `playbackVerified:false`. No live YouTube request was made; private/deleted/region/age-restricted outcomes beyond the oEmbed status mapping, redirects in the actual server route, transcript availability and actual player playback were not verified.

`POST /api/youtube/resolve` now returns the parsed `kind` (`shorts`, `watch`, etc.), `isShortsUrl`, timestamp/playlist/index fields, `metadataSource: "youtube-oembed"`, and `playbackVerified: false`. On failure, the route returns a stable oEmbed error code rather than exposing an exception. Metadata/embeddability is not proof of playback, and the change does not claim transcript extraction.

Command: `npm test` (includes `tests/youtube.test.js`). Result: PASS.
