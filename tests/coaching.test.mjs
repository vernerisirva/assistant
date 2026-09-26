import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyCoachingRequest,
  coachingModeContracts,
  coachingModes,
} from "../scripts/lib/coaching.mjs";
import { routineIds } from "../scripts/lib/routine.mjs";

const personalPrompt = readFileSync("agents/personal/AGENTS.md", "utf8");
const policy = JSON.parse(readFileSync("config/approval-policy.json", "utf8"));
const schedules = JSON.parse(readFileSync("config/schedules.json", "utf8"));

// The prompt's "Coaching routing examples" and the deterministic classifier
// must agree, so each example is listed once here with its expected result.
const routingExamples = [
  ["Coach me", "ask what it is for", { kind: "coaching", context: "general", mode: "clarify" }],
  ["Pre-round coach", "golf pre-performance setup", { kind: "coaching", context: "golf", mode: "pre_performance" }],
  ["Coach me before my round", "golf pre-performance setup", { kind: "coaching", context: "golf", mode: "pre_performance" }],
  ["I just made a double bogey", "golf in-performance reset", { kind: "coaching", context: "golf", mode: "in_performance" }],
  ["I'm +4 after four holes and getting annoyed", "golf in-performance reset", { kind: "coaching", context: "golf", mode: "in_performance" }],
  ["Help me prepare for my presentation", "work pre-performance setup", { kind: "coaching", context: "work", mode: "pre_performance" }],
  ["Help me focus for the next 45 minutes", "work pre-performance setup", { kind: "coaching", context: "work", mode: "pre_performance" }],
  ["I can't focus", "work quick reset", { kind: "coaching", context: "work", mode: "quick_reset" }],
  ["I'm procrastinating", "work quick reset", { kind: "coaching", context: "work", mode: "quick_reset" }],
  ["I'm distracted in this meeting", "work in-performance reset", { kind: "coaching", context: "work", mode: "in_performance" }],
  ["Sleep coach", "sleep coaching", { kind: "coaching", context: "sleep", mode: "sleep_coaching" }],
  ["Help me wind down tonight", "sleep coaching", { kind: "coaching", context: "sleep", mode: "sleep_coaching" }],
  ["Debrief my round", "golf debrief", { kind: "coaching", context: "golf", mode: "debrief" }],
  ["Debrief today's work", "work debrief", { kind: "coaching", context: "work", mode: "debrief" }],
  ["How do I fix my slice?", "golf technique question, not mental coaching", { kind: "golf_technique", context: "golf", mode: null }],
  ["What is performance anxiety?", "factual question, not coaching", null],
  ["I haven't slept properly for months", "sleep health: suggest a professional assessment, no diagnosis", { kind: "sleep_health", context: "sleep", mode: null }],
  ["I feel hopeless and can't cope", "support first, not coaching", { kind: "support", context: "general", mode: null }],
];

function section(prompt, start, end) {
  const from = prompt.indexOf(start);
  const to = prompt.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return prompt.slice(from, to);
}

function classified(message) {
  const result = classifyCoachingRequest(message);
  return result && { kind: result.kind, context: result.context, mode: result.mode };
}

function expectCoaching(messages, expected) {
  for (const message of messages) {
    assert.deepEqual(classified(message), { kind: "coaching", ...expected }, message);
  }
}

describe("coaching routing", () => {
  it("classifies every prompt routing example the way the prompt says", () => {
    for (const [message, , expected] of routingExamples) {
      assert.deepEqual(classified(message), expected, message);
    }
  });

  it("keeps the prompt's routing examples and this table in step", () => {
    const examples = section(personalPrompt, "Coaching routing examples:", "Confirm-before-action:")
      .split("\n")
      .filter((line) => line.startsWith("- `"));

    assert.deepEqual(
      examples,
      routingExamples.map(([message, label]) => `- \`${message}\` → ${label}`),
    );
  });

  it("recognizes the documented coaching requests", () => {
    for (const message of [
      "coach me", "mental coach", "performance coach", "pre-round coach", "golf mindset",
      "help me stay present", "help me focus", "reset me", "I'm tilting", "I'm frustrated after that hole",
      "help me prepare mentally", "sleep coach", "help me wind down", "debrief my round", "debrief this work session",
    ]) {
      assert.equal(classifyCoachingRequest(message)?.kind, "coaching", message);
    }
  });

  it("treats a curly apostrophe like a straight one", () => {
    assert.deepEqual(classified("I’m procrastinating"), classified("I'm procrastinating"));
  });

  it("sends a stress or lost-focus moment to a quick reset", () => {
    expectCoaching(["Help me reset", "I'm getting angry", "I'm overthinking"], { context: "general", mode: "quick_reset" });
    expectCoaching(
      ["I've been staring at this task for 20 minutes", "I can't focus on work"],
      { context: "work", mode: "quick_reset" },
    );
  });

  it("recognizes active performance as in-performance", () => {
    expectCoaching(
      ["I'm losing confidence with driver", "I'm getting frustrated on the course", "I choked on the last hole"],
      { context: "golf", mode: "in_performance" },
    );
    expectCoaching(["I've lost focus during this work block"], { context: "work", mode: "in_performance" });
  });

  it("recognizes preparation for golf and work performances", () => {
    expectCoaching(["I have first tee nerves"], { context: "golf", mode: "pre_performance" });
    expectCoaching(["Help me prepare mentally for this meeting"], { context: "work", mode: "pre_performance" });
  });

  it("routes sleep coaching to health and other coaching to personal", () => {
    assert.equal(classifyCoachingRequest("Sleep coach — I need to wake at 06:30").agent, "health");
    assert.equal(classifyCoachingRequest("Help me wind down tonight").agent, "health");
    assert.equal(classifyCoachingRequest("Pre-round coach").agent, "personal");
    assert.equal(classifyCoachingRequest("Debrief today's work").agent, "personal");
  });

  it("leaves ordinary meeting prep with admin instead of coaching", () => {
    assert.equal(classifyCoachingRequest("Help me prepare for my meeting with Tobias"), null);
  });

  it("does not answer a factual question with coaching", () => {
    for (const message of ["What is performance anxiety?", "How much sleep do adults need?", "What causes insomnia?"]) {
      assert.equal(classifyCoachingRequest(message), null, message);
    }
  });

  it("does not treat the user's human golf coach as a coaching request", () => {
    assert.equal(classifyCoachingRequest("My golf coach told me to work on my grip"), null);
  });

  it("does not mistake everyday words for actions", () => {
    expectCoaching(["I can't pay attention in this meeting"], { context: "work", mode: "in_performance" });
    expectCoaching(
      ["My to-do list is huge and I can't focus", "I need to focus in order to finish this report"],
      { context: "work", mode: "quick_reset" },
    );
    assert.equal(classifyCoachingRequest("Pay the green fee for Saturday"), null);
  });

  it("keeps a nightly habit or one bad night in sleep coaching", () => {
    expectCoaching(
      [
        "Help me wind down, I scroll my phone every night",
        "I slept badly last night, help me recover",
        "I can't sleep",
        "My bedtime is usually midnight and I can't sleep",
      ],
      { context: "sleep", mode: "sleep_coaching" },
    );
  });

  it("treats a routine mentioned while asking for help as coaching, not a playbook write", () => {
    expectCoaching(["My golf cue word is commit, coach me before my round"], { context: "golf", mode: "pre_performance" });
  });

  it("never masks an action that needs its own classification", () => {
    for (const message of [
      "Help me focus and move my meeting to 3pm",
      "Coach me and add a Todoist task to practice putting",
      "Remind me to do my breathing reset before the meeting",
      "Debrief my round and book golf for Saturday",
      "Help me prepare mentally and send an email to Anna",
      "Put a focus block in my calendar",
    ]) {
      assert.equal(classifyCoachingRequest(message), null, message);
    }
  });
});

describe("coaching mode contracts", () => {
  it("keeps a quick reset concise with at most one question", () => {
    const quickReset = coachingModeContracts[coachingModes.quickReset];
    assert.equal(quickReset.maxQuestions, 1);
    assert.deepEqual(quickReset.shape, ["short acknowledgement", "one question only if needed", "one reset action", "one cue or next step"]);
  });

  it("asks no questions during active performance", () => {
    assert.equal(coachingModeContracts[coachingModes.inPerformance].maxQuestions, 0);
    assert.equal(classifyCoachingRequest("I just made a double bogey").contract.maxQuestions, 0);
  });

  it("allows up to three preparation questions", () => {
    const pre = coachingModeContracts[coachingModes.prePerformance];
    assert.equal(pre.minQuestions, 0);
    assert.equal(pre.maxQuestions, 3);
    assert.ok(pre.shape.includes("one cue word"));
  });

  it("makes a debrief reflective, ending with one thing to keep and one to adjust", () => {
    const debrief = coachingModeContracts[coachingModes.debrief];
    assert.equal(debrief.minQuestions, 3);
    assert.equal(debrief.maxQuestions, 5);
    assert.ok(debrief.shape.includes("one thing to keep"));
    assert.ok(debrief.shape.includes("one thing to adjust"));
    assert.ok(debrief.shape.includes("optional lesson the user may choose to save"));
  });

  it("gives sleep coaching a small schedule plan after at most three questions", () => {
    const sleep = coachingModeContracts[coachingModes.sleep];
    assert.equal(sleep.maxQuestions, 3);
    assert.ok(sleep.shape.includes("one small plan with clock times"));
  });

  it("asks exactly one question when the situation is unknown", () => {
    assert.equal(classifyCoachingRequest("Coach me").contract.maxQuestions, 1);
    assert.equal(classifyCoachingRequest("Coach me").contract.minQuestions, 1);
  });

  it("matches the question budget stated in the prompt", () => {
    assert.match(
      personalPrompt,
      /Ask none when the situation is clear and urgent, at most one for a quick reset, one to three for preparation or sleep, and three to five short prompts for a debrief\./,
    );
  });

  it("gives every mode a contract", () => {
    for (const mode of Object.values(coachingModes)) {
      assert.ok(coachingModeContracts[mode], mode);
    }
  });
});

describe("coaching side effects and memory", () => {
  it("has no side effects for coaching, support, technique, or sleep-health replies", () => {
    for (const message of [
      "Coach me", "I just made a double bogey", "Help me prepare for my presentation", "Sleep coach",
      "Debrief my round", "How do I fix my slice?", "I haven't slept properly for months", "I feel hopeless and can't cope",
    ]) {
      const result = classifyCoachingRequest(message);
      assert.equal(result.sideEffects, "none", message);
      assert.equal(result.approvalRequired, false, message);
    }
  });

  it("does not turn a frustrated self-judgement into memory", () => {
    const result = classifyCoachingRequest("I always choke under pressure");
    assert.equal(result.kind, "coaching");
    assert.equal(result.sideEffects, "none");
  });

  it("recognizes an explicit playbook entry as one low-risk memory write", () => {
    for (const [message, context] of [
      ['My golf cue word is "commit"', "golf"],
      ["Remember my bad-shot reset: exhale, accept, next shot", "golf"],
      ["Use this pre-round routine from now on", "golf"],
      ["My deep-work block is normally 45 minutes", "work"],
      ["My target wake time is 06:30", "sleep"],
    ]) {
      const result = classifyCoachingRequest(message);
      assert.equal(result.kind, "playbook", message);
      assert.equal(result.context, context, message);
      assert.equal(result.agent, "personal", message);
      assert.equal(result.sideEffects, "memory", message);
      assert.equal(result.approvalRequired, false, message);
    }
  });

  it("keeps a playbook entry with a health detail behind sensitive-memory approval", () => {
    const result = classifyCoachingRequest("Remember that my wind-down routine includes my sleeping pills");
    assert.equal(result.kind, "playbook");
    assert.equal(result.approvalRequired, true);
    assert.match(result.reason, /sensitive memory needs Telegram approval/);
  });

  it("does not treat reading the playbook as a write", () => {
    assert.equal(classifyCoachingRequest("What's my cue word?"), null);
  });

  it("adds no scheduled or trusted coaching automation", () => {
    for (const id of routineIds(schedules)) {
      assert.doesNotMatch(id, /coach|mental|mindset|mindful|motivat/i);
    }
    assert.deepEqual(policy.trustedRoutines.map((routine) => routine.id), ["weekly-plan"]);
    assert.ok(!policy.allowedWithoutExtraApproval.some((action) => /coach/i.test(action)));
  });
});

describe("coaching safety", () => {
  it("treats ordinary frustration as performance emotion, not a clinical problem", () => {
    for (const message of [
      "I'm getting frustrated on the course",
      "I'm so angry after that hole",
      "I'm annoyed with myself",
      "I'm tilting",
      "I keep slicing it and I'm getting frustrated",
    ]) {
      const result = classifyCoachingRequest(message);
      assert.equal(result.kind, "coaching", message);
      assert.doesNotMatch(JSON.stringify(result), /diagnos|disorder|symptom|therap|patholog|clinical/i, message);
    }
  });

  it("drops the coaching frame for significant distress", () => {
    for (const message of [
      "I feel hopeless and can't cope",
      "I don't want to be here anymore",
      "I've been having panic attacks every day",
    ]) {
      const result = classifyCoachingRequest(message);
      assert.equal(result.kind, "support", message);
      assert.equal(result.mode, null, message);
      assert.match(result.reason, /urgent help first/);
    }
  });

  it("hands persistent or severe sleep trouble to health without a diagnosis", () => {
    for (const message of [
      "I haven't slept properly for months",
      "I've been waking up at 3am every night for weeks",
      "I snore loudly and wake up gasping",
      "Should I take melatonin to sleep?",
      "I think I have insomnia",
    ]) {
      const result = classifyCoachingRequest(message);
      assert.equal(result.kind, "sleep_health", message);
      assert.equal(result.agent, "health", message);
      assert.match(result.reason, /no diagnosis/);
      assert.match(result.reason, /doctor or 1177/);
    }
  });

  it("does not silently turn an explicit swing question into mental coaching", () => {
    for (const message of ["How do I fix my slice?", "What's wrong with my grip?", "Give me swing tips for my driver"]) {
      const result = classifyCoachingRequest(message);
      assert.equal(result.kind, "golf_technique", message);
      assert.match(result.reason, /golf coach/);
      assert.match(result.reason, /not recast it as a purely mental problem/);
    }
  });
});
