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

Example morning brief output shape:

```text
Morning Brief (personal)

Cover:
- calendar-pressure: Flag only conflicts, deadlines, or tight transitions.
- must-do-tasks: List up to 3 tasks that matter today.
- quick-wins: List 1-2 small actions that reduce friction.
- health-routine-anchor: Choose one realistic food, movement, sleep, or recovery anchor.
- one-thing-to-avoid: Name one preventable source of friction.
- suggested-day-plan: Give a simple morning, midday, and afternoon plan.
- proposed-changes: Suggest a Todoist or Calendar change only when useful.

Morning brief rules:
- Read and summarize configured context only.
- Proposed Todoist or Calendar changes require a separate explicit user action.
- Do not modify Todoist, Calendar, Gmail, memory, or routines from the morning brief.
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

Example weekly review output shape:

```text
Weekly Review (personal)

Cover:
- week-recap: Summarize 1-2 important things that happened this week.
- unfinished-tasks: List 1-2 unfinished Todoist/admin threads.
- calendar-pressure: Flag 1-2 upcoming Calendar pressure points.
- health-routines: Summarize workouts, golf, sleep, food, and groceries.
- important-decisions: Name 1-2 decisions to make.
- top-3-priorities: Choose the top 3 priorities for next week.
- stop-or-simplify: Choose one thing to stop, simplify, defer, or make easier.

Weekly review rules:
- Proposed actions only: Todoist or Calendar changes require confirmation.
- Do not modify Todoist, Calendar, Gmail, memory, or routines from the weekly review.
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

## Weekly Plan

The weekly plan is the one routine that creates Todoist tasks on its own, under a narrow standing authorization the user granted explicitly (see `docs/security/approval-model.md`).

Every Saturday at 09:00 Europe/Stockholm Hilla proposes next week's (Monday-Sunday) plan for food, grocery shopping, gym, stretching, golf rounds and golf practice, sends it to Telegram, and creates the resulting Todoist tasks after a 12-hour review window unless the plan is changed or cancelled.

How it works:

1. `Assistant weekly plan: propose` (Saturday 09:00, model-backed, personal agent) gathers read-only context: next week's Calendar load, non-sensitive memory, last week's plan. It passes that context as structured JSON to `npm run weekly-plan -- propose --send`. It does not run a questionnaire.
2. The planner (`scripts/lib/weekly-plan.mjs`) is deterministic. It picks activity counts from the agent's input, then last week's plan, then `config/weekly-plan.json` defaults. It places activities around busy days, treats golf as physical load, spreads gym and meal prep, fills meals from the catalog in `config/food-planning.json`, derives one grocery list from those meals, and builds the exact Todoist payloads through the shared task pipeline. Existing Todoist tasks for the week count toward the targets and are never changed.
3. The plan is written to `.openclaw/state/weekly-plan/plans/<planId>.json` as a `draft` before it is sent. Only after Telegram confirms the send does it become `pending`, with a review deadline 12 elapsed hours later, rounded up to the next quarter-hour apply check. If the send fails, it stays a draft and never applies.
4. Replies in Telegram go to the personal agent. A change such as "Gym 3 times", "Move Friday gym to Sunday", "No salmon" or "Add bananas" becomes a structured `revise`. That stores a new version, shows it with its new deadline, and restarts the 12-hour window, for example from 20:30 Saturday to 08:30 Sunday. Changes never touch Todoist.
5. An explicit "OK", "Looks good", "Create it", "Yes" or "Go ahead" to the displayed version applies it immediately. "Skip this week", "Cancel the weekly plan" or "Don't create these" cancels it, and a cancelled plan never applies.
6. `Assistant weekly plan: apply due plans` is a command job that runs every 15 minutes with no model. It runs `node scripts/weekly-plan.mjs apply-due` and prints `NO_REPLY` when nothing is due. When a pending plan's deadline has passed, it creates exactly the stored operations of the displayed version and sends a per-item summary.

Todoist tasks: `Gym — Tuesday`, `Golf round — Sunday`, `Golf practice — Thursday`, `Stretch — Monday` (15 min with concrete movements), `Meal prep — Tuesday`, plus one `Grocery shopping for next week` task whose description is the grouped list for the latest food plan. Each task is due on its day.

Idempotency and failures:

- Each operation has a stable id (`gym:2026-09-29`), a persisted outcome, and a deterministic Todoist request id. Finished operations are never repeated, even if the check fires twice or the gateway restarts.
- If the process stops mid-apply, the plan stays `applying`. The next check resumes it: an interrupted operation is re-checked against Todoist before it is attempted again.
- Tasks that already exist with the same title and date are recorded as `already_exists`, never duplicated. The same title on another date, such as last week's session, is a different task.
- Transient Todoist errors (429, 5xx, network) are retried at most twice, and Todoist is re-checked before each retry. Other errors are not retried.
- If some operations fail, the plan ends `applied_with_errors` and the summary lists each failed item. If none succeed, it ends `failed`. Neither is retried automatically. Operations whose date has already passed are recorded as `skipped_past_date` instead of creating overdue tasks.

Commands:

```bash
npm run --silent weekly-plan -- status            # pending? when? which version? applied?
npm run --silent weekly-plan -- show              # the current plan text
npm run --silent weekly-plan -- propose           # preview only; stores nothing, never applies
npm run --silent weekly-plan -- install --dry-run # preview the two Gateway cron jobs
npm run --silent weekly-plan -- install           # install or update them through the Gateway
npm run --silent weekly-plan -- status --jobs     # plan status plus installed job state
```

The two jobs are installed through the Gateway cron CLI, `openclaw cron add/edit`, because the Gateway keeps its own cron store. `routines:install` and the quiet-ops mutations still edit the old `cron/jobs.json`, which this OpenClaw version no longer reads.

## Telegram Use

The personal agent should use the routine output as a briefing template, then gather live context from configured tools where appropriate: Calendar, Gmail, Todoist, memory, food planning, and health context. Scheduled cron jobs should return the final Telegram text only; they must not call Telegram or message-sending tools themselves because cron delivery sends the final answer.

The assistant may summarize, draft, recommend, and check in. Side effects still require Telegram approval. The morning brief is planning-only: it may propose Todoist or Calendar changes, but it must not execute them from the routine.

The assistant may run quiet-ops status and audit commands for questions like "what automatic messages are scheduled?" or "audit notification noise." Disabling, enabling, changing a time, or rescheduling a reminder is a side effect: the assistant must show the exact job id or exact job name and wait for Telegram approval before running the command.

Scheduled check-ins should include a small feedback invitation about timing, tone, or detail level. If that feedback suggests a stable preference, the assistant must ask before storing it as memory.

## Memory Boundary

Routines may suggest new memories from repeated patterns, but inferred memories must not be stored silently. The assistant should ask before storing inferred memories, and sensitive memories require Telegram approval.
