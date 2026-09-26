import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as assistantStatusModule from "../scripts/lib/assistant-status.mjs";
import { REQUIRED_ENV_KEYS, requiredEnvReport } from "../scripts/lib/env.mjs";
import {
  buildAssistantStatus,
  loadAssistantStatusInputs,
  parseGatewayLogText,
  redactSensitiveText,
} from "../scripts/lib/assistant-status.mjs";
import {
  formatAssistantStatus,
  parseAssistantStatusArgs,
  runAssistantStatusCli,
} from "../scripts/assistant-status.mjs";
import { runWeeklyPlanCli } from "../scripts/weekly-plan.mjs";
import { createLiveCron, loadLiveCronSnapshot, normalizeCronJob } from "../scripts/lib/live-cron.mjs";
import { runQuietOpsCli } from "../scripts/quiet-ops.mjs";
import { FAKE_TELEGRAM_ID, createFakeOpenClawCron } from "./fixtures/fake-openclaw-cron.mjs";

function sampleConfig() {
  return {
    gateway: {
      mode: "local",
      auth: { token: "gateway-secret-token" },
      remote: { token: "gateway-secret-token" },
    },
    plugins: {
      entries: {
        telegram: { enabled: true },
      },
    },
    bindings: [
      {
        agentId: "personal",
        match: { channel: "telegram", accountId: "main" },
      },
    ],
    channels: {
      telegram: {
        enabled: true,
        defaultAccount: "main",
        allowFrom: ["1029709001"],
        accounts: {
          main: {
            botToken: "${HILLA_TELEGRAM_BOT_TOKEN}",
            allowFrom: ["1029709001"],
            execApprovals: { enabled: true, approvers: ["1029709001"] },
          },
        },
      },
    },
  };
}

// Raw jobs as `openclaw cron list --all --json` returns them.
function sampleLiveRawJobs() {
  return [
    {
      id: "routine-midday",
      agentId: "health",
      name: "Assistant routine: midday-check-in",
      enabled: true,
      schedule: { kind: "cron", expr: "30 12 * * *", tz: "Europe/Stockholm" },
      sessionKey: `agent:health:telegram:main:direct:${FAKE_TELEGRAM_ID}`,
      payload: { kind: "agentTurn", message: "midday" },
      delivery: { mode: "announce", channel: "telegram", to: `telegram:${FAKE_TELEGRAM_ID}` },
      state: {
        nextRunAtMs: Date.parse("2026-06-11T10:30:00.000Z"),
        lastStatus: "ok",
        lastRunAtMs: Date.parse("2026-06-10T10:30:00.000Z"),
      },
    },
    {
      id: "routine-evening",
      agentId: "personal",
      name: "Assistant routine: evening-review",
      enabled: false,
      schedule: { kind: "cron", expr: "0 21 * * *", tz: "Europe/Stockholm" },
      state: {},
    },
    {
      id: "renew-gym",
      agentId: "personal",
      name: "Reminder: Renew gym card",
      enabled: true,
      schedule: { kind: "at", at: "2026-06-19T07:00:00.000Z" },
      state: {},
    },
  ];
}

function liveSnapshot(rawJobs = sampleLiveRawJobs(), scheduler = { enabled: true, storage: "sqlite", jobCount: rawJobs.length, nextWakeAt: null }) {
  return { available: true, source: "openclaw-gateway", jobs: rawJobs.map(normalizeCronJob), scheduler, error: null };
}

function loadLiveSnapshotFrom(fake) {
  return loadLiveCronSnapshot(createLiveCron({ run: fake.run }));
}

function sampleLogs() {
  return [
    "2026-06-10T22:53:45.680+02:00 [gateway] ready",
    "2026-06-10T22:53:46.030+02:00 [telegram] [main] starting provider (@hilla_assistant_bot)",
    "2026-06-10T23:23:13.735+02:00 [fetch-timeout] fetch timeout after 10000ms operation=fetchWithTimeout url=https://api.telegram.org/bot891055:SECRET/getMe",
    "2026-06-11T08:49:24.422+02:00 [skills] Skipping escaped skill path outside its configured root",
    "Error: untimestamped stack trace fragments should not become recent issues",
  ].join("\n");
}

describe("assistant status aggregation", () => {
  it("exports only the supported assistant status helpers", () => {
    assert.deepEqual(Object.keys(assistantStatusModule).sort(), [
      "buildAssistantStatus",
      "loadAssistantStatusInputs",
      "parseGatewayLogText",
      "redactSensitiveText",
    ]);
  });

  it("builds a redacted running status from local config, live Gateway jobs, and logs", () => {
    const status = buildAssistantStatus({
      env: {
        HILLA_TELEGRAM_BOT_TOKEN: "891055:SECRET",
        TELEGRAM_USER_ID: "1029709001",
      },
      config: sampleConfig(),
      liveCron: liveSnapshot(),
      skipStore: {
        version: 1,
        skips: [
          {
            routineId: "midday-check-in",
            date: "2026-06-11",
            timezone: "Europe/Stockholm",
            source: "telegram",
            createdAt: "2026-06-10T20:15:00.000Z",
          },
        ],
      },
      gatewayLogText: sampleLogs(),
      gatewayErrLogText: "",
      paths: {
        configPath: ".openclaw/openclaw.json",
        stateDir: ".openclaw/state",
        telegramDir: ".openclaw/state/telegram",
      },
      exists: () => true,
      now: new Date("2026-06-11T07:00:00.000Z"),
      recentHours: 24,
    });

    assert.equal(status.overall, "degraded");
    assert.equal(status.telegram.enabled, true);
    assert.equal(status.telegram.defaultAccount, "main");
    assert.equal(status.telegram.provider, "@hilla_assistant_bot");
    assert.equal(status.telegram.allowFromCount, 1);
    assert.equal(status.telegram.botTokenConfigured, true);
    assert.equal(status.automation.summary.enabledJobs, 2);
    assert.deepEqual(
      status.automation.routines.map((routine) => [routine.routineId, routine.enabled]),
      [
        ["midday-check-in", true],
        ["evening-review", false],
      ],
    );
    const midday = status.automation.routines.find((routine) => routine.routineId === "midday-check-in");
    assert.equal(midday.skippedToday, true);
    assert.equal(midday.skipDate, "2026-06-11");
    assert.equal(status.recentActivity.gatewayReadyAt, "2026-06-10T22:53:45.680+02:00");
    assert.equal(status.recentActivity.telegramProviderStartedAt, "2026-06-10T22:53:46.030+02:00");
    assert.equal(status.recentIssues.length, 1);
    assert.equal(status.recentIssues[0].type, "fetch-timeout");
    assert.equal(status.checks.find((check) => check.id === "live-scheduler").status, "ok");
    assert.equal(status.automation.source, "openclaw-gateway");
    assert.equal(status.recentActivity.lastScheduledRunAt, "2026-06-10T10:30:00.000Z");
    assert.equal(JSON.stringify(status).includes("891055:SECRET"), false);
    assert.equal(JSON.stringify(status).includes("gateway-secret-token"), false);
    assert.equal(JSON.stringify(status).includes(FAKE_TELEGRAM_ID), false);
    assert.ok(status.suggestedActions.some((action) => action.command.includes("npm run routines:status")));
    assert.ok(status.suggestedActions.some((action) => action.command.includes("npm run doctor")));
  });

  it("reports needs_attention when config or state are missing", () => {
    const status = buildAssistantStatus({
      env: {},
      config: {},
      gatewayLogText: "",
      gatewayErrLogText: "",
      paths: {
        configPath: ".openclaw/openclaw.json",
        stateDir: ".openclaw/state",
        telegramDir: ".openclaw/state/telegram",
      },
      exists: (path) => ![".openclaw/openclaw.json", ".openclaw/state"].includes(path),
      now: new Date("2026-06-11T07:00:00.000Z"),
      recentHours: 24,
    });

    assert.equal(status.overall, "needs_attention");
    assert.equal(status.checks.find((check) => check.id === "config-file").status, "fail");
    assert.equal(status.checks.find((check) => check.id === "state-dir").status, "fail");
    assert.equal(status.telegram.enabled, false);
    assert.equal(status.telegram.botTokenConfigured, false);
  });

  it("reports degraded status when warning checks need attention", () => {
    const status = buildAssistantStatus({
      env: {
        HILLA_TELEGRAM_BOT_TOKEN: "891055:SECRET",
        TELEGRAM_USER_ID: "1029709001",
      },
      config: sampleConfig(),
      gatewayLogText: "",
      gatewayErrLogText: "",
      paths: {
        configPath: ".openclaw/openclaw.json",
        stateDir: ".openclaw/state",
        telegramDir: ".openclaw/state/telegram",
      },
      exists: (path) => path !== ".openclaw/state/telegram",
      now: new Date("2026-06-11T07:00:00.000Z"),
    });

    assert.equal(status.overall, "degraded");
    assert.equal(status.checks.find((check) => check.id === "telegram-dir").status, "warn");
    assert.equal(status.checks.find((check) => check.id === "gateway-ready-log").status, "warn");
    assert.deepEqual(
      status.recentIssues
        .filter((issue) => issue.type === "check-warning")
        .map((issue) => [issue.severity, issue.checkId])
        .sort(),
      [
        ["warn", "gateway-ready-log"],
        ["warn", "telegram-dir"],
      ],
    );
  });

  it("does not treat rendered env placeholders, hourly cron, or disabled daily cron as configured daily status", () => {
    const config = sampleConfig();
    const status = buildAssistantStatus({
      env: { TELEGRAM_USER_ID: "1029709001" },
      config,
      liveCron: liveSnapshot([
        {
          id: "hourly-check",
          name: "Hourly check",
          enabled: true,
          schedule: { kind: "cron", expr: "0 * * * *", tz: "Europe/Stockholm" },
        },
        {
          id: "quarter-hour-check",
          name: "Quarter-hour check",
          enabled: true,
          schedule: { kind: "cron", expr: "*/15 * * * *", tz: "Europe/Stockholm" },
        },
        {
          id: "disabled-daily-check",
          name: "Disabled daily check",
          enabled: false,
          schedule: { kind: "cron", expr: "0 8 * * *", tz: "Europe/Stockholm" },
        },
        {
          id: "daily-check",
          name: "Daily check",
          enabled: true,
          schedule: { kind: "cron", expr: "30 12 * * *", tz: "Europe/Stockholm" },
        },
      ]),
      paths: {
        configPath: ".openclaw/openclaw.json",
        stateDir: ".openclaw/state",
        telegramDir: ".openclaw/state/telegram",
      },
      exists: () => true,
      now: new Date("2026-06-11T07:00:00.000Z"),
    });

    assert.equal(status.telegram.botTokenConfigured, false);
    assert.equal(status.automation.summary.dailyRecurringJobs, 1);
    assert.equal(status.checks.find((check) => check.id === "telegram-env").status, "fail");
  });

  it("keeps returning degraded status when the Gateway reports invalid run timestamps", () => {
    const [midday, ...rest] = sampleLiveRawJobs();
    const status = buildAssistantStatus({
      env: {
        HILLA_TELEGRAM_BOT_TOKEN: "891055:SECRET",
        TELEGRAM_USER_ID: "1029709001",
      },
      config: sampleConfig(),
      liveCron: liveSnapshot([{ ...midday, state: { nextRunAtMs: "not-a-date", lastRunAtMs: 1e100, lastStatus: "ok" } }, ...rest]),
      paths: {
        configPath: ".openclaw/openclaw.json",
        stateDir: ".openclaw/state",
        telegramDir: ".openclaw/state/telegram",
      },
      exists: () => true,
      now: new Date("2026-06-11T07:00:00.000Z"),
    });

    assert.equal(status.overall, "degraded");
    assert.equal(status.automation.jobs[0].nextRunAt, null);
    assert.equal(status.automation.jobs[0].lastRunAt, null);
    assert.equal(status.automation.routines[0].nextRunAt, null);
    assert.equal(status.recentActivity.lastScheduledRunAt, null);
    assert.equal(status.recentIssues.some((issue) => issue.type === "invalid-state-timestamp"), true);
  });

  it("reports malformed skip state and never reads the retired cron/jobs.json", () => {
    const directory = mkdtempSync(join(tmpdir(), "assistant-status-"));
    const stateDir = join(directory, ".openclaw/state");
    const configPath = join(directory, ".openclaw/openclaw.json");
    mkdirSync(join(stateDir, "cron"), { recursive: true });
    mkdirSync(join(stateDir, "routines"), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(sampleConfig())}\n`);
    writeFileSync(join(stateDir, "cron/jobs.json"), "{ broken json");
    writeFileSync(join(stateDir, "routines/skips.json"), "{ broken skips");

    try {
      const inputs = loadAssistantStatusInputs({
        env: { HILLA_TELEGRAM_BOT_TOKEN: "891055:SECRET", TELEGRAM_USER_ID: "1029709001" },
        projectRoot: directory,
        configPath,
        stateDir,
      });
      const status = buildAssistantStatus({
        ...inputs,
        now: new Date("2026-06-11T07:00:00.000Z"),
      });

      assert.equal(status.overall, "degraded");
      assert.equal("cronStore" in inputs, false);
      assert.equal(status.automation.available, false);
      assert.equal(status.automation.summary, null, "an unread scheduler is not reported as 0 jobs");
      assert.equal(status.recentIssues.some((issue) => String(issue.path ?? "").endsWith("jobs.json")), false);
      assert.equal(inputs.skipStore.skips.length, 0);
      assert.equal(inputs.paths.skipStorePath.endsWith("routines/skips.json"), true);
      assert.equal(
        status.recentIssues.some((issue) => issue.type === "malformed-json" && issue.path.endsWith("skips.json")),
        true,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("assistant status log parsing", () => {
  it("extracts high-signal events and ignores noisy skill warnings", () => {
    const parsed = parseGatewayLogText(sampleLogs(), {
      now: new Date("2026-06-11T07:00:00.000Z"),
      recentHours: 24,
      secrets: ["891055:SECRET"],
    });

    assert.equal(parsed.gatewayReadyAt, "2026-06-10T22:53:45.680+02:00");
    assert.equal(parsed.telegramProvider, "@hilla_assistant_bot");
    assert.equal(parsed.issues.length, 1);
    assert.equal(parsed.issues[0].type, "fetch-timeout");
    assert.equal(parsed.issues[0].message.includes("891055:SECRET"), false);
    assert.equal(parsed.issues.some((issue) => issue.message.includes("Skipping escaped skill path")), false);
  });

  it("does not carry warning issues across a later clean gateway start", () => {
    const parsed = parseGatewayLogText([
      "2026-06-10T19:36:55.065+02:00 [ws] ⇄ res ✗ message.action 65ms errorMessage=ToolInputError: pollQuestion required",
      "2026-06-10T23:23:13.735+02:00 [fetch-timeout] fetch timeout after 10000ms operation=fetchWithTimeout",
      "2026-06-11T10:48:38.193+02:00 [gateway] ready",
      "2026-06-11T10:48:38.322+02:00 [telegram] [main] starting provider (@hilla_assistant_bot)",
    ].join("\n"), {
      now: new Date("2026-06-11T09:00:00.000Z"),
      recentHours: 24,
    });

    assert.equal(parsed.gatewayReadyAt, "2026-06-11T10:48:38.193+02:00");
    assert.equal(parsed.issues.length, 0);
  });

  it("keeps warning issues that happen after the latest gateway start", () => {
    const parsed = parseGatewayLogText([
      "2026-06-11T10:48:38.193+02:00 [gateway] ready",
      "2026-06-11T10:49:38.193+02:00 [fetch-timeout] fetch timeout after 10000ms operation=fetchWithTimeout",
    ].join("\n"), {
      now: new Date("2026-06-11T09:00:00.000Z"),
      recentHours: 24,
    });

    assert.equal(parsed.issues.length, 1);
    assert.equal(parsed.issues[0].type, "fetch-timeout");
  });

  it("keeps a long-running gateway ready after its start line is more than a day old", () => {
    const logText = [
      "2026-09-20T08:00:00.000+02:00 [gateway] ready",
      "2026-09-20T08:00:00.200+02:00 [telegram] [main] starting provider (@hilla_assistant_bot)",
      "2026-09-26T12:19:24.426+02:00 [agents/auth-profiles] adopted newer OAuth credentials from main agent",
    ].join("\n");
    const now = new Date("2026-09-26T11:00:00.000Z");

    const parsed = parseGatewayLogText(logText, { now, recentHours: 24 });
    assert.equal(parsed.gatewayReadyAt, "2026-09-20T08:00:00.000+02:00");
    assert.equal(parsed.telegramProvider, "@hilla_assistant_bot");

    const status = buildAssistantStatus({
      env: { HILLA_TELEGRAM_BOT_TOKEN: "891055:SECRET", TELEGRAM_USER_ID: "1029709001" },
      config: sampleConfig(),
      gatewayLogText: logText,
      paths: { configPath: ".openclaw/openclaw.json", stateDir: ".openclaw/state", telegramDir: ".openclaw/state/telegram" },
      exists: () => true,
      now,
    });
    assert.equal(status.checks.find((check) => check.id === "gateway-ready-log").status, "ok");
    assert.equal(status.overall, "running");
  });

  it("treats a start followed by a shutdown as stopped until the next start", () => {
    const stopped = [
      "2026-09-26T12:00:00.000+02:00 [gateway] ready",
      "2026-09-26T12:00:00.100+02:00 [telegram] [main] starting provider (@hilla_assistant_bot)",
      "2026-09-26T12:26:51.223+02:00 [gateway] received SIGTERM; shutting down",
      "2026-09-26T12:26:51.284+02:00 [shutdown] started: gateway stopping",
    ];
    const now = new Date("2026-09-26T11:00:00.000Z");

    const whileStopped = parseGatewayLogText(stopped.join("\n"), { now, recentHours: 24 });
    assert.equal(whileStopped.gatewayReadyAt, null);
    assert.equal(whileStopped.telegramProvider, null);

    const restarted = parseGatewayLogText(
      [...stopped, "2026-09-26T12:26:59.022+02:00 [gateway] ready"].join("\n"),
      { now, recentHours: 24 },
    );
    assert.equal(restarted.gatewayReadyAt, "2026-09-26T12:26:59.022+02:00");
  });

  it("redacts known secrets and Telegram bot URL token forms", () => {
    const text = "token=abc123 https://api.telegram.org/bot891055:SECRET/getMe gateway-secret-token";
    const redacted = redactSensitiveText(text, ["abc123", "gateway-secret-token"]);

    assert.equal(redacted.includes("abc123"), false);
    assert.equal(redacted.includes("891055:SECRET"), false);
    assert.equal(redacted.includes("gateway-secret-token"), false);
    assert.match(redacted, /<redacted>/);
  });
});

describe("assistant status CLI", () => {
  it("parses json, recent-hours, and include-logs options", () => {
    assert.deepEqual(parseAssistantStatusArgs(["--json", "--recent-hours", "6", "--include-logs"]), {
      json: true,
      recentHours: 6,
      includeLogs: true,
    });
  });

  it("rejects invalid recent-hours values", () => {
    assert.throws(() => parseAssistantStatusArgs(["--recent-hours", "0"]), /recent-hours/i);
    assert.throws(() => parseAssistantStatusArgs(["--recent-hours", "abc"]), /recent-hours/i);
  });

  it("runs with injected status inputs", async () => {
    const result = await runAssistantStatusCli(["--json"], {
      loadInputs: () => ({
        env: { HILLA_TELEGRAM_BOT_TOKEN: "891055:SECRET", TELEGRAM_USER_ID: "1029709001" },
        config: sampleConfig(),
        liveCron: liveSnapshot(),
        gatewayLogText: sampleLogs(),
        gatewayErrLogText: "",
        paths: {
          configPath: ".openclaw/openclaw.json",
          stateDir: ".openclaw/state",
          telegramDir: ".openclaw/state/telegram",
        },
        exists: () => true,
      }),
      now: new Date("2026-06-11T07:00:00.000Z"),
    });

    assert.equal(result.overall, "degraded");
    assert.equal(JSON.stringify(result).includes("891055:SECRET"), false);
  });

  it("accepts launchd-style absolute OpenClaw paths and reports the live jobs, not a stale jobs.json", async () => {
    const directory = mkdtempSync(join(tmpdir(), "assistant-status-cli-"));
    const configPath = join(directory, ".openclaw/openclaw.json");
    const stateDir = join(directory, ".openclaw/state");
    mkdirSync(join(stateDir, "cron"), { recursive: true });
    mkdirSync(join(stateDir, "logs"), { recursive: true });
    mkdirSync(join(stateDir, "telegram"), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(sampleConfig())}\n`);
    // A leftover of the old file store; the Gateway no longer reads it and neither does status.
    writeFileSync(join(stateDir, "cron/jobs.json"), `${JSON.stringify({ version: 1, jobs: sampleLiveRawJobs() })}\n`);
    writeFileSync(join(stateDir, "logs/gateway.log"), `${sampleLogs()}\n`);
    const fake = createFakeOpenClawCron();

    try {
      const result = await runAssistantStatusCli(["--json"], {
        root: directory,
        env: {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          HILLA_TELEGRAM_BOT_TOKEN: "891055:SECRET",
          TELEGRAM_USER_ID: "1029709001",
        },
        runOpenClaw: fake.run,
        now: new Date("2026-06-11T07:00:00.000Z"),
      });

      assert.equal(result.checks.find((check) => check.id === "config-file").status, "ok");
      assert.equal(result.checks.find((check) => check.id === "state-dir").status, "ok");
      assert.equal(result.telegram.enabled, true);
      assert.equal(result.automation.summary.totalJobs, 11);
      assert.equal(result.automation.jobs.some((job) => job.id === "renew-gym"), false);
      assert.deepEqual(fake.mutations(), []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports the live Gateway jobs: weekly plan, routines, one-shots and disabled jobs", async () => {
    const fake = createFakeOpenClawCron();
    const result = await runAssistantStatusCli(["--json"], {
      loadInputs: async () => ({
        env: { TELEGRAM_USER_ID: FAKE_TELEGRAM_ID },
        config: sampleConfig(),
        liveCron: await loadLiveSnapshotFrom(fake),
        paths: {},
        exists: () => true,
      }),
      now: new Date("2026-09-26T11:00:00.000Z"),
    });
    const jobNames = result.automation.jobs.map((job) => job.name);

    assert.equal(result.automation.available, true);
    assert.deepEqual(result.automation.summary, {
      totalJobs: 11,
      enabledJobs: 6,
      disabledJobs: 5,
      cronJobs: 9,
      intervalJobs: 1,
      oneTimeJobs: 1,
      otherScheduleJobs: 0,
      dailyRecurringJobs: 2,
    });
    assert.ok(jobNames.includes("Assistant weekly plan: propose"));
    assert.ok(jobNames.includes("Assistant weekly plan: apply due plans"));
    assert.ok(jobNames.includes("Renew EU health insurance card"));
    assert.equal(result.automation.jobs.find((job) => job.name === "Assistant weather: morning").enabled, false);
    assert.deepEqual(result.automation.routines.map((routine) => [routine.routineId, routine.enabled]), [
      ["workout-window", true],
      ["midday-check-in", true],
      ["weekly-review", true],
      ["evening-review", false],
      ["morning-brief", false],
    ]);
    assert.equal(result.automation.jobs.find((job) => job.id === "routine-workout").lastErrorReason, "auth");
    assert.equal(result.recentActivity.lastScheduledRunAt, new Date(1790423100019).toISOString());
    assert.equal(result.automation.scheduler.storage, "sqlite");
    assert.equal(JSON.stringify(result).includes(FAKE_TELEGRAM_ID), false);
    assert.match(formatAssistantStatus(result), /Automation: 6\/11 automatic jobs enabled; 2 enabled daily recurring jobs \(live Gateway scheduler\)\./);
  });

  it("agrees with quiet-ops about the same live jobs", async () => {
    const fake = createFakeOpenClawCron();
    const status = buildAssistantStatus({ liveCron: await loadLiveSnapshotFrom(fake), paths: {}, exists: () => true });
    const quiet = await runQuietOpsCli(["status"], { runOpenClaw: fake.run, env: {} });

    for (const key of ["totalJobs", "enabledJobs", "disabledJobs", "oneShotJobs", "dailyRecurringJobs"]) {
      const statusKey = key === "oneShotJobs" ? "oneTimeJobs" : key;
      assert.equal(status.automation.summary[statusKey], quiet.summary[key], key);
    }
    assert.deepEqual(
      status.automation.jobs.map((job) => [job.id, job.enabled]),
      quiet.jobs.map((job) => [job.id, job.enabled]),
    );
  });

  it("reports a live scheduler it cannot read as a clear issue, never as 0 jobs", async () => {
    const fake = createFakeOpenClawCron({ fail: () => new Error("openclaw cron list failed: gateway closed (1006)") });
    const directory = mkdtempSync(join(tmpdir(), "assistant-status-down-"));
    const stateDir = join(directory, ".openclaw/state");
    mkdirSync(join(stateDir, "cron"), { recursive: true });
    writeFileSync(join(directory, ".openclaw/openclaw.json"), `${JSON.stringify(sampleConfig())}\n`);
    writeFileSync(join(stateDir, "cron/jobs.json"), `${JSON.stringify({ version: 1, jobs: sampleLiveRawJobs() })}\n`);

    try {
      const result = await runAssistantStatusCli(["--json"], {
        root: directory,
        env: { HILLA_TELEGRAM_BOT_TOKEN: "891055:SECRET", TELEGRAM_USER_ID: "1029709001" },
        runOpenClaw: fake.run,
        now: new Date("2026-06-11T07:00:00.000Z"),
      });

      assert.equal(result.automation.available, false);
      assert.equal(result.automation.summary, null);
      assert.deepEqual(result.automation.jobs, []);
      assert.match(result.automation.error, /gateway closed/);
      assert.equal(result.checks.find((check) => check.id === "live-scheduler").status, "warn");
      assert.ok(
        result.recentIssues.some((issue) => issue.checkId === "live-scheduler" && /could not be read: openclaw cron list failed/.test(issue.message)),
      );
      assert.notEqual(result.overall, "running");
      const text = formatAssistantStatus(result);
      assert.match(text, /Automation: live Gateway scheduler unavailable \(openclaw cron list failed: gateway closed \(1006\)\)\./);
      assert.match(text, /Routines: unknown while the live scheduler is unavailable\./);
      assert.doesNotMatch(text, /0\/0|no assistant routines installed/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("warns when the Gateway scheduler itself is disabled", () => {
    const status = buildAssistantStatus({
      liveCron: liveSnapshot(sampleLiveRawJobs(), { enabled: false, storage: "sqlite", jobCount: 3, nextWakeAt: null }),
      paths: {},
      exists: () => true,
    });

    assert.equal(status.checks.find((check) => check.id === "live-scheduler").status, "warn");
    assert.match(formatAssistantStatus(status), /\(live Gateway scheduler, which is disabled\)/);
  });

  it("includes bounded redacted log lines only when requested", async () => {
    const result = await runAssistantStatusCli(["--include-logs"], {
      loadInputs: () => ({
        env: { HILLA_TELEGRAM_BOT_TOKEN: "891055:SECRET", TELEGRAM_USER_ID: "1029709001" },
        config: sampleConfig(),
        liveCron: liveSnapshot(),
        gatewayLogText: sampleLogs(),
        gatewayErrLogText: "2026-06-10T23:30:00.000+02:00 [gateway] error token 891055:SECRET",
        paths: {
          configPath: ".openclaw/openclaw.json",
          stateDir: ".openclaw/state",
          telegramDir: ".openclaw/state/telegram",
        },
        exists: () => true,
      }),
      now: new Date("2026-06-11T07:00:00.000Z"),
    });

    assert.equal(result.recentLogs.length > 0, true);
    assert.equal(JSON.stringify(result.recentLogs).includes("891055:SECRET"), false);
    assert.equal(result.recentLogs.some((entry) => entry.line.includes("[gateway] ready")), true);
    assert.match(formatAssistantStatus(result), /Recent logs:/);
  });

  it("formats a concise human summary", () => {
    const summary = formatAssistantStatus({
      overall: "running",
      telegram: {
        enabled: true,
        provider: "@hilla_assistant_bot",
        providerStartedAt: "2026-06-10T22:53:46.030+02:00",
        allowFromCount: 1,
      },
      automation: {
        summary: { enabledJobs: 2, totalJobs: 3, dailyRecurringJobs: 1 },
        routines: [
          { routineId: "midday-check-in", enabled: true },
          { routineId: "workout-window", enabled: true, skippedToday: true },
          { routineId: "evening-review", enabled: false },
        ],
      },
      recentActivity: {
        gatewayReadyAt: "2026-06-10T22:53:45.680+02:00",
        lastScheduledRunAt: null,
      },
      recentIssues: [],
      suggestedActions: [
        { label: "Check routines", command: "npm run routines:status" },
        { label: "Run doctor", command: "npm run doctor" },
      ],
    });

    assert.match(summary, /Status: running/);
    assert.match(summary, /@hilla_assistant_bot/);
    assert.match(summary, /2\/3 automatic jobs enabled/);
    assert.match(summary, /midday-check-in enabled/);
    assert.match(summary, /workout-window enabled, skipped today/);
    assert.match(summary, /evening-review disabled/);
    assert.match(summary, /npm run routines:status/);
    assert.match(summary, /npm run doctor/);
  });
});

describe("canonical Telegram bot token variable", () => {
  const config = sampleConfig();
  const base = { config, liveCron: liveSnapshot(), now: new Date() };

  function telegramCheck(env) {
    const status = buildAssistantStatus({ ...base, env });
    return status.checks.find((check) => check.id === "telegram-env");
  }

  it("requires only the canonical name for env validation", () => {
    assert.ok(REQUIRED_ENV_KEYS.includes("HILLA_TELEGRAM_BOT_TOKEN"));
    assert.ok(!REQUIRED_ENV_KEYS.includes("TELEGRAM_BOT_TOKEN"));

    const legacyOnly = requiredEnvReport({
      HILLA_TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_BOT_TOKEN: "891055:SECRET",
    });
    assert.ok(legacyOnly.missing.includes("HILLA_TELEGRAM_BOT_TOKEN"));

    const canonical = requiredEnvReport({ HILLA_TELEGRAM_BOT_TOKEN: "891055:SECRET" });
    assert.ok(!canonical.missing.includes("HILLA_TELEGRAM_BOT_TOKEN"));
  });

  it("accepts the canonical name for status reporting", () => {
    assert.equal(
      telegramCheck({ HILLA_TELEGRAM_BOT_TOKEN: "891055:SECRET", TELEGRAM_USER_ID: "1029709001" }).status,
      "ok",
    );
  });

  it("falls back to the legacy name so an unmigrated runtime is not reported as broken", () => {
    assert.equal(
      telegramCheck({ TELEGRAM_BOT_TOKEN: "891055:SECRET", TELEGRAM_USER_ID: "1029709001" }).status,
      "ok",
    );
  });

  it("prefers the canonical name when both are set", () => {
    const status = buildAssistantStatus({
      ...base,
      env: {
        HILLA_TELEGRAM_BOT_TOKEN: "canonical-token-value",
        TELEGRAM_BOT_TOKEN: "legacy-token-value",
        TELEGRAM_USER_ID: "1029709001",
      },
      logText: "2026-06-11T08:00:00.000+02:00 [telegram] canonical-token-value and legacy-token-value seen",
    });
    const serialized = JSON.stringify(status);

    assert.equal(status.telegram.botTokenConfigured, true);
    assert.ok(!serialized.includes("canonical-token-value"));
    assert.ok(!serialized.includes("legacy-token-value"));
  });

  it("reports a failure when neither name is set", () => {
    assert.equal(telegramCheck({ TELEGRAM_USER_ID: "1029709001" }).status, "fail");
  });

  it("redacts a token held under either name", () => {
    assert.equal(
      redactSensitiveText("token 891055:SECRET here", ["891055:SECRET"]),
      "token <redacted> here",
    );

    for (const key of ["HILLA_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"]) {
      const status = buildAssistantStatus({
        ...base,
        env: { [key]: "891055:SECRET", TELEGRAM_USER_ID: "1029709001" },
        logText: "2026-06-11T08:00:00.000+02:00 [telegram] using 891055:SECRET now",
      });

      assert.ok(!JSON.stringify(status).includes("891055:SECRET"), `leaked via ${key}`);
    }
  });
});

describe("assistant status weekly plan", () => {
  it("reports a pending weekly plan with its version and local apply time", async () => {
    const directory = mkdtempSync(join(tmpdir(), "assistant-status-plan-"));
    const stateDir = join(directory, ".openclaw/state");
    const now = new Date("2026-09-26T07:00:00.000Z");
    try {
      await runWeeklyPlanCli(["propose", "--send"], {
        stateDir,
        env: { TELEGRAM_USER_ID: "1029709001" },
        todoistClient: { getTasks: async () => [] },
        sendMessage: async () => ({ messageId: 1 }),
        now: () => now,
        random: () => "abc123",
      });
      const inputs = loadAssistantStatusInputs({ env: {}, projectRoot: directory, stateDir });
      const status = buildAssistantStatus({ ...inputs, now });

      assert.equal(status.weeklyPlan.pending.length, 1);
      assert.equal(status.weeklyPlan.pending[0].planId, "wp-2026-W40-abc123");
      assert.equal(status.weeklyPlan.pending[0].currentVersion, 1);
      assert.equal(status.weeklyPlan.pending[0].reviewDeadlineLocal, "21:00 on Saturday 26 Sep");
      assert.equal(status.weeklyPlan.upcomingWeek.status, "pending");
      assert.match(formatAssistantStatus(status), /Weekly plan: 2026-W40 pending \(v1\), applies at 21:00 on Saturday 26 Sep\./);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports unreadable weekly plan state as an issue instead of failing", () => {
    const directory = mkdtempSync(join(tmpdir(), "assistant-status-plan-"));
    const stateDir = join(directory, ".openclaw/state");
    mkdirSync(join(stateDir, "weekly-plan/plans"), { recursive: true });
    writeFileSync(join(stateDir, "weekly-plan/plans/wp-2026-W40-abc123.json"), "{ broken");
    try {
      const inputs = loadAssistantStatusInputs({ env: {}, projectRoot: directory, stateDir });
      const status = buildAssistantStatus({ ...inputs, now: new Date("2026-09-26T07:00:00.000Z") });

      assert.deepEqual(status.weeklyPlan.pending, []);
      assert.ok(status.recentIssues.some((issue) => issue.type === "weekly-plan-read-failed"));
      assert.match(formatAssistantStatus(status), /Weekly plan: none yet\./);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("assistant status gateway log discovery", () => {
  const liveNow = new Date("2026-09-26T11:00:00.000Z");

  function createLogFixture() {
    const directory = mkdtempSync(join(tmpdir(), "assistant-status-logs-"));
    const fixture = {
      directory,
      home: join(directory, "home"),
      stateDir: join(directory, ".openclaw/state"),
      configPath: join(directory, ".openclaw/openclaw.json"),
    };
    mkdirSync(join(fixture.stateDir, "telegram"), { recursive: true });
    writeFileSync(fixture.configPath, `${JSON.stringify(sampleConfig())}\n`);
    return fixture;
  }

  function writeFileAt(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }

  function launchAgentPlist({ stdoutPath, stderrPath }) {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "  <key>Label</key>",
      "  <string>ai.openclaw.gateway</string>",
      "  <key>StandardOutPath</key>",
      `  <string>${stdoutPath}</string>`,
      "  <key>StandardErrorPath</key>",
      `  <string>${stderrPath}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
  }

  // A clean start as OpenClaw 2026.7 writes it to the LaunchAgent log.
  function healthyLiveLog() {
    return [
      "2026-09-26T12:26:56.719+02:00 [gateway] loading configuration…",
      "2026-09-26T12:26:58.825+02:00 [gateway] agent model: openai/gpt-5.6-sol (thinking=medium, fast=off)",
      "2026-09-26T12:26:59.022+02:00 [gateway] ready",
      "2026-09-26T12:26:59.134+02:00 [telegram] [main] starting provider (@hilla_assistant_bot)",
      "",
    ].join("\n");
  }

  // What the repo-local file still holds after the service moved elsewhere:
  // its last start, then the shutdown when the old service was removed.
  function staleLegacyLog() {
    return [
      "2026-07-22T22:17:00.000+02:00 [gateway] ready",
      "2026-07-22T22:18:23.036+02:00 [gateway] received SIGTERM; shutting down",
      "2026-07-22T22:18:23.070+02:00 [shutdown] started: gateway stopping",
      "2026-07-22T22:18:28.403+02:00 [shutdown] completed cleanly in 5334ms",
      "",
    ].join("\n");
  }

  const liveLogPath = (home, name = "gateway.log") => join(home, "Library/Logs/openclaw", name);
  const plistPath = (home) => join(home, "Library/LaunchAgents/ai.openclaw.gateway.plist");
  const legacyLogPath = (stateDir) => join(stateDir, "logs/gateway.log");
  const liveEnv = (home, extra = {}) => ({
    HOME: home,
    HILLA_TELEGRAM_BOT_TOKEN: "891055:SECRET",
    TELEGRAM_USER_ID: "1029709001",
    ...extra,
  });

  function loadFor(fixture, { env, platform = "darwin" }) {
    return loadAssistantStatusInputs({
      env,
      projectRoot: fixture.directory,
      configPath: fixture.configPath,
      stateDir: fixture.stateDir,
      platform,
    });
  }

  function statusFor(fixture, options) {
    return buildAssistantStatus({ ...loadFor(fixture, options), now: liveNow });
  }

  it("reads the log the installed LaunchAgent writes instead of the stale repo-local copy", () => {
    const fixture = createLogFixture();
    try {
      writeFileAt(liveLogPath(fixture.home), healthyLiveLog());
      writeFileAt(plistPath(fixture.home), launchAgentPlist({ stdoutPath: liveLogPath(fixture.home), stderrPath: "/dev/null" }));
      writeFileAt(legacyLogPath(fixture.stateDir), staleLegacyLog());

      const status = statusFor(fixture, { env: liveEnv(fixture.home) });

      assert.equal(status.logs.source, "launchd");
      assert.equal(status.logs.stdoutPath, liveLogPath(fixture.home));
      assert.equal(status.logs.stderrPath, null);
      assert.equal(status.recentActivity.gatewayReadyAt, "2026-09-26T12:26:59.022+02:00");
      assert.equal(status.telegram.provider, "@hilla_assistant_bot");
      assert.equal(status.checks.find((check) => check.id === "gateway-ready-log").status, "ok");
      assert.deepEqual(status.recentIssues, []);
      assert.equal(status.overall, "running");
      assert.match(formatAssistantStatus(status), /Gateway log: .*Library\/Logs\/openclaw\/gateway\.log \(launchd\)\./);

      // Reading only the stale repo-local copy is what used to report a healthy gateway as degraded.
      const legacyOnly = statusFor(fixture, { env: liveEnv(fixture.home), platform: "linux" });
      assert.equal(legacyOnly.logs.source, "legacy");
      assert.equal(legacyOnly.overall, "degraded");
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("uses OpenClaw's default LaunchAgent log location when no plist is installed", () => {
    const fixture = createLogFixture();
    try {
      writeFileAt(liveLogPath(fixture.home), healthyLiveLog());
      writeFileAt(legacyLogPath(fixture.stateDir), staleLegacyLog());

      const status = statusFor(fixture, { env: liveEnv(fixture.home) });
      assert.equal(status.logs.source, "openclaw-default");
      assert.equal(status.logs.stdoutPath, liveLogPath(fixture.home));
      assert.equal(status.overall, "running");

      writeFileAt(liveLogPath(fixture.home, "custom.log"), healthyLiveLog());
      const prefixed = statusFor(fixture, { env: liveEnv(fixture.home, { OPENCLAW_LOG_PREFIX: "custom" }) });
      assert.equal(prefixed.logs.stdoutPath, liveLogPath(fixture.home, "custom.log"));
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("reads a binary LaunchAgent plist too", { skip: process.platform !== "darwin" && "needs macOS plutil" }, () => {
    const fixture = createLogFixture();
    try {
      // A non-default file name proves the path came from the plist, not the default location.
      const customLog = liveLogPath(fixture.home, "custom-gateway.log");
      writeFileAt(customLog, healthyLiveLog());
      writeFileAt(plistPath(fixture.home), launchAgentPlist({ stdoutPath: customLog, stderrPath: "/dev/null" }));
      execFileSync("/usr/bin/plutil", ["-convert", "binary1", plistPath(fixture.home)]);
      writeFileAt(legacyLogPath(fixture.stateDir), staleLegacyLog());

      const status = statusFor(fixture, { env: liveEnv(fixture.home) });
      assert.equal(status.logs.source, "launchd");
      assert.equal(status.logs.stdoutPath, customLog);
      assert.equal(status.overall, "running");
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("skips a LaunchAgent log path that does not exist", () => {
    const fixture = createLogFixture();
    try {
      writeFileAt(plistPath(fixture.home), launchAgentPlist({ stdoutPath: liveLogPath(fixture.home, "missing.log"), stderrPath: "/dev/null" }));
      writeFileAt(liveLogPath(fixture.home), healthyLiveLog());

      const status = statusFor(fixture, { env: liveEnv(fixture.home) });
      assert.equal(status.logs.source, "openclaw-default");
      assert.equal(status.logs.stdoutPath, liveLogPath(fixture.home));
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("falls back to the legacy repo-local logs, which are also OpenClaw's default off macOS", () => {
    const fixture = createLogFixture();
    try {
      writeFileAt(legacyLogPath(fixture.stateDir), healthyLiveLog());

      const status = statusFor(fixture, { env: liveEnv(fixture.home) });
      assert.equal(status.logs.source, "legacy");
      assert.equal(status.logs.stdoutPath, legacyLogPath(fixture.stateDir));
      assert.equal(status.recentActivity.gatewayReadyAt, "2026-09-26T12:26:59.022+02:00");
      assert.equal(status.overall, "running");

      writeFileAt(liveLogPath(fixture.home), staleLegacyLog());
      const offMac = statusFor(fixture, { env: liveEnv(fixture.home), platform: "linux" });
      assert.equal(offMac.logs.source, "legacy");

      const withoutHome = statusFor(fixture, { env: liveEnv(undefined) });
      assert.equal(withoutHome.logs.source, "legacy");
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("keeps returning status when no gateway log exists anywhere", () => {
    const fixture = createLogFixture();
    try {
      const status = statusFor(fixture, { env: liveEnv(fixture.home) });

      assert.equal(status.logs.source, null);
      assert.equal(status.logs.stdoutPath, null);
      assert.equal(status.logs.checked.includes(liveLogPath(fixture.home)), true);
      assert.equal(status.logs.checked.includes(legacyLogPath(fixture.stateDir)), true);
      assert.equal(status.checks.find((check) => check.id === "gateway-ready-log").status, "warn");
      assert.equal(status.overall, "degraded");
      assert.match(formatAssistantStatus(status), /Gateway log: not found\./);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("redacts secrets in lines read from the discovered log", async () => {
    const fixture = createLogFixture();
    try {
      writeFileAt(
        liveLogPath(fixture.home),
        [
          healthyLiveLog().trimEnd(),
          "2026-09-26T12:40:00.000+02:00 [telegram] error polling https://api.telegram.org/bot891055:SECRET/getUpdates with 891055:SECRET",
          "2026-09-26T12:41:00.000+02:00 [gateway] error auth gateway-secret-token rejected",
          "",
        ].join("\n"),
      );

      const result = await runAssistantStatusCli(["--include-logs"], {
        loadInputs: () => loadFor(fixture, { env: liveEnv(fixture.home) }),
        now: liveNow,
      });

      assert.equal(result.logs.source, "openclaw-default");
      assert.equal(result.recentIssues.filter((issue) => issue.type === "log-error").length, 2);
      assert.equal(result.recentLogs.some((entry) => entry.line.includes("<redacted>")), true);
      assert.equal(JSON.stringify(result).includes("891055:SECRET"), false);
      assert.equal(JSON.stringify(result).includes("gateway-secret-token"), false);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
});
