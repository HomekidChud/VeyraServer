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

const { URL } = require("url");


let cheerio = null;
try { cheerio = require("cheerio"); } catch {}

/**
 * A single neural robot worker. Fetches and parses pages without Chromium.
 */
class NeuralRobot {
  constructor(id, opts = {}) {
    this.id = id;
    this.status = "idle";      
    this.currentUrl = null;
    this.visited = new Set();
    this.queue = [];
    this.depth = 0;
    this.maxDepth = opts.maxDepth || 3;
    this.maxPages = opts.maxPages || 50;
    this.maxLinksPerPage = opts.maxLinksPerPage || 80;
    this.concurrency = Math.max(1, Math.min(8, Number(opts.concurrency) || 3));
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
      compressedResponses: 0,
      duplicateUrls: 0,
      skippedNonHtml: 0,
    };
    this.neuralModel = opts.neuralModel || null;  
    this.onPageFound = opts.onPageFound || (() => {});
    this.onLinkFound = opts.onLinkFound || (() => {});
    this.onFeedback = opts.onFeedback || (() => {});
    this.fetchPage = typeof opts.fetchPage === "function" ? opts.fetchPage : null;
  }

  /**
   * Fetch a URL as raw HTML — no Chromium needed. 10-50x faster.
   */
  async fetchRaw(url, opts = {}) {
    if (!this.fetchPage) throw Object.assign(new Error("Crawler fetch is unavailable until a socket-validated fetcher is configured."), { code: "SAFE_FETCH_REQUIRED" });
    const response = await this.fetchPage(url, opts);
    const statusCode = Number(response?.statusCode || response?.status || 0);
    if (!response || statusCode < 200 || statusCode >= 300) throw Object.assign(new Error(`HTTP ${statusCode || "fetch failed"}`), { status: statusCode || 502 });
    const finalUrl = String(response.finalUrl || response.url || url);
    const contentType = String(response.contentType || response.headers?.get?.("content-type") || "").toLowerCase();
    const isRobots = new URL(finalUrl).pathname.toLowerCase() === "/robots.txt";
    if (!/(?:text\/html|application\/xhtml\+xml)/i.test(contentType) && !isRobots) throw Object.assign(new Error(`Not HTML: ${contentType || "unknown content type"}`), { code: "CONTENT_TYPE_UNSUPPORTED" });
    const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(String(response.html || response.body || ""), "utf8");
    if (body.length > (opts.maxBytes || 8 * 1024 * 1024)) throw Object.assign(new Error("Page too large"), { code: "RESPONSE_TOO_LARGE" });
    return { url: finalUrl, html: body.toString("utf8"), statusCode, headers: response.headers || {}, bytes: body.length, contentType };
  }

  /**
   * Parse HTML and extract links, title, text, metadata — no Chromium needed.
   */
  parseHtml(html, baseUrl) {
    if (!cheerio) {
      
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

    
    const metadata = {};
    $('meta[name], meta[property]').each((i, el) => {
      const name = $(el).attr("name") || $(el).attr("property");
      const content = $(el).attr("content");
      if (name && content) metadata[name] = content;
    });

    
    $("script, style, noscript, svg, template, nav, header, footer, aside, form, [role='navigation'], [aria-hidden='true'], [class*='cookie'], [id*='cookie'], [class*='advert'], [id*='advert'], [class*='social'], [class*='share']").remove();
    const text = String($("main, article").first().text() || $("body").text()).replace(/\s+/g, " ").trim().slice(0, 5000);

    
    const headings = [];
    $("h1, h2, h3").each((i, el) => {
      if (i < 20) headings.push($(el).text().trim());
    });

    const canonical = $("link[rel='canonical']").attr("href") || "";
    const language = $("html").attr("lang") || "";
    const jsonLd = [];
    $("script[type='application/ld+json']").each((i, el) => {
      if (i >= 4) return false;
      try { jsonLd.push(JSON.parse($(el).text())); } catch {}
    });
    const passages = [];
    $("main,article,section,p,li").each((i, el) => {
      if (i >= 80) return false;
      const value = $(el).text().replace(/\s+/g, " ").trim();
      if (value.length >= 45) passages.push(value.slice(0, 500));
    });
    return { title, links, text, metadata, headings, canonical, language, jsonLd, passages };
  }

  /**
   * Score a page using the neural model. Returns 0-1 relevance score.
   */
  scorePage(pageInfo, query, depth) {
    if (!this.neuralModel || typeof this.neuralModel.score !== "function") {
      
      let score = 0.5;
      if (pageInfo.title) score += 0.1;
      if (pageInfo.text && pageInfo.text.length > 200) score += 0.1;
      if (pageInfo.metadata["og:title"]) score += 0.05;
      if (depth === 0) score += 0.15;
      if (pageInfo.links && pageInfo.links.length > 10) score += 0.1;
      const lexical = this.textRelevance(pageInfo.text + " " + pageInfo.title, query);
      return Math.min(1, score * 0.55 + lexical * 0.45);
    }

    const features = [0.5, 0.5, 1.0, Math.max(0, 1 - depth * 0.2), 0.5,
      this.textRelevance(pageInfo.text + " " + pageInfo.title, query), 0.5, 0.8, 0.5, 0.5];
    const neural = this.neuralModel.score(features);
    const lexical = features[5];
    return Math.max(0, Math.min(1, neural * 0.55 + lexical * 0.45));
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

  canonicalUrl(raw, base = "") {
    try {
      const u = new URL(raw, base || undefined);
      if (!/^https?:$/.test(u.protocol)) return "";
      u.hash = ""; u.hostname = u.hostname.toLowerCase();
      for (const key of [...u.searchParams.keys()]) if (/^(utm_|gclid|fbclid|mc_|ref|source|session|click)/i.test(key)) u.searchParams.delete(key);
      if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
      if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "");
      return u.href;
    } catch { return ""; }
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
      
      this.robotsCache.set(u.host, { isAllowed: () => true });
      return true;
    }
  }

  parseRobots(txt) {
    const groups = []; let group = null;
    for (const raw of String(txt || "").split(/\r?\n/)) {
      const line = raw.replace(/#.*/, "").trim(); if (!line) continue;
      const m = line.match(/^([^:]+):\s*(.*)$/); if (!m) continue;
      const key = m[1].toLowerCase(), value = m[2].trim();
      if (key === "user-agent") { if (!group || group.rules.length) { group = { agents: [], rules: [] }; groups.push(group); } group.agents.push(value.toLowerCase()); }
      else if ((key === "allow" || key === "disallow") && group) group.rules.push({ type: key, path: value });
    }
    const bot = this.userAgent.toLowerCase();
    const selected = groups.find(g => g.agents.some(a => a !== "*" && bot.includes(a))) || groups.find(g => g.agents.includes("*"));
    return {
      isAllowed(path) {
        if (!selected) return true;
        const matching = selected.rules.filter(r => r.path && path.startsWith(r.path)).sort((a, b) => b.path.length - a.path.length);
        return !matching.length || matching[0].type === "allow";
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

    
    const allowed = await this.checkRobots(url);
    if (!allowed) {
      this.status = "idle";
      return null;
    }

    try {
      const res = await this.fetchRaw(url);
      const parsed = this.parseHtml(res.html, res.url || url);
      const score = this.scorePage(parsed, query, depth);
      const latency = Date.now() - start;

      this.stats.pagesCrawled++;
      this.stats.linksFound += parsed.links.length;
      this.stats.bytesFetched += res.bytes;
      this.stats.avgLatencyMs = (this.stats.avgLatencyMs * (this.stats.pagesCrawled - 1) + latency) / this.stats.pagesCrawled;

      const page = {
        url: this.canonicalUrl(parsed.canonical || res.url || url), title: parsed.title, text: parsed.text, links: parsed.links.map(link => this.canonicalUrl(link, res.url || url)).filter(Boolean),
        metadata: parsed.metadata, headings: parsed.headings, passages: parsed.passages || [], language: parsed.language || "", jsonLd: parsed.jsonLd || [],
        score, query, queryRelevance: this.textRelevance(`${parsed.title} ${parsed.text} ${(parsed.headings || []).join(" ")}`, query), depth, latency, bytes: res.bytes,
        timestamp: Date.now(),
      };

      this.onPageFound(page);
      page.links.forEach(link => this.onLinkFound(link, page.url, score));

      
      for (const link of page.links) {
        if (!this.visited.has(link) && depth < this.maxDepth) {
          const lexical = this.textRelevance(link, query);
          const neural = this.neuralModel?.scoreUrl ? this.neuralModel.scoreUrl(link, { type: "html", internal: new URL(link).hostname === new URL(page.url).hostname }) : score;
          const priority = neural + lexical * 2;
          this.queue.push({ url: link, depth: depth + 1, priority });
        }
      }
      this.queue.sort((a, b) => (b.priority || 0) - (a.priority || 0));

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
    this.queue = [{ url: this.canonicalUrl(seedUrl), depth: 0, priority: 1 }];
    this.stats = { pagesCrawled: 0, linksFound: 0, errors: 0, startTime: Date.now(), bytesFetched: 0, avgLatencyMs: 0, compressedResponses: 0, duplicateUrls: 0, skippedNonHtml: 0 };
    this.maxDepth = opts.maxDepth || this.maxDepth;
    this.maxPages = opts.maxPages || this.maxPages;

    const results = [], active = new Set();
    let started = 0;
    this.status = "crawling";
    const pump = async () => {
      while (this.queue.length && started < this.maxPages && this.status !== "paused") {
        const item = this.queue.shift();
        if (!item?.url || this.visited.has(item.url)) { this.stats.duplicateUrls++; continue; }
        this.visited.add(item.url);
        started++;
        const task = this.crawlPage(item.url, query, item.depth).then(page => { if (page) results.push(page); }).finally(() => active.delete(task));
        active.add(task);
        if (active.size >= this.concurrency) await Promise.race(active);
      }
      await Promise.all(active);
    };
    await pump();
    this.status = "idle";

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
      compressedResponses: this.stats.compressedResponses,
      duplicateUrls: this.stats.duplicateUrls,
      skippedNonHtml: this.stats.skippedNonHtml,
      queueSize: this.queue.length,
      visitedCount: this.visited.size,
      uptime: this.stats.startTime ? Date.now() - this.stats.startTime : 0,
    };
  }

  reset() {
    this.visited.clear();
    this.queue = [];
    this.stats = { pagesCrawled: 0, linksFound: 0, errors: 0, startTime: 0, bytesFetched: 0, avgLatencyMs: 0, compressedResponses: 0, duplicateUrls: 0, skippedNonHtml: 0 };
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
        ...opts,
        neuralModel: this.neuralModel,
        onPageFound: (page) => { this.logPage(page); opts.onPageFound?.(page); },
        onLinkFound: (url, fromUrl, score) => this.logLink(url, fromUrl, score),
        onFeedback: (url, clicked, relevance) => this.logFeedback(url, clicked, relevance),
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
