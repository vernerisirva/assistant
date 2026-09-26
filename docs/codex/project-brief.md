# Codex Project Brief

## Purpose

Hilla is Verner's personal OpenClaw assistant, reached through Telegram. It should feel useful, practical, and personal: a quiet helper for logistics, planning, routines, health support, admin, and research.

The repo should stay easy for Codex and future agents to maintain. Prefer clear Markdown, focused scripts, tested helpers, and narrow prompt changes.

## Five-Minute Orientation

1. Start at root `AGENTS.md`.
2. Use `README.md` as the map of durable docs.
3. Check `git status --short` before editing.
4. Use `config/agents.json` to see which source prompt belongs to each agent.
5. Treat `.openclaw/` as generated private runtime output, not source.

## Current Agents

- `personal`: the only agent the user should feel they are talking to. Routes work to specialists and handles memory, routines, status, approvals, on-demand coaching, next-action recommendations and focus sessions, and concise Telegram replies.
- `admin`: Gmail, Calendar, Todoist, Min Golf tee-time search, reminders, logistics, meeting prep, and personal administration.
- `health`: workouts, food choices, meal planning, groceries, sleep consistency, movement, and routine support.
- `research`: source-backed lookup, comparisons, and planning support.

Agent prompts live in `agents/<agent>/AGENTS.md`. The rendered OpenClaw runtime copies them into `.openclaw/`.

## Agent Boundary Quick Reference

| Agent | Owns | Must Stop Before |
| --- | --- | --- |
| `personal` | Telegram-facing conversation, routing, memory/routine/status controls, approval flow, on-demand coaching, next-action recommendations and focus sessions | Direct risky side effects, unclear targets, specialist work that should be routed, turning a coaching idea or focus recommendation into a task, event or memory without the user's yes |
| `admin` | Gmail, Calendar, Todoist, reminders, Min Golf search, logistics, meeting/admin planning | Email mutations, risky Todoist changes, Calendar edits, bookings, payments, forms, account changes without approval |
| `health` | Workouts, food planning, groceries, sleep consistency, cravings, supportive routine design | Diagnosis, extreme dieting advice, medical treatment, purchases, Calendar/Todoist mutations without routed approval |
| `research` | Source-backed facts, comparisons, current lookup, planning support | Booking, buying, submitting forms, account changes, local file edits, uncited high-stakes claims |

Each agent prompt has an `Agent contract` section with purpose, primary responsibilities, allowed read-only actions, approval-required actions, hard stop points, and routing examples.

## Integrations

- Telegram for the main user interface.
- Gmail and Google Calendar setup through OpenClaw-compatible helpers.
- Todoist for tasks and commitments.
- Min Golf for read-only tee-time search and approval-gated booking assist.
- Local memory stored under `.openclaw/state/memory/`.
- OpenClaw cron jobs for scheduled routines and reminders.

Setup notes live in `docs/setup/`.

## Safety Model

Hilla starts from confirm-before-action. It may read configured context, summarize, draft, plan, recommend, and perform low-risk exact actions allowed by policy.

Explicit approval is required for email sends/mutations, Calendar edits/deletes/invites/responses, risky Todoist changes, Min Golf bookings or account changes, purchases, payments, browser form submissions, sensitive memory, actions affecting other people, and state-changing shell commands that are not clearly part of the user's repo-maintenance request.

One narrow standing authorization exists: the Saturday weekly plan may create the user's own Todoist tasks from its displayed, stored proposal after a 12-hour review window or an explicit OK. It never edits, completes, moves or deletes tasks, and never touches Calendar, Gmail, bookings, purchases or memory. See `docs/security/approval-model.md`.

Low-risk Todoist changes may proceed from an explicit user instruction when exactly one personal task target is clear, including when that exact target is resolved from a screenshot or reference. Examples include formatting cleanup, wording cleanup, adding detail, labels, due-date changes, and marking that one personal task complete. Ask a clarifying question for ambiguous targets, and require approval for deletes, reopens, moves, bulk edits, shared/project-wide changes, sensitive content, inferred update content, or changes affecting other people.

The authoritative policy sources are:

- `config/approval-policy.json`
- `docs/security/approval-model.md`
- `agents/*/AGENTS.md`

Keep those aligned and covered by tests.

## Development Priorities

1. Keep the assistant running reliably through Telegram.
2. Reduce unnecessary approval friction without weakening safety.
3. Make routines adaptive and quiet.
4. Improve Todoist, Calendar, reminder, and status workflows.
5. Keep docs, prompts, tests, and config easy for future agents to understand.

## Current Maintenance Rules

- Do not commit `.env`, `.openclaw/`, tokens, logs, private local state, or generated workspaces.
- Use `npm test` for the full suite.
- Use `npm run render:config` after prompt or config changes.
- Use `npm run doctor` for local setup checks.
- Preserve runtime behavior unless the task explicitly asks for behavior change.

## Run, Validate, Troubleshoot

- Full regression check: `npm test`.
- Environment check: `npm run validate:env`.
- Render generated OpenClaw config: `npm run render:config`.
- Local health check: `npm run doctor`.
- Runtime status: `npm run --silent assistant:status`.
- Routine status: `npm run routines:status`.
- Schedule/noise audit: `npm run quiet:audit -- --json`.
