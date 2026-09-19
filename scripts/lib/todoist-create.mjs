/**
 * The one authoritative Todoist task creation/update payload path.
 *
 * Every caller — individual CLI flags, structured `--task-json`, dry run, and
 * real creation — builds the exact wire payload here, so a task looks the same
 * in Todoist regardless of how the command was constructed.
 */
import { buildTodoistTaskPayload } from "./todoist.mjs";
import {
  containsUrl,
  dropDuplicateTitleLine,
  hasTransportEscapes,
  normalizeTodoistDescription,
  splitTodoistTitle,
} from "./todoist-format.mjs";

export const TODOIST_CONTENT_MAX_LENGTH = 500;
export const TODOIST_DESCRIPTION_MAX_LENGTH = 16384;
const LONG_TITLE_LENGTH = 120;

/** Fields an agent may set. Anything else is rejected before it reaches Todoist. */
export const supportedTaskFields = Object.freeze([
  "content",
  "description",
  "dueString",
  "dueLang",
  "priority",
  "projectId",
  "sectionId",
  "parentId",
  "labels",
  "deadlineDate",
]);

const fieldAliases = Object.freeze({
  due: "dueString",
  due_string: "dueString",
  due_lang: "dueLang",
  project_id: "projectId",
  section_id: "sectionId",
  parent_id: "parentId",
  deadline_date: "deadlineDate",
  label: "labels",
});

export function normalizeTaskFieldKeys(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Todoist task input must be a JSON object.");
  }

  const normalized = {};
  for (const [key, value] of Object.entries(input)) {
    const field = fieldAliases[key] ?? key;
    if (!supportedTaskFields.includes(field)) {
      throw new Error(
        `Unsupported Todoist task field: ${key}. Supported fields: ${supportedTaskFields.join(", ")}.`,
      );
    }
    normalized[field] = value;
  }

  return normalized;
}

export function buildTodoistCreatePlan(input = {}) {
  const fields = buildTaskFields(input, { requireContent: true, allowTitleOverflow: true });

  return {
    mode: "execute_then_confirm",
    command: "add",
    taskId: null,
    payload: buildTodoistTaskPayload(fields.task),
    descriptionLines: fields.task.description ? fields.task.description.split("\n") : [],
    descriptionState: fields.task.description ? "set" : "empty",
    adjustments: fields.adjustments,
    warnings: fields.warnings,
    confirmation: `Created the Todoist task "${fields.task.content}".`,
  };
}

export function buildTodoistUpdatePlan(taskId, input = {}) {
  if (!String(taskId ?? "").trim()) {
    throw new Error("Todoist task id is required.");
  }

  const fields = buildTaskFields(input, { requireContent: false, allowTitleOverflow: false });
  const descriptionState = describeUpdateDescription(input, fields.task);
  const payload = buildTodoistTaskPayload(fields.task, { requireContent: false });

  // buildTodoistTaskPayload drops empty values, so an explicit request to clear
  // the description is re-added here. The preview may only say a field changes
  // when that field is actually in the wire payload.
  if (descriptionState === "empty") payload.description = "";

  return {
    mode: "execute_then_confirm",
    command: "update",
    taskId,
    payload,
    descriptionLines: fields.task.description ? fields.task.description.split("\n") : [],
    descriptionState,
    adjustments: fields.adjustments,
    warnings: fields.warnings,
    confirmation: `Updated the Todoist task ${taskId}.`,
  };
}

export function formatTodoistTaskPlan(plan, { dryRun = false } = {}) {
  const payload = plan.payload ?? {};
  const lines = [
    dryRun
      ? `Todoist ${plan.command} dry run. Nothing was sent to Todoist.`
      : plan.confirmation,
    `- Title: ${payload.content ?? "(unchanged)"}`,
  ];

  if (plan.descriptionLines.length > 0) {
    lines.push("- Description:");
    for (const line of plan.descriptionLines) lines.push(`  | ${line}`);
  } else if (plan.descriptionState === "unchanged") {
    lines.push("- Description: (unchanged)");
  } else {
    lines.push("- Description: (empty)");
  }

  for (const [label, key] of [
    ["Due", "due_string"],
    ["Due language", "due_lang"],
    ["Deadline", "deadline_date"],
    ["Priority", "priority"],
    ["Project", "project_id"],
    ["Section", "section_id"],
    ["Parent", "parent_id"],
  ]) {
    if (payload[key] !== undefined) lines.push(`- ${label}: ${payload[key]}`);
  }

  if (Array.isArray(payload.labels) && payload.labels.length > 0) {
    lines.push(`- Labels: ${payload.labels.join(", ")}`);
  }

  for (const adjustment of plan.adjustments) lines.push(`- Adjusted: ${adjustment}`);
  for (const warning of plan.warnings) lines.push(`- Check: ${warning}`);

  return lines.join("\n");
}

function buildTaskFields(rawInput, { requireContent, allowTitleOverflow }) {
  const input = normalizeTaskFieldKeys(rawInput);
  const adjustments = [];
  const warnings = [];

  assertDescriptionType(input.description);
  const escapedNewlines =
    hasTransportEscapes(input.content ?? "") || hasTransportEscapes(input.description ?? "");

  const { title, overflow } = splitTodoistTitle(input.content ?? "");
  if (requireContent && !title) {
    throw new Error("Todoist task content is required.");
  }
  if (input.content !== undefined && !title) {
    throw new Error("Todoist task content is required.");
  }

  if (title && title.length > TODOIST_CONTENT_MAX_LENGTH) {
    throw new Error(
      `Todoist task content must be ${TODOIST_CONTENT_MAX_LENGTH} characters or fewer.`,
    );
  }

  if (overflow && !allowTitleOverflow) {
    throw new Error(
      "Todoist task content must be one line. Pass the extra lines as --description.",
    );
  }

  const task = {};
  if (title) task.content = title;

  const description = composeDescription({
    title,
    overflow,
    description: input.description,
    adjustments,
  });

  if (description) {
    if (description.length > TODOIST_DESCRIPTION_MAX_LENGTH) {
      throw new Error(
        `Todoist task description must be ${TODOIST_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
      );
    }
    task.description = description;
  } else if (input.description !== undefined && input.description !== null) {
    task.description = "";
  }

  assignOptionalFields(task, input);
  recordTitleAdjustments({ input, title, overflow, escapedNewlines, adjustments });
  recordWarnings({ task, warnings });

  return { task, adjustments, warnings };
}

/**
 * An update that carries no description field leaves the existing description
 * alone. Only an explicitly supplied empty description clears it.
 */
function describeUpdateDescription(input, task) {
  if (task.description) return "set";
  if (input.description === undefined || input.description === null) return "unchanged";
  return "empty";
}

function composeDescription({ title, overflow, description, adjustments }) {
  const supplied = normalizeTodoistDescription(description ?? "");
  const deduplicatedSupplied = dropDuplicateTitleLine(title, supplied);
  const movedTitleLines = normalizeTodoistDescription(overflow ?? "");
  const combined = [movedTitleLines, deduplicatedSupplied].filter(Boolean).join("\n\n");
  const composed = dropDuplicateTitleLine(title, combined);

  if (supplied !== deduplicatedSupplied || combined !== composed) {
    adjustments.push("Removed a description first line that only repeated the task title.");
  }

  return composed;
}

function assignOptionalFields(task, input) {
  if (input.dueString !== undefined) task.dueString = requireText(input.dueString, "dueString");
  if (input.dueLang !== undefined) task.dueLang = requireText(input.dueLang, "dueLang");
  if (input.projectId !== undefined) task.projectId = requireText(input.projectId, "projectId");
  if (input.sectionId !== undefined) task.sectionId = requireText(input.sectionId, "sectionId");
  if (input.parentId !== undefined) task.parentId = requireText(input.parentId, "parentId");
  if (input.deadlineDate !== undefined) {
    task.deadlineDate = requireText(input.deadlineDate, "deadlineDate");
  }
  if (input.priority !== undefined) task.priority = requirePriority(input.priority);
  if (input.labels !== undefined) task.labels = requireLabels(input.labels);
}

function recordTitleAdjustments({ input, title, overflow, escapedNewlines, adjustments }) {
  if (escapedNewlines) {
    adjustments.push("Converted escaped newline sequences into real line breaks.");
  }

  if (overflow) {
    adjustments.push("Moved extra task title lines into the description.");
  } else if (input.content !== undefined && String(input.content).trim() !== title) {
    adjustments.push("Normalized the task title to one clean line.");
  }
}

function recordWarnings({ task, warnings }) {
  if (!task.content) return;

  if (containsUrl(task.content)) {
    warnings.push("The task title contains a URL. Links usually belong in the description.");
  }

  if (task.dueString && repeatsDueText(task.content, task.dueString)) {
    warnings.push(
      `The task title repeats the due date "${task.dueString}", which Todoist already stores separately.`,
    );
  }

  if (task.content.length > LONG_TITLE_LENGTH) {
    warnings.push("The task title is long. Consider moving detail into the description.");
  }
}

function repeatsDueText(content, dueString) {
  const due = String(dueString).trim().toLowerCase();
  if (due.length < 3) return false;
  return new RegExp(`(^|\\s)${escapeRegExp(due)}(\\s|$)`).test(content.toLowerCase());
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertDescriptionType(description) {
  if (description === undefined || description === null) return;
  if (typeof description !== "string") {
    throw new Error("Todoist task description must be a string.");
  }
}

function requireText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Todoist task ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function requirePriority(value) {
  const priority = Number(value);
  if (!Number.isInteger(priority) || priority < 1 || priority > 4) {
    throw new Error("Todoist task priority must be an integer between 1 and 4.");
  }
  return priority;
}

function requireLabels(value) {
  if (!Array.isArray(value)) {
    throw new Error("Todoist task labels must be an array of strings.");
  }
  return value.map((label) => requireText(label, "label"));
}
