import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWeeklyPlanCli } from "../scripts/weekly-plan.mjs";
import { createWeeklyPlanStore, versionEntry } from "../scripts/lib/weekly-plan-store.mjs";
import {
  WEEKLY_PLAN_APPLY_JOB,
  WEEKLY_PLAN_PROPOSE_JOB,
  buildProposeMessage,
  buildWeeklyPlanCronJobs,
} from "../scripts/lib/weekly-plan-cron.mjs";
import { COMPETITION_ANSWER, GOLF_ANSWER } from "./fixtures/golf-answers.mjs";

const schedules = JSON.parse(readFileSync("config/schedules.json", "utf8"));
const SATURDAY_0900 = "2026-10-10T07:00:00.000Z";
const PLAN_ID = "wp-2026-W42-abc123";
// The message the installed Saturday job runs. The planner builds the plan and
// its optional golf questions itself, so this did not change; changing it
// needs `weekly-plan install`.
const INSTALLED_PROPOSE_MESSAGE_SHA256 = "eb7e783e0563428e47a37a502c59908e78bba3b82cad5f284522589e6724058f";

function fakeTodoist(initial = []) {
  const tasks = initial.map((task) => ({ ...task }));
  const calls = { addTask: [], forbidden: [] };
  let nextId = 5000;
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

const golfOps = (plan) => plan.operations.filter((operation) => operation.activity === "golf");
const dayOf = (plan, date) => plan.golf.days.find((day) => day.date === date);

describe("weekly plan golf week", () => {
  let stateDir;
  let memoryPath;
  let clock;
  let todoist;
  let sent;

  const context = (extra = {}) => ({
    stateDir,
    memoryPath,
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
  const revise = (version, changes, extra) => run(["revise", "--expect-version", String(version), "--changes-json", JSON.stringify(changes)], extra);
  const plan = (planId = PLAN_ID) => createWeeklyPlanStore({ stateDir }).readPlan(planId);
  const planFile = (planId = PLAN_ID) => readFileSync(join(stateDir, "weekly-plan/plans", `${planId}.json`), "utf8");
  const at = (iso) => {
    clock = new Date(iso);
  };
  const memoryHash = () => createHash("sha256").update(readFileSync(memoryPath)).digest("hex");

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "weekly-plan-golf-"));
    memoryPath = join(stateDir, "memory.json");
    writeFileSync(
      memoryPath,
      `${JSON.stringify({
        version: 1,
        entries: [
          { id: "m1", category: "golf", key: "cue-word", value: "commit", sensitivity: "low", source: "telegram", createdAt: "x", updatedAt: "x" },
          { id: "m2", category: "golf", key: "bad-shot-reset", value: "After a poor shot: walk away, exhale, next shot", sensitivity: "low", source: "telegram", createdAt: "x", updatedAt: "x" },
        ],
      }, null, 2)}\n`,
    );
    clock = new Date(SATURDAY_0900);
    todoist = fakeTodoist([{ id: "manual-1", content: "Golf lesson with Anna", due: { date: "2026-10-15" } }]);
    sent = [];
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("runs Saturday's week end to end: complete default plan, answers as revisions, deterministic apply, no duplicates", async () => {
    const memoryBefore = memoryHash();

    // Saturday 09:00: the scheduled job runs propose --send. It plans the whole week and asks, optionally.
    const shown = await run(["propose", "--send"]);
    assert.deepEqual([shown.status, shown.sent, shown.version], ["pending", true, 1]);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^Next week's plan · 12 Oct–18 Oct · v1\n/);
    assert.match(sent[0], /\nThis week's focus: a balanced mix for competitive play \(default: you haven't named a focus\)\n/);
    assert.match(sent[0], /\nPlaying days: not given yet, so every golf day is practice, not a round \(default\)\n/);
    assert.match(
      sent[0],
      /\n\nTwo things you can help me improve:\n1\. Which days will you play golf, if any\? Roughly 9 or 18 holes, and is any of it a competition or a lesson\?\n2\. What would you like to focus on in your golf practice\?\n\nIf you don't reply, that's fine: I'll create \d+ Todoist tasks at 21:00 on Saturday 10 Oct\.\n/,
    );
    const v1 = versionEntry(plan(), 1).plan;
    assert.deepEqual([v1.golf.activeDays, v1.golf.restDays], [6, 1]);
    assert.deepEqual(v1.golf.assumed, ["rounds", "focus"]);
    // The manual lesson on Thursday counts as a golf day and is left alone; nothing is invented.
    assert.equal(dayOf(v1, "2026-10-15").role, "existing");
    assert.ok(v1.golf.days.every((day) => !["round", "competition", "lesson"].includes(day.role)), "no invented rounds, competitions or lessons");
    assert.ok(golfOps(v1).every((operation) => operation.payload.content.startsWith("Golf practice — ")));
    assert.doesNotMatch(JSON.stringify(v1.operations), /Cue: commit/, "the scheduled plan reads no saved routines");
    assert.equal(plan().reviewDeadline, "2026-10-10T19:00:00.000Z");
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");

    // Playing days only: they become rounds, the default focus stays, the window restarts.
    at("2026-10-10T08:05:00.000Z");
    const days = await revise(1, {
      golf: {
        replyText: "18 holes Wednesday and Saturday, Saturday is a competition",
        addRounds: [{ day: "wednesday", holes: 18 }, { day: "saturday", holes: 18, competition: true }],
      },
    });
    assert.equal(days.version, 2);
    assert.equal(days.reviewDeadline, "2026-10-10T20:15:00.000Z");
    assert.match(days.telegramText, /^Updated plan · 12 Oct–18 Oct · v2\nChanges: Golf: \+ 18 holes Wed · Golf: \+ Sat competition \(18 holes\)\n/);
    assert.match(days.telegramText, /\nThis week's focus: a balanced mix for competitive play \(default: you haven't named a focus\)\n/);
    assert.doesNotMatch(days.telegramText, /improve:/, "the questions are asked once");
    const v2 = versionEntry(plan(), 2).plan;
    assert.deepEqual(v2.golf.assumed, ["focus"]);
    assert.equal(dayOf(v2, "2026-10-14").role, "round");
    assert.equal(dayOf(v2, "2026-10-16").kind, "comp-prep");
    assert.equal(dayOf(v2, "2026-10-17").role, "competition");
    assert.equal(dayOf(v2, "2026-10-18").role, "rest", "rest after the competition");
    // A golf answer in chat may word the tasks with the saved routines.
    assert.match(golfOps(v2).find((operation) => operation.date === "2026-10-12").payload.description, /Cue: commit\./);

    // Focus only: the sessions follow it, the playing days stay.
    at("2026-10-10T09:40:00.000Z");
    const focus = await revise(2, { golf: { replyText: "Wedges 50–100 m and putting inside 2 m", focus: ["Wedges 50–100 m", "Putting inside 2 m"] } });
    assert.equal(focus.version, 3);
    assert.equal(focus.reviewDeadline, "2026-10-10T21:45:00.000Z");
    const v3 = versionEntry(plan(), 3).plan;
    assert.equal(v3.golf.assumed, undefined);
    assert.deepEqual(golfOps(v3).filter((operation) => operation.payload.content.startsWith("Golf practice")).map((operation) => operation.payload.content), [
      "Golf practice — Wedges 50–100 m",
      "Golf practice — Putting inside 2 m",
      "Golf practice — Competition preparation",
    ]);
    assert.equal(dayOf(v3, "2026-10-14").role, "round");

    // A change that alters nothing keeps the version and its deadline.
    const noOp = await revise(3, { golf: { replyText: "Saturday is a competition", addRounds: [{ day: "saturday", competition: true }] } });
    assert.equal(noOp.changed, false);
    assert.equal(plan().currentVersion, 3);
    assert.equal(plan().reviewDeadline, "2026-10-10T21:45:00.000Z");

    // Nothing before the deadline; exactly v3 after it; nothing twice.
    at("2026-10-10T21:44:00.000Z");
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    assert.equal(todoist.calls.addTask.length, 0);
    at("2026-10-10T21:45:00.000Z");
    assert.match((await run(["apply-due"])).text, /^Applied weekly plan · 12 Oct–18 Oct · v3\n/);
    assert.deepEqual(todoist.calls.addTask.map((call) => call.payload), v3.operations.map((operation) => operation.payload));
    at("2026-10-10T22:00:00.000Z");
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    const accepted = await run(["accept", "--plan-id", PLAN_ID, "--version", "3", "--reply-text", "OK"]);
    assert.equal(accepted.applied, false);
    assert.equal(todoist.calls.addTask.length, v3.operations.length, "repeat checks create nothing");
    const titles = todoist.tasks.map((task) => `${task.due.date} ${task.content}`);
    assert.equal(new Set(titles).size, titles.length, "no duplicates");
    assert.ok(todoist.tasks.some((task) => task.id === "manual-1" && task.content === "Golf lesson with Anna"));
    assert.deepEqual(todoist.calls.forbidden, [], "no existing task is edited, completed, moved or deleted");
    assert.equal(memoryHash(), memoryBefore, "memory is never written");
  });

  it("refuses golf answers that are not in the user's words, and stores nothing", async () => {
    await run(["propose", "--send"]);
    const before = planFile();
    const invented = await revise(1, { golf: { replyText: "Same as usual I guess", addRounds: [{ day: "wednesday", holes: 18 }] } });
    assert.equal(invented.status, "clarify");
    assert.deepEqual(invented.problems, ["Wednesday is not in the user's words.", "18 holes is not in the user's words."]);
    assert.equal(invented.telegramText, "Which days are you playing next week, and roughly 9 or 18 holes?");
    assert.equal(planFile(), before, "nothing was stored");
    const added = await revise(1, { golf: { replyText: "Add another round", addRounds: [{ day: "friday" }] } });
    assert.equal(added.status, "clarify");
    assert.equal(planFile(), before);
  });

  it("ignores golf answers from the scheduled job, and drops its own golf question", async () => {
    const result = await run([
      "propose",
      "--send",
      "--input-json",
      JSON.stringify({
        targets: { golfRound: 2, golfPractice: 1 },
        golfPracticeFocus: ["Driver"],
        question: "Which days will you play golf?",
        golf: { replyText: "18 holes Wednesday", addRounds: [{ day: "wednesday", holes: 18 }], focus: ["Driver"] },
      }),
    ]);
    assert.equal(result.status, "pending");
    const v1 = versionEntry(plan(), 1);
    assert.equal(v1.inputs.golf.roundsKnown, false, "the scheduled job's golf input is ignored");
    assert.equal(v1.inputs.question, null);
    assert.doesNotMatch(sent[0], /Question:|Driver/);
  });

  it("builds the plan at once with the golf answers an on-demand request already gives", async () => {
    at("2026-10-07T16:00:00.000Z"); // Wednesday
    const result = await run(["propose", "--reply", "--input-json", JSON.stringify({ golf: COMPETITION_ANSWER })]);
    assert.equal(result.status, "pending");
    assert.match(result.telegramText, /^Next week's plan · 12 Oct–18 Oct · v1\nHere is your plan\. I've used your existing tasks, preferences and sensible defaults\.\n\nGolf · /);
    assert.doesNotMatch(result.telegramText, /improve:/, "nothing left to ask");
    assert.equal(sent.length, 0, "a chat reply, not a Telegram send");
    assert.match(JSON.stringify(versionEntry(plan(), 1).plan.operations), /Cue: commit\./, "a plan built in chat may use the saved routines");
  });

  it("takes a non-golf change in the same message as the golf answer", async () => {
    await run(["propose", "--send"]);
    const shown = await revise(1, { golf: GOLF_ANSWER, excludeIngredients: ["salmon"] });
    assert.equal(shown.version, 2);
    assert.doesNotMatch(JSON.stringify(versionEntry(plan(), 2).plan.operations).toLowerCase(), /salmon|lax/);
  });

  it("honours no golf, and asks before a seventh golf day", async () => {
    await run(["propose", "--send"]);
    const none = await revise(1, { golf: { replyText: "No golf next week, I'm travelling", activeDays: 0 } });
    const v2 = versionEntry(plan(), 2).plan;
    assert.equal(none.version, 2);
    assert.deepEqual(golfOps(v2), []);
    assert.match(none.telegramText, /\nChanges: No golf this week\n/);
    // The user's own lesson stays: existing tasks are never touched.
    assert.match(none.telegramText, /\nThu — Golf lesson with Anna \(in Todoist\)\n/);
    const seven = await revise(2, { golf: { replyText: "Seven golf days please", activeDays: 7 } });
    assert.equal(seven.status, "clarify");
    assert.match(seven.telegramText, /I keep at least one golf-free day each week/);
  });

  it("understands Finnish golf answers", async () => {
    await run(["propose", "--send"]);
    const days = await revise(1, {
      golf: {
        replyText: "Pelaan keskiviikkona 18 reikää ja lauantaina on seurakisa",
        addRounds: [{ day: "wednesday", holes: 18 }, { day: "saturday", competition: true }],
      },
    });
    assert.equal(days.version, 2);
    const v2 = versionEntry(plan(), 2).plan;
    assert.equal(dayOf(v2, "2026-10-14").role, "round");
    assert.equal(dayOf(v2, "2026-10-17").role, "competition");
    const focus = await revise(2, { golf: { replyText: "Keskity puttaukseen ja lähipeliin", focus: ["Puttaus", "Lähipeli"] } });
    assert.equal(focus.version, 3);
    const kinds = versionEntry(plan(), 3).plan.golf.days.filter((day) => day.focusIndex !== null && day.focusIndex !== undefined).map((day) => day.kind);
    assert.ok(kinds.includes("putting") && kinds.includes("short-game"), kinds.join(", "));
    const rest = await revise(3, { golf: { replyText: "Siirrä lepopäivä perjantaille", restDay: "friday" } });
    assert.equal(dayOf(versionEntry(plan(), 4).plan, "2026-10-16").role, "rest", rest.telegramText);
    const none = await revise(4, { golf: { replyText: "Ei golfia ensi viikolla", activeDays: 0 } });
    assert.deepEqual(golfOps(versionEntry(plan(), 5).plan), [], none.telegramText);
  });

  it('uses last week\'s playing days for "same as last week", from the plan the user saw', async () => {
    await run(["propose", "--send"]);
    await revise(1, { golf: COMPETITION_ANSWER });
    await run(["accept", "--version", "2", "--reply-text", "OK"]);

    at("2026-10-17T07:00:00.000Z");
    await run(["propose", "--send"], { random: () => "def456" });
    const next = versionEntry(plan("wp-2026-W43-def456"), 1).plan.golf;
    assert.ok(next.days.every((day) => !["round", "competition"].includes(day.role)), "last week's rounds are not copied as bookings");
    const shown = await revise(1, { golf: { replyText: "Same as last week", rounds: "same-as-last-week", focus: "same-as-last-week" } }, {});
    assert.equal(shown.version, 2);
    const week = versionEntry(plan("wp-2026-W43-def456"), 2).plan.golf;
    assert.deepEqual(
      week.days.filter((day) => day.role === "round" || day.role === "competition").map((day) => [day.date, day.role]),
      [["2026-10-21", "round"], ["2026-10-24", "round"]],
      "same days, but last week's competition is not repeated",
    );
  });

  it("cancels a shown plan, and closes a legacy week whose questions were never answered", async () => {
    await run(["propose", "--send"]);
    const cancelled = await run(["cancel", "--reason", "Skip this week"]);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.telegramText, "Cancelled the weekly plan for 12 Oct–18 Oct (v1). Nothing was created in Todoist.");
    at("2026-10-11T12:00:00.000Z");
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    assert.equal(todoist.calls.addTask.length, 0);
  });

  it("keeps a plan made before the golf week acceptable and appliable, but not changeable", async () => {
    await run(["propose", "--send"]);
    const path = join(stateDir, "weekly-plan/plans", `${PLAN_ID}.json`);
    const document = JSON.parse(readFileSync(path, "utf8"));
    const entry = document.versions[0];
    delete entry.inputs.golf;
    entry.inputs.targets = { ...entry.inputs.targets, golfRound: 1, golfPractice: 1 };
    writeFileSync(path, JSON.stringify(document));

    await assert.rejects(
      revise(1, { targets: { gym: 3 } }),
      /made before the golf week planner, so it can still be accepted or cancelled but not changed/,
    );
    const accepted = await run(["accept", "--version", "1", "--reply-text", "Looks good"]);
    assert.equal(accepted.status, "applied");
  });

  it("serves the guide with the current status", async () => {
    await run(["propose", "--send"]);
    const guide = await run(["guide"], { root: process.cwd() });
    assert.match(guide.text, /^Current weekly plan status:\nWeekly plan for 12 Oct–18 Oct is pending \(v1\); I'll create its tasks at 21:00 on Saturday 10 Oct/);
    assert.match(guide.text, /\n\n# Weekly Plan\n/);
  });

  it("keeps exactly the two installed jobs, with the Saturday message unchanged", () => {
    const jobs = buildWeeklyPlanCronJobs(schedules, { telegramUserId: "1029709001", projectRoot: "/repo", nodePath: "/usr/bin/node" });
    assert.deepEqual(jobs.map((job) => job.name), [WEEKLY_PLAN_PROPOSE_JOB, WEEKLY_PLAN_APPLY_JOB]);
    assert.equal(jobs.filter((job) => job.schedule.expr.endsWith(" 6")).length, 1, "one Saturday job");
    assert.equal(createHash("sha256").update(buildProposeMessage(schedules.weeklyPlan)).digest("hex"), INSTALLED_PROPOSE_MESSAGE_SHA256);
    assert.equal(jobs[0].message, buildProposeMessage(schedules.weeklyPlan));
    // No other job is defined anywhere for golf or post-round coaching.
    const lib = readdirSync("scripts/lib").filter((name) => name.endsWith(".mjs"));
    for (const name of lib) {
      assert.doesNotMatch(readFileSync(join("scripts/lib", name), "utf8"), /Assistant (golf|coaching|post-round)/, name);
    }
  });
});
