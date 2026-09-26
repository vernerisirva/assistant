import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWeeklyPlanCli, parseWeeklyPlanArgs } from "../scripts/weekly-plan.mjs";
import { createWeeklyPlanStore, versionEntry } from "../scripts/lib/weekly-plan-store.mjs";
import { applyWeeklyPlan, createWeeklyPlanTodoistGateway, isTransient } from "../scripts/lib/weekly-plan-apply.mjs";
import { digestPlan } from "../scripts/lib/weekly-plan.mjs";
import {
  WEEKLY_PLAN_APPLY_JOB,
  WEEKLY_PLAN_PROPOSE_JOB,
  buildWeeklyPlanCronJobs,
} from "../scripts/lib/weekly-plan-cron.mjs";

const schedules = JSON.parse(readFileSync("config/schedules.json", "utf8"));
const SATURDAY_0900 = "2026-09-26T07:00:00.000Z";

function fakeTodoist(initial = []) {
  const tasks = initial.map((task) => ({ ...task }));
  const calls = { getTasks: 0, addTask: [], forbidden: [] };
  let nextId = 1000;
  const forbidden = (name) => async () => {
    calls.forbidden.push(name);
    throw new Error(`${name} must never be called by the weekly plan`);
  };
  return {
    tasks,
    calls,
    failures: new Map(),
    async getTasks() {
      calls.getTasks += 1;
      return tasks.map((task) => ({ ...task }));
    },
    async addTask(payload, options) {
      calls.addTask.push({ payload: structuredClone(payload), requestId: options?.requestId });
      const failure = this.failures.get(payload.content);
      if (failure) {
        const next = failure.shift();
        if (failure.length === 0) this.failures.delete(payload.content);
        if (next === "create-then-503") {
          tasks.push({ id: String(nextId++), content: payload.content, due: { date: payload.due_string, string: payload.due_string } });
          throw new Error("Todoist API request failed: 503 upstream timeout");
        }
        if (next) throw new Error(next);
      }
      const task = { id: String(nextId++), content: payload.content, due: { date: payload.due_string, string: payload.due_string } };
      tasks.push(task);
      return task;
    },
    updateTask: forbidden("updateTask"),
    closeTask: forbidden("closeTask"),
    reopenTask: forbidden("reopenTask"),
    deleteTask: forbidden("deleteTask"),
    addComment: forbidden("addComment"),
  };
}

describe("weekly plan workflow", () => {
  let stateDir;
  let clock;
  let todoist;
  let sent;
  let sendFails;

  const context = (extra = {}) => ({
    stateDir,
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
  const store = () => createWeeklyPlanStore({ stateDir });
  const plan = () => store().readPlan("wp-2026-W40-abc123");
  const at = (iso) => {
    clock = new Date(iso);
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "weekly-plan-"));
    clock = new Date(SATURDAY_0900);
    todoist = fakeTodoist();
    sent = [];
    sendFails = false;
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  describe("proposal persistence", () => {
    it("stores the proposal as a draft before sending, then marks it pending with a 12-hour deadline", async () => {
      let statusWhileSending;
      const result = await run(["propose", "--send"], {
        sendMessage: async (text) => {
          statusWhileSending = store().readPlan("wp-2026-W40-abc123").status;
          sent.push(text);
          return { messageId: 42 };
        },
      });

      assert.equal(statusWhileSending, "draft");
      assert.equal(result.status, "pending");
      assert.equal(result.sent, true);
      assert.equal(result.telegramText, null);
      const document = plan();
      assert.equal(document.status, "pending");
      assert.equal(document.weekId, "2026-W40");
      assert.equal(document.currentVersion, 1);
      assert.equal(document.displayedVersion, 1);
      assert.equal(document.displayedAt, SATURDAY_0900);
      assert.equal(document.reviewDeadline, "2026-09-26T19:00:00.000Z");
      assert.equal(document.displayedDigest, versionEntry(document, 1).digest);
      assert.match(sent[0], /I'll create \d+ Todoist tasks at 21:00 on Saturday 26 Sep/);
      assert.equal(todoist.calls.addTask.length, 0, "the proposal never creates tasks");
    });

    it("keeps the plan a draft when sending fails, and a draft never applies", async () => {
      sendFails = true;
      await assert.rejects(run(["propose", "--send"]), /stays a draft and will not apply/);
      assert.equal(plan().status, "draft");

      at("2026-09-27T12:00:00.000Z");
      assert.equal((await run(["apply-due"])).text, "NO_REPLY");
      assert.equal(todoist.calls.addTask.length, 0);

      sendFails = false;
      const retried = await run(["propose", "--send"]);
      assert.equal(retried.status, "pending");
      assert.equal(sent.length, 1);
    });

    it("survives a restart: a fresh store reads the same pending plan", async () => {
      await run(["propose", "--send"]);
      const reloaded = createWeeklyPlanStore({ stateDir }).readPlan("wp-2026-W40-abc123");
      assert.equal(reloaded.status, "pending");
      assert.deepEqual(reloaded.versions, plan().versions);
    });

    it("does not create a second proposal for the same week", async () => {
      await run(["propose", "--send"]);
      const again = await run(["propose", "--send"], { random: () => "def456" });
      assert.equal(again.status, "exists");
      assert.equal(sent.length, 1);
      assert.equal(store().listPlans().length, 1);
    });

    it("previews a plain proposal without storing anything that could apply", async () => {
      const preview = await run(["propose"]);
      assert.equal(preview.status, "preview");
      assert.match(preview.telegramText, /^Next week's plan · 28 Sep–4 Oct · v1/);
      assert.deepEqual(store().listPlans(), []);

      const sentLater = await run(["propose", "--send"]);
      assert.equal(sentLater.status, "pending");
    });

    it("reads existing Todoist tasks so the proposal does not duplicate them", async () => {
      todoist = fakeTodoist([{ id: "1", content: "Golf round: Bro Hof", due: { date: "2026-10-03" } }]);
      await run(["propose", "--send"]);
      const entry = versionEntry(plan(), 1);
      assert.equal(entry.plan.operations.filter((operation) => operation.activity === "golfRound").length, 0);
      assert.match(sent[0], /Sat — Golf round \(in Todoist\)/);
    });

    it("still proposes when Todoist cannot be read, and says duplicates are re-checked", async () => {
      todoist.getTasks = async () => {
        throw new Error("Todoist API request failed: 503");
      };
      await run(["propose", "--send"]);
      assert.match(sent[0], /couldn't read Todoist just now/);
    });
  });

  describe("versions and the review window", () => {
    it("a modification stores a new version, shows it, and restarts the 12-hour window", async () => {
      await run(["propose", "--send"]);
      at("2026-09-26T18:30:00.000Z"); // 20:30 Stockholm

      const revised = await run(["revise", "--expect-version", "1", "--changes-json", '{"targets":{"gym":3,"golfRound":0}}']);

      assert.equal(revised.version, 2);
      assert.equal(revised.reviewDeadline, "2026-09-27T06:30:00.000Z");
      assert.equal(revised.reviewDeadlineLocal, "08:30 on Sunday 27 Sep");
      assert.match(revised.telegramText, /^Updated plan · 28 Sep–4 Oct · v2\nChanges: Gym 2 → 3 · Golf 1 → 0/);
      assert.match(revised.telegramText, /at 08:30 on Sunday 27 Sep/);
      const document = plan();
      assert.equal(document.currentVersion, 2);
      assert.equal(document.displayedVersion, 2);
      assert.equal(document.versions.length, 2);
      assert.equal(versionEntry(document, 1).plan.targets.gym, 2, "v1 is kept unchanged");
      assert.equal(todoist.calls.addTask.length, 0, "a modification never touches Todoist");
    });

    it("never applies before the deadline, and applies exactly the latest version after it", async () => {
      await run(["propose", "--send"]);
      at("2026-09-26T18:30:00.000Z");
      await run(["revise", "--expect-version", "1", "--changes-json", '{"targets":{"gym":3,"golfRound":0}}']);

      at("2026-09-26T19:00:00.000Z"); // v1's deadline has passed, v2's has not
      assert.equal((await run(["apply-due"])).text, "NO_REPLY");
      at("2026-09-27T06:29:59.999Z");
      assert.equal((await run(["apply-due"])).text, "NO_REPLY");
      assert.equal(todoist.calls.addTask.length, 0);

      at("2026-09-27T06:30:00.000Z");
      const applied = await run(["apply-due"]);
      assert.match(applied.text, /^Applied weekly plan · 28 Sep–4 Oct · v2/);
      const created = todoist.calls.addTask.map((call) => call.payload);
      assert.deepEqual(created, versionEntry(plan(), 2).plan.operations.map((operation) => operation.payload));
      assert.equal(created.filter((payload) => payload.content.startsWith("Gym — ")).length, 3);
      assert.equal(created.filter((payload) => payload.content.startsWith("Golf round")).length, 0);
    });

    it("rejects a revision based on a version the user is no longer looking at", async () => {
      await run(["propose", "--send"]);
      await run(["revise", "--expect-version", "1", "--changes-json", '{"targets":{"gym":3}}']);
      await assert.rejects(
        run(["revise", "--expect-version", "1", "--changes-json", '{"targets":{"gym":1}}']),
        /looking at v1, but the current version is v2/,
      );
    });

    it("does not create a version or restart the window for a change that alters nothing", async () => {
      await run(["propose", "--send"]);
      at("2026-09-26T10:00:00.000Z");
      const result = await run(["revise", "--expect-version", "1", "--changes-json", '{"excludeIngredients":["durian"]}']);
      assert.equal(result.changed, false);
      assert.equal(plan().currentVersion, 1);
      assert.equal(plan().reviewDeadline, "2026-09-26T19:00:00.000Z");
    });

    it('explicit "OK" applies the displayed version immediately', async () => {
      await run(["propose", "--send"]);
      at("2026-09-26T08:00:00.000Z");
      const accepted = await run(["accept", "--version", "1", "--reply-text", "OK"]);

      assert.equal(accepted.applied, true);
      assert.equal(accepted.status, "applied");
      assert.match(accepted.telegramText, /^Applied weekly plan/);
      assert.equal(todoist.calls.addTask.length, versionEntry(plan(), 1).plan.operations.length);
      assert.equal(plan().apply.trigger, "accepted");
    });

    it("an old version cannot be accepted after a revision", async () => {
      await run(["propose", "--send"]);
      await run(["revise", "--expect-version", "1", "--changes-json", '{"targets":{"gym":3}}']);
      await assert.rejects(run(["accept", "--version", "1", "--reply-text", "OK"]), /not the current displayed version/);
      assert.equal(todoist.calls.addTask.length, 0);
    });

    it("a reply that is not explicit acceptance creates nothing", async () => {
      await run(["propose", "--send"]);
      const result = await run(["accept", "--version", "1", "--reply-text", "ok but no salmon"]);
      assert.equal(result.status, "not_accepted");
      assert.equal(plan().status, "pending");
      assert.equal(todoist.calls.addTask.length, 0);
    });

    it('"Skip this week" cancels: nothing is created, now or after the deadline', async () => {
      await run(["propose", "--send"]);
      const cancelled = await run(["cancel", "--reason", "Skip this week"]);
      assert.equal(cancelled.status, "cancelled");
      assert.match(cancelled.telegramText, /Nothing was created in Todoist/);

      at("2026-09-28T12:00:00.000Z");
      assert.equal((await run(["apply-due"])).text, "NO_REPLY");
      const late = await run(["accept", "--plan-id", "wp-2026-W40-abc123", "--version", "1", "--reply-text", "OK"]);
      assert.equal(late.applied, false);
      assert.match(late.telegramText, /was cancelled, so nothing was created/);
      assert.equal(plan().status, "cancelled");
      assert.equal(todoist.calls.addTask.length, 0);
    });

    it("an applied plan cannot be cancelled or applied again", async () => {
      await run(["propose", "--send"]);
      await run(["accept", "--version", "1", "--reply-text", "Go ahead"]);
      const count = todoist.calls.addTask.length;

      await assert.rejects(run(["cancel", "--plan-id", "wp-2026-W40-abc123"]), /can no longer be cancelled/);
      const again = await run(["accept", "--plan-id", "wp-2026-W40-abc123", "--version", "1", "--reply-text", "OK"]);
      assert.equal(again.applied, false);
      at("2026-09-30T12:00:00.000Z");
      assert.equal((await run(["apply-due"])).text, "NO_REPLY");
      assert.equal(todoist.calls.addTask.length, count);
    });
  });

  describe("deterministic application", () => {
    async function proposeAndReachDeadline() {
      await run(["propose", "--send"]);
      at("2026-09-26T19:00:00.000Z");
    }

    it("applies without the planner: config cannot even be loaded at apply time", async () => {
      await proposeAndReachDeadline();
      const result = await run(["apply-due"], {
        loadPlanningConfig: () => {
          throw new Error("the planner must not run at apply time");
        },
      });
      assert.match(result.text, /^Applied weekly plan/);
      assert.deepEqual(
        todoist.calls.addTask.map((call) => call.payload),
        versionEntry(plan(), 1).plan.operations.map((operation) => operation.payload),
      );
    });

    it("the apply module has no path to the planner or a model", () => {
      const source = readFileSync("scripts/lib/weekly-plan-apply.mjs", "utf8");
      for (const forbidden of ["buildWeeklyPlan", "applyWeeklyPlanChanges", "buildInitialPlanInputs", "openrouter", "fetch("]) {
        assert.ok(!source.includes(forbidden), forbidden);
      }
    });

    it("uses a Todoist gateway that can only read open tasks and create tasks", async () => {
      assert.deepEqual(Object.keys(createWeeklyPlanTodoistGateway(todoist)).sort(), ["addTask", "getTasks"]);
      await proposeAndReachDeadline();
      await run(["apply-due"]);
      assert.deepEqual(todoist.calls.forbidden, []);
    });

    it("skips tasks that already exist and records them as already_exists", async () => {
      await proposeAndReachDeadline();
      const [first, second] = versionEntry(plan(), 1).plan.operations;
      todoist.tasks.push(
        { id: "u1", content: first.payload.content, due: { date: first.date, string: first.date } },
        { id: "u2", content: second.payload.content, due: { date: second.date, string: "tuesday" } },
        { id: "old", content: "Stretch — Wednesday", due: { date: "2026-09-23", string: "2026-09-23" } },
      );

      const result = await run(["apply-due"]);
      const outcomes = plan().apply.outcomes;
      assert.equal(outcomes[first.opId].status, "already_exists");
      assert.equal(outcomes[first.opId].taskId, "u1");
      assert.equal(outcomes[second.opId].status, "already_exists");
      assert.match(result.text, /Already existed: 2/);
      // Last week's task with the same title does not block this week's.
      const wednesday = versionEntry(plan(), 1).plan.operations.find((operation) => operation.opId === "stretch:2026-09-30");
      assert.equal(outcomes[wednesday.opId].status, "created");
      assert.equal(plan().status, "applied");
    });

    it("reports partial failure per item and marks the plan applied_with_errors", async () => {
      await proposeAndReachDeadline();
      const target = versionEntry(plan(), 1).plan.operations.find((operation) => operation.activity === "golfPractice");
      todoist.failures.set(target.payload.content, ["Todoist API request failed: 400 invalid due date"]);

      const result = await run(["apply-due"]);
      assert.equal(plan().status, "applied_with_errors");
      assert.equal(plan().apply.outcomes[target.opId].status, "failed");
      assert.equal(plan().apply.outcomes[target.opId].attempts, 1, "a 400 is not retried");
      assert.match(result.text, /^Applied weekly plan, with errors/);
      assert.match(result.text, /Failed: 1/);
      assert.match(result.text, new RegExp(`- ${target.payload.content}: Todoist API request failed: 400`));
    });

    it("retries a transient failure a bounded number of times with the same request id", async () => {
      await proposeAndReachDeadline();
      const [first, second] = versionEntry(plan(), 1).plan.operations;
      todoist.failures.set(first.payload.content, ["Todoist API request failed: 503", "Todoist API request failed: 429"]);
      todoist.failures.set(second.payload.content, [
        "Todoist API request failed: 503",
        "Todoist API request failed: 503",
        "Todoist API request failed: 503",
      ]);

      await run(["apply-due"]);
      const outcomes = plan().apply.outcomes;
      assert.equal(outcomes[first.opId].status, "created");
      assert.equal(outcomes[first.opId].attempts, 3);
      assert.equal(outcomes[second.opId].status, "failed");
      assert.equal(outcomes[second.opId].attempts, 3);
      const firstIds = new Set(todoist.calls.addTask.filter((call) => call.payload.content === first.payload.content).map((call) => call.requestId));
      assert.equal(firstIds.size, 1);
      assert.equal(todoist.calls.addTask.filter((call) => call.payload.content === second.payload.content).length, 3);
    });

    it("re-checks Todoist before retrying, so a create that actually landed is not repeated", async () => {
      await proposeAndReachDeadline();
      const [first] = versionEntry(plan(), 1).plan.operations;
      todoist.failures.set(first.payload.content, ["create-then-503"]);

      await run(["apply-due"]);
      assert.equal(todoist.tasks.filter((task) => task.content === first.payload.content).length, 1);
      assert.equal(plan().apply.outcomes[first.opId].status, "created");
      assert.equal(plan().apply.outcomes[first.opId].recovered, true);
    });

    it("waits for the next check when Todoist is unreachable, then applies once it is back", async () => {
      await proposeAndReachDeadline();
      const realGetTasks = todoist.getTasks.bind(todoist);
      todoist.getTasks = async () => {
        throw new Error("fetch failed");
      };

      assert.equal((await run(["apply-due"])).text, "NO_REPLY");
      at("2026-09-26T19:15:00.000Z");
      assert.equal((await run(["apply-due"])).text, "NO_REPLY");
      assert.equal(plan().status, "pending");
      assert.equal(plan().applyDeferrals.count, 2);
      assert.equal(todoist.calls.addTask.length, 0);

      todoist.getTasks = realGetTasks;
      at("2026-09-26T19:30:00.000Z");
      assert.match((await run(["apply-due"])).text, /^Applied weekly plan/);
      assert.equal(plan().status, "applied");
    });

    it("fails once, with one message, after the bounded number of unreachable checks", async () => {
      await proposeAndReachDeadline();
      todoist.getTasks = async () => {
        throw new Error("Todoist API request failed: 401");
      };
      const texts = [];
      for (let check = 0; check < 10; check += 1) {
        at(new Date(Date.parse("2026-09-26T19:00:00.000Z") + check * 15 * 60_000).toISOString());
        texts.push((await run(["apply-due"])).text);
      }

      assert.deepEqual(texts.slice(0, 7), Array(7).fill("NO_REPLY"));
      assert.match(texts[7], /^Weekly plan could not be applied/);
      assert.match(texts[7], /Reason: Todoist could not be reached after 8 checks: Todoist API request failed: 401/);
      assert.deepEqual(texts.slice(8), ["NO_REPLY", "NO_REPLY"]);
      assert.equal(plan().status, "failed");
      assert.equal(todoist.calls.addTask.length, 0);
    });

    it("gives a revised version a fresh set of unreachable-Todoist checks", async () => {
      await proposeAndReachDeadline();
      const realGetTasks = todoist.getTasks.bind(todoist);
      todoist.getTasks = async () => {
        throw new Error("fetch failed");
      };
      await run(["apply-due"]);
      assert.equal(plan().applyDeferrals.count, 1);

      todoist.getTasks = realGetTasks;
      await run(["revise", "--expect-version", "1", "--changes-json", '{"targets":{"gym":3}}']);
      assert.equal(plan().applyDeferrals, null);
    });

    it("tells the user at once when an explicit OK cannot reach Todoist, and keeps the plan pending", async () => {
      await run(["propose", "--send"]);
      todoist.getTasks = async () => {
        throw new Error("fetch failed");
      };
      await assert.rejects(
        run(["accept", "--version", "1", "--reply-text", "OK"]),
        /Could not reach Todoist, so nothing was created and the plan stays pending/,
      );
      assert.equal(plan().status, "pending");
    });

    it("does not let an unreadable plan file block other plans", async () => {
      await proposeAndReachDeadline();
      writeFileSync(join(stateDir, "weekly-plan/plans/wp-2026-W41-bad000.json"), "{ broken");

      assert.match((await run(["apply-due"])).text, /^Applied weekly plan/);
      const status = await run(["status"]);
      assert.equal(status.unreadablePlanFiles.length, 1);
      assert.match(status.telegramText, /1 weekly plan file\(s\) could not be read and are ignored/);
    });

    it("resumes after a crash without recreating finished operations", async () => {
      await proposeAndReachDeadline();
      const operations = versionEntry(plan(), 1).plan.operations;
      const crashAt = operations[2].opId;
      const crashingStore = createWeeklyPlanStore({ stateDir });
      const realWrite = crashingStore.writePlan;
      crashingStore.writePlan = (document) => {
        // Crash after Todoist accepted the third task but before it was recorded.
        if (document.apply?.outcomes?.[crashAt]?.status === "created") throw new Error("simulated crash");
        return realWrite(document);
      };

      await assert.rejects(
        applyWeeklyPlan({ store: crashingStore, planId: "wp-2026-W40-abc123", trigger: "deadline", todoist, now: () => clock }),
        /simulated crash/,
      );
      assert.equal(plan().status, "applying");
      assert.equal(plan().apply.outcomes[crashAt].status, "in_progress");

      const resumed = await run(["apply-due"]);
      assert.match(resumed.text, /^Applied weekly plan/);
      for (const operation of operations) {
        assert.equal(todoist.tasks.filter((task) => task.content === operation.payload.content && task.due.date === operation.date).length, 1, operation.opId);
      }
      assert.equal(plan().apply.outcomes[crashAt].recovered, true);
      assert.equal(plan().status, "applied");
    });

    it("never runs two applies at once", async () => {
      await proposeAndReachDeadline();
      const lockStore = createWeeklyPlanStore({ stateDir });
      await lockStore.withPlanLock("wp-2026-W40-abc123", async () => {
        assert.equal((await run(["apply-due"])).text, "NO_REPLY");
        await assert.rejects(run(["accept", "--version", "1", "--reply-text", "OK"]), /being updated right now/);
      });
      assert.equal(todoist.calls.addTask.length, 0);
      assert.match((await run(["apply-due"])).text, /^Applied weekly plan/);
    });

    it("refuses to apply a plan whose stored operations changed after it was shown", async () => {
      await proposeAndReachDeadline();
      const path = join(stateDir, "weekly-plan/plans/wp-2026-W40-abc123.json");
      const document = JSON.parse(readFileSync(path, "utf8"));
      document.versions[0].plan.operations.push({
        opId: "extra:2026-09-29",
        kind: "create-task",
        activity: "gym",
        date: "2026-09-29",
        payload: { content: "Something never shown" },
      });
      writeFileSync(path, JSON.stringify(document));

      const result = await run(["apply-due"]);
      assert.match(result.text, /^Weekly plan could not be applied/);
      assert.match(result.text, /changed after it was shown; it will not be applied/);
      assert.equal(plan().status, "failed");
      assert.equal(todoist.calls.addTask.length, 0);
      // Final: the next check stays quiet instead of repeating the error.
      at("2026-09-26T19:15:00.000Z");
      assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    });

    it("never executes an operation outside the authorization, even if it was shown", async () => {
      await proposeAndReachDeadline();
      const path = join(stateDir, "weekly-plan/plans/wp-2026-W40-abc123.json");
      const document = JSON.parse(readFileSync(path, "utf8"));
      document.versions[0].plan.operations.unshift({
        opId: "delete:2026-09-29",
        kind: "delete-task",
        activity: "gym",
        date: "2026-09-29",
        payload: { content: "Gym", id: "123" },
      });
      document.versions[0].digest = digestPlan(document.versions[0].plan);
      document.displayedDigest = document.versions[0].digest;
      writeFileSync(path, JSON.stringify(document));

      await run(["apply-due"]);
      assert.match(plan().apply.outcomes["delete:2026-09-29"].error, /^Not authorized: operation kind "delete-task"/);
      assert.ok(todoist.calls.addTask.every((call) => call.payload.content !== "Gym"));
      assert.deepEqual(todoist.calls.forbidden, []);
      assert.equal(plan().status, "applied_with_errors");
    });

    it("skips operations whose date has already passed instead of creating overdue tasks", async () => {
      await run(["propose", "--send"]);
      at("2026-09-26T09:00:00.000Z");
      await run(["revise", "--expect-version", "1", "--changes-json", '{"targets":{"gym":3}}']);
      at("2026-09-29T22:30:00.000Z"); // Wednesday 00:30 in Stockholm
      await run(["apply-due"]);
      const outcomes = plan().apply.outcomes;
      for (const operation of versionEntry(plan(), 2).plan.operations) {
        const expected = operation.date < "2026-09-30" ? "skipped_past_date" : "created";
        assert.equal(outcomes[operation.opId].status, expected, operation.opId);
      }
    });

    it("classifies only rate limits, server errors and network failures as transient", () => {
      assert.equal(isTransient(new Error("Todoist API request failed: 503")), true);
      assert.equal(isTransient(new Error("Todoist API request failed: 429")), true);
      assert.equal(isTransient(new TypeError("fetch failed")), true);
      assert.equal(isTransient(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })), true);
      assert.equal(isTransient(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })), true);
      assert.equal(isTransient(Object.assign(new Error("timed out"), { name: "TimeoutError" })), true);
      assert.equal(isTransient(new Error("Todoist API request failed: 400 bad")), false);
      assert.equal(isTransient(new Error("Todoist API request failed: 401")), false);
      assert.equal(isTransient(new TypeError("Cannot read properties of undefined")), false);
      assert.equal(isTransient(new Error("something unexpected")), false);
    });
  });

  describe("plan lock", () => {
    const lockPath = () => join(stateDir, "weekly-plan/locks/wp-2026-W40-abc123.lock");
    const writeOldLock = (pid) => {
      mkdirSync(join(stateDir, "weekly-plan/locks"), { recursive: true });
      writeFileSync(lockPath(), JSON.stringify({ pid, token: "someone-else" }));
      const old = new Date(Date.now() - 60 * 60_000);
      utimesSync(lockPath(), old, old);
    };

    it("does not take over an old lock whose owner is still running", async () => {
      writeOldLock(process.pid);
      await assert.rejects(
        createWeeklyPlanStore({ stateDir }).withPlanLock("wp-2026-W40-abc123", async () => "ran"),
        /being updated right now/,
      );
    });

    it("takes over an old lock whose owner is gone", async () => {
      writeOldLock(123456);
      const result = await createWeeklyPlanStore({ stateDir, isProcessAlive: () => false }).withPlanLock(
        "wp-2026-W40-abc123",
        async () => "ran",
      );
      assert.equal(result, "ran");
      assert.equal(existsSync(lockPath()), false);
    });

    it("never takes over a recent lock, even without a live owner", async () => {
      mkdirSync(join(stateDir, "weekly-plan/locks"), { recursive: true });
      writeFileSync(lockPath(), JSON.stringify({ pid: 123456, token: "fresh" }));
      await assert.rejects(
        createWeeklyPlanStore({ stateDir, isProcessAlive: () => false }).withPlanLock("wp-2026-W40-abc123", async () => "ran"),
        /being updated right now/,
      );
    });

    it("keeps a live lock fresh while the holder works", async () => {
      const lockStore = createWeeklyPlanStore({ stateDir, lockHeartbeatMs: 5 });
      await lockStore.withPlanLock("wp-2026-W40-abc123", async () => {
        const old = new Date(Date.now() - 60 * 60_000);
        utimesSync(lockPath(), old, old);
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.ok(Date.now() - statSync(lockPath()).mtimeMs < 10_000, "the heartbeat refreshed the lock");
      });
    });

    it("does not remove a lock that another holder owns by the time it finishes", async () => {
      await createWeeklyPlanStore({ stateDir }).withPlanLock("wp-2026-W40-abc123", async () => {
        writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, token: "another-holder" }));
      });
      assert.equal(JSON.parse(readFileSync(lockPath(), "utf8")).token, "another-holder");
    });
  });

  describe("status", () => {
    it("answers whether a plan is pending, when it applies, which version, and whether it was applied", async () => {
      assert.match((await run(["status"])).telegramText, /No weekly plan is pending/);

      await run(["propose", "--send"]);
      await run(["revise", "--expect-version", "1", "--changes-json", '{"targets":{"stretch":4}}']);
      const pending = await run(["status"]);
      assert.equal(pending.pending.length, 1);
      assert.equal(pending.pending[0].currentVersion, 2);
      assert.equal(pending.pending[0].reviewDeadlineLocal, "21:00 on Saturday 26 Sep");
      assert.match(pending.telegramText, /pending \(v2\); I'll create its tasks at 21:00 on Saturday 26 Sep/);

      at("2026-09-26T19:00:00.000Z");
      await run(["apply-due"]);
      const applied = await run(["status"]);
      assert.equal(applied.pending.length, 0);
      assert.equal(applied.upcomingWeek.status, "applied");
      assert.equal(applied.upcomingWeek.appliedVersion, 2);
      assert.match(applied.telegramText, /was applied at 21:00 on Saturday 26 Sep \(v2\)/);
    });

    it("shows the current plan", async () => {
      await run(["propose", "--send"]);
      const shown = await run(["show"]);
      assert.equal(shown.telegramText, sent[0]);
    });
  });

  describe("installation", () => {
    function cronRunner(existing = []) {
      const calls = [];
      return {
        calls,
        runOpenClaw: async (args) => {
          calls.push(args);
          if (args[0] === "cron" && args[1] === "list") return `banner line\n${JSON.stringify({ jobs: existing })}`;
          return "{}";
        },
      };
    }

    it("defines a Saturday 09:00 proposal and a model-free apply check every 15 minutes", () => {
      const [propose, apply] = buildWeeklyPlanCronJobs(schedules, {
        telegramUserId: "1029709001",
        projectRoot: "/repo",
        nodePath: "/usr/bin/node",
      });

      assert.equal(propose.name, WEEKLY_PLAN_PROPOSE_JOB);
      assert.deepEqual(propose.schedule, { kind: "cron", expr: "0 9 * * 6", tz: "Europe/Stockholm" });
      assert.equal(propose.kind, "agentTurn");
      assert.equal(propose.agentId, "personal");
      assert.match(propose.message, /propose --send --input-json-stdin/);
      assert.match(propose.message, /the proposal creates no Todoist tasks/);
      assert.match(propose.message, /Do not create, edit, complete, move or delete Todoist tasks yourself/);
      assert.equal(apply.name, WEEKLY_PLAN_APPLY_JOB);
      assert.equal(apply.kind, "command");
      assert.deepEqual(apply.argv, ["/usr/bin/node", "scripts/weekly-plan.mjs", "apply-due"]);
      assert.equal(apply.cwd, "/repo");
      assert.deepEqual(apply.schedule, { kind: "cron", expr: "*/15 * * * *", tz: "Europe/Stockholm" });
      for (const job of [propose, apply]) assert.equal(job.delivery.to, "telegram:1029709001");
    });

    it("previews installation without changing the Gateway, with the token masked", async () => {
      const runner = cronRunner();
      const result = await run(["install", "--dry-run"], {
        runOpenClaw: runner.runOpenClaw,
        root: stateDir,
        env: { TELEGRAM_USER_ID: "1029709001", OPENCLAW_CLI: "openclaw" },
      });

      assert.equal(result.dryRun, true);
      assert.deepEqual(result.commands.map((command) => command.action), ["add", "add"]);
      assert.deepEqual(runner.calls, [["cron", "list", "--all", "--json"]]);
      assert.match(result.commands[1].display, /--command-argv/);
    });

    it("adds missing jobs and edits existing ones in place", async () => {
      const runner = cronRunner([{ id: "job-1", name: WEEKLY_PLAN_PROPOSE_JOB, enabled: false }]);
      const result = await run(["install"], {
        runOpenClaw: runner.runOpenClaw,
        root: stateDir,
        env: { TELEGRAM_USER_ID: "1029709001", OPENCLAW_CLI: "openclaw" },
      });

      assert.deepEqual(result.results.map((entry) => entry.action), ["edit", "add"]);
      const edit = runner.calls.find((args) => args[1] === "edit");
      assert.deepEqual(edit.slice(0, 4), ["cron", "edit", "job-1", "--enable"]);
      const add = runner.calls.find((args) => args[1] === "add");
      assert.ok(add.includes(WEEKLY_PLAN_APPLY_JOB));
      assert.ok(!add.includes("--message"), "the apply job has no model message");
    });
  });

  it("parses arguments strictly", () => {
    assert.throws(() => parseWeeklyPlanArgs(["revise"]), /requires --expect-version/);
    assert.throws(() => parseWeeklyPlanArgs(["accept", "--version", "1"]), /--reply-text/);
    assert.throws(() => parseWeeklyPlanArgs(["propose", "--send", "--reply"]), /either --send or --reply/);
    assert.throws(() => parseWeeklyPlanArgs(["propose", "--yolo"]), /Unknown weekly-plan option/);
    assert.throws(() => parseWeeklyPlanArgs(["delete"]), /Unknown weekly-plan command/);
  });
});
