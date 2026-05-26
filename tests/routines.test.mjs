import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRoutineBrief, routineIds } from "../scripts/lib/routine.mjs";
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

  it("groups groceries by useful store sections", () => {
    assert.deepEqual(food.groceryPlanning.sections, [
      "protein",
      "vegetables",
      "fruit",
      "carbs",
      "dairy-or-alternatives",
      "snacks",
      "breakfast",
      "pantry",
      "backup-meals",
    ]);
  });
});

describe("routine briefs", () => {
  it("builds a memory-aware morning brief", () => {
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
    assert.ok(brief.sections.some((section) => section.id === "calendar"));
    assert.ok(brief.sections.some((section) => section.id === "meal-plan"));
    assert.ok(brief.sections.some((section) => section.id === "workout-anchor"));
    assert.ok(brief.allowedWithoutApproval.includes("summarize-configured-gmail-and-calendar"));
    assert.ok(brief.approvalRequired.some((item) => item.includes("calendar changes")));
    assert.match(brief.telegramPrompt, /Morning Brief/);
    assert.match(brief.telegramPrompt, /Use memory/);
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

  it("builds a weekly review with groceries and one adjustment", () => {
    const brief = buildRoutineBrief("weekly-review", {
      schedules,
      food,
      memoryEntries,
      now: "2026-05-31T17:00:00.000Z",
    });

    assert.equal(brief.routineId, "weekly-review");
    assert.ok(brief.sections.some((section) => section.id === "grocery-plan"));
    assert.ok(brief.sections.some((section) => section.id === "one-adjustment"));
    assert.ok(brief.foodSections.includes("protein"));
    assert.ok(brief.memoryContext.some((line) => line.includes("golf/tee-time")));
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
});
