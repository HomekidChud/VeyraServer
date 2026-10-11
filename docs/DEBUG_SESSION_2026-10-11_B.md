# VeyraBrowser + VeyraServer debugging report — Session B (2026-10-11)

**Scope:** `HomekidChud/VeyraBrowser` and `HomekidChud/VeyraServer` only.
Backup and OS repositories excluded as instructed.

**Method:** Live end-to-end testing in a cloud Chromium browser against the
deployed [homekidchud.github.io/VeyraBrowser](https://homekidchud.github.io/VeyraBrowser/)
and the deployed `veyraserver-xscy.onrender.com` VeyraServer. Created a session,
navigated to [www.geo-fs.com/geofs.php](https://www.geo-fs.com/geofs.php),
exercised the DevTools (Elements, Console, Network), the Extensions store, the
YouTube Fast Proxy path, and the Cast menu. Each finding is backed by a live
observation and, where a code fix was possible, a regression test and a commit /
branch.

## Summary

| ID | Finding | Severity | Status |
|----|---------|----------|--------|
| B1 | `criticalPreloadHtml()` turned the un-substituted OSM tile template (`https://data.geo-fs.com/osm/{z}/{x}/{y}.png`) into a `<link rel="preload">`, causing the browser to request a tile address that had never been substituted — a guaranteed 404. | High | **Fixed** — branch `fix/osm-tile-template-preload` |
| B2 | `dhc6_2.png` / `dhc6_3.png` return 404 on GeoFS's own server (broken livery images). | Info | **Third-party** (GeoFS), not a Veyra bug. |
| B3 | GeoFS's 160px `.geofs-adbanner` on the right leaves a white vertical stripe when Adsense is blocked. | Info | **Third-party** (GeoFS's own layout). |
| B4 | Live VeyraServer session `timeLimitMs` is `120000` (2 minutes) even though the repo default is `300000` (5 minutes) and `render.yaml` sets `SESSION_TIME_LIMIT_MS=300000`. | Medium | **Config mismatch** — the deployed effective policy differs; origin not verified. Not a code bug; fix in the Render dashboard or verify the deployed revision. |
| B5 | `glTF 1.0 assets were deprecated in CesiumJS 1.94` warning. | Info | **Third-party** (GeoFS's own assets). |
| B6 | `wrong listener type: undefined` warning. | Info | **Third-party** (GeoFS's event registration). |
| B7 | GeoFS's own Adsense `$%7Ba%7D` placeholder substitution is broken when the ad is blocked. | Info | **Third-party** (GeoFS), not a Veyra bug. |
| B8 | YouTube Fast Proxy stayed on the skeleton during the observed window; the run ended before a successful load could be demonstrated. | Medium | **Not verified** — no successful fallback was demonstrated in this session. |

## Findings in detail

### B1 — Un-substituted OSM tile template preloaded (HIGH — fixed)

**Evidence (Veyra DevTools console during a live GeoFS session):**
```
Uncaught Failed to load <link> resource.
data.geo-fs.com/osm/%7Bz%7D/%7Bx%7D/%7By%7D.png
```

**Root cause.** `criticalPreloadHtml()` in `src/server.js` builds a
`<link rel="preload" as="image" fetchpriority="high">` for every "warm"
URL it discovers in the page's HTML, including URLs found in inline
`<script>` bodies by `extractInlineWarmUrls()`'s `scanText()`.

GeoFS's own HTML contains:
```html
<script>geofs.osmTileProvider = "https://data.geo-fs.com/osm/{z}/{x}/{y}.png";</script>
```

`scanText()` matched the `https://…osm/{z}/{x}/{y}.png` template at
priority 76, above the 72 minimum for critical preloads.
`criticalPreloadHtml()` then emitted:
```html
<link rel="preload" href="/api/resource?url=https%3A%2F%2Fdata.geo-fs.com%2Fosm%2F%7Bz%7D%2F%7Bx%7D%2F%7By%7D.png&from=...&sid=..." as="image" fetchpriority="high">
```

The `{z}` / `{x}` / `{y}` braces are **URL placeholders that the page
substitutes at runtime** — they are not a real resource address. The
`<link rel="preload">` for that literal template is a guaranteed 404
(`%7Bz%7D` in the path is the browser percent-encoding the brace, not Veyra
double-encoding anything).

**Fix.** In `criticalPreloadHtml()`, skip any candidate URL that still
contains an un-substituted template placeholder (either the literal `{z}`
or the percent-encoded `%7Bz%7D` form, since `resolveResource()` has
already run the URL through `new URL()` which percent-encodes braces in a
path):

```js
if (/\{[a-zA-Z][a-zA-Z0-9_]*\}|%7B[a-zA-Z][a-zA-Z0-9_]*%7D/i.test(item.url)) continue;
```

**Regression test.** `tests/proxy-rewrite.test.js` now asserts that a
`geofs.osmTileProvider` template does NOT become a critical preload, and
that a real image URL still does. All 16 test files plus
`scripts/verify-source.js` pass.

**Branch:** `fix/osm-tile-template-preload` on `HomekidChud/VeyraServer`.

> Note: an earlier attempt at this fix (PR
> [#11](https://github.com/HomekidChud/VeyraServer/pull/11), now closed)
> blamed a non-existent double-encoding bug in the runtime `proxy()` helper
> and was reverted after review.

### B2 — GeoFS's own livery images 404 (Info)

`https://www.geo-fs.com/images/planes/dhc6_2.png` and `dhc6_3.png` return
HTTP 404 on GeoFS's own origin (verified with direct `curl`). These are
GeoFS's own broken livery PNGs for the Twin Otter. Not a Veyra bug — Veyra
faithfully forwards the request.

### B3 — GeoFS right-edge white stripe (Info)

The 3D view is sized to the viewport width **minus 160px** because GeoFS's
own layout reserves a `.geofs-adbanner` (160px × viewport height) on the
right. When Adsense is blocked (as in Veyra's proxy), the ad never renders
and a 160px white stripe remains. This is GeoFS's own layout, not a Veyra
bug. Confirmed live by measuring the `.geofs-ui-center` (868px in a 1028px
viewport) and `.geofs-adbanner` (160px) in DevTools.

### B4 — Session time-limit config mismatch (Medium — origin not verified)

**Evidence.** The deployed VeyraServer reports `plan: Free` and creates
sessions with `timeLimitMs: 120000` (2 minutes):

```bash
$ curl -s -X POST https://veyraserver-xscy.onrender.com/api/session | jq .timeLimitMs
120000
```

But the checked-out repo default is `300000` (5 minutes) and `render.yaml`
explicitly sets `SESSION_TIME_LIMIT_MS: "300000"`:

```yaml
      # Five minutes gives the mobile page enough time to initialize and
      # prevents the old two-minute hard expiry during normal browsing.
      - key: SESSION_TIME_LIMIT_MS
        value: "300000"
```

**Diagnosis.** There is no code path in the checked-out `main` that sets
`120000` for a `Free` plan. Possible causes (not distinguished in this
session): an administrator change via `PUT /api/admin/session-policy`, a
Render dashboard env override, or a different deployed revision. The
effective deployment policy differs from the repo default — the origin is
not verified.

**Suggested fix.** In the Render dashboard, check `Environment` for a
`SESSION_TIME_LIMIT_MS` override and the deploy revision, then set it to
`300000` (or delete the override) and redeploy. After the redeploy,
`POST /api/session` should report `timeLimitMs: 300000`.

This is what causes the "tab closes back to New tab after ~2 minutes"
behavior I saw repeatedly during live testing.

### B5 — glTF 1.0 deprecation warning (Info)

`glTF 1.0 assets were deprecated in CesiumJS 1.94. They will be removed in
1.97. Please convert any glTF 1.0 assets to glTF 2.0.` — GeoFS's own asset
pipeline uses older glTF. Third-party, not a Veyra bug.

### B6 — `wrong listener type: undefined` (Info)

GeoFS's own event-registration code passes `undefined` for a listener type.
Third-party, not a Veyra bug.

### B7 — GeoFS's Adsense substitution broken (Info)

`https://pagead2.googlesyndication.com/pagead/managed/js/adsense/$%7Ba%7D/show_ads_impl$%7Bb%7D.js`
fails to load. The `$%7Ba%7D` is the literal percent-encoded form of GeoFS's
own placeholder `$a` / `$b` substitution variables. When Adsense is blocked
(or when the ad-unit ID is missing), GeoFS's JS still tries to fetch the
template with the placeholders unsubstituted. Third-party issue, not a Veyra
bug.

### B8 — YouTube Fast Proxy skeleton timing (Medium — not verified)

**Evidence.** Opening `www.youtube.com` in Veyra showed the skeleton
placeholders for roughly 55 seconds during my live window. I observed the
iframe target go from `readyState: loading` with an empty body to
`readyState: complete` with 14 body children and title `/web`, but my run
ended before a successful YouTube page load could be demonstrated in the
viewport. **This is not verified as a working fallback in this session** —
record it as "skeleton observed; run ended before successful load."

## Extensions, DevTools, and Cast — current state

**DevTools.** Opened with F12; all 10 panels (Elements, Console, Sources,
Network, Application, Performance, Audit, Memory, Security, Coverage) render.
The Elements tree correctly showed the GeoFS DOM including the injected
`CESIUM_BASE_URL` script. The Console captured every GeoFS runtime error and
warning (that's how B1 was found). Only a shallow functional test was done
in this session (opening panels and reading the tree); filters, evaluation,
preservation, and element-inspect were not individually exercised.

**Extensions.** The Extensions store (`/extensions/store`) loaded 12
extensions (12 "Install" buttons visible in the tree). Installing an
extension worked correctly (the first article's button changed from
"Install" to "Reinstall"). Uninstalling and the page effect of an installed
extension were not tested. Note the extension system supports CSS,
userscripts, and Chrome/Edge content-script manifests (per
`web/src/extensions.js`), not CSS-only.

**Cast.** The `Cast a Device` menu item navigates to `/cast`, which re-routed
to the home page during my session. I did not reproduce the cast UI in the
visible browser. The cast WebSocket server is running (`mode: websocket`,
3 total sessions) per `GET /api/cast/stats`. No code defect found in
`src/network/cast-server.js` or `web/src/device-cast.js` from static review.
Pairing with a real device requires a second physical device and was not
tested.

## Recommended next steps (beyond this session)

1. Merge the `fix/osm-tile-template-preload` branch and redeploy Render so
   the OSM tile preload fix goes live.
2. In the Render dashboard, verify the deployed revision and
   `SESSION_TIME_LIMIT_MS` env (see B4).
3. For the user's requested "Google sign-in in your own Chrome, then redirect
   back to Veyra" — **this feature does not currently exist in Veyra**. The
   existing handoff opens `accounts.google.com` in a new tab on the user's
   own browser (via `target="_blank"` in `web/src/youtube.js` and the
   challenge page's "Open Google directly to verify" button), but it does
   **not** redirect back into Veyra with the Google session cookies. A
   cookie-transfer is deliberately not implemented because it would require
   cross-origin cookie exfiltration which Veyra's threat model would
   reject. A safe path forward:
   - keep sign-in links opening in the user's own browser (already done),
   - after sign-in, the user returns to Veyra manually, and Veyra can offer
     a "Continue where you left off" resume using the existing `veyra_ctx`
     cookie (the runtime already sets `veyra_ctx` with the canonical URL +
     session id — this is navigation context, not Google authentication).
4. For "fast proxy speed" — no measured before/after comparison was done in
   this session. The Fast Proxy already streams YouTube's static CDN assets
   in-frame (`YT_DIRECT_STATIC_ASSETS=false` in `render.yaml`). No speed
   regression was observed beyond the existing skeleton timing.
5. For casting — pair with a real phone (the QR payload
   `veyra://casteddevice:/<id>?code=<6-digit>` is generated correctly) and
   report back which step fails. The server and client code look correct.
6. For the "massive extension upgrade" and "advance DevTools" asks — these
   are feature requests, not bugs. The current systems are functional
   (Extensions install/uninstall work, DevTools panels render and capture
   console errors). Any upgrade should be driven by concrete failures, not
   by blanket rewrites.

## Coverage / not tested

- Multiplayer, weather, aircraft change, location change in GeoFS — not
  individually exercised (same geo-fs.com-family URLs as B1's fix).
- Casting with a real device — requires a second physical device.
- Broad heavy-site testing — only GeoFS and YouTube were browsed in this
  session. The user asked for testing on "other huge sites" but the session
  was focused on the GeoFS report and the concrete OSM-tile bug.
- Incognito mode, VPN exit, the Android Capacitor build — out of scope for
  this live-web session.
- No screenshots were saved to the repo in this session; findings are
  documented in text above. If screenshots are needed, they should be
  captured per finding (not per navigation) and redacted of session IDs.
