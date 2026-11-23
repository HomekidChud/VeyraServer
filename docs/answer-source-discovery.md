# Source discovery for Veyra AI overviews

`POST /api/search/answer` uses `wide-v1` for signed-in overviews that identify their category. Queries without `source` and legacy follow-up callers retain their existing behavior. This widens evidence retrieval for the answer, not the ordering or latency of regular search results.

## How it works

- **Web:** Start with URL-only search-result hints, trusted matches in Veyra's index, relevant links from the editorial reference catalog, and the server's multi-provider Web search. The original Web lookup can use the existing topic-specific adapters such as Wikipedia, MDN, and Stack Exchange when eligible. Explicitly scholarly searches also try the existing Research adapter in parallel.
- **Categories:** Images, Videos, News, Shopping, Research, and Discussions discover source pages within the selected category. They do not silently switch to Web. A thumbnail, product listing snippet, paper record, or video description returned by a search provider is not page evidence. Index searches stay within the local index.
- **Second pass:** On thin coverage or a comparison, do at most one additional round. Strip introductory question wording, look up the two named sides of a comparison, or try one provider-approved next page when reformulation is inappropriate. Keep all `site:` and `-site:` restrictions. No generated query, third-party key, new crawling network, or model training is required. This is a small, bounded version of [parallel and sequential research planning](https://arxiv.org/html/2512.02038v1), not a long-running research agent.
- **Rank and read:** Fuse batches using [weighted reciprocal rank fusion](https://dl.acm.org/doi/10.1145/1571941.1572114). Deduplicate canonical URLs and supplied DOIs, give different hosts an opportunity in the shortlist, and reuse only trusted indexed text. The existing page reader applies its robots, access and concurrency rules. Fresh reads skip publisher opt-outs and non-page content; the synthesis and grounding stages work from readable text, not search snippets.
- **Answer:** Discover for up to six seconds, shortlist up to 24 candidate pages, and send up to 12 extracted, relevant sources to synthesis. Those are caps, not targets. Duplicate page content is rejected. The overview displays only sources cited by the verified answer, with the existing abstention behavior if evidence is inadequate. Host diversity is not a guarantee of editorial independence.

## Operations

`GET /api/answer/status` reports the configured source discovery strategy and shortlist limit. `pipeline.sourceRetrieval` distinguishes discovered URLs, hosts, shortlisted URLs, and batch failures. `pipeline.selected` counts relevant evidence sent to synthesis, and `sources` contains only citations retained in the answer. None of those counts are evidence of accuracy by themselves.

Each server process accepts one wide overview per account and four in total at once. When busy it returns a retryable response instead of queuing more work. Index stays local even when an indexed page has too little text. Indexed evidence relies on the stored snapshot; current publisher directives are checked on page reads, not inferred from historical text.

Set `AI_ANSWER_WIDE_DISCOVERY=0` to revert to the existing discovery path without changing the browser. The checked-in comparison fixture in `tests/ai-answer.test.js` demonstrates the difference between a small single-host result page and a broader discovery pool. This is a controlled fixture, not a live answer-quality benchmark.
