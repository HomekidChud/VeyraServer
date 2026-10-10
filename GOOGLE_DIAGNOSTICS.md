# Google search diagnostics

## Veyra configuration and error behavior

The active web-search module supports Google Custom Search JSON API only when both a key (`GOOGLE_SEARCH_API_KEY` or `GOOGLE_API_KEY`) and a search-engine identifier (`GOOGLE_SEARCH_CX` or `GOOGLE_CSE_ID`) are configured. Missing configuration is skipped as `not-configured`; it does not disable unrelated providers. Credential values are not included in Veyra provider diagnostics or logs.

The active module classifies challenge, consent, forbidden, rate-limited, upstream, timeout, DNS/TLS/network, malformed, HTTP and empty outcomes. Deterministic regression assertions cover classification and skip/fallback behavior without exercising Google's live API or quota.

## Bounded direct smoke check

`node scripts/network-diagnostics.js --route=direct` was run once on 2026-10-10. The sandbox resolved `www.google.com`; a direct Google HTML search response returned HTTP 200 (2,008 ms) but the diagnostic HTML result extractor recognized **0** result links. The command reported the classification as a response and extraction as `empty-or-unrecognized`. This is a homepage/search-HTML reachability observation—not proof of valid Veyra search results.

The Google Custom Search API was **not configured** in this environment. No API key/CX validation, API request, quota test or actual `/api/search/web` Google-provider result was performed. Google API configuration, homepage reachability, HTML search parsing and actual Veyra API results remain distinct checks.

No Google HTML scraping provider, CAPTCHA solver, proxy rotation, access-control bypass or repeated retry behavior was added. Where automated access is challenged, the route should stop and report degraded status.

Official troubleshooting reference: https://support.google.com/websearch/answer/86640
