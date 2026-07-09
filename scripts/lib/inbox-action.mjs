import { isApprovalMessage, normalizeApprovalText } from "./approval-language.mjs";

export const inboxActionModes = Object.freeze({
  executeThenConfirm: "execute_then_confirm",
  approvalRequired: "approval_required",
  clarify: "clarify",
  answerOnly: "answer_only",
});

export const inboxActionIntents = Object.freeze({
  todoistCreate: "todoist.create",
  todoistUpdate: "todoist.update",
  reminderCreate: "reminder.create",
  calendarCreate: "calendar.create",
  statusQuery: "status.query",
  adviceQuery: "advice.query",
  approvalResponse: "approval.response",
  clarify: "clarify",
  noAction: "no_action",
});

const defaultOptions = Object.freeze({
  hasPendingApproval: false,
  source: "typed",
  exactTaskTarget: false,
  completeDetails: false,
  targetCalendarClear: false,
  hasGuests: false,
  affectsOtherPeople: false,
  sensitiveContent: false,
  inferredUpdateContent: false,
});

const destructiveTodoistPattern =
  /\b(delete|remove task|reopen|move .* todoist|move todoist|bulk edit|all todoist|all tasks|all old todoist|every todoist|shared todoist|project-wide|all old tasks|every .*task|shared .*task|project .*tasks?)\b/;
const lowRiskTodoistUpdatePattern =
  /\b(rename|clean up .*formatting|clean .*formatting|format .*task|clean up .*wording|clean .*wording|wording cleanup|formatting cleanup|update .*description|replace .*description|append .*comment|append .*description|add detail|add .*detail|change due|reschedule|add label|remove label|complete .*task|mark .*done|mark .* complete)\b/;
const todoistPattern = /\b(todoist|tasks?|description)\b/;
const broadTodoistChangePattern = /\b(change|update|clean up|edit|modify)\b.*\b(my )?(todoist )?tasks?\b|\b(todoist )?tasks?\b.*\b(change|update|clean up|edit|modify)\b/;
const reminderPattern = /\b(remind me|set reminder|reminder)\b/;
const calendarPattern = /\b(calendar|event)\b/;
const calendarHighRiskPattern = /\b(delete|remove|move|reschedule|invite|add guest|rsvp|respond)\b/;
const statusPattern = /\b(agent running|bot running|status|what is running|scheduled|automatic messages|what.*next scheduled)\b/;
const advicePattern = /\b(what should i do|what next|recommend|how would you improve|what would you do)\b/;
const ambiguousActionPattern = /\b(move it|add this|remind me later|change that|update it|put it in the calendar)\b/;

export function classifyInboxAction(message, options = {}) {
  const raw = String(message ?? "").trim();
  const opts = { ...defaultOptions, ...options };
  const text = normalizeApprovalText(raw);

  if (!text) return answerOnly("no_action", "Empty message has no action.");

  if (isApprovalMessage(raw, { hasPendingApproval: opts.hasPendingApproval })) {
    return answerOnly("approval.response", "Approval reply for a pending approval prompt.");
  }

  if (isApprovalLikeWithoutPending(text)) {
    return answerOnly("no_action", "Approval-like message without a pending approval prompt.");
  }

  if (opts.affectsOtherPeople) {
    return approvalRequired(inferActionIntent(text), "high", "Actions affecting other people require approval.");
  }

  if (opts.sensitiveContent) {
    return approvalRequired(inferActionIntent(text), "high", "Sensitive content requires approval.");
  }

  if (isReferenceDerivedSource(opts.source)) {
    if (todoistPattern.test(text)) {
      return classifyTodoist(text, { ...opts, referenceDerived: true });
    }

    return approvalRequired(inferActionIntent(text), "medium", "Reference-derived non-Todoist actions require approval.");
  }

  if (ambiguousActionPattern.test(text)) {
    return clarify("Action-like message is missing a clear target or critical details.");
  }

  if (todoistPattern.test(text)) {
    return classifyTodoist(text, opts);
  }

  if (calendarPattern.test(text)) {
    return classifyCalendar(text, opts);
  }

  if (reminderPattern.test(text)) {
    if (opts.completeDetails) {
      return executeThenConfirm("reminder.create", "Complete typed reminder request.");
    }

    return clarify("Reminder request is missing text, date, or time.");
  }

  if (statusPattern.test(text)) {
    return answerOnly("status.query", "Status request does not mutate state.");
  }

  if (advicePattern.test(text)) {
    return answerOnly("advice.query", "Advice request does not mutate state.");
  }

  return answerOnly("no_action", "No supported action intent detected.");
}

function classifyTodoist(text, opts) {
  if (destructiveTodoistPattern.test(text)) {
    return approvalRequired("todoist.update", "high", "Destructive or bulk Todoist changes require approval.");
  }

  if (opts.inferredUpdateContent) {
    return approvalRequired("todoist.update", "medium", "Inferred Todoist update content requires approval.");
  }

  if (lowRiskTodoistUpdatePattern.test(text)) {
    if (opts.exactTaskTarget && opts.completeDetails) {
      const reason = opts.referenceDerived
        ? "Reference-derived exact Todoist task target and explicit low-risk personal productivity update."
        : "Exact Todoist task target and explicit low-risk personal productivity update.";
      return executeThenConfirm("todoist.update", reason);
    }

    return clarify("Todoist update is missing exact task target or complete details.");
  }

  if (broadTodoistChangePattern.test(text)) {
    return clarify("Todoist change is missing one exact personal task target.");
  }

  if (/\b(add|create|new)\b/.test(text)) {
    if (opts.referenceDerived) {
      return approvalRequired("todoist.create", "medium", "Reference-derived Todoist creation details require approval.");
    }

    if (opts.completeDetails) {
      return executeThenConfirm("todoist.create", "Complete typed Todoist creation request.");
    }

    return clarify("Todoist creation is missing task content, due date, project, or other critical details.");
  }

  return answerOnly("no_action", "Todoist was mentioned without a supported task action.");
}

function classifyCalendar(text, opts) {
  if (calendarHighRiskPattern.test(text) || opts.hasGuests) {
    return approvalRequired("calendar.create", "high", "Calendar edits, invites, and responses require approval.");
  }

  if (/\b(add|create|put|schedule)\b/.test(text)) {
    if (opts.completeDetails && opts.targetCalendarClear) {
      return executeThenConfirm("calendar.create", "Complete typed calendar creation request.");
    }

    return clarify("Calendar creation is missing date, time, title, timezone, or target calendar.");
  }

  return answerOnly("no_action", "Calendar was mentioned without a supported event creation request.");
}

function inferActionIntent(text) {
  if (todoistPattern.test(text)) return "todoist.update";
  if (calendarPattern.test(text)) return "calendar.create";
  if (reminderPattern.test(text)) return "reminder.create";
  return "clarify";
}

function isReferenceDerivedSource(source) {
  return ["image", "ocr", "screenshot", "reference"].includes(source);
}

function executeThenConfirm(intent, reason) {
  return decision(intent, "low", "execute_then_confirm", false, reason);
}

function approvalRequired(intent, risk, reason) {
  return decision(intent, risk, "approval_required", true, reason);
}

function clarify(reason) {
  return decision("clarify", "unknown", "clarify", false, reason);
}

function answerOnly(intent, reason) {
  return decision(intent, "none", "answer_only", false, reason);
}

function decision(intent, risk, mode, approvalRequired, reason) {
  return { intent, risk, mode, approvalRequired, reason };
}

function isApprovalLikeWithoutPending(text) {
  return ["approve", "approved", "ok", "okay", "yes", "go ahead", "proceed"].includes(text);
}
