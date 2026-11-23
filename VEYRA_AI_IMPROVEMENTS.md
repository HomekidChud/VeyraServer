# Veyra AI Improvements

## Implemented

- DOM-aware extraction with Cheerio that removes scripts, styles, navigation, forms, cookie/ad/social regions and hidden accessibility blocks.
- Block-level extraction preserving headings, paragraphs, lists, definitions, table cells and useful reference structure.
- Repeated block removal and boilerplate filtering for dictionary-style pages, including audio-player and “Add to word list” contamination.
- URL normalization that removes fragments and common tracking parameters without changing the resource host/path.
- Search-result normalization with stable rank, title, snippet and source identity.
- Exact content-hash and near-duplicate passage suppression. Sources from the same host are retained as related evidence but are not treated as independent corroboration.
- Passage ranking using query/subject coverage, intent cues and passage quality instead of passing full pages to the model.
- Grounded native-model prompt that clearly separates the user question from untrusted source evidence and requires citations per factual claim.
- Model-provided confidence has been removed from the synthesis contract. The server now calculates an explicit **evidence-quality score** from claim coverage, relevance, extraction quality and independent-source count.
- Claim-level validation records supported and unsupported sentence counts and removes invalid citation IDs.
- Response now exposes `confidenceLabel`, `confidenceBasis`, `grounding` details and pipeline counts while retaining the legacy numeric `confidence` field for clients.
- The browser AI card now shows the evidence-quality label rather than an uncalibrated percentage.
- Added deterministic regression coverage for raw webpage contamination, duplicate evidence, URL normalization and citation verification.

## Neural index crawler extension

The existing neural robot pool now feeds the Veyra Index instead of only logging discovered pages. AI-selected answer sources automatically become bounded crawl seeds when `INDEX_AI_FINDINGS=true` (the default), with a configurable page budget and depth. A manual `POST /api/neural/index` route is also available for administrators or controlled indexing jobs. Each indexed page stores normalized metadata, cleaned text, a content hash, query relevance and neural score; raw pages are never returned as an answer dump. Link scheduling combines the existing neural URL score with query-term relevance, respects robots rules and keeps crawl budgets bounded.

The previous absolute-seed canonicalization bug was fixed, and indexed crawler text now removes navigation, cookie, advertisement, social, audio and dictionary UI boilerplate before it enters the search index.

Neural synthesis now requires cited multi-source output when independent evidence exists. If the native model is unavailable or fails those checks, Veyra abstains instead of displaying copied raw snippets. The old extractive fallback remains opt-in through `AI_ANSWER_ALLOW_EXTRACTIVE_FALLBACK=true` for controlled diagnostics only.

## Deliberate limitations

The score is explicitly not a calibrated probability. A statistically calibrated confidence model requires a reviewed, labeled evaluation set and repeated measurement. Claim verification is transparent citation/coverage checking; it is not a semantic entailment model. No external model was substituted for Veyra’s configured native model.
