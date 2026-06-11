# Routines Setup

Routine Phase 1 generates memory-aware Telegram briefing templates. The helper reads:

- `config/schedules.json`
- `config/food-planning.json`
- `.openclaw/state/memory/preferences.json`

It does not send messages, create tasks, edit calendars, or perform side effects by itself.

Scheduled Routine Phase 1 installs OpenClaw cron jobs that send the routine check-ins through Telegram. The jobs use the same helper output and still keep every side effect behind approval.

## Commands

Morning brief:

```bash
npm run routine -- morning-brief
```

Midday health check-in:

```bash
npm run routine -- midday-check-in
```

Workout window:

```bash
npm run routine -- workout-window
```

Evening review:

```bash
npm run routine -- evening-review
```

Weekly review:

```bash
npm run routine -- weekly-review
```

Preview scheduled routine jobs without changing OpenClaw:

```bash
npm run routines:plan
```

Install or update the scheduled Telegram check-ins:

```bash
npm run routines:install
```

The installer upserts jobs named `Assistant routine: ...` in `.openclaw/state/cron/jobs.json` and leaves unrelated OpenClaw cron jobs alone. By default, midday check-in, workout-window, and weekly review are enabled; morning brief and evening review are installed disabled to keep automatic daily messages quieter. Restart the OpenClaw gateway after installing so the scheduler reloads the store.

Review scheduled routine status:

```bash
npm run routines:status
```

Temporarily disable or re-enable one routine:

```bash
npm run routines:disable -- workout-window
npm run routines:enable -- workout-window
```

Change one routine time:

```bash
npm run routines:set-time -- morning-brief 08:30
```

Restart the gateway after enable, disable, or set-time so the scheduler reloads the cron store.

## Quiet Ops

Use quiet ops to inspect and control every project-local OpenClaw cron or reminder job, including ad hoc reminders and assistant routines:

```bash
npm run quiet:status -- --json
npm run quiet:audit -- --json
```

`quiet:status` lists all installed jobs, enabled state, category, schedule, and available next/last run state. `quiet:audit` flags same-time enabled jobs, disabled installed jobs, upcoming one-shot reminders, and the enabled daily recurring message count.

Mutations require an exact job id or exact job name:

```bash
npm run quiet:disable -- "Assistant routine: workout-window"
npm run quiet:enable -- "Assistant routine: workout-window"
npm run quiet:set-time -- "Assistant routine: midday-check-in" 13:15
npm run quiet:reschedule -- "Reminder: Renew gym card" 2026-06-19 09:00
```

Add `--dry-run` to preview a mutation without writing. Mutating commands write `.openclaw/state/cron/jobs.json`, preserve the rest of each job, create a timestamped backup beside the store, and require an OpenClaw Gateway restart before the scheduler reloads the change.

## Telegram Use

The personal agent should use the routine output as a briefing template, then gather live context from configured tools where appropriate: Calendar, Gmail, Todoist, memory, food planning, and health context. Scheduled cron jobs should return the final Telegram text only; they must not call Telegram or message-sending tools themselves because cron delivery sends the final answer.

The assistant may summarize, draft, recommend, and check in. Side effects still require Telegram approval.

The assistant may run quiet-ops status and audit commands for questions like "what automatic messages are scheduled?" or "audit notification noise." Disabling, enabling, changing a time, or rescheduling a reminder is a side effect: the assistant must show the exact job id or exact job name and wait for Telegram approval before running the command.

Scheduled check-ins should include a small feedback invitation about timing, tone, or detail level. If that feedback suggests a stable preference, the assistant must ask before storing it as memory.

## Memory Boundary

Routines may suggest new memories from repeated patterns, but inferred memories must not be stored silently. The assistant should ask before storing inferred memories, and sensitive memories require Telegram approval.
