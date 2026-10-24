#!/usr/bin/env node
/**
 * Routine briefings.
 *
 * `npm run routine -- ROUTINE_ID` prints the briefing template for a routine
 * the user asked for. A scheduled job adds `--scheduled`: nobody asked for
 * that message, so the template looks only for what needs the user's
 * attention, and the job sends what `--scheduled --findings-json-stdin` prints
 * for its findings, which is NO_REPLY when nothing qualifies.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRoutineBrief, buildRoutineNotice, routineIds } from "./lib/routine.mjs";
import { listMemoryEntries } from "./lib/memory.mjs";
import { projectPath, readJson } from "./lib/config.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");
const defaultMemoryPath = projectPath(projectRoot, ".openclaw/state/memory/preferences.json");
const flags = { "--scheduled": "scheduled", "--findings-json-stdin": "findingsJsonStdin" };

export function parseRoutineArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (flags[arg]) {
      options[flags[arg]] = true;
      continue;
    }

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

  if (options.findingsJsonStdin && !options.scheduled) {
    throw new Error("--findings-json-stdin is only for a scheduled run: add --scheduled.");
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
    stdin = process.stdin,
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
        "npm run --silent routine -- weekly-review --scheduled",
      ],
    };
  }

  const routineNow = parsed.options.date
    ? `${parsed.options.date}T00:00:00.000Z`
    : now;

  if (parsed.options.findingsJsonStdin) {
    return buildRoutineNotice(parsed.command, await readFindings(stdin), {
      schedules,
      now: new Date(routineNow ?? Date.now()),
    });
  }

  return buildRoutineBrief(parsed.command, {
    schedules,
    food,
    memoryEntries: memoryEntries ?? listMemoryEntries(memoryPath),
    now: routineNow ?? new Date().toISOString(),
    scheduled: parsed.options.scheduled === true,
  });
}

async function readFindings(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error('--findings-json-stdin needs JSON on stdin, such as {"items": []}.');
  try {
    return JSON.parse(text);
  } catch (error) {
    // Node's message quotes the input; findings stay out of errors.
    const position = /position (\d+)/.exec(error.message)?.[1];
    throw new Error(`The findings are not valid JSON${position ? ` (at character ${position})` : ""}.`);
  }
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
