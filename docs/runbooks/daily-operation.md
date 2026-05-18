# Daily Operation Runbook

Run diagnostics:

```bash
npm run doctor
```

Render config after changing `.env` or `config/agents.json`:

```bash
npm run render:config
```

`config/schedules.json`, `config/approval-policy.json`, and `config/food-planning.json` are repository defaults for prompts, docs, and tests in this first skeleton. They are not wired into OpenClaw automation until a later implementation step.

Start the local OpenClaw gateway:

```bash
npm run start:openclaw
```

Planned/default routines to enable and verify after OpenClaw automation is configured:

- Morning brief at 08:00.
- Midday check-in at 12:30.
- Adaptive workout-window nudge between 16:00 and 19:00.
- Evening review at 21:00.
- Weekly review on Sunday at 19:00.

Starting the gateway alone does not prove these routines are running automatically in the first skeleton.

When the assistant proposes a side effect, approve it only if the action, target, expected effect, and risk are clear.
