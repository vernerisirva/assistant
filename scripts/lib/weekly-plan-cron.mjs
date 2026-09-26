/**
 * The two scheduled jobs behind the weekly plan, installed through the
 * OpenClaw Gateway cron CLI (the Gateway owns its cron store; writing the old
 * jobs.json file would not reach the scheduler).
 *
 * - propose: a model-backed turn on Saturday that gathers read-only context
 *   and calls the deterministic planner, which stores and sends the proposal.
 * - apply-due: a command job with no model at all. It runs the deterministic
 *   apply check every few minutes, so a deadline that moves after a revision
 *   needs no cron rewrite.
 */
import { maskCronCommandForDisplay } from "./routine-cron.mjs";

export const WEEKLY_PLAN_JOB_PREFIX = "Assistant weekly plan:";
export const WEEKLY_PLAN_PROPOSE_JOB = `${WEEKLY_PLAN_JOB_PREFIX} propose`;
export const WEEKLY_PLAN_APPLY_JOB = `${WEEKLY_PLAN_JOB_PREFIX} apply due plans`;

const DAY_NUMBERS = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };

export function buildWeeklyPlanCronJobs(schedules, { telegramUserId, projectRoot, nodePath }) {
  if (!telegramUserId) throw new Error("TELEGRAM_USER_ID is required to install the weekly plan jobs.");
  if (!projectRoot) throw new Error("The project root is required to install the weekly plan jobs.");
  if (!nodePath) throw new Error("A node executable path is required to install the weekly plan jobs.");
  const settings = schedules.weeklyPlan;
  if (!settings) throw new Error("config/schedules.json has no weeklyPlan entry.");

  const { hour, minute } = parseTime(settings.propose.time);
  const day = DAY_NUMBERS[settings.propose.day];
  if (day === undefined) throw new Error(`Unsupported weekly plan day: ${settings.propose.day}`);
  const every = Number(settings.applyCheckEveryMinutes);
  if (!Number.isInteger(every) || every < 1 || every > 60 || 60 % every !== 0) {
    throw new Error("applyCheckEveryMinutes must divide an hour evenly.");
  }

  const delivery = {
    channel: "telegram",
    accountId: "main",
    to: `telegram:${telegramUserId}`,
    bestEffort: true,
  };

  return [
    {
      key: "propose",
      name: WEEKLY_PLAN_PROPOSE_JOB,
      description: "Saturday: prepare and send next week's editable plan. Creates no Todoist tasks.",
      kind: "agentTurn",
      agentId: settings.agent,
      sessionTarget: "isolated",
      sessionKey: `agent:${settings.agent}:telegram:main:direct:${telegramUserId}`,
      wakeMode: "now",
      schedule: { kind: "cron", expr: `${minute} ${hour} * * ${day}`, tz: schedules.timezone },
      message: buildProposeMessage(settings),
      timeoutSeconds: 600,
      delivery,
      enabled: true,
    },
    {
      key: "apply-due",
      name: WEEKLY_PLAN_APPLY_JOB,
      description: `Every ${every} min: create the Todoist tasks of a displayed weekly plan whose ${settings.reviewWindowHours}-hour review window has passed. No model involved.`,
      kind: "command",
      argv: [nodePath, "scripts/weekly-plan.mjs", "apply-due"],
      cwd: projectRoot,
      schedule: { kind: "cron", expr: `*/${every} * * * *`, tz: schedules.timezone },
      timeoutSeconds: 300,
      delivery,
      enabled: true,
    },
  ];
}

export function buildProposeMessage(settings) {
  return [
    "Scheduled assistant routine: weekly-plan (Saturday proposal). The user explicitly asked for this weekly planning automation.",
    "Goal: prepare next week's (Monday-Sunday, Europe/Stockholm) food, shopping, gym, stretching, golf-round and golf-practice plan as a concrete editable proposal. Do not run a questionnaire.",
    "1. Gather context read-only: next week's Calendar for busy, heavy or unavailable days; non-sensitive memory via npm run memory -- list; last week's plan via npm run --silent weekly-plan -- status --json. Do not read sensitive memory.",
    "2. Leave targets out unless context gives a clear reason to change them; the planner then uses last week's targets or the configured defaults. Add at most one short question, and only when a genuinely important preference is missing.",
    "3. Run from the assistant repo: npm run --silent weekly-plan -- propose --send --input-json-stdin with the input JSON in a quoted heredoc. Input fields: targets {gym, golfRound, golfPractice, stretch, mealPrep}, days {weekday: light|normal|heavy|unavailable}, preferences {activity: {preferredDays, avoidDays}}, food {mealIds, excludeIngredients, addMeals, addShopping, customMeals}, golfPracticeFocus, question, notes. The planner reads existing Todoist tasks itself.",
    "4. If the command reports sent true, or reports that a plan for that week already exists, return exactly NO_REPLY. If it fails, return one short line saying the weekly plan could not be prepared and why.",
    `Hard limits: the proposal creates no Todoist tasks. Do not create, edit, complete, move or delete Todoist tasks yourself; do not write Calendar, Gmail or memory; do not book or buy anything. Task creation happens later in the deterministic apply check after the ${settings.reviewWindowHours}-hour review window, from the stored plan only.`,
  ].join("\n");
}

export function buildWeeklyPlanCronCommands(jobs, { existingJobs = [], gatewayToken, openclawCommand = "openclaw" } = {}) {
  return jobs.map((job) => {
    const existing = existingJobs.find((candidate) => candidate.name === job.name);
    const args = existing ? ["cron", "edit", existing.id, "--enable", ...jobArgs(job)] : ["cron", "add", ...jobArgs(job), "--json"];
    if (gatewayToken) args.push("--token", gatewayToken);
    return {
      action: existing ? "edit" : "add",
      jobName: job.name,
      key: job.key,
      command: openclawCommand,
      args,
      display: maskCronCommandForDisplay({ command: openclawCommand, args }),
    };
  });
}

function jobArgs(job) {
  const shared = [
    "--name",
    job.name,
    "--description",
    job.description,
    "--cron",
    job.schedule.expr,
    "--tz",
    job.schedule.tz,
    "--exact",
    "--timeout-seconds",
    String(job.timeoutSeconds),
    "--announce",
    "--channel",
    job.delivery.channel,
    "--to",
    job.delivery.to,
    "--account",
    job.delivery.accountId,
    "--best-effort-deliver",
  ];
  if (job.kind === "command") {
    return [...shared, "--command-argv", JSON.stringify(job.argv), "--command-cwd", job.cwd];
  }
  return [
    ...shared,
    "--agent",
    job.agentId,
    "--session",
    job.sessionTarget,
    "--session-key",
    job.sessionKey,
    "--wake",
    job.wakeMode,
    "--message",
    job.message,
  ];
}

/** Read-only view of installed weekly plan jobs from `openclaw cron list --json`. */
export function weeklyPlanJobStatus(jobs) {
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => typeof job?.name === "string" && job.name.startsWith(WEEKLY_PLAN_JOB_PREFIX))
    .map((job) => ({
      id: job.id,
      name: job.name,
      enabled: job.enabled !== false,
      schedule: job.schedule?.expr ?? null,
      timezone: job.schedule?.tz ?? null,
      payload: job.payload?.kind ?? null,
      nextRunAt: job.state?.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : null,
      lastStatus: job.state?.lastStatus ?? job.state?.lastRunStatus ?? null,
    }));
}

function parseTime(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time ?? "");
  if (!match) throw new Error(`Invalid weekly plan time: ${time}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}
