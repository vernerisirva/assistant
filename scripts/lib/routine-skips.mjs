import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_ROUTINE_SKIP_TIMEZONE = "Europe/Stockholm";
export const DEFAULT_ROUTINE_SKIP_STORE = { version: 1, skips: [] };

export function resolveRoutineSkipStorePath(stateDir) {
  return join(stateDir, "routines/skips.json");
}

export function normalizeRoutineSkipStore(value) {
  const skips = Array.isArray(value?.skips)
    ? value.skips
        .filter((skip) => skip && typeof skip === "object" && !Array.isArray(skip))
        .map((skip) => ({ ...skip }))
    : [];

  return {
    version: 1,
    skips,
  };
}

export function readRoutineSkipStore(path, { issues = [], strict = false } = {}) {
  if (!existsSync(path)) return emptyRoutineSkipStore();

  const text = readFileSync(path, "utf8");
  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = `Malformed routine skip state at ${path}: ${error.message}`;
    if (strict) {
      throw new Error(message, { cause: error });
    }

    issues.push({
      severity: "warn",
      type: "malformed-json",
      path,
      message,
    });
    return emptyRoutineSkipStore();
  }

  try {
    assertValidRoutineSkipStoreShape(parsed);
    return normalizeRoutineSkipStore(parsed);
  } catch (error) {
    const message = `Malformed routine skip state at ${path}: ${error.message}`;
    if (strict) {
      throw new Error(message, { cause: error });
    }

    issues.push({
      severity: "warn",
      type: "malformed-store",
      path,
      message,
    });
    return emptyRoutineSkipStore();
  }
}

export function writeRoutineSkipStoreFile(path, store, { now = new Date(), backup = true } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  let backupPath = null;

  if (backup && existsSync(path)) {
    backupPath = `${path}.bak.${formatBackupTimestamp(now)}`;
    copyFileSync(path, backupPath);
  }

  writeFileSync(path, `${JSON.stringify(normalizeRoutineSkipStore(store), null, 2)}\n`);
  return { path, backupPath };
}

export function addRoutineSkip(
  store,
  {
    routineIds,
    routineId,
    date,
    timezone = DEFAULT_ROUTINE_SKIP_TIMEZONE,
    source = "telegram",
    now = new Date(),
  },
) {
  assertValidRoutineId(routineId, routineIds);
  assertValidDate(date);

  const normalized = normalizeRoutineSkipStore(store);
  assertValidRoutineSkipStoreForMutation(normalized, routineIds);
  const existing = normalized.skips.find((skip) => skipMatches(skip, routineId, date, timezone));
  if (existing) {
    return {
      store: normalized,
      result: {
        action: "add",
        routineId,
        date,
        timezone,
        added: false,
        skip: existing,
      },
    };
  }

  const skip = {
    routineId,
    date,
    timezone,
    source,
    createdAt: dateToIsoString(now),
  };

  return {
    store: {
      version: normalized.version,
      skips: [...normalized.skips, skip],
    },
    result: {
      action: "add",
      routineId,
      date,
      timezone,
      added: true,
      skip,
    },
  };
}

export function removeRoutineSkip(
  store,
  {
    routineIds,
    routineId,
    date,
    timezone = DEFAULT_ROUTINE_SKIP_TIMEZONE,
  },
) {
  assertValidRoutineId(routineId, routineIds);
  assertValidDate(date);

  const normalized = normalizeRoutineSkipStore(store);
  assertValidRoutineSkipStoreForMutation(normalized, routineIds);
  const skips = normalized.skips.filter((skip) => !skipMatches(skip, routineId, date, timezone));
  const removed = skips.length !== normalized.skips.length;

  return {
    store: {
      version: normalized.version,
      skips,
    },
    result: {
      action: "remove",
      routineId,
      date,
      timezone,
      removed,
    },
  };
}

export function routineSkipStatus(
  store,
  {
    routineIds,
    now = new Date(),
    timezone = DEFAULT_ROUTINE_SKIP_TIMEZONE,
  },
) {
  const date = localDateInTimeZone(now, timezone);

  return routineIds.map((routineId) => {
    assertValidRoutineId(routineId, routineIds);
    return {
      routineId,
      date,
      timezone,
      skippedToday: isRoutineSkipped(store, routineId, date, timezone),
    };
  });
}

export function isRoutineSkipped(store, routineId, date, timezone = DEFAULT_ROUTINE_SKIP_TIMEZONE) {
  assertValidDate(date);
  return normalizeRoutineSkipStore(store).skips.some((skip) => skipMatches(skip, routineId, date, timezone));
}

export function localDateInTimeZone(now = new Date(), timezone = DEFAULT_ROUTINE_SKIP_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(toDate(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${values.year}-${values.month}-${values.day}`;
}

export function assertValidRoutineId(routineId, routineIds) {
  if (!Array.isArray(routineIds) || !routineIds.includes(routineId)) {
    throw new Error(`Unknown routine id: ${routineId}`);
  }
}

export function assertValidDate(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date: ${date}`);
  }

  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid date: ${date}`);
  }
}

function assertValidRoutineSkipStoreShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Routine skip state must be an object.");
  }
  if (value.version !== undefined && value.version !== 1) {
    throw new Error(`Unsupported routine skip state version: ${value.version}`);
  }
  if (value.skips !== undefined && !Array.isArray(value.skips)) {
    throw new Error("Routine skip state skips must be an array.");
  }

  for (const [index, skip] of (value.skips ?? []).entries()) {
    assertValidRoutineSkipEntryShape(skip, index);
  }
}

function assertValidRoutineSkipStoreForMutation(store, routineIds) {
  for (const skip of store.skips) {
    assertValidRoutineId(skip.routineId, routineIds);
    assertValidDate(skip.date);
    assertValidTimezone(skip.timezone);
    if (skip.createdAt !== undefined && typeof skip.createdAt !== "string") {
      throw new Error(`Invalid routine skip createdAt: ${skip.createdAt}`);
    }
    if (skip.source !== undefined && typeof skip.source !== "string") {
      throw new Error(`Invalid routine skip source: ${skip.source}`);
    }
  }
}

function assertValidRoutineSkipEntryShape(skip, index) {
  if (!skip || typeof skip !== "object" || Array.isArray(skip)) {
    throw new Error(`Routine skip entry ${index} must be an object.`);
  }
  if (typeof skip.routineId !== "string" || !skip.routineId.trim()) {
    throw new Error(`Invalid routine id: ${skip.routineId}`);
  }
  assertValidDate(skip.date);
  assertValidTimezone(skip.timezone);
  if (skip.createdAt !== undefined && typeof skip.createdAt !== "string") {
    throw new Error(`Invalid routine skip createdAt: ${skip.createdAt}`);
  }
  if (skip.source !== undefined && typeof skip.source !== "string") {
    throw new Error(`Invalid routine skip source: ${skip.source}`);
  }
}

function assertValidTimezone(timezone) {
  if (typeof timezone !== "string" || !timezone.trim()) {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
}

function emptyRoutineSkipStore() {
  return { version: 1, skips: [] };
}

function skipMatches(skip, routineId, date, timezone) {
  return skip.routineId === routineId && skip.date === date && skip.timezone === timezone;
}

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function dateToIsoString(value) {
  return toDate(value).toISOString();
}

function formatBackupTimestamp(now) {
  return toDate(now).toISOString().replace(/[-:.]/g, "");
}
