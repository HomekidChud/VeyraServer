# Veyra Assistance — Server Agent Training Prototype

## What it is

Veyra Assistance has a server-side, keyless cooperative-training path. The Veyra Server process runs three rule-driven roles—**Scout**, **Mapper**, and **Coordinator**—through generated mazes. They share verified map observations and team messages, collect objectives, and attempt to reach the exit. Difficulty increases gradually within a configured maze-size limit.

This is a software-agent simulation with bounded reward-statistic updates. It is **not** a general-purpose language model, foundation-model training, or AGI. The environment does not execute agent-generated programs, access user browser sessions, make network calls on the agents' behalf, or expose host files to maze agents. The public Assistant endpoint handles questions locally and honestly states when a question is outside its limited domain. It does not call an external model API, even when provider credentials happen to exist in the server environment.

## Continuous training loop

The training loop starts with the main server process by default and pauses when that process exits. Render free web services spin down after 15 minutes without inbound traffic and are not suitable for 24/7 training. The current Render blueprint specifies the paid `pro` compute plan (2 CPU / 4 GB RAM); the live VeyraServer service was observed on Render's `free` plan, so the blueprint and service are not yet aligned. Paid compute is required for the stated always-on goal. Do not start a second training loop per worker replica unless shared coordination or a single-leader lock is added; the current design is one loop per server process.

Configuration:

| Environment variable | Default | Purpose |
|---|---:|---|
| `VEYRA_AGENT_TRAINING_ENABLED` | `true` | Start the server training loop during main-server startup |
| `VEYRA_AGENT_TRAINING_REQUIRE_MONGO` | `false` in development; `true` in Render blueprint | In strict mode, never read or write local checkpoints; pause training until MongoDB connects |
| `VEYRA_AGENT_TRAINING_TICK_MS` | `350` | Delay between bounded simulation steps (clamped to 100–5000 ms) |
| `VEYRA_AGENT_TRAINING_CHECKPOINT_STEPS` | `20` | Persist active state to Mongo every N steps; completed episodes are saved immediately |
| `VEYRA_AGENT_TRAINING_MAX_MAZE` | `21` | Maximum odd maze side length (clamped to 9–31) |
| `VEYRA_AGENT_TRAINING_SAMPLES_PER_EPISODE` | `256` | Maximum visible-observation/action/reward samples stored for each completed episode; `0` disables samples |
| `VEYRA_AGENT_TRAINING_LOCAL_EPISODES` | `500` | Maximum completed episode records retained in the local JSONL archive when MongoDB is not required |
| `VEYRA_AGENT_TRAINING_LIVE_LOG_STEPS` | `5000` | Target number of recent live-turn records in the local JSONL decision trace; file compaction runs in bounded batches to avoid rewriting it on every phone tick |
| `VEYRA_AGENT_TRAINING_DIR` | `<authDataDir>/agent-training` | Protected development-only checkpoint fallback when MongoDB is not required |
| `MONGODB_URI` / `MONGODB_DB` | unset / `veyra` | Existing Veyra MongoDB connection configuration |

In Render production, `VEYRA_AGENT_TRAINING_REQUIRE_MONGO=true`: Veyra reads/writes the policy, counters, visible episode checkpoint, and completed summaries through the existing Mongo adapter, using `agent_training_models` and `agent_training_episodes`. On connection loss, the training loop pauses and retries; it never silently falls back to Render's ephemeral filesystem. Development can use a protected local checkpoint when strict Mongo mode is off. Render logs from the existing deployment confirm that Veyra's application Mongo database is configured and existing data hydrates successfully; the new agent-training collections still require a post-deployment write/read check.

The visible maze observations are checkpointed; hidden maze truth is intentionally omitted from the live checkpoint. Completed summaries store scores, difficulty, outcomes, agent counters, and sanitized team messages—not full hidden solutions. When MongoDB is not required, Veyra also writes a bounded local `episodes.jsonl` archive. It retains only the newest configured number of episodes and records up to the configured sample cap per episode. A sample contains the team's visible observation, selected action, reward, and resulting position; hidden maze layouts are not written. This is synthetic maze experience, not scraped or user-provided data.

The archive makes experience available for analysis or a future learning implementation. The current policy remains rule-driven and does not train foundation-model weights; running it longer creates more maze examples and counters, not general intelligence. See [`TERMUX_SETUP.md`](./TERMUX_SETUP.md) for a local phone profile. Android may still stop background work, so Termux is best-effort rather than guaranteed 24/7 compute.

## Admin live view

Open **`/admin/agent-training`** on the same Veyra Server host (for a phone-only Termux server, `http://127.0.0.1:10000/admin/agent-training`). The standalone mobile-friendly page and backing `/api/admin/agent-training` and `/api/admin/agent-training/control` endpoints require the existing administrator gate. It refreshes the visible map, agent positions, latest rule-based decision explanations, messages, episode counts, solve rate, reward statistics, and sanctions; admins can pause/resume and download the live trace. The local trace file is `live-training.jsonl` beside the checkpoint and completed-episode archive. It is a rolling, private JSONL log of recent observed maps, selected actions/rules, outcomes, and score—not hidden maze layouts. `tail -f` can follow it from Termux.

The decision explanations are a transparent account of the implemented rules and visible evidence, not a dump of private chain-of-thought. These agents are deterministic rule-based code, not a language model with hidden thoughts.

**Voice events** is off by default and can be enabled locally in the browser. It uses built-in browser speech synthesis for a small set of major training events; it sends no audio to the server.

## Safety response / sanctions

Agent moves are validated against the sandbox's grid and must be adjacent and traversable. Invalid proposals are blocked, incur a reward penalty, and receive a short cooldown. Sanction counters and reasons appear in the admin live event feed. These are simulated training penalties only: no person, account, process priority, or operating-system resource is punished. The agents do not have arbitrary code, network, or host-control tools to misuse.

The current curriculum demonstrates cooperative maze exploration and safe action validation. It does not yet constitute a broad library of diverse cognitive curricula. Add new isolated benchmark environments, reproducible scoring, adversarial test fixtures, and independent safety evaluation before expanding claims or capabilities.

## Verification

Run `npm test` for server regression tests and `npm run check` for browser source validation. Agent-training tests check maze reachability, no-key responses, sanction counters/cooldowns, and checkpoint exclusion of hidden maze truth. These tests do not prove general intelligence, continuous production uptime, Mongo availability, or resistance to all forms of malicious behavior.
