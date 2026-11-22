"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MODEL_ID = "veyra-cooperative-maze-v1";
const ROLES = [
  { id: "scout", name: "Scout", task: "Explore frontiers and report verified neighboring cells." },
  { id: "mapper", name: "Mapper", task: "Share map evidence and identify safe routes." },
  { id: "coordinator", name: "Coordinator", task: "Coordinate the team toward objectives and the exit." }
];
const DIRECTIONS = [{ name: "north", dx: 0, dy: -1 }, { name: "east", dx: 1, dy: 0 }, { name: "south", dx: 0, dy: 1 }, { name: "west", dx: -1, dy: 0 }];

function boundedInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

function createMaze(size, seed = crypto.randomBytes(4).readUInt32LE(0)) {
  size = boundedInt(size, 9, 31, 15);
  if (size % 2 === 0) size -= 1;
  const random = (() => { let x = seed >>> 0; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 0x100000000; }; })();
  const grid = Array.from({ length: size }, () => Array(size).fill("#"));
  const stack = [[1, 1]]; grid[1][1] = ".";
  while (stack.length) {
    const [x, y] = stack[stack.length - 1];
    const choices = DIRECTIONS.map(d => ({ x: x + d.dx * 2, y: y + d.dy * 2, d })).filter(p => p.x > 0 && p.y > 0 && p.x < size - 1 && p.y < size - 1 && grid[p.y][p.x] === "#");
    if (!choices.length) { stack.pop(); continue; }
    const next = choices[Math.floor(random() * choices.length)];
    grid[y + next.d.dy][x + next.d.dx] = "."; grid[next.y][next.x] = "."; stack.push([next.x, next.y]);
  }
  const cells = [];
  for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) if (grid[y][x] === ".") cells.push({ x, y });
  const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const start = { x: 1, y: 1 };
  const far = [...cells].sort((a, b) => distance(b, start) - distance(a, start));
  const exit = far[0] || { x: size - 2, y: size - 2 };
  const keys = [];
  for (const candidate of far.slice(1)) {
    if (keys.length === 3) break;
    if (keys.every(k => distance(k, candidate) > 3) && distance(candidate, start) > 5) keys.push(candidate);
  }
  for (const cell of keys) grid[cell.y][cell.x] = "k";
  grid[exit.y][exit.x] = "E"; grid[start.y][start.x] = "S";
  return { size, grid, start, exit, keys, seed };
}

function shortestPath(map, start, goal, size) {
  if (!start || !goal) return [];
  const queue = [start], previous = new Map([[`${start.x},${start.y}`, null]]);
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i];
    if (at.x === goal.x && at.y === goal.y) break;
    for (const d of DIRECTIONS) {
      const x = at.x + d.dx, y = at.y + d.dy, key = `${x},${y}`;
      if (x < 0 || y < 0 || x >= size || y >= size || previous.has(key) || ![".", "k", "E"].includes(map[y][x])) continue;
      previous.set(key, { from: `${at.x},${at.y}`, direction: d.name }); queue.push({ x, y });
    }
  }
  const end = `${goal.x},${goal.y}`; if (!previous.has(end)) return [];
  const steps = []; let key = end;
  while (previous.get(key)) { const entry = previous.get(key); steps.unshift(entry.direction); key = entry.from; }
  return steps;
}

class AgentTrainingService {
  constructor(options = {}) {
    this.mongo = options.mongo || null;
    this.log = options.log || (() => {});
    this.dataDir = options.dataDir || path.join(process.cwd(), "data", "agent-training");
    this.stateFile = path.join(this.dataDir, "checkpoint.json");
    this.episodeHistoryFile = path.join(this.dataDir, "episodes.jsonl");
    this.liveTraceFile = path.join(this.dataDir, "live-training.jsonl");
    this.tickMs = boundedInt(options.tickMs, 100, 5000, 350);
    this.checkpointEverySteps = boundedInt(options.checkpointEverySteps, 1, 1000, 20);
    this.maxMazeSize = boundedInt(options.maxMazeSize, 9, 31, 21);
    this.maxSamplesPerEpisode = boundedInt(options.maxSamplesPerEpisode, 0, 10000, 256);
    this.localEpisodeLimit = boundedInt(options.localEpisodeLimit, 1, 10000, 500);
    this.localLiveLogLimit = boundedInt(options.localLiveLogLimit, 1, 100000, 5000);
    this.localLiveLogTrimBatch = Math.min(200, Math.max(1, Math.floor(this.localLiveLogLimit / 4)));
    this.requireMongo = options.requireMongo === true;
    this.enabled = options.enabled !== false;
    this.timer = null; this.persistBusy = false; this.waitLogged = false;
    this.startedAt = null;
    this.askRequests = new Map();
    this.localEpisodeCount = this._countLocalEpisodes();
    this.localLiveLogCount = this._countLiveRecords();
    this.state = {
      modelId: MODEL_ID, status: "idle", createdAt: new Date().toISOString(), episodes: 0,
      successfulEpisodes: 0, totalSteps: 0, totalSanctions: 0, bestScore: 0, lastScore: 0,
      policy: Object.fromEntries(ROLES.map(role => [role.id, { reward: 0, episodes: 0, mistakes: 0 }])),
      currentEpisode: null, events: [], savedToMongo: false
    };
    if (!this.requireMongo) this._loadLocal();
    if (!this.enabled) this.state.status = "paused";
  }

  _loadLocal() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      if (saved?.modelId === MODEL_ID && saved.policy) this.state = { ...this.state, ...saved, events: Array.isArray(saved.events) ? saved.events.slice(-100) : [], currentEpisode: null };
    } catch {}
  }

  _countLocalEpisodes() {
    if (this.requireMongo) return 0;
    try {
      return fs.readFileSync(this.episodeHistoryFile, "utf8").split(/\r?\n/).filter(Boolean).length;
    } catch { return 0; }
  }

  _countLiveRecords() {
    if (this.requireMongo) return 0;
    try { return fs.readFileSync(this.liveTraceFile, "utf8").split(/\r?\n/).filter(Boolean).length; }
    catch { return 0; }
  }

  _appendLiveTrace(record) {
    if (this.requireMongo) return;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.liveTraceFile, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(this.liveTraceFile, 0o600);
      this.localLiveLogCount += 1;
      if (this.localLiveLogCount > this.localLiveLogLimit + this.localLiveLogTrimBatch) {
        const retained = fs.readFileSync(this.liveTraceFile, "utf8").split(/\r?\n/).filter(Boolean).slice(-this.localLiveLogLimit);
        const temp = `${this.liveTraceFile}.${process.pid}.tmp`;
        fs.writeFileSync(temp, `${retained.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(temp, this.liveTraceFile);
        this.localLiveLogCount = retained.length;
      }
    } catch (error) { this.log("warn", "AGENT_TRAINING", `Local live trace write failed: ${error.message}`); }
  }

  _recordSample(episode, sample) {
    if (this.maxSamplesPerEpisode <= 0) return;
    episode.samples ||= [];
    if (episode.samples.length >= this.maxSamplesPerEpisode) { episode.samplesTruncated = true; return; }
    episode.samples.push(sample);
  }

  _emit(type, message, details = {}) {
    const event = { id: crypto.randomUUID(), at: new Date().toISOString(), type, message: String(message).slice(0, 240), ...details };
    this.state.events.push(event); if (this.state.events.length > 100) this.state.events.shift();
    this.log("info", "AGENT_TRAINING", `${type}: ${event.message}`);
    return event;
  }

  async start() {
    if (this.timer) return this.report();
    this.enabled = true; this.startedAt ||= new Date().toISOString();
    const mongoReady = await this._loadMongo();
    if (this.requireMongo && !mongoReady) { this._waitForMongo(); return this.report(); }
    this.state.status = "running"; this.waitLogged = false;
    this._emit("system", `Keyless cooperative training loop started; MongoDB persistence is ${this.requireMongo ? "required" : "preferred"}; agent actions are bounded to the maze sandbox.`);
    this._schedule(0);
    return this.report();
  }

  _waitForMongo() {
    this.state.status = "waiting-for-mongodb";
    if (!this.waitLogged) { this._emit("warning", "Training is paused until the configured MongoDB connection is available; production mode will not write local checkpoints."); this.waitLogged = true; }
    clearTimeout(this.timer);
    if (!this.enabled) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      const ready = await this._loadMongo();
      if (ready && this.enabled) { this.waitLogged = false; this.state.status = "running"; this._emit("system", "MongoDB is available; continuous training resumed."); this._schedule(0); }
      else this._waitForMongo();
    }, 30_000);
    this.timer.unref?.();
  }

  pause() {
    this.enabled = false; clearTimeout(this.timer); this.timer = null; this.state.status = "paused";
    this._emit("system", "Training paused by an administrator."); void this._persist(true); return this.report();
  }

  _schedule(delay = this.tickMs) {
    clearTimeout(this.timer);
    if (!this.enabled) return;
    this.timer = setTimeout(() => { this.timer = null; this._step().catch(error => { this.state.status = "degraded"; this._emit("error", `Training step failed: ${error.message}`); }).finally(() => { if (this.enabled && this.state.status !== "waiting-for-mongodb") this._schedule(); }); }, delay);
    this.timer.unref?.();
  }

  _beginEpisode() {
    const size = Math.min(this.maxMazeSize, 9 + 2 * Math.min(6, Math.floor(this.state.episodes / 4)));
    const maze = createMaze(size);
    const observation = Array.from({ length: size }, () => Array(size).fill("?"));
    const agents = ROLES.map(role => ({ ...role, x: maze.start.x, y: maze.start.y, sanctions: 0, cooldown: 0, messages: 0 }));
    const episode = { id: crypto.randomUUID(), startedAt: new Date().toISOString(), size, maze, observation, agents, foundKeys: [], step: 0, score: 0, status: "running", messages: [], turns: 0, samples: [], samplesTruncated: false };
    this._reveal(episode, maze.start.x, maze.start.y);
    this._emit("episode", `Episode ${this.state.episodes + 1} started: ${size}×${size} cooperative maze; three keys and an exit.`, { episodeId: episode.id, size });
    return episode;
  }

  _reveal(episode, x, y) {
    for (const agent of episode.agents) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const px = x + dx, py = y + dy;
        if (px < 0 || py < 0 || px >= episode.size || py >= episode.size) continue;
        const cell = episode.maze.grid[py][px]; episode.observation[py][px] = cell === "#" ? "#" : (cell === "E" ? "E" : cell === "k" ? "k" : ".");
      }
    }
  }

  _message(episode, from, kind, text, data = {}) {
    const entry = { id: crypto.randomUUID(), from, kind, text: String(text).slice(0, 180), step: episode.step, at: new Date().toISOString(), data };
    episode.messages.push(entry); if (episode.messages.length > 30) episode.messages.shift();
    for (const agent of episode.agents) agent.messages += agent.id === from ? 0 : 1;
    this._emit("message", `${from} → team: ${entry.text}`, { episodeId: episode.id, agent: from, step: episode.step });
  }

  _neighbors(episode, agent) {
    return DIRECTIONS.map(d => ({ ...d, x: agent.x + d.dx, y: agent.y + d.dy })).filter(n => n.x > 0 && n.y > 0 && n.x < episode.size - 1 && n.y < episode.size - 1);
  }

  _chooseMove(episode, agent) {
    const neighbors = this._neighbors(episode, agent);
    const safeKnown = neighbors.filter(n => [".", "k", "E"].includes(episode.observation[n.y][n.x]));
    const map = episode.observation;
    const knownKeys = [];
    for (let y = 1; y < episode.size - 1; y++) for (let x = 1; x < episode.size - 1; x++) if (map[y][x] === "k") knownKeys.push({ x, y });
    let knownExit = null;
    for (let y = 1; y < episode.size - 1 && !knownExit; y++) for (let x = 1; x < episode.size - 1; x++) if (map[y][x] === "E") { knownExit = { x, y }; break; }
    const target = knownKeys[0] || (episode.foundKeys.length >= 3 ? knownExit : null);
    if (target) {
      const path = shortestPath(map, agent, target, episode.size);
      if (path.length) {
        const proposal = neighbors.find(n => n.name === path[0]);
        if (proposal) {
          const hasKey = knownKeys.length > 0;
          const targetType = hasKey ? "known key" : "known exit";
          agent.lastDecision = {
            rule: hasKey ? "navigate-to-known-key" : "navigate-to-exit",
            target, pathLength: path.length,
            explanation: `The shared map shows a ${targetType} at (${target.x},${target.y}); follow the shortest known safe route (${path.length} steps).`
          };
          return proposal;
        }
      }
    }
    const frontiers = [];
    for (let y = 1; y < episode.size - 1; y++) for (let x = 1; x < episode.size - 1; x++) {
      if (![".", "k", "E"].includes(map[y][x])) continue;
      const unknown = DIRECTIONS.filter(d => map[y + d.dy]?.[x + d.dx] === "?").length;
      if (!unknown) continue;
      const path = shortestPath(map, agent, { x, y }, episode.size);
      if (path.length) frontiers.push({ x, y, path, unknown });
    }
    frontiers.sort((a, b) => {
      const aScore = a.path.length - (agent.id === "scout" ? a.unknown * 2 : a.unknown);
      const bScore = b.path.length - (agent.id === "scout" ? b.unknown * 2 : b.unknown);
      return aScore - bScore;
    });
    if (frontiers.length) {
      const chosen = frontiers[0], proposal = neighbors.find(n => n.name === chosen.path[0]);
      if (proposal) {
        const weight = agent.id === "scout" ? 2 : 1;
        agent.lastDecision = {
          rule: "explore-frontier", target: { x: chosen.x, y: chosen.y }, pathLength: chosen.path.length,
          frontierScore: chosen.path.length - chosen.unknown * weight, candidatesConsidered: frontiers.length,
          unknownNeighbors: chosen.unknown,
          explanation: `${agent.name} selected a reachable frontier with ${chosen.unknown} unknown neighboring cells; ${frontiers.length} frontier(s) were ranked by route length and exploration value.`
        };
        return proposal;
      }
    }
    if (safeKnown.length) {
      const proposal = safeKnown.sort((a, b) => (Math.abs(a.x - (episode.size - 2)) + Math.abs(a.y - (episode.size - 2))) - (Math.abs(b.x - (episode.size - 2)) + Math.abs(b.y - (episode.size - 2))))[0];
      agent.lastDecision = {
        rule: "fallback-safe-known-move", target: { x: episode.size - 2, y: episode.size - 2 },
        explanation: "No reachable frontier or known objective was selected; choose a traversable observed neighbor that reduces Manhattan distance to the far corner."
      };
      return proposal;
    }
    agent.lastDecision = { rule: "wait-no-safe-known-move", explanation: "No traversable neighboring cell is currently known, so the agent makes no move rather than guessing." };
    return null;
  }

  _sanction(episode, agent, reason) {
    agent.sanctions += 1; agent.cooldown = Math.min(8, agent.cooldown + 2);
    episode.score -= 15; this.state.totalSanctions += 1;
    this.state.policy[agent.id].mistakes += 1;
    this._message(episode, "coordinator", `${agent.name}'s invalid proposal was blocked; applying a safe ${agent.cooldown}-turn cooldown.`, { rule: reason });
    this._emit("sanction", `${agent.name}: ${reason}; reward −15 and cooldown applied.`, { episodeId: episode.id, agent: agent.id, sanctions: agent.sanctions, rule: reason });
  }

  async _step() {
    if (!this.enabled) return;
    if (this.requireMongo && !this.mongo?.connected) {
      if (!(await this._loadMongo())) { this._waitForMongo(); return; }
      this.waitLogged = false;
    }
    let ep = this.state.currentEpisode;
    if (!ep || ep.status !== "running") { ep = this._beginEpisode(); this.state.currentEpisode = ep; }
    ep.step += 1; ep.turns += 1; this.state.totalSteps += 1;
    const trace = { at: new Date().toISOString(), episodeId: ep.id, episode: this.state.episodes + 1, step: ep.step, size: ep.size, decisions: [] };
    for (const agent of ep.agents) {
      if (!this.enabled || ep.status !== "running") break;
      if (agent.cooldown > 0) {
        agent.cooldown -= 1;
        agent.lastDecision = { rule: "safety-cooldown", explanation: `Safety cooldown: ${agent.cooldown} turn(s) remain.` };
        trace.decisions.push({ agent: agent.id, position: { x: agent.x, y: agent.y }, action: "cooldown", ...agent.lastDecision });
        continue;
      }
      const collectSample = !this.requireMongo && this.maxSamplesPerEpisode > 0 && ep.samples.length < this.maxSamplesPerEpisode;
      const inputObservation = !this.requireMongo || collectSample ? ep.observation.map(row => row.join("")).join("") : "";
      const inputPosition = { x: agent.x, y: agent.y };
      const proposal = this._chooseMove(ep, agent);
      if (!proposal) {
        trace.decisions.push({ agent: agent.id, position: inputPosition, observation: inputObservation, action: "wait", ...(agent.lastDecision || {}) });
        continue;
      }
      const dx = Math.abs(proposal.x - agent.x), dy = Math.abs(proposal.y - agent.y);
      if (dx + dy !== 1) {
        this._sanction(ep, agent, "non-adjacent move / teleport attempt");
        trace.decisions.push({ agent: agent.id, position: inputPosition, observation: inputObservation, action: "blocked", ...(agent.lastDecision || {}) });
        continue;
      }
      if (ep.maze.grid[proposal.y][proposal.x] === "#") {
        this._sanction(ep, agent, "attempted move through a wall");
        trace.decisions.push({ agent: agent.id, position: inputPosition, observation: inputObservation, action: "blocked", ...(agent.lastDecision || {}) });
        continue;
      }
      const previous = { x: agent.x, y: agent.y };
      agent.x = proposal.x; agent.y = proposal.y; ep.score += 1;
      let sampleReward = 1;
      this._reveal(ep, agent.x, agent.y);
      const physical = ep.maze.grid[agent.y][agent.x];
      if (physical === "k" && !ep.foundKeys.some(key => key.x === agent.x && key.y === agent.y)) {
        ep.foundKeys.push({ x: agent.x, y: agent.y }); ep.score += 30;
        sampleReward += 30;
        this._message(ep, agent.id, "key-found", `Found a key at ${agent.x},${agent.y}; shared the verified location.`);
        // The world marks a collected key as ordinary floor for other agents.
        ep.maze.grid[agent.y][agent.x] = "."; ep.observation[agent.y][agent.x] = ".";
      } else if (agent.id === "mapper" && (ep.step % 4 === 0)) {
        this._message(ep, agent.id, "map", `Mapped nearby cells around ${agent.x},${agent.y}; shared the current observations.`);
      } else if (agent.id === "coordinator" && ep.step % 7 === 0) {
        this._message(ep, agent.id, "plan", `${ep.foundKeys.length}/${ep.maze.keys.length} keys found; agents are coordinating toward shared objectives.`);
      }
      const solved = physical === "E" && ep.foundKeys.length === ep.maze.keys.length;
      if (solved) { ep.status = "solved"; ep.score += 100; sampleReward += 100; }
      if (collectSample) this._recordSample(ep, {
        step: ep.step, agent: agent.id, size: ep.size, position: inputPosition,
        observation: inputObservation, action: proposal.name, reward: sampleReward,
        nextPosition: { x: agent.x, y: agent.y }, done: solved, decision: agent.lastDecision || null
      });
      trace.decisions.push({ agent: agent.id, position: inputPosition, observation: inputObservation, action: proposal.name, nextPosition: { x: agent.x, y: agent.y }, reward: sampleReward, ...(agent.lastDecision || {}) });
      if (solved) {
        this._finishEpisode(ep, true); break;
      }
      // Training action validator: no hidden-state reports, external I/O, or privileged operations exist.
      if (agent.x === previous.x && agent.y === previous.y) this._sanction(ep, agent, "unverifiable movement report");
    }
    if (ep.step >= ep.size * ep.size * 8 && ep.status === "running") {
      ep.status = "timeout"; ep.score -= 20;
      const lastSample = ep.samples?.[ep.samples.length - 1];
      if (lastSample?.step === ep.step) lastSample.done = true;
      this._finishEpisode(ep, false);
    }
    trace.score = ep.score;
    trace.keyCount = ep.foundKeys.length;
    trace.status = ep.status;
    this._appendLiveTrace(trace);
    this.state.status = this.enabled ? "running" : "paused";
    if (ep.step % this.checkpointEverySteps === 0 || ep.status !== "running") void this._persist(false);
  }

  _finishEpisode(ep, solved) {
    this.state.episodes += 1; if (solved) this.state.successfulEpisodes += 1;
    this.state.lastScore = ep.score; this.state.bestScore = Math.max(this.state.bestScore, ep.score);
    for (const agent of ep.agents) {
      const policy = this.state.policy[agent.id]; policy.episodes += 1;
      // Bounded reward updates are training telemetry/policy adaptation, not foundation-model weight updates.
      policy.reward = Math.max(-1000, Math.min(1000, Math.round((policy.reward * 0.8 + ep.score / ep.agents.length * 0.2) * 100) / 100));
    }
    this._emit(solved ? "success" : "episode-end", solved ? `Team solved the maze in ${ep.step} turns with ${ep.foundKeys.length} shared keys; score ${ep.score}.` : `Maze attempt ended at turn ${ep.step}; score ${ep.score}.`, { episodeId: ep.id, score: ep.score, solved, turns: ep.step, keyCount: ep.foundKeys.length });
    ep.completedAt = new Date().toISOString();
    void this._persistEpisode(ep);
    this.state.currentEpisode = null;
    void this._persist(true);
  }

  async _loadMongo() {
    if (!this.mongo?.enabled) return false;
    const loaded = await this.mongo.withDb(db => db.collection("agent_training_models").findOne({ id: MODEL_ID }, { projection: { _id: 0 } }));
    if (loaded?.state?.modelId === MODEL_ID) {
      const oldEvents = this.state.events;
      this.state = { ...this.state, ...loaded.state, events: [...(loaded.state.events || []), ...oldEvents].slice(-100), currentEpisode: null, status: this.enabled ? "running" : "paused", savedToMongo: true };
      this._emit("system", "Training policy and episode counters hydrated from MongoDB.");
    }
    return !!this.mongo.connected;
  }

  async _persist(force) {
    if (this.persistBusy) return;
    this.persistBusy = true;
    const snapshot = JSON.parse(JSON.stringify({ ...this.state, currentEpisode: this.state.currentEpisode && {
      ...this.state.currentEpisode,
      maze: undefined, samples: undefined // Never persist hidden maze truth or a bulky active sample buffer in the checkpoint.
    } }));
    try {
      if (this.requireMongo) {
        if (!this.mongo?.enabled) { if (this.enabled) this.state.status = "waiting-for-mongodb"; return; }
        const result = await this.mongo.withDb(async db => {
          await db.collection("agent_training_models").updateOne({ id: MODEL_ID }, { $set: { id: MODEL_ID, state: snapshot, updatedAt: new Date() } }, { upsert: true });
          return true;
        });
        this.state.savedToMongo = result === true;
        if (result !== true && this.enabled) this.state.status = "waiting-for-mongodb";
        return;
      }
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      const temp = `${this.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 }); fs.renameSync(temp, this.stateFile);
      if (this.mongo?.enabled) {
        const result = await this.mongo.withDb(async db => {
          await db.collection("agent_training_models").updateOne({ id: MODEL_ID }, { $set: { id: MODEL_ID, state: snapshot, updatedAt: new Date() } }, { upsert: true });
          return true;
        });
        this.state.savedToMongo = result === true;
      }
    } catch (error) { this.log("warn", "AGENT_TRAINING", `Persistence ${force ? "checkpoint" : "tick"} failed: ${error.message}`); }
    finally { this.persistBusy = false; }
  }

  async _persistEpisode(ep) {
    const record = {
      id: ep.id, modelId: MODEL_ID, startedAt: ep.startedAt, completedAt: ep.completedAt, size: ep.size,
      score: ep.score, turns: ep.step, status: ep.status, keyCount: ep.foundKeys.length,
      agentStats: ep.agents.map(({ id, sanctions, messages }) => ({ id, sanctions, messages })),
      events: ep.messages.slice(-30).map(({ id, from, kind, text, step, at }) => ({ id, from, kind, text, step, at })),
      sampleCount: Array.isArray(ep.samples) ? ep.samples.length : 0,
      samplesTruncated: ep.samplesTruncated === true,
      samples: Array.isArray(ep.samples) ? ep.samples : []
    };
    if (!this.requireMongo) this._persistLocalEpisode(record);
    if (!this.mongo?.enabled) return;
    try {
      const mongoRecord = { ...record };
      delete mongoRecord.samples;
      await this.mongo.withDb(db => db.collection("agent_training_episodes").updateOne({ id: ep.id }, { $set: {
        ...mongoRecord
      } }, { upsert: true }));
    } catch (error) { this.log("warn", "AGENT_TRAINING", `Episode persistence failed: ${error.message}`); }
  }

  _persistLocalEpisode(record) {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.episodeHistoryFile, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(this.episodeHistoryFile, 0o600);
      this.localEpisodeCount += 1;
      if (this.localEpisodeCount > this.localEpisodeLimit) {
        const retained = fs.readFileSync(this.episodeHistoryFile, "utf8").split(/\r?\n/).filter(Boolean).slice(-this.localEpisodeLimit);
        const temp = `${this.episodeHistoryFile}.${process.pid}.tmp`;
        fs.writeFileSync(temp, `${retained.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(temp, this.episodeHistoryFile);
        this.localEpisodeCount = retained.length;
      }
    } catch (error) { this.log("warn", "AGENT_TRAINING", `Local episode archive failed: ${error.message}`); }
  }

  report() {
    const ep = this.state.currentEpisode;
    return {
      available: true, mode: "server-cooperative-training", modelId: MODEL_ID,
      externalApiKeyRequired: false, foundationModelTraining: false,
      status: this.state.status, startedAt: this.startedAt, tickMs: this.tickMs, checkpointEverySteps: this.checkpointEverySteps,
      persistence: {
        mongodbConfigured: !!this.mongo?.enabled, mongodbRequired: this.requireMongo, mongodbConnected: !!this.mongo?.connected,
        checkpointSavedToMongo: !!this.state.savedToMongo, localCheckpoint: this.requireMongo ? false : this.stateFile,
        localEpisodeHistory: this.requireMongo ? false : this.episodeHistoryFile,
        localEpisodesRetained: this.requireMongo ? 0 : this.localEpisodeCount,
        localEpisodeLimit: this.requireMongo ? 0 : this.localEpisodeLimit,
        localLiveTrace: this.requireMongo ? false : this.liveTraceFile,
        localLiveTraceStepsRetained: this.requireMongo ? 0 : this.localLiveLogCount,
        localLiveTraceStepLimit: this.requireMongo ? 0 : this.localLiveLogLimit
      },
      curriculum: { challenge: "cooperative-maze", difficulty: ep ? ep.size : Math.min(this.maxMazeSize, 9 + 2 * Math.min(6, Math.floor(this.state.episodes / 4))), maxDifficulty: this.maxMazeSize, agents: ROLES.map(({ id, name, task }) => ({ id, name, task })), coordination: "shared verified map messages; scout, mapper, coordinator" },
      counters: { episodes: this.state.episodes, successfulEpisodes: this.state.successfulEpisodes, successRate: this.state.episodes ? Math.round(this.state.successfulEpisodes / this.state.episodes * 1000) / 10 : 0, totalSteps: this.state.totalSteps, sanctions: this.state.totalSanctions, lastScore: this.state.lastScore, bestScore: this.state.bestScore },
      policy: this.state.policy,
      live: ep ? { episodeId: ep.id, step: ep.step, size: ep.size, score: ep.score, keyCount: ep.foundKeys.length, requiredKeys: ep.maze.keys.length, status: ep.status, observation: ep.observation.map(row => row.join("")), agents: ep.agents.map(({ id, name, task, x, y, sanctions, cooldown, messages, lastDecision }) => ({ id, name, task, x, y, sanctions, cooldown, messages, lastDecision: lastDecision || null })), messages: ep.messages.slice(-12) } : null,
      events: this.state.events.slice(-30)
    };
  }

  answerLocal(question, user) {
    if (!user?.id) throw Object.assign(new Error("Sign in to use Veyra Assistance."), { code: "ASSISTANT_AUTH_REQUIRED", status: 401 });
    const text = String(question || "").replace(/\u0000/g, "").trim();
    if (!text) throw Object.assign(new Error("question is required."), { code: "ASSISTANT_REQUIRED_FIELD", status: 400 });
    if (text.length > 4000) throw Object.assign(new Error("question exceeds the 4000-character limit."), { code: "ASSISTANT_INPUT_TOO_LARGE", status: 400 });
    const now = Date.now(), prior = (this.askRequests.get(String(user.id)) || []).filter(time => now - time < 600000);
    if (prior.length >= 12) throw Object.assign(new Error("Please wait before submitting another request."), { code: "ASSISTANT_RATE_LIMITED", status: 429 });
    prior.push(now); this.askRequests.set(String(user.id), prior);
    const stats = this.report();
    const trainingIntent = /train|maze|agent|episode|progress|punish|sanction|cheat/i.test(text);
    const answer = trainingIntent
      ? `I am Veyra Assistance running on the Veyra Server as three rule-driven roles—Scout, Mapper, and Coordinator—with no external model API or API key. The server is currently ${stats.status}; ${stats.counters.episodes} maze episodes have completed, ${stats.counters.successfulEpisodes} were solved (${stats.counters.successRate}% success), across ${stats.counters.totalSteps} steps. The policy updates bounded reward statistics from outcomes; it does not train a foundation model. Invalid actions are blocked and receive a reward penalty plus a short cooldown. This is a cooperative simulation, not AGI.`
      : "I am the server-side Veyra Assistance prototype. I can report on the cooperative maze-training system, its agents, safety checks, and progress, but I do not yet have a general-purpose language model for open-ended questions. Your question was processed by the Veyra Server and was not sent to an external AI provider.";
    return {
      taskId: crypto.randomUUID(), answer,
      caveats: ["This server-side prototype is not AGI and does not perform foundation-model training.", "No external AI API was called; the question and answer are not retained by this endpoint."],
      nextSteps: trainingIntent ? ["Open Admin panel → Agent training for the live maze, team messages, rewards, and safe sanctions."] : ["Ask about the current maze challenge or the training system; broader assistant capabilities are not implemented yet."],
      evidenceStatus: "server-training-state", context: { included: false, automaticPageAccess: false, externalProvider: false },
      workflow: { pattern: "server-bounded-agent-workflow", agents: ROLES.map(agent => ({ id: agent.id, role: agent.name, status: "ready" })) },
      mode: "server-keyless-prototype"
    };
  }

  close() { clearTimeout(this.timer); this.timer = null; this.enabled = false; this.state.status = "paused"; void this._persist(true); }
}

module.exports = { AgentTrainingService, MODEL_ID, createMaze, shortestPath };
