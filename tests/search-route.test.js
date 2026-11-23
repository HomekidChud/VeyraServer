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
        assert.equal(options.region, "IN");
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
  // All direct-source crawling is also fixture-backed, including the robots
  // and redirect checks in the production Fast Proxy adapter.
  const sourceCalls = [];
  app.locals.veyraSourceSearchFetch = async (url, options) => {
    sourceCalls.push(url);
    assert.equal(options.sessionId, undefined);
    assert.equal(options.headers, undefined);
    const u = new URL(url);
    assert.equal(u.search, "");
    const html = (title, content, robotsTag = "") => ({ ok: true, status: 200, finalUrl: url, contentType: "text/html", body: Buffer.from(`<title>${title}</title><main><h1>${title}</h1>${content}</main>`), robotsTag });
    if (u.pathname === "/robots.txt") {
      return { ok: true, status: 200, finalUrl: url, contentType: "text/plain", body: Buffer.from(
        u.hostname === "docs.python.org" ? "User-agent: *\nDisallow: /private/" :
          u.hostname === "slow-source.example" ? "User-agent: *\nCrawl-delay: 15" : "User-agent: *\nAllow: /") };
    }
    if (url === "https://docs.python.org/3/library/index.html") {
      return html("Python reference", '<a href="/python-frobnicator">Python frobnicator</a><a href="https://unrelated.example/python-frobnicator">Python frobnicator</a>');
    }
    if (url === "https://docs.python.org/python-frobnicator") {
      await assert.rejects(options.beforeRedirect("https://docs.python.org/private/fixture"));
      await assert.rejects(options.beforeRedirect("https://another.example/frobnicator"));
      return html("Python frobnicator reference", "<p>The Python frobnicator fixture demonstrates how to read a public reference with a relevant excerpt and without Google.</p>");
    }
    if (url === "https://evidence-source.example/frobnicator") {
      return html("Python frobnicator example", "<p>This Python frobnicator guide describes the fixture in enough detail to be used as a direct publisher excerpt.</p>");
    }
    if (url === "https://optout-source.example/frobnicator") {
      return html("Python frobnicator opt-out", "<p>This Python frobnicator fixture must never turn into a published excerpt because the publisher opted out.</p>", "nosnippet");
    }
    return { ok: false, status: 404, contentType: "text/plain", body: Buffer.alloc(0) };
  };

  const url = "https://fixture-search-route.test/veyra-local-answer";
  const article = `<!doctype html><html><head><title>Veyra local route fixture</title><meta name="description" content="Local route integration fixture"></head><body><main><h1>Veyra local route fixture</h1><p>The Veyra local route fixture confirms the answer endpoint can reuse indexed article text without another page fetch.</p><p>Stored source text retains its canonical URL, provider attribution, extraction status and exact passage offsets for citation checks.</p></main></body></html>`;
  assert(indexDocument(url, article), "fixture article should enter the in-memory local index");
  assert(indexDocument("https://fixture-search-route.test/orbital", "<!doctype html><html><head><title>Orbital lunar livestream</title></head><body><main><p>Orbital lunar livestream commentary from the lunar mission observation deck, including official schedules and an archive for offline viewing.</p></main></body></html>"));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const suggest = input => fetch(`${base}/api/search/suggest?${new URLSearchParams(input)}`);
    for (const [q, expected] of [["orbital lun", ["orbital lunar"]], ["orbital ", ["orbital lunar"]], ["site:fixture.test lun", []]]) {
      const response = await suggest({ q, limit: "1" });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual((await response.json()).suggestions, expected);
    }
    const guestSuggestions = await suggest({ q: "orbital lun", limit: "1", private: "1" });
    assert.equal(guestSuggestions.headers.get("cache-control"), "no-store");
    assert.deepEqual((await guestSuggestions.json()).suggestions, ["orbital lunar"]);
    assert.deepEqual((await (await suggest({ q: "orbital lun", incognito: "1", private: "1" })).json()).suggestions, []);
    const localResults = (await (await fetch(`${base}/api/search?q=orbital%20lunar`)).json()).results;
    assert.ok(localResults.length && localResults.every(row => Number.isInteger(row.matchPercent) && row.matchPercent >= 1 && row.matchPercent <= 100));

    const signup = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "search-fixture@example.test", password: "fixture-search-only-42" })
    });
    const login = await signup.json();
    assert.equal(signup.status, 201, JSON.stringify(login));
    assert.ok(login.token, "the regular fixture account can sign in");
    const authorization = `Bearer ${login.token}`;
    const webResponse = await fetch(`${base}/api/search/web?q=mock%20web%20route%20query&engine=bing&region=IN`, { headers: { authorization } });
    const webPayload = await webResponse.json();
    assert.equal(webResponse.status, 200);
    assert.equal(webPayload.ok, true);
    assert.equal(webPayload.provider, "mock-provider");
    assert.equal(webPayload.results[0].url, "https://search-fixture.example/result");
    assert.ok(webPayload.results[0].matchPercent > 1);
    assert.equal(webPayload.source, "web");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(crawlCalls, 1, "relevant external search results should be sent to the bounded background index crawler");
    assert.deepEqual(crawlArgs.seeds, ["https://search-fixture.example/result"]);
    assert.equal(crawlArgs.query, "mock web route query");
    assert.ok(crawlArgs.options.maxPages <= CFG.indexAiMaxPages);
    assert.equal(webSearchCalls, 1);
    const retired = await fetch(`${base}/api/search/deep?q=old+bookmark`);
    assert.equal(retired.status, 410);
    assert.equal(retired.headers.get("cache-control"), "no-store");
    assert.equal((await retired.json()).code, "SEARCH_MODE_RETIRED");
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
    const engineOverride = app.locals.veyraAnswerEngine;
    app.locals.veyraAnswerEngine = {
      async answer(_query, results) {
        assert.equal(results.length, 2);
        assert.equal(results[0].url, url);
        assert.equal(results[0].provider, "veyra-index");
        assert.match(results[0].contentText, /Veyra/);
        assert.deepEqual(results[1], { url: "https://external.example/page" });
        assert.doesNotMatch(JSON.stringify(results), /UNTRUSTED/);
        return { hasAnswer: false, reason: "Controlled provenance fixture" };
      }
    };
    const hints = await (await fetch(`${base}/api/search/answer`, {
      method: "POST", headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ query: "Veyra fixture", results: [
        { url, title: "UNTRUSTED", contentText: "UNTRUSTED" },
        { url: "https://external.example/page", title: "UNTRUSTED", snippet: "UNTRUSTED", contentText: "UNTRUSTED" }
      ] })
    })).json();
    assert.equal(hints.reason, "Controlled provenance fixture");
    app.locals.veyraAnswerEngine = engineOverride;

    let verticalCalls = 0, activeVerticalCalls = 0, peakVerticalCalls = 0;
    app.locals.veyraVerticalSearch = {
      async search(type, query, options) {
        verticalCalls++;
        if (type === "images" && query === "preview fixture") {
          assert.equal(options.requireThumbnail, true);
          return { type, status: "ok", provider: "wikimedia", nextPage: 1, results: Array.from({ length: 10 }, (_, i) => ({
            url: `https://commons.wikimedia.org/wiki/${i}`, title: "Preview fixture",
            thumbnail: i ? `https://upload.wikimedia.org/photo-${i}.jpg` : ""
          })) };
        }
        if (options.preview) {
          assert.equal(options.region, "IN");
          assert.equal(options.noCache, true, "guest category previews cannot use shared caches");
          peakVerticalCalls = Math.max(peakVerticalCalls, ++activeVerticalCalls);
          await new Promise(resolve => setImmediate(resolve));
          activeVerticalCalls--;
        }
        if (type === "news") throw Error("provider unreachable");
        if (type === "research") return { type, status: "empty", results: [] };
        if (type === "images" && !options.preview) return { type, status: "ok", provider: "image-mix", results: [
          { url: "https://images-assets.nasa.gov/first.jpg", sourcePageUrl: "https://www.nasa.gov/gallery", provider: "veyra-crawler", title: "Fixture" },
          { url: "https://images-assets.nasa.gov/second.jpg", sourcePageUrl: "https://www.nasa.gov/gallery", provider: "veyra-crawler", title: "Second fixture" }
        ] };
        const candidate = { url: "https://public.example/vertical-result", provider: "fixture", title: "Provider title is not evidence", snippet: "Provider snippet is not evidence" };
        return { type, status: "ok", provider: "fixture", results: Array(4).fill(candidate) };
      }
    };
    const aggregateResponse = await fetch(`${base}/api/search/vertical?type=all&q=category+fixture&region=IN`);
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
        assert.equal(options.requirePageEvidence, true);
        if (options.vertical === "images") {
          assert.equal(query, "category fixture");
          assert.deepEqual(results, [{ url: "https://www.nasa.gov/gallery", provider: "veyra-crawler" }]);
        } else {
          assert.equal(query, "category fixture");
          assert.equal(options.vertical, "videos");
          assert.deepEqual(results, [{ url: "https://public.example/vertical-result", provider: "fixture" }]);
        }
        return { hasAnswer: false, reason: "No readable source evidence found" };
      }
    };
    const categoryAnswer = await getSummary({ query: "category fixture", vertical: "videos", results: [{ url: "https://evil.example/", contentText: "Untrusted text" }] });
    assert.equal(categoryAnswer.hasAnswer, false);
    assert.equal(categoryAnswer.vertical, "videos");
    assert.equal((await getSummary({ query: "site:nasa.gov category fixture", vertical: "images" })).vertical, "images");
    const postFollowUp = (body, suffix = "", headers = { authorization }) => fetch(`${base}/api/search/answer${suffix}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
    });
    const chatSeed = "site:fixture-search-route.test -site:blocked.fixture-search-route.test Veyra local route fixture";
    const input = { query: chatSeed, source: "index", followUp: {
      question: "What does it confirm?", previousQuestion: "How is the route fixture indexed?", previousAnswer: "UNTRUSTED_OLD_ANSWER"
    }, results: [{ url: "https://fixture-search-route.test/forged", contentText: "UNTRUSTED_RESULT" }] };
    const beforeChat = { crawls: crawlCalls, web: webSearchCalls, vertical: verticalCalls };
    for (const [suffix, headers] of [["?incognito=1", { authorization }], ["?private=1", { authorization }], ["", {}]]) {
      assert.equal((await (await postFollowUp(input, suffix, headers)).json()).hasAnswer, false);
    }
    for (const question of ["site:outside.example A question?", "-site:fixture-search-route.test try", "x".repeat(201), " "]) {
      assert.equal((await postFollowUp({ ...input, followUp: { question } })).status, 400);
    }
    const originalChatWebSearch = app.locals.veyraWebSearch;
    app.locals.veyraAnswerEngine = {
      async answer(q, results, opts) {
        assert.match(q, /^What does it confirm\?/);
        assert.match(q, /Veyra local route fixture/);
        assert.equal(opts.noCache, true);
        assert.equal(opts.chatContext.question, input.followUp.question);
        assert.equal(opts.chatContext.previousQuestion, input.followUp.previousQuestion);
        assert.equal(opts.allowSource({ url: "https://blocked.fixture-search-route.test/fixture" }), false);
        assert.equal(opts.allowSource({ url, canonicalUrl: "https://outside.example/" }), false);
        assert.ok(results.some(row => row.url === url && row.provider === "veyra-index"));
        assert.doesNotMatch(JSON.stringify({ results, context: opts.chatContext }), /UNTRUSTED/);
        return { hasAnswer: true, answer: "Verified follow-up fixture. [S1]", sources: [{ id: "S1", url }] };
      }
    };
    const chatResponse = await postFollowUp(input);
    assert.equal(chatResponse.status, 200);
    assert.equal(chatResponse.headers.get("cache-control"), "no-store");
    const chatResult = await chatResponse.json();
    assert.equal(chatResult.hasAnswer, true);
    assert.equal(chatResult.followUp, true);
    assert.equal(chatResult.observationId, undefined);
    assert.deepEqual({ crawls: crawlCalls, web: webSearchCalls, vertical: verticalCalls }, beforeChat);
    let chatProviderCalls = 0;
    app.locals.veyraWebSearch = { async search(q, opts) {
      chatProviderCalls++;
      assert.match(q, /^site:fixture-search-route.test -site:blocked.fixture-search-route.test What does it confirm\?/);
      assert.equal(opts.noCache, true);
      return { provider: "fixture", results: [{ url: "https://outside.example/", snippet: "Not in scope" }] };
    } };
    assert.equal((await (await postFollowUp({ ...input, source: "web" })).json()).followUp, true);
    assert.equal(chatProviderCalls, 1);
    assert.equal(crawlCalls, beforeChat.crawls);
    app.locals.veyraWebSearch = originalChatWebSearch;
    const originalChatVertical = app.locals.veyraVerticalSearch;
    const testedVerticalQueries = [];
    app.locals.veyraVerticalSearch = { async search(type, q, opts) {
      assert.equal(type, "research");
      assert.equal(opts.noCache, true);
      testedVerticalQueries.push(q);
      return { provider: "fixture-research", results: q === chatSeed ? [
        { url, provider: "fixture-research" }, { url: "https://blocked.fixture-search-route.test/" }
      ] : [] };
    } };
    app.locals.veyraAnswerEngine = { async answer(_q, results, opts) {
      assert.equal(opts.requirePageEvidence, true);
      assert.deepEqual(results, [{ url, provider: "fixture-research" }]);
      return { hasAnswer: true, answer: "Verified research follow-up. [S1]", sources: [{ id: "S1", url }] };
    } };
    assert.equal((await (await postFollowUp({ ...input, vertical: "research" })).json()).followUp, true);
    assert.equal(testedVerticalQueries.length, 2);
    assert.match(testedVerticalQueries[0], /What does it confirm\?/);
    assert.equal(testedVerticalQueries[1], chatSeed);
    app.locals.veyraVerticalSearch = originalChatVertical;
    app.locals.veyraAnswerEngine = engineOverride;
    assert.equal((await fetch(`${base}/api/search/vertical?type=images&page=7&provider=image-mix&q=category`)).status, 200);
    assert.equal((await fetch(`${base}/api/search/vertical?type=images&page=9&provider=image-mix&q=category`)).status, 200);
    assert.equal((await fetch(`${base}/api/search/vertical?type=images&page=10&provider=image-mix&q=category`)).status, 400);

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

    const feedTerm = "paginatest";
    const localA = "https://feed-fixture.example/indexed-a", localB = "https://feed-fixture.example/indexed-b";
    for (const link of [localA, localB, "https://outside.example/indexed"]) {
      assert(indexDocument(link, article.replaceAll("fixture", feedTerm)));
    }
    const offsets = [];
    const crawlsBeforeFeed = crawlCalls;
    app.locals.veyraWebSearch = { async search(query, options) {
      assert.equal(query, `site:feed-fixture.example ${feedTerm}`);
      assert.equal(options.feed, true);
      assert.equal(options.reference, true);
      assert.equal(options.region, "IN");
      offsets.push(options.offset);
      const more = options.offset === 0;
      return { provider: "fixture", nextOffset: more ? 10 : null, more, results: [
        { url: `https://feed-fixture.example/provider-${options.offset}`, title: feedTerm },
        { url: "https://outside.example/", title: feedTerm }
      ] };
    } };
    const feedUrl = `${base}/api/search/web?${new URLSearchParams({ q: `site:feed-fixture.example ${feedTerm}`, feed: "1", region: "IN", limit: "1" })}`;
    const getFeed = async (offset, { privateFeed = false } = {}) => {
      const response = await fetch(`${feedUrl}&offset=${offset}${privateFeed ? "&private=1" : ""}`, { headers: { authorization } });
      assert.equal(response.status, 200);
      if (privateFeed) assert.equal(response.headers.get("cache-control"), "no-store");
      return response.json();
    };
    assert.equal((await fetch(`${feedUrl}&offset=7`)).status, 400);
    const providerStart = await getFeed(0, { privateFeed: true });
    assert.equal(providerStart.nextOffset, 10);
    const providerEnd = await getFeed(providerStart.nextOffset);
    assert.equal(providerEnd.results.length, 1);
    assert.equal(providerEnd.nextOffset, 100);
    const indexStart = await getFeed(providerEnd.nextOffset);
    assert.equal(indexStart.provider, "veyra-index");
    assert.equal(indexStart.nextOffset, 101);
    const indexEnd = await getFeed(indexStart.nextOffset);
    assert.equal(indexEnd.nextOffset, null);
    assert.deepEqual([indexStart.results[0].url, indexEnd.results[0].url].sort(), [localA, localB]);
    assert.deepEqual(offsets, [0, 10], "index pages must not call providers");
    assert.equal(crawlCalls, crawlsBeforeFeed, "private initial requests and authenticated continuations must not trigger new crawls");
    assert(indexDocument("https://one-word.example/landing", article.replaceAll("fixture", "cobalt")));
    assert(indexDocument("https://relevant.example/cobalt", article.replaceAll("fixture", "cobalt quarry")));
    const topical = await (await fetch(`${base}/api/search?q=cobalt+quarry&region=IN`)).json();
    assert.deepEqual(topical.results.map(row => row.url), ["https://relevant.example/cobalt"]);

    const getSourceResults = async (q, opts = {}) => {
      const r = await fetch(`${base}/api/search/web?${new URLSearchParams({ q, feed: "1", ...opts })}`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("cache-control"), "no-store");
      return r.json();
    };
    app.locals.veyraWebSearch = { async search() { throw new Error("All discovery providers unavailable"); } };
    const beforePrivate = sourceCalls.length;
    for (const q of ["Python asyncio", "site:docs.python.org asyncio"]) {
      const privateResult = await getSourceResults(q, { incognito: "1", private: "1", region: "IN" });
      assert.equal(privateResult.status, "ok");
      assert.equal(privateResult.provider, "veyra-reference");
      assert.equal(privateResult.results[0].url, "https://docs.python.org/3/library/asyncio.html");
      assert(privateResult.results.every(row => !Object.hasOwn(row, "evidence") && row.snippet === ""));
    }
    assert.equal(sourceCalls.length, beforePrivate, "private catalog lookup performs no publisher requests");
    assert.equal((await getSourceResults("Python asyncio -site:docs.python.org")).results.length, 0);
    assert.equal((await getSourceResults("site:elsewhere.example Python asyncio")).results.length, 0);
    const independent = await getSourceResults("site:docs.python.org Python frobnicator");
    assert.equal(independent.provider, "veyra-crawl");
    assert.equal(independent.status, "ok");
    assert.deepEqual(independent.results.map(row => [row.url, row.evidence.level]), [["https://docs.python.org/python-frobnicator", "strong"]]);
    assert.match(independent.results[0].snippet, /without Google/);
    assert(!sourceCalls.some(url => url.includes("unrelated.example")));
    app.locals.veyraWebSearch = { async search(_q, opts) {
      assert.equal(opts.noCache, true);
      const results = ["evidence-source", "slow-source", "optout-source"].map(name =>
        ({ url: `https://${name}.example/frobnicator`, title: "Python frobnicator", snippet: "Provider snippet.", source: "fixture" }));
      return { provider: "fixture", nextOffset: opts.offset ? null : 10, results };
    } };
    const mixed = await getSourceResults("Python frobnicator");
    assert.equal(mixed.nextOffset, 10);
    assert.equal(mixed.results.find(row => row.url.includes("evidence-source")).evidence.basis, "page-passage");
    assert.match(mixed.results.find(row => row.url.includes("evidence-source")).snippet, /direct publisher excerpt/);
    assert.equal(mixed.results.find(row => row.url.includes("optout-source")).evidence.basis, "excerpt-restricted");
    assert.equal(mixed.results.find(row => row.url.includes("optout-source")).snippet, "");
    assert.equal(mixed.results.find(row => row.url.includes("slow-source")).evidence.basis, "not-checked");
    assert(!sourceCalls.includes("https://slow-source.example/frobnicator"), "crawl-delay prevents a page fetch");
    const callsBeforeSkip = sourceCalls.length;
    assert((await getSourceResults("Python frobnicator", { incognito: "1" })).results.every(row => !row.evidence));
    assert((await getSourceResults("Python frobnicator", { engine: "bing" })).results.every(row => !row.evidence));
    assert((await getSourceResults("Python frobnicator", { offset: "10" })).results.every(row => row.evidence.basis === "not-checked"));
    for (const opts of [{ engine: "bing" }, { offset: "10" }]) {
      assert(!(await getSourceResults("Python asyncio", opts)).results.some(row => row.source === "veyra-reference"));
    }
    assert.equal(sourceCalls.length, callsBeforeSkip, "incognito, explicit engines and pagination do not crawl");
    app.locals.veyraWebSearch = { async search(query, options) {
      assert.ok(["google.com", "northern lights", "site:example.com"].includes(query));
      assert.equal(options.preferGoogle, query === "northern lights");
      if (query === "site:example.com") {
        assert.equal(options.domainBrowse, true);
        return { provider: "fixture", results: [
          { title: "Publisher page", url: "https://media.example.com/story",
            media: { type: "videos", thumbnail: "https://imgs.search.brave.com/story", duration: "3:35" } },
          { title: "Imposter page", url: "https://example.com.other.test/story" }
        ] };
      }
      return { provider: "none", results: [], status: "unavailable", googleConfigured: false };
    } };
    const home = await getSourceResults("search:google.com", { incognito: "1" });
    assert.equal(home.status, "ok");
    assert.equal(home.results[0].url, "https://www.google.com/");
    assert.equal(home.results[0].source, "veyra-navigation");
    const noGoogle = await getSourceResults("search:google.com northern lights", { incognito: "1" });
    assert.equal(noGoogle.preferredEngine, "google");
    assert.equal(noGoogle.googleIncluded, false);
    const scoped = await getSourceResults("search:example.com", { incognito: "1" });
    assert.deepEqual(scoped.results.map(row => row.url), ["https://media.example.com/story"]);
    assert.equal(scoped.results[0].media, undefined);
    const scopedWithMedia = await getSourceResults("search:example.com", {});
    assert.deepEqual(scopedWithMedia.results[0].media,
      { type: "videos", thumbnail: "https://imgs.search.brave.com/story", duration: "3:35" });
    const previewUrl = `${base}/api/search/vertical?type=images&q=preview+fixture&preview=1`;
    const preview = await (await fetch(previewUrl)).json();
    assert.equal(preview.results.length, 6);
    assert(preview.results.every(row => row.thumbnail));
    assert.equal(preview.nextPage, null);
    const beforeIncognito = verticalCalls;
    assert.deepEqual((await (await fetch(`${previewUrl}&incognito=1`)).json()).results, []);
    assert.equal(verticalCalls, beforeIncognito);
    assert.equal((await fetch(`${previewUrl}&page=1&provider=wikimedia`)).status, 400);
    assert.equal((await fetch(`${base}/api/search/vertical?type=news&q=preview+fixture&preview=1`)).status, 400);
    app.locals.veyraVerticalSearch = { async search(type, q, options) {
      assert.equal(type, "videos");
      assert.equal(q, "site:example.com");
      assert.equal(options.domainBrowse, true);
      assert.equal(options.requireThumbnail, true);
      return { provider: "fixture", status: "ok", nextPage: 1, results: [
        ...Array.from({ length: 7 }, (_, i) => ({ title: "No preview", url: `https://media.example.com/watch?id=${i}` })),
        { title: "Watch", url: "https://media.example.com/watch?a=1", thumbnail: "https://imgs.search.brave.com/watch.jpg" },
        { title: "Offsite", url: "https://other.test/watch", sourcePageUrl: "https://example.com/story", thumbnail: "https://imgs.search.brave.com/offsite.jpg" }
      ] };
    } };
    const videoPreview = await (await fetch(`${base}/api/search/vertical?${new URLSearchParams({
      type: "videos", q: "search:example.com", preview: "1"
    })}`)).json();
    assert.deepEqual(videoPreview.results.map(row => row.url), ["https://media.example.com/watch?a=1"]);
    assert.equal(videoPreview.nextPage, null);
    console.log("Search, answer and YouTube Express routes passed controlled local integration tests");
  } finally {
    delete app.locals.veyraWebSearch;
    delete app.locals.veyraSourceSearchFetch;
    delete app.locals.veyraVerticalSearch;
    delete app.locals.veyraAnswerEngine;
    delete app.locals.veyraNeuralRobotPool;
    delete app.locals.veyraYoutubeFetch;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
