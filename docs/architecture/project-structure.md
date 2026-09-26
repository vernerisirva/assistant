# Project Structure

This repo is the source of truth for Hilla's prompts, config templates, safety policy, helper scripts, tests, and docs. OpenClaw runtime files are generated locally.

## Source Directories

- `agents/`: source prompts and standing orders.
- `config/`: JSON configuration templates used by render scripts and tests.
- `scripts/`: command-line helpers for config rendering, status, routines, Todoist, memory, Min Golf, and quiet ops.
- `scripts/lib/`: reusable helper modules with unit coverage.
- `tests/`: Node test suite.
- `docs/`: product, architecture, operations, security, setup, and Codex-facing guidance.

## Generated Runtime Directories

- `.openclaw/openclaw.json`: rendered config.
- `.openclaw/workspace-*`: generated per-agent workspaces.
- `.openclaw/agents/*`: generated OpenClaw agent directories.
- `.openclaw/state`: runtime state, including the Gateway's SQLite database (cron jobs and their run history), memories, weekly plans (`weekly-plan/`), and Telegram state.

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

## Safety Flow

`config/approval-policy.json`, `docs/security/approval-model.md`, and agent prompts should agree. Tests enforce important prompt and policy boundaries in:

- `tests/approval-policy.test.mjs`
- `tests/approval-language.test.mjs`
- `tests/agent-boundaries.test.mjs`
- `tests/inbox-action.test.mjs`
