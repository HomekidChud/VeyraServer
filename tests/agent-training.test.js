"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentTrainingService, MODEL_ID, createMaze, shortestPath } = require("../src/services/agent-training");
const { agentTrainingPage } = require("../src/services/agent-training-page");

(async () => {
  const maze = createMaze(9, 12345);
  assert.equal(maze.size, 9);
  assert.equal(maze.grid[maze.start.y][maze.start.x], "S");
  assert.equal(maze.grid[maze.exit.y][maze.exit.x], "E");
  assert.ok(maze.keys.length > 0);
  const openMap = maze.grid.map(row => row.map(cell => cell === "#" ? "#" : cell));
  const route = shortestPath(openMap, maze.start, maze.exit, maze.size);
  assert.ok(route.length > 0, "generated exit should be reachable");

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-agent-training-"));
  const service = new AgentTrainingService({ dataDir: temp, enabled: false, maxMazeSize: 9 });
  assert.equal(service.report().externalApiKeyRequired, false);
  assert.equal(service.report().foundationModelTraining, false);
  const answer = service.answerLocal("How is maze training progressing?", { id: "admin-test" });
  assert.match(answer.answer, /no external model API or API key/i);
  assert.equal(answer.context.automaticPageAccess, false);
  assert.equal(answer.mode, "server-keyless-prototype");
  assert.match(agentTrainingPage(), /Live shared observation/);
  assert.match(agentTrainingPage(), /Decision trace, not hidden thoughts/);
  assert.match(agentTrainingPage(), /loginForm/);
  assert.match(agentTrainingPage(), /New to this local server\? Create account/);
  assert.match(agentTrainingPage(), /authMode==="login"\?"\/api\/auth\/login":"\/api\/auth\/signup"/);
  assert.match(agentTrainingPage(), /headers\.set\("Authorization","Bearer \"\+authToken\)/);
  assert.match(agentTrainingPage(), /VEYRA_ADMIN_EMAILS/);
  assert.throws(() => service.answerLocal("", { id: "admin-test" }), /question is required/i);

  const episode = service._beginEpisode();
  service.state.currentEpisode = episode;
  service._sanction(episode, episode.agents[0], "test unauthorized move");
  assert.equal(episode.agents[0].sanctions, 1);
  assert.equal(episode.agents[0].cooldown, 2);
  assert.equal(service.state.totalSanctions, 1);
  await service._persist(true);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(temp, "checkpoint.json"), "utf8"));
  assert.equal(checkpoint.modelId, MODEL_ID);
  assert.equal(checkpoint.currentEpisode.maze, undefined, "hidden maze solution must not be stored in the live checkpoint");
  assert.ok(Array.isArray(checkpoint.currentEpisode.observation));
  service.close();
  fs.rmSync(temp, { recursive: true, force: true });

  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-agent-archive-"));
  const archive = new AgentTrainingService({ dataDir: archiveDir, enabled: false, localEpisodeLimit: 2, maxSamplesPerEpisode: 1 });
  const sampleEpisode = archive._beginEpisode();
  archive._recordSample(sampleEpisode, { step: 1, observation: "safe-visible-map", action: "east", reward: 1, done: false });
  archive._recordSample(sampleEpisode, { step: 2, observation: "safe-visible-map", action: "north", reward: 1, done: false });
  assert.equal(sampleEpisode.samples.length, 1, "per-episode sample collection should be capped");
  assert.equal(sampleEpisode.samplesTruncated, true);
  const liveSampler = new AgentTrainingService({ dataDir: archiveDir, enabled: true, maxMazeSize: 9, maxSamplesPerEpisode: 2, localLiveLogLimit: 2 });
  await liveSampler._step();
  const liveSample = liveSampler.state.currentEpisode.samples[0];
  assert.ok(liveSample, "a real maze step should record an experience sample");
  assert.equal(liveSample.observation.length, 81, "sample observation should be the visible 9×9 map");
  assert.ok(["north", "east", "south", "west"].includes(liveSample.action));
  assert.equal(typeof liveSample.reward, "number");
  assert.ok(liveSample.decision?.rule, "experience samples should expose a concise rule-based rationale");
  for (let i = 0; i < 5; i++) await liveSampler._step();
  const livePath = path.join(archiveDir, "live-training.jsonl");
  const liveRows = fs.readFileSync(livePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(liveRows.length <= 2, "live trace should retain no more than its configured maximum after compaction");
  assert.ok(liveRows.some(row => row.decisions.some(decision => decision.observation?.length === 81 && decision.rule)), "live trace should include visible maps and explicit decision rules");
  assert.equal(Object.hasOwn(liveRows.at(-1), "maze"), false, "live trace must not contain the hidden maze layout");
  assert.equal(fs.statSync(livePath).mode & 0o777, 0o600, "live trace should be owner-only on the local filesystem");
  assert.equal(liveSampler.report().persistence.localLiveTraceStepsRetained, 2);
  liveSampler.close();
  for (let i = 1; i <= 3; i++) {
    const ep = { ...archive._beginEpisode(), id: `local-${i}`, status: "solved", completedAt: new Date().toISOString(), samples: [{ step: i, observation: "visible-only", action: "east", reward: 1, done: true }] };
    await archive._persistEpisode(ep);
  }
  const archivePath = path.join(archiveDir, "episodes.jsonl");
  const archived = fs.readFileSync(archivePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(archived.map(row => row.id), ["local-2", "local-3"], "local archive should retain only the newest configured number of episodes");
  assert.equal(Object.hasOwn(archived[0], "maze"), false, "experience records must not contain the hidden maze layout");
  assert.equal(archived[0].samples[0].observation, "visible-only");
  assert.equal(archive.report().persistence.localEpisodesRetained, 2);
  archive.close();
  fs.rmSync(archiveDir, { recursive: true, force: true });

  const strictDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-agent-mongo-required-"));
  const strict = new AgentTrainingService({
    dataDir: strictDir, enabled: true, requireMongo: true,
    mongo: { enabled: false, connected: false, withDb: async () => null }
  });
  const strictStatus = await strict.start();
  assert.equal(strictStatus.status, "waiting-for-mongodb", "strict mode must not train before Mongo connects");
  assert.equal(strictStatus.persistence.localCheckpoint, false);
  await strict._persist(true);
  await strict._persistEpisode({ id: "strict-no-local", agents: [], messages: [], foundKeys: [], samples: [] });
  strict._appendLiveTrace({ step: 1 });
  assert.equal(fs.existsSync(path.join(strictDir, "checkpoint.json")), false, "strict mode must never write local checkpoints");
  assert.equal(fs.existsSync(path.join(strictDir, "episodes.jsonl")), false, "Mongo-required mode must not create a local episode archive");
  assert.equal(fs.existsSync(path.join(strictDir, "live-training.jsonl")), false, "Mongo-required mode must not create a local live trace");
  strict.close();
  fs.rmSync(strictDir, { recursive: true, force: true });

  const mongoDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-agent-mongo-live-"));
  const writes = [];
  const connectedMongo = {
    enabled: true, connected: true,
    withDb: async fn => fn({ collection: name => ({
      findOne: async () => null,
      updateOne: async (...args) => writes.push({ name, args })
    }) })
  };
  const mongoOnly = new AgentTrainingService({ dataDir: mongoDir, enabled: true, requireMongo: true, mongo: connectedMongo });
  const mongoStatus = await mongoOnly.start();
  assert.equal(mongoStatus.status, "running");
  clearTimeout(mongoOnly.timer); mongoOnly.timer = null;
  await mongoOnly._persist(true);
  assert.ok(writes.some(write => write.name === "agent_training_models"), "strict mode should checkpoint to MongoDB");
  assert.equal(mongoOnly.report().persistence.localCheckpoint, false);
  assert.equal(fs.existsSync(path.join(mongoDir, "checkpoint.json")), false, "Mongo-required mode never mirrors to local files");
  mongoOnly.close();
  fs.rmSync(mongoDir, { recursive: true, force: true });
  console.log("Agent training regression tests passed");
})().catch(error => { console.error(error); process.exit(1); });
