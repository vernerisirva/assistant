/**
 * The private stock watchlist: the listed companies the user asked Hilla to
 * follow, how closely, and the investment thesis they chose to share.
 *
 * Following a stock is research, not ownership. A record never implies that
 * the user owns shares: ownership is unknown unless they said otherwise and
 * agreed to store it, and no position size, purchase price or portfolio value
 * is ever kept.
 *
 * The watchlist lives in its own owner-only folder under the ignored runtime
 * state (`<stateDir>/stock-watch/watchlist/`), one owner-only file per
 * security, written atomically under one lock. A record that cannot be read
 * is reported and skipped, never allowed to hide the others, and never
 * overwritten by a later change. It is kept apart from the contract register:
 * different folder, lock, ids and policy.
 *
 * Starting to follow a security, storing or changing a thesis, recording
 * ownership and removing a security are previews until the user's own yes
 * comes back with the preview's digest. Settings that only change how closely
 * Hilla watches (which sources, how loud, paused or not) run on the user's
 * request.
 *
 * Nothing in this module trades, places orders, connects to a broker or
 * contacts anyone.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { isApprovalMessage } from "./approval-language.mjs";
import { EXCHANGES, SOURCE_IDENTIFIERS, describeSecurity, nameKey, normalizeIdentifiers, normalizeSecurity, normalizeTicker, sameListing } from "./stock-identity.mjs";
import { withFileLockSync, writeFileAtomicSync } from "./state-file.mjs";

export const STOCK_SCHEMA_VERSION = 1;
export const WATCH_ID_PATTERN = /^sw-[0-9a-f]{8}$/;
export const STOCK_ACTIONS = Object.freeze(["add", "settings", "thesis", "ownership", "remove"]);
export const NOTIFICATION_LEVELS = Object.freeze(["critical", "important", "all", "off"]);
export const OWNERSHIP = Object.freeze(["unknown", "owns", "does_not_own"]);
export const MONITORING_KEYS = Object.freeze(["reports", "companyNews", "generalNews", "forums", "priceAlerts"]);
export const DEFAULT_MONITORING = Object.freeze({ reports: true, companyNews: true, generalNews: true, forums: false, priceAlerts: false });
export const DEFAULT_MAX_WATCHED = 25;
const HISTORY_LIMIT = 50;
const STATUSES = ["watching", "paused"];
const HISTORY_KINDS = new Set(["added", "settings", "thesis", "ownership"]);

export const MONITORING_LABELS = Object.freeze({
  reports: "reports and the report calendar",
  companyNews: "company announcements",
  generalNews: "news",
  forums: "investor forums",
  priceAlerts: "price alerts",
});

// --- Free text ----------------------------------------------------------------------

const CONTROL = /[\u{0}-\u{1f}\u{7f}]/gu;
const MARKUP = /[*_`[\]<>|\\~#]/g;
const ISO_DATES = /\b\d{4}-\d{2}-\d{2}\b/g;
const LONG_NUMBER = /\d(?:[\s.-]?\d){7,}/;
const IDENTIFIER_WORDS =
  /\b(?:personnummer|samordningsnummer|henkilötunnus|hetu|social security|ssn|passport|passnummer|(?:account|customer|client|depot|depå) ?(?:no|nr|number|id)\b|(?:konto|kund|depå|bank|clearing)(?:nummer|nr)|(?:asiakas|tili|arvo-osuustili)(?:numero|nro)|iban|bic|swift|bankgiro|plusgiro)\b/i;
const CREDENTIAL_WORDS = /\b(?:password|passcode|lösenord|salasana|pin(?:[- ]?(?:kod|code|koodi))?|bankid|login|log-?in|logga in|inloggning|användarnamn|username|security code|säkerhetskod)\b/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const LINK = /https?:\/\/|\bwww\./i;
const PHONE = /(?:\+|00)\d[\d\s-]{6,}\d/;
const INSTRUCTIONS =
  /\b(?:ignore|disregard|override|forget)\b[^.]{0,40}\b(?:instructions?|rules|prompts?|guidelines|orders|above|previous)\b|\bsystem prompt\b|\bdeveloper (?:message|mode)\b|\byou are now\b|\bas an ai\b|\b(?:run|execute|exec)\b[^.]{0,30}\b(?:commands?|scripts?|shell|terminal|code)\b|\bapi[ _-]?keys?\b|\btokens?\b|\bsudo\b|\brm -rf\b|\bcurl\b|\bwget\b|<\s*script|\bnpm run\b|\bopenclaw\b|\b(?:assistant|system|user)\s*:/i;

const TEXT_RULES = [
  [(text) => LINK.test(text), "leave links out"],
  [(text) => EMAIL.test(text), "leave email addresses out"],
  [(text) => CREDENTIAL_WORDS.test(text), "leave passwords, codes and login details out"],
  [(text) => IDENTIFIER_WORDS.test(text), "leave identity, account and bank numbers out"],
  [(text) => LONG_NUMBER.test(text.replace(ISO_DATES, " ")) || PHONE.test(text), "looks like an identity, account or phone number; leave it out"],
  [(text) => INSTRUCTIONS.test(text), "reads like instructions, not the user's own view; leave it out"],
];

/** One line of stored text, or a problem. The problem never repeats the text itself. */
export function checkStockText(value, { max }) {
  if (typeof value !== "string") return { problem: "must be text" };
  const text = value.normalize("NFC").replace(CONTROL, " ").replace(MARKUP, " ").replace(/\s+/g, " ").trim();
  if (!text) return { problem: "is empty" };
  if (text.length > max) return { problem: `is longer than ${max} characters` };
  for (const [breaks, message] of TEXT_RULES) {
    if (breaks(text)) return { problem: message };
  }
  return { value: text };
}

function checkTextList(value, { field, maxItems, itemMax }) {
  if (!Array.isArray(value) || value.length > maxItems) return { problem: `${field}: must be a list of at most ${maxItems} short items` };
  const items = [];
  for (const item of value) {
    const text = checkStockText(item, { max: itemMax });
    if (text.problem) return { problem: `${field}: an item ${text.problem}` };
    if (!items.some((existing) => existing.toLowerCase() === text.value.toLowerCase())) items.push(text.value);
  }
  return { value: items };
}

// --- Fields ------------------------------------------------------------------------

/** `{reports, companyNews, ...}` merged over `base`; price alerts are not supported. */
export function normalizeMonitoring(input, base = DEFAULT_MONITORING) {
  if (input === undefined) return { value: { ...base } };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { problem: `monitoring: must be an object with ${MONITORING_KEYS.join(", ")}` };
  const value = { ...base };
  for (const [key, raw] of Object.entries(input)) {
    if (!MONITORING_KEYS.includes(key)) return { problem: `monitoring.${key}: unknown (allowed: ${MONITORING_KEYS.join(", ")})` };
    if (typeof raw !== "boolean") return { problem: `monitoring.${key}: must be true or false` };
    value[key] = raw;
  }
  if (value.priceAlerts) return { problem: "monitoring.priceAlerts: price alerts are not supported; leave them off" };
  return { value };
}

/** A thesis is the user's own words: what they believe, which metrics matter, what would break it. */
export function normalizeThesis(input) {
  if (input === null) return { value: null };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { problem: "thesis: must be {statement, metrics, breakers} or null to remove it" };
  const extra = Object.keys(input).filter((key) => !["statement", "metrics", "breakers"].includes(key));
  if (extra.length > 0) return { problem: `thesis: unknown keys ${extra.join(", ")} (allowed: statement, metrics, breakers)` };
  const statement = checkStockText(input.statement, { max: 400 });
  if (statement.problem) return { problem: `thesis.statement: ${statement.problem}` };
  const metrics = input.metrics === undefined ? { value: [] } : checkTextList(input.metrics, { field: "thesis.metrics", maxItems: 8, itemMax: 60 });
  if (metrics.problem) return metrics;
  const breakers = input.breakers === undefined ? { value: [] } : checkTextList(input.breakers, { field: "thesis.breakers", maxItems: 8, itemMax: 120 });
  if (breakers.problem) return breakers;
  return { value: { statement: statement.value, metrics: metrics.value, breakers: breakers.value } };
}

function normalizeFocusAreas(input) {
  if (input === undefined) return { value: [] };
  return checkTextList(input, { field: "focusAreas", maxItems: 6, itemMax: 40 });
}

// --- Records -------------------------------------------------------------------------

export function newWatchId(random = randomBytes) {
  return `sw-${random(4).toString("hex")}`;
}

/** A canonical, order-independent digest of what the user is asked to approve. */
export function stockChangeDigest(action, { id = null, revision = 0, payload }) {
  return createHash("sha256").update(canonicalJson({ scope: "stock-watch", action, id, revision, payload })).digest("hex").slice(0, 16);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const isTimestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

/** A stored record is checked as strictly as new input, so a damaged or hand-edited file is reported, never half-used. */
function parseStoredRecord(document, expectedId) {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("is not a JSON object");
  if (document.schemaVersion !== STOCK_SCHEMA_VERSION) throw new Error(`has unsupported schema version ${document.schemaVersion}`);
  if (document.id !== expectedId) throw new Error("has an id that does not match its file name");
  if (!STATUSES.includes(document.status)) throw new Error("has an unknown status");
  if (!Number.isInteger(document.revision) || document.revision < 1) throw new Error("has no valid revision");
  if (!isTimestamp(document.addedAt) || !isTimestamp(document.updatedAt)) throw new Error("has invalid timestamps");
  const security = normalizeSecurity(document.security);
  if (security.problems.length > 0) throw new Error(`has an invalid security (${security.problems.map((problem) => problem.split(":")[0]).join(", ")})`);
  const monitoring = normalizeMonitoring(document.monitoring, Object.fromEntries(MONITORING_KEYS.map((key) => [key, false])));
  if (monitoring.problem || MONITORING_KEYS.some((key) => typeof document.monitoring?.[key] !== "boolean")) throw new Error("has invalid monitoring settings");
  if (!NOTIFICATION_LEVELS.includes(document.notificationLevel)) throw new Error("has an unknown notification level");
  if (!OWNERSHIP.includes(document.ownership)) throw new Error("has an unknown ownership value");
  if (normalizeFocusAreas(document.focusAreas).problem) throw new Error("has invalid focus areas");
  if (document.thesis !== null) {
    const thesis = document.thesis;
    if (!thesis || typeof thesis !== "object" || !isTimestamp(thesis.setAt) || normalizeThesis({ statement: thesis.statement, metrics: thesis.metrics, breakers: thesis.breakers }).problem) {
      throw new Error("has an invalid thesis");
    }
  }
  if (!Array.isArray(document.history) || document.history.length === 0) throw new Error("has no history");
  for (const entry of document.history) {
    const valid = entry && typeof entry === "object" && isTimestamp(entry.at) && Number.isInteger(entry.revision) && HISTORY_KINDS.has(entry.kind) && Array.isArray(entry.changes);
    if (!valid) throw new Error("has a malformed history entry");
  }
  return document;
}

// --- Store -------------------------------------------------------------------------

export function resolveStockWatchDir(stateDir) {
  if (!stateDir) throw new Error("A state directory is required for the stock watchlist.");
  return join(stateDir, "stock-watch");
}

/**
 * The watchlist on disk. Folders are owner-only (0700) and record files
 * owner-only (0600); both are re-applied on every write. Writes replace a file
 * atomically, and `withLock` serializes read-check-write cycles across
 * processes.
 */
export function createWatchlistStore({ stateDir, lockTimeoutMs }) {
  const root = resolveStockWatchDir(stateDir);
  const recordsDir = join(root, "watchlist");
  const recordPath = (id) => join(recordsDir, `${requireWatchId(id)}.json`);
  const base = dirname(root);

  const ensure = () => {
    for (const dir of [root, recordsDir]) ensurePrivateDir(dir, { base });
  };

  function read(id) {
    const path = recordPath(id);
    if (!existsSync(path) && !isLink(path)) {
      const missing = new Error(`No watched security with id ${id}.`);
      missing.code = "STOCK_NOT_FOUND";
      throw missing;
    }
    assertPlainDir(root, { base });
    assertPlainDir(recordsDir, { base });
    if (!lstatSync(path).isFile()) throw unreadableRecord(id, "is not a regular file");
    let document;
    try {
      document = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw unreadableRecord(id, "is not valid JSON");
    }
    try {
      return parseStoredRecord(document, id);
    } catch (error) {
      throw unreadableRecord(id, error.message);
    }
  }

  /** Unreadable files are reported, never allowed to hide the other records. */
  function listWithIssues() {
    assertPlainDir(root, { base });
    if (!existsSync(recordsDir)) return { records: [], issues: [] };
    assertPlainDir(recordsDir, { base });
    const records = [];
    const issues = [];
    for (const name of readdirSync(recordsDir).filter((entry) => entry.endsWith(".json")).sort()) {
      const id = name.slice(0, -".json".length);
      if (!WATCH_ID_PATTERN.test(id)) {
        issues.push({ file: name, id: null, message: `Watchlist file ${name} has an unexpected file name.`, reason: "has an unexpected file name" });
        continue;
      }
      try {
        records.push(read(id));
      } catch (error) {
        issues.push({ file: name, id, message: error.message, reason: error.reason ?? "could not be read" });
      }
    }
    return { records, issues };
  }

  function write(record) {
    ensure();
    writeFileAtomicSync(recordPath(record.id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return record;
  }

  function withLock(fn) {
    ensure();
    return withFileLockSync(join(root, "watchlist"), fn, lockTimeoutMs === undefined ? {} : { timeoutMs: lockTimeoutMs });
  }

  /** Folders or files that someone other than the owner could read. */
  function permissionProblems() {
    const problems = [];
    const check = (path, expected) => {
      if (!existsSync(path) && !isLink(path)) return;
      const mode = lstatSync(path).mode & 0o777;
      if (mode & 0o077) problems.push({ path: relative(base, path), mode: mode.toString(8).padStart(4, "0"), expected });
    };
    check(root, "0700");
    check(recordsDir, "0700");
    if (existsSync(recordsDir)) {
      for (const name of readdirSync(recordsDir).filter((entry) => entry.endsWith(".json"))) check(join(recordsDir, name), "0600");
    }
    return problems;
  }

  return {
    root,
    recordsDir,
    read,
    listWithIssues,
    write,
    withLock,
    permissionProblems,
    remove: (id) => rmSync(recordPath(id), { force: true }),
    exists: (id) => existsSync(recordPath(id)),
  };
}

export function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Creates an owner-only folder, or re-applies 0700. A link or anything but a plain folder is refused, never followed. */
export function ensurePrivateDir(dir, { base }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPlainDir(dir, { base });
  chmodSync(dir, 0o700);
}

export function assertPlainDir(dir, { base }) {
  if ((existsSync(dir) || isLink(dir)) && !lstatSync(dir).isDirectory()) {
    throw new Error(`The stock watch folder ${relative(base, dir)} is not a plain folder; refusing to use it.`);
  }
}

function requireWatchId(id) {
  if (typeof id !== "string" || !WATCH_ID_PATTERN.test(id)) throw new Error("A watched security's id looks like sw-1a2b3c4d.");
  return id;
}

function unreadableRecord(id, reason) {
  const error = new Error(`Watchlist record ${id} could not be read: it ${reason}.`);
  error.code = "STOCK_UNREADABLE";
  error.reason = reason;
  return error;
}

// --- Finding one watched security ------------------------------------------------------

const STOP_WORDS = new Set(["my", "the", "a", "an", "this", "that", "stock", "stocks", "share", "shares", "aktie", "aktien", "aktierna", "osake", "osakkeet", "company", "bolaget", "yhtiö", "in", "on", "of", "watchlist"]);

function tokens(text) {
  return String(text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function recordTokens(record) {
  const { security } = record;
  const ticker = security.ticker ? [...tokens(security.ticker), security.ticker.toLowerCase().replace(/[ .-]/g, "")] : [];
  return [record.id, ...tokens(nameKey(security.companyName)), ...ticker, ...(security.shareClass ? [security.shareClass.toLowerCase()] : []), ...(security.isin ? [security.isin.toLowerCase()] : [])];
}

/**
 * Exactly one watched security for an id or the user's words ("Investor B",
 * "Fortnox", "MSFT"), or the candidates to ask about. Every word must match
 * the record's name, ticker, share class or ISIN, so "Investor" with both
 * share classes watched is ambiguous and "Investor B" is not.
 */
export function resolveWatched(records, selector = {}) {
  if (selector.id !== undefined) {
    const record = records.find((candidate) => candidate.id === selector.id);
    return record ? { status: "resolved", record, candidates: [record] } : { status: "none", candidates: [] };
  }
  const words = tokens(selector.target).filter((word) => !STOP_WORDS.has(word));
  const matches = words.length === 0
    ? []
    : records.filter((record) => {
        const hay = recordTokens(record);
        return words.every((word) => hay.some((candidate) => candidate === word || (word.length >= 3 && candidate.startsWith(word))));
      });
  if (matches.length === 1) return { status: "resolved", record: matches[0], candidates: matches };
  return { status: matches.length === 0 ? "none" : "ambiguous", candidates: matches };
}

// --- Actions ---------------------------------------------------------------------------

/**
 * Runs one watchlist action. `add`, `thesis`, `ownership` and `remove` are
 * previews unless the input carries `approval: {digest, replyText}` with the
 * preview's digest and a plain yes. `settings` runs on the user's request.
 * `coverage(security, monitoring)` says which sources can follow a security.
 */
export function runStockAction(action, input, { store, now = new Date(), random = randomBytes, coverage = () => [], maxWatched = DEFAULT_MAX_WATCHED, monitorRunning = false }) {
  if (!STOCK_ACTIONS.includes(action)) throw new Error(`Unknown stock watchlist action: ${action}`);
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid(["the input must be a JSON object"]);
  const { approval, ...payload } = input;
  if (approval !== undefined && action === "settings") return invalid(["approval: settings run on the user's request and take no approval"]);
  const context = { store, now, random, approval, coverage, maxWatched, monitorRunning };
  switch (action) {
    case "add":
      return addSecurity(payload, context);
    case "settings":
      return changeSettings(payload, context);
    case "thesis":
      return changeThesis(payload, context);
    case "ownership":
      return changeOwnership(payload, context);
    case "remove":
      return removeSecurity(payload, context);
    default:
      throw new Error(`Unknown stock watchlist action: ${action}`);
  }
}

function addSecurity(payload, context) {
  const allowed = ["security", "monitoring", "notificationLevel", "focusAreas", "thesis", "ownership"];
  const extra = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (extra.length > 0) return invalid([`${extra.join(", ")}: unknown keys (add takes ${allowed.join(", ")})`]);
  const problems = [];
  const security = normalizeSecurity(payload.security);
  problems.push(...security.problems);
  const monitoring = normalizeMonitoring(payload.monitoring);
  if (monitoring.problem) problems.push(monitoring.problem);
  const notificationLevel = payload.notificationLevel ?? "important";
  if (!NOTIFICATION_LEVELS.includes(notificationLevel)) problems.push(`notificationLevel: must be ${NOTIFICATION_LEVELS.join(", ")}`);
  const focusAreas = normalizeFocusAreas(payload.focusAreas);
  if (focusAreas.problem) problems.push(focusAreas.problem);
  const thesis = payload.thesis === undefined ? { value: null } : normalizeThesis(payload.thesis);
  if (thesis.problem) problems.push(thesis.problem);
  const ownership = payload.ownership ?? "unknown";
  if (!OWNERSHIP.includes(ownership)) problems.push(`ownership: must be ${OWNERSHIP.join(", ")}`);
  if (problems.length > 0) return invalid(problems);

  const draft = { security: security.value, monitoring: monitoring.value, notificationLevel, focusAreas: focusAreas.value, thesis: thesis.value, ownership };
  const { records } = context.store.listWithIssues();
  const blocked = addBlocked(records, draft, context);
  if (blocked) return blocked;
  const digest = stockChangeDigest("add", { payload: draft });

  if (context.approval === undefined) {
    return {
      ok: true,
      status: "preview",
      action: "add",
      digest,
      sources: context.coverage(draft.security, draft.monitoring),
      telegramText: formatAddPreview(draft, context),
      guidance:
        "Nothing is saved yet. Send telegramText unchanged (one short sentence before it is fine) and wait for the user's reply. Save only after a plain yes: run add again with the same JSON plus {\"approval\": {\"digest\": \"<digest>\", \"replyText\": \"<their exact reply>\"}}. If they change something, run a new preview instead.",
    };
  }
  const refusal = approvalRefusal(context.approval, digest);
  if (refusal) return refusal;

  return context.store.withLock(() => {
    const again = addBlocked(context.store.listWithIssues().records, draft, context);
    if (again) return again;
    const at = context.now.toISOString();
    const record = {
      schemaVersion: STOCK_SCHEMA_VERSION,
      id: uniqueId(context),
      revision: 1,
      status: "watching",
      security: draft.security,
      monitoring: draft.monitoring,
      notificationLevel: draft.notificationLevel,
      focusAreas: draft.focusAreas,
      thesis: draft.thesis ? { ...draft.thesis, setAt: at } : null,
      ownership: draft.ownership,
      addedAt: at,
      updatedAt: at,
      history: [{ at, revision: 1, kind: "added", changes: [], reason: null }],
    };
    context.store.write(record);
    return { ok: true, status: "saved", action: "add", security: summarizeWatched(record), telegramText: formatAdded(record, context) };
  });
}

function addBlocked(records, draft, context) {
  const duplicate = records.find((record) => sameListing(record.security, draft.security));
  if (duplicate) {
    return {
      ok: false,
      status: "duplicate",
      candidates: [{ id: duplicate.id, name: describeSecurity(duplicate.security) }],
      telegramText: `${describeSecurity(duplicate.security)} is already on your watchlist${duplicate.status === "paused" ? " (paused)" : ""}.`,
      guidance: "Nothing was saved. Change the existing entry with settings or thesis instead.",
    };
  }
  if (records.length >= context.maxWatched) {
    return {
      ok: false,
      status: "limit",
      telegramText: `Your watchlist already has ${records.length} securities, the most I follow. Remove one first if you want to follow this one.`,
      guidance: "Nothing was saved.",
    };
  }
  return null;
}

function uniqueId(context) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = newWatchId(context.random);
    if (!context.store.exists(id)) return id;
  }
  throw new Error("Could not pick a new watchlist id.");
}

/** How closely to watch one security: sources, notification level, focus areas, paused or not. On the user's request. */
function changeSettings(payload, context) {
  const allowed = ["id", "target", "monitoring", "notificationLevel", "focusAreas", "status", "sources"];
  const extra = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (extra.length > 0) return invalid([`${extra.join(", ")}: unknown keys (settings takes id or target, monitoring, notificationLevel, focusAreas, status and sources)`]);
  if (!["monitoring", "notificationLevel", "focusAreas", "status", "sources"].some((key) => payload[key] !== undefined)) {
    return invalid(["settings: give at least one of monitoring, notificationLevel, focusAreas, status or sources"]);
  }
  const sources = payload.sources === undefined ? null : normalizeSourceChanges(payload.sources);
  if (sources?.problems.length > 0) return invalid(sources.problems);
  if (payload.notificationLevel !== undefined && !NOTIFICATION_LEVELS.includes(payload.notificationLevel)) return invalid([`notificationLevel: must be ${NOTIFICATION_LEVELS.join(", ")}`]);
  if (payload.status !== undefined && !STATUSES.includes(payload.status)) return invalid([`status: must be ${STATUSES.join(" or ")}`]);
  const focusAreas = payload.focusAreas === undefined ? null : normalizeFocusAreas(payload.focusAreas);
  if (focusAreas?.problem) return invalid([focusAreas.problem]);
  return context.store.withLock(() => {
    const resolution = resolveSelector(context.store.listWithIssues().records, payload);
    if (resolution.status !== "resolved") return resolution;
    const record = resolution.record;
    const monitoring = normalizeMonitoring(payload.monitoring, record.monitoring);
    if (monitoring.problem) return invalid([monitoring.problem]);
    const identifiers = { ...record.security.identifiers };
    for (const [key, value] of Object.entries(sources?.value ?? {})) {
      if (value === null) delete identifiers[key];
      else identifiers[key] = value;
    }
    const next = {
      ...record,
      security: { ...record.security, identifiers },
      monitoring: monitoring.value,
      notificationLevel: payload.notificationLevel ?? record.notificationLevel,
      focusAreas: focusAreas ? focusAreas.value : record.focusAreas,
      status: payload.status ?? record.status,
    };
    const changes = ["status", "monitoring", "notificationLevel", "focusAreas"]
      .filter((key) => canonicalJson(record[key]) !== canonicalJson(next[key]))
      .map((key) => ({ field: key, from: record[key], to: next[key] }));
    if (canonicalJson(record.security.identifiers) !== canonicalJson(identifiers)) changes.push({ field: "sources", from: record.security.identifiers, to: identifiers });
    if (changes.length === 0) return { ok: true, status: "unchanged", action: "settings", security: summarizeWatched(record), telegramText: formatSettings(record, context) };
    const saved = bumpRevision(next, context.now.toISOString(), "settings", changes, null);
    context.store.write(saved);
    return { ok: true, status: "saved", action: "settings", security: summarizeWatched(saved), telegramText: formatSettings(saved, context, changes) };
  });
}

/**
 * Where sources find the company (its Cision newsroom, MFN id, calendar code,
 * forum thread, news name). They change where Hilla looks, never which
 * security it is; null removes one.
 */
function normalizeSourceChanges(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { value: null, problems: [`sources: must be an object with ${SOURCE_IDENTIFIERS.join(", ")}`] };
  const problems = [];
  const value = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!SOURCE_IDENTIFIERS.includes(key)) {
      problems.push(`sources.${key}: not a source setting (allowed: ${SOURCE_IDENTIFIERS.join(", ")})`);
      continue;
    }
    if (raw === null) {
      value[key] = null;
      continue;
    }
    const checked = normalizeIdentifiers({ [key]: raw }, problems);
    if (checked[key] !== undefined) value[key] = checked[key];
  }
  return { value, problems: problems.map((problem) => problem.replace(/^security\.identifiers\./, "sources.")) };
}

function changeThesis(payload, context) {
  const extra = Object.keys(payload).filter((key) => !["id", "target", "thesis", "reason"].includes(key));
  if (extra.length > 0) return invalid([`${extra.join(", ")}: unknown keys (thesis takes id or target, thesis and reason)`]);
  if (!("thesis" in payload)) return invalid(["thesis: give the thesis {statement, metrics, breakers}, or null to remove it"]);
  const thesis = normalizeThesis(payload.thesis);
  if (thesis.problem) return invalid([thesis.problem]);
  return changeRecord("thesis", payload, context, (record) => {
    const current = record.thesis ? { statement: record.thesis.statement, metrics: record.thesis.metrics, breakers: record.thesis.breakers } : null;
    if (canonicalJson(current) === canonicalJson(thesis.value)) return { unchanged: true };
    return { field: "thesis", from: current, to: thesis.value, apply: (at) => ({ thesis: thesis.value ? { ...thesis.value, setAt: at } : null }) };
  });
}

function changeOwnership(payload, context) {
  const extra = Object.keys(payload).filter((key) => !["id", "target", "ownership"].includes(key));
  if (extra.length > 0) return invalid([`${extra.join(", ")}: unknown keys (ownership takes id or target and ownership)`]);
  if (!OWNERSHIP.includes(payload.ownership)) return invalid([`ownership: must be ${OWNERSHIP.join(", ")}; no amounts or prices are stored`]);
  return changeRecord("ownership", payload, context, (record) => {
    if (record.ownership === payload.ownership) return { unchanged: true };
    return { field: "ownership", from: record.ownership, to: payload.ownership, apply: () => ({ ownership: payload.ownership }) };
  });
}

/**
 * The shared preview-then-commit path for an approval-gated change to one
 * record. The commit re-reads the record under the lock and refuses when it
 * changed since the preview, so a stale yes never overwrites newer details.
 */
function changeRecord(action, payload, context, build) {
  let reason = null;
  if (payload.reason !== undefined && payload.reason !== null) {
    const text = checkStockText(payload.reason, { max: 200 });
    if (text.problem) return invalid([`reason: ${text.problem}`]);
    reason = text.value;
  }
  const resolution = resolveSelector(context.store.listWithIssues().records, payload);
  if (resolution.status !== "resolved") return resolution;
  const record = resolution.record;
  const built = build(record);
  if (built.unchanged) {
    return { ok: true, status: "unchanged", action, security: summarizeWatched(record), telegramText: `That doesn't change anything stored for ${describeSecurity(record.security)}.` };
  }
  const digest = stockChangeDigest(action, { id: record.id, revision: record.revision, payload: { from: built.from, to: built.to, reason } });
  if (context.approval === undefined) {
    return {
      ok: true,
      status: "preview",
      action,
      digest,
      watchId: record.id,
      telegramText: formatChangePreview(action, record, built),
      guidance:
        "Nothing is saved yet. Send telegramText unchanged and wait for the user's reply. Save only after a plain yes: run the same command again with {\"id\": \"<watchId>\"}, the same change and {\"approval\": {\"digest\": \"<digest>\", \"replyText\": \"<their exact reply>\"}}.",
    };
  }
  const refusal = approvalRefusal(context.approval, digest);
  if (refusal) return refusal;
  return context.store.withLock(() => {
    const current = context.store.read(record.id);
    if (current.revision !== record.revision) return changedSincePreview();
    const at = context.now.toISOString();
    const next = bumpRevision({ ...current, ...built.apply(at) }, at, action, [{ field: built.field, from: built.from, to: built.to }], reason);
    context.store.write(next);
    return { ok: true, status: "saved", action, security: summarizeWatched(next), telegramText: formatChangeSaved(action, next) };
  });
}

function removeSecurity(payload, context) {
  const extra = Object.keys(payload).filter((key) => !["id", "target"].includes(key));
  if (extra.length > 0) return invalid([`${extra.join(", ")}: unknown keys for remove`]);
  const { records, issues } = context.store.listWithIssues();
  // An unreadable record can be removed by its id, so a broken file never has to stay.
  const broken = payload.id !== undefined ? issues.find((issue) => issue.id === payload.id) : null;
  const resolution = broken ? null : resolveSelector(records, payload);
  if (resolution && resolution.status !== "resolved") return resolution;
  const record = resolution?.record ?? null;
  const id = record?.id ?? broken.id;
  const digest = stockChangeDigest("remove", { id, revision: record?.revision ?? 0, payload: { id } });
  if (context.approval === undefined) {
    return {
      ok: true,
      status: "preview",
      action: "remove",
      digest,
      watchId: id,
      telegramText: record
        ? `Remove ${describeSecurity(record.security)} from your watchlist? Its settings${record.thesis ? ", your thesis" : ""} and the events I've found go with it, and I stop checking its sources. To keep everything, I can pause it instead. Reply yes to remove.`
        : "One watchlist record can't be read. Delete that record file? This can't be undone. Reply yes to delete.",
      guidance: "Nothing is removed yet. Remove only after a plain yes, with the digest and their exact reply as approval.",
    };
  }
  const refusal = approvalRefusal(context.approval, digest);
  if (refusal) return refusal;
  return context.store.withLock(() => {
    if (record && context.store.read(id).revision !== record.revision) return changedSincePreview();
    if (!record && !context.store.listWithIssues().issues.some((issue) => issue.id === id)) return changedSincePreview();
    context.store.remove(id);
    return {
      ok: true,
      status: "removed",
      action: "remove",
      watchId: id,
      telegramText: record ? `Removed ${describeSecurity(record.security)} from your watchlist.` : "Deleted the unreadable watchlist record.",
    };
  });
}

function bumpRevision(record, at, kind, changes, reason) {
  const revision = record.revision + 1;
  return { ...record, revision, updatedAt: at, history: [...record.history, { at, revision, kind, changes, reason }].slice(-HISTORY_LIMIT) };
}

function resolveSelector(records, payload) {
  const hasId = payload.id !== undefined;
  const hasTarget = payload.target !== undefined;
  if (hasId === hasTarget) return invalid(["id or target: give exactly one (an id from list, or the user's words for the stock)"]);
  if (hasId && (typeof payload.id !== "string" || !WATCH_ID_PATTERN.test(payload.id))) return invalid(["id: looks like sw-1a2b3c4d"]);
  if (hasTarget && (typeof payload.target !== "string" || payload.target.length > 80)) return invalid(["target: must be the user's words for the stock, at most 80 characters"]);
  const resolution = resolveWatched(records, hasId ? { id: payload.id } : { target: payload.target });
  if (resolution.status === "resolved") return resolution;
  if (resolution.status === "none") return { ok: false, status: "not_found", telegramText: "That stock isn't on your watchlist.", candidates: [] };
  return {
    ok: false,
    status: "ambiguous",
    candidates: resolution.candidates.map((record) => ({ id: record.id, name: describeSecurity(record.security) })),
    telegramText: `Which one do you mean? ${resolution.candidates.map((record) => describeSecurity(record.security)).join("; ")}.`,
    guidance: "Nothing was changed. Ask the user which one they mean, then run the command again with its id.",
  };
}

function approvalRefusal(approval, digest) {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) return invalid(["approval: must be {digest, replyText}"]);
  if (approval.digest !== digest) return changedSincePreview();
  if (!isApprovalMessage(approval.replyText, { hasPendingApproval: true })) {
    return {
      ok: false,
      status: "not_approved",
      message: "The reply is not a plain yes, so nothing was saved. Ask the user to confirm the shown details, or make the change they asked for and show a new preview.",
    };
  }
  return null;
}

function changedSincePreview() {
  return {
    ok: false,
    status: "changed_since_preview",
    message: "These details differ from what the user was shown, or the record changed since. Nothing was saved. Run the command again without approval and show the new preview.",
  };
}

function invalid(problems) {
  return { ok: false, status: "invalid", problems, message: "Nothing was saved. Fix every listed problem and run the command again; never guess a value the user or an official source did not give." };
}

// --- Text ------------------------------------------------------------------------------

const LEVEL_TEXT = {
  critical: "only time-critical events",
  important: "important events",
  all: "everything I find",
  off: "nothing (I keep watching quietly)",
};

function securityLines(security) {
  const exchange = EXCHANGES[security.exchange];
  const lines = [`${security.companyName} — ${security.ticker ?? "ticker not known"}${security.shareClass ? ` (${security.shareClass} share)` : ""}, ${exchange.name}, ${security.currency}`];
  const ids = [security.isin ? `ISIN ${security.isin}` : "ISIN unknown"];
  const verified = { "esma-firds": "ESMA's instrument register (ISIN, exchange, currency)", "sec-edgar": "SEC EDGAR's company list" }[security.verification.source];
  ids.push(verified ? `checked against ${verified}` : "not checked against an official listing");
  lines.push(ids.join(" · "));
  return lines;
}

function sourceLines(sources) {
  if (sources.length === 0) return ["Sources: none of my sources can follow this listing yet."];
  return [
    "Sources I'd check:",
    ...sources.map((source) => `- ${source.label}${source.status === "available" ? "" : ` (${source.note})`}`),
  ];
}

function monitoringSummary(monitoring) {
  const on = MONITORING_KEYS.filter((key) => monitoring[key]).map((key) => MONITORING_LABELS[key]);
  return on.length > 0 ? on.join(", ") : "nothing";
}

function formatAddPreview(draft, context) {
  const lines = ["Here's the listing I'd follow:", "", ...securityLines(draft.security), "", ...sourceLines(context.coverage(draft.security, draft.monitoring))];
  lines.push(`Following: ${monitoringSummary(draft.monitoring)}. Forums ${draft.monitoring.forums ? "on" : "off"}; price alerts aren't supported.`);
  if (draft.focusAreas.length > 0) lines.push(`Your focus: ${draft.focusAreas.join(", ")}.`);
  if (draft.thesis) lines.push(`Your thesis: ${draft.thesis.statement}`);
  if (draft.ownership !== "unknown") lines.push(`You ${draft.ownership === "owns" ? "own" : "don't own"} shares (no amounts are kept).`);
  lines.push("", "Start following it? It stays in a private watchlist on this computer; only public company identifiers are used to check sources. Reply yes to start, or tell me what to change.");
  return lines.join("\n");
}

function formatAdded(record, context) {
  const lines = [`Now following ${describeSecurity(record.security)}.`];
  lines.push(
    context.monitorRunning
      ? "I check its sources on a schedule and keep what's new; ask “What's new with it?” any time."
      : "Scheduled checks aren't running yet; until they are, ask me to check it any time.",
  );
  return lines.join("\n");
}

function formatSettings(record, context, changes = []) {
  const name = describeSecurity(record.security);
  if (record.status === "paused") return `Paused ${name}: I keep it on your watchlist but don't check its sources until you say resume.`;
  const lines = [changes.length === 0 ? `No change for ${name}.` : `Updated ${name}.`];
  lines.push(`Following: ${monitoringSummary(record.monitoring)}.`);
  lines.push(`Notifications: ${LEVEL_TEXT[record.notificationLevel]}.`);
  if (record.focusAreas.length > 0) lines.push(`Your focus: ${record.focusAreas.join(", ")}.`);
  if (changes.some((change) => change.field === "status")) lines.push(context.monitorRunning ? "Checks resume with the next scheduled run." : "Scheduled checks aren't running yet.");
  return lines.join("\n");
}

function thesisLines(thesis) {
  if (!thesis) return ["(none)"];
  const lines = [thesis.statement];
  if (thesis.metrics.length > 0) lines.push(`Metrics that matter: ${thesis.metrics.join("; ")}`);
  if (thesis.breakers.length > 0) lines.push(`Would break it: ${thesis.breakers.join("; ")}`);
  return lines;
}

function formatChangePreview(action, record, built) {
  const name = describeSecurity(record.security);
  if (action === "thesis") {
    if (built.to === null) return [`Remove your investment thesis for ${name}?`, "", ...thesisLines(built.from), "", "I'd then report its news without a thesis to measure it against. Reply yes to remove."].join("\n");
    return [
      `${built.from ? "Replace" : "Save"} your investment thesis for ${name}:`,
      "",
      ...thesisLines(built.to),
      ...(built.from ? ["", "Instead of:", ...thesisLines(built.from)] : []),
      "",
      "These are your assumptions, in your words; I only measure news against them and never change them on my own. Reply yes to save, or tell me what to change.",
    ].join("\n");
  }
  const text = { owns: "you own shares", does_not_own: "you don't own shares", unknown: "unknown" }[built.to];
  return `Record that ${text === "unknown" ? "your ownership of" : text + " in"} ${name}${text === "unknown" ? " is unknown" : ""}? Only that is kept: no amounts, prices or account details. It lets me say when a corporate action may concern you. Reply yes to save.`;
}

function formatChangeSaved(action, record) {
  const name = describeSecurity(record.security);
  if (action === "thesis") return record.thesis ? `Saved your thesis for ${name}.` : `Removed your thesis for ${name}.`;
  return `Saved for ${name}: ${{ owns: "you own shares", does_not_own: "you don't own shares", unknown: "ownership unknown" }[record.ownership]}.`;
}

/** What a list or another command may hand back about one watched security. */
export function summarizeWatched(record) {
  return {
    id: record.id,
    name: describeSecurity(record.security),
    companyName: record.security.companyName,
    ticker: record.security.ticker,
    exchange: record.security.exchange,
    isin: record.security.isin,
    status: record.status,
    monitoring: { ...record.monitoring },
    notificationLevel: record.notificationLevel,
    hasThesis: record.thesis !== null,
  };
}

export function formatWatchlist(records, issues) {
  const lines = [];
  if (records.length === 0) lines.push("Your stock watchlist is empty.");
  else {
    lines.push(`Your stock watchlist (${records.length})`);
    const sorted = [...records].sort((left, right) => left.security.companyName.localeCompare(right.security.companyName) || String(left.security.ticker ?? left.security.isin).localeCompare(String(right.security.ticker ?? right.security.isin)));
    for (const record of sorted) {
      const state = record.status === "paused" ? "paused" : `following ${monitoringSummary(record.monitoring)}`;
      lines.push(`- ${describeSecurity(record.security)}: ${state}${record.thesis ? " · thesis saved" : ""}`);
    }
  }
  if (issues.length > 0) lines.push("", `${issues.length === 1 ? "One watchlist record" : `${issues.length} watchlist records`} couldn't be read, so ${issues.length === 1 ? "it isn't" : "they aren't"} shown or checked. Ask me to check the watchlist.`);
  return lines.join("\n");
}

export function formatWatchedDetail(record, { sources = [] } = {}) {
  const lines = [...securityLines(record.security)];
  lines.push(`Status: ${record.status === "paused" ? "paused" : "following"} · notifications: ${LEVEL_TEXT[record.notificationLevel]}`);
  lines.push(`Following: ${monitoringSummary(record.monitoring)}.`);
  if (sources.length > 0) lines.push(...sourceLines(sources));
  if (record.focusAreas.length > 0) lines.push(`Your focus: ${record.focusAreas.join(", ")}.`);
  lines.push(`Thesis: ${record.thesis ? thesisLines(record.thesis).join(" · ") : "none saved"}`);
  if (record.ownership !== "unknown") lines.push(`Ownership: ${record.ownership === "owns" ? "you own shares" : "you don't own shares"} (no amounts kept).`);
  return lines.join("\n");
}

/** A redacted health view: counts and problems, never which companies. */
export function watchlistStatus(store) {
  const { records, issues } = store.listWithIssues();
  const permissions = store.permissionProblems();
  return {
    securities: records.length,
    watching: records.filter((record) => record.status === "watching").length,
    paused: records.filter((record) => record.status === "paused").length,
    withThesis: records.filter((record) => record.thesis !== null).length,
    unreadable: issues.map((issue) => ({ file: issue.file, reason: issue.reason })),
    permissions: { ok: permissions.length === 0, problems: permissions },
  };
}

export function formatWatchlistStatus(status) {
  const lines = [
    status.securities === 0
      ? "Stock watchlist: empty."
      : `Stock watchlist: ${status.securities} securit${status.securities === 1 ? "y" : "ies"} (${status.watching} followed, ${status.paused} paused), ${status.withThesis} with a thesis.`,
    status.permissions.ok ? "Storage: private (owner-only folder and files)." : `Storage: ${status.permissions.problems.length} path(s) readable by others; fix the permissions.`,
  ];
  if (status.unreadable.length > 0) lines.push(`Unreadable: ${status.unreadable.map((issue) => `${issue.file} (${issue.reason})`).join("; ")}. Remove it with the user's OK, or fix the file.`);
  return lines.join("\n");
}

/** The ticker a user typed, upper-cased, for messages; null when it isn't one. */
export function tickerFromWords(text) {
  return normalizeTicker(text);
}
