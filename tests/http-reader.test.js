"use strict";
const assert = require("node:assert/strict");
const { youtubeItemsFromHtml, youtubeInitialData, linkRows } = require("../src/services/http-reader");

process.env.VEYRA_CHROMIUM_ENABLED = "false";
const { app, mongoStore, CFG } = require("../src/server");
mongoStore.enabled = false;
mongoStore.uri = "";
let fetches = 0;
let youtubeCalls = 0;
app.locals.veyraReaderAssertPublic = async url => {
  if (new URL(url).hostname === "127.0.0.1") throw Object.assign(new Error("blocked"), { code: "SSRF_BLOCKED" });
};
app.locals.veyraReaderFetch = async (url, options) => {
  fetches++;
  assert.equal(url, "https://reader.fixture.test/article");
  assert.equal(options.engine, "http-reader");
  assert.equal(options.retries, 0);
  assert.ok(options.maxBytes <= 4 * 1024 * 1024);
  return {
    ok: true, status: 200, finalUrl: url, durationMs: 7,
    contentType: "text/html; charset=utf-8",
    body: Buffer.from(`<!doctype html><html lang="en"><head><title>Reader Fixture</title><meta name="description" content="A safe test page"></head><body><nav>Nav junk</nav><main><h1>Readable heading</h1><p>Plain text extracted from this public article.</p><a href="/next">Next page</a><a href="https://external.fixture.test/read?api_key=private">Sensitive link</a><script>alert('untrusted')</script></main><footer>Footer junk</footer></body></html>`),
  };
};
app.locals.veyraYoutubeFetch = async url => {
  youtubeCalls++;
  assert.match(url, /^https:\/\/www\.youtube\.com\/oembed\?/);
  return { status: 200, json: async () => ({ title: "Public video", author_name: "Fixture channel", thumbnail_url: "https://i.ytimg.com/vi/abcDEF12345/0.jpg" }) };
};

const sampleFeed = {
  contents: [{ videoRenderer: {
    videoId: "abcDEF12345", title: { runs: [{ text: "A public video" }] },
    shortBylineText: { runs: [{ text: "Channel" }] },
    viewCountText: { simpleText: "1,234 views" },
    thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/abcDEF12345/default.jpg" }] },
  } }],
};
const html = `<script>window["ytInitialData"] = ${JSON.stringify(sampleFeed)};</script>`;
assert.deepEqual(youtubeInitialData(html), sampleFeed, "initial data is parsed as JSON and never executed");
assert.equal(youtubeItemsFromHtml(html)[0].videoId, "abcDEF12345");
assert.equal(youtubeItemsFromHtml(html)[0].title, "A public video");
assert.equal(linkRows(["https://safe.fixture.test/ok", "https://safe.fixture.test/x?token=secret"], "https://reader.fixture.test/").length, 1);

(async () => {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const scrapeResponse = await fetch(`${base}/api/scrape?url=${encodeURIComponent("https://reader.fixture.test/article")}`);
    const scraped = await scrapeResponse.json();
    assert.equal(scrapeResponse.status, 200);
    assert.equal(scraped.ok, true);
    assert.equal(scraped.title, "Reader Fixture");
    assert.match(scraped.text, /Plain text extracted from this public article/);
    assert.equal(scraped.links.some(link => link.url.includes("api_key")), false);
    assert.equal(scraped.engine, "bounded-http-reader");

    const readerResponse = await fetch(`${base}/api/reader?url=${encodeURIComponent("https://reader.fixture.test/article")}&sid=reader-test-session`);
    const readerHtml = await readerResponse.text();
    assert.equal(readerResponse.status, 200);
    assert.match(readerResponse.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(readerResponse.headers.get("content-security-policy"), /script-src 'nonce-/);
    assert.match(readerResponse.headers.get("content-security-policy"), /frame-ancestors 'self'/);
    assert.match(readerHtml, /Veyra · HTTP reader/);
    assert.match(readerHtml, /Plain text extracted from this public article/);
    assert.doesNotMatch(readerHtml, /alert\('untrusted'\)/);
    assert.match(readerHtml, /parent\.postMessage/);
    assert.match(readerResponse.headers.get("x-content-type-options"), /nosniff/i);

    const videoUrl = "https://www.youtube.com/watch?v=abcDEF12345";
    const videoResponse = await fetch(`${base}/api/scrape?url=${encodeURIComponent(videoUrl)}`);
    const video = await videoResponse.json();
    assert.equal(videoResponse.status, 200);
    assert.equal(video.title, "Public video");
    assert.equal(video.youtubeVideo.authorName, "Fixture channel");
    assert.match(video.embedUrl, /^https:\/\/www\.youtube-nocookie\.com\/embed\/abcDEF12345/);
    assert.equal(video.fetchDurationMs, 0, "oEmbed route must not invoke server-side page rendering");
    const videoReaderResponse = await fetch(`${base}/api/reader?url=${encodeURIComponent(videoUrl)}`);
    const videoReaderHtml = await videoReaderResponse.text();
    assert.match(videoReaderHtml, /youtube-nocookie\.com\/embed\/abcDEF12345/);
    assert.match(videoReaderResponse.headers.get("content-security-policy"), /frame-src https:\/\/www\.youtube-nocookie\.com/);
    assert.equal(youtubeCalls, 2);

    const sensitive = await fetch(`${base}/api/scrape?url=${encodeURIComponent("https://reader.fixture.test/article?access_token=private")}`);
    assert.equal(sensitive.status, 400);
    assert.equal((await sensitive.json()).code, "SENSITIVE_URL");
    const privateTarget = await fetch(`${base}/api/scrape?url=${encodeURIComponent("http://127.0.0.1/private")}`);
    assert.equal(privateTarget.status, 403);
    assert.equal((await privateTarget.json()).code, "SSRF_BLOCKED");
    assert.equal(fetches, 2, "sensitive and private URLs must be rejected before outbound fetches");
    assert.equal(CFG.browserEnabled, false);
    console.log("HTTP scraper and reader route, CSP, URL safety, and official YouTube embed tests passed");
  } finally {
    delete app.locals.veyraReaderAssertPublic;
    delete app.locals.veyraReaderFetch;
    delete app.locals.veyraYoutubeFetch;
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
