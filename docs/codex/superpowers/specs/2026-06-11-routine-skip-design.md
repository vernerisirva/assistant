# Routine Skip Design

Date: 2026-06-11

## Purpose

Add a safe, temporary way to skip one assistant routine for one local day without disabling the recurring scheduler job. The motivating case is skipping `workout-window` today after Verneri says he is not working out, while keeping future workout-window check-ins enabled.

## Scope

V1 supports assistant routines only:

- `morning-brief`
- `midday-check-in`
- `workout-window`
- `evening-review`
- `weekly-review`

V1 does not suppress one-shot reminders, golf reminders, AGM reminders, gym card reminders, or arbitrary cron jobs.

## User Flow

The Personal agent may propose a skip when the user says a routine is not relevant for a day. It must ask for Telegram approval before writing skip state.

Example approval prompt:

```text
Agent: personal
Action: skip assistant routine
Target: workout-window on 2026-06-11
Expected effect: today's workout-window scheduled message will not be sent; future workout-window messages remain enabled.
Risk: you may miss one check-in today.
Approval options: approve / cancel
```

After approval, the agent runs:

```bash
npm run routines:skip -- workout-window 2026-06-11
```

Users can inspect or undo skips:

```bash
npm run routines:skips
npm run routines:unskip -- workout-window 2026-06-11
```

## Storage

Store skip state at:

```text
.openclaw/state/routines/skips.json
```

Shape:

```json
{
  "version": 1,
  "skips": [
    {
      "routineId": "workout-window",
      "date": "2026-06-11",
      "timezone": "Europe/Stockholm",
      "createdAt": "2026-06-11T09:30:00.000Z",
      "source": "telegram"
    }
  ]
}
```

The key is `(routineId, date, timezone)`. Adding the same skip again is idempotent. Removing a skip that does not exist returns a clear no-op result.

Writes create timestamped backups beside `skips.json` when the file already exists.

## Scheduled Run Behavior

Each scheduled routine prompt should first check the skip store for its routine id and the current local date in `Europe/Stockholm`.

If skipped, the scheduled run final answer must be exactly:

```text
NO_REPLY
```

If not skipped, the routine follows the existing behavior: run `npm run routine -- ROUTINE_ID`, gather relevant context, and produce the normal Telegram check-in.

The skip check must be read-only during scheduled runs.

## Status Behavior

`npm run routines:status` and `npm run assistant:status -- --json` should include skip state for routines. A routine enabled in cron but skipped for the current local date should be reported as enabled and skipped today, rather than disabled.

Human summaries should phrase this as:

```text
workout-window enabled, skipped today
```

JSON status should include enough structure for Telegram summaries:

```json
{
  "routineId": "workout-window",
  "enabled": true,
  "skippedToday": true,
  "skipDate": "2026-06-11"
}
```

## CLI Commands

Add commands to the existing routines CLI:

```bash
npm run routines:skip -- ROUTINE_ID YYYY-MM-DD
npm run routines:unskip -- ROUTINE_ID YYYY-MM-DD
npm run routines:skips
```

Rules:

- Routine id must be one of the configured routine ids.
- Date must be `YYYY-MM-DD`.
- Timezone defaults to `Europe/Stockholm`.
- `skip` and `unskip` support `--dry-run`.
- Mutations report whether a restart is required. Skip file changes do not require a gateway restart after the scheduled prompts have been updated once.

## Agent Prompt Updates

Personal standing orders should explain:

- Read-only skip inspection is allowed without extra approval.
- Applying or removing a skip requires Telegram approval.
- Skips are temporary and routine-only.
- Disabling a routine remains the correct action for recurring changes.

Scheduled routine cron prompts should explain:

- Check skip state before doing routine work.
- Return exactly `NO_REPLY` if skipped.
- Do not send Telegram/message tools directly.

## Error Handling

Malformed `skips.json` should not crash status commands. Status should report a degraded warning and continue with no active skips.

Malformed `skips.json` should block mutations with a clear error so the user does not overwrite unknown state accidentally.

Invalid routine ids and invalid dates should be rejected before writing.

## Testing

Add focused tests for:

- Adding a skip is idempotent.
- Removing a skip works and missing removals are no-op.
- Invalid routine ids and dates are rejected.
- `routines:status` marks enabled routines as `skippedToday`.
- `assistant:status` includes routine skip state.
- Scheduled routine prompt text includes the skip check and `NO_REPLY` behavior.
- Malformed skip state degrades status but blocks writes.

## Rollout

Implementation should be small and staged:

1. Add skip store helpers and tests.
2. Add routines CLI commands.
3. Thread skip state into routine status and assistant status.
4. Update Personal and scheduled routine prompts.
5. Render OpenClaw config and restart the gateway once.
6. Smoke test by skipping `workout-window` for today and asking Telegram for status.
