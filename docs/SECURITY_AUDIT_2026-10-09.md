# Veyra Security Audit — 2026-10-09

> **Scope:** `HomekidChud/VeyraBrowser` and `HomekidChud/VeyraServer`, with emphasis on extension intake, browser extension execution, API authorization, AI assistance boundaries, and dependency health.
>
> **Assessment type:** targeted source review plus automated regression and local API integration testing. This is not a penetration test, compliance certification, or a claim that a running deployment is secure without its production configuration.

## Executive summary

The prior extension store already attempted a CSS-only policy, but it had no submission lifecycle, no reviewer separation, limited manifest validation, no authoritative store audit record, and the browser installed the pre-verification object instead of the server-normalized object. Developer scripts could also be included in account synchronization, which made script propagation possible across a user’s devices.

This upgrade implements a fail-closed CSS-only public Store pipeline, separates locally risky developer scripts from Store functionality, and introduces consent boundaries around the new Assistant service.

## Findings and remediation

| ID | Severity before | Finding | Remediation delivered | Verification |
|---|---:|---|---|---|
| EXT-01 | High | Store validation did not enforce an upload-to-review-to-publish lifecycle; a catalog was read directly from JSON. | Implemented `UPLOADED → VALIDATING → QUARANTINED → SCANNING → REVIEW_REQUIRED → APPROVED → PUBLISHED` state machine. Publication requires a distinct administrator reviewer. | Unit test and local API lifecycle test |
| EXT-02 | High | Client verified a package but installed the original object, permitting metadata/provenance drift between verification and installation. | Client installs the server-returned normalized package after server re-verification. | Browser source verification and implementation review |
| EXT-03 | High | Extension package shape was permissive enough to lack robust virtual file, unknown field, capability, and match-pattern enforcement. | JSON-only schema with one `style.css`, strict field/capability allowlist, bounded patterns, size limits, canonical integrity record. | `extension-security.test.js` |
| EXT-04 | High | No modeled archive/binary path made it easy for a future uploader to add unsafe extraction. | Archive/binary endpoint explicitly returns `415`; the Store accepts no archive parser or binary. | `/api/extensions/policy` integration check |
| EXT-05 | Medium | Store UI used static `rating` and `installs` values not established as telemetry. | Removed Store popularity/rating presentation; UI shows security evidence, publisher, scope, scan, signature state, and integrity prefix. | Browser source review |
| EXT-06 | High | Local developer scripts could be present in account synchronization data. | Scripts and local-only entries are excluded from push and rejected on pull. Runtime requires `localOnly` for script execution. | Browser source review |
| EXT-07 | Medium | `GM_addStyle` was size-limited but did not repeat CSS remote-resource denial. | Added CSS remote/resource denial in the runtime bridge. | Browser/bridge regression checks |
| EXT-08 | Medium | Mutable neural crawler and challenge endpoints were not consistently authenticated. | Feedback/crawl/index/challenge solve require a user; neural and robot reset endpoints require an administrator. | Server source verification |
| AI-01 | High if enabled without boundaries | A multi-agent Assistant could silently pull browsing context or retain prompts. | Assistant has no browser tool, requires explicit pasted-context consent, has bounded input/output, per-user limits, timeout, and disabled-by-default provider configuration. | `veyra-assistant.test.js` and server unavailable-path test |
| AI-02 | Medium | “Training” could imply automatic retention/fine-tuning without user consent. | Feedback storage requires explicit opt-in, expires by retention policy, and is labelled `PENDING_HUMAN_REVIEW`; automatic training is false. | Assistant regression test |

## Implemented security controls

### Extension intake and publication

- Transport is JSON only; archives and binary packages are rejected rather than parsed.
- The only accepted package file is the virtual `style.css` entry.
- CSS is bounded to 120 KB and blocks imports, URLs, JavaScript URI patterns, CSS expressions, Mozilla binding, behavior properties, namespaces, and remote font declarations.
- Manifest fields and executable/browser capability fields are denied by default.
- Valid package contents are canonicalized and SHA-256 hashed server-side.
- Optional Ed25519 verification can be enforced through `VEYRA_EXTENSION_REQUIRE_SIGNATURE=true` and `VEYRA_EXTENSION_TRUSTED_KEYS_JSON`.
- New packages enter quarantine, record transition events, pass static policy checks, then await a separate administrator’s review and publication action.
- Publisher and reviewer identities are recorded in persisted state; there is no publisher delete endpoint.

### Client and developer-mode separation

- Browser Store installation re-checks a package against the server and uses the normalized response.
- Users must review the CSS-only capability, match scope, publisher, PASS verdict, and integrity prefix before installation.
- Store pages no longer show fabricated popularity information.
- Local developer scripts are never Store packages, never account-synced, require a user warning, and are denied if they include common network, cookie, worker, or dynamic-code primitives.
- The server-side page bridge repeats the local-only and content checks, including CSS rules passed through `GM_addStyle`.

### Veyra Assistant controls

- Disabled until API key, API base, and model environment variables are all present.
- Uses two independent analysts and one verifier; no raw private reasoning is returned.
- Explicit context consent; the server rejects context without it.
- No browser page access, tool access, cookie access, credential access, or automatic navigation.
- Per-user sliding-window rate limit, request size limits, output validation, and provider timeout.
- Feedback is non-retentive by default; opt-in data is bounded and placed in a human-review queue only.

## Residual risk and release conditions

| Risk | Current disposition | Required operational action |
|---|---|---|
| Developer mode executes local code in the page realm | Intentional advanced feature; not part of Store trust model | Keep developer mode off by default; use a non-sensitive test profile; consider removing the capability entirely for high-assurance deployments |
| Static CSS analysis cannot evaluate an arbitrary executable package | Avoided by rejecting executable and archive packages | Do not broaden Store acceptance without sandboxing, CDR, malware analysis, and an independent security review |
| Publisher signing is optional by default | CSS-only design and review gate still apply | Provision trusted Ed25519 keys and enforce signatures before accepting third-party publishers at scale |
| Account/admin security depends on deployment secrets | Code has gates but cannot secure empty/weak production variables | Configure strong `VEYRA_AUTH_SECRET`, `VEYRA_ADMIN_TOKEN`, TLS, backups, and restricted data-directory permissions |
| AI provider may retain data under its own contractual terms | User-approved content is sent to configured provider only | Select provider and data-processing terms deliberately; disclose them to users; do not enable Assistant until approved |
| Rate limit is in-process | Suitable for a single process only | Use a shared rate-limit store when horizontally scaling the API |

## Test evidence

| Command or check | Result |
|---|---|
| `npm test` in `VeyraServer` | Passed source verification, AI answer, neural crawler, proxy rewrite, extension security, and Assistant regression tests |
| `npm run check` in `VeyraBrowser` | Passed source, Console Lab, and extension regression checks |
| `node --check` for `src/server.js` and both new services | Passed |
| Isolated server API test | Passed policy check; blocked script submission; `REVIEW_REQUIRED → APPROVED → PUBLISHED` lifecycle; Assistant returned `503 ASSISTANT_UNAVAILABLE` without provider configuration |
| Production dependency audit (`npm audit --omit=dev`) | No production vulnerabilities reported in either repository at audit time |

## Verification caveat

The integration test used an isolated local data directory and test accounts. It proves the code path and fail-closed behavior; it does not validate production reverse-proxy rules, cloud IAM, backup access, DNS, TLS termination, model-provider data policies, or administrative operating procedures.
