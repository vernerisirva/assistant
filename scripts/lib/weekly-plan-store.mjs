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
 * - awaiting_input: only in plans stored before golf answers became optional:
 *   the week's context and the golf questions, with no plan version yet.
 *   Never applies; answering it, or proposing that week again, builds the
 *   plan with defaults for whatever is still unanswered.
 * - draft: stored, not yet shown to the user. Never applies. A draft the
 *   scheduled proposal could not deliver is sent again by the apply check.
 * - pending: shown; applies after the review deadline or on explicit OK. A
 *   plan built without reading Todoist is held for an explicit OK when the
 *   week turns out to have tasks it did not account for (`applyHold`). A
 *   change the user asked for holds it too (`revisionHold`), from the moment
 *   the change arrives until it is shown as a new version, the user keeps the
 *   plan as shown, or cancels it: it never applies on its own meanwhile, and
 *   an OK is not taken as acceptance while the change is open.
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
  addDays,
  computeReviewDeadline,
  digestPlan,
  isoWeekId,
} from "./weekly-plan.mjs";
import { golfInputStatus } from "./golf-week.mjs";

export const PLAN_SCHEMA_VERSION = 1;
export const OPEN_STATUSES = Object.freeze(["awaiting_input", "draft", "pending", "applying"]);
export const FINAL_STATUSES = Object.freeze(["applied", "applied_with_errors", "failed", "cancelled"]);
const DONE_OUTCOMES = new Set(["created", "already_exists", "skipped_past_date", "failed"]);
const LOCK_STALE_MS = 15 * 60_000;
const LOCK_HEARTBEAT_MS = 60_000;
const LOCK_POLL_MS = 250;
/** An open change is reported once at the deadline it held up, when it has been open at least this long. */
const REVISION_HOLD_REPORT_AFTER_MS = 60 * 60_000;
/** Minutes before each retry of an undelivered plan: 15, 30, 60, then every 2 hours. */
const DELIVERY_RETRY_MINUTES = Object.freeze([15, 30, 60, 120]);
/** A scheduled draft that no send ever touched is left alone this long, so a running proposal finishes first. */
const UNSENT_DRAFT_GRACE_MS = 10 * 60_000;

export function resolveWeeklyPlanDir(stateDir) {
  return join(stateDir, "weekly-plan");
}

export function createWeeklyPlanStore({
  stateDir,
  lockStaleMs = LOCK_STALE_MS,
  lockHeartbeatMs = LOCK_HEARTBEAT_MS,
  lockPollMs = LOCK_POLL_MS,
  clock = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
   * the lock only if it still carries its own token. A chat command may wait
   * up to `waitMs` for the holder (an apply in progress) instead of failing.
   */
  async function withPlanLock(planId, fn, { waitMs = 0 } = {}) {
    mkdirSync(locksDir, { recursive: true });
    const lockPath = join(locksDir, `${requirePlanId(planId)}.lock`);
    const token = randomBytes(8).toString("hex");
    let descriptor;
    for (let waited = 0; descriptor === undefined; ) {
      try {
        descriptor = openSync(lockPath, "wx", 0o600);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const held = readLock(lockPath);
        if (!held) continue;
        if (clock() - held.mtimeMs >= lockStaleMs && !isProcessAlive(held.pid)) {
          if (readLock(lockPath)?.token === held.token) rmSync(lockPath, { force: true });
          continue;
        }
        if (waited >= waitMs) {
          const busy = new Error(`Weekly plan ${planId} is being updated right now.`);
          busy.code = "PLAN_LOCKED";
          throw busy;
        }
        await sleep(lockPollMs);
        waited += lockPollMs;
      }
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

  async function mutatePlan(planId, mutate, lockOptions) {
    return withPlanLock(
      planId,
      async () => {
        const next = await mutate(readPlan(planId));
        return next ? writePlan(next) : readPlan(planId);
      },
      lockOptions,
    );
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
 * A week whose golf part still needs the user's answers. The rest of the
 * week's context is kept as `baseInputs`; the answers so far are `golf`.
 * There is no plan version yet, so nothing can be shown, accepted or applied.
 */
export function createAwaitingDocument({ planId, weekStart, baseInputs, golf, now, source = "scheduled", timezone }) {
  const at = toIso(now);
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId,
    weekId: isoWeekId(weekStart),
    weekStart,
    weekEnd: addDays(weekStart, 6),
    timezone,
    status: "awaiting_input",
    createdAt: at,
    updatedAt: at,
    currentVersion: 0,
    displayedVersion: null,
    displayedAt: null,
    displayedDigest: null,
    displayChannel: null,
    reviewWindowHours: null,
    reviewDeadline: null,
    versions: [],
    awaiting: { source, baseInputs, golf, askedAt: null, lastAskedAt: null, completedAt: null },
    apply: null,
    cancelledAt: null,
    history: [{ at, event: "created", version: 0, awaiting: "golf-input" }],
  };
}

/** The golf questions (or a follow-up) were sent, or returned as the chat reply. */
export function recordGolfQuestion(document, { askedAt, channel, messageId = null, followUp = false }) {
  requireAwaiting(document);
  const at = toIso(askedAt);
  return {
    ...document,
    updatedAt: at,
    awaiting: { ...document.awaiting, askedAt: document.awaiting.askedAt ?? at, lastAskedAt: at },
    history: [
      ...document.history,
      { at, event: followUp ? "golf-follow-up" : "golf-asked", channel, ...(messageId ? { messageId } : {}) },
    ],
  };
}

/** Stores the golf answers so far, with the user's words that gave them. */
export function recordGolfAnswer(document, { golf, replyText, fields, now }) {
  requireAwaiting(document);
  const at = toIso(now);
  return {
    ...document,
    updatedAt: at,
    awaiting: { ...document.awaiting, golf },
    history: [...document.history, { at, event: "golf-answered", fields, replyText: String(replyText).slice(0, 500) }],
  };
}

/**
 * The golf answers are complete: version 1 is the whole plan. It is a draft
 * until markPlanDisplayed shows it, which is when its review window starts.
 */
export function completeAwaitingDocument(document, { inputs, plan, now }) {
  requireAwaiting(document);
  const at = toIso(now);
  return {
    ...document,
    status: "draft",
    updatedAt: at,
    weekEnd: plan.weekEnd,
    currentVersion: 1,
    versions: [{ version: 1, createdAt: at, source: "golf-answers", changeSummary: [], note: null, inputs, plan, digest: digestPlan(plan) }],
    awaiting: { ...document.awaiting, completedAt: at },
    history: [...document.history, { at, event: "created", version: 1 }],
  };
}

function requireAwaiting(document) {
  if (document.status !== "awaiting_input") {
    throw new Error(`Weekly plan ${document.planId} is ${document.status}, not waiting for golf answers.`);
  }
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
    applyHold: null,
    revisionHold: null,
    delivery: null,
    history: [...document.history, { at, event: "displayed", version, channel, ...(messageId ? { messageId } : {}) }],
  };
}

/**
 * A send of the draft did not reach Telegram. The draft stays unshown, so it
 * never applies, and the apply check sends it again after a growing pause.
 */
export function recordDeliveryFailure(document, { error, now }) {
  if (document.status !== "draft") throw new Error(`Weekly plan ${document.planId} is ${document.status}, not an unshown draft.`);
  const at = toIso(now);
  const attempts = (document.delivery?.attempts ?? 0) + 1;
  const pause = DELIVERY_RETRY_MINUTES[Math.min(attempts, DELIVERY_RETRY_MINUTES.length) - 1];
  return {
    ...document,
    updatedAt: at,
    delivery: {
      attempts,
      lastError: deliveryErrorText(error),
      lastAttemptAt: at,
      nextAttemptAt: new Date(Date.parse(at) + pause * 60_000).toISOString(),
    },
    history: [...document.history, { at, event: "delivery-failed", version: document.currentVersion, attempt: attempts }],
  };
}

/** A failed send's error as it is stored, so the same error can be recognised next time. */
export function deliveryErrorText(error) {
  return String(error ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Whether the apply check should send this draft now: a send already failed
 * and its pause is over, or the scheduled proposal stored it and no send ever
 * touched it (the job stopped in between). Never after the plan's week.
 */
export function isDeliveryRetryDue(document, now, { today }) {
  if (document.status !== "draft" || document.weekEnd < today) return false;
  if (document.delivery?.attempts > 0) return Date.parse(document.delivery.nextAttemptAt) <= toMs(now);
  const scheduled = document.versions.find((entry) => entry.version === document.currentVersion)?.source === "scheduled";
  return scheduled && toMs(now) - Date.parse(document.createdAt) >= UNSENT_DRAFT_GRACE_MS;
}

/**
 * The plan was built without reading Todoist, and at its deadline that week
 * has tasks the plan did not account for. Nothing is created automatically;
 * an explicit OK, a change or a cancel decides. Reported once per version.
 */
export function recordApplyHold(document, { unaccounted, now }) {
  const at = toIso(now);
  return {
    ...document,
    updatedAt: at,
    applyHold: { version: document.currentVersion, at, unaccounted },
    history: [...document.history, { at, event: "apply-held", version: document.currentVersion }],
  };
}

/**
 * The user asked to change the shown version. This is written before the
 * change is worked out, so whatever happens next (a question, a failed step,
 * a crash or a restart) the version they asked to change cannot apply on its
 * own until the change is shown as a new version, kept or cancelled.
 */
export function holdForRevision(document, { now, fromVersion }) {
  if (document.status !== "pending") throw new Error(`Weekly plan ${document.planId} is ${document.status}, not a shown plan.`);
  const at = toIso(now);
  return {
    ...document,
    updatedAt: at,
    revisionHold: {
      requestedAt: at,
      fromVersion: fromVersion ?? document.currentVersion,
      question: null,
      askedAt: null,
      understood: [],
      pendingInputs: null,
      reportedAt: null,
    },
    history: [...document.history, { at, event: "revision-requested", version: document.currentVersion }],
  };
}

/**
 * The change needs the user's answer. The hold keeps the question and what
 * the user's words already made clear (`pendingInputs`, summarized in
 * `understood`), so the answer completes the change without the user
 * repeating it. The shown version stays held.
 */
export function recordRevisionQuestion(document, { question, understood, pendingInputs, now }) {
  const at = toIso(now);
  const hold = document.revisionHold ?? { requestedAt: at, fromVersion: document.currentVersion, reportedAt: null };
  return {
    ...document,
    updatedAt: at,
    revisionHold: { ...hold, question, askedAt: at, understood, pendingInputs },
    history: [...document.history, { at, event: "revision-question", version: document.currentVersion }],
  };
}

/** The change was shown as a new version, changed nothing, or the user kept the plan as shown. */
export function releaseRevisionHold(document, { now, outcome }) {
  if (!document.revisionHold) return document;
  const at = toIso(now);
  return {
    ...document,
    updatedAt: at,
    revisionHold: null,
    history: [...document.history, { at, event: "revision-hold-released", version: document.currentVersion, outcome }],
  };
}

/**
 * The apply check says once that an open change kept the shown version from
 * applying: after the deadline it held up, and only when the change has been
 * open for a while, so an answer that is on its way doesn't get a second
 * message. It never resumes the old version on its own.
 */
export function isRevisionHoldReportDue(document, now) {
  const hold = document.revisionHold;
  if (document.status !== "pending" || !hold || hold.reportedAt || !document.reviewDeadline) return false;
  return Date.parse(document.reviewDeadline) <= toMs(now) && toMs(now) - Date.parse(hold.askedAt ?? hold.requestedAt) >= REVISION_HOLD_REPORT_AFTER_MS;
}

export function recordRevisionHoldReported(document, { now }) {
  const at = toIso(now);
  return {
    ...document,
    updatedAt: at,
    revisionHold: { ...document.revisionHold, reportedAt: at },
    history: [...document.history, { at, event: "revision-hold-reported", version: document.currentVersion }],
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
  if (!["awaiting_input", "draft", "pending"].includes(document.status)) {
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
    ...(document.revisionHold ? { revisionHold: null } : {}),
    history: [...document.history, { at, event: "cancelled", version: document.currentVersion, ...(reason ? { reason } : {}) }],
  };
}

/**
 * The deadline path applies only a pending plan whose latest version was
 * shown and whose full review window has passed, and never one that waits for
 * an explicit OK or holds for a change the user asked for.
 */
export function isPlanDue(document, now) {
  return (
    document.status === "pending" &&
    document.displayedVersion === document.currentVersion &&
    document.applyHold?.version !== document.currentVersion &&
    !document.revisionHold &&
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
  if (document.revisionHold) {
    throw new Error(`Weekly plan ${document.planId} has a change the user asked for that isn't finished; it will not be applied.`);
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
    ...(document.delivery?.attempts > 0
      ? { deliveryAttempts: document.delivery.attempts, deliveryError: document.delivery.lastError, nextDeliveryAt: document.delivery.nextAttemptAt }
      : {}),
    ...(document.applyHold && document.applyHold.version === document.currentVersion && document.status === "pending"
      ? { waitingForOk: true, unaccountedTasks: document.applyHold.unaccounted }
      : {}),
    ...(document.revisionHold && document.status === "pending"
      ? { changeOnHold: { requestedAt: document.revisionHold.requestedAt, question: document.revisionHold.question ?? null } }
      : {}),
    ...(document.status === "awaiting_input"
      ? { golfQuestionsAskedAt: document.awaiting?.askedAt ?? null, golfMissing: golfInputStatus(document.awaiting.golf).missing }
      : {}),
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
