"use strict";
const assert = require("assert");
const { parseYoutubeUrl, buildEmbedUrl, checkEmbeddable } = require("../src/browser/youtube");

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
  const ok = await checkEmbeddable("dQw4w9WgXcQ", async () => ({ status: 200, json: async () => ({ title: "Test video", author_name: "Test channel", thumbnail_url: "https://img.youtube.com/vi/dQw4w9WgXcQ/0.jpg" }) }));
  assert.equal(ok.ok, true);
  const blocked = await checkEmbeddable("dQw4w9WgXcQ", async () => ({ status: 403 }));
  assert.equal(blocked.code, "YOUTUBE_EMBED_DISABLED");
  console.log("YouTube video and Shorts regression tests passed");
})().catch(error => { console.error(error); process.exit(1); });
