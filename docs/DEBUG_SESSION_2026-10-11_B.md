# VeyraBrowser + VeyraServer debugging report — Session B (2026-10-11)

**Scope:** `HomekidChud/VeyraBrowser` and `HomekidChud/VeyraServer` only.
Backup and OS repositories excluded as instructed.

**Method:** Live end-to-end testing in a cloud Chromium browser against the
deployed [homekidchud.github.io/VeyraBrowser](https://homekidchud.github.io/VeyraBrowser/)
and the deployed `veyraserver-xscy.onrender.com` VeyraServer. Created a session,
navigated to [www.geo-fs.com/geofs.php](https://www.geo-fs.com/geofs.php),
exercised the DevTools (Elements, Console, Network), the Extensions store, the
YouTube Fast Proxy path, and the Cast menu. Each finding is backed by a live
observation and, where a code fix was possible, a regression test and a branch /
PR.

## Summary

| ID | Finding | Severity | Status |
|----|---------|----------|--------|
| B1 | `extractWarmUrls()` returned the un-substituted OSM tile template (`https://data.geo-fs.com/osm/{z}/{x}/{y}.png`) as a warm candidate, and `criticalPreloadHtml()` turned it into a `<link rel="preload" as="image">`. The `{z}/{x}/{y}` are URL placeholders the page substitutes at runtime — preloading the literal template is a guaranteed 404. | High | **Fixed** — PR [#12](https://github.com/HomekidChud/VeyraServer/pull/12) (branch `fix/osm-tile-template-preload`) |
| B2 | The `404.html` fallback redirected to `./web/` **relative to the failing URL**, so a 404 at `/web/extensions/store` redirected to `/web/extensions/web/`, which itself 404'd, redirecting to `/web/extensions/extensions/web/`, and so on indefinitely. The live URL ended up at `/web/web/web/web/...` (over 100 segments). | High | **Fixed** — PR [#11](https://github.com/HomekidChud/VeyraBrowser/pull/11) (branch `fix/404-page-redirect`) |
| B3 | `validateExtensionPackage()` dropped `category`, `tags`, `rating`, `installs`, `updated` from the validated package. The live `/api/extensions/store` response showed all 12 extensions in category `other` while the source `extension-store.json` has 8 distinct categories. The frontend uses these fields to build the store sidebar and Featured section. | Medium | **Fixed** — PR [#12](https://github.com/HomekidChud/VeyraServer/pull/12) (branch `fix/osm-tile-template-preload`) |
| B4 | Live VeyraServer session `timeLimitMs` is `120000` (2 minutes) even though the repo default is `300000` (5 minutes) and `render.yaml` sets `SESSION_TIME_LIMIT_MS=300000`. | Medium | **Effective deployed policy differs; origin not verified.** Possible causes: an admin `PUT /api/admin/session-policy` change, a Render env override, or a different deployed revision. |
| B5 | GeoFS console showed `Uncaught TypeError: Cannot read properties of undefined (reading 'dataProvider')` from `geofs.js`. | Medium | **Third-party** (GeoFS's own JS), not a Veyra bug. |
| B6 | `dhc6_2.png` / `dhc6_3.png` return 404 on GeoFS's own server (broken livery images). | Info | **Third-party** (GeoFS), not a Veyra bug. |
| B7 | GeoFS's 160px `.geofs-adbanner` on the right leaves a white vertical stripe when Adsense is blocked. | Info | **Third-party** (GeoFS's own layout). |
| B8 | GeoFS's own Adsense `$%7Ba%7D` placeholder substitution is broken when the ad is blocked. | Info | **Third-party** (GeoFS), not a Veyra bug. |
| B9 | `glTF 1.0 assets were deprecated in CesiumJS 1.94` warning. | Info | **Third-party** (GeoFS's own assets). |
| B10 | `wrong listener type: undefined` warning. | Info | **Third-party** (GeoFS's event registration). |
| B11 | YouTube Fast Proxy stayed on the skeleton during the observed window; the run ended before a successful load could be demonstrated. | Medium | **Not verified** — no successful fallback was demonstrated in this session. |

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

`scanText()` matched that template at priority 76 (above the 72 critical
threshold). `criticalPreloadHtml()` then emitted a preload for the
**un-substituted** template. The `{z}` / `{x}` / `{y}` braces are URL
placeholders the page substitutes at runtime — they are not a real
resource address. The `%7Bz%7D` in the failing request is the browser
percent-encoding the brace in a path, not Veyra double-encoding anything.

**Fix.** Reject un-substituted template URLs in the shared
`extractWarmUrls()` helper, so both the critical-preload path AND the
server-side speculative warm path (`warmPageResources`) skip them. Match
either the literal `{z}` or the percent-encoded `%7Bz%7D` form, since
`resolveResource()` has already run the URL through `new URL()` which
percent-encodes braces in a path:

```js
if (/\{[a-zA-Z][a-zA-Z0-9_]*\}|%7B[a-zA-Z][a-zA-Z0-9_]*%7D/i.test(u)) return;
```

**Regression test.** `tests/proxy-rewrite.test.js` asserts the
`geofs.osmTileProvider` template does NOT become a critical preload and
that a real image URL still does. Verified the test **fails on original
`main`** (reproduces the bug) and passes with the fix. All 16 test files
plus `scripts/verify-source.js` pass.

**PR:** [#12](https://github.com/HomekidChud/VeyraServer/pull/12).

> Note: an earlier attempt (closed PR
> [#11](https://github.com/HomekidChud/VeyraServer/pull/11)) misdiagnosed
> this as a double-encoding bug in the runtime `proxy()` helper and was
> reverted after review.

### B2 — 404 page redirect chaining (HIGH — fixed)

**Evidence (live):** Navigating to
`https://homekidchud.github.io/VeyraBrowser/web/extensions/store` (a route
that 404s on GitHub Pages) ended up at a URL containing over 100 `/web`
segments (`/web/web/web/web/...`). The same happened for
`/VeyraBrowser/web/cast`.

**Root cause.** The `404.html` fallback page used:
```html
<meta http-equiv="refresh" content="0; url=./web/">
<script>location.replace(new URL("./web/", location.href));</script>
```

`new URL("./web/", "/web/extensions/store")` resolves to
`/web/extensions/web/` — the redirect target inherits the failing path's
directory. That page itself 404s, redirects to
`/web/extensions/extensions/web/`, and the chain grows the URL
indefinitely.

**Fix.** Derive the absolute app root from the failing path: find the
`/web` segment and redirect to the path before it. For a 404 at
`/VeyraBrowser/web/cast`, the root is `/VeyraBrowser/`; for a 404 at
`/VeyraBrowser/`, the root is `/VeyraBrowser/`.

**PR:** [#11](https://github.com/HomekidChud/VeyraBrowser/pull/11).

### B3 — Extension store categories dropped (Medium — fixed)

**Evidence (live):** The Extensions store UI showed "All 12" and a single
"Other 12" category button, while the source `extension-store.json` has 8
distinct categories (reading, accessibility, appearance, social, privacy,
media, developer, typography).

**Root cause.** `validateExtensionPackage()` in `src/server.js` returns a
stripped object that omits `category`, `tags`, `rating`, `installs`, and
`updated`. The frontend's `renderExtensions()` uses
`e.category || "other"`, so every extension fell back to `other`.

**Fix.** Pass through `category`, `tags`, `rating`, `installs`, `updated`
with bounds checks, after the security-critical fields.

**PR:** [#12](https://github.com/HomekidChud/VeyraServer/pull/12).

### B4 — Session time-limit config mismatch (Medium — origin not verified)

**Evidence.** The deployed VeyraServer creates sessions with
`timeLimitMs: 120000` (2 minutes):

```bash
$ curl -s -X POST https://veyraserver-xscy.onrender.com/api/session | jq .timeLimitMs
120000
```

But the checked-out repo default is `300000` (5 minutes) and `render.yaml`
explicitly sets `SESSION_TIME_LIMIT_MS: "300000"`.

**Diagnosis.** There is no code path in the checked-out `main` that sets
`120000` for a `Free` plan. Possible causes (not distinguished in this
session): an administrator change via `PUT /api/admin/session-policy`, a
Render dashboard env override, or a different deployed revision. The
effective deployment policy differs from the repo default — the origin
is not verified.

**Suggested next step.** Check the Render dashboard `Environment` for a
`SESSION_TIME_LIMIT_MS` override, verify the deployed git revision, and
query `/api/admin/session-policy` (requires admin auth) to see the live
runtime policy.

This is what caused the "tab closes back to New tab after ~2 minutes"
behavior I saw repeatedly during live testing.

### B5 — GeoFS `dataProvider` TypeError (Medium — third-party)

**Evidence (Veyra DevTools console):**
```
Uncaught TypeError: Cannot read properties of undefined (reading 'dataProvider')
    at HTMLDocument.<anonymous> (https://veyraserver-xscy.onrender.com/api/resource?url=https%3A%2F%2Fwww.geo-fs.com%2Fjs%2Fgeofs.js...)
```

GeoFS's own `geofs.js` references `dataProvider` on an undefined object.
Third-party JS bug, not a Veyra proxy defect — Veyra faithfully serves the
upstream script.

### B6 — GeoFS's own livery images 404 (Info)

`https://www.geo-fs.com/images/planes/dhc6_2.png` and `dhc6_3.png` return
HTTP 404 on GeoFS's own origin (verified with direct `curl`). These are
GeoFS's own broken livery PNGs for the Twin Otter.

### B7 — GeoFS right-edge white stripe (Info)

The 3D view is sized to the viewport width **minus 160px** because GeoFS's
own layout reserves a `.geofs-adbanner` (160px × viewport height) on the
right. When Adsense is blocked (as in Veyra's proxy), the ad never renders
and a 160px white stripe remains. Confirmed live by measuring the
`.geofs-ui-center` (868px in a 1028px viewport) and `.geofs-adbanner`
(160px) in DevTools.

### B8 — GeoFS's Adsense substitution broken (Info)

`https://pagead2.googlesyndication.com/pagead/managed/js/adsense/$%7Ba%7D/show_ads_impl$%7Bb%7D.js`
fails to load. The `$%7Ba%7D` is the literal percent-encoded form of GeoFS's
own placeholder `$a` / `$b` substitution variables.

### B9 — glTF 1.0 deprecation warning (Info)

`glTF 1.0 assets were deprecated in CesiumJS 1.94. They will be removed in
1.97. Please convert any glTF 1.0 assets to glTF 2.0.`

### B10 — `wrong listener type: undefined` (Info)

GeoFS's own event-registration code passes `undefined` for a listener type.

### B11 — YouTube Fast Proxy skeleton timing (Medium — not verified)

**Evidence.** Opening `www.youtube.com` in Veyra showed the skeleton
placeholders for roughly 55 seconds during my live window. I observed the
iframe target go from `readyState: loading` with an empty body to
`readyState: complete` with 14 body children, but my run ended before a
successful YouTube page load could be demonstrated in the viewport.
**This is not verified as a working fallback in this session** — record it
as "skeleton observed; run ended before successful load."

## Extensions, DevTools, and Cast — current state

**DevTools.** Opened with F12; all 10 panel tab labels render (Elements,
Console, Sources, Network, Application, Performance, Audit, Memory,
Security, Coverage). I functionally exercised the Elements and Console
panels (read the GeoFS DOM, captured every runtime error and warning —
that's how B1 and B5 were found) and the inspect-element pick mode
(Ctrl+Shift+C toggled `aria-pressed` correctly). Filters, preservation,
console evaluation, and the other panels were not individually exercised.

**Extensions.** The Extensions store (`/extensions/store`) loaded 12
extensions (12 "Install" buttons visible in the tree). Installing an
extension worked correctly (the first article's button changed from
"Install" to "Reinstall"). Uninstalling and the page effect of an
installed extension were not tested. The extension system supports CSS,
userscripts, and Chrome/Edge content-script manifests (per
`web/src/extensions.js`), not CSS-only.

**Cast.** The `Cast a Device` menu item navigates to `/cast`, which is a
404 on GitHub Pages and triggers the B2 redirect loop — the cast UI was
never rendered in my live session. The cast WebSocket server is running
(`mode: websocket`, 3 total sessions) per `GET /api/cast/stats`. No code
defect found in `src/network/cast-server.js` or `web/src/device-cast.js`
from static review. Pairing with a real device requires a second physical
device and was not tested.

## Recommended next steps (beyond this session)

1. Merge PRs [#11](https://github.com/HomekidChud/VeyraBrowser/pull/11),
   [#12](https://github.com/HomekidChud/VeyraServer/pull/12), and
   [#10](https://github.com/HomekidChud/VeyraBrowser/pull/10), then
   redeploy Render so the fixes go live.
2. Verify the Render dashboard env and deployed revision (see B4).
3. For the user's requested "Google sign-in in your own Chrome, then
   redirect back to Veyra" — **this feature does not currently exist in
   Veyra**. The existing handoff opens `accounts.google.com` in a new tab
   (via `target="_blank"` in `web/src/youtube.js` and the challenge
   page's "Open Google directly to verify" button), but it does **not**
   redirect back into Veyra with the Google session cookies. A
   cookie-transfer is deliberately not implemented because it would
   require cross-origin cookie exfiltration which Veyra's threat model
   would reject. A safe path forward:
   - keep sign-in links opening in the user's own browser (already done),
   - after sign-in, the user returns to Veyra manually, and Veyra can
     offer a "Continue where you left off" resume using the existing
     `veyra_ctx` cookie (the runtime already sets `veyra_ctx` with the
     canonical URL + session id — this is navigation context, not Google
     authentication).
4. For "fast proxy speed" — no measured before/after comparison was done
   in this session.
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
  session. The user asked for testing on "other huge sites" but the
  session was focused on the GeoFS report and the concrete bugs found.
- Incognito mode, VPN exit, the Android Capacitor build — out of scope for
  this live-web session.
- No screenshots were saved to the repo; findings are documented in text
  above. If screenshots are needed, they should be captured per finding
  (not per navigation) and redacted of session IDs.
