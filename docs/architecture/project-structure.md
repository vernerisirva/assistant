# Project Structure

This repo is the source of truth for Hilla's prompts, config templates, safety policy, helper scripts, tests, and docs. OpenClaw runtime files are generated locally.

## Source Directories

- `agents/`: source prompts and standing orders.
- `agents/personal/skills/<skill>/SKILL.md`: OpenClaw skills for the personal agent, such as `travel-deals`, `contract-renewals` and `stock-watch`. `render:config` copies them into `.openclaw/workspace-personal/skills/`, where OpenClaw discovers them; the model sees only each skill's name and description until it reads the file, so skills do not count against the project-doc budget either.
- `agents/personal/guides/`: detailed feature guides that a helper serves on demand, such as `npm run --silent focus -- guide`, `npm run --silent playbook -- guide` and `npm run --silent weekly-plan -- guide`. They are not rendered into workspaces and do not count against the project-doc budget.
- `config/`: JSON configuration templates used by render scripts and tests.
- `scripts/`: command-line helpers for config rendering, status, routines, Todoist, memory, Min Golf, and quiet ops.
- `scripts/lib/`: reusable helper modules with unit coverage.
- `tests/`: Node test suite.
- `docs/`: product, architecture, operations, security, setup, and Codex-facing guidance.

## Generated Runtime Directories

- `.openclaw/openclaw.json`: rendered config.
- `.openclaw/workspace-*`: generated per-agent workspaces.
- `.openclaw/agents/*`: generated OpenClaw agent directories.
- `.openclaw/state`: runtime state, including the Gateway's SQLite database (cron jobs and their run history), memories, weekly plans (`weekly-plan/`), the disposable focus session record (`focus/`), the private contract register (`contracts/`, owner-only, one file per contract, with the renewal watch's notes in `contracts/watch/`), the private stock watchlist (`stock-watch/`, owner-only: `watchlist/` records, the monitor's events, source health and report dates in `monitor/`, each event's importance, analysis, alert and answer plus the outbox in `alerts/`, the alert preferences in `preferences.json`, public listing caches in `cache/`), and Telegram state.

## Scheduled Jobs

The running Gateway's scheduler is the only source of truth for cron jobs and reminders. Scripts read and change it only through `scripts/lib/live-cron.mjs`, which calls the supported `openclaw cron` CLI. The old `.openclaw/state/cron/jobs.json` was migrated into the Gateway's database (renamed `jobs.json.migrated`) and is not read by anything.

Generated runtime files are local and private. They are ignored by git and should not be committed.

## Config Flow

1. Source prompts live in `agents/<agent>/AGENTS.md`.
2. Agent registry lives in `config/agents.json`.
3. Local env values live in `.env`.
4. `npm run render:config` renders `.openclaw/openclaw.json` and generated prompt workspaces.
5. The OpenClaw gateway loads the rendered config.

### Prompt Size Budget

The agents run on the Codex harness. It reads `AGENTS.md` files from the repository root down to the agent workspace, so each agent gets this repo's root `AGENTS.md` followed by its own prompt. Together they share Codex's 32 KiB project-doc budget. Anything past the budget is dropped without an error, and the end of an agent prompt holds its Confirm-before-action rules. `tests/agent-boundaries.test.mjs` fails when any agent prompt plus the root guide exceeds the budget. Keep prompt additions compact, and check a new session's Codex rollout after large prompt changes.

`agents/personal/SOUL.md` is outside that budget: OpenClaw puts it in the system prompt it builds (its "Agent Soul" section, in each turn's developer instructions), scheduled turns included. It holds the personal agent's voice and the policy for messages the user did not ask for.

A new capability keeps its triggers and hard boundaries in the standing orders and moves the detail into `agents/personal/guides/<feature>.md`, which its helper prints when the agent runs it. The focus, playbook and weekly-plan guides work this way: the prompt says when to run `npm run --silent focus -- guide` or `npm run --silent playbook -- guide`, and tests pin both the pointer and the guide.

## Capability Registry

`scripts/lib/capabilities.mjs` is the only list of what Hilla tells the user it can do. Help answers come from it through `npm run --silent capabilities -- guide`, never from a feature list in a prompt or a doc, so no other file keeps one. Each entry has one side-effect profile (effect, approval, automatic), and actions with different boundaries are separate entries. A boundary users tend to assume, such as Calendar writes or sending email, is an entry marked not supported, with what Hilla offers instead.

A new capability adds its entry in the same change. `tests/capabilities.test.mjs` fails when an available entry has no helper script or defining prompt or guide section behind it, when its approval disagrees with `config/approval-policy.json`, or when a pinned entry disappears.

## Safety Flow

`config/approval-policy.json`, `docs/security/approval-model.md`, and agent prompts should agree. Tests enforce important prompt and policy boundaries in:

- `tests/approval-policy.test.mjs`
- `tests/approval-language.test.mjs`
- `tests/agent-boundaries.test.mjs`
- `tests/inbox-action.test.mjs`
