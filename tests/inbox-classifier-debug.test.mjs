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

  it("shows a complete low-risk Calendar request as a preview, never a created event", () => {
    const result = classify("Create calendar event Gym on 2026-07-09 at 17:30 for 60 minutes", {
      actionOptions: { completeDetails: true, targetCalendarClear: true },
    });

    assert.equal(result.selectedAgent, "admin");
    assert.equal(result.action.intent, "calendar.create");
    assert.equal(result.action.mode, "execute_then_confirm");
    assert.equal(result.sideEffecting, true);
    assert.equal(result.approvalRequired, false);
    assert.match(result.action.reason, /policy-allowed preview/i);

    const output = formatInboxClassifierDebug(result);
    assert.match(output, /policy-allowed preview/i);
    assert.match(output, /no event is created/i);
    assert.match(output, /no Calendar write tool/i);
    assert.doesNotMatch(output, /base classifier detected an executable intent/i);
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

  it("parses explicit Calendar preview context flags", () => {
    assert.deepEqual(
      parseInboxClassifierDebugArgs([
        "--complete-details",
        "--target-calendar-clear",
        "Create calendar event Gym on 2026-07-09 at 17:30 for 60 minutes",
      ]),
      {
        json: false,
        actionOptions: {
          completeDetails: true,
          targetCalendarClear: true,
        },
        message: "Create calendar event Gym on 2026-07-09 at 17:30 for 60 minutes",
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

  it("routes performance coaching to personal as conversation with no side effects", () => {
    for (const [message, mode] of [
      ["I just made a double bogey", "in_performance"],
      ["Pre-round coach", "pre_performance"],
      ["Help me prepare mentally for this meeting", "pre_performance"],
      ["I've been staring at this task for 20 minutes", "quick_reset"],
      ["Debrief today's work", "debrief"],
    ]) {
      const result = classify(message);

      assert.equal(result.selectedAgent, "personal", message);
      assert.equal(result.coaching.kind, "coaching", message);
      assert.equal(result.coaching.mode, mode, message);
      assert.equal(result.action.mode, "answer_only", message);
      assert.equal(result.sideEffecting, false, message);
      assert.equal(result.approvalRequired, false, message);
      assert.match(result.safety.reason, /Coaching is conversation only/, message);
      assert.match(result.hardStopPoints[0], /Stop before turning a coaching idea into a Todoist task/, message);
    }
  });

  it("routes sleep coaching and serious sleep trouble to health", () => {
    const coaching = classify("Sleep coach — I need to wake at 06:30");
    assert.equal(coaching.selectedAgent, "health");
    assert.equal(coaching.coaching.mode, "sleep_coaching");
    assert.equal(coaching.sideEffecting, false);
    assert.match(coaching.hardStopPoints.join(" "), /Stop before diagnosis/);

    const referral = classify("I haven't slept properly for months");
    assert.equal(referral.selectedAgent, "health");
    assert.equal(referral.coaching.kind, "sleep_health");
    assert.match(referral.route.reason, /professional assessment rather than coaching/);
  });

  it("keeps the approval path of an action that arrives with a coaching request", () => {
    const calendar = classify("Help me focus and move my meeting to 3pm");
    assert.equal(calendar.coaching, null);
    assert.equal(calendar.selectedAgent, "admin");

    const todoist = classify("Coach me and add a Todoist task to practice putting");
    assert.equal(todoist.coaching, null);
    assert.equal(todoist.action.mode, "clarify");

    const booking = classify("Debrief my round and book golf for Saturday");
    assert.equal(booking.coaching, null);
    assert.equal(booking.approvalRequired, true);

    const email = classify("Help me prepare mentally and send an email to Anna");
    assert.equal(email.coaching, null);
    assert.equal(email.approvalRequired, true);
  });

  it("shows an explicit playbook entry as one low-risk memory write", () => {
    const result = classify('My golf cue word is "commit"');

    assert.equal(result.selectedAgent, "personal");
    assert.equal(result.coaching.kind, "playbook");
    assert.equal(result.sideEffecting, true);
    assert.equal(result.approvalRequired, false);
    assert.match(result.safety.reason, /low-risk memory write through the normal memory command/);
  });

  it("escalates a playbook entry with a health detail to sensitive-memory approval", () => {
    const result = classify("Remember that my wind-down routine includes my sleeping pills");

    assert.equal(result.coaching.kind, "playbook");
    assert.equal(result.sideEffecting, true);
    assert.equal(result.approvalRequired, true);
    assert.match(result.safety.reason, /sensitive memory needs Telegram approval/);
  });

  it("does not report a frustrated self-judgement as a memory write", () => {
    const result = classify("I always choke under pressure");

    assert.equal(result.coaching.mode, "quick_reset");
    assert.equal(result.sideEffecting, false);
  });

  it("leaves non-coaching messages without a coaching block", () => {
    for (const message of [
      "What is performance anxiety?",
      "Can you adjust my workout-window routine for today?",
      "Remember that I prefer early workouts",
      "Help me prepare for my meeting with Tobias",
    ]) {
      assert.equal(classify(message).coaching, null, message);
    }
    assert.equal(classify("Help me prepare for my meeting with Tobias").selectedAgent, "admin");
  });

  it("formats the coaching block without implying an action", () => {
    const output = formatInboxClassifierDebug(classify("I just made a double bogey"));

    assert.match(output, /Likely route: personal \(confidence: high\)/);
    assert.match(output, /Coaching:\n- Kind: coaching \(context: golf\)\n- Mode: in_performance\n- Questions: none/);
    assert.match(output, /- Shape: immediate reset → next controllable action → at most one cue/);
    assert.match(output, /- Side-effect signal: no/);
    assert.match(output, /Note: coaching is conversation only; nothing is created, scheduled, or stored\./);

    const debrief = formatInboxClassifierDebug(classify("Debrief my round"));
    assert.match(debrief, /- Questions: 3 to 5/);

    const clarify = formatInboxClassifierDebug(classify("Coach me"));
    assert.match(clarify, /- Questions: exactly 1/);

    const technique = formatInboxClassifierDebug(classify("How do I fix my slice?"));
    assert.match(technique, /- Kind: golf_technique \(context: golf\)/);
    assert.doesNotMatch(technique, /- Mode:/);
  });
});
