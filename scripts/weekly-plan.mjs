#!/usr/bin/env node
/**
 * Weekly plan CLI.
 *
 *   propose   preview next week's plan, or store and show it (--send or --reply)
 *   revise    store a new version from structured changes and restart the review window
 *   accept    apply the displayed version now after an explicit OK
 *   cancel    cancel a draft or pending plan; nothing is created
 *   show      print the current version
 *   status    read-only summary: pending? when? which version? applied?
 *   apply-due deterministic deadline check used by the scheduled command job
 *   install   install or update the two scheduled jobs through the Gateway cron CLI
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  weekdayIndex,
} from "./lib/weekly-plan.mjs";
import {
  OPEN_STATUSES,
  addPlanRevision,
  cancelPlan,
  createPlanDocument,
  createWeeklyPlanStore,
  isPlanDue,
  markPlanDisplayed,
  newPlanId,
  summarizeWeeklyPlans,
  versionEntry,
} from "./lib/weekly-plan-store.mjs";
import { applyWeeklyPlan, createWeeklyPlanTodoistGateway } from "./lib/weekly-plan-apply.mjs";
import { buildWeeklyPlanCronCommands, buildWeeklyPlanCronJobs, weeklyPlanJobStatus } from "./lib/weekly-plan-cron.mjs";
import { localDateInTimeZone } from "./lib/routine-skips.mjs";

const execFileAsync = promisify(execFile);
const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");
const COMMANDS = ["propose", "revise", "accept", "cancel", "show", "status", "apply-due", "install", "help"];

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
          "npm run --silent weekly-plan -- revise --expect-version 1 --changes-json '{\"targets\":{\"gym\":3}}'",
          "npm run --silent weekly-plan -- accept --version 2 --reply-text \"OK\"",
          "npm run --silent weekly-plan -- cancel --reason \"Skip this week\"",
        ],
      };
    case "propose":
      return propose(parsed.options, context);
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
  const openclawCommand = () => resolveGatewayOpenClawCommand(env);
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
  const now = context.now();
  const { timezone } = context.settings();
  const weekStart = input.weekStart ?? nextWeekStart(now, timezone);
  const thisMonday = mondayOf(localDateInTimeZone(now, timezone));
  if (typeof weekStart !== "string" || weekStart < thisMonday) {
    throw new Error(`weekStart must be a Monday from ${thisMonday} onward.`);
  }

  const store = context.store;
  const plans = store.listPlans();
  const active = plans.filter((plan) => plan.weekStart === weekStart && plan.status !== "cancelled").at(-1);
  if (active) {
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
  let existingTasks = input.existingTasks;
  if (existingTasks === undefined) {
    try {
      existingTasks = await context.todoist().getTasks({});
      if (!Array.isArray(existingTasks)) throw new Error("Todoist did not return a task list.");
    } catch (error) {
      existingTasks = [];
      notes.push("I couldn't read Todoist just now; duplicates are re-checked before anything is created.");
    }
  }

  const previous = plans
    .filter((plan) => plan.weekStart < weekStart && plan.status !== "cancelled" && plan.status !== "draft")
    .at(-1);
  const inputs = buildInitialPlanInputs(
    { ...input, existingTasks },
    { config, weekStart, previousTargets: previous ? versionEntry(previous, previous.currentVersion).plan.targets : null },
  );
  inputs.notes.push(...notes);
  const plan = buildWeeklyPlan(inputs, { config, food });
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
      }),
      message: "Preview only. Nothing was stored, so nothing will apply.",
    };
  }

  // Written as a draft before anything is shown, so a failed send never leaves
  // a displayed plan without a stored record, and a draft never applies.
  store.writePlan(document);
  return display(planId, options, context);
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
  const planId = resolveOpenPlanId(options.planId, context.store);
  const { config, food } = context.planning();
  const { timezone, reviewWindowHours, roundMinutes } = context.settings();
  let unchanged = false;

  const document = await context.store.mutatePlan(planId, async (current) => {
    const entry = versionEntry(current, current.currentVersion);
    if (options.expectVersion !== current.currentVersion) {
      throw new Error(
        `The user was looking at v${options.expectVersion}, but the current version is v${current.currentVersion}. Show the current version first.`,
      );
    }
    const { inputs, summary, note } = applyWeeklyPlanChanges(entry.inputs, entry.plan, changes, { config, food });
    const plan = buildWeeklyPlan(inputs, { config, food });
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
  const planId = resolveOpenPlanId(options.planId, context.store);
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
  const planId = resolveOpenPlanId(options.planId, context.store);
  const document = await context.store.mutatePlan(planId, async (current) =>
    cancelPlan(current, { now: context.now(), reason: options.reason ?? null }),
  );
  return {
    status: document.status,
    planId,
    telegramText: `Cancelled the weekly plan for ${formatWeekLabel(document.weekStart)} (v${document.currentVersion}). Nothing was created in Todoist.`,
  };
}

async function show(options, context) {
  const store = context.store;
  const plans = store.listPlans();
  const document = options.planId
    ? store.readPlan(options.planId)
    : plans.filter((plan) => OPEN_STATUSES.includes(plan.status)).at(-1) ?? plans.at(-1);
  if (!document) return { status: "none", telegramText: "There is no weekly plan yet." };
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
    if (plan.status === "draft") lines.push(`Weekly plan for ${week} is a draft (v${plan.currentVersion}); it was not shown yet and will not apply.`);
    else if (plan.status === "applying") lines.push(`Weekly plan for ${week} (v${plan.currentVersion}) is being applied now.`);
    else lines.push(`Weekly plan for ${week} is pending (v${plan.currentVersion}); I'll create its tasks at ${formatLocalDateTime(plan.reviewDeadline, timezone)} unless you change or cancel it.`);
  }
  if (summary.pending.length === 0) lines.push("No weekly plan is pending.");
  const latest = summary.latest;
  if (latest && !["draft", "pending", "applying"].includes(latest.status)) {
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
        : `Last plan (${week}) was ${outcome}.`,
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

function resolveOpenPlanId(planId, store) {
  if (planId) return planId;
  const open = store.listPlans().filter((plan) => ["draft", "pending"].includes(plan.status));
  if (open.length === 1) return open[0].planId;
  if (open.length === 0) throw new Error("There is no pending weekly plan.");
  throw new Error(`Several weekly plans are open (${open.map((plan) => plan.planId).join(", ")}); pass --plan-id.`);
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

/** The Gateway's own CLI first, so a stale global `openclaw` never talks to a newer Gateway. */
export function resolveGatewayOpenClawCommand(env = process.env) {
  if (env.OPENCLAW_CLI) return env.OPENCLAW_CLI;
  const gatewayCli = join(env.HOME || homedir(), ".openclaw/bin/openclaw");
  if (existsSync(gatewayCli)) return gatewayCli;
  return resolveOpenClawCommand(env) ?? "openclaw";
}

export function formatWeeklyPlanCliResult(command, result, { json = false, text = false } = {}) {
  if (command === "apply-due") return result.text;
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
