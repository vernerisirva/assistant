#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTodoistClient } from "./lib/todoist.mjs";
import { mergedEnv } from "./lib/env.mjs";
import { projectPath } from "./lib/config.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");

const writeCommands = new Set(["add", "update", "close", "reopen", "delete"]);

export function parseTodoistArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  let dryRun = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }
    index += 1;

    switch (arg) {
      case "--filter":
        options.filter = value;
        break;
      case "--content":
        options.content = value;
        break;
      case "--description":
        options.description = value;
        break;
      case "--due":
        options.dueString = value;
        break;
      case "--due-lang":
        options.dueLang = value;
        break;
      case "--priority":
        options.priority = Number(value);
        break;
      case "--project-id":
        options.projectId = value;
        break;
      case "--section-id":
        options.sectionId = value;
        break;
      case "--task-id":
        options.taskId = value;
        break;
      case "--label":
        options.labels = [...(options.labels ?? []), value];
        break;
      default:
        throw new Error(`Unknown Todoist option: ${arg}`);
    }
  }

  if (["close", "reopen", "delete", "update"].includes(command) && !options.taskId) {
    throw new Error("--task-id is required.");
  }

  return { command, options, dryRun };
}

export async function runTodoistCli(argv, { env = mergedEnv(projectPath(projectRoot, ".env")) } = {}) {
  const parsed = parseTodoistArgs(argv);

  if (parsed.command === "help") {
    return {
      commands: ["projects", "tasks", "add", "update", "close", "reopen", "delete"],
      examples: [
        "npm run todoist -- tasks --filter today",
        "npm run todoist -- add --content \"Buy oats\" --due tomorrow --dry-run",
      ],
    };
  }

  if (parsed.dryRun && writeCommands.has(parsed.command)) {
    return dryRunResult(parsed);
  }

  const client = createTodoistClient({ token: env.TODOIST_API_TOKEN });
  switch (parsed.command) {
    case "projects":
      return client.getProjects();
    case "tasks":
      return client.getTasks(parsed.options);
    case "add":
      return client.addTask(taskInput(parsed.options), { requestId: randomUUID() });
    case "update":
      return client.updateTask(parsed.options.taskId, taskInput(parsed.options, false), {
        requestId: randomUUID(),
      });
    case "close":
      return client.closeTask(parsed.options.taskId);
    case "reopen":
      return client.reopenTask(parsed.options.taskId);
    case "delete":
      return client.deleteTask(parsed.options.taskId);
    default:
      throw new Error(`Unknown Todoist command: ${parsed.command}`);
  }
}

function dryRunResult(parsed) {
  return {
    dryRun: true,
    command: parsed.command,
    target: parsed.options.taskId ?? null,
    payload: taskInput(parsed.options, parsed.command === "add"),
  };
}

function taskInput(options, includeContent = true) {
  const {
    taskId: _taskId,
    filter: _filter,
    ...input
  } = options;

  if (!includeContent && input.content === undefined) {
    delete input.content;
  }

  return input;
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const result = await runTodoistCli(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
