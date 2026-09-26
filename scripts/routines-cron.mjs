#!/usr/bin/env node
/**
 * Routine controls.
 *
 * plan, install, status, enable, disable and set-time work on the live
 * OpenClaw Gateway scheduler through scripts/lib/live-cron.mjs. A change is
 * live as soon as the command returns; no Gateway restart is needed.
 *
 * skips, skip and unskip use the local skip store, which each routine prompt
 * reads when it runs.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRoutineCronJobs,
  cronExpressionWithTime,
  findRoutineJob,
  parseTime,
  planRoutineInstall,
  publicRoutineJob,
  routineCronStatus,
} from "./lib/routine-cron.mjs";
import {
  LIVE_CRON_RESTART_REQUIRED,
  LIVE_CRON_SOURCE,
  changedJobs,
  createGatewayCron,
  createSecretRedactor,
  executeJobChange,
  maskCronCommandForDisplay,
  planCronExpressionChange,
  planEnabledChange,
  publicCronJob,
} from "./lib/live-cron.mjs";
import {
  addRoutineSkip,
  readRoutineSkipStore,
  removeRoutineSkip,
  resolveRoutineSkipStorePath,
  routineSkipStatus,
  writeRoutineSkipStoreFile,
} from "./lib/routine-skips.mjs";
import { resolveOpenClawStateDir } from "./lib/commands.mjs";
import { projectPath, readJson } from "./lib/config.mjs";
import { mergedEnv } from "./lib/env.mjs";
import { routineIds } from "./lib/routine.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");

export function parseRoutineCronArgs(argv) {
  const [command = "plan", ...rest] = argv;
  const options = {};
  const operands = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown routines cron option: ${arg}`);
        operands.push(arg);
        break;
    }
  }

  if (!["plan", "install", "status", "enable", "disable", "set-time", "skips", "skip", "unskip"].includes(command)) {
    throw new Error(`Unknown routines cron command: ${command}`);
  }

  switch (command) {
    case "plan":
    case "install":
    case "status":
    case "skips":
      if (operands.length > 0) {
        throw new Error(`${command} accepts no operands.`);
      }
      break;
    case "enable":
    case "disable":
      if (operands.length !== 1) throw new Error(`${command} accepts exactly one routine id.`);
      options.routineId = operands[0];
      break;
    case "set-time":
      if (operands.length !== 2) {
        throw new Error("set-time accepts exactly a routine id and HH:mm time.");
      }
      options.routineId = operands[0];
      options.time = operands[1];
      break;
    case "skip":
    case "unskip":
      if (operands.length !== 2) {
        throw new Error(`${command} accepts exactly a routine id and YYYY-MM-DD date.`);
      }
      options.routineId = operands[0];
      options.date = operands[1];
      break;
  }

  return { command, options };
}

export async function runRoutineCronCli(
  argv,
  {
    root = projectRoot,
    env = mergedEnv(projectPath(root, ".env")),
    schedules = readJson(projectPath(root, "config/schedules.json")),
    cron,
    runOpenClaw,
    stateDir = resolveOpenClawStateDir(env, root),
    skipStorePath = resolveRoutineSkipStorePath(stateDir),
    readSkipStoreForStatus = () => readRoutineSkipStore(skipStorePath, { strict: false }),
    readSkipStoreForMutation = () => readRoutineSkipStore(skipStorePath, { strict: true }),
    writeSkipStore = (store) => writeRoutineSkipStoreFile(skipStorePath, store),
    now = new Date(),
  } = {},
) {
  const parsed = parseRoutineCronArgs(argv);
  const configuredRoutineIds = routineIds(schedules);
  let cronCache;
  const liveCron = () => {
    cronCache ??= cron ?? createGatewayCron({ root, env, runOpenClaw });
    return cronCache;
  };

  if (parsed.command === "skips") {
    return routineSkipStatus(readSkipStoreForStatus(), {
      routineIds: configuredRoutineIds,
      now,
      timezone: schedules.timezone,
    });
  }

  if (parsed.command === "skip") {
    const update = addRoutineSkip(readSkipStoreForMutation(), {
      routineIds: configuredRoutineIds,
      routineId: parsed.options.routineId,
      date: parsed.options.date,
      timezone: schedules.timezone,
      source: "telegram",
      now,
    });
    const result = { ...update.result, action: "skip" };
    if (!parsed.options.dryRun && update.result.added) writeSkipStore(update.store);
    return { dryRun: parsed.options.dryRun === true, restartRequired: false, result };
  }

  if (parsed.command === "unskip") {
    const update = removeRoutineSkip(readSkipStoreForMutation(), {
      routineIds: configuredRoutineIds,
      routineId: parsed.options.routineId,
      date: parsed.options.date,
      timezone: schedules.timezone,
    });
    const result = { ...update.result, action: "unskip" };
    if (!parsed.options.dryRun && update.result.removed) writeSkipStore(update.store);
    return { dryRun: parsed.options.dryRun === true, restartRequired: false, result };
  }

  if (parsed.command === "status") {
    const redact = liveCron().redact ?? ((text) => text);
    const routines = routineCronStatus(await liveCron().list(), {
      skipStore: readSkipStoreForStatus(),
      now,
      timezone: schedules.timezone,
    });
    const counts = new Map();
    for (const routine of routines) counts.set(routine.routineId, (counts.get(routine.routineId) ?? 0) + 1);
    return {
      source: LIVE_CRON_SOURCE,
      routines: routines.map((routine) => ({ ...routine, routineId: redact(routine.routineId), name: redact(routine.name) })),
      notInstalled: configuredRoutineIds.filter((routineId) => !counts.has(routineId)),
      duplicates: [...counts].filter(([, count]) => count > 1).map(([routineId]) => redact(routineId)),
    };
  }

  if (["enable", "disable", "set-time"].includes(parsed.command)) {
    return controlRoutine(parsed, liveCron());
  }

  return installRoutines(parsed, {
    cron: liveCron(),
    desired: buildRoutineCronJobs(schedules, { telegramUserId: env.TELEGRAM_USER_ID }),
  });
}

async function controlRoutine(parsed, cron) {
  const { routineId, time } = parsed.options;
  const jobs = await cron.list();
  const job = findRoutineJob(jobs, routineId);
  let plan;
  if (parsed.command === "set-time") {
    if (job.schedule.kind !== "cron") {
      throw new Error(`${job.name} [${job.id}] has schedule kind ${job.schedule.kind}; set-time needs a cron schedule.`);
    }
    plan = planCronExpressionChange(job, cronExpressionWithTime(job.schedule.expr, parseTime(time)));
  } else {
    plan = planEnabledChange(job, parsed.command === "enable");
  }

  const dryRun = parsed.options.dryRun === true;
  const outcome = await executeJobChange(cron, plan, { beforeJobs: jobs, dryRun });
  const redact = cron.redact ?? ((text) => text);
  return {
    source: LIVE_CRON_SOURCE,
    dryRun,
    changed: outcome.changed,
    applied: outcome.applied,
    restartRequired: LIVE_CRON_RESTART_REQUIRED,
    result: {
      action: plan.action,
      routineId,
      jobId: job.id,
      jobName: job.name,
      ...(parsed.command === "set-time" ? { cron: plan.preview.schedule.expr } : {}),
    },
    preview: { before: publicCronJob(outcome.before, { redact }), after: publicCronJob(outcome.after, { redact }) },
    ...(outcome.verification
      ? { verification: { ...outcome.verification, unrelatedJobsChanged: redactNames(outcome.verification.unrelatedJobsChanged, redact) } }
      : {}),
  };
}

function redactNames(jobs, redact) {
  return jobs.map((job) => ({ ...job, name: redact(job.name) }));
}

/**
 * A true upsert against the live Gateway: exact routine names only, one edit
 * or add per routine, then a fresh listing that must show every routine
 * matching config and no other job changed.
 */
async function installRoutines(parsed, { cron, desired }) {
  const beforeJobs = await cron.list();
  const steps = planRoutineInstall(desired, beforeJobs);
  const preview = steps.map((step) => ({
    action: step.action,
    routineId: step.routineId,
    jobName: step.jobName,
    jobId: step.jobId,
    changes: step.changes,
    display: displayStep(step),
  }));

  if (parsed.command === "plan" || parsed.options.dryRun) {
    return {
      source: LIVE_CRON_SOURCE,
      dryRun: parsed.command === "install",
      jobs: desired.map(publicRoutineJob),
      steps: preview,
    };
  }

  const results = [];
  for (const step of steps) {
    if (step.action === "unchanged") {
      results.push({ action: "unchanged", routineId: step.routineId, jobName: step.jobName, jobId: step.jobId });
      continue;
    }
    try {
      const job = step.action === "add" ? await cron.add(step.args) : await cron.edit(step.jobId, step.args);
      results.push({ action: step.action, routineId: step.routineId, jobName: step.jobName, jobId: job.id ?? step.jobId });
    } catch (error) {
      const applied = results.filter((entry) => entry.action !== "unchanged").map((entry) => `${entry.action} ${entry.jobName}`);
      throw new Error(`routines:install stopped at ${step.jobName}: ${error.message} Already applied: ${applied.join(", ") || "nothing"}.`);
    }
  }

  const afterJobs = await cron.list();
  let remaining;
  try {
    remaining = planRoutineInstall(desired, afterJobs).filter((step) => step.action !== "unchanged");
  } catch (error) {
    throw new Error(`routines:install ran, but the Gateway now reports a problem: ${error.message}`);
  }
  if (remaining.length > 0) {
    throw new Error(
      `routines:install ran, but these routine jobs still differ from config: ${remaining
        .map((step) => `${step.jobName} (${step.action === "add" ? "missing" : step.changes.map((change) => change.field).join(", ")})`)
        .join("; ")}.`,
    );
  }
  const routineNames = new Set(desired.map((job) => job.name));
  const unrelated = (jobs) => jobs.filter((job) => !routineNames.has(job.name));

  return {
    source: LIVE_CRON_SOURCE,
    dryRun: false,
    restartRequired: LIVE_CRON_RESTART_REQUIRED,
    results,
    verification: {
      remainingDifferences: [],
      unrelatedJobsChanged: redactNames(changedJobs(unrelated(beforeJobs), unrelated(afterJobs)), cron.redact ?? ((text) => text)),
    },
  };
}

function displayStep(step) {
  if (step.action === "add") return maskCronCommandForDisplay({ command: "openclaw", args: ["cron", "add", ...step.args, "--json"] });
  if (step.action === "edit") return maskCronCommandForDisplay({ command: "openclaw", args: ["cron", "edit", step.jobId, ...step.args] });
  return null;
}

export function formatRoutineCronCliResult(command, result) {
  if (command === "skips") return formatRoutineSkipStatus(result);
  if (command === "skip" || command === "unskip") return formatRoutineSkipMutation(result);
  return JSON.stringify(result, null, 2);
}

function formatRoutineSkipStatus(status) {
  if (!Array.isArray(status) || status.length === 0) return "No routine skip status available.";

  const [{ date, timezone }] = status;
  const lines = [`Routine skips for ${date} (${timezone}):`];
  for (const entry of status) {
    lines.push(`- ${entry.routineId}: ${entry.skippedToday ? "skipped" : "scheduled"}`);
  }
  return lines.join("\n");
}

function formatRoutineSkipMutation({ dryRun = false, result }) {
  const skipped = result.action === "skip";
  const changed = skipped ? result.added : result.removed;
  const restartGuidance = "No gateway restart is required.";

  if (skipped) {
    const action = dryRun && changed ? "Would skip" : changed ? "Skipped" : "Already skipped";
    return `${action} ${result.routineId} on ${result.date} (${result.timezone}). ${restartGuidance}`;
  }

  const action = dryRun && changed ? "Would unskip" : changed ? "Unskipped" : "No skip existed for";
  return `${action} ${result.routineId} on ${result.date} (${result.timezone}). ${restartGuidance}`;
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const argv = process.argv.slice(2);
    const parsed = parseRoutineCronArgs(argv);
    const result = await runRoutineCronCli(argv);
    console.log(
      parsed.options.json ? JSON.stringify(result, null, 2) : formatRoutineCronCliResult(parsed.command, result),
    );
  } catch (error) {
    console.error(createSecretRedactor({ env: mergedEnv(projectPath(projectRoot, ".env")) })(error.message));
    process.exit(1);
  }
}
