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

The installer upserts jobs named `Assistant routine: ...` in `.openclaw/state/cron/jobs.json` and leaves unrelated OpenClaw cron jobs alone. Restart the OpenClaw gateway after installing so the scheduler reloads the store.

## Telegram Use

The personal agent should use the routine output as a briefing template, then gather live context from configured tools where appropriate: Calendar, Gmail, Todoist, memory, food planning, and health context.

The assistant may summarize, draft, recommend, and check in. Side effects still require Telegram approval.

Scheduled check-ins should include a small feedback invitation about timing, tone, or detail level. If that feedback suggests a stable preference, the assistant must ask before storing it as memory.

## Memory Boundary

Routines may suggest new memories from repeated patterns, but inferred memories must not be stored silently. The assistant should ask before storing inferred memories, and sensitive memories require Telegram approval.
