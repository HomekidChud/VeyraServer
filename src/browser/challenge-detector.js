"use strict";

const challengePatterns = [
  /Just a moment\.\.\./i, /Checking your browser/i, /cf-browser-verification/i,
  /cf-challenge-running/i, /__cf_chl/i, /challenge-platform/i,
  /Please wait while we verify your browser/i, /enable JavaScript/i,
  /DDoS protection/i, /Access denied/i, /Attention Required/i, /Ray ID:/i,
  /__dd_host/i, /blazingfast\.ws/i, /Sucuri/i, /PerimeterX/i, /Shape Security/i,
];
const challengeTypes = [
  ["turnstile", /turnstile|cf-turnstile/i],
  ["hcaptcha", /hcaptcha/i],
  ["recaptcha", /recaptcha/i],
  ["cloudflare", /cloudflare|cf-challenge|cf-browser|__cf_chl|Ray ID/i],
  ["ddos-guard", /__dd_host|ddos-guard/i],
  ["sucuri", /sucuri/i],
  ["perimeterx", /perimeterx|pxhd/i],
  ["blazingfast", /blazingfast/i],
  ["meta-refresh", /<meta[^>]+http-equiv=["']refresh["']/i],
  ["js-required", /enable JavaScript/i],
];

function isChallengePage(html, statusCode) {
  if (typeof html !== "string" || !html) return false;
  if ([200, 403, 429, 503].includes(statusCode) &&
      challengePatterns.some(pattern => pattern.test(html))) return true;
  return statusCode === 200 && (
    (html.length < 5000 && /<meta[^>]+http-equiv=["']refresh["'][^>]+url=/i.test(html)) ||
    (html.length < 3000 && /<script[^>]*>/.test(html) && !/<body[^>]*>[\s\S]{200,}/i.test(html))
  );
}

function detectChallengeType(html) {
  if (typeof html !== "string" || !html) return "unknown";
  return challengeTypes.find(([, pattern]) => pattern.test(html))?.[0] || "unknown";
}

module.exports = { isChallengePage, detectChallengeType };
