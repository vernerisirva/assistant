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
 * @param tasks open tasks as returned by the Todoist API
 */
export function findTodoistDuplicates(payload = {}, tasks = []) {
  const wantedTitle = comparableTaskTitle(payload.content ?? "");
  if (!wantedTitle) return { status: duplicateStatuses.none, matches: [] };

  const candidates = (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task && typeof task === "object")
    .filter((task) => task.checked !== true && task.is_deleted !== true)
    .filter((task) => comparableTaskTitle(task.content ?? "") === wantedTitle);

  if (candidates.length === 0) return { status: duplicateStatuses.none, matches: [] };

  const matches = candidates.map((task) => describeMatch(task, payload));
  const status = matches.every((match) => match.dueComparison === "same")
    ? duplicateStatuses.duplicate
    : duplicateStatuses.uncertain;

  return { status, matches };
}

export function describeDuplicateOutcome({ status, matches }) {
  if (status === duplicateStatuses.duplicate) {
    return matches.length === 1
      ? "A matching Todoist task already exists, so nothing was created."
      : `${matches.length} matching Todoist tasks already exist, so nothing was created.`;
  }

  if (status === duplicateStatuses.uncertain) {
    return "A Todoist task with this title already exists but its due date differs, so nothing was created. Confirm whether you want another one.";
  }

  return "No matching Todoist task was found.";
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
  if (String(payload.deadline_date ?? "").trim()) return "unknown";

  const requestedDue = comparableTaskTitle(payload.due_string ?? "");

  if (!requestedDue && !existingDue) return "same";
  if (!requestedDue || !existingDue) return "unknown";

  const existingText = comparableTaskTitle(existingDue.string ?? "");
  return existingText && existingText === requestedDue ? "same" : "unknown";
}
