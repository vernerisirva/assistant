#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTodoistClient } from "./lib/todoist.mjs";
import {
  buildTodoistCreatePlan,
  buildTodoistUpdatePlan,
  formatTodoistTaskPlan,
  normalizeTaskFieldKeys,
} from "./lib/todoist-create.mjs";
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
  let taskJson = null;
  let dryRun = false;
  let text = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--text") {
      text = true;
      continue;
    }

    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }
    index += 1;

    switch (arg) {
      case "--task-json":
        taskJson = parseTaskJson(value);
        break;
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

  const parsed = { command, options: mergeTaskJson(taskJson, options), dryRun };
  if (text) parsed.text = true;

  if (["close", "reopen", "delete", "update"].includes(command) && !parsed.options.taskId) {
    throw new Error("--task-id is required.");
  }

  if (command === "exact-update") {
    if (!parsed.options.taskId && !parsed.options.matchContent) {
      throw new Error("--task-id or --match-content is required.");
    }
    if (!parsed.options.action) {
      throw new Error("--action is required.");
    }
  }

  return parsed;
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
        "npm run todoist -- add --task-json '{\"content\":\"Review AI research updates\",\"description\":\"Goal:\\\\nFind 1-3 updates.\",\"dueString\":\"tomorrow\"}' --dry-run --text",
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
    case "add": {
      const plan = buildTodoistCreatePlan(taskInput(parsed.options));
      const task = await todoist.addTask(plan.payload, { requestId: randomUUID() });
      return { dryRun: false, ...plan, task };
    }
    case "update": {
      const plan = buildTodoistUpdatePlan(parsed.options.taskId, taskInput(parsed.options));
      const task = await todoist.updateTask(plan.taskId, plan.payload, {
        requestId: randomUUID(),
      });
      return { dryRun: false, ...plan, task };
    }
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
  if (parsed.command === "add") {
    const plan = buildTodoistCreatePlan(taskInput(parsed.options));
    return {
      ...plan,
      dryRun: true,
      confirmation: `Dry run only. No Todoist task was created for "${plan.payload.content}".`,
    };
  }

  if (parsed.command === "update") {
    const plan = buildTodoistUpdatePlan(parsed.options.taskId, taskInput(parsed.options));
    return {
      ...plan,
      dryRun: true,
      confirmation: `Dry run only. Todoist task ${plan.taskId} was not changed.`,
    };
  }

  return {
    dryRun: true,
    command: parsed.command,
    target: parsed.options.taskId ?? null,
    payload: null,
    confirmation: `Dry run only. Todoist task ${parsed.options.taskId} was not changed.`,
  };
}

function taskInput(options) {
  const {
    taskId: _taskId,
    filter: _filter,
    matchContent: _matchContent,
    action: _action,
    detail: _detail,
    replacementDescription: _replacementDescription,
    ...input
  } = options;

  return input;
}

function parseTaskJson(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`--task-json must be valid JSON: ${error.message}`);
  }

  return normalizeTaskFieldKeys(parsed);
}

function mergeTaskJson(taskJson, options) {
  if (!taskJson) return options;
  return { ...taskJson, ...options };
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
    const parsed = parseTodoistArgs(process.argv.slice(2));
    const result = await runTodoistCli(process.argv.slice(2));
    const printable = parsed.text && result?.descriptionLines !== undefined;
    console.log(
      printable
        ? formatTodoistTaskPlan(result, { dryRun: Boolean(result.dryRun) })
        : JSON.stringify(result, null, 2),
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
