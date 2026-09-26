#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAssistantStatus,
  loadAssistantStatusInputs,
  redactSensitiveText,
} from "./lib/assistant-status.mjs";
import { createGatewayCron, loadLiveCronSnapshot, LIVE_CRON_SOURCE } from "./lib/live-cron.mjs";
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
    env,
    configPath,
    stateDir,
    loadInputs,
    cron,
    runOpenClaw,
    now = new Date(),
  } = {},
) {
  const options = parseAssistantStatusArgs(argv);
  const inputs = loadInputs
    ? await loadInputs()
    : await loadDefaultInputs({ root, env, configPath, stateDir, cron, runOpenClaw });
  const status = buildAssistantStatus({
    ...inputs,
    now,
    recentHours: options.recentHours,
  });

  if (!options.includeLogs) return status;

  return {
    ...status,
    recentLogs: buildRecentLogLines(inputs, {
      now,
      recentHours: options.recentHours,
      limit: 10,
    }),
  };
}

async function loadDefaultInputs({ root, env, configPath, stateDir, cron, runOpenClaw }) {
  const resolvedEnv = env ?? mergedEnv(projectPath(root, ".env"));
  const resolvedConfigPath = configPath ?? resolveOpenClawConfigPath(resolvedEnv, root);
  const resolvedStateDir = stateDir ?? resolveOpenClawStateDir(resolvedEnv, root);
  const inputs = loadAssistantStatusInputs({
    env: resolvedEnv,
    projectRoot: root,
    configPath: resolvedConfigPath,
    stateDir: resolvedStateDir,
  });
  return { ...inputs, liveCron: await loadLiveCron({ root, env: resolvedEnv, cron, runOpenClaw }) };
}

async function loadLiveCron({ root, env, cron, runOpenClaw }) {
  try {
    return await loadLiveCronSnapshot(cron ?? createGatewayCron({ root, env, runOpenClaw }));
  } catch (error) {
    return { available: false, source: LIVE_CRON_SOURCE, jobs: [], scheduler: null, error: error.message };
  }
}

function buildRecentLogLines(
  {
    env = {},
    config = {},
    gatewayLogText = "",
    gatewayErrLogText = "",
  },
  { now, recentHours, limit },
) {
  const cutoffMs = now.getTime() - recentHours * 60 * 60 * 1000;
  const secrets = collectCliSecrets(env, config);
  const lines = [
    ...tagLogLines("gateway", gatewayLogText),
    ...tagLogLines("gateway-error", gatewayErrLogText),
  ].filter((entry) => isRecentLogLine(entry.line, cutoffMs));

  return lines.slice(-limit).map((entry) => ({
    source: entry.source,
    line: redactSensitiveText(entry.line, secrets),
  }));
}

export function formatAssistantStatus(status) {
  const automation = status.automation ?? {};
  const summary = automation.summary ?? {};
  const routines = automation.routines ?? [];
  const liveUnavailable = automation.available === false;
  const automationText = liveUnavailable
    ? `live Gateway scheduler ${automation.error === "not checked" ? "not checked" : `unavailable (${automation.error})`}`
    : `${summary.enabledJobs ?? 0}/${summary.totalJobs ?? 0} automatic jobs enabled; ` +
      `${summary.dailyRecurringJobs ?? 0} enabled daily recurring jobs (live Gateway scheduler` +
      `${automation.scheduler?.enabled === false ? ", which is disabled" : ""})`;
  const routineText = liveUnavailable
    ? "unknown while the live scheduler is unavailable"
    : routines.length === 0
    ? "no assistant routines installed"
    : routines
      .map((routine) => {
        const state = routine.enabled ? "enabled" : "disabled";
        return `${routine.routineId} ${state}${routine.skippedToday ? ", skipped today" : ""}`;
      })
      .join(", ");
  const issueText = status.recentIssues?.length > 0
    ? `${status.recentIssues.length} recent issue(s): ${status.recentIssues.map((issue) => issue.type).join(", ")}`
    : "no blocking recent issues found";
  const controlText = status.suggestedActions?.length > 0
    ? status.suggestedActions.map((action) => action.command).join(" | ")
    : "npm run doctor";
  const logLines = Array.isArray(status.recentLogs)
    ? [
      status.recentLogs.length > 0
        ? `Recent logs:\n${status.recentLogs.map((entry) => `- ${entry.line}`).join("\n")}`
        : "Recent logs: no recent log lines found.",
    ]
    : [];

  return [
    `Status: ${status.overall}`,
    `Telegram: ${status.telegram?.enabled ? "enabled" : "disabled"}${status.telegram?.provider ? ` for ${status.telegram.provider}` : ""}; ${status.telegram?.allowFromCount ?? 0} allowlisted user(s).`,
    `Automation: ${automationText}.`,
    `Routines: ${routineText}.`,
    `Weekly plan: ${describeWeeklyPlan(status.weeklyPlan)}.`,
    `Recent activity: gateway ready at ${status.recentActivity?.gatewayReadyAt ?? "unknown"}; last scheduled run ${status.recentActivity?.lastScheduledRunAt ?? "unknown"}.`,
    ...describeGatewayLog(status.logs),
    `Recent issues: ${issueText}.`,
    `Controls: ${controlText}`,
    ...logLines,
  ].join("\n");
}

function describeGatewayLog(logs) {
  if (!logs) return [];
  const path = logs.stdoutPath ?? logs.stderrPath;
  return [path ? `Gateway log: ${path} (${logs.source}).` : "Gateway log: not found."];
}

function describeWeeklyPlan(weeklyPlan) {
  const pending = weeklyPlan?.pending ?? [];
  if (pending.length > 0) {
    return pending
      .map((plan) =>
        plan.status === "pending"
          ? `${plan.weekId} pending (v${plan.currentVersion}), applies at ${plan.reviewDeadlineLocal}`
          : `${plan.weekId} ${plan.status} (v${plan.currentVersion})`,
      )
      .join("; ");
  }
  const latest = weeklyPlan?.latest;
  return latest ? `none pending; last ${latest.weekId} ${latest.status}` : "none yet";
}

function tagLogLines(source, text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ source, line }));
}

function isRecentLogLine(line, cutoffMs) {
  const timestamp = /^(\d{4}-\d{2}-\d{2}T\S+)/.exec(line)?.[1];
  if (!timestamp) return true;
  const timestampMs = Date.parse(timestamp);
  return !Number.isFinite(timestampMs) || timestampMs >= cutoffMs;
}

function collectCliSecrets(env, config) {
  const secrets = new Set([
    env.HILLA_TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_BOT_TOKEN,
    env.OPENCLAW_GATEWAY_TOKEN,
    env.GATEWAY_TOKEN,
    /^\d{5,}$/.test(String(env.TELEGRAM_USER_ID ?? "").trim()) ? String(env.TELEGRAM_USER_ID).trim() : null,
  ]);
  collectSecretValues(config, secrets);
  return [...secrets].filter((secret) => typeof secret === "string" && secret.length > 0);
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
