/**
 * Local persistence for weekly plans.
 *
 * The plan file is the authority, never the chat history: a proposal is
 * written before it is shown, every revision is a new stored version, and the
 * apply step reads the stored version back instead of rebuilding anything.
 * Files live under the ignored runtime state directory and survive gateway
 * restarts.
 *
 * States:
 * - draft: stored, not yet shown to the user. Never applies.
 * - pending: shown; applies after the review deadline or on explicit OK.
 * - applying: task creation in progress; a crash leaves this state and the
 *   next check resumes it without redoing finished operations.
 * - applied: every operation was created, already existed, or had a date in
 *   the past.
 * - applied_with_errors: at least one operation failed and at least one
 *   succeeded. Final; failed items are reported, not retried automatically.
 * - failed: nothing could be created. Final.
 * - cancelled: final; never applies.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_APPLY_CHECK_MINUTES,
  DEFAULT_REVIEW_WINDOW_HOURS,
  computeReviewDeadline,
  digestPlan,
  isoWeekId,
} from "./weekly-plan.mjs";

export const PLAN_SCHEMA_VERSION = 1;
export const OPEN_STATUSES = Object.freeze(["draft", "pending", "applying"]);
export const FINAL_STATUSES = Object.freeze(["applied", "applied_with_errors", "failed", "cancelled"]);
const DONE_OUTCOMES = new Set(["created", "already_exists", "skipped_past_date", "failed"]);
const LOCK_STALE_MS = 15 * 60_000;
const LOCK_HEARTBEAT_MS = 60_000;

export function resolveWeeklyPlanDir(stateDir) {
  return join(stateDir, "weekly-plan");
}

export function createWeeklyPlanStore({
  stateDir,
  lockStaleMs = LOCK_STALE_MS,
  lockHeartbeatMs = LOCK_HEARTBEAT_MS,
  clock = () => Date.now(),
  isProcessAlive = processIsAlive,
} = {}) {
  if (!stateDir) throw new Error("A state directory is required for the weekly plan store.");
  const root = resolveWeeklyPlanDir(stateDir);
  const plansDir = join(root, "plans");
  const locksDir = join(root, "locks");

  const planPath = (planId) => join(plansDir, `${requirePlanId(planId)}.json`);

  function readPlan(planId) {
    const path = planPath(planId);
    if (!existsSync(path)) throw new Error(`No weekly plan found with id ${planId}.`);
    const document = JSON.parse(readFileSync(path, "utf8"));
    if (document.schemaVersion !== PLAN_SCHEMA_VERSION) {
      throw new Error(`Weekly plan ${planId} has unsupported schema version ${document.schemaVersion}.`);
    }
    return document;
  }

  function writePlan(document) {
    mkdirSync(plansDir, { recursive: true });
    const path = planPath(document.planId);
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return document;
  }

  /**
   * Unreadable files are skipped and reported, never allowed to block the
   * other plans: the scheduled check must keep working, and status surfaces
   * the problem.
   */
  function listPlansWithIssues() {
    if (!existsSync(plansDir)) return { plans: [], issues: [] };
    const plans = [];
    const issues = [];
    for (const name of readdirSync(plansDir).filter((entry) => entry.endsWith(".json"))) {
      try {
        plans.push(readPlan(name.slice(0, -".json".length)));
      } catch (error) {
        issues.push({ file: name, message: error.message });
      }
    }
    plans.sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.createdAt.localeCompare(b.createdAt));
    return { plans, issues };
  }

  function listPlans() {
    return listPlansWithIssues().plans;
  }

  /**
   * Runs `fn` while holding the plan's lock file. Every mutation goes through
   * here, so an OK in chat and the scheduled check can never apply the same
   * plan twice at once. The holder refreshes the lock while it works, so a slow
   * Todoist call never makes a live lock look abandoned. A lock is taken over
   * only when it is old and its owning process is gone, and a holder removes
   * the lock only if it still carries its own token.
   */
  async function withPlanLock(planId, fn) {
    mkdirSync(locksDir, { recursive: true });
    const lockPath = join(locksDir, `${requirePlanId(planId)}.lock`);
    const token = randomBytes(8).toString("hex");
    let descriptor;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const held = readLock(lockPath);
      const abandoned = held && clock() - held.mtimeMs >= lockStaleMs && !isProcessAlive(held.pid);
      if (!abandoned) {
        const busy = new Error(`Weekly plan ${planId} is being updated right now.`);
        busy.code = "PLAN_LOCKED";
        throw busy;
      }
      if (readLock(lockPath)?.token === held.token) rmSync(lockPath, { force: true });
      descriptor = openSync(lockPath, "wx", 0o600);
    }
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, at: new Date(clock()).toISOString() }));
    const heartbeat = setInterval(() => {
      try {
        const now = new Date();
        utimesSync(lockPath, now, now);
      } catch {
        // A missing lock is handled when the holder releases it.
      }
    }, lockHeartbeatMs);
    heartbeat.unref();
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      closeSync(descriptor);
      if (readLock(lockPath)?.token === token) rmSync(lockPath, { force: true });
    }
  }

  async function mutatePlan(planId, mutate) {
    return withPlanLock(planId, async () => {
      const next = await mutate(readPlan(planId));
      return next ? writePlan(next) : readPlan(planId);
    });
  }

  return { root, plansDir, readPlan, writePlan, listPlans, listPlansWithIssues, withPlanLock, mutatePlan };
}

/** `{ pid, token, mtimeMs }` of a lock file, or null when it is gone. Unreadable content counts as ownerless. */
function readLock(lockPath) {
  let mtimeMs;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    return { pid: Number(content.pid), token: content.token ?? null, mtimeMs };
  } catch {
    return { pid: NaN, token: null, mtimeMs };
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function newPlanId(weekStart, random = () => randomBytes(3).toString("hex")) {
  return `wp-${isoWeekId(weekStart)}-${random()}`;
}

// ---------------------------------------------------------------------------
// Pure transitions. Each takes a document and returns a new one.

export function createPlanDocument({ planId, inputs, plan, now, source = "scheduled", timezone }) {
  const at = toIso(now);
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId,
    weekId: isoWeekId(inputs.weekStart),
    weekStart: inputs.weekStart,
    weekEnd: plan.weekEnd,
    timezone,
    status: "draft",
    createdAt: at,
    updatedAt: at,
    currentVersion: 1,
    displayedVersion: null,
    displayedAt: null,
    displayedDigest: null,
    displayChannel: null,
    reviewWindowHours: null,
    reviewDeadline: null,
    versions: [{ version: 1, createdAt: at, source, changeSummary: [], note: null, inputs, plan, digest: digestPlan(plan) }],
    apply: null,
    cancelledAt: null,
    history: [{ at, event: "created", version: 1 }],
  };
}

/**
 * Records that `version` was shown to the user at `displayedAt` and starts its
 * review window. Only the current version can be shown.
 */
export function markPlanDisplayed(
  document,
  {
    version,
    displayedAt,
    channel,
    messageId = null,
    reviewWindowHours = DEFAULT_REVIEW_WINDOW_HOURS,
    roundMinutes = DEFAULT_APPLY_CHECK_MINUTES,
  },
) {
  if (!["draft", "pending"].includes(document.status)) {
    throw new Error(`Weekly plan ${document.planId} is ${document.status} and cannot be shown for review.`);
  }
  if (version !== document.currentVersion) {
    throw new Error(`Only the current version (v${document.currentVersion}) of ${document.planId} can be shown.`);
  }
  const entry = versionEntry(document, version);
  const at = toIso(displayedAt);
  return {
    ...document,
    status: "pending",
    updatedAt: at,
    displayedVersion: version,
    displayedAt: at,
    displayedDigest: entry.digest,
    displayChannel: channel,
    reviewWindowHours,
    reviewDeadline: computeReviewDeadline(at, { hours: reviewWindowHours, roundMinutes }),
    applyDeferrals: null,
    history: [...document.history, { at, event: "displayed", version, channel, ...(messageId ? { messageId } : {}) }],
  };
}

export function addPlanRevision(document, { expectedVersion, inputs, plan, changeSummary, note, now }) {
  if (!["draft", "pending"].includes(document.status)) {
    throw new Error(`Weekly plan ${document.planId} is ${document.status} and can no longer be changed.`);
  }
  if (expectedVersion !== document.currentVersion) {
    throw new Error(
      `Weekly plan ${document.planId} is at v${document.currentVersion}, not v${expectedVersion}. Show the current version before changing it.`,
    );
  }
  const at = toIso(now);
  const version = document.currentVersion + 1;
  return {
    ...document,
    updatedAt: at,
    currentVersion: version,
    versions: [
      ...document.versions,
      { version, createdAt: at, source: "revision", changeSummary, note, inputs, plan, digest: digestPlan(plan) },
    ],
    history: [...document.history, { at, event: "revised", version, changeSummary }],
  };
}

export function cancelPlan(document, { now, reason = null }) {
  if (!["draft", "pending"].includes(document.status)) {
    throw new Error(
      document.status === "cancelled"
        ? `Weekly plan ${document.planId} is already cancelled.`
        : `Weekly plan ${document.planId} is ${document.status}; it can no longer be cancelled.`,
    );
  }
  const at = toIso(now);
  return {
    ...document,
    status: "cancelled",
    updatedAt: at,
    cancelledAt: at,
    reviewDeadline: null,
    history: [...document.history, { at, event: "cancelled", version: document.currentVersion, ...(reason ? { reason } : {}) }],
  };
}

/**
 * The deadline path applies only a pending plan whose latest version was
 * shown and whose full review window has passed.
 */
export function isPlanDue(document, now) {
  return (
    document.status === "pending" &&
    document.displayedVersion === document.currentVersion &&
    Boolean(document.reviewDeadline) &&
    Date.parse(document.reviewDeadline) <= toMs(now)
  );
}

export function beginApply(document, { trigger, now }) {
  const at = toIso(now);
  if (document.status === "applying") {
    assertUnchangedSinceDisplay(document, document.apply.version);
    return { ...document, updatedAt: at, history: [...document.history, { at, event: "apply-resumed", version: document.apply.version }] };
  }
  if (document.status !== "pending" || document.displayedVersion !== document.currentVersion) {
    throw new Error(`Weekly plan ${document.planId} is not ready to apply.`);
  }
  assertUnchangedSinceDisplay(document, document.currentVersion);
  return {
    ...document,
    status: "applying",
    updatedAt: at,
    apply: { version: document.currentVersion, trigger, startedAt: at, finishedAt: null, outcomes: {} },
    history: [...document.history, { at, event: "apply-started", version: document.currentVersion, trigger }],
  };
}

/**
 * Recomputes the digest from the stored plan content. Comparing only the
 * stored digest fields would miss an operation added to the file after the
 * plan was shown.
 */
export function assertUnchangedSinceDisplay(document, version) {
  const entry = versionEntry(document, version);
  if (digestPlan(entry.plan) !== document.displayedDigest || entry.digest !== document.displayedDigest) {
    throw new Error(`Weekly plan ${document.planId} changed after it was shown; it will not be applied.`);
  }
}

/** Todoist could not be reached for this check; the next check tries again. */
export function recordApplyDeferral(document, { error, now }) {
  const at = toIso(now);
  const count = (document.applyDeferrals?.count ?? 0) + 1;
  return {
    ...document,
    updatedAt: at,
    applyDeferrals: { count, lastError: error, lastAt: at },
    history: [...document.history, { at, event: "apply-deferred", version: document.currentVersion, attempt: count }],
  };
}

/**
 * Ends an apply that cannot proceed: every unfinished operation is recorded as
 * failed with the reason, so the plan reaches a final state and is reported
 * once instead of at every check.
 */
export function abandonApply(document, { reason, trigger = "deadline", now }) {
  const at = toIso(now);
  const version = document.apply?.version ?? document.displayedVersion ?? document.currentVersion;
  let next = {
    ...document,
    status: "applying",
    failureReason: reason,
    apply: document.apply ?? { version, trigger, startedAt: at, finishedAt: null, outcomes: {} },
  };
  for (const operation of versionEntry(next, version).plan.operations) {
    if (!isOutcomeDone(next.apply.outcomes[operation.opId])) {
      next = recordOutcome(next, operation.opId, { status: "failed", error: reason, attempts: next.apply.outcomes[operation.opId]?.attempts ?? 0 }, at);
    }
  }
  return finishApply(next, at);
}

export function recordOutcome(document, opId, outcome, now) {
  const at = toIso(now);
  return {
    ...document,
    updatedAt: at,
    apply: {
      ...document.apply,
      outcomes: { ...document.apply.outcomes, [opId]: { ...outcome, updatedAt: at } },
    },
  };
}

export function isOutcomeDone(outcome) {
  return Boolean(outcome && DONE_OUTCOMES.has(outcome.status));
}

export function finishApply(document, now) {
  const at = toIso(now);
  const operations = versionEntry(document, document.apply.version).plan.operations;
  const statuses = operations.map((operation) => document.apply.outcomes[operation.opId]?.status);
  const failed = statuses.filter((status) => status === "failed").length;
  const succeeded = statuses.filter((status) => status === "created" || status === "already_exists").length;
  const status = failed === 0 ? "applied" : succeeded === 0 ? "failed" : "applied_with_errors";
  return {
    ...document,
    status,
    updatedAt: at,
    apply: { ...document.apply, finishedAt: at },
    history: [...document.history, { at, event: "apply-finished", version: document.apply.version, status }],
  };
}

export function versionEntry(document, version) {
  const entry = document.versions.find((candidate) => candidate.version === version);
  if (!entry) throw new Error(`Weekly plan ${document.planId} has no version ${version}.`);
  return entry;
}

/** Read-only summary for status questions: pending? when? which version? applied? */
export function summarizeWeeklyPlans(documents, { now = new Date(), currentWeekStart = null } = {}) {
  const describe = (document) => ({
    planId: document.planId,
    weekId: document.weekId,
    weekStart: document.weekStart,
    status: document.status,
    currentVersion: document.currentVersion,
    displayedVersion: document.displayedVersion,
    displayedAt: document.displayedAt,
    reviewDeadline: document.reviewDeadline,
    appliedAt: document.apply?.finishedAt ?? null,
    appliedVersion: document.apply?.version ?? null,
    counts: countOutcomes(document),
    failureReason: document.failureReason ?? null,
    deferredChecks: document.applyDeferrals?.count ?? 0,
  });
  const open = documents.filter((document) => OPEN_STATUSES.includes(document.status));
  const latest = documents.at(-1) ?? null;
  const forWeek = currentWeekStart
    ? documents.filter((document) => document.weekStart === currentWeekStart).at(-1) ?? null
    : null;
  return {
    now: toIso(now),
    pending: open.map(describe),
    latest: latest ? describe(latest) : null,
    upcomingWeek: forWeek ? describe(forWeek) : null,
  };
}

function countOutcomes(document) {
  if (!document.apply) return null;
  const counts = { created: 0, already_exists: 0, failed: 0, skipped_past_date: 0, in_progress: 0 };
  for (const outcome of Object.values(document.apply.outcomes)) {
    counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  }
  return counts;
}

function requirePlanId(planId) {
  if (typeof planId !== "string" || !/^wp-\d{4}-W\d{2}-[a-z0-9]{1,16}$/.test(planId)) {
    throw new Error(`Invalid weekly plan id: ${planId}`);
  }
  return planId;
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid time: ${value}`);
  return date.toISOString();
}

function toMs(value) {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}
