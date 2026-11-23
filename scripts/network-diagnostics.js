"use strict";
const dns = require("node:dns").promises;
const { fetch: undiciFetch, ProxyAgent } = require("undici");
const cheerio = require("cheerio");
const { classifyGoogleResponse } = require("../src/services/websearch");

const TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 128 * 1024;
function codeOf(error) { return String(error?.code || error?.cause?.code || error?.name || "NETWORK_ERROR").slice(0, 80); }
async function readLimited(response, maxBytes = MAX_BODY_BYTES) {
  const chunks = []; let length = 0;
  for await (const chunk of response.body) { const buf = Buffer.from(chunk); const remaining = maxBytes - length; if (remaining <= 0) break; chunks.push(buf.subarray(0, remaining)); length += Math.min(buf.length, remaining); if (buf.length > remaining) break; }
  return Buffer.concat(chunks).toString("utf8");
}
async function request(fetchImpl, url, dispatcher) {
  const started = Date.now(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { dispatcher, redirect: "follow", signal: controller.signal, headers: { "user-agent": "VeyraNetworkDiagnostics/1.0", accept: "text/html,application/json;q=0.9,*/*;q=0.1" } });
    const text = await readLimited(response);
    return { ok: response.status >= 200 && response.status < 400, status: response.status, contentType: response.headers?.get?.("content-type") || "", latencyMs: Date.now() - started, text };
  } catch (error) { return { ok: false, status: 0, latencyMs: Date.now() - started, error: codeOf(error) }; }
  finally { clearTimeout(timer); }
}
async function lookupHost(lookup, host, family) {
  try {
    const rows = await lookup(host, { all: true, verbatim: true, ...(family ? { family } : {}) });
    return { ok: rows.length > 0, host, family: family || "any", addresses: rows.map(row => row.address), count: rows.length };
  } catch (error) { return { ok: false, host, family: family || "any", error: codeOf(error) }; }
}
function responseSummary(response) { const { text, ...safe } = response; return safe; }
function googleExtraction(response) {
  const classification = classifyGoogleResponse({ status: response.status, text: response.text, error: response.error || "" });
  if (classification !== "response") return { classification, extractedLinks: 0 };
  const $ = cheerio.load(String(response.text || ""));
  if (/javascript required|enable javascript/i.test($.root().text())) return { classification: "javascript-dependent", extractedLinks: 0 };
  const links = new Set();
  $("h3").each((_, heading) => {
    const anchor = $(heading).closest("a").length ? $(heading).closest("a") : $(heading).parents("a").first();
    const href = anchor.attr("href") || "";
    try { const u = new URL(href, "https://www.google.com"); if (/^https?:$/.test(u.protocol) && !/(^|\.)google\./i.test(u.hostname)) links.add(u.href); } catch {}
  });
  return { classification: links.size ? "results-extracted" : "empty-or-unrecognized", extractedLinks: links.size };
}
async function runDiagnostics({ fetchImpl = undiciFetch, lookup = dns.lookup, env = process.env, route = "auto" } = {}) {
  const proxyUrl = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || "";
  const proxyConfigured = !!proxyUrl;
  let proxyDispatcher = null, proxyConfigurationError = null;
  if (proxyConfigured) try { proxyDispatcher = new ProxyAgent(proxyUrl); } catch (error) { proxyConfigurationError = codeOf(error); }
  const requestedProxy = route === "proxy" || (route === "auto" && proxyConfigured);
  const providerRoute = requestedProxy && !proxyDispatcher ? "proxy-unavailable" : requestedProxy ? "proxy" : "direct";
  const providerDispatcher = providerRoute === "proxy" ? proxyDispatcher : undefined;
  const dnsResults = await Promise.all(["www.google.com", "html.duckduckgo.com", "www.bing.com"].map(host => lookupHost(lookup, host)));
  const [directV4, directV6] = await Promise.all([
    request(fetchImpl, "https://api4.ipify.org", undefined),
    request(fetchImpl, "https://api6.ipify.org", undefined)
  ]);
  const proxyV4 = proxyDispatcher ? await request(fetchImpl, "https://api4.ipify.org", proxyDispatcher) : null;
  const ipv4 = directV4.ok ? directV4.text.trim() : "";
  const proxyAddress = proxyV4?.ok ? proxyV4.text.trim() : "";
  const expected = String(env.EXPECTED_EGRESS_IP || "").trim();
  const unavailable = { ok: false, status: 0, latencyMs: 0, error: "PROXY_UNAVAILABLE", text: "" };
  const google = providerRoute === "proxy-unavailable" ? unavailable : await request(fetchImpl, "https://www.google.com/search?q=veyra+network+diagnostics", providerDispatcher);
  const bing = providerRoute === "proxy-unavailable" ? unavailable : await request(fetchImpl, "https://www.bing.com/search?q=veyra+network+diagnostics", providerDispatcher);
  const ddg = providerRoute === "proxy-unavailable" ? unavailable : await request(fetchImpl, "https://html.duckduckgo.com/html/?q=veyra+network+diagnostics", providerDispatcher);
  const googleClass = classifyGoogleResponse({ status: google.status, text: google.text, error: google.error || "" });
  if (proxyDispatcher) await proxyDispatcher.close().catch(() => {});
  return {
    checkedAt: new Date().toISOString(), routeUsedForProviders: providerRoute,
    connectivity: {
      directIpv4: { ok: directV4.ok, address: ipv4 || null, latencyMs: directV4.latencyMs, error: directV4.error || null },
      directIpv6: { ok: directV6.ok, address: directV6.ok ? directV6.text.trim() : null, latencyMs: directV6.latencyMs, error: directV6.error || null },
      proxy: { configured: proxyConfigured, reachable: proxyV4?.ok || false, observedIpv4: proxyAddress || null, latencyMs: proxyV4?.latencyMs ?? null, error: proxyV4?.error || proxyConfigurationError },
      expectedEgress: expected ? { configured: true, matchesDirectIpv4: !!ipv4 && ipv4 === expected, matchesProxyIpv4: !!proxyAddress && proxyAddress === expected } : { configured: false }
    },
    ipClassification: { residential: "not-classified", basis: "Connectivity and IP address alone cannot establish residential allocation." },
    dns: dnsResults,
    tlsAndProvider: {
      googleSearchHtml: { ...responseSummary(google), classification: googleClass, extraction: googleExtraction(google) },
      bingSearchHtml: responseSummary(bing),
      duckDuckGoHtml: { ...responseSummary(ddg), classification: /captcha|challenge|anomaly-modal|bots use duckduckgo/i.test(ddg.text || "") ? "challenge" : ddg.ok ? "response" : "unreachable" },
      googleCustomSearchApiConfigured: !!((env.GOOGLE_SEARCH_API_KEY || env.GOOGLE_API_KEY) && (env.GOOGLE_SEARCH_CX || env.GOOGLE_CSE_ID))
    },
    limitations: ["Each external endpoint is requested at most once; challenges and rate limits are reported, not retried or bypassed.", "IP network classification is deliberately not inferred."]
  };
}
async function main() {
  const route = process.argv.includes("--route=direct") ? "direct" : process.argv.includes("--route=proxy") ? "proxy" : "auto";
  const report = await runDiagnostics({ route });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.connectivity.directIpv4.ok && !report.connectivity.proxy.reachable) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ error: codeOf(error) })); process.exitCode = 1; });
module.exports = { runDiagnostics, request, lookupHost };
