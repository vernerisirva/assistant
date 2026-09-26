import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_CRON_RESTART_REQUIRED,
  changedJobs,
  createGatewayCron,
  createLiveCron,
  createOpenClawCliRunner,
  createSecretRedactor,
  executeJobChange,
  isDailyCronSchedule,
  loadLiveCronSnapshot,
  maskCronCommandForDisplay,
  normalizeCronJob,
  planCronExpressionChange,
  planEnabledChange,
  planOneShotChange,
  publicCronJob,
  summarizeCronJobs,
} from "../scripts/lib/live-cron.mjs";
import { FAKE_TELEGRAM_ID, createFakeOpenClawCron, sampleRawJobs } from "./fixtures/fake-openclaw-cron.mjs";

function liveCronFor(fake) {
  return createLiveCron({ run: fake.run });
}

describe("live cron adapter: reading the Gateway", () => {
  it("lists enabled and disabled jobs with one read-only CLI call", async () => {
    const fake = createFakeOpenClawCron();
    const jobs = await liveCronFor(fake).list();

    assert.deepEqual(fake.calls, [["cron", "list", "--all", "--json"]]);
    assert.equal(jobs.length, 11);
    assert.equal(jobs.filter((job) => job.enabled).length, 6);
    assert.ok(jobs.some((job) => job.name === "Assistant weather: morning" && job.enabled === false));
    assert.ok(jobs.some((job) => job.name === "Assistant weekly plan: propose" && job.enabled === true));
  });

  it("normalizes a cron job into Hilla's shape, run state included", async () => {
    const jobs = await liveCronFor(createFakeOpenClawCron()).list();
    const workout = jobs.find((job) => job.id === "routine-workout");

    assert.deepEqual(workout, {
      id: "routine-workout",
      name: "Assistant routine: workout-window",
      description: "Assistant routine: workout-window description",
      agentId: "health",
      enabled: true,
      status: "error",
      schedule: { kind: "cron", expr: "30 17 * * *", timezone: "Europe/Stockholm", staggerMs: null },
      sessionTarget: "isolated",
      sessionKey: `agent:health:telegram:main:direct:${FAKE_TELEGRAM_ID}`,
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Assistant routine: workout-window prompt", timeoutSeconds: 180 },
      delivery: { mode: "announce", channel: "telegram", to: `telegram:${FAKE_TELEGRAM_ID}`, accountId: "main", bestEffort: true },
      deleteAfterRun: false,
      nextRunAt: new Date(1790436600000).toISOString(),
      lastRunAt: new Date(1790350200024).toISOString(),
      lastStatus: "error",
      lastErrorReason: "auth",
      warnings: [],
    });
  });

  it("normalizes a one-shot job and a command job", async () => {
    const jobs = await liveCronFor(createFakeOpenClawCron()).list();
    const card = jobs.find((job) => job.id === "one-shot-card");
    const apply = jobs.find((job) => job.id === "wp-apply");

    assert.deepEqual(card.schedule, { kind: "at", at: "2028-12-18T08:00:00.000Z" });
    assert.equal(card.deleteAfterRun, true);
    assert.equal(card.nextRunAt, "2028-12-18T08:00:00.000Z");
    assert.deepEqual(apply.payload, {
      kind: "command",
      argv: ["/usr/bin/node", "scripts/weekly-plan.mjs", "apply-due"],
      cwd: "/repo",
      timeoutSeconds: 300,
    });
    assert.equal(apply.schedule.staggerMs, 0);
    assert.equal(apply.lastStatus, "ok");
  });

  it("keeps interval jobs and marks schedule kinds it does not know instead of guessing", () => {
    const every = normalizeCronJob(sampleRawJobs().find((job) => job.id === "legacy-food-every"));
    const onExit = normalizeCronJob({ id: "watcher", name: "Watcher", schedule: { kind: "on-exit", command: "make" }, payload: { kind: "command" } });
    const broken = normalizeCronJob({ id: "broken", name: "Broken" });

    assert.deepEqual(every.schedule, { kind: "every", everyMs: 604800000, anchorAt: new Date(1784478600000).toISOString() });
    assert.deepEqual(onExit.schedule, { kind: "on-exit", supported: false });
    assert.deepEqual(broken.schedule, { kind: "unknown", supported: false });
    assert.deepEqual(broken.payload, { kind: "unknown" });

    const summary = summarizeCronJobs([every, onExit, broken]);
    assert.equal(summary.intervalJobs, 1);
    assert.equal(summary.otherScheduleJobs, 2);
    assert.equal(summary.cronJobs, 0);
  });

  it("drops invalid run timestamps with a warning", () => {
    const job = normalizeCronJob({
      id: "odd",
      name: "Odd",
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * *" },
      state: { nextRunAtMs: "not-a-date", lastRunAtMs: 1e100, lastStatus: "ok" },
    });

    assert.equal(job.nextRunAt, null);
    assert.equal(job.lastRunAt, null);
    assert.equal(job.lastStatus, "ok");
    assert.deepEqual(job.warnings, ["invalid nextRunAtMs", "invalid lastRunAtMs"]);
  });

  it("reads scheduler status even when the CLI prints a blank line first", async () => {
    const status = await liveCronFor(createFakeOpenClawCron()).schedulerStatus();
    assert.deepEqual(status, { enabled: true, storage: "sqlite", jobCount: 11, nextWakeAt: new Date(1790424000000).toISOString() });
  });

  it("rejects malformed CLI JSON without echoing the output", async () => {
    const cron = createLiveCron({ run: async () => `not json at all, telegram:${FAKE_TELEGRAM_ID}` });

    await assert.rejects(cron.list(), (error) => {
      assert.match(error.message, /openclaw cron list did not return JSON/);
      assert.equal(error.message.includes(FAKE_TELEGRAM_ID), false);
      return true;
    });
  });

  it("refuses a partial job list, which could hide a job with the same name", async () => {
    const cron = createLiveCron({
      run: async () => JSON.stringify({ jobs: [{ id: "a", name: "A" }], total: 2, hasMore: true, nextOffset: 1 }),
    });
    await assert.rejects(cron.list(), /returned 1 of 2 jobs; a partial list cannot be used/);
  });

  it("drops the CLI's delivery previews and prints no Telegram id in the public view", async () => {
    const jobs = await liveCronFor(createFakeOpenClawCron()).list();
    const views = jobs.map(publicCronJob);

    assert.equal(JSON.stringify(views).includes(FAKE_TELEGRAM_ID), false);
    assert.equal(JSON.stringify(jobs).includes("announce ->"), false);
    assert.deepEqual(views.find((view) => view.id === "routine-workout").delivery, { mode: "announce", channel: "telegram" });
    assert.equal(views.find((view) => view.id === "routine-workout").payload, "agentTurn");
    assert.equal("sessionKey" in views[0], false);
  });
});

describe("live cron adapter: CLI failures", () => {
  it("reduces a failure to one redacted line without the command's arguments", async () => {
    const run = createOpenClawCliRunner({
      command: "/fake/openclaw",
      redact: createSecretRedactor({
        env: { TELEGRAM_USER_ID: FAKE_TELEGRAM_ID, OPENCLAW_GATEWAY_TOKEN: "gateway-secret-token-value" },
      }),
      execFileImpl: (command, args, options, callback) => {
        const error = Object.assign(new Error("Command failed"), { code: 1 });
        callback(error, "", `OpenClaw 2026.7.1-2 (0790d9f)\nunauthorized: token gateway-secret-token-value rejected for telegram:${FAKE_TELEGRAM_ID}\n`);
      },
    });

    await assert.rejects(run(["cron", "edit", "job-1", "--message=private routine prompt text"]), (error) => {
      assert.equal(error.name, "LiveCronError");
      assert.match(error.message, /^openclaw cron edit failed: unauthorized: token <redacted> rejected for telegram:<telegram-id>$/);
      assert.equal(error.message.includes("private routine prompt text"), false);
      assert.equal(error.message.includes("gateway-secret-token-value"), false);
      assert.equal(error.message.includes(FAKE_TELEGRAM_ID), false);
      return true;
    });
  });

  it("names a missing CLI and a timeout plainly", async () => {
    const missing = createOpenClawCliRunner({
      command: "/nowhere/openclaw",
      execFileImpl: (command, args, options, callback) => callback(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })),
    });
    await assert.rejects(missing(["cron", "list"]), /openclaw cron list failed: OpenClaw CLI not found at \/nowhere\/openclaw\./);

    const slow = createOpenClawCliRunner({
      command: "/fake/openclaw",
      timeoutMs: 5000,
      execFileImpl: (command, args, options, callback) => callback(Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" })),
    });
    await assert.rejects(slow(["cron", "list"]), /timed out after 5s/);
  });

  it("turns a missing OpenClaw runtime into an error from the first call, not at construction", async () => {
    const run = createOpenClawCliRunner({
      command: () => {
        throw new Error("No OpenClaw runtime found.");
      },
    });
    const cron = createLiveCron({ run });
    await assert.rejects(cron.list(), { name: "LiveCronError", message: "No OpenClaw runtime found." });
  });

  it("reports an unreadable scheduler as unavailable, never as an empty job list", async () => {
    const snapshot = await loadLiveCronSnapshot(
      createLiveCron({
        run: async () => {
          throw new Error("openclaw cron list failed: gateway closed (1006)");
        },
      }),
    );

    assert.deepEqual(snapshot, {
      available: false,
      source: "openclaw-gateway",
      jobs: [],
      scheduler: null,
      error: "openclaw cron list failed: gateway closed (1006)",
    });
  });

  it("runs an injected runner instead of a real process", async () => {
    const fake = createFakeOpenClawCron();
    const snapshot = await loadLiveCronSnapshot(createGatewayCron({ runOpenClaw: fake.run }));

    assert.equal(snapshot.available, true);
    assert.equal(snapshot.jobs.length, 11);
    assert.equal(snapshot.scheduler.storage, "sqlite");
  });
});

describe("live cron adapter: changes", () => {
  it("passes values as --flag=value and refuses ids that could be read as options", async () => {
    const fake = createFakeOpenClawCron();
    const cron = liveCronFor(fake);

    await cron.setCronExpression("routine-midday", "15 13 * * *", { timezone: "Europe/Stockholm" });
    await cron.rescheduleOneShot("one-shot-card", "2028-12-19T08:00:00.000Z");
    await cron.enable("weather-morning");

    assert.deepEqual(fake.mutations(), [
      ["cron", "edit", "routine-midday", "--cron=15 13 * * *", "--tz=Europe/Stockholm"],
      ["cron", "edit", "one-shot-card", "--at=2028-12-19T08:00:00.000Z"],
      ["cron", "enable", "weather-morning"],
    ]);
    for (const id of ["--help", "-x", "a b", "", undefined]) {
      await assert.rejects(cron.disable(id), /Refusing an unexpected cron job id/);
    }
    assert.equal(fake.mutations().length, 3);
  });

  it("keeps the stagger and timezone when only the time changes", async () => {
    const fake = createFakeOpenClawCron();
    const cron = liveCronFor(fake);
    const after = await cron.setCronExpression("wp-propose", "30 9 * * 6", { timezone: "Europe/Stockholm" });

    assert.deepEqual(after.schedule, { kind: "cron", expr: "30 9 * * 6", timezone: "Europe/Stockholm", staggerMs: 0 });
  });

  it("makes no Gateway call for a dry run or a change that changes nothing", async () => {
    const fake = createFakeOpenClawCron();
    const cron = liveCronFor(fake);
    const jobs = await cron.list();
    const midday = jobs.find((job) => job.id === "routine-midday");

    const dryRun = await executeJobChange(cron, planEnabledChange(midday, false), { beforeJobs: jobs, dryRun: true });
    const noop = await executeJobChange(cron, planEnabledChange(midday, true), { beforeJobs: jobs });

    assert.equal(dryRun.applied, false);
    assert.equal(dryRun.after.enabled, false);
    assert.equal(noop.changed, false);
    assert.deepEqual(fake.mutations(), []);
  });

  it("verifies an applied change and proves no other field or job changed", async () => {
    const fake = createFakeOpenClawCron();
    const cron = liveCronFor(fake);
    const jobs = await cron.list();
    const weather = jobs.find((job) => job.id === "weather-morning");

    const outcome = await executeJobChange(cron, planEnabledChange(weather, true), { beforeJobs: jobs });

    assert.equal(LIVE_CRON_RESTART_REQUIRED, false);
    assert.equal(outcome.applied, true);
    assert.equal(outcome.after.enabled, true);
    assert.deepEqual(outcome.verification, { changedFields: ["enabled"], unexpectedFields: [], unrelatedJobsChanged: [] });
    assert.deepEqual(fake.mutations(), [["cron", "enable", "weather-morning"]]);
  });

  it("reports another job that changed during the operation", async () => {
    const fake = createFakeOpenClawCron();
    const cron = createLiveCron({
      run: async (args) => {
        const output = await fake.run(args);
        if (args[1] === "enable") fake.jobs.find((job) => job.id === "wp-propose").enabled = false;
        return output;
      },
    });
    const jobs = await cron.list();
    const outcome = await executeJobChange(cron, planEnabledChange(jobs.find((job) => job.id === "weather-morning"), true), {
      beforeJobs: jobs,
    });

    assert.deepEqual(outcome.verification.unrelatedJobsChanged, [
      { id: "wp-propose", name: "Assistant weekly plan: propose", change: "changed", fields: ["enabled"] },
    ]);
  });

  it("fails loudly when the Gateway did not apply the change", async () => {
    const fake = createFakeOpenClawCron();
    const cron = createLiveCron({
      run: async (args) => (args[1] === "enable" ? JSON.stringify(fake.jobs[6]) : fake.run(args)),
    });
    const jobs = await cron.list();

    await assert.rejects(
      executeJobChange(cron, planEnabledChange(jobs[6], true), { beforeJobs: jobs }),
      /The Gateway did not apply enable to Assistant weather: morning \[weather-morning\]/,
    );
  });

  it("plans time and one-shot changes only for the matching schedule kind", async () => {
    const jobs = await liveCronFor(createFakeOpenClawCron()).list();
    const card = jobs.find((job) => job.id === "one-shot-card");
    const midday = jobs.find((job) => job.id === "routine-midday");

    assert.throws(() => planCronExpressionChange(card, "0 9 * * *"), /is not a cron job \(its schedule kind is at\)/);
    assert.throws(() => planOneShotChange(midday, "2028-01-01T00:00:00.000Z"), /is not a one-shot job \(its schedule kind is cron\)/);
    assert.equal(planOneShotChange(card, "2028-12-18T09:00:00+01:00").changed, false);
    assert.equal(planCronExpressionChange(midday, "30 12 * * *").changed, false);
  });

  it("finds definition changes but ignores run state", () => {
    const before = normalizeCronJob(sampleRawJobs()[1]);
    const ran = normalizeCronJob({ ...sampleRawJobs()[1], updatedAtMs: 1, state: { lastRunAtMs: 2, lastRunStatus: "ok" }, lastRunStatus: "ok" });
    const edited = normalizeCronJob({ ...sampleRawJobs()[1], payload: { kind: "agentTurn", message: "new", timeoutSeconds: 180 } });

    assert.deepEqual(changedJobs([before], [ran]), []);
    assert.deepEqual(changedJobs([before], [edited]), [
      { id: "routine-workout", name: "Assistant routine: workout-window", change: "changed", fields: ["payload.message"] },
    ]);
    assert.deepEqual(changedJobs([before], []), [{ id: "routine-workout", name: "Assistant routine: workout-window", change: "removed" }]);
  });
});

describe("live cron adapter: display and redaction", () => {
  it("masks tokens, the Telegram destination and prompt text in printed commands", () => {
    const shown = maskCronCommandForDisplay({
      command: "openclaw",
      args: [
        "cron",
        "add",
        "--token",
        "secret-token",
        "--token=inline-secret",
        `--to=telegram:${FAKE_TELEGRAM_ID}`,
        "--session-key",
        `agent:personal:telegram:main:direct:${FAKE_TELEGRAM_ID}`,
        "--message=Say hello",
        "--name=Routine",
      ],
    });

    assert.equal(
      shown,
      "openclaw cron add --token <redacted> --token=<redacted> --to=<redacted> --session-key <redacted> --message=<9 chars> --name=Routine",
    );
  });

  it("redacts env and config secrets, the Telegram id and bot tokens", () => {
    const redact = createSecretRedactor({
      env: { TELEGRAM_USER_ID: FAKE_TELEGRAM_ID, TODOIST_API_TOKEN: "todoist-token-123", SHORT_KEY: "abc" },
      config: { gateway: { auth: { token: "config-gateway-token" } }, channels: { telegram: { accounts: { main: { botToken: "${HILLA_TELEGRAM_BOT_TOKEN}" } } } } },
    });

    assert.equal(
      redact(`todoist-token-123 config-gateway-token ${FAKE_TELEGRAM_ID} 891055123:AAHfakefakefakefakefakefakefakefake abc`),
      "<redacted> <redacted> <telegram-id> <redacted> abc",
    );
  });

  it("counts only fixed-time everyday cron schedules as daily", () => {
    const cron = (expr) => ({ kind: "cron", expr });
    assert.equal(isDailyCronSchedule(cron("30 12 * * *")), true);
    assert.equal(isDailyCronSchedule(cron("0 8,20 * * *")), true);
    assert.equal(isDailyCronSchedule(cron("*/15 * * * *")), false);
    assert.equal(isDailyCronSchedule(cron("0 * * * *")), false);
    assert.equal(isDailyCronSchedule(cron("0 19 * * 0")), false);
    assert.equal(isDailyCronSchedule({ kind: "every", everyMs: 86400000 }), false);
  });
});
