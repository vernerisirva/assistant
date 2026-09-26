import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { auditQuietOps, classifyQuietJob, quietOpsStatus } from "../scripts/lib/quiet-ops.mjs";
import { normalizeCronJob } from "../scripts/lib/live-cron.mjs";
import { formatQuietOpsResult, parseQuietOpsArgs, runQuietOpsCli } from "../scripts/quiet-ops.mjs";
import { FAKE_TELEGRAM_ID, createFakeOpenClawCron, sampleRawJobs } from "./fixtures/fake-openclaw-cron.mjs";

const liveJobs = (raw = sampleRawJobs()) => raw.map(normalizeCronJob);
const run = (argv, fake, extra = {}) => runQuietOpsCli(argv, { runOpenClaw: fake.run, env: {}, ...extra });

function unrelatedSnapshot(fake, exceptId) {
  return structuredClone(fake.jobs.filter((job) => job.id !== exceptId));
}

describe("quiet ops status and audit on the live Gateway", () => {
  it("lists every live job, disabled ones included, with category and run state", async () => {
    const fake = createFakeOpenClawCron();
    const status = await run(["status", "--json"], fake);

    assert.equal(status.source, "openclaw-gateway");
    assert.deepEqual(
      status.jobs.map((job) => [job.id, job.category, job.enabled, job.schedule.kind]),
      [
        ["wp-apply", "weekly-plan", true, "cron"],
        ["routine-workout", "assistant-routine", true, "cron"],
        ["routine-midday", "assistant-routine", true, "cron"],
        ["routine-weekly", "assistant-routine", true, "cron"],
        ["wp-propose", "weekly-plan", true, "cron"],
        ["one-shot-card", "reminder", true, "at"],
        ["weather-morning", "unknown", false, "cron"],
        ["routine-evening", "assistant-routine", false, "cron"],
        ["routine-morning", "assistant-routine", false, "cron"],
        ["legacy-sunday-golf", "golf", false, "cron"],
        ["legacy-food-every", "unknown", false, "every"],
      ],
    );
    const midday = status.jobs.find((job) => job.id === "routine-midday");
    assert.deepEqual(midday.schedule, { kind: "cron", expr: "30 12 * * *", timezone: "Europe/Stockholm" });
    assert.equal(midday.nextRunAt, new Date(1790505000000).toISOString());
    assert.equal(midday.lastStatus, "ok");
    assert.deepEqual(status.jobs.find((job) => job.id === "legacy-food-every").schedule, { kind: "every", everyMs: 604800000 });
    assert.deepEqual(status.summary, {
      totalJobs: 11,
      enabledJobs: 6,
      disabledJobs: 5,
      recurringJobs: 10,
      intervalJobs: 1,
      oneShotJobs: 1,
      otherScheduleJobs: 0,
      dailyRecurringJobs: 2,
    });
    assert.deepEqual(fake.calls, [["cron", "list", "--all", "--json"]]);
    assert.equal(JSON.stringify(status).includes(FAKE_TELEGRAM_ID), false);
  });

  it("classifies known job types", () => {
    const jobs = liveJobs();
    const byId = (id) => jobs.find((job) => job.id === id);

    assert.equal(classifyQuietJob(byId("routine-midday")), "assistant-routine");
    assert.equal(classifyQuietJob(byId("legacy-sunday-golf")), "golf");
    assert.equal(classifyQuietJob(byId("one-shot-card")), "reminder");
    assert.equal(classifyQuietJob(byId("legacy-food-every")), "unknown");
    assert.equal(classifyQuietJob({ name: "Assistant weekly plan: propose", description: "golf plan" }), "weekly-plan");
    assert.equal(classifyQuietJob({ name: "Assistant weekly plan: apply due plans" }), "weekly-plan");
  });

  it("audits overlaps, disabled jobs, upcoming reminders, daily counts and unknown schedules", () => {
    const raw = sampleRawJobs();
    raw.push(
      { ...raw.find((job) => job.id === "legacy-sunday-golf"), id: "golf-overlap", name: "Sunday golf check", enabled: true, schedule: { kind: "cron", expr: "0 19 * * 0", tz: "Europe/Stockholm" } },
      { id: "watcher", name: "Build watcher", enabled: true, schedule: { kind: "on-exit", command: "make" }, payload: { kind: "command" } },
    );
    const audit = auditQuietOps(liveJobs(raw), { now: new Date("2028-12-10T08:00:00.000Z"), upcomingDays: 14 });
    const issuesOf = (type) => audit.issues.filter((issue) => issue.type === type);

    assert.deepEqual(issuesOf("same-time-enabled").map((issue) => issue.jobNames), [["Assistant routine: weekly-review", "Sunday golf check"]]);
    assert.deepEqual(issuesOf("disabled-installed").map((issue) => issue.jobId), [
      "weather-morning",
      "routine-evening",
      "routine-morning",
      "legacy-sunday-golf",
      "legacy-food-every",
    ]);
    assert.deepEqual(issuesOf("upcoming-one-shot").map((issue) => [issue.jobName, issue.at]), [["Renew EU health insurance card", "2028-12-18T08:00:00.000Z"]]);
    assert.deepEqual(issuesOf("daily-recurring-count"), [
      {
        type: "daily-recurring-count",
        severity: "info",
        count: 2,
        jobNames: ["Assistant routine: workout-window", "Assistant routine: midday-check-in"],
      },
    ]);
    assert.deepEqual(issuesOf("unsupported-schedule").map((issue) => [issue.jobId, issue.schedule]), [
      ["watcher", { kind: "on-exit", supported: false }],
    ]);
    assert.equal(quietOpsStatus(liveJobs(raw)).summary.otherScheduleJobs, 1);
  });

  it("reports a Gateway that cannot be read instead of an empty schedule", async () => {
    const fake = createFakeOpenClawCron({ fail: () => new Error("openclaw cron list failed: gateway closed (1006)") });
    await assert.rejects(run(["status", "--json"], fake), /openclaw cron list failed: gateway closed/);
  });
});

describe("quiet ops mutations on the live Gateway", () => {
  it("disables an exact job id and enables an exact job name, touching nothing else", async () => {
    const fake = createFakeOpenClawCron();
    const others = unrelatedSnapshot(fake, "routine-midday");

    const disabled = await run(["disable", "routine-midday"], fake);
    assert.equal(disabled.applied, true);
    assert.equal(disabled.restartRequired, false);
    assert.equal(disabled.preview.before.enabled, true);
    assert.equal(disabled.preview.after.enabled, false);
    assert.deepEqual(disabled.result, { action: "disable", jobId: "routine-midday", jobName: "Assistant routine: midday-check-in" });
    assert.deepEqual(disabled.verification, { changedFields: ["enabled"], unexpectedFields: [], unrelatedJobsChanged: [] });
    assert.deepEqual(unrelatedSnapshot(fake, "routine-midday"), others);

    const enabled = await run(["enable", "Assistant weather: morning"], fake);
    assert.equal(enabled.result.jobId, "weather-morning");
    assert.equal(fake.jobs.find((job) => job.id === "weather-morning").enabled, true);
    assert.deepEqual(fake.mutations(), [
      ["cron", "disable", "routine-midday"],
      ["cron", "enable", "weather-morning"],
    ]);
  });

  it("changes only the time of a cron job and keeps its timezone and stagger", async () => {
    const fake = createFakeOpenClawCron();
    const before = structuredClone(fake.jobs.find((job) => job.id === "wp-propose"));

    const result = await run(["set-time", "Assistant weekly plan: propose", "09:45"], fake);
    const after = fake.jobs.find((job) => job.id === "wp-propose");

    assert.deepEqual(fake.mutations(), [["cron", "edit", "wp-propose", "--cron=45 9 * * 6", "--tz=Europe/Stockholm"]]);
    assert.deepEqual(after.schedule, { kind: "cron", expr: "45 9 * * 6", tz: "Europe/Stockholm", staggerMs: 0 });
    assert.deepEqual({ ...after, schedule: before.schedule, updatedAtMs: before.updatedAtMs }, before);
    assert.equal(result.result.cron, "45 9 * * 6");
    assert.deepEqual(result.verification.unexpectedFields, []);
    assert.deepEqual(result.verification.unrelatedJobsChanged, []);
  });

  it("reschedules a one-shot reminder in Stockholm time", async () => {
    const fake = createFakeOpenClawCron();
    const result = await run(["reschedule", "Renew EU health insurance card", "2028-12-19", "09:30"], fake);

    assert.deepEqual(fake.mutations(), [["cron", "edit", "one-shot-card", "--at=2028-12-19T08:30:00.000Z"]]);
    assert.deepEqual(result.result, {
      action: "reschedule",
      jobId: "one-shot-card",
      jobName: "Renew EU health insurance card",
      at: "2028-12-19T08:30:00.000Z",
      timezone: "Europe/Stockholm",
    });
    assert.equal(fake.jobs.find((job) => job.id === "one-shot-card").deleteAfterRun, true);
  });

  it("refuses set-time on non-cron jobs and reschedule on non-one-shot jobs without calling the Gateway", async () => {
    const fake = createFakeOpenClawCron();

    await assert.rejects(run(["set-time", "one-shot-card", "08:30"], fake), /requires a cron job: .* has schedule kind at/);
    await assert.rejects(run(["set-time", "legacy-food-every", "08:30"], fake), /requires a cron job: .* has schedule kind every/);
    await assert.rejects(run(["reschedule", "routine-midday", "2028-07-01", "09:30"], fake), /requires a one-shot at job/);
    assert.deepEqual(fake.mutations(), []);
  });

  it("requires an exact, unambiguous job reference", async () => {
    const fake = createFakeOpenClawCron();
    await assert.rejects(run(["disable", "midday"], fake), /No quiet-ops job matches exact id or name: midday/);

    const raw = sampleRawJobs();
    raw.push({ ...raw.find((job) => job.id === "weather-morning"), id: "weather-morning-2" });
    const duplicated = createFakeOpenClawCron({ jobs: raw });
    await assert.rejects(
      run(["disable", "Assistant weather: morning"], duplicated),
      /Ambiguous quiet-ops job reference: Assistant weather: morning matches weather-morning, weather-morning-2/,
    );
    assert.deepEqual([...fake.mutations(), ...duplicated.mutations()], []);
  });

  it("runs every mutation as a dry run without any Gateway mutation", async () => {
    const commands = [
      ["disable", "routine-midday"],
      ["enable", "Assistant weather: morning"],
      ["set-time", "routine-midday", "13:15"],
      ["reschedule", "one-shot-card", "2028-12-19", "09:30"],
    ];
    for (const argv of commands) {
      const fake = createFakeOpenClawCron();
      const before = structuredClone(fake.jobs);
      const result = await run([...argv, "--dry-run"], fake);

      assert.equal(result.dryRun, true, argv.join(" "));
      assert.equal(result.applied, false);
      assert.equal(result.changed, true);
      assert.equal(result.restartRequired, false);
      assert.deepEqual(fake.mutations(), [], argv.join(" "));
      assert.deepEqual(fake.jobs, before);
      assert.match(formatQuietOpsResult(result, argv[0]), /^DRY RUN .* Nothing was changed\.$/);
    }
  });

  it("previews the change it would make in a dry run", async () => {
    const result = await run(["set-time", "routine-midday", "13:15", "--dry-run"], createFakeOpenClawCron());

    assert.deepEqual(result.preview.before.schedule, { kind: "cron", expr: "30 12 * * *", timezone: "Europe/Stockholm" });
    assert.deepEqual(result.preview.after.schedule, { kind: "cron", expr: "15 13 * * *", timezone: "Europe/Stockholm" });
    assert.equal(result.preview.after.nextRunAt, null);
  });

  it("does nothing when the job is already in the requested state", async () => {
    const fake = createFakeOpenClawCron();
    const result = await run(["enable", "routine-midday"], fake);

    assert.equal(result.changed, false);
    assert.equal(result.applied, false);
    assert.deepEqual(fake.mutations(), []);
    assert.match(formatQuietOpsResult(result, "enable"), /already in that state; nothing was changed/);
  });

  it("says the change is live and never asks for a Gateway restart", async () => {
    const result = await run(["disable", "routine-midday"], createFakeOpenClawCron());
    const text = formatQuietOpsResult(result, "disable");

    assert.match(text, /It is live now; no Gateway restart is needed\./);
    assert.doesNotMatch(text, /kickstart|restart (?:the|OpenClaw) Gateway/i);
  });
});

describe("quiet ops CLI parsing", () => {
  it("parses status, audit, and mutation commands", () => {
    assert.deepEqual(parseQuietOpsArgs(["status", "--json"]), {
      command: "status",
      options: { json: true },
    });
    assert.deepEqual(parseQuietOpsArgs(["audit"]), { command: "audit", options: {} });
    assert.deepEqual(parseQuietOpsArgs(["disable", "routine-midday", "--dry-run"]), {
      command: "disable",
      options: { dryRun: true, ref: "routine-midday" },
    });
    assert.deepEqual(parseQuietOpsArgs(["set-time", "golf-weekly", "18:45"]), {
      command: "set-time",
      options: { ref: "golf-weekly", time: "18:45" },
    });
    assert.deepEqual(parseQuietOpsArgs(["reschedule", "one-shot", "2026-07-01", "09:30"]), {
      command: "reschedule",
      options: { ref: "one-shot", date: "2026-07-01", time: "09:30" },
    });
    assert.throws(() => parseQuietOpsArgs(["disable", "--token=x"]), /Unknown quiet-ops option/);
  });
});
