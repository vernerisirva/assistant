/**
 * Applies a stored weekly plan. Deterministic orchestration only: it reads the
 * persisted operations of the displayed version and creates exactly those
 * Todoist tasks. It never plans, rewrites or regenerates anything, and it has
 * no access to a model.
 *
 * Idempotency does not depend on title matching alone. Every operation has a
 * stable id and outcome in the plan file, finished operations are never
 * repeated, an interrupted operation is re-checked against Todoist before it
 * is attempted again, and each create carries a deterministic request id.
 */
import { findTodoistDuplicates } from "./todoist-duplicates.mjs";
import { localDateInTimeZone } from "./routine-skips.mjs";
import {
  WEEKLY_PLAN_TIMEZONE,
  checkWeeklyPlanOperation,
  formatApplySummary,
  operationRequestId,
} from "./weekly-plan.mjs";
import {
  FINAL_STATUSES,
  abandonApply,
  assertUnchangedSinceDisplay,
  beginApply,
  finishApply,
  isOutcomeDone,
  isPlanDue,
  recordApplyDeferral,
  recordOutcome,
  versionEntry,
} from "./weekly-plan-store.mjs";

export const DEFAULT_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000]);
/**
 * If Todoist cannot be reached at the deadline (offline laptop, outage), the
 * plan waits for the next check instead of failing, at most this many times
 * (two hours of 15-minute checks). Then it fails once, with one message.
 */
export const MAX_APPLY_DEFERRALS = 8;

/**
 * The only Todoist capabilities the weekly-plan authorization covers: reading
 * open tasks for the duplicate check and creating a task. There is no update,
 * complete, reopen, move, comment or delete here to call by mistake.
 */
export function createWeeklyPlanTodoistGateway(client) {
  return Object.freeze({
    getTasks: () => client.getTasks({}),
    addTask: (payload, options) => client.addTask(payload, options),
  });
}

/**
 * @param trigger "deadline" (review window elapsed) or "accepted" (explicit OK
 *   for `expectedVersion`). A plan left in `applying` by a crash is resumed by
 *   either trigger.
 * @returns `{ applied, reason, document, summary }`
 */
export async function applyWeeklyPlan({
  store,
  planId,
  trigger,
  expectedVersion,
  todoist,
  now = () => new Date(),
  sleep = defaultSleep,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  maxDeferrals = MAX_APPLY_DEFERRALS,
  timezone = WEEKLY_PLAN_TIMEZONE,
}) {
  if (!["deadline", "accepted"].includes(trigger)) throw new Error(`Unknown apply trigger: ${trigger}`);

  return store.withPlanLock(planId, async () => {
    let document = store.readPlan(planId);

    if (FINAL_STATUSES.includes(document.status)) {
      return { applied: false, reason: `already ${document.status}`, document, summary: null };
    }
    if (document.status !== "applying") {
      if (trigger === "deadline" && !isPlanDue(document, now())) {
        return { applied: false, reason: "not due", document, summary: null };
      }
      if (trigger === "accepted") {
        if (document.status !== "pending") {
          throw new Error(`Weekly plan ${planId} has not been shown yet, so it cannot be accepted.`);
        }
        if (expectedVersion !== document.currentVersion || document.displayedVersion !== document.currentVersion) {
          throw new Error(
            `The accepted version v${expectedVersion} is not the current displayed version v${document.displayedVersion ?? "none"}; nothing was created.`,
          );
        }
      }
    }

    const version = document.apply?.version ?? document.currentVersion;
    try {
      assertUnchangedSinceDisplay(document, version);
    } catch (error) {
      // Final and reported once; a tampered plan is never retried.
      document = store.writePlan(abandonApply(document, { reason: error.message, trigger, now: now() }));
      return { applied: false, reason: "changed-after-display", document, summary: formatApplySummary(document) };
    }

    const operations = versionEntry(document, version).plan.operations;
    let openTasks = [];
    if (operations.some((operation) => !isOutcomeDone(document.apply?.outcomes?.[operation.opId]))) {
      const read = await readOpenTasksWithRetry(todoist, { sleep, retryDelaysMs });
      if (read.error) {
        const message = shorten(read.error.message);
        if (trigger === "accepted" && document.status === "pending") {
          throw new Error(`Could not reach Todoist, so nothing was created and the plan stays pending: ${message}`);
        }
        const attempts = (document.applyDeferrals?.count ?? 0) + 1;
        if (attempts < maxDeferrals) {
          store.writePlan(recordApplyDeferral(document, { error: message, now: now() }));
          return { applied: false, reason: "todoist-unavailable", deferred: true, document, summary: null };
        }
        document = store.writePlan(
          abandonApply(document, {
            reason: `Todoist could not be reached after ${attempts} checks: ${message}`,
            trigger,
            now: now(),
          }),
        );
        return { applied: false, reason: "todoist-unavailable", document, summary: formatApplySummary(document) };
      }
      openTasks = read.tasks;
    }

    document = store.writePlan(beginApply(document, { trigger, now: now() }));
    const today = localDateInTimeZone(now(), timezone);
    const save = (opId, outcome) => {
      document = store.writePlan(recordOutcome(document, opId, outcome, now()));
    };

    for (const operation of operations) {
      const previous = document.apply.outcomes[operation.opId];
      if (isOutcomeDone(previous)) continue;

      const authorization = checkWeeklyPlanOperation(operation);
      if (!authorization.allowed) {
        save(operation.opId, { status: "failed", error: `Not authorized: ${authorization.reason}`, attempts: 0 });
        continue;
      }
      if (operation.date < today) {
        save(operation.opId, { status: "skipped_past_date", attempts: previous?.attempts ?? 0 });
        continue;
      }

      const existing = evaluateExisting(operation, openTasks);
      if (existing.kind === "exists") {
        // An interrupted create that did reach Todoist is recognized here and
        // recorded as created, not created a second time.
        save(
          operation.opId,
          previous?.status === "in_progress"
            ? { status: "created", taskId: existing.taskId, recovered: true, attempts: previous.attempts ?? 0 }
            : { status: "already_exists", taskId: existing.taskId, attempts: 0 },
        );
        continue;
      }
      if (existing.kind === "unreadable") {
        save(operation.opId, {
          status: "failed",
          error: "Part of the Todoist task list could not be read, so a duplicate could not be ruled out.",
          attempts: previous?.attempts ?? 0,
        });
        continue;
      }

      const requestId = operationRequestId(planId, version, operation.opId);
      let attempts = previous?.attempts ?? 0;
      let outcome = null;
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        attempts += 1;
        save(operation.opId, { status: "in_progress", requestId, attempts });
        try {
          const task = await todoist.addTask(operation.payload, { requestId });
          outcome = { status: "created", taskId: task?.id ?? null, attempts };
          if (task && typeof task === "object") openTasks.push(task);
          break;
        } catch (error) {
          outcome = { status: "failed", error: shorten(error?.message ?? String(error)), attempts };
          if (!isTransient(error) || attempt === retryDelaysMs.length) break;
          await sleep(retryDelaysMs[attempt]);
          // The failed call may still have created the task. Look before retrying.
          const reread = await readOpenTasks(todoist);
          if (reread.error) {
            outcome = { ...outcome, error: `${outcome.error}; could not re-check before retrying` };
            break;
          }
          openTasks = reread.tasks;
          const recheck = evaluateExisting(operation, openTasks);
          if (recheck.kind === "exists") {
            outcome = { status: "created", taskId: recheck.taskId, recovered: true, attempts };
            break;
          }
        }
      }
      save(operation.opId, outcome);
    }

    document = store.writePlan(finishApply(document, now()));
    return { applied: true, reason: null, document, summary: formatApplySummary(document) };
  });
}

/**
 * Reuses the shared duplicate guard. An exact title match with the same due
 * text or the same due date is this task; a recurring task with the same
 * title is treated as already covering it. The same title on another date
 * (last week's session) is a different task.
 */
export function evaluateExisting(operation, tasks) {
  const result = findTodoistDuplicates(operation.payload, tasks);
  if (result.status === "none") return { kind: "none" };
  if (result.status === "duplicate") return { kind: "exists", taskId: result.matches[0]?.id ?? null };
  if (result.matches.length === 0) return { kind: "unreadable" };
  const match = result.matches.find(
    (candidate) => String(candidate.dueDate ?? "").slice(0, 10) === operation.date || candidate.recurring,
  );
  return match ? { kind: "exists", taskId: match.id ?? null } : { kind: "none" };
}

async function readOpenTasksWithRetry(todoist, { sleep, retryDelaysMs }) {
  let result = await readOpenTasks(todoist);
  for (const delay of retryDelaysMs) {
    if (!result.error || !isTransient(result.error)) break;
    await sleep(delay);
    result = await readOpenTasks(todoist);
  }
  return result;
}

async function readOpenTasks(todoist) {
  try {
    const tasks = await todoist.getTasks();
    if (!Array.isArray(tasks)) throw new Error("Todoist did not return a task list.");
    return { tasks: [...tasks], error: null };
  } catch (error) {
    return { tasks: null, error };
  }
}

/** Rate limits, server errors and network failures are worth one bounded retry; other 4xx are not. */
export function isTransient(error) {
  const status = /Todoist API request failed: (\d{3})/.exec(String(error?.message ?? ""))?.[1];
  if (status) return status === "429" || status.startsWith("5");
  return true;
}

function shorten(message) {
  const text = String(message ?? "").replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
