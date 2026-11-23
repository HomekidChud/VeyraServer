# GeoFS debugging report — VeyraBrowser + VeyraServer

**Date:** 2026-10-11
**Scope:** `HomekidChud/VeyraBrowser` and `HomekidChud/VeyraServer` only.
Backup and OS repositories were excluded as requested.
**Method:** Live end-to-end test in a cloud Chromium. Loaded
[homekidchud.github.io/VeyraBrowser](https://homekidchud.github.io/VeyraBrowser/),
opened the browser UI, navigated to
[www.geo-fs.com/geofs.php](https://www.geo-fs.com/geofs.php), captured every
console message, network request, and screenshot of the failing state, then
traced each failure to a root cause in the server code and fixed it.

## Summary

| ID | Bug | Severity | Status |
|----|-----|----------|--------|
| G1 | `CESIUM_BASE_URL` not injected — Cesium `buildModuleUrl` resolves to `location.origin + '/' + undefined`, so every Assets request 404s (`/undefined/Assets/approximateTerrainHeights.json`, `/undefined/Assets/IAU2006_XYS/IAU2006_XYS_16.json`). World renders as a black plane. | High | **Fixed** |
| G2 | Terrain tiles 404 because the proxy rewrote `geofs.srtmServer` to the relative form `/api/resource?url=...&from=...&sid=...`. Cesium's `getDerivedResource` replaces the query string when the tile template has one (`{z}/{x}/{y}.terrain?v={version}`), dropping `url`/`from`/`sid` and producing `/api/resource/<z>/<x>/<y>.terrain?v=1.0.0` — a 404. | High | **Fixed** |
| G3 | "You crashed / click to reset" shown before the user has flown. | Medium | **Not a Veyra bug** — GeoFS resets the flight on load; it's GeoFS's own behavior. |
| G4 | `glTF 1.0 assets were deprecated in CesiumJS 1.94` console warning. | Info | **Third-party** (GeoFS's own asset pipeline). Not a Veyra defect. |
| G5 | `wrong listener type: undefined` console warning. | Info | **Third-party** (GeoFS's event registration). Not a Veyra defect. |
| G6 | `/api/undefined/Assets/Images/ion-credit.png` 404. | Medium | Same root cause as G1. **Fixed** by the same change. |

## Findings in detail

### G1 — Cesium base URL is `undefined`

**Evidence (console):**
```
UNHANDLED_REJECTION: {"statusCode":404,"response":"<html>...<center><h1>404 Not Found</h1></center>...
","responseHeaders":{...,"x-veyra-canonical-url":"https://www.geo-fs.com/undefined/Assets/approximateTerrainHeights.json",
"x-veyra-proxy-mode":"resource",...}}
UNHANDLED_REJECTION: {"statusCode":404,...,"x-veyra-canonical-url":"https://www.geo-fs.com/undefined/Assets/IAU2006_XYS/IAU2006_XYS_16.json",...}
```

**Evidence (network):**
```
https://veyraserver-xscy.onrender.com/api/resource?url=https%3A%2F%2Fwww.geo-fs.com%2Fundefined%2FAssets%2FapproximateTerrainHeights.json  → 404
https://veyraserver-xscy.onrender.com/api/resource?url=https%3A%2F%2Fwww.geo-fs.com%2Fundefined%2FAssets%2FIAU2006_XYS%2FIAU2006_XYS_16.json  → 404
https://veyraserver-xscy.onrender.com/api/undefined/Assets/Images/ion-credit.png  → 404
```

**Root cause:** CesiumJS (the `Cesium.js` bundle GeoFS loads) resolves its
`Assets/` base by scanning the DOM for a `<script src>` that matches the regex
`/((?:.*\/)|^)Cesium\.js(?:\?|#|$)/`. When the Veyra proxy rewrites the script
tag to `/api/resource?url=https%3A%2F%2Fwww.geo-fs.com%2Fjs%2FCesium%2Fbuild%2FCesium.js&from=...&sid=...`,
the src no longer ends with `Cesium.js` — it ends with `&sid=...`. The regex
does not match, `Pbe()` returns `undefined`, and every subsequent
`buildModuleUrl("Assets/...")` produces
`https://<proxy-origin>/api/undefined/Assets/...`.

**Fix:** Inject
`<script>window.CESIUM_BASE_URL = "<real Cesium.js parent dir>";</script>`
immediately before any script tag that loads `Cesium.js` — covering
`script[src]`, `script[data-deferredsrc]`, and `script[dest]` in
`rewriteHtml`. `buildModuleUrl` then uses the real upstream directory and the
runtime `fetch`/`XHR` patch (already in `injectRuntime`) wraps each Assets
request into the proxy.

### G2 — Terrain tiles 404 because Cesium replaces the query

**Evidence (network):**
```
https://veyraserver-xscy.onrender.com/api/resource?url=https%3A%2F%2Fveyraserver-xscy.onrender.com%2Fapi%2Fresource%2F12%2F4332%2F3042.terrain%3Fv%3D1  → 404
https://veyraserver-xscy.onrender.com/api/resource?url=https%3A%2F%2Fveyraserver-xscy.onrender.com%2Fapi%2Fresource%2F0%2F1%2F0.terrain%3Fv%3D1.0.0%26  → 404
```

**Evidence (console):**
```
An error occurred in "Object": Failed to obtain terrain tile X: 0 Y: 0 Level: 0. Error message: "Request has failed. Status Code: 404"
An error occurred in "Object": Failed to obtain terrain tile X: 1 Y: 0 Level: 0. Error message: "Request has failed. Status Code: 404"
```

**Root cause:** GeoFS's upstream HTML sets
`geofs.srtmServer = 'https://data.geo-fs.com/srtm/'`. The Veyra proxy
rewrites this to the relative form
`/api/resource?url=https%3A%2F%2Fdata.geo-fs.com%2Fsrtm%2F&from=...&sid=...`.
Cesium's `CesiumTerrainProvider` uses that value as a `Resource` base and
calls `getDerivedResource({url: '{z}/{x}/{y}.terrain?v={version}'})`. Because
the tile template carries its own query string (`?v={version}`), the derived
resource **replaces** the entire original query — dropping the proxy's
`url`, `from`, and `sid` parameters. The result is
`/api/resource/<z>/<x>/<y>.terrain?v=1.0.0` — a 404.

**Fix:** Exclude the geo-fs.com server-config URLs that Cesium uses as
tile-template bases from the same-origin rewrite in `rewriteJsText`:
`srtmServer`, `dataServer`, `blackMarbleServer`, `landuseServer`,
`buildingServer`, `treeServer`, `objectServer`, `aircraftServer`,
`runwayServer`. They stay absolute; the runtime `fetch`/`XHR` patch wraps
each tile request into the proxy.

`geofs.weatherServer` and `geofs.multiplayerHost` are NOT excluded — they are
not tile-template bases and continue to be rewritten as before.

## Fixes and verification

Commit: `47ba92c` ("Fix GeoFS Cesium base URL and terrain tile 404s in proxy")
on `HomekidChud/VeyraServer` `main`.

Changes:
- `src/server.js` — inject `CESIUM_BASE_URL` for any Cesium.js script tag;
  exclude GeoFS tile-template base URLs from the same-origin rewrite.
- `tests/proxy-rewrite.test.js` — regression tests for both fixes and an
  assertion that `CESIUM_BASE_URL` is NOT injected on non-Cesium pages.

Verification (all 13 test files pass, plus `scripts/verify-source.js`):

| Test | Result |
|------|--------|
| `tests/proxy-rewrite.test.js` | passed |
| `tests/auth.test.js` | passed |
| `tests/ai-answer.test.js` | passed |
| `tests/neural-crawler.test.js` | passed |
| `tests/acquisition-manager.test.js` | passed |
| `tests/google-accounts-transport.test.js` | passed |
| `tests/browser-status.test.js` | passed |
| `tests/youtube.test.js` | passed |
| `tests/youtube-direct-assets.test.js` | passed |
| `tests/crawler-js-heavy-render.test.js` | passed |
| `tests/websearch.test.js` | passed |
| `tests/search-route.test.js` | passed |
| `tests/source-view.test.js` | passed |
| `tests/http-reader.test.js` | passed |
| `tests/network-diagnostics.test.js` | passed |
| `scripts/verify-source.js` | validated 61 JS source files |

End-to-end check against the live GeoFS page, with the patched
`rewriteHtml`:

```
srtmServer:     geofs.srtmServer = 'https://data.geo-fs.com/srtm/'
dataServer:     geofs.dataServer = 'https://data.geo-fs.com/'
blackMarbleServer: geofs.blackMarbleServer = 'https://data.geo-fs.com/bm/'
has undefined-path: false
has api-resource path collision: false
```

No `undefined`-path proxy URLs and no terrain-path collisions remain in the
rewritten HTML.

**Deployment note:** The fix is on `VeyraServer` `main`. Render.com
deploys this branch automatically; after the next deploy the live
`veyraserver-xscy.onrender.com` will pick it up. No change was needed in
`VeyraBrowser` itself — both bugs live in the server-side proxy.

## Screenshot evidence

Screenshots live in `evidence/` at the repo root of this workspace (not
committed to GitHub, because they show the Render URL and session IDs).

- `bug_cesium_base_undefined.png` — GeoFS after clicking FLY with the bug:
  the aircraft renders but the world is a solid black plane. The underlying
  cause is every Assets and terrain request returning 404.

## Out of scope / notes

- `HomekidChud/VeyraBrowserBackup` and `HomekidChud/VeyraServerBackup` were
  excluded per the user's instruction.
- `HomekidChud/VeyraOS` was excluded per the user's instruction.
- The client-side VeyraBrowser code (`web/`) itself showed no console errors
  during session creation or navigation — the errors all came from inside the
  cross-origin iframe that loads the proxied GeoFS page.

## Coverage

Tested: session creation, navigation to `www.geo-fs.com/geofs.php`, the
GeoFS welcome modal, clicking FLY, and the resulting simulator render state.
Console capture was installed on the parent VeyraBrowser frame and on the
proxied GeoFS frame. Network requests were inspected via
`performance.getEntriesByType('resource')` because the iframe is
cross-origin to the parent and CDP attach to it is blocked by the
browser harness.

Not tested: multiplayer, weather, aircraft change, location change,
recorded flight playback. These all depend on the same
`geo-fs.com`-family URLs that G2 now fixes, so they are expected to benefit
from the same change, but were not exercised individually.
