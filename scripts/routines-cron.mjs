#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import { resolveOpenClawCommand, resolveOpenClawConfigPath, resolveOpenClawStateDir } from "./lib/commands.mjs";
import { projectPath, readJson } from "./lib/config.mjs";
import { mergedEnv } from "./lib/env.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");

export function parseRoutineCronArgs(argv) {
  const [command = "plan", ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        if (command === "enable" || command === "disable") {
          if (options.routineId) throw new Error(`${command} accepts exactly one routine id.`);
          options.routineId = arg;
          break;
        }
        if (command === "set-time") {
          if (!options.routineId) {
            options.routineId = arg;
            break;
          }
          if (!options.time) {
            options.time = arg;
            break;
          }
          throw new Error("set-time accepts exactly a routine id and HH:mm time.");
        }
        throw new Error(`Unknown routines cron option: ${arg}`);
    }
  }

  if (!["plan", "install", "status", "enable", "disable", "set-time"].includes(command)) {
    throw new Error(`Unknown routines cron command: ${command}`);
  }

  if ((command === "enable" || command === "disable") && !options.routineId) {
    throw new Error(`${command} requires a routine id.`);
  }

  if (command === "set-time") {
    if (!options.routineId || !options.time) {
      throw new Error("set-time requires a routine id and HH:mm time.");
    }
  }

  return { command, options };
}

export async function runRoutineCronCli(
  argv,
  {
    root = projectRoot,
    env = mergedEnv(projectPath(root, ".env")),
    schedules = readJson(projectPath(root, "config/schedules.json")),
    config = readJsonIfExists(resolveOpenClawConfigPath(env, root)),
    cronStorePath = resolveCronStorePath(resolveOpenClawStateDir(env, root)),
    existingCronStore = readExistingCronStore(cronStorePath),
    existingCronState = readExistingCronState(resolveOpenClawStateDir(env, root)),
    existingJobs = Array.isArray(existingCronStore.jobs) ? existingCronStore.jobs : [],
    openclawCommand = resolveOpenClawCommand(env) ?? "openclaw",
    writeCronStore = (store) => writeCronStoreFile(cronStorePath, store),
    nowMs = Date.now(),
    idGenerator = randomUUID,
  } = {},
) {
  const parsed = parseRoutineCronArgs(argv);

  if (parsed.command === "status") {
    return { routines: routineCronStatus(existingCronStore, existingCronState) };
  }

  if (parsed.command === "enable" || parsed.command === "disable") {
    const update = updateRoutineCronEnabled(
      existingCronStore,
      parsed.options.routineId,
      parsed.command === "enable",
    );
    writeCronStore(update.store);
    return { restartRequired: true, result: update.result };
  }

  if (parsed.command === "set-time") {
    const update = updateRoutineCronTime(
      existingCronStore,
      parsed.options.routineId,
      parsed.options.time,
    );
    writeCronStore(update.store);
    return { restartRequired: true, result: update.result };
  }

  const jobs = buildRoutineCronJobs(schedules, { telegramUserId: env.TELEGRAM_USER_ID });
  const commands = buildRoutineCronCommands(jobs, {
    existingJobs,
    gatewayToken: gatewayTokenFrom(config),
    openclawCommand,
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

  const upsert = upsertRoutineCronJobs(existingCronStore, jobs, { nowMs, idGenerator });
  writeCronStore(upsert.store);

  return { dryRun: false, restartRequired: true, jobs, results: upsert.results };
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolveCronStorePath(stateDir) {
  return join(stateDir, "cron/jobs.json");
}

function readExistingCronStore(jobsPath) {
  if (!existsSync(jobsPath)) return { version: 1, jobs: [] };

  const parsed = JSON.parse(readFileSync(jobsPath, "utf8"));
  if (Array.isArray(parsed.jobs)) return parsed;
  return { version: parsed.version ?? 1, jobs: [] };
}

function readExistingCronState(stateDir) {
  const statePath = join(stateDir, "cron/jobs-state.json");
  if (!existsSync(statePath)) return { version: 1, jobs: {} };

  const parsed = JSON.parse(readFileSync(statePath, "utf8"));
  if (parsed && typeof parsed === "object" && parsed.jobs && typeof parsed.jobs === "object") {
    return parsed;
  }
  return { version: parsed.version ?? 1, jobs: {} };
}

function writeCronStoreFile(jobsPath, store) {
  mkdirSync(dirname(jobsPath), { recursive: true });
  if (existsSync(jobsPath)) {
    copyFileSync(jobsPath, `${jobsPath}.bak`);
  }
  writeFileSync(jobsPath, `${JSON.stringify(store, null, 2)}\n`);
}

function gatewayTokenFrom(config) {
  return config.gateway?.remote?.token ?? config.gateway?.auth?.token;
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const result = await runRoutineCronCli(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
