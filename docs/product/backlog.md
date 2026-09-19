# Hilla Backlog

Backlog items are intentionally small. They should improve the current local assistant without adding new integrations or weakening approval boundaries.

Priority scale:

- `P0`: safety or reliability issue.
- `P1`: high daily usefulness.
- `P2`: useful refinement.
- `P3`: later polish.

## Stabilization

### 1. Inbox Classifier Debug Command

- Problem: The classifier exists as a tested helper, but there is no simple way to ask how Hilla would classify a Telegram message.
- User value: Faster debugging of approval friction, unclear routing, and "why did it ask me this?" moments.
- Affected agent(s): personal, admin.
- Safety risk: Low. It should be read-only and side-effect free.
- Approval requirement: None if it only prints classification.
- Suggested tests: CLI parsing tests; classification output tests for `execute_then_confirm`, `approval_required`, `clarify`, and `answer_only`.
- Rough priority: P1.

### 2. Telegram Status Answer Playbook

- Problem: Runtime status exists, but future agents can still answer status questions inconsistently.
- User value: Clear answers to "is it running?", "what is scheduled?", "what failed?", and "what will message me next?"
- Affected agent(s): personal.
- Safety risk: Low. Read-only status and summaries.
- Approval requirement: None for read-only status; approval required for any suggested mutation.
- Suggested tests: Agent-boundary prompt tests; assistant-status summary tests if formatting changes.
- Rough priority: P1.

### 3. Notification Noise Audit Refinement

- Problem: Quiet-ops can audit jobs, but outputs could better distinguish harmless disabled routines, duplicate jobs, and actionable noise.
- User value: Less notification fatigue and fewer accidental schedule changes.
- Affected agent(s): personal, admin.
- Safety risk: Low for read-only audit; medium for schedule mutations.
- Approval requirement: None for audit; explicit Telegram approval for disable/enable/time/reschedule.
- Suggested tests: `quiet-ops` audit tests for duplicate times, daily recurring counts, disabled jobs, and upcoming one-offs.
- Rough priority: P1.

### 4. Config/Prompt Drift Check

- Problem: Prompts, approval docs, and `config/approval-policy.json` can drift as small changes accumulate.
- User value: Safety rules stay coherent.
- Affected agent(s): personal, admin, health, research.
- Safety risk: Low. Test-only or lint-like check.
- Approval requirement: None for checks.
- Suggested tests: Extend `tests/agent-boundaries.test.mjs` and `tests/approval-policy.test.mjs` around any new invariant.
- Rough priority: P2.

## Daily Usefulness

### 5. Weekly Review Upgrade

- Problem: Weekly review exists, but can become more useful by connecting Calendar pressure, Todoist pressure, groceries, workouts, and admin follow-ups into one concise plan.
- User value: A useful Sunday planning message without adding more daily noise.
- Affected agent(s): personal, admin, health.
- Safety risk: Low if it only summarizes and suggests.
- Approval requirement: None for summaries/recommendations; approval required for creating tasks, changing schedules, or storing inferred memories outside existing low-risk policy.
- Suggested tests: Routine brief tests for weekly-review sections, sensitive-memory filtering, and one-action recommendation limits.
- Rough priority: P1.

### 6. Routine Feedback Loop

- Status: local feedback capture v1 is implemented for explicit useful, annoying, and improvement feedback.
- User value: Check-ins and workflows can be improved from explicit friction without silent memory creep or copied conversation context.
- Affected agent(s): personal, health.
- Safety risk: Low while feedback stays local, explicit, and separate from memory; sensitive content and external delivery remain blocked.
- Approval requirement: No extra approval for explicit four-field local feedback capture. External sharing requires approval; sensitive feedback must be rephrased.
- Suggested tests: Feedback log field/sensitivity tests; classifier tests for local capture vs external sharing.
- Rough priority: P2. Follow-up only: a manual feedback review flow, never automatic prompt/config changes.

### 7. Memory Review And Cleanup Flow

- Problem: Local preferences can become stale or too broad.
- User value: Hilla remembers useful things and forgets clutter.
- Affected agent(s): personal, health, admin.
- Safety risk: Medium around sensitive memory and accidental over-retention.
- Approval requirement: Low-risk explicit memory writes can proceed under policy; sensitive memory requires approval; inferred memory should ask first.
- Suggested tests: Memory list/forget tests; prompt tests for "do not silently remember".
- Rough priority: P2.

### 8. Todoist Exact Update UX

- Status: Task-creation formatting is done. One creation pipeline builds every payload, `--task-json` carries multiline descriptions safely, and `add` and exact updates share the same normalization. Remaining work is conversational wording around exact target, action, and confirmation.
- Problem: Low-risk exact Todoist updates are allowed, but the assistant needs consistently crisp wording around exact target, action, and confirmation.
- User value: Faster task cleanup with less approval noise.
- Affected agent(s): personal, admin.
- Safety risk: Medium if target matching is fuzzy or destructive actions slip through.
- Approval requirement: No second approval only for exact low-risk actions already allowed, including exact screenshot/reference Todoist targets for low-risk formatting/wording/detail updates; approval for delete/reopen/move/bulk/shared/project-wide/ambiguous/sensitive/inferred-content changes.
- Suggested tests: Todoist helper tests, inbox-action tests, agent-boundary tests for exact vs ambiguous targets.
- Rough priority: P1.

## Carefully Approved Side Effects

### 9. Calendar Creation From Typed Details

- Status: normalized Calendar creation preview is implemented; a real safe Calendar write tool is still intentionally absent.
- Problem: Hilla can now validate one simple event request, but cannot yet create it through a documented safe runtime path.
- User value: Clear, safe previews now; a future write tool can reuse the validated request.
- Affected agent(s): personal, admin.
- Safety risk: Medium. Wrong date/time/calendar creates real calendar noise.
- Approval requirement: A preview is policy-allowed only when explicitly requested, typed, complete, primary personal Calendar, no guests, no recurrence, and low-risk. Approval required for guests/invites, OCR/inferred substantive content, uncertainty, non-primary/shared Calendars, recurrence/multiple events, and all edits/deletes/invites/responses. The preview itself never creates an event.
- Suggested tests: Calendar preview builder tests; approval-policy tests; agent-boundary tests; safe write-tool contract tests before any runtime mutation.
- Rough priority: P2.

### 10. Gmail Mutation Guardrails

- Problem: Gmail can be summarized and draft responses can be discussed, but mutation flows need hard guardrails before any send/archive/delete/label/move support.
- User value: Safer future email assistance.
- Affected agent(s): admin, personal.
- Safety risk: High. Email actions are externally visible and hard to undo cleanly.
- Approval requirement: Explicit Telegram approval for every mutation.
- Suggested tests: Approval prompt builder tests before any mutation code; agent-boundary tests for no-send-without-approval.
- Rough priority: P3.

### 11. Min Golf Booking Assist Hardening

- Problem: Booking-request drafting exists, and non-payment booking assist is allowed only after exact approval, but it remains a high-risk flow.
- User value: Faster tee-time booking while stopping before payment/account surprises.
- Affected agent(s): admin, personal, research for read-only support.
- Safety risk: High around payment, BankID, mismatched terms, or changed booking details.
- Approval requirement: Explicit Telegram approval after exact final details; stop before payment, BankID, redirects, changed terms, or mismatch.
- Suggested tests: Min Golf booking-request tests for complete approval prompt; browser-plan tests for forbidden actions.
- Rough priority: P3.

## Research And Planning

### 12. Research Handoff Format

- Problem: Research can cite sources, but handoffs could be more consistent for decisions like nutrition lookup, product comparison, travel checks, and local errands.
- User value: Clearer factual summaries and fewer unsupported recommendations.
- Affected agent(s): research, personal, health, admin.
- Safety risk: Medium for medical/legal/financial/travel/purchase advice if sources are weak.
- Approval requirement: None for read-only research; approval for purchases, bookings, form submissions, or account changes.
- Suggested tests: Agent-boundary tests for citations and no side effects; no new integration required.
- Rough priority: P2.

## Do Not Build Yet

- Fully autonomous email sending or triage.
- Automatic Calendar rescheduling across multiple events.
- Payment, purchase, checkout, Swish, BankID, or financial actions.
- Autonomous browser operation on arbitrary sites.
- Silent memory learning from behavior.
- Multi-user or shared household workflows.
- A separate web dashboard or database for Hilla.
- New integrations beyond Telegram, Gmail/Calendar setup, Todoist, Min Golf, routines, memory, and research.
- Complex agent orchestration framework beyond the current personal/admin/health/research split.

## Top Candidate Sequence

1. Inbox classifier debug command.
2. Weekly review upgrade.
3. Todoist exact update UX.
