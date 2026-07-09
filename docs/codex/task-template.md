# Codex Task Template

Use this template when asking Codex or another agent to change this repo.

```md
Goal:
Describe the concrete outcome.

Context:
- Relevant user preference or current behavior.
- Relevant files, docs, or commands.
- Whether runtime behavior may change.
- Any unrelated dirty or untracked files already present.

Scope:
- In scope:
- Out of scope:

Safety:
- Must not commit `.env`, `.openclaw/`, tokens, local state, logs, or generated private workspaces.
- Side effects such as email sends, Calendar edits, bookings, purchases, browser form submission, and state-changing shell commands require explicit approval unless they are clearly part of this repo-maintenance task.
- Preserve confirm-before-action unless the task explicitly changes the safety model.

Expected files:
- Create:
- Modify:
- Do not touch:

Checks:
- npm test
- npm run validate:env
- npm run render:config
- npm run doctor

Delivery:
- Summarize changes.
- List checks run and results.
- List any unclear areas or follow-up recommendations.
- State whether runtime behavior changed.
```
