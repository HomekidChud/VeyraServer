const assert = require("assert/strict");
const {
  normalizeUrl, resolveNavigation, resolveResource, makeViewUrl, makeResourceUrl,
  rewriteHtml, rewriteCssText, rewriteJsText, detectChallenge, PriorityFrontier, crawlPriority
} = require("./server");

(async () => {
  assert.equal(normalizeUrl("https://example.com/a?b=2&utm_source=x&a=1#x"), "https://example.com/a?b=2&a=1");
  assert.equal(resolveNavigation("../about", "https://example.com/path/to/page"), "https://example.com/path/about");
  assert.equal(resolveNavigation("?q=1", "https://example.com/path"), "https://example.com/path?q=1");
  assert.equal(resolveNavigation("#frag", "https://example.com/path?q=1"), "https://example.com/path?q=1#frag");
  assert.equal(resolveResource("data:image/png;base64,xx", "https://example.com/"), null);
  assert.equal(resolveResource("#local", "https://example.com/"), null);
  assert.match(makeViewUrl("https://example.com/a?x=1&y=2"), /^\/api\/view\?url=/);
  assert.match(makeResourceUrl("https://example.com/app.js"), /^\/api\/resource\?url=/);
  assert.match(makeResourceUrl("https://example.com/app.js", "https://example.com/path/page"), /from=/);

  const c = detectChallenge("<title>Just a moment...</title><p>Performing security verification</p>", "text/html", 403, {});
  assert.equal(c.type, "security-verification");
  assert.equal(detectChallenge("<title>Example</title><p>Hello world</p>", "text/html", 200, {}), null);

  const q = new PriorityFrontier(10);
  q.add({url:"https://a.example/low",type:"html"}, 1, "a");
  q.add({url:"https://b.example/high",type:"html"}, 10, "b");
  assert.equal(q.takeNext(new Map(), 2, new Map()).url, "https://b.example/high");
  assert.ok(crawlPriority("https://example.com/", "html", "root") > crawlPriority("https://example.com/a/b", "html", "discovered"));

  const sample = rewriteHtml(
    '<!doctype html><html><head><title>T</title><link rel="stylesheet" href="/assets/app.css"><script src="/assets/app.js" integrity="sha256-test"></script></head><body><img src="/images/logo.png"><picture><source srcset="/images/a.png 1x, /images/b.png 2x"></picture><video poster="/img/poster.jpg"><source src="/movie.mp4"></video><svg><use href="/icons.svg#logo"></use></svg><img data-src="/lazy.png"><img data-srcset="/a.png 1x, /b.png 2x"></body></html>',
    'https://example.com/path/page'
  );
  assert(sample.includes('/api/resource?url=https%3A%2F%2Fexample.com%2Fimages%2Flogo.png'));
  assert(sample.includes('from=https%3A%2F%2Fexample.com%2Fpath%2Fpage'));
  assert(!sample.includes('integrity="sha256-test"'));
  assert(sample.includes('b.png'));
  assert(sample.includes('icons.svg'));
  assert(sample.includes('data-src="/api/resource?url=https%3A%2F%2Fexample.com%2Flazy.png'));

  const css = rewriteCssText('@font-face{src:url(../fonts/a.woff2)}', 'https://example.com/css/app.css');
  assert(css.includes('/api/resource?url=https%3A%2F%2Fexample.com%2Ffonts%2Fa.woff2'));
  const js = rewriteJsText('import("./chunk.js")', 'https://example.com/assets/app.js');
  assert(js.includes('/api/resource?url=https%3A%2F%2Fexample.com%2Fassets%2Fchunk.js'));

  console.log("Veyra server tests passed");
  console.log("rewrite/resource tests passed");
})().catch(err => { console.error(err); process.exit(1); });
