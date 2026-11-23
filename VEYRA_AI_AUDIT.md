# Veyra AI Audit

## Scope

Audit performed on **2026-10-09** against the active `VeyraServer` and `VeyraBrowser` repositories. Backup repositories were not inspected or modified.

## Actual execution path

1. `POST /api/search/answer` in `src/server.js` receives the query and browser search results.
2. `AIAnswerEngine.answer()` normalizes URLs, fetches up to eight pages, builds evidence, then chooses native OpenAI-compatible synthesis or a local fallback.
3. The answer is returned to the browser with citations embedded as `[S#]` and a source list.
4. `VeyraBrowser/web/src/app.js` renders the answer card and source chips.

## Baseline defects

- HTML was reduced with broad regular expressions. Navigation, audio controls, duplicate headings, accessibility text and dictionary UI could remain in evidence.
- Results were not normalized for tracking URLs and independent source identity.
- Near-identical or syndicated passages were counted as separate corroboration.
- The model was asked to return a confidence number, and the server passed it through. This was not calibrated and had no measurable basis.
- Visible source fallback could expose sources that were not cited by the generated answer.
- Verification only checked that citation IDs existed; it did not report unsupported claims.
- The browser presented the value as a percentage confidence, implying a calibrated probability.
- Existing tests only syntax-checked JavaScript and did not exercise the answer pipeline.

## Constraints preserved

The existing endpoint, response fields, search provider, native model path, authentication/security boundaries and browser UI structure remain intact. New fields are additive and backward-compatible.
