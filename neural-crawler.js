"use strict";
/**
 * Veyra Neural Crawler — a trainable relevance model that learns from user
 * interactions to prioritise which URLs to crawl and index.
 *
 * Architecture:
 *   - Feature extraction: each discovered URL is converted to a feature vector
 *     (domain authority, link context, content type, depth, freshness, etc.)
 *   - Weight vector: a simple single-layer neural model (logistic regression
 *     with a learned bias). Weights are updated via gradient descent on
 *     user feedback signals.
 *   - Feedback signals: clicks on search results, bookmarks, time spent on
 *     a page, tab opens, reloads, and explicit "useful" / "not useful" votes.
 *   - Priority queue: the crawler's frontier is re-ranked by the neural
 *     model's predicted relevance score.
 *   - Persistence: the weight vector is saved to disk periodically and
 *     restored on startup.
 *
 * This is intentionally lightweight (no external ML libraries). It runs in
 * the same Node.js process as the server and adds < 1ms per scoring call.
 */

const fs = require("fs");
const path = require("path");

// ----------------------------------------------------------------- utilities
function sigmoid(x) { return 1 / (1 + Math.exp(-Math.max(-50, Math.min(50, x)))); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function now() { return Date.now(); }
function safeHost(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
function safePath(url) { try { return new URL(url).pathname; } catch { return ""; } }
function safeScheme(url) { try { return new URL(url).protocol.replace(":", ""); } catch { return ""; } }

// ----------------------------------------------------------------- features
// Each feature is a number in [0, 1]. The model learns weights for each.
const FEATURE_NAMES = [
  "domainAuthority",    // Is this a well-known, high-quality domain?
  "linkContextScore",   // Was the link found in a prominent position?
  "contentTypeScore",   // Is this likely to be valuable content (HTML vs asset)?
  "depthScore",         // How deep in the site is this URL? (shallower = better)
  "freshnessScore",     // Is this a recently-discovered URL?
  "relevanceScore",     // Does the URL text match common search patterns?
  "internalLinkScore",  // Is this an internal link (same-origin)?
  "resourceTypeScore",  // Is this a page vs a resource?
  "clickProbability",   // Predicted probability of being clicked
  "domainDiversity",    // Does this domain add diversity to results?
];

const NUM_FEATURES = FEATURE_NAMES.length;

// Well-known high-quality domains for domain authority scoring
const HIGH_AUTHORITY_DOMAINS = new Set([
  "wikipedia.org", "github.com", "stackoverflow.com", "developer.mozilla.org",
  "w3.org", "python.org", "nodejs.org", "reactjs.org", "vuejs.org",
  "angular.io", "typescriptlang.org", "rust-lang.org", "golang.org",
  "java.com", "oracle.com", "ibm.com", "microsoft.com", "apple.com",
  "google.com", "amazon.com", "bbc.com", "nytimes.com", "theguardian.com",
  "nature.com", "science.org", "arxiv.org", "ieee.org", "acm.org",
  "mit.edu", "stanford.edu", "berkeley.edu", "cam.ac.uk", "ox.ac.uk",
  "json.org", "ecma-international.org", "whatwg.org", "spec.whatwg.org",
  "developer.chrome.com", "web.dev", "caniuse.com", "npmjs.com",
  "pypi.org", "crates.io", "rubygems.org", "mvnrepository.com",
  "dev.to", "medium.com", "hackernoon.com", "css-tricks.com",
  "smashingmagazine.com", "alistapart.com", "web.dev",
]);

// ----------------------------------------------------------------- model
class NeuralCrawlerModel {
  constructor(opts = {}) {
    this.weights = new Float64Array(NUM_FEATURES);
    this.bias = 0;
    this.learningRate = opts.learningRate || 0.01;
    this.l2Regularization = opts.l2Regularization || 0.001;
    this.trainingExamples = 0;
    this.feedbackHistory = [];
    this.maxHistory = opts.maxHistory || 10000;
    this.savePath = opts.savePath || "";
    this.lastSaveAt = 0;
    this.saveIntervalMs = opts.saveIntervalMs || 60000; // save at most once per minute
    this.domainClickCounts = new Map(); // domain -> click count
    this.domainVisitCounts = new Map(); // domain -> visit count
    this.urlFeatures = new Map(); // url -> feature vector (cache)
    this.maxUrlCache = opts.maxUrlCache || 50000;
    this.stats = {
      scored: 0, trained: 0, positiveFeedback: 0, negativeFeedback: 0,
      avgScore: 0, domainDiversityScore: 0
    };
  }

  // Extract features from a URL and its discovery context
  extractFeatures(url, context = {}) {
    const host = safeHost(url);
    const urlPath = safePath(url);
    const scheme = safeScheme(url);

    // Domain authority: is this a known high-quality domain?
    let domainAuthority = 0.1;
    const baseHost = host.split(".").slice(-2).join(".");
    if (HIGH_AUTHORITY_DOMAINS.has(host) || HIGH_AUTHORITY_DOMAINS.has(baseHost)) {
      domainAuthority = 0.9;
    }
    // Domains that have been clicked before get a boost
    const clickCount = this.domainClickCounts.get(host) || 0;
    if (clickCount > 0) domainAuthority = Math.min(1, domainAuthority + 0.1 * Math.log(1 + clickCount));

    // Link context: was this found in a prominent position?
    const linkContextScore = clamp({
      "html": 0.7, "css": 0.3, "js": 0.4, "data": 0.5,
      "image": 0.2, "media": 0.2, "font": 0.1, "asset": 0.15,
      "sitemap": 0.6, "broad-scan": 0.3, "attribute-scan": 0.25,
      "lazy-attribute": 0.35, "preload-runtime": 0.4,
      "css-url": 0.2, "css-import": 0.25, "json-discovered": 0.45,
      "media-manifest": 0.3, "link-header": 0.4,
    }[context.type] || 0.3, 0, 1);

    // Content type: HTML pages are more valuable than assets
    const contentTypeScore = context.type === "html" ? 0.85 : 0.3;

    // Depth: shallower URLs are generally more important
    const pathSegments = urlPath.split("/").filter(Boolean);
    const depthScore = clamp(1 - pathSegments.length * 0.15, 0.1, 1);

    // Freshness: recently discovered URLs get a small boost
    const ageMs = context.discoveredAt ? now() - context.discoveredAt : 0;
    const freshnessScore = clamp(1 - ageMs / (30 * 60 * 1000), 0.3, 1);

    // Relevance: does the URL text contain common search terms?
    const urlText = (host + " " + urlPath).toLowerCase();
    const commonTerms = ["api", "docs", "guide", "tutorial", "reference", "example",
      "blog", "news", "article", "wiki", "learn", "course", "book", "manual"];
    const relevanceScore = clamp(commonTerms.filter(t => urlText.includes(t)).length / 3, 0, 1);

    // Internal link: same-origin links are more likely to be valuable
    const internalLinkScore = context.internal ? 0.7 : 0.4;

    // Resource type: pages vs resources
    const resourceTypeScore = context.type === "html" ? 0.8 : 0.3;

    // Click probability: predicted by the model (initially 0.5)
    const features = [
      domainAuthority, linkContextScore, contentTypeScore, depthScore,
      freshnessScore, relevanceScore, internalLinkScore, resourceTypeScore,
      0.5, // clickProbability placeholder (updated below)
      0.5, // domainDiversity placeholder (updated below)
    ];

    // Compute click probability from the model
    const score = this.score(features);
    features[8] = clamp(score, 0, 1);

    // Domain diversity: has this domain been visited a lot already?
    const visitCount = this.domainVisitCounts.get(host) || 0;
    features[9] = clamp(1 - visitCount * 0.05, 0.1, 1);

    return features;
  }

  // Score a feature vector using the neural model
  score(features) {
    let z = this.bias;
    for (let i = 0; i < NUM_FEATURES; i++) {
      z += this.weights[i] * features[i];
    }
    return sigmoid(z);
  }

  // Score a URL with context
  scoreUrl(url, context = {}) {
    this.stats.scored++;
    let features = this.urlFeatures.get(url);
    if (!features) {
      features = this.extractFeatures(url, context);
      this.urlFeatures.set(url, features);
      if (this.urlFeatures.size > this.maxUrlCache) {
        // Evict oldest entries (Map maintains insertion order)
        const firstKey = this.urlFeatures.keys().next().value;
        this.urlFeatures.delete(firstKey);
      }
    }
    const s = this.score(features);
    this.stats.avgScore = (this.stats.avgScore * 0.99) + (s * 0.01);
    return s;
  }

  // Train the model on a feedback signal
  // feedback: { url, positive: boolean, weight: number, context: {} }
  train(feedback) {
    const url = feedback.url;
    if (!url) return;

    const features = this.urlFeatures.get(url) || this.extractFeatures(url, feedback.context || {});
    const target = feedback.positive ? 1 : 0;
    const weight = feedback.weight || 1.0;

    // Forward pass
    const predicted = this.score(features);
    const error = predicted - target;

    // Backward pass: gradient descent
    const gradient = error * weight;
    for (let i = 0; i < NUM_FEATURES; i++) {
      // L2 regularization
      const reg = this.l2Regularization * this.weights[i];
      this.weights[i] -= this.learningRate * (gradient * features[i] + reg);
    }
    this.bias -= this.learningRate * gradient;

    // Track domain statistics
    const host = safeHost(url);
    if (feedback.positive) {
      this.domainClickCounts.set(host, (this.domainClickCounts.get(host) || 0) + 1);
      this.stats.positiveFeedback++;
    } else {
      this.stats.negativeFeedback++;
    }

    // Record feedback
    this.feedbackHistory.push({ url, positive: feedback.positive, weight, ts: now() });
    if (this.feedbackHistory.length > this.maxHistory) this.feedbackHistory.shift();

    this.trainingExamples += 1;
    this.stats.trained++;
    this.maybeSave();
  }

  // Record a domain visit (for diversity scoring)
  recordVisit(url) {
    const host = safeHost(url);
    this.domainVisitCounts.set(host, (this.domainVisitCounts.get(host) || 0) + 1);
  }

  // Get crawl priority for a URL (higher = more important to crawl)
  crawlPriority(url, context = {}) {
    const score = this.scoreUrl(url, context);
    // Combine neural score with existing priority factors
    const basePriority = context.priority || 0;
    // Neural score is in [0, 1], scale to [-50, +50] range for frontier
    const neuralBoost = (score - 0.5) * 100;
    return basePriority + neuralBoost;
  }

  // Save model weights to disk
  maybeSave() {
    if (!this.savePath) return;
    if (now() - this.lastSaveAt < this.saveIntervalMs) return;
    this.lastSaveAt = now();
    this.save();
  }

  save() {
    if (!this.savePath) return;
    try {
      const data = this.serialize();
      fs.writeFileSync(this.savePath, JSON.stringify(data, null, 2));
    } catch (e) {
      // Silent fail — model persistence is best-effort
    }
  }

  serialize() {
    return {
        version: 1,
        weights: Array.from(this.weights),
        bias: this.bias,
        trainingExamples: this.trainingExamples,
        stats: { ...this.stats },
        domainClickCounts: Object.fromEntries(this.domainClickCounts),
        domainVisitCounts: Object.fromEntries(this.domainVisitCounts),
        savedAt: new Date().toISOString(),
    };
  }

  loadData(data) {
    if (!data || data.version !== 1) return false;
    const w = data.weights || [];
    for (let i = 0; i < NUM_FEATURES && i < w.length; i++) this.weights[i] = Number(w[i]) || 0;
    this.bias = Number(data.bias) || 0;
    this.trainingExamples = Number(data.trainingExamples) || 0;
    if (data.stats) Object.assign(this.stats, data.stats);
    this.domainClickCounts.clear();
    for (const [k, v] of Object.entries(data.domainClickCounts || {})) this.domainClickCounts.set(k, Number(v) || 0);
    this.domainVisitCounts.clear();
    for (const [k, v] of Object.entries(data.domainVisitCounts || {})) this.domainVisitCounts.set(k, Number(v) || 0);
    return true;
  }

  // Load model weights from disk
  load() {
    if (!this.savePath) return false;
    try {
      if (!fs.existsSync(this.savePath)) return false;
      return this.loadData(JSON.parse(fs.readFileSync(this.savePath, "utf8")));
    } catch {
      return false;
    }
  }

  // Get a report for the DevTools / admin panel
  report() {
    const topDomains = [...this.domainClickCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([domain, clicks]) => ({ domain, clicks }));
    return {
      enabled: true,
      features: FEATURE_NAMES,
      weights: Array.from(this.weights),
      bias: this.bias,
      trainingExamples: this.stats.trained,
      stats: { ...this.stats },
      topDomains,
      feedbackCount: this.feedbackHistory.length,
      urlCacheSize: this.urlFeatures.size,
      domainCount: this.domainClickCounts.size,
    };
  }

  // Reset the model (for testing or retraining)
  reset() {
    this.weights = new Float64Array(NUM_FEATURES);
    this.bias = 0;
    this.trainingExamples = 0;
    this.feedbackHistory = [];
    this.domainClickCounts.clear();
    this.domainVisitCounts.clear();
    this.urlFeatures.clear();
    this.stats = { scored: 0, trained: 0, positiveFeedback: 0, negativeFeedback: 0, avgScore: 0, domainDiversityScore: 0 };
  }
}

module.exports = { NeuralCrawlerModel, FEATURE_NAMES, NUM_FEATURES, HIGH_AUTHORITY_DOMAINS };
