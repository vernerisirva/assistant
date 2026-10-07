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
import { COMPETITION_ANSWER, GOLF_ANSWER, answerJson } from "./fixtures/golf-answers.mjs";

const schedules = JSON.parse(readFileSync("config/schedules.json", "utf8"));
const SATURDAY_0900 = "2026-10-10T07:00:00.000Z";
const PLAN_ID = "wp-2026-W42-abc123";
// The message the installed Saturday job runs. The golf questions are asked by
// the planner, so this did not change; changing it needs `weekly-plan install`.
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
  const answer = (golf, extra) => run(["answer", "--input-json", answerJson(golf)], extra);
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

  it("runs Saturday's week end to end: ask, answer, six-day plan, revise, deterministic apply, no duplicates", async () => {
    const memoryBefore = memoryHash();

    // Saturday 09:00: the scheduled job runs propose --send. It asks; it does not plan.
    const asked = await run(["propose", "--send"]);
    assert.deepEqual([asked.status, asked.sent, asked.missing], ["awaiting_input", true, ["rounds", "focus"]]);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^Next week's plan · 12 Oct–18 Oct\n\nBefore I build next week's golf plan:/);
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");

    // The user answers in two messages. Nothing is planned until both parts are known.
    at("2026-10-10T08:05:00.000Z");
    const partial = await answer({
      replyText: "18 holes Wednesday and Saturday, Saturday is a competition",
      addRounds: [{ day: "wednesday", holes: 18 }, { day: "saturday", holes: 18, competition: true }],
    });
    assert.equal(partial.status, "needs_input");
    assert.deepEqual(partial.missing, ["focus"]);
    assert.equal(plan().currentVersion, 0);
    assert.equal(plan().reviewDeadline, null, "no review window before the complete plan is shown");
    at("2026-10-10T09:40:00.000Z"); // 11:40 Stockholm
    const shown = await answer({ replyText: "Wedges 50–100 m and putting inside 2 m", focus: ["Wedges 50–100 m", "Putting inside 2 m"] });

    assert.equal(shown.status, "pending");
    assert.equal(shown.reviewDeadline, "2026-10-10T21:45:00.000Z", "12 hours after the full plan was shown");
    const v1 = versionEntry(plan(), 1).plan;
    assert.equal(v1.golf.activeDays, 6);
    assert.equal(v1.golf.restDays, 1);
    // The manual lesson on Thursday counts as a golf day and is left alone.
    assert.equal(v1.golf.days.find((day) => day.date === "2026-10-15").role, "existing");
    const golfOps = v1.operations.filter((operation) => operation.activity === "golf");
    assert.equal(golfOps.length, 5);
    assert.deepEqual(
      golfOps.map((operation) => operation.date).sort(),
      v1.golf.days.filter((day) => ["practice", "round", "competition", "lesson"].includes(day.role)).map((day) => day.date),
    );
    assert.match(shown.telegramText, /\nThu — Golf lesson with Anna \(in Todoist\)\n/);
    assert.match(shown.telegramText, /\nSat — Competition · 18 holes · process: routine\n/);
    // Saved routines shape the wording.
    assert.match(golfOps.find((operation) => operation.date === "2026-10-14").payload.description, /Cue: commit\.[\s\S]*Use your bad shot reset, then make the next decision\./);

    // A substantive revision stores v2 and restarts the window; a no-op does not.
    at("2026-10-10T18:30:00.000Z"); // 20:30 Stockholm
    const mondayKind = v1.golf.days.find((day) => day.date === "2026-10-12").kind;
    const revised = await run([
      "revise",
      "--expect-version",
      "1",
      "--changes-json",
      JSON.stringify({ golf: { replyText: "Tuesday needs to be the rest day", restDay: "tuesday" } }),
    ]);
    assert.equal(revised.version, 2);
    assert.equal(revised.reviewDeadline, "2026-10-11T06:30:00.000Z");
    assert.match(revised.telegramText, /^Updated plan · 12 Oct–18 Oct · v2\nChanges: Golf: rest day Tue\n/);
    assert.match(revised.telegramText, /\nTue — Rest\n/);
    const noOp = await run([
      "revise",
      "--expect-version",
      "2",
      "--changes-json",
      JSON.stringify({ golf: { replyText: "Make Tuesday the rest day", restDay: "tuesday" } }),
    ]);
    assert.equal(noOp.changed, false);
    assert.equal(plan().currentVersion, 2);
    assert.equal(plan().reviewDeadline, "2026-10-11T06:30:00.000Z");
    assert.equal(versionEntry(plan(), 2).plan.golf.days.find((day) => day.date === "2026-10-12").kind, mondayKind, "Monday kept its session");

    // Nothing before the deadline; exactly v2 after it; nothing twice.
    at("2026-10-11T06:29:00.000Z");
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    assert.equal(todoist.calls.addTask.length, 0);
    at("2026-10-11T06:30:00.000Z");
    assert.match((await run(["apply-due"])).text, /^Applied weekly plan · 12 Oct–18 Oct · v2\n/);
    const v2 = versionEntry(plan(), 2).plan;
    assert.deepEqual(todoist.calls.addTask.map((call) => call.payload), v2.operations.map((operation) => operation.payload));
    at("2026-10-11T06:45:00.000Z");
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    const accepted = await run(["accept", "--plan-id", PLAN_ID, "--version", "2", "--reply-text", "OK"]);
    assert.equal(accepted.applied, false);
    assert.equal(todoist.calls.addTask.length, v2.operations.length, "repeat checks create nothing");
    const titles = todoist.tasks.map((task) => `${task.due.date} ${task.content}`);
    assert.equal(new Set(titles).size, titles.length, "no duplicates");
    assert.ok(todoist.tasks.some((task) => task.id === "manual-1" && task.content === "Golf lesson with Anna"));
    assert.deepEqual(todoist.calls.forbidden, [], "no existing task is edited, completed, moved or deleted");
    assert.equal(memoryHash(), memoryBefore, "memory is never written");
  });

  it("never creates golf tasks while the answers are incomplete, and refuses invented input without storing anything", async () => {
    await run(["propose", "--send"]);
    await answer({ replyText: "Focus on putting", focus: ["Putting"] });
    const before = planFile();

    const invented = await answer({ replyText: "Same as usual I guess", addRounds: [{ day: "wednesday", holes: 18 }] });
    assert.equal(invented.status, "clarify");
    assert.deepEqual(invented.problems, ["Wednesday is not in the user's words.", "18 holes is not in the user's words."]);
    assert.equal(invented.telegramText, "Which days are you playing next week, and roughly 9 or 18 holes?");
    assert.equal(planFile(), before, "nothing was stored");

    at("2026-10-12T12:00:00.000Z");
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    await assert.rejects(run(["accept", "--version", "1", "--reply-text", "OK"]), /has not been shown yet/);
    await assert.rejects(
      run(["revise", "--expect-version", "1", "--changes-json", '{"targets":{"gym":3}}']),
      /still waiting for golf answers; use answer/,
    );
    assert.equal(todoist.calls.addTask.length, 0);
  });

  it("asks rather than taking golf answers from the scheduled job, and drops its own golf question", async () => {
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
    assert.equal(result.status, "awaiting_input");
    assert.equal(plan().awaiting.golf.roundsKnown, false, "the scheduled job's golf input is ignored");
    assert.equal(plan().awaiting.baseInputs.question, null);
    const shown = await answer(GOLF_ANSWER);
    assert.doesNotMatch(shown.telegramText, /Question:|Driver/);
  });

  it("builds the plan at once when an on-demand request already answers the golf questions", async () => {
    at("2026-10-07T16:00:00.000Z"); // Wednesday
    const result = await run(["propose", "--reply", "--input-json", JSON.stringify({ golf: COMPETITION_ANSWER })]);
    assert.equal(result.status, "pending");
    assert.match(result.telegramText, /^Next week's plan · 12 Oct–18 Oct · v1\n\nGolf · /);
    assert.equal(sent.length, 0, "a chat reply, not a Telegram send");
  });

  it("takes a non-golf change in the same message as the golf answer", async () => {
    await run(["propose", "--send"]);
    const shown = await run(["answer", "--input-json", answerJson(GOLF_ANSWER, { changes: { excludeIngredients: ["salmon"] } })]);
    assert.equal(shown.status, "pending");
    assert.doesNotMatch(JSON.stringify(versionEntry(plan(), 1).plan.operations).toLowerCase(), /salmon/);
  });

  it('uses last week\'s playing days for "same as last week", from the plan the user saw', async () => {
    await run(["propose", "--send"]);
    await answer(COMPETITION_ANSWER);
    await run(["accept", "--version", "1", "--reply-text", "OK"]);

    at("2026-10-17T07:00:00.000Z");
    await run(["propose", "--send"], { random: () => "def456" });
    assert.match(sent.at(-1), /\n\nLast week: 18 holes Wed · competition Sat \(18 holes\) · focus: wedges 50–100 m, putting inside 2 m\.\n\n/);
    const shown = await answer({ replyText: "Same as last week", rounds: "same-as-last-week", focus: "same-as-last-week" });
    assert.equal(shown.status, "pending");
    const week = versionEntry(plan("wp-2026-W43-def456"), 1).plan.golf;
    assert.deepEqual(
      week.days.filter((day) => day.role === "round" || day.role === "competition").map((day) => [day.date, day.role]),
      [["2026-10-21", "round"], ["2026-10-24", "round"]],
      "same days, but last week's competition is not repeated",
    );
  });

  it("cancels while waiting for answers, and closes a week whose questions were never answered", async () => {
    await run(["propose", "--send"]);
    const cancelled = await run(["cancel", "--reason", "Skip this week"]);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.telegramText, "Cancelled the weekly plan for 12 Oct–18 Oct. Nothing was created in Todoist.");
    assert.match((await run(["status"])).telegramText, /Last plan \(12 Oct–18 Oct\) was cancelled before it was built\./);

    at("2026-10-17T07:00:00.000Z");
    await run(["propose", "--send"], { random: () => "def456" });
    at("2026-10-24T07:00:00.000Z");
    await run(["propose", "--send"], { random: () => "fed789" });
    assert.equal(plan("wp-2026-W43-def456").status, "cancelled", "the unanswered week is closed");
    assert.equal(plan("wp-2026-W44-fed789").status, "awaiting_input");
    assert.match((await run(["status"])).telegramText, /^Weekly plan for 26 Oct–1 Nov is waiting for your golf answers/);
    assert.equal(todoist.calls.addTask.length, 0);
  });

  it("asks again when an on-demand request finds the week still waiting", async () => {
    await run(["propose", "--send"]);
    await answer({ replyText: "Focus on putting", focus: ["Putting"] });
    const again = await run(["propose", "--reply"]);
    assert.equal(again.status, "awaiting_input");
    assert.match(again.telegramText, /^Got it: focus: putting\.\n\nWhich days are you playing next week/);
  });

  it("refuses an ungrounded golf change to a shown plan without storing a version", async () => {
    await run(["propose", "--send"]);
    await answer(GOLF_ANSWER);
    const before = planFile();
    const result = await run([
      "revise",
      "--expect-version",
      "1",
      "--changes-json",
      JSON.stringify({ golf: { replyText: "Add another round", addRounds: [{ day: "friday" }] } }),
    ]);
    assert.equal(result.status, "clarify");
    assert.equal(planFile(), before);
  });

  it("keeps a plan made before the golf week acceptable and appliable, but not changeable", async () => {
    await run(["propose", "--send"]);
    await answer(GOLF_ANSWER);
    const path = join(stateDir, "weekly-plan/plans", `${PLAN_ID}.json`);
    const document = JSON.parse(readFileSync(path, "utf8"));
    const entry = document.versions[0];
    delete entry.inputs.golf;
    entry.inputs.targets = { ...entry.inputs.targets, golfRound: 1, golfPractice: 1 };
    writeFileSync(path, JSON.stringify(document));

    await assert.rejects(
      run(["revise", "--expect-version", "1", "--changes-json", '{"targets":{"gym":3}}']),
      /made before the golf week planner, so it can still be accepted or cancelled but not changed/,
    );
    const accepted = await run(["accept", "--version", "1", "--reply-text", "Looks good"]);
    assert.equal(accepted.status, "applied");
  });

  it("serves the guide with the current status", async () => {
    await run(["propose", "--send"]);
    const guide = await run(["guide"], { root: process.cwd() });
    assert.match(guide.text, /^Current weekly plan status:\nWeekly plan for 12 Oct–18 Oct is waiting for your golf answers/);
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
