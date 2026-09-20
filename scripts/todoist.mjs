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
  resolveTodoistProject,
  resolveTodoistSection,
  targetStatuses,
} from "./lib/todoist-targets.mjs";
import {
  describeDuplicateOutcome,
  duplicateStatuses,
  findTodoistDuplicates,
} from "./lib/todoist-duplicates.mjs";
import {
  buildExactTodoistUpdatePlan,
  resolveExactTodoistTask,
} from "./lib/todoist-exact-update.mjs";
import { hasTransportEscapes, normalizeLineEndings } from "./lib/todoist-format.mjs";
import { mergedEnv } from "./lib/env.mjs";
import { projectPath } from "./lib/config.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");

const writeCommands = new Set(["add", "update", "close", "reopen", "delete"]);

export function parseTodoistArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  let taskJson = null;
  let taskJsonStdin = false;
  let dryRun = false;
  let text = false;
  /**
   * A shell argument holding a literal `\n` is ambiguous: it is either multiline
   * text that lost its line breaks in quoting, or a backslash the user wrote,
   * as in `C:\notes`. Guessing would silently rewrite one of the two, so the
   * command stops and points at the structured interface that cannot be
   * ambiguous. Todoist therefore never receives a literal `\n` meant as a break,
   * and never loses a backslash meant literally.
   */
  const fromShellArgument = (flag, value) => {
    if (hasTransportEscapes(value)) {
      throw new Error(
        `${flag} contains a literal \\n. Pass multiline text as JSON on stdin instead: ` +
          "npm run todoist -- add --task-json-stdin <<'JSON' ... JSON",
      );
    }
    return normalizeLineEndings(value);
  };

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
    if (arg === "--task-json-stdin") {
      taskJsonStdin = true;
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
        options.content = fromShellArgument("--content", value);
        break;
      case "--description":
        options.description = fromShellArgument("--description", value);
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
      case "--project":
        options.projectName = value;
        break;
      case "--section":
        options.sectionName = value;
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
        options.detail = fromShellArgument("--detail", value);
        break;
      case "--replacement-description":
        options.replacementDescription = fromShellArgument("--replacement-description", value);
        break;
      case "--label":
        options.labels = [...(options.labels ?? []), value];
        break;
      default:
        throw new Error(`Unknown Todoist option: ${arg}`);
    }
  }

  if (taskJson && taskJsonStdin) {
    throw new Error("Use either --task-json or --task-json-stdin, not both.");
  }

  const parsed = { command, options: mergeTaskJson(taskJson, options), dryRun };

  // A name and a raw id for the same destination contradict each other. Letting
  // one quietly win would preview and create somewhere the caller never
  // unambiguously asked for. Scoping a named section with --project-id is not a
  // conflict and stays supported.
  if (parsed.options.projectName !== undefined && parsed.options.projectId !== undefined) {
    throw new Error("Use either --project or --project-id, not both.");
  }
  if (parsed.options.sectionName !== undefined && parsed.options.sectionId !== undefined) {
    throw new Error("Use either --section or --section-id, not both.");
  }
  if (text) parsed.text = true;
  if (taskJsonStdin) parsed.taskJsonStdin = true;

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
  stdin = process.stdin,
} = {}) {
  const parsed = parseTodoistArgs(argv);

  if (parsed.taskJsonStdin) {
    parsed.options = mergeTaskJson(await readTaskJsonFromStdin(stdin), parsed.options);
  }

  if (parsed.command === "help") {
    return {
      commands: ["projects", "tasks", "add", "update", "exact-update", "close", "reopen", "delete"],
      examples: [
        "npm run todoist -- tasks --filter today",
        "npm run todoist -- add --content \"Buy oats\" --due tomorrow --dry-run",
        "npm run todoist -- add --content \"Ask about pricing\" --project \"Work\" --section \"Interviews\" --dry-run",
        "npm run todoist -- add --task-json-stdin --dry-run --text <<'JSON'\n{\"content\":\"Review AI research updates\",\"description\":\"Goal:\\nFind 1-3 updates.\"}\nJSON",
        "npm run todoist -- exact-update --task-id TASK_ID --action format-description --dry-run",
      ],
    };
  }

  if (parsed.dryRun && writeCommands.has(parsed.command)) {
    return dryRunResult(parsed, { client, env });
  }

  const todoist = client ?? createTodoistClient({ token: env.TODOIST_API_TOKEN });
  switch (parsed.command) {
    case "projects":
      return todoist.getProjects();
    case "tasks":
      return todoist.getTasks(parsed.options);
    case "add": {
      const resolution = await resolveNamedTarget(todoist, parsed.options);
      if (resolution.status !== targetStatuses.resolved) {
        return targetClarification(
          buildTodoistCreatePlan(taskInput(parsed.options)),
          resolution,
          false,
        );
      }

      const plan = buildTodoistCreatePlan({ ...taskInput(parsed.options), ...resolution.target });
      const duplicateCheck = await checkForDuplicates(todoist, plan);

      if (duplicateCheck.status !== duplicateStatuses.none) {
        return blockedByDuplicates(plan, duplicateCheck, false);
      }

      const task = await todoist.addTask(plan.payload, { requestId: randomUUID() });
      return { dryRun: false, ...plan, duplicateCheck, task };
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

async function dryRunResult(parsed, { client, env } = {}) {
  if (parsed.command === "add") {
    const reader = client ?? tryCreateClient(env);
    let target = {};

    // Names are resolved before the plan is built, so the preview shows the
    // destination the real create would use.
    if (parsed.options.projectName !== undefined || parsed.options.sectionName !== undefined) {
      // A blank name needs no lookup to answer, so it is answered before the
      // access check rather than being blamed on a missing token.
      const blank = blankNamedTarget(parsed.options);
      if (blank) {
        return targetClarification(
          buildTodoistCreatePlan(taskInput(parsed.options)),
          { reason: blank, matches: [] },
          true,
        );
      }

      // Without Todoist access there is nothing to resolve the name against.
      // Dropping it and previewing the task anyway would show it going to the
      // Inbox, which is a destination the user did not ask for and the real
      // create would never pick. A named destination is asked about, never
      // quietly discarded.
      if (!reader) {
        return targetClarification(
          buildTodoistCreatePlan(taskInput(parsed.options)),
          {
            reason:
              `${namedTargetLabel(parsed.options)} cannot be resolved without Todoist access. ` +
              "Set TODOIST_API_TOKEN, or give the destination as --project-id or --section-id.",
            matches: [],
          },
          true,
        );
      }

      const resolution = await resolveNamedTarget(reader, parsed.options);
      if (resolution.status !== targetStatuses.resolved) {
        return targetClarification(
          buildTodoistCreatePlan(taskInput(parsed.options)),
          resolution,
          true,
        );
      }
      target = resolution.target;
    }

    const plan = buildTodoistCreatePlan({ ...taskInput(parsed.options), ...target });

    if (!reader) {
      return {
        ...plan,
        dryRun: true,
        duplicateCheck: { status: duplicateStatuses.unchecked, matches: [] },
        confirmation: `Dry run only. No Todoist task was created for "${plan.payload.content}". Duplicate check not performed in dry-run mode.`,
      };
    }

    const duplicateCheck = await checkForDuplicates(reader, plan);
    if (duplicateCheck.status !== duplicateStatuses.none) {
      return blockedByDuplicates(plan, duplicateCheck, true);
    }

    return {
      ...plan,
      dryRun: true,
      duplicateCheck,
      confirmation: `Dry run only. No Todoist task was created for "${plan.payload.content}". No matching open task was found.`,
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

/**
 * Reads open tasks before any create. A failed read is reported as a failure,
 * never as an absence of duplicates, so uncertainty can never become a silent
 * second copy of a task.
 */
async function checkForDuplicates(client, plan) {
  try {
    const tasks = await client.getTasks({});
    return findTodoistDuplicates(plan.payload, tasks);
  } catch (error) {
    // Covers a failed request and a response that is not a task list. Either
    // way the check produced no evidence, so it is reported as a failure and
    // never as an absence of duplicates.
    return {
      status: duplicateStatuses.readFailed,
      matches: [],
      error: error?.message ?? String(error),
    };
  }
}

/** No task is created, and nothing existing is touched. */
function blockedByDuplicates(plan, duplicateCheck, dryRun) {
  return {
    ...plan,
    dryRun,
    mode: "clarify",
    command: "add",
    task: null,
    duplicateCheck,
    matches: duplicateCheck.matches,
    reason: duplicateCheck.status === duplicateStatuses.readFailed
      ? `Could not check for existing Todoist tasks, so nothing was created: ${duplicateCheck.error}`
      : describeDuplicateOutcome(duplicateCheck),
    confirmation: null,
  };
}

function tryCreateClient(env) {
  try {
    return createTodoistClient({ token: env?.TODOIST_API_TOKEN });
  } catch {
    return null;
  }
}

function taskInput(options) {
  const {
    taskId: _taskId,
    filter: _filter,
    matchContent: _matchContent,
    action: _action,
    detail: _detail,
    replacementDescription: _replacementDescription,
    projectName: _projectName,
    sectionName: _sectionName,
    ...input
  } = options;

  return input;
}

/**
 * Turns a named project or section into ids before anything is created, so the
 * creation plan and the API layer keep dealing in ids only. A name that matches
 * nothing or several things stops here and asks; it is never resolved to the
 * Inbox or to a same-named section in another project.
 */
async function resolveNamedTarget(client, options) {
  // Supplied-but-empty is a destination the user asked for and left blank, not
  // an absent one. Treating it as absent would send the task to the Inbox.
  const wantsProject = options.projectName !== undefined;
  const wantsSection = options.sectionName !== undefined;
  if (!wantsProject && !wantsSection) return { status: targetStatuses.resolved, target: {} };

  const target = {};

  if (wantsProject) {
    const projects = await client.getProjects();
    const resolved = resolveTodoistProject(options.projectName, projects);
    if (resolved.status !== targetStatuses.resolved) return { ...resolved, target: null };
    target.projectId = resolved.projectId;
  }

  if (wantsSection) {
    const projectId = target.projectId ?? options.projectId;
    const sections = await client.getSections(projectId ? { projectId } : {});
    let resolved = resolveTodoistSection(options.sectionName, sections, { projectId });

    // "Say which project it is in" cannot be answered from raw ids, so the
    // project names are read only when that question is the one being asked.
    if (resolved.status !== targetStatuses.resolved && !projectId && resolved.matches.length > 0) {
      resolved = resolveTodoistSection(options.sectionName, sections, {
        projectId,
        projectsById: await projectNamesById(client),
      });
    }

    if (resolved.status !== targetStatuses.resolved) return { ...resolved, target: null };
    target.sectionId = resolved.sectionId;
    if (!target.projectId && !options.projectId) target.projectId = resolved.projectId;
  }

  return { status: targetStatuses.resolved, target };
}

async function projectNamesById(client) {
  const projects = await client.getProjects();
  if (!Array.isArray(projects)) return {};

  return Object.fromEntries(
    projects
      .filter((project) => project && typeof project === "object")
      .map((project) => [project.id, project.name ?? null]),
  );
}

/** Matches the wording resolveTodoistProject/Section use for the same case. */
function blankNamedTarget({ projectName, sectionName } = {}) {
  if (projectName !== undefined && !String(projectName).trim()) return "A project name is required.";
  if (sectionName !== undefined && !String(sectionName).trim()) return "A section name is required.";
  return null;
}

/** Names the destination the user asked for, so a refusal says which one. */
function namedTargetLabel({ projectName, sectionName } = {}) {
  const parts = [];
  if (projectName) parts.push(`project "${String(projectName).trim()}"`);
  if (sectionName) parts.push(`section "${String(sectionName).trim()}"`);
  return `The named ${parts.join(" and ")}`;
}

function targetClarification(plan, resolution, dryRun) {
  return {
    ...plan,
    dryRun,
    mode: "clarify",
    command: "add",
    task: null,
    matches: resolution.matches,
    reason: resolution.reason,
    confirmation: null,
  };
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

/**
 * Structured task input over stdin. This is the shell-safe path: task text is
 * never embedded in a quoted shell argument, so apostrophes, quotes, `$HOME`,
 * `$(...)`, and backticks cannot break or be expanded by the shell. It feeds
 * the same normalization and plan builder as --task-json and the flags.
 */
async function readTaskJsonFromStdin(stream) {
  if (!stream || stream.isTTY) {
    throw new Error(
      "--task-json-stdin needs a JSON object on stdin. Pipe it in, for example with a quoted heredoc.",
    );
  }

  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();

  if (!raw) {
    throw new Error("--task-json-stdin received empty stdin. Provide a JSON object.");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`--task-json-stdin must be valid JSON: ${error.message}`);
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
