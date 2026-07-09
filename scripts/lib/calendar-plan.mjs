const DEFAULT_TIMEZONE = "Europe/Stockholm";
const WORKDAY_START = "08:00";
const WORKDAY_END = "18:00";

export function planCalendarSnapshot(events, {
  range = "today",
  date = localDateInTimeZone(new Date(), DEFAULT_TIMEZONE),
  timezone = DEFAULT_TIMEZONE,
} = {}) {
  if (!["today", "week"].includes(range)) {
    throw new Error("Calendar plan range must be today or week.");
  }

  const normalizedDate = assertDate(date);
  const normalizedEvents = normalizeEvents(events);
  const dates = range === "today" ? [normalizedDate] : weekDates(normalizedDate);
  const days = dates.map((dayDate) => planDay(normalizedEvents, dayDate, timezone));
  const busyEventCount = days.reduce((total, day) => total + day.busyEvents.length, 0);
  const freeMinutes = days.reduce(
    (total, day) => total + day.freeBlocks.reduce((sum, block) => sum + block.durationMinutes, 0),
    0,
  );

  return {
    range,
    date: normalizedDate,
    timezone,
    readOnly: true,
    sideEffects: [],
    days,
    summary: {
      busyEventCount,
      freeMinutes,
      pressure: overallPressure(days),
    },
  };
}

export function formatCalendarPlan(plan) {
  if (plan.range === "week") return formatWeekPlan(plan);

  const [day] = plan.days;
  const lines = [
    `Calendar plan: ${formatDate(day.date)}`,
    `- Calendar pressure: ${day.pressure}. ${day.busyEvents.length === 0 ? "No busy events." : `${day.busyEvents.length} busy events.`}`,
    `- Free blocks: ${formatBlocks(day.freeBlocks)}.`,
  ];

  if (day.meetingClusters.length > 0) {
    lines.push(`- Meeting clusters: ${day.meetingClusters.map((cluster) => `${cluster.start}-${cluster.end} (${cluster.eventCount})`).join("; ")}.`);
  }
  if (day.risks.length > 0) {
    lines.push(`- Risk: back-to-back meetings ${day.risks.map((risk) => `${risk.start}-${risk.end}`).join("; ")}.`);
  }

  lines.push(`- Windows: ${formatWindows(day.windows)}.`);
  lines.push(`- Suggested plan: ${day.suggestedPlan}`);
  if (day.proposedChange) lines.push(`- ${day.proposedChange}`);
  lines.push("- Read-only: no Calendar changes were made.");
  return lines.join("\n");
}

function planDay(events, date, timezone) {
  const startMs = localDateTimeToUtcMs(date, WORKDAY_START, timezone);
  const endMs = localDateTimeToUtcMs(date, WORKDAY_END, timezone);
  const busyEvents = events
    .filter((event) => event.busy && event.endMs > startMs && event.startMs < endMs)
    .map((event) => ({
      ...event,
      startMs: Math.max(event.startMs, startMs),
      endMs: Math.min(event.endMs, endMs),
    }))
    .sort((left, right) => left.startMs - right.startMs)
    .map((event) => ({
      title: event.title,
      start: formatTime(event.startMs, timezone),
      end: formatTime(event.endMs, timezone),
      location: event.location,
      calendar: event.calendar,
      startMs: event.startMs,
      endMs: event.endMs,
    }));
  const freeBlocks = findFreeBlocks(busyEvents, startMs, endMs, timezone);
  const meetingClusters = findMeetingClusters(busyEvents, timezone);
  const risks = meetingClusters.map(({ start, end }) => ({ type: "back-to-back", start, end }));
  const windows = suggestWindows(freeBlocks);

  return {
    date,
    pressure: pressureFor(busyEvents, startMs, endMs),
    busyEvents,
    freeBlocks,
    meetingClusters,
    risks,
    windows,
    suggestedPlan: suggestedPlan(windows),
    proposedChange: proposedFocusChange(windows.focus),
  };
}

function normalizeEvents(events) {
  if (!Array.isArray(events)) throw new Error("Calendar event snapshot must be an array.");

  return events.map((event) => {
    const title = requiredText(event?.title, "Calendar event title is required.");
    const start = requiredText(event?.start, "Calendar event start is required.");
    const end = requiredText(event?.end, "Calendar event end is required.");
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new Error("Calendar event start and end must be ISO timestamps.");
    }
    if (endMs <= startMs) throw new Error("Calendar event end must be after start.");

    return {
      title,
      startMs,
      endMs,
      location: optionalText(event.location),
      calendar: optionalText(event.calendar),
      busy: event.busy !== false,
    };
  });
}

function findFreeBlocks(events, startMs, endMs, timezone) {
  const merged = [];
  for (const event of events) {
    const previous = merged.at(-1);
    if (!previous || event.startMs > previous.endMs) {
      merged.push({ startMs: event.startMs, endMs: event.endMs });
    } else {
      previous.endMs = Math.max(previous.endMs, event.endMs);
    }
  }

  const blocks = [];
  let cursor = startMs;
  for (const interval of merged) {
    if (interval.startMs > cursor) blocks.push(freeBlock(cursor, interval.startMs, timezone));
    cursor = Math.max(cursor, interval.endMs);
  }
  if (cursor < endMs) blocks.push(freeBlock(cursor, endMs, timezone));
  return blocks;
}

function findMeetingClusters(events, timezone) {
  const clusters = [];
  let current = null;

  for (const event of events) {
    if (!current || event.startMs - current.endMs > 15 * 60_000) {
      if (current?.eventCount > 1) clusters.push(formatCluster(current, timezone));
      current = { startMs: event.startMs, endMs: event.endMs, eventCount: 1 };
      continue;
    }
    current.endMs = Math.max(current.endMs, event.endMs);
    current.eventCount += 1;
  }
  if (current?.eventCount > 1) clusters.push(formatCluster(current, timezone));
  return clusters;
}

function suggestWindows(blocks) {
  const unused = new Set(blocks.map((_, index) => index));
  const choose = (minimumMinutes) => {
    const candidates = [...unused]
      .filter((index) => blocks[index].durationMinutes >= minimumMinutes)
      .sort((left, right) => blocks[right].durationMinutes - blocks[left].durationMinutes);
    const index = candidates[0];
    if (index === undefined) return null;
    unused.delete(index);
    return blocks[index];
  };

  return {
    focus: choose(90),
    workout: choose(60),
    admin: choose(30),
  };
}

function suggestedPlan(windows) {
  const parts = [];
  if (windows.focus) parts.push(`put focused work in ${windows.focus.start}-${windows.focus.end}`);
  if (windows.workout) parts.push(`use ${windows.workout.start}-${windows.workout.end} for a workout or movement`);
  if (windows.admin) parts.push(`keep ${windows.admin.start}-${windows.admin.end} for admin`);
  return parts.length > 0 ? `${capitalize(parts.join("; "))}.` : "Protect the largest available gap and keep the day light.";
}

function proposedFocusChange(focus) {
  if (!focus) return null;
  const end = addMinutesToTime(focus.start, Math.min(60, focus.durationMinutes));
  return `Proposed change: block ${focus.start}-${end} for focused work. Ask me to create it if you want.`;
}

function pressureFor(events, startMs, endMs) {
  const busyMinutes = events.reduce((total, event) => total + (event.endMs - event.startMs) / 60_000, 0);
  const workdayMinutes = (endMs - startMs) / 60_000;
  if (busyMinutes >= workdayMinutes * 0.6) return "high";
  if (busyMinutes >= workdayMinutes * 0.3) return "medium";
  return "low";
}

function overallPressure(days) {
  if (days.some((day) => day.pressure === "high")) return "high";
  if (days.some((day) => day.pressure === "medium")) return "medium";
  return "low";
}

function freeBlock(startMs, endMs, timezone) {
  return {
    start: formatTime(startMs, timezone),
    end: formatTime(endMs, timezone),
    durationMinutes: Math.round((endMs - startMs) / 60_000),
  };
}

function formatCluster(cluster, timezone) {
  return {
    start: formatTime(cluster.startMs, timezone),
    end: formatTime(cluster.endMs, timezone),
    eventCount: cluster.eventCount,
  };
}

function formatWeekPlan(plan) {
  const busyDays = plan.days.filter((day) => day.busyEvents.length > 0);
  return [
    `Calendar plan: week of ${formatDate(plan.days[0].date)}`,
    `- Calendar pressure: ${plan.summary.pressure} (${plan.summary.busyEventCount} busy events).`,
    `- Free time: ${formatDuration(plan.summary.freeMinutes)} across the working week.`,
    `- Meeting days: ${busyDays.length > 0 ? busyDays.map((day) => `${formatDate(day.date)} (${day.pressure})`).join("; ") : "none"}.`,
    "- Read-only: no Calendar changes were made.",
  ].join("\n");
}

function formatBlocks(blocks) {
  return blocks.length > 0 ? blocks.map((block) => `${block.start}-${block.end}`).join("; ") : "none";
}

function formatWindows(windows) {
  const entries = Object.entries(windows)
    .filter(([, block]) => block)
    .map(([name, block]) => `${name} ${block.start}-${block.end}`);
  return entries.length > 0 ? entries.join("; ") : "no clear protected window";
}

function localDateInTimeZone(now, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function weekDates(date) {
  const parsed = parseDate(date);
  const day = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
  const mondayOffset = (day + 6) % 7;
  return Array.from({ length: 7 }, (_, index) => dateAtOffset(date, index - mondayOffset));
}

function dateAtOffset(date, offset) {
  const parsed = parseDate(date);
  const value = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + offset));
  return value.toISOString().slice(0, 10);
}

function assertDate(date) {
  parseDate(date);
  return date;
}

function parseDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  if (!match) throw new Error("Calendar plan date must use YYYY-MM-DD.");
  const parsed = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const utc = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  if (utc.getUTCFullYear() !== parsed.year || utc.getUTCMonth() !== parsed.month - 1 || utc.getUTCDate() !== parsed.day) {
    throw new Error("Calendar plan date must use YYYY-MM-DD.");
  }
  return parsed;
}

function localDateTimeToUtcMs(date, time, timezone) {
  const parsedDate = parseDate(date);
  const [hour, minute] = time.split(":").map(Number);
  const localAsUtcMs = Date.UTC(parsedDate.year, parsedDate.month - 1, parsedDate.day, hour, minute);
  let utcMs = localAsUtcMs;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    utcMs = localAsUtcMs - timeZoneOffsetMs(new Date(utcMs), timezone);
  }
  return utcMs;
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

function formatTime(ms, timezone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

function addMinutesToTime(time, minutes) {
  const [hour, minute] = time.split(":").map(Number);
  const total = hour * 60 + minute + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function requiredText(value, errorMessage) {
  const text = optionalText(value);
  if (!text) throw new Error(errorMessage);
  return text;
}

function optionalText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function capitalize(value) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
