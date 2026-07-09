#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addFeedbackEntry, feedbackTypes, listFeedbackEntries } from "./lib/feedback.mjs";
import { projectPath } from "./lib/config.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");
const defaultFeedbackPath = projectPath(projectRoot, ".openclaw/state/feedback/feedback.jsonl");

export function parseFeedbackArgs(argv) {
  const [command = "help", ...rest] = argv;
  if (!["help", "add", "list"].includes(command)) {
    throw new Error(`Unknown feedback command: ${command}`);
  }

  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }
    index += 1;

    switch (arg) {
      case "--type":
        options.type = value;
        break;
      case "--message":
        options.message = value;
        break;
      default:
        throw new Error(`Unknown feedback option: ${arg}`);
    }
  }

  if (command === "list" && Object.keys(options).length > 0) {
    throw new Error("list does not accept options.");
  }

  if (command === "add") {
    if (!options.type) throw new Error("--type is required.");
    if (!options.message) throw new Error("--message is required.");
  }

  return { command, options };
}

export async function runFeedbackCli(
  argv,
  {
    feedbackPath = defaultFeedbackPath,
    now,
  } = {},
) {
  const parsed = parseFeedbackArgs(argv);

  if (parsed.command === "help") {
    return {
      commands: ["add", "list"],
      types: feedbackTypes,
      examples: [
        'npm run feedback -- add --type useful --message "That was useful"',
        'npm run feedback -- add --type annoying --message "That was annoying"',
        'npm run feedback -- add --type improvement --message "Morning brief was too long"',
        "npm run feedback -- list",
      ],
      safety: "Stores only explicit local feedback. Sensitive feedback is not stored, and feedback is never sent externally or written to memory.",
    };
  }

  if (parsed.command === "list") {
    return { entries: listFeedbackEntries(feedbackPath) };
  }

  return {
    captured: true,
    entry: addFeedbackEntry(feedbackPath, parsed.options, { now }),
  };
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    console.log(JSON.stringify(await runFeedbackCli(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
