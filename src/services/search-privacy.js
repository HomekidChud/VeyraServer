"use strict";

const MODES = new Set(["unfiltered", "filtered", "blocked", "restricted"]);
const ADULT_HOSTS = ["porn.com", "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "youporn.com", "redtube.com",
  "tube8.com", "spankbang.com", "phncdn.com", "others-cdn.com"];
const URL_FIELDS = ["url", "canonical", "canonicalUrl", "sourcePageUrl", "imageUrl", "thumbnail", "thumbnailUrl", "posterUrl", "embedUrl", "favicon"];

const searchPrivacy = value => MODES.has(value) ? value : "filtered";
const knownHost = host => ADULT_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`));
function knownAdultUrl(input) {
  if (typeof input !== "string" || !input) return false;
  try {
    const url = new URL(input.startsWith("//") ? `https:${input}` : input);
    return /^https?:$/.test(url.protocol) && knownHost(url.hostname.replace(/\.+$/, ""));
  } catch { return false; }
}
function masksSearchScope(mode, query, scope) {
  if (mode === "unfiltered") return false;
  if (scope.include.some(knownHost)) return true;
  if (mode !== "blocked") return false;
  // Block explicit URL/hostname tokens, not brand names or general health topics.
  return (String(query).match(/[^\s"'<>()[\]{},;]+/g) || []).some(token =>
    !/^-site:/i.test(token) && knownAdultUrl(/^(?:https?:)?\/\//i.test(token) ? token : `https://${token}`));
}
function allowsSearchResult(mode, row) {
  if (!row) return false;
  if (mode === "unfiltered") return true;
  return ![row, row.media, row.evidence].some(item => item &&
    (item.adult === true || item.nsfw === true || item.isAdult === true || URL_FIELDS.some(key => knownAdultUrl(item[key]))));
}

module.exports = { searchPrivacy, masksSearchScope, allowsSearchResult };
