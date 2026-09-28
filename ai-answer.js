"use strict";
/**
 * Veyra AI Search Answer — reads search results and generates a summary answer.
 *
 * When a user searches for something like "what does looksmaxxing mean?",
 * this module:
 *   1. Fetches the top search results' page content (via the neural robots)
 *   2. Extracts the most relevant paragraphs
 *   3. Generates a concise answer summary
 *   4. Returns it as an "AI Answer" card above the search results
 *
 * If it can't find a confident answer, it returns nothing (no AI card shown).
 *
 * No external AI API needed — uses extractive summarization:
 *   - TextRank-like scoring of sentences
 *   - Query relevance scoring
 *   - Answer pattern detection (definition, how-to, factual)
 *
 * Integration in server.js:
 *   const { AIAnswerEngine } = require('./ai-answer');
 *   const aiAnswer = new AIAnswerEngine();
 *   app.post('/api/search/answer', async (req, res) => {
 *     const result = await aiAnswer.answer(req.body.query, req.body.results || []);
 *     res.json(result);
 *   });
 */

const https = require("https");
const http = require("http");
const { URL } = require("url");

class AIAnswerEngine {
  constructor(opts = {}) {
    this.maxPagesToRead = opts.maxPagesToRead || 3;
    this.maxContentBytes = opts.maxContentBytes || 50000;
    this.timeoutMs = opts.timeoutMs || 8000;
    this.minConfidence = opts.minConfidence || 0.15;
    this.userAgent = opts.userAgent || "VeyraAIBot/1.0 (+https://veyra.app/bot)";
  }

  /**
   * Main entry: given a query and search results, try to produce an AI answer.
   */
  async answer(query, searchResults = []) {
    const startTime = Date.now();

    // Detect query intent
    const intent = this.detectIntent(query);

    // If the query isn't a question or definition, don't try to answer
    if (intent.type === "none") {
      return { hasAnswer: false, reason: "Not a question or definition query" };
    }

    // Fetch content from top results
    const contents = await this.fetchContents(searchResults.slice(0, this.maxPagesToRead));

    // Extract candidate answers from the content
    const candidates = this.extractAnswers(query, intent, contents);

    if (candidates.length === 0 || candidates[0].score < this.minConfidence) {
      return { hasAnswer: false, reason: "No confident answer found", query, intent };
    }

    const best = candidates[0];
    const sources = contents.filter(c => c.url === best.sourceUrl).map(c => ({
      url: c.url, title: c.title,
    }));

    return {
      hasAnswer: true,
      answer: best.text,
      confidence: Math.round(best.score * 100) / 100,
      sources,
      intent: intent.type,
      query,
      responseTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Detect what type of question this is.
   */
  detectIntent(query) {
    const q = query.toLowerCase().trim();

    // Definition queries: "what is X", "what does X mean", "X meaning"
    if (/^(what\s+(is|are|was|were)\s|what\s+does\s+.+\s+mean|what's\s|define\s|meaning\s+of\s)/i.test(q)) {
      return { type: "definition", subject: this.extractSubject(q, "definition") };
    }

    // How-to queries
    if (/^(how\s+(to|do|can|does)|how\s+do\s+i)/i.test(q)) {
      return { type: "howto", subject: query };
    }

    // Why queries
    if (/^why\s/i.test(q)) {
      return { type: "why", subject: query };
    }

    // When/where queries
    if (/^(when|where|who)\s/i.test(q)) {
      return { type: "factual", subject: query };
    }

    // "X meaning" or "X definition"
    if (/\b(meaning|definition|definition)\s*$/i.test(q) || /\b(meaning|definition)\s+of\b/i.test(q)) {
      return { type: "definition", subject: this.extractSubject(q, "definition") };
    }

    return { type: "none", subject: query };
  }

  extractSubject(q, type) {
    if (type === "definition") {
      let s = q
        .replace(/^what\s+(is|are|was|were)\s/, "")
        .replace(/^what\s+does\s+/, "")
        .replace(/\s+mean\b/g, "")
        .replace(/^what's\s/, "")
        .replace(/^define\s/, "")
        .replace(/^meaning\s+of\s/, "")
        .replace(/\b(meaning|definition)\s*$/g, "")
        .trim();
      return s || q;
    }
    return q;
  }

  /**
   * Fetch page content from search result URLs.
   */
  async fetchContents(results) {
    const contents = [];
    for (const r of results) {
      if (!r?.url) continue;
      try {
        const content = await this.fetchPageContent(r.url);
        if (content && content.text.length > 100) {
          contents.push({ ...content, url: r.url, title: r.title || r.url });
        }
      } catch {}
    }
    return contents;
  }

  fetchPageContent(url) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.get(url, {
        headers: { "User-Agent": this.userAgent, "Accept": "text/html,*/*;q=0.8", "Accept-Encoding": "identity" },
        timeout: this.timeoutMs,
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
          if (data.length > this.maxContentBytes) { res.destroy(); resolve(this.parseContent(data, url)); }
        });
        res.on("end", () => resolve(this.parseContent(data, url)));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    });
  }

  /**
   * Parse HTML to extract clean text and paragraphs.
   */
  parseContent(html, url) {
    // Remove scripts, styles, and HTML tags
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();

    // Split into sentences
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

    // Extract paragraphs (groups of 2-5 sentences)
    const paragraphs = [];
    for (let i = 0; i < sentences.length; i += 3) {
      const para = sentences.slice(i, i + 3).join(" ").trim();
      if (para.length > 50 && para.length < 1000) paragraphs.push(para);
    }

    return { text: text.slice(0, this.maxContentBytes), paragraphs, sentences, url };
  }

  /**
   * Extract candidate answers from page content.
   */
  extractAnswers(query, intent, contents) {
    const queryTerms = this.extractTerms(query);
    const subjectTerms = this.extractTerms(intent.subject || query);
    const candidates = [];

    for (const content of contents) {
      for (const para of content.paragraphs) {
        const score = this.scoreParagraph(para, queryTerms, subjectTerms, intent);
        if (score > 0) {
          candidates.push({
            text: this.cleanAnswer(para, intent),
            score,
            sourceUrl: content.url,
            sourceTitle: content.title,
          });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, 5);
  }

  extractTerms(text) {
    const stopWords = new Set(["the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could", "should", "may", "might",
      "can", "shall", "to", "of", "in", "on", "at", "by", "for", "with", "about", "as", "into",
      "like", "through", "after", "over", "between", "out", "against", "during", "without",
      "before", "under", "around", "among", "and", "but", "or", "nor", "not", "so", "yet",
      "both", "either", "neither", "each", "every", "all", "any", "few", "more", "most",
      "other", "some", "such", "no", "only", "own", "same", "than", "too", "very",
      "just", "as", "also", "this", "that", "these", "those", "what", "which", "who",
      "whom", "whose", "when", "where", "why", "how", "all", "it", "its", "it's",
      "i", "you", "he", "she", "we", "they", "me", "him", "her", "us", "them",
      "my", "your", "his", "our", "their", "mine", "yours", "hers", "ours", "theirs",
      "if", "then", "because", "while", "until", "though", "although", "since",
      "unless", "whether", "however", "therefore", "moreover", "furthermore",
      "what's", "whats", "meaning", "definition", "define", "mean",
    ]);
    return text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
  }

  scoreParagraph(para, queryTerms, subjectTerms, intent) {
    const paraLower = para.toLowerCase();
    let score = 0;

    // Subject term matches are most important
    let subjectHits = 0;
    for (const term of subjectTerms) {
      if (paraLower.includes(term)) subjectHits++;
    }
    score += (subjectHits / Math.max(1, subjectTerms.length)) * 0.5;

    // Query term matches
    let queryHits = 0;
    for (const term of queryTerms) {
      if (paraLower.includes(term)) queryHits++;
    }
    score += (queryHits / Math.max(1, queryTerms.length)) * 0.2;

    // Intent-specific scoring
    if (intent.type === "definition") {
      // Look for definition patterns
      if (new RegExp(`${subjectTerms[0] || ""}.*(is|are|refers to|means|defined as|is a|is an)`, "i").test(para)) {
        score += 0.3;
      }
      // First paragraph bonus
      if (para.length < 500) score += 0.1;
    }

    if (intent.type === "howto") {
      // Look for step-by-step patterns
      if (/\b(first|then|next|finally|step|steps|begin|start)\b/i.test(para)) {
        score += 0.2;
      }
    }

    // Sentence quality: not too short, not too long
    if (para.length > 100 && para.length < 600) score += 0.1;

    // Penalize navigation/menu text
    if (/\b(menu|navigation|search|login|sign in|register|home|about|contact|privacy|terms|cookie)\b/i.test(para)) {
      score -= 0.3;
    }

    return Math.max(0, score);
  }

  cleanAnswer(para, intent) {
    // Trim to a reasonable length
    let answer = para.trim();
    if (answer.length > 400) {
      // Find a good break point
      const cut = answer.slice(0, 400);
      const lastSentence = cut.lastIndexOf(". ");
      if (lastSentence > 200) answer = cut.slice(0, lastSentence + 1);
      else answer = cut + "...";
    }
    return answer;
  }

  report() {
    return { maxPages: this.maxPagesToRead, minConfidence: this.minConfidence };
  }
}

module.exports = { AIAnswerEngine };
