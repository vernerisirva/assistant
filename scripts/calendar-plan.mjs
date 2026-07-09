#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatCalendarPlan, planCalendarSnapshot } from "./lib/calendar-plan.mjs";

const currentFile = fileURLToPath(import.meta.url);

export function parseCalendarPlanArgs(argv) {
  const [range = "help", ...rest] = argv;
  if (!["help", "today", "week"].includes(range)) {
    throw new Error("Calendar plan range must be today or week.");
  }

  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    index += 1;
    if (arg === "--events-json") options.eventsJsonPath = value;
    else if (arg === "--date") options.date = value;
    else if (arg === "--timezone") options.timezone = value;
    else throw new Error(`Unknown calendar planning option: ${arg}`);
  }

  if (range !== "help" && !options.eventsJsonPath) {
    throw new Error("--events-json is required. Supply a read-only normalized event snapshot.");
  }
  if (options.date && !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error("--date must use YYYY-MM-DD.");
  }
  return { range, options };
}

export async function runCalendarPlanCli(argv) {
  const parsed = parseCalendarPlanArgs(argv);
  if (parsed.range === "help") {
    return {
      commands: ["today", "week"],
      examples: [
        "npm run calendar:plan -- today --events-json path/to/events.json",
        "npm run calendar:plan -- week --events-json path/to/events.json --date 2026-07-09",
      ],
      safety: "Reads only the supplied normalized event snapshot. It does not fetch, create, edit, delete, invite, RSVP, email, book, or mutate Calendar data.",
    };
  }

  const events = JSON.parse(readFileSync(parsed.options.eventsJsonPath, "utf8"));
  return planCalendarSnapshot(events, {
    range: parsed.range,
    date: parsed.options.date,
    timezone: parsed.options.timezone,
  });
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const parsed = parseCalendarPlanArgs(process.argv.slice(2));
    const result = await runCalendarPlanCli(process.argv.slice(2));
    console.log(parsed.options.json ? JSON.stringify(result, null, 2) : parsed.range === "help" ? JSON.stringify(result, null, 2) : formatCalendarPlan(result));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
