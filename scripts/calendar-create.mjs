#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  buildCalendarCreationPreview,
  formatCalendarCreationPreview,
} from "./lib/calendar-create.mjs";

const currentFile = fileURLToPath(import.meta.url);

export function parseCalendarCreateArgs(argv) {
  const options = { dryRun: false, json: false };
  const request = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (["--recurring", "--multiple", "--possible-duplicate", "--guests-unclear", "--sensitive-content", "--affects-other-people", "--inferred-substantive-content", "--requires-browser-submission"].includes(arg)) {
      request[flagName(arg)] = true;
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    index += 1;

    if (arg === "--title") request.title = value;
    else if (arg === "--date") request.date = value;
    else if (arg === "--start") request.start = value;
    else if (arg === "--end") request.end = value;
    else if (arg === "--duration") request.duration = value;
    else if (arg === "--timezone") request.timezone = value;
    else if (arg === "--calendar") request.calendar = value;
    else if (arg === "--guest") request.guests = [...(request.guests ?? []), value];
    else if (arg === "--operation") request.operation = value;
    else if (arg === "--source") request.source = value;
    else throw new Error(`Unknown Calendar creation option: ${arg}`);
  }

  return { options, request };
}

export async function runCalendarCreateCli(argv) {
  const parsed = parseCalendarCreateArgs(argv);
  if (!parsed.options.dryRun) {
    throw new Error("Calendar creation v1 is preview-only. Re-run with --dry-run; no Calendar write tool is configured.");
  }
  return buildCalendarCreationPreview(parsed.request);
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const parsed = parseCalendarCreateArgs(process.argv.slice(2));
    const preview = await runCalendarCreateCli(process.argv.slice(2));
    console.log(parsed.options.json ? JSON.stringify(preview, null, 2) : formatCalendarCreationPreview(preview));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

function flagName(flag) {
  return flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
