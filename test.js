const assert = require("assert/strict");
const {
  CFG, Semaphore, normalizeUrl, resolveNavigation, resolveResource, makeViewUrl, makeResourceUrl, crawlLimitForContentType,
  rewriteHtml, rewriteCssText, rewriteJsText, injectRuntime, detectChallenge, PriorityFrontier, CooperativeRobotPool, crawlPriority,
  tokenizeSearch, parseSearchQuery, localSearch, searchIndexStats, indexDocument,
  BrowserTaskScheduler
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
  assert.match(makeViewUrl("https://example.com/a", "abcdef0123456789"), /sid=abcdef0123456789/);
  assert.match(makeResourceUrl("https://example.com/app.js", "https://example.com/path/page", "abcdef0123456789"), /sid=abcdef0123456789/);
  assert.equal(crawlLimitForContentType("image/png"), CFG.maxProxyImageBytes);
  assert.equal(crawlLimitForContentType("video/mp4"), CFG.maxProxyMediaBytes);
  assert.equal(crawlLimitForContentType("application/json"), CFG.maxTextBytesPerResource);

  const c = detectChallenge("<title>Just a moment...</title><p>Performing security verification</p>", "text/html", 403, {});
  assert.equal(c.type, "security-verification");
  assert.equal(detectChallenge("<title>Example</title><p>Hello world</p>", "text/html", 200, {}), null);

  const browser = new BrowserTaskScheduler(2, 1, 10);
  const browserResults = await Promise.all([
    browser.request("a1", async () => { await new Promise(r => setTimeout(r, 10)); return "a1"; }, { host: "a.example", url: "https://a.example/1", priority: 100 }),
    browser.request("a1", async () => "duplicate", { host: "a.example", url: "https://a.example/1", priority: 1 }),
    browser.request("b1", async () => "b1", { host: "b.example", url: "https://b.example/1", priority: 50 })
  ]);
  assert.deepEqual(browserResults.slice(0,2), ["a1", "a1"]);
  assert.equal(browser.stats.deduped, 1);
  assert.equal(browser.active, 0);

  const sem = new Semaphore(1);
  const release1 = await sem.acquire();
  const waiting = sem.acquire();
  assert.equal(sem.active, 1);
  release1();
  const release2 = await waiting;
  release2();

  const q = new PriorityFrontier(10);
  q.add({url:"https://a.example/low",type:"html"}, 1, "a");
  q.add({url:"https://b.example/high",type:"html"}, 10, "b");
  assert.equal(q.takeNext(new Map(), 2, new Map()).url, "https://b.example/high");
  assert.ok(crawlPriority("https://example.com/", "html", "root") > crawlPriority("https://example.com/a/b", "html", "discovered"));

  const fakeJob = {
    robotFleet: 4, pageFrontier: new PriorityFrontier(20), resourceFrontier: new PriorityFrontier(20),
    hostActive: new Map(), hostCooldowns: new Map()
  };
  const mesh = new CooperativeRobotPool(fakeJob);
  mesh.robots[0].queue.push({ url: "https://example.com/a", type: "html" }, { url: "https://example.com/b", type: "html" });
  // Same bookkeeping the real enqueue path does (helpers are found via the shareable index).
  mesh.updateLoadBucket(mesh.robots[0]);
  mesh.markShareable(mesh.robots[0]);
  const helper = mesh.robots[1];
  assert.equal(await mesh.requestHelp(helper), true);
  assert.equal(helper.helpAccepted, 1);
  assert.equal(mesh.robots[0].helpGiven, 1);
  assert.equal(helper.queue.length, 1);
  assert.equal(mesh.robots[0].queue.length, 1);
  assert.equal(mesh.events.at(-1)?.type, "help-accepted");
  mesh.robots[0].queue.push({ url: "https://example.com/c", type: "html" });
  mesh.robots[0].queue.push({ url: "https://example.com/d", type: "html" });
  mesh.updateLoadBucket(mesh.robots[0]);
  mesh.markShareable(mesh.robots[0]);
  const multitaskRequester = mesh.robots[2];
  multitaskRequester.activeTasks = 1;
  multitaskRequester.countActive = true;
  multitaskRequester.countIdle = false;
  mesh.activeRobotCount += 1;
  mesh.idleRobotCount = Math.max(0, mesh.idleRobotCount - 1);
  mesh.updateLoadBucket(multitaskRequester);
  mesh.robots[0].lastHelpAt = 0; // skip ROBOT_HELP_COOLDOWN_MS for the test
  assert.equal(await mesh.requestHelp(multitaskRequester), true);
  assert.equal(multitaskRequester.activeTasks, 1);
  assert.ok(multitaskRequester.queue.length >= 1 && multitaskRequester.queue.length <= 2); // ROBOT_STEAL_BATCH (2)
  assert.equal(multitaskRequester.helpAccepted, 1);
  console.log("cooperative robot multitask handoff passed");

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

  const runtime = injectRuntime('<!doctype html><html><head><title>T</title></head><body></body></html>', 'https://example.com/path/page');
  assert(runtime.includes('new URL(unwrap(String(url)),virtualUrl)'));
  assert(runtime.includes('const prefix=API_ORIGIN || location.origin'));
  assert(runtime.includes("d.type==='veyra:find'"));
  assert(runtime.includes("d.type==='veyra:print'"));

  const css = rewriteCssText('@font-face{src:url(../fonts/a.woff2)}', 'https://example.com/css/app.css');
  assert(css.includes('/api/resource?url=https%3A%2F%2Fexample.com%2Ffonts%2Fa.woff2'));
  const js = rewriteJsText('import("./chunk.js")', 'https://example.com/assets/app.js');
  assert(js.includes('/api/resource?url=https%3A%2F%2Fexample.com%2Fassets%2Fchunk.js'));


  assert.deepEqual(tokenizeSearch("The quick brown fox 123"), ["quick", "brown", "fox", "123"]);
  const parsed = parseSearchQuery('site:example.com "cats dogs" -spam intitle:cats');
  assert.equal(parsed.filters.site, "example.com");
  assert.equal(parsed.filters.intitle, "cats");
  assert.ok(parsed.phrases.includes("cats dogs"));
  assert.ok(parsed.negativeTerms.includes("spam"));
  indexDocument("https://example.com/cats", '<!doctype html><html><head><title>Cats Guide</title><meta name="description" content="A guide to cats and kittens"></head><body><main><h1>Cats guide</h1><p>Cats are curious companion animals.</p></main></body></html>');
  indexDocument("https://example.org/dogs", '<!doctype html><html><head><title>Dogs Guide</title><meta name="description" content="A guide to dogs"></head><body><main><h1>Dogs guide</h1><p>Dogs are loyal companion animals.</p></main></body></html>');
  const sr = localSearch("cats", 0, 10);
  assert.equal(sr.total >= 1, true);
  assert.equal(sr.results[0].url, "https://example.com/cats");
  assert.equal(localSearch("site:example.com cats -kittens", 0, 10).total, 0);
  assert.equal(localSearch('"cats guide"', 0, 10).results[0].url, "https://example.com/cats");
  assert.equal(searchIndexStats().documents >= 2, true);
  console.log("Veyra server tests passed");
  assert.equal(typeof CFG.globalConcurrency, "number");
  console.log("rewrite/resource/navigation tests passed");
})().catch(err => { console.error(err); process.exit(1); });
