# Repository Guide For Agents

## What This Project Is

This repository maintains Hilla, a local OpenClaw multi-agent assistant accessed through one Telegram bot. The repo stores agent standing orders, OpenClaw config templates, safety policy, helper scripts, tests, and operating documentation.

OpenClaw runtime output is generated locally under `.openclaw/`. Do not treat generated workspaces or local state as source files.

## First Five Minutes

For a new Codex agent, orient in this order:

1. Read this file.
2. Read `README.md` for the short map.
3. Read `docs/codex/project-brief.md` for Hilla's purpose, agents, integrations, and priorities.
4. Read `docs/architecture/project-structure.md` before moving files or changing config flow.
5. Read `docs/security/approval-model.md` before changing prompts, integrations, or side-effect behavior.
6. Run `git status --short` and identify unrelated local or untracked files before editing.

If the task is vague, ask one concise clarifying question before changing behavior. If the task is a documentation or structure cleanup, keep changes small and avoid runtime behavior changes.

## Checks

Use these commands before handing work back:

```bash
npm test
npm run validate:env
npm run render:config
npm run doctor
```

`npm test` also runs in GitHub Actions on every pull request targeting `main`
and on every push to `main`. That workflow is the deterministic gate; the env,
config, and doctor checks stay local because they need real runtime
configuration and must not be faked in CI.

Useful read-only runtime checks:

```bash
npm run --silent assistant:status
npm run routines:status
npm run quiet:status -- --json
```

Troubleshooting order:

1. `npm run doctor` for local setup and generated config health.
2. `npm run --silent assistant:status -- --include-logs --recent-hours 2` for Telegram/gateway/runtime issues.
3. `npm run routines:status` for scheduled routines.
4. `npm run quiet:audit -- --json` for notification-noise or duplicate-schedule questions.

Only run state-changing commands when the user asked for that change or explicitly approved it.

## Workflow For Substantial Changes

The owner is not a routine code-review gate. For a substantial change, run this
loop and only escalate when it genuinely needs a human decision:

1. Implement the smallest coherent change.
2. Run `npm test`.
3. Read your own complete diff.
4. Run `npm run review -- --base main --head HEAD` for an independent model review.
5. Fix legitimate blockers. Reject findings that are unsupported or that conflict
   with the stated objective, and record why.
6. Rerun the focused tests.
7. Review again only if the fixes were material.
8. Open a PR; CI runs `npm test`.
9. Merge when tests pass and no blocking findings remain.

Stop reviewing once deterministic gates are green and a review returns no
blockers. One review for a meaningful change, plus one more after material
fixes, is the normal ceiling.

Escalate to the owner for product ambiguity where different readings change
user-facing behavior, any change to a safety or approval boundary, credentials
or account authorization, meaningful spending, destructive or hard-to-reverse
actions, or a reviewer finding whose correct fix would change intended product
behavior. See `docs/setup/review.md` for setup and cost controls.

## Source Layout

- `agents/<agent>/AGENTS.md`: source standing orders for each OpenClaw agent.
- `agents/personal/SOUL.md`: personal agent tone/personality material.
- `config/agents.json`: agent registry, prompt directories, workspaces, and model env names.
- `config/approval-policy.json`: safety and approval policy source.
- `config/schedules.json`: routine schedule defaults.
- `config/food-planning.json`: food-planning defaults.
- `scripts/review.mjs`: independent model review harness.
- `scripts/`: local CLI helpers.
- `scripts/lib/`: tested helper modules.
- `tests/`: Node test suite.
- `docs/product/`: product-level purpose and user-facing intent.
- `docs/architecture/`: project structure and system design notes.
- `docs/operations/`: local runbooks and operational commands.
- `docs/security/`: approval and safety model.
- `docs/setup/`: integration setup notes.
- `docs/codex/`: Codex-facing project brief, task templates, review checklists, and planning artifacts.

## Runtime And Generated Files

Do not commit:

- `.env` or `.env.*`
- `.openclaw/`
- tokens, cookies, session files, chat ids, or raw logs with private data
- local state, generated agent workspaces, or private launchd/service env files

`.env.example` is the only env file intended for git.

## Safety Rules

Hilla is safety-first and confirm-before-action.

Allowed without extra approval:

- Read configured local context.
- Summarize, draft, plan, and recommend.
- Run safe read-only status or diagnostic commands.
- Execute low-risk exact actions already allowed by `config/approval-policy.json`.

Explicit approval is required for:

- Sending, deleting, archiving, labeling, or moving email.
- Editing, deleting, inviting guests to, or responding to Calendar events.
- Todoist delete, complete, reopen, project/section move, bulk edit, ambiguous target, or inferred change.
- Bookings, purchases, payments, browser form submission, check-in, cancellation, account changes, or actions affecting other people.
- Sensitive memory writes or exports.
- State-changing shell commands unless the user clearly requested the local repo maintenance action.

When an approval prompt is needed, include agent, action, target, expected effect, risk, and approval options.

## Development Style

- Prefer small, direct Markdown docs and clear scripts over new abstractions.
- Keep Hilla practical and personal; do not turn it into a generic enterprise platform.
- Preserve runtime behavior unless the task explicitly asks for behavior changes.
- When restructuring docs, prefer moving existing files and updating references over rewriting history.
- Follow existing Node ESM style and use `node:test` for code changes.
- Add or update tests when behavior, safety policy, prompt boundaries, or scripts change.
- Keep prompt edits narrow and test prompt expectations in `tests/agent-boundaries.test.mjs` when they define safety-critical behavior.
- Render config after prompt/config changes with `npm run render:config`.
- Do not stage unrelated untracked files without calling them out.

## Helpful Starting Points

- Product brief: `docs/codex/project-brief.md`
- Daily operations: `docs/operations/daily-operation.md`
- Approval model: `docs/security/approval-model.md`
- Codex task template: `docs/codex/task-template.md`
- Review checklist: `docs/codex/review-checklist.md`
