"use strict";
const assert = require("assert");
const { NeuralRobot, NeuralRobotPool } = require("../src/services/neural-robots");
const { NeuralCrawlerModel, NUM_FEATURES } = require("../src/services/neural-crawler");
const { imageIdentity } = require("../src/services/crawl-page-data");

const robot = new NeuralRobot(0, { neuralModel: null });
const relevant = robot.scorePage({ title: "Photosynthesis process", text: "Photosynthesis converts light, water and carbon dioxide into chemical energy.", metadata: {"og:title":"Photosynthesis"}, links: [] }, "photosynthesis", 1);
const irrelevant = robot.scorePage({ title: "Travel guide", text: "Hotels, flights and holiday destinations.", metadata: {}, links: [] }, "photosynthesis", 1);
assert.ok(relevant > irrelevant, `relevant=${relevant} irrelevant=${irrelevant}`);
assert.ok(relevant >= 0 && relevant <= 1);
assert.ok(irrelevant >= 0 && irrelevant <= 1);

const parsed = robot.parseHtml('<html><head><title>Photosynthesis</title></head><body><nav>Navigation menu Add to word list</nav><main><h1>Photosynthesis</h1><p>Plants use light to make food.</p><a href="/biology">Biology</a></main><footer>Cookie settings</footer></body></html>', 'https://example.com/start');
assert.equal(parsed.title, 'Photosynthesis');
assert.equal(parsed.links[0], 'https://example.com/biology');
assert.match(parsed.text, /Plants use light/);
assert.doesNotMatch(parsed.text, /Navigation menu|Add to word list|Cookie settings/);

const nasa = "https://assets.science.nasa.gov";
const esa = "https://media.esa.int/legacy/web/images/esa_multimedia/images/2022/12/gallery";
const nasaOg = `${nasa}/content/dam/science/missions/webb/nebula.png/jcr:content/renditions/cq5dam.web.1280.1280.png`;
const nasaDynamic = `${nasa}/dynamicimage/assets/science/missions/webb/nebula.png?w=8423&h=14589&fit=clip`;
const compass = `${nasa}/content/dam/science/missions/webb/nebula.png/jcr:content/renditions/Compass%20and%20Scale%20Image.png`;
const esaOg = `${esa}/259791/image-thumb__259791__social_share/nebula.jpg`;
const esaLarge = `${esa}/259791/image-thumb__259791__fit_large/nebula.webp`;
assert.equal(imageIdentity(nasaOg), imageIdentity(nasaDynamic));
assert.equal(imageIdentity(nasaOg), imageIdentity(nasaDynamic.replaceAll("&", "&amp;")));
assert.equal(imageIdentity(esaOg), imageIdentity(esaLarge));
assert.notEqual(imageIdentity(esaOg), imageIdentity(esaLarge.replaceAll("259791", "259792")));
for (const url of [compass, `${nasaDynamic}&transform=other`, esaLarge.replace("/259791/", "/259792/"),
  esaOg.replace("media.esa.int", "media.esa.int.example.org"), nasaOg.replace(".gov", ".gov.example.org")]) {
  assert.equal(imageIdentity(url), url, "unrelated images and lookalike hosts keep their original key");
}
const galleryPage = robot.parseHtml(`<meta property="og:image" content="${nasaOg}"><meta property="og:image" content="${esaOg}">
  <script type="application/ld+json">${JSON.stringify({ "@type": "ImageObject", contentUrl: nasaDynamic.replaceAll("&", "&amp;") })}</script>
  <main><img src="${nasaDynamic.replaceAll("&", "&amp;")}" alt="Nebula"><img src="${compass}" alt="Compass">
  <img src="${esaLarge}" alt="ESA nebula"></main>`, "https://science.nasa.gov/fixture");
assert.deepEqual(galleryPage.images, [
  { url: nasaOg, title: "Nebula", primary: true }, { url: esaOg, title: "ESA nebula", primary: true },
  { url: compass, title: "Compass" },
]);

const model = new NeuralCrawlerModel({ learningRate: 0.01, weightDecay: 0.001 });
const trainingUrl = "https://developer.mozilla.org/en-US/docs/Web/JavaScript";
const before = model.scoreUrl(trainingUrl, { type: "html" });
for (let i = 0; i < 24; i++) model.train({ url: trainingUrl, positive: true, weight: 1, context: { type: "html" } });
assert.ok(model.scoreUrl(trainingUrl, { type: "html" }) > before, "AdamW feedback should improve the selected URL's ranking score");
const checkpoint = model.serialize();
assert.equal(checkpoint.version, 2);
assert.equal(checkpoint.optimizer.name, "AdamW");
assert.equal(checkpoint.optimizer.step, 24);
const restored = new NeuralCrawlerModel();
assert.equal(restored.loadData(checkpoint), true);
assert.equal(restored.optimizerStep, 24);
assert.deepEqual(Array.from(restored.firstMoment), Array.from(model.firstMoment));
assert.deepEqual(Array.from(restored.secondMoment), Array.from(model.secondMoment));
const invalidWeights = model.serialize(); invalidWeights.weights[0] = Infinity;
assert.equal(restored.loadData(invalidWeights), false, "non-finite model weights are rejected before state mutation");
const invalidMoments = model.serialize(); invalidMoments.optimizer.secondMoment[0] = NaN;
assert.equal(restored.loadData(invalidMoments), false, "non-finite Adam moments are rejected before state mutation");
assert.equal(Number.isFinite(restored.scoreUrl(trainingUrl, { type: "html" })), true, "rejected checkpoints leave live scoring finite");
assert.equal(model.train({ url: trainingUrl, positive: true, weight: -1 }), false, "negative feedback weights cannot reverse model updates");
assert.equal(model.train({ url: trainingUrl, positive: 1 }), false, "feedback labels must be explicit booleans");
const legacy = new NeuralCrawlerModel();
assert.equal(legacy.loadData({ version: 1, weights: Array(NUM_FEATURES).fill(0.2), bias: 0.1 }), true, "legacy v1 checkpoints remain loadable");
assert.equal(legacy.optimizerStep, 0);
assert.equal(model.report().optimizer.name, "AdamW");

const dynamicUrl = "https://crawler-fixture.example/docs/guide";
const htmlContext = { type: "html", internal: true };
const cssContext = { type: "css", internal: false };
const dynamicModel = () => {
  const m = new NeuralCrawlerModel({ maxUrlCache: 2 });
  m.weights.set([1, 0.2, 0.6, 0.1, 0.8, 0.1, 0.5, 0.4, 1.5, 0.7]);
  return m;
};
const htmlFirst = dynamicModel(), cssFirst = dynamicModel();
const htmlScore = htmlFirst.scoreUrl(dynamicUrl, htmlContext);
const cssScore = cssFirst.scoreUrl(dynamicUrl, cssContext);
assert.ok(htmlScore > cssScore);
assert.equal(htmlFirst.scoreUrl(dynamicUrl, cssContext), cssScore);
assert.equal(cssFirst.scoreUrl(dynamicUrl, htmlContext), htmlScore);
assert.ok(htmlFirst.scoreUrl(dynamicUrl, { ...htmlContext, discoveredAt: Date.now() - 60 * 60 * 1000 }) < htmlScore);
htmlFirst.recordVisit("https://crawler-fixture.example/another-page");
assert.ok(htmlFirst.scoreUrl(dynamicUrl, htmlContext) < htmlScore, "a cached URL must see new domain visits");
const originalClock = Date.now;
try {
  let time = originalClock();
  Date.now = () => time;
  const fading = { ...htmlContext, discoveredAt: time };
  const fresh = cssFirst.scoreUrl(dynamicUrl, fading);
  time += 15 * 60 * 1000;
  assert.ok(cssFirst.scoreUrl(dynamicUrl, fading) < fresh, "freshness decays even when the context is reused");
} finally { Date.now = originalClock; }

const hot = dynamicModel(), cold = dynamicModel();
hot.scoreUrl(dynamicUrl, htmlContext);
const beforeUpdate = hot.extractFeatures(dynamicUrl, cssContext);
for (const m of [hot, cold]) assert.equal(m.train({ url: dynamicUrl, context: cssContext, positive: true }), true);
assert.deepEqual(hot.serialize().weights, cold.serialize().weights, "URL-only feedback must use its own context even with a warm cache");
const afterUpdate = hot.extractFeatures(dynamicUrl, cssContext);
assert.ok(afterUpdate[0] > beforeUpdate[0], "authority must include new domain clicks");
assert.notEqual(afterUpdate[8], beforeUpdate[8], "model-derived input must reflect updated weights");
assert.equal(hot.scoreUrl(dynamicUrl, cssContext), hot.score(afterUpdate));
hot.scoreUrl("https://crawler-fixture.example/second");
hot.scoreUrl("https://crawler-fixture.example/third");
assert.equal(hot.report().urlCacheSize, 2);
hot.reset();
assert.equal(hot.report().urlCacheSize, 0);

(async () => {
  await assert.rejects(() => robot.fetchRaw("https://127.0.0.1/private"), error => error.code === "SAFE_FETCH_REQUIRED", "crawler workers without the socket-validated adapter must fail closed");
  const safeRobot = new NeuralRobot(1, { fetchPage: async url => ({
    status: 200, finalUrl: url, contentType: url.endsWith("/robots.txt") ? "text/plain" : "text/html; charset=utf-8",
    body: Buffer.from(url.endsWith("/robots.txt") ? "User-agent: *\nDisallow: /private" : "<html><head><title>Fixture</title></head><body><main><p>Safe fixture page content for the neural crawler.</p></main></body></html>")
  }) });
  assert.equal(await safeRobot.checkRobots("https://crawler-fixture.example/private/page"), false, "plain-text robots.txt must be parsed instead of silently treated as unavailable");
  const page = await safeRobot.fetchRaw("https://crawler-fixture.example/public/page");
  assert.match(page.html, /Safe fixture page content/);

  const origin = "https://crawler-fixture.example";
  const requested = [];
  const ignoredMeta = '<meta name="irrelevant" content="fixture">'.repeat(201);
  const pages = {
    "/": '<a href="/a">First</a><a href="/b">Second</a><a href="/private">Blocked</a>',
    "/a": `<meta property="og:image" content="/cover.jpg?utm_source=fixture">
      <script type="application/ld+json">{"@type":"Article","articleBody":"Structured fixture text about planetary science.","image":"/structured.jpg"}</script>
      <main><p>This is the visible, public planetary science fixture.</p><figure><picture><source srcset="/small.jpg 320w, /large.jpg 1280w">
      <img src="/placeholder.gif" alt="Wide planet view"></picture></figure><img data-src="/lazy.jpg" alt="Lazy-loaded photo">
      <img src="/cover.jpg" alt="Planet cover"><img src="/pixel.png"><img src="/unsafe.jpg?token=fixture"></main>
      <a href="/shared">Deep link</a>`,
    "/b": `<meta property="og:image" content="/b.jpg">${ignoredMeta}<meta name="ROBOTS" content="noimageindex"><a href="/shared?utm_tag=fixture">Deep duplicate</a>`,
    "/shared": '<a href="/do-not-follow">Unfollowed</a>',
    "/restricted": '<meta name="robots" content="noindex"><p>Not searchable</p>'
  };
  const fetchPage = async url => {
    const path = new URL(url).pathname;
    requested.push(path);
    if (path === "/") await new Promise(resolve => setImmediate(resolve));
    const body = path === "/robots.txt" ? "User-agent: *\nDisallow: /private" : pages[path] || "";
    return { status: 200, finalUrl: url, body: Buffer.from(body), contentType: path === "/robots.txt" ? "text/plain" : "text/html",
      headers: new Headers(path === "/shared" ? { "x-robots-tag": "nofollow" } : {}) };
  };
  const branching = new NeuralRobot(2, { fetchPage, maxDepth: 2, concurrency: 3 });
  const crawl = await branching.startCrawl(origin, "planetary science", { maxPages: 5 });
  assert.deepEqual(crawl.pages.map(row => new URL(row.url).pathname).sort(), ["/", "/a", "/b", "/shared"]);
  assert.equal(requested.filter(path => path === "/shared").length, 1);
  assert.ok(!requested.includes("/private") && !requested.includes("/do-not-follow"));
  const gallery = crawl.pages.find(row => row.url === `${origin}/a`);
  assert.match(gallery.text, /Structured fixture text/);
  assert.deepEqual(gallery.images.map(image => [image.url, image.title]), [
    [`${origin}/cover.jpg`, "Planet cover"], [`${origin}/structured.jpg`, ""], [`${origin}/large.jpg`, "Wide planet view"], [`${origin}/lazy.jpg`, "Lazy-loaded photo"]
  ]);
  assert.equal(crawl.stats.imagesFound, 4);
  assert.deepEqual(crawl.pages.find(row => row.url === `${origin}/b`).images, []);
  assert.equal((await branching.startCrawl(origin, "", { maxDepth: 0 })).pages.length, 1);
  assert.equal((await branching.startCrawl(`${origin}/restricted`)).pages.length, 0);

  const pool = new NeuralRobotPool({ maxWorkers: 1, fetchPage });
  const seeds = [`${origin}/a`, `${origin}/b`, `${origin}/shared`];
  const pending = pool.startCrawl(seeds, "", { maxDepth: 0, maxPages: 1 });
  assert.deepEqual(await pool.startCrawl(seeds, ""), [], "a second call cannot take a reserved worker");
  assert.deepEqual((await pending).map(row => [row.seed, row.status, row.result.pages.length]), seeds.map(seed => [seed, "fulfilled", 1]));
  console.log("Neural crawler regression tests passed, including fail-closed safe fetching and robots.txt policy");
})().catch(error => { console.error(error); process.exitCode = 1; });
