# Assistant Status Design

## Purpose

Give the Telegram-facing Personal agent one dependable, read-only way to answer questions like:

- Are you running?
- What automatic messages are active?
- Why did you message me?
- Are you too noisy?
- What can I safely change next?

The goal is trust and control before adding more autonomous power. The user should be able to ask from Telegram and get a concise status snapshot without inspecting logs or shell output.

## Current Context

The assistant runs as a local OpenClaw gateway accessed through one Telegram bot. The `personal` agent is the only normal Telegram-facing agent and routes work quietly to `admin`, `health`, and `research`.

Existing building blocks:

- `npm run doctor` verifies the local runtime, config, state directory, and required environment.
- `npm run quiet:status -- --json` reports automatic assistant messages, reminders, cron jobs, and scheduled jobs.
- `npm run quiet:audit -- --json` flags noisy or duplicated scheduled messaging patterns.
- `npm run routines:status` reports routine scheduling state.
- `.openclaw/state/logs/gateway.log` and `.openclaw/state/logs/gateway.err.log` contain recent gateway, Telegram, and diagnostic events.
- `.openclaw/state/telegram/` and `.openclaw/state/agents/main/sessions/` contain Telegram runtime state.

## Recommended Approach

Add one unified, read-only status command, exposed as an npm script such as:

```bash
npm run assistant:status -- --json
```

The Personal agent should call this command when the user asks about status, uptime, active automatic messages, noise, routines, Telegram health, or recent failures. The command should gather and normalize existing signals instead of duplicating each underlying subsystem.

This is preferred over prompt-only instructions because it creates one source of truth, and preferred over a full Telegram control dashboard because v1 should stay small and reliable.

## User Experience

Telegram responses should be concise, practical, and controllable. A typical response should include:

- Overall state: running, degraded, or needs attention.
- Telegram state: configured, recently active if known, or no recent activity found.
- Automatic messages: enabled routines and reminders, grouped by enabled and disabled.
- Recent activity: last scheduled assistant message or inbound Telegram event when available.
- Recent issues: only high-signal errors from recent logs, not noisy warnings.
- Safe next actions: exact commands the agent can run after approval, such as disabling or rescheduling a routine.

Example shape:

```text
Status: running
Telegram: provider started for @hilla_assistant_bot; last activity yesterday 20:05.
Automatic messages: midday check-in, workout window, weekly review enabled. Morning brief and evening review disabled.
Recent issues: no blocking errors found. One non-blocking update notice is present.
Controls: I can disable or change the time for an exact routine after approval.
```

The agent should not paste raw JSON into Telegram unless the user explicitly asks for details.

## Command Contract

The new status command should support:

- Human mode for CLI use.
- `--json` for agent use and tests.
- Optional `--recent-hours N`, defaulting to a reasonable recent window such as 24 hours.
- Optional `--include-logs` if detailed log snippets are needed.

The JSON output should be stable enough for tests and prompt use:

```json
{
  "overall": "running",
  "checks": [],
  "telegram": {},
  "automation": {},
  "recentActivity": {},
  "recentIssues": [],
  "suggestedActions": []
}
```

No secrets, tokens, chat IDs beyond already-local user-facing identifiers, or raw `.env` values should be printed.

## Architecture

Add a small aggregator module under `scripts/lib/assistant-status.mjs` and a CLI wrapper under `scripts/assistant-status.mjs`.

The aggregator should:

- Reuse existing project path and environment helpers from `scripts/lib/config.mjs` and `scripts/lib/env.mjs`.
- Reuse quiet-ops and cron-store helpers where practical.
- Read the rendered OpenClaw config only for non-secret status fields.
- Inspect recent gateway logs with simple, bounded parsing.
- Avoid network calls in v1 so the command stays fast and safe.

The Personal agent standing orders should gain a short "Status and control" section telling it when to call the command and how to summarize it for Telegram.

## Data Flow

1. User asks the Personal agent "are you alive?", "what is running?", or "why did you message me?"
2. Personal agent runs `npm run assistant:status -- --json`.
3. The CLI gathers local status from config, cron state, quiet-ops, routine status, Telegram state, and recent logs.
4. The CLI emits redacted structured JSON.
5. Personal agent summarizes the snapshot in Telegram-friendly language.
6. If the user asks to change a job, the existing quiet-ops approval flow handles mutations.

## Error Handling

The command should degrade gracefully:

- Missing log files should produce a warning item, not a crash.
- Missing cron state should report no installed jobs or unknown automation state.
- Malformed JSON state should be reported as a recent issue with the affected path.
- Failed sub-checks should be included in `checks` and should influence `overall`.
- Secrets should be redacted even in errors.

Suggested overall states:

- `running`: gateway appears active and no blocking issues are detected.
- `degraded`: gateway or Telegram state is uncertain, or recent non-fatal errors are present.
- `needs_attention`: core config, environment, or gateway checks fail.

## Testing

Add focused tests for:

- Status output with fixture config, cron state, and logs.
- Secret redaction.
- Missing optional files.
- Malformed state files.
- Enabled and disabled routine summaries.
- Recent error filtering.

Existing tests should continue to pass with `npm test`.

## Rollout

Implement read-only status first. Do not add Telegram buttons or state-changing controls in this phase.

After implementation:

1. Run unit tests.
2. Run `npm run assistant:status -- --json`.
3. Ask the live Telegram agent "what is running?" and verify that it produces a concise summary.
4. Keep the existing approval flow for disable, enable, reschedule, and time changes.

## Non-Goals

This design does not add autonomous actions, automatic restarts, email or calendar writes, Telegram button dashboards, or new external services. It should not increase the assistant's side-effect permissions.
