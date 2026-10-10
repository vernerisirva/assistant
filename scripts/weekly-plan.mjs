#!/usr/bin/env node
/**
 * Weekly plan CLI.
 *
 *   propose   preview next week's plan, or store and show it (--send or --reply);
 *             with golf on, this first asks the week's golf questions
 *   answer    store the user's golf answers; once complete, build and show the plan
 *   revise    store a new version from structured changes and restart the review window
 *   accept    apply the displayed version now after an explicit OK
 *   cancel    cancel a draft or pending plan; nothing is created
 *   show      print the current version
 *   status    read-only summary: pending? when? which version? applied?
 *   apply-due deterministic deadline check used by the scheduled command job
 *   install   install or update the two scheduled jobs through the Gateway cron CLI
 *   guide     the personal agent's weekly-plan guide, with the current status (text)
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTodoistClient } from "./lib/todoist.mjs";
import { resolveTodoistProject, resolveTodoistSection, targetStatuses } from "./lib/todoist-targets.mjs";
import { resolveOpenClawCommand, resolveOpenClawConfigPath, resolveOpenClawStateDir } from "./lib/commands.mjs";
import { projectPath, readJson } from "./lib/config.mjs";
import { mergedEnv } from "./lib/env.mjs";
import {
  DEFAULT_APPLY_CHECK_MINUTES,
  DEFAULT_REVIEW_WINDOW_HOURS,
  WEEKLY_PLAN_TIMEZONE,
  applyWeeklyPlanChanges,
  buildInitialPlanInputs,
  buildWeeklyPlan,
  computeReviewDeadline,
  digestPlan,
  formatApplySummary,
  formatLocalDateTime,
  formatPlanMessage,
  formatWeekLabel,
  isWeeklyPlanAcceptance,
  nextWeekStart,
  normalizeExistingTasks,
  weekdayIndex,
} from "./lib/weekly-plan.mjs";
import {
  GolfInputError,
  applyGolfChanges,
  emptyGolfInputs,
  formatGolfClarification,
  formatGolfFollowUp,
  formatGolfQuestion,
  golfInputStatus,
  readSavedGolfRoutines,
} from "./lib/golf-week.mjs";
import {
  OPEN_STATUSES,
  addPlanRevision,
  cancelPlan,
  completeAwaitingDocument,
  createAwaitingDocument,
  createPlanDocument,
  createWeeklyPlanStore,
  isPlanDue,
  markPlanDisplayed,
  newPlanId,
  recordGolfAnswer,
  recordGolfQuestion,
  summarizeWeeklyPlans,
  versionEntry,
} from "./lib/weekly-plan-store.mjs";
import { applyWeeklyPlan, createWeeklyPlanTodoistGateway } from "./lib/weekly-plan-apply.mjs";
import { buildWeeklyPlanCronCommands, buildWeeklyPlanCronJobs, weeklyPlanJobStatus } from "./lib/weekly-plan-cron.mjs";
import { localDateInTimeZone } from "./lib/routine-skips.mjs";
import { listMemoryEntries } from "./lib/memory.mjs";
import { DEFAULT_RECIPE_LANGUAGE, RecipeInputError, formatRecipeClarification, localizedMealName, parseRecipeLanguage } from "./lib/recipes.mjs";

const execFileAsync = promisify(execFile);
const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");
const COMMANDS = ["propose", "answer", "revise", "accept", "cancel", "show", "status", "apply-due", "install", "guide", "help"];
export const WEEKLY_PLAN_GUIDE_PATH = "agents/personal/guides/weekly-plan.md";
const TODOIST_UNREADABLE_NOTE = "I couldn't read Todoist just now; duplicates are re-checked before anything is created.";
const GOLF_TOPIC = /\b(golf\w*|rounds?|holes?|practi[cs]\w*|putt\w*|wedges?|range|competitions?|tee times?|lessons?)\b/i;

export function parseWeeklyPlanArgs(argv) {
  const [command = "help", ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new Error(`Unknown weekly-plan command: ${command}`);
  const options = {};
  const valueFlags = {
    "--plan-id": "planId",
    "--expect-version": "expectVersion",
    "--version": "version",
    "--reply-text": "replyText",
    "--reason": "reason",
    "--input-json": "inputJson",
    "--changes-json": "changesJson",
    "--now": "now",
  };
  const booleanFlags = {
    "--send": "send",
    "--reply": "reply",
    "--input-json-stdin": "inputJsonStdin",
    "--changes-json-stdin": "changesJsonStdin",
    "--text": "text",
    "--json": "json",
    "--dry-run": "dryRun",
    "--jobs": "jobs",
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (booleanFlags[arg]) {
      options[booleanFlags[arg]] = true;
      continue;
    }
    if (valueFlags[arg]) {
      const value = rest[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value.`);
      options[valueFlags[arg]] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown weekly-plan option: ${arg}`);
  }

  for (const key of ["expectVersion", "version"]) {
    if (options[key] !== undefined) {
      const number = Number(options[key]);
      if (!Number.isInteger(number) || number < 1) throw new Error(`--${key === "version" ? "version" : "expect-version"} must be a positive integer.`);
      options[key] = number;
    }
  }
  if (options.send && options.reply) throw new Error("Use either --send or --reply, not both.");
  if (options.inputJson && options.inputJsonStdin) throw new Error("Use either --input-json or --input-json-stdin.");
  if (options.changesJson && options.changesJsonStdin) throw new Error("Use either --changes-json or --changes-json-stdin.");
  if (command === "revise" && options.expectVersion === undefined) {
    throw new Error("revise requires --expect-version, the version the user was looking at.");
  }
  if (command === "accept" && (options.version === undefined || options.replyText === undefined)) {
    throw new Error("accept requires --version (the displayed version) and --reply-text (the user's exact reply).");
  }
  if (command === "answer" && !options.inputJson && !options.inputJsonStdin) {
    throw new Error('answer requires --input-json or --input-json-stdin with {"golf": {"replyText": "...", ...}}.');
  }
  if (command === "guide" && rest.length > 0) throw new Error("guide does not accept options.");
  return { command, options };
}

export async function runWeeklyPlanCli(argv, overrides = {}) {
  const parsed = parseWeeklyPlanArgs(argv);
  const context = createContext(overrides);

  switch (parsed.command) {
    case "help":
      return {
        commands: COMMANDS.filter((command) => command !== "help"),
        examples: [
          "npm run --silent weekly-plan -- status",
          "npm run --silent weekly-plan -- propose --send --input-json-stdin <<'JSON'\n{\"days\":{\"wednesday\":\"heavy\"}}\nJSON",
          "npm run --silent weekly-plan -- answer --input-json-stdin <<'JSON'\n{\"golf\":{\"replyText\":\"18 holes Wednesday, focus putting\",\"addRounds\":[{\"day\":\"wednesday\",\"holes\":18}],\"focus\":[\"Putting\"]}}\nJSON",
          "npm run --silent weekly-plan -- revise --expect-version 1 --changes-json '{\"targets\":{\"gym\":3}}'",
          "npm run --silent weekly-plan -- accept --version 2 --reply-text \"OK\"",
          "npm run --silent weekly-plan -- cancel --reason \"Skip this week\"",
        ],
      };
    case "propose":
      return propose(parsed.options, context);
    case "answer":
      return answer(parsed.options, context);
    case "revise":
      return revise(parsed.options, context);
    case "accept":
      return accept(parsed.options, context);
    case "cancel":
      return cancel(parsed.options, context);
    case "show":
      return show(parsed.options, context);
    case "status":
      return status(parsed.options, context);
    case "apply-due":
      return applyDue(parsed.options, context);
    case "install":
      return install(parsed.options, context);
    case "guide":
      return guide(context);
    default:
      throw new Error(`Unknown weekly-plan command: ${parsed.command}`);
  }
}

function createContext({
  root = projectRoot,
  env = mergedEnv(projectPath(root, ".env")),
  stateDir,
  store,
  loadPlanningConfig,
  schedules,
  todoistClient,
  sendMessage,
  runOpenClaw,
  memoryPath,
  now = () => new Date(),
  stdin = process.stdin,
  random,
  sleep,
  retryDelaysMs,
  nodePath = process.execPath,
} = {}) {
  const resolvedStateDir = stateDir ?? resolveOpenClawStateDir(env, root);
  const loadedSchedules = () => schedules ?? readJson(projectPath(root, "config/schedules.json"));
  let planningCache;
  let todoistCache;
  const openclawCommand = () => resolveOpenClawCommand(env);
  // Like the Gateway wrapper: the repo .env values (for example the Telegram
  // bot token the rendered config refers to) plus the project config and state.
  const openclawEnv = () => ({
    ...process.env,
    ...env,
    OPENCLAW_CONFIG_PATH: resolveOpenClawConfigPath(env, root),
    OPENCLAW_STATE_DIR: resolvedStateDir,
  });
  const execOpenClaw =
    runOpenClaw ??
    (async (args, { timeoutMs = 60_000 } = {}) => {
      const { stdout } = await execFileAsync(openclawCommand(), args, {
        cwd: root,
        env: openclawEnv(),
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      return stdout;
    });

  const settings = () => {
    const weeklyPlan = loadedSchedules().weeklyPlan ?? {};
    return {
      timezone: loadedSchedules().timezone ?? WEEKLY_PLAN_TIMEZONE,
      reviewWindowHours: weeklyPlan.reviewWindowHours ?? DEFAULT_REVIEW_WINDOW_HOURS,
      roundMinutes: weeklyPlan.applyCheckEveryMinutes ?? DEFAULT_APPLY_CHECK_MINUTES,
    };
  };

  return {
    root,
    env,
    now: () => {
      const value = now();
      return value instanceof Date ? value : new Date(value);
    },
    stdin,
    random,
    sleep,
    retryDelaysMs,
    nodePath,
    settings,
    schedules: loadedSchedules,
    store: store ?? createWeeklyPlanStore({ stateDir: resolvedStateDir }),
    // Read-only: the golf week quotes a saved cue word and routine names.
    memoryPath: memoryPath ?? (env.ASSISTANT_MEMORY_PATH || projectPath(root, ".openclaw/state/memory/preferences.json")),
    planning: () => {
      planningCache ??= loadPlanningConfig
        ? loadPlanningConfig()
        : {
            config: readJson(projectPath(root, "config/weekly-plan.json")),
            food: readJson(projectPath(root, "config/food-planning.json")),
          };
      return planningCache;
    },
    todoist: () => {
      todoistCache ??= todoistClient ?? createTodoistClient({ token: env.TODOIST_API_TOKEN });
      return todoistCache;
    },
    sendMessage:
      sendMessage ??
      (async (text) => {
        if (!env.TELEGRAM_USER_ID) throw new Error("TELEGRAM_USER_ID is not configured.");
        const stdout = await execOpenClaw([
          "message",
          "send",
          "--channel",
          "telegram",
          "--account",
          "main",
          "--target",
          String(env.TELEGRAM_USER_ID),
          "--message",
          text,
          "--json",
        ]);
        const parsed = parseJsonOutput(stdout);
        return { messageId: parsed?.messageId ?? parsed?.result?.messageId ?? parsed?.id ?? null };
      }),
    execOpenClaw,
    openclawCommand,
  };
}

// ---------------------------------------------------------------------------

async function propose(options, context) {
  const input = (await readJsonOption(options.inputJson, options.inputJsonStdin, context.stdin, "input")) ?? {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("The input must be a JSON object.");
  // Golf answers come only from the user in chat. The scheduled proposal has
  // no user words, so a golf object there is ignored and the questions are asked.
  // For the same reason it cannot add dishes or groceries: those would be
  // top-ups nobody chose.
  const { golf: golfAnswer, ...planInput } = input;
  if (options.send) planInput.food = withoutAdditions(planInput.food);
  const now = context.now();
  const { timezone } = context.settings();
  const weekStart = planInput.weekStart ?? nextWeekStart(now, timezone);
  const thisMonday = mondayOf(localDateInTimeZone(now, timezone));
  if (typeof weekStart !== "string" || weekStart < thisMonday) {
    throw new Error(`weekStart must be a Monday from ${thisMonday} onward.`);
  }

  const store = context.store;
  const plans = store.listPlans();
  const active = plans.filter((plan) => plan.weekStart === weekStart && plan.status !== "cancelled").at(-1);
  if (active) {
    if (active.status === "awaiting_input") {
      if (options.reply && golfAnswer) return answerGolf(active.planId, { golf: golfAnswer }, context);
      // Ask again in chat, or retry a Saturday send that never reached Telegram.
      if (options.reply || (options.send && !active.awaiting?.askedAt)) return askGolf(active.planId, options, context);
    }
    if (active.status === "draft" && (options.send || options.reply)) {
      return display(active.planId, options, context);
    }
    return {
      status: "exists",
      planId: active.planId,
      planStatus: active.status,
      version: active.currentVersion,
      reviewDeadline: active.reviewDeadline,
      sent: false,
      telegramText: null,
      message: `A weekly plan for ${formatWeekLabel(weekStart)} already exists (${active.status}, v${active.currentVersion}).`,
    };
  }

  const { config, food } = context.planning();
  const notes = [];
  let existingTasks = planInput.existingTasks;
  if (existingTasks === undefined) {
    try {
      existingTasks = await context.todoist().getTasks({});
      if (!Array.isArray(existingTasks)) throw new Error("Todoist did not return a task list.");
    } catch (error) {
      existingTasks = [];
      notes.push(TODOIST_UNREADABLE_NOTE);
    }
  }

  const previous = plans
    .filter((plan) => plan.weekStart < weekStart && plan.versions.length > 0 && !["cancelled", "draft"].includes(plan.status))
    .at(-1);
  let inputs;
  try {
    inputs = buildInitialPlanInputs(
      { ...planInput, existingTasks },
      {
        config,
        food,
        weekStart,
        previousTargets: previous ? versionEntry(previous, previous.currentVersion).plan.targets : null,
        language: savedRecipeLanguage(context.memoryPath),
      },
    );
  } catch (error) {
    if (error instanceof RecipeInputError) return recipeClarification(null, error);
    throw error;
  }
  inputs.notes.push(...notes);
  const planId = newPlanId(weekStart, context.random);

  if (config.golf?.enabled) {
    // The golf questions are the planner's own; a golf question the scheduled
    // job added would repeat them in the finished plan.
    if (inputs.question && GOLF_TOPIC.test(inputs.question)) inputs.question = null;
    if (!options.send && !options.reply) {
      return {
        status: "preview",
        planId: null,
        version: null,
        sent: false,
        telegramText: formatGolfQuestion({ weekStart, previousWeek: previousGolfWeek(plans, weekStart) }),
        message: "Preview only. Nothing was stored. The plan is built after the user answers these golf questions.",
      };
    }
    await supersedeUnansweredWeeks(store, weekStart, context);
    store.writePlan(
      createAwaitingDocument({
        planId,
        weekStart,
        baseInputs: inputs,
        golf: emptyGolfInputs(config),
        now,
        source: options.reply ? "chat" : "scheduled",
        timezone,
      }),
    );
    if (options.reply && golfAnswer) return answerGolf(planId, { golf: golfAnswer }, context);
    return askGolf(planId, options, context);
  }

  const plan = buildWeeklyPlan(inputs, { config, food });
  await resolveConfiguredTarget(plan, config, context);
  const document = createPlanDocument({ planId, inputs, plan, now, source: options.reply ? "chat" : "scheduled", timezone });

  if (!options.send && !options.reply) {
    return {
      status: "preview",
      planId: null,
      version: 1,
      sent: false,
      telegramText: formatPlanMessage(document, {
        version: 1,
        deadline: computeReviewDeadline(now.toISOString(), reviewOptions(context)),
        timezone,
      }),
      message: "Preview only. Nothing was stored, so nothing will apply.",
    };
  }

  // Written as a draft before anything is shown, so a failed send never leaves
  // a displayed plan without a stored record, and a draft never applies.
  store.writePlan(document);
  return display(planId, options, context);
}

/**
 * Asks the week's golf questions: sends them (--send, the Saturday job) or
 * hands them back as the chat reply. After a partial answer it asks only for
 * what is missing. No plan version exists yet, so no review window runs.
 */
async function askGolf(planId, options, context) {
  const store = context.store;
  return store.withPlanLock(planId, async () => {
    let document = store.readPlan(planId);
    const answered = document.history.some((entry) => entry.event === "golf-answered");
    const { missing } = golfInputStatus(document.awaiting.golf);
    const text = answered
      ? formatGolfFollowUp({ golf: document.awaiting.golf, missing })
      : formatGolfQuestion({ weekStart: document.weekStart, previousWeek: previousGolfWeek(store.listPlans(), document.weekStart) });

    let messageId = null;
    if (options.send) {
      try {
        ({ messageId } = await context.sendMessage(text));
      } catch (error) {
        const failure = new Error(`Could not send the golf questions to Telegram; nothing was shown and nothing will apply: ${error.message}`);
        failure.planId = planId;
        throw failure;
      }
    }
    document = recordGolfQuestion(document, {
      askedAt: context.now(),
      channel: options.send ? "telegram-send" : "chat-reply",
      messageId,
      followUp: answered,
    });
    store.writePlan(document);
    return {
      status: "awaiting_input",
      planId,
      sent: Boolean(options.send),
      missing,
      telegramText: options.send ? null : text,
      message: options.send ? "Sent to Telegram. Return NO_REPLY." : "Reply to the user with telegramText exactly.",
    };
  });
}

async function answer(options, context) {
  const payload = await readJsonOption(options.inputJson, options.inputJsonStdin, context.stdin, "input");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error('answer needs {"golf": {...}} as JSON.');
  for (const key of Object.keys(payload)) {
    if (!["golf", "changes"].includes(key)) throw new Error(`Unknown field in the answer: ${key}. Allowed: golf, changes.`);
  }
  if (!payload.golf) throw new Error('answer needs a "golf" object with the user\'s exact words as replyText.');
  const planId = resolveOpenPlanId(options.planId, context.store, ["awaiting_input"]);
  return answerGolf(planId, payload, context);
}

/**
 * Stores the user's golf answers. Values that are not in the user's words are
 * refused and nothing is stored. While playing days or focus are missing it
 * asks for them; once both are known it builds the whole plan, stores it as
 * v1 and shows it as the chat reply, which is when the 12-hour window starts.
 */
async function answerGolf(planId, payload, context) {
  const { config, food } = context.planning();
  const { timezone, reviewWindowHours, roundMinutes } = context.settings();
  const store = context.store;
  return store.withPlanLock(planId, async () => {
    let document = store.readPlan(planId);
    const week = formatWeekLabel(document.weekStart);
    if (document.status !== "awaiting_input") {
      throw new Error(
        ["draft", "pending"].includes(document.status)
          ? `The plan for ${week} is already built (v${document.currentVersion}); change it with revise.`
          : `The weekly plan for ${week} is ${document.status}.`,
      );
    }
    const now = context.now();
    const today = localDateInTimeZone(now, timezone);
    const previousWeek = previousGolfWeek(store.listPlans(), document.weekStart);
    const routines = readSavedGolfRoutines(context.memoryPath);
    const golfContext = { today, previousWeek, normalWeekText: routines.normalWeek };
    const result = applyGolfChanges(document.awaiting.golf, payload.golf, { ...golfContext, weekStart: document.weekStart });
    if (result.problems.length > 0) return clarification(planId, result.problems);

    document = recordGolfAnswer(document, {
      golf: result.golf,
      replyText: payload.golf.replyText,
      fields: Object.keys(payload.golf).filter((key) => key !== "replyText"),
      now,
    });
    const readiness = golfInputStatus(result.golf);
    if (!readiness.complete) {
      document = recordGolfQuestion(document, { askedAt: now, channel: "chat-reply", followUp: true });
      store.writePlan(document);
      return {
        status: "needs_input",
        planId,
        missing: readiness.missing,
        telegramText: formatGolfFollowUp({ golf: result.golf, missing: readiness.missing }),
        message: "Nothing is planned yet. Reply to the user with telegramText exactly.",
      };
    }

    // Complete: the stored context, today's Todoist tasks and the answers.
    const base = structuredClone(document.awaiting.baseInputs);
    // Stored before the scheduled run lost its food additions, or before recipes had a language.
    if (document.awaiting.source === "scheduled") base.food = { ...base.food, addedMeals: [], customMeals: [], extraShopping: [] };
    base.food.language ??= savedRecipeLanguage(context.memoryPath) ?? food.weeklyMealPlan?.defaultLanguage ?? DEFAULT_RECIPE_LANGUAGE;
    try {
      const tasks = await context.todoist().getTasks({});
      if (!Array.isArray(tasks)) throw new Error("Todoist did not return a task list.");
      base.existing = normalizeExistingTasks(tasks, document.weekStart);
      base.notes = base.notes.filter((note) => note !== TODOIST_UNREADABLE_NOTE);
    } catch {
      if (!base.notes.includes(TODOIST_UNREADABLE_NOTE)) base.notes.push(TODOIST_UNREADABLE_NOTE);
    }
    let inputs = { ...base, golf: { ...result.golf, saved: routines.saved } };
    let plan = buildWeeklyPlan(inputs, { config, food, today });
    if (payload.changes) {
      try {
        ({ inputs } = applyWeeklyPlanChanges(inputs, plan, payload.changes, { config, food, golfContext }));
      } catch (error) {
        if (error instanceof GolfInputError) return clarification(planId, error.problems);
        if (error instanceof RecipeInputError) return recipeClarification(planId, error);
        throw error;
      }
      plan = buildWeeklyPlan(inputs, { config, food, today });
    }
    await resolveConfiguredTarget(plan, config, context);

    document = completeAwaitingDocument(document, { inputs, plan, now });
    document = markPlanDisplayed(document, { version: 1, displayedAt: now, channel: "chat-reply", reviewWindowHours, roundMinutes });
    store.writePlan(document);
    return {
      status: "pending",
      planId,
      version: 1,
      reviewDeadline: document.reviewDeadline,
      reviewDeadlineLocal: formatLocalDateTime(document.reviewDeadline, timezone),
      telegramText: formatPlanMessage(document, { version: 1, deadline: document.reviewDeadline, timezone }),
      message: "Reply to the user with telegramText exactly.",
    };
  });
}

/** A recipe the user supplied is missing something: ask for exactly that, and store nothing. */
function recipeClarification(planId, error) {
  return {
    status: "clarify",
    planId,
    changed: false,
    problems: error.problems,
    telegramText: formatRecipeClarification(error),
    message:
      "Nothing was stored. Ask the user telegramText. Never fill in an amount, unit or step the user's recipe does not give; one of the catalog recipes can be used instead if they prefer.",
  };
}

/** The scheduled run's food input without dishes or groceries added on the user's behalf. */
function withoutAdditions(food) {
  if (!food || typeof food !== "object" || Array.isArray(food)) return food;
  const { addMeals, customMeals, addShopping, ...rest } = food;
  return rest;
}

/** A saved recipe-language preference (`food/recipe-language` in memory), read only. */
function savedRecipeLanguage(memoryPath) {
  try {
    const entry = listMemoryEntries(memoryPath, { category: "food" }).find(
      (candidate) => candidate.key === "recipe-language" && candidate.sensitivity === "low",
    );
    return parseRecipeLanguage(entry?.value);
  } catch {
    return null;
  }
}

function clarification(planId, problems) {
  return {
    status: "clarify",
    planId,
    changed: false,
    problems: problems.map((problem) => problem.reason),
    telegramText: formatGolfClarification(problems),
    message:
      "Nothing was stored. Use only what the user said: leave out values they did not give and run the command again, or ask them telegramText.",
  };
}

/** The most recent earlier week whose golf answers were shown in a plan: "same as last week". */
function previousGolfWeek(plans, weekStart) {
  const shown = new Set(["pending", "applying", "applied", "applied_with_errors", "failed"]);
  for (const plan of [...plans].reverse()) {
    if (plan.weekStart >= weekStart || !shown.has(plan.status)) continue;
    const version = plan.apply?.version ?? plan.displayedVersion ?? plan.currentVersion;
    const golf = plan.versions.find((entry) => entry.version === version)?.inputs?.golf;
    if (golf) return { weekStart: plan.weekStart, golf };
  }
  return null;
}

/** A week whose golf questions were never answered is closed when the next week's plan starts. */
async function supersedeUnansweredWeeks(store, weekStart, context) {
  for (const plan of store.listPlans()) {
    if (plan.status !== "awaiting_input" || plan.weekStart >= weekStart) continue;
    try {
      await store.mutatePlan(plan.planId, async (current) =>
        current.status === "awaiting_input"
          ? cancelPlan(current, { now: context.now(), reason: "No golf answers before the next week's plan." })
          : null,
      );
    } catch (error) {
      if (error.code !== "PLAN_LOCKED") throw error;
    }
  }
}

/** Shows the current version: sends it (--send) or hands it back for the chat reply (--reply). */
async function display(planId, options, context) {
  const { timezone, reviewWindowHours, roundMinutes } = context.settings();
  return context.store.withPlanLock(planId, async () => {
    let document = context.store.readPlan(planId);
    const version = document.currentVersion;
    const displayedAt = context.now().toISOString();
    const deadline = computeReviewDeadline(displayedAt, { hours: reviewWindowHours, roundMinutes });
    const text = formatPlanMessage(document, {
      version,
      deadline,
      changeSummary: versionEntry(document, version).changeSummary,
      timezone,
    });

    let messageId = null;
    if (options.send) {
      try {
        ({ messageId } = await context.sendMessage(text));
      } catch (error) {
        const failure = new Error(`Could not send the weekly plan to Telegram; it stays a draft and will not apply: ${error.message}`);
        failure.planId = planId;
        throw failure;
      }
    }

    document = markPlanDisplayed(document, {
      version,
      displayedAt,
      channel: options.send ? "telegram-send" : "chat-reply",
      messageId,
      reviewWindowHours,
      roundMinutes,
    });
    context.store.writePlan(document);
    return {
      status: "pending",
      planId,
      version,
      reviewDeadline: document.reviewDeadline,
      reviewDeadlineLocal: formatLocalDateTime(document.reviewDeadline, timezone),
      sent: Boolean(options.send),
      telegramText: options.send ? null : text,
      message: options.send
        ? "Sent to Telegram. Return NO_REPLY."
        : "Reply to the user with telegramText exactly.",
    };
  });
}

async function revise(options, context) {
  const changes = await readJsonOption(options.changesJson, options.changesJsonStdin, context.stdin, "changes");
  if (!changes) throw new Error("revise needs --changes-json or --changes-json-stdin.");
  const planId = resolveOpenPlanId(options.planId, context.store, ["draft", "pending"]);
  const { config, food } = context.planning();
  const { timezone, reviewWindowHours, roundMinutes } = context.settings();
  let unchanged = false;

  let document;
  try {
    document = await context.store.mutatePlan(planId, async (current) => {
      const entry = versionEntry(current, current.currentVersion);
      if (options.expectVersion !== current.currentVersion) {
        throw new Error(
          `The user was looking at v${options.expectVersion}, but the current version is v${current.currentVersion}. Show the current version first.`,
        );
      }
      const today = localDateInTimeZone(context.now(), timezone);
      const golfContext = changes.golf
        ? {
            today,
            previousWeek: previousGolfWeek(context.store.listPlans(), current.weekStart),
            normalWeekText: readSavedGolfRoutines(context.memoryPath).normalWeek,
          }
        : { today };
      const { inputs, summary, note } = applyWeeklyPlanChanges(entry.inputs, entry.plan, changes, { config, food, golfContext });
      const plan = buildWeeklyPlan(inputs, { config, food, today });
      await resolveConfiguredTarget(plan, config, context);
      if (digestPlan(plan) === entry.digest) {
        unchanged = true;
        return null;
      }
      const now = context.now();
      const revised = addPlanRevision(current, {
        expectedVersion: options.expectVersion,
        inputs,
        plan,
        changeSummary: summary,
        note,
        now,
      });
      // The revised plan is the chat reply, so it is displayed now and its
      // review window starts over.
      return markPlanDisplayed(revised, {
        version: revised.currentVersion,
        displayedAt: now,
        channel: "chat-reply",
        reviewWindowHours,
        roundMinutes,
      });
    });
  } catch (error) {
    if (error instanceof GolfInputError) return clarification(planId, error.problems);
    if (error instanceof RecipeInputError) return recipeClarification(planId, error);
    throw error;
  }

  const version = document.currentVersion;
  if (unchanged) {
    return {
      status: document.status,
      planId,
      version,
      changed: false,
      reviewDeadline: document.reviewDeadline,
      telegramText: `That doesn't change the plan (still v${version}).${document.reviewDeadline ? ` I'll create the tasks at ${formatLocalDateTime(document.reviewDeadline, timezone)} unless you change or cancel it.` : ""}`,
    };
  }
  return {
    status: document.status,
    planId,
    version,
    changed: true,
    reviewDeadline: document.reviewDeadline,
    reviewDeadlineLocal: formatLocalDateTime(document.reviewDeadline, timezone),
    telegramText: formatPlanMessage(document, {
      version,
      deadline: document.reviewDeadline,
      changeSummary: versionEntry(document, version).changeSummary,
      timezone,
    }),
  };
}

async function accept(options, context) {
  const planId = resolveOpenPlanId(options.planId, context.store, ["awaiting_input", "draft", "pending"]);
  if (!isWeeklyPlanAcceptance(options.replyText)) {
    return {
      status: "not_accepted",
      planId,
      applied: false,
      telegramText: null,
      message: "The reply is not an explicit acceptance. Treat it as a change or ask one short question; nothing was created.",
    };
  }
  const result = await applyWeeklyPlan({
    store: context.store,
    planId,
    trigger: "accepted",
    expectedVersion: options.version,
    todoist: createWeeklyPlanTodoistGateway(context.todoist()),
    now: context.now,
    ...(context.sleep ? { sleep: context.sleep } : {}),
    ...(context.retryDelaysMs ? { retryDelaysMs: context.retryDelaysMs } : {}),
    timezone: context.settings().timezone,
  });
  const week = formatWeekLabel(result.document.weekStart);
  return {
    status: result.document.status,
    planId,
    applied: result.applied,
    reason: result.reason,
    telegramText:
      result.summary ??
      (result.document.status === "cancelled"
        ? `The weekly plan for ${week} was cancelled, so nothing was created.`
        : result.document.apply
          ? `This plan was already handled; nothing new was created.\n\n${formatApplySummary(result.document)}`
          : null),
  };
}

async function cancel(options, context) {
  const planId = resolveOpenPlanId(options.planId, context.store, ["awaiting_input", "draft", "pending"]);
  const document = await context.store.mutatePlan(planId, async (current) =>
    cancelPlan(current, { now: context.now(), reason: options.reason ?? null }),
  );
  return {
    status: document.status,
    planId,
    telegramText:
      document.currentVersion === 0
        ? `Cancelled the weekly plan for ${formatWeekLabel(document.weekStart)}. Nothing was created in Todoist.`
        : `Cancelled the weekly plan for ${formatWeekLabel(document.weekStart)} (v${document.currentVersion}). Nothing was created in Todoist.`,
  };
}

async function show(options, context) {
  const store = context.store;
  const plans = store.listPlans();
  const document = options.planId
    ? store.readPlan(options.planId)
    : plans.filter((plan) => OPEN_STATUSES.includes(plan.status)).at(-1) ?? plans.at(-1);
  if (!document) return { status: "none", telegramText: "There is no weekly plan yet." };
  if (document.status === "awaiting_input" || (document.status === "cancelled" && document.currentVersion === 0)) {
    const { missing } = golfInputStatus(document.awaiting.golf);
    const answered = document.history.some((entry) => entry.event === "golf-answered");
    return {
      status: document.status,
      planId: document.planId,
      version: null,
      reviewDeadline: null,
      telegramText:
        document.status === "cancelled"
          ? `The weekly plan for ${formatWeekLabel(document.weekStart)} was cancelled before it was built.`
          : answered
            ? formatGolfFollowUp({ golf: document.awaiting.golf, missing })
            : formatGolfQuestion({ weekStart: document.weekStart, previousWeek: previousGolfWeek(plans, document.weekStart) }),
    };
  }
  const { timezone } = context.settings();
  const version = document.currentVersion;
  const deadline = document.reviewDeadline ?? computeReviewDeadline(context.now().toISOString(), reviewOptions(context));
  const header =
    document.status === "pending" || document.status === "draft"
      ? null
      : `Status: ${document.status}${document.apply ? ` (v${document.apply.version})` : ""}.`;
  const text = formatPlanMessage(document, {
    version,
    deadline,
    changeSummary: versionEntry(document, version).changeSummary,
    timezone,
  });
  return {
    status: document.status,
    planId: document.planId,
    version,
    reviewDeadline: document.reviewDeadline,
    telegramText: header ? `${header}\n\n${document.apply ? formatApplySummary(document) : text}` : text,
  };
}

async function status(options, context) {
  const { timezone } = context.settings();
  const now = context.now();
  const { plans, issues } = context.store.listPlansWithIssues();
  const summary = summarizeWeeklyPlans(plans, {
    now,
    currentWeekStart: nextWeekStart(now, timezone),
  });
  const localize = (entry) =>
    entry && {
      ...entry,
      reviewDeadlineLocal: entry.reviewDeadline ? formatLocalDateTime(entry.reviewDeadline, timezone) : null,
      appliedAtLocal: entry.appliedAt ? formatLocalDateTime(entry.appliedAt, timezone) : null,
    };
  const result = {
    ...summary,
    pending: summary.pending.map(localize),
    latest: localize(summary.latest),
    upcomingWeek: localize(summary.upcomingWeek),
    unreadablePlanFiles: issues,
    telegramText: [
      describeStatus(summary, timezone),
      ...(issues.length > 0 ? [`${issues.length} weekly plan file(s) could not be read and are ignored.`] : []),
    ].join("\n"),
    ...(summary.pending.length > 0
      ? { guidance: "Before answering, changing, accepting or cancelling, run npm run --silent weekly-plan -- guide and follow it." }
      : {}),
  };
  if (options.jobs) {
    result.jobs = weeklyPlanJobStatus(await listCronJobs(context));
  }
  return result;
}

function describeStatus(summary, timezone) {
  const lines = [];
  for (const plan of summary.pending) {
    const week = formatWeekLabel(plan.weekStart);
    if (plan.status === "awaiting_input") {
      const missing = (plan.golfMissing ?? []).map((field) => (field === "rounds" ? "which days you're playing" : "what to focus on"));
      lines.push(
        plan.golfQuestionsAskedAt
          ? `Weekly plan for ${week} is waiting for your golf answers${missing.length > 0 ? ` (${missing.join(" and ")})` : ""}; nothing is created until you've seen the full plan.`
          : `Weekly plan for ${week} couldn't ask its golf questions yet; nothing will be created.`,
      );
    } else if (plan.status === "draft") lines.push(`Weekly plan for ${week} is a draft (v${plan.currentVersion}); it was not shown yet and will not apply.`);
    else if (plan.status === "applying") lines.push(`Weekly plan for ${week} (v${plan.currentVersion}) is being applied now.`);
    else lines.push(`Weekly plan for ${week} is pending (v${plan.currentVersion}); I'll create its tasks at ${formatLocalDateTime(plan.reviewDeadline, timezone)} unless you change or cancel it.`);
  }
  if (summary.pending.length === 0) lines.push("No weekly plan is pending.");
  const latest = summary.latest;
  if (latest && !OPEN_STATUSES.includes(latest.status)) {
    const week = formatWeekLabel(latest.weekStart);
    const outcome = {
      applied: "applied",
      applied_with_errors: "applied with errors",
      failed: "not applied (failed)",
      cancelled: "cancelled",
    }[latest.status];
    lines.push(
      latest.appliedAt
        ? `Last plan (${week}) was ${outcome} at ${formatLocalDateTime(latest.appliedAt, timezone)} (v${latest.appliedVersion}).`
        : `Last plan (${week}) was ${outcome}${latest.currentVersion === 0 ? " before it was built" : ""}.`,
    );
    if (latest.failureReason) lines.push(`Reason: ${latest.failureReason}`);
  }
  return lines.join("\n");
}

async function applyDue(options, context) {
  const store = context.store;
  const now = context.now();
  const summaries = [];
  let failures = 0;
  for (const document of store.listPlans()) {
    if (document.status !== "applying" && !isPlanDue(document, now)) continue;
    try {
      const result = await applyWeeklyPlan({
        store,
        planId: document.planId,
        trigger: "deadline",
        todoist: createWeeklyPlanTodoistGateway(context.todoist()),
        now: context.now,
        ...(context.sleep ? { sleep: context.sleep } : {}),
        ...(context.retryDelaysMs ? { retryDelaysMs: context.retryDelaysMs } : {}),
        timezone: context.settings().timezone,
      });
      if (result.summary) summaries.push(result.summary);
    } catch (error) {
      if (error.code === "PLAN_LOCKED") continue;
      failures += 1;
      summaries.push(`Weekly plan ${document.weekId} could not be applied: ${error.message}`);
    }
  }
  return { text: summaries.length > 0 ? summaries.join("\n\n") : "NO_REPLY", failures };
}

async function install(options, context) {
  const env = context.env;
  const jobs = buildWeeklyPlanCronJobs(context.schedules(), {
    telegramUserId: env.TELEGRAM_USER_ID,
    projectRoot: context.root,
    nodePath: context.nodePath,
  });
  const existingJobs = await listCronJobs(context);
  const config = readJsonIfPresent(resolveOpenClawConfigPath(env, context.root));
  const commands = buildWeeklyPlanCronCommands(jobs, {
    existingJobs,
    gatewayToken: config.gateway?.remote?.token ?? config.gateway?.auth?.token,
    openclawCommand: context.openclawCommand(),
  });
  const preview = commands.map(({ action, jobName, display }) => ({ action, jobName, display }));
  if (options.dryRun) return { dryRun: true, jobs: jobs.map(describeJob), commands: preview };

  const results = [];
  for (const command of commands) {
    await context.execOpenClaw(command.args);
    results.push({ action: command.action, jobName: command.jobName });
  }
  return {
    dryRun: false,
    results,
    installed: weeklyPlanJobStatus(await listCronJobs(context)),
  };
}

function describeJob(job) {
  return {
    name: job.name,
    kind: job.kind,
    schedule: job.schedule,
    ...(job.kind === "command" ? { argv: job.argv, cwd: job.cwd } : { agentId: job.agentId }),
    delivery: { channel: job.delivery.channel, to: job.delivery.to },
    enabled: job.enabled,
  };
}

async function listCronJobs(context) {
  const parsed = parseJsonOutput(await context.execOpenClaw(["cron", "list", "--all", "--json"]));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.jobs)) return parsed.jobs;
  throw new Error("Could not read the installed cron jobs from the Gateway.");
}

/**
 * Resolves the configured Todoist project/section once at proposal time with
 * the existing resolver, so the stored payload already carries the ids. A name
 * that does not resolve stops the proposal instead of falling back to the Inbox.
 */
async function resolveConfiguredTarget(plan, config, context) {
  const projectName = config.todoist?.projectName;
  const sectionName = config.todoist?.sectionName;
  if (!projectName && !sectionName) return;
  const client = context.todoist();
  const target = {};
  if (projectName) {
    const resolved = resolveTodoistProject(projectName, await client.getProjects());
    if (resolved.status !== targetStatuses.resolved) throw new Error(resolved.reason);
    target.project_id = resolved.projectId;
  }
  if (sectionName) {
    const resolved = resolveTodoistSection(sectionName, await client.getSections(target.project_id ? { projectId: target.project_id } : {}), {
      projectId: target.project_id,
    });
    if (resolved.status !== targetStatuses.resolved) throw new Error(resolved.reason);
    target.section_id = resolved.sectionId;
    target.project_id ??= resolved.projectId;
  }
  for (const operation of plan.operations) Object.assign(operation.payload, target);
}

function resolveOpenPlanId(planId, store, statuses) {
  if (planId) return planId;
  const plans = store.listPlans();
  const open = plans.filter((plan) => statuses.includes(plan.status));
  if (open.length === 1) return open[0].planId;
  if (open.length > 1) throw new Error(`Several weekly plans are open (${open.map((plan) => plan.planId).join(", ")}); pass --plan-id.`);
  if (!statuses.includes("awaiting_input") && plans.some((plan) => plan.status === "awaiting_input")) {
    throw new Error("The weekly plan is still waiting for golf answers; use answer (a change can go along with it).");
  }
  if (statuses.length === 1 && statuses[0] === "awaiting_input") {
    throw new Error(
      plans.some((plan) => ["draft", "pending"].includes(plan.status))
        ? "The plan is already built; change it with revise."
        : "No weekly plan is waiting for golf answers.",
    );
  }
  throw new Error("There is no pending weekly plan.");
}

/** The guide always prints; an unreadable plan store is reported, never hidden. */
function guide(context) {
  let text = readFileSync(projectPath(context.root, WEEKLY_PLAN_GUIDE_PATH), "utf8").trim();
  try {
    const meals = context.planning().food.weeklyMealPlan.meals;
    text += `\n\n## Recipe Ids\n\n${meals.map((meal) => `- \`${meal.id}\`: ${localizedMealName(meal, "sv")} / ${localizedMealName(meal, "fi")}`).join("\n")}`;
  } catch (error) {
    text += `\n\nThe recipe catalog could not be read: ${error.message}`;
  }
  let statusText;
  try {
    const now = context.now();
    const { timezone } = context.settings();
    statusText = describeStatus(
      summarizeWeeklyPlans(context.store.listPlansWithIssues().plans, { now, currentWeekStart: nextWeekStart(now, timezone) }),
      timezone,
    );
  } catch (error) {
    statusText = `The weekly plan store could not be read: ${error.message}`;
  }
  return { text: `Current weekly plan status:\n${statusText}\n\n${text}` };
}

function reviewOptions(context) {
  const { reviewWindowHours, roundMinutes } = context.settings();
  return { hours: reviewWindowHours, roundMinutes };
}

function mondayOf(date) {
  const offset = weekdayIndex(date);
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - offset * 86_400_000).toISOString().slice(0, 10);
}

async function readJsonOption(inline, fromStdin, stdin, label) {
  if (inline !== undefined) return parseJson(inline, label);
  if (!fromStdin) return null;
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? parseJson(text, label) : null;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`The ${label} is not valid JSON: ${error.message}`);
  }
}

function parseJsonOutput(stdout) {
  const text = String(stdout ?? "");
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((index) => index >= 0);
  if (starts.length === 0) return null;
  try {
    return JSON.parse(text.slice(Math.min(...starts)));
  } catch {
    return null;
  }
}

function readJsonIfPresent(path) {
  try {
    return existsSync(path) ? readJson(path) : {};
  } catch {
    return {};
  }
}

export function formatWeeklyPlanCliResult(command, result, { json = false, text = false } = {}) {
  if (command === "apply-due" || command === "guide") return result.text;
  if (json) return JSON.stringify(result, null, 2);
  if (text && typeof result.telegramText === "string") return result.telegramText;
  return JSON.stringify(result, null, 2);
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const argv = process.argv.slice(2);
    const parsed = parseWeeklyPlanArgs(argv);
    const result = await runWeeklyPlanCli(argv);
    console.log(formatWeeklyPlanCliResult(parsed.command, result, parsed.options));
    if (parsed.command === "apply-due" && result.failures > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
