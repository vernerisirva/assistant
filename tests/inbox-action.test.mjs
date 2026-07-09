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
      "Clean up the formatting of this Todoist task",
      "Clean up the wording of Todoist task AI video",
      "Add detail to Todoist task AI video description",
      "Append comment to Todoist task Gym workout: keep it easy after golf",
      "Change due date for Todoist task Renew gym card to 2026-06-19 10:00",
      "Add label health to Todoist task Gym workout",
      "Remove label errands from Todoist task Renew gym card",
      "Complete Todoist task Gym workout",
      "Mark Todoist task Gym workout done",
    ]) {
      expectDecision(message, options, {
        intent: "todoist.update",
        mode: "execute_then_confirm",
        risk: "low",
        approvalRequired: false,
      });
    }
  });

  it("allows one exact Todoist match from context for low-risk description cleanup", () => {
    expectDecision(
      "Update my AI video task description",
      { exactTaskTarget: true, completeDetails: true },
      {
        intent: "todoist.update",
        mode: "execute_then_confirm",
        risk: "low",
        approvalRequired: false,
      },
    );
  });

  it("allows exact screenshot or reference Todoist targets for low-risk formatting updates", () => {
    for (const source of ["image", "ocr", "screenshot", "reference"]) {
      expectDecision(
        "Clean up formatting of this Todoist task",
        { source, exactTaskTarget: true, completeDetails: true },
        {
          intent: "todoist.update",
          mode: "execute_then_confirm",
          risk: "low",
          approvalRequired: false,
        },
      );
    }
  });

  it("allows exact screenshot or reference Todoist targets for wording cleanup that preserves meaning", () => {
    expectDecision(
      "Clean up wording of this Todoist task, keep the meaning the same",
      { source: "screenshot", exactTaskTarget: true, completeDetails: true },
      {
        intent: "todoist.update",
        mode: "execute_then_confirm",
        risk: "low",
        approvalRequired: false,
      },
    );
  });

  it("requires approval for inferred substantive Todoist update content", () => {
    expectDecision(
      "Add detail to this Todoist task",
      {
        source: "screenshot",
        exactTaskTarget: true,
        completeDetails: true,
        inferredUpdateContent: true,
      },
      {
        intent: "todoist.update",
        mode: "approval_required",
        risk: "medium",
        approvalRequired: true,
      },
    );
  });

  it("keeps sensitive and other-person screenshot Todoist updates approval-gated", () => {
    for (const options of [
      { source: "screenshot", exactTaskTarget: true, completeDetails: true, sensitiveContent: true },
      { source: "screenshot", exactTaskTarget: true, completeDetails: true, affectsOtherPeople: true },
    ]) {
      expectDecision(
        "Clean up formatting of this Todoist task",
        options,
        {
          intent: "todoist.update",
          mode: "approval_required",
          risk: "high",
          approvalRequired: true,
        },
      );
    }
  });

  it("asks for clarification when screenshot Todoist target is unclear", () => {
    expectDecision(
      "Clean up formatting of this Todoist task",
      { source: "screenshot", completeDetails: true },
      {
        intent: "clarify",
        mode: "clarify",
        risk: "unknown",
        approvalRequired: false,
      },
    );
  });

  it("requires approval for screenshot-derived destructive or bulk Todoist actions", () => {
    for (const message of [
      "Delete this Todoist task",
      "Bulk edit all Todoist tasks in this screenshot",
    ]) {
      expectDecision(
        message,
        { source: "screenshot", exactTaskTarget: true, completeDetails: true },
        {
          intent: "todoist.update",
          mode: "approval_required",
          risk: "high",
          approvalRequired: true,
        },
      );
    }
  });

  it("requires approval for destructive Todoist actions", () => {
    for (const message of [
      "Delete Todoist task Renew gym card",
      "Reopen Todoist task Gym workout",
      "Move Todoist task Renew gym card to Work",
      "Bulk edit all Todoist tasks due today",
      "Delete all old Todoist tasks",
      "Change every Todoist task in the project",
      "Update the shared Todoist task for Anna",
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

  it("asks for clarification for ambiguous Todoist changes", () => {
    for (const message of [
      "Change my tasks",
      "Clean up my Todoist tasks",
      "Update Todoist task",
    ]) {
      expectDecision(message, {}, {
        intent: "clarify",
        mode: "clarify",
        risk: "unknown",
        approvalRequired: false,
      });
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

  it("classifies calendar planning questions as read-only planning", () => {
    for (const message of [
      "What does my day look like?",
      "Where are my free blocks today?",
      "Help me plan work around my meetings",
      "Do I have space for a workout today?",
      "What calendar pressure do I have this week?",
    ]) {
      expectDecision(message, {}, {
        intent: "calendar.plan",
        mode: "answer_only",
        risk: "none",
        approvalRequired: false,
      });
    }
  });

  it("keeps focus-block creation out of read-only calendar planning", () => {
    expectDecision("Create a focus block", {}, {
      intent: "calendar.create",
      mode: "clarify",
      risk: "unknown",
      approvalRequired: false,
    });
  });

  it("classifies explicit local feedback as low-risk capture", () => {
    for (const message of [
      "That was useful",
      "That was annoying",
      "Feedback: morning brief was too long",
      "Log improvement idea: calendar planning should show gaps between meetings",
    ]) {
      expectDecision(message, {}, {
        intent: "feedback.capture",
        mode: "execute_then_confirm",
        risk: "low",
        approvalRequired: false,
      });
    }
  });

  it("keeps external feedback delivery approval-gated", () => {
    expectDecision("Send this feedback to Anna", {}, {
      intent: "feedback.send",
      mode: "approval_required",
      risk: "high",
      approvalRequired: true,
    });
  });

  it("classifies complete low-risk personal Calendar creation as a policy-allowed preview", () => {
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

    const preview = classifyInboxAction(
      "Create calendar event Dentist on 2026-06-21 14:00 in Personal calendar",
      { completeDetails: true, targetCalendarClear: true },
    );
    assert.match(preview.reason, /policy-allowed preview/i);
    assert.match(preview.reason, /no event is created/i);
  });

  it("keeps Calendar edits, guests, recurrence, and multiple events approval-gated", () => {
    for (const message of [
      "Delete calendar event Dentist",
      "Move calendar event Dentist to 15:00",
      "Invite Anna to calendar event Dentist",
      "RSVP yes to the AGM calendar invite",
      "Create a recurring calendar event Gym",
      "Create two calendar events for my workouts",
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
