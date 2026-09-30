"use strict";
/**
 * Veyra Renewing System — session renewal via ads.
 *
 * When a user's session is about to expire, they can watch an ad (video, 
 * link, or sponsored content) to renew/extend their session time.
 *
 * Admins add ad content via the /dev panel or API. Ads are stored in memory
 * and served to users when they need to renew.
 *
 * Flow:
 *   1. User's session timer drops below 30 seconds
 *   2. Veyra shows a "Renew session" prompt with an ad
 *   3. User watches/clicks the ad content
 *   4. After the ad duration completes, session is extended
 *   5. Admin can manage ads via /api/renew/ads
 *
 * Integration in server.js:
 *   const { RenewingManager } = require('./renewing-system');
 *   const renewing = new RenewingManager();
 *   app.get('/api/renew/ads', (req, res) => res.json(renewing.getActiveAds()));
 *   app.post('/api/renew/ads', requireAdmin, (req, res) => res.json(renewing.addAd(req.body)));
 *   app.post('/api/renew/watch/:adId', (req, res) => res.json(renewing.watchAd(req.params.adId, req.body.sessionId)));
 */

const crypto = require("crypto");

// Extract a YouTube video ID from a watch/short/youtu.be URL or a bare ID.
// Returns null for anything that is not recognisably YouTube.
function extractYoutubeId(input) {
  const s = String(input || "").trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s.startsWith("http") ? s : `https://${s}`);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return /^\/?([a-zA-Z0-9_-]{11})/.exec(u.pathname)?.[1] || null;
    if (host.endsWith("youtube.com")) {
      return u.searchParams.get("v") || /^\/(?:embed|shorts|live)\/([a-zA-Z0-9_-]{11})/.exec(u.pathname)?.[1] || null;
    }
  } catch {}
  return null;
}

class RenewingManager {
  constructor(opts = {}) {
    this.ads = new Map();
    this.watches = new Map();  // watchId -> {adId, sessionId, startedAt, completedAt, reward}
    this.defaultRewardMs = opts.defaultRewardMs || 2 * 60 * 1000;  // 2 minutes per ad
    this.maxAdsPerSession = opts.maxAdsPerSession || 5;
    this.sessionAdCount = new Map();  // sessionId -> count
    this.log = opts.log || (() => {});
  }

  /**
   * Add an advertisement (admin only).
   */
  addAd({ title, type, url, durationSec, rewardMs, description, imageUrl }) {
    if (!title || !type) throw new Error("Title and type are required");
    if (!["video", "youtube", "link", "banner", "interactive"].includes(type)) {
      throw new Error("Type must be: video, youtube, link, banner, or interactive");
    }
    if (type === "youtube" && !extractYoutubeId(url)) throw new Error("A YouTube ad needs a valid YouTube video URL or 11-character video ID.");
    const ad = {
      id: crypto.randomUUID(),
      title: String(title).slice(0, 200),
      type,
      // YouTube ads: normalise any YouTube URL/ID to a clean 11-char video ID
      // so the frontend can embed the official player without script injection.
      youtubeId: type === "youtube" ? extractYoutubeId(url) : undefined,
      url: String(url || "").slice(0, 2048),
      durationSec: Math.min(300, Math.max(5, Number(durationSec) || 15)),
      rewardMs: Math.min(30 * 60 * 1000, Math.max(30 * 1000, Number(rewardMs) || this.defaultRewardMs)),
      description: String(description || "").slice(0, 500),
      imageUrl: String(imageUrl || "").slice(0, 2048),
      createdAt: Date.now(),
      active: true,
      watchCount: 0,
    };
    this.ads.set(ad.id, ad);
    this.log("info", "RENEW", `Ad added: ${ad.title} (${ad.type}, ${ad.durationSec}s, +${ad.rewardMs / 1000}s reward)`);
    return ad;
  }

  /**
   * Remove an advertisement (admin only).
   */
  removeAd(id) {
    const ad = this.ads.get(id);
    if (!ad) return false;
    this.ads.delete(id);
    this.log("info", "RENEW", `Ad removed: ${ad.title}`);
    return true;
  }

  /**
   * Toggle ad active status (admin only).
   */
  toggleAd(id) {
    const ad = this.ads.get(id);
    if (!ad) return null;
    ad.active = !ad.active;
    return ad;
  }

  /**
   * Get all ads (for admin management).
   */
  getAllAds() {
    return [...this.ads.values()];
  }

  /**
   * Get active ads for users to watch.
   */
  getActiveAds() {
    return [...this.ads.values()].filter(a => a.active);
  }

  /**
   * Start watching an ad for session renewal.
   */
  watchAd(adId, sessionId) {
    const ad = this.ads.get(adId);
    if (!ad || !ad.active) throw new Error("Ad not found or inactive");
    if (!sessionId) throw new Error("Session ID required");

    // Check session ad limit
    const count = this.sessionAdCount.get(sessionId) || 0;
    if (count >= this.maxAdsPerSession) {
      throw new Error(`Maximum of ${this.maxAdsPerSession} renewals per session reached`);
    }

    const watchId = crypto.randomUUID();
    const watch = {
      id: watchId,
      adId,
      sessionId,
      startedAt: Date.now(),
      completedAt: null,
      rewardMs: ad.rewardMs,
      durationSec: ad.durationSec,
    };
    this.watches.set(watchId, watch);

    return {
      watchId,
      ad: {
        id: ad.id,
        title: ad.title,
        type: ad.type,
        url: ad.url,
        youtubeId: ad.youtubeId,
        durationSec: ad.durationSec,
        description: ad.description,
        imageUrl: ad.imageUrl,
      },
      rewardMs: ad.rewardMs,
    };
  }

  /**
   * Look up a watch (completed or not) — used when granting the reward.
   */
  getWatch(watchId) {
    return this.watches.get(watchId) || null;
  }

  /**
   * Complete watching an ad and get the renewal reward.
   */
  completeWatch(watchId) {
    const watch = this.watches.get(watchId);
    if (!watch) throw new Error("Watch session not found");
    if (watch.completedAt) throw new Error("Already completed");

    const elapsed = (Date.now() - watch.startedAt) / 1000;
    if (elapsed < watch.durationSec) {
      throw new Error(`Ad not watched long enough (${Math.round(elapsed)}/${watch.durationSec}s)`);
    }

    watch.completedAt = Date.now();
    
    // Increment ad watch count
    const ad = this.ads.get(watch.adId);
    if (ad) ad.watchCount++;

    // Increment session ad count
    const count = this.sessionAdCount.get(watch.sessionId) || 0;
    this.sessionAdCount.set(watch.sessionId, count + 1);

    this.log("info", "RENEW", `Session ${watch.sessionId.slice(0, 8)} renewed by +${watch.rewardMs / 1000}s (watched ${ad?.title || watch.adId})`);

    return {
      renewed: true,
      rewardMs: watch.rewardMs,
      totalRenewals: count + 1,
      maxRenewals: this.maxAdsPerSession,
    };
  }

  /**
   * Check if a session can still renew.
   */
  canRenew(sessionId) {
    const count = this.sessionAdCount.get(sessionId) || 0;
    return count < this.maxAdsPerSession;
  }

  /**
   * Get renewal status for a session.
   */
  getSessionStatus(sessionId) {
    const count = this.sessionAdCount.get(sessionId) || 0;
    const remaining = Math.max(0, this.maxAdsPerSession - count);
    return {
      renewalsUsed: count,
      renewalsRemaining: remaining,
      maxRenewals: this.maxAdsPerSession,
      canRenew: remaining > 0,
      activeAds: this.getActiveAds().length,
    };
  }

  /**
   * Clear session renewal count (when session ends).
   */
  clearSession(sessionId) {
    this.sessionAdCount.delete(sessionId);
    // Clean up watches for this session
    for (const [id, watch] of this.watches) {
      if (watch.sessionId === sessionId) this.watches.delete(id);
    }
  }

  /**
   * Status report (for admin panel).
   */
  report() {
    return {
      totalAds: this.ads.size,
      activeAds: this.getActiveAds().length,
      totalWatches: this.watches.size,
      completedWatches: [...this.watches.values()].filter(w => w.completedAt).length,
      totalRenewals: [...this.sessionAdCount.values()].reduce((a, b) => a + b, 0),
      maxAdsPerSession: this.maxAdsPerSession,
      defaultRewardMs: this.defaultRewardMs,
      ads: [...this.ads.values()].map(a => ({
        id: a.id, title: a.title, type: a.type, active: a.active,
        watchCount: a.watchCount, durationSec: a.durationSec, rewardMs: a.rewardMs,
      })),
    };
  }
}

module.exports = { RenewingManager };
