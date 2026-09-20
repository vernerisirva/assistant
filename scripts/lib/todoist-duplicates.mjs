/**
 * Duplicate detection for Todoist task creation.
 *
 * Hilla should not silently create a second copy of a task when the same
 * Telegram request arrives twice or a create call is retried. Matching is
 * deliberately strict: the normalized title from the creation plan must match
 * an open task exactly, ignoring only letter case and repeated whitespace. No
 * fuzzy distance, no embeddings, no model judgement, and no punctuation or word
 * stripping, because wrongly blocking a genuinely new task is worse than
 * missing a vague duplicate.
 *
 * Due dates are compared only as faithfully as the API allows. A new task
 * carries a natural-language `due_string`, while Todoist stores both the
 * resolved `due.date` and the original `due.string`. Comparing the two due
 * strings reflects what the user asked for without inventing date equivalence,
 * so anything less clear than "both absent" or "both identical" is reported as
 * uncertain rather than guessed either way.
 */
import { comparableTaskTitle } from "./todoist-format.mjs";

export const duplicateStatuses = Object.freeze({
  none: "none",
  duplicate: "duplicate",
  uncertain: "uncertain",
  readFailed: "read_failed",
  unchecked: "unchecked",
});

/**
 * @param payload the exact wire payload from buildTodoistCreatePlan
 * @param tasks open tasks as returned by the Todoist API. Deliberately has no
 *   default: an absent list means the read produced nothing, which must fail
 *   closed rather than look like an empty result.
 */
export function findTodoistDuplicates(payload = {}, tasks) {
  // Anything other than a list means the read did not produce a task list.
  // Coercing it to an empty list would report "no duplicate" on the strength of
  // no evidence, so the caller has to treat it as a failed read instead.
  if (!Array.isArray(tasks)) {
    throw new Error("Todoist duplicate detection needs a list of tasks.");
  }

  const wantedTitle = comparableTaskTitle(payload.content ?? "");
  if (!wantedTitle) return { status: duplicateStatuses.none, matches: [] };

  // An entry that is not a readable task means part of the list could not be
  // examined, so the check cannot claim that no duplicate exists there.
  const usable = tasks.filter((task) => task && typeof task === "object" && typeof task.content === "string");
  const unreadableEntries = tasks.length - usable.length;

  const candidates = usable
    .filter((task) => isOpen(task))
    .filter((task) => comparableTaskTitle(task.content) === wantedTitle);

  if (candidates.length === 0) {
    return unreadableEntries > 0
      ? { status: duplicateStatuses.uncertain, matches: [], unreadableEntries }
      : { status: duplicateStatuses.none, matches: [], unreadableEntries: 0 };
  }

  const matches = candidates.map((task) => describeMatch(task, payload));
  const status = matches.every((match) => match.dueComparison === "same")
    ? duplicateStatuses.duplicate
    : duplicateStatuses.uncertain;

  return { status, matches, unreadableEntries };
}

const uncertaintyReasons = Object.freeze({
  due_text_differs: "its due date differs",
  request_due_missing: "the existing task has a due date and this request does not",
  existing_due_missing: "this request has a due date and the existing task does not",
  deadline_unsupported: "this request carries a deadline, which cannot be compared",
  recurring_existing: "the existing task recurs, so the timing may not overlap",
});

export function describeDuplicateOutcome({ status, matches = [], unreadableEntries = 0 }) {
  if (status === duplicateStatuses.duplicate) {
    return matches.length === 1
      ? "A matching Todoist task already exists, so nothing was created."
      : `${matches.length} matching Todoist tasks already exist, so nothing was created.`;
  }

  if (status !== duplicateStatuses.uncertain) return "No matching Todoist task was found.";

  if (matches.length === 0) {
    return `Part of the Todoist task list could not be read (${unreadableEntries} unreadable ${unreadableEntries === 1 ? "entry" : "entries"}), so nothing was created.`;
  }

  const causes = [...new Set(matches.map((match) => uncertaintyReasons[match.dueComparison]).filter(Boolean))];
  const because = causes.length > 0 ? causes.join(", and ") : "the comparison is not conclusive";

  return `A Todoist task with this title already exists but ${because}, so nothing was created. Confirm whether you want another one.`;
}

/**
 * A finished task must never block a new one. The observed API returns
 * `checked`, while other Todoist endpoints and versions report `is_completed`
 * or `completed_at`, so all of them are honoured rather than assuming one.
 */
function isOpen(task) {
  if (task.checked === true || task.is_completed === true || task.is_deleted === true) return false;
  return !task.completed_at;
}

function describeMatch(task, payload) {
  const existingDue = task.due && typeof task.due === "object" ? task.due : null;

  return {
    id: task.id ?? null,
    content: task.content ?? "",
    dueDate: existingDue?.date ?? null,
    dueString: existingDue?.string ?? null,
    recurring: existingDue?.is_recurring === true,
    projectId: task.project_id ?? null,
    dueComparison: compareDue(payload, existingDue),
  };
}

/**
 * Returns "same" only when the request and the existing task plainly agree:
 * neither has a due date, or both carry the same due text. A recurring task
 * counts as the same request only when that text matches, so a recurring task
 * never silently blocks a one-off request with the same title.
 */
function compareDue(payload, existingDue) {
  // A deadline is a separate Todoist concept that the read does not let us
  // compare, so a request carrying one is never treated as plainly matching.
  if (String(payload.deadline_date ?? "").trim()) return "deadline_unsupported";

  const requestedDue = comparableTaskTitle(payload.due_string ?? "");

  if (!requestedDue && !existingDue) return "same";
  if (!requestedDue) return "request_due_missing";
  if (!existingDue) return "existing_due_missing";

  const existingText = comparableTaskTitle(existingDue.string ?? "");
  if (existingText && existingText === requestedDue) return "same";

  return existingDue.is_recurring === true ? "recurring_existing" : "due_text_differs";
}
