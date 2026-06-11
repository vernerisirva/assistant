import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as assistantStatusModule from "../scripts/lib/assistant-status.mjs";
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
            botToken: "${TELEGRAM_BOT_TOKEN}",
            allowFrom: ["1029709001"],
            execApprovals: { enabled: true, approvers: ["1029709001"] },
          },
        },
      },
    },
  };
}

function sampleCronStore() {
  return {
    version: 1,
    jobs: [
      {
        id: "routine-midday",
        agentId: "health",
        name: "Assistant routine: midday-check-in",
        enabled: true,
        schedule: { kind: "cron", expr: "30 12 * * *", tz: "Europe/Stockholm" },
      },
      {
        id: "routine-evening",
        agentId: "personal",
        name: "Assistant routine: evening-review",
        enabled: false,
        schedule: { kind: "cron", expr: "0 21 * * *", tz: "Europe/Stockholm" },
      },
      {
        id: "renew-gym",
        agentId: "personal",
        name: "Reminder: Renew gym card",
        enabled: true,
        schedule: { kind: "at", at: "2026-06-19T07:00:00.000Z" },
      },
    ],
  };
}

function sampleCronState() {
  return {
    version: 1,
    jobs: {
      "routine-midday": {
        state: {
          nextRunAtMs: Date.parse("2026-06-11T10:30:00.000Z"),
          lastStatus: "ok",
          lastRunAtMs: Date.parse("2026-06-10T10:30:00.000Z"),
        },
      },
    },
  };
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

  it("builds a redacted running status from local config, cron state, and logs", () => {
    const status = buildAssistantStatus({
      env: {
        TELEGRAM_BOT_TOKEN: "891055:SECRET",
        TELEGRAM_USER_ID: "1029709001",
      },
      config: sampleConfig(),
      cronStore: sampleCronStore(),
      cronState: sampleCronState(),
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
    assert.equal(JSON.stringify(status).includes("891055:SECRET"), false);
    assert.equal(JSON.stringify(status).includes("gateway-secret-token"), false);
    assert.ok(status.suggestedActions.some((action) => action.command.includes("npm run routines:status")));
    assert.ok(status.suggestedActions.some((action) => action.command.includes("npm run doctor")));
  });

  it("reports needs_attention when config or state are missing", () => {
    const status = buildAssistantStatus({
      env: {},
      config: {},
      cronStore: { version: 1, jobs: [] },
      cronState: { version: 1, jobs: {} },
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

  it("does not treat rendered env placeholders or hourly cron as configured daily status", () => {
    const config = sampleConfig();
    const status = buildAssistantStatus({
      env: { TELEGRAM_USER_ID: "1029709001" },
      config,
      cronStore: {
        version: 1,
        jobs: [
          {
            id: "hourly-check",
            name: "Hourly check",
            enabled: true,
            schedule: { kind: "cron", expr: "0 * * * *", tz: "Europe/Stockholm" },
          },
          {
            id: "daily-check",
            name: "Daily check",
            enabled: true,
            schedule: { kind: "cron", expr: "30 12 * * *", tz: "Europe/Stockholm" },
          },
        ],
      },
      cronState: { version: 1, jobs: {} },
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

  it("keeps returning degraded status when cron state timestamps are invalid", () => {
    const status = buildAssistantStatus({
      env: {
        TELEGRAM_BOT_TOKEN: "891055:SECRET",
        TELEGRAM_USER_ID: "1029709001",
      },
      config: sampleConfig(),
      cronStore: sampleCronStore(),
      cronState: {
        version: 1,
        jobs: {
          "routine-midday": {
            state: {
              nextRunAtMs: "not-a-date",
              lastRunAtMs: 1e100,
              lastStatus: "ok",
            },
          },
        },
      },
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

  it("reports malformed JSON state as a recent issue and keeps returning status", () => {
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
        env: { TELEGRAM_BOT_TOKEN: "891055:SECRET", TELEGRAM_USER_ID: "1029709001" },
        projectRoot: directory,
        configPath,
        stateDir,
      });
      const status = buildAssistantStatus({
        ...inputs,
        now: new Date("2026-06-11T07:00:00.000Z"),
      });

      assert.equal(status.overall, "degraded");
      assert.equal(status.automation.summary.totalJobs, 0);
      assert.equal(status.recentIssues.find((issue) => issue.type === "malformed-json").path.endsWith("jobs.json"), true);
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
        env: { TELEGRAM_BOT_TOKEN: "891055:SECRET", TELEGRAM_USER_ID: "1029709001" },
        config: sampleConfig(),
        cronStore: sampleCronStore(),
        cronState: sampleCronState(),
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

  it("accepts launchd-style absolute OpenClaw paths inside the project", async () => {
    const directory = mkdtempSync(join(tmpdir(), "assistant-status-cli-"));
    const configPath = join(directory, ".openclaw/openclaw.json");
    const stateDir = join(directory, ".openclaw/state");
    mkdirSync(join(stateDir, "cron"), { recursive: true });
    mkdirSync(join(stateDir, "logs"), { recursive: true });
    mkdirSync(join(stateDir, "telegram"), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(sampleConfig())}\n`);
    writeFileSync(join(stateDir, "cron/jobs.json"), `${JSON.stringify(sampleCronStore())}\n`);
    writeFileSync(join(stateDir, "cron/jobs-state.json"), `${JSON.stringify(sampleCronState())}\n`);
    writeFileSync(join(stateDir, "logs/gateway.log"), `${sampleLogs()}\n`);

    try {
      const result = await runAssistantStatusCli(["--json"], {
        root: directory,
        env: {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          TELEGRAM_BOT_TOKEN: "891055:SECRET",
          TELEGRAM_USER_ID: "1029709001",
        },
        now: new Date("2026-06-11T07:00:00.000Z"),
      });

      assert.equal(result.checks.find((check) => check.id === "config-file").status, "ok");
      assert.equal(result.checks.find((check) => check.id === "state-dir").status, "ok");
      assert.equal(result.telegram.enabled, true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("includes bounded redacted log lines only when requested", async () => {
    const result = await runAssistantStatusCli(["--include-logs"], {
      loadInputs: () => ({
        env: { TELEGRAM_BOT_TOKEN: "891055:SECRET", TELEGRAM_USER_ID: "1029709001" },
        config: sampleConfig(),
        cronStore: sampleCronStore(),
        cronState: sampleCronState(),
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
