# Daily Operation Runbook

Run diagnostics:

```bash
npm run doctor
```

Check assistant runtime and Telegram automation status:

```bash
npm run assistant:status
npm run --silent assistant:status -- --json
```

Use this before changing schedules or restarting the gateway. The command is read-only and redacts local secrets.

Render config after changing `.env` or `config/agents.json`:

```bash
npm run render:config
```

`config/schedules.json`, `config/approval-policy.json`, and `config/food-planning.json` are repository defaults for prompts, docs, and tests. Routines are available as helper commands through `npm run routine`, and scheduled Telegram check-ins can be installed with `npm run routines:install`.

Start the local OpenClaw gateway:

```bash
npm run start:openclaw
```

Planned/default routines to verify after OpenClaw automation is configured:

- Morning brief at 08:00, installed disabled by default.
- Midday check-in at 12:30.
- Adaptive workout-window nudge between 16:00 and 19:00.
- Evening review at 21:00, installed disabled by default.
- Weekly review on Sunday at 19:00.

Starting the gateway alone does not prove these routines are running automatically in the first skeleton.

When the assistant proposes a side effect, approve it only if the action, target, expected effect, and risk are clear. Natural approvals such as `approve`, `ok`, `that's ok`, `yes do it`, or `go ahead` are enough after a clear approval prompt.

Low-risk additive actions do not need a second approval when the user explicitly asks and all critical fields are complete and unambiguous. Examples: create a Calendar event from typed details, create a Todoist task from clear text, or remember a low-risk preference explicitly requested by the user.

Low-risk Todoist updates also do not need a second approval when the exact task is clear and the user explicitly asks to rename it, append or replace a description, change due date, or add/remove labels. Ask for approval when details are inferred from image/OCR, dates or targets are uncertain, another person is affected, or the action deletes, completes, reopens, moves, bulk edits, sends, invites, books, pays, purchases, submits forms, or touches sensitive memory.

## Inbox Action Loop Checks

When the bot gives an unexpected approval prompt or acts too cautiously, check the intended handling path:

- `execute_then_confirm`: explicit low-risk action with complete details.
- `approval_required`: clear action that is risky, destructive, inferred, image/OCR-derived, or externally impactful.
- `clarify`: action-like message with missing critical details.
- `answer_only`: read-only question, status request, advice, or planning.

The classifier is deterministic and side-effect free; execution remains controlled by the relevant tool and approval policy.

Run a routine manually:

```bash
npm run routine -- morning-brief
npm run routine -- midday-check-in
npm run routine -- workout-window
npm run routine -- evening-review
npm run routine -- weekly-review
```

Preview scheduled routine jobs:

```bash
npm run routines:plan
```

Review current scheduled routine status:

```bash
npm run routines:status
```

Inspect temporary routine-only skips:

```bash
npm run routines:skips
```

Skip or unskip one assistant routine for one Europe/Stockholm date. Replace `YYYY-MM-DD` with the intended local date:

```bash
npm run routines:skip -- workout-window YYYY-MM-DD
npm run routines:unskip -- workout-window YYYY-MM-DD
```

Routine skips do not disable future runs and do not affect one-shot reminders. Run `npm run routines:install` once to upsert skip-aware cron prompts; after that, changing `skips.json` does not require a gateway restart.

Review all automatic assistant messages and reminders:

```bash
npm run quiet:status -- --json
npm run quiet:audit
```

Install or update scheduled routine jobs:

```bash
npm run routines:install
npm run render:config
launchctl kickstart -k gui/501/ai.openclaw.gateway
```

The installer upserts jobs named `Assistant routine: ...` in `.openclaw/state/cron/jobs.json` and should not remove unrelated OpenClaw cron jobs. The gateway restart reloads the cron store.

Control one scheduled routine:

```bash
npm run routines:disable -- workout-window
npm run routines:enable -- workout-window
npm run routines:set-time -- morning-brief 08:30
npm run render:config
launchctl kickstart -k gui/501/ai.openclaw.gateway
```

Control any project-local OpenClaw cron or reminder job with an exact job id or exact job name:

```bash
npm run quiet:disable -- "Assistant routine: workout-window"
npm run quiet:enable -- "Assistant routine: workout-window"
npm run quiet:set-time -- "Assistant routine: midday-check-in" 13:15
npm run quiet:reschedule -- "Reminder: Renew gym card" 2026-06-19 09:00
launchctl kickstart -k gui/501/ai.openclaw.gateway
```

Use `--dry-run` before quiet-ops mutations when the target is not obvious. Quiet-ops mutations create timestamped backups beside `.openclaw/state/cron/jobs.json` and preserve unrelated job fields.
