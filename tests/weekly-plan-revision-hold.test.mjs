import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWeeklyPlanCli } from "../scripts/weekly-plan.mjs";
import {
  beginApply,
  createWeeklyPlanStore,
  holdForRevision,
  isPlanDue,
  isRevisionHoldReportDue,
  releaseRevisionHold,
  versionEntry,
} from "../scripts/lib/weekly-plan-store.mjs";
import { weeklyPlanPendingProvider } from "../scripts/lib/pending.mjs";

const schedules = JSON.parse(readFileSync("config/schedules.json", "utf8"));
const PLAN_ID = "wp-2026-W44-abc123";
// Saturday 24 October 2026: v1 was shown at 09:01:13, so its tasks were due at 21:15.
const SHOWN = "2026-10-24T07:01:13.000Z";
const DEADLINE = "2026-10-24T19:15:00.000Z";
const CHANGE_AT = "2026-10-24T18:55:31.000Z";
const ANSWER_AT = "2026-10-24T19:15:31.000Z";
const MESSAGE = "Maybe 9 holes on friday, 18 on saturday and sunday. Golf practice on mon-friday and gym on tuesday and thursday";
const DAY = Object.freeze({ mon: "2026-10-26", tue: "2026-10-27", wed: "2026-10-28", thu: "2026-10-29", fri: "2026-10-30", sat: "2026-10-31", sun: "2026-11-01" });
const QUESTION = "Golf on all seven days next week, with no golf-free day?";

// The 20:55 message as an agent might map it: everything clear, except that
// "golf practice on mon-friday" became "seven golf days", which those words
// alone don't say.
const UNCLEAR_CHANGE = Object.freeze({
  golf: {
    replyText: MESSAGE,
    addRounds: [{ day: "friday", holes: 9 }, { day: "saturday", holes: 18 }, { day: "sunday", holes: 18 }],
    activeDays: 7,
  },
  activityDays: { gym: ["tuesday", "thursday"] },
});
// The same message mapped in full.
const FULL_CHANGE = Object.freeze({
  golf: {
    replyText: MESSAGE,
    addRounds: [{ day: "friday", holes: 9, tentative: true }, { day: "saturday", holes: 18 }, { day: "sunday", holes: 18 }],
    practiceDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  },
  activityDays: { gym: ["tuesday", "thursday"] },
});
const NO_REST_DAY = Object.freeze({ golf: { replyText: "I don't need a rest day next week :)", activeDays: 7 } });

function fakeTodoist() {
  const tasks = [];
  const calls = { addTask: [], forbidden: [] };
  let nextId = 7000;
  let gate = null;
  const forbidden = (name) => async () => {
    calls.forbidden.push(name);
    throw new Error(`${name} must never be called by the weekly plan`);
  };
  return {
    tasks,
    calls,
    /** The next task read waits until released: a check that holds the plan lock. */
    pause() {
      let release;
      let arrived;
      const reached = new Promise((resolve) => {
        arrived = resolve;
      });
      gate = { arrived, wait: new Promise((resolve) => (release = resolve)) };
      return { reached, release: () => release() };
    },
    async getTasks() {
      if (gate) {
        const current = gate;
        gate = null;
        current.arrived();
        await current.wait;
      }
      return tasks.map((task) => ({ ...task }));
    },
    async addTask(payload) {
      calls.addTask.push(structuredClone(payload));
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

describe("weekly plan: a change the user asks for holds the shown version", () => {
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
    lockWaitMs: 5_000,
    ...extra,
  });
  const run = (argv, extra) => runWeeklyPlanCli(argv, context(extra));
  const revise = (version, changes, extra) => run(["revise", "--expect-version", String(version), "--changes-json", JSON.stringify(changes)], extra);
  const plan = () => createWeeklyPlanStore({ stateDir }).readPlan(PLAN_ID);
  const at = (iso) => {
    clock = new Date(iso);
  };
  const opsOf = (version, activity) => versionEntry(plan(), version).plan.operations.filter((operation) => operation.activity === activity);
  const showSaturdayPlan = async () => {
    at(SHOWN);
    const shown = await run(["propose", "--send"]);
    assert.deepEqual([shown.status, shown.version, plan().reviewDeadline], ["pending", 1, DEADLINE]);
    return versionEntry(plan(), 1).plan.operations.length;
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "weekly-plan-hold-"));
    memoryPath = join(stateDir, "memory.json");
    writeFileSync(memoryPath, `${JSON.stringify({ version: 1, entries: [] })}\n`);
    todoist = fakeTodoist();
    sent = [];
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("replays 24 October: the 20:55 change holds v1 through 21:15, the answer shows seven golf days, and only that version applies, once", async () => {
    await showSaturdayPlan();

    // 20:55: the change arrives; one part of it needs the user's answer.
    at(CHANGE_AT);
    const asked = await revise(1, UNCLEAR_CHANGE);
    assert.deepEqual([asked.status, asked.held, asked.version, asked.changed], ["clarify", true, 1, false]);
    assert.deepEqual(asked.understood, ["Gym Tue, Thu", "Golf: + maybe 9 holes Fri", "Golf: + 18 holes Sat", "Golf: + 18 holes Sun"]);
    assert.equal(
      asked.telegramText,
      `Got it: Gym Tue, Thu · Golf: + maybe 9 holes Fri · Golf: + 18 holes Sat · Golf: + 18 holes Sun.\n\n${QUESTION}\n\nUntil you answer, your plan is on hold and nothing is created. Say Keep the plan to leave it as it was, or Skip this week.`,
    );
    const held = plan();
    assert.deepEqual([held.status, held.currentVersion, held.reviewDeadline], ["pending", 1, DEADLINE], "no new version, the old deadline is unchanged");
    assert.deepEqual(
      { ...held.revisionHold, pendingInputs: Boolean(held.revisionHold.pendingInputs) },
      {
        requestedAt: CHANGE_AT,
        fromVersion: 1,
        question: QUESTION,
        askedAt: CHANGE_AT,
        understood: asked.understood,
        pendingInputs: true,
        reportedAt: null,
      },
    );
    assert.ok(!JSON.stringify(held.revisionHold).includes("Maybe 9 holes"), "the user's message itself is not stored");

    // 21:15: the apply check runs, and the version the user asked to change does not apply.
    for (const check of [DEADLINE, "2026-10-24T19:15:01.441Z"]) {
      at(check);
      assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    }
    assert.equal(todoist.calls.addTask.length, 0, "v1 was not applied");
    assert.equal(plan().status, "pending");

    // 21:15:31: "I don't need a rest day next week :)" completes the change.
    at(ANSWER_AT);
    const shown = await revise(1, NO_REST_DAY);
    assert.deepEqual([shown.status, shown.version, shown.changed], ["pending", 2, true]);
    assert.match(
      shown.telegramText,
      /^Updated plan · 26 Oct–1 Nov · v2\nChanges: Gym Tue, Thu · Golf: \+ maybe 9 holes Fri · Golf: \+ 18 holes Sat · Golf: \+ 18 holes Sun · Golf days 6 → 7\n\nGolf · 7 golf days\n/,
    );
    assert.match(shown.telegramText, /\nFri — .+ · possible 9 holes\n/);
    assert.match(shown.telegramText, /\nSat — 18 holes · process: .+\nSun — 18 holes · process: .+\n/);
    assert.match(shown.telegramText, /\nNote: Golf every day, as you asked: practice stays moderate, and .+ light\.\n/);
    assert.doesNotMatch(shown.telegramText, /golf-free|rest day|Which day/i, "no rest day is demanded");
    assert.match(shown.telegramText, /\nThe 12-hour review window restarted with this change\./);
    const v2 = plan();
    assert.deepEqual([v2.revisionHold, v2.displayedVersion, v2.reviewDeadline], [null, 2, "2026-10-25T07:30:00.000Z"], "a fresh window from when v2 was shown");
    const week = versionEntry(v2, 2).plan;
    assert.deepEqual(week.golf.days.map((day) => day.role), ["practice", "practice", "practice", "practice", "practice", "round", "round"]);
    assert.deepEqual(opsOf(2, "gym").map((operation) => operation.date), [DAY.tue, DAY.thu], "gym on the days asked for, beside golf practice");
    const friday = opsOf(2, "golf").filter((operation) => operation.date === DAY.fri);
    assert.equal(friday.length, 1, "one golf task on Friday");
    assert.match(friday[0].payload.content, /^Golf practice — /);
    assert.match(friday[0].payload.description, /\nPossible round\nIf the 9-hole round is on, play it instead of this session\./);
    assert.deepEqual(
      opsOf(2, "golf").filter((operation) => [DAY.sat, DAY.sun].includes(operation.date)).map((operation) => operation.payload.content),
      ["Golf — 18-hole round", "Golf — 18-hole round"],
    );

    // v2 applies once, at its own deadline; checks after that create nothing more.
    at("2026-10-25T07:15:00.000Z");
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    at("2026-10-25T07:30:00.000Z");
    assert.match((await run(["apply-due"])).text, /^Applied weekly plan · 26 Oct–1 Nov · v2\nCreated: \d+ · Already existed: 0 · Failed: 0$/);
    assert.equal(todoist.calls.addTask.length, week.operations.length);
    for (const check of ["2026-10-25T07:45:00.000Z", "2026-10-25T08:00:00.000Z"]) {
      at(check);
      assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    }
    assert.equal(todoist.calls.addTask.length, week.operations.length, "no duplicates");
    const titles = todoist.tasks.map((task) => `${task.due.date} ${task.content}`);
    assert.equal(new Set(titles).size, titles.length);
    assert.equal(plan().apply.version, 2);
    assert.ok(!plan().history.some((entry) => entry.event === "apply-started" && entry.version === 1), "v1 never started applying");
    assert.deepEqual(todoist.calls.forbidden, []);
  });

  it("needs no question when the change is mapped in full: it shows at once, restarts the window, and 21:15 applies nothing", async () => {
    await showSaturdayPlan();
    at(CHANGE_AT);
    const shown = await revise(1, FULL_CHANGE);
    assert.deepEqual([shown.version, shown.changed, plan().revisionHold, plan().reviewDeadline], [2, true, null, "2026-10-25T07:00:00.000Z"]);
    assert.match(shown.telegramText, /\nChanges: Gym Tue, Thu · Golf: \+ maybe 9 holes Fri · Golf: \+ 18 holes Sat · Golf: \+ 18 holes Sun · Golf: practice Mon–Fri · Golf: every day, no golf-free day\n/);
    assert.match(shown.telegramText, /\nNote: Friday's 9-hole round is only a possibility, so Friday keeps its practice\. If it's on, tell me and I'll make Friday the round\.\n/);
    at(DEADLINE);
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    assert.equal(todoist.calls.addTask.length, 0);
    assert.deepEqual(
      plan().history.map((entry) => entry.event),
      ["created", "displayed", "revision-requested", "revised", "revision-hold-released", "displayed"],
    );
  });

  it("reads a plain yes together with the question it answers", async () => {
    await showSaturdayPlan();
    at(CHANGE_AT);
    await revise(1, UNCLEAR_CHANGE);
    const yes = await revise(1, { golf: { replyText: "Yes", activeDays: 7 } });
    assert.deepEqual([yes.version, plan().revisionHold], [2, null]);
    assert.match(yes.telegramText, /\nChanges: Gym Tue, Thu · Golf: \+ maybe 9 holes Fri · Golf: \+ 18 holes Sat · Golf: \+ 18 holes Sun · Golf days 6 → 7\n\nGolf · 7 golf days\n/);
    // Once it is answered, "yes" alone says nothing about golf days.
    const again = await revise(2, { golf: { replyText: "Yes", activeDays: 5 } });
    assert.equal(again.status, "clarify");
  });

  it("never lets a no borrow the question's words, and can show the clear part without the unanswered one", async () => {
    await showSaturdayPlan();
    at(CHANGE_AT);
    await revise(1, UNCLEAR_CHANGE);
    const no = await revise(1, { golf: { replyText: "No", activeDays: 7 } });
    assert.equal(no.status, "clarify");
    assert.equal(plan().revisionHold.question, QUESTION);
    // "Just do the rest": what was clear is shown, with six golf days and a rest day.
    const rest = await revise(1, {});
    assert.deepEqual([rest.version, plan().revisionHold], [2, null]);
    assert.match(rest.telegramText, /\nChanges: Gym Tue, Thu · Golf: \+ maybe 9 holes Fri · Golf: \+ 18 holes Sat · Golf: \+ 18 holes Sun\n\nGolf · 6 golf days, 1 rest day\n/);
  });

  it("answers after the original deadline still show the new version with a fresh window, after one notice that nothing was created", async () => {
    await showSaturdayPlan();
    at(CHANGE_AT);
    await revise(1, UNCLEAR_CHANGE);
    at(DEADLINE);
    assert.equal((await run(["apply-due"])).text, "NO_REPLY", "no notice while the question is fresh");
    at("2026-10-24T20:00:00.000Z");
    const notice = (await run(["apply-due"])).text;
    assert.equal(
      notice,
      [
        "Weekly plan · 26 Oct–1 Nov · v1: nothing created yet",
        `You asked to change this plan at 20:55 on Saturday 24 Oct, and that change isn't finished: I still need your answer to “${QUESTION}”. So its tasks weren't created at 21:15 on Saturday 24 Oct.`,
        "Answer, tell me the change again, say Keep the plan to create it as shown, or Skip this week to cancel.",
      ].join("\n"),
    );
    for (const check of ["2026-10-24T20:15:00.000Z", "2026-10-24T23:00:00.000Z"]) {
      at(check);
      assert.equal((await run(["apply-due"])).text, "NO_REPLY", "said once, never repeated");
    }
    assert.equal(todoist.calls.addTask.length, 0);

    at("2026-10-25T08:10:00.000Z");
    const shown = await revise(1, NO_REST_DAY);
    assert.deepEqual([shown.version, plan().reviewDeadline], [2, "2026-10-25T20:15:00.000Z"]);
    at("2026-10-25T20:15:00.000Z");
    assert.match((await run(["apply-due"])).text, /^Applied weekly plan · 26 Oct–1 Nov · v2\n/);
  });

  it("writes the hold before the change is worked out, so a failed step, a crash or a restart never lets v1 apply on its own", async () => {
    const tasks = await showSaturdayPlan();
    at(CHANGE_AT);
    // The test week's gym is on Monday and Thursday: this move refers to a session that isn't there.
    await assert.rejects(revise(1, { moves: [{ activity: "gym", from: "sunday", to: "thursday" }] }), /There is no planned gym on Sunday to move\./);
    assert.deepEqual([plan().currentVersion, plan().revisionHold.question, plan().revisionHold.requestedAt], [1, null, CHANGE_AT]);

    // A restart: every check below runs with a fresh store and context.
    at(DEADLINE);
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    assert.equal(todoist.calls.addTask.length, 0);
    const status = await run(["status"]);
    assert.match(status.telegramText, /^Weekly plan for 26 Oct–1 Nov \(v1\) is on hold: you asked for a change at 20:55 on Saturday 24 Oct that isn't finished\. Nothing is created on its own until you finish the change, keep the plan as shown, or skip the week\.$/m);
    const pending = weeklyPlanPendingProvider.read({ stateDir, now: clock, timezone: "Europe/Stockholm" });
    assert.equal(pending.items.length, 1);
    assert.match(pending.items[0].detail, /^You asked for a change at 20:55 on Saturday 24 Oct that isn't finished, so nothing is created automatically\.$/);
    const show = await run(["show"]);
    assert.match(show.telegramText, /^On hold: you asked for a change at 20:55 on Saturday 24 Oct that isn't finished, so nothing is created on its own\.\n\nNext week's plan/);
    assert.match(show.telegramText, /\n\nNothing is created on its own while the change you asked for is open\. Answer my question, say Keep the plan to keep this version, or Skip this week\.$/);
    assert.doesNotMatch(show.telegramText, /I'll create/);

    at("2026-10-24T20:00:00.000Z");
    assert.match((await run(["apply-due"])).text, /^Weekly plan · 26 Oct–1 Nov · v1: nothing created yet\nYou asked to change this plan at 20:55 on Saturday 24 Oct, and that change isn't finished\. So its tasks weren't created at 21:15 on Saturday 24 Oct\.\n/);

    // "Keep the plan": the change is dropped and v1 applies at the next check.
    const kept = await run(["keep", "--version", "1"]);
    assert.equal(kept.telegramText, `OK, I've dropped that change and kept the plan as shown (v1). I'll create its ${tasks} Todoist tasks at 22:15 on Saturday 24 Oct unless you change or cancel it.`);
    assert.equal(plan().revisionHold, null);
    at("2026-10-24T20:15:00.000Z");
    assert.match((await run(["apply-due"])).text, /^Applied weekly plan · 26 Oct–1 Nov · v1\n/);
    assert.equal(todoist.calls.addTask.length, tasks);
  });

  it("takes an OK while a change is open as the answer, not as acceptance; after Keep the plan an OK applies the shown version", async () => {
    const tasks = await showSaturdayPlan();
    at(CHANGE_AT);
    await revise(1, UNCLEAR_CHANGE);
    const ok = await run(["accept", "--version", "1", "--reply-text", "OK"]);
    assert.deepEqual([ok.status, ok.applied], ["not_accepted", false]);
    assert.match(ok.message, /that change isn't finished, so this reply is not taken as acceptance: it most likely answers your question \(Golf on all seven days next week, with no golf-free day\?\), so finish the change with revise\. Nothing was created\. If they clearly want the plan as shown without their change, run keep --version 1; after that an OK applies it\./);
    assert.equal(todoist.calls.addTask.length, 0);

    // The user explicitly wants the original plan.
    await run(["keep", "--version", "1"]);
    const accepted = await run(["accept", "--version", "1", "--reply-text", "OK"]);
    assert.deepEqual([accepted.status, accepted.applied], ["applied", true]);
    assert.equal(todoist.calls.addTask.length, tasks);
    assert.equal(plan().apply.version, 1);
  });

  it("cancelling during an open change ends it, and nothing ever applies", async () => {
    await showSaturdayPlan();
    at(CHANGE_AT);
    await revise(1, UNCLEAR_CHANGE);
    const cancelled = await run(["cancel", "--reason", "Skip this week"]);
    assert.equal(cancelled.telegramText, "Cancelled the weekly plan for 26 Oct–1 Nov (v1). Nothing was created in Todoist.");
    assert.deepEqual([plan().status, plan().revisionHold], ["cancelled", null]);
    for (const check of [DEADLINE, "2026-10-24T21:00:00.000Z"]) {
      at(check);
      assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    }
    assert.equal(todoist.calls.addTask.length, 0);
  });

  it("lets questions and silence leave the plan alone: it still applies at its deadline", async () => {
    const tasks = await showSaturdayPlan();
    at(CHANGE_AT);
    // "What's on Friday?", "When will it apply?": read-only answers, no change.
    await run(["show"]);
    await run(["status"]);
    await run(["guide"], { root: process.cwd() });
    assert.equal(plan().revisionHold ?? null, null);
    at(DEADLINE);
    assert.match((await run(["apply-due"])).text, /^Applied weekly plan · 26 Oct–1 Nov · v1\n/);
    assert.equal(todoist.calls.addTask.length, tasks);
  });

  it("finishes an apply that started first and reports the change as too late: nothing is undone, doubled or revised", async () => {
    const tasks = await showSaturdayPlan();
    at(DEADLINE);
    const paused = todoist.pause();
    const applying = run(["apply-due"]);
    await paused.reached;
    // The change arrives while the check holds the plan; it waits for the lock.
    const change = revise(1, FULL_CHANGE);
    await new Promise((resolve) => setTimeout(resolve, 50));
    paused.release();
    assert.match((await applying).text, /^Applied weekly plan · 26 Oct–1 Nov · v1\n/);
    const late = await change;
    assert.deepEqual([late.status, late.changed, late.telegramText], ["applied", false, null]);
    assert.match(
      late.message,
      new RegExp(`^v1 of the plan for 26 Oct–1 Nov was applied at 21:15 on Saturday 24 Oct \\(${tasks} tasks created\\) before this change could be made, so revise can't change it and nothing was undone\\. Say so plainly, then follow the guide's "After A Plan Was Applied" section\\.$`),
    );
    assert.deepEqual([plan().versions.length, plan().revisionHold ?? null], [1, null]);
    assert.equal(todoist.calls.addTask.length, tasks, "created once");

    // A change that comes later still gets the same honest answer.
    at(ANSWER_AT);
    assert.equal((await revise(1, NO_REST_DAY)).status, "applied");
  });

  it("says a plan left half-applied by a crash is being applied, never revises it", async () => {
    await showSaturdayPlan();
    const path = join(stateDir, "weekly-plan/plans", `${PLAN_ID}.json`);
    const document = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...document, status: "applying", apply: { version: 1, trigger: "deadline", startedAt: DEADLINE, finishedAt: null, outcomes: {} } }));
    at(ANSWER_AT);
    const late = await revise(1, FULL_CHANGE);
    assert.deepEqual([late.status, late.changed, late.telegramText], ["applying", false, null]);
    assert.match(late.message, /^The plan for 26 Oct–1 Nov is being applied right now, before this change could be made\./);
    assert.equal(plan().versions.length, 1);
  });

  it("keeps the deadline check out while a change holds the plan, between its two steps and during the second", async () => {
    await showSaturdayPlan();
    const real = createWeeklyPlanStore({ stateDir });
    const checks = [];
    const check = async () => checks.push((await runWeeklyPlanCli(["apply-due"], context({ now: () => new Date(DEADLINE) }))).text);
    let calls = 0;
    // A store that runs the deadline check right after the hold is written,
    // and again while the change itself holds the lock.
    const store = {
      ...real,
      async mutatePlan(planId, fn, options) {
        calls += 1;
        if (calls === 2) {
          const inner = fn;
          fn = async (current) => {
            await check();
            return inner(current);
          };
        }
        const result = await real.mutatePlan(planId, fn, options);
        if (calls === 1) await check();
        return result;
      },
    };
    at("2026-10-24T19:14:59.000Z");
    const shown = await revise(1, FULL_CHANGE, { store });
    assert.equal(shown.version, 2);
    assert.deepEqual(checks, ["NO_REPLY", "NO_REPLY"]);
    at(DEADLINE);
    assert.equal((await run(["apply-due"])).text, "NO_REPLY", "the new version has its own window");
    assert.equal(todoist.calls.addTask.length, 0);
  });

  it("closes a plan still held when its week is over and the next week's plan starts", async () => {
    await showSaturdayPlan();
    at(CHANGE_AT);
    await revise(1, UNCLEAR_CHANGE);
    at("2026-11-07T08:00:00.000Z");
    await run(["propose", "--send"]);
    const old = plan();
    assert.equal(old.status, "cancelled");
    assert.equal(old.history.at(-1).reason, "The change asked for wasn't finished before its week ended.");
    assert.equal(todoist.calls.addTask.length, 0);
  });

  it("waits for a held lock only as long as asked, and treats an unreadable lock like any other", async () => {
    await showSaturdayPlan();
    const lock = join(stateDir, "weekly-plan/locks", `${PLAN_ID}.lock`);
    // A process that died between creating the lock and writing its owner.
    writeFileSync(lock, "");
    let slept = 0;
    const store = createWeeklyPlanStore({ stateDir, lockPollMs: 250, sleep: async (ms) => (slept += ms) });
    await assert.rejects(store.mutatePlan(PLAN_ID, async () => null, { waitMs: 1_000 }), { code: "PLAN_LOCKED" });
    assert.equal(slept, 1_000, "it polled for the wait it was given, then stopped");
    await assert.rejects(store.mutatePlan(PLAN_ID, async () => null), { code: "PLAN_LOCKED" });
    assert.equal(slept, 1_000, "without a wait it doesn't poll at all");
    // Once it is old and no live process owns it, it is taken over.
    const old = new Date(Date.now() - 16 * 60_000);
    utimesSync(lock, old, old);
    assert.equal((await store.mutatePlan(PLAN_ID, async () => null)).planId, PLAN_ID);
    assert.equal(existsSync(lock), false);
  });

  it("enforces the hold in the store itself", () => {
    const document = {
      planId: PLAN_ID,
      status: "pending",
      currentVersion: 1,
      displayedVersion: 1,
      reviewDeadline: DEADLINE,
      history: [],
      versions: [],
    };
    assert.equal(isPlanDue(document, "2026-10-24T20:00:00.000Z"), true);
    const held = holdForRevision(document, { now: CHANGE_AT, fromVersion: 1 });
    assert.equal(isPlanDue(held, "2026-10-24T20:00:00.000Z"), false);
    assert.throws(() => beginApply(held, { trigger: "deadline", now: DEADLINE }), /has a change the user asked for that isn't finished; it will not be applied/);
    assert.throws(() => holdForRevision({ ...document, status: "applied" }, { now: CHANGE_AT }), /is applied, not a shown plan/);
    assert.equal(isRevisionHoldReportDue(held, "2026-10-24T19:30:00.000Z"), false, "not within an hour of the change");
    assert.equal(isRevisionHoldReportDue(held, "2026-10-24T19:56:00.000Z"), true);
    assert.equal(isPlanDue(releaseRevisionHold(held, { now: DEADLINE, outcome: "kept" }), "2026-10-24T20:00:00.000Z"), true);
  });
});
