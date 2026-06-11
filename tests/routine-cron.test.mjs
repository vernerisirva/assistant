import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRoutineCronCommands,
  buildRoutineCronJobs,
  maskCronCommandForDisplay,
  routineCronStatus,
  updateRoutineCronEnabled,
  updateRoutineCronTime,
  upsertRoutineCronJobs,
} from "../scripts/lib/routine-cron.mjs";
import { parseRoutineCronArgs, runRoutineCronCli } from "../scripts/routines-cron.mjs";

const schedules = JSON.parse(readFileSync("config/schedules.json", "utf8"));

describe("routine cron jobs", () => {
  it("builds Telegram cron jobs from the routine schedule", () => {
    const jobs = buildRoutineCronJobs(schedules, { telegramUserId: "1029709001" });

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
      assert.equal(job.delivery.to, "telegram:1029709001");
      assert.equal(job.delivery.bestEffort, true);
      assert.match(job.name, /^Assistant routine:/);
      assert.deepEqual(job.message.split("\n").slice(0, 4), [
        `Scheduled assistant routine: ${job.routineId}.`,
        `First run npm run --silent routines:skips -- --json from the assistant repo and inspect ${job.routineId} for today's Europe/Stockholm date.`,
        `If ${job.routineId} is skippedToday, return exactly NO_REPLY as your final answer and do no routine work.`,
        `If ${job.routineId} is not skippedToday, run npm run routine -- ${job.routineId} from the assistant repo and use the returned telegramPrompt as the briefing template.`,
      ]);
      assert.match(job.message, /skip store/i);
      assert.match(job.message, /No side effects without approval/i);
      assert.match(job.message, /feedback/i);
      assert.match(job.message, /ask before storing/i);
      assert.match(job.message, /Do not call Telegram\/message tools/i);
      assert.match(job.message, /cron delivery will send/i);
      assert.doesNotMatch(job.message, /Send Verneri/i);
    }
  });

  it("plans add commands for missing routine jobs", () => {
    const [job] = buildRoutineCronJobs(schedules, { telegramUserId: "1029709001" });
    const [command] = buildRoutineCronCommands([job], {
      openclawCommand: "openclaw",
      gatewayToken: "secret-token",
      existingJobs: [],
    });

    assert.equal(command.action, "add");
    assert.equal(command.jobName, "Assistant routine: morning-brief");
    assert.deepEqual(command.args.slice(0, 2), ["cron", "add"]);
    assert.ok(command.args.includes("--announce"));
    assert.ok(command.args.includes("--best-effort-deliver"));
    assert.ok(command.args.includes("--disabled"));
    assert.ok(command.args.includes("--exact"));
    assert.ok(command.args.includes("--json"));
    assert.ok(command.args.includes("--token"));
    assert.ok(command.args.includes("secret-token"));
  });

  it("plans edit commands for existing routine jobs", () => {
    const [job] = buildRoutineCronJobs(schedules, { telegramUserId: "1029709001" });
    const [command] = buildRoutineCronCommands([job], {
      openclawCommand: "openclaw",
      existingJobs: [{ id: "existing-job-id", name: "Assistant routine: morning-brief" }],
    });

    assert.equal(command.action, "edit");
    assert.deepEqual(command.args.slice(0, 3), ["cron", "edit", "existing-job-id"]);
    assert.ok(command.args.includes("--disable"));
    assert.ok(command.args.includes("--name"));
  });

  it("masks gateway tokens in displayed commands", () => {
    const displayed = maskCronCommandForDisplay({
      command: "openclaw",
      args: ["cron", "add", "--token", "secret-token", "--name", "Routine"],
    });

    assert.equal(displayed, "openclaw cron add --token <redacted> --name Routine");
  });

  it("upserts routine jobs into an OpenClaw cron store without touching unrelated jobs", () => {
    const jobs = buildRoutineCronJobs(schedules, { telegramUserId: "1029709001" });
    const result = upsertRoutineCronJobs(
      {
        version: 1,
        jobs: [
          {
            id: "unrelated",
            name: "Daily golf training schedule reminder",
            createdAtMs: 1,
            schedule: { kind: "cron", expr: "0 7 * * *", tz: "Europe/Stockholm" },
          },
          {
            id: "existing-morning",
            name: "Assistant routine: morning-brief",
            createdAtMs: 2,
            schedule: { kind: "cron", expr: "15 8 * * *", tz: "Europe/Stockholm" },
            state: { note: "preserve" },
          },
        ],
      },
      jobs,
      {
        nowMs: 1779900000000,
        idGenerator: () => "new-routine-id",
      },
    );

    assert.equal(result.store.jobs.length, 6);
    assert.deepEqual(
      result.results.map((entry) => [entry.action, entry.jobName]),
      [
        ["edit", "Assistant routine: morning-brief"],
        ["add", "Assistant routine: midday-check-in"],
        ["add", "Assistant routine: workout-window"],
        ["add", "Assistant routine: evening-review"],
        ["add", "Assistant routine: weekly-review"],
      ],
    );

    const unrelated = result.store.jobs.find((job) => job.id === "unrelated");
    assert.equal(unrelated.name, "Daily golf training schedule reminder");

    const morning = result.store.jobs.find((job) => job.name === "Assistant routine: morning-brief");
    assert.equal(morning.id, "existing-morning");
    assert.equal(morning.createdAtMs, 2);
    assert.deepEqual(morning.state, { note: "preserve" });
    assert.equal(morning.schedule.expr, "0 8 * * *");
    assert.equal(morning.enabled, false);
    assert.equal(morning.payload.kind, "agentTurn");
    assert.match(morning.payload.message, /morning-brief/);
    assert.equal(morning.delivery.mode, "announce");
  });

  it("reports routine status with next run information", () => {
    const jobs = buildRoutineCronJobs(schedules, { telegramUserId: "1029709001" });
    const upserted = upsertRoutineCronJobs({ version: 1, jobs: [] }, jobs, {
      nowMs: 1779900000000,
      idGenerator: () => "routine-id",
    }).store;
    const morning = upserted.jobs.find((job) => job.name === "Assistant routine: morning-brief");

    const status = routineCronStatus(upserted, {
      jobs: {
        [morning.id]: {
          state: {
            nextRunAtMs: 1779948000000,
            lastStatus: "ok",
          },
        },
      },
    });

    assert.equal(status.length, 5);
    assert.deepEqual(status[0], {
      routineId: "morning-brief",
      name: "Assistant routine: morning-brief",
      enabled: false,
      cron: "0 8 * * *",
      timezone: "Europe/Stockholm",
      nextRunAt: "2026-05-28T06:00:00.000Z",
      lastStatus: "ok",
      skippedToday: false,
      skipDate: null,
    });
  });

  it("marks enabled routines skipped today without disabling them", () => {
    const jobs = buildRoutineCronJobs(schedules, { telegramUserId: "1029709001" });
    const upserted = upsertRoutineCronJobs({ version: 1, jobs: [] }, jobs, {
      nowMs: 1779900000000,
      idGenerator: () => "routine-id",
    }).store;

    const status = routineCronStatus(upserted, { jobs: {} }, {
      skipStore: {
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
      },
      now: new Date("2026-06-11T10:00:00.000Z"),
      timezone: "Europe/Stockholm",
    });

    const workout = status.find((routine) => routine.routineId === "workout-window");
    assert.equal(workout.enabled, true);
    assert.equal(workout.skippedToday, true);
    assert.equal(workout.skipDate, "2026-06-11");
  });

  it("enables and disables only the selected routine job", () => {
    const jobs = buildRoutineCronJobs(schedules, { telegramUserId: "1029709001" });
    const upserted = upsertRoutineCronJobs({ version: 1, jobs: [] }, jobs, {
      nowMs: 1779900000000,
      idGenerator: () => "routine-id",
    }).store;

    const disabled = updateRoutineCronEnabled(upserted, "workout-window", false);
    assert.equal(
      disabled.store.jobs.find((job) => job.name === "Assistant routine: workout-window").enabled,
      false,
    );
    assert.equal(
      disabled.store.jobs.find((job) => job.name === "Assistant routine: morning-brief").enabled,
      false,
    );
    assert.equal(disabled.result.action, "disable");

    const enabled = updateRoutineCronEnabled(disabled.store, "workout-window", true);
    assert.equal(
      enabled.store.jobs.find((job) => job.name === "Assistant routine: workout-window").enabled,
      true,
    );
    assert.equal(enabled.result.action, "enable");
  });

  it("updates daily and weekly routine times", () => {
    const jobs = buildRoutineCronJobs(schedules, { telegramUserId: "1029709001" });
    const upserted = upsertRoutineCronJobs({ version: 1, jobs: [] }, jobs, {
      nowMs: 1779900000000,
      idGenerator: () => "routine-id",
    }).store;

    const daily = updateRoutineCronTime(upserted, "morning-brief", "08:30");
    assert.equal(
      daily.store.jobs.find((job) => job.name === "Assistant routine: morning-brief").schedule.expr,
      "30 8 * * *",
    );

    const weekly = updateRoutineCronTime(daily.store, "weekly-review", "18:45");
    assert.equal(
      weekly.store.jobs.find((job) => job.name === "Assistant routine: weekly-review").schedule.expr,
      "45 18 * * 0",
    );
    assert.equal(weekly.result.action, "set-time");
  });
});

describe("routine cron CLI", () => {
  it("parses plan and install commands", () => {
    assert.deepEqual(parseRoutineCronArgs(["plan"]), { command: "plan", options: {} });
    assert.deepEqual(parseRoutineCronArgs(["install", "--dry-run"]), {
      command: "install",
      options: { dryRun: true },
    });
    assert.deepEqual(parseRoutineCronArgs(["status"]), { command: "status", options: {} });
    assert.deepEqual(parseRoutineCronArgs(["disable", "workout-window"]), {
      command: "disable",
      options: { routineId: "workout-window" },
    });
    assert.deepEqual(parseRoutineCronArgs(["set-time", "morning-brief", "08:30"]), {
      command: "set-time",
      options: { routineId: "morning-brief", time: "08:30" },
    });
    assert.deepEqual(parseRoutineCronArgs(["skips", "--json"]), {
      command: "skips",
      options: { json: true },
    });
    assert.deepEqual(parseRoutineCronArgs(["skip", "workout-window", "2026-06-11", "--dry-run"]), {
      command: "skip",
      options: { routineId: "workout-window", date: "2026-06-11", dryRun: true },
    });
    assert.deepEqual(parseRoutineCronArgs(["unskip", "workout-window", "2026-06-11"]), {
      command: "unskip",
      options: { routineId: "workout-window", date: "2026-06-11" },
    });
  });

  it("runs a dry-run install without spawning OpenClaw", async () => {
    const result = await runRoutineCronCli(["install", "--dry-run"], {
      schedules,
      env: { TELEGRAM_USER_ID: "1029709001" },
      config: { gateway: { remote: { token: "secret-token" } } },
      existingJobs: [],
      spawn: () => {
        throw new Error("spawn should not run during dry-run");
      },
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.commands.length, 5);
    assert.equal(result.commands[0].display.includes("secret-token"), false);
    assert.match(result.commands[0].display, /<redacted>/);
  });

  it("installs routine jobs by writing an updated cron store", async () => {
    let writtenStore;
    const result = await runRoutineCronCli(["install"], {
      schedules,
      env: { TELEGRAM_USER_ID: "1029709001" },
      config: { gateway: { remote: { token: "secret-token" } } },
      existingCronStore: { version: 1, jobs: [] },
      writeCronStore: (store) => {
        writtenStore = store;
      },
      nowMs: 1779900000000,
      idGenerator: () => "generated-id",
    });

    assert.equal(result.dryRun, false);
    assert.equal(result.results.length, 5);
    assert.equal(writtenStore.jobs.length, 5);
    assert.equal(writtenStore.jobs[0].name, "Assistant routine: morning-brief");
  });

  it("runs status and control commands against the cron store", async () => {
    const jobs = buildRoutineCronJobs(schedules, { telegramUserId: "1029709001" });
    const existingCronStore = upsertRoutineCronJobs({ version: 1, jobs: [] }, jobs, {
      nowMs: 1779900000000,
      idGenerator: () => "routine-id",
    }).store;
    let writtenStore;

    const status = await runRoutineCronCli(["status"], {
      schedules,
      env: { TELEGRAM_USER_ID: "1029709001" },
      existingCronStore,
      existingCronState: { jobs: {} },
    });
    assert.equal(status.routines.length, 5);

    const disabled = await runRoutineCronCli(["disable", "midday-check-in"], {
      schedules,
      env: { TELEGRAM_USER_ID: "1029709001" },
      existingCronStore,
      writeCronStore: (store) => {
        writtenStore = store;
      },
    });
    assert.equal(disabled.result.action, "disable");
    assert.equal(
      writtenStore.jobs.find((job) => job.name === "Assistant routine: midday-check-in").enabled,
      false,
    );

    const changed = await runRoutineCronCli(["set-time", "midday-check-in", "13:15"], {
      schedules,
      env: { TELEGRAM_USER_ID: "1029709001" },
      existingCronStore: writtenStore,
      writeCronStore: (store) => {
        writtenStore = store;
      },
    });
    assert.equal(changed.result.action, "set-time");
    assert.equal(
      writtenStore.jobs.find((job) => job.name === "Assistant routine: midday-check-in").schedule.expr,
      "15 13 * * *",
    );
  });

  it("writes a routine skip without requiring an OpenClaw restart", async () => {
    let writtenStore;

    const result = await runRoutineCronCli(["skip", "workout-window", "2026-06-11"], {
      schedules,
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

  it("removes a routine skip without requiring an OpenClaw restart", async () => {
    let writtenStore;

    const result = await runRoutineCronCli(["unskip", "workout-window", "2026-06-11"], {
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
      writeSkipStore: (store) => {
        writtenStore = store;
      },
    });

    assert.equal(result.restartRequired, false);
    assert.equal(result.result.action, "unskip");
    assert.equal(result.result.removed, true);
    assert.deepEqual(writtenStore, { version: 1, skips: [] });
  });

  it("reports routine skip status for today", async () => {
    const result = await runRoutineCronCli(["skips", "--json"], {
      schedules,
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

  it("does not load cron state for skip status commands", async () => {
    const directory = mkdtempSync(join(tmpdir(), "routine-cron-lazy-"));

    try {
      mkdirSync(join(directory, "cron"), { recursive: true });
      writeFileSync(join(directory, "cron/jobs.json"), "{ nope");

      const result = await runRoutineCronCli(["skips", "--json"], {
        schedules,
        stateDir: directory,
        readSkipStoreForStatus: () => ({ version: 1, skips: [] }),
      });

      assert.equal(result.length, 5);
      assert.equal(result.find((entry) => entry.routineId === "workout-window").skippedToday, false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
