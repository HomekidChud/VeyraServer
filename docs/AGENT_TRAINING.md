# Veyra Assistance — Local Agent Training Prototype

## What it is

Veyra Assistance now has a local, keyless cooperative-training path. The Veyra Server process runs three bounded rule-driven roles—**Scout**, **Mapper**, and **Coordinator**—through generated mazes. They share verified map observations and team messages, collect objectives, and attempt to reach the exit. Difficulty increases gradually within a configured maze-size limit.

This is a software-agent simulation with bounded reward-statistic updates. It is **not** a general-purpose language model, foundation-model training, or AGI. The environment does not execute agent-generated programs, access user browser sessions, make network calls on the agents' behalf, or expose host files to maze agents. The public Assistant endpoint handles questions locally and honestly states when a question is outside its limited domain. It does not call an external model API, even when provider credentials happen to exist in the server environment.

## Continuous training loop

The training loop starts with the main server process by default and pauses when that process exits. It does not keep a hosting provider awake, survive host suspension, or run after deployment shutdown. For uninterrupted operation, deploy Veyra Server on an always-on service/worker and configure its platform to restart the process after failure. Do not start a second training loop per worker replica unless shared coordination or a single-leader lock is added; the current design is one loop per server process.

Configuration:

| Environment variable | Default | Purpose |
|---|---:|---|
| `VEYRA_AGENT_TRAINING_ENABLED` | `true` | Start the local training loop during main-server startup |
| `VEYRA_AGENT_TRAINING_TICK_MS` | `350` | Delay between bounded simulation steps (clamped to 100–5000 ms) |
| `VEYRA_AGENT_TRAINING_MAX_MAZE` | `21` | Maximum odd maze side length (clamped to 9–31) |
| `VEYRA_AGENT_TRAINING_DIR` | `<authDataDir>/agent-training` | Protected local checkpoint fallback directory |
| `MONGODB_URI` / `MONGODB_DB` | unset / `veyra` | Existing Veyra MongoDB connection configuration |

The server maintains a local checkpoint regardless of MongoDB availability. If `MONGODB_URI` is configured and the existing Mongo adapter connects, Veyra stores the bounded policy/counters in `agent_training_models` and completed episode summaries in `agent_training_episodes`. Mongo persistence failures are logged; local checkpoint persistence remains the fallback. Configure a durable MongoDB URI in the deployment environment to meet the Mongo persistence requirement. No URI was configured in the development environment used for this code change, so live Mongo persistence was not exercised here.

The visible maze observations are checkpointed; hidden maze truth is intentionally omitted from the live checkpoint. Completed summaries store scores, difficulty, outcomes, agent counters, and sanitized team messages—not full hidden solutions.

## Admin live view

Open **Admin panel → Agent training**. The route and backing `/api/admin/agent-training` and `/api/admin/agent-training/control` endpoints require the existing Veyra administrator gate. The screen refreshes using the Admin panel's existing live-poll setting and displays the current observation map, agent positions, messages, episode counts, solve rate, bounded reward statistics, and safety sanctions. Admins may pause or resume the loop.

**Voice events** is off by default and can be enabled locally in the browser. It uses built-in browser speech synthesis for a small set of major training events; it sends no audio to the server.

## Safety response / sanctions

Agent moves are validated against the sandbox's grid and must be adjacent and traversable. Invalid proposals are blocked, incur a reward penalty, and receive a short cooldown. Sanction counters and reasons appear in the admin live event feed. These are simulated training penalties only: no person, account, process priority, or operating-system resource is punished. The agents do not have arbitrary code, network, or host-control tools to misuse.

The current curriculum demonstrates cooperative maze exploration and safe action validation. It does not yet constitute a broad library of diverse cognitive curricula. Add new isolated benchmark environments, reproducible scoring, adversarial test fixtures, and independent safety evaluation before expanding claims or capabilities.

## Verification

Run `npm test` for server regression tests and `npm run check` for browser source validation. Agent-training tests check maze reachability, no-key responses, sanction counters/cooldowns, and checkpoint exclusion of hidden maze truth. These tests do not prove general intelligence, continuous production uptime, Mongo availability, or resistance to all forms of malicious behavior.
