/**
 * The repo's one interface to the live OpenClaw Gateway scheduler.
 *
 * OpenClaw 2026.7 keeps cron jobs, their run state and their history in the
 * Gateway's SQLite state database. It imported the old
 * `<stateDir>/cron/jobs.json` once, renamed it `jobs.json.migrated`, and no
 * longer reads it, so no file under `.openclaw/state/cron/` is a source of
 * truth for anything.
 *
 * Every read and change here goes through the supported CLI
 * (`openclaw cron list|get|status|enable|disable|edit|add`), which calls the
 * running Gateway. Nothing reads the Gateway database directly.
 *
 * Jobs come back in one normalized shape (`normalizeCronJob`). Print them with
 * `publicCronJob`, which leaves out routing details such as the Telegram
 * destination and the session key.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolveOpenClawCommand, resolveOpenClawConfigPath, resolveOpenClawStateDir } from "./commands.mjs";

export const LIVE_CRON_SOURCE = "openclaw-gateway";

/**
 * The Gateway's `cron.update` persists a change and re-arms its scheduler timer
 * before it answers, so a successful CLI mutation is already live. No command
 * here asks for a Gateway restart.
 */
export const LIVE_CRON_RESTART_REQUIRED = false;

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KNOWN_SCHEDULE_KINDS = new Set(["cron", "at", "every"]);
// Read-view fields that change on every run; they are not part of what a job is.
const RUNTIME_FIELDS = new Set(["state", "status", "updatedAtMs", "nextRunAtMs", "runningAtMs"]);
const rawDefinitions = new WeakMap();

export class LiveCronError extends Error {
  constructor(message) {
    super(message);
    this.name = "LiveCronError";
  }
}

/**
 * The adapter the CLIs use: the Gateway's own OpenClaw CLI, run with the repo
 * .env plus the project config and state, as the Gateway's wrapper does. The
 * CLI reads the Gateway token from that config itself, so no token is ever
 * passed on a command line. The runtime is resolved on first use, so a missing
 * runtime becomes a clear error from the first call.
 */
export function createGatewayCron({ root, env = {}, runOpenClaw } = {}) {
  if (runOpenClaw) return createLiveCron({ run: runOpenClaw });

  const configPath = resolveOpenClawConfigPath(env, root);
  const stateDir = resolveOpenClawStateDir(env, root);
  return createLiveCron({
    run: createOpenClawCliRunner({
      command: () => resolveOpenClawCommand(env),
      cwd: root,
      env: { ...process.env, ...env, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: stateDir },
      redact: createSecretRedactor({ env, config: readJsonQuietly(configPath) }),
    }),
  });
}

export function createLiveCron({ run }) {
  const runJson = async (args, label) => parseCliJson(await run(args), label);

  const mutate = async (id, args, label) => {
    assertJobId(id);
    const stdout = await run(args);
    try {
      return normalizeCronJob(parseCliJson(stdout, label));
    } catch {
      // The change went through; read the job back instead of trusting odd output.
      return get(id);
    }
  };

  async function list() {
    const parsed = await runJson(["cron", "list", "--all", "--json"], "cron list");
    const rawJobs = Array.isArray(parsed) ? parsed : parsed?.jobs;
    if (!Array.isArray(rawJobs)) throw new LiveCronError("openclaw cron list returned no jobs array.");
    const total = Number.isInteger(parsed?.total) ? parsed.total : rawJobs.length;
    if (parsed?.hasMore === true || total !== rawJobs.length) {
      throw new LiveCronError(`openclaw cron list returned ${rawJobs.length} of ${total} jobs; a partial list cannot be used.`);
    }
    return rawJobs.map(normalizeCronJob);
  }

  async function get(id) {
    assertJobId(id);
    return normalizeCronJob(await runJson(["cron", "get", id], "cron get"));
  }

  async function schedulerStatus() {
    const parsed = await runJson(["cron", "status", "--json"], "cron status");
    return {
      enabled: parsed?.enabled !== false,
      storage: typeof parsed?.storage === "string" ? parsed.storage : null,
      jobCount: Number.isInteger(parsed?.jobs) ? parsed.jobs : null,
      nextWakeAt: isoFromMs(parsed?.nextWakeAtMs),
    };
  }

  return {
    list,
    get,
    schedulerStatus,
    enable: (id) => mutate(id, ["cron", "enable", id], "cron enable"),
    disable: (id) => mutate(id, ["cron", "disable", id], "cron disable"),
    // Without --stagger/--exact the Gateway keeps the job's stagger; the
    // timezone is passed explicitly so it never falls back to the host's.
    setCronExpression: (id, expr, { timezone } = {}) =>
      mutate(id, ["cron", "edit", id, `--cron=${expr}`, ...(timezone ? [`--tz=${timezone}`] : [])], "cron edit"),
    rescheduleOneShot: (id, at) => mutate(id, ["cron", "edit", id, `--at=${at}`], "cron edit"),
    edit: (id, args) => mutate(id, ["cron", "edit", id, ...args], "cron edit"),
    add: async (args) => {
      const parsed = await runJson(["cron", "add", ...args, "--json"], "cron add");
      return normalizeCronJob(parsed?.job ?? parsed);
    },
  };
}

/** A read-only snapshot for status views. A failure is reported, never replaced by stale data. */
export async function loadLiveCronSnapshot(cron) {
  try {
    const [jobs, scheduler] = await Promise.all([cron.list(), cron.schedulerStatus().catch(() => null)]);
    return { available: true, source: LIVE_CRON_SOURCE, jobs, scheduler, error: null };
  } catch (error) {
    return { available: false, source: LIVE_CRON_SOURCE, jobs: [], scheduler: null, error: error.message };
  }
}

/**
 * Runs one planned change and proves what happened: it lists the Gateway jobs
 * again, returns the target as the Gateway now reports it, and names every
 * field that changed on the target and every other job whose definition
 * changed meanwhile. Run state (next/last run) is not part of a definition.
 */
export async function applyLiveJobChange(cron, { beforeJobs, job, intendedFields = [], run }) {
  await run(cron);
  const afterJobs = await cron.list();
  const after = afterJobs.find((candidate) => candidate.id === job.id);
  if (!after) throw new LiveCronError(`${job.name} [${job.id}] is missing from the Gateway after the change.`);
  const changedFields = changedDefinitionFields(job, after);
  return {
    after,
    afterJobs,
    changedFields,
    unexpectedFields: changedFields.filter((field) => !intendedFields.includes(field)),
    unrelatedJobsChanged: changedJobs(beforeJobs, afterJobs, { exceptIds: [job.id] }),
  };
}

/**
 * Planned changes to one live job. Each plan says whether anything would
 * change, what the job would look like (`preview`; the Gateway computes the
 * next run, so it is null there), and how to apply and check the change.
 */
export function planEnabledChange(job, enabled) {
  const changed = job.enabled !== enabled;
  return {
    action: enabled ? "enable" : "disable",
    job,
    changed,
    preview: changed ? { ...job, enabled, nextRunAt: null } : job,
    intendedFields: ["enabled"],
    apply: (cron) => (enabled ? cron.enable(job.id) : cron.disable(job.id)),
    appliedIn: (after) => after.enabled === enabled,
  };
}

export function planCronExpressionChange(job, expr) {
  if (job.schedule.kind !== "cron") {
    throw new LiveCronError(`${job.name} [${job.id}] is not a cron job (its schedule kind is ${job.schedule.kind}).`);
  }
  const { timezone } = job.schedule;
  const changed = expr !== job.schedule.expr;
  return {
    action: "set-time",
    job,
    changed,
    preview: changed ? { ...job, schedule: { ...job.schedule, expr }, nextRunAt: null } : job,
    intendedFields: ["schedule.expr"],
    apply: (cron) => cron.setCronExpression(job.id, expr, { timezone }),
    appliedIn: (after) => after.schedule.kind === "cron" && after.schedule.expr === expr && after.schedule.timezone === timezone,
  };
}

export function planOneShotChange(job, at) {
  if (job.schedule.kind !== "at") {
    throw new LiveCronError(`${job.name} [${job.id}] is not a one-shot job (its schedule kind is ${job.schedule.kind}).`);
  }
  const changed = Date.parse(at) !== Date.parse(job.schedule.at);
  return {
    action: "reschedule",
    job,
    changed,
    preview: changed ? { ...job, schedule: { ...job.schedule, at }, nextRunAt: null } : job,
    intendedFields: ["schedule.at"],
    apply: (cron) => cron.rescheduleOneShot(job.id, at),
    appliedIn: (after) => after.schedule.kind === "at" && Date.parse(after.schedule.at) === Date.parse(at),
  };
}

/**
 * Carries out a plan unless it is a dry run or would change nothing. A change
 * the Gateway did not apply is an error; anything else it changed is reported.
 */
export async function executeJobChange(cron, plan, { beforeJobs, dryRun = false }) {
  if (dryRun || !plan.changed) {
    return { applied: false, changed: plan.changed, before: plan.job, after: plan.preview, verification: null };
  }
  const outcome = await applyLiveJobChange(cron, {
    beforeJobs,
    job: plan.job,
    intendedFields: plan.intendedFields,
    run: plan.apply,
  });
  if (!plan.appliedIn(outcome.after)) {
    throw new LiveCronError(`The Gateway did not apply ${plan.action} to ${plan.job.name} [${plan.job.id}].`);
  }
  return {
    applied: true,
    changed: true,
    before: plan.job,
    after: outcome.after,
    verification: {
      changedFields: outcome.changedFields,
      unexpectedFields: outcome.unexpectedFields,
      unrelatedJobsChanged: outcome.unrelatedJobsChanged,
    },
  };
}

/** Hilla's view of one Gateway job. Unknown schedule and payload kinds are kept, marked, and never guessed. */
export function normalizeCronJob(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const state = source.state && typeof source.state === "object" ? source.state : {};
  const warnings = [];
  const timestamp = (field) => {
    const value = state[field] ?? source[field];
    if (value === undefined || value === null) return null;
    const iso = isoFromMs(value);
    if (!iso) warnings.push(`invalid ${field}`);
    return iso;
  };
  const enabled = source.enabled !== false;
  const job = {
    id: stringOrNull(source.id),
    name: typeof source.name === "string" ? source.name : "",
    description: stringOrNull(source.description),
    agentId: stringOrNull(source.agentId),
    enabled,
    status: stringOrNull(source.status) ?? deriveStatus(enabled, state),
    schedule: normalizeSchedule(source.schedule),
    sessionTarget: stringOrNull(source.sessionTarget),
    sessionKey: stringOrNull(source.sessionKey),
    wakeMode: stringOrNull(source.wakeMode),
    payload: normalizePayload(source.payload),
    delivery: normalizeDelivery(source.delivery),
    deleteAfterRun: source.deleteAfterRun === true,
    nextRunAt: timestamp("nextRunAtMs"),
    lastRunAt: timestamp("lastRunAtMs"),
    lastStatus: stringOrNull(state.lastStatus) ?? stringOrNull(state.lastRunStatus) ?? stringOrNull(source.lastRunStatus),
    lastErrorReason: stringOrNull(state.lastErrorReason),
    warnings,
  };
  rawDefinitions.set(job, rawJobDefinition(source));
  return job;
}

/** What a status view may print: no description, Telegram destination, session key, prompt text or command line. */
export function publicCronJob(job) {
  return {
    id: job.id,
    name: job.name,
    agentId: job.agentId,
    enabled: job.enabled,
    status: job.status,
    schedule: job.schedule,
    payload: job.payload?.kind ?? null,
    delivery: job.delivery ? { mode: job.delivery.mode, channel: job.delivery.channel } : null,
    nextRunAt: job.nextRunAt,
    lastRunAt: job.lastRunAt,
    lastStatus: job.lastStatus,
    lastErrorReason: job.lastErrorReason,
  };
}

export function summarizeCronJobs(jobs) {
  const count = (predicate) => jobs.filter(predicate).length;
  const enabledJobs = count((job) => job.enabled);
  return {
    totalJobs: jobs.length,
    enabledJobs,
    disabledJobs: jobs.length - enabledJobs,
    cronJobs: count((job) => job.schedule.kind === "cron"),
    intervalJobs: count((job) => job.schedule.kind === "every"),
    oneTimeJobs: count((job) => job.schedule.kind === "at"),
    otherScheduleJobs: count((job) => !KNOWN_SCHEDULE_KINDS.has(job.schedule.kind)),
    dailyRecurringJobs: count((job) => job.enabled && isDailyCronSchedule(job.schedule)),
  };
}

/** A cron schedule that fires every day at fixed times, such as `30 12 * * *` (not `*\/15 * * * *`). */
export function isDailyCronSchedule(schedule) {
  if (schedule?.kind !== "cron" || typeof schedule.expr !== "string") return false;
  const parts = schedule.expr.trim().split(/\s+/);
  return (
    parts.length === 5 &&
    /^\d+(,\d+)*$/.test(parts[0]) &&
    /^\d+(,\d+)*$/.test(parts[1]) &&
    parts[2] === "*" &&
    parts[3] === "*" &&
    parts[4] === "*"
  );
}

/** Dotted names of the definition fields that differ, such as `enabled` or `schedule.expr`. */
export function changedDefinitionFields(before, after) {
  return diffPaths(definitionOf(before), definitionOf(after));
}

/** Jobs that were added, removed or redefined between two list snapshots. */
export function changedJobs(beforeJobs, afterJobs, { exceptIds = [] } = {}) {
  const skip = new Set(exceptIds);
  const afterById = new Map(afterJobs.map((job) => [job.id, job]));
  const beforeIds = new Set();
  const changes = [];
  for (const before of beforeJobs) {
    beforeIds.add(before.id);
    if (skip.has(before.id)) continue;
    const after = afterById.get(before.id);
    if (!after) {
      changes.push({ id: before.id, name: before.name, change: "removed" });
      continue;
    }
    const fields = changedDefinitionFields(before, after);
    if (fields.length > 0) changes.push({ id: before.id, name: before.name, change: "changed", fields });
  }
  for (const after of afterJobs) {
    if (!beforeIds.has(after.id) && !skip.has(after.id)) changes.push({ id: after.id, name: after.name, change: "added" });
  }
  return changes;
}

/**
 * A printable command line. Tokens and the Telegram destination/session key
 * are masked and prompt text is reduced to its length.
 */
export function maskCronCommandForDisplay({ command, args }) {
  const masked = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    const [flag, ...rest] = arg.split("=");
    const inlineValue = arg.includes("=") && arg.startsWith("--") ? rest.join("=") : null;
    const kind = { "--token": "secret", "--to": "secret", "--session-key": "secret", "--message": "text" }[flag];
    if (!kind) {
      masked.push(arg);
      continue;
    }
    if (inlineValue !== null) {
      masked.push(`${flag}=${maskValue(kind, inlineValue)}`);
      continue;
    }
    masked.push(arg);
    if (index + 1 < args.length) {
      masked.push(maskValue(kind, String(args[index + 1])));
      index += 1;
    }
  }
  return [command, ...masked].join(" ");
}

/**
 * Masks secrets from the environment and config, and the user's Telegram id,
 * in anything a CLI failure could carry back.
 */
export function createSecretRedactor({ env = {}, config = {} } = {}) {
  const secrets = new Set();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.length >= 8 && /(TOKEN|KEY|SECRET|PASSWORD)$/i.test(key)) secrets.add(value);
  }
  collectConfigSecrets(config, secrets);
  const ordered = [...secrets].sort((left, right) => right.length - left.length);
  const telegramUserId = typeof env.TELEGRAM_USER_ID === "string" && /^\d{5,}$/.test(env.TELEGRAM_USER_ID.trim())
    ? env.TELEGRAM_USER_ID.trim()
    : null;

  return (text) => {
    let redacted = String(text ?? "");
    for (const secret of ordered) redacted = redacted.split(secret).join("<redacted>");
    if (telegramUserId) redacted = redacted.split(telegramUserId).join("<telegram-id>");
    return redacted.replace(/\b\d{5,}:[A-Za-z0-9_-]{30,}/g, "<redacted>");
  };
}

/**
 * Runs the CLI without a shell. A failure becomes one redacted line naming the
 * subcommand; its arguments (prompt text, Telegram destination) and stdout are
 * never echoed.
 */
export function createOpenClawCliRunner({ command, cwd, env, redact = (text) => text, execFileImpl = execFile, timeoutMs = 60_000 }) {
  return (args, { timeoutMs: callTimeoutMs = timeoutMs } = {}) =>
    new Promise((resolvePromise, reject) => {
      let resolvedCommand;
      try {
        resolvedCommand = typeof command === "function" ? command() : command;
      } catch (error) {
        reject(new LiveCronError(redact(error.message)));
        return;
      }
      const options = { cwd, env, timeout: callTimeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" };
      execFileImpl(resolvedCommand, args, options, (error, stdout, stderr) => {
        if (!error) {
          resolvePromise(String(stdout ?? ""));
          return;
        }
        reject(new LiveCronError(redact(describeCliFailure({ args, error, stderr, command: resolvedCommand, timeoutMs: callTimeoutMs }))));
      });
    });
}

function describeCliFailure({ args, error, stderr, command, timeoutMs }) {
  const action = `openclaw ${args.slice(0, 2).join(" ")}`;
  if (error.code === "ENOENT") return `${action} failed: OpenClaw CLI not found at ${command}.`;
  if (error.killed) return `${action} failed: timed out after ${Math.round(timeoutMs / 1000)}s.`;
  const line = String(stderr ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry && !/^OpenClaw \d{4}\./.test(entry));
  return `${action} failed: ${line ? line.slice(0, 300) : `exit code ${error.code ?? "unknown"}`}`;
}

function parseCliJson(stdout, label) {
  const text = String(stdout ?? "").trim();
  try {
    return JSON.parse(text);
  } catch {
    // Fall through: the CLI may print a notice around the JSON.
  }
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((index) => index >= 0);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (starts.length > 0 && end > Math.min(...starts)) {
    try {
      return JSON.parse(text.slice(Math.min(...starts), end + 1));
    } catch {
      // Reported below without echoing the output.
    }
  }
  throw new LiveCronError(`openclaw ${label} did not return JSON.`);
}

function assertJobId(id) {
  if (typeof id !== "string" || !JOB_ID_PATTERN.test(id)) {
    throw new LiveCronError(`Refusing an unexpected cron job id: ${JSON.stringify(id)}`);
  }
}

function normalizeSchedule(schedule) {
  const kind = typeof schedule?.kind === "string" ? schedule.kind : "unknown";
  if (kind === "cron" && typeof schedule.expr === "string") {
    return {
      kind,
      expr: schedule.expr,
      timezone: stringOrNull(schedule.tz),
      staggerMs: Number.isFinite(schedule.staggerMs) ? schedule.staggerMs : null,
    };
  }
  if (kind === "at" && typeof schedule.at === "string") {
    const atMs = Date.parse(schedule.at);
    return { kind, at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : schedule.at };
  }
  if (kind === "every" && Number.isFinite(schedule.everyMs) && schedule.everyMs > 0) {
    return { kind, everyMs: schedule.everyMs, anchorAt: isoFromMs(schedule.anchorMs) };
  }
  return { kind, supported: false };
}

function normalizePayload(payload) {
  const kind = typeof payload?.kind === "string" ? payload.kind : "unknown";
  if (kind === "agentTurn") {
    return { kind, message: stringOrNull(payload.message), timeoutSeconds: integerOrNull(payload.timeoutSeconds) };
  }
  if (kind === "command") {
    return {
      kind,
      argv: Array.isArray(payload.argv) ? payload.argv.map(String) : null,
      cwd: stringOrNull(payload.cwd),
      timeoutSeconds: integerOrNull(payload.timeoutSeconds),
    };
  }
  if (kind === "systemEvent") return { kind, text: stringOrNull(payload.text) };
  return { kind };
}

function normalizeDelivery(delivery) {
  if (!delivery || typeof delivery !== "object") return null;
  return {
    mode: stringOrNull(delivery.mode),
    channel: stringOrNull(delivery.channel),
    to: stringOrNull(delivery.to),
    accountId: stringOrNull(delivery.accountId),
    bestEffort: delivery.bestEffort === true,
  };
}

function deriveStatus(enabled, state) {
  if (!enabled) return "disabled";
  if (Number.isFinite(state.runningAtMs)) return "running";
  return stringOrNull(state.lastRunStatus) ?? stringOrNull(state.lastStatus) ?? "idle";
}

function rawJobDefinition(raw) {
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => !RUNTIME_FIELDS.has(key) && !/^last[A-Z]/.test(key)),
  );
}

// A copied job has lost its raw definition; its normalized fields still compare.
function definitionOf(job) {
  if (rawDefinitions.has(job)) return rawDefinitions.get(job);
  const { status, nextRunAt, lastRunAt, lastStatus, lastErrorReason, warnings, ...definition } = job ?? {};
  return definition;
}

function diffPaths(left, right, prefix = "", depth = 0) {
  const keys = [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])].sort();
  const paths = [];
  for (const key of keys) {
    const a = left?.[key];
    const b = right?.[key];
    if (stableJson(a) === stableJson(b)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (depth === 0 && isPlainObject(a) && isPlainObject(b)) paths.push(...diffPaths(a, b, path, depth + 1));
    else paths.push(path);
  }
  return paths;
}

function stableJson(value) {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, (_, entry) =>
    isPlainObject(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry,
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function maskValue(kind, value) {
  return kind === "text" ? `<${value.length} chars>` : "<redacted>";
}

function collectConfigSecrets(value, secrets, key = "") {
  if (!value || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    const compoundKey = `${key}.${childKey}`.toLowerCase();
    if (typeof childValue === "string") {
      if (/(token|secret|password|credential|key)$/.test(compoundKey) && childValue.length >= 8 && !/^\$\{[^}]+\}$/.test(childValue)) {
        secrets.add(childValue);
      }
    } else if (childValue && typeof childValue === "object") {
      collectConfigSecrets(childValue, secrets, compoundKey);
    }
  }
}

function readJsonQuietly(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  } catch {
    return {};
  }
}

function isoFromMs(value) {
  const ms = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}
