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

Low-risk Todoist updates also do not need a second approval when one exact personal task is clear and the user explicitly asks for formatting cleanup, wording cleanup, adding detail, rename, append or replace a description/comment, change due date, add/remove labels, or marking that one task complete. A screenshot/reference-derived exact Todoist target is allowed for those low-risk updates. For formatting-only cleanup, use the screenshot/reference only to identify the task, fetch or read the actual Todoist task content, and reformat that fetched content without adding substantive content. Ask for clarification when the target is ambiguous. Ask for approval when non-Todoist details are inferred from image/OCR, Todoist update content is inferred rather than fetched or explicitly provided, dates or targets are uncertain, another person is affected, or the action deletes, reopens, moves, bulk edits, changes shared/project-wide tasks, sends, invites, books, pays, purchases, submits forms, or touches sensitive memory.

## Calendar Planning

Calendar planning v1 analyzes an explicit, normalized read-only event snapshot from the existing OpenClaw/Telegram Calendar context. It does not implement a Calendar API client or fetch events itself.

```bash
npm run calendar:plan -- today --events-json path/to/events.json
npm run calendar:plan -- week --events-json path/to/events.json --date 2026-07-09
```

Each event needs `title`, `start`, and `end` ISO timestamps; `location`, `calendar`, and `busy` are optional. The output summarizes calendar pressure, free blocks, meeting clusters, back-to-back risks, and focus/workout/admin windows. It is strictly read-only: no create, edit, delete, invite, RSVP, email, booking, or Calendar mutation is implemented. A possible focus block is only a proposal, for example: `Proposed change: block 14:00-15:00 for focused work. Ask me to create it if you want.`

## Local Feedback

Capture explicit local feedback without sending it anywhere:

```bash
npm run feedback -- add --type useful --message "That was useful"
npm run feedback -- add --type annoying --message "That was annoying"
npm run feedback -- add --type improvement --message "Morning brief was too long"
npm run feedback -- list
```

Feedback entries are append-only local runtime state at `.openclaw/state/feedback/feedback.jsonl`, which is ignored by Git. Each entry stores only timestamp, type, message, and source. Do not attach conversation context or the preceding assistant response. Sensitive feedback is not stored; ask the user to rephrase without private health, financial, or authentication details. Do not send feedback externally without explicit Telegram approval.

## Inbox Action Loop Checks

When the bot gives an unexpected approval prompt or acts too cautiously, check the intended handling path:

- `execute_then_confirm`: explicit low-risk action with complete details.
- `approval_required`: clear action that is risky, destructive, inferred, image/OCR-derived, or externally impactful.
- `clarify`: action-like message with missing critical details.
- `answer_only`: read-only question, status request, advice, or planning.

The classifier is deterministic and side-effect free; execution remains controlled by the relevant tool and approval policy.

Preview how Hilla would route and classify a Telegram message without taking action:

```bash
npm run inbox:debug -- "Can you book golf tomorrow morning?"
npm run inbox:debug -- --json "Send email to Anna saying I will be late"
npm run inbox:debug -- --source screenshot --exact-task-target --complete-details "Clean up the formatting of this Todoist task"
```

Preview or run exact Todoist updates after one task has been resolved:

```bash
npm run todoist -- exact-update --task-id TASK_ID --action format-description --dry-run
npm run todoist -- exact-update --task-id TASK_ID --action append-detail --detail "User-provided detail" --dry-run
npm run todoist -- exact-update --match-content "Gym workout" --action complete
```

If `--match-content` resolves multiple tasks, ask one clarifying question instead of editing.

Run a routine manually:

```bash
npm run routine -- morning-brief
npm run routine -- midday-check-in
npm run routine -- workout-window
npm run routine -- evening-review
npm run routine -- weekly-review
```

The morning brief is a short, read-only daily plan. It covers calendar pressure, up to three must-do tasks, quick wins, one health/routine anchor, one thing to avoid, a morning/midday/afternoon plan, and any useful Todoist or Calendar suggestions. Suggestions do not change Todoist or Calendar; a separate explicit user request must follow the approval policy.

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
