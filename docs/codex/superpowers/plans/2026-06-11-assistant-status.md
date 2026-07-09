# Assistant Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one read-only assistant status command that the Telegram-facing Personal agent can use to explain gateway, Telegram, routine, automation, and recent-error state.

**Architecture:** Create a focused status aggregator in `scripts/lib/assistant-status.mjs` and a thin CLI wrapper in `scripts/assistant-status.mjs`. The aggregator reads local config, cron state, quiet-ops summaries, routine summaries, and bounded gateway logs, then returns redacted structured data for the Personal agent to summarize.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing OpenClaw config/state files, existing quiet-ops and routine-cron helpers, no new dependencies.

---

### File Structure

- Create `scripts/lib/assistant-status.mjs`: pure-ish status aggregation helpers with dependency injection for tests.
- Create `scripts/assistant-status.mjs`: CLI arg parsing, JSON/human output, and process exit behavior.
- Create `tests/assistant-status.test.mjs`: unit tests for status aggregation, redaction, log parsing, missing files, malformed state, and CLI formatting.
- Modify `package.json`: add `assistant:status`.
- Modify `agents/personal/AGENTS.md`: teach the Telegram-facing agent when to use the status command and how to summarize it.
- Modify `docs/operations/daily-operation.md`: document the new status command for local operations.

### Task 1: Status Aggregator Tests

**Files:**
- Create: `tests/assistant-status.test.mjs`
- Create: `scripts/lib/assistant-status.mjs`

- [ ] **Step 1: Create the failing test file**

Add this initial test file at `tests/assistant-status.test.mjs`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAssistantStatus,
  loadAssistantStatusInputs,
  parseGatewayLogText,
  redactSensitiveText,
} from "../scripts/lib/assistant-status.mjs";

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
  ].join("\n");
}

describe("assistant status aggregation", () => {
  it("builds a redacted running status from local config, cron state, and logs", () => {
    const status = buildAssistantStatus({
      env: {
        TELEGRAM_BOT_TOKEN: "891055:SECRET",
        TELEGRAM_USER_ID: "1029709001",
      },
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
    assert.equal(status.recentActivity.gatewayReadyAt, "2026-06-10T22:53:45.680+02:00");
    assert.equal(status.recentActivity.telegramProviderStartedAt, "2026-06-10T22:53:46.030+02:00");
    assert.equal(status.recentIssues.length, 1);
    assert.equal(status.recentIssues[0].type, "fetch-timeout");
    assert.equal(JSON.stringify(status).includes("891055:SECRET"), false);
    assert.equal(JSON.stringify(status).includes("gateway-secret-token"), false);
    assert.ok(status.suggestedActions.some((action) => action.command.includes("npm run quiet:status")));
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
      exists: (path) => path !== ".openclaw/openclaw.json",
      now: new Date("2026-06-11T07:00:00.000Z"),
      recentHours: 24,
    });

    assert.equal(status.overall, "needs_attention");
    assert.equal(status.checks.find((check) => check.id === "config-file").status, "fail");
    assert.equal(status.telegram.enabled, false);
  });

  it("reports malformed JSON state as a recent issue and keeps returning status", () => {
    const directory = mkdtempSync(join(tmpdir(), "assistant-status-"));
    const stateDir = join(directory, ".openclaw/state");
    const configPath = join(directory, ".openclaw/openclaw.json");
    mkdirSync(join(stateDir, "cron"), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(sampleConfig())}\n`);
    writeFileSync(join(stateDir, "cron/jobs.json"), "{ broken json");

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

  it("redacts known secrets and Telegram bot URL token forms", () => {
    const text = "token=abc123 https://api.telegram.org/bot891055:SECRET/getMe gateway-secret-token";
    const redacted = redactSensitiveText(text, ["abc123", "gateway-secret-token"]);

    assert.equal(redacted.includes("abc123"), false);
    assert.equal(redacted.includes("891055:SECRET"), false);
    assert.equal(redacted.includes("gateway-secret-token"), false);
    assert.match(redacted, /<redacted>/);
  });
});
```

- [ ] **Step 2: Add an empty module so the import target exists**

Create `scripts/lib/assistant-status.mjs` with only the exported stubs below:

```js
export function buildAssistantStatus() {
  throw new Error("buildAssistantStatus is not implemented");
}

export function parseGatewayLogText() {
  throw new Error("parseGatewayLogText is not implemented");
}

export function redactSensitiveText() {
  throw new Error("redactSensitiveText is not implemented");
}
```

- [ ] **Step 3: Run the focused test to verify RED**

Run:

```bash
node --test tests/assistant-status.test.mjs
```

Expected: FAIL with `buildAssistantStatus is not implemented`.

- [ ] **Step 4: Commit the RED test**

Run:

```bash
git add tests/assistant-status.test.mjs scripts/lib/assistant-status.mjs
git commit -m "test: define assistant status behavior"
```

Expected: commit succeeds and contains only the new test and stub module. If local `.git` metadata permissions block committing, keep the staged file list to these two paths and record the failure in the task handoff.

### Task 2: Status Aggregator Implementation

**Files:**
- Modify: `scripts/lib/assistant-status.mjs`
- Test: `tests/assistant-status.test.mjs`

- [ ] **Step 1: Implement the aggregator helpers**

Replace `scripts/lib/assistant-status.mjs` with:

```js
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { quietOpsStatus, auditQuietOps } from "./quiet-ops.mjs";
import {
  resolveCronStatePath,
  resolveCronStorePath,
} from "./cron-store.mjs";
import { routineCronStatus } from "./routine-cron.mjs";

const TOKEN_PATTERN = /bot[^/\s]+/gi;
const DEFAULT_RECENT_HOURS = 24;

export function loadAssistantStatusInputs({ env, projectRoot, configPath, stateDir }) {
  const cronStorePath = resolveCronStorePath(stateDir);
  const cronStatePath = resolveCronStatePath(stateDir);
  const loadIssues = [];
  return {
    env,
    config: safeReadJson(configPath, { fallback: {}, loadIssues }),
    cronStore: safeReadCronStore(cronStorePath, loadIssues),
    cronState: safeReadCronState(cronStatePath, loadIssues),
    gatewayLogText: readTextIfExists(join(stateDir, "logs/gateway.log")),
    gatewayErrLogText: readTextIfExists(join(stateDir, "logs/gateway.err.log")),
    loadIssues,
    paths: {
      projectRoot,
      configPath,
      stateDir,
      telegramDir: join(stateDir, "telegram"),
    },
    exists: existsSync,
  };
}

export function buildAssistantStatus({
  env = {},
  config = {},
  cronStore = { version: 1, jobs: [] },
  cronState = { version: 1, jobs: {} },
  gatewayLogText = "",
  gatewayErrLogText = "",
  loadIssues = [],
  paths = {},
  exists = existsSync,
  now = new Date(),
  recentHours = DEFAULT_RECENT_HOURS,
} = {}) {
  const secrets = secretValues(env, config);
  const logs = parseGatewayLogText(`${gatewayLogText}\n${gatewayErrLogText}`, { now, recentHours, secrets });
  const quietStatus = quietOpsStatus(cronStore, cronState);
  const quietAudit = auditQuietOps(cronStore, cronState, { now });
  const routines = routineCronStatus(cronStore, cronState);
  const checks = buildChecks({ env, config, paths, exists, logs });
  const telegram = buildTelegramStatus({ env, config, logs });
  const recentIssues = [
    ...checks.filter((check) => check.status === "fail").map(checkIssue),
    ...loadIssues,
    ...logs.issues,
    ...quietAudit.issues.filter((issue) => issue.severity === "warn").map(quietIssue),
  ];

  return {
    overall: overallState(checks, recentIssues),
    checks,
    telegram,
    automation: {
      summary: quietStatus.summary,
      jobs: quietStatus.jobs,
      routines,
      auditIssues: quietAudit.issues,
    },
    recentActivity: {
      gatewayReadyAt: logs.gatewayReadyAt,
      telegramProviderStartedAt: logs.telegramProviderStartedAt,
      lastInboundTelegramAt: logs.lastInboundTelegramAt,
      lastScheduledRunAt: lastScheduledRunAt(cronState),
    },
    recentIssues,
    suggestedActions: [
      {
        label: "Review automatic messages",
        command: "npm run quiet:status -- --json",
      },
      {
        label: "Audit noisy automation",
        command: "npm run quiet:audit -- --json",
      },
      {
        label: "Review routines",
        command: "npm run routines:status",
      },
    ],
  };
}

export function parseGatewayLogText(text = "", { now = new Date(), recentHours = DEFAULT_RECENT_HOURS, secrets = [] } = {}) {
  const startMs = now.getTime() - recentHours * 60 * 60 * 1000;
  const result = {
    gatewayReadyAt: null,
    telegramProviderStartedAt: null,
    telegramProvider: null,
    lastInboundTelegramAt: null,
    issues: [],
  };

  for (const line of text.split(/\r?\n/)) {
    const timestamp = timestampFromLine(line);
    if (!timestamp) continue;
    const timestampMs = Date.parse(timestamp);
    if (Number.isFinite(timestampMs) && timestampMs < startMs) continue;

    if (line.includes("[gateway] ready")) {
      result.gatewayReadyAt = timestamp;
    }

    const providerMatch = /\[telegram\].*starting provider \(([^)]+)\)/.exec(line);
    if (providerMatch) {
      result.telegramProviderStartedAt = timestamp;
      result.telegramProvider = providerMatch[1];
    }

    if (line.includes("[telegram] Inbound message")) {
      result.lastInboundTelegramAt = timestamp;
    }

    const issue = issueFromLogLine(line, timestamp, secrets);
    if (issue) result.issues.push(issue);
  }

  return result;
}

export function redactSensitiveText(text = "", secrets = []) {
  let redacted = String(text).replace(TOKEN_PATTERN, "bot<redacted>");
  for (const secret of secrets.filter((value) => typeof value === "string" && value.length > 0)) {
    redacted = redacted.split(secret).join("<redacted>");
  }
  return redacted;
}

function buildChecks({ env, config, paths, exists, logs }) {
  return [
    check("config-file", Boolean(paths.configPath && exists(paths.configPath)), `Config file ${paths.configPath ?? "unknown"}`),
    check("state-dir", Boolean(paths.stateDir && exists(paths.stateDir)), `State dir ${paths.stateDir ?? "unknown"}`),
    check("telegram-dir", Boolean(paths.telegramDir && exists(paths.telegramDir)), `Telegram state dir ${paths.telegramDir ?? "unknown"}`, "warn"),
    check("telegram-env", Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_USER_ID), "Telegram env keys configured"),
    check("telegram-config", config.channels?.telegram?.enabled === true, "Telegram channel enabled"),
    check("gateway-ready-log", Boolean(logs.gatewayReadyAt), "Recent gateway ready log found", "warn"),
  ];
}

function buildTelegramStatus({ env, config, logs }) {
  const telegramConfig = config.channels?.telegram ?? {};
  const account = telegramConfig.defaultAccount ?? "main";
  const accountConfig = telegramConfig.accounts?.[account] ?? {};
  return {
    enabled: telegramConfig.enabled === true,
    defaultAccount: account,
    provider: logs.telegramProvider,
    providerStartedAt: logs.telegramProviderStartedAt,
    allowFromCount: Array.isArray(telegramConfig.allowFrom) ? telegramConfig.allowFrom.length : 0,
    botTokenConfigured: Boolean(env.TELEGRAM_BOT_TOKEN || accountConfig.botToken),
    execApprovalsEnabled: accountConfig.execApprovals?.enabled === true,
  };
}

function issueFromLogLine(line, timestamp, secrets) {
  if (line.includes("[skills] Skipping escaped skill path")) return null;
  if (line.includes("[fetch-timeout]")) {
    return {
      severity: "warn",
      type: "fetch-timeout",
      at: timestamp,
      message: redactSensitiveText(line, secrets),
    };
  }
  if (/\berror\b/i.test(line) || /\bfatal\b/i.test(line)) {
    return {
      severity: "warn",
      type: "log-error",
      at: timestamp,
      message: redactSensitiveText(line, secrets),
    };
  }
  return null;
}

function secretValues(env, config) {
  return [
    env.TELEGRAM_BOT_TOKEN,
    config.gateway?.auth?.token,
    config.gateway?.remote?.token,
  ].filter(Boolean);
}

function timestampFromLine(line) {
  return /^(\d{4}-\d{2}-\d{2}T\S+)/.exec(line)?.[1] ?? null;
}

function check(id, passed, message, failStatus = "fail") {
  return {
    id,
    status: passed ? "pass" : failStatus,
    message,
  };
}

function checkIssue(check) {
  return {
    severity: check.status === "fail" ? "error" : "warn",
    type: "check-failed",
    checkId: check.id,
    message: check.message,
  };
}

function quietIssue(issue) {
  return {
    severity: issue.severity,
    type: issue.type,
    message: issue.jobNames ? issue.jobNames.join(" | ") : issue.jobName ?? issue.type,
  };
}

function overallState(checks, issues) {
  if (checks.some((check) => check.status === "fail")) return "needs_attention";
  if (issues.some((issue) => issue.severity === "warn" || issue.severity === "error")) return "degraded";
  return "running";
}

function lastScheduledRunAt(cronState) {
  const times = Object.values(cronState?.jobs ?? {})
    .map((entry) => entry?.state?.lastRunAtMs)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a);
  return times.length > 0 ? new Date(times[0]).toISOString() : null;
}

function readTextIfExists(path) {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function safeReadJson(path, { fallback, loadIssues }) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    loadIssues.push({
      severity: "warn",
      type: "malformed-json",
      path,
      message: `Malformed JSON in ${path}: ${error.message}`,
    });
    return fallback;
  }
}

function safeReadCronStore(path, loadIssues) {
  const parsed = safeReadJson(path, { fallback: { version: 1, jobs: [] }, loadIssues });
  if (Array.isArray(parsed.jobs)) return parsed;
  return { version: parsed.version ?? 1, jobs: [] };
}

function safeReadCronState(path, loadIssues) {
  const parsed = safeReadJson(path, { fallback: { version: 1, jobs: {} }, loadIssues });
  if (parsed && typeof parsed === "object" && parsed.jobs && typeof parsed.jobs === "object") return parsed;
  return { version: parsed.version ?? 1, jobs: {} };
}
```

- [ ] **Step 2: Run the focused test to verify GREEN**

Run:

```bash
node --test tests/assistant-status.test.mjs
```

Expected: PASS. If `overall` is unexpectedly `running`, check that `fetch-timeout` log parsing returns one warn issue.

- [ ] **Step 3: Run related tests**

Run:

```bash
node --test tests/quiet-ops.test.mjs tests/routine-cron.test.mjs tests/assistant-status.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Commit the aggregator**

Run:

```bash
git add scripts/lib/assistant-status.mjs tests/assistant-status.test.mjs
git commit -m "feat: aggregate assistant status"
```

Expected: commit contains the status library and updated tests only.

### Task 3: CLI Wrapper and Package Script

**Files:**
- Create: `scripts/assistant-status.mjs`
- Modify: `package.json`
- Modify: `tests/assistant-status.test.mjs`

- [ ] **Step 1: Add failing CLI tests**

Append this block to `tests/assistant-status.test.mjs`:

```js
import {
  formatAssistantStatus,
  parseAssistantStatusArgs,
  runAssistantStatusCli,
} from "../scripts/assistant-status.mjs";

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
          { routineId: "evening-review", enabled: false },
        ],
      },
      recentActivity: {
        gatewayReadyAt: "2026-06-10T22:53:45.680+02:00",
        lastScheduledRunAt: null,
      },
      recentIssues: [],
      suggestedActions: [{ label: "Review automatic messages", command: "npm run quiet:status -- --json" }],
    });

    assert.match(summary, /Status: running/);
    assert.match(summary, /@hilla_assistant_bot/);
    assert.match(summary, /2\/3 automatic jobs enabled/);
    assert.match(summary, /midday-check-in enabled/);
    assert.match(summary, /evening-review disabled/);
  });
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
node --test tests/assistant-status.test.mjs
```

Expected: FAIL because `scripts/assistant-status.mjs` does not exist.

- [ ] **Step 3: Implement the CLI wrapper**

Create `scripts/assistant-status.mjs`:

```js
#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAssistantStatus, loadAssistantStatusInputs } from "./lib/assistant-status.mjs";
import { resolveOpenClawConfigPath, resolveOpenClawStateDir } from "./lib/commands.mjs";
import { projectPath } from "./lib/config.mjs";
import { mergedEnv } from "./lib/env.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");

export function parseAssistantStatusArgs(argv) {
  const options = {
    json: false,
    recentHours: 24,
    includeLogs: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--include-logs") {
      options.includeLogs = true;
      continue;
    }
    if (arg === "--recent-hours") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 168) {
        throw new Error("--recent-hours requires an integer from 1 to 168.");
      }
      options.recentHours = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown assistant status option: ${arg}`);
  }

  return options;
}

export async function runAssistantStatusCli(
  argv,
  {
    root = projectRoot,
    env = mergedEnv(projectPath(root, ".env")),
    configPath = resolveOpenClawConfigPath(env, root),
    stateDir = resolveOpenClawStateDir(env, root),
    loadInputs = () => loadAssistantStatusInputs({ env, projectRoot: root, configPath, stateDir }),
    now = new Date(),
  } = {},
) {
  const options = parseAssistantStatusArgs(argv);
  return buildAssistantStatus({
    ...loadInputs(),
    now,
    recentHours: options.recentHours,
    includeLogs: options.includeLogs,
  });
}

export function formatAssistantStatus(status) {
  const enabledRoutines = status.automation.routines
    .filter((routine) => routine.enabled)
    .map((routine) => `${routine.routineId} enabled`);
  const disabledRoutines = status.automation.routines
    .filter((routine) => !routine.enabled)
    .map((routine) => `${routine.routineId} disabled`);
  const routineText = [...enabledRoutines, ...disabledRoutines].join(", ") || "no assistant routines installed";
  const issueText = status.recentIssues.length === 0
    ? "no blocking recent issues found"
    : `${status.recentIssues.length} recent issue(s): ${status.recentIssues.map((issue) => issue.type).join(", ")}`;

  return [
    `Status: ${status.overall}`,
    `Telegram: ${status.telegram.enabled ? "enabled" : "disabled"}${status.telegram.provider ? ` for ${status.telegram.provider}` : ""}; ${status.telegram.allowFromCount ?? 0} allowlisted user(s).`,
    `Automation: ${status.automation.summary.enabledJobs}/${status.automation.summary.totalJobs} automatic jobs enabled; ${status.automation.summary.dailyRecurringJobs} enabled daily recurring jobs.`,
    `Routines: ${routineText}.`,
    `Recent activity: gateway ready at ${status.recentActivity.gatewayReadyAt ?? "unknown"}; last scheduled run ${status.recentActivity.lastScheduledRunAt ?? "unknown"}.`,
    `Recent issues: ${issueText}.`,
    `Controls: ${status.suggestedActions.map((action) => action.command).join(" | ")}`,
  ].join("\n");
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const argv = process.argv.slice(2);
    const options = parseAssistantStatusArgs(argv);
    const status = await runAssistantStatusCli(argv);
    console.log(options.json ? JSON.stringify(status, null, 2) : formatAssistantStatus(status));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Add the npm script**

Modify `package.json` so the script block includes:

```json
"assistant:status": "node scripts/assistant-status.mjs",
```

Place it near the quiet-ops scripts:

```json
"quiet:reschedule": "node scripts/quiet-ops.mjs reschedule",
"assistant:status": "node scripts/assistant-status.mjs",
"start:openclaw": "node scripts/start-openclaw.mjs",
```

- [ ] **Step 5: Run focused tests to verify GREEN**

Run:

```bash
node --test tests/assistant-status.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Run the real command locally**

Run:

```bash
npm run assistant:status -- --json
npm run assistant:status
```

Expected: both commands exit 0. JSON output must not contain `TELEGRAM_BOT_TOKEN`, the actual bot token, or gateway tokens. Human output should be short enough to paste into Telegram.

- [ ] **Step 7: Commit CLI changes**

Run:

```bash
git add scripts/assistant-status.mjs scripts/lib/assistant-status.mjs tests/assistant-status.test.mjs package.json
git commit -m "feat: add assistant status command"
```

Expected: commit contains the CLI, script entry, library, and tests.

### Task 4: Agent Instructions and Operations Docs

**Files:**
- Modify: `agents/personal/AGENTS.md`
- Modify: `docs/operations/daily-operation.md`
- Generated by command: `.openclaw/workspace-personal/AGENTS.md`

- [ ] **Step 1: Add Personal agent status instructions**

In `agents/personal/AGENTS.md`, insert this section after the "Quiet Ops" section and before "Confirm-before-action":

```md
Status and control:
- Use `npm run assistant:status -- --json` when the user asks whether the assistant is running, what automatic messages are active, why it messaged them, whether it is too noisy, or what can safely be changed.
- Summarize status in Telegram-friendly language: overall state, Telegram state, enabled automatic messages, recent activity, recent issues, and safe next controls.
- Do not paste raw JSON unless the user asks for details.
- Read-only status checks are allowed without extra approval.
- For changes, keep using the existing quiet-ops approval flow with exact job ids or exact job names.
```

- [ ] **Step 2: Update the daily runbook**

In `docs/operations/daily-operation.md`, add this block after the existing `npm run doctor` command:

````md
Check assistant runtime and Telegram automation status:

```bash
npm run assistant:status
npm run assistant:status -- --json
```

Use this before changing schedules or restarting the gateway. The command is read-only and redacts local secrets.
````

- [ ] **Step 3: Render generated OpenClaw workspace files**

Run:

```bash
npm run render:config
```

Expected: exits 0 and copies the updated Personal standing orders to `.openclaw/workspace-personal/AGENTS.md`. Do not commit generated `.openclaw` files.

- [ ] **Step 4: Run focused verification**

Run:

```bash
node --test tests/agent-boundaries.test.mjs tests/assistant-status.test.mjs
```

Expected: PASS. If `agent-boundaries` fails because it expects exact text, update the test assertion to include the new `assistant:status` command and rerun.

- [ ] **Step 5: Commit docs and agent instruction changes**

Run:

```bash
git add agents/personal/AGENTS.md docs/operations/daily-operation.md tests/agent-boundaries.test.mjs
git commit -m "docs: teach agent assistant status flow"
```

Expected: commit includes only source docs, source agent instructions, and any needed test update. It does not include `.openclaw/` generated files.

### Task 5: Full Verification and Live Telegram Smoke Test

**Files:**
- No source files expected after Task 4.

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run environment and gateway checks**

Run:

```bash
npm run validate:env
npm run doctor
npm run assistant:status -- --json
```

Expected: all commands exit 0. `assistant:status -- --json` emits valid JSON with `overall` set to `running`, `degraded`, or `needs_attention`.

- [ ] **Step 3: Verify status output redaction**

Run:

```bash
npm run assistant:status -- --json | rg 'TELEGRAM_BOT_TOKEN|gateway-secret-token|bot[0-9]+:'
```

Expected: no matches. If there is a match, fix redaction before continuing.

- [ ] **Step 4: Verify local human output**

Run:

```bash
npm run assistant:status
```

Expected: a concise multi-line summary with `Status:`, `Telegram:`, `Automation:`, `Routines:`, `Recent activity:`, `Recent issues:`, and `Controls:`.

- [ ] **Step 5: Restart gateway only if source agent instructions changed**

Run:

```bash
launchctl kickstart -k gui/501/ai.openclaw.gateway
```

Expected: gateway restarts cleanly. If launchd is unavailable in the environment, record that manual restart was skipped and verify with `npm run doctor`.

- [ ] **Step 6: Ask Telegram for status**

From Telegram, send:

```text
What is running right now?
```

Expected: the Personal agent calls `npm run assistant:status -- --json` and replies with a concise summary rather than raw JSON.

- [ ] **Step 7: Final commit check**

Run:

```bash
git status --short
git log --oneline -3
```

Expected: only unrelated pre-existing worktree changes remain unstaged. The new assistant-status commits are visible in recent history.
