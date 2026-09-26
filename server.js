const express = require("express");
const cors = require("cors");
const cheerio = require("cheerio");
const crypto = require("crypto");

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.use(express.json({ limit: "32kb" }));

const PORT = Number(process.env.PORT || 10000);

// Fixed defaults: no UI configuration is required.
// These are deliberately high but bounded so one job is fast without creating
// an unbounded request storm.
const DEFAULTS = Object.freeze({
  htmlWorkers: 24,
  assetWorkers: 40,
  maxUrls: 5000,
  maxSourceBytes: 900_000,
  timeoutMs: 12_000,
  maxSitemapUrls: 50_000,
  maxJobAgeMs: 45 * 60 * 1000,
  userAgent: "Veyra BrowseCrawler/4.0 (+https://github.com/)"
});

const jobs = new Map();

function now() { return new Date().toISOString(); }
function log(job, level, message) {
  const entry = { id: ++job.logSeq, time: now(), level, message: String(message) };
  job.logs.push(entry);
  if (job.logs.length > 300) job.logs.shift();
  return entry;
}

function normalizeUrl(value, base) {
  try {
    const u = new URL(value, base);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.hash = "";

    // Remove tracking parameters but preserve functional query parameters.
    const drop = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|msclkid$|yclid$|dclid$)/i;
    for (const key of [...u.searchParams.keys()]) {
      if (drop.test(key)) u.searchParams.delete(key);
    }

    // Sort parameters for stronger de-duplication.
    const pairs = [...u.searchParams.entries()].sort(([a, b]) => a.localeCompare(b));
    u.search = "";
    for (const [k, v] of pairs) u.searchParams.append(k, v);

    if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) {
      u.port = "";
    }
    return u.href;
  } catch {
    return null;
  }
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return (u.pathname || "/") + (u.search || "");
  } catch {
    return url;
  }
}

function isSameOrigin(url, root) {
  try { return new URL(url).origin === new URL(root).origin; }
  catch { return false; }
}

function typeForUrl(url, hint = "") {
  const p = url.toLowerCase().split("?")[0].split("#")[0];
  if (hint === "css" || /\.css$/i.test(p)) return "css";
  if (hint === "js" || /\.(?:js|mjs|cjs)$/i.test(p)) return "js";
  if (/\.(?:png|jpe?g|gif|svg|webp|ico|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|webmanifest)$/i.test(p)) return "asset";
  return "html";
}

function safeBodyText(buffer) {
  // Buffer -> UTF-8. This is intentionally permissive for source viewing.
  return buffer.toString("utf8");
}

function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();

    if (key === "user-agent") {
      current = { agents: [value.toLowerCase()], disallow: [], sitemaps: [] };
      groups.push(current);
    } else if (!current) {
      continue;
    } else if (key === "disallow" && value) {
      current.disallow.push(value);
    } else if (key === "sitemap" && value) {
      current.sitemaps.push(value);
    }
  }
  return { groups };
}

function robotsAllowed(url, robots) {
  if (!robots) return true;
  try {
    const u = new URL(url);
    const path = u.pathname + (u.search || "");
    const group = robots.groups.find(g => g.agents.includes("*"));
    if (!group) return true;
    return !group.disallow.some(prefix => path.startsWith(prefix));
  } catch {
    return true;
  }
}

async function fetchBuffer(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": DEFAULTS.userAgent,
        "accept": "text/html,application/xhtml+xml,application/xml,text/css,application/javascript,text/javascript,*/*;q=0.1"
      }
    });

    const chunks = [];
    let total = 0;
    const limit = DEFAULTS.maxSourceBytes;

    // Read only up to the source-display cap. This keeps a single huge page
    // from consuming the Render instance's memory.
    if (res.body) {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total <= limit) chunks.push(Buffer.from(value));
        if (total > limit) {
          try { await reader.cancel(); } catch {}
          break;
        }
      }
    } else {
      const ab = await res.arrayBuffer();
      const b = Buffer.from(ab);
      chunks.push(b.subarray(0, limit));
      total = b.length;
    }

    const buffer = Buffer.concat(chunks);
    return {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url || url,
      contentType: res.headers.get("content-type") || "",
      bytes: total,
      truncated: total > limit,
      body: buffer
    };
  } finally {
    clearTimeout(timer);
  }
}

function addResource(job, item, response, source) {
  const existing = job.resourceByUrl.get(item.url);
  if (existing) return existing;

  const type = item.type === "html" ? "html" : typeForUrl(item.url, item.type);
  const id = job.resources.length;
  const resource = {
    id,
    url: response.finalUrl || item.url,
    requestedUrl: item.url,
    type,
    status: response.status,
    contentType: response.contentType,
    bytes: response.bytes,
    bytesLabel: labelBytes(response.bytes),
    truncated: response.truncated,
    sourceId: source || null,
    text: safeBodyText(response.body)
  };

  job.resources.push(resource);
  job.resourceByUrl.set(item.url, resource);
  if (resource.url !== item.url) job.resourceByUrl.set(resource.url, resource);
  if (type === "html") job.counts.htmlPages++;
  if (type === "css") job.counts.css++;
  if (type === "js") job.counts.js++;
  return resource;
}

function labelBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function enqueue(job, url, type, source) {
  if (!url) return false;
  const normalized = normalizeUrl(url, source || job.root);
  if (!normalized) return false;

  const normalizedType = typeForUrl(normalized, type);
  const isPage = normalizedType === "html";

  // Pages are same-origin. CSS/JS can be external so CDN libraries are captured,
  // but external HTML pages are never recursively crawled.
  if (isPage && !isSameOrigin(normalized, job.root)) return false;

  if (isPage && !robotsAllowed(normalized, job.robots)) return false;

  const key = `${normalizedType}|${normalized}`;
  if (job.discovered.has(key)) return false;
  if (job.discoveredCount >= DEFAULTS.maxSitemapUrls + DEFAULTS.maxUrls * 6) return false;

  job.discovered.add(key);
  job.discoveredCount++;
  job.counts.links++;
  job.links.push({
    url: normalized,
    path: pathOf(normalized),
    type: normalizedType,
    source: source || job.root,
    internal: isSameOrigin(normalized, job.root),
    captured: false
  });

  if ((job.pageQueue.length + job.assetQueue.length + job.activeWorkers + job.processed) >= DEFAULTS.maxUrls && isPage) return false;

  if (isPage) {
    job.pageQueue.push({ url: normalized, type: "html", source: source || null });
  } else if (normalizedType === "css" || normalizedType === "js") {
    job.assetQueue.push({ url: normalized, type: normalizedType, source: source || null });
  }

  return true;
}

function markCaptured(job, resource) {
  const link = job.links.find(l => l.url === resource.url || l.url === resource.requestedUrl);
  if (link) link.captured = true;
}

function discoverFromHtml(job, resource) {
  const $ = cheerio.load(resource.text, { decodeEntities: false });

  const add = (raw, type = "html") => {
    const u = normalizeUrl(raw, resource.url);
    if (u) enqueue(job, u, type, resource.url);
  };

  $("a[href],area[href]").each((_, el) => add($(el).attr("href"), "html"));
  $("link[href]").each((_, el) => {
    const rel = String($(el).attr("rel") || "").toLowerCase();
    const href = $(el).attr("href");
    if (rel.includes("stylesheet")) add(href, "css");
    else add(href, "asset");
  });
  $("script[src]").each((_, el) => add($(el).attr("src"), "js"));
  $("img[src],source[src],video[poster],audio[src],iframe[src],object[data],input[src]").each((_, el) => {
    const attr = el.name === "object" ? "data" : (el.name === "video" ? "poster" : "src");
    add($(el).attr(attr), "asset");
  });
  $("form[action]").each((_, el) => add($(el).attr("action"), "html"));
  $("[srcset]").each((_, el) => {
    String($(el).attr("srcset") || "").split(",").forEach(part => add(part.trim().split(/\s+/)[0], "asset"));
  });

  // Common dynamically-created URLs.
  const patterns = [
    /(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:axios|XMLHttpRequest).*?["'`]([^"'`]+)["'`]/g,
    /["'`]([^"'`]+\.(?:js|mjs)(?:\?[^"'`]*)?)["'`]/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(resource.text)) !== null) add(m[1], typeForUrl(m[1]));
  }

  // CSS URLs embedded in <style> blocks and style attributes.
  $("style").each((_, el) => discoverCssText(job, $(el).text(), resource.url));
  $("[style]").each((_, el) => discoverCssText(job, $(el).attr("style") || "", resource.url));
}

function discoverCssText(job, text, base) {
  const urlRe = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    const u = normalizeUrl(m[1], base);
    if (u) enqueue(job, u, "asset", base);
  }
  const impRe = /@import\s+(?:url\(\s*)?["']([^"']+)["']/gi;
  while ((m = impRe.exec(text)) !== null) {
    const u = normalizeUrl(m[1], base);
    if (u) enqueue(job, u, "css", base);
  }
}

function discoverFromCss(job, resource) {
  discoverCssText(job, resource.text, resource.url);
}

function discoverFromJs(job, resource) {
  const patterns = [
    /(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bimport\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:location(?:\.href)?|window\.open)\s*=?\s*["'`]([^"'`]+)["'`]/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(resource.text)) !== null) {
      const type = typeForUrl(m[1], "js");
      const u = normalizeUrl(m[1], resource.url);
      if (u) enqueue(job, u, type, resource.url);
    }
  }
}

async function fetchRobots(job) {
  const robotsUrl = new URL("/robots.txt", job.root).href;
  try {
    const response = await fetchBuffer(robotsUrl, 8000);
    const text = safeBodyText(response.body);
    job.robots = parseRobots(text);
    log(job, "debug", "robots.txt loaded.");
    const sitemapLines = [...text.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map(m => m[1]);
    for (const s of sitemapLines) job.sitemaps.push(normalizeUrl(s, robotsUrl)).filter(Boolean);
  } catch {
    log(job, "debug", "robots.txt unavailable; continuing.");
  }
}

async function fetchSitemaps(job) {
  const candidates = new Set(job.sitemaps.filter(Boolean));
  candidates.add(normalizeUrl("/sitemap.xml", job.root));
  candidates.add(normalizeUrl("/sitemap_index.xml", job.root));

  const seenSitemaps = new Set();
  const queue = [...candidates].filter(Boolean);
  let count = 0;

  while (queue.length && count < 25 && !job.stop) {
    const sitemapUrl = queue.shift();
    if (seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);
    count++;

    try {
      const response = await fetchBuffer(sitemapUrl, 10000);
      const xml = safeBodyText(response.body);
      log(job, "debug", `Sitemap read: ${sitemapUrl}`);
      for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
        const u = normalizeUrl(m[1], sitemapUrl);
        if (!u) continue;
        if (/sitemap|\.xml$/i.test(u) && !isSameOrigin(u, job.root)) continue;
        if (/sitemap|\.xml$/i.test(u) && (u.endsWith(".xml") || /sitemap/i.test(u))) {
          if (queue.length < 50) queue.push(u);
        } else {
          enqueue(job, u, "html", sitemapUrl);
        }
      }
    } catch (e) {
      log(job, "debug", `Sitemap failed: ${sitemapUrl} (${e.message})`);
    }
  }
}

async function processItem(job, item) {
  const key = `${item.type}|${item.url}`;
  if (job.visited.has(key)) return;
  job.visited.add(key);

  if (item.type === "html" && !isSameOrigin(item.url, job.root)) return;
  if (item.type === "html" && !robotsAllowed(item.url, job.robots)) return;

  try {
    const response = await fetchBuffer(item.url, DEFAULTS.timeoutMs);
    const resource = addResource(job, item, response, item.source);
    markCaptured(job, resource);

    if (!response.ok) {
      log(job, "warn", `${response.status} ${item.url}`);
      return;
    }

    if (resource.type === "html") discoverFromHtml(job, resource);
    else if (resource.type === "css") discoverFromCss(job, resource);
    else if (resource.type === "js") discoverFromJs(job, resource);

    if (resource.type !== "asset") {
      log(job, "debug", `Captured ${resource.type.toUpperCase()} ${item.url}`);
    }
  } catch (e) {
    log(job, "error", `Fetch failed ${item.url} — ${e.name || "Error"}: ${e.message}`);
  }
}

async function workerLoop(job, queueName, limit) {
  while (!job.stop) {
    const item = queueName === "html" ? job.pageQueue.shift() : job.assetQueue.shift();
    if (!item) {
      if (job.runningWorkers === 0 && (job.pageQueue.length || job.assetQueue.length)) continue;
      if (job.activeWorkers === 0) break;
      await new Promise(r => setTimeout(r, 12));
      continue;
    }

    job.activeWorkers++;
    job.runningWorkers++;
    try {
      await processItem(job, item);
      job.processed++;
    } finally {
      job.activeWorkers--;
      job.runningWorkers--;
    }

    if (job.processed >= DEFAULTS.maxUrls) break;
  }
}

async function runCrawl(job) {
  log(job, "info", `High-speed crawl started with ${DEFAULTS.htmlWorkers} HTML workers and ${DEFAULTS.assetWorkers} asset workers.`);

  await fetchRobots(job);
  await fetchSitemaps(job);

  enqueue(job, job.root, "html", null);

  // Keep worker pools alive while discoveries are still arriving.
  await Promise.race([
    (async () => {
      while (!job.stop) {
        if (job.processed >= DEFAULTS.maxUrls) break;
        if (!job.pageQueue.length && !job.assetQueue.length && job.activeWorkers === 0) break;
        await new Promise(r => setTimeout(r, 25));
      }
    })(),
    Promise.resolve()
  ]);

  // Start workers after seed/sitemap discovery; they can continue to consume
  // dynamically added queue entries.
  const htmlWorkers = Array.from({length: DEFAULTS.htmlWorkers}, () => workerLoop(job, "html"));
  const assetWorkers = Array.from({length: DEFAULTS.assetWorkers}, () => workerLoop(job, "asset"));

  // Workers need a shared wake-up loop because JS promises do not have a built-in queue.
  // The simple loops below stay alive until both queues and active fetches are empty.
  let idlePasses = 0;
  while (!job.stop) {
    if (job.processed >= DEFAULTS.maxUrls) break;

    if (job.pageQueue.length || job.assetQueue.length) {
      idlePasses = 0;
    } else if (job.activeWorkers === 0) {
      idlePasses++;
      if (idlePasses > 4) break;
    } else {
      idlePasses = 0;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  await Promise.allSettled([...htmlWorkers, ...assetWorkers]);

  if (job.stop) {
    job.status = "stopped";
    job.statusText = "Stopped by user.";
    log(job, "warn", "Crawl stopped.");
  } else if (job.processed >= DEFAULTS.maxUrls) {
    job.status = "done";
    job.statusText = `Finished at the ${DEFAULTS.maxUrls.toLocaleString()} URL safety limit.`;
    log(job, "warn", "Safety URL limit reached.");
  } else {
    job.status = "done";
    job.statusText = `Complete — queue exhausted after ${job.processed.toLocaleString()} fetched resources.`;
    log(job, "info", "Crawl queue exhausted; no more discovered URLs.");
  }
  job.done = true;
  job.finishedAt = now();
}

function createJob(url) {
  const id = crypto.randomUUID();
  return {
    id,
    url,
    root: url,
    createdAt: now(),
    finishedAt: null,
    done: false,
    stop: false,
    status: "starting",
    statusText: "Starting…",
    pageQueue: [],
    assetQueue: [],
    visited: new Set(),
    discovered: new Set(),
    discoveredCount: 0,
    resources: [],
    resourceByUrl: new Map(),
    links: [],
    robots: null,
    sitemaps: [],
    logs: [],
    logSeq: 0,
    activeWorkers: 0,
    runningWorkers: 0,
    processed: 0,
    counts: { htmlPages: 0, css: 0, js: 0, links: 0 }
  };
}

function publicJob(job) {
  return {
    id: job.id,
    url: job.url,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    done: job.done,
    status: job.status,
    statusText: job.statusText,
    maxUrls: DEFAULTS.maxUrls,
    counts: {
      htmlPages: job.counts.htmlPages,
      css: job.counts.css,
      js: job.counts.js,
      links: job.counts.links,
      processed: job.processed,
      queued: job.pageQueue.length + job.assetQueue.length,
      active: job.activeWorkers
    },
    logs: job.logs.slice(-120)
  };
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "veyra-browse-crawler", time: now() });
});

app.post("/api/crawl", (req, res) => {
  const input = String(req.body?.url || "").trim();
  const url = normalizeUrl(input);
  if (!url || !/^https?:$/i.test(new URL(url).protocol)) {
    return res.status(400).json({ error: "Please provide a public http(s) URL." });
  }

  const active = [...jobs.values()].filter(j => !j.done && !j.stop).length;
  if (active >= 2) {
    return res.status(429).json({ error: "Two crawl jobs are already running. Wait for one to finish." });
  }

  const job = createJob(url);
  jobs.set(job.id, job);
  job.status = "running";
  job.statusText = "Crawling…";
  log(job, "info", "Job accepted for " + url);

  runCrawl(job).catch(err => {
    job.status = "error";
    job.statusText = "Crawler crashed: " + err.message;
    job.done = true;
    job.finishedAt = now();
    log(job, "error", err.stack || err.message);
  });

  res.status(202).json(publicJob(job));
});

app.get("/api/crawl/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  res.json(publicJob(job));
});

app.post("/api/crawl/:id/stop", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  job.stop = true;
  if (!job.done) {
    job.status = "stopping";
    job.statusText = "Stopping…";
  }
  log(job, "warn", "Stop requested.");
  res.json({ ok: true });
});

app.get("/api/crawl/:id/resources", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });

  const resources = job.resources.map(r => ({
    id: r.id,
    url: r.url,
    type: r.type,
    status: r.status,
    bytes: r.bytes,
    bytesLabel: r.bytesLabel,
    truncated: r.truncated,
    sourceId: r.sourceId
  }));
  res.json({ resources });
});

app.get("/api/crawl/:id/source/:resourceId", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });

  const index = Number(req.params.resourceId);
  const resource = Number.isInteger(index) ? job.resources[index] : null;
  if (!resource) return res.status(404).json({ error: "Resource not found." });
  res.json({ id: resource.id, url: resource.url, type: resource.type, source: resource.text });
});

app.get("/api/crawl/:id/links", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  res.json({ links: job.links });
});

app.get("/api/crawl/:id/export", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });

  const exportData = {
    id: job.id,
    root: job.root,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    status: job.status,
    counts: job.counts,
    links: job.links,
    resources: job.resources.map(r => ({
      id: r.id,
      url: r.url,
      type: r.type,
      status: r.status,
      contentType: r.contentType,
      bytes: r.bytes,
      truncated: r.truncated,
      sourceId: r.sourceId,
      source: r.text
    }))
  };

  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="veyra-browse-${job.id}.json"`);
  res.send(JSON.stringify(exportData, null, 2));
});

// Keep memory bounded. Finished jobs are disposable; Render web instances are ephemeral.
setInterval(() => {
  const cutoff = Date.now() - DEFAULTS.maxJobAgeMs;
  for (const [id, job] of jobs) {
    if (job.done && new Date(job.finishedAt || job.createdAt).getTime() < cutoff) {
      jobs.delete(id);
    }
  }
}, 60_000).unref();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Veyra Browse crawler listening on 0.0.0.0:${PORT}`);
});
