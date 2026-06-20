# Inbox Action Classifier Design

## Goal

Make the Telegram assistant more action-oriented by routing each incoming request into a clear handling path: execute a low-risk action, ask for approval, ask one clarifying question, or answer normally.

The first version should improve reliability without building a large workflow engine. It should be conservative when uncertain and preserve the existing approval model.

## Current Context

The assistant already has:

- A Telegram-facing personal agent that routes to admin, health, and research agents.
- A risk-tiered approval policy for low-risk additive actions.
- Todoist tooling for reading, creating, and completing tasks.
- Routine, memory, status, quiet-ops, and approval-language helpers.
- Tests that enforce agent boundaries and approval-policy behavior.

Recent work relaxed approvals for exact low-risk Todoist updates. The next bottleneck is deciding what kind of action a Telegram message is asking for.

## Recommended Approach

Add a structured action classifier in `scripts/lib/inbox-action.mjs`, covered by `tests/inbox-action.test.mjs`.

The classifier should not perform side effects. It should classify a message into a decision object that downstream agent instructions and future tooling can use.

Example decision:

```json
{
  "intent": "todoist.update",
  "risk": "low",
  "mode": "execute_then_confirm",
  "approvalRequired": false,
  "reason": "Exact task target and explicit update instruction"
}
```

## Decision Modes

The classifier returns one of four modes:

- `execute_then_confirm`: The request is explicit, complete, low-risk, and already allowed by policy.
- `approval_required`: The request is clear but requires approval before execution.
- `clarify`: The request is action-like but missing a target, date, time, calendar, task, or other critical detail.
- `answer_only`: The request is a question, status check, advice request, or other non-mutating interaction.

## Intent Categories

Initial categories:

- `todoist.create`
- `todoist.update`
- `reminder.create`
- `calendar.create`
- `status.query`
- `advice.query`
- `approval.response`
- `clarify`
- `no_action`

The first implementation should focus on deciding the correct handling path, not fully extracting every field needed to execute every integration.

## Direct Execution Rules

The classifier may return `execute_then_confirm` only when all critical details are explicit and complete.

Allowed low-risk direct paths:

- Create a Todoist task from typed, complete details.
- Rename a clearly identified Todoist task.
- Append a Todoist task description or comment when the exact task is clear.
- Replace a Todoist task description when the user explicitly asks to replace or update the description.
- Change a Todoist due date when the exact task and new date are clear.
- Add or remove Todoist labels when the exact task and labels are clear.
- Create a simple reminder when text, date, and time are complete.
- Create a calendar event when typed details are complete, the target calendar is clear, there are no guests, and no critical field is inferred.
- Store an explicit low-risk memory already allowed by the existing memory policy.

After direct execution, the assistant should confirm briefly in Telegram.

## Approval Rules

The classifier must return `approval_required` for:

- Any image or OCR-derived action.
- Any inferred date, year, time, timezone, target, calendar, or task.
- Todoist delete, complete, reopen, move, or bulk edits.
- Calendar edit, delete, invite, or RSVP/respond actions.
- Email send, archive, delete, label, or move actions.
- Bookings, payments, purchases, forms, check-ins, cancellations, or account changes.
- Actions affecting other people.
- Sensitive memory writes or exports.

The approval prompt remains responsible for including agent, action, target, expected effect, risk, and approval options.

## Clarification Rules

The classifier should return `clarify` when the message suggests an action but is missing required information.

Examples:

- "Move it to tomorrow."
- "Add this."
- "Remind me later."
- "Change that task."
- "Update the booking."
- "Put it in the calendar."

The assistant should ask one concise clarifying question, not produce a full approval prompt.

## Agent Prompt Updates

Update the personal and admin agent instructions to teach the action loop:

1. Classify the message intent.
2. Execute low-risk exact actions directly and confirm.
3. Ask approval for clear high-risk actions.
4. Ask one clarifying question when action details are incomplete.
5. Answer normally for status, advice, and informational requests.

Health agent instructions should point Todoist and calendar mutations through the personal or admin agent, preserving existing boundaries.

## Tests

Add unit tests for:

- Exact low-risk Todoist create and update decisions.
- Todoist delete, complete, move, and bulk edits requiring approval.
- OCR/image-derived requests requiring approval.
- Ambiguous target/date requests returning `clarify`.
- Status and advice requests returning `answer_only`.
- Calendar creation allowed only for complete typed details.
- Calendar edits and invites requiring approval.
- Approval replies classified separately from new action requests.

Update existing tests:

- `tests/agent-boundaries.test.mjs` to verify the agent prompts describe the inbox action loop.
- `tests/approval-policy.test.mjs` only if policy fields need to reference classifier behavior.

## Out of Scope

This version does not:

- Build a persistent action inbox.
- Execute actions from the classifier directly.
- Replace OpenClaw approvals.
- Add broad NLP extraction for every integration.
- Add multi-user workflows.

## Success Criteria

- The classifier is deterministic and covered by unit tests.
- Agent prompts teach the same behavior as the classifier.
- Existing approval boundaries remain intact.
- Low-risk exact Telegram requests become faster to handle.
- Unclear or risky requests are still safely gated.
