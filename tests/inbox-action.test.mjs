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
