# Approval Model

Hilla uses risk-tiered approval. The goal is to be useful without becoming reckless: read-only work should be frictionless, exact low-risk personal productivity work can run from an explicit user instruction, unclear work should ask one clarifying question, and risky work still needs Telegram approval.

Every approval prompt must say which agent is acting, what action is proposed, which target will change, what effect is expected, and what risk exists. The user can approve or deny. Both approved and denied attempts are logged with the approval prompt context so the decision can be reconstructed later. Denied actions are not retried unless the user asks again.

Approval wording is flexible but must be explicit and tied to a pending approval prompt. Short natural replies such as `approve`, `ok`, `that's ok`, `yes do it`, `go ahead`, `proceed`, `sounds good`, and `looks good` are allowed. Questions, hedges, and denials such as `maybe ok`, `probably`, `is that ok?`, `can you approve this?`, `no`, `stop`, and `cancel` are not approvals.

## Action Classes

Read-only actions do not need approval:

- Read configured local context.
- Summarize Gmail, Calendar, Todoist, routines, memory, or status.
- Analyze a supplied read-only Calendar event snapshot for planning; the helper must not fetch or mutate Calendar data.
- Search/read visible Min Golf availability without changing booking state.
- Draft replies, plans, task changes, calendar changes, grocery lists, and recommendations.
- Run local read-only diagnostics.

Low-risk direct actions do not need a second approval when the user explicitly asks, the target is exact, all critical fields are complete, the action affects only the user's own data, and it is easy to undo:

- Create a simple personal Todoist task from clear text.
- Build a preview for one simple personal Calendar event from typed complete details, without guests. This repository has no Calendar write tool, so the preview never creates an event.
- Store or forget one low-risk memory when explicitly requested.
- Make a low-risk change to one clearly identified personal Todoist task.
- Capture explicit local feedback in the local feedback log.

Clarification-needed actions should ask one concise clarifying question before execution or approval:

- The target is unclear, for example `change my tasks`, `move it`, or `update that`.
- There are multiple plausible Todoist, Calendar, Gmail, or reminder targets.
- A date, time, timezone, calendar, task, label, or content field is missing.
- The assistant would need to infer a critical field from context.

Approval-required actions need explicit Telegram approval before execution:

- Sending, deleting, archiving, labeling, or moving email.
- Calendar edits, deletes, invites, guests, or invite responses.
- Todoist deletes, reopens, moves, bulk edits, shared/project-wide changes, ambiguous changes, sensitive-content changes, unclear reference-derived targets, or inferred update content.
- Min Golf bookings or booking changes.
- Purchases, payments, financial actions, delivery orders, browser form submissions, account changes, and actions affecting other people.
- Sensitive memory writes or exports.

Hard stop actions must stop even after a vague approval and only continue after exact details are shown and approved, if the repo policy allows them at all:

- Payment, BankID, Swish, card entry, invoice, checkout, or financial transfer.
- Third-party booking/payment redirects, changed booking terms, or mismatched booking details.
- Browser submissions or account changes where the visible final state differs from what was approved.
- Extracting secrets or unrelated sensitive local data.

## Todoist Policy

No extra approval is needed when the user explicitly asks for a low-risk change to one clearly identified personal Todoist task. A screenshot or other reference can identify the target without creating an approval requirement, as long as exactly one personal Todoist task is resolved and the requested update is low-risk. Examples:

- Formatting cleanup.
- Wording cleanup.
- Adding detail to the description or comment.
- Appending or replacing a description when explicitly requested.
- Adding or removing a label.
- Changing a due date.
- Marking one personal task complete.
- Creating a simple personal task from clear text.

The assistant should execute the exact low-risk action and then briefly confirm what changed.

For screenshot/reference-derived Todoist cleanup, the safe implementation pattern is:

- Use the screenshot/reference only to identify exactly one personal Todoist task.
- Fetch or read the actual Todoist task content before editing.
- Reformat the fetched Todoist content, or apply content explicitly provided by the user.
- If the user asks to keep the content the same, do not add, remove, or reinterpret substantive content.
- Reply briefly after the update, for example: `Updated the Todoist task formatting. I kept the content the same and only cleaned up the description layout.`

Ask a clarifying question when the target is ambiguous, such as `change my tasks`, `clean up my Todoist tasks`, `update the task` with no exact match, or a screenshot/reference that contains multiple plausible tasks.

Telegram approval is still required for Todoist deletes, reopens, moves between projects/sections, bulk edits, shared/project-wide changes, sensitive content, inferred update content, or changes that affect other people.

## Standing Authorization: Weekly Plan

The user explicitly authorized one trusted routine on 2026-09-26. It is recorded as `trustedRoutines` → `weekly-plan` in `config/approval-policy.json` and enforced in code by `checkWeeklyPlanOperation` and a Todoist gateway that can only read open tasks and create tasks.

Hilla may create the user's own Todoist tasks from the latest weekly planning proposal without another approval, provided:

- the proposal was displayed to the user;
- the full 12-hour review window elapsed after its latest substantive revision, or the user explicitly accepted that displayed version (`OK`, `Looks good`, `Create it`, `Yes`, `Go ahead`);
- the proposal was not cancelled;
- execution is exactly the stored, displayed version, verified by digest;
- the actions only create the user's own Todoist tasks;
- no unrelated action is added.

The review window is 12 elapsed hours from the moment the latest version was shown, rounded up to the next 15-minute apply check. Each substantive change stores a new version and restarts the window. The Telegram message always states the local apply time in Europe/Stockholm. Around a DST change the window is still 12 real hours, so the local clock time can differ by an hour from a naive "+12".

This authorization does not permit deleting, completing, moving or editing existing Todoist tasks. It does not permit Calendar writes, Gmail writes, bookings, purchases, browser submissions, memory writes, arbitrary shell mutations, or creating anything that was not in the displayed proposal. The apply step never calls a model and never regenerates the plan. Everything else stays confirm-before-action.

## Feedback Capture

Explicit local feedback can be captured without a second approval. The feedback log is local-only and append-only at `.openclaw/state/feedback/feedback.jsonl`. Each entry contains only `timestamp`, `type`, `message`, and `source`.

The assistant must store only the feedback text the user explicitly provides. It must not attach, summarize, infer, or copy surrounding conversation content, including the preceding assistant response. Feedback capture must not write to memory, Todoist, Calendar, Gmail, routines, config, or agent prompts, and it must never send feedback externally.

Sensitive feedback is not stored. Ask the user to rephrase without private health, financial, or authentication details. Sending, sharing, emailing, or posting feedback externally requires explicit Telegram approval with a clear recipient and target.

## Calendar Creation Preview

`npm run calendar:create -- ... --dry-run` validates and normalizes one proposed Calendar event. It is a pure preview helper: it does not fetch Calendar data, call a Calendar API, create an event, edit an event, send email, invite guests, RSVP, book, purchase, or submit a browser form.

A policy-allowed preview is available only for one explicitly requested personal event with a clear title, `YYYY-MM-DD` date, start time, and duration or end time. It uses the primary personal Calendar and defaults the timezone to `Europe/Stockholm` only when no timezone was supplied. It must have no guests, recurrence, sensitive content, external impact, or existing-event mutation. The output must say that no event was created and that it is only ready for a future documented safe Calendar write tool.

Ask one clarifying question for missing or ambiguous title, date, start time, duration/end time, timezone, possible duplicate, or unclear guests. Telegram approval is required for guests/invitations/notifications, edits/deletes/moves, recurrence, multiple events, named non-primary or shared Calendars, sensitive or other-person impact, uncertain screenshot/OCR-derived substantive content, booking/payment, and browser activity.

## Inbox Action Classifier

The inbox action classifier is advisory. It decides whether a Telegram message should be handled as `execute_then_confirm`, `approval_required`, `clarify`, or `answer_only`, but it does not execute side effects.

Direct execution is allowed only for low-risk exact actions already allowed by this approval model. Calendar creation v1 is preview-only even when policy-allowed; it has no Calendar write path. Reference-derived exact Todoist targets may proceed for explicit low-risk Todoist updates; uncertain reference-derived non-Todoist substantive details, inferred critical fields, destructive actions, external-impact actions, and actions affecting other people remain approval-gated.

Telegram approval is still required when critical fields are inferred from image/OCR, any date/year/time/timezone/calendar/target is uncertain, the action is ambiguous, another person is affected, or sensitive memory/private health/finance data is involved. For Todoist, an exact screenshot/reference target is not by itself an inferred critical field.

Email sends, Calendar edits/deletes/invite responses, Todoist deletes/reopens/moves/bulk/shared/project-wide changes, Min Golf bookings or booking changes, payments, purchases, financial actions, browser submissions, destructive shell commands, and sensitive local data access remain approval-gated. Min Golf booking-assist must stop before payment, BankID, third-party redirects, changed terms, mismatched details, or unexpected account changes.
