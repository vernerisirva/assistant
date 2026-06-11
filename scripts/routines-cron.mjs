#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  buildRoutineCronCommands,
  buildRoutineCronJobs,
  routineCronStatus,
  updateRoutineCronEnabled,
  updateRoutineCronTime,
  upsertRoutineCronJobs,
} from "./lib/routine-cron.mjs";
import {
  readExistingCronState,
  readExistingCronStore,
  readJsonIfExists,
  resolveCronStorePath,
  writeCronStoreFile,
} from "./lib/cron-store.mjs";
import {
  addRoutineSkip,
  readRoutineSkipStore,
  removeRoutineSkip,
  resolveRoutineSkipStorePath,
  routineSkipStatus,
  writeRoutineSkipStoreFile,
} from "./lib/routine-skips.mjs";
import { resolveOpenClawCommand, resolveOpenClawConfigPath, resolveOpenClawStateDir } from "./lib/commands.mjs";
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
    config,
    stateDir = resolveOpenClawStateDir(env, root),
    cronStorePath = resolveCronStorePath(stateDir),
    existingCronStore,
    existingCronState,
    existingJobs,
    skipStorePath = resolveRoutineSkipStorePath(stateDir),
    readSkipStoreForStatus = () => readRoutineSkipStore(skipStorePath, { strict: false }),
    readSkipStoreForMutation = () => readRoutineSkipStore(skipStorePath, { strict: true }),
    writeSkipStore = (store) => writeRoutineSkipStoreFile(skipStorePath, store),
    openclawCommand,
    writeCronStore = (store) => writeCronStoreFile(cronStorePath, store),
    now = new Date(),
    nowMs = now.getTime(),
    idGenerator = randomUUID,
  } = {},
) {
  const parsed = parseRoutineCronArgs(argv);
  const configuredRoutineIds = routineIds(schedules);
  let configCache;
  let cronStoreCache;
  let cronStateCache;
  const getConfig = () => {
    configCache ??= config ?? readJsonIfExists(resolveOpenClawConfigPath(env, root));
    return configCache;
  };
  const getCronStore = () => {
    cronStoreCache ??= existingCronStore ?? readExistingCronStore(cronStorePath);
    return cronStoreCache;
  };
  const getCronState = () => {
    cronStateCache ??= existingCronState ?? readExistingCronState(stateDir);
    return cronStateCache;
  };
  const getExistingJobs = () => existingJobs ?? (Array.isArray(getCronStore().jobs) ? getCronStore().jobs : []);
  const getOpenClawCommand = () => openclawCommand ?? resolveOpenClawCommand(env) ?? "openclaw";

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
    return {
      routines: routineCronStatus(getCronStore(), getCronState(), {
        skipStore: readSkipStoreForStatus(),
        now,
        timezone: schedules.timezone,
      }),
    };
  }

  if (parsed.command === "enable" || parsed.command === "disable") {
    const update = updateRoutineCronEnabled(
      getCronStore(),
      parsed.options.routineId,
      parsed.command === "enable",
    );
    writeCronStore(update.store);
    return { restartRequired: true, result: update.result };
  }

  if (parsed.command === "set-time") {
    const update = updateRoutineCronTime(
      getCronStore(),
      parsed.options.routineId,
      parsed.options.time,
    );
    writeCronStore(update.store);
    return { restartRequired: true, result: update.result };
  }

  const jobs = buildRoutineCronJobs(schedules, { telegramUserId: env.TELEGRAM_USER_ID });
  const commands = buildRoutineCronCommands(jobs, {
    existingJobs: getExistingJobs(),
    gatewayToken: gatewayTokenFrom(getConfig()),
    openclawCommand: getOpenClawCommand(),
  });

  if (parsed.command === "plan" || parsed.options.dryRun) {
    return {
      dryRun: parsed.command === "install" && parsed.options.dryRun === true,
      jobs,
      commands: commands.map((command) => ({
        action: command.action,
        jobName: command.jobName,
        routineId: command.routineId,
        display: command.display,
      })),
    };
  }

  const upsert = upsertRoutineCronJobs(getCronStore(), jobs, { nowMs, idGenerator });
  writeCronStore(upsert.store);

  return { dryRun: false, restartRequired: true, jobs, results: upsert.results };
}

function gatewayTokenFrom(config) {
  return config.gateway?.remote?.token ?? config.gateway?.auth?.token;
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
    console.error(error.message);
    process.exit(1);
  }
}
