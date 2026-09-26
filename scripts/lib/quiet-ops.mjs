/**
 * Quiet ops: status, noise audit and exact-target controls for every live
 * OpenClaw Gateway cron job, working on jobs normalized by live-cron.mjs.
 */
import {
  LIVE_CRON_SOURCE,
  isDailyCronSchedule,
  planCronExpressionChange,
  planEnabledChange,
  planOneShotChange,
} from "./live-cron.mjs";

const DEFAULT_TIMEZONE = "Europe/Stockholm";

/** `redact` masks secrets and the Telegram id in printed names; matching always uses the real name. */
export function quietOpsStatus(jobs, { redact } = {}) {
  const statusJobs = cronJobs(jobs).map((job) => describeQuietJob(job, { redact }));

  return {
    source: LIVE_CRON_SOURCE,
    jobs: statusJobs,
    summary: quietOpsSummary(cronJobs(jobs)),
  };
}

export function auditQuietOps(jobs, { now = new Date(), upcomingDays = 14, redact } = {}) {
  const status = quietOpsStatus(jobs, { redact });
  const issues = [
    ...sameTimeEnabledIssues(status.jobs),
    ...disabledInstalledIssues(status.jobs),
    ...upcomingOneShotIssues(status.jobs, { now, upcomingDays }),
    ...dailyRecurringCountIssues(status.jobs),
    ...unsupportedScheduleIssues(status.jobs),
  ];

  return {
    source: LIVE_CRON_SOURCE,
    summary: status.summary,
    issues,
  };
}

export function classifyQuietJob(job) {
  const name = String(job?.name ?? "");
  const lowerName = name.toLowerCase();
  const description = String(job?.description ?? "").toLowerCase();

  if (name.startsWith("Assistant routine:")) return "assistant-routine";
  if (name.startsWith("Assistant weekly plan:")) return "weekly-plan";
  if (job?.schedule?.kind === "at" || name.startsWith("Reminder:")) return "reminder";
  if (lowerName.includes("golf") || description.includes("golf")) return "golf";
  return "unknown";
}

export function describeQuietJob(job, { redact = (text) => text } = {}) {
  return {
    id: job.id,
    name: redact(job.name),
    category: classifyQuietJob(job),
    enabled: job.enabled,
    agentId: job.agentId ?? null,
    schedule: describeSchedule(job.schedule),
    nextRunAt: job.nextRunAt ?? null,
    lastRunAt: job.lastRunAt ?? null,
    lastStatus: job.lastStatus ?? null,
  };
}

/**
 * Resolves the exact target and plans one change without touching the Gateway.
 * Unsupported combinations, such as set-time on a one-shot, fail here.
 */
export function planQuietOpsChange(jobs, parsed, { timezone = DEFAULT_TIMEZONE } = {}) {
  const job = findQuietJob(cronJobs(jobs), parsed.options.ref);
  const result = { action: parsed.command, jobId: job.id, jobName: job.name };

  switch (parsed.command) {
    case "enable":
    case "disable":
      return { plan: planEnabledChange(job, parsed.command === "enable"), result };
    case "set-time": {
      if (job.schedule?.kind !== "cron") {
        throw new Error(`Quiet-ops set-time requires a cron job: ${job.name} [${job.id}] has schedule kind ${job.schedule?.kind ?? "unknown"}.`);
      }
      const cron = cronExpressionWithTime(job.schedule.expr, parseTime(parsed.options.time));
      return { plan: planCronExpressionChange(job, cron), result: { ...result, cron } };
    }
    case "reschedule": {
      if (job.schedule?.kind !== "at") {
        throw new Error(`Quiet-ops reschedule requires a one-shot at job: ${job.name} [${job.id}] has schedule kind ${job.schedule?.kind ?? "unknown"}.`);
      }
      const at = localDateTimeToUtcIso(parsed.options.date, parsed.options.time, timezone);
      return { plan: planOneShotChange(job, at), result: { ...result, at, timezone } };
    }
    default:
      throw new Error(`Unsupported quiet-ops mutation: ${parsed.command}`);
  }
}

export function findQuietJob(jobs, ref) {
  const matches = jobs.filter((job) => job.id === ref || job.name === ref);

  if (matches.length === 0) {
    throw new Error(`No quiet-ops job matches exact id or name: ${ref}`);
  }

  if (matches.length > 1) {
    throw new Error(`Ambiguous quiet-ops job reference: ${ref} matches ${matches.map((job) => job.id).join(", ")}`);
  }

  return matches[0];
}

function quietOpsSummary(jobs) {
  const enabledJobs = jobs.filter((job) => job.enabled).length;
  const kinds = jobs.map((job) => job.schedule?.kind);

  return {
    totalJobs: jobs.length,
    enabledJobs,
    disabledJobs: jobs.length - enabledJobs,
    recurringJobs: kinds.filter((kind) => kind === "cron" || kind === "every").length,
    intervalJobs: kinds.filter((kind) => kind === "every").length,
    oneShotJobs: kinds.filter((kind) => kind === "at").length,
    otherScheduleJobs: kinds.filter((kind) => !["cron", "every", "at"].includes(kind)).length,
    dailyRecurringJobs: jobs.filter((job) => job.enabled && isDailyCronSchedule(job.schedule)).length,
  };
}

function sameTimeEnabledIssues(statusJobs) {
  const groups = new Map();
  for (const job of statusJobs) {
    if (!job.enabled || job.schedule.kind !== "cron") continue;
    const key = `${job.schedule.expr}|${job.schedule.timezone ?? ""}`;
    const group = groups.get(key) ?? [];
    group.push(job);
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      type: "same-time-enabled",
      severity: "warn",
      schedule: group[0].schedule,
      jobIds: group.map((job) => job.id),
      jobNames: group.map((job) => job.name),
    }));
}

function disabledInstalledIssues(statusJobs) {
  return statusJobs
    .filter((job) => !job.enabled)
    .map((job) => ({
      type: "disabled-installed",
      severity: "info",
      jobId: job.id,
      jobName: job.name,
      schedule: job.schedule,
    }));
}

function upcomingOneShotIssues(statusJobs, { now, upcomingDays }) {
  const startMs = now.getTime();
  const endMs = startMs + upcomingDays * 24 * 60 * 60 * 1000;

  return statusJobs
    .filter((job) => job.enabled && job.schedule.kind === "at")
    .map((job) => ({ job, atMs: Date.parse(job.schedule.at) }))
    .filter(({ atMs }) => Number.isFinite(atMs) && atMs >= startMs && atMs <= endMs)
    .map(({ job }) => ({
      type: "upcoming-one-shot",
      severity: "info",
      jobId: job.id,
      jobName: job.name,
      at: job.schedule.at,
    }));
}

function dailyRecurringCountIssues(jobs) {
  const dailyJobs = jobs.filter((job) => job.enabled && isDailyCronSchedule(job.schedule));
  if (dailyJobs.length === 0) return [];

  return [
    {
      type: "daily-recurring-count",
      severity: "info",
      count: dailyJobs.length,
      jobNames: dailyJobs.map((job) => job.name),
    },
  ];
}

// A schedule kind this repo does not know is shown as-is, never treated as cron or at.
function unsupportedScheduleIssues(statusJobs) {
  return statusJobs
    .filter((job) => job.schedule.supported === false)
    .map((job) => ({
      type: "unsupported-schedule",
      severity: "info",
      jobId: job.id,
      jobName: job.name,
      schedule: job.schedule,
    }));
}

function describeSchedule(schedule = {}) {
  if (schedule.kind === "cron") {
    return {
      kind: "cron",
      expr: schedule.expr,
      timezone: schedule.timezone ?? null,
    };
  }

  if (schedule.kind === "at") {
    return {
      kind: "at",
      at: schedule.at,
    };
  }

  if (schedule.kind === "every") {
    return {
      kind: "every",
      everyMs: schedule.everyMs,
    };
  }

  return {
    kind: schedule.kind ?? "unknown",
    supported: false,
  };
}

function cronJobs(jobs) {
  return Array.isArray(jobs) ? jobs : [];
}

function cronExpressionWithTime(expr, { hour, minute }) {
  const parts = (expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Unsupported cron expression: ${expr}`);
  }

  return [String(minute), String(hour), ...parts.slice(2)].join(" ");
}

function parseTime(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time ?? "");
  if (!match) {
    throw new Error(`Invalid time: ${time}`);
  }

  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

function parseDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  if (!match) {
    throw new Error(`Invalid date: ${date}`);
  }

  const parsed = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const utc = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  if (
    utc.getUTCFullYear() !== parsed.year ||
    utc.getUTCMonth() !== parsed.month - 1 ||
    utc.getUTCDate() !== parsed.day
  ) {
    throw new Error(`Invalid date: ${date}`);
  }
  return parsed;
}

function localDateTimeToUtcIso(date, time, timezone) {
  const parsedDate = parseDate(date);
  const parsedTime = parseTime(time);
  const localAsUtcMs = Date.UTC(
    parsedDate.year,
    parsedDate.month - 1,
    parsedDate.day,
    parsedTime.hour,
    parsedTime.minute,
  );
  let utcMs = localAsUtcMs;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    utcMs = localAsUtcMs - timeZoneOffsetMs(new Date(utcMs), timezone);
  }

  return new Date(utcMs).toISOString();
}

function timeZoneOffsetMs(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const localAsUtcMs = Date.UTC(
    Number(byType.year),
    Number(byType.month) - 1,
    Number(byType.day),
    Number(byType.hour),
    Number(byType.minute),
    Number(byType.second),
  );

  return localAsUtcMs - date.getTime();
}
