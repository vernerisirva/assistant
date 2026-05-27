import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildRoutineCronCommands,
  buildRoutineCronJobs,
  maskCronCommandForDisplay,
  upsertRoutineCronJobs,
} from "../scripts/lib/routine-cron.mjs";
import { parseRoutineCronArgs, runRoutineCronCli } from "../scripts/routines-cron.mjs";

const schedules = JSON.parse(readFileSync("config/schedules.json", "utf8"));

describe("routine cron jobs", () => {
  it("builds Telegram cron jobs from the routine schedule", () => {
    const jobs = buildRoutineCronJobs(schedules, { telegramUserId: "1029709001" });

    assert.deepEqual(
      jobs.map((job) => [job.routineId, job.agentId, job.schedule.expr]),
      [
        ["morning-brief", "personal", "0 8 * * *"],
        ["midday-check-in", "health", "30 12 * * *"],
        ["workout-window", "health", "30 17 * * *"],
        ["evening-review", "personal", "0 21 * * *"],
        ["weekly-review", "personal", "0 19 * * 0"],
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
      assert.match(job.message, new RegExp(`npm run routine -- ${job.routineId}`));
      assert.match(job.message, /No side effects without approval/i);
      assert.match(job.message, /feedback/i);
      assert.match(job.message, /ask before storing/i);
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
    assert.ok(command.args.includes("--enable"));
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
    assert.equal(morning.payload.kind, "agentTurn");
    assert.match(morning.payload.message, /morning-brief/);
    assert.equal(morning.delivery.mode, "announce");
  });
});

describe("routine cron CLI", () => {
  it("parses plan and install commands", () => {
    assert.deepEqual(parseRoutineCronArgs(["plan"]), { command: "plan", options: {} });
    assert.deepEqual(parseRoutineCronArgs(["install", "--dry-run"]), {
      command: "install",
      options: { dryRun: true },
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
});
