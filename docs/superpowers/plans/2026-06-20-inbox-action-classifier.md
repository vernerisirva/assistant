# Inbox Action Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic Telegram inbox action classifier that routes messages to execute, approval, clarification, or answer-only paths.

**Architecture:** Create a focused helper at `scripts/lib/inbox-action.mjs` that classifies text plus optional context into a decision object. The helper does not perform side effects; prompts and tests consume its vocabulary so the bot behavior and safety policy stay aligned.

**Tech Stack:** Node.js ESM, `node:test`, existing repo prompt files, existing approval-language helper.

---

## File Structure

- Create `scripts/lib/inbox-action.mjs`: deterministic classification helper, decision constants, risk/mode vocabulary, and text normalization.
- Create `tests/inbox-action.test.mjs`: unit tests for low-risk execution, approval-required actions, clarification, answer-only paths, and approval replies.
- Modify `agents/personal/AGENTS.md`: teach the Telegram-facing action loop.
- Modify `agents/admin/AGENTS.md`: teach admin to use the same action loop for Todoist, Calendar, reminders, and approval boundaries.
- Modify `agents/health/AGENTS.md`: keep health side-effect boundaries routed through personal/admin.
- Modify `tests/agent-boundaries.test.mjs`: enforce action-loop prompt language.
- Modify `docs/security/approval-model.md`: document classifier role without changing approval authority.
- Modify `docs/runbooks/daily-operation.md`: add operating guidance for action-loop debugging.

## Decision Contract

`classifyInboxAction(message, options)` returns:

```js
{
  intent: "todoist.update",
  risk: "low",
  mode: "execute_then_confirm",
  approvalRequired: false,
  reason: "Exact Todoist task target and explicit low-risk update",
}
```

Allowed `mode` values:

- `execute_then_confirm`
- `approval_required`
- `clarify`
- `answer_only`

Allowed `intent` values:

- `todoist.create`
- `todoist.update`
- `reminder.create`
- `calendar.create`
- `status.query`
- `advice.query`
- `approval.response`
- `clarify`
- `no_action`

Supported `options`:

```js
{
  hasPendingApproval: false,
  source: "typed",
  exactTaskTarget: false,
  completeDetails: false,
  targetCalendarClear: false,
  hasGuests: false,
  affectsOtherPeople: false,
}
```

`source` must default to `"typed"`. Use `"image"` or `"ocr"` for extracted content.

---

### Task 1: Add Inbox Classifier Tests

**Files:**
- Create: `tests/inbox-action.test.mjs`
- Create later in Task 2: `scripts/lib/inbox-action.mjs`

- [ ] **Step 1: Write the failing test file**

Create `tests/inbox-action.test.mjs` with:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyInboxAction } from "../scripts/lib/inbox-action.mjs";

const expectDecision = (message, options, expected) => {
  const decision = classifyInboxAction(message, options);
  assert.deepEqual(
    {
      intent: decision.intent,
      mode: decision.mode,
      risk: decision.risk,
      approvalRequired: decision.approvalRequired,
    },
    expected,
  );
  assert.equal(typeof decision.reason, "string");
  assert.ok(decision.reason.length > 0);
};

describe("inbox action classifier", () => {
  it("classifies exact low-risk Todoist creation as execute then confirm", () => {
    expectDecision(
      "Add Todoist task Renew gym card due 2026-06-19 09:00",
      { completeDetails: true },
      {
        intent: "todoist.create",
        mode: "execute_then_confirm",
        risk: "low",
        approvalRequired: false,
      },
    );
  });

  it("classifies exact low-risk Todoist updates as execute then confirm", () => {
    const options = { exactTaskTarget: true, completeDetails: true };

    for (const message of [
      "Rename Todoist task Gym workout to Post-round gym plan",
      "Update the description for Todoist task Gym workout to warm-up then strength",
      "Append comment to Todoist task Gym workout: keep it easy after golf",
      "Change due date for Todoist task Renew gym card to 2026-06-19 10:00",
      "Add label health to Todoist task Gym workout",
      "Remove label errands from Todoist task Renew gym card",
    ]) {
      expectDecision(message, options, {
        intent: "todoist.update",
        mode: "execute_then_confirm",
        risk: "low",
        approvalRequired: false,
      });
    }
  });

  it("requires approval for destructive Todoist actions", () => {
    for (const message of [
      "Delete Todoist task Renew gym card",
      "Complete Todoist task Gym workout",
      "Reopen Todoist task Gym workout",
      "Move Todoist task Renew gym card to Work",
      "Bulk edit all Todoist tasks due today",
    ]) {
      expectDecision(
        message,
        { exactTaskTarget: true, completeDetails: true },
        {
          intent: "todoist.update",
          mode: "approval_required",
          risk: "high",
          approvalRequired: true,
        },
      );
    }
  });

  it("requires approval for image and OCR derived actions", () => {
    for (const source of ["image", "ocr"]) {
      expectDecision(
        "Add these ferry trips to calendar",
        { source, completeDetails: true, targetCalendarClear: true },
        {
          intent: "calendar.create",
          mode: "approval_required",
          risk: "medium",
          approvalRequired: true,
        },
      );
    }
  });

  it("asks for clarification when action details are ambiguous", () => {
    for (const message of [
      "Move it to tomorrow",
      "Add this",
      "Remind me later",
      "Change that task",
      "Put it in the calendar",
    ]) {
      expectDecision(message, {}, {
        intent: "clarify",
        mode: "clarify",
        risk: "unknown",
        approvalRequired: false,
      });
    }
  });

  it("classifies status and advice as answer only", () => {
    expectDecision("Is the agent running?", {}, {
      intent: "status.query",
      mode: "answer_only",
      risk: "none",
      approvalRequired: false,
    });

    expectDecision("What should I do next?", {}, {
      intent: "advice.query",
      mode: "answer_only",
      risk: "none",
      approvalRequired: false,
    });
  });

  it("allows complete typed calendar creation but gates edits and invites", () => {
    expectDecision(
      "Create calendar event Dentist on 2026-06-21 14:00 in Personal calendar",
      { completeDetails: true, targetCalendarClear: true },
      {
        intent: "calendar.create",
        mode: "execute_then_confirm",
        risk: "low",
        approvalRequired: false,
      },
    );

    for (const message of [
      "Delete calendar event Dentist",
      "Move calendar event Dentist to 15:00",
      "Invite Anna to calendar event Dentist",
      "RSVP yes to the AGM calendar invite",
    ]) {
      expectDecision(
        message,
        { completeDetails: true, targetCalendarClear: true },
        {
          intent: "calendar.create",
          mode: "approval_required",
          risk: "high",
          approvalRequired: true,
        },
      );
    }
  });

  it("classifies approval replies only when an approval prompt is pending", () => {
    expectDecision(
      "approve",
      { hasPendingApproval: true },
      {
        intent: "approval.response",
        mode: "answer_only",
        risk: "none",
        approvalRequired: false,
      },
    );

    expectDecision(
      "approve",
      { hasPendingApproval: false },
      {
        intent: "no_action",
        mode: "answer_only",
        risk: "none",
        approvalRequired: false,
      },
    );
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
node --test tests/inbox-action.test.mjs
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

or a similar failure showing `scripts/lib/inbox-action.mjs` does not exist yet.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/inbox-action.test.mjs
git commit -m "test: define inbox action classifier behavior"
```

---

### Task 2: Implement Inbox Classifier

**Files:**
- Create: `scripts/lib/inbox-action.mjs`
- Test: `tests/inbox-action.test.mjs`

- [ ] **Step 1: Create the classifier implementation**

Create `scripts/lib/inbox-action.mjs` with:

```js
import { isApprovalMessage, normalizeApprovalText } from "./approval-language.mjs";

export const inboxActionModes = Object.freeze({
  executeThenConfirm: "execute_then_confirm",
  approvalRequired: "approval_required",
  clarify: "clarify",
  answerOnly: "answer_only",
});

export const inboxActionIntents = Object.freeze({
  todoistCreate: "todoist.create",
  todoistUpdate: "todoist.update",
  reminderCreate: "reminder.create",
  calendarCreate: "calendar.create",
  statusQuery: "status.query",
  adviceQuery: "advice.query",
  approvalResponse: "approval.response",
  clarify: "clarify",
  noAction: "no_action",
});

const defaultOptions = Object.freeze({
  hasPendingApproval: false,
  source: "typed",
  exactTaskTarget: false,
  completeDetails: false,
  targetCalendarClear: false,
  hasGuests: false,
  affectsOtherPeople: false,
});

const destructiveTodoistPattern =
  /\b(delete|remove task|complete|mark .* done|reopen|move .* todoist|bulk edit|all todoist|all tasks)\b/;
const lowRiskTodoistUpdatePattern =
  /\b(rename|update .*description|replace .*description|append .*comment|append .*description|change due|reschedule|add label|remove label)\b/;
const todoistPattern = /\b(todoist|task)\b/;
const reminderPattern = /\b(remind me|set reminder|reminder)\b/;
const calendarPattern = /\b(calendar|event)\b/;
const calendarHighRiskPattern = /\b(delete|remove|move|reschedule|invite|add guest|rsvp|respond)\b/;
const statusPattern = /\b(agent running|bot running|status|what is running|scheduled|automatic messages|what.*next scheduled)\b/;
const advicePattern = /\b(what should i do|what next|recommend|how would you improve|what would you do)\b/;
const ambiguousActionPattern = /\b(move it|add this|remind me later|change that|update it|put it in the calendar)\b/;

export function classifyInboxAction(message, options = {}) {
  const raw = String(message ?? "").trim();
  const opts = { ...defaultOptions, ...options };
  const text = normalizeApprovalText(raw);

  if (!text) return answerOnly("no_action", "Empty message has no action.");

  if (isApprovalMessage(raw, { hasPendingApproval: opts.hasPendingApproval })) {
    return answerOnly("approval.response", "Approval reply for a pending approval prompt.");
  }

  if (isApprovalLikeWithoutPending(text)) {
    return answerOnly("no_action", "Approval-like message without a pending approval prompt.");
  }

  if (opts.source === "image" || opts.source === "ocr") {
    return approvalRequired(inferActionIntent(text), "medium", "Image or OCR-derived actions require approval.");
  }

  if (opts.affectsOtherPeople) {
    return approvalRequired(inferActionIntent(text), "high", "Actions affecting other people require approval.");
  }

  if (ambiguousActionPattern.test(text)) {
    return clarify("Action-like message is missing a clear target or critical details.");
  }

  if (todoistPattern.test(text)) {
    return classifyTodoist(text, opts);
  }

  if (calendarPattern.test(text)) {
    return classifyCalendar(text, opts);
  }

  if (reminderPattern.test(text)) {
    if (opts.completeDetails) {
      return executeThenConfirm("reminder.create", "Complete typed reminder request.");
    }

    return clarify("Reminder request is missing text, date, or time.");
  }

  if (statusPattern.test(text)) {
    return answerOnly("status.query", "Status request does not mutate state.");
  }

  if (advicePattern.test(text)) {
    return answerOnly("advice.query", "Advice request does not mutate state.");
  }

  return answerOnly("no_action", "No supported action intent detected.");
}

function classifyTodoist(text, opts) {
  if (destructiveTodoistPattern.test(text)) {
    return approvalRequired("todoist.update", "high", "Destructive or bulk Todoist changes require approval.");
  }

  if (lowRiskTodoistUpdatePattern.test(text)) {
    if (opts.exactTaskTarget && opts.completeDetails) {
      return executeThenConfirm("todoist.update", "Exact Todoist task target and explicit low-risk update.");
    }

    return clarify("Todoist update is missing exact task target or complete details.");
  }

  if (/\b(add|create|new)\b/.test(text)) {
    if (opts.completeDetails) {
      return executeThenConfirm("todoist.create", "Complete typed Todoist creation request.");
    }

    return clarify("Todoist creation is missing task content, due date, project, or other critical details.");
  }

  return answerOnly("no_action", "Todoist was mentioned without a supported task action.");
}

function classifyCalendar(text, opts) {
  if (calendarHighRiskPattern.test(text) || opts.hasGuests) {
    return approvalRequired("calendar.create", "high", "Calendar edits, invites, and responses require approval.");
  }

  if (/\b(add|create|put|schedule)\b/.test(text)) {
    if (opts.completeDetails && opts.targetCalendarClear) {
      return executeThenConfirm("calendar.create", "Complete typed calendar creation request.");
    }

    return clarify("Calendar creation is missing date, time, title, timezone, or target calendar.");
  }

  return answerOnly("no_action", "Calendar was mentioned without a supported event creation request.");
}

function inferActionIntent(text) {
  if (todoistPattern.test(text)) return "todoist.update";
  if (calendarPattern.test(text)) return "calendar.create";
  if (reminderPattern.test(text)) return "reminder.create";
  return "clarify";
}

function executeThenConfirm(intent, reason) {
  return decision(intent, "low", "execute_then_confirm", false, reason);
}

function approvalRequired(intent, risk, reason) {
  return decision(intent, risk, "approval_required", true, reason);
}

function clarify(reason) {
  return decision("clarify", "unknown", "clarify", false, reason);
}

function answerOnly(intent, reason) {
  return decision(intent, "none", "answer_only", false, reason);
}

function decision(intent, risk, mode, approvalRequired, reason) {
  return { intent, risk, mode, approvalRequired, reason };
}

function isApprovalLikeWithoutPending(text) {
  return ["approve", "approved", "ok", "okay", "yes", "go ahead", "proceed"].includes(text);
}
```

- [ ] **Step 2: Run the focused classifier test**

Run:

```bash
node --test tests/inbox-action.test.mjs
```

Expected:

```text
pass
```

If any test fails because a pattern is too broad or too narrow, adjust only `scripts/lib/inbox-action.mjs` and re-run the same command.

- [ ] **Step 3: Run related approval-language tests**

Run:

```bash
node --test tests/approval-language.test.mjs tests/inbox-action.test.mjs
```

Expected:

```text
pass
```

- [ ] **Step 4: Commit the classifier**

```bash
git add scripts/lib/inbox-action.mjs tests/inbox-action.test.mjs
git commit -m "feat: classify inbox action risk"
```

---

### Task 3: Align Agent Prompts With the Classifier

**Files:**
- Modify: `agents/personal/AGENTS.md`
- Modify: `agents/admin/AGENTS.md`
- Modify: `agents/health/AGENTS.md`
- Modify: `tests/agent-boundaries.test.mjs`

- [ ] **Step 1: Add failing agent-boundary tests**

Modify `tests/agent-boundaries.test.mjs` by adding this test after the existing risk-tiered approvals test:

```js
  it("teaches the personal and admin agents the inbox action loop", () => {
    const personalAgent = agents.find((agent) => agent.id === "personal");
    const adminAgent = agents.find((agent) => agent.id === "admin");
    const healthAgent = agents.find((agent) => agent.id === "health");
    const personalPrompt = readFileSync(`${personalAgent.promptDir}/AGENTS.md`, "utf8");
    const adminPrompt = readFileSync(`${adminAgent.promptDir}/AGENTS.md`, "utf8");
    const healthPrompt = readFileSync(`${healthAgent.promptDir}/AGENTS.md`, "utf8");

    for (const prompt of [personalPrompt, adminPrompt]) {
      assert.match(prompt, /Inbox action loop/i);
      assert.match(prompt, /execute low-risk exact actions directly and confirm/i);
      assert.match(prompt, /approval_required/i);
      assert.match(prompt, /clarify/i);
      assert.match(prompt, /answer_only/i);
      assert.match(prompt, /image\/OCR-derived action/i);
    }

    assert.match(healthPrompt, /route Todoist and Calendar mutations through the personal or admin agent/i);
  });
```

- [ ] **Step 2: Run the failing agent-boundary test**

Run:

```bash
node --test tests/agent-boundaries.test.mjs
```

Expected:

```text
FAIL
```

The failure should mention missing `Inbox action loop` or related prompt text.

- [ ] **Step 3: Update the personal agent prompt**

In `agents/personal/AGENTS.md`, add this section near the existing risk-tiered approval section:

```md
Inbox action loop:
- First classify Telegram messages by handling path: `execute_then_confirm`, `approval_required`, `clarify`, or `answer_only`.
- Execute low-risk exact actions directly and confirm when the user explicitly asks and all critical details are complete.
- Use `approval_required` for clear high-risk actions, including image/OCR-derived action details, inferred fields, deletes, sends, bookings, payments, purchases, forms, or actions affecting other people.
- Use `clarify` for action-like requests with missing target, date, time, calendar, task, or other critical detail.
- Use `answer_only` for status, advice, and informational requests.
- Keep confirmations brief after direct low-risk actions.
```

- [ ] **Step 4: Update the admin agent prompt**

In `agents/admin/AGENTS.md`, add this section near the Todoist or Confirm-before-action section:

```md
Inbox action loop:
- Classify admin requests by handling path: `execute_then_confirm`, `approval_required`, `clarify`, or `answer_only`.
- Execute low-risk exact actions directly and confirm only when the action is already allowed by the approval policy.
- Use `approval_required` for clear high-risk actions, including image/OCR-derived action details, inferred fields, Todoist delete/complete/reopen/move/bulk edits, Calendar edit/delete/invite/respond actions, email mutations, bookings, payments, purchases, forms, and actions affecting other people.
- Use `clarify` when a request says things like "move it", "add this", "remind me later", "change that task", or "put it in the calendar" without enough detail.
- Use `answer_only` for read-only status, planning, summaries, and advice.
```

- [ ] **Step 5: Update the health agent prompt**

In `agents/health/AGENTS.md`, add this sentence near the existing Todoist boundary:

```md
- For the inbox action loop, route Todoist and Calendar mutations through the personal or admin agent; health may recommend the content but should not bypass approval, clarification, or low-risk exact-action rules.
```

- [ ] **Step 6: Run the focused agent-boundary test**

Run:

```bash
node --test tests/agent-boundaries.test.mjs
```

Expected:

```text
pass
```

- [ ] **Step 7: Commit prompt alignment**

```bash
git add agents/personal/AGENTS.md agents/admin/AGENTS.md agents/health/AGENTS.md tests/agent-boundaries.test.mjs
git commit -m "docs: teach agents inbox action loop"
```

---

### Task 4: Update Operator Documentation

**Files:**
- Modify: `docs/security/approval-model.md`
- Modify: `docs/runbooks/daily-operation.md`

- [ ] **Step 1: Update approval model documentation**

In `docs/security/approval-model.md`, add this section after the low-risk approval exception section:

```md
## Inbox Action Classifier

The inbox action classifier is advisory. It decides whether a Telegram message should be handled as `execute_then_confirm`, `approval_required`, `clarify`, or `answer_only`, but it does not execute side effects.

Direct execution is allowed only for low-risk exact actions already allowed by this approval model. Image/OCR-derived actions, inferred critical fields, destructive actions, external-impact actions, and actions affecting other people remain approval-gated.
```

- [ ] **Step 2: Update daily operation documentation**

In `docs/runbooks/daily-operation.md`, add this section near the assistant status or troubleshooting section:

```md
## Inbox Action Loop Checks

When the bot gives an unexpected approval prompt or acts too cautiously, check the intended handling path:

- `execute_then_confirm`: explicit low-risk action with complete details.
- `approval_required`: clear action that is risky, destructive, inferred, image/OCR-derived, or externally impactful.
- `clarify`: action-like message with missing critical details.
- `answer_only`: read-only question, status request, advice, or planning.

The classifier is deterministic and side-effect free; execution remains controlled by the relevant tool and approval policy.
```

- [ ] **Step 3: Run documentation/policy related tests**

Run:

```bash
node --test tests/approval-policy.test.mjs tests/agent-boundaries.test.mjs tests/inbox-action.test.mjs
```

Expected:

```text
pass
```

- [ ] **Step 4: Commit documentation updates**

```bash
git add docs/security/approval-model.md docs/runbooks/daily-operation.md
git commit -m "docs: document inbox action routing"
```

---

### Task 5: Full Verification, Render, Push, and Restart

**Files:**
- Generated: `.openclaw/openclaw.json`
- Verify all modified files from prior tasks

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected:

```text
tests 166
pass 166
fail 0
```

The exact count may be higher if additional tests were added during implementation. There must be zero failures.

- [ ] **Step 2: Render OpenClaw config**

Run:

```bash
npm run render:config
```

Expected:

```text
Rendered OpenClaw config: /Users/vernerisirva/AI-assistant/.openclaw/openclaw.json
```

- [ ] **Step 3: Verify branch is ahead of main cleanly**

Run:

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git status --short --branch
```

Expected:

```text
git merge-base exits 0
```

`git status` may show existing unrelated untracked `.superpowers/` or plan files. Do not add those unless they are part of this plan.

- [ ] **Step 4: Push directly to main**

Run:

```bash
git push origin HEAD:main
```

Expected:

```text
HEAD -> main
```

- [ ] **Step 5: Restart gateway**

Run:

```bash
uid=$(id -u); launchctl kickstart -k gui/$uid/ai.openclaw.gateway
```

Expected: command exits 0.

- [ ] **Step 6: Verify runtime status**

Run:

```bash
npm run --silent assistant:status -- --include-logs --recent-hours 2
```

Expected:

```text
Status: running
Telegram: enabled
Recent issues: no blocking recent issues found.
```

- [ ] **Step 7: Final response**

Report:

- Commit hash pushed to `main`.
- Full test suite result.
- Config render result.
- Gateway restart result.
- Current assistant/Telegram status.
- Any unrelated untracked files left untouched.

---

## Self-Review Notes

- Spec coverage: classifier, direct execution, approval rules, clarification rules, prompt updates, tests, out-of-scope boundaries, and success criteria are each mapped to tasks.
- Scope: no persistent inbox, no direct side-effect executor, no broad NLP extraction.
- Type consistency: plan uses the same `intent`, `risk`, `mode`, and `approvalRequired` fields across tests and implementation.
