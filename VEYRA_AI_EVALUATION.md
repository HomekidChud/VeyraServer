# Veyra AI Evaluation

## Test commands

```bash
cd VeyraServer
npm test
```

## Results

- `node --check src/services/ai-answer.js`: passed.
- Repository JavaScript syntax validation: passed, 38 files validated.
- `tests/ai-answer.test.js`: passed.
- `tests/neural-crawler.test.js`: passed.

The deterministic test covers:

- Removal of navigation, duplicate dictionary UI, audio-player text and repeated paragraphs.
- Detection of duplicate extracted content.
- Tracking-parameter and fragment URL normalization.
- Removal of script/configuration contamination.
- Near-identical evidence suppression.
- Citation support validation and bounded evidence-quality scoring.
- Full extracted page text is passed to synthesis within a bounded aggregate; answer formatting is normalized, paraphrases are citation-checked against document sentences, and copied sentences are rejected.
- Model failure or unsupported paraphrases abstain by default rather than displaying verbatim passages; extractive fallback is explicit diagnostic opt-in.
- Complementary source pages remain separate even when their opening sentence is similar.
- A simulated original-wording answer grounded in the page is accepted; an unsupported claim and the default verbatim fallback are rejected.
- Query-aware neural crawler scoring, absolute seed canonicalization and removal of navigation/cookie boilerplate before indexing.

## Baseline versus updated behavior

| Area | Baseline | Updated implementation |
|---|---|---|
| Web extraction | Regex flattening of HTML | DOM-aware structural extraction plus block deduplication |
| Evidence count | Result/page count could be conflated | Retrieved, fetched, selected and independent counts are distinct in `pipeline` |
| Duplicates | URL-only result dedupe | URL normalization, content hashes and near-duplicate suppression |
| Synthesis | Model could return arbitrary confidence | Native model receives structured evidence; score is computed server-side |
| Verification | Citation ID existence only | Invalid citations removed; supported/unsupported claims reported |
| UI label | Percentage confidence | Evidence-quality label with transparent basis available in response |

No claim is made here about a production accuracy uplift because a labeled benchmark and live provider fixtures were not available in the repository. The score must not be interpreted as a calibrated probability.

## Live indexing smoke test

A bounded crawl of the public Wikipedia photosynthesis page completed successfully and inserted one normalized document into the local Veyra Index. A subsequent Veyra Index query returned the indexed document with a cleaned content snippet rather than the page's navigation dump. The crawler uses configurable budgets (`INDEX_AI_MAX_PAGES`, default 24, and `INDEX_AI_MAX_DEPTH`, default 2); production scale depends on configured seeds, crawl capacity, robots permissions and persistence availability.

The answer endpoint abstains when native neural synthesis cannot produce a cited, grounded paraphrase. Full extracted text from the selected pages is sent within a bounded context budget; exploratory queries request a longer overview. Verbatim extracts are never silently presented as the default Veyra AI answer. Extractive fallback is available only when explicitly enabled for diagnostics.

## Recommended next evaluation stage

Add reviewed fixtures for definitions, conflicts, current facts, insufficient evidence, malicious source instructions and provider failures. Compare the same fixtures before and after this pipeline using citation correctness, unsupported-claim rate, extraction quality and latency.
