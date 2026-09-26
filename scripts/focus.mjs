#!/usr/bin/env node
/**
 * Focus session CLI.
 *
 *   guide   the focus and next-action guide, with the current status (text)
 *   status  read-only: the running session, if any
 *   start   record a new session (outcome, first action, done-when, ignore)
 *   update  change fields of the running session
 *   end     delete the record
 *
 * The record is local and disposable. It holds task facts only, and nothing
 * here creates Todoist tasks, Calendar events, reminders, or messages.
 *
 * The guide lives in agents/personal/guides/focus.md rather than in the
 * personal agent's standing orders, which must fit Codex's project-doc budget.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawStateDir } from "./lib/commands.mjs";
import { projectPath } from "./lib/config.mjs";
import { mergedEnv } from "./lib/env.mjs";
import {
  endFocusSession,
  formatFocusStatus,
  readFocusSession,
  resolveFocusSessionPath,
  startFocusSession,
  updateFocusSession,
} from "./lib/focus.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");
export const FOCUS_GUIDE_PATH = "agents/personal/guides/focus.md";
const COMMANDS = ["guide", "status", "start", "update", "end", "help"];
const VALUE_FLAGS = Object.freeze({
  "--minutes": "plannedMinutes",
  "--outcome": "outcome",
  "--first-action": "firstAction",
  "--done-when": "definitionOfDone",
  "--context": "context",
  "--ignore": "ignore",
});

export function parseFocusArgs(argv) {
  const [command = "help", ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new Error(`Unknown focus command: ${command}`);

  const fields = {};
  let replace = false;
  let jsonStdin = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--replace") {
      replace = true;
      continue;
    }
    if (arg === "--json-stdin") {
      jsonStdin = true;
      continue;
    }
    if (!VALUE_FLAGS[arg]) throw new Error(`Unknown focus option: ${arg}`);

    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    fields[VALUE_FLAGS[arg]] = value;
    index += 1;
  }

  if (["guide", "status", "end", "help"].includes(command) && (Object.keys(fields).length > 0 || replace || jsonStdin)) {
    throw new Error(`${command} does not accept options.`);
  }
  if (command === "update" && replace) throw new Error("update does not accept --replace.");
  if (jsonStdin && Object.keys(fields).length > 0) throw new Error("Use either --json-stdin or field flags, not both.");
  if (command === "start" && !jsonStdin) {
    for (const [flag, field] of [["--minutes", "plannedMinutes"], ["--outcome", "outcome"], ["--first-action", "firstAction"], ["--done-when", "definitionOfDone"]]) {
      if (fields[field] === undefined) throw new Error(`start requires ${flag}.`);
    }
  }
  return { command, fields, replace, jsonStdin };
}

/**
 * Task text from the user arrives as JSON on stdin through a quoted heredoc, so
 * it never enters a shell argument: quotes, backticks, and `$` stay literal.
 */
async function readJsonFields(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("--json-stdin needs a JSON object on stdin.");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`The focus session JSON is not valid: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The focus session JSON must be an object.");
  }
  return parsed;
}

export async function runFocusCli(argv, { root = projectRoot, env, stateDir, now = new Date(), stdin = process.stdin } = {}) {
  const parsed = parseFocusArgs(argv);
  if (parsed.command === "help") {
    return {
      commands: COMMANDS.filter((command) => command !== "help"),
      examples: [
        "npm run --silent focus -- guide",
        "npm run --silent focus -- status",
        "npm run --silent focus -- start --json-stdin <<'JSON'\n{\"plannedMinutes\":45,\"context\":\"thesis\",\"outcome\":\"Verify the final benchmark packet\",\"firstAction\":\"Run the frozen validation script\",\"definitionOfDone\":\"Validation passes, or the first concrete blocker is documented\",\"ignore\":\"Anything unrelated to benchmark verification\"}\nJSON",
        "npm run --silent focus -- update --json-stdin <<'JSON'\n{\"plannedMinutes\":60}\nJSON",
        "npm run --silent focus -- end",
      ],
      safety:
        "Local, disposable conversation state with task facts only. It never creates Todoist tasks, Calendar events, reminders, or messages, and nothing is scheduled.",
    };
  }

  const resolvedEnv = env ?? mergedEnv(projectPath(root, ".env"));
  const path = resolveFocusSessionPath(stateDir ?? resolveOpenClawStateDir(resolvedEnv, root));
  const timezone = resolvedEnv.ASSISTANT_TIMEZONE || "Europe/Stockholm";
  const withText = (state) => ({ ...state, text: formatFocusStatus(state, { timezone }) });

  switch (parsed.command) {
    case "guide":
      return focusGuide({ root, path, now, timezone });
    case "status":
      return withText(readFocusSession(path, { now }));
    case "start": {
      const fields = parsed.jsonStdin ? await readJsonFields(stdin) : parsed.fields;
      return withText(startFocusSession(path, fields, { now, replace: parsed.replace }));
    }
    case "update": {
      const fields = parsed.jsonStdin ? await readJsonFields(stdin) : parsed.fields;
      return withText(updateFocusSession(path, fields, { now }));
    }
    case "end": {
      const result = endFocusSession(path, { now });
      return {
        ...result,
        text: result.ended ? "Focus session ended and cleared." : "No focus session was running.",
      };
    }
    default:
      throw new Error(`Unknown focus command: ${parsed.command}`);
  }
}

/** The guide always prints; an unreadable record is reported, never hidden. */
function focusGuide({ root, path, now, timezone }) {
  const guide = readFileSync(projectPath(root, FOCUS_GUIDE_PATH), "utf8").trim();
  let status;
  let statusText;
  try {
    const state = readFocusSession(path, { now });
    status = state.status;
    statusText = formatFocusStatus(state, { timezone });
  } catch (error) {
    status = "unreadable";
    statusText = error.message;
  }
  return { status, text: `Current focus status:\n${statusText}\n\n${guide}` };
}

export function formatFocusCliResult(command, result) {
  return command === "guide" ? result.text : JSON.stringify(result, null, 2);
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const argv = process.argv.slice(2);
    const result = await runFocusCli(argv);
    console.log(formatFocusCliResult(parseFocusArgs(argv).command, result));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
