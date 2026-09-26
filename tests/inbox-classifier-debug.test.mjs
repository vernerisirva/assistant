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

describe("inbox classifier debug: focus and next action", () => {
  const focusHardStop = /^Stop before turning a focus recommendation into a Todoist task, Calendar change, reminder, or message/;

  it("answers a next-action request in personal, as advice with no side effects", () => {
    // "meeting" would otherwise route to admin.
    const result = classify("I have 90 minutes before my next meeting");

    assert.equal(result.selectedAgent, "personal");
    assert.equal(result.confidence, "high");
    assert.equal(result.focus.kind, "next_action");
    assert.equal(result.focus.availableMinutes, 90);
    assert.equal(result.coaching, null);
    assert.equal(result.sideEffecting, false);
    assert.equal(result.approvalRequired, false);
    assert.match(result.safety.reason, /Focus recommendations are advisory conversation/);
    assert.match(result.hardStopPoints[0], focusHardStop);
  });

  it("shows a session start or end as a local focus-record write that needs no approval", () => {
    for (const [message, options] of [
      ["Start a 45-minute focus session on my thesis", {}],
      ["Done", { focusActive: true }],
    ]) {
      const result = classify(message, options);

      assert.equal(result.selectedAgent, "personal", message);
      assert.equal(result.focus.writes, "focus-state", message);
      assert.equal(result.sideEffecting, true, message);
      assert.equal(result.approvalRequired, false, message);
      assert.match(result.safety.reason, /Writes only the local, disposable focus session record; no Todoist task, Calendar event, reminder, or message/, message);
      assert.match(result.hardStopPoints[0], focusHardStop, message);
    }
  });

  it("uses the running session only when there is one", () => {
    const inSession = classify("I'm stuck", { focusActive: true });
    assert.equal(inSession.focus.kind, "session_check_in");
    assert.equal(inSession.focus.usesFocusSession, true);

    const noSession = classify("I'm stuck");
    assert.equal(noSession.focus.kind, "next_action");
    assert.equal(noSession.focus.usesFocusSession, false);
    assert.match(noSession.focus.reason, /do not invent one/);

    assert.equal(classify("Done").focus, null);
  });

  it("leads over general coaching but never over distress, sleep health, technique, or a playbook write", () => {
    const distractedInSession = classify("I'm getting distracted", { focusActive: true });
    assert.equal(distractedInSession.focus.kind, "session_check_in");
    assert.equal(distractedInSession.coaching, null);
    assert.match(distractedInSession.focus.reason, /coaching quick reset/);

    const distractedAlone = classify("I'm getting distracted");
    assert.equal(distractedAlone.focus, null);
    assert.equal(distractedAlone.coaching.mode, "quick_reset");

    const bareHelp = classify("Help me focus");
    assert.equal(bareHelp.focus, null);
    assert.equal(bareHelp.coaching.mode, "quick_reset");

    for (const [message, kind] of [
      ["I feel hopeless and can't cope", "support"],
      ["I haven't slept properly for months", "sleep_health"],
      ["How do I fix my slice?", "golf_technique"],
      ["My deep-work block is normally 45 minutes", "playbook"],
    ]) {
      const result = classify(message, { focusActive: true });
      assert.equal(result.focus, null, message);
      assert.equal(result.coaching.kind, kind, message);
    }
  });

  it("never masks an action or softens a side-effect signal", () => {
    const task = classify("I have 45 minutes, add a Todoist task to email my supervisor");
    assert.equal(task.focus, null);
    assert.notEqual(task.action.mode, "answer_only");

    const calendar = classify("Schedule a focus block at 14:00 tomorrow");
    assert.equal(calendar.focus, null);
    assert.equal(calendar.action.intent, "calendar.create");

    const payment = classify("I have 30 minutes, should I pay my invoices?");
    assert.equal(payment.focus.kind, "next_action");
    assert.equal(payment.approvalRequired, true);
    assert.doesNotMatch(formatInboxClassifierDebug(payment), /Note: focus replies are advisory/);
  });

  it("keeps a session's project out of storage and a factual question out of focus", () => {
    const project = classify("I'm working on my MSc now");
    assert.equal(project.focus.kind, "project_context");
    assert.equal(project.focus.project, "msc");
    assert.equal(project.sideEffecting, false);

    assert.equal(classify("What is a focus session?").focus, null);
    assert.equal(classify("What Todoist tasks are due today?").focus, null);
  });

  it("parses the focus-active flag for in-session debugging", () => {
    assert.deepEqual(parseInboxClassifierDebugArgs(["--focus-active", "I'm stuck"]), {
      json: false,
      focusActive: true,
      actionOptions: {},
      message: "I'm stuck",
    });
  });

  it("formats the focus block without implying an action", () => {
    const output = formatInboxClassifierDebug(classify("I have 45 minutes, what should I do?"));

    assert.match(output, /Likely route: personal \(confidence: high\)/);
    assert.match(output, /Focus:\n- Kind: next_action\n- Available time: 45 minutes\n- Uses the running focus session: no\n- Questions: at most 1/);
    assert.match(output, /- Shape: one primary recommendation with a one-line reason → optional fallback → one thing not worth starting now/);
    assert.match(output, /- Writes: nothing/);
    assert.match(output, /Note: focus replies are advisory; only starting or ending a session writes the local focus record, and nothing is scheduled\./);

    const checkIn = formatInboxClassifierDebug(classify("I found another bug", { focusActive: true }));
    assert.match(checkIn, /- Kind: session_check_in \(trigger: scope\)/);
    assert.match(checkIn, /- Uses the running focus session: yes/);

    const project = formatInboxClassifierDebug(classify("Switch to thesis mode"));
    assert.match(project, /- Project for this session: thesis \(not stored\)/);
    assert.match(project, /- Questions: none/);
  });
});

describe("inbox classifier debug: playbooks", () => {
  const playbookHardStop = /^Stop before saving or changing a playbook without the user's explicit words/;

  it("uses a saved playbook alongside coaching, writing nothing", () => {
    const result = classify("Use my pre-round routine");

    assert.equal(result.selectedAgent, "personal");
    assert.equal(result.playbook.kind, "playbook_use");
    assert.equal(result.playbook.writes, "nothing");
    assert.equal(result.coaching.mode, "pre_performance");
    assert.equal(result.sideEffecting, false);
    assert.ok(result.hardStopPoints.some((point) => playbookHardStop.test(point)));
  });

  it("shows a playbook change as one explicit memory write, not a scheduled-routine change", () => {
    const result = classify("Change my pre-round routine to target, breath, commit");

    assert.equal(result.playbook.kind, "playbook_update");
    assert.equal(result.coaching, null);
    assert.equal(result.sideEffecting, true);
    assert.equal(result.approvalRequired, false);
    assert.match(result.safety.reason, /Saves or changes one playbook in the memory store, only with the user's explicit words/);

    const scheduled = classify("Change my morning-brief routine to 07:30");
    assert.equal(scheduled.playbook, null);
    assert.equal(scheduled.approvalRequired, true);
    assert.equal(scheduled.safety.reason, "Routine mutations require Telegram approval.");
  });

  it("sends a standalone cue word to the coaching setting, not a playbook", () => {
    const result = classify("Change my golf cue word to commit");

    assert.equal(result.playbook.kind, "coaching_setting");
    assert.equal(result.sideEffecting, true);
    assert.equal(result.approvalRequired, false);
    assert.match(result.safety.reason, /coaching setting, such as the golf cue word, with the normal memory command/);
    assert.match(formatInboxClassifierDebug(result), /- Writes: one coaching setting in the memory store/);

    assert.equal(classify("Change the cue in my pre-round routine to commit").playbook.kind, "playbook_update");
  });

  it("offers instead of saving after a passing remark", () => {
    const result = classify("That reset worked really well today");

    assert.equal(result.playbook.kind, "playbook_offer");
    assert.equal(result.sideEffecting, false);
    assert.equal(result.coaching, null);
    assert.match(formatInboxClassifierDebug(result), /Note: playbooks are saved or changed only with the user's explicit words; using, showing, or offering one writes nothing\./);
  });

  it("leaves coaching's own playbook entry, distress, and actions to their paths", () => {
    const entry = classify("Remember my bad-shot reset: exhale, accept, next shot");
    assert.equal(entry.coaching.kind, "playbook");
    assert.equal(entry.playbook, null);

    const distress = classify("I feel hopeless and can't cope");
    assert.equal(distress.coaching.kind, "support");
    assert.equal(distress.playbook, null);

    const task = classify("Add a Todoist task to update my pre-round routine");
    assert.equal(task.playbook, null);
    assert.notEqual(task.action.mode, "answer_only");
  });

  it("formats the playbook block", () => {
    const output = formatInboxClassifierDebug(classify("Add one breath before the target step"));
    assert.match(output, /Playbook:\n- Kind: playbook_update\n- Writes: one playbook in the memory store, with the user's explicit words/);
  });
});
