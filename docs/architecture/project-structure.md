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
- `.openclaw/state`: runtime state, logs, cron store, memories, and Telegram state.

Generated runtime files are local and private. They are ignored by git and should not be committed.

## Config Flow

1. Source prompts live in `agents/<agent>/AGENTS.md`.
2. Agent registry lives in `config/agents.json`.
3. Local env values live in `.env`.
4. `npm run render:config` renders `.openclaw/openclaw.json` and generated prompt workspaces.
5. The OpenClaw gateway loads the rendered config.

## Safety Flow

`config/approval-policy.json`, `docs/security/approval-model.md`, and agent prompts should agree. Tests enforce important prompt and policy boundaries in:

- `tests/approval-policy.test.mjs`
- `tests/approval-language.test.mjs`
- `tests/agent-boundaries.test.mjs`
- `tests/inbox-action.test.mjs`
