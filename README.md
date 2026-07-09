# Assistant

Local OpenClaw multi-agent assistant accessed through one Telegram bot.

## Start Here

- Agent/repo guide: `AGENTS.md`
- Product overview: `docs/product/overview.md`
- Product roadmap: `docs/product/roadmap.md`
- Product backlog: `docs/product/backlog.md`
- Project structure: `docs/architecture/project-structure.md`
- Daily operations: `docs/operations/daily-operation.md`
- Approval model: `docs/security/approval-model.md`
- Codex project brief: `docs/codex/project-brief.md`

## Common Checks

```bash
npm test
npm run validate:env
npm run render:config
npm run doctor
npm run inbox:debug -- "Can you book golf tomorrow morning?"
```

## Setup Docs

- Telegram: `docs/setup/telegram.md`
- Google: `docs/setup/google.md`
- Todoist: `docs/setup/todoist.md`
- Min Golf: `docs/setup/mingolf.md`
- Memory: `docs/setup/memory.md`
- Routines: `docs/setup/routines.md`

## Safety

Do not commit `.env`, `.openclaw/`, tokens, logs, local state, or generated private workspaces.

Hilla is confirm-before-action. Side effects such as sending email, Calendar edits, bookings, purchases, browser form submissions, risky Todoist changes, and sensitive memory require explicit approval unless the approval policy says the exact low-risk action is already allowed.
