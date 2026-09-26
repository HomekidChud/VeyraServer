const assert = require("assert/strict");
const { normalizeUrl, resolveNavigation, resolveResource, makeViewUrl, makeResourceUrl, detectChallenge, PriorityFrontier, crawlPriority } = require("./server");

(async () => {
  assert.equal(normalizeUrl("https://example.com/a?b=2&utm_source=x&a=1#x"), "https://example.com/a?b=2&a=1");
  assert.equal(resolveNavigation("../about", "https://example.com/path/to/page"), "https://example.com/path/about");
  assert.equal(resolveNavigation("?q=1", "https://example.com/path"), "https://example.com/path?q=1");
  assert.equal(resolveNavigation("#frag", "https://example.com/path?q=1"), "https://example.com/path?q=1#frag");
  assert.equal(resolveResource("data:image/png;base64,xx", "https://example.com/"), null);
  assert.match(makeViewUrl("https://example.com/a?x=1&y=2"), /^\/api\/view\?url=/);
  assert.match(makeResourceUrl("https://example.com/app.js"), /^\/api\/resource\?url=/);
  const c = detectChallenge("<title>Just a moment...</title><p>Performing security verification</p>", "text/html", 403, {});
  assert.equal(c.type, "security-verification");
  assert.equal(detectChallenge("<title>Example</title><p>Hello world</p>", "text/html", 200, {}), null);
  const q = new PriorityFrontier(10);
  q.add({url:"https://a.example/low",type:"html"}, 1, "a");
  q.add({url:"https://b.example/high",type:"html"}, 10, "b");
  assert.equal(q.takeNext(new Map(), 2, new Map()).url, "https://b.example/high");
  assert.ok(crawlPriority("https://example.com/", "html", "root") > crawlPriority("https://example.com/a/b", "html", "discovered"));
  console.log("Veyra server tests passed");
})().catch(err => { console.error(err); process.exit(1); });
