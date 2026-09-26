import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRoutineCronJobs,
  findRoutineJob,
  maskCronCommandForDisplay,
  planRoutineInstall,
  routineCronStatus,
} from "../scripts/lib/routine-cron.mjs";
import { normalizeCronJob } from "../scripts/lib/live-cron.mjs";
import {
  formatRoutineCronCliResult,
  parseRoutineCronArgs,
  runRoutineCronCli,
} from "../scripts/routines-cron.mjs";
import { FAKE_TELEGRAM_ID, createFakeOpenClawCron, sampleRawJobs } from "./fixtures/fake-openclaw-cron.mjs";

const schedules = {
  timezone: "Europe/Stockholm",
  daily: [
    {
      id: "morning-brief",
      agent: "personal",
      time: "08:00",
      enabled: false,
      purpose: "Calendar summary, important Gmail, top priorities, meal plan, and workout anchor.",
    },
    {
      id: "midday-check-in",
      agent: "health",
      time: "12:30",
      purpose: "Food, movement, energy, and schedule pressure check.",
    },
    {
      id: "workout-window",
      agent: "health",
      window: {
        start: "16:00",
        end: "19:00",
      },
      purpose: "Find a realistic workout or movement moment from calendar availability.",
    },
    {
      id: "evening-review",
      agent: "personal",
      time: "21:00",
      enabled: false,
      purpose: "Tomorrow's calendar, open admin actions, meal prep needs, and health reflection.",
    },
  ],
  weekly: {
    id: "weekly-review",
    agent: "personal",
    day: "Sunday",
    time: "19:00",
    purpose: "Review calendar, email, health friction, food planning, groceries, and one adjustment for the next week.",
  },
};

const env = { TELEGRAM_USER_ID: FAKE_TELEGRAM_ID };
const desiredJobs = () => buildRoutineCronJobs(schedules, { telegramUserId: FAKE_TELEGRAM_ID });

/** A live routine job exactly as the Gateway imported it from the old store: no stagger field. */
function rawRoutineJob(spec, id, overrides = {}) {
  return {
    id,
    name: spec.name,
    description: spec.description,
    enabled: spec.enabled,
    createdAtMs: 1780000000000,
    updatedAtMs: 1780000000000,
    agentId: spec.agentId,
    sessionKey: spec.sessionKey,
    schedule: { kind: "cron", expr: spec.schedule.expr, tz: spec.schedule.tz },
    sessionTarget: spec.sessionTarget,
    wakeMode: spec.wakeMode,
    payload: { kind: "agentTurn", message: spec.message, timeoutSeconds: spec.timeoutSeconds, model: "openai/kept-model" },
    delivery: { mode: "announce", ...spec.delivery },
    state: { nextRunAtMs: 1790505000000, lastRunAtMs: 1790418600021, lastRunStatus: "ok", lastStatus: "ok" },
    ...overrides,
  };
}

const unrelatedRawJobs = () => sampleRawJobs().filter((job) => !job.name.startsWith("Assistant routine:"));

/** The Gateway as it is when every routine matches config, plus the unrelated jobs. */
function gatewayWithRoutines(overridesById = {}) {
  const routines = desiredJobs().map((spec) => rawRoutineJob(spec, `live-${spec.routineId}`, overridesById[spec.routineId]));
  return [...unrelatedRawJobs(), ...routines];
}

const cli = (argv, fake, extra = {}) => runRoutineCronCli(argv, { schedules, env, runOpenClaw: fake.run, ...extra });

describe("routine job specs", () => {
  it("builds Telegram cron jobs from the routine schedule", () => {
    const jobs = desiredJobs();

    assert.deepEqual(
      jobs.map((job) => [job.routineId, job.agentId, job.schedule.expr, job.enabled]),
      [
        ["morning-brief", "personal", "0 8 * * *", false],
        ["midday-check-in", "health", "30 12 * * *", true],
        ["workout-window", "health", "30 17 * * *", true],
        ["evening-review", "personal", "0 21 * * *", false],
        ["weekly-review", "personal", "0 19 * * 0", true],
      ],
    );

    for (const job of jobs) {
      assert.equal(job.schedule.tz, "Europe/Stockholm");
      assert.equal(job.sessionTarget, "isolated");
      assert.equal(job.wakeMode, "now");
      assert.equal(job.delivery.channel, "telegram");
      assert.equal(job.delivery.accountId, "main");
      assert.equal(job.delivery.to, `telegram:${FAKE_TELEGRAM_ID}`);
      assert.equal(job.delivery.bestEffort, true);
      assert.match(job.name, /^Assistant routine:/);
      assert.match(job.message, new RegExp(`^Scheduled assistant routine: ${job.routineId}\\.`));

      const skipCommandIndex = job.message.indexOf("npm run --silent routines:skips -- --json");
      const routineCommandIndex = job.message.indexOf(`npm run routine -- ${job.routineId}`);
      const noReplyIndex = job.message.indexOf(`If ${job.routineId} is skippedToday`);
      const contextGatheringIndex = job.message.indexOf("Gather or summarize live Calendar");
      const skipStoreIndex = job.message.search(/skip store/i);

      assert.notEqual(skipCommandIndex, -1);
      assert.notEqual(routineCommandIndex, -1);
      assert.notEqual(noReplyIndex, -1);
      assert.notEqual(contextGatheringIndex, -1);
      assert.notEqual(skipStoreIndex, -1);
      assert.match(job.message, /NO_REPLY/);
      assert.match(job.message, new RegExp(`inspect ${job.routineId} for today's Europe/Stockholm date`));
      assert.ok(skipCommandIndex < routineCommandIndex);
      assert.ok(noReplyIndex < routineCommandIndex);
      assert.ok(noReplyIndex < contextGatheringIndex);
      assert.ok(skipStoreIndex < routineCommandIndex);
      assert.ok(skipStoreIndex < contextGatheringIndex);
      assert.match(job.message, /No side effects without approval/i);
      assert.match(job.message, /feedback/i);
      assert.match(job.message, /ask before storing/i);
      assert.match(job.message, /Do not call Telegram\/message tools/i);
      assert.match(job.message, /cron delivery will send/i);
      assert.doesNotMatch(job.message, /Send Verneri/i);
    }
  });

  it("refuses a Telegram user id that is not numeric", () => {
    assert.throws(() => buildRoutineCronJobs(schedules, { telegramUserId: "" }), /TELEGRAM_USER_ID is required/);
    assert.throws(() => buildRoutineCronJobs(schedules, { telegramUserId: "12 --disable" }), /must be a numeric Telegram user id/);
  });

  it("keeps masking tokens for the weekly plan's command display", () => {
    const displayed = maskCronCommandForDisplay({
      command: "openclaw",
      args: ["cron", "add", "--token", "secret-token", "--name", "Routine"],
    });
    assert.equal(displayed, "openclaw cron add --token <redacted> --name Routine");
  });
});

describe("routine install plan against live jobs", () => {
  it("leaves routines that already match config alone", () => {
    const steps = planRoutineInstall(desiredJobs(), gatewayWithRoutines().map(normalizeCronJob));

    assert.deepEqual(steps.map((step) => [step.routineId, step.action]), [
      ["morning-brief", "unchanged"],
      ["midday-check-in", "unchanged"],
      ["workout-window", "unchanged"],
      ["evening-review", "unchanged"],
      ["weekly-review", "unchanged"],
    ]);
  });

  it("edits only the fields that differ and adds a missing routine", () => {
    const live = gatewayWithRoutines({
      "workout-window": { schedule: { kind: "cron", expr: "0 17 * * *", tz: "Europe/Stockholm" } },
      "midday-check-in": { enabled: false },
    }).filter((job) => job.id !== "live-weekly-review");

    const steps = planRoutineInstall(desiredJobs(), live.map(normalizeCronJob));
    const byId = Object.fromEntries(steps.map((step) => [step.routineId, step]));

    assert.deepEqual(byId["workout-window"].args, ["--cron=30 17 * * *", "--tz=Europe/Stockholm", "--exact"]);
    assert.deepEqual(byId["workout-window"].changes, [
      { field: "schedule", before: "cron 0 17 * * * Europe/Stockholm", after: "cron 30 17 * * * Europe/Stockholm" },
    ]);
    assert.deepEqual(byId["midday-check-in"].args, ["--enable"]);
    assert.equal(byId["weekly-review"].action, "add");
    assert.ok(byId["weekly-review"].args.includes("--cron=0 19 * * 0"));
    assert.equal(byId["morning-brief"].action, "unchanged");
  });

  it("stops before any change when a routine name matches two live jobs", () => {
    const live = gatewayWithRoutines();
    live.push({ ...live.find((job) => job.id === "live-midday-check-in"), id: "live-midday-copy" });

    assert.throws(
      () => planRoutineInstall(desiredJobs(), live.map(normalizeCronJob)),
      /Several live Gateway jobs are named "Assistant routine: midday-check-in" \(live-midday-check-in, live-midday-copy\)/,
    );
  });

  it("refuses to turn a job with a routine's name but another payload into a routine", () => {
    const live = gatewayWithRoutines({ "workout-window": { payload: { kind: "command", argv: ["true"] } } });
    assert.throws(() => planRoutineInstall(desiredJobs(), live.map(normalizeCronJob)), /runs a command payload; refusing to turn it into a routine/);
  });
});

describe("routines CLI against the live Gateway", () => {
  it("plans without changing anything and prints no Telegram id or prompt text", async () => {
    const fake = createFakeOpenClawCron({
      jobs: gatewayWithRoutines({ "workout-window": { payload: { kind: "agentTurn", message: "old prompt", timeoutSeconds: 180 } } }),
    });
    const plan = await cli(["plan"], fake);

    assert.deepEqual(fake.mutations(), []);
    const workout = plan.steps.find((step) => step.routineId === "workout-window");
    assert.equal(workout.action, "edit");
    assert.deepEqual(workout.changes.map((change) => change.field), ["payload"]);
    assert.match(workout.display, /^openclaw cron edit live-workout-window --message=<\d+ chars> --timeout-seconds=180$/);
    assert.equal(JSON.stringify(plan).includes(FAKE_TELEGRAM_ID), false);
  });

  it("installs missing routines with a true upsert and leaves unrelated jobs untouched", async () => {
    const fake = createFakeOpenClawCron({ jobs: unrelatedRawJobs() });
    const unrelatedBefore = structuredClone(fake.jobs);

    const result = await cli(["install"], fake);

    assert.equal(result.dryRun, false);
    assert.equal(result.restartRequired, false);
    assert.deepEqual(result.results.map((entry) => [entry.routineId, entry.action]), [
      ["morning-brief", "add"],
      ["midday-check-in", "add"],
      ["workout-window", "add"],
      ["evening-review", "add"],
      ["weekly-review", "add"],
    ]);
    assert.deepEqual(result.verification, { remainingDifferences: [], unrelatedJobsChanged: [] });

    const adds = fake.mutations().filter((args) => args[1] === "add");
    assert.equal(adds.length, 5);
    for (const args of adds) {
      assert.ok(args.includes("--exact"));
      assert.ok(args.includes("--announce"));
      assert.ok(args.includes(`--to=telegram:${FAKE_TELEGRAM_ID}`));
      assert.ok(args.includes("--json"));
      assert.ok(!args.some((arg) => arg.startsWith("--token")), "the CLI reads the token from config");
    }
    assert.ok(adds.find((args) => args.includes("--name=Assistant routine: morning-brief")).includes("--disabled"));
    assert.ok(!adds.find((args) => args.includes("--name=Assistant routine: midday-check-in")).includes("--disabled"));

    const routineJobs = fake.jobs.filter((job) => job.name.startsWith("Assistant routine:"));
    assert.equal(routineJobs.length, 5);
    assert.equal(new Set(routineJobs.map((job) => job.name)).size, 5);
    assert.deepEqual(fake.jobs.filter((job) => !job.name.startsWith("Assistant routine:")), unrelatedBefore);
  });

  it("edits an existing routine in place, keeps fields it does not own, and creates no duplicate", async () => {
    const fake = createFakeOpenClawCron({
      jobs: gatewayWithRoutines({
        "workout-window": { schedule: { kind: "cron", expr: "0 17 * * *", tz: "Europe/Stockholm" } },
        "morning-brief": { enabled: true },
      }),
    });
    const before = structuredClone(fake.jobs.find((job) => job.id === "live-workout-window"));

    const first = await cli(["install"], fake);
    assert.deepEqual(first.results.filter((entry) => entry.action !== "unchanged").map((entry) => [entry.routineId, entry.action]), [
      ["morning-brief", "edit"],
      ["workout-window", "edit"],
    ]);
    assert.deepEqual(fake.mutations(), [
      ["cron", "edit", "live-morning-brief", "--disable"],
      ["cron", "edit", "live-workout-window", "--cron=30 17 * * *", "--tz=Europe/Stockholm", "--exact"],
    ]);
    const after = fake.jobs.find((job) => job.id === "live-workout-window");
    assert.deepEqual(after.schedule, { kind: "cron", expr: "30 17 * * *", tz: "Europe/Stockholm", staggerMs: 0 });
    assert.equal(after.payload.model, "openai/kept-model");
    assert.deepEqual({ ...after, schedule: before.schedule, updatedAtMs: before.updatedAtMs }, before);

    const second = await cli(["install"], fake);
    assert.ok(second.results.every((entry) => entry.action === "unchanged"));
    assert.equal(fake.mutations().length, 2, "a second install changes nothing");
    assert.equal(fake.jobs.filter((job) => job.name.startsWith("Assistant routine:")).length, 5);
  });

  it("previews an install without mutating the Gateway", async () => {
    const fake = createFakeOpenClawCron({ jobs: unrelatedRawJobs() });
    const result = await cli(["install", "--dry-run"], fake);

    assert.equal(result.dryRun, true);
    assert.equal(result.steps.length, 5);
    assert.deepEqual(fake.mutations(), []);
    assert.equal(JSON.stringify(result).includes(FAKE_TELEGRAM_ID), false);
  });

  it("refuses to install over duplicated routine jobs", async () => {
    const jobs = gatewayWithRoutines();
    jobs.push({ ...jobs.find((job) => job.id === "live-weekly-review"), id: "live-weekly-review-copy" });
    const fake = createFakeOpenClawCron({ jobs });

    await assert.rejects(cli(["install"], fake), /Several live Gateway jobs are named "Assistant routine: weekly-review"/);
    assert.deepEqual(fake.mutations(), []);
  });

  it("reports live routine status, run state, skips, missing and duplicated routines", async () => {
    const jobs = gatewayWithRoutines().filter((job) => job.id !== "live-evening-review");
    jobs.push({ ...jobs.find((job) => job.id === "live-weekly-review"), id: "live-weekly-review-copy" });
    const fake = createFakeOpenClawCron({ jobs });

    const status = await cli(["status"], fake, {
      now: new Date("2026-06-11T10:00:00.000Z"),
      readSkipStoreForStatus: () => ({
        version: 1,
        skips: [{ routineId: "workout-window", date: "2026-06-11", timezone: "Europe/Stockholm", source: "telegram", createdAt: "2026-06-10T20:15:00.000Z" }],
      }),
    });

    assert.equal(status.source, "openclaw-gateway");
    assert.deepEqual(status.notInstalled, ["evening-review"]);
    assert.deepEqual(status.duplicates, ["weekly-review"]);
    const workout = status.routines.find((routine) => routine.routineId === "workout-window");
    assert.deepEqual(workout, {
      routineId: "workout-window",
      jobId: "live-workout-window",
      name: "Assistant routine: workout-window",
      enabled: true,
      cron: "30 17 * * *",
      timezone: "Europe/Stockholm",
      nextRunAt: new Date(1790505000000).toISOString(),
      lastRunAt: new Date(1790418600021).toISOString(),
      lastStatus: "ok",
      skippedToday: true,
      skipDate: "2026-06-11",
    });
    assert.equal(status.routines.find((routine) => routine.routineId === "morning-brief").enabled, false);
    assert.deepEqual(fake.mutations(), []);
  });

  it("disables and enables one routine live, with no restart", async () => {
    const fake = createFakeOpenClawCron({ jobs: gatewayWithRoutines() });

    const disabled = await cli(["disable", "midday-check-in"], fake);
    assert.equal(disabled.applied, true);
    assert.equal(disabled.restartRequired, false);
    assert.deepEqual(disabled.result, {
      action: "disable",
      routineId: "midday-check-in",
      jobId: "live-midday-check-in",
      jobName: "Assistant routine: midday-check-in",
    });
    assert.deepEqual(disabled.verification.unrelatedJobsChanged, []);
    assert.equal(JSON.stringify(disabled).includes(FAKE_TELEGRAM_ID), false);

    const again = await cli(["disable", "midday-check-in"], fake);
    assert.equal(again.changed, false);

    await cli(["enable", "midday-check-in"], fake);
    assert.deepEqual(fake.mutations(), [
      ["cron", "disable", "live-midday-check-in"],
      ["cron", "enable", "live-midday-check-in"],
    ]);
  });

  it("changes one routine's time and keeps its day and timezone", async () => {
    const fake = createFakeOpenClawCron({ jobs: gatewayWithRoutines() });
    const result = await cli(["set-time", "weekly-review", "18:45"], fake);

    assert.equal(result.result.cron, "45 18 * * 0");
    assert.deepEqual(fake.mutations(), [["cron", "edit", "live-weekly-review", "--cron=45 18 * * 0", "--tz=Europe/Stockholm"]]);
    assert.deepEqual(result.verification.unexpectedFields, []);
  });

  it("previews enable, disable and set-time without mutating the Gateway", async () => {
    for (const argv of [["disable", "midday-check-in"], ["enable", "morning-brief"], ["set-time", "midday-check-in", "13:15"]]) {
      const fake = createFakeOpenClawCron({ jobs: gatewayWithRoutines() });
      const result = await cli([...argv, "--dry-run"], fake);

      assert.equal(result.dryRun, true);
      assert.equal(result.applied, false);
      assert.equal(result.changed, true);
      assert.deepEqual(fake.mutations(), [], argv.join(" "));
    }
  });

  it("names a routine that is not installed", async () => {
    const fake = createFakeOpenClawCron({ jobs: unrelatedRawJobs() });
    await assert.rejects(cli(["disable", "workout-window"], fake), /Routine cron job not installed: Assistant routine: workout-window/);
    await assert.rejects(cli(["disable", "../x"], fake), /Invalid routine id/);
  });

  it("finds a routine job by its exact name only", () => {
    const jobs = gatewayWithRoutines().map(normalizeCronJob);
    assert.equal(findRoutineJob(jobs, "weekly-review").id, "live-weekly-review");
    assert.throws(() => findRoutineJob(jobs, "weekly"), /not installed/);
  });

  it("reports routine status from normalized jobs directly", () => {
    const status = routineCronStatus(gatewayWithRoutines().map(normalizeCronJob), { now: new Date("2026-06-11T10:00:00.000Z") });
    assert.equal(status.length, 5);
    assert.ok(status.every((routine) => routine.skippedToday === false));
  });
});

describe("routine skips stay local", () => {
  const gatewayMustNotBeCalled = async () => {
    throw new Error("skip commands must not call the Gateway");
  };

  it("parses routine commands", () => {
    assert.deepEqual(parseRoutineCronArgs(["plan"]), { command: "plan", options: {} });
    assert.deepEqual(parseRoutineCronArgs(["install", "--dry-run"]), { command: "install", options: { dryRun: true } });
    assert.deepEqual(parseRoutineCronArgs(["status"]), { command: "status", options: {} });
    assert.deepEqual(parseRoutineCronArgs(["disable", "workout-window"]), {
      command: "disable",
      options: { routineId: "workout-window" },
    });
    assert.deepEqual(parseRoutineCronArgs(["set-time", "morning-brief", "08:30"]), {
      command: "set-time",
      options: { routineId: "morning-brief", time: "08:30" },
    });
    assert.deepEqual(parseRoutineCronArgs(["skips", "--json"]), { command: "skips", options: { json: true } });
    assert.deepEqual(parseRoutineCronArgs(["skip", "workout-window", "2026-06-11", "--dry-run"]), {
      command: "skip",
      options: { routineId: "workout-window", date: "2026-06-11", dryRun: true },
    });
    assert.deepEqual(parseRoutineCronArgs(["unskip", "workout-window", "2026-06-11"]), {
      command: "unskip",
      options: { routineId: "workout-window", date: "2026-06-11" },
    });
  });

  it("writes a routine skip without calling the Gateway or requiring a restart", async () => {
    let writtenStore;

    const result = await runRoutineCronCli(["skip", "workout-window", "2026-06-11"], {
      schedules,
      runOpenClaw: gatewayMustNotBeCalled,
      now: new Date("2026-06-10T20:15:00.000Z"),
      readSkipStoreForMutation: () => ({ version: 1, skips: [] }),
      writeSkipStore: (store) => {
        writtenStore = store;
      },
    });

    assert.equal(result.restartRequired, false);
    assert.equal(result.result.action, "skip");
    assert.deepEqual(writtenStore, {
      version: 1,
      skips: [
        {
          routineId: "workout-window",
          date: "2026-06-11",
          timezone: "Europe/Stockholm",
          source: "telegram",
          createdAt: "2026-06-10T20:15:00.000Z",
        },
      ],
    });
  });

  it("removes a routine skip without calling the Gateway or requiring a restart", async () => {
    let writtenStore;

    const result = await runRoutineCronCli(["unskip", "workout-window", "2026-06-11"], {
      schedules,
      runOpenClaw: gatewayMustNotBeCalled,
      readSkipStoreForMutation: () => ({
        version: 1,
        skips: [
          {
            routineId: "workout-window",
            date: "2026-06-11",
            timezone: "Europe/Stockholm",
            source: "telegram",
            createdAt: "2026-06-10T20:15:00.000Z",
          },
        ],
      }),
      writeSkipStore: (store) => {
        writtenStore = store;
      },
    });

    assert.equal(result.restartRequired, false);
    assert.equal(result.result.action, "unskip");
    assert.equal(result.result.removed, true);
    assert.deepEqual(writtenStore, { version: 1, skips: [] });
  });

  it("formats skip and unskip confirmations with no-restart guidance", () => {
    assert.match(
      formatRoutineCronCliResult("skip", {
        result: { action: "skip", added: true, routineId: "workout-window", date: "2026-06-12", timezone: "Europe/Stockholm" },
      }),
      /No gateway restart is required/i,
    );
    assert.match(
      formatRoutineCronCliResult("unskip", {
        result: { action: "unskip", removed: true, routineId: "workout-window", date: "2026-06-12", timezone: "Europe/Stockholm" },
      }),
      /No gateway restart is required/i,
    );
  });

  it("reports routine skip status for today without calling the Gateway", async () => {
    const result = await runRoutineCronCli(["skips", "--json"], {
      schedules,
      runOpenClaw: gatewayMustNotBeCalled,
      now: new Date("2026-06-10T22:30:00.000Z"),
      readSkipStoreForStatus: () => ({
        version: 1,
        skips: [
          {
            routineId: "workout-window",
            date: "2026-06-11",
            timezone: "Europe/Stockholm",
            source: "telegram",
            createdAt: "2026-06-10T20:15:00.000Z",
          },
        ],
      }),
    });

    assert.equal(result.length, 5);
    assert.deepEqual(result.find((entry) => entry.routineId === "workout-window"), {
      routineId: "workout-window",
      date: "2026-06-11",
      timezone: "Europe/Stockholm",
      skippedToday: true,
    });
    assert.equal(result.find((entry) => entry.routineId === "morning-brief").skippedToday, false);
  });

  it("does not rewrite the skip store when skip is already present", async () => {
    const result = await runRoutineCronCli(["skip", "workout-window", "2026-06-11"], {
      schedules,
      readSkipStoreForMutation: () => ({
        version: 1,
        skips: [
          {
            routineId: "workout-window",
            date: "2026-06-11",
            timezone: "Europe/Stockholm",
            source: "telegram",
            createdAt: "2026-06-10T20:15:00.000Z",
          },
        ],
      }),
      writeSkipStore: () => {
        throw new Error("writeSkipStore should not run for an existing skip");
      },
    });

    assert.equal(result.result.action, "skip");
    assert.equal(result.result.added, false);
  });

  it("does not rewrite the skip store when unskip has nothing to remove", async () => {
    const result = await runRoutineCronCli(["unskip", "workout-window", "2026-06-11"], {
      schedules,
      readSkipStoreForMutation: () => ({ version: 1, skips: [] }),
      writeSkipStore: () => {
        throw new Error("writeSkipStore should not run for a missing skip");
      },
    });

    assert.equal(result.result.action, "unskip");
    assert.equal(result.result.removed, false);
  });

  it("does not write the skip store during skip dry runs", async () => {
    const result = await runRoutineCronCli(["skip", "workout-window", "2026-06-11", "--dry-run"], {
      schedules,
      readSkipStoreForMutation: () => ({ version: 1, skips: [] }),
      writeSkipStore: () => {
        throw new Error("writeSkipStore should not run during dry-run");
      },
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.result.action, "skip");
    assert.equal(result.result.added, true);
  });
});
