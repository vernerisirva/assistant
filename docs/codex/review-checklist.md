# Review Checklist

Use this before committing or handing work back.

## Scope

- The change matches the user request.
- Runtime behavior is unchanged unless explicitly requested.
- No unrelated refactors or formatting churn.
- Untracked files are either intentionally included or explicitly left alone.
- A new Codex agent can identify the purpose, source files, checks, and safety boundaries from `README.md`, `AGENTS.md`, and `docs/codex/project-brief.md`.

## Safety

- No `.env`, `.env.*`, `.openclaw/`, tokens, logs, local state, generated workspaces, or private service env files are staged.
- Approval policy remains intact for email, Calendar edits, Todoist risky changes, bookings, purchases, payments, browser submissions, sensitive memory, and actions affecting other people.
- Agent prompt changes do not weaken confirm-before-action boundaries.

## Maintainability

- Docs are in the right folder:
  - `docs/product`
  - `docs/architecture`
  - `docs/operations`
  - `docs/security`
  - `docs/setup`
  - `docs/codex`
- Root `README.md` stays concise.
- Root `AGENTS.md` remains the operational guide for future agents.
- Scripts stay simple and testable.

## Verification

Run the safe local checks that apply:

```bash
npm test
npm run validate:env
npm run render:config
npm run doctor
```

For prompt/config changes, `npm run render:config` should be included unless local env is unavailable.

## Handoff

Report:

- Files changed.
- Checks run and whether they passed.
- Any commands not run and why.
- Any unclear areas.
- Whether `.env`, `.openclaw/`, generated workspaces, logs, and local state stayed out of git.
