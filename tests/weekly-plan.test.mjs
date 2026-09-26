import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TARGET_KEYS,
  WEEKLY_PLAN_AUTHORIZATION,
  addDays,
  applyWeeklyPlanChanges,
  buildInitialPlanInputs,
  buildWeeklyPlan,
  checkWeeklyPlanOperation,
  classifyExistingTask,
  computeReviewDeadline,
  digestPlan,
  formatLocalDateTime,
  isWeeklyPlanAcceptance,
  isoWeekId,
  nextWeekStart,
  operationRequestId,
  resolvePlanDay,
  weekdayIndex,
} from "../scripts/lib/weekly-plan.mjs";

const config = JSON.parse(readFileSync("config/weekly-plan.json", "utf8"));
const food = JSON.parse(readFileSync("config/food-planning.json", "utf8"));
const policy = JSON.parse(readFileSync("config/approval-policy.json", "utf8"));
const WEEK = "2026-09-28";

function planFor(input = {}, options = {}) {
  const inputs = buildInitialPlanInputs(input, { config, weekStart: WEEK, ...options });
  return { inputs, plan: buildWeeklyPlan(inputs, { config, food }) };
}

function datesOf(plan, activity) {
  return plan.placements.filter((entry) => entry.activity === activity).map((entry) => entry.date);
}

function opsOf(plan, activity) {
  return plan.operations.filter((operation) => operation.activity === activity);
}

function revise(previous, changes) {
  const { inputs, summary } = applyWeeklyPlanChanges(previous.inputs, previous.plan, changes, { config });
  return { inputs, summary, plan: buildWeeklyPlan(inputs, { config, food }) };
}

function everyText(plan) {
  return JSON.stringify({ food: plan.food, shopping: plan.shopping, operations: plan.operations }).toLowerCase();
}

describe("weekly plan dates", () => {
  it("plans the Monday-Sunday week after a Saturday in Europe/Stockholm", () => {
    assert.equal(nextWeekStart(new Date("2026-09-26T07:00:00Z")), "2026-09-28");
    // 23:30 UTC on Sunday is already Monday in Stockholm, so the plan is for the week after.
    assert.equal(nextWeekStart(new Date("2026-09-27T23:30:00Z")), "2026-10-05");
    assert.equal(isoWeekId("2026-09-28"), "2026-W40");
    assert.equal(isoWeekId("2026-12-28"), "2026-W53");
    assert.equal(isoWeekId("2027-01-04"), "2027-W01");
  });

  it("resolves weekday names and in-week dates, and rejects anything else", () => {
    assert.equal(resolvePlanDay("Friday", WEEK), "2026-10-02");
    assert.equal(resolvePlanDay("sun", WEEK), "2026-10-04");
    assert.equal(resolvePlanDay("2026-09-30", WEEK), "2026-09-30");
    assert.throws(() => resolvePlanDay("2026-10-05", WEEK), /not part of the plan week/);
    assert.throws(() => resolvePlanDay("someday", WEEK), /Unknown day/);
  });
});

describe("weekly plan review window", () => {
  it("applies 12 hours after display: shown 09:00, applied 21:00 Stockholm time", () => {
    const deadline = computeReviewDeadline("2026-09-26T07:00:00.000Z");
    assert.equal(deadline, "2026-09-26T19:00:00.000Z");
    assert.equal(formatLocalDateTime(deadline), "21:00 on Saturday 26 Sep");
  });

  it("rounds up to the next apply check so the stated time is when it happens", () => {
    assert.equal(computeReviewDeadline("2026-09-26T07:02:00.000Z"), "2026-09-26T19:15:00.000Z");
    assert.equal(computeReviewDeadline("2026-09-26T07:15:00.000Z"), "2026-09-26T19:15:00.000Z");
  });

  it("counts elapsed hours across the autumn DST change, never fewer than 12", () => {
    // 20:30 CEST on Saturday 24 Oct; clocks go back one hour that night.
    const shown = "2026-10-24T18:30:00.000Z";
    const deadline = computeReviewDeadline(shown);
    assert.equal(Date.parse(deadline) - Date.parse(shown), 12 * 3_600_000);
    assert.equal(formatLocalDateTime(deadline), "07:30 on Sunday 25 Oct");
  });

  it("counts elapsed hours across the spring DST change, so the window is not shortened", () => {
    // 20:30 CET on Saturday 27 Mar 2027; clocks go forward one hour that night.
    const shown = "2027-03-27T19:30:00.000Z";
    const deadline = computeReviewDeadline(shown);
    assert.equal(Date.parse(deadline) - Date.parse(shown), 12 * 3_600_000);
    assert.equal(formatLocalDateTime(deadline), "09:30 on Sunday 28 Mar");
  });
});

describe("weekly plan generation", () => {
  it("covers food, shopping, gym, stretching, golf rounds and golf practice", () => {
    const { plan } = planFor();

    for (const activity of TARGET_KEYS) {
      assert.equal(datesOf(plan, activity).length, config.defaultTargets[activity], activity);
      assert.equal(opsOf(plan, activity).length, config.defaultTargets[activity], activity);
    }
    assert.equal(plan.food.prep.length, config.defaultTargets.mealPrep);
    assert.ok(plan.food.prep.every((session) => session.mealId && session.portions > 0));
    assert.ok(plan.food.breakfast.length > 0);
    assert.ok(plan.food.backup);
    assert.ok(plan.shopping.itemCount > 0);
    assert.equal(opsOf(plan, "shopping").length, 1);
    assert.equal(opsOf(plan, "shopping")[0].payload.content, "Grocery shopping for next week");
  });

  it("honours configurable counts for every activity", () => {
    const targets = { gym: 4, golfRound: 2, golfPractice: 3, stretch: 5, mealPrep: 3 };
    const { plan } = planFor({ targets });

    for (const [activity, count] of Object.entries(targets)) {
      assert.equal(opsOf(plan, activity).length, count, activity);
      assert.equal(new Set(datesOf(plan, activity)).size, count, `${activity} is at most once per day`);
    }
  });

  it("accepts zero for every optional activity", () => {
    const { plan } = planFor({ targets: { gym: 0, golfRound: 0, golfPractice: 0, stretch: 0, mealPrep: 0 } });

    assert.equal(plan.placements.length, 0);
    assert.deepEqual(plan.food.prep, []);
    // Breakfast and snacks still need buying, so one shopping task remains.
    assert.deepEqual(plan.operations.map((operation) => operation.activity), ["shopping"]);
  });

  it("rejects counts outside 0-7 and unknown activities", () => {
    assert.throws(() => planFor({ targets: { gym: 8 } }), /from 0 to 7/);
    assert.throws(() => planFor({ targets: { gym: -1 } }), /from 0 to 7/);
    assert.throws(() => planFor({ targets: { swimming: 1 } }), /Unknown activity/);
    assert.throws(() => planFor({ surprise: true }), /Unknown field/);
  });

  it("keeps unavailable days free and demanding sessions off heavy days", () => {
    const { plan } = planFor({ days: { wednesday: "unavailable", thursday: { load: "heavy", note: "Work trip" } } });

    assert.ok(plan.placements.every((entry) => entry.date !== "2026-09-30"));
    for (const activity of ["gym", "golfRound", "golfPractice", "mealPrep"]) {
      assert.ok(!datesOf(plan, activity).includes("2026-10-01"), `${activity} avoids the heavy day`);
    }
  });

  it("treats golf as physical load: no gym on a golf-round day or next to it when avoidable", () => {
    const { plan } = planFor({ targets: { gym: 2, golfRound: 2 } });
    const rounds = datesOf(plan, "golfRound");
    const gyms = datesOf(plan, "gym");

    for (const gym of gyms) {
      assert.ok(!rounds.includes(gym));
      assert.ok(!rounds.includes(addDays(gym, 1)) && !rounds.includes(addDays(gym, -1)), `gym on ${gym} is next to a round`);
    }
  });

  it("spreads gym sessions instead of stacking them on adjacent days", () => {
    const { plan } = planFor({ targets: { gym: 3 } });
    const indexes = datesOf(plan, "gym").map(weekdayIndex).sort();

    for (let index = 1; index < indexes.length; index += 1) {
      assert.ok(indexes[index] - indexes[index - 1] >= 2, `gyms at ${indexes.join(",")}`);
    }
  });

  it("puts golf rounds on the preferred weekend days and respects avoided days", () => {
    const { plan } = planFor({ preferences: { gym: { avoidDays: ["monday", "tuesday"] } } });

    assert.deepEqual(datesOf(plan, "golfRound"), ["2026-10-04"]);
    assert.ok(datesOf(plan, "gym").every((date) => !["2026-09-28", "2026-09-29"].includes(date)));
  });

  it("counts existing Todoist activities toward targets without duplicating or changing them", () => {
    const existingTasks = [
      { id: "1", content: "Gym", due: { date: "2026-09-29" } },
      { id: "2", content: "Golf round: Bro Hof", due: { date: "2026-10-03T10:00:00" } },
      { id: "3", content: "Buy a new gym card", due: { date: "2026-09-30" } },
      { id: "4", content: "Gym", due: { date: "2026-10-06" } },
    ];
    const snapshot = structuredClone(existingTasks);
    const { plan } = planFor({ existingTasks });

    assert.deepEqual(existingTasks, snapshot);
    assert.equal(opsOf(plan, "gym").length, 1);
    assert.ok(opsOf(plan, "gym").every((operation) => operation.date !== "2026-09-29"));
    assert.equal(opsOf(plan, "golfRound").length, 0);
    const tuesday = plan.schedule.find((day) => day.date === "2026-09-29");
    assert.deepEqual(tuesday.activities.find((activity) => activity.activity === "gym"), {
      activity: "gym",
      status: "existing",
      title: "Gym",
    });
    // Only creation operations exist; nothing refers to an existing task id.
    assert.ok(plan.operations.every((operation) => operation.kind === "create-task"));
  });

  it("classifies existing tasks conservatively", () => {
    assert.equal(classifyExistingTask("Gym — Tuesday"), "gym");
    assert.equal(classifyExistingTask("Golf round: Sunday"), "golfRound");
    assert.equal(classifyExistingTask("Golf practice: wedges"), "golfPractice");
    assert.equal(classifyExistingTask("Golf Monday: range"), "golfPractice");
    assert.equal(classifyExistingTask("Stretch 15 min"), "stretch");
    assert.equal(classifyExistingTask("Meal prep"), "mealPrep");
    assert.equal(classifyExistingTask("Grocery shopping for next week"), "shopping");
    assert.equal(classifyExistingTask("Buy a new gym card"), null);
    assert.equal(classifyExistingTask("Call the golf club about membership"), null);
  });

  it("builds a shopping list that matches the food plan, with quantities", () => {
    const { plan } = planFor();
    const items = plan.shopping.sections.flatMap((section) => section.items);
    const chicken = items.find((item) => item.name === "Chicken breast");

    assert.equal(chicken.quantity, "450 g");
    assert.equal(plan.shopping.date, plan.food.prep[0].date);
    const description = opsOf(plan, "shopping")[0].payload.description;
    assert.match(description, /^Protein:\n- Chicken breast \(450 g\)/);
    assert.match(description, /\n\nFor:\n- Chicken, rice and vegetables x3/);
  });

  it("writes concrete stretch and training details through the Todoist pipeline", () => {
    const { plan } = planFor();
    const stretch = opsOf(plan, "stretch")[0].payload;
    const gym = opsOf(plan, "gym")[0].payload;

    assert.match(stretch.content, /^Stretch — (Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day$/);
    assert.match(stretch.description, /^15 min mobility:\n- /);
    assert.ok(stretch.description.split("\n").length >= 4);
    assert.match(gym.content, /^Gym — /);
    assert.equal(gym.due_string, opsOf(plan, "gym")[0].date);
    assert.deepEqual(Object.keys(gym).sort(), ["content", "description", "due_string"]);
  });

  it("is deterministic and digests identical plans identically", () => {
    assert.equal(digestPlan(planFor().plan), digestPlan(planFor().plan));
    assert.notEqual(digestPlan(planFor().plan), digestPlan(planFor({ targets: { gym: 3 } }).plan));
    assert.equal(operationRequestId("wp-2026-W40-abc", 2, "gym:2026-09-28").length, 36);
    assert.equal(
      operationRequestId("wp-2026-W40-abc", 2, "gym:2026-09-28"),
      operationRequestId("wp-2026-W40-abc", 2, "gym:2026-09-28"),
    );
  });

  it("uses previous targets when the agent supplies none, and explicit ones otherwise", () => {
    const previousTargets = { gym: 3, golfRound: 2, golfPractice: 2, stretch: 4, mealPrep: 1 };
    assert.deepEqual(planFor({}, { previousTargets }).plan.targets, previousTargets);
    assert.equal(planFor({ targets: { gym: 1 } }, { previousTargets }).plan.targets.gym, 1);
  });
});

describe("weekly plan modifications", () => {
  it('"Gym 3 times" adds a session and keeps the existing ones where they were', () => {
    const before = planFor();
    const after = revise(before, { targets: { gym: 3 } });

    assert.equal(opsOf(after.plan, "gym").length, 3);
    for (const date of datesOf(before.plan, "gym")) assert.ok(datesOf(after.plan, "gym").includes(date));
    assert.deepEqual(after.summary, ["Gym 2 → 3"]);
  });

  it('"No golf" removes golf rounds', () => {
    const after = revise(planFor(), { targets: { golfRound: 0 } });
    assert.equal(opsOf(after.plan, "golfRound").length, 0);
    assert.equal(after.plan.targets.golfRound, 0);
  });

  it('"Two golf practices" and "Stretch four times" change those counts', () => {
    const after = revise(planFor(), { targets: { golfPractice: 2, stretch: 4 } });
    assert.equal(opsOf(after.plan, "golfPractice").length, 2);
    assert.equal(opsOf(after.plan, "stretch").length, 4);
  });

  it('"Move Friday gym to Sunday" moves exactly that session', () => {
    const before = planFor({ preferences: { gym: { preferredDays: ["tuesday", "friday"] } } });
    assert.ok(datesOf(before.plan, "gym").includes("2026-10-02"));

    const after = revise(before, { moves: [{ activity: "gym", from: "friday", to: "sunday" }] });
    assert.ok(!datesOf(after.plan, "gym").includes("2026-10-02"));
    assert.ok(datesOf(after.plan, "gym").includes("2026-10-04"));
    assert.ok(datesOf(after.plan, "gym").includes("2026-09-29"));
    assert.deepEqual(after.summary, ["Gym Fri → Sun"]);
  });

  it("refuses to move an existing Todoist task or a session that is not planned", () => {
    const before = planFor({ existingTasks: [{ content: "Gym", due: { date: "2026-10-02" } }] });
    assert.throws(
      () => revise(before, { moves: [{ activity: "gym", from: "friday", to: "sunday" }] }),
      /existing Todoist task; the weekly plan does not move existing tasks/,
    );
    assert.throws(
      () => revise(planFor(), { moves: [{ activity: "golfRound", from: "monday", to: "tuesday" }] }),
      /no planned golf round on Monday/,
    );
  });

  it('"No salmon" removes salmon from the food plan, the shopping list and every task', () => {
    const before = planFor();
    assert.match(everyText(before.plan), /salmon/);

    const after = revise(before, { excludeIngredients: ["Salmon"] });
    assert.doesNotMatch(everyText(after.plan), /salmon/);
    assert.equal(after.plan.food.prep.length, 2);
    assert.ok(after.plan.food.prep.every((session) => session.mealId));
  });

  it('"Add bananas" adds them to the shopping list and the shopping task', () => {
    const after = revise(planFor(), { addShopping: [{ name: "bananas", section: "fruit" }] });
    const fruit = after.plan.shopping.sections.find((section) => section.id === "fruit");

    assert.ok(fruit.items.some((item) => item.name === "Bananas"));
    assert.match(opsOf(after.plan, "shopping")[0].payload.description, /- Bananas/);
  });

  it('"Add pasta" adds a pasta meal and its ingredients', () => {
    const after = revise(planFor(), { addMeals: ["turkey-pasta"] });
    assert.deepEqual(after.plan.food.extras.map((meal) => meal.mealId), ["turkey-pasta"]);
    assert.match(everyText(after.plan), /turkey mince/);
  });

  it('"Meal prep once" leaves one session and a matching shopping list', () => {
    const after = revise(planFor(), { targets: { mealPrep: 1 } });

    assert.equal(opsOf(after.plan, "mealPrep").length, 1);
    assert.equal(after.plan.food.prep.length, 1);
    assert.doesNotMatch(everyText(after.plan), /salmon/);
  });

  it('"Skip Saturday completely" keeps new activities off Saturday', () => {
    const after = revise(planFor({ targets: { golfRound: 2 } }), { skipDays: ["saturday"] });
    assert.ok(after.plan.placements.every((entry) => entry.date !== "2026-10-03"));
  });

  it("rejects empty or unknown changes instead of guessing", () => {
    assert.throws(() => revise(planFor(), {}), /at least one change/);
    assert.throws(() => revise(planFor(), { note: "just a note" }), /at least one change/);
    assert.throws(() => revise(planFor(), { makeItBetter: true }), /Unknown field/);
  });
});

describe("weekly plan acceptance", () => {
  it('accepts explicit replies such as "OK", "Looks good", "Create it", "Yes" and "Go ahead"', () => {
    for (const reply of ["OK", "ok", "Looks good", "Create it", "create them", "Yes", "Go ahead", "Sounds good"]) {
      assert.equal(isWeeklyPlanAcceptance(reply), true, reply);
    }
  });

  it("does not treat questions, hedges, denials or acceptance mixed with a change as acceptance", () => {
    for (const reply of [
      "ok?",
      "maybe ok",
      "is that ok?",
      "no",
      "don't create these",
      "skip this week",
      "ok but no salmon",
      "yes, gym 3 times",
      "",
    ]) {
      assert.equal(isWeeklyPlanAcceptance(reply), false, reply);
    }
  });
});

describe("weekly plan authorization", () => {
  it("allows only creating a task with plain task fields", () => {
    const { plan } = planFor();
    for (const operation of plan.operations) assert.deepEqual(checkWeeklyPlanOperation(operation), { allowed: true, reason: null });
  });

  it("cannot delete, edit, complete, move, comment, touch Calendar or Gmail, book, buy, write memory or run shell", () => {
    const payload = { content: "Gym — Monday" };
    for (const kind of [
      "delete-task",
      "update-task",
      "complete-task",
      "close-task",
      "reopen-task",
      "move-task",
      "add-comment",
      "calendar-create-event",
      "calendar-edit-event",
      "gmail-send",
      "book-tee-time",
      "purchase",
      "memory-write",
      "shell-command",
    ]) {
      assert.equal(checkWeeklyPlanOperation({ kind, payload }).allowed, false, kind);
    }
  });

  it("refuses create payloads that carry fields beyond a plain personal task", () => {
    for (const extra of [{ assignee_id: "1" }, { parent_id: "2" }, { labels: ["x"] }, { id: "existing" }]) {
      assert.equal(
        checkWeeklyPlanOperation({ kind: "create-task", payload: { content: "Gym", ...extra } }).allowed,
        false,
        JSON.stringify(extra),
      );
    }
    assert.equal(checkWeeklyPlanOperation({ kind: "create-task", payload: { content: " " } }).allowed, false);
  });

  it("matches the trusted-routine entry in config/approval-policy.json", () => {
    const entry = policy.trustedRoutines.find((routine) => routine.id === "weekly-plan");

    assert.equal(entry.mode, "trusted-routine");
    assert.deepEqual(entry.allowedOperationKinds, [...WEEKLY_PLAN_AUTHORIZATION.allowedOperationKinds]);
    assert.deepEqual(entry.allowedTaskFields, [...WEEKLY_PLAN_AUTHORIZATION.allowedPayloadFields]);
    assert.equal(entry.reviewWindowHours, WEEKLY_PLAN_AUTHORIZATION.reviewWindowHours);
    for (const forbidden of [
      "delete-todoist-task",
      "complete-todoist-task",
      "move-todoist-task",
      "modify-existing-todoist-task",
      "calendar-write",
      "gmail-write",
      "booking",
      "purchase",
      "browser-submission",
      "memory-write",
      "shell-mutation",
      "create-anything-not-in-displayed-proposal",
    ]) {
      assert.ok(entry.notAuthorized.includes(forbidden), forbidden);
    }
  });

  it("leaves general confirm-before-action untouched", () => {
    assert.equal(policy.initialTrustMode, "confirm-before-action");
    const todoist = policy.approvalRequired.find((domain) => domain.domain === "todoist").actions;
    for (const action of ["create-task", "edit-task", "complete-task", "delete-task", "move-task"]) {
      assert.ok(todoist.includes(action), action);
    }
    assert.equal(policy.trustedRoutines.length, 1);
  });
});
