/**
 * Hilla's scheduled routine check-ins as live OpenClaw Gateway cron jobs.
 *
 * `buildRoutineCronJobs` turns config/schedules.json into the desired jobs.
 * `planRoutineInstall` compares them with the live jobs by exact name and says
 * per routine whether an install adds it, edits only the fields that differ
 * from config, or leaves it alone. Jobs with other names are never touched.
 */
import {
  DEFAULT_ROUTINE_SKIP_TIMEZONE,
  isRoutineSkipped,
  localDateInTimeZone,
} from "./routine-skips.mjs";

// weekly-plan-cron.mjs imports the display helper from here.
export { maskCronCommandForDisplay } from "./live-cron.mjs";

export const ROUTINE_JOB_PREFIX = "Assistant routine: ";

const dayToCronNumber = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

export function buildRoutineCronJobs(schedules, { telegramUserId }) {
  if (!telegramUserId) {
    throw new Error("TELEGRAM_USER_ID is required to install routine cron jobs.");
  }
  if (!/^\d+$/.test(String(telegramUserId))) {
    throw new Error("TELEGRAM_USER_ID must be a numeric Telegram user id.");
  }

  const dailyJobs = schedules.daily.map((routine) =>
    buildRoutineCronJob(routine, {
      telegramUserId,
      schedule: {
        kind: "cron",
        expr: dailyCronExpression(routine),
        tz: schedules.timezone,
      },
    }),
  );

  const weeklyJob = buildRoutineCronJob(schedules.weekly, {
    telegramUserId,
    schedule: {
      kind: "cron",
      expr: weeklyCronExpression(schedules.weekly),
      tz: schedules.timezone,
    },
  });

  return [...dailyJobs, weeklyJob];
}

export function routineJobName(routineId) {
  return `${ROUTINE_JOB_PREFIX}${routineId}`;
}

/** One entry per live routine job, with its run state and today's skip. */
export function routineCronStatus(
  jobs,
  {
    skipStore,
    now = new Date(),
    timezone = DEFAULT_ROUTINE_SKIP_TIMEZONE,
  } = {},
) {
  const today = localDateInTimeZone(now, timezone);
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => isRoutineJob(job))
    .map((job) => {
      const routineId = routineIdFromJobName(job.name);
      const skippedToday = skipStore ? isRoutineSkipped(skipStore, routineId, today, timezone) : false;
      const cron = job.schedule?.kind === "cron";
      return {
        routineId,
        jobId: job.id,
        name: job.name,
        enabled: job.enabled,
        cron: cron ? job.schedule.expr : null,
        timezone: cron ? job.schedule.timezone : null,
        nextRunAt: job.nextRunAt,
        lastRunAt: job.lastRunAt,
        lastStatus: job.lastStatus,
        skippedToday,
        skipDate: skippedToday ? today : null,
      };
    });
}

/** The single live job for a routine id. A missing or duplicated job is an error, never a guess. */
export function findRoutineJob(jobs, routineId) {
  if (typeof routineId !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(routineId)) {
    throw new Error(`Invalid routine id: ${routineId}`);
  }
  const name = routineJobName(routineId);
  const matches = jobs.filter((job) => job.name === name);
  if (matches.length === 0) {
    throw new Error(`Routine cron job not installed: ${name}. Run npm run routines:install first.`);
  }
  if (matches.length > 1) {
    throw new Error(`Several live Gateway jobs are named "${name}" (${matches.map((job) => job.id).join(", ")}).`);
  }
  return matches[0];
}

/**
 * What `routines:install` would do per routine. The whole install stops before
 * any change when a routine name matches more than one live job, or matches a
 * job that is not an agent turn.
 */
export function planRoutineInstall(desiredJobs, liveJobs) {
  return desiredJobs.map((desired) => {
    const matches = liveJobs.filter((job) => job.name === desired.name);
    if (matches.length > 1) {
      throw new Error(
        `Several live Gateway jobs are named "${desired.name}" (${matches.map((job) => job.id).join(", ")}). ` +
          "Remove the extra one before installing so no routine runs twice.",
      );
    }
    const base = { routineId: desired.routineId, jobName: desired.name };
    const [existing] = matches;
    if (!existing) return { ...base, action: "add", jobId: null, changes: [], args: buildAddArgs(desired) };

    if (existing.payload?.kind !== "agentTurn") {
      throw new Error(
        `Live job "${desired.name}" [${existing.id}] runs a ${existing.payload?.kind ?? "unknown"} payload; ` +
          "refusing to turn it into a routine.",
      );
    }
    const differing = ROUTINE_FIELDS.filter((field) => field.differs(existing, desired));
    const changes = differing.map((field) => ({
      field: field.name,
      before: field.show(existing),
      after: field.show(specAsLiveJob(desired)),
    }));
    if (differing.length === 0) return { ...base, action: "unchanged", jobId: existing.id, changes, args: [] };
    return { ...base, action: "edit", jobId: existing.id, changes, args: differing.flatMap((field) => field.args(desired)) };
  });
}

/** The desired job without private routing details, for printing a plan. */
export function publicRoutineJob(job) {
  return {
    routineId: job.routineId,
    name: job.name,
    agentId: job.agentId,
    enabled: job.enabled,
    schedule: job.schedule,
    sessionTarget: job.sessionTarget,
    timeoutSeconds: job.timeoutSeconds,
    delivery: { channel: job.delivery.channel, accountId: job.delivery.accountId, bestEffort: job.delivery.bestEffort },
  };
}

export function cronExpressionWithTime(expr, { hour, minute }) {
  const parts = (expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Unsupported routine cron expression: ${expr}`);
  }

  return [String(minute), String(hour), ...parts.slice(2)].join(" ");
}

export function parseTime(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time ?? "");
  if (!match) {
    throw new Error(`Invalid routine time: ${time}`);
  }

  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

// The fields a routine job owns. Anything else on the live job, such as a
// model or thinking override, is left as the Gateway has it.
const maskRoute = (value) => (typeof value === "string" ? value.replace(/\d{5,}/g, "<telegram-id>") : value);
const ROUTINE_FIELDS = [
  {
    name: "description",
    differs: (live, spec) => (live.description ?? "") !== spec.description,
    show: (job) => job.description,
    args: (spec) => [`--description=${spec.description}`],
  },
  {
    name: "agentId",
    differs: (live, spec) => live.agentId !== spec.agentId,
    show: (job) => job.agentId,
    args: (spec) => [`--agent=${spec.agentId}`],
  },
  {
    name: "enabled",
    differs: (live, spec) => live.enabled !== spec.enabled,
    show: (job) => job.enabled,
    args: (spec) => [spec.enabled ? "--enable" : "--disable"],
  },
  {
    name: "schedule",
    // A job without a stagger runs on time, like the installed `--exact`.
    differs: (live, spec) =>
      live.schedule.kind !== "cron" ||
      live.schedule.expr !== spec.schedule.expr ||
      live.schedule.timezone !== spec.schedule.tz ||
      (live.schedule.staggerMs ?? 0) !== 0,
    show: (job) =>
      job.schedule.kind === "cron"
        ? `cron ${job.schedule.expr} ${job.schedule.timezone ?? "(host timezone)"}${job.schedule.staggerMs ? ` stagger ${job.schedule.staggerMs}ms` : ""}`
        : job.schedule.kind,
    args: (spec) => [`--cron=${spec.schedule.expr}`, `--tz=${spec.schedule.tz}`, "--exact"],
  },
  {
    name: "session",
    differs: (live, spec) =>
      live.sessionTarget !== spec.sessionTarget || live.sessionKey !== spec.sessionKey || live.wakeMode !== spec.wakeMode,
    show: (job) => `${job.sessionTarget} ${maskRoute(job.sessionKey)} wake=${job.wakeMode}`,
    args: (spec) => [`--session=${spec.sessionTarget}`, `--session-key=${spec.sessionKey}`, `--wake=${spec.wakeMode}`],
  },
  {
    name: "payload",
    differs: (live, spec) => live.payload.message !== spec.message || live.payload.timeoutSeconds !== spec.timeoutSeconds,
    show: (job) => `message of ${job.payload.message?.length ?? 0} chars, timeout ${job.payload.timeoutSeconds}s`,
    args: (spec) => [`--message=${spec.message}`, `--timeout-seconds=${spec.timeoutSeconds}`],
  },
  {
    name: "delivery",
    differs: (live, spec) =>
      !live.delivery ||
      live.delivery.mode !== "announce" ||
      live.delivery.channel !== spec.delivery.channel ||
      live.delivery.to !== spec.delivery.to ||
      live.delivery.accountId !== spec.delivery.accountId ||
      live.delivery.bestEffort !== spec.delivery.bestEffort,
    show: (job) =>
      job.delivery
        ? `${job.delivery.mode} ${job.delivery.channel} ${maskRoute(job.delivery.to)} account=${job.delivery.accountId} bestEffort=${job.delivery.bestEffort}`
        : null,
    args: (spec) => [
      "--announce",
      `--channel=${spec.delivery.channel}`,
      `--to=${spec.delivery.to}`,
      `--account=${spec.delivery.accountId}`,
      "--best-effort-deliver",
    ],
  },
];

// The desired spec in the normalized live shape, so one `show` prints both sides.
function specAsLiveJob(spec) {
  return {
    description: spec.description,
    agentId: spec.agentId,
    enabled: spec.enabled,
    schedule: { kind: "cron", expr: spec.schedule.expr, timezone: spec.schedule.tz, staggerMs: 0 },
    sessionTarget: spec.sessionTarget,
    sessionKey: spec.sessionKey,
    wakeMode: spec.wakeMode,
    payload: { kind: "agentTurn", message: spec.message, timeoutSeconds: spec.timeoutSeconds },
    delivery: { mode: "announce", ...spec.delivery },
  };
}

function buildAddArgs(job) {
  return [
    `--name=${job.name}`,
    `--description=${job.description}`,
    `--agent=${job.agentId}`,
    `--session=${job.sessionTarget}`,
    `--session-key=${job.sessionKey}`,
    `--wake=${job.wakeMode}`,
    `--cron=${job.schedule.expr}`,
    `--tz=${job.schedule.tz}`,
    "--exact",
    `--message=${job.message}`,
    `--timeout-seconds=${job.timeoutSeconds}`,
    "--announce",
    `--channel=${job.delivery.channel}`,
    `--to=${job.delivery.to}`,
    `--account=${job.delivery.accountId}`,
    "--best-effort-deliver",
    ...(job.enabled ? [] : ["--disabled"]),
  ];
}

function buildRoutineCronJob(routine, { telegramUserId, schedule }) {
  return {
    routineId: routine.id,
    agentId: routine.agent,
    name: routineJobName(routine.id),
    description: routine.purpose,
    enabled: routine.enabled !== false,
    schedule,
    sessionTarget: "isolated",
    wakeMode: "now",
    sessionKey: `agent:${routine.agent}:telegram:main:direct:${telegramUserId}`,
    message: buildRoutineMessage(routine),
    timeoutSeconds: routine.id === "weekly-review" ? 240 : 180,
    delivery: {
      channel: "telegram",
      accountId: "main",
      to: `telegram:${telegramUserId}`,
      bestEffort: true,
    },
  };
}

function routineIdFromJobName(name) {
  return name.slice(ROUTINE_JOB_PREFIX.length);
}

function isRoutineJob(job) {
  return typeof job?.name === "string" && job.name.startsWith(ROUTINE_JOB_PREFIX);
}

function buildRoutineMessage(routine) {
  return [
    `Scheduled assistant routine: ${routine.id}.`,
    `First run npm run --silent routines:skips -- --json from the assistant repo and inspect ${routine.id} for today's Europe/Stockholm date.`,
    `If ${routine.id} is skippedToday, return exactly NO_REPLY as your final answer and do no routine work.`,
    "Read the skip store result from that command before doing routine work; it is the source of truth for skippedToday.",
    `If ${routine.id} is not skippedToday, run npm run routine -- ${routine.id} from the assistant repo and use the returned telegramPrompt as the briefing template.`,
    "Gather or summarize live Calendar, Gmail, Todoist, health, food, and memory context where available.",
    "Return exactly one concise Telegram check-in for Verneri as your final answer. Do not call Telegram/message tools; cron delivery will send the final answer.",
    "No side effects without approval: do not send email, edit calendar events, change Todoist, book golf, buy anything, submit forms, or store sensitive memory without Telegram approval.",
    "Feedback loop: include one small line asking whether the timing, tone, or detail level should change. If feedback suggests a stable preference, ask before storing it as memory; do not silently remember inferred preferences.",
  ].join("\n");
}

function dailyCronExpression(routine) {
  const time = routine.time ?? midpointTime(routine.window);
  const { hour, minute } = parseTime(time);
  return `${minute} ${hour} * * *`;
}

function weeklyCronExpression(routine) {
  const { hour, minute } = parseTime(routine.time);
  const day = dayToCronNumber[routine.day];
  if (day === undefined) {
    throw new Error(`Unsupported weekly routine day: ${routine.day}`);
  }
  return `${minute} ${hour} * * ${day}`;
}

function midpointTime(window) {
  if (!window?.start || !window?.end) {
    throw new Error("Routine requires either time or window.start/window.end.");
  }

  const start = minutesSinceMidnight(window.start);
  const end = minutesSinceMidnight(window.end);
  const midpoint = Math.round((start + end) / 2);
  return formatTime(midpoint);
}

function minutesSinceMidnight(time) {
  const { hour, minute } = parseTime(time);
  return hour * 60 + minute;
}

function formatTime(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
