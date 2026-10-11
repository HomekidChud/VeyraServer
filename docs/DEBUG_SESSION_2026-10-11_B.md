# VeyraBrowser + VeyraServer debugging report — Session B (2026-10-11)

**Scope:** `HomekidChud/VeyraBrowser` and `HomekidChud/VeyraServer` only.
Backup and OS repositories excluded as instructed.

**Method:** Live end-to-end testing in a cloud Chromium browser against the
deployed [homekidchud.github.io/VeyraBrowser](https://homekidchud.github.io/VeyraBrowser/)
and the deployed `veyraserver-xscy.onrender.com` VeyraServer. Created a session,
navigated to [www.geo-fs.com/geofs.php](https://www.geo-fs.com/geofs.php),
exercised the DevTools (Elements, Console, Network), the Extensions store, the
YouTube Fast Proxy path, and the Cast menu. Each finding is backed by a live
observation and, where a code fix was possible, a regression test and a
commit / PR.

## Summary

| ID | Finding | Severity | Status |
|----|---------|----------|--------|
| B1 | `osmTileProvider` OSM tile-template URL braces were double-encoded by the runtime proxy patch — every OSM tile 404'd (`data.geo-fs.com/osm/%7Bz%7D/%7Bx%7D/%7By%7D.png`). | High | **Fixed** — PR [#11](https://github.com/HomekidChud/VeyraServer/pull/11) |
| B2 | `dhc6_2.png` / `dhc6_3.png` return 404 on GeoFS's own server (broken livery images). | Info | **Third-party** (GeoFS), not a Veyra bug. |
| B3 | `pagead2.googlesyndication.com/pagead/managed/js/adsense/$%7Ba%7D/show_ads_impl$%7Bb%7D.js` fails to load — GeoFS's own Adsense template substitution is broken when the ad is blocked. | Info | **Third-party** (GeoFS), not a Veyra bug. |
| B4 | Live VeyraServer session `timeLimitMs` is `120000` (2 minutes) even though the repo default is `300000` (5 minutes) and `render.yaml` says `SESSION_TIME_LIMIT_MS=300000`. | Medium | **Config mismatch** — the Render dashboard is overriding the env var. Not a code bug; fix in the Render dashboard. |
| B5 | GeoFS's own layout uses a 160px `.geofs-adbanner` on the right, leaving a white vertical stripe when Adsense is blocked. | Info | **Third-party** (GeoFS's own layout). |
| B6 | `glTF 1.0 assets were deprecated in CesiumJS 1.94` warning. | Info | **Third-party** (GeoFS's own assets). |
| B7 | `wrong listener type: undefined` warning. | Info | **Third-party** (GeoFS's event registration). |
| B8 | YouTube Fast Proxy remained stuck on skeleton for ~55 seconds before falling back to Chromium render mode. | Medium | **Existing behavior**; the prior session's "stuck-on-skeleton" fix works, it just takes time to fall back. |

## Findings in detail

### B1 — OSM tile-template braces double-encoded (HIGH — fixed)

**Evidence (Veyra DevTools console during a live GeoFS session):**
```
Uncaught Failed to load <img> resource.
data.geo-fs.com/osm/%7Bz%7D/%7Bx%7D/%7By%7D.png
```

**Root cause.** The runtime patch that VeyraServer injects into the proxied
page builds every outbound proxy URL with:

```js
proxy('resource', u) → '/api/resource?url=' + encodeURIComponent(u)
```

Before `proxy()` is called, the URL has already been normalized once by the
browser's `new URL()` inside `toVirtual()` / `resolve()`. The browser's URL
parser percent-encodes the literal `{` and `}` in a *path* to `%7B` and `%7D`.
`encodeURIComponent()` then re-encodes the `%` itself into `%25`, producing
`%257Bz%257D` — a double-encoded form. The server decodes once, sees the
literal `%7Bz%7D` in the tile path, and requests it — a 404.

The server-side `makeResourceUrl()` in `src/server.js` already has the same
fix (keeping braces literal in the query), but the runtime patch did not.

**Fix.** In `src/server.js` `injectRuntime()`'s `proxy()` helper, un-encode
braces before `encodeURIComponent()`, then restore them again after.

```js
const encodedTarget = String(u||'').replace(/%7B/g,'{').replace(/%7D/g,'}');
const base = prefix + (kind==='view'?'/api/view?url=':'/api/resource?url=') +
  encodeURIComponent(encodedTarget)
    .replace(/%257B/g,'{').replace(/%257D/g,'}')
    .replace(/%7B/g,'{').replace(/%7D/g,'}');
```

**Regression test.** `tests/proxy-rewrite.test.js` now asserts that a rewritten
`geofs.osmTileProvider` template keeps the literal `{z}` / `{x}` / `{y}` in
the `/api/resource?url=` query and that `%257B` never appears. All 16 test
files plus `scripts/verify-source.js` pass.

**Commit:** `ca9a9c1` ("Fix OSM tile template double-encoding in proxy runtime")
on branch `fix/osm-tile-provider-double-encode`, opened as PR
[#11](https://github.com/HomekidChud/VeyraServer/pull/11) against `main`.

### B2 — GeoFS's own livery images 404 (Info)

`https://www.geo-fs.com/images/planes/dhc6_2.png` and `dhc6_3.png` return
HTTP 404 on GeoFS's own origin (I verified with direct `curl`). These are
GeoFS's own broken livery PNGs for the Twin Otter. Not a Veyra bug — Veyra
faithfully forwards the request.

### B3 — GeoFS's Adsense substitution broken (Info)

`https://pagead2.googlesyndication.com/pagead/managed/js/adsense/$%7Ba%7D/show_ads_impl$%7Bb%7D.js`
fails to load. The `$%7Ba%7D` is the literal percent-encoded form of GeoFS's
own placeholder `$a` / `$b` substitution variables. When Adsense is blocked
(or when the ad-unit ID is missing), GeoFS's JS still tries to fetch the
template with the placeholders unsubstituted. Third-party issue, not a Veyra
bug.

### B4 — Session time-limit config mismatch (Medium — config)

**Evidence.** The deployed VeyraServer reports `plan: Free` and creates
sessions with `timeLimitMs: 120000` (2 minutes):

```bash
$ curl -s -X POST https://veyraserver-xscy.onrender.com/api/session | jq .timeLimitMs
120000
```

But the repo default is `300000` (5 minutes) and `render.yaml` explicitly
sets `SESSION_TIME_LIMIT_MS: "300000"`:

```yaml
      # Five minutes gives the mobile page enough time to initialize and
      # prevents the old two-minute hard expiry during normal browsing.
      - key: SESSION_TIME_LIMIT_MS
        value: "300000"
```

**Diagnosis.** There is no code path that sets `120000` for a `Free` plan.
The Render dashboard is overriding the `SESSION_TIME_LIMIT_MS` environment
variable to `120000` at deploy time (or the deploy is running an older
commit whose default was 2 minutes). The `render.yaml` value is ignored
because Render prefers dashboard-set env vars.

**Fix (in the Render dashboard).** Open the `veyraserver-xscy` service →
Environment → find `SESSION_TIME_LIMIT_MS` → set to `300000` (or delete the
dashboard override so the `render.yaml` value is used) → redeploy. After
the redeploy, `POST /api/session` should report `timeLimitMs: 300000`.

This is what causes the "tab closes back to New tab after ~2 minutes"
behavior I saw repeatedly during live testing.

### B5 — GeoFS right-edge white stripe (Info)

The 3D view is sized to the viewport width **minus 160px** because GeoFS's
own layout reserves a `.geofs-adbanner` (160px × viewport height) on the
right. When Adsense is blocked (as in Veyra's proxy), the ad never renders
and a 160px white stripe remains. This is GeoFS's own layout, not a Veyra
bug. Confirmed live by measuring the `.geofs-ui-center` (868px in a 1028px
viewport) and `.geofs-adbanner` (160px) in DevTools.

### B6 — glTF 1.0 deprecation warning (Info)

`glTF 1.0 assets were deprecated in CesiumJS 1.94. They will be removed in
1.97. Please convert any glTF 1.0 assets to glTF 2.0.` — GeoFS's own asset
pipeline uses older glTF. Third-party, not a Veyra bug.

### B7 — `wrong listener type: undefined` (Info)

GeoFS's own event-registration code passes `undefined` for a listener type.
Third-party, not a Veyra bug.

### B8 — YouTube Fast Proxy skeleton timing (Medium — existing behavior)

**Evidence.** Opening `www.youtube.com` in Veyra showed the skeleton
placeholders for roughly 55 seconds, then the iframe switched to Chromium
remote-render mode and content loaded (the iframe went from `readyState:
loading` with an empty body to `readyState: complete` with 14 body children).
This is the intended Fast-Proxy → Chromium fallback path; the previous
session's "stuck-on-skeleton" fix is working, it just takes ~50 s before
falling back.

## Extensions, DevTools, and Cast — current state

**DevTools.** Opened with F12, all 10 panels (Elements, Console, Sources,
Network, Application, Performance, Audit, Memory, Security, Coverage) render.
The Elements tree correctly shows the GeoFS DOM including the injected
`CESIUM_BASE_URL` script. The Console captured every GeoFS runtime error and
warning (that's how B1 was found). The Console's "Preserve log" and filter
controls work. No defects found in DevTools itself during this session.

**Extensions.** The Extensions store (`/extensions/store`) loaded all 12
extensions (12 "Install" buttons visible in the tree). Installing an
extension worked correctly (the first article's button changed from
"Install" to "Reinstall"). Extensions are CSS-only today (no scripts) by
design, to keep the security boundary safe.

**Cast.** The `Cast a Device` menu item navigates to `/cast`, which re-routes
to the home page. The cast WebSocket server is running (`mode: websocket`,
3 total sessions) per `GET /api/cast/stats`. The `/cast` UI requires a live
session to pair, so I could not exercise the QR / pairing flow without a
second device. No code defect found in `src/network/cast-server.js` or
`web/src/device-cast.js` from static review.

## Recommended next steps (beyond this session)

1. Merge PR [#11](https://github.com/HomekidChud/VeyraServer/pull/11) and
   redeploy Render so the OSM tile fix goes live.
2. In the Render dashboard, set `SESSION_TIME_LIMIT_MS=300000` (see B4).
3. For the user's requested "Google sign-in in your own Chrome, then redirect
   back to Veyra" — the current Veyra already has a partial handoff: the
   challenge page has an "Open Google directly to verify" button that opens
   `accounts.google.com` in a new tab on the *user's own browser*, and
   YouTube's sign-in link opens `accounts.google.com/ServiceLogin?service=youtube&continue=<video>`
   in a new tab. What it does **not** do is redirect back into Veyra with the
   Google session cookies, because Google's cookies stay in the user's
   browser. A cookie-transfer is deliberately not implemented because it
   would require cross-origin cookie exfiltration which Veyra's threat model
   (and most security reviews) would reject. The recommended path is:
   - keep sign-in links opening in the user's own browser (already done),
   - after sign-in, the user returns to Veyra and Veyra can offer a "Continue
     where you left off" resume using the existing `veyra_ctx` cookie (the
     runtime already sets `veyra_ctx` with the canonical URL + session id).
4. For "fast proxy speed" — the Fast Proxy already streams YouTube's static
   CDN assets in-frame (`YT_DIRECT_STATIC_ASSETS=false` in `render.yaml`)
   and the skeleton fallback is working. No further speed regression was
   observed beyond the existing ~50 s fallback to Chromium.
5. For casting — pair with a real phone (the QR payload
   `veyra://casteddevice:/<id>?code=<6-digit>` is generated correctly) and
   report back which step fails. The server and client code look correct.

## Coverage / not tested

- Multiplayer, weather, aircraft change, location change in GeoFS — not
  individually exercised (same geo-fs.com-family URLs as B1's fix).
- Casting with a real device — requires a second physical device.
- Incognito mode, VPN exit, the Android Capacitor build — out of scope for
  this live-web session.
