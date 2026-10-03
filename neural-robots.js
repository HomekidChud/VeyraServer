"use strict";
/**
 * Veyra Neural Robot Workers — trainable crawling robots that work WITHOUT Chromium.
 *
 * Each robot worker is a lightweight headless crawler that:
 *   - Fetches pages via HTTP (no browser needed)
 *   - Parses HTML with cheerio
 *   - Extracts links, content, and metadata
 *   - Scores pages using the neural model
 *   - Learns from click feedback
 *   - Can run in parallel with multiple workers
 *
 * This solves the "Chromium is slow" problem for crawling — most pages
 * can be fetched and parsed as raw HTML, which is 10-50x faster than
 * spinning up a full browser.
 *
 * Integration in server.js:
 *   const { NeuralRobotPool } = require('./neural-robots');
 *   const robotPool = new NeuralRobotPool({ maxWorkers: 8, neuralModel });
 *   app.get('/api/robots/status', (req, res) => res.json(robotPool.report()));
 *   app.post('/api/robots/crawl', (req, res) => robotPool.startCrawl(req.body.seed, req.body));
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");
const path = require("path");

// Try to load cheerio (should be available in VeyraBackend)
let cheerio = null;
try { cheerio = require("cheerio"); } catch {}

/**
 * A single neural robot worker. Fetches and parses pages without Chromium.
 */
class NeuralRobot {
  constructor(id, opts = {}) {
    this.id = id;
    this.status = "idle";      // idle | crawling | paused | error
    this.currentUrl = null;
    this.visited = new Set();
    this.queue = [];
    this.depth = 0;
    this.maxDepth = opts.maxDepth || 3;
    this.maxPages = opts.maxPages || 50;
    this.maxLinksPerPage = opts.maxLinksPerPage || 30;
    this.timeoutMs = opts.timeoutMs || 10000;
    this.userAgent = opts.userAgent || "VeyraNeuralBot/1.0 (+https://veyra.app/bot)";
    this.respectRobots = opts.respectRobots !== false;
    this.robotsCache = new Map();
    this.stats = {
      pagesCrawled: 0,
      linksFound: 0,
      errors: 0,
      startTime: 0,
      bytesFetched: 0,
      avgLatencyMs: 0,
    };
    this.neuralModel = opts.neuralModel || null;  // Reference to NeuralCrawler model
    this.onPageFound = opts.onPageFound || (() => {});
    this.onLinkFound = opts.onLinkFound || (() => {});
    this.onFeedback = opts.onFeedback || (() => {});
  }

  /**
   * Fetch a URL as raw HTML — no Chromium needed. 10-50x faster.
   */
  fetchRaw(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;
      const headers = {
        "User-Agent": this.userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en;q=0.9",
        "Accept-Encoding": "identity",  // No gzip to keep it simple
        "Connection": "close",
        ...opts.headers,
      };

      const req = lib.get(url, { headers, timeout: opts.timeoutMs || this.timeoutMs }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirect = new URL(res.headers.location, url).href;
          if (this.visited.has(redirect)) return reject(new Error("Redirect loop"));
          return resolve(this.fetchRaw(redirect, opts));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const contentType = res.headers["content-type"] || "";
        if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
          res.resume();
          return reject(new Error(`Not HTML: ${contentType}`));
        }
        let data = "";
        let bytes = 0;
        const maxBytes = 5 * 1024 * 1024; // 5MB limit
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) { res.destroy(); reject(new Error("Page too large")); return; }
          data += chunk;
        });
        res.on("end", () => {
          resolve({
            url: url,
            html: data,
            statusCode: res.statusCode,
            headers: res.headers,
            bytes: bytes,
            contentType: contentType,
          });
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    });
  }

  /**
   * Parse HTML and extract links, title, text, metadata — no Chromium needed.
   */
  parseHtml(html, baseUrl) {
    if (!cheerio) {
      // Fallback: regex-based extraction (less accurate but works)
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";
      const links = [];
      const linkRegex = /<a[^>]+href=["']([^"']+)["']/gi;
      let m;
      while ((m = linkRegex.exec(html)) !== null) {
        try { links.push(new URL(m[1], baseUrl).href); } catch {}
      }
      const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 5000);
      return { title, links: links.slice(0, this.maxLinksPerPage), text, metadata: {} };
    }

    const $ = cheerio.load(html);
    const title = $("title").text().trim() || $("h1").first().text().trim() || "";
    const links = [];
    $("a[href]").each((i, el) => {
      if (i >= this.maxLinksPerPage) return false;
      const href = $(el).attr("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) return;
      try { links.push(new URL(href, baseUrl).href); } catch {}
    });

    // Extract meta tags
    const metadata = {};
    $('meta[name], meta[property]').each((i, el) => {
      const name = $(el).attr("name") || $(el).attr("property");
      const content = $(el).attr("content");
      if (name && content) metadata[name] = content;
    });

    // Extract text content (strip scripts/styles)
    $("script, style, noscript").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 5000);

    // Extract headings
    const headings = [];
    $("h1, h2, h3").each((i, el) => {
      if (i < 20) headings.push($(el).text().trim());
    });

    return { title, links, text, metadata, headings };
  }

  /**
   * Score a page using the neural model. Returns 0-1 relevance score.
   */
  scorePage(pageInfo, query, depth) {
    if (!this.neuralModel || typeof this.neuralModel.score !== "function") {
      // Fallback heuristic scoring
      let score = 0.5;
      if (pageInfo.title) score += 0.1;
      if (pageInfo.text && pageInfo.text.length > 200) score += 0.1;
      if (pageInfo.metadata["og:title"]) score += 0.05;
      if (depth === 0) score += 0.15;
      if (pageInfo.links && pageInfo.links.length > 10) score += 0.1;
      return Math.min(score, 1.0);
    }

    const features = [0.5, 0.5, 1.0, Math.max(0, 1 - depth * 0.2), 0.5,
      this.textRelevance(pageInfo.text + " " + pageInfo.title, query), 0.5, 0.8, 0.5, 0.5];
    return this.neuralModel.score(features);
  }

  /**
   * Simple text relevance: count query terms in text.
   */
  textRelevance(text, query) {
    if (!text || !query) return 0;
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (!terms.length) return 0;
    const lower = text.toLowerCase();
    let hits = 0;
    for (const t of terms) { if (lower.includes(t)) hits++; }
    return Math.min(hits / terms.length, 1.0);
  }

  /**
   * Check robots.txt for a domain.
   */
  async checkRobots(url) {
    if (!this.respectRobots) return true;
    const u = new URL(url);
    const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
    if (this.robotsCache.has(u.host)) {
      const rules = this.robotsCache.get(u.host);
      return rules.isAllowed(u.pathname);
    }
    try {
      const res = await this.fetchRaw(robotsUrl, { timeoutMs: 5000 });
      const rules = this.parseRobots(res.html);
      this.robotsCache.set(u.host, rules);
      return rules.isAllowed(u.pathname);
    } catch {
      // If robots.txt can't be fetched, allow crawling
      this.robotsCache.set(u.host, { isAllowed: () => true });
      return true;
    }
  }

  parseRobots(txt) {
    const rules = { allowed: [], disallowed: [] };
    const lines = txt.split("\n");
    for (const line of lines) {
      const m = line.match(/^\s*(Allow|Disallow):\s*(.*)/i);
      if (m) {
        if (m[1].toLowerCase() === "allow") rules.allowed.push(m[2].trim());
        else rules.disallowed.push(m[2].trim());
      }
    }
    return {
      isAllowed(path) {
        for (const d of rules.disallowed) {
          if (d === "/" || path.startsWith(d)) {
            for (const a of rules.allowed) { if (path.startsWith(a)) return true; }
            return false;
          }
        }
        return true;
      },
    };
  }

  /**
   * Crawl a single page. Returns the extracted info.
   */
  async crawlPage(url, query, depth) {
    this.currentUrl = url;
    this.status = "crawling";
    const start = Date.now();

    // Check robots.txt
    const allowed = await this.checkRobots(url);
    if (!allowed) {
      this.status = "idle";
      return null;
    }

    try {
      const res = await this.fetchRaw(url);
      const parsed = this.parseHtml(res.html, url);
      const score = this.scorePage(parsed, query, depth);
      const latency = Date.now() - start;

      this.stats.pagesCrawled++;
      this.stats.linksFound += parsed.links.length;
      this.stats.bytesFetched += res.bytes;
      this.stats.avgLatencyMs = (this.stats.avgLatencyMs * (this.stats.pagesCrawled - 1) + latency) / this.stats.pagesCrawled;

      const page = {
        url, title: parsed.title, text: parsed.text, links: parsed.links,
        metadata: parsed.metadata, headings: parsed.headings,
        score, depth, latency, bytes: res.bytes,
        timestamp: Date.now(),
      };

      this.onPageFound(page);
      parsed.links.forEach(link => this.onLinkFound(link, url, score));

      // Add discovered links to queue
      for (const link of parsed.links) {
        if (!this.visited.has(link) && depth < this.maxDepth) {
          this.queue.push({ url: link, depth: depth + 1 });
        }
      }

      this.status = "idle";
      this.currentUrl = null;
      return page;
    } catch (e) {
      this.stats.errors++;
      this.status = "idle";
      this.currentUrl = null;
      return null;
    }
  }

  /**
   * Start a crawl from a seed URL.
   */
  async startCrawl(seedUrl, query = "", opts = {}) {
    this.visited.clear();
    this.queue = [{ url: seedUrl, depth: 0 }];
    this.stats = { pagesCrawled: 0, linksFound: 0, errors: 0, startTime: Date.now(), bytesFetched: 0, avgLatencyMs: 0 };
    this.maxDepth = opts.maxDepth || this.maxDepth;
    this.maxPages = opts.maxPages || this.maxPages;

    const results = [];
    while (this.queue.length > 0 && results.length < this.maxPages && this.status !== "paused") {
      const { url, depth } = this.queue.shift();
      if (this.visited.has(url)) continue;
      this.visited.add(url);

      const page = await this.crawlPage(url, query, depth);
      if (page) results.push(page);
    }

    return {
      pages: results,
      stats: this.report(),
      query,
    };
  }

  /**
   * Learn from click feedback — adjusts the neural model.
   */
  learn(url, clicked, relevance) {
    if (this.neuralModel && typeof this.neuralModel.train === "function") {
      this.neuralModel.train({
        url,
        positive: !!clicked,
        weight: Math.max(0.05, Math.min(5, Number(relevance) || 0.5)),
        context: { type: "html", relevanceScore: Number(relevance) || 0.5 }
      });
      this.onFeedback(url, clicked, relevance);
    }
  }

  report() {
    return {
      id: this.id,
      status: this.status,
      currentUrl: this.currentUrl,
      pagesCrawled: this.stats.pagesCrawled,
      linksFound: this.stats.linksFound,
      errors: this.stats.errors,
      bytesFetched: this.stats.bytesFetched,
      avgLatencyMs: Math.round(this.stats.avgLatencyMs),
      queueSize: this.queue.length,
      visitedCount: this.visited.size,
      uptime: this.stats.startTime ? Date.now() - this.stats.startTime : 0,
    };
  }

  reset() {
    this.visited.clear();
    this.queue = [];
    this.stats = { pagesCrawled: 0, linksFound: 0, errors: 0, startTime: 0, bytesFetched: 0, avgLatencyMs: 0 };
    this.status = "idle";
    this.currentUrl = null;
  }
}

/**
 * Pool of neural robot workers for parallel crawling.
 */
class NeuralRobotPool {
  constructor(opts = {}) {
    this.maxWorkers = opts.maxWorkers || 8;
    this.workers = [];
    this.neuralModel = opts.neuralModel || null;
    this.crawlLog = [];
    this.maxLogSize = 1000;

    for (let i = 0; i < this.maxWorkers; i++) {
      this.workers.push(new NeuralRobot(i, {
        neuralModel: this.neuralModel,
        onPageFound: (page) => this.logPage(page),
        onLinkFound: (url, fromUrl, score) => this.logLink(url, fromUrl, score),
        onFeedback: (url, clicked, relevance) => this.logFeedback(url, clicked, relevance),
        ...opts,
      }));
    }
  }

  logPage(page) {
    this.crawlLog.push({ type: "page", ...page, timestamp: Date.now() });
    if (this.crawlLog.length > this.maxLogSize) this.crawlLog.shift();
  }

  logLink(url, fromUrl, score) {
    this.crawlLog.push({ type: "link", url, fromUrl, score, timestamp: Date.now() });
    if (this.crawlLog.length > this.maxLogSize) this.crawlLog.shift();
  }

  logFeedback(url, clicked, relevance) {
    this.crawlLog.push({ type: "feedback", url, clicked, relevance, timestamp: Date.now() });
    if (this.crawlLog.length > this.maxLogSize) this.crawlLog.shift();
  }

  /**
   * Start a parallel crawl from multiple seed URLs.
   */
  async startCrawl(seeds, query, opts = {}) {
    const seedList = Array.isArray(seeds) ? seeds : [seeds];
    const activeWorkers = this.workers.filter(w => w.status === "idle");
    const promises = [];

    for (let i = 0; i < seedList.length && i < activeWorkers.length; i++) {
      promises.push(activeWorkers[i].startCrawl(seedList[i], query, opts));
    }

    const results = await Promise.allSettled(promises);
    return results.map((r, i) => ({
      seed: seedList[i],
      status: r.status,
      result: r.status === "fulfilled" ? r.value : null,
      error: r.status === "rejected" ? r.reason?.message : null,
    }));
  }

  /**
   * Send feedback to all workers for neural learning.
   */
  sendFeedback(url, clicked, relevance) {
    for (const w of this.workers) w.learn(url, clicked, relevance);
  }

  /**
   * Get a status report for all workers.
   */
  report() {
    return {
      totalWorkers: this.workers.length,
      active: this.workers.filter(w => w.status === "crawling").length,
      idle: this.workers.filter(w => w.status === "idle").length,
      error: this.workers.filter(w => w.status === "error").length,
      totalPagesCrawled: this.workers.reduce((sum, w) => sum + w.stats.pagesCrawled, 0),
      totalLinksFound: this.workers.reduce((sum, w) => sum + w.stats.linksFound, 0),
      totalErrors: this.workers.reduce((sum, w) => sum + w.stats.errors, 0),
      totalBytesFetched: this.workers.reduce((sum, w) => sum + w.stats.bytesFetched, 0),
      workers: this.workers.map(w => w.report()),
      logEntries: this.crawlLog.length,
    };
  }

  /**
   * Get the crawl log (recent pages/links found).
   */
  getLog(limit = 50) {
    return this.crawlLog.slice(-limit);
  }

  /**
   * Reset all workers.
   */
  resetAll() {
    for (const w of this.workers) w.reset();
    this.crawlLog = [];
  }
}

module.exports = { NeuralRobot, NeuralRobotPool };
