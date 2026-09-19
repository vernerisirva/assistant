import { normalizeTodoistDescription } from "./todoist-format.mjs";

const approvalRequiredActions = new Set([
  "delete",
  "bulk-edit",
  "move",
  "reopen",
  "shared-update",
]);

export function resolveExactTodoistTask(tasks = [], { taskId, content } = {}) {
  const candidates = Array.isArray(tasks) ? tasks : [];

  if (taskId?.trim()) {
    const matches = candidates.filter((task) => task.id === taskId);
    return exactResolution(matches, "No Todoist task matched that id.");
  }

  if (content?.trim()) {
    const wanted = normalizeComparableText(content);
    const matches = candidates.filter((task) =>
      normalizeComparableText(task.content) === wanted
    );
    return exactResolution(matches, "No Todoist task matched that title.");
  }

  return {
    status: "clarification_needed",
    reason: "A Todoist task id or exact task title is required.",
    matches: [],
  };
}

/**
 * Formatting-only cleanup for an existing Todoist description. This shares the
 * creation pipeline's normalization so add and update cannot drift apart, and
 * it never changes substantive text.
 */
export function cleanupTodoistDescriptionFormatting(description = "") {
  return normalizeTodoistDescription(description);
}

export function appendExplicitTodoistDetail(description = "", detail = "") {
  const cleanDescription = cleanupTodoistDescriptionFormatting(description);
  const cleanDetail = cleanupTodoistDescriptionFormatting(detail);

  if (!cleanDetail) {
    throw new Error("Explicit detail is required.");
  }

  return cleanDescription ? `${cleanDescription}\n\n${cleanDetail}` : cleanDetail;
}

export function buildExactTodoistUpdatePlan(task, {
  action,
  detail,
  replacementDescription,
  inferredUpdateContent = false,
  sensitiveContent = false,
  affectsOtherPeople = false,
} = {}) {
  if (!task?.id) {
    return clarify("One exact Todoist task is required.");
  }

  if (sensitiveContent) {
    return approvalRequired("Sensitive Todoist update content requires approval.");
  }

  if (affectsOtherPeople) {
    return approvalRequired("Todoist changes affecting other people require approval.");
  }

  if (inferredUpdateContent) {
    return approvalRequired("Inferred Todoist update content requires approval.");
  }

  if (approvalRequiredActions.has(action)) {
    return approvalRequired("Destructive, bulk, shared, or project-wide Todoist changes require approval.");
  }

  switch (action) {
    case "format-description":
      return executeUpdate(task, {
        description: cleanupTodoistDescriptionFormatting(task.description ?? ""),
      }, "Updated the Todoist task formatting. I kept the content the same and only cleaned up the description layout.");
    case "wording-description":
      if (!replacementDescription?.trim()) {
        return clarify("Wording cleanup requires replacement text that preserves meaning.");
      }
      return executeUpdate(task, {
        description: cleanupTodoistDescriptionFormatting(replacementDescription),
      }, "Updated the Todoist task wording. I kept the meaning the same.");
    case "append-detail":
      try {
        return executeUpdate(task, {
          description: appendExplicitTodoistDetail(task.description ?? "", detail),
        }, "Updated the Todoist task with the detail you provided.");
      } catch (error) {
        return clarify(error.message);
      }
    case "complete":
      return {
        mode: "execute_then_confirm",
        command: "close",
        taskId: task.id,
        payload: null,
        confirmation: "Marked the Todoist task complete.",
      };
    default:
      return clarify("Unsupported exact Todoist update action.");
  }
}

function exactResolution(matches, emptyReason) {
  if (matches.length === 1) {
    return {
      status: "exact",
      task: matches[0],
    };
  }

  if (matches.length === 0) {
    return {
      status: "clarification_needed",
      reason: emptyReason,
      matches: [],
    };
  }

  return {
    status: "clarification_needed",
    reason: "Multiple Todoist tasks matched. Choose one exact task.",
    matches: matches.map(({ id, content }) => ({ id, content })),
  };
}

function executeUpdate(task, payload, confirmation) {
  return {
    mode: "execute_then_confirm",
    command: "update",
    taskId: task.id,
    payload,
    confirmation,
  };
}

function approvalRequired(reason) {
  return {
    mode: "approval_required",
    command: null,
    taskId: null,
    payload: null,
    confirmation: null,
    reason,
  };
}

function clarify(reason) {
  return {
    mode: "clarify",
    command: null,
    taskId: null,
    payload: null,
    confirmation: null,
    reason,
  };
}

/**
 * Exact task-target matching stays strict on purpose: only surrounding and
 * repeated whitespace plus letter case are ignored. Markdown markers and
 * punctuation still have to match so task targeting never becomes fuzzy.
 */
function normalizeComparableText(value = "") {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}
