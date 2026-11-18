"use strict";

const fs = require("node:fs");
const { join } = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");
const { SOURCES } = require("../src/services/neural-training-data");

const { STAGING_DIR, stagingIsolation } = require("./staging-ranker-baseline");
const BATCH_PER_PUBLISHER = 3;
const ROTATION_DAYS = 3;
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
    pages: "programs/earthquake-hazards programs/volcano-hazards programs/water-resources programs/land-change-science-program programs/national-geospatial-program programs/coastal-and-marine-hazards-and-resources-program programs/geomagnetism programs/land-remote-sensing-program programs/national-cooperative-geologic-mapping-program programs/energy-resources-program programs/mineral-resources-program water-science-school programs/national-land-imaging-program programs/ecosystems".split(" ")
  },
  {
    name: "pandas-data-analysis",
    base: "https://pandas.pydata.org/docs/user_guide/",
    pages: "index 10min dsintro basics indexing missing_data groupby merging reshaping timeseries timedeltas categorical visualization io options scaling enhancingperf sparse text".split(" ").map(name => `${name}.html`)
  },
  {
    name: "nist-statistical-methods",
    base: "https://www.itl.nist.gov/div898/handbook/",
    pages: "eda/index.htm eda/section2/eda21.htm eda/section3/eda33.htm eda/section3/eda35.htm mpc/index.htm ppc/index.htm pri/index.htm pmd/index.htm pmc/index.htm apr/index.htm prc/index.htm toolaids/pff/index.htm".split(" ")
  },
  {
    name: "nws-weather-education",
    base: "https://www.weather.gov/jetstream/",
    pages: "index atmosphere ocean clouds satellites radar synoptic thunderstorms lightning tornado tropical global".split(" ")
  },
  {
    name: "numpy-numerical-computing",
    base: "https://numpy.org/doc/stable/user/",
    pages: "absolute_beginners quickstart basics.creation basics.indexing basics.broadcasting basics.types basics.copies basics.ufuncs basics.rec basics.dispatch".split(" ").map(name => `${name}.html`)
  },
  {
    name: "r-statistics-and-data",
    base: "https://stat.ethz.ch/R-manual/R-devel/library/stats/html/",
    pages: "cor lm glm anova density filter acf arima prcomp hclust kmeans median quantile sd t.test chisq.test p.adjust predict aggregate smooth.spline".split(" ").map(name => `${name}.html`)
  },
  {
    name: "noaa-ocean-education",
    base: "https://oceanservice.noaa.gov/education/tutorial_",
    pages: "tides/ tides/tides01_intro.html tides/tides02_cause.html tides/tides03_gravity.html currents/ currents/01whatis.html currents/02tidal1.html currents/04currents1.html geodesy/ corals/ estuaries/ pollution/".split(" ")
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
    // The free service may be asleep at 13:30. Catch up on the same local date.
    inWindow: Number(hour) * 60 + Number(minute) >= 13 * 60 + 30
  };
}

function batchFor(dayIndex) {
  const modulo = (n, length) => (n % length + length) % length;
  const alternate = modulo(dayIndex, ROTATION_DAYS);
  const turn = Math.floor(dayIndex / ROTATION_DAYS);
  return DATASETS.filter((_, i) => i % ROTATION_DAYS === alternate).map(d => {
    const cycle = Math.ceil(d.pages.length / BATCH_PER_PUBLISHER);
    const startIndex = modulo(turn, cycle) * BATCH_PER_PUBLISHER;
    return { name: d.name, seeds: d.pages.slice(startIndex, startIndex + BATCH_PER_PUBLISHER).map(page => d.base + page) };
  });
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
            completed = Math.min(seeds.length, result.results.filter(x => x.status === "fulfilled" && Number(x.stats?.pagesCrawled) > 0).length);
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
