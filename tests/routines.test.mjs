import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const schedules = JSON.parse(readFileSync("config/schedules.json", "utf8"));
const food = JSON.parse(readFileSync("config/food-planning.json", "utf8"));

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
