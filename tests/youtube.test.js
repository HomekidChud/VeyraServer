"use strict";
const assert = require("assert");
const { parseYoutubeUrl, buildEmbedUrl, checkEmbeddable, isYoutubeUrl } = require("../src/browser/youtube");

(async () => {
  const cases = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "watch"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "shorts"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "live"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "embed"],
    ["https://youtu.be/dQw4w9WgXcQ", "short-link"],
  ];
  for (const [url, kind] of cases) {
    const parsed = parseYoutubeUrl(url);
    assert(parsed && parsed.videoId === "dQw4w9WgXcQ" && parsed.kind === kind, `failed to parse ${url}`);
    assert(buildEmbedUrl(parsed, "https://homekidchud.github.io").includes(`/embed/${parsed.videoId}`));
  }
  const mobile = parseYoutubeUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PL12345678&index=2&t=42s");
  assert.equal(mobile.videoId, "dQw4w9WgXcQ");
  assert.equal(mobile.list, "PL12345678");
  assert.equal(mobile.index, 2);
  assert.equal(mobile.startSeconds, 42);
  assert.equal(parseYoutubeUrl("https://youtu.be/%E0%A4%A"), null);
  assert.equal(parseYoutubeUrl("https://youtube.com/watch?v=bad"), null);
  assert.equal(isYoutubeUrl("https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ"), false);
  assert.equal(parseYoutubeUrl("https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ"), null);
  const ok = await checkEmbeddable("dQw4w9WgXcQ", async () => ({ status: 200, json: async () => ({ title: "Test video", author_name: "Test channel", thumbnail_url: "https://img.youtube.com/vi/dQw4w9WgXcQ/0.jpg" }) }));
  assert.equal(ok.ok, true);
  const blocked = await checkEmbeddable("dQw4w9WgXcQ", async () => ({ status: 403 }));
  assert.equal(blocked.code, "YOUTUBE_EMBED_DISABLED");
  for (const status of [401, 403, 404]) {
    const result = await checkEmbeddable("dQw4w9WgXcQ", async () => ({ status }));
    assert.equal(result.code, "YOUTUBE_EMBED_DISABLED", `HTTP ${status} should be reported as unavailable for embedding`);
  }
  for (const status of [429, 500, 503]) {
    const result = await checkEmbeddable("dQw4w9WgXcQ", async () => ({ status }));
    assert.equal(result.code, "YOUTUBE_UNAVAILABLE", `HTTP ${status} should be a provider outage, not a parsing success`);
  }
  assert.equal((await checkEmbeddable("dQw4w9WgXcQ", async () => ({ status: 200, json: async () => null }))).code, "YOUTUBE_UNAVAILABLE");
  assert.equal((await checkEmbeddable("dQw4w9WgXcQ", async () => { throw new Error("offline"); })).code, "YOUTUBE_UNAVAILABLE");
  let invalidCalls = 0;
  assert.equal((await checkEmbeddable("bad", async () => { invalidCalls += 1; })).code, "YOUTUBE_EMBED_DISABLED");
  assert.equal(invalidCalls, 0);
  const shorts = parseYoutubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ?list=PL12345678&index=3&t=15s");
  assert.equal(shorts.kind, "shorts");
  assert.equal(shorts.startSeconds, 15);
  const shortsEmbed = new URL(buildEmbedUrl(shorts));
  assert.equal(shortsEmbed.searchParams.get("list"), "PL12345678");
  assert.equal(shortsEmbed.searchParams.get("index"), "3");
  assert.equal(shortsEmbed.searchParams.get("start"), "15");
  console.log("YouTube video and Shorts regression tests passed");
})().catch(error => { console.error(error); process.exit(1); });
