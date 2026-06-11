const DEFAULT_TIMEZONE = "Europe/Stockholm";

export function quietOpsStatus(existingStore, existingState = {}) {
  const jobs = cronJobs(existingStore);
  const statusJobs = jobs.map((job) => describeQuietJob(job, existingState));

  return {
    jobs: statusJobs,
    summary: quietOpsSummary(statusJobs),
  };
}

export function auditQuietOps(existingStore, existingState = {}, { now = new Date(), upcomingDays = 14 } = {}) {
  const status = quietOpsStatus(existingStore, existingState);
  const issues = [
    ...sameTimeEnabledIssues(status.jobs),
    ...disabledInstalledIssues(status.jobs),
    ...upcomingOneShotIssues(status.jobs, { now, upcomingDays }),
    ...dailyRecurringCountIssues(status.jobs),
  ];

  return {
    summary: status.summary,
    issues,
  };
}

export function classifyQuietJob(job) {
  const name = String(job?.name ?? "");
  const lowerName = name.toLowerCase();
  const description = String(job?.description ?? "").toLowerCase();

  if (name.startsWith("Assistant routine:")) return "assistant-routine";
  if (job?.schedule?.kind === "at" || name.startsWith("Reminder:")) return "reminder";
  if (lowerName.includes("golf") || description.includes("golf")) return "golf";
  return "unknown";
}

export function updateQuietJobEnabled(existingStore, ref, enabled) {
  const update = updateQuietJob(existingStore, ref, (job) => ({
    ...job,
    enabled,
  }));

  return {
    ...update,
    result: {
      action: enabled ? "enable" : "disable",
      jobId: update.after.id,
      jobName: update.after.name,
    },
  };
}

export function updateQuietCronTime(existingStore, ref, time) {
  const parsedTime = parseTime(time);
  const update = updateQuietJob(existingStore, ref, (job) => {
    if (job.schedule?.kind !== "cron") {
      throw new Error(`Quiet-ops set-time requires a cron job: ${job.name}`);
    }

    return {
      ...job,
      schedule: {
        ...job.schedule,
        expr: cronExpressionWithTime(job.schedule.expr, parsedTime),
      },
    };
  });

  return {
    ...update,
    result: {
      action: "set-time",
      jobId: update.after.id,
      jobName: update.after.name,
      cron: update.after.schedule.expr,
    },
  };
}

export function updateQuietOneShotTime(
  existingStore,
  ref,
  date,
  time,
  { timezone = DEFAULT_TIMEZONE } = {},
) {
  let at;
  const update = updateQuietJob(existingStore, ref, (job) => {
    if (job.schedule?.kind !== "at") {
      throw new Error(`Quiet-ops reschedule requires a one-shot at job: ${job.name}`);
    }

    at = localDateTimeToUtcIso(date, time, timezone);
    return {
      ...job,
      schedule: {
        ...job.schedule,
        at,
      },
    };
  });

  return {
    ...update,
    result: {
      action: "reschedule",
      jobId: update.after.id,
      jobName: update.after.name,
      at,
      timezone,
    },
  };
}

export function describeQuietJob(job, existingState = {}) {
  const state = existingState.jobs?.[job.id]?.state ?? {};

  return {
    id: job.id,
    name: job.name,
    category: classifyQuietJob(job),
    enabled: job.enabled !== false,
    agentId: job.agentId ?? null,
    schedule: describeSchedule(job.schedule),
    nextRunAt: state.nextRunAtMs ? new Date(state.nextRunAtMs).toISOString() : null,
    lastStatus: state.lastStatus ?? null,
  };
}

function quietOpsSummary(statusJobs) {
  const enabledJobs = statusJobs.filter((job) => job.enabled).length;
  const recurringJobs = statusJobs.filter((job) => job.schedule.kind === "cron").length;
  const oneShotJobs = statusJobs.filter((job) => job.schedule.kind === "at").length;
  const dailyRecurringJobs = statusJobs.filter((job) => job.enabled && isDailyCron(job.schedule.expr)).length;

  return {
    totalJobs: statusJobs.length,
    enabledJobs,
    disabledJobs: statusJobs.length - enabledJobs,
    recurringJobs,
    oneShotJobs,
    dailyRecurringJobs,
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

function dailyRecurringCountIssues(statusJobs) {
  const dailyJobs = statusJobs.filter((job) => job.enabled && isDailyCron(job.schedule.expr));
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

function describeSchedule(schedule = {}) {
  if (schedule.kind === "cron") {
    return {
      kind: "cron",
      expr: schedule.expr,
      timezone: schedule.tz ?? null,
    };
  }

  if (schedule.kind === "at") {
    return {
      kind: "at",
      at: schedule.at,
    };
  }

  return {
    kind: schedule.kind ?? "unknown",
  };
}

function updateQuietJob(existingStore, ref, updater) {
  const jobs = cronJobs(existingStore);
  const { job, index } = findQuietJob(jobs, ref);
  const after = updater(job);
  const updatedJobs = jobs.map((candidate, candidateIndex) => (candidateIndex === index ? after : candidate));

  return {
    store: {
      ...existingStore,
      version: existingStore?.version ?? 1,
      jobs: updatedJobs,
    },
    before: job,
    after,
  };
}

function findQuietJob(jobs, ref) {
  const matches = jobs
    .map((job, index) => ({ job, index }))
    .filter(({ job }) => job.id === ref || job.name === ref);

  if (matches.length === 0) {
    throw new Error(`No quiet-ops job matches exact id or name: ${ref}`);
  }

  if (matches.length > 1) {
    throw new Error(`Ambiguous quiet-ops job reference: ${ref}`);
  }

  return matches[0];
}

function cronJobs(existingStore) {
  return Array.isArray(existingStore?.jobs) ? existingStore.jobs : [];
}

function cronExpressionWithTime(expr, { hour, minute }) {
  const parts = (expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Unsupported cron expression: ${expr}`);
  }

  return [String(minute), String(hour), ...parts.slice(2)].join(" ");
}

function isDailyCron(expr) {
  const parts = (expr ?? "").trim().split(/\s+/);
  return parts.length === 5 && parts[2] === "*" && parts[3] === "*" && parts[4] === "*";
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
