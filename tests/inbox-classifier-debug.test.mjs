import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildInboxClassifierDebug,
  formatInboxClassifierDebug,
  parseInboxClassifierDebugArgs,
} from "../scripts/lib/inbox-classifier-debug.mjs";

const classify = (message, options) => buildInboxClassifierDebug({ message, ...options });

describe("inbox classifier debug command", () => {
  it("routes admin logistics messages to admin", () => {
    const result = classify("What is on my calendar tomorrow and what Todoist tasks are due?");

    assert.equal(result.selectedAgent, "admin");
    assert.equal(result.sideEffecting, false);
    assert.equal(result.approvalRequired, false);
    assert.equal(result.action.intent, "no_action");
    assert.match(result.reason, /admin/i);
  });

  it("routes health routine messages to health", () => {
    const result = classify("Can you adjust my workout-window routine for today?");

    assert.equal(result.selectedAgent, "health");
    assert.equal(result.sideEffecting, true);
    assert.equal(result.approvalRequired, true);
    assert.match(result.hardStopPoints.join(" "), /routine/i);
  });

  it("routes source-backed lookup messages to research", () => {
    const result = classify("Can you look up current nutrition research and cite sources?");

    assert.equal(result.selectedAgent, "research");
    assert.equal(result.sideEffecting, false);
    assert.equal(result.approvalRequired, false);
    assert.match(result.reason, /source-backed|research/i);
  });

  it("routes calendar planning questions to admin as read-only work", () => {
    for (const message of [
      "What does my day look like?",
      "Where are my free blocks today?",
    ]) {
      const result = classify(message);

      assert.equal(result.selectedAgent, "admin");
      assert.equal(result.action.intent, "calendar.plan");
      assert.equal(result.sideEffecting, false);
      assert.equal(result.approvalRequired, false);
    }
  });

  it("flags Min Golf booking-like messages as approval-gated admin work", () => {
    const result = classify("Can you book golf tomorrow morning?");

    assert.equal(result.selectedAgent, "admin");
    assert.equal(result.sideEffecting, true);
    assert.equal(result.approvalRequired, true);
    assert.equal(result.safety.reason, "Min Golf booking-like action requires Telegram approval.");
    assert.match(result.hardStopPoints.join(" "), /payment|BankID|booking/i);
  });

  it("flags email and calendar side effects as requiring approval", () => {
    for (const message of [
      "Send email to Anna saying I will be late",
      "Move my calendar event tomorrow to 10:00",
    ]) {
      const result = classify(message);

      assert.equal(result.selectedAgent, "admin");
      assert.equal(result.sideEffecting, true);
      assert.equal(result.approvalRequired, true);
    }
  });

  it("explains Todoist and memory side-effect implications", () => {
    const todoist = classify("Delete Todoist task Gym workout");
    assert.equal(todoist.selectedAgent, "admin");
    assert.equal(todoist.sideEffecting, true);
    assert.equal(todoist.approvalRequired, true);
    assert.match(todoist.safety.reason, /Todoist/i);

    const memory = classify("Remember that I prefer early workouts");
    assert.equal(memory.selectedAgent, "personal");
    assert.equal(memory.sideEffecting, true);
    assert.equal(memory.approvalRequired, false);
    assert.match(memory.safety.reason, /memory/i);

    const sensitiveMemory = classify("Remember that I take heart medication");
    assert.equal(sensitiveMemory.selectedAgent, "personal");
    assert.equal(sensitiveMemory.sideEffecting, true);
    assert.equal(sensitiveMemory.approvalRequired, true);
    assert.match(sensitiveMemory.safety.reason, /Sensitive memory/i);
  });

  it("routes explicit local feedback through personal without approval", () => {
    for (const message of [
      "That was useful",
      "That was annoying",
      "Feedback: morning brief was too long",
      "Log improvement idea: calendar planning should show gaps between meetings",
    ]) {
      const result = classify(message);

      assert.equal(result.selectedAgent, "personal");
      assert.equal(result.action.intent, "feedback.capture");
      assert.equal(result.action.mode, "execute_then_confirm");
      assert.equal(result.sideEffecting, true);
      assert.equal(result.approvalRequired, false);
      assert.match(result.safety.reason, /local feedback/i);
    }
  });

  it("keeps external feedback delivery approval-gated", () => {
    const result = classify("Send this feedback to Anna");

    assert.equal(result.selectedAgent, "personal");
    assert.equal(result.action.intent, "feedback.send");
    assert.equal(result.sideEffecting, true);
    assert.equal(result.approvalRequired, true);
  });

  it("shows exact low-risk Todoist task changes as side-effecting without approval", () => {
    for (const message of [
      "Clean up the formatting of this Todoist task",
      "Update my AI video task description",
    ]) {
      const result = classify(message, {
        actionOptions: { exactTaskTarget: true, completeDetails: true },
      });

      assert.equal(result.selectedAgent, "admin");
      assert.equal(result.sideEffecting, true);
      assert.equal(result.approvalRequired, false);
      assert.equal(result.action.mode, "execute_then_confirm");
      assert.match(result.safety.reason, /Exact Todoist task target/i);
      assert.doesNotMatch(result.hardStopPoints.join(" "), /Exact Todoist task target/i);
    }
  });

  it("shows exact screenshot Todoist formatting cleanup as side-effecting without approval", () => {
    const result = classify("Clean up formatting of this Todoist task", {
      actionOptions: {
        source: "screenshot",
        exactTaskTarget: true,
        completeDetails: true,
      },
    });

    assert.equal(result.selectedAgent, "admin");
    assert.equal(result.sideEffecting, true);
    assert.equal(result.approvalRequired, false);
    assert.equal(result.action.mode, "execute_then_confirm");
    assert.match(result.safety.reason, /reference-derived exact Todoist task target/i);
    assert.doesNotMatch(result.safety.reason, /actions require approval/i);
  });

  it("keeps inferred substantive screenshot Todoist update content approval-gated", () => {
    const result = classify("Add detail to this Todoist task", {
      actionOptions: {
        source: "screenshot",
        exactTaskTarget: true,
        completeDetails: true,
        inferredUpdateContent: true,
      },
    });

    assert.equal(result.selectedAgent, "admin");
    assert.equal(result.sideEffecting, true);
    assert.equal(result.approvalRequired, true);
    assert.equal(result.action.mode, "approval_required");
    assert.match(result.safety.reason, /Inferred Todoist update content requires approval/i);
  });

  it("shows unclear screenshot Todoist formatting cleanup as clarification needed", () => {
    const result = classify("Clean up formatting of this Todoist task", {
      actionOptions: {
        source: "screenshot",
        completeDetails: true,
      },
    });

    assert.equal(result.selectedAgent, "personal");
    assert.equal(result.action.mode, "clarify");
    assert.equal(result.sideEffecting, false);
    assert.equal(result.approvalRequired, false);
    assert.match(result.safety.reason, /clarification/i);
  });

  it("keeps screenshot-derived Todoist destructive actions approval-gated", () => {
    const result = classify("Delete this Todoist task", {
      actionOptions: {
        source: "screenshot",
        exactTaskTarget: true,
        completeDetails: true,
      },
    });

    assert.equal(result.selectedAgent, "admin");
    assert.equal(result.action.mode, "approval_required");
    assert.equal(result.sideEffecting, true);
    assert.equal(result.approvalRequired, true);
  });

  it("shows ambiguous Todoist changes as clarification needed", () => {
    const result = classify("Change my tasks");

    assert.equal(result.selectedAgent, "personal");
    assert.equal(result.action.mode, "clarify");
    assert.equal(result.sideEffecting, false);
    assert.equal(result.approvalRequired, false);
    assert.match(result.safety.reason, /clarification/i);
  });

  it("keeps dangerous non-Todoist actions approval-gated", () => {
    for (const message of [
      "Send this email",
      "Book golf tomorrow morning",
    ]) {
      const result = classify(message);

      assert.equal(result.sideEffecting, true);
      assert.equal(result.approvalRequired, true);
    }
  });

  it("keeps ambiguous messages in clarify mode", () => {
    const result = classify("Move it to tomorrow");

    assert.equal(result.selectedAgent, "personal");
    assert.equal(result.action.mode, "clarify");
    assert.equal(result.confidence, "low");
    assert.equal(result.sideEffecting, false);
    assert.equal(result.approvalRequired, false);
  });

  it("parses message arguments after npm separator", () => {
    assert.deepEqual(parseInboxClassifierDebugArgs(["Can you book golf tomorrow?"]), {
      json: false,
      actionOptions: {},
      message: "Can you book golf tomorrow?",
    });
  });

  it("parses json mode", () => {
    assert.deepEqual(parseInboxClassifierDebugArgs(["--json", "Can you book golf tomorrow?"]), {
      json: true,
      actionOptions: {},
      message: "Can you book golf tomorrow?",
    });
  });

  it("parses exact Todoist context flags for low-risk debug runs", () => {
    assert.deepEqual(
      parseInboxClassifierDebugArgs([
        "--json",
        "--source",
        "screenshot",
        "--exact-task-target",
        "--complete-details",
        "--inferred-update-content",
        "Clean up the formatting of this Todoist task",
      ]),
      {
        json: true,
        actionOptions: {
          source: "screenshot",
          exactTaskTarget: true,
          completeDetails: true,
          inferredUpdateContent: true,
        },
        message: "Clean up the formatting of this Todoist task",
      },
    );
  });

  it("formats layer-aware wording for booking-like output", () => {
    const output = formatInboxClassifierDebug(classify("Can you book golf tomorrow morning?"));

    assert.match(output, /Likely route: admin \(confidence: high\)/);
    assert.match(output, /Action classifier:/);
    assert.match(output, /- Detected executable intent: no \(intent: no_action\)/);
    assert.match(output, /Routing\/safety overlay:/);
    assert.match(output, /- Side-effect signal: yes/);
    assert.match(output, /- Approval if executed: required/);
    assert.match(output, /Note: the base classifier did not detect an executable intent, but the safety overlay found side-effect language/);
    assert.match(output, /Hard stop points:/);
  });
});
