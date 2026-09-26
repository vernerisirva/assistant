#!/usr/bin/env node
/**
 * Quiet ops against the live OpenClaw Gateway scheduler. status and audit are
 * read-only. enable, disable, set-time and reschedule change exactly one job,
 * named by exact id or exact name, and are live when the command returns.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditQuietOps, describeQuietJob, planQuietOpsChange, quietOpsStatus } from "./lib/quiet-ops.mjs";
import {
  LIVE_CRON_RESTART_REQUIRED,
  LIVE_CRON_SOURCE,
  createGatewayCron,
  createSecretRedactor,
  executeJobChange,
} from "./lib/live-cron.mjs";
import { projectPath } from "./lib/config.mjs";
import { mergedEnv } from "./lib/env.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");

export function parseQuietOpsArgs(argv) {
  const [command = "status", ...rest] = argv;
  if (!["status", "audit", "enable", "disable", "set-time", "reschedule"].includes(command)) {
    throw new Error(`Unknown quiet-ops command: ${command}`);
  }

  const options = {};
  const operands = [];

  for (const arg of rest) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown quiet-ops option: ${arg}`);
    }
    operands.push(arg);
  }

  if (command === "status" || command === "audit") {
    if (operands.length > 0) throw new Error(`${command} does not accept job operands.`);
    return { command, options };
  }

  if (command === "enable" || command === "disable") {
    if (operands.length !== 1) throw new Error(`${command} requires exactly one exact job id or name.`);
    return { command, options: { ...options, ref: operands[0] } };
  }

  if (command === "set-time") {
    if (operands.length !== 2) throw new Error("set-time requires exactly a job ref and HH:mm time.");
    return { command, options: { ...options, ref: operands[0], time: operands[1] } };
  }

  if (operands.length !== 3) {
    throw new Error("reschedule requires exactly a job ref, YYYY-MM-DD date, and HH:mm time.");
  }
  return { command, options: { ...options, ref: operands[0], date: operands[1], time: operands[2] } };
}

export async function runQuietOpsCli(
  argv,
  {
    root = projectRoot,
    env = mergedEnv(projectPath(root, ".env")),
    cron,
    runOpenClaw,
    now = new Date(),
    timezone = "Europe/Stockholm",
  } = {},
) {
  const parsed = parseQuietOpsArgs(argv);
  const liveCron = cron ?? createGatewayCron({ root, env, runOpenClaw });
  const redact = liveCron.redact ?? ((text) => text);
  const jobs = await liveCron.list();

  if (parsed.command === "status") {
    return quietOpsStatus(jobs, { redact });
  }

  if (parsed.command === "audit") {
    return auditQuietOps(jobs, { now, redact });
  }

  const { plan, result } = planQuietOpsChange(jobs, parsed, { timezone });
  const dryRun = parsed.options.dryRun === true;
  const outcome = await executeJobChange(liveCron, plan, { beforeJobs: jobs, dryRun });
  const verification = outcome.verification && {
    ...outcome.verification,
    unrelatedJobsChanged: outcome.verification.unrelatedJobsChanged.map((job) => ({ ...job, name: redact(job.name) })),
  };

  return {
    source: LIVE_CRON_SOURCE,
    dryRun,
    changed: outcome.changed,
    applied: outcome.applied,
    restartRequired: LIVE_CRON_RESTART_REQUIRED,
    result: { ...result, jobName: redact(result.jobName) },
    preview: {
      before: describeQuietJob(outcome.before, { redact }),
      after: describeQuietJob(outcome.after, { redact }),
    },
    ...(verification ? { verification } : {}),
  };
}

export function formatQuietOpsResult(result, command) {
  if (command === "status") return formatQuietOpsStatus(result);
  if (command === "audit") return formatQuietOpsAudit(result);
  return formatQuietOpsMutation(result);
}

function formatQuietOpsStatus(result) {
  const lines = result.jobs.map((job) => {
    const state = job.enabled ? "ENABLED" : "disabled";
    return `${state} ${job.category} ${job.name} [${job.id}] ${formatSchedule(job.schedule)}`;
  });
  lines.push(
    `Summary: ${result.summary.enabledJobs}/${result.summary.totalJobs} enabled, ` +
      `${result.summary.dailyRecurringJobs} enabled daily recurring jobs (live Gateway scheduler).`,
  );
  return lines.join("\n");
}

function formatQuietOpsAudit(result) {
  if (result.issues.length === 0) return "No quiet-ops issues found.";

  return result.issues
    .map((issue) => {
      if (issue.type === "same-time-enabled") {
        return `WARN same-time-enabled ${formatSchedule(issue.schedule)}: ${issue.jobNames.join(" | ")}`;
      }
      if (issue.type === "disabled-installed") {
        return `INFO disabled-installed: ${issue.jobName} [${issue.jobId}]`;
      }
      if (issue.type === "upcoming-one-shot") {
        return `INFO upcoming-one-shot ${issue.at}: ${issue.jobName} [${issue.jobId}]`;
      }
      if (issue.type === "daily-recurring-count") {
        return `INFO daily-recurring-count ${issue.count}: ${issue.jobNames.join(" | ")}`;
      }
      if (issue.type === "unsupported-schedule") {
        return `INFO unsupported-schedule ${formatSchedule(issue.schedule)}: ${issue.jobName} [${issue.jobId}]`;
      }
      return `${issue.severity?.toUpperCase() ?? "INFO"} ${issue.type}`;
    })
    .join("\n");
}

function formatQuietOpsMutation(result) {
  const target = `${result.result.action} ${result.result.jobName} [${result.result.jobId}]`;
  if (!result.changed) return `${target}: already in that state; nothing was changed.`;
  if (result.dryRun) return `DRY RUN ${target}. Nothing was changed.`;

  const notes = [];
  const { unexpectedFields = [], unrelatedJobsChanged = [] } = result.verification ?? {};
  if (unexpectedFields.length > 0) notes.push(`The Gateway also changed: ${unexpectedFields.join(", ")}.`);
  if (unrelatedJobsChanged.length > 0) {
    notes.push(`Other jobs changed meanwhile: ${unrelatedJobsChanged.map((job) => `${job.name} [${job.id}]`).join(", ")}.`);
  }
  const restart = result.restartRequired ? "Restart the Gateway to apply it." : "It is live now; no Gateway restart is needed.";
  return [`${target}. ${restart}`, ...notes].join(" ");
}

function formatSchedule(schedule) {
  if (schedule.kind === "cron") return `cron=${schedule.expr} tz=${schedule.timezone ?? "unknown"}`;
  if (schedule.kind === "at") return `at=${schedule.at}`;
  if (schedule.kind === "every") return `every=${formatInterval(schedule.everyMs)}`;
  return `schedule=${schedule.kind} (not understood by quiet-ops)`;
}

function formatInterval(ms) {
  const units = [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
  ];
  const [unit, size] = units.find(([, unitMs]) => ms % unitMs === 0) ?? ["ms", 1];
  return `${ms / size}${unit}`;
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const argv = process.argv.slice(2);
    const parsed = parseQuietOpsArgs(argv);
    const result = await runQuietOpsCli(argv);
    console.log(parsed.options.json ? JSON.stringify(result, null, 2) : formatQuietOpsResult(result, parsed.command));
  } catch (error) {
    console.error(createSecretRedactor({ env: mergedEnv(projectPath(projectRoot, ".env")) })(error.message));
    process.exit(1);
  }
}
