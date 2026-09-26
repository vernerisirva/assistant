# Hilla Roadmap

Hilla should stay a practical local assistant: one Telegram front door, clear specialist agents, small tested scripts, and explicit approval before risky side effects.

This roadmap describes what to build next without adding new integrations or changing runtime behavior by itself.

## Current Baseline

Hilla currently has:

- One Telegram-facing personal assistant with hidden specialist agents.
- Agent prompts for `personal`, `admin`, `health`, and `research`.
- Risk-tiered approval policy and natural approval language tests.
- Local OpenClaw config rendering from `.env`, `config/*.json`, and `agents/*/AGENTS.md`.
- Status, doctor, config-render, and env-validation commands.
- Todoist helper for projects, task reads, task completion, and one normalized task-creation pipeline with a shell-safe structured `--task-json-stdin` interface for multiline descriptions.
- Min Golf read-only search planning and approval-gated booking-request drafting.
- Memory helper for explicit local preferences and sensitive-memory approval flow.
- Routine helpers for morning brief, midday check-in, workout window, evening review, weekly review, routine skips, and scheduled routine cron jobs.
- Quiet-ops helpers for inspecting, auditing, enabling/disabling, and rescheduling local OpenClaw cron/reminder jobs.
- Weekly plan automation: a Saturday proposal for food, shopping, gym, stretching, golf and golf practice. Natural Telegram changes create new versions. The displayed version's Todoist tasks are created after a 12-hour review window under a narrow standing authorization. This is the only automation that writes on its own; the user wants to try this level before anything more is added.
- Research agent instructions for source-backed lookup and comparisons.
- On-demand coaching v1 in the personal agent: quick reset, in-performance, pre-performance, debrief, and sleep coaching for golf, work, and sleep habits. It is conversation only, with no schedule, and playbook memory is stored only when the user sets it explicitly.
- Focus and next action v1: "What should I do now?" gives one recommendation from fresh context, and a focus session keeps one disposable local record of the block's task facts. No timers, no scheduled prompts, and no Todoist or Calendar side effects.
- Personal playbooks v1: the user's own routines (resets, pre-round, meeting prep, wind-down) in the existing memory store, saved or changed only with the user's explicit words and used before inventing a new technique. Debriefs end with Keep, Adjust, and a possible lesson that is saved only after a yes.
- Pending actions v1: one read-only view of what Hilla is waiting on (a weekly plan awaiting review, a running focus session), built from stored state. Unreadable sources are reported, and nothing is inferred from conversation.

## Phase 1: Stabilize Current Assistant

Focus: make the existing assistant easier to operate, debug, and trust.

- Add a small CLI/debug command around the existing inbox action classifier.
- Tighten status answers so "what is running?", "why did I get this?", and "what will message me next?" are consistently easy to answer.
- Keep notification-noise audits simple and actionable.
- Keep docs and prompts aligned with `config/approval-policy.json`.
- Improve test coverage only where it protects safety, routing, or operational clarity.

Success looks like:

- A new Codex agent can diagnose runtime state without reading logs manually.
- Hilla can explain scheduled routines and reminders clearly.
- Approval boundaries remain boringly predictable.

## Phase 2: Improve Daily Usefulness

Focus: make existing routines and task flows more helpful without adding risk.

- Tune routine prompts based on ignored/used check-ins, but do not silently store inferred preferences.
- Improve weekly review output so it connects Calendar pressure, Todoist pressure, groceries, workouts, and admin follow-ups.
- Make Todoist read/update flows easier for exact low-risk task changes. Creation formatting is done; conversational target/confirmation wording is the remaining part.
- Improve memory review and cleanup so preferences stay useful and small.
- Add better research handoffs for nutrition lookup, product/travel comparisons, and local errands while preserving citations.

Success looks like:

- Daily messages feel timely rather than noisy.
- Weekly review creates a small set of useful next actions.
- Todoist and memory stay useful rather than becoming clutter.

## Phase 3: Add Carefully Approved Side Effects

Focus: allow more useful actions only where the approval model is clear and tests protect the boundary.

- A documented safe Calendar write tool that can consume the already implemented creation preview, staying separate from Calendar edits/deletes/invites.
- Todoist exact low-risk updates that are already allowed by policy.
- Approval-gated quiet-ops changes with exact job ids/names.
- Approval-gated Min Golf non-payment booking assist only when the visible final booking matches approved details.
- Approval-gated Gmail drafts or mutations only after the existing Google setup path is safe and documented.

Success looks like:

- Low-risk exact actions are quick.
- Higher-risk actions produce compact, specific approval prompts.
- Hilla stops before payment, account changes, unclear targets, inferred data, and external impact.

## Later Ideas / Not Now

These are tempting but should wait because they add complexity or risk.

- Fully autonomous email triage or sending.
- Broad Calendar editing, invite handling, or automatic rescheduling.
- Payment, purchase, checkout, BankID, Swish, or financial workflows.
- Autonomous browser operation across arbitrary websites.
- Multi-user or shared-family agent workflows.
- Large database, dashboard, or web app around Hilla.
- Silent memory learning from behavior.
- Proactive coaching. A later explicit opt-in could offer a short setup on a golf day (`You have golf today. Want a 60-second mental setup?`) by reusing the pre-performance mode. Only after the on-demand version has been tried; no mood tracking or profiling either way.
- New integrations not already represented in repo docs/scripts.

## Roadmap Principles

- Prefer one small improvement that helps tomorrow over a broad platform feature.
- Add tests before changing behavior.
- Keep the personal agent as the only visible Telegram personality.
- Keep specialist agents boring and bounded.
- Never weaken confirm-before-action to reduce friction.
