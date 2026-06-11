#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditQuietOps,
  describeQuietJob,
  quietOpsStatus,
  updateQuietCronTime,
  updateQuietJobEnabled,
  updateQuietOneShotTime,
} from "./lib/quiet-ops.mjs";
import {
  readExistingCronState,
  readExistingCronStore,
  resolveCronStorePath,
  writeCronStoreFile,
} from "./lib/cron-store.mjs";
import { resolveOpenClawStateDir } from "./lib/commands.mjs";
import { projectPath } from "./lib/config.mjs";
import { mergedEnv } from "./lib/env.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");
const mutationCommands = new Set(["enable", "disable", "set-time", "reschedule"]);

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
    stateDir = resolveOpenClawStateDir(env, root),
    cronStorePath = resolveCronStorePath(stateDir),
    existingCronStore = readExistingCronStore(cronStorePath),
    existingCronState = readExistingCronState(stateDir),
    writeCronStore = (store) => writeCronStoreFile(cronStorePath, store),
    now = new Date(),
    timezone = "Europe/Stockholm",
  } = {},
) {
  const parsed = parseQuietOpsArgs(argv);

  if (parsed.command === "status") {
    return quietOpsStatus(existingCronStore, existingCronState);
  }

  if (parsed.command === "audit") {
    return auditQuietOps(existingCronStore, existingCronState, { now });
  }

  const update = quietOpsMutation(parsed, existingCronStore, { timezone });
  const dryRun = parsed.options.dryRun === true;

  if (!dryRun) {
    writeCronStore(update.store);
  }

  return {
    dryRun,
    restartRequired: !dryRun,
    result: update.result,
    preview: {
      before: describeQuietJob(update.before, existingCronState),
      after: describeQuietJob(update.after, existingCronState),
    },
  };
}

function quietOpsMutation(parsed, existingCronStore, { timezone }) {
  switch (parsed.command) {
    case "enable":
      return updateQuietJobEnabled(existingCronStore, parsed.options.ref, true);
    case "disable":
      return updateQuietJobEnabled(existingCronStore, parsed.options.ref, false);
    case "set-time":
      return updateQuietCronTime(existingCronStore, parsed.options.ref, parsed.options.time);
    case "reschedule":
      return updateQuietOneShotTime(
        existingCronStore,
        parsed.options.ref,
        parsed.options.date,
        parsed.options.time,
        { timezone },
      );
    default:
      throw new Error(`Unsupported quiet-ops mutation: ${parsed.command}`);
  }
}

function formatQuietOpsResult(result, command) {
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
      `${result.summary.dailyRecurringJobs} enabled daily recurring jobs.`,
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
      return `${issue.severity?.toUpperCase() ?? "INFO"} ${issue.type}`;
    })
    .join("\n");
}

function formatQuietOpsMutation(result) {
  const dryRun = result.dryRun ? "DRY RUN " : "";
  const restart = result.restartRequired ? " Restart OpenClaw Gateway for the scheduler to reload." : "";
  return `${dryRun}${result.result.action} ${result.result.jobName} [${result.result.jobId}].${restart}`;
}

function formatSchedule(schedule) {
  if (schedule.kind === "cron") return `cron=${schedule.expr} tz=${schedule.timezone ?? "unknown"}`;
  if (schedule.kind === "at") return `at=${schedule.at}`;
  return `schedule=${schedule.kind}`;
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const argv = process.argv.slice(2);
    const parsed = parseQuietOpsArgs(argv);
    const result = await runQuietOpsCli(argv);
    console.log(parsed.options.json ? JSON.stringify(result, null, 2) : formatQuietOpsResult(result, parsed.command));
    if (mutationCommands.has(parsed.command) && !parsed.options.dryRun) {
      console.log("Restart with: launchctl kickstart -k gui/501/ai.openclaw.gateway");
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
