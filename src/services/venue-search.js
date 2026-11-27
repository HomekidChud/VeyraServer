"use strict";

const DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter";
const ATTRIBUTION = "© OpenStreetMap contributors";
const ATTRIBUTION_URL = "https://www.openstreetmap.org/copyright";
const LICENSE_URL = "https://opendatacommons.org/licenses/odbl/1-0/";
const CATEGORIES = Object.freeze({
  cafe: { amenity: ["cafe"] }, restaurant: { amenity: ["restaurant"] }, bar: { amenity: ["bar", "pub"] },
  fast_food: { amenity: ["fast_food"] }, pub: { amenity: ["pub"] },
  museum: { tourism: ["museum"] }, gallery: { tourism: ["gallery"] }, hotel: { tourism: ["hotel", "guest_house", "hostel", "motel"] },
  attraction: { tourism: ["attraction", "viewpoint", "zoo", "theme_park"] },
  park: { leisure: ["park"] },
});
const MAX_RADIUS = 50000;
const MAX_LIMIT = 100;
const MAX_OFFSET = 10000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

class VenueSearchError extends Error {
  constructor(code, message) { super(message); this.name = "VenueSearchError"; this.code = code; }
}
function validPoint(lat, lon) {
  return Number.isFinite(Number(lat)) && Number(lat) >= -90 && Number(lat) <= 90 &&
    Number.isFinite(Number(lon)) && Number(lon) >= -180 && Number(lon) <= 180;
}
function validateInput(input = {}) {
  const lat = Number(input.lat), lon = Number(input.lon), radiusMeters = Number(input.radiusMeters ?? input.radius);
  if (input.lat == null || input.lon == null || !validPoint(lat, lon)) throw new VenueSearchError("INVALID_COORDINATES", "Valid latitude and longitude are required");
  if (!Number.isInteger(radiusMeters) || radiusMeters < 1 || radiusMeters > MAX_RADIUS) throw new VenueSearchError("INVALID_RADIUS", `Radius must be an integer from 1 to ${MAX_RADIUS} meters`);
  const category = input.category || "cafe";
  if (!Object.hasOwn(CATEGORIES, category)) throw new VenueSearchError("INVALID_CATEGORY", "Unsupported venue category");
  const offset = input.offset == null ? 0 : Number(input.offset), limit = input.limit == null ? 20 : Number(input.limit);
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) throw new VenueSearchError("INVALID_PAGINATION", "Offset is out of bounds");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new VenueSearchError("INVALID_PAGINATION", `Limit must be from 1 to ${MAX_LIMIT}`);
  const text = input.text == null ? "" : String(input.text).trim().slice(0, 100);
  return { lat, lon, radiusMeters, category, text, offset, limit };
}
// User text is intentionally absent from Overpass QL; it is only applied locally.
function buildOverpassQuery({ lat, lon, radiusMeters, category }) {
  const input = validateInput({ lat, lon, radiusMeters, category, limit: 1 });
  const spec = CATEGORIES[input.category];
  const selectors = Object.entries(spec).flatMap(([key, vals]) => vals.map(value => `nwr["${key}"="${value}"](around:${input.radiusMeters},${input.lat},${input.lon});`));
  return `[out:json][timeout:15];(${selectors.join("")} );out center tags;`;
}
function clean(value, max = 200) {
  if (typeof value !== "string") return "";
  const s = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s.slice(0, max);
}
function safeWebUrl(raw) {
  if (typeof raw !== "string" || raw.length > 1000) return "";
  try { const u = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : ""; } catch { return ""; }
}
function distanceMeters(aLat, aLon, bLat, bLon) {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function categoryFor(tags) {
  for (const [category, spec] of Object.entries(CATEGORIES)) for (const [key, vals] of Object.entries(spec)) if (vals.includes(tags[key])) return category;
  return "";
}
function parseElements(elements, input) {
  const seen = new Set(), found = [];
  for (const el of Array.isArray(elements) ? elements.slice(0, 20000) : []) {
    if (!el || !["node", "way", "relation"].includes(el.type) || !Number.isSafeInteger(el.id) || el.id < 0) continue;
    const identity = `${el.type}/${el.id}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const tags = el.tags && typeof el.tags === "object" && !Array.isArray(el.tags) ? el.tags : {};
    const name = clean(tags.name, 160), category = categoryFor(tags);
    if (!name || category !== input.category) continue;
    let lat = el.type === "node" ? Number(el.lat) : Number(el.center?.lat);
    let lon = el.type === "node" ? Number(el.lon) : Number(el.center?.lon);
    if (!validPoint(lat, lon)) continue;
    const distance = distanceMeters(input.lat, input.lon, lat, lon);
    if (distance > input.radiusMeters) continue;
    const address = ["addr:housenumber", "addr:street", "addr:city", "addr:postcode", "addr:state", "addr:country"]
      .map(k => clean(tags[k], 100)).filter(Boolean);
    const row = { id: `osm:${identity}`, name, category, lat, lon, distanceMeters: Math.round(distance),
      address: address.length ? address.join(", ") : null,
      phone: clean(tags.phone || tags["contact:phone"], 60) || null,
      website: safeWebUrl(tags.website || tags["contact:website"]) || null,
      openingHours: clean(tags.opening_hours, 200) || null,
      rating: null, price: null,
      source: { provider: "openstreetmap", osmType: el.type, osmId: el.id } };
    found.push(row);
  }
  return found.sort((a, b) => a.distanceMeters - b.distanceMeters || a.id.localeCompare(b.id));
}
function endpointFrom(value) {
  try { const u = new URL(value || DEFAULT_ENDPOINT); return u.protocol === "https:" && !u.username && !u.password ? u.href : DEFAULT_ENDPOINT; } catch { return DEFAULT_ENDPOINT; }
}
async function readBoundedResponse(response) {
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new VenueSearchError("UPSTREAM_ERROR", "Venue provider response exceeded size limit");
  if (typeof response.body?.getReader === "function") {
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        size += chunk.byteLength;
        if (size > MAX_BODY_BYTES) {
          try { await reader.cancel(); } catch {}
          throw new VenueSearchError("UPSTREAM_ERROR", "Venue provider response exceeded size limit");
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size).toString("utf8");
    } catch (error) {
      if (error instanceof VenueSearchError) throw error;
      throw error;
    }
  }
  if (typeof response.text === "function") {
    const body = String(await response.text());
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new VenueSearchError("UPSTREAM_ERROR", "Venue provider response exceeded size limit");
    return body;
  }
  if (typeof response.json === "function") {
    const data = await response.json();
    const body = JSON.stringify(data);
    if (typeof body !== "string") throw new VenueSearchError("UPSTREAM_ERROR", "Invalid venue provider response");
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new VenueSearchError("UPSTREAM_ERROR", "Venue provider response exceeded size limit");
    return body;
  }
  throw new VenueSearchError("UPSTREAM_ERROR", "Invalid venue provider response");
}

function createVenueSearch(options = {}) {
  const fetchFn = options.fetch || globalThis.fetch;
  const env = options.env || process.env;
  const endpoint = endpointFrom(options.endpoint || env.VEYRA_OVERPASS_URL);
  const ttlMs = Math.max(1000, Math.min(Number(options.ttlMs) || 60000, 3600000));
  const maxEntries = Math.max(1, Math.min(Number(options.maxEntries) || 100, 1000));
  const timeoutMs = Math.max(100, Math.min(Number(options.timeoutMs) || 8000, 30000));
  const cache = new Map();
  let queue = Promise.resolve();
  async function request(query, signal) {
    if (typeof fetchFn !== "function") throw new VenueSearchError("UNAVAILABLE", "Venue provider is unavailable");
    const task = queue.then(async () => {
      if (signal?.aborted) throw new VenueSearchError("CANCELLED", "Venue search was cancelled");
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchFn(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ data: query }).toString(), signal: controller.signal });
        if (!response?.ok) throw new VenueSearchError("UPSTREAM_ERROR", "Venue provider returned an error");
        const data = JSON.parse(await readBoundedResponse(response));
        if (!data || !Array.isArray(data.elements)) throw new VenueSearchError("UPSTREAM_ERROR", "Invalid venue provider response");
        return data.elements;
      } catch (err) {
        if (signal?.aborted) throw new VenueSearchError("CANCELLED", "Venue search was cancelled");
        if (err instanceof VenueSearchError) throw err;
        throw new VenueSearchError(err?.name === "AbortError" ? "TIMEOUT" : "UNAVAILABLE", err?.name === "AbortError" ? "Venue provider request timed out" : "Venue provider is unavailable");
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    });
    queue = task.catch(() => {});
    return task;
  }
  async function search(rawInput) {
    let input;
    try { input = validateInput(rawInput); } catch (e) { return { ok: false, error: { code: e.code || "INVALID_REQUEST", message: e.message } }; }
    const signal = rawInput?.signal;
    if (signal?.aborted) return { ok: false, error: { code: "CANCELLED", message: "Venue search was cancelled" } };
    const key = JSON.stringify([input.lat, input.lon, input.radiusMeters, input.category]);
    let entry = cache.get(key);
    if (entry && entry.expiresAt <= Date.now()) { cache.delete(key); entry = null; }
    let rows;
    if (entry) { cache.delete(key); cache.set(key, entry); rows = entry.rows; }
    else {
      try {
        rows = parseElements(await request(buildOverpassQuery(input), signal), { ...input, text: "" });
        cache.set(key, { rows, expiresAt: Date.now() + ttlMs });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      } catch (e) { return { ok: false, error: { code: e.code || "UNAVAILABLE", message: e.message || "Venue provider is unavailable" } }; }
    }
    const filtered = input.text ? rows.filter(r => r.name.toLocaleLowerCase().includes(input.text.toLocaleLowerCase())) : rows;
    const results = filtered.slice(input.offset, input.offset + input.limit);
    const hasMore = input.offset + results.length < filtered.length;
    return { ok: true, results, hasMore, nextOffset: hasMore ? input.offset + results.length : null,
      attribution: { text: ATTRIBUTION, url: ATTRIBUTION_URL, license: "ODbL-1.0", licenseUrl: LICENSE_URL } };
  }
  return { search, clearCache: () => cache.clear(), cacheSize: () => cache.size, endpoint,
    metadata: { provider: "openstreetmap", categories: Object.freeze(Object.keys(CATEGORIES)), attribution: { text: ATTRIBUTION, url: ATTRIBUTION_URL, license: "ODbL-1.0", licenseUrl: LICENSE_URL }, usageNote: "Public Overpass instances are shared community infrastructure intended for modest mapper use, not application backends; cache responses and keep request frequency low." } };
}

module.exports = { createVenueSearch, VenueSearchError, CATEGORIES, validateInput, buildOverpassQuery, parseElements, distanceMeters, MAX_RADIUS, MAX_LIMIT };
