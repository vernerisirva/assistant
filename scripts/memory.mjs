#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMemoryApprovalPrompt,
  forgetMemoryEntry,
  listMemoryEntries,
  memoryRequiresApproval,
  rememberMemoryEntry,
} from "./lib/memory.mjs";
import { projectPath } from "./lib/config.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");
const defaultMemoryPath = projectPath(projectRoot, ".openclaw/state/memory/preferences.json");

export function parseMemoryArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  let dryRun = false;
  let approved = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--approved") {
      approved = true;
      continue;
    }

    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }
    index += 1;

    switch (arg) {
      case "--category":
        options.category = value;
        break;
      case "--key":
        options.key = value;
        break;
      case "--value":
        options.value = value;
        break;
      case "--sensitivity":
        options.sensitivity = value;
        break;
      case "--source":
        options.source = value;
        break;
      case "--id":
        options.id = value;
        break;
      default:
        throw new Error(`Unknown memory option: ${arg}`);
    }
  }

  if (command === "forget" && !options.id) {
    throw new Error("--id is required.");
  }

  return { command, options, dryRun, approved };
}

export async function runMemoryCli(
  argv,
  {
    memoryPath = process.env.ASSISTANT_MEMORY_PATH || defaultMemoryPath,
    now,
    idGenerator,
  } = {},
) {
  const parsed = parseMemoryArgs(argv);

  if (parsed.command === "help") {
    return {
      commands: ["list", "remember", "forget"],
      examples: [
        'npm run memory -- remember --category food --key breakfast --value "likes Greek yogurt"',
        "npm run memory -- list",
        "npm run memory -- forget --id MEMORY_ID",
      ],
      categories: ["food", "health", "schedule", "tone", "golf", "admin", "general"],
      safety:
        "Low-risk memories can be saved when the user explicitly asks. Sensitive memories require Telegram approval and --approved.",
    };
  }

  if (parsed.command === "list" || parsed.command === "review") {
    return { entries: listMemoryEntries(memoryPath, parsed.options) };
  }

  if (parsed.command === "remember") {
    const approvalRequired = memoryRequiresApproval(parsed.options);
    if (parsed.dryRun) {
      return {
        dryRun: true,
        action: "remember",
        approvalRequired,
        approvalPrompt: approvalRequired ? buildMemoryApprovalPrompt(parsed.options) : null,
        entry: {
          category: parsed.options.category,
          key: parsed.options.key,
          value: parsed.options.value,
          sensitivity: parsed.options.sensitivity ?? "low",
          source: parsed.options.source ?? "manual",
        },
      };
    }
    if (approvalRequired && !parsed.approved) {
      throw new Error("Sensitive memory requires approval. Re-run with --approved after Telegram approval.");
    }
    return {
      remembered: true,
      entry: rememberMemoryEntry(memoryPath, parsed.options, { now, idGenerator }),
    };
  }

  if (parsed.command === "forget") {
    if (parsed.dryRun) {
      return { dryRun: true, action: "forget", target: parsed.options.id };
    }
    return forgetMemoryEntry(memoryPath, parsed.options.id);
  }

  throw new Error(`Unknown memory command: ${parsed.command}`);
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const result = await runMemoryCli(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
