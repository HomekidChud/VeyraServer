"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentTrainingService, MODEL_ID, createMaze, shortestPath } = require("../src/services/agent-training");

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
  console.log("Agent training regression tests passed");
})().catch(error => { console.error(error); process.exit(1); });
