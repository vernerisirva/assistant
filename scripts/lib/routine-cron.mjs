import { randomUUID } from "node:crypto";
import {
  DEFAULT_ROUTINE_SKIP_TIMEZONE,
  isRoutineSkipped,
  localDateInTimeZone,
} from "./routine-skips.mjs";

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

export function buildRoutineCronCommands(
  jobs,
  {
    existingJobs = [],
    gatewayToken,
    openclawCommand = "openclaw",
  } = {},
) {
  return jobs.map((job) => {
    const existingJob = existingJobs.find((candidate) => candidate.name === job.name);
    const action = existingJob ? "edit" : "add";
    const args = action === "edit"
      ? buildEditArgs(existingJob.id, job, gatewayToken)
      : buildAddArgs(job, gatewayToken);

    return {
      action,
      jobName: job.name,
      routineId: job.routineId,
      command: openclawCommand,
      args,
      display: maskCronCommandForDisplay({ command: openclawCommand, args }),
    };
  });
}

export function maskCronCommandForDisplay({ command, args }) {
  const maskedArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    maskedArgs.push(args[index]);
    if (args[index] === "--token" && args[index + 1]) {
      maskedArgs.push("<redacted>");
      index += 1;
    }
  }

  return [command, ...maskedArgs].join(" ");
}

export function upsertRoutineCronJobs(
  existingStore,
  jobs,
  {
    nowMs = Date.now(),
    idGenerator = randomUUID,
  } = {},
) {
  const existingJobs = Array.isArray(existingStore?.jobs) ? existingStore.jobs : [];
  const routineNames = new Set(jobs.map((job) => job.name));
  const results = [];
  const upsertedJobs = jobs.map((job) => {
    const existingJob = existingJobs.find((candidate) => candidate.name === job.name);
    const action = existingJob ? "edit" : "add";
    results.push({ action, jobName: job.name, routineId: job.routineId });
    return toOpenClawCronJob(job, {
      existingJob,
      nowMs,
      id: existingJob?.id ?? idGenerator(),
    });
  });
  const unrelatedJobs = existingJobs.filter((job) => !routineNames.has(job.name));

  return {
    store: {
      version: existingStore?.version ?? 1,
      jobs: [...unrelatedJobs, ...upsertedJobs],
    },
    results,
  };
}

export function routineCronStatus(
  existingStore,
  existingState = {},
  {
    skipStore,
    now = new Date(),
    timezone = DEFAULT_ROUTINE_SKIP_TIMEZONE,
  } = {},
) {
  const jobs = Array.isArray(existingStore?.jobs) ? existingStore.jobs : [];
  const today = localDateInTimeZone(now, timezone);
  return jobs
    .filter((job) => isRoutineJob(job))
    .map((job) => {
      const state = existingState.jobs?.[job.id]?.state ?? {};
      const routineId = routineIdFromJobName(job.name);
      const skippedToday = skipStore ? isRoutineSkipped(skipStore, routineId, today, timezone) : false;
      return {
        routineId,
        name: job.name,
        enabled: job.enabled !== false,
        cron: job.schedule?.expr,
        timezone: job.schedule?.tz,
        nextRunAt: state.nextRunAtMs ? new Date(state.nextRunAtMs).toISOString() : null,
        lastStatus: state.lastStatus ?? null,
        skippedToday,
        skipDate: skippedToday ? today : null,
      };
    });
}

export function updateRoutineCronEnabled(existingStore, routineId, enabled) {
  const jobName = routineJobName(routineId);
  const { store, job } = updateRoutineCronJob(existingStore, jobName, (candidate) => ({
    ...candidate,
    enabled,
  }));

  return {
    store,
    result: {
      action: enabled ? "enable" : "disable",
      routineId,
      jobName: job.name,
    },
  };
}

export function updateRoutineCronTime(existingStore, routineId, time) {
  const parsedTime = parseTime(time);
  const jobName = routineJobName(routineId);
  const { store, job } = updateRoutineCronJob(existingStore, jobName, (candidate) => ({
    ...candidate,
    schedule: {
      ...candidate.schedule,
      expr: cronExpressionWithTime(candidate.schedule?.expr, parsedTime),
    },
  }));

  return {
    store,
    result: {
      action: "set-time",
      routineId,
      jobName: job.name,
      cron: job.schedule.expr,
    },
  };
}

function buildRoutineCronJob(routine, { telegramUserId, schedule }) {
  return {
    routineId: routine.id,
    agentId: routine.agent,
    name: `Assistant routine: ${routine.id}`,
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

function routineJobName(routineId) {
  return `Assistant routine: ${routineId}`;
}

function routineIdFromJobName(name) {
  return name.slice("Assistant routine: ".length);
}

function isRoutineJob(job) {
  return typeof job?.name === "string" && job.name.startsWith("Assistant routine:");
}

function updateRoutineCronJob(existingStore, jobName, updater) {
  const jobs = Array.isArray(existingStore?.jobs) ? existingStore.jobs : [];
  let updatedJob;
  const updatedJobs = jobs.map((job) => {
    if (job.name !== jobName) return job;
    updatedJob = updater(job);
    return updatedJob;
  });

  if (!updatedJob) {
    throw new Error(`Routine cron job not installed: ${jobName}`);
  }

  return {
    store: {
      version: existingStore?.version ?? 1,
      jobs: updatedJobs,
    },
    job: updatedJob,
  };
}

function toOpenClawCronJob(job, { existingJob, nowMs, id }) {
  return {
    id,
    agentId: job.agentId,
    sessionKey: job.sessionKey,
    name: job.name,
    description: job.description,
    enabled: job.enabled !== false,
    createdAtMs: existingJob?.createdAtMs ?? nowMs,
    schedule: job.schedule,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload: {
      kind: "agentTurn",
      message: job.message,
      timeoutSeconds: job.timeoutSeconds,
    },
    delivery: {
      mode: "announce",
      to: job.delivery.to,
      channel: job.delivery.channel,
      accountId: job.delivery.accountId,
      bestEffort: job.delivery.bestEffort,
    },
    state: existingJob?.state ?? {},
  };
}

function buildRoutineMessage(routine) {
  return [
    `Scheduled assistant routine: ${routine.id}.`,
    `First run npm run --silent routines:skips -- --json from the assistant repo and inspect ${routine.id} for today's Europe/Stockholm date.`,
    `If ${routine.id} is skippedToday, return exactly NO_REPLY as your final answer and do no routine work.`,
    `If ${routine.id} is not skippedToday, run npm run routine -- ${routine.id} from the assistant repo and use the returned telegramPrompt as the briefing template.`,
    "Use the skip store result from that command as the source of truth for skippedToday.",
    "Gather or summarize live Calendar, Gmail, Todoist, health, food, and memory context where available.",
    "Return exactly one concise Telegram check-in for Verneri as your final answer. Do not call Telegram/message tools; cron delivery will send the final answer.",
    "No side effects without approval: do not send email, edit calendar events, change Todoist, book golf, buy anything, submit forms, or store sensitive memory without Telegram approval.",
    "Feedback loop: include one small line asking whether the timing, tone, or detail level should change. If feedback suggests a stable preference, ask before storing it as memory; do not silently remember inferred preferences.",
  ].join("\n");
}

function buildAddArgs(job, gatewayToken) {
  return [
    "cron",
    "add",
    ...sharedCronArgs(job),
    "--announce",
    "--channel",
    job.delivery.channel,
    "--to",
    job.delivery.to,
    "--account",
    job.delivery.accountId,
    "--best-effort-deliver",
    ...enabledArgs(job, { add: true }),
    "--json",
    ...tokenArgs(gatewayToken),
  ];
}

function buildEditArgs(jobId, job, gatewayToken) {
  return [
    "cron",
    "edit",
    jobId,
    ...enabledArgs(job),
    ...sharedCronArgs(job),
    "--announce",
    "--channel",
    job.delivery.channel,
    "--to",
    job.delivery.to,
    "--account",
    job.delivery.accountId,
    "--best-effort-deliver",
    ...tokenArgs(gatewayToken),
  ];
}

function sharedCronArgs(job) {
  return [
    "--name",
    job.name,
    "--description",
    job.description,
    "--agent",
    job.agentId,
    "--session",
    job.sessionTarget,
    "--session-key",
    job.sessionKey,
    "--wake",
    job.wakeMode,
    "--cron",
    job.schedule.expr,
    "--tz",
    job.schedule.tz,
    "--exact",
    "--message",
    job.message,
    "--timeout-seconds",
    String(job.timeoutSeconds),
  ];
}

function enabledArgs(job, { add = false } = {}) {
  if (job.enabled === false) {
    return [add ? "--disabled" : "--disable"];
  }
  return add ? [] : ["--enable"];
}

function tokenArgs(gatewayToken) {
  return gatewayToken ? ["--token", gatewayToken] : [];
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

function cronExpressionWithTime(expr, { hour, minute }) {
  const parts = (expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Unsupported routine cron expression: ${expr}`);
  }

  return [String(minute), String(hour), ...parts.slice(2)].join(" ");
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

function parseTime(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time ?? "");
  if (!match) {
    throw new Error(`Invalid routine time: ${time}`);
  }

  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
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
