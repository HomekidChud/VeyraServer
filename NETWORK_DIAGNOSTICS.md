# Network diagnostics

**Endpoint-check run:** `node scripts/network-diagnostics.js --route=direct`
**Time:** 2026-10-10 16:29:13 UTC (17:29:13 +01:00)
**Route:** direct; no proxy configured. Each diagnostic endpoint was requested at most once. The runner caps request time at 5 seconds and reads at most 128 KiB per response.

## Observed endpoint results

| Check | Result | Interpretation |
|---|---|---|
| Public IPv4 endpoint | Success; `200.53.207.95` (1,637 ms) | IPv4 egress worked for this run. No network class is inferred. |
| Public IPv6 endpoint | Failed with `ENETUNREACH` (11 ms) | This sandbox had no usable IPv6 route during the check. |
| Proxy | Not configured | No proxy endpoint/egress comparison was possible. |
| Expected egress | Not configured | No match/mismatch assertion was requested. |
| DNS | Google, Bing and DuckDuckGo hostnames all resolved | DNS worked for these lookups at the observed time. |
| Google HTML search | HTTP 200; 2,008 ms; page response classified; 0 result links extracted | Reachability is distinct from usable search results. The parser did not recognize/extract results in this response. |
| Bing HTML search | HTTP 200; 2,239 ms | This diagnostic confirms an HTTP response only; it is distinct from the actual Veyra route smoke below. |
| DuckDuckGo HTML search | HTTP 200; 1,691 ms; classified as `challenge` | Automated HTML search was challenged. No retries, proxy rotation or challenge bypass were attempted. |
| Google Custom Search API | Not configured | Google API key and search-engine identifier were not both present. |
| Residential classification | Not classified | IP connectivity/address alone is insufficient evidence of residential allocation. |

## Actual Veyra route smoke

At approximately 2026-10-10 18:19 +01:00, one separate bounded request exercised the actual local Express route `/api/search/web` with `engine=bing` and a Veyra crawler/search query. No API key was configured or needed for Bing HTML mode.

Observed result: **HTTP 200**, `ok: true`, **provider `bing`**, **10 results**, **2,663 ms** total route response, and **2,661 ms** provider-reported latency. The single-sample p50/p95 were both 2,661 ms. This confirms that one live Veyra route call returned results through this direct sandbox path. It is one sample only; it does not establish uptime, quality, deployment behavior, baseline speedup, or residential status. No `/api/search/answer` request fetched external pages during this smoke.

At approximately 2026-10-10 18:32 +01:00, a one-page crawl of Wikipedia's public Main Page was run through the actual local Express `/api/robots/crawl` route (`maxPages: 1`, depth 1, query `Wikipedia main page`). The robot checked `robots.txt` before fetching; Chromium and Mongo persistence were disabled. Result: **HTTP 200**, one page fetched, zero crawler errors, page fetch/parse latency **240 ms**, total route wall time **301 ms**, **252,676 bytes** received, 79 links found, and 5,000 extracted text characters (the crawler's per-page extraction cap). These are sandbox single-sample results; they include neither a deployment round trip nor a multi-page/load test and do not represent repeatable network performance.

## Interpretation and repeatable command

The direct IPv4/IPv6 service results, DNS answers, raw provider HTML checks and Veyra's actual configured route are separate tests. This run does not classify the connection as residential. The sandbox's observations should not be generalized to a deployment or a user's network.

```bash
npm run diagnostics:network -- --route=direct
```

Use `--route=proxy` only with an authorized configured proxy; use `EXPECTED_EGRESS_IP` only when a known expected address is available. The command deliberately reports `residential: not-classified` and does not circumvent CAPTCHA, unusual-traffic or rate-limit responses. Diagnostic output excludes cookies and authorization headers.
