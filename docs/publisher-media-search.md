# Protected publisher-media search

Fast Proxy navigates a site in a visitor's own browsing session. It is not a feed, a grant to reuse publisher artwork, or evidence of the visitor's verified age. The public video fallback recognizes a limited set of watch URL formats and its image provider uses strict filtering. Neither a Fast Proxy session nor the Veyra invite gate unlocks this catalog.

This implementation is disabled by default. It stages an approved operator-supplied snapshot and exposes it through a separate age-gated API. It does not crawl either site, fetch or cache thumbnail bytes, or add records to public search. Do not activate the route for real data until the publisher rights, restricted-display controls, verifier integration and target deployment have been approved and tested.

## Approval and input snapshot

- Confirm permission for both indexing metadata and displaying the particular poster URLs to the proposed audience. Keep the actual evidence in a restricted register. The [Pornhub webmaster page](https://www.pornhub.com/webmasters) and [XVideos export page](https://info.xvideos.net/db) describe embedding; do not assume they grant every use of exported artwork. Review the [Pornhub terms](https://www.pornhub.com/information/terms) and the applicable publisher agreement.
- This version accepts only approved worldwide use; it does not verify where the visitor is. Feed entries must be accurate, cleared and active. Store a normalized snapshot outside the checkout, web root and any public storage. Put no embed HTML, thumbnails, access tokens or sensitive identity records in it.
- Join the publisher's current catalog with removals before import. XVideos documents a deletion export. Use an atomic file replacement and restart to load each reviewed update; removals must not wait for a routine restart window. Disable access until a new snapshot is in service if a removal cannot be applied immediately. Snapshots never stay eligible beyond their expiry or 24 hours from generation, whichever comes first. Snapshots are limited to 16 MiB total and 15,000 records per publisher.

The example is synthetic and has intentionally expired timestamps. `id` is the Pornhub watch key or XVideos first watch-path segment; a known feed host is only an input validator, never proof of rights. An unfamiliar thumbnail host is counted as rejected rather than being automatically allowed.

```json
{
  "schemaVersion": 1,
  "catalogs": [
    {
      "domain": "pornhub.com",
      "generatedAtMs": 0,
      "expiresAtMs": 1,
      "approval": {
        "status": "approved",
        "evidenceRef": "internal:example/publisher-agreement",
        "territories": "worldwide",
        "uses": ["search-metadata", "thumbnail-display"]
      },
      "withdrawnIds": [],
      "entries": [
        {
          "id": "fixture123",
          "title": "Synthetic fixture entry",
          "tags": "lunar atlas",
          "url": "https://www.pornhub.com/embed/fixture123",
          "thumbnail": "https://ei.phncdn.com/synthetic-fixture.jpg"
        }
      ]
    }
  ]
}
```

## Verification and API

Choose an age-assurance provider whose actual method and implementation fit the deployment, with privacy and child-safety review. An invite code, checkbox, typed date of birth, admin role, or Fast Proxy cookies do not count. See [Ofcom's age-assurance guidance](https://www.ofcom.org.uk/online-safety/protecting-children/age-assurance) and [preview placement guidance](https://www.ofcom.org.uk/online-safety/protecting-children/age-checks-why-their-placement-matters-in-pornography).

Keep the provider and signing key outside Veyra. Only a trusted integration that confirms the completed age check for the requesting browser may sign a result. It must protect the nonce flow against sharing, cross-user substitution and replay and provide an accessible failure path. No official age verifier or verifier bridge is shipped by this change.

Configuration variables: `VEYRA_PUBLISHER_SEARCH=1`, `VEYRA_PUBLISHER_CATALOG_PATH` (absolute local file path), `VEYRA_PUBLISHER_AGE_ISSUER` (canonical HTTPS URL), `VEYRA_PUBLISHER_AGE_START_URL` (same origin, no query), and `VEYRA_PUBLISHER_AGE_PUBLIC_KEY` (Ed25519 SPKI public PEM). The private signing key must not be set in Veyra. Invalid inputs leave the route unavailable.

All publisher endpoints require `?privacy=restricted` in addition to the access checks. This query parameter selects a surface; it does not prove age or grant permission. Other modes, including Unfiltered, do not access the catalog.

1. `POST /api/search/publisher/challenge` with a Veyra account bearer token starts an expiring challenge and returns its nonce and the verifier URL. Starting again invalidates that account's old challenge.
2. The verifier bridge delivers the signed decision back to the original client through a confidential, session-bound integration. Do not put the assertion in a URL or rely on a manually shared link or token. The original client calls `POST /api/search/publisher/verify` with the same Veyra bearer token and `{ "assertion": "<compact signed JWS>" }`. The JWS has `alg: EdDSA`, `typ: JWT`, and claims `iss` (canonical issuer URL), `aud: "veyra:publisher-search"`, `nonce`, boolean `over18`, and integer `iat`/`exp` Unix seconds. Only a current, positive, signed decision redeemed in the initiating session unlocks the challenge.
3. `POST /api/search/publisher` with the original account bearer and `{ "nonce": "...", "q": "search:xvideos.com lunar atlas", "page": 0 }` returns authorized, publisher-scoped rows, the matched count and `expiresInMs` for the earlier of grant expiry and snapshot expiry. The search terms and proof stay out of the query string; there is no incognito mode. Clients should subtract request time from this lifetime, keep data in memory and clear it on mode changes, sign-out or expiration.

### Optional VeyraBrowser client

`GET /api/search/publisher/status?domain=pornhub.com&privacy=restricted` requires a signed-in session and only returns `{ "ok": true }` when `VEYRA_PUBLISHER_BROWSER=1` and that domain has an approved, unexpired, non-empty catalog. Leave this separate option off until the Browser handoff is tested against a real, reviewed provider.

The Browser opens the configured first-party verifier bridge in a popup only on user action. The bridge must retain the opener only on trusted pages, not forward it to untrusted or vendor pages, and have a compatible cross-origin opener policy. After the bridge confirms a decision belongs to the initiating browser, it sends `window.opener.postMessage({ type: "veyra:publisher-age-decision", nonce, assertion }, configuredBrowserOrigin)` using the exact Browser origin, never `*`. The client only accepts the message from that popup and bridge origin with its current nonce. The assertion is only passed to `/verify` in a POST, not stored or placed in a URL. The bridge must not trust age, nonce ownership, or return origins supplied by the browser without independently verifying the flow.

Use a single instance for this version: challenges live only in memory and a restart invalidates them. The age check must be completed before any client access to titles, thumbnails, or embeds. The Browser renders only titles and outbound links in this version. Thumbnails require a separately reviewed delivery strategy and release testing; do not add publisher CDNs to public Browser content security policy. Setting either flag does not establish media rights, prove age assurance works, or authorize publication.

## Verification and logs

`npm run test:publisher-media` generates test keys, uses synthetic metadata, and runs a real local Express integration. It checks approval, expiry, cross-account/session binding, incorrect and replayed signatures, signed denial, host spoofing, removals, scope, unique IDs and page counts without visiting either publisher or loading their images.

`PUBLISHER_MEDIA` startup logs include aggregate counts per publisher: received, indexed, missing thumbnail, rejected thumbnail, invalid record, withdrawn and duplicate. Search responses return `total`, page number and page continuation after authorization. The route does not log the viewer's terms, age proof, returned media URLs, or result titles.
