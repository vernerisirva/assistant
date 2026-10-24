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

The weekly review is a decision check, not a recap. Example output shape:

```text
Weekly Review (personal)

Look at the coming week and what is still open from this one for:
- decision: A meaningful decision the user has not made yet.
- change: A new outside development, such as an email, a Calendar change or published news, that changes an existing plan.
- deadline: A deadline that needs a choice, not just doing a task already planned in Todoist.
- approval: An approval or essential missing information the user still owes.
- conflict: A real scheduling conflict or an unforeseen blocker.
- failure: A connection Hilla relies on that stopped working and needs the user to fix it, such as an expired sign-in.
- not-news: Leave out what is already planned in Todoist or the weekly plan, exercise lists, start times, tips, motivation, recaps, generic priorities, and alerts already sent.

Weekly review rules:
- At most 3 items, each as What changed, Why it matters and Decision needed, with a Deadline or Source when known. If nothing qualifies, say so in one line.
- Proposed actions only: Todoist or Calendar changes require confirmation.
- Do not modify Todoist, Calendar, Gmail, memory, or routines from the weekly review.
```

### Scheduled runs write only when something needs the user

The user follows Todoist directly, so a scheduled routine never repeats what is planned there. Its job runs the helper with `--scheduled`:

```bash
npm run --silent routine -- weekly-review --scheduled
```

That template, for any routine, looks only for the six kinds above (a decision, a change, a deadline that needs a choice, an approval or missing information, a conflict, a connection that stopped working and needs the user), in the routine's own window: today, the rest of today, this evening, tomorrow, or the coming week. The agent hands what it found to the notice and returns the notice's `text` as the job's final answer:

```bash
npm run --silent routine -- weekly-review --scheduled --findings-json-stdin <<'JSON'
{"items": [{"kind": "decision", "whatChanged": "…", "whyItMatters": "…", "decision": "…", "deadline": "2026-10-29", "source": "Gmail, 25 Oct"}]}
JSON
```

The notice writes each finding as `What changed`, `Why it matters` and `Decision needed`, then `Deadline` and `Source` when given, at most three findings. It drops, with the reason, a finding of another kind, one missing a part, a change without its source, a deadline item without a date, a deadline that is malformed or has passed, an exercise prescription such as `3 × 8`, and a question about Hilla's own messages. With nothing left the text is exactly `NO_REPLY`, which the Gateway's cron delivery never posts; the run history records such a run as `not-delivered`. A routine whose commands keep failing (after one fix of its JSON) is not silent: its final answer is one short line saying it could not run and why.

A routine the user asks for in chat is still the full briefing: `npm run routine -- workout-window` gives a complete session, and a weekly review asked for says in one line when nothing needs a decision.

### Where scheduled jobs live

The live OpenClaw Gateway scheduler is the only source of truth for scheduled jobs. OpenClaw 2026.7 keeps jobs, their run state and their history in the Gateway's SQLite state database. It imported the old `.openclaw/state/cron/jobs.json` once and renamed it `jobs.json.migrated`. Nothing reads that file any more, and editing it changes nothing.

`routines:*`, `quiet:*`, `assistant:status` and `weekly-plan -- status --jobs` all talk to the running Gateway through the supported CLI (`openclaw cron list|get|add|edit|enable|disable`). The first three go through one adapter, `scripts/lib/live-cron.mjs`. They use the Gateway's own OpenClaw: `OPENCLAW_CLI` if set, else `~/.openclaw/bin/openclaw`, else an `openclaw` on PATH that reports 2026.7.1 or newer. Inside an agent turn the Gateway sets `OPENCLAW_CLI=1` as a marker; that exact value names no command and is ignored. The CLI reads the Gateway token from the rendered config, so no token appears on a command line. The Gateway applies a change before the command returns, so none of these commands needs a Gateway restart. If the Gateway cannot be reached they say so. They never fall back to an old file.

Preview what an install would change, without changing anything:

```bash
npm run routines:plan
```

Install or update the scheduled Telegram check-ins:

```bash
npm run routines:install
```

The install is an upsert by exact job name, `Assistant routine: <id>`:

- a missing routine is added;
- an existing routine is edited in place, and only in the fields that differ from `config/schedules.json`;
- a routine that already matches is left alone, so a second install changes nothing.

Jobs with other names are never touched. If two live jobs share a routine's name, the install stops before changing anything. Afterwards it lists the jobs again and reports any routine that still differs and any other job that changed. By default only the Sunday weekly review is enabled. The morning brief, midday check-in, workout window and evening review are installed disabled, because the user follows the planned day in Todoist; each one still answers on request. An install switches a disabled routine off again, so turning one back on for good means changing `config/schedules.json`.

Review scheduled routine status:

```bash
npm run routines:status
```

It lists every live routine job with its next run, last run, last status and whether it is skipped today. It also names any configured routine that is not installed, or is installed twice.

Temporarily disable or re-enable one routine:

```bash
npm run routines:disable -- workout-window
npm run routines:enable -- workout-window
```

Change one routine time:

```bash
npm run routines:set-time -- morning-brief 08:30
```

These change only that one job, and the change is live immediately. Add `--dry-run` to see the job before and after without changing it. `set-time` keeps the job's days, timezone and stagger. A later `routines:install` sets time and enabled state back to `config/schedules.json`, so change the config to make a change permanent.

## Quiet Ops

Use quiet ops to inspect and control every live Gateway cron job, including ad hoc reminders, assistant routines and the weekly plan jobs:

```bash
npm run quiet:status -- --json
npm run quiet:audit -- --json
```

`quiet:status` lists all live jobs, enabled or not, with category, schedule, and next and last run state. `quiet:audit` flags:

- enabled jobs that fire at the same time;
- disabled installed jobs;
- upcoming one-shot reminders;
- the number of enabled daily recurring messages;
- any schedule kind quiet-ops does not understand. Such a job is shown as it is, never treated as cron or one-shot.

Mutations require an exact job id or exact job name. An ambiguous or unknown reference fails without changing anything:

```bash
npm run quiet:disable -- "Assistant routine: workout-window"
npm run quiet:enable -- "Assistant routine: workout-window"
npm run quiet:set-time -- "Assistant routine: midday-check-in" 13:15
npm run quiet:reschedule -- "Reminder: Renew gym card" 2026-06-19 09:00
```

Add `--dry-run` to see the job before and after without changing anything. A real mutation changes only the named field through `openclaw cron enable|disable|edit`:

- `set-time` changes only a cron job's minute and hour, and keeps its days, timezone and stagger;
- `reschedule` works only on one-shot jobs.

The change is live when the command returns, with no Gateway restart. Afterwards the command lists the jobs again and reports any other field or job that changed.

## Weekly Plan

The weekly plan is the one routine that creates Todoist tasks on its own, under a narrow standing authorization the user granted explicitly (see `docs/security/approval-model.md`).

Every Saturday at 09:00 Europe/Stockholm Hilla sends next week's (Monday-Sunday) complete plan for food, grocery shopping, gym, stretching and golf, and creates the resulting Todoist tasks after a 12-hour review window unless the plan is changed or cancelled. The plan never waits for golf answers: what the user hasn't said is a labelled default, and the review window starts when the plan has been shown.

How it works:

1. `Assistant weekly plan: propose` (Saturday 09:00, model-backed, personal agent) gathers read-only context: next week's Calendar load, non-sensitive memory, last week's plan. It passes that context as structured JSON to `npm run weekly-plan -- propose --send`. The job's message did not change when the plan stopped waiting for golf answers, so the installed job stays as it was.
2. The planner (`scripts/lib/weekly-plan.mjs` with `scripts/lib/golf-week.mjs`) builds the whole plan deterministically. It reads Todoist (with a short retry), picks activity counts from the agent's input, then last week's plan, then the config defaults, and builds the golf week (below) with its defaults: no playing days means every golf day is practice, never an invented round, and no focus means a balanced mix for competitive play. It then places gym, stretching and meal prep around the golf load, gives each meal-prep session a dish with a complete recipe (below), derives one grocery list from those recipes, and builds the exact Todoist payloads through the shared task pipeline. Existing Todoist tasks for the week count toward the targets and are never changed.
3. The plan is stored as v1, a `draft`, then sent. Only a send that reaches Telegram makes it `pending`, with a review deadline 12 elapsed hours later, rounded up to the next quarter-hour apply check. The message shows each day's golf session, gym session and mobility routine, the dishes and the grocery list, labels the defaults, and ends with up to two optional questions (which days the user plays, what to focus on), asked once, and when the tasks will be created if nobody replies.
4. Golf answers are changes like any other. The personal agent maps a reply to structured fields with the user's exact words as `replyText` and runs `npm run weekly-plan -- revise`. Every playing day, hole count, competition, lesson, focus area and time limit must be found in those words, in English, Swedish or Finnish; anything else is refused and nothing is stored. A partial answer changes only what it says: "Playing Wednesday and Saturday" keeps the default focus, "Focus on wedges and putting" keeps everything else. The first playing days or focus re-plan the practice around them, keeping any session the user moved. Shortcuts work: "Same playing days as last week", "Use my normal golf week" (a saved `golf/normal-week` memory), "No specific technical focus, choose the practice balance", "I won't play any full rounds next week", "No golf next week".
5. Any other change, such as "Move wedges to Thursday", "Move the rest day to Friday", "Saturday is now a competition", "Gym 3 times", "No salmon" or "Make recipes in Finnish", is a `revise` too. A revision stores a new version, shows it with its new deadline, and restarts the 12-hour window, for example from 20:30 Saturday to 08:30 Sunday. A change that alters nothing keeps the version and its deadline. Changes never touch Todoist.
6. An explicit "OK", "Looks good", "Create it", "Yes" or "Go ahead" to the displayed version applies it immediately. "Skip this week", "Cancel the weekly plan" or "Don't create these" cancels it, and a cancelled plan never applies.
7. `Assistant weekly plan: apply due plans` is a command job that runs every 15 minutes with no model. It runs `node scripts/weekly-plan.mjs apply-due` and prints `NO_REPLY` when nothing is due. When a pending plan's deadline has passed, it creates exactly the stored operations of the displayed version and sends a per-item summary.

When something fails, it stays visible and nothing unshown applies:

- If the Saturday send fails, the plan stays an unshown `draft`: it never applies, the job's reply says it couldn't be delivered, and the apply check sends it again after 15, 30 and 60 minutes, then every two hours, quietly, until its week ends. The window starts from the send that succeeds. A scheduled draft that no send ever touched (the job stopped in between) is sent the same way after ten minutes. `status` reports the tries and the next one.
- If Todoist can't be read when the plan is built, the plan says so instead of treating Todoist as empty. At the deadline the apply check reads Todoist anyway; if that week has gym, golf, stretching, cooking or grocery tasks the plan didn't account for, it creates nothing, says so once, and waits for an explicit OK, a change or a cancel. A revision of such a plan counts Todoist's tasks if it can read them then.
- A week that has already started (a late answer, or a plan asked for mid-week) plans only the days left, keeps a golf-free day in them and never catches up on missed golf days. When the window ends after the day the plan is shown, the message says that day's tasks are only created with an OK before it ends.
- If a plan file for the week can't be read, `propose` refuses to start a second plan beside it.
- An earlier week's undelivered draft, or a plan still waiting for an OK, is closed once its week is over and the next week's plan starts.

Plans stored before golf answers became optional may still be `awaiting_input`. `answer` builds such a week from the user's golf words with defaults for the rest; `propose --send` or `propose --reply` for that week (`--input-json '{"weekStart":"YYYY-MM-DD"}'`) builds it with defaults for everything unanswered. Both keep the stored answers, re-read Todoist, plan only days that haven't passed, and show the plan before its window starts. A legacy week still unanswered when the next week's plan starts is cancelled.

### The golf week

The golf part plans one week toward consistently good competitive golf:

- The user's rounds, competitions and lessons are fixed points, and golf tasks already in Todoist for the week count toward the golf days. Practice fills the other days up to six golf days (`golf.activeDays`), with one golf-free day: after a competition or full round, or on a heavy work day. The user can ask for fewer golf days in a week, never seven. Last week's rounds are never copied into a new week unless the user asks for the same playing days.
- Six golf days are not six hard days. A practice day is full, moderate or light: lighter next to a full round, two days before a competition, on a heavy work day, or with little time. Two or more full rounds cap all practice at moderate, three at light. The day before a competition is light competition preparation, with no technique changes.
- Practice follows a priority: the main focus gets most sessions, the second focus fewer, and the rest is upkeep, such as scoring under pressure, a 9-hole practice round when there are few rounds, or short game. A focus that has several sessions ends its last one with a measurable pressure test; the others end with a routine finish, so not every session is a test. Heavier development work goes early in the week. Without a focus the week is a balanced mix of wedges, putting, short game, long game, scoring and on-course play, every second session ending with a test.
- It plans training, not swing technique. A technical priority appears only in the user's or their coach's words; otherwise a range session says to work on the current priority from their lesson or coach.
- It uses the user's saved golf cue word and the names of their saved pre-round routine, bad-shot reset and competition routine, read only when the plan is built or its golf defaults are replaced in chat; the scheduled Saturday plan uses neutral wording. It never writes memory or playbooks, never reads weather, keeps no golf statistics, and sends no post-round messages.

### Food, gym and stretching

- Every meal-prep session cooks one dish from `config/food-planning.json`, where each dish is a complete recipe in Swedish and Finnish: portions, time, oven temperature and mode, every ingredient with its amount, numbered steps and storage advice. A session keeps its dish across revisions, so changing one meal changes only that session. A session is never planned without a complete recipe: with too few dishes left after exclusions, the plan has fewer sessions and says so.
- The recipe is scaled to the planned portions once (`scripts/lib/recipes.mjs`), and both the cooking task and the grocery list are built from that one scaled recipe, so their amounts always agree.
- The grocery list holds exactly what the planned dishes need, by store section, with oil, salt and spices last as basics to check at home, plus items the user explicitly added. Nothing else: no breakfast, snack or backup top-ups, and the Saturday run cannot add dishes, groceries or portions because no user chose them. A grocery the user adds must be named in the recipe language; an English name is refused so the agent translates it. A dish the user adds gets its own meal-prep session (meal prep +1 when none is free), never only groceries.
- Recipes are Swedish by default; Finnish when the user asks (`recipeLanguage`) or has a saved `food/recipe-language` memory. A recipe the user supplies must be complete and translated; the planner converts its lb, oz, cups, tbsp, tsp and °F to g, dl, msk, tsk and °C (volume stays volume), refuses text that still reads as English or imperial, and asks for any missing amount, unit or step instead of guessing.
- Gym sessions and 15-minute mobility routines are structured in `config/weekly-plan.json` (`scripts/lib/workouts.mjs` renders them): every exercise with sets × repetitions or time and rest, a warm-up, load as repetitions in reserve and the length; every movement with its hold time or repetitions per side and a cue. The day before a round or competition the gym day gets the session with less leg work, with a set less per leg exercise.

Todoist tasks: one per golf day, such as `Golf practice — Wedges 50–100 m`, `Golf — 18-hole round`, `Golf — Competition` or `Golf — Lesson`, with the whole session in the description (focus, timed blocks, mental focus, success criterion; a round's process objective and reset). Then `Gym – Helkropp A, måndag` (the whole session), `Rörlighet – Tisdag, 15 minuter` (the whole routine), one `Matlagning – Kyckling med ris och grönsaker` per cooked dish (the whole recipe), and one `Matinköp för veckan` task with the week's grocery list. Each task is due on its day. Plans shown before these formats keep the tasks they were shown with; a revision builds the new formats.

Idempotency and failures:

- Each operation has a stable id (`gym:2026-09-29`), a persisted outcome, and a deterministic Todoist request id. Finished operations are never repeated, even if the check fires twice or the gateway restarts.
- If the process stops mid-apply, the plan stays `applying`. The next check resumes it: an interrupted operation is re-checked against Todoist before it is attempted again.
- Tasks that already exist with the same title and date are recorded as `already_exists`, never duplicated. The same title on another date, such as last week's session, is a different task.
- Transient Todoist errors (429, 5xx, network) are retried at most twice, and Todoist is re-checked before each retry. Other errors are not retried.
- If some operations fail, the plan ends `applied_with_errors` and the summary lists each failed item. If none succeed, it ends `failed`. Neither is retried automatically. Operations whose date has already passed are recorded as `skipped_past_date` instead of creating overdue tasks.

Commands:

```bash
npm run --silent weekly-plan -- status            # pending? when? which version? applied? undelivered or waiting for an OK?
npm run --silent weekly-plan -- show              # the current plan text
npm run --silent weekly-plan -- propose           # preview only; stores nothing, never applies
npm run --silent weekly-plan -- revise --expect-version N --changes-json-stdin  # a change or golf answer (see the guide)
npm run --silent weekly-plan -- answer --input-json-stdin  # golf answers for a legacy awaiting_input week
npm run --silent weekly-plan -- guide             # the personal agent's weekly-plan guide, with the status
npm run --silent weekly-plan -- install --dry-run # preview the two Gateway cron jobs
npm run --silent weekly-plan -- install           # install or update them through the Gateway
npm run --silent weekly-plan -- status --jobs     # plan status plus installed job state
```

The two jobs are installed through the Gateway cron CLI, `openclaw cron add/edit`, like every other scheduled job (see "Where scheduled jobs live" above).

## Renewal Watch

`Assistant contracts: renewal watch` is one command job at 09:30 every day. It checks the dates of the contracts the user asked Hilla to watch and prints an alert, announced to Telegram, only when a contract reaches a milestone before its earliest action deadline. A model runs only at a contract's research point, as one isolated personal-agent turn the job starts and waits for. It never changes a contract and never creates Todoist tasks. Install it with `npm run --silent contracts -- watch-install` (after `--dry-run`); `docs/setup/contracts.md` has the design, the bounds and the self-test.

## Telegram Use

The personal agent should use the routine output as a briefing template, then gather live context from configured tools where appropriate: Calendar, Gmail, Todoist, memory, food planning, and health context. Scheduled cron jobs should return the final Telegram text only; they must not call Telegram or message-sending tools themselves because cron delivery sends the final answer.

The assistant may summarize, draft, recommend, and check in. Side effects still require Telegram approval. The morning brief is planning-only: it may propose Todoist or Calendar changes, but it must not execute them from the routine.

The assistant may run quiet-ops status and audit commands for questions like "what automatic messages are scheduled?" or "audit notification noise." Disabling, enabling, changing a time, or rescheduling a reminder is a side effect: the assistant must show the exact job id or exact job name and wait for Telegram approval before running the command.

Scheduled messages never ask about their own timing, tone or detail level; the user can ask for a change at any time. If the user's feedback looks like a stable preference, the assistant asks before storing it as memory.

## Unasked Messages

Todoist holds the planned work and its details, and the user follows it directly. Telegram is Hilla's attention and decision channel. A message the user did not ask for needs at least one of:

1. new material information;
2. a concrete decision the user has to make;
3. an approaching deadline the existing plan does not cover;
4. an approval, or essential missing information;
5. an unexpected failure that needs attention;
6. a scheduled planning proposal or a reminder the user asked for.

A task already planned in Todoist is not a reason. Hilla does not send "today is gym day", a session's exercises, a start time, water or kit tips, meal-prep nudges, motivation or productivity tips, or recaps; without a reason the answer is exactly `NO_REPLY`. New information about something that also has a task is still news: when a report the user plans to read changes the picture, the alert says what changed, not what the task says.

An unasked message reads `What changed`, `Why it matters`, `Decision needed`, then `Deadline` only when it is relevant and verified and `Source` for outside information, with no advice, encouragement or closing question. The Saturday weekly plan is the exception: it shows the exact stored plan, because what was shown is what applies. Stock and renewal alerts keep their own wording and their own once-only tracking.

The agent-facing copy of this policy is the `Unasked messages` section of `agents/personal/SOUL.md`, which OpenClaw puts in the personal agent's system prompt; the personal standing orders hold a one-line rule. Questions the user asks (what is in Todoist today, show my workout, remind me to train tonight, help me plan my day) are answered normally.

## Memory Boundary

Routines may suggest new memories from repeated patterns, but inferred memories must not be stored silently. The assistant should ask before storing inferred memories, and sensitive memories require Telegram approval.
