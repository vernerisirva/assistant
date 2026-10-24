import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { buildRoutineBrief, buildRoutineNotice, routineIds } from "../scripts/lib/routine.mjs";
import { parseRoutineArgs, runRoutineCli } from "../scripts/routine.mjs";

const schedules = JSON.parse(readFileSync("config/schedules.json", "utf8"));
const food = JSON.parse(readFileSync("config/food-planning.json", "utf8"));
const memoryEntries = [
  {
    id: "mem-food",
    category: "food",
    key: "breakfast",
    value: "likes Greek yogurt with berries",
    sensitivity: "low",
  },
  {
    id: "mem-tone",
    category: "tone",
    key: "telegram",
    value: "prefers concise Telegram messages",
    sensitivity: "low",
  },
  {
    id: "mem-golf",
    category: "golf",
    key: "tee-time",
    value: "prefers morning tee times",
    sensitivity: "low",
  },
];

describe("routine schedules", () => {
  it("uses Europe/Stockholm and defines daily assistant routines", () => {
    assert.equal(schedules.timezone, "Europe/Stockholm");
    assert.deepEqual(
      schedules.daily.map((routine) => routine.id),
      ["morning-brief", "midday-check-in", "workout-window", "evening-review"],
    );
  });

  it("defines the Sunday weekly review", () => {
    assert.equal(schedules.weekly.id, "weekly-review");
    assert.equal(schedules.weekly.day, "Sunday");
  });

  it("exposes every configured routine id", () => {
    assert.deepEqual(routineIds(schedules), [
      "morning-brief",
      "midday-check-in",
      "workout-window",
      "evening-review",
      "weekly-review",
    ]);
  });
});

describe("food planning defaults", () => {
  it("keeps daily meal planning and grocery planning enabled", () => {
    assert.equal(food.dailyMealPlan.enabled, true);
    assert.equal(food.groceryPlanning.enabled, true);
  });

  it("groups groceries by store section, with no snack, breakfast or backup top-up sections", () => {
    assert.deepEqual(food.groceryPlanning.sections, [
      "produce",
      "bread",
      "meat-fish",
      "dairy",
      "dry-goods",
      "canned",
      "frozen",
      "other",
    ]);
    assert.ok(food.groceryPlanning.principles.includes("only-what-planned-dishes-need"));
  });
});

describe("routine briefs", () => {
  it("builds a concise, read-only morning plan with practical sections", () => {
    const brief = buildRoutineBrief("morning-brief", {
      schedules,
      food,
      memoryEntries,
      now: "2026-05-26T06:00:00.000Z",
    });

    assert.equal(brief.routineId, "morning-brief");
    assert.equal(brief.agent, "personal");
    assert.equal(brief.title, "Morning Brief");
    assert.ok(brief.memoryContext.some((line) => line.includes("food/breakfast")));
    assert.ok(brief.memoryContext.some((line) => line.includes("tone/telegram")));
    assert.deepEqual(
      brief.sections.map((section) => section.id),
      [
        "calendar-pressure",
        "must-do-tasks",
        "quick-wins",
        "health-routine-anchor",
        "one-thing-to-avoid",
        "suggested-day-plan",
        "proposed-changes",
      ],
    );
    assert.match(brief.sections[0].instruction, /today's calendar pressure/i);
    assert.match(brief.sections[1].instruction, /up to 3/i);
    assert.match(brief.sections[2].instruction, /1-2/i);
    assert.match(brief.sections[3].instruction, /one realistic/i);
    assert.match(brief.sections[4].instruction, /one thing to avoid/i);
    assert.match(brief.sections[5].instruction, /morning, midday, and afternoon/i);
    assert.match(brief.sections[6].instruction, /only if useful/i);
    assert.ok(brief.allowedWithoutApproval.includes("summarize-configured-gmail-and-calendar"));
    assert.ok(brief.approvalRequired.some((item) => item.includes("calendar changes")));
    assert.match(brief.telegramPrompt, /Morning Brief/);
    assert.match(brief.telegramPrompt, /Use memory/);
    assert.match(brief.telegramPrompt, /Morning brief rules/i);
    assert.match(brief.telegramPrompt, /short enough for Telegram/i);
    assert.match(brief.telegramPrompt, /Calendar, Gmail, Todoist, food, health, and memory context only as read-only inputs/i);
    assert.match(brief.telegramPrompt, /Proposed Todoist or Calendar changes only if useful/i);
    assert.match(brief.telegramPrompt, /Do not modify Todoist, Calendar, Gmail, memory, or routines from the morning brief/i);
    assert.match(brief.telegramPrompt, /Do not send email, edit Calendar events, book anything, make purchases, or submit browser forms/i);
  });

  it("builds an evening review with memory suggestion boundaries", () => {
    const brief = buildRoutineBrief("evening-review", {
      schedules,
      food,
      memoryEntries,
      now: "2026-05-26T19:00:00.000Z",
    });

    assert.equal(brief.routineId, "evening-review");
    assert.ok(brief.sections.some((section) => section.id === "tomorrow"));
    assert.ok(brief.sections.some((section) => section.id === "memory-suggestions"));
    assert.match(brief.memoryRule, /ask before storing inferred memories/i);
  });

  it("builds a workout-window prompt that adapts to training, golf, rest, and skip signals", () => {
    const brief = buildRoutineBrief("workout-window", {
      schedules,
      food,
      memoryEntries,
      now: "2026-06-11T15:30:00.000Z",
    });

    assert.equal(brief.routineId, "workout-window");
    assert.equal(brief.agent, "health");
    assert.ok(brief.sections.some((section) => section.id === "day-type"));
    assert.ok(brief.sections.some((section) => /training day/i.test(section.instruction)));
    // A suggested workout is a prescription, not "a push and a pull".
    assert.match(brief.telegramPrompt, /named exercises, sets × reps or time, rest and total minutes/);
    assert.match(brief.telegramPrompt, /named movements with hold times or repetitions/);
    assert.ok(brief.sections.some((section) => /golf\/active day/i.test(section.instruction)));
    assert.ok(brief.sections.some((section) => /rest\/no-workout day/i.test(section.instruction)));
    assert.match(brief.telegramPrompt, /First classify today as training, golf\/active, rest\/no-workout, or unclear/i);
    assert.match(brief.telegramPrompt, /If today is rest\/no-workout/i);
    assert.match(brief.telegramPrompt, /offer to skip today's workout-window/i);
    assert.match(brief.telegramPrompt, /If the day type is unclear, ask one concise question/i);
  });

  it("does not expose sensitive memories in routine context", () => {
    const brief = buildRoutineBrief("morning-brief", {
      schedules,
      food,
      memoryEntries: [
        {
          id: "mem-private",
          category: "private",
          key: "health",
          value: "sensitive detail",
          sensitivity: "sensitive",
        },
      ],
      now: "2026-05-26T06:00:00.000Z",
    });

    assert.deepEqual(brief.memoryContext, ["No stored preferences yet."]);
    assert.doesNotMatch(brief.telegramPrompt, /sensitive detail/);
  });

  it("builds a weekly review that looks only for decisions, never a recap of the week", () => {
    const brief = buildRoutineBrief("weekly-review", {
      schedules,
      food,
      memoryEntries,
      now: "2026-05-31T17:00:00.000Z",
    });

    assert.equal(brief.routineId, "weekly-review");
    assert.equal(brief.scheduled, false);
    assert.deepEqual(
      brief.sections.map((section) => section.id),
      ["decision", "change", "deadline", "approval", "conflict", "not-news"],
    );
    assert.match(brief.telegramPrompt, /Look at the coming week and what is still open from this one for:/);
    assert.match(brief.telegramPrompt, /- deadline: A deadline that needs a choice, not just doing a task already planned in Todoist\./);
    assert.match(brief.telegramPrompt, /- not-news: Leave out what is already planned in Todoist or the weekly plan \(tasks, workouts, stretching, meals, prep, shopping\)/);
    assert.doesNotMatch(brief.telegramPrompt, /week-recap|unfinished-tasks|health-routines|top-3-priorities|stop-or-simplify|top 3 priorities/i);
    assert.ok(brief.foodSections.includes("meat-fish"));
    assert.ok(brief.memoryContext.some((line) => line.includes("golf/tee-time")));
    // Asked for in chat it always answers, in the same shape as a scheduled notice.
    assert.match(brief.telegramPrompt, /at most 3 items, each as What changed, Why it matters and Decision needed, with a Deadline or Source when known\. If nothing qualifies, say so in one line\./);
    assert.doesNotMatch(brief.telegramPrompt, /NO_REPLY|findings-json-stdin/);
    assert.match(brief.telegramPrompt, /Proposed actions only/i);
    assert.match(brief.telegramPrompt, /Todoist or Calendar/i);
    assert.match(brief.telegramPrompt, /confirmation/i);
    assert.match(brief.telegramPrompt, /Do not modify Todoist, Calendar, Gmail, memory, or routines/i);
    assert.match(brief.telegramPrompt, /Keep this short enough for Telegram/i);
  });

  it("turns every scheduled routine into an attention check that hands its findings to the notice", () => {
    for (const routineId of routineIds(schedules)) {
      const brief = buildRoutineBrief(routineId, { schedules, food, memoryEntries, now: "2026-10-20T15:30:00.000Z", scheduled: true });

      assert.equal(brief.scheduled, true);
      assert.deepEqual(brief.sections.map((section) => section.id), ["decision", "change", "deadline", "approval", "conflict", "not-news"], routineId);
      assert.match(brief.telegramPrompt, new RegExp(`^${brief.title} \\(${brief.agent}\\), scheduled\\n`));
      assert.match(brief.telegramPrompt, /Nobody asked for this message\. The user follows Todoist directly, so write only about what needs their attention, and never make up a decision to have something to send\./);
      assert.match(brief.telegramPrompt, /News about something that also has a Todoist task is still news: say what changed, never what the task says\./);
      assert.ok(brief.telegramPrompt.includes(`to npm run --silent routine -- ${routineId} --scheduled --findings-json-stdin through a quoted heredoc, and return its text exactly as your final answer. With nothing to report submit {"items": []}; the text is then NO_REPLY.`), routineId);
      assert.match(brief.telegramPrompt, /never ask about timing, tone or detail level/);
      // No section asks for a workout, a start time, a tip or a question.
      assert.doesNotMatch(brief.telegramPrompt, /suggest one primary workout|sets × reps or time|hydration|energy or stress question|quick wins|suggested-day-plan|Draft or recommend freely/i, routineId);
    }
    assert.match(buildRoutineBrief("workout-window", { schedules, food, scheduled: true }).telegramPrompt, /Look at this evening for:/);
    assert.match(buildRoutineBrief("midday-check-in", { schedules, food, scheduled: true }).telegramPrompt, /Look at the rest of today for:/);
  });

  it("keeps a briefing the user asks for as it was", () => {
    const asked = buildRoutineBrief("workout-window", { schedules, food, memoryEntries, now: "2026-10-20T15:30:00.000Z" });
    const scheduled = buildRoutineBrief("workout-window", { schedules, food, memoryEntries, now: "2026-10-20T15:30:00.000Z", scheduled: true });

    assert.equal(asked.scheduled, false);
    assert.equal(asked.sections.find((section) => section.id === "workout").instruction, "For a training day, suggest one primary workout and one lighter fallback, each with named exercises, sets × reps or time, rest and total minutes.");
    assert.match(asked.telegramPrompt, /^Workout Window \(health\)\n/);
    assert.match(asked.telegramPrompt, /Draft or recommend freely; ask for approval before side effects\./);
    assert.doesNotMatch(asked.telegramPrompt, /NO_REPLY|findings-json-stdin|Nobody asked/);
    assert.notEqual(asked.telegramPrompt, scheduled.telegramPrompt);
  });
});

describe("scheduled routine notice", () => {
  const now = new Date("2026-10-25T17:00:00.000Z");
  const notice = (items, routineId = "weekly-review") => buildRoutineNotice(routineId, { items }, { schedules, now });
  const decision = {
    kind: "decision",
    whatChanged: "Two offers for the November golf trip arrived; the cheaper one expires Wednesday.",
    whyItMatters: "Waiting past Wednesday loses the 1,200 kr difference.",
    decision: "Pick an offer, or let both go.",
    deadline: "2026-10-28",
    source: "Gmail, Golfresor 24 Oct",
  };

  it("sends exactly NO_REPLY when nothing qualifies", () => {
    assert.deepEqual(notice([]), { routineId: "weekly-review", text: "NO_REPLY", included: 0, dropped: [] });
  });

  it("writes a real decision as What changed, Why it matters and Decision needed, with its deadline and source", () => {
    const result = notice([decision]);
    assert.equal(
      result.text,
      [
        "What changed: Two offers for the November golf trip arrived; the cheaper one expires Wednesday.",
        "Why it matters: Waiting past Wednesday loses the 1,200 kr difference.",
        "Decision needed: Pick an offer, or let both go.",
        "Deadline: Wed 28 Oct 2026",
        "Source: Gmail, Golfresor 24 Oct",
      ].join("\n"),
    );
    assert.equal(result.included, 1);
    assert.equal(notice([{ ...decision, deadline: "2026-10-28 12:00" }]).text.split("\n")[3], "Deadline: Wed 28 Oct 2026, 12:00");
    assert.doesNotMatch(result.text, /\?$|timing|tone|detail/i);
  });

  it("drops what isn't news and says why, so nothing unchecked reaches the user", () => {
    const result = notice([
      { kind: "reminder", whatChanged: "Today is gym day: Todoist has Helkropp A and 15 minutes of mobility.", whyItMatters: "It is planned.", decision: "Train tonight." },
      { ...decision, kind: "decision", decision: "Start at 18:00 with Knäböj 3 × 8, vila 2 min." },
      { ...decision, decision: "Would you like to change the time, tone or detail level of these check-ins?" },
      { ...decision, decision: "Vill du ändra tidpunkt, ton eller detaljnivå på dessa check-ins?" },
      { ...decision, kind: "change", source: "" },
      { ...decision, kind: "deadline", deadline: undefined },
      { ...decision, deadline: "2026-10-24" },
      { ...decision, deadline: "2026-02-30" },
      { ...decision, whyItMatters: "" },
      "not an object",
    ]);

    assert.equal(result.text, "NO_REPLY");
    assert.deepEqual(
      result.dropped.map((entry) => [entry.index, entry.problems]),
      [
        [0, ["kind must be decision, change, deadline, approval, conflict: a planned task, workout, meal or recap is not news"]],
        [1, ["an exercise prescription: planned sessions stay in Todoist"]],
        [2, ["a question about Hilla's own messages: the user can ask for changes any time"]],
        [3, ["a question about Hilla's own messages: the user can ask for changes any time"]],
        [4, ["a change needs its source"]],
        [5, ["a deadline needs its verified date"]],
        [6, ["the deadline has passed"]],
        [7, ["deadline must be YYYY-MM-DD or YYYY-MM-DD HH:mm"]],
        [8, ["whyItMatters is missing"]],
        [9, ["not an object"]],
      ],
    );
  });

  it("sends at most three findings and keeps each one to its lines", () => {
    const result = notice([1, 2, 3, 4].map((n) => ({ ...decision, whatChanged: `Offer ${n}\n\narrived from Golfresor.`, deadline: null })));
    assert.equal(result.included, 3);
    assert.deepEqual(result.dropped, [{ index: 3, problems: ["more than 3 items; send only the most important"] }]);
    assert.equal(result.text.split("\n\n").length, 3);
    assert.match(result.text, /^What changed: Offer 1 arrived from Golfresor\.\n/);
  });

  it("refuses findings that are not the expected JSON, and unknown routines", () => {
    assert.throws(() => buildRoutineNotice("weekly-review", { findings: [] }, { schedules, now }), /Findings must be a JSON object like \{"items": \[\]\}/);
    assert.throws(() => buildRoutineNotice("daily-digest", { items: [] }, { schedules, now }), /Unknown routine: daily-digest/);
  });
});

describe("routine CLI", () => {
  it("parses routine commands", () => {
    assert.deepEqual(parseRoutineArgs(["morning-brief", "--date", "2026-05-26"]), {
      command: "morning-brief",
      options: { date: "2026-05-26" },
    });
  });

  it("runs routine commands with supplied memory entries", async () => {
    const result = await runRoutineCli(["midday-check-in"], {
      schedules,
      food,
      memoryEntries,
      now: "2026-05-26T10:30:00.000Z",
    });

    assert.equal(result.routineId, "midday-check-in");
    assert.equal(result.agent, "health");
    assert.ok(result.sections.some((section) => section.id === "food"));
    assert.match(result.telegramPrompt, /Midday Check-In/);
  });

  it("parses the scheduled flags, and keeps findings for scheduled runs only", () => {
    assert.deepEqual(parseRoutineArgs(["weekly-review", "--scheduled"]), { command: "weekly-review", options: { scheduled: true } });
    assert.deepEqual(parseRoutineArgs(["weekly-review", "--scheduled", "--findings-json-stdin"]), {
      command: "weekly-review",
      options: { scheduled: true, findingsJsonStdin: true },
    });
    assert.throws(() => parseRoutineArgs(["weekly-review", "--findings-json-stdin"]), /only for a scheduled run: add --scheduled/);
    assert.throws(() => parseRoutineArgs(["weekly-review", "--loud", "yes"]), /Unknown routine option: --loud/);
  });

  it("prints the notice for findings piped on stdin", async () => {
    const run = (input) =>
      runRoutineCli(["weekly-review", "--scheduled", "--findings-json-stdin"], { schedules, food, memoryEntries, now: "2026-10-25T17:00:00.000Z", stdin: Readable.from([input]) });

    assert.equal((await run('{"items": []}')).text, "NO_REPLY");
    const decided = await run(JSON.stringify({ items: [{ kind: "approval", whatChanged: "Next week's plan waits for your OK.", whyItMatters: "Nothing is created until you answer.", decision: "Reply OK, ask for a change, or cancel it." }] }));
    assert.equal(decided.text, "What changed: Next week's plan waits for your OK.\nWhy it matters: Nothing is created until you answer.\nDecision needed: Reply OK, ask for a change, or cancel it.");
    await assert.rejects(run('{"items": [ {"kind": "decision", "whatChanged": "private detail"'), (error) => {
      assert.match(error.message, /^The findings are not valid JSON/);
      assert.doesNotMatch(error.message, /private detail/);
      return true;
    });
    await assert.rejects(run(""), /needs JSON on stdin/);
  });
});
