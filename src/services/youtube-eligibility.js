"use strict";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";
const TTL = 5 * 60_000;
const CAPACITY = 1000;
const HOURLY_LOOKUPS = 350;
const HOUR = 60 * 60_000;

function createYouTubeEligibility({ key, request, now = Date.now }) {
  const cache = new Map();
  const pending = new Map();
  let budget = { since: now(), used: 0 };
  return async id => {
    if (typeof id !== "string" || !VIDEO_ID.test(id)) return "invalid";
    if (!key) return "unavailable";
    const found = cache.get(id);
    if (found && found.until > now()) return found.state;
    if (pending.has(id)) return pending.get(id);
    if (pending.size >= 6) return "unavailable";
    if (now() - budget.since >= HOUR) budget = { since: now(), used: 0 };
    if (budget.used >= HOURLY_LOOKUPS) return "unavailable";
    budget.used++;
    const job = Promise.resolve().then(async () => {
      const url = new URL(ENDPOINT);
      url.search = new URLSearchParams({ part: "id,status", id, fields: "items(id,status(embeddable,madeForKids))" });
      const response = await request(url, {
        headers: { accept: "application/json", "x-goog-api-key": key },
        redirect: "error", signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) return "unavailable";
      const data = await response.json();
      if (!Array.isArray(data?.items)) return "unavailable";
      const status = data.items.find(item => item?.id === id)?.status;
      const state = status?.madeForKids === true || status?.embeddable === false || !data.items.length ? "external"
        : status?.madeForKids === false && status?.embeddable === true ? "ready" : "unavailable";
      if (state !== "unavailable") {
        cache.delete(id);
        if (cache.size >= CAPACITY) cache.delete(cache.keys().next().value);
        cache.set(id, { until: now() + TTL, state });
      }
      return state;
    }).catch(() => "unavailable").finally(() => pending.delete(id));
    pending.set(id, job);
    return job;
  };
}
module.exports = { createYouTubeEligibility };
