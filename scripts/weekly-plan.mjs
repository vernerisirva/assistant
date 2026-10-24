#!/usr/bin/env node
/**
 * Weekly plan CLI.
 *
 *   propose   preview next week's plan, or store and show it (--send or --reply);
 *             complete at once, with labelled defaults for golf answers not given
 *   answer    golf answers for a plan stored before they became optional
 *             (awaiting_input): builds and shows the plan, defaults for the rest
 *   revise    store a new version from structured changes and restart the review window;
 *             holds the shown version first, and keeps it held while a question is open
 *   keep      the user keeps the shown version and drops the change they asked for
 *   reconcile        after the plan was applied: propose the exact Todoist changes a new
 *                    change needs (add, change, remove), stored for approval; changes nothing
 *   reconcile-apply  make exactly a stored proposal's changes after the user's explicit approval
 *   accept    apply the displayed version now after an explicit OK
 *   cancel    cancel a draft or pending plan; nothing is created
 *   show      print the current version
 *   status    read-only summary: pending? when? which version? applied?
 *   apply-due deterministic check used by the scheduled command job: sends an
 *             undelivered proposal again, and applies plans whose window has passed
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
  applyClearWeeklyPlanChanges,
  applyWeeklyPlanChanges,
  assertRevisable,
  buildInitialPlanInputs,
  buildWeeklyPlan,
  computeReviewDeadline,
  digestPlan,
  formatApplySummary,
  formatLocalDateTime,
  formatPlanMessage,
  formatRevisionHold,
  formatRevisionQuestion,
  formatWeekLabel,
  isWeeklyPlanAcceptance,
  isoWeekId,
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
  createPlanDocument,
  createWeeklyPlanStore,
  deliveryErrorText,
  holdForRevision,
  isDeliveryRetryDue,
  isPlanDue,
  isRevisionHoldReportDue,
  markPlanDisplayed,
  newPlanId,
  recordDeliveryFailure,
  recordGolfAnswer,
  recordRevisionHoldReported,
  recordRevisionQuestion,
  releaseRevisionHold,
  summarizeWeeklyPlans,
  versionEntry,
} from "./lib/weekly-plan-store.mjs";
import { applyWeeklyPlan, createWeeklyPlanTodoistGateway, readOpenTasksWithRetry } from "./lib/weekly-plan-apply.mjs";
import {
  addReconciliation,
  applyReconciliation,
  createReconciliationRecord,
  createReconciliationTodoistGateway,
  formatReconciliationProposal,
  isReconcilable,
  planReconciliation,
  reconciliationBase,
} from "./lib/weekly-plan-reconcile.mjs";
import { buildWeeklyPlanCronCommands, buildWeeklyPlanCronJobs, weeklyPlanJobStatus } from "./lib/weekly-plan-cron.mjs";
import { localDateInTimeZone } from "./lib/routine-skips.mjs";
import { listMemoryEntries } from "./lib/memory.mjs";
import { DEFAULT_RECIPE_LANGUAGE, RecipeInputError, formatRecipeClarification, localizedMealName, parseRecipeLanguage } from "./lib/recipes.mjs";

const execFileAsync = promisify(execFile);
const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");
const COMMANDS = ["propose", "answer", "revise", "keep", "accept", "cancel", "show", "status", "apply-due", "reconcile", "reconcile-apply", "install", "guide", "help"];
/** How long a chat command waits for a check that is applying the same plan. */
const CHAT_LOCK_WAIT_MS = 60_000;
export const WEEKLY_PLAN_GUIDE_PATH = "agents/personal/guides/weekly-plan.md";
const TODOIST_UNREADABLE_NOTE =
  "I couldn't retrieve your Todoist tasks, so I can't safely rule out duplicates. I'll check again before creating anything, and ask you first if that week already has tasks this plan didn't account for.";
/** Earlier wordings of the same note, still in stored plans. */
const TODOIST_UNREADABLE_NOTES = Object.freeze([TODOIST_UNREADABLE_NOTE, "I couldn't read Todoist just now; duplicates are re-checked before anything is created."]);
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
    "--proposal-id": "proposalId",
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
  if (command === "keep" && options.version === undefined) {
    throw new Error("keep requires --version, the version the user was looking at.");
  }
  if (command === "reconcile-apply" && (options.proposalId === undefined || options.replyText === undefined)) {
    throw new Error("reconcile-apply requires --proposal-id (from reconcile) and --reply-text (the user's exact reply).");
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
          "npm run --silent weekly-plan -- revise --expect-version 1 --changes-json-stdin <<'JSON'\n{\"golf\":{\"replyText\":\"18 holes Wednesday, focus putting\",\"addRounds\":[{\"day\":\"wednesday\",\"holes\":18}],\"focus\":[\"Putting\"]}}\nJSON",
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
    case "keep":
      return keep(parsed.options, context);
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
    case "reconcile":
      return reconcile(parsed.options, context);
    case "reconcile-apply":
      return reconcileApply(parsed.options, context);
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
  lockWaitMs = CHAT_LOCK_WAIT_MS,
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
    lockWaitMs,
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
  // no user words, so a golf object there is ignored and the plan uses its
  // labelled defaults. For the same reason it cannot add dishes or groceries:
  // those would be top-ups nobody chose.
  const { golf: golfAnswer, ...planInput } = input;
  if (options.send) planInput.food = withoutAdditions(planInput.food);
  const now = context.now();
  const { timezone } = context.settings();
  const today = localDateInTimeZone(now, timezone);
  const weekStart = planInput.weekStart ?? nextWeekStart(now, timezone);
  const thisMonday = mondayOf(today);
  if (typeof weekStart !== "string" || weekStart < thisMonday) {
    throw new Error(`weekStart must be a Monday from ${thisMonday} onward.`);
  }

  const store = context.store;
  const { plans, issues } = store.listPlansWithIssues();
  // A plan file for that week that can't be read may be shown or applied
  // already; a second plan beside it could double the week's tasks.
  const unreadable = issues.filter((issue) => issue.file.startsWith(`wp-${isoWeekId(weekStart)}-`));
  if (unreadable.length > 0) {
    throw new Error(
      `The stored weekly plan for ${formatWeekLabel(weekStart)} can't be read (${unreadable.map((issue) => issue.file).join(", ")}), so I won't start a second plan for that week. Nothing was created.`,
    );
  }
  const active = plans.filter((plan) => plan.weekStart === weekStart && plan.status !== "cancelled").at(-1);
  if (active) {
    // Stored before golf answers became optional: build it now, with defaults
    // for whatever is still unanswered, and show it.
    if (active.status === "awaiting_input" && (options.send || options.reply)) {
      return completeAwaiting(active.planId, options.reply && golfAnswer ? { golf: golfAnswer } : {}, options, context);
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
  let existingUnchecked = false;
  if (existingTasks === undefined) {
    const read = await readTodoistTasks(context);
    existingTasks = read.tasks ?? [];
    if (read.error) {
      // Not silently "no tasks": the plan says so, and its automatic apply
      // waits for an OK if that week turns out to have tasks it didn't count.
      existingUnchecked = true;
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
  if (existingUnchecked) inputs.existingUnchecked = true;

  if (config.golf?.enabled) {
    // The plan asks its own optional golf questions; a golf question the
    // scheduled job added would repeat them.
    if (inputs.question && GOLF_TOPIC.test(inputs.question)) inputs.question = null;
    // Saved golf routines shape the wording only of a plan built in chat,
    // never of the scheduled one.
    const routines = options.reply ? readSavedGolfRoutines(context.memoryPath) : { saved: null, normalWeek: null };
    inputs.golf = { ...emptyGolfInputs(config), saved: routines.saved };
    if (options.reply && golfAnswer) {
      const result = applyGolfChanges(inputs.golf, golfAnswer, {
        weekStart,
        today,
        previousWeek: previousGolfWeek(plans, weekStart),
        normalWeekText: routines.normalWeek,
      });
      if (result.problems.length > 0) return clarification(null, result.problems);
      inputs.golf = result.golf;
    }
  }

  const plan = buildWeeklyPlan(inputs, { config, food, today });
  await resolveConfiguredTarget(plan, config, context);
  const planId = newPlanId(weekStart, context.random);
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
        today,
      }),
      message: "Preview only. Nothing was stored, so nothing will apply.",
    };
  }

  await supersedeEarlierWeeks(store, weekStart, context);
  // Written as a draft before anything is shown, so a failed send never leaves
  // a displayed plan without a stored record, and a draft never applies.
  store.writePlan(document);
  return display(planId, options, context);
}

async function answer(options, context) {
  const payload = await readJsonOption(options.inputJson, options.inputJsonStdin, context.stdin, "input");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error('answer needs {"golf": {...}} as JSON.');
  for (const key of Object.keys(payload)) {
    if (!["golf", "changes"].includes(key)) throw new Error(`Unknown field in the answer: ${key}. Allowed: golf, changes.`);
  }
  if (!payload.golf) throw new Error('answer needs a "golf" object with the user\'s exact words as replyText.');
  const planId = resolveOpenPlanId(options.planId, context.store, ["awaiting_input"]);
  return completeAwaiting(planId, payload, { reply: true }, context);
}

/**
 * Builds the plan of a week stored before golf answers became optional
 * (`awaiting_input`): the answers it has, plus the user's words in
 * `payload.golf` when there are any, with labelled defaults for the rest. Golf
 * values not found in the user's words are refused and nothing is stored.
 * Todoist is read again, nothing is planned on days that have passed, and the
 * plan is shown (the chat reply, or sent with --send), which is when its
 * 12-hour window starts.
 */
async function completeAwaiting(planId, payload, options, context) {
  const { config, food } = context.planning();
  const { timezone } = context.settings();
  const store = context.store;
  const chat = !options.send;
  const refused = await store.withPlanLock(planId, async () => {
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
    const routines = chat ? readSavedGolfRoutines(context.memoryPath) : { saved: null, normalWeek: null };
    const golfContext = { today, previousWeek: previousGolfWeek(store.listPlans(), document.weekStart), normalWeekText: routines.normalWeek };
    let golf = document.awaiting.golf;
    if (payload.golf) {
      const result = applyGolfChanges(golf, payload.golf, { ...golfContext, weekStart: document.weekStart });
      if (result.problems.length > 0) return clarification(planId, result.problems);
      golf = result.golf;
      document = recordGolfAnswer(document, {
        golf,
        replyText: payload.golf.replyText,
        fields: Object.keys(payload.golf).filter((key) => key !== "replyText"),
        now,
      });
    }

    // The stored context, today's Todoist tasks and the answers so far.
    const base = structuredClone(document.awaiting.baseInputs);
    // Stored before the scheduled run lost its food additions, or before recipes had a language.
    if (document.awaiting.source === "scheduled") base.food = { ...base.food, addedMeals: [], customMeals: [], extraShopping: [], portions: {} };
    base.food.language ??= savedRecipeLanguage(context.memoryPath) ?? food.weeklyMealPlan?.defaultLanguage ?? DEFAULT_RECIPE_LANGUAGE;
    base.notes = base.notes.filter((note) => !TODOIST_UNREADABLE_NOTES.includes(note));
    delete base.existingUnchecked;
    const read = await readTodoistTasks(context);
    if (read.error) {
      base.notes.push(TODOIST_UNREADABLE_NOTE);
      base.existingUnchecked = true;
    } else {
      base.existing = normalizeExistingTasks(read.tasks, document.weekStart);
    }
    let inputs = { ...base, golf: { ...golf, saved: routines.saved } };
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
    store.writePlan(completeAwaitingDocument(document, { inputs, plan, now }));
    return null;
  });
  if (refused) return refused;
  return display(planId, chat ? { reply: true } : { send: true }, context);
}

/** Open Todoist tasks for planning, `{ tasks, error }`; a missing client counts as unreadable. */
async function readTodoistTasks(context) {
  try {
    return await readOpenTasksWithRetry(createWeeklyPlanTodoistGateway(context.todoist()), {
      ...(context.sleep ? { sleep: context.sleep } : {}),
      ...(context.retryDelaysMs ? { retryDelaysMs: context.retryDelaysMs } : {}),
    });
  } catch (error) {
    return { tasks: null, error };
  }
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

/** The scheduled run's food input without dishes, groceries or portions chosen on the user's behalf. */
function withoutAdditions(food) {
  if (!food || typeof food !== "object" || Array.isArray(food)) return food;
  const { addMeals, customMeals, addShopping, portions, ...rest } = food;
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

/**
 * Earlier weeks that can no longer go anywhere are closed when a new week's
 * plan starts: a week still waiting for golf answers (stored before they became
 * optional), and, once their week is over, a draft that was never shown or a
 * plan that waited for an OK that never came. None of them ever applied.
 */
async function supersedeEarlierWeeks(store, weekStart, context) {
  const today = localDateInTimeZone(context.now(), context.settings().timezone);
  const reasonFor = (plan) => {
    if (plan.status === "awaiting_input") return "No golf answers before the next week's plan.";
    if (plan.weekEnd >= today) return null;
    if (plan.status === "draft") return "Never shown before its week ended.";
    if (plan.status === "pending" && plan.applyHold?.version === plan.currentVersion) return "No OK before its week ended.";
    if (plan.status === "pending" && plan.revisionHold) return "The change asked for wasn't finished before its week ended.";
    return null;
  };
  for (const plan of store.listPlans()) {
    if (plan.weekStart >= weekStart || !reasonFor(plan)) continue;
    try {
      await store.mutatePlan(plan.planId, async (current) => {
        const reason = reasonFor(current);
        return reason ? cancelPlan(current, { now: context.now(), reason }) : null;
      });
    } catch (error) {
      if (error.code !== "PLAN_LOCKED") throw error;
    }
  }
}

/**
 * Shows the current version: sends it (--send) or hands it back for the chat
 * reply (--reply). Only a send that reached Telegram, or the reply itself,
 * makes it pending and starts its review window. A failed send leaves the
 * draft unshown and records it, so the apply check sends it again later.
 */
async function display(planId, options, context) {
  const { timezone, reviewWindowHours, roundMinutes } = context.settings();
  return context.store.withPlanLock(planId, async () => {
    let document = context.store.readPlan(planId);
    const version = document.currentVersion;
    const now = context.now();
    const displayedAt = now.toISOString();
    const deadline = computeReviewDeadline(displayedAt, { hours: reviewWindowHours, roundMinutes });
    const text = formatPlanMessage(document, {
      version,
      deadline,
      changeSummary: versionEntry(document, version).changeSummary,
      timezone,
      today: localDateInTimeZone(now, timezone),
    });

    let messageId = null;
    if (options.send) {
      try {
        ({ messageId } = await context.sendMessage(text));
      } catch (error) {
        if (document.status === "draft") context.store.writePlan(recordDeliveryFailure(document, { error: error.message, now }));
        const failure = new Error(
          `Could not send the weekly plan to Telegram: ${error.message}. It stays a draft and will not apply until it has been shown; the apply check sends it again.`,
        );
        failure.planId = planId;
        failure.deliveryFailed = true;
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

/**
 * A change to the shown plan. It is recorded on the plan first and on its own
 * (`revisionHold`), before anything that can take time or fail, so the version
 * the user asked to change cannot apply on its own while the change is worked
 * out, asked about, or stopped by an error, a crash or a restart; the apply
 * check reads that from the plan file, not from the conversation.
 *
 * Then everything the user's words make clear is applied. A value they don't
 * support, an incomplete recipe, or a question of the agent's own (`ask`)
 * becomes the one question to ask; what was clear waits on the plan with it,
 * so the answer completes the change without the user repeating it. A
 * complete change is shown as a new version: that restarts the 12-hour window
 * and ends the hold. A change that alters nothing ends it too and keeps the
 * deadline. A plan that was applied first is reported as such, never revised.
 */
async function revise(options, context) {
  const raw = await readJsonOption(options.changesJson, options.changesJsonStdin, context.stdin, "changes");
  if (!raw) throw new Error("revise needs --changes-json or --changes-json-stdin.");
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("The changes must be a JSON object.");
  const { ask, ...changes } = raw;
  const asked = ask === undefined ? null : requireQuestion(ask);
  const store = context.store;
  const planId = resolveRevisablePlanId(options.planId, context);
  const { config, food } = context.planning();
  const { timezone, reviewWindowHours, roundMinutes } = context.settings();
  const lock = { waitMs: context.lockWaitMs };

  const held = await store.mutatePlan(
    planId,
    async (current) => {
      if (current.status !== "pending" || current.revisionHold) return null;
      // A plan that can never be changed has no change to wait for.
      assertRevisable(versionEntry(current, current.currentVersion).inputs);
      return holdForRevision(current, { now: context.now(), fromVersion: options.expectVersion });
    },
    lock,
  );
  if (!["draft", "pending"].includes(held.status)) return notRevisable(held, timezone);

  let outcome = null;
  const document = await store.mutatePlan(
    planId,
    async (current) => {
      if (!["draft", "pending"].includes(current.status)) {
        outcome = { closed: true };
        return null;
      }
      if (options.expectVersion !== current.currentVersion) {
        throw new Error(
          `The user was looking at v${options.expectVersion}, but the current version is v${current.currentVersion}. Show the current version first.`,
        );
      }
      const entry = versionEntry(current, current.currentVersion);
      const hold = current.revisionHold ?? null;
      const now = context.now();
      const today = localDateInTimeZone(now, timezone);
      // A golf reply in chat may word the golf tasks with the user's saved
      // routines (read only) when it replaces the defaults, and is read
      // together with the question it answers.
      const routines = changes.golf ? readSavedGolfRoutines(context.memoryPath) : null;
      const golfContext = routines
        ? {
            today,
            previousWeek: previousGolfWeek(store.listPlans(), current.weekStart),
            normalWeekText: routines.normalWeek,
            saved: routines.saved,
            question: hold?.question ?? null,
          }
        : { today };
      // What an earlier message of this change already made clear, else the shown version.
      let previousInputs = hold?.pendingInputs ?? entry.inputs;
      const checked = [];
      // A plan made while Todoist could not be read counts its tasks now if it can.
      if (previousInputs.existingUnchecked) {
        const read = await readTodoistTasks(context);
        if (!read.error) {
          previousInputs = structuredClone(previousInputs);
          previousInputs.existing = normalizeExistingTasks(read.tasks, current.weekStart);
          previousInputs.notes = previousInputs.notes.filter((note) => !TODOIST_UNREADABLE_NOTES.includes(note));
          delete previousInputs.existingUnchecked;
          const found = previousInputs.existing.length;
          checked.push(found > 0 ? `Counted ${found} task${found === 1 ? "" : "s"} already in Todoist` : "Todoist checked: nothing to count");
        }
      }
      const previousPlan = hold?.pendingInputs ? buildWeeklyPlan(previousInputs, { config, food, today }) : entry.plan;
      const applied = applyClearWeeklyPlanChanges(previousInputs, previousPlan, changes, { config, food, golfContext });
      const understood = [...(hold?.understood ?? []), ...applied.summary, ...checked];
      const question =
        asked ?? (applied.recipe ? formatRecipeClarification(applied.recipe) : applied.refused.length > 0 ? formatGolfClarification(applied.refused) : null);
      if (question) {
        outcome = { question, understood, problems: [...applied.refused.map((problem) => problem.reason), ...(applied.recipe?.problems ?? [])] };
        // A draft never applies on its own, so nothing about it is held or stored.
        if (current.status !== "pending") return null;
        const clear = applied.summary.length > 0 || checked.length > 0;
        return recordRevisionQuestion(current, { question, understood, pendingInputs: clear ? applied.inputs : hold?.pendingInputs ?? null, now });
      }
      const plan = buildWeeklyPlan(applied.inputs, { config, food, today });
      await resolveConfiguredTarget(plan, config, context);
      if (digestPlan(plan) === entry.digest) {
        outcome = { unchanged: true };
        return hold ? releaseRevisionHold(current, { now, outcome: "no-change" }) : null;
      }
      outcome = { changed: true };
      const revised = addPlanRevision(current, {
        expectedVersion: options.expectVersion,
        inputs: applied.inputs,
        plan,
        changeSummary: understood,
        note: applied.note,
        now,
      });
      // The revised plan is the chat reply, so it is displayed now and its
      // review window starts over; that ends the hold.
      return markPlanDisplayed(releaseRevisionHold(revised, { now, outcome: "revised" }), {
        version: revised.currentVersion,
        displayedAt: now,
        channel: "chat-reply",
        reviewWindowHours,
        roundMinutes,
      });
    },
    lock,
  );

  const version = document.currentVersion;
  if (outcome.closed) return notRevisable(document, timezone);
  if (outcome.question) {
    const stored = document.status === "pending";
    return {
      status: "clarify",
      planId,
      version,
      changed: false,
      held: stored,
      understood: outcome.understood,
      problems: outcome.problems,
      telegramText: stored ? formatRevisionQuestion({ question: outcome.question, understood: outcome.understood }) : outcome.question,
      message: stored
        ? `The change isn't finished, so v${version} is on hold: it won't apply on its own until the change is shown, kept or cancelled. What the user's words made clear is kept (understood); values they didn't give were left out (problems). Ask the user telegramText. When they answer, run revise --expect-version ${version} with only what the answer says; the kept part is added. If they want the plan as it was, run keep --version ${version}. If the question is only there because you added something the user didn't say, run revise --expect-version ${version} --changes-json '{}' to show the change without it.`
        : "Nothing was stored. Use only what the user said: leave out values they did not give and run the command again, or ask them telegramText.",
    };
  }
  if (outcome.unchanged) {
    const waiting = document.applyHold?.version === version;
    return {
      status: document.status,
      planId,
      version,
      changed: false,
      reviewDeadline: document.reviewDeadline,
      telegramText: `That doesn't change the plan (still v${version}).${
        waiting
          ? " It's waiting for your OK before anything is created."
          : document.reviewDeadline
            ? ` I'll create the tasks at ${formatLocalDateTime(applyTime(document, context), timezone)} unless you change or cancel it.`
            : ""
      }`,
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
      today: localDateInTimeZone(context.now(), timezone),
    }),
  };
}

/**
 * The user keeps the shown version as it is (`Keep the plan`, `Forget the
 * change`): the change they asked for is dropped, and the plan applies at its
 * deadline, or at the next check if that has passed.
 */
async function keep(options, context) {
  const planId = resolveOpenPlanId(options.planId, context.store, ["pending"]);
  const { timezone } = context.settings();
  let dropped = false;
  const document = await context.store.mutatePlan(
    planId,
    async (current) => {
      if (current.status !== "pending") throw new Error(`The weekly plan for ${formatWeekLabel(current.weekStart)} is ${current.status}.`);
      if (options.version !== current.currentVersion || current.displayedVersion !== current.currentVersion) {
        throw new Error(`The user was looking at v${options.version}, but the shown version is v${current.displayedVersion ?? "none"}. Show the current version first.`);
      }
      if (!current.revisionHold) return null;
      dropped = true;
      return releaseRevisionHold(current, { now: context.now(), outcome: "kept" });
    },
    { waitMs: context.lockWaitMs },
  );
  const version = document.currentVersion;
  const count = versionEntry(document, version).plan.operations.length;
  const when = formatLocalDateTime(applyTime(document, context), timezone);
  const start = dropped ? `OK, I've dropped that change and kept the plan as shown (v${version}).` : `Nothing was waiting to change, so the plan stays as shown (v${version}).`;
  return {
    status: document.status,
    planId,
    version,
    kept: dropped,
    reviewDeadline: document.reviewDeadline,
    telegramText:
      document.applyHold?.version === version
        ? `${start} It's waiting for your OK before anything is created.`
        : count === 0
          ? `${start} There's nothing to add to Todoist; I'll close it at ${when}.`
          : `${start} I'll create its ${count} Todoist task${count === 1 ? "" : "s"} at ${when} unless you change or cancel it.`,
  };
}

/** When a pending plan's tasks are created: its deadline, or the next check once that has passed. */
function applyTime(document, context) {
  const now = context.now().getTime();
  if (Date.parse(document.reviewDeadline) > now) return document.reviewDeadline;
  const step = context.settings().roundMinutes * 60_000;
  return new Date(Math.ceil((now + 1) / step) * step).toISOString();
}

/**
 * The change came after the plan stopped being open: it is being applied, was
 * applied, or was cancelled. Nothing is rolled back or pretended away.
 */
function notRevisable(document, timezone) {
  const week = formatWeekLabel(document.weekStart);
  const base = { status: document.status, planId: document.planId, version: document.currentVersion, changed: false, telegramText: null };
  if (document.status === "applying") {
    return { ...base, message: `The plan for ${week} is being applied right now, before this change could be made. Tell the user, check status in a minute, then follow the guide's "After A Plan Was Applied" section.` };
  }
  if (document.status === "cancelled") {
    return { ...base, message: `The plan for ${week} was cancelled, so there is nothing to change. Ask whether they want a new plan for that week.` };
  }
  const counts = document.apply ? countCreated(document) : null;
  return {
    ...base,
    appliedAt: document.apply?.finishedAt ?? null,
    appliedVersion: document.apply?.version ?? null,
    message: `v${document.apply?.version ?? document.currentVersion} of the plan for ${week} was ${document.status === "failed" ? "not applied (it failed)" : `applied at ${formatLocalDateTime(document.apply?.finishedAt ?? document.updatedAt, timezone)}${counts === null ? "" : ` (${counts} task${counts === 1 ? "" : "s"} created)`}`} before this change could be made, so revise can't change it and nothing was undone. Say so plainly, then follow the guide's "After A Plan Was Applied" section.`,
  };
}

function countCreated(document) {
  return Object.values(document.apply?.outcomes ?? {}).filter((outcome) => outcome.status === "created").length;
}

function requireQuestion(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("ask must be the one question to ask the user, as text.");
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length > 300) throw new Error("ask must be at most 300 characters.");
  return text;
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
    lockWaitMs: context.lockWaitMs,
  });
  const week = formatWeekLabel(result.document.weekStart);
  if (result.reason === "change-open") {
    const hold = result.document.revisionHold;
    return {
      status: "not_accepted",
      planId,
      applied: false,
      telegramText: null,
      message: `The user asked to change v${result.document.currentVersion} at ${formatLocalDateTime(hold.requestedAt, context.settings().timezone)} and that change isn't finished, so this reply is not taken as acceptance${hold.question ? `: it most likely answers your question (${hold.question.replace(/\s+/g, " ")}), so finish the change with revise` : ""}. Nothing was created. If they clearly want the plan as shown without their change, run keep --version ${result.document.currentVersion}; after that an OK applies it.`,
    };
  }
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
  const document = await context.store.mutatePlan(
    planId,
    async (current) => cancelPlan(current, { now: context.now(), reason: options.reason ?? null }),
    { waitMs: context.lockWaitMs },
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
  const version = document.currentVersion;
  if (document.status === "draft") {
    // Showing a draft here would not start its window, and an OK to it could not apply.
    return {
      status: document.status,
      planId: document.planId,
      version,
      reviewDeadline: null,
      telegramText: null,
      message: `This plan was never shown, so it will not apply. To show it, run npm run --silent weekly-plan -- propose --reply --input-json '{"weekStart":"${document.weekStart}"}' and reply with its telegramText exactly; that starts its 12-hour review window.`,
    };
  }
  const { timezone } = context.settings();
  const deadline = document.reviewDeadline ?? computeReviewDeadline(context.now().toISOString(), reviewOptions(context));
  const changeOpen = document.status === "pending" && Boolean(document.revisionHold);
  const header =
    document.status === "pending"
      ? changeOpen
        ? `On hold: you asked for a change at ${formatLocalDateTime(document.revisionHold.requestedAt, timezone)} that isn't finished${document.revisionHold.question ? ` (I asked: ${document.revisionHold.question})` : ""}, so nothing is created on its own.`
        : document.applyHold?.version === version
          ? "Waiting for your OK: I couldn't read Todoist when I made this plan, and that week has tasks it didn't account for, so nothing is created automatically."
          : null
      : `Status: ${document.status}${document.apply ? ` (v${document.apply.version})` : ""}.`;
  const text = formatPlanMessage(document, {
    version,
    deadline,
    changeSummary: versionEntry(document, version).changeSummary,
    timezone,
    today: localDateInTimeZone(context.now(), timezone),
    held: changeOpen,
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
          ? `Weekly plan for ${week} is waiting for your golf answers${missing.length > 0 ? ` (${missing.join(" and ")})` : ""}; nothing is created until you've seen the full plan. Answer, or ask for the plan and I'll use defaults for the rest.`
          : `Weekly plan for ${week} couldn't ask its golf questions yet; nothing will be created. Ask for the plan and I'll build it with defaults.`,
      );
    } else if (plan.status === "draft") {
      lines.push(
        plan.deliveryAttempts
          ? `Weekly plan for ${week} (v${plan.currentVersion}) couldn't be delivered yet (${plan.deliveryAttempts} ${plan.deliveryAttempts === 1 ? "try" : "tries"}; last error: ${plan.deliveryError}). It won't apply until you've seen it; the next try is at ${formatLocalDateTime(plan.nextDeliveryAt, timezone)}.`
          : `Weekly plan for ${week} is a draft (v${plan.currentVersion}); it was not shown yet and will not apply.`,
      );
    } else if (plan.status === "applying") lines.push(`Weekly plan for ${week} (v${plan.currentVersion}) is being applied now.`);
    else if (plan.changeOnHold) {
      lines.push(
        `Weekly plan for ${week} (v${plan.currentVersion}) is on hold: you asked for a change at ${formatLocalDateTime(plan.changeOnHold.requestedAt, timezone)} that isn't finished${plan.changeOnHold.question ? ` (I asked: ${plan.changeOnHold.question.replace(/\s+/g, " ")})` : ""}. Nothing is created on its own until you finish the change, keep the plan as shown, or skip the week.`,
      );
    } else if (plan.waitingForOk) {
      lines.push(
        `Weekly plan for ${week} (v${plan.currentVersion}) is waiting for your OK: I couldn't read Todoist when I made it, and that week has tasks it didn't account for. Nothing is created until you reply OK, change it or skip it.`,
      );
    } else lines.push(`Weekly plan for ${week} is pending (v${plan.currentVersion}); I'll create its tasks at ${formatLocalDateTime(plan.reviewDeadline, timezone)} unless you change or cancel it.`);
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
  const today = localDateInTimeZone(now, context.settings().timezone);
  const summaries = [];
  let failures = 0;
  // A proposal the scheduled job could not deliver is sent again. Only a send
  // that reaches Telegram shows it and starts its 12-hour window; a failed one
  // is recorded on the draft quietly, since Telegram is what is failing.
  for (const document of store.listPlans()) {
    if (!isDeliveryRetryDue(document, now, { today })) continue;
    try {
      await display(document.planId, { send: true }, context);
    } catch (error) {
      if (error.code === "PLAN_LOCKED" || error.deliveryFailed) continue;
      // Anything else pauses like a failed send, and the same error is reported once, not at every check.
      try {
        await store.mutatePlan(document.planId, async (current) => (current.status === "draft" ? recordDeliveryFailure(current, { error: error.message, now }) : null));
      } catch {
        // The next check tries again.
      }
      if (document.delivery?.lastError !== deliveryErrorText(error.message)) {
        failures += 1;
        summaries.push(`Weekly plan ${document.weekId} could not be sent: ${error.message}`);
      }
    }
  }
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
  // A change the user asked for that was never finished kept a shown plan
  // from applying. That is said once, so silence never looks like a created
  // plan; the old version never resumes on its own.
  for (const document of store.listPlans()) {
    if (!isRevisionHoldReportDue(document, now)) continue;
    try {
      const reported = await store.mutatePlan(document.planId, async (current) =>
        isRevisionHoldReportDue(current, now) ? recordRevisionHoldReported(current, { now }) : null,
      );
      if (reported.revisionHold?.reportedAt === now.toISOString()) summaries.push(formatRevisionHold(reported, { timezone: context.settings().timezone }));
    } catch (error) {
      if (error.code === "PLAN_LOCKED") continue;
      failures += 1;
      summaries.push(`Weekly plan ${document.weekId} is on hold for a change, and that couldn't be recorded: ${error.message}`);
    }
  }
  return { text: summaries.length > 0 ? summaries.join("\n\n") : "NO_REPLY", failures };
}

/**
 * A change after the plan was applied. Its tasks exist, so nothing is
 * revised or undone: the week the user now wants is built with the same
 * planner from the applied version and their change (grounded in their words),
 * compared with the plan's tasks as Todoist holds them now, and the exact
 * changes are stored as one proposal for the user's approval. Nothing in
 * Todoist changes here.
 */
async function reconcile(options, context) {
  const changes = await readJsonOption(options.changesJson, options.changesJsonStdin, context.stdin, "changes");
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new Error("reconcile needs --changes-json or --changes-json-stdin with a JSON object.");
  }
  const store = context.store;
  const { config, food } = context.planning();
  const { timezone } = context.settings();
  const now = context.now();
  const today = localDateInTimeZone(now, timezone);
  const planId = options.planId ?? resolveAppliedPlanId(store, today);
  const document = store.readPlan(planId);
  if (!isReconcilable(document)) {
    throw new Error(
      ["draft", "pending"].includes(document.status)
        ? "That plan hasn't been applied yet; change it with revise."
        : `The weekly plan for ${formatWeekLabel(document.weekStart)} is ${document.status}, so its tasks can't be reconciled.`,
    );
  }
  const base = reconciliationBase(document);
  const routines = changes.golf ? readSavedGolfRoutines(context.memoryPath) : null;
  const golfContext = routines
    ? { today, previousWeek: previousGolfWeek(store.listPlans(), document.weekStart), normalWeekText: routines.normalWeek, saved: routines.saved }
    : { today };
  let changed;
  try {
    changed = applyWeeklyPlanChanges(base.inputs, base.plan ?? buildWeeklyPlan(base.inputs, { config, food, today }), changes, { config, food, golfContext });
  } catch (error) {
    if (error instanceof GolfInputError) return clarification(planId, error.problems);
    if (error instanceof RecipeInputError) return recipeClarification(planId, error);
    throw error;
  }
  const target = buildWeeklyPlan(changed.inputs, { config, food, today });
  await resolveConfiguredTarget(target, config, context);

  const todoist = createReconciliationTodoistGateway(context.todoist());
  const read = await readOpenTasksWithRetry(todoist, {
    ...(context.sleep ? { sleep: context.sleep } : {}),
    ...(context.retryDelaysMs ? { retryDelaysMs: context.retryDelaysMs } : {}),
  });
  if (read.error) throw new Error(`I couldn't read Todoist, so I can't compare the plan's tasks: ${read.error.message}. Nothing was changed.`);
  const open = new Set(read.tasks.map((task) => String(task.id)));
  const closed = await closedTaskStates(todoist, Object.values(base.expected).map((entry) => entry.taskId).filter((taskId) => !open.has(taskId)));
  const planned = planReconciliation({ expected: base.expected, target: target.operations, openTasks: read.tasks, closed, today });
  const record = createReconciliationRecord(document, { base, summary: changed.summary, targetInputs: changed.inputs, targetOperations: target.operations, planned, now });
  if (record.changes.length === 0) {
    return { status: "unchanged", planId, proposalId: null, changes: 0, telegramText: formatReconciliationProposal(document, record) };
  }
  let proposal = record;
  const stored = await store.mutatePlan(
    planId,
    async (current) => {
      if (!isReconcilable(current) || reconciliationBase(current).from !== base.from) {
        throw new Error("The plan's tasks changed while I compared them. Nothing was changed; ask again.");
      }
      proposal = { ...record, id: `r${(current.reconciliations ?? []).length + 1}` };
      return addReconciliation(current, proposal);
    },
    { waitMs: context.lockWaitMs },
  );
  return {
    status: "proposed",
    planId,
    proposalId: proposal.id,
    changes: proposal.changes.length,
    telegramText: formatReconciliationProposal(stored, proposal),
    message: `Reply with telegramText exactly. Only an explicit approval of it (Approve, Yes, OK) is carried out, with reconcile-apply --plan-id ${planId} --proposal-id ${proposal.id} --reply-text "EXACT_REPLY"; anything else changes nothing.`,
  };
}

/** Makes exactly a stored proposal's changes, after the user's explicit approval of it. */
async function reconcileApply(options, context) {
  const store = context.store;
  const planId = options.planId ?? resolveProposalPlanId(store, options.proposalId);
  const result = await applyReconciliation({
    store,
    planId,
    proposalId: options.proposalId,
    replyText: options.replyText,
    todoist: createReconciliationTodoistGateway(context.todoist()),
    now: context.now,
    ...(context.sleep ? { sleep: context.sleep } : {}),
    ...(context.retryDelaysMs ? { retryDelaysMs: context.retryDelaysMs } : {}),
    timezone: context.settings().timezone,
    lockWaitMs: context.lockWaitMs,
  });
  if (result.status === "not_approved") {
    return {
      status: "not_approved",
      planId,
      telegramText: null,
      message: "The reply is not an explicit approval, so nothing was changed. If they said no, reply that the tasks stay as they are.",
    };
  }
  return { status: result.status, planId, proposalId: options.proposalId, telegramText: result.telegramText };
}

/** Whether a plan task that is no longer open was completed ("done") or removed ("gone"); "unknown" when Todoist doesn't say. */
async function closedTaskStates(todoist, taskIds) {
  const states = new Map();
  for (const taskId of taskIds) {
    try {
      const task = await todoist.getTask(taskId);
      states.set(taskId, task?.checked || task?.is_completed || task?.completed_at ? "done" : task?.is_deleted ? "gone" : "unknown");
    } catch (error) {
      states.set(taskId, /request failed: 404\b/.test(String(error?.message)) ? "gone" : "unknown");
    }
  }
  return states;
}

/** This or next week's applied plan: the one a change after the apply is about. */
function resolveAppliedPlanId(store, today) {
  const current = store.listPlans().filter((plan) => plan.weekEnd >= today);
  const plans = current.filter(isReconcilable);
  if (plans.length === 1) return plans[0].planId;
  if (plans.length > 1) throw new Error(`Several applied weekly plans are current (${plans.map((plan) => plan.planId).join(", ")}); pass --plan-id.`);
  if (current.some((plan) => ["draft", "pending"].includes(plan.status))) throw new Error("That plan hasn't been applied yet; change it with revise.");
  throw new Error("There is no applied weekly plan for this or next week.");
}

/** The plan a proposal belongs to: the one where it is open, else the only one that has it (so a repeat says what became of it). */
function resolveProposalPlanId(store, proposalId) {
  const plans = store.listPlans().filter((plan) => (plan.reconciliations ?? []).some((record) => record.id === proposalId));
  const open = plans.filter((plan) => plan.reconciliations.some((record) => record.id === proposalId && ["proposed", "applying"].includes(record.status)));
  if (open.length === 1) return open[0].planId;
  if (open.length > 1 || plans.length > 1) throw new Error(`Several weekly plans have a proposal ${proposalId}; pass --plan-id.`);
  if (plans.length === 1) return plans[0].planId;
  throw new Error(`There is no open proposal ${proposalId}. Ask again and I'll compare the tasks afresh.`);
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

/**
 * The plan a change is for: the open one, or, when none is open, this or next
 * week's plan that was applied (or is being applied) before the change came,
 * so the reply can say so instead of "no pending plan".
 */
function resolveRevisablePlanId(planId, context) {
  if (planId) return planId;
  const store = context.store;
  try {
    return resolveOpenPlanId(null, store, ["draft", "pending"]);
  } catch (error) {
    const plans = store.listPlans();
    if (plans.some((plan) => ["awaiting_input", "draft", "pending"].includes(plan.status))) throw error;
    const today = localDateInTimeZone(context.now(), context.settings().timezone);
    const closed = plans.filter((plan) => plan.weekEnd >= today && ["applying", "applied", "applied_with_errors", "failed"].includes(plan.status)).at(-1);
    if (!closed) throw error;
    return closed.planId;
  }
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
