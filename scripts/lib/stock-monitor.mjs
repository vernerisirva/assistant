/**
 * The stock monitor: one deterministic scheduled check over the securities
 * the user asked Hilla to follow.
 *
 * Each run reads the watchlist, works out which public sources are due for
 * which security (company disclosures about hourly, news and the report
 * calendar less often, forums least), checks them within a fixed request
 * budget, turns what they return into events, deduplicates them and stores
 * only what is new. Nothing calls a model.
 *
 * Honesty about coverage comes first. Every source check is recorded per
 * security: the last attempt, the last success, the newest item seen, its
 * health and the last error. A failed source is never reported as "nothing
 * new"; a source that could not be checked this run because the budget ran
 * out is deferred, not skipped silently. Everything a source returns on its
 * first successful check is history (`baseline`), never news. When the
 * computer was asleep or offline, the next run catches up over at most
 * `catchUpDays`, and anything older is kept as missed, not as new.
 *
 * The monitor writes only its own state (`<stateDir>/stock-watch/monitor/`)
 * and caches, never a watchlist record. It never trades, places orders,
 * signs in anywhere or contacts anyone.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { localDate } from "./contract-dates.mjs";
import { detectReport, mergeEvents, noticeDate, normalizeItem, reportIdentity } from "./stock-events.mjs";
import { describeSecurity } from "./stock-identity.mjs";
import { WATCH_ID_PATTERN, assertPlainDir, ensurePrivateDir, isLink, resolveStockWatchDir } from "./stock-watchlist.mjs";
import { withFileLockSync, writeFileAtomicSync } from "./state-file.mjs";

export const STOCK_MONITOR_JOB = "Assistant stocks: watch monitor";
export const MONITOR_SCHEMA_VERSION = 1;
export const SOURCE_KINDS = Object.freeze(["disclosures", "calendar", "news", "forums"]);
export const SOURCE_HEALTH = Object.freeze(["ok", "partial", "degraded", "failing", "blocked"]);
const DEFAULT_TIMEZONE = "Europe/Stockholm";
const MAX_BACKOFF_MS = 24 * 3_600_000;
const ERROR_MAX = 160;

export const DEFAULT_MONITOR_SETTINGS = Object.freeze({
  minute: 7,
  checkEveryMinutes: { disclosures: 60, calendar: 1440, news: 240, forums: 720 },
  limits: {
    maxSecurities: 25,
    maxSourceChecksPerRun: 40,
    maxRequestsPerRun: 80,
    maxRequestsPerCheck: 3,
    maxItemsPerCheck: 50,
    catchUpDays: 7,
    eventsKeptPerSecurity: 300,
    requestTimeoutSeconds: 20,
    maxResponseKb: 3000,
    minHostIntervalMs: 1000,
    documentChecksPerRun: 3,
  },
  jobTimeoutSeconds: 900,
  // Sources whose terms are unclear stay off until the owner turns them on (see OWNER_DECISION_SOURCES).
  sources: { "nasdaq-company-news": false },
});

// --- Settings ----------------------------------------------------------------------

/** The monitor settings from config/schedules.json `stockWatch`, checked, with defaults for what is left out. */
export function stockMonitorSettings(schedules = {}) {
  const source = schedules.stockWatch ?? {};
  const settings = {
    timezone: schedules.timezone ?? DEFAULT_TIMEZONE,
    minute: source.minute ?? DEFAULT_MONITOR_SETTINGS.minute,
    checkEveryMinutes: { ...DEFAULT_MONITOR_SETTINGS.checkEveryMinutes, ...(source.checkEveryMinutes ?? {}) },
    limits: { ...DEFAULT_MONITOR_SETTINGS.limits, ...(source.limits ?? {}) },
    jobTimeoutSeconds: source.jobTimeoutSeconds ?? DEFAULT_MONITOR_SETTINGS.jobTimeoutSeconds,
    sources: { ...DEFAULT_MONITOR_SETTINGS.sources, ...(source.sources ?? {}) },
  };
  for (const [key, value] of Object.entries(settings.sources)) {
    if (typeof value !== "boolean") throw new Error(`stockWatch.sources.${key} must be true or false.`);
  }
  if (!Number.isInteger(settings.minute) || settings.minute < 0 || settings.minute > 59) throw new Error("stockWatch.minute must be a whole number from 0 to 59.");
  for (const kind of SOURCE_KINDS) {
    const every = settings.checkEveryMinutes[kind];
    if (!Number.isInteger(every) || every < 60 || every > 10_080) throw new Error(`stockWatch.checkEveryMinutes.${kind} must be 60 to 10080 minutes: nothing is checked more often than hourly.`);
  }
  const bounds = {
    maxSecurities: [1, 50],
    maxSourceChecksPerRun: [1, 200],
    maxRequestsPerRun: [1, 300],
    maxRequestsPerCheck: [1, 10],
    maxItemsPerCheck: [1, 200],
    catchUpDays: [1, 30],
    eventsKeptPerSecurity: [50, 2000],
    requestTimeoutSeconds: [5, 60],
    maxResponseKb: [100, 20_000],
    minHostIntervalMs: [500, 10_000],
    documentChecksPerRun: [0, 10],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const value = settings.limits[key];
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`stockWatch.limits.${key} must be a whole number from ${min} to ${max}.`);
  }
  if (!Number.isInteger(settings.jobTimeoutSeconds) || settings.jobTimeoutSeconds < 120 || settings.jobTimeoutSeconds > 3600) throw new Error("stockWatch.jobTimeoutSeconds must be 120 to 3600.");
  return settings;
}

/** The monitor runs only while the policy's authorization stands: enabled, and not past `authorizedUntil` when one is set. */
export function monitorAuthorization(policy, { today }) {
  const entry = policy?.stockMonitoring;
  if (!entry || entry.enabled !== true) return { authorized: false, reason: "stock monitoring is switched off in the approval policy" };
  if (entry.authorizedUntil && (!/^\d{4}-\d{2}-\d{2}$/.test(entry.authorizedUntil) || entry.authorizedUntil < today)) {
    return { authorized: false, reason: "stock monitoring's authorization has expired" };
  }
  return { authorized: true, reason: null };
}

// --- State -------------------------------------------------------------------------

export function emptyMonitorState(watchId) {
  return { schemaVersion: MONITOR_SCHEMA_VERSION, watchId, sources: {}, events: [], calendar: { entries: [] }, updatedAt: null };
}

/**
 * The monitor's notes, one owner-only file per security next to the
 * watchlist, written atomically under one lock, plus a global file with the
 * heartbeat, a summary of the last run and the robots.txt cache. Locks are
 * held only for a read-change-write, never across network requests.
 */
export function createMonitorStore({ stateDir, lockTimeoutMs }) {
  const base = resolveStockWatchDir(stateDir);
  const root = join(base, "monitor");
  const statePath = (watchId) => join(root, `${requireId(watchId)}.json`);
  const globalPath = join(root, "monitor.json");
  const ensure = () => {
    ensurePrivateDir(base, { base: dirname(base) });
    ensurePrivateDir(root, { base: dirname(base) });
  };

  function readFile(path, label) {
    assertPlainDir(base, { base: dirname(base) });
    assertPlainDir(root, { base: dirname(base) });
    if (!existsSync(path) && !isLink(path)) return null;
    if (isLink(path)) throw unreadable(label, "are not a regular file");
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw unreadable(label, "are not valid JSON");
    }
  }

  function read(watchId) {
    const document = readFile(statePath(watchId), watchId);
    if (document === null) return null;
    const problem = monitorStateProblem(document, watchId);
    if (problem) throw unreadable(watchId, problem);
    return document;
  }

  function write(state) {
    ensure();
    writeFileAtomicSync(statePath(state.watchId), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    return state;
  }

  function readGlobal() {
    const document = readFile(globalPath, "monitor.json");
    if (document === null) return { schemaVersion: MONITOR_SCHEMA_VERSION, lastRunAt: null, lastRun: null, robots: {} };
    if (document.schemaVersion !== MONITOR_SCHEMA_VERSION || typeof document.robots !== "object" || document.robots === null) throw unreadable("monitor.json", "have an unexpected shape");
    return document;
  }

  function writeGlobal(document) {
    ensure();
    writeFileAtomicSync(globalPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  }

  function ids() {
    if (!existsSync(root)) return [];
    assertPlainDir(root, { base: dirname(base) });
    return readdirSync(root)
      .filter((name) => name.endsWith(".json") && name !== "monitor.json")
      .map((name) => name.slice(0, -".json".length))
      .filter((id) => WATCH_ID_PATTERN.test(id));
  }

  function withLock(fn) {
    ensure();
    return withFileLockSync(join(root, "monitor"), fn, lockTimeoutMs === undefined ? {} : { timeoutMs: lockTimeoutMs });
  }

  /** Read, change and write one security's state under the lock. `change` returns the new state, or null to keep it. */
  function mutate(watchId, change) {
    return withLock(() => {
      const current = read(watchId) ?? emptyMonitorState(watchId);
      const next = change(structuredClone(current));
      if (!next) return current;
      return write({ ...next, updatedAt: new Date().toISOString() });
    });
  }

  return { root, read, write, readGlobal, writeGlobal, ids, withLock, mutate, remove: (watchId) => rmSync(statePath(watchId), { force: true }) };
}

function requireId(watchId) {
  if (typeof watchId !== "string" || !WATCH_ID_PATTERN.test(watchId)) throw new Error("A watched security's id looks like sw-1a2b3c4d.");
  return watchId;
}

function unreadable(label, reason) {
  const error = new Error(`The stock monitor's notes for ${label} could not be read: they ${reason}.`);
  error.code = "MONITOR_UNREADABLE";
  error.reason = reason;
  return error;
}

function monitorStateProblem(document, watchId) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return "are not a JSON object";
  if (document.schemaVersion !== MONITOR_SCHEMA_VERSION) return "have an unsupported schema version";
  if (document.watchId !== watchId) return "belong to another security";
  if (!document.sources || typeof document.sources !== "object" || Array.isArray(document.sources)) return "have malformed source notes";
  if (!Array.isArray(document.events) || document.events.some((event) => !event || typeof event.id !== "string" || !Array.isArray(event.sources) || !Array.isArray(event.keys))) return "have malformed events";
  if (!document.calendar || !Array.isArray(document.calendar.entries)) return "have a malformed calendar";
  return null;
}

// --- What is due -------------------------------------------------------------------------

/**
 * The source checks due now: for each followed security, each source that can
 * cover it and that its monitoring settings switch on, whose interval has
 * passed and whose back-off (after a failure or a rate limit) has ended.
 * Most overdue first, so a long outage is caught up fairly.
 */
export function dueChecks(records, states, sources, { now, settings, force = false }) {
  const due = [];
  for (const record of records) {
    if (record.status !== "watching") continue;
    const state = states.get(record.id) ?? emptyMonitorState(record.id);
    for (const source of sources) {
      if (!source.enabledFor(record.monitoring)) continue;
      if (source.coverage(record.security).status !== "available") continue;
      const notes = state.sources[source.key] ?? null;
      const interval = settings.checkEveryMinutes[source.kind] * 60_000;
      // A check the user asked for skips the interval, but never a source's request to slow down.
      const nextAt = force ? (notes?.retryAfter ? Date.parse(notes.retryAfter) : 0) : nextCheckAt(notes, interval);
      if (nextAt > now.getTime()) continue;
      due.push({ record, source, notes, overdueMs: now.getTime() - nextAt, interval });
    }
  }
  // Official sources first within the same moment, so a report is known before news about it arrives.
  const kindOrder = (entry) => SOURCE_KINDS.indexOf(entry.source.kind);
  return due.sort((left, right) => right.overdueMs - left.overdueMs || left.record.id.localeCompare(right.record.id) || kindOrder(left) - kindOrder(right) || left.source.key.localeCompare(right.source.key));
}

function nextCheckAt(notes, interval) {
  if (!notes?.lastAttemptAt) return 0;
  const attempted = Date.parse(notes.lastAttemptAt);
  const retryAfter = notes.retryAfter ? Date.parse(notes.retryAfter) : 0;
  // A small slack keeps an hourly check from slipping a whole hour when the job runs a few seconds early.
  return Math.max(attempted + interval - 120_000, retryAfter);
}

// --- One source check --------------------------------------------------------------------

/** Notes after a successful check. A first success is the baseline: what it found was already there. */
function successNotes(notes, result, { now, latestItemAt }) {
  return {
    ...(notes ?? {}),
    lastAttemptAt: now.toISOString(),
    lastSuccessAt: now.toISOString(),
    latestItemAt: latestItemAt ?? notes?.latestItemAt ?? null,
    health: "ok",
    lastError: null,
    consecutiveFailures: 0,
    retryAfter: null,
    baselineDone: true,
    etag: result.etag ?? notes?.etag ?? null,
    lastModified: result.lastModified ?? notes?.lastModified ?? null,
    cursor: result.cursor ?? notes?.cursor ?? null,
  };
}

/** Notes after a failed check: health falls with repeated failures, and the next try backs off. */
function failureNotes(notes, result, { now, interval }) {
  const failures = (notes?.consecutiveFailures ?? 0) + 1;
  const backoff = Math.min(interval * 2 ** Math.min(failures - 1, 6), MAX_BACKOFF_MS);
  const retryAfterHeader = Number(result.retryAfter);
  const retryAfter = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? Math.max(retryAfterHeader * 1000, backoff) : backoff;
  return {
    ...(notes ?? {}),
    lastAttemptAt: now.toISOString(),
    lastSuccessAt: notes?.lastSuccessAt ?? null,
    latestItemAt: notes?.latestItemAt ?? null,
    health: result.status === "blocked" ? "blocked" : failures >= 3 ? "failing" : "degraded",
    lastError: sanitizeError(result.reason ?? result.status),
    lastErrorStatus: result.status,
    consecutiveFailures: failures,
    retryAfter: new Date(now.getTime() + retryAfter).toISOString(),
    baselineDone: notes?.baselineDone ?? false,
  };
}

export function sanitizeError(text) {
  return String(text ?? "unknown")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[\u{0}-\u{1f}\u{7f}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ERROR_MAX);
}

/**
 * Stores what one successful check found. New events are flagged: `baseline`
 * on a source's first success, `catchUp` when the source's last success was
 * more than two intervals ago, and `missed` when such an item is older than
 * the catch-up window.
 */
export function recordCheck(state, { record, source, result, now, settings, interval }) {
  const notes = state.sources[source.key] ?? null;
  const baseline = !notes?.baselineDone;
  const lastSuccessMs = notes?.lastSuccessAt ? Date.parse(notes.lastSuccessAt) : null;
  const catchUp = !baseline && lastSuccessMs !== null && now.getTime() - lastSuccessMs > 2 * interval;
  const windowStart = now.getTime() - settings.limits.catchUpDays * 86_400_000;
  const candidates = (result.items ?? [])
    .slice(0, settings.limits.maxItemsPerCheck)
    .map((item) => normalizeItem({ ...item, sourceKey: source.key, sourceName: source.name, evidence: item.evidence ?? source.evidence }, { watchId: record.id, security: record.security, now }))
    .filter(Boolean);
  const merged = mergeEvents(state.events, candidates, { watchId: record.id, baseline, now });
  for (const event of merged.added) {
    if (baseline) continue;
    const publishedMs = Date.parse(event.publishedAt ?? "");
    if (catchUp) event.catchUp = true;
    // Found late and published before the catch-up window: kept, but as missed, never as news.
    if (Number.isFinite(publishedMs) && publishedMs < windowStart) event.missed = true;
    // A source can surface an old item at any time, such as a page that changed order.
    if (!catchUp && Number.isFinite(publishedMs) && lastSuccessMs !== null && publishedMs < lastSuccessMs - 7 * 86_400_000) event.missed = true;
  }
  const latestItemAt = candidates.map((candidate) => candidate.publishedAt).filter(Boolean).sort().at(-1) ?? null;
  state.sources[source.key] = successNotes(notes, result, { now, latestItemAt: latestItemAt && (!notes?.latestItemAt || latestItemAt > notes.latestItemAt) ? latestItemAt : notes?.latestItemAt ?? null });

  // Report dates: from a calendar source, and from the company's own date notices ("publishes its interim report on 28 October").
  const today = localDate(now, settings.timezone);
  const announced = merged.added
    .filter((event) => event.type === "report_notice" && (event.evidence === "official_disclosure" || event.evidence === "company_release"))
    .map((event) => {
      const date = noticeDate(event.title, { publishedAt: event.publishedAt });
      const report = detectReport(event.title, { notice: true });
      if (!date || !report || date < today) return null;
      const fiscalYear = report.fiscalYear ?? Number(date.slice(0, 4)) - ((report.period === "FY" || report.period === "Q4") && Number(date.slice(5, 7)) <= 6 ? 1 : 0);
      return { kind: report.kind, fiscalYear, period: report.period, date, time: null, status: "confirmed", url: event.sources[0]?.url ?? null };
    })
    .filter(Boolean);
  let events = merged.events;
  const added = [...merged.added];
  if (result.calendar || announced.length > 0) {
    const before = new Map(state.calendar.entries.map((entry) => [entry.key, entry.date]));
    state.calendar = mergeCalendar(state.calendar, [...(result.calendar ?? []), ...announced], { now, source });
    // A moved date is worth knowing: it becomes an event of its own, once per new date.
    const moves = state.calendar.entries
      .filter((entry) => before.has(entry.key) && before.get(entry.key) !== entry.date)
      .map((entry) => ({ sourceKey: source.key, sourceName: source.name, evidence: "official_disclosure", calendarChange: true, documentId: `calendar:${entry.key}:${entry.date}`, title: `Report date moved: ${entry.kind.replace("_", "-")} report${entry.period ? ` ${entry.period}` : ""}${entry.fiscalYear ? ` ${entry.fiscalYear}` : ""} from ${before.get(entry.key)} to ${entry.date}`, publishedAt: now.toISOString() }))
      .map((item) => normalizeItem(item, { watchId: record.id, security: record.security, now }));
    if (moves.length > 0) {
      const movedEvents = mergeEvents(events, moves, { watchId: record.id, baseline: false, now });
      events = movedEvents.events;
      added.push(...movedEvents.added);
    }
  }
  state.events = pruneEvents(events, settings.limits.eventsKeptPerSecurity);
  return { added, merged: merged.merged, baseline, catchUp };
}

/** The newest events stay; history found on a first check goes first when space runs out. */
function pruneEvents(events, keep) {
  if (events.length <= keep) return events;
  const order = (event) => Date.parse(event.publishedAt ?? event.discoveredAt) || 0;
  const sorted = [...events].sort((left, right) => Number(left.baseline) - Number(right.baseline) || order(right) - order(left));
  const kept = new Set(sorted.slice(0, keep).map((event) => event.id));
  return events.filter((event) => kept.has(event.id));
}

// --- Report calendar -------------------------------------------------------------------------

export const CALENDAR_STATUSES = Object.freeze(["confirmed", "estimated"]);

/**
 * Merges announced report dates into the security's calendar. An entry is one
 * upcoming report (kind and period). A changed date keeps the earlier one as
 * `previousDate`, and the change is noted for the event list. Nothing here
 * invents a date: an entry exists only when a source stated it.
 */
export function mergeCalendar(calendar, found, { now, source }) {
  const entries = calendar.entries.map((entry) => ({ ...entry }));
  for (const item of found) {
    const key = `${item.kind}:${item.fiscalYear ?? ""}:${item.period ?? ""}`;
    const existing = entries.find((entry) => entry.key === key);
    const status = CALENDAR_STATUSES.includes(item.status) ? item.status : "estimated";
    if (!existing) {
      entries.push({ key, kind: item.kind, fiscalYear: item.fiscalYear ?? null, period: item.period ?? null, date: item.date, time: item.time ?? null, status, source: { key: source.key, name: source.name, url: item.url ?? null }, firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), previousDate: null, changedAt: null });
      continue;
    }
    // A confirmed date is not replaced by an estimate.
    if (existing.status === "confirmed" && status === "estimated") continue;
    if (existing.date !== item.date) {
      existing.previousDate = existing.date;
      existing.changedAt = now.toISOString();
      existing.date = item.date;
    }
    Object.assign(existing, { time: item.time ?? existing.time, status, lastSeenAt: now.toISOString(), source: { key: source.key, name: source.name, url: item.url ?? existing.source?.url ?? null } });
  }
  return { entries, checkedAt: now.toISOString() };
}

/** The next report date on or after today, or null when no source has stated one. */
export function nextReportDate(calendar, { today, events = [] }) {
  // A report already published is not upcoming, even on its own date.
  const published = new Set(events.filter((event) => event.type === "report" && event.report).map((event) => reportIdentity(event.report)).filter(Boolean));
  return (
    (calendar?.entries ?? [])
      .filter((entry) => entry.date >= today && ["interim", "half_year", "year_end", "business_review", "earnings_release"].includes(entry.kind))
      .filter((entry) => !published.has(reportIdentity(entry)))
      .sort((left, right) => left.date.localeCompare(right.date))[0] ?? null
  );
}

// --- The run -----------------------------------------------------------------------------------

/**
 * One scheduled run. Returns the text to print (NO_REPLY: this monitor only
 * records; it sends nothing) and a report in counts and outcomes.
 * `sources` are the adapters (see stock-sources.mjs); `fetcher` comes from
 * createSourceFetcher.
 */
export async function runStockMonitor({ watchlistStore, monitorStore, settings, policy, sources, fetcher, now = new Date(), scheduled = true, only = null, force = false, clock = Date.now }) {
  // Checks stop starting two minutes before the job's own timeout; what is left is deferred to the next run.
  const deadline = clock() + (settings.jobTimeoutSeconds - 120) * 1000;
  const today = localDate(now, settings.timezone);
  const report = { today, scheduled, authorized: true, followed: 0, due: 0, checked: 0, deferred: 0, added: 0, merged: 0, baseline: 0, catchUp: 0, missed: 0, failures: [], requests: 0, issues: [] };
  const authorization = monitorAuthorization(policy, { today });
  if (!authorization.authorized && scheduled) {
    report.authorized = false;
    report.issues.push(authorization.reason);
    return { text: "NO_REPLY", report };
  }

  const { records, issues } = watchlistStore.listWithIssues();
  for (const issue of issues) report.issues.push(issue.message);
  const followed = records.filter((record) => record.status === "watching" && (!only || only.includes(record.id))).slice(0, settings.limits.maxSecurities);
  report.followed = followed.length;
  const states = new Map();
  for (const record of followed) {
    try {
      states.set(record.id, monitorStore.read(record.id) ?? emptyMonitorState(record.id));
    } catch (error) {
      report.issues.push(error.message);
    }
  }
  const due = dueChecks(followed.filter((record) => states.has(record.id)), states, sources, { now, settings, force });
  report.due = due.length;
  const work = due.slice(0, settings.limits.maxSourceChecksPerRun);
  report.deferred = due.length - work.length;

  for (const item of work) {
    const { record, source, notes, interval } = item;
    if (clock() > deadline) {
      report.deferred += 1;
      continue;
    }
    let result;
    try {
      result = await source.check(record.security, { fetcher, notes, now, settings, maxRequests: settings.limits.maxRequestsPerCheck });
    } catch (error) {
      result = { status: "error", reason: error.message };
    }
    if (result.status === "budget") {
      report.deferred += 1;
      continue;
    }
    report.checked += 1;
    const ok = result.status === "ok" || result.status === "not_modified";
    const outcome = monitorStore.mutate(record.id, (state) => {
      if (!ok) {
        state.sources[source.key] = failureNotes(state.sources[source.key], result, { now, interval });
        return state;
      }
      item.outcome = recordCheck(state, { record, source, result: result.status === "not_modified" ? { ...result, items: [] } : result, now, settings, interval });
      // Part of the source failed: what was read is kept, and the source is not called healthy.
      if (result.partial) Object.assign(state.sources[source.key], { health: "partial", lastError: sanitizeError(result.partial) });
      return state;
    });
    states.set(record.id, outcome);
    if (!ok) {
      report.failures.push({ watchId: record.id, source: source.key, status: result.status, reason: sanitizeError(result.reason ?? result.status) });
      continue;
    }
    if (result.partial) report.failures.push({ watchId: record.id, source: source.key, status: "partial", reason: sanitizeError(result.partial) });
    const { added, merged, baseline, catchUp } = item.outcome;
    report.added += baseline ? 0 : added.length;
    report.baseline += baseline ? added.length : 0;
    report.merged += merged.length;
    report.catchUp += catchUp ? added.length : 0;
    report.missed += added.filter((event) => event.missed).length;
  }
  report.documents = await confirmReportDocuments({ followed, monitorStore, sources, fetcher, now, settings, deadline, clock });
  report.requests = fetcher.requestsUsed();

  if (scheduled) {
    // Notes of securities that are no longer on the watchlist go with them.
    const known = new Set([...records.map((record) => record.id), ...issues.map((issue) => issue.id).filter(Boolean)]);
    for (const watchId of monitorStore.ids()) if (!known.has(watchId)) monitorStore.remove(watchId);
  }
  if (scheduled || report.requests > 0) {
    // The heartbeat is only a scheduled run's; the robots.txt rules read meanwhile are kept either way.
    monitorStore.withLock(() => {
      const global = monitorStore.readGlobal();
      const robots = fetcher.robots ?? global.robots;
      if (!scheduled) return monitorStore.writeGlobal({ ...global, robots });
      const lastRun = { at: now.toISOString(), followed: report.followed, due: report.due, checked: report.checked, deferred: report.deferred, added: report.added, baseline: report.baseline, failures: report.failures.length, requests: report.requests, issues: report.issues.length };
      return monitorStore.writeGlobal({ ...global, lastRunAt: now.toISOString(), lastRun, robots });
    });
  }
  return { text: "NO_REPLY", report };
}

/**
 * Whether newly published reports can actually be retrieved: for a report
 * found in the last three days whose release links its document (the report
 * PDF, the filing), the first 2 kB are read, which shows that it is there and
 * what it is. A few per run; the rest wait for the next run. The document is
 * never stored.
 */
async function confirmReportDocuments({ followed, monitorStore, sources, fetcher, now, settings, deadline, clock }) {
  const outcome = { checked: 0, retrieved: 0, failed: 0 };
  const bySource = new Map(sources.map((source) => [source.key, source]));
  const pending = [];
  for (const record of followed) {
    let state;
    try {
      state = monitorStore.read(record.id);
    } catch {
      continue;
    }
    for (const event of state?.events ?? []) {
      if (event.baseline || event.type !== "report" || !event.report || event.report.documentRetrieved !== null) continue;
      if (now.getTime() - Date.parse(event.discoveredAt) > 3 * 86_400_000) continue;
      const withDocument = event.sources.find((entry) => entry.documents?.length > 0 && bySource.get(entry.key)?.documentHosts);
      if (withDocument) pending.push({ record, event, link: withDocument.documents[0], source: bySource.get(withDocument.key) });
    }
  }
  for (const { record, event, link, source } of pending.slice(0, settings.limits.documentChecksPerRun)) {
    if (clock() > deadline) break;
    const page = await fetcher.get(link, { hosts: source.documentHosts, ...(source.userAgent ? { userAgent: source.userAgent } : {}), accept: "application/pdf, text/html;q=0.9, */*;q=0.5", firstBytes: 2048 });
    if (page.status === "budget") break;
    const retrieved = page.status === "ok";
    const type = !retrieved ? null : page.body.startsWith("%PDF") ? "pdf" : /<!doctype html|<html/i.test(page.body.slice(0, 1000)) ? "html" : "other";
    outcome.checked += 1;
    outcome[retrieved ? "retrieved" : "failed"] += 1;
    monitorStore.mutate(record.id, (state) => {
      const stored = state.events.find((candidate) => candidate.id === event.id);
      if (!stored?.report) return null;
      stored.report = { ...stored.report, documentRetrieved: retrieved, document: { url: link, type, checkedAt: now.toISOString(), problem: retrieved ? null : sanitizeError(page.reason ?? page.status) } };
      return state;
    });
  }
  return outcome;
}

// --- Views ---------------------------------------------------------------------------------------

const HEALTH_TEXT = { ok: "checked", partial: "checked only in part", degraded: "failing lately", failing: "failing", blocked: "refused" };

/**
 * Per-source health for one security, in words: what was checked when, what
 * failed and since when. "Never checked" is never shown as "nothing new".
 */
export function sourceHealthLines(record, state, sources, { timezone = DEFAULT_TIMEZONE } = {}) {
  const lines = [];
  for (const source of sources) {
    if (!source.enabledFor(record.monitoring)) continue;
    const coverage = source.coverage(record.security);
    if (coverage.status !== "available") {
      lines.push(`${source.label}: ${coverage.note}.`);
      continue;
    }
    const notes = state?.sources?.[source.key];
    if (!notes?.lastAttemptAt) {
      lines.push(`${source.label}: not checked yet.`);
      continue;
    }
    const success = notes.lastSuccessAt ? `last checked ${formatTime(notes.lastSuccessAt, timezone)}` : "never checked successfully";
    if (notes.health === "ok") lines.push(`${source.label}: ${success}.`);
    else lines.push(`${source.label}: ${HEALTH_TEXT[notes.health] ?? "failing"} (${notes.lastError ?? "unknown error"}); ${success}.`);
  }
  return lines;
}

/**
 * The followed sources that are not fully checked for a security: never
 * checked yet, failing, refused, or checked only in part. Whatever they would
 * have found is unknown, so a view of "what's new" must say so.
 */
export function sourceGaps(record, state, sources) {
  const gaps = [];
  for (const source of sources) {
    if (!source.enabledFor(record.monitoring) || source.coverage(record.security).status !== "available") continue;
    const notes = state?.sources?.[source.key];
    if (!notes?.lastAttemptAt) gaps.push({ key: source.key, label: source.label, problem: "not checked yet" });
    else if (notes.health !== "ok") gaps.push({ key: source.key, label: source.label, problem: `${HEALTH_TEXT[notes.health] ?? "failing"}: ${notes.lastError ?? "unknown error"}` });
  }
  return gaps;
}

export function formatTime(iso, timezone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

/** A redacted view of the monitor: the job, the heartbeat, counts, and source health without company names. */
export function monitorStatusView({ watchlistStore, monitorStore, jobs, sources, now, settings }) {
  const { records, issues } = watchlistStore.listWithIssues();
  const view = { job: null, lastRunAt: null, lastRun: null, followed: 0, paused: 0, sources: {}, events: { total: 0, last24h: 0, baseline: 0 }, unreadableRecords: issues.length, unreadableNotes: 0 };
  if (Array.isArray(jobs)) {
    const matches = jobs.filter((job) => job.name === STOCK_MONITOR_JOB);
    view.job = matches.length === 0 ? { installed: false } : { installed: true, duplicates: matches.length > 1, enabled: matches.some((job) => job.enabled), nextRunAt: matches[0].nextRunAt, lastRunAt: matches[0].lastRunAt, lastStatus: matches[0].lastStatus };
  }
  try {
    const global = monitorStore.readGlobal();
    view.lastRunAt = global.lastRunAt;
    view.lastRun = global.lastRun;
  } catch {
    view.unreadableNotes += 1;
  }
  for (const record of records) {
    if (record.status !== "watching") {
      view.paused += 1;
      continue;
    }
    view.followed += 1;
    let state;
    try {
      state = monitorStore.read(record.id);
    } catch {
      view.unreadableNotes += 1;
      continue;
    }
    for (const source of sources) {
      if (!source.enabledFor(record.monitoring)) continue;
      const tally = (view.sources[source.key] ??= { label: source.label, ok: 0, failing: 0, notChecked: 0, unavailable: 0, lastSuccessAt: null });
      if (source.coverage(record.security).status !== "available") {
        tally.unavailable += 1;
        continue;
      }
      const notes = state?.sources?.[source.key];
      if (!notes?.lastAttemptAt) tally.notChecked += 1;
      else if (notes.health === "ok") tally.ok += 1;
      else if (notes.health === "partial") tally.partial = (tally.partial ?? 0) + 1;
      else tally.failing += 1;
      if (notes?.lastSuccessAt && (!tally.lastSuccessAt || notes.lastSuccessAt > tally.lastSuccessAt)) tally.lastSuccessAt = notes.lastSuccessAt;
    }
    for (const event of state?.events ?? []) {
      view.events.total += 1;
      if (event.baseline) view.events.baseline += 1;
      else if (now.getTime() - Date.parse(event.discoveredAt) < 86_400_000) view.events.last24h += 1;
    }
  }
  return view;
}

export function formatMonitorStatus(view, { timezone = DEFAULT_TIMEZONE } = {}) {
  const lines = [];
  if (!view.job) lines.push("Stock monitor job: not checked.");
  else if (!view.job.installed) lines.push("Stock monitor job: not set up.");
  else lines.push(`Stock monitor job: ${view.job.enabled ? "on" : "off"}${view.job.duplicates ? " (more than one job has its name; remove the extra one)" : ""}${view.job.lastStatus ? `, last run ${view.job.lastStatus}` : ""}.`);
  lines.push(view.lastRunAt ? `Last run: ${formatTime(view.lastRunAt, timezone)}${view.lastRun ? ` (${view.lastRun.checked} source checks, ${view.lastRun.failures} failed, ${view.lastRun.deferred} deferred, ${view.lastRun.requests} requests)` : ""}.` : "Last run: never.");
  lines.push(`Followed: ${view.followed}${view.paused > 0 ? `, paused: ${view.paused}` : ""}.`);
  for (const tally of Object.values(view.sources)) {
    const parts = [`${tally.ok} ok`, tally.partial > 0 ? `${tally.partial} checked only in part` : null, tally.failing > 0 ? `${tally.failing} failing` : null, tally.notChecked > 0 ? `${tally.notChecked} not checked yet` : null, tally.unavailable > 0 ? `${tally.unavailable} not covered` : null].filter(Boolean);
    lines.push(`${tally.label}: ${parts.join(", ")}${tally.lastSuccessAt ? `; last success ${formatTime(tally.lastSuccessAt, timezone)}` : ""}.`);
  }
  lines.push(`Events: ${view.events.total} stored (${view.events.last24h} new in 24 h, ${view.events.baseline} history from first checks).`);
  if (view.unreadableRecords > 0 || view.unreadableNotes > 0) lines.push(`Unreadable: ${view.unreadableRecords} watchlist record(s), ${view.unreadableNotes} monitor note(s).`);
  return lines.join("\n");
}

// --- The scheduled job -------------------------------------------------------------------------

/** The one hourly command job. It runs no model and, in this version, prints NO_REPLY: it only records. */
export function buildStockMonitorJob(schedules, { telegramUserId, projectRoot, nodePath }) {
  if (!telegramUserId || !/^\d{5,}$/.test(String(telegramUserId))) throw new Error("TELEGRAM_USER_ID is required to install the stock monitor.");
  if (!projectRoot || !nodePath) throw new Error("The project root and a node path are required to install the stock monitor.");
  const settings = stockMonitorSettings(schedules);
  return {
    name: STOCK_MONITOR_JOB,
    description: "Hourly: checks public sources for the stocks you asked Hilla to follow and records new reports, announcements and news. No model; it never trades or changes the watchlist.",
    argv: [nodePath, "scripts/stocks.mjs", "monitor", "--scheduled"],
    cwd: projectRoot,
    schedule: { expr: `${settings.minute} * * * *`, tz: settings.timezone },
    timeoutSeconds: settings.jobTimeoutSeconds,
    delivery: { channel: "telegram", to: `telegram:${telegramUserId}`, accountId: "main" },
  };
}

/** `openclaw cron add|edit` arguments. Delivery is not best-effort, so a failed delivery fails the run. */
export function stockMonitorJobArgs(job, { edit = false } = {}) {
  return [
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
    ...(edit ? ["--no-best-effort-deliver", "--enable"] : []),
    "--command-argv",
    JSON.stringify(job.argv),
    "--command-cwd",
    job.cwd,
  ];
}

/** How a live job differs from the one this repo installs; an empty list means it matches. */
export function stockMonitorJobMismatches(live, job) {
  const mismatches = [];
  if (!live.enabled) mismatches.push("enabled");
  if (live.payload?.kind !== "command") mismatches.push("payload.kind");
  if (JSON.stringify(live.payload?.argv ?? null) !== JSON.stringify(job.argv)) mismatches.push("payload.argv");
  if (live.payload?.cwd !== job.cwd) mismatches.push("payload.cwd");
  if (live.payload?.timeoutSeconds !== job.timeoutSeconds) mismatches.push("payload.timeoutSeconds");
  if (live.schedule?.kind !== "cron" || live.schedule.expr !== job.schedule.expr || live.schedule.timezone !== job.schedule.tz) mismatches.push("schedule");
  if (live.delivery?.mode !== "announce" || live.delivery.channel !== job.delivery.channel || live.delivery.to !== job.delivery.to || live.delivery.accountId !== job.delivery.accountId) mismatches.push("delivery");
  if (live.delivery?.bestEffort) mismatches.push("delivery.bestEffort");
  return mismatches;
}

/** Add, update or leave the job; more than one job with its name is refused, never guessed at. */
export function planStockMonitorInstall(existingJobs, job) {
  const matches = existingJobs.filter((candidate) => candidate.name === job.name);
  if (matches.length > 1) return { action: "refuse", problem: `${matches.length} live jobs are named ${job.name}; remove the extra ones first.` };
  if (matches.length === 0) return { action: "add", args: stockMonitorJobArgs(job) };
  const [live] = matches;
  const mismatches = stockMonitorJobMismatches(live, job);
  return mismatches.length === 0 ? { action: "unchanged", jobId: live.id } : { action: "edit", jobId: live.id, mismatches, args: stockMonitorJobArgs(job, { edit: true }) };
}

/** "Investor AB (INVE B, Nasdaq Stockholm)" for texts; re-exported so the CLI needs one import. */
export { describeSecurity };
