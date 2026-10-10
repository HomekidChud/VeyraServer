"use strict";
const assert = require("assert");

// Keep route integration coverage fully local and side-effect-free.
for (const name of ["OPENAI_API_KEY", "OPENAI_API_BASE", "GOOGLE_SEARCH_API_KEY", "GOOGLE_API_KEY", "GOOGLE_SEARCH_CX", "GOOGLE_CSE_ID", "BRAVE_SEARCH_API_KEY", "BING_SEARCH_API_KEY"]) delete process.env[name];
process.env.WEB_SEARCH_ORDER = "google";
process.env.VEYRA_CHROMIUM_ENABLED = "false";
process.env.INDEX_AI_FINDINGS = "false";
process.env.AI_ANSWER_ALLOW_EXTRACTIVE_FALLBACK = "true";

const { app, indexDocument, mongoStore, CFG } = require("../src/server");
(async () => {
  assert.equal(CFG.browserEnabled, false, "Chromium remains opt-in for ordinary server/search routes");
  mongoStore.enabled = false;
  mongoStore.uri = "";
  let webSearchCalls = 0;
  app.locals.veyraWebSearch = {
    async search(query, options) {
      webSearchCalls += 1;
      if (query === "mock web route query") {
        assert.equal(options.engine, "bing");
        return { provider: "mock-provider", results: [{ url: "https://search-fixture.example/result", title: "Mock result", snippet: "Controlled route fixture", provider: "mock-provider" }], attempts: [{ provider: "mock-provider", count: 1 }] };
      }
      return { provider: "none", results: [], attempts: [{ provider: "none", skipped: "test-fixture" }] };
    }
  };

  const url = "https://fixture-search-route.test/veyra-local-answer";
  const article = `<!doctype html><html><head><title>Veyra local route fixture</title><meta name="description" content="Local route integration fixture"></head><body><main><h1>Veyra local route fixture</h1><p>The Veyra local route fixture confirms the answer endpoint can reuse indexed article text without another page fetch.</p><p>Stored source text retains its canonical URL, provider attribution, extraction status and exact passage offsets for citation checks.</p></main></body></html>`;
  assert(indexDocument(url, article), "fixture article should enter the in-memory local index");
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const webResponse = await fetch(`${base}/api/search/web?q=mock%20web%20route%20query&engine=bing`);
    const webPayload = await webResponse.json();
    assert.equal(webResponse.status, 200);
    assert.equal(webPayload.ok, true);
    assert.equal(webPayload.provider, "mock-provider");
    assert.equal(webPayload.results[0].url, "https://search-fixture.example/result");
    assert.equal(webPayload.source, "web");
    assert.equal(webSearchCalls, 1);

    const answerResponse = await fetch(`${base}/api/search/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "What does the Veyra local route fixture confirm?" })
    });
    const answer = await answerResponse.json();
    assert.equal(answerResponse.status, 200);
    assert.equal(answer.hasAnswer, true);
    assert.equal(answer.generatedBy, "local-grounded-fallback");
    assert.equal(answer.sources.some(source => source.provider === "veyra-index"), true);
    assert.equal(answer.pipeline.sourceRetrieval.localCandidates > 0, true);
    assert.equal(answer.pipeline.sourceRetrieval.external.fetched, 0, "controlled provider mock must not fetch external pages");
    assert.equal(Number.isFinite(answer.pipeline.responseTimeMs), true);
    assert.equal(answer.responseTimeMs, answer.pipeline.responseTimeMs);
    assert.equal(Number.isFinite(answer.pipeline.sourceRetrieval.localSearchMs), true);
    assert.equal(answer.grounding.claims.every(claim => claim.sourceIds.length > 0), true);
    assert.equal(webSearchCalls, 2);

    let oembedCalls = 0;
    app.locals.veyraYoutubeFetch = async (target) => {
      oembedCalls += 1;
      assert.match(target, /^https:\/\/www\.youtube\.com\/oembed\?/);
      return { status: 200, json: async () => ({ title: "Mock Shorts title", author_name: "Mock channel", thumbnail_url: "https://img.youtube.com/vi/abcDEF12345/0.jpg" }) };
    };
    const youtubeResponse = await fetch(`${base}/api/youtube/resolve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://www.youtube.com/shorts/abcDEF12345?t=42&list=PLtest123" })
    });
    const youtube = await youtubeResponse.json();
    assert.equal(youtubeResponse.status, 200);
    assert.equal(youtube.ok, true);
    assert.equal(youtube.kind, "shorts");
    assert.equal(youtube.isShortsUrl, true);
    assert.equal(youtube.startSeconds, 42);
    assert.equal(youtube.title, "Mock Shorts title");
    assert.equal(youtube.metadataSource, "youtube-oembed");
    assert.equal(youtube.playbackVerified, false, "oEmbed metadata must not be described as playback verification");
    assert.equal(oembedCalls, 1);

    app.locals.veyraYoutubeFetch = async () => ({ status: 403, json: async () => ({}) });
    const unavailableResponse = await fetch(`${base}/api/youtube/resolve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://youtu.be/abcDEF12345" })
    });
    const unavailable = await unavailableResponse.json();
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.code, "YOUTUBE_EMBED_DISABLED");
    assert.equal(unavailable.playbackVerified, false);
    assert.equal(Object.hasOwn(unavailable, "stack"), false);
    console.log("Search, answer and YouTube Express routes passed controlled local integration tests");
  } finally {
    delete app.locals.veyraWebSearch;
    delete app.locals.veyraYoutubeFetch;
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
