import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  auditQuietOps,
  classifyQuietJob,
  quietOpsStatus,
  updateQuietCronTime,
  updateQuietJobEnabled,
  updateQuietOneShotTime,
} from "../scripts/lib/quiet-ops.mjs";
import { writeCronStoreFile } from "../scripts/lib/cron-store.mjs";
import { parseQuietOpsArgs, runQuietOpsCli } from "../scripts/quiet-ops.mjs";

function sampleStore(overrides = {}) {
  return {
    version: 7,
    jobs: [
      {
        id: "routine-midday",
        agentId: "health",
        name: "Assistant routine: midday-check-in",
        enabled: true,
        schedule: { kind: "cron", expr: "30 12 * * *", tz: "Europe/Stockholm" },
        payload: { kind: "agentTurn", message: "midday" },
        delivery: { mode: "announce", to: "telegram:1029709001" },
        state: { keep: true },
      },
      {
        id: "routine-workout",
        agentId: "health",
        name: "Assistant routine: workout-window",
        enabled: true,
        schedule: { kind: "cron", expr: "30 17 * * *", tz: "Europe/Stockholm" },
      },
      {
        id: "golf-weekly",
        agentId: "personal",
        name: "Sunday golf weekly plan",
        enabled: true,
        schedule: { kind: "cron", expr: "0 19 * * 0", tz: "Europe/Stockholm" },
      },
      {
        id: "routine-weekly",
        agentId: "personal",
        name: "Assistant routine: weekly-review",
        enabled: true,
        schedule: { kind: "cron", expr: "0 19 * * 0", tz: "Europe/Stockholm" },
      },
      {
        id: "disabled-golf",
        agentId: "personal",
        name: "Daily golf training schedule reminder",
        enabled: false,
        schedule: { kind: "cron", expr: "0 7 * * *", tz: "Europe/Stockholm" },
      },
      {
        id: "one-shot",
        agentId: "personal",
        name: "Reminder: Renew gym card",
        enabled: true,
        schedule: { kind: "at", at: "2026-06-19T07:00:00.000Z" },
        deleteAfterRun: true,
      },
      {
        id: "unknown",
        agentId: "personal",
        name: "Mystery automation",
        schedule: { kind: "cron", expr: "15 9 * * 1", tz: "Europe/Stockholm" },
      },
    ],
    ...overrides,
  };
}

function sampleState() {
  return {
    version: 1,
    jobs: {
      "routine-midday": {
        state: {
          nextRunAtMs: Date.parse("2026-06-10T10:30:00.000Z"),
          lastStatus: "ok",
        },
      },
    },
  };
}

describe("quiet ops status", () => {
  it("lists cron and one-shot jobs with category and state", () => {
    const status = quietOpsStatus(sampleStore(), sampleState());

    assert.equal(status.jobs.length, 7);
    assert.deepEqual(
      status.jobs.map((job) => [job.id, job.category, job.enabled, job.schedule.kind]),
      [
        ["routine-midday", "assistant-routine", true, "cron"],
        ["routine-workout", "assistant-routine", true, "cron"],
        ["golf-weekly", "golf", true, "cron"],
        ["routine-weekly", "assistant-routine", true, "cron"],
        ["disabled-golf", "golf", false, "cron"],
        ["one-shot", "reminder", true, "at"],
        ["unknown", "unknown", true, "cron"],
      ],
    );

    const midday = status.jobs.find((job) => job.id === "routine-midday");
    assert.deepEqual(midday.schedule, {
      kind: "cron",
      expr: "30 12 * * *",
      timezone: "Europe/Stockholm",
    });
    assert.equal(midday.nextRunAt, "2026-06-10T10:30:00.000Z");
    assert.equal(midday.lastStatus, "ok");

    assert.deepEqual(status.summary, {
      totalJobs: 7,
      enabledJobs: 6,
      disabledJobs: 1,
      recurringJobs: 6,
      oneShotJobs: 1,
      dailyRecurringJobs: 2,
    });
  });

  it("classifies known job types", () => {
    const jobs = sampleStore().jobs;

    assert.equal(classifyQuietJob(jobs.find((job) => job.id === "routine-midday")), "assistant-routine");
    assert.equal(classifyQuietJob(jobs.find((job) => job.id === "golf-weekly")), "golf");
    assert.equal(classifyQuietJob(jobs.find((job) => job.id === "one-shot")), "reminder");
    assert.equal(classifyQuietJob(jobs.find((job) => job.id === "unknown")), "unknown");
  });

  it("audits overlaps, disabled jobs, upcoming reminders, and daily recurring counts", () => {
    const audit = auditQuietOps(sampleStore(), sampleState(), {
      now: new Date("2026-06-10T08:00:00.000Z"),
      upcomingDays: 14,
    });

    assert.equal(audit.issues.find((issue) => issue.type === "same-time-enabled").schedule.expr, "0 19 * * 0");
    assert.deepEqual(
      audit.issues.find((issue) => issue.type === "same-time-enabled").jobNames,
      ["Sunday golf weekly plan", "Assistant routine: weekly-review"],
    );
    assert.equal(audit.issues.find((issue) => issue.type === "disabled-installed").jobName, "Daily golf training schedule reminder");
    assert.equal(audit.issues.find((issue) => issue.type === "upcoming-one-shot").jobName, "Reminder: Renew gym card");
    assert.deepEqual(audit.issues.find((issue) => issue.type === "daily-recurring-count"), {
      type: "daily-recurring-count",
      severity: "info",
      count: 2,
      jobNames: ["Assistant routine: midday-check-in", "Assistant routine: workout-window"],
    });
  });
});

describe("quiet ops mutations", () => {
  it("enables and disables only an exact selected job while preserving fields", () => {
    const disabled = updateQuietJobEnabled(sampleStore(), "routine-midday", false);
    const job = disabled.store.jobs.find((candidate) => candidate.id === "routine-midday");

    assert.equal(disabled.store.version, 7);
    assert.equal(job.enabled, false);
    assert.deepEqual(job.payload, { kind: "agentTurn", message: "midday" });
    assert.deepEqual(job.delivery, { mode: "announce", to: "telegram:1029709001" });
    assert.deepEqual(job.state, { keep: true });
    assert.equal(disabled.result.action, "disable");
    assert.equal(disabled.result.jobName, "Assistant routine: midday-check-in");

    const enabled = updateQuietJobEnabled(disabled.store, "Assistant routine: midday-check-in", true);
    assert.equal(
      enabled.store.jobs.find((candidate) => candidate.id === "routine-midday").enabled,
      true,
    );
    assert.equal(enabled.result.action, "enable");
  });

  it("sets time for cron jobs and rejects one-shot jobs", () => {
    const changed = updateQuietCronTime(sampleStore(), "golf-weekly", "18:45");

    assert.equal(
      changed.store.jobs.find((candidate) => candidate.id === "golf-weekly").schedule.expr,
      "45 18 * * 0",
    );
    assert.equal(changed.result.action, "set-time");

    assert.throws(
      () => updateQuietCronTime(sampleStore(), "one-shot", "08:30"),
      /requires a cron job/i,
    );
  });

  it("reschedules one-shot reminders in Stockholm time and rejects cron jobs", () => {
    const changed = updateQuietOneShotTime(sampleStore(), "one-shot", "2026-07-01", "09:30", {
      timezone: "Europe/Stockholm",
    });

    assert.equal(
      changed.store.jobs.find((candidate) => candidate.id === "one-shot").schedule.at,
      "2026-07-01T07:30:00.000Z",
    );
    assert.deepEqual(changed.result, {
      action: "reschedule",
      jobId: "one-shot",
      jobName: "Reminder: Renew gym card",
      at: "2026-07-01T07:30:00.000Z",
      timezone: "Europe/Stockholm",
    });

    assert.throws(
      () => updateQuietOneShotTime(sampleStore(), "routine-midday", "2026-07-01", "09:30"),
      /requires a one-shot/i,
    );
  });

  it("requires exact unambiguous job references", () => {
    assert.throws(
      () => updateQuietJobEnabled(sampleStore(), "midday", false),
      /No quiet-ops job matches/i,
    );

    const duplicateStore = sampleStore({
      jobs: [
        ...sampleStore().jobs,
        { id: "duplicate-name", name: "Mystery automation", schedule: { kind: "cron", expr: "0 10 * * *" } },
      ],
    });

    assert.throws(
      () => updateQuietJobEnabled(duplicateStore, "Mystery automation", false),
      /Ambiguous quiet-ops job reference/i,
    );
  });
});

describe("quiet ops CLI", () => {
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
  });

  it("runs dry-run without writing", async () => {
    let writes = 0;

    const result = await runQuietOpsCli(["disable", "routine-midday", "--dry-run"], {
      existingCronStore: sampleStore(),
      existingCronState: sampleState(),
      writeCronStore: () => {
        writes += 1;
      },
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.restartRequired, false);
    assert.equal(result.result.action, "disable");
    assert.equal(result.preview.before.enabled, true);
    assert.equal(result.preview.after.enabled, false);
    assert.equal(writes, 0);
  });

  it("writes a timestamped backup before mutating the cron store", async () => {
    const directory = mkdtempSync(join(tmpdir(), "quiet-ops-"));
    const jobsPath = join(directory, "jobs.json");
    writeFileSync(jobsPath, `${JSON.stringify(sampleStore(), null, 2)}\n`);

    try {
      const result = await runQuietOpsCli(["disable", "routine-midday"], {
        existingCronStore: sampleStore(),
        existingCronState: sampleState(),
        writeCronStore: (store) =>
          writeCronStoreFile(jobsPath, store, {
            now: new Date("2026-06-10T09:15:30.000Z"),
          }),
      });

      assert.equal(result.restartRequired, true);
      assert.equal(existsSync(join(directory, "jobs.json.bak.20260610T091530000Z")), true);
      assert.equal(JSON.parse(readFileSync(jobsPath, "utf8")).jobs[0].enabled, false);
      assert.equal(readdirSync(directory).filter((file) => file.startsWith("jobs.json.bak.")).length, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
