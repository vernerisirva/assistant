import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { routineCronStatus } from "./routine-cron.mjs";
import { readRoutineSkipStore, resolveRoutineSkipStorePath } from "./routine-skips.mjs";

const defaultCronStore = { version: 1, jobs: [] };
const defaultCronState = { version: 1, jobs: {} };
const defaultSkipStore = { version: 1, skips: [] };

export function buildAssistantStatus({
  env = {},
  config = {},
  cronStore = defaultCronStore,
  cronState = defaultCronState,
  skipStore = defaultSkipStore,
  gatewayLogText = "",
  gatewayErrLogText = "",
  loadIssues = [],
  paths = {},
  exists = existsSync,
  now = new Date(),
  recentHours = 24,
} = {}) {
  const secrets = collectSecrets({ env, config });
  const parsedLogs = parseGatewayLogText([gatewayLogText, gatewayErrLogText].filter(Boolean).join("\n"), {
    now,
    recentHours,
    secrets,
  });
  const stateIssues = [];
  const safeCronState = sanitizeCronState(cronState, stateIssues);
  const telegram = buildTelegramStatus({ env, config, parsedLogs });
  const checks = buildChecks({ env, config, paths, exists, parsedLogs, telegram });
  const checkIssues = checks
    .filter((check) => check.status === "fail")
    .map((check) => ({
      severity: "error",
      type: "check-failed",
      checkId: check.id,
      message: check.message,
    }));
  const recentIssues = [...checkIssues, ...loadIssues, ...stateIssues, ...parsedLogs.issues].map((issue) =>
    redactIssue(issue, secrets),
  );
  const hasFail = checks.some((check) => check.status === "fail");
  const hasWarnOrError = recentIssues.some((issue) => ["warn", "error"].includes(issue.severity));

  return {
    overall: hasFail ? "needs_attention" : hasWarnOrError ? "degraded" : "running",
    checks,
    telegram,
    automation: {
      summary: buildAutomationSummary(cronStore),
      jobs: buildAutomationJobs(cronStore, safeCronState, secrets),
      routines: routineCronStatus(cronStore, safeCronState, {
        skipStore,
        now,
        timezone: "Europe/Stockholm",
      }),
    },
    recentActivity: {
      gatewayReadyAt: parsedLogs.gatewayReadyAt,
      telegramProviderStartedAt: parsedLogs.telegramProviderStartedAt,
      lastInboundTelegramAt: parsedLogs.lastInboundTelegramAt,
      lastScheduledRunAt: lastScheduledRunAt(safeCronState),
    },
    recentIssues,
    suggestedActions: buildSuggestedActions(),
  };
}

export function loadAssistantStatusInputs({
  env = process.env,
  projectRoot = process.cwd(),
  configPath,
  stateDir,
} = {}) {
  const resolvedConfigPath = configPath ?? join(projectRoot, ".openclaw", "openclaw.json");
  const resolvedStateDir = stateDir ?? join(projectRoot, ".openclaw", "state");
  const skipStorePath = resolveRoutineSkipStorePath(resolvedStateDir);
  const loadIssues = [];
  const config = readJsonFile(resolvedConfigPath, {}, loadIssues);
  const cronStore = normalizeCronStore(
    readJsonFile(join(resolvedStateDir, "cron", "jobs.json"), defaultCronStore, loadIssues),
  );
  const cronState = normalizeCronState(
    readJsonFile(join(resolvedStateDir, "cron", "jobs-state.json"), defaultCronState, loadIssues),
  );
  const skipStore = readRoutineSkipStore(skipStorePath, { issues: loadIssues, strict: false });

  return {
    env,
    config,
    cronStore,
    cronState,
    skipStore,
    gatewayLogText: readTextFile(join(resolvedStateDir, "logs", "gateway.log")),
    gatewayErrLogText: readTextFile(join(resolvedStateDir, "logs", "gateway.err.log")),
    loadIssues,
    paths: {
      projectRoot,
      configPath: resolvedConfigPath,
      stateDir: resolvedStateDir,
      telegramDir: join(resolvedStateDir, "telegram"),
      skipStorePath,
    },
    exists: existsSync,
  };
}

export function parseGatewayLogText(text = "", { now = new Date(), recentHours = 24, secrets = [] } = {}) {
  const cutoffMs = now.getTime() - recentHours * 60 * 60 * 1000;
  const result = {
    gatewayReadyAt: null,
    telegramProviderStartedAt: null,
    telegramProvider: null,
    lastInboundTelegramAt: null,
    issues: [],
  };
  const issueCandidates = [];

  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.includes("[skills] Skipping escaped skill path outside its configured root")) continue;

    const timestamp = leadingTimestamp(line);
    if (!timestamp) continue;
    const timestampMs = timestamp ? Date.parse(timestamp) : NaN;
    if (Number.isFinite(timestampMs) && timestampMs < cutoffMs) continue;

    if (line.includes("[gateway] ready")) {
      result.gatewayReadyAt = timestamp ?? result.gatewayReadyAt;
    }

    const providerMatch = line.match(/\[telegram\].*starting provider\s+\(([^)]+)\)/i);
    if (providerMatch) {
      result.telegramProviderStartedAt = timestamp ?? result.telegramProviderStartedAt;
      result.telegramProvider = providerMatch[1];
    }

    if (isInboundTelegramLine(line)) {
      result.lastInboundTelegramAt = timestamp ?? result.lastInboundTelegramAt;
    }

    if (line.includes("[fetch-timeout]")) {
      issueCandidates.push({
        severity: "warn",
        type: "fetch-timeout",
        at: timestamp,
        message: redactSensitiveText(line, secrets),
      });
      continue;
    }

    if (/\b(error|fatal)\b/i.test(line)) {
      issueCandidates.push({
        severity: "warn",
        type: "log-error",
        at: timestamp,
        message: redactSensitiveText(line, secrets),
      });
    }
  }

  result.issues = filterIssuesSinceLatestGatewayReady(issueCandidates, result.gatewayReadyAt);
  return result;
}

export function redactSensitiveText(text = "", secrets = []) {
  let redacted = String(text);
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(String(secret)).join("<redacted>");
  }
  redacted = redacted.replace(
    /(https:\/\/api\.telegram\.org\/bot)([^/\s]+)(\/[^\s]*)?/gi,
    (_, prefix, token, suffix = "") => `${prefix}${token ? "<redacted>" : ""}${suffix}`,
  );
  return redacted;
}

function buildChecks({ env, config, paths, exists, parsedLogs, telegram }) {
  const telegramConfig = config?.channels?.telegram;
  const hasTelegramEnv = hasConfiguredSecret(env.TELEGRAM_BOT_TOKEN) && hasConfiguredValue(env.TELEGRAM_USER_ID);
  return [
    pathCheck("config-file", paths.configPath, exists, "fail", "OpenClaw config file is missing."),
    pathCheck("state-dir", paths.stateDir, exists, "fail", "OpenClaw state directory is missing."),
    pathCheck("telegram-dir", paths.telegramDir, exists, "warn", "Telegram state directory is missing."),
    {
      id: "telegram-env",
      status: hasTelegramEnv ? "ok" : "fail",
      message: hasTelegramEnv
        ? "Telegram environment is configured."
        : "Telegram bot token and user id are required.",
    },
    {
      id: "telegram-config",
      status: telegramConfig?.enabled === true && telegram.defaultAccount ? "ok" : "fail",
      message: telegramConfig?.enabled === true && telegram.defaultAccount
        ? "Telegram config is enabled."
        : "Telegram channel config is missing or disabled.",
    },
    {
      id: "gateway-ready-log",
      status: parsedLogs.gatewayReadyAt ? "ok" : "warn",
      message: parsedLogs.gatewayReadyAt ? "Gateway ready log found." : "No recent gateway ready log was found.",
    },
  ];
}

function pathCheck(id, path, exists, missingStatus, missingMessage) {
  const present = path ? exists(path) : false;
  return {
    id,
    status: present ? "ok" : missingStatus,
    message: present ? `${id} is present.` : missingMessage,
  };
}

function buildTelegramStatus({ env, config, parsedLogs }) {
  const telegramConfig = config?.channels?.telegram ?? {};
  const defaultAccount = telegramConfig.defaultAccount ?? Object.keys(telegramConfig.accounts ?? {})[0] ?? null;
  const account = defaultAccount ? telegramConfig.accounts?.[defaultAccount] ?? {} : {};
  const allowFrom = Array.isArray(account.allowFrom) ? account.allowFrom : telegramConfig.allowFrom;

  return {
    enabled: telegramConfig.enabled === true,
    defaultAccount,
    provider: parsedLogs.telegramProvider,
    providerStartedAt: parsedLogs.telegramProviderStartedAt,
    allowFromCount: Array.isArray(allowFrom) ? allowFrom.length : 0,
    botTokenConfigured: hasConfiguredSecret(env.TELEGRAM_BOT_TOKEN) || hasConfiguredSecret(account.botToken),
    execApprovalsEnabled: account.execApprovals?.enabled === true,
  };
}

function buildAutomationSummary(cronStore) {
  const jobs = Array.isArray(cronStore?.jobs) ? cronStore.jobs : [];
  const enabledJobs = jobs.filter((job) => job.enabled !== false).length;
  const cronJobs = jobs.filter((job) => job.schedule?.kind === "cron").length;
  const oneTimeJobs = jobs.filter((job) => job.schedule?.kind === "at").length;
  return {
    totalJobs: jobs.length,
    enabledJobs,
    disabledJobs: jobs.length - enabledJobs,
    cronJobs,
    oneTimeJobs,
    dailyRecurringJobs: jobs.filter((job) => isDailyCron(job.schedule)).length,
  };
}

function buildAutomationJobs(cronStore, cronState, secrets) {
  const jobs = Array.isArray(cronStore?.jobs) ? cronStore.jobs : [];
  return jobs.map((job) => {
    const state = cronState?.jobs?.[job.id]?.state ?? {};
    return {
      id: redactSensitiveText(job.id ?? "", secrets),
      name: redactSensitiveText(job.name ?? "", secrets),
      agentId: job.agentId ?? null,
      enabled: job.enabled !== false,
      schedule: summarizeSchedule(job.schedule),
      nextRunAt: isoFromTimestampMs(state.nextRunAtMs),
      lastRunAt: isoFromTimestampMs(state.lastRunAtMs),
      lastStatus: state.lastStatus ?? null,
    };
  });
}

function summarizeSchedule(schedule = {}) {
  if (schedule.kind === "cron") {
    return {
      kind: "cron",
      expr: schedule.expr,
      timezone: schedule.tz,
    };
  }
  if (schedule.kind === "at") {
    return {
      kind: "at",
      at: schedule.at,
    };
  }
  return { kind: schedule.kind ?? "unknown" };
}

function isDailyCron(schedule = {}) {
  if (schedule.kind !== "cron" || typeof schedule.expr !== "string") return false;
  const parts = schedule.expr.trim().split(/\s+/);
  return (
    parts.length === 5 &&
    parts[0] !== "*" &&
    parts[1] !== "*" &&
    parts[2] === "*" &&
    parts[3] === "*" &&
    parts[4] === "*"
  );
}

function lastScheduledRunAt(cronState) {
  const lastRunMs = Object.values(cronState?.jobs ?? {})
    .map((job) => job?.state?.lastRunAtMs)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];
  return lastRunMs ? new Date(lastRunMs).toISOString() : null;
}

function sanitizeCronState(cronState, issues) {
  const jobs = {};
  for (const [jobId, entry] of Object.entries(cronState?.jobs ?? {})) {
    const state = { ...(entry?.state ?? {}) };
    for (const key of ["nextRunAtMs", "lastRunAtMs"]) {
      if (state[key] === undefined || state[key] === null) continue;
      const normalized = timestampMs(state[key]);
      if (normalized === null) {
        delete state[key];
        issues.push({
          severity: "warn",
          type: "invalid-state-timestamp",
          jobId,
          field: key,
          message: `Ignored invalid cron state timestamp for ${jobId}.${key}.`,
        });
      } else {
        state[key] = normalized;
      }
    }
    jobs[jobId] = { ...entry, state };
  }
  return { version: cronState?.version ?? 1, jobs };
}

function isoFromTimestampMs(value) {
  const normalized = timestampMs(value);
  return normalized === null ? null : new Date(normalized).toISOString();
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && Number.isFinite(new Date(value).getTime())) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && Number.isFinite(new Date(parsed).getTime())) return parsed;
  }
  return null;
}

function buildSuggestedActions() {
  return [
    {
      label: "Check routines",
      command: "npm run routines:status",
    },
    {
      label: "Run doctor",
      command: "npm run doctor",
    },
  ];
}

function readJsonFile(path, fallback, loadIssues) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    loadIssues.push({
      severity: "warn",
      type: "malformed-json",
      path,
      message: redactSensitiveText(error.message),
    });
    return fallback;
  }
}

function readTextFile(path) {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function normalizeCronStore(value) {
  return Array.isArray(value?.jobs) ? { version: value.version ?? 1, jobs: value.jobs } : defaultCronStore;
}

function normalizeCronState(value) {
  return value?.jobs && typeof value.jobs === "object" && !Array.isArray(value.jobs)
    ? { version: value.version ?? 1, jobs: value.jobs }
    : defaultCronState;
}

function leadingTimestamp(line) {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T\S+)/);
  return match?.[1] ?? null;
}

function filterIssuesSinceLatestGatewayReady(issues, gatewayReadyAt) {
  const readyMs = gatewayReadyAt ? Date.parse(gatewayReadyAt) : NaN;
  if (!Number.isFinite(readyMs)) return issues;

  return issues.filter((issue) => {
    const issueMs = Date.parse(issue.at);
    return !Number.isFinite(issueMs) || issueMs >= readyMs;
  });
}

function isInboundTelegramLine(line) {
  return /\[telegram\]/i.test(line) && /\b(inbound|received|message)\b/i.test(line) && /\b(from|chat|user)\b/i.test(line);
}

function redactIssue(issue, secrets) {
  return Object.fromEntries(
    Object.entries(issue).map(([key, value]) => [
      key,
      typeof value === "string" ? redactSensitiveText(value, secrets) : value,
    ]),
  );
}

function collectSecrets({ env, config }) {
  const secrets = new Set([
    env.TELEGRAM_BOT_TOKEN,
    env.OPENCLAW_GATEWAY_TOKEN,
    env.GATEWAY_TOKEN,
  ]);
  collectSecretValues(config, secrets);
  return [...secrets].filter((secret) => typeof secret === "string" && secret.length > 0);
}

function hasConfiguredSecret(value) {
  return hasConfiguredValue(value);
}

function hasConfiguredValue(value) {
  return typeof value === "string" && value.trim().length > 0 && !/^\$\{[^}]+\}$/.test(value.trim());
}

function collectSecretValues(value, secrets, key = "") {
  if (!value || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    const compoundKey = `${key}.${childKey}`.toLowerCase();
    if (typeof childValue === "string" && /(token|secret|password|credential|key)$/.test(compoundKey)) {
      secrets.add(childValue);
    } else if (childValue && typeof childValue === "object") {
      collectSecretValues(childValue, secrets, compoundKey);
    }
  }
}
