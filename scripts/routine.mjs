#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRoutineBrief, routineIds } from "./lib/routine.mjs";
import { listMemoryEntries } from "./lib/memory.mjs";
import { projectPath, readJson } from "./lib/config.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");
const defaultMemoryPath = projectPath(projectRoot, ".openclaw/state/memory/preferences.json");

export function parseRoutineArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }
    index += 1;

    switch (arg) {
      case "--date":
        options.date = value;
        break;
      default:
        throw new Error(`Unknown routine option: ${arg}`);
    }
  }

  return { command, options };
}

export async function runRoutineCli(
  argv,
  {
    schedules = readJson(projectPath(projectRoot, "config/schedules.json")),
    food = readJson(projectPath(projectRoot, "config/food-planning.json")),
    memoryEntries,
    memoryPath = process.env.ASSISTANT_MEMORY_PATH || defaultMemoryPath,
    now,
  } = {},
) {
  const parsed = parseRoutineArgs(argv);
  const ids = routineIds(schedules);

  if (parsed.command === "help") {
    return {
      commands: ids,
      examples: [
        "npm run routine -- morning-brief",
        "npm run routine -- midday-check-in",
        "npm run routine -- evening-review",
        "npm run routine -- weekly-review",
      ],
    };
  }

  const routineNow = parsed.options.date
    ? `${parsed.options.date}T00:00:00.000Z`
    : now;

  return buildRoutineBrief(parsed.command, {
    schedules,
    food,
    memoryEntries: memoryEntries ?? listMemoryEntries(memoryPath),
    now: routineNow ?? new Date().toISOString(),
  });
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const result = await runRoutineCli(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
