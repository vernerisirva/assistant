/**
 * Bringing an applied weekly plan's Todoist tasks in line with a change the
 * user asked for after the plan was applied.
 *
 * The weekly plan's standing authorization ends at creating the shown
 * version's tasks: it never edits, moves or deletes. So a change after the
 * apply is an ordinary Todoist change that needs the user's explicit approval
 * of exactly what will happen:
 *
 * - `planReconciliation` compares the week the user now wants (the same
 *   planner, from the applied version plus their change) with what the plan
 *   expects to be in Todoist and what Todoist really holds. A task that
 *   already fits is kept. A task the plan created and nobody has touched
 *   since may get a new title, description or date, or be removed. A missing
 *   one is added, unless that day already has a task for the same activity;
 *   one the user removed comes back only when the change is about it. A task
 *   the user changed, completed or made themselves is left as it is, and
 *   said so.
 * - The proposal is stored with what each task it touches looked like, and
 *   shown as one approval prompt.
 * - `applyReconciliation` acts only on an explicit approval of that stored
 *   proposal. It reads Todoist again first and refuses the whole proposal if
 *   any task it would touch has changed since, or a task it would add is
 *   already there. Then it makes exactly the stored changes, additions first
 *   and removals last, records each outcome, and reports failures as they
 *   are; none is retried.
 *
 * The plan is never created a second time, and nothing outside the plan's
 * own tasks for its week is touched.
 */
import { createHash } from "node:crypto";
import { isApprovalMessage } from "./approval-language.mjs";
import { findTodoistDuplicates } from "./todoist-duplicates.mjs";
import { localDateInTimeZone } from "./routine-skips.mjs";
import { readOpenTasksWithRetry } from "./weekly-plan-apply.mjs";
import { WEEKLY_PLAN_TIMEZONE, classifyExistingTask, formatWeekLabel, operationRequestId } from "./weekly-plan.mjs";
import { MONTHS, shortWeekday } from "./weekly-plan-dates.mjs";
import { versionEntry } from "./weekly-plan-store.mjs";

const RECONCILABLE_STATUSES = Object.freeze(["applied", "applied_with_errors"]);
const ACTION_ORDER = Object.freeze(["create", "update", "delete"]);

/**
 * The only Todoist calls a reconciliation makes: reading tasks, then, after
 * the user's approval, adding, editing and deleting exactly the proposed ones.
 * No completing, reopening, moving between projects or comments.
 */
export function createReconciliationTodoistGateway(client) {
  return Object.freeze({
    getTasks: () => client.getTasks({}),
    getTask: (taskId) => client.getTask(taskId),
    addTask: (payload, options) => client.addTask(payload, options),
    updateTask: (taskId, fields, options) => client.updateTask(taskId, fields, options),
    deleteTask: (taskId) => client.deleteTask(taskId),
  });
}

export function isReconcilable(document) {
  return RECONCILABLE_STATUSES.includes(document.status) && Boolean(document.apply);
}

/**
 * What the plan believes the week is now: the applied version, or the last
 * reconciliation that was carried out, with the task each operation became
 * (`expected`: opId → { taskId, content, description, due }).
 */
export function reconciliationBase(document) {
  const last = (document.reconciliations ?? []).filter((record) => RECONCILABLE_STATUSES.includes(record.status)).at(-1);
  if (last) return { from: last.id, inputs: last.targetInputs, plan: null, expected: structuredClone(last.expected) };
  const entry = versionEntry(document, document.apply.version);
  const expected = {};
  for (const operation of entry.plan.operations) {
    const outcome = document.apply.outcomes?.[operation.opId];
    if (!outcome?.taskId || !["created", "already_exists"].includes(outcome.status)) continue;
    expected[operation.opId] = { taskId: String(outcome.taskId), ...taskState(operation.payload) };
  }
  return { from: null, inputs: entry.inputs, plan: entry.plan, expected };
}

/**
 * The changes that turn what Todoist holds into the week the user wants.
 *
 * @param expected what the plan believes each of its operations became in Todoist
 * @param target the operations of the week the user wants
 * @param openTasks the user's open Todoist tasks, read just now
 * @param closed for expected tasks that are no longer open: "done", "gone" or "unknown"
 * @param today nothing before this local date is added, changed or removed
 * @returns `{ changes, kept, leftAlone }`
 */
export function planReconciliation({ expected, target, openTasks, closed = new Map(), today }) {
  const open = new Map(openTasks.filter((task) => task && task.id !== undefined).map((task) => [String(task.id), task]));
  const targetIds = new Set(target.map((operation) => operation.opId));
  const changes = [];
  const kept = [];
  const leftAlone = [];
  const missing = [];
  // One line per task the user should know about, on the day it is now.
  const noted = new Set();
  const note = (entry, reason, task) => {
    if (task && noted.has(String(task.id))) return;
    if (task) noted.add(String(task.id));
    leftAlone.push({ opId: entry.opId, date: task ? dueDate(task) || entry.date : entry.date, title: task?.content ?? entry.title, reason });
  };

  for (const operation of [...target].sort(byDate)) {
    if (today && operation.date < today) continue;
    const before = expected[operation.opId];
    const task = before ? open.get(before.taskId) : null;
    if (before && task) {
      if (fits(task, operation.payload)) kept.push({ opId: operation.opId, taskId: before.taskId, date: operation.date, title: task.content });
      else if (fits(task, before)) changes.push(update(operation, before.taskId, task));
      else note({ ...operation, title: task.content }, "edited", task);
      continue;
    }
    if (before) {
      const state = closed.get(before.taskId) ?? "unknown";
      if (state === "done") {
        note({ ...operation, title: before.content }, "done");
        continue;
      }
      if (state !== "gone") {
        note({ ...operation, title: before.content }, "unchecked");
        continue;
      }
      // Removed in Todoist: it comes back only when this change is about it.
      if (fits(before, operation.payload)) {
        note({ ...operation, title: before.content }, "removed");
        continue;
      }
    }
    missing.push(operation);
  }

  // Tasks the plan made that the wanted week no longer has: moved or removed,
  // unless they changed since, which leaves them to the user.
  const obsolete = [];
  for (const [opId, before] of Object.entries(expected)) {
    const [activity, date] = splitOpId(opId);
    if (targetIds.has(opId) || (today && date < today)) continue;
    const task = open.get(before.taskId);
    if (!task) continue;
    if (!fits(task, before)) {
      note({ opId, date, title: task.content }, "edited", task);
      continue;
    }
    obsolete.push({ opId, activity, date, taskId: before.taskId, task });
  }

  const claimed = new Set([...kept.map((entry) => entry.taskId), ...changes.map((change) => change.taskId)]);
  for (const operation of missing) {
    // The same title on the same day is this task already; the same title on
    // another day (last week's session) is a different one.
    const duplicate = findTodoistDuplicates(operation.payload, [...open.values()]);
    const same = duplicate.matches.find((match) => String(match.dueDate ?? "").slice(0, 10) === operation.date || match.recurring);
    if (same) {
      claimed.add(String(same.id));
      kept.push({ opId: operation.opId, taskId: String(same.id), date: operation.date, title: operation.payload.content });
      continue;
    }
    if (duplicate.unreadableEntries > 0) {
      note(operation, "unreadable");
      continue;
    }
    // A task for the same activity on that day, made by the user or by an
    // earlier change, already covers it: one per activity and day.
    const covering = [...open.values()].find(
      (task) => !claimed.has(String(task.id)) && dueDate(task) === operation.date && classifyExistingTask(task.content) === operation.activity && !obsolete.some((entry) => entry.taskId === String(task.id)),
    );
    if (covering) {
      note({ ...operation, title: covering.content }, "covered", covering);
      continue;
    }
    const nearest = obsolete
      .filter((entry) => entry.activity === operation.activity && !entry.used)
      .sort((a, b) => distance(a.date, operation.date) - distance(b.date, operation.date) || a.date.localeCompare(b.date))[0];
    if (nearest) {
      nearest.used = true;
      changes.push(update(operation, nearest.taskId, nearest.task, nearest.opId));
      continue;
    }
    changes.push({ action: "create", opId: operation.opId, activity: operation.activity, date: operation.date, payload: structuredClone(operation.payload) });
  }
  for (const entry of obsolete.filter((candidate) => !candidate.used)) {
    changes.push({ action: "delete", opId: entry.opId, activity: entry.activity, date: entry.date, taskId: entry.taskId, before: taskState(entry.task) });
  }

  const ordered = changes
    .sort((a, b) => ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action) || a.date.localeCompare(b.date) || a.opId.localeCompare(b.opId))
    .map((change, index) => ({ id: `c${index + 1}`, ...change }));
  return { changes: ordered, kept: kept.sort(byDate), leftAlone: leftAlone.sort(byDate) };
}

function update(operation, taskId, task, fromOpId = null) {
  return {
    action: "update",
    opId: operation.opId,
    ...(fromOpId ? { fromOpId } : {}),
    activity: operation.activity,
    date: operation.date,
    taskId: String(taskId),
    before: taskState(task),
    after: taskState(operation.payload),
  };
}

/** A stored proposal: what changes, from what, and what stays. */
export function createReconciliationRecord(document, { base, summary, targetInputs, targetOperations, planned, now }) {
  const ids = (document.reconciliations ?? []).length + 1;
  const record = {
    id: `r${ids}`,
    status: "proposed",
    createdAt: toIso(now),
    base: { version: document.apply.version, reconciliation: base.from },
    summary,
    targetInputs,
    targetOperations: targetOperations.map(({ opId, activity, date, payload }) => ({ opId, activity, date, ...taskState(payload) })),
    changes: planned.changes,
    kept: planned.kept,
    leftAlone: planned.leftAlone,
    outcomes: {},
    approvedAt: null,
    finishedAt: null,
    expected: null,
  };
  record.digest = digestChanges(record.changes);
  return record;
}

export function digestChanges(changes) {
  return `sha256:${createHash("sha256").update(JSON.stringify(changes)).digest("hex")}`;
}

/** Adds a proposal, closing any earlier one that was never approved. */
export function addReconciliation(document, record) {
  const at = record.createdAt;
  const earlier = (document.reconciliations ?? []).map((entry) => (entry.status === "proposed" ? { ...entry, status: "superseded", finishedAt: at } : entry));
  return {
    ...document,
    updatedAt: at,
    reconciliations: [...earlier, record],
    history: [...document.history, { at, event: "reconciliation-proposed", reconciliation: record.id, changes: record.changes.length }],
  };
}

/**
 * The approval prompt for a proposal: what is added, changed and removed,
 * what stays as it is and why, the expected effect and the risk.
 */
export function formatReconciliationProposal(document, record) {
  const week = formatWeekLabel(document.weekStart);
  const line = (date, text) => `• ${shortWeekday(date)} ${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} — ${text}`;
  const lines = [`Weekly plan · ${week}: ${record.changes.length === 0 ? "nothing to change in Todoist" : "changes for your approval"}`];
  if (record.summary.length > 0) lines.push(`Your change: ${record.summary.join(" · ")}`);
  const of = (action) => record.changes.filter((change) => change.action === action);
  if (of("create").length > 0) lines.push("", "Add:", ...of("create").map((change) => line(change.date, change.payload.content)));
  if (of("update").length > 0) {
    lines.push(
      "",
      "Change:",
      ...of("update").map((change) => {
        const fields = [change.after.content !== change.before.content ? "title" : null, change.after.description !== change.before.description ? "details" : null, change.after.due !== change.before.due ? `date, from ${shortWeekday(change.before.due)}` : null].filter(Boolean);
        const title = change.after.content === change.before.content ? change.before.content : `${change.before.content} → ${change.after.content}`;
        return line(change.date, `${title} (${fields.join(", ")})`);
      }),
    );
  }
  if (of("delete").length > 0) lines.push("", "Remove:", ...of("delete").map((change) => line(change.date, change.before.content)));
  if (record.leftAlone.length > 0) {
    lines.push("", "Left as they are:", ...record.leftAlone.map((entry) => line(entry.date, `${entry.title}: ${LEFT_ALONE[entry.reason]}`)));
  }
  if (record.kept.length > 0) lines.push("", `Unchanged: ${record.kept.length} task${record.kept.length === 1 ? "" : "s"} already fit${record.kept.length === 1 ? "s" : ""}.`);
  if (record.changes.length === 0) return lines.join("\n");
  const removals = of("delete").length;
  lines.push(
    "",
    "Agent: Personal",
    `Action: ${describeCounts(record.changes)} in Todoist for the weekly plan of ${week}`,
    "Expected effect: those tasks match your change; nothing else in Todoist changes.",
    `Risk: changed tasks get the new title, details or date${removals > 0 ? `, and ${removals === 1 ? "the removed task is" : "removed tasks are"} deleted` : ""}.`,
    "Reply Approve to make exactly these changes, or No to leave the tasks as they are.",
  );
  return lines.join("\n");
}

const LEFT_ALONE = Object.freeze({
  edited: "changed in Todoist since the plan made it",
  done: "already completed",
  removed: "removed from Todoist, so not added back",
  unchecked: "no longer open, and I couldn't check why",
  covered: "that day already has this activity in Todoist",
  unreadable: "part of the Todoist list couldn't be read, so I can't rule out a duplicate",
});

function describeCounts(changes) {
  const count = (action) => changes.filter((change) => change.action === action).length;
  const parts = [
    count("create") > 0 ? `add ${count("create")} task${count("create") === 1 ? "" : "s"}` : null,
    count("update") > 0 ? `change ${count("update")}` : null,
    count("delete") > 0 ? `remove ${count("delete")}` : null,
  ].filter(Boolean);
  return parts.join(", ").replace(/^./, (first) => first.toUpperCase());
}

/**
 * Carries out a stored proposal after the user's explicit approval. Any reply
 * that isn't one changes nothing. A proposal that is stale (Todoist changed
 * since), superseded or already done is refused or reported, never redone.
 *
 * @returns `{ status, record, telegramText }`
 */
export async function applyReconciliation({
  store,
  planId,
  proposalId,
  replyText,
  todoist,
  now = () => new Date(),
  sleep,
  retryDelaysMs,
  timezone = WEEKLY_PLAN_TIMEZONE,
  lockWaitMs = 0,
}) {
  if (!isApprovalMessage(replyText, { hasPendingApproval: true })) {
    return { status: "not_approved", record: null, telegramText: null };
  }
  return store.withPlanLock(
    planId,
    async () => {
      let document = store.readPlan(planId);
      const records = document.reconciliations ?? [];
      let record = records.find((entry) => entry.id === proposalId);
      if (!record) throw new Error(`Weekly plan ${planId} has no proposal ${proposalId}.`);
      const week = formatWeekLabel(document.weekStart);
      if (["applied", "applied_with_errors", "failed"].includes(record.status)) {
        return { status: record.status, record, telegramText: `Those changes were already made.\n\n${formatReconciliationSummary(document, record)}` };
      }
      if (record.status !== "proposed" && record.status !== "applying") {
        return { status: record.status, record, telegramText: `That proposal for ${week} is no longer open (${record.status}), so nothing was changed. Ask me again and I'll compare the tasks afresh.` };
      }
      if (digestChanges(record.changes) !== record.digest) {
        throw new Error(`Proposal ${proposalId} of ${planId} changed after it was shown; nothing was changed.`);
      }
      const read = await readOpenTasksWithRetry(todoist, { ...(sleep ? { sleep } : {}), ...(retryDelaysMs ? { retryDelaysMs } : {}) });
      if (read.error) {
        return { status: record.status, record, telegramText: `I couldn't read Todoist just now, so nothing was changed: ${shorten(read.error.message)}` };
      }
      let open = new Map(read.tasks.map((task) => [String(task.id), task]));
      const save = (next) => {
        document = store.writePlan({ ...document, updatedAt: toIso(now()), reconciliations: (document.reconciliations ?? []).map((entry) => (entry.id === next.id ? next : entry)) });
        record = next;
      };

      const resumed = record.status === "applying";
      if (record.status === "proposed") {
        const stale = staleReasons(record, open, today(now, timezone));
        if (stale.length > 0) {
          save({ ...record, status: "stale", finishedAt: toIso(now()), staleReasons: stale });
          document = store.writePlan({ ...document, history: [...document.history, { at: toIso(now()), event: "reconciliation-stale", reconciliation: record.id }] });
          return {
            status: "stale",
            record,
            telegramText: [`Todoist changed since I proposed this, so nothing was changed:`, ...stale.map((reason) => `• ${reason}`), "", "Ask me again and I'll compare the tasks afresh."].join("\n"),
          };
        }
        save({ ...record, status: "applying", approvedAt: toIso(now()) });
      }

      for (const change of [...record.changes].sort((a, b) => ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action))) {
        const previous = record.outcomes[change.id];
        if (previous && previous.status !== "in_progress") continue;
        // A change that was cut off may have reached Todoist: look before doing it again.
        if (previous?.status === "in_progress") {
          const reread = await readOpenTasksWithRetry(todoist, { ...(sleep ? { sleep } : {}), ...(retryDelaysMs ? { retryDelaysMs } : {}) });
          if (reread.error) {
            save({ ...record, outcomes: { ...record.outcomes, [change.id]: { status: "failed", error: `Couldn't check whether it was already made: ${shorten(reread.error.message)}` } } });
            continue;
          }
          open = new Map(reread.tasks.map((task) => [String(task.id), task]));
          const done = alreadyDone(change, open);
          if (done) {
            save({ ...record, outcomes: { ...record.outcomes, [change.id]: { status: "done", recovered: true, ...(done.taskId ? { taskId: done.taskId } : {}) } } });
            continue;
          }
        }
        // Resumed after a stop: a change not started yet is made only if its task is still as proposed.
        if (resumed && !previous) {
          const reasons = staleReasons({ changes: [change] }, open, today(now, timezone));
          if (reasons.length > 0) {
            save({ ...record, outcomes: { ...record.outcomes, [change.id]: { status: "failed", error: `Not made: ${reasons[0]}` } } });
            continue;
          }
        }
        save({ ...record, outcomes: { ...record.outcomes, [change.id]: { status: "in_progress" } } });
        let outcome;
        try {
          const requestId = operationRequestId(planId, Number(record.id.slice(1)), `${change.id}:${change.opId}`);
          if (change.action === "create") {
            const task = await todoist.addTask(change.payload, { requestId });
            outcome = { status: "done", taskId: task?.id === undefined ? null : String(task.id) };
          } else if (change.action === "update") {
            await todoist.updateTask(change.taskId, { content: change.after.content, description: change.after.description, due_string: change.after.due }, { requestId });
            outcome = { status: "done", taskId: change.taskId };
          } else {
            await todoist.deleteTask(change.taskId);
            outcome = { status: "done", taskId: change.taskId };
          }
        } catch (error) {
          outcome = { status: "failed", error: shorten(error?.message ?? String(error)) };
        }
        save({ ...record, outcomes: { ...record.outcomes, [change.id]: outcome } });
      }

      const failed = record.changes.filter((change) => record.outcomes[change.id]?.status === "failed").length;
      const status = failed === 0 ? "applied" : failed === record.changes.length ? "failed" : "applied_with_errors";
      save({ ...record, status, finishedAt: toIso(now()), expected: expectedAfter(record, reconciliationBaseBefore(document, record)) });
      document = store.writePlan({ ...document, history: [...document.history, { at: toIso(now()), event: "reconciliation-finished", reconciliation: record.id, status }] });
      return { status, record, telegramText: formatReconciliationSummary(document, record) };
    },
    { waitMs: lockWaitMs },
  );
}

/** Why a proposal no longer matches Todoist; empty when it still does. */
export function staleReasons(record, open, todayDate) {
  const reasons = [];
  for (const change of record.changes) {
    const day = shortWeekday(change.date);
    if (todayDate && change.date < todayDate) {
      reasons.push(`${day}: that day has passed.`);
      continue;
    }
    if (change.action === "create") {
      const duplicate = findTodoistDuplicates(change.payload, [...open.values()]);
      const same = duplicate.matches.find((match) => String(match.dueDate ?? "").slice(0, 10) === change.date || match.recurring);
      const covering = [...open.values()].find(
        (task) => dueDate(task) === change.date && classifyExistingTask(task.content) === change.activity && !record.changes.some((other) => other.taskId === String(task.id)),
      );
      if (same || covering) reasons.push(`${day}: ${(covering ?? same).content} is in Todoist now.`);
      else if (duplicate.unreadableEntries > 0) reasons.push("Part of the Todoist task list couldn't be read, so a duplicate couldn't be ruled out.");
      continue;
    }
    const task = open.get(change.taskId);
    if (!task) reasons.push(`${shortWeekday(change.before.due)}: ${change.before.content} is no longer open.`);
    else if (!fits(task, change.before)) reasons.push(`${shortWeekday(change.before.due)}: ${change.before.content} was changed.`);
  }
  return reasons;
}

function alreadyDone(change, open) {
  if (change.action === "create") {
    const match = findTodoistDuplicates(change.payload, [...open.values()]).matches.find((task) => String(task.dueDate ?? "").slice(0, 10) === change.date);
    return match ? { taskId: String(match.id) } : null;
  }
  const task = open.get(change.taskId);
  if (change.action === "update") return task && fits(task, change.after) ? { taskId: change.taskId } : null;
  return task ? null : { taskId: change.taskId };
}

/** The expected state a carried-out proposal leaves: its successful changes on top of what it started from. */
function expectedAfter(record, startExpected) {
  const expected = structuredClone(startExpected);
  for (const entry of record.kept) {
    const target = record.targetOperations.find((operation) => operation.opId === entry.opId);
    if (target) expected[entry.opId] = { taskId: entry.taskId, content: target.content, description: target.description, due: target.due };
  }
  for (const change of record.changes) {
    const outcome = record.outcomes[change.id];
    if (outcome?.status !== "done") continue;
    if (change.action === "create") {
      if (outcome.taskId) expected[change.opId] = { taskId: outcome.taskId, ...taskState(change.payload) };
    } else if (change.action === "update") {
      if (change.fromOpId) delete expected[change.fromOpId];
      expected[change.opId] = { taskId: change.taskId, ...change.after };
    } else {
      delete expected[change.opId];
    }
  }
  return expected;
}

function reconciliationBaseBefore(document, record) {
  if (!record.base.reconciliation) return reconciliationBase({ ...document, reconciliations: [] }).expected;
  const earlier = (document.reconciliations ?? []).find((entry) => entry.id === record.base.reconciliation);
  return structuredClone(earlier?.expected ?? {});
}

export function formatReconciliationSummary(document, record) {
  const week = formatWeekLabel(document.weekStart);
  const done = record.changes.filter((change) => record.outcomes[change.id]?.status === "done");
  const failed = record.changes.filter((change) => record.outcomes[change.id]?.status === "failed");
  const title = record.status === "applied" ? "Changed the weekly plan's tasks" : record.status === "applied_with_errors" ? "Changed the weekly plan's tasks, with errors" : "Couldn't change the weekly plan's tasks";
  const lines = [`${title} · ${week}`, `Done: ${done.length} · Failed: ${failed.length}`];
  for (const change of failed) {
    lines.push(`- ${shortWeekday(change.date)} ${change.action === "create" ? change.payload.content : change.before.content}: ${record.outcomes[change.id].error}`);
  }
  if (failed.length > 0) lines.push("", "Failed changes are not retried. Ask me to look again if you want them made.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

/** Title, description and due date of a Todoist task, a task payload or a stored state, in one comparable form. */
function taskState(source) {
  const due = source.due_string ?? (source.due && typeof source.due === "object" ? source.due.date : source.due) ?? "";
  return { content: String(source.content ?? ""), description: String(source.description ?? ""), due: String(due ?? "").slice(0, 10) };
}

function fits(task, wanted) {
  const have = taskState(task);
  const want = taskState(wanted);
  return have.content === want.content && have.description === want.description && have.due === want.due;
}

function dueDate(task) {
  return taskState(task).due;
}

function splitOpId(opId) {
  const index = opId.indexOf(":");
  return [opId.slice(0, index), opId.slice(index + 1)];
}

function distance(a, b) {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
}

function byDate(a, b) {
  return a.date.localeCompare(b.date) || String(a.opId ?? "").localeCompare(String(b.opId ?? ""));
}

function today(now, timezone) {
  return localDateInTimeZone(now(), timezone);
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function shorten(message) {
  const text = String(message ?? "").replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}
