#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTodoistClient } from "./lib/todoist.mjs";
import {
  buildExactTodoistUpdatePlan,
  resolveExactTodoistTask,
} from "./lib/todoist-exact-update.mjs";
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
      case "--match-content":
        options.matchContent = value;
        break;
      case "--action":
        options.action = value;
        break;
      case "--detail":
        options.detail = value;
        break;
      case "--replacement-description":
        options.replacementDescription = value;
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

  if (command === "exact-update") {
    if (!options.taskId && !options.matchContent) {
      throw new Error("--task-id or --match-content is required.");
    }
    if (!options.action) {
      throw new Error("--action is required.");
    }
  }

  return { command, options, dryRun };
}

export async function runTodoistCli(argv, {
  env = mergedEnv(projectPath(projectRoot, ".env")),
  client,
} = {}) {
  const parsed = parseTodoistArgs(argv);

  if (parsed.command === "help") {
    return {
      commands: ["projects", "tasks", "add", "update", "exact-update", "close", "reopen", "delete"],
      examples: [
        "npm run todoist -- tasks --filter today",
        "npm run todoist -- add --content \"Buy oats\" --due tomorrow --dry-run",
        "npm run todoist -- exact-update --task-id TASK_ID --action format-description --dry-run",
      ],
    };
  }

  if (parsed.dryRun && writeCommands.has(parsed.command)) {
    return dryRunResult(parsed);
  }

  const todoist = client ?? createTodoistClient({ token: env.TODOIST_API_TOKEN });
  switch (parsed.command) {
    case "projects":
      return todoist.getProjects();
    case "tasks":
      return todoist.getTasks(parsed.options);
    case "add":
      return todoist.addTask(taskInput(parsed.options), { requestId: randomUUID() });
    case "update":
      return todoist.updateTask(parsed.options.taskId, taskInput(parsed.options, false), {
        requestId: randomUUID(),
      });
    case "exact-update":
      return runExactUpdate(todoist, parsed);
    case "close":
      return todoist.closeTask(parsed.options.taskId);
    case "reopen":
      return todoist.reopenTask(parsed.options.taskId);
    case "delete":
      return todoist.deleteTask(parsed.options.taskId);
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
    matchContent: _matchContent,
    action: _action,
    detail: _detail,
    replacementDescription: _replacementDescription,
    ...input
  } = options;

  if (!includeContent && input.content === undefined) {
    delete input.content;
  }

  return input;
}

async function runExactUpdate(client, parsed) {
  const task = parsed.options.taskId
    ? await client.getTask(parsed.options.taskId)
    : null;
  const tasks = task
    ? [task]
    : await client.getTasks({ filter: parsed.options.matchContent });
  const resolution = resolveExactTodoistTask(tasks, {
    taskId: parsed.options.taskId,
    content: parsed.options.matchContent,
  });

  if (resolution.status !== "exact") {
    return resolution;
  }

  const plan = buildExactTodoistUpdatePlan(resolution.task, {
    action: parsed.options.action,
    detail: parsed.options.detail,
    replacementDescription: parsed.options.replacementDescription,
  });

  if (parsed.dryRun || plan.mode !== "execute_then_confirm") {
    return {
      dryRun: parsed.dryRun,
      ...plan,
    };
  }

  if (plan.command === "close") {
    await client.closeTask(plan.taskId);
    return plan;
  }

  if (plan.command === "update") {
    await client.updateTask(plan.taskId, plan.payload, { requestId: randomUUID() });
    return plan;
  }

  return plan;
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
