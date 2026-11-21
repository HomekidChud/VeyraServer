"use strict";

const segmenter = new Intl.Segmenter("und", { granularity: "word" });
const unspaced = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const words = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'’_-]*/gu;
const useful = /[\p{L}\p{N}]/u;

function normalizeSearchText(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase();
}

function unicodeWords(value) {
  const text = normalizeSearchText(value);
  const out = [];
  for (const match of text.matchAll(words)) {
    const word = match[0].replace(/['’_-]+$/u, "");
    if (unspaced.test(word)) {
      for (const part of segmenter.segment(word)) {
        if (part.isWordLike && useful.test(part.segment)) out.push(part.segment.slice(0, 64));
      }
    } else {
      out.push(word.slice(0, 64));
    }
  }
  return out;
}

function languageTag(value) {
  if (typeof value !== "string" || value.length > 35 || !value.trim()) return "";
  if (/^x-default$/i.test(value.trim())) return "x-default";
  try { return new Intl.Locale(value.trim()).baseName; } catch { return ""; }
}

// Prefer the script of a query over the UI locale when the script is a strong
// signal. Do not guess a language from Latin, Arabic or Cyrillic alone.
function queryLanguage(query, preferred) {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(query)) return "ja";
  if (/\p{Script=Hangul}/u.test(query)) return "ko";
  if (/\p{Script=Thai}/u.test(query)) return "th";
  if (/\p{Script=Bengali}/u.test(query) && !/^as(?:-|$)/.test(preferred)) return "bn";
  if (/\p{Script=Devanagari}/u.test(query) && !/^(?:hi|mr|ne|sa)(?:-|$)/.test(preferred)) return "hi";
  if (/\p{Script=Han}/u.test(query) && !/^(?:zh|ja)(?:-|$)/.test(preferred)) return "zh";
  return preferred;
}

const BRAVE_CODES = new Set("ar eu bn bg ca hr cs da nl en et fi fr gl de el gu he hi hu is it kn ko lv lt ms ml mr nb pl pa ro ru sr sk sl es sv ta te th tr uk vi".split(" "));
function braveLanguage(tag) {
  if (/^zh(?:-|$)/.test(tag)) return /(?:-Hant|-TW|-HK|-MO)(?:-|$)/.test(tag) ? "zh-hant" : "zh-hans";
  if (/^ja(?:-|$)/.test(tag)) return "jp";
  if (/^pt(?:-|$)/.test(tag)) return /-BR(?:-|$)/.test(tag) ? "pt-br" : "pt-pt";
  if (tag === "en-GB") return "en-gb";
  const base = tag.split("-")[0];
  return BRAVE_CODES.has(base) ? base : "";
}

module.exports = { normalizeSearchText, unicodeWords, languageTag, queryLanguage, braveLanguage };
