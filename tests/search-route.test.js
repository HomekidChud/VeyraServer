"use strict";
const assert = require("assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Keep route integration coverage fully local and side-effect-free.
for (const name of ["AI_API_KEY", "AI_API_BASE_URL", "AI_API_URL", "AI_API_PATH", "AI_API_KEY_HEADER", "AI_API_KEY_PREFIX", "AI_API_HEADERS_JSON", "AI_API_TOKEN_FIELD", "AI_API_STRUCTURED_OUTPUT", "AI_API_OPTIONS_JSON", "AI_API_REQUEST_TEMPLATE_JSON", "AI_API_RESPONSE_PATH", "AI_PROVIDER", "AI_PROVIDER_NAME", "AI_ANSWER_MODEL", "OPENAI_API_KEY", "OPENAI_API_BASE", "GROQ_API_KEY", "GOOGLE_SEARCH_API_KEY", "GOOGLE_API_KEY", "GOOGLE_SEARCH_CX", "GOOGLE_CSE_ID", "BRAVE_SEARCH_API_KEY", "BING_SEARCH_API_KEY"]) delete process.env[name];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-search-route-"));
process.env.VEYRA_DATA_DIR = dataDir;
delete process.env.MONGODB_URI;
process.env.ACCESS_GATE = "0";
process.env.VEYRA_ALLOW_SIGNUP = "1";
process.env.VEYRA_SIGNUP_KEY = "";
process.env.VEYRA_TEST_MODE = "0";
process.env.WEB_SEARCH_ORDER = "google";
process.env.VEYRA_CHROMIUM_ENABLED = "false";
process.env.INDEX_AI_FINDINGS = "true";
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
        assert.equal(options.limit, 20, "Veyra web search should request 20 results by default");
        return { provider: "mock-provider", results: [{ url: "https://search-fixture.example/result", title: "Mock result", snippet: "Controlled route fixture", provider: "mock-provider" }], attempts: [{ provider: "mock-provider", count: 1 }] };
      }
      if (query === "private fixture") {
        assert.equal(options.noCache, true);
        return { results: [{ url: "https://search-fixture.example/private", title: "Private fixture" }] };
      }
      assert.equal(options.limit, 20, "answer discovery should request 20 provider results");
      return { provider: "mock-provider", results: [
        { url: "https://search-fixture.example/result", title: "Mock web result", snippet: "Controlled external discovery result", provider: "mock-provider" },
        { url: "https://second-search-fixture.example/result", title: "Second web result", snippet: "Another independently indexed candidate", provider: "mock-provider" }
      ], candidates: [
        { url: "https://search-fixture.example/result", title: "Mock web result", snippet: "Controlled external discovery result", provider: "mock-provider" },
        { url: "https://second-search-fixture.example/result", title: "Second web result", snippet: "Another independently indexed candidate", provider: "mock-provider" }
      ], attempts: [{ provider: "mock-provider", count: 2 }] };
    }
  };
  let crawlCalls = 0, crawlArgs = null;
  app.locals.veyraNeuralRobotPool = { async startCrawl(seeds, query, options) { crawlCalls += 1; crawlArgs = { seeds, query, options }; return [{ status: "fulfilled" }]; } };

  const url = "https://fixture-search-route.test/veyra-local-answer";
  const article = `<!doctype html><html><head><title>Veyra local route fixture</title><meta name="description" content="Local route integration fixture"></head><body><main><h1>Veyra local route fixture</h1><p>The Veyra local route fixture confirms the answer endpoint can reuse indexed article text without another page fetch.</p><p>Stored source text retains its canonical URL, provider attribution, extraction status and exact passage offsets for citation checks.</p></main></body></html>`;
  assert(indexDocument(url, article), "fixture article should enter the in-memory local index");
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const signup = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "search-fixture@example.test", password: "fixture-search-only-42" })
    });
    const login = await signup.json();
    assert.equal(signup.status, 201, JSON.stringify(login));
    assert.ok(login.token, "the regular fixture account can sign in");
    const authorization = `Bearer ${login.token}`;
    const webResponse = await fetch(`${base}/api/search/web?q=mock%20web%20route%20query&engine=bing`, { headers: { authorization } });
    const webPayload = await webResponse.json();
    assert.equal(webResponse.status, 200);
    assert.equal(webPayload.ok, true);
    assert.equal(webPayload.provider, "mock-provider");
    assert.equal(webPayload.results[0].url, "https://search-fixture.example/result");
    assert.equal(webPayload.source, "web");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(crawlCalls, 1, "relevant external search results should be sent to the bounded background index crawler");
    assert.deepEqual(crawlArgs.seeds, ["https://search-fixture.example/result"]);
    assert.equal(crawlArgs.query, "mock web route query");
    assert.ok(crawlArgs.options.maxPages <= CFG.indexAiMaxPages);
    assert.equal(webSearchCalls, 1);
    for (const [suffix, headers] of [["", {}], ["&private=1", { authorization }]]) {
      const privateResponse = await fetch(`${base}/api/search/web?q=private%20fixture${suffix}`, { headers });
      assert.equal(privateResponse.headers.get("cache-control"), "no-store");
      assert.equal((await privateResponse.json()).results.length, 1);
      assert.equal(crawlCalls, 1, "private searches are not queued for indexing");
    }
    const guestAnswer = await (await fetch(`${base}/api/search/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "private fixture" }) })).json();
    assert.equal(guestAnswer.hasAnswer, false, "guest answer is not generated or retained");

    const answerResponse = await fetch(`${base}/api/search/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ query: "What does the Veyra local route fixture confirm?" })
    });
    const answer = await answerResponse.json();
    assert.equal(answerResponse.status, 200);
    assert.equal(answer.hasAnswer, true);
    assert.equal(answer.generatedBy, "local-grounded-fallback");
    assert.equal(answer.sources.some(source => source.provider === "veyra-index"), true);
    assert.equal(answer.searchResults.some(source => source.provider === "mock-provider"), true, "web search results should remain available separately when answer generation has no configured model");
    assert.equal(answer.searchResults.length, 2, "external result discovery should not be truncated to only the top few answer-crawl candidates");
    assert.equal(answer.pipeline.sourceRetrieval.localCandidates > 0, true);
    assert.equal(answer.pipeline.sourceRetrieval.external.fetched, 0, "controlled provider mock must not fetch external pages");
    assert.equal(Number.isFinite(answer.pipeline.responseTimeMs), true);
    assert.equal(answer.responseTimeMs, answer.pipeline.responseTimeMs);
    assert.equal(Number.isFinite(answer.pipeline.sourceRetrieval.localSearchMs), true);
    assert.equal(answer.grounding.claims.every(claim => claim.sourceIds.length > 0), true);
    assert.equal(webSearchCalls, 4);

    const scopedWeb = await (await fetch(`${base}/api/search/web?q=${encodeURIComponent("site:search-fixture.example controlled")}`)).json();
    assert.deepEqual(scopedWeb.results.map(row => row.url), ["https://search-fixture.example/result"]);
    assert.deepEqual(scopedWeb.siteFilter.include, ["search-fixture.example"]);
    assert.equal(scopedWeb.total, null);
    const invalidWeb = await (await fetch(`${base}/api/search/web?q=${encodeURIComponent("site: controlled")}`)).json();
    assert.equal(invalidWeb.siteFilter.invalid, true);
    assert.deepEqual(invalidWeb.results, []);
    assert.equal(webSearchCalls, 5, "invalid scopes do not call upstream providers");
    const scopedIndex = await (await fetch(`${base}/api/search?q=${encodeURIComponent("site:fixture-search-route.test -site:fixture-search-route.test fixture")}`)).json();
    assert.deepEqual(scopedIndex.results, []);
    const scopedAnswer = await (await fetch(`${base}/api/search/answer`, {
      method: "POST", headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ query: "site:fixture-search-route.test What does the Veyra local route fixture confirm?", results: [
        { url, contentText: article },
        { url: "https://outside.example/", contentText: article },
        { url: "https://fixture-search-route.test/fake", canonicalUrl: "https://outside.example/", contentText: article }
      ] })
    })).json();
    assert.equal(scopedAnswer.hasAnswer, true);
    assert.deepEqual(scopedAnswer.sources.map(row => row.url), [url]);

    let verticalCalls = 0, activeVerticalCalls = 0, peakVerticalCalls = 0;
    app.locals.veyraVerticalSearch = {
      async search(type, query, options) {
        verticalCalls++;
        if (options.preview) {
          assert.equal(options.noCache, true, "guest category previews cannot use shared caches");
          peakVerticalCalls = Math.max(peakVerticalCalls, ++activeVerticalCalls);
          await new Promise(resolve => setImmediate(resolve));
          activeVerticalCalls--;
        }
        if (type === "news") throw Error("provider unreachable");
        if (type === "research") return { type, status: "empty", results: [] };
        const candidate = { url: "https://public.example/vertical-result", provider: "fixture", title: "Provider title is not evidence", snippet: "Provider snippet is not evidence" };
        return { type, status: "ok", provider: "fixture", results: Array(4).fill(candidate) };
      }
    };
    const aggregateResponse = await fetch(`${base}/api/search/vertical?type=all&q=category+fixture`);
    assert.equal(aggregateResponse.headers.get("cache-control"), "no-store");
    const aggregate = await aggregateResponse.json();
    assert.deepEqual(aggregate.sections.map(s => s.type), ["images", "videos", "news", "shopping", "research", "discussions"]);
    assert.equal(aggregate.sections[0].results.length, 3);
    assert.equal(aggregate.sections[2].status, "unavailable");
    assert.equal(aggregate.sections[4].status, "empty");
    assert.equal(peakVerticalCalls, 3);
    assert.equal((await fetch(`${base}/api/search/vertical?type=images&page=1&q=category`)).status, 400);
    assert.equal((await fetch(`${base}/api/search/vertical?type=images&page=4&provider=fixture&q=category`)).status, 400);
    const getSummary = async (body, { suffix = "", headers = { authorization } } = {}) => (await fetch(`${base}/api/search/answer${suffix}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
    })).json();
    assert.equal((await getSummary({ query: "category fixture", vertical: "videos" }, { headers: {} })).hasAnswer, false);
    assert.equal((await getSummary({ query: "category fixture", vertical: "videos" }, { suffix: "?private=1" })).hasAnswer, false);
    assert.equal(verticalCalls, 6, "private and guest summarization do not look up categories");
    assert.equal((await getSummary({ query: "category fixture", vertical: "research" })).hasAnswer, false);
    assert.equal((await getSummary({ query: "site:outside.example category fixture", vertical: "images" })).hasAnswer, false);
    app.locals.veyraAnswerEngine = {
      async answer(query, results, options) {
        assert.equal(query, "category fixture");
        assert.equal(options.requirePageEvidence, true);
        assert.equal(options.vertical, "videos");
        assert.ok(results.length > 0);
        assert.ok(results.every(row => row.url === "https://public.example/vertical-result" && !row.contentText && !row.snippet && !row.title));
        return { hasAnswer: false, reason: "No readable source evidence found" };
      }
    };
    const categoryAnswer = await getSummary({ query: "category fixture", vertical: "videos", results: [{ url: "https://evil.example/", contentText: "Untrusted text" }] });
    assert.equal(categoryAnswer.hasAnswer, false);
    assert.equal(categoryAnswer.vertical, "videos");

    assert.match(answer.observationId, /^obs_[A-Za-z0-9_-]{20,40}$/);
    assert.equal(answer.qualityLearning.calibrated, false, "the learned quality estimate must not be presented as calibrated confidence");
    const feedbackBody = JSON.stringify({ observationId: answer.observationId, rating: "unhelpful" });
    const postFeedback = (suffix, headers) => fetch(`${base}/api/search/answer/feedback${suffix}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: feedbackBody });
    assert.equal((await postFeedback("", {})).status, 401);
    assert.equal((await postFeedback("?private=1", { authorization })).status, 401);
    const anotherAccount = await (await fetch(`${base}/api/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "other-search-fixture@example.test", password: "another-fixture-42" }) })).json();
    assert.ok(anotherAccount.token);
    assert.equal((await postFeedback("", { authorization: `Bearer ${anotherAccount.token}` })).status, 410);
    const feedbackResponse = await postFeedback("", { authorization });
    const feedback = await feedbackResponse.json();
    assert.equal(feedbackResponse.status, 200);
    assert.equal(feedback.trained, true);
    assert.equal(feedback.optimizer, "AdamW");
    assert.ok(feedback.scoreAfter < feedback.scoreBefore, "unhelpful feedback should lower the predicted quality for that profile");
    const replay = await postFeedback("", { authorization });
    assert.equal(replay.status, 409, "the same answer feedback token cannot train the model twice");
    const aiStatus = await (await fetch(`${base}/api/answer/status`)).json();
    assert.equal(aiStatus.qualityLearning.trainingExamples, 1);

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
    delete app.locals.veyraVerticalSearch;
    delete app.locals.veyraAnswerEngine;
    delete app.locals.veyraNeuralRobotPool;
    delete app.locals.veyraYoutubeFetch;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
