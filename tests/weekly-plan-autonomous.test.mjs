import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWeeklyPlanCli } from "../scripts/weekly-plan.mjs";
import {
  createAwaitingDocument,
  createWeeklyPlanStore,
  recordGolfAnswer,
  recordGolfQuestion,
  versionEntry,
} from "../scripts/lib/weekly-plan-store.mjs";
import { buildInitialPlanInputs } from "../scripts/lib/weekly-plan.mjs";
import { applyGolfChanges, emptyGolfInputs } from "../scripts/lib/golf-week.mjs";

const schedules = JSON.parse(readFileSync("config/schedules.json", "utf8"));
const config = JSON.parse(readFileSync("config/weekly-plan.json", "utf8"));
const food = JSON.parse(readFileSync("config/food-planning.json", "utf8"));
// Saturday 24 Oct 2026, 09:00 in Stockholm; the plan is for 26 Oct–1 Nov.
const SATURDAY_0900 = "2026-10-24T07:00:00.000Z";
const PLAN_ID = "wp-2026-W44-abc123";

function fakeTodoist(initial = []) {
  const tasks = initial.map((task) => ({ ...task }));
  const calls = { addTask: [], forbidden: [] };
  let nextId = 9000;
  const forbidden = (name) => async () => {
    calls.forbidden.push(name);
    throw new Error(`${name} must never be called by the weekly plan`);
  };
  return {
    tasks,
    calls,
    async getTasks() {
      return tasks.map((task) => ({ ...task }));
    },
    async addTask(payload, options) {
      calls.addTask.push({ payload: structuredClone(payload), requestId: options?.requestId });
      const task = { id: String(nextId++), content: payload.content, due: { date: payload.due_string, string: payload.due_string } };
      tasks.push(task);
      return task;
    },
    updateTask: forbidden("updateTask"),
    closeTask: forbidden("closeTask"),
    reopenTask: forbidden("reopenTask"),
    deleteTask: forbidden("deleteTask"),
    moveTask: forbidden("moveTask"),
    addComment: forbidden("addComment"),
  };
}

const opsOf = (plan, activity) => plan.operations.filter((operation) => operation.activity === activity);
const numberedLines = (text) => text.split("\n").filter((line) => /^\d+\. /.test(line));

describe("weekly plan without answers", () => {
  let stateDir;
  let clock;
  let todoist;
  let sent;
  let sendFails;

  const context = (extra = {}) => ({
    stateDir,
    memoryPath: join(stateDir, "memory.json"),
    env: { TELEGRAM_USER_ID: "1029709001" },
    schedules,
    todoistClient: todoist,
    sendMessage: async (text) => {
      if (sendFails) throw new Error("Telegram unreachable");
      sent.push(text);
      return { messageId: sent.length };
    },
    now: () => clock,
    random: () => "abc123",
    sleep: async () => {},
    retryDelaysMs: [0, 0],
    ...extra,
  });
  const run = (argv, extra) => runWeeklyPlanCli(argv, context(extra));
  const revise = (version, changes) => run(["revise", "--expect-version", String(version), "--changes-json", JSON.stringify(changes)]);
  const plan = (planId = PLAN_ID) => createWeeklyPlanStore({ stateDir }).readPlan(planId);
  const at = (iso) => {
    clock = new Date(iso);
  };
  const created = () => todoist.tasks.filter((task) => /^9\d{3}$/.test(task.id));

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "weekly-plan-autonomous-"));
    writeFileSync(join(stateDir, "memory.json"), `${JSON.stringify({ version: 1, entries: [] })}\n`);
    clock = new Date(SATURDAY_0900);
    todoist = fakeTodoist();
    sent = [];
    sendFails = false;
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("creates the shown default plan 12 hours after Saturday's message when nobody replies, exactly once", async () => {
    // 1–4. Saturday 09:00, no golf answers: the complete plan is built and shown.
    const shown = await run(["propose", "--send"]);
    assert.deepEqual([shown.status, shown.sent, shown.version, shown.reviewDeadlineLocal], ["pending", true, 1, "21:00 on Saturday 24 Oct"]);
    const v1 = versionEntry(plan(), 1).plan;

    // Golf: six golf days of practice and one rest day, nothing invented.
    assert.deepEqual([v1.golf.activeDays, v1.golf.restDays], [6, 1]);
    assert.equal(opsOf(v1, "golf").length, 6);
    assert.ok(opsOf(v1, "golf").every((operation) => operation.payload.content.startsWith("Golf practice — ")));
    // Gym and stretching: whole sessions with exercises, sets and repetitions or holds.
    assert.equal(opsOf(v1, "gym").length, 2);
    for (const operation of opsOf(v1, "gym")) assert.ok(numberedLines(operation.payload.description).every((line) => / – \d+ × \d+/.test(line)));
    assert.equal(opsOf(v1, "stretch").length, 3);
    for (const operation of opsOf(v1, "stretch")) assert.ok(numberedLines(operation.payload.description).length >= 5);
    // Food: two dishes, each its own cooking task with ingredients and numbered steps; one grocery list from them.
    assert.equal(opsOf(v1, "mealPrep").length, 2);
    for (const operation of opsOf(v1, "mealPrep")) {
      assert.match(operation.payload.content, /^Matlagning – /);
      assert.match(operation.payload.description, /\n\nIngredienser\n- /);
      assert.ok(numberedLines(operation.payload.description).length >= 3);
    }
    assert.deepEqual(opsOf(v1, "shopping").map((operation) => operation.payload.content), ["Matinköp för veckan"]);
    assert.deepEqual(v1.shopping.dishes.map((dish) => dish.mealId).sort(), v1.food.prep.map((session) => session.mealId).sort());

    // The message shows the actual schedule and sessions, labels the defaults and asks, optionally.
    const message = sent[0];
    assert.match(message, /\nMon — Wedges · \d+ min\n/);
    assert.match(message, /\nMon — Gym \(Helkropp A\)\n/);
    assert.match(message, /Stretch \(Höfter och bröstrygg\)/);
    assert.match(message, /\nFood\n• Kyckling med ris och grönsaker ×3 \(prep [A-Z][a-z]{2}\)\n/);
    assert.match(message, /\nShopping \([A-Z][a-z]{2}\)\n/);
    assert.match(message, /\(default: you haven't named a focus\)/);
    assert.match(message, /\nTwo things you can help me improve:\n/);
    assert.match(message, /\nIf you don't reply, that's fine: I'll create 14 Todoist tasks at 21:00 on Saturday 24 Oct\.\nReply with changes, OK to apply now, or Skip this week to cancel\.$/);
    assert.ok(message.length < 3500, `${message.length} characters fit one Telegram message`);

    // 5. Nothing exists in Todoist yet.
    at("2026-10-24T18:45:00.000Z");
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    assert.equal(todoist.calls.addTask.length, 0);

    // 6–8. Twelve hours later the deterministic check creates exactly the shown tasks.
    at("2026-10-24T19:00:00.000Z");
    const applied = await run(["apply-due"]);
    assert.equal(applied.text, "Applied weekly plan · 26 Oct–1 Nov · v1\nCreated: 14 · Already existed: 0 · Failed: 0");
    assert.deepEqual(todoist.calls.addTask.map((call) => call.payload), v1.operations.map((operation) => operation.payload));

    // 9–10. Running again creates nothing more.
    at("2026-10-24T19:15:00.000Z");
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    assert.equal(created().length, 14);
    assert.deepEqual(todoist.calls.forbidden, []);
  });

  it("creates the latest shown version after partial answers and a revision, with the window restarted by each change", async () => {
    await run(["propose", "--send"]);

    // Playing days only: the default focus stays.
    at("2026-10-24T08:00:00.000Z");
    const days = await revise(1, { golf: { replyText: "Playing Wednesday and Saturday", addRounds: [{ day: "wednesday" }, { day: "saturday" }] } });
    assert.equal(days.version, 2);
    assert.equal(days.reviewDeadline, "2026-10-24T20:00:00.000Z");
    assert.deepEqual(versionEntry(plan(), 2).plan.golf.assumed, ["focus"]);

    // "Gym three days instead" and "No salmon".
    at("2026-10-24T09:00:00.000Z");
    const gym = await revise(2, { targets: { gym: 3 }, excludeIngredients: ["salmon"] });
    assert.equal(gym.version, 3);
    assert.equal(gym.reviewDeadline, "2026-10-24T21:00:00.000Z");
    const v3 = versionEntry(plan(), 3).plan;
    assert.equal(opsOf(v3, "gym").length, 3);
    assert.doesNotMatch(JSON.stringify(v3.operations).toLowerCase(), /lax|salmon/);

    // A no-op keeps the version and the deadline.
    at("2026-10-24T10:00:00.000Z");
    const same = await revise(3, { golf: { replyText: "Playing Saturday", addRounds: [{ day: "saturday" }] } });
    assert.equal(same.changed, false);
    assert.equal(plan().reviewDeadline, "2026-10-24T21:00:00.000Z");

    // The user's own task is not doubled.
    const duplicate = opsOf(v3, "stretch")[0];
    todoist.tasks.push({ id: "own-1", content: duplicate.payload.content, due: { date: duplicate.date } });

    at("2026-10-24T20:00:00.000Z");
    assert.equal((await run(["apply-due"])).text, "NO_REPLY", "v2's deadline no longer counts");
    at("2026-10-24T21:00:00.000Z");
    assert.match((await run(["apply-due"])).text, /^Applied weekly plan · 26 Oct–1 Nov · v3\nCreated: \d+ · Already existed: 1 · Failed: 0$/);
    assert.equal(plan().apply.outcomes[duplicate.opId].status, "already_exists");
    assert.deepEqual(
      todoist.calls.addTask.map((call) => call.payload),
      v3.operations.filter((operation) => operation.opId !== duplicate.opId).map((operation) => operation.payload),
    );
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");
  });

  it("never applies a plan that could not be shown, however long it waits", async () => {
    sendFails = true;
    await assert.rejects(run(["propose", "--send"]), /stays a draft and will not apply/);
    for (const iso of ["2026-10-24T19:00:00.000Z", "2026-10-25T07:00:00.000Z", "2026-10-26T12:00:00.000Z", "2026-11-02T12:00:00.000Z"]) {
      at(iso);
      assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    }
    assert.equal(plan().status, "draft");
    assert.equal(todoist.calls.addTask.length, 0);
    assert.equal(sent.length, 0);
    // Past its week the retries stop, and the next week's plan closes it.
    const attempts = plan().delivery.attempts;
    at("2026-11-03T12:00:00.000Z");
    await run(["apply-due"]);
    assert.equal(plan().delivery.attempts, attempts);
    sendFails = false;
    at("2026-11-07T07:00:00.000Z");
    await run(["propose", "--send"], { random: () => "def456" });
    assert.equal(plan().status, "cancelled");
    assert.equal(plan().history.at(-1).reason, "Never shown before its week ended.");
    assert.equal(todoist.calls.addTask.length, 0);
  });

  it("explicit OK applies at once, and Skip this week cancels: both without waiting for golf answers", async () => {
    await run(["propose", "--send"]);
    const accepted = await run(["accept", "--version", "1", "--reply-text", "Ser bra ut"]);
    assert.equal(accepted.status, "applied");
    assert.equal(created().length, 14);

    at("2026-10-31T07:00:00.000Z");
    await run(["propose", "--send"], { random: () => "def456" });
    const cancelled = await run(["cancel", "--reason", "Skip this week"]);
    assert.equal(cancelled.status, "cancelled");
    at("2026-10-31T19:00:00.000Z");
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    assert.equal(created().length, 14);
  });

  it("never plans a dish without a complete recipe: a configured recipe missing its steps is left out and the plan says so", async () => {
    const broken = structuredClone(food);
    for (const meal of broken.weeklyMealPlan.meals.slice(1)) {
      for (const language of Object.keys(meal.steps ?? {})) meal.steps[language] = [];
    }
    await run(["propose", "--send"], { loadPlanningConfig: () => ({ config, food: broken }) });
    const v1 = versionEntry(plan(), 1).plan;
    assert.equal(opsOf(v1, "mealPrep").length, 1);
    assert.match(sent[0], /\nNote: Only 1 dish with a complete recipe is left after your changes, so meal prep is 1 instead of 2\./);
    assert.doesNotMatch(JSON.stringify(v1.operations), /of your choice/i);
    assert.deepEqual(v1.shopping.dishes.map((dish) => dish.mealId), [v1.food.prep[0].mealId]);
  });

  it("leaves an applied plan alone: a new proposal for that week only reports it", async () => {
    await run(["propose", "--send"]);
    at("2026-10-24T19:00:00.000Z");
    await run(["apply-due"]);
    const before = JSON.stringify(plan());
    const again = await run(["propose", "--send", "--input-json", '{"weekStart":"2026-10-26"}'], { random: () => "def456" });
    assert.equal(again.status, "exists");
    assert.equal(again.planStatus, "applied");
    assert.equal(JSON.stringify(plan()), before);
    assert.equal(sent.length, 1);
  });
});

describe("weekly plans stored while waiting for golf answers", () => {
  let stateDir;
  let clock;
  let todoist;
  let sent;

  const context = (extra = {}) => ({
    stateDir,
    memoryPath: join(stateDir, "memory.json"),
    env: { TELEGRAM_USER_ID: "1029709001" },
    schedules,
    todoistClient: todoist,
    sendMessage: async (text) => {
      sent.push(text);
      return { messageId: sent.length };
    },
    now: () => clock,
    random: () => "abc123",
    sleep: async () => {},
    retryDelaysMs: [0, 0],
    ...extra,
  });
  const run = (argv, extra) => runWeeklyPlanCli(argv, context(extra));
  const store = () => createWeeklyPlanStore({ stateDir });
  const at = (iso) => {
    clock = new Date(iso);
  };

  /** A week stored the old way: its context, the golf questions sent, and the answers given so far. */
  function storeAwaitingWeek({ planId, weekStart, askedAt, answers = [] }) {
    const baseInputs = buildInitialPlanInputs({}, { config, food, weekStart, language: "sv" });
    let document = createAwaitingDocument({ planId, weekStart, baseInputs, golf: emptyGolfInputs(config), now: askedAt, timezone: "Europe/Stockholm" });
    document = recordGolfQuestion(document, { askedAt, channel: "telegram-send", messageId: 1 });
    for (const { at: answeredAt, golf } of answers) {
      const result = applyGolfChanges(document.awaiting.golf, golf, { weekStart });
      assert.deepEqual(result.problems, []);
      document = recordGolfAnswer(document, { golf: result.golf, replyText: golf.replyText, fields: Object.keys(golf), now: answeredAt });
    }
    store().writePlan(document);
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "weekly-plan-legacy-"));
    writeFileSync(join(stateDir, "memory.json"), `${JSON.stringify({ version: 1, entries: [] })}\n`);
    todoist = fakeTodoist();
    sent = [];
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("builds the plan from a partial answer, with defaults for the rest, instead of asking again", async () => {
    storeAwaitingWeek({ planId: PLAN_ID, weekStart: "2026-10-26", askedAt: SATURDAY_0900 });
    at("2026-10-24T08:00:00.000Z");
    const shown = await run(["answer", "--input-json", JSON.stringify({ golf: { replyText: "Focus on putting", focus: ["Putting"] } })]);
    assert.equal(shown.status, "pending");
    assert.equal(shown.version, 1);
    assert.equal(shown.reviewDeadline, "2026-10-24T20:00:00.000Z");
    assert.match(shown.telegramText, /\nThis week's focus: 1\. Putting\n/);
    assert.match(shown.telegramText, /\nPlaying days: not given yet, so every golf day is practice, not a round \(default\)\n/);
    assert.match(shown.telegramText, /\nOne thing you can help me improve:\nWhich days will you play golf, if any\?/);
    at("2026-10-24T20:00:00.000Z");
    assert.match((await run(["apply-due"])).text, /^Applied weekly plan · 26 Oct–1 Nov · v1/);
  });

  it("recovers the current week mid-week: only the days left, no catch-up golf, no overdue tasks, applied only as shown", async () => {
    // Like 19–25 Oct: questions on Saturday, a lesson and the rounds on Monday, no focus.
    storeAwaitingWeek({
      planId: "wp-2026-W43-abc123",
      weekStart: "2026-10-19",
      askedAt: "2026-10-17T07:01:18.000Z",
      answers: [
        { at: "2026-10-19T05:08:00.000Z", golf: { replyText: "Lesson on Thursday", addLessons: [{ day: "thursday" }] } },
        {
          at: "2026-10-19T05:15:00.000Z",
          golf: { replyText: "9 holes Friday, 18 holes Saturday and Sunday", addRounds: [{ day: "friday", holes: 9 }, { day: "saturday", holes: 18 }, { day: "sunday", holes: 18 }] },
        },
      ],
    });
    const before = store().readPlan("wp-2026-W43-abc123");

    // Tuesday 13:00: the plan is asked for. Nothing is applied before it is shown.
    at("2026-10-20T11:00:00.000Z");
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    const shown = await run(["propose", "--reply", "--input-json", '{"weekStart":"2026-10-19"}']);
    assert.equal(shown.status, "pending");
    assert.equal(shown.reviewDeadline, "2026-10-20T23:00:00.000Z");
    assert.match(shown.telegramText, /^This week's plan · 19 Oct–25 Oct · v1\n/);
    assert.match(shown.telegramText, /\nTuesday's tasks would be overdue by then, so they are only created if you reply OK before Tuesday ends\.\n/);
    assert.match(shown.telegramText, /\nNote: The week has already started, so the 6 days left get 5 golf days and keep a golf-free day; missed golf days aren't caught up\.\n/);

    const document = store().readPlan("wp-2026-W43-abc123");
    assert.deepEqual(document.history.slice(0, before.history.length), before.history, "the stored answers and history are kept");
    const v1 = versionEntry(document, 1).plan;
    assert.ok(v1.operations.every((operation) => operation.date >= "2026-10-20"), "nothing on Monday");
    const golfDays = Object.fromEntries(v1.golf.days.map((day) => [day.date, day.role]));
    assert.equal(golfDays["2026-10-19"], "off");
    assert.equal(golfDays["2026-10-22"], "lesson");
    assert.deepEqual([golfDays["2026-10-23"], golfDays["2026-10-24"], golfDays["2026-10-25"]], ["round", "round", "round"]);
    assert.deepEqual([v1.golf.activeDays, v1.golf.restDays], [5, 1], "five golf days and a rest day in the six days left");

    // At the deadline (01:00 Wednesday) Tuesday has passed: its tasks are skipped, never created overdue.
    at("2026-10-20T23:00:00.000Z");
    const applied = await run(["apply-due"]);
    assert.match(applied.text, /^Applied weekly plan · 19 Oct–25 Oct · v1\nCreated: \d+ · Already existed: 0 · Failed: 0 · Skipped \(date passed\): \d+$/);
    assert.ok(todoist.tasks.every((task) => task.due.date >= "2026-10-21"));
    const outcomes = store().readPlan("wp-2026-W43-abc123").apply.outcomes;
    for (const operation of v1.operations) {
      assert.equal(outcomes[operation.opId].status, operation.date < "2026-10-21" ? "skipped_past_date" : "created", operation.opId);
    }
  });

  it("recovers with a Telegram send when the week is proposed again, and the same command afterwards only reports it", async () => {
    storeAwaitingWeek({ planId: PLAN_ID, weekStart: "2026-10-26", askedAt: SATURDAY_0900 });
    at("2026-10-24T10:00:00.000Z");
    const sentNow = await run(["propose", "--send"]);
    assert.deepEqual([sentNow.status, sentNow.sent], ["pending", true]);
    assert.match(sent[0], /^Next week's plan · 26 Oct–1 Nov · v1\n/);
    assert.match(sent[0], /\nTwo things you can help me improve:\n/);
    assert.equal((await run(["propose", "--send"])).status, "exists");
    assert.equal(sent.length, 1);
  });

  it("refuses a golf answer that is not in the user's words, and keeps the week as it was", async () => {
    storeAwaitingWeek({ planId: PLAN_ID, weekStart: "2026-10-26", askedAt: SATURDAY_0900 });
    const file = readFileSync(join(stateDir, "weekly-plan/plans", `${PLAN_ID}.json`), "utf8");
    at("2026-10-24T08:00:00.000Z");
    const refused = await run(["answer", "--input-json", JSON.stringify({ golf: { replyText: "As usual", addRounds: [{ day: "wednesday", holes: 18 }] } })]);
    assert.equal(refused.status, "clarify");
    assert.equal(readFileSync(join(stateDir, "weekly-plan/plans", `${PLAN_ID}.json`), "utf8"), file);
    assert.equal((await run(["status"])).pending[0].status, "awaiting_input");
  });

  it("still cancels, and is closed when the next week's plan starts", async () => {
    storeAwaitingWeek({ planId: PLAN_ID, weekStart: "2026-10-26", askedAt: SATURDAY_0900 });
    at("2026-10-31T07:00:00.000Z");
    await run(["propose", "--send"], { random: () => "def456" });
    assert.equal(store().readPlan(PLAN_ID).status, "cancelled");
    assert.equal(store().readPlan("wp-2026-W45-def456").status, "pending");
    assert.equal(todoist.calls.addTask.length, 0);
  });
});
