# Search privacy modes

Built-in search accepts a `privacy` query parameter on Web, Index, category, suggestion and correction requests, and a `privacy` body field for answers. Omitted or invalid values resolve to Filtered.

| Value | Effect |
|---|---|
| `filtered` | Hides known adult hosts, results marked adult by a provider where those labels are available, and explicit searches scoped to a known adult host. |
| `blocked` | Applies Filtered and also rejects searches with exact known adult destinations as separate URL/host tokens before dispatch to upstream providers. |
| `restricted` | Applies Filtered to public results. Separately enables the publisher flow only when the server is configured with a current, approved catalog and the user signs in and verifies their age. |
| `unfiltered` | Opts out of Veyra's public-result filter only. It does not change upstream filtering, make unavailable media appear, or grant publisher access. |

These rules are based on known domains and labels, not a comprehensive classification or parental-control policy. They do not control Fast Proxy navigation, history, retention or incognito. Private searches still use their existing isolation, and cannot start the publisher flow. See [publisher catalog access](publisher-media-search.md) for the independent approval and signed-decision requirements.
