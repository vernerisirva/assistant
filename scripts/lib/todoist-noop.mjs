/**
 * Detecting a Todoist update that would change nothing.
 *
 * Formatting cleanup on an already-clean description, a rename to the current
 * title, or a label change that lands on the existing set are all writes that
 * cost a request and produce a confirmation for something that did not happen.
 *
 * Equality is only ever claimed where it is reliable. Every field in the payload
 * must be comparable and equal; a single field whose semantics this module
 * cannot compare makes the whole update proceed, because wrongly skipping a real
 * change is worse than sending a redundant request.
 */
import { comparableTaskTitle } from "./todoist-format.mjs";

/**
 * @param payload the exact wire payload that would be sent
 * @param task the existing task as returned by the Todoist API
 */
export function detectTodoistNoop(payload = {}, task) {
  if (!task || typeof task !== "object") {
    return { noop: false, undetermined: ["task"] };
  }

  const entries = Object.entries(payload);
  if (entries.length === 0) return { noop: false, undetermined: [] };

  const undetermined = [];
  let allEqual = true;

  for (const [field, value] of entries) {
    const comparison = compareField(field, value, task);
    if (comparison === "undetermined") undetermined.push(field);
    if (comparison !== "equal") allEqual = false;
  }

  return { noop: allEqual && undetermined.length === 0, undetermined };
}

function compareField(field, value, task) {
  switch (field) {
    case "content":
    case "description":
      return typeof task[field] === "string" && String(value) === task[field] ? "equal" : "different";

    case "priority":
      return Number(value) === Number(task.priority) ? "equal" : "different";

    case "project_id":
    case "section_id":
    case "parent_id":
      // An absent key is not evidence that the field is empty. Only an explicit
      // null or a real value can be compared; anything else sends the update.
      if (!(field in task)) return "undetermined";
      return sameId(value, task[field]) ? "equal" : "different";

    case "labels":
      return sameLabelSet(value, task.labels) ? "equal" : "different";

    // Only the due text the user wrote is comparable. A natural-language due
    // date is resolved by Todoist, so nothing here decides that "tomorrow"
    // already equals a stored date.
    case "due_string": {
      // A stored due carrying no due text of its own is not comparable. Reading
      // an absent string as "" would let a requested due clear or change look
      // equal to it, so this stays undetermined and the update is sent.
      const stored = task.due?.string;
      if (typeof stored !== "string") return "undetermined";
      return comparableTaskTitle(value) === comparableTaskTitle(stored) ? "equal" : "different";
    }

    case "due_lang":
      return String(value) === String(task.due?.lang ?? "") ? "equal" : "different";

    default:
      return "undetermined";
  }
}

function sameId(value, existing) {
  if (value === null || value === undefined) return existing === null || existing === undefined;
  return String(value) === String(existing ?? "");
}

function sameLabelSet(value, existing) {
  if (!Array.isArray(value) || !Array.isArray(existing)) return false;
  const normalize = (labels) => [...new Set(labels.map((label) => String(label)))].sort();
  const wanted = normalize(value);
  const current = normalize(existing);
  return wanted.length === current.length && wanted.every((label, index) => label === current[index]);
}
