import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { LIVE_CRON_SOURCE, publicCronJob, summarizeCronJobs } from "./live-cron.mjs";
import { routineCronStatus } from "./routine-cron.mjs";
import { readRoutineSkipStore, resolveRoutineSkipStorePath } from "./routine-skips.mjs";
import { formatLocalDateTime, nextWeekStart } from "./weekly-plan.mjs";
import { createWeeklyPlanStore, summarizeWeeklyPlans } from "./weekly-plan-store.mjs";

const defaultSkipStore = { version: 1, skips: [] };
const DEFAULT_LAUNCHD_LABEL = "ai.openclaw.gateway";

/**
 * `liveCron` is a snapshot from the live Gateway scheduler (see
 * loadLiveCronSnapshot). When it could not be read, automation is reported as
 * unavailable with the reason. Nothing falls back to the retired
 * `.openclaw/state/cron/jobs.json`.
 */
export function buildAssistantStatus({
  env = {},
  config = {},
  liveCron,
  skipStore = defaultSkipStore,
  weeklyPlans = [],
  gatewayLogText = "",
  gatewayErrLogText = "",
  loadIssues = [],
  paths = {},
  logSource = null,
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
  const telegram = buildTelegramStatus({ env, config, parsedLogs });
  const checks = [
    ...buildChecks({ env, config, paths, exists, parsedLogs, telegram }),
    ...liveSchedulerChecks(liveCron, secrets),
  ];
  const checkIssues = checks
    .filter((check) => ["fail", "warn"].includes(check.status))
    .map((check) => ({
      severity: check.status === "fail" ? "error" : "warn",
      type: check.status === "fail" ? "check-failed" : "check-warning",
      checkId: check.id,
      message: check.message,
    }));
  const recentIssues = [...checkIssues, ...loadIssues, ...liveCronIssues(liveCron), ...parsedLogs.issues].map((issue) =>
    redactIssue(issue, secrets),
  );
  const hasFail = checks.some((check) => check.status === "fail");
  const hasWarnOrError = recentIssues.some((issue) => ["warn", "error"].includes(issue.severity));

  return {
    overall: hasFail ? "needs_attention" : hasWarnOrError ? "degraded" : "running",
    checks,
    telegram,
    automation: buildAutomation(liveCron, { skipStore, now, secrets }),
    weeklyPlan: buildWeeklyPlanStatus(weeklyPlans, now),
    recentActivity: {
      gatewayReadyAt: parsedLogs.gatewayReadyAt,
      telegramProviderStartedAt: parsedLogs.telegramProviderStartedAt,
      lastInboundTelegramAt: parsedLogs.lastInboundTelegramAt,
      lastScheduledRunAt: lastScheduledRunAt(liveCron),
    },
    recentIssues,
    logs: logSource
      ? {
          source: logSource.source ?? null,
          stdoutPath: logSource.stdoutPath ?? null,
          stderrPath: logSource.stderrPath ?? null,
          checked: logSource.checked ?? [],
        }
      : null,
    suggestedActions: buildSuggestedActions(),
  };
}

export function loadAssistantStatusInputs({
  env = process.env,
  projectRoot = process.cwd(),
  configPath,
  stateDir,
  platform = process.platform,
} = {}) {
  const resolvedConfigPath = configPath ?? join(projectRoot, ".openclaw", "openclaw.json");
  const resolvedStateDir = stateDir ?? join(projectRoot, ".openclaw", "state");
  const skipStorePath = resolveRoutineSkipStorePath(resolvedStateDir);
  const logSource = resolveGatewayLogSource({ env, stateDir: resolvedStateDir, platform });
  const loadIssues = [];
  const config = readJsonFile(resolvedConfigPath, {}, loadIssues);
  const skipStore = readRoutineSkipStore(skipStorePath, { issues: loadIssues, strict: false });
  const weeklyPlans = readWeeklyPlans(resolvedStateDir, loadIssues);

  return {
    env,
    config,
    skipStore,
    weeklyPlans,
    gatewayLogText: logSource.stdoutPath ? readTextFile(logSource.stdoutPath) : "",
    gatewayErrLogText: logSource.stderrPath ? readTextFile(logSource.stderrPath) : "",
    logSource,
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

/**
 * Finds the log files the running gateway actually writes, in this order:
 *
 * 1. the installed LaunchAgent's StandardOutPath/StandardErrorPath, which is
 *    the explicit launch configuration (/dev/null is ignored);
 * 2. OpenClaw's own LaunchAgent default, ~/Library/Logs/openclaw/<prefix>.log;
 * 3. the legacy <stateDir>/logs used by the repo's launchd installer, which is
 *    also OpenClaw's default off macOS.
 *
 * The first candidate with an existing file wins. The macOS candidates need
 * env.HOME, so a caller that passes no HOME only looks in the state directory.
 */
function resolveGatewayLogSource({ env = {}, stateDir, platform }) {
  const candidates = [];
  const home = typeof env.HOME === "string" && env.HOME.trim().length > 0 ? env.HOME.trim() : null;
  if (platform === "darwin" && home) {
    const label = env.OPENCLAW_LAUNCHD_LABEL?.trim() || DEFAULT_LAUNCHD_LABEL;
    const launchAgentPaths = readLaunchAgentLogPaths(join(home, "Library", "LaunchAgents", `${label}.plist`));
    if (launchAgentPaths) candidates.push({ source: "launchd", ...launchAgentPaths });
    const prefix = env.OPENCLAW_LOG_PREFIX?.trim() || "gateway";
    const logDir = join(home, "Library", "Logs", "openclaw");
    candidates.push({
      source: "openclaw-default",
      stdoutPath: join(logDir, `${prefix}.log`),
      stderrPath: join(logDir, `${prefix}.err.log`),
    });
  }
  candidates.push({
    source: "legacy",
    stdoutPath: join(stateDir, "logs", "gateway.log"),
    stderrPath: join(stateDir, "logs", "gateway.err.log"),
  });

  const checked = candidates.flatMap((candidate) => [candidate.stdoutPath, candidate.stderrPath].filter(Boolean));
  const found = candidates.find((candidate) =>
    [candidate.stdoutPath, candidate.stderrPath].some((path) => path && existsSync(path)),
  );
  if (!found) return { source: null, stdoutPath: null, stderrPath: null, checked };
  return {
    source: found.source,
    stdoutPath: found.stdoutPath && existsSync(found.stdoutPath) ? found.stdoutPath : null,
    stderrPath: found.stderrPath && existsSync(found.stderrPath) ? found.stderrPath : null,
    checked,
  };
}

function readLaunchAgentLogPaths(plistPath) {
  const plist = readPlistXml(plistPath);
  if (!plist) return null;
  const stdoutPath = plistLogPath(plist, "StandardOutPath");
  const stderrPath = plistLogPath(plist, "StandardErrorPath");
  return stdoutPath || stderrPath ? { stdoutPath, stderrPath } : null;
}

/** launchd accepts binary plists too; macOS plutil converts those to XML. */
function readPlistXml(plistPath) {
  const text = readTextFile(plistPath);
  if (!text.startsWith("bplist")) return text;
  try {
    return execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", plistPath], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/** Reads one string value from an XML plist. */
function plistLogPath(plist, key) {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist);
  const value = match
    ? match[1]
        .trim()
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&amp;", "&")
    : "";
  return isAbsolute(value) && value !== "/dev/null" ? value : null;
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

    // A gateway that is still up logged "ready" at its last start, however long
    // ago that was; hot reloads do not log it again. Only a later shutdown
    // means that start is over.
    if (line.includes("[gateway] ready")) {
      result.gatewayReadyAt = timestamp;
    } else if (isGatewayShutdownLine(line)) {
      result.gatewayReadyAt = null;
      result.telegramProviderStartedAt = null;
      result.telegramProvider = null;
    }

    const providerMatch = line.match(/\[telegram\].*starting provider\s+\(([^)]+)\)/i);
    if (providerMatch) {
      result.telegramProviderStartedAt = timestamp;
      result.telegramProvider = providerMatch[1];
    }

    if (Number.isFinite(timestampMs) && timestampMs < cutoffMs) continue;

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
  const hasTelegramEnv = hasConfiguredSecret(resolveTelegramBotToken(env)) && hasConfiguredValue(env.TELEGRAM_USER_ID);
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
      message: parsedLogs.gatewayReadyAt
        ? "Gateway ready log found."
        : "No gateway start without a later shutdown was found in the gateway log.",
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
    botTokenConfigured: hasConfiguredSecret(resolveTelegramBotToken(env)) || hasConfiguredSecret(account.botToken),
    execApprovalsEnabled: account.execApprovals?.enabled === true,
  };
}

function buildAutomation(liveCron, { skipStore, now, secrets }) {
  if (!liveCron?.available) {
    return {
      source: LIVE_CRON_SOURCE,
      available: false,
      error: liveCron ? redactSensitiveText(liveCron.error ?? "unknown error", secrets) : "not checked",
      scheduler: null,
      summary: null,
      jobs: [],
      routines: [],
    };
  }

  return {
    source: LIVE_CRON_SOURCE,
    available: true,
    error: null,
    scheduler: liveCron.scheduler ?? null,
    summary: summarizeCronJobs(liveCron.jobs),
    jobs: liveCron.jobs.map((job) => publicCronJob(job, { redact: (text) => redactSensitiveText(text, secrets) })),
    routines: routineCronStatus(liveCron.jobs, {
      skipStore,
      now,
      timezone: "Europe/Stockholm",
    }),
  };
}

/** Only a scheduler that was actually queried can pass or warn; a caller that skipped it adds no check. */
function liveSchedulerChecks(liveCron, secrets) {
  if (!liveCron) return [];
  if (!liveCron.available) {
    return [
      {
        id: "live-scheduler",
        status: "warn",
        message: redactSensitiveText(`Live Gateway scheduler could not be read: ${liveCron.error ?? "unknown error"}`, secrets),
      },
    ];
  }
  if (liveCron.schedulerError) {
    return [
      {
        id: "live-scheduler",
        status: "warn",
        message: redactSensitiveText(
          `Live Gateway jobs were read, but the scheduler state could not be: ${liveCron.schedulerError}`,
          secrets,
        ),
      },
    ];
  }
  if (liveCron.scheduler?.enabled === false) {
    return [{ id: "live-scheduler", status: "warn", message: "The Gateway scheduler is disabled, so no cron job will run." }];
  }
  return [{ id: "live-scheduler", status: "ok", message: `Live Gateway scheduler lists ${liveCron.jobs.length} job(s).` }];
}

function liveCronIssues(liveCron) {
  if (!liveCron?.available) return [];
  return liveCron.jobs.flatMap((job) =>
    (job.warnings ?? []).map((warning) => ({
      severity: "warn",
      type: "invalid-state-timestamp",
      jobId: job.id,
      field: warning.replace(/^invalid /, ""),
      message: `Ignored ${warning} reported by the Gateway for ${job.id}.`,
    })),
  );
}

function lastScheduledRunAt(liveCron) {
  if (!liveCron?.available) return null;
  return (
    liveCron.jobs
      .map((job) => job.lastRunAt)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null
  );
}

/** Answers: is a weekly plan pending, when does it apply, which version, was it applied? */
function buildWeeklyPlanStatus(weeklyPlans, now) {
  const summary = summarizeWeeklyPlans(weeklyPlans, { now, currentWeekStart: nextWeekStart(now) });
  const localize = (entry) =>
    entry && {
      ...entry,
      reviewDeadlineLocal: entry.reviewDeadline ? formatLocalDateTime(entry.reviewDeadline) : null,
    };
  return {
    pending: summary.pending.map(localize),
    latest: localize(summary.latest),
    upcomingWeek: localize(summary.upcomingWeek),
  };
}

function readWeeklyPlans(stateDir, loadIssues) {
  try {
    const { plans, issues } = createWeeklyPlanStore({ stateDir }).listPlansWithIssues();
    for (const issue of issues) {
      loadIssues.push({
        severity: "warn",
        type: "weekly-plan-read-failed",
        message: `Weekly plan file ${issue.file} could not be read: ${issue.message}`,
      });
    }
    return plans;
  } catch (error) {
    loadIssues.push({
      severity: "warn",
      type: "weekly-plan-read-failed",
      message: `Weekly plan state could not be read: ${error.message}`,
    });
    return [];
  }
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

function isGatewayShutdownLine(line) {
  return /\[gateway\] received SIG[A-Z]+; shutting down|\[shutdown\] started/.test(line);
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
    env.HILLA_TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_BOT_TOKEN,
    env.OPENCLAW_GATEWAY_TOKEN,
    env.GATEWAY_TOKEN,
    // The user's Telegram id is private too; job names and Gateway errors can carry it.
    /^\d{5,}$/.test(String(env.TELEGRAM_USER_ID ?? "").trim()) ? String(env.TELEGRAM_USER_ID).trim() : null,
  ]);
  collectSecretValues(config, secrets);
  return [...secrets].filter((secret) => typeof secret === "string" && secret.length > 0);
}

/**
 * HILLA_TELEGRAM_BOT_TOKEN is the canonical name. The unprefixed name is still
 * read here so a runtime that has not migrated yet is reported accurately and
 * its token is redacted, but only the canonical name satisfies env validation.
 */
function resolveTelegramBotToken(env) {
  return env.HILLA_TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
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
