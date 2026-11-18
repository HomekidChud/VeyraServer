"use strict";

const fs = require("node:fs");
const { join } = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");
const { SOURCES } = require("../src/services/neural-training-data");

const { STAGING_DIR, stagingIsolation } = require("./staging-ranker-baseline");
const BATCH_PER_PUBLISHER = 4;
const DATASETS = [
  {
    name: "python-standard-library",
    base: "https://docs.python.org/3/library/",
    pages: "collections itertools functools heapq bisect array enum dataclasses numbers math cmath decimal fractions statistics random datetime calendar zoneinfo time textwrap string unicodedata difflib pprint reprlib pathlib csv json configparser types".split(" ").map(name => `${name}.html`)
  },
  {
    name: "node-core-apis",
    base: "https://nodejs.org/api/",
    pages: "assert async_context buffer console diagnostics_channel events fs globals inspector intl module os path perf_hooks process readline repl stream string_decoder test timers tty url util v8 vm wasi webstreams worker_threads zlib".split(" ").map(name => `${name}.html`)
  },
  {
    name: "web-platform-reference",
    base: "https://developer.mozilla.org/en-US/docs/Web/API/",
    pages: "URL URLSearchParams AbortController Blob File FileReader FormData Headers Request Response Fetch_API Event EventTarget CustomEvent Document Element Node DOMParser DOMTokenList Range TreeWalker MutationObserver IntersectionObserver ResizeObserver Canvas_API Web_Animations_API History Location Performance TextEncoder".split(" ")
  },
  {
    name: "w3c-web-standards",
    base: "https://www.w3.org/TR/",
    pages: "WCAG22 wai-aria-1.2 accname-1.2 css-syntax-3 css-color-4 css-cascade-5 css-values-4 css-grid-1 css-flexbox-1 css-contain-2 css-display-3 css-overflow-3 css-transforms-1 css-writing-modes-3 webaudio webvtt pointerevents3 screen-orientation".split(" ").map(name => `${name}/`)
  },
  {
    name: "nasa-science",
    base: "https://science.nasa.gov/",
    pages: "solar-system/ solar-system/planets/ solar-system/moons/ solar-system/asteroids/ solar-system/comets/ solar-system/meteors-meteorites/ solar-system/kuiper-belt/ solar-system/oort-cloud/ universe/ universe/black-holes/ universe/galaxies/ universe/stars/ universe/exoplanets/ universe/cosmic-microwave-background/ universe/dark-matter-dark-energy/ universe/neutron-stars/".split(" ")
  },
  {
    name: "usgs-earth-science",
    base: "https://www.usgs.gov/",
    pages: "programs/earthquake-hazards programs/volcano-hazards programs/water-resources programs/land-change-science-program programs/national-geospatial-program programs/coastal-and-marine-hazards-and-resources-program programs/geomagnetism programs/land-remote-sensing-program programs/national-cooperative-geologic-mapping-program programs/energy-resources-program programs/mineral-resources-program programs/biological-threats-and-invasive-species-research-program programs/national-land-imaging-program programs/ecosystems".split(" ")
  }
];

const localDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});

function scheduleAt(now) {
  const {year, month, day, hour, minute} = Object.fromEntries(localDate.formatToParts(now).map(p => [p.type, p.value]));
  return {
    date: `${year}-${month}-${day}`,
    dayIndex: Math.floor(Date.UTC(+year, +month - 1, +day) / 86400000),
    inWindow: hour === "13" && Number(minute) >= 30
  };
}

function batchFor(dayIndex) {
  const alternate = ((dayIndex % 2) + 2) % 2;
  const group = DATASETS.slice(alternate * 3, alternate * 3 + 3);
  const cycleLength = Math.ceil(Math.max(...group.map(d => d.pages.length)) / BATCH_PER_PUBLISHER);
  const turn = Math.floor(dayIndex / 2);
  const startIndex = ((turn % cycleLength + cycleLength) % cycleLength) * BATCH_PER_PUBLISHER;
  return group.map(d => ({
    name: d.name,
    seeds: d.pages.slice(startIndex, startIndex + BATCH_PER_PUBLISHER).map(page => d.base + page)
  })).filter(d => d.seeds.length);
}

function aggregate(body) {
  const trainer = body?.trainer || {};
  return {
    enabled: trainer.publicCrawlTraining === true,
    baselineExamples: Number(body?.baseline?.trainingExamples) || 0,
    baselineUpdates: Number(body?.baseline?.optimizerUpdates) || 0,
    trained: Number(trainer.trained) || 0,
    queued: Number(trainer.queueSize) || 0,
    bySource: Object.fromEntries(Object.keys(SOURCES).map(name => [name, Number(trainer.bySource?.[name]) || 0]))
  };
}

function createRunner({ dataDir, port, token, fetchImpl = fetch, now = () => new Date(), wait = pause,
  log = event => console.log("[VEYRA_STAGING_TRAINING]", JSON.stringify(event)) }) {
  let working = false;
  let ready = false;
  const status = async (path, payload) => {
    const headers = { "x-veyra-admin-token": token };
    if (payload) headers["content-type"] = "application/json";
    const response = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
      headers, method: payload ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(35000),
      body: payload ? JSON.stringify(payload) : undefined
    });
    if (!response.ok) throw new Error("Staging endpoint unavailable");
    return response.json();
  };
  const stats = async () => {
    const body = await status("/api/neural/stats");
    if (!body?.ok || body.mongo?.configured !== false) throw new Error("Staging storage is not isolated");
    return aggregate(body);
  };
  return async function run() {
    const {date, dayIndex, inWindow} = scheduleAt(now());
    if (working) return;
    const marker = join(dataDir, `crawl-batch-${date}`);
    if (ready && (!inWindow || fs.existsSync(marker))) return;
    working = true;
    try {
      const before = await stats();
      if (!ready) {
        log({ phase: "ready", date, ...before });
        ready = true;
      }
      if (!before.enabled || !inWindow) return;
      try {
        fs.closeSync(fs.openSync(marker, "wx", 0o600));
      } catch (error) {
        if (error.code === "EEXIST") return;
        throw error;
      }
      const datasets = [];
      for (const {name, seeds} of batchFor(dayIndex)) {
        let completed = 0;
        try {
          const result = await status("/api/neural/index", { seeds, maxPages: seeds.length, maxDepth: 1 });
          if (result?.ok && Array.isArray(result.results)) {
            completed = Math.min(seeds.length, result.results.filter(x => x.status === "fulfilled").length);
          }
        } catch { /* One publisher must not block the other datasets. */ }
        datasets.push({ name, attempted: seeds.length, completed });
      }
      let after = await stats();
      for (let check = 0; after.queued > 0 && check < 8; check++) {
        await wait(1500);
        after = await stats();
      }
      log({ phase: "batch", date, datasets, trainedDelta: after.trained - before.trained, ...after });
    } catch {
      log({ phase: "unavailable", date });
    } finally {
      working = false;
    }
  };
}

function start(env = process.env) {
  const port = Number(env.PORT || 10000);
  if (!stagingIsolation(env) || !/^[0-9a-f]{64}$/.test(env.VEYRA_ADMIN_TOKEN || "") ||
      !Number.isInteger(port) || port < 1 || port > 65535) return false;
  const run = createRunner({ dataDir: STAGING_DIR, port, token: env.VEYRA_ADMIN_TOKEN });
  setTimeout(run, 2000).unref();
  setInterval(run, 60_000).unref();
  return true;
}

module.exports = { aggregate, batchFor, createRunner, scheduleAt, start };
