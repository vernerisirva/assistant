/**
 * "What are you waiting on from me?": one read-only view of the places where
 * Hilla is genuinely waiting for the user.
 *
 * Each source is a small provider over state that already exists; nothing new
 * is stored. The weekly plan store gives a plan awaiting review and its
 * deadline, and the focus record gives a running session. Approval prompts and
 * clarifying questions asked in chat are not stored anywhere, so this view
 * cannot list them and says so. Recommendations, Todoist tasks, and memory are
 * not pending actions and are never read here.
 *
 * Providers fail independently. A source that cannot be read is reported as
 * unchecked, never as "nothing pending". Only short summaries leave a provider,
 * never stored payloads, ids, or task content, and all text is redacted.
 *
 * Read-only: no provider writes, locks, renames, or creates anything.
 */
import { formatFocusStatus, isFocusSessionCurrent, readFocusSession, resolveFocusSessionPath } from "./focus.mjs";
import { redactSensitiveText } from "./assistant-status.mjs";
import { formatLocalDateTime, formatWeekLabel } from "./weekly-plan.mjs";
import { createWeeklyPlanStore } from "./weekly-plan-store.mjs";

const TYPE_ORDER = Object.freeze(["weekly_plan", "focus_session"]);

// Key-shaped text is masked even when the secret itself is unknown.
const secretShapedPattern =
  /\b(?:sk-(?:or-|proj-|live-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|\d{8,10}:[A-Za-z0-9_-]{30,}|[A-Fa-f0-9]{32,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b|\b(?:password|passcode|passwd|token|secret|api[_ -]?key|bearer)\b\s*[:=]?\s*\S+/gi;

export function redactPendingText(text, secrets = []) {
  return redactSensitiveText(String(text ?? ""), secrets).replace(secretShapedPattern, "<redacted>");
}

/** A weekly plan that was shown and waits for the user's OK, change, or cancel. */
export const weeklyPlanPendingProvider = Object.freeze({
  id: "weekly-plan",
  label: "the weekly plan",
  read({ stateDir, now, timezone }) {
    const { plans, issues } = createWeeklyPlanStore({ stateDir }).listPlansWithIssues();
    const items = [];
    const notes = [];

    for (const plan of plans) {
      const week = formatWeekLabel(plan.weekStart);
      if (plan.status === "pending" && plan.reviewDeadline) {
        const deadlinePassed = Date.parse(plan.reviewDeadline) <= now.getTime();
        items.push({
          type: "weekly_plan",
          source: "weekly-plan",
          summary: `Weekly plan for ${week} (v${plan.currentVersion})`,
          detail: deadlinePassed
            ? `Its review window ended at ${formatLocalDateTime(plan.reviewDeadline, timezone)}, so the tasks are created at the next apply check unless you cancel it now.`
            : `Its tasks are created automatically at ${formatLocalDateTime(plan.reviewDeadline, timezone)} unless you change or cancel it.`,
          since: plan.displayedAt,
          deadline: plan.reviewDeadline,
          requiredAction: deadlinePassed ? "You can still cancel it." : "Reply OK to create them now, ask for a change, or cancel it.",
        });
      } else if (plan.status === "draft") {
        notes.push(`A weekly plan draft for ${week} was never shown, so it will not apply.`);
      } else if (plan.status === "applying") {
        notes.push(`The weekly plan for ${week} is being applied right now.`);
      }
    }

    return {
      items,
      notes,
      issues: issues.length > 0 ? [`${issues.length} weekly plan file(s) could not be read, so a plan may be missing.`] : [],
    };
  },
});

/** A focus session that is running or past its planned end. */
export const focusPendingProvider = Object.freeze({
  id: "focus",
  label: "the focus session",
  read({ stateDir, now, timezone }) {
    const state = readFocusSession(resolveFocusSessionPath(stateDir), { now });
    if (state.status === "none") return { items: [], notes: [], issues: [] };
    if (!isFocusSessionCurrent(state)) {
      return { items: [], notes: [formatFocusStatus(state, { timezone })], issues: [] };
    }

    // Only the block's length, project, and timing identify it; its outcome and
    // other task text stay in the focus record.
    const [headline] = formatFocusStatus(state, { timezone }).split("\n");
    return {
      items: [
        {
          type: "focus_session",
          source: "focus",
          summary: headline.replace(/\.$/, ""),
          detail: null,
          since: state.session.startedAt,
          deadline: state.endsAt,
          requiredAction: state.status === "active" ? "Keep going, or say done to end it." : "Say done to end it, or keep going.",
        },
      ],
      notes: [],
      issues: [],
    };
  },
});

export const PENDING_PROVIDERS = Object.freeze([weeklyPlanPendingProvider, focusPendingProvider]);

/**
 * Runs every provider on its own. One broken source never hides the others,
 * and it is reported as unchecked instead of as empty.
 */
export function collectPendingActions({ stateDir, now = new Date(), timezone = "Europe/Stockholm", secrets = [], providers = PENDING_PROVIDERS } = {}) {
  if (!stateDir) throw new Error("A state directory is required for the pending view.");
  const context = { stateDir, now: now instanceof Date ? now : new Date(now), timezone };
  const redact = (text) => (text === null || text === undefined ? null : redactPendingText(text, secrets));

  const items = [];
  const notes = [];
  const checked = [];
  const unavailable = [];
  for (const provider of providers) {
    let result;
    try {
      result = provider.read(context);
    } catch (error) {
      unavailable.push({ source: provider.id, label: provider.label, reason: redact(error.message) });
      continue;
    }
    checked.push({ source: provider.id, label: provider.label });
    items.push(...result.items.map((item) => ({ ...item, summary: redact(item.summary), detail: redact(item.detail), requiredAction: redact(item.requiredAction) })));
    notes.push(...result.notes.map(redact));
    if (result.issues.length > 0) {
      unavailable.push({ source: provider.id, label: provider.label, reason: redact(result.issues.join(" ")), partial: true });
    }
  }

  items.sort(comparePendingItems);
  return { items, notes, checked, unavailable };
}

export function comparePendingItems(left, right) {
  const leftDeadline = left.deadline ? Date.parse(left.deadline) : Number.POSITIVE_INFINITY;
  const rightDeadline = right.deadline ? Date.parse(right.deadline) : Number.POSITIVE_INFINITY;
  return (
    leftDeadline - rightDeadline ||
    TYPE_ORDER.indexOf(left.type) - TYPE_ORDER.indexOf(right.type) ||
    compareStrings(left.since ?? "", right.since ?? "") ||
    compareStrings(left.summary, right.summary)
  );
}

// Code-unit order, so the result never depends on the runtime locale.
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Telegram text built from the collected state, without a model. */
export function formatPendingActions({ items, notes, checked, unavailable }) {
  const lines = [];
  const unchecked = unavailable.filter((entry) => !entry.partial).map((entry) => entry.label);
  const partial = unavailable.filter((entry) => entry.partial);

  if (items.length > 0) {
    lines.push(`You're waiting on ${items.length === 1 ? "1 thing" : `${items.length} things`}:`, "");
    items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.summary}`);
      if (item.detail) lines.push(`   ${item.detail}`);
      if (item.requiredAction) lines.push(`   ${item.requiredAction}`);
      lines.push("");
    });
    lines.pop();
  } else if (unchecked.length === 0 && partial.length === 0) {
    lines.push("Nothing is waiting on you right now.");
  } else if (checked.length === 0) {
    lines.push(`I couldn't check what's waiting on you: ${joinLabels(unchecked)} couldn't be read.`);
  } else {
    const checkedLabels = checked.map((entry) => entry.label);
    lines.push(`I found nothing waiting on you in ${joinLabels(checkedLabels)}${unchecked.length > 0 ? `, but ${joinLabels(unchecked)} couldn't be checked` : ""}.`);
  }

  if (items.length > 0 && unchecked.length > 0) {
    lines.push("", `I couldn't check ${joinLabels(unchecked)}, so something there may be missing.`);
  }
  for (const entry of partial) lines.push("", entry.reason);
  for (const note of notes) lines.push("", note);
  return lines.join("\n");
}

export const PENDING_GUIDANCE =
  "Reply with telegramText. This view is read-only: approving, changing, or cancelling an item follows its own rules (weekly plan accept, revise, or cancel; focus end). Chat is not stored: if earlier in this conversation you sent an approval prompt or a clarifying question that blocks an action the user asked for, and it is still unanswered, add one line after telegramText starting with `Also from our chat:`. Never add any other question, or tasks, reminders, deadlines, or recommendations.";

function joinLabels(labels) {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}
