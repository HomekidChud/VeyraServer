"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_BASELINE = "59286f0150ee7532c44cf141ac5703a0aba99c57";
const baselineRef = process.env.VEYRA_BENCH_BASELINE_REF || DEFAULT_BASELINE;
const delayMs = Math.max(1, Math.min(1000, Number(process.env.VEYRA_BENCH_DELAY_MS) || 60));
const sampleCount = Math.max(3, Math.min(50, Number(process.env.VEYRA_BENCH_SAMPLES) || 7));
const providerEnv = {
  WEB_SEARCH_ORDER: "duckduckgo,bing,brave",
  WEB_SEARCH_MAX_PROVIDERS: "3",
  WEB_SEARCH_CONCURRENCY: "3",
  WEB_SEARCH_PROVIDER_TIMEOUT_MS: "5000",
  WEB_SEARCH_CACHE_TTL_MS: "0",
  BRAVE_SEARCH_API_KEY: "mock-only"
};

function mockFetch(delay) {
  return async url => {
    await new Promise(resolve => setTimeout(resolve, delay));
    if (url.includes("duckduckgo")) return { ok: true, status: 200, text: "<html><body>no results</body></html>" };
    if (url.includes("bing.com")) return { ok: true, status: 200, text: "<html><body>no results</body></html>" };
    return { ok: true, status: 200, text: JSON.stringify({ web: { results: [{ url: "https://bench.example/item", title: "Benchmark item", description: "Deterministic test result." }] } }) };
  };
}
async function benchmark(factory, label) {
  const observations = [];
  for (let index = 0; index < sampleCount; index += 1) {
    let providerRequests = 0;
    const service = factory({ env: providerEnv, log() {}, fetchText: async (...args) => { providerRequests += 1; return mockFetch(delayMs)(...args); } });
    const started = performance.now();
    const result = await service.search(`deterministic benchmark ${label} ${index}`);
    observations.push({ elapsedMs: performance.now() - started, providerRequests, results: result.results.length });
  }
  const sorted = observations.map(row => row.elapsedMs).sort((a, b) => a - b);
  return {
    medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(1)),
    p95MsNearestRank: Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)].toFixed(1)),
    requestsPerRun: observations[0].providerRequests,
    resultsPerRun: observations[0].results
  };
}
async function main() {
  const baselineSource = execFileSync("git", ["show", `${baselineRef}:src/services/websearch.js`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-search-benchmark-"));
  const tempModule = path.join(tempDir, "websearch-baseline.cjs");
  try {
    fs.writeFileSync(tempModule, baselineSource);
    process.env.NODE_PATH = [path.join(ROOT, "node_modules"), process.env.NODE_PATH || ""].filter(Boolean).join(path.delimiter);
    require("node:module").Module._initPaths();
    const baseline = require(tempModule).createWebSearch;
    const upgraded = require(path.join(ROOT, "src/services/websearch.js")).createWebSearch;
    const before = await benchmark(baseline, "baseline");
    const after = await benchmark(upgraded, "upgraded");
    process.stdout.write(`${JSON.stringify({
      methodology: "Cold-cache unit microbenchmark; network is mocked; the first two providers return empty responses and Brave returns one result; each provider request waits the same fixed delay.",
      baselineRef,
      samplesPerMode: sampleCount,
      mockedProviderDelayMs: delayMs,
      baseline: before,
      upgraded: after,
      limitations: ["Measures only orchestration latency for deterministic mocked provider calls; not real network performance, result quality or production throughput."]
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
main().catch(error => { process.stderr.write(`${String(error?.message || "Benchmark failed")}\n`); process.exitCode = 1; });
