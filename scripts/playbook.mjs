#!/usr/bin/env node
/**
 * Personal playbook CLI.
 *
 *   guide   the playbook and debrief guide, with the saved playbooks (text)
 *   list    read-only: saved playbooks and coaching settings, optionally for one domain
 *   show    read-only: one playbook by name
 *   save    save a playbook from JSON on stdin, with the user's exact words
 *   update  make one change to one playbook from JSON on stdin, with the user's exact words
 *
 * Playbooks are entries in the existing memory store. The user's words arrive
 * only as JSON through a quoted heredoc, never as shell arguments. Nothing here
 * touches Todoist, Calendar, reminders, or messages.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectPath } from "./lib/config.mjs";
import {
  findPlaybook,
  formatPlaybook,
  formatPlaybookList,
  listCoachingSettings,
  listPlaybooks,
  savePlaybook,
  updatePlaybook,
} from "./lib/playbooks.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");
export const PLAYBOOK_GUIDE_PATH = "agents/personal/guides/playbooks.md";
const COMMANDS = ["guide", "list", "show", "save", "update", "help"];
const OPTIONS_BY_COMMAND = Object.freeze({
  guide: [],
  help: [],
  list: ["--domain"],
  show: ["--name", "--domain"],
  save: ["--json-stdin", "--replace"],
  update: ["--json-stdin"],
});

export function parsePlaybookArgs(argv) {
  const [command = "help", ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new Error(`Unknown playbook command: ${command}`);

  const options = { jsonStdin: false, replace: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!OPTIONS_BY_COMMAND[command].includes(arg)) {
      throw new Error(`${command} does not accept ${arg}.`);
    }
    if (arg === "--json-stdin") {
      options.jsonStdin = true;
      continue;
    }
    if (arg === "--replace") {
      options.replace = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    options[arg.slice(2)] = value;
    index += 1;
  }

  if (command === "show" && !options.name) throw new Error("show requires --name.");
  if (["save", "update"].includes(command) && !options.jsonStdin) {
    throw new Error(`${command} reads the playbook and the user's words as JSON: pass --json-stdin with a quoted heredoc.`);
  }
  return { command, options };
}

export async function runPlaybookCli(
  argv,
  {
    root = projectRoot,
    memoryPath = process.env.ASSISTANT_MEMORY_PATH || projectPath(root, ".openclaw/state/memory/preferences.json"),
    stdin = process.stdin,
    now,
    idGenerator,
  } = {},
) {
  const { command, options } = parsePlaybookArgs(argv);

  switch (command) {
    case "help":
      return {
        commands: COMMANDS.filter((entry) => entry !== "help"),
        examples: [
          "npm run --silent playbook -- guide",
          "npm run --silent playbook -- list --domain golf",
          'npm run --silent playbook -- show --name "bad-shot reset"',
          "npm run --silent playbook -- save --json-stdin <<'JSON'\n{\"replyText\":\"Save that as my bad-shot reset\",\"domain\":\"golf\",\"name\":\"Bad-shot reset\",\"trigger\":\"After a poor shot\",\"steps\":[\"Walk away from the shot\",\"Slow exhale\",\"Say: next shot\"],\"cue\":\"next shot\"}\nJSON",
          "npm run --silent playbook -- update --json-stdin <<'JSON'\n{\"replyText\":\"Change my pre-round cue to commit\",\"name\":\"pre-round routine\",\"change\":{\"setCue\":\"commit\"}}\nJSON",
        ],
        safety:
          "Playbooks are entries in the existing memory store, written only with the user's explicit words. Traits, feelings, judgements, and health details are refused. Nothing touches Todoist, Calendar, reminders, or messages.",
      };
    case "guide":
      return playbookGuide({ root, memoryPath });
    case "list": {
      const playbooks = listPlaybooks(memoryPath, { domain: options.domain });
      const settings = listCoachingSettings(memoryPath, { domain: options.domain });
      return { playbooks, settings, text: formatPlaybookList(playbooks, settings) };
    }
    case "show": {
      const result = findPlaybook(memoryPath, { name: options.name, domain: options.domain });
      return { ...result, text: result.status === "found" ? formatPlaybook(result.playbook) : result.question ?? "No playbook by that name." };
    }
    case "save": {
      const { replyText, ...playbook } = await readJsonObject(stdin);
      const result = savePlaybook(memoryPath, playbook, { replyText, replace: options.replace, now, idGenerator });
      return withText(result);
    }
    case "update": {
      const { replyText, name, domain, change, ...unknown } = await readJsonObject(stdin);
      if (Object.keys(unknown).length > 0) {
        throw new Error(`update reads replyText, name, domain, and change; not ${Object.keys(unknown).join(", ")}.`);
      }
      return withText(updatePlaybook(memoryPath, { name, domain }, change, { replyText, now }));
    }
    default:
      throw new Error(`Unknown playbook command: ${command}`);
  }
}

function withText(result) {
  if (result.status === "saved") return { ...result, text: `Saved ${result.playbook.name} (${result.playbook.domain}).\n${formatPlaybook(result.playbook)}` };
  if (result.status === "updated") return { ...result, text: `Updated ${result.playbook.name}.\n${formatPlaybook(result.playbook)}` };
  if (result.status === "clarify") return { ...result, text: result.question };
  return { ...result, text: `Nothing was saved. ${result.reason}` };
}

/** The guide always prints; an unreadable memory store is reported, never hidden. */
function playbookGuide({ root, memoryPath }) {
  const guide = readFileSync(projectPath(root, PLAYBOOK_GUIDE_PATH), "utf8").trim();
  let saved;
  try {
    saved = formatPlaybookList(listPlaybooks(memoryPath), listCoachingSettings(memoryPath));
  } catch (error) {
    saved = `Saved playbooks could not be read: ${error.message}`;
  }
  return { text: `${saved}\n\n${guide}` };
}

async function readJsonObject(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("--json-stdin needs a JSON object on stdin.");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`The playbook JSON is not valid: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The playbook JSON must be an object.");
  return parsed;
}

export function formatPlaybookCliResult(command, result) {
  return command === "guide" ? result.text : JSON.stringify(result, null, 2);
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const argv = process.argv.slice(2);
    const result = await runPlaybookCli(argv);
    console.log(formatPlaybookCliResult(parsePlaybookArgs(argv).command, result));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
