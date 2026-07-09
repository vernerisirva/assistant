export const calendarCreationModes = Object.freeze({
  policyAllowedPreview: "policy_allowed_preview",
  clarificationNeeded: "clarification_needed",
  approvalRequired: "approval_required",
  unsupported: "unsupported",
});

const defaultTimezone = "Europe/Stockholm";

export function buildCalendarCreationPreview(input = {}) {
  const request = normalizeRequest(input);
  if (input.requestExecution) {
    return decision(calendarCreationModes.unsupported, {
      approvalRequired: false,
      request,
      reason: "Calendar creation execution is unsupported in v1 because no documented safe Calendar write tool is configured.",
    });
  }

  const approvalReason = approvalReasonFor(input, request);
  if (approvalReason) {
    return decision(calendarCreationModes.approvalRequired, {
      approvalRequired: true,
      request,
      reason: approvalReason,
    });
  }

  const clarification = clarificationFor(input, request);
  if (clarification) {
    return decision(calendarCreationModes.clarificationNeeded, {
      approvalRequired: false,
      request,
      question: clarification,
      reason: "Calendar creation needs one more clear detail before Hilla can build a preview.",
    });
  }

  return decision(calendarCreationModes.policyAllowedPreview, {
    approvalRequired: false,
    readyForSafeCreateTool: true,
    request,
    reason: "Exactly one complete low-risk personal Calendar event is ready as a policy-allowed preview. No event is created by this helper.",
  });
}

export function formatCalendarCreationPreview(preview) {
  if (preview.mode === calendarCreationModes.policyAllowedPreview) {
    const { request } = preview;
    return [
      `Calendar creation preview: ${request.title}`,
      `- When: ${request.date} ${request.start}-${request.end} (${request.timezone})`,
      "- Calendar: Primary personal Calendar.",
      "- Guests: No guests.",
      "- External impact: No email, invitations, or existing-event changes.",
      "- Status: policy-allowed preview / ready for a future safe create tool.",
      "- This is a preview only; no event was created.",
    ].join("\n");
  }

  if (preview.mode === calendarCreationModes.clarificationNeeded) {
    return [
      "Calendar creation preview needs clarification.",
      `- ${preview.question}`,
      "- No event was created.",
    ].join("\n");
  }

  if (preview.mode === calendarCreationModes.approvalRequired) {
    return [
      "Calendar creation preview requires approval before any future write tool could be used.",
      `- Reason: ${preview.reason}`,
      "- This preview made no Calendar changes.",
    ].join("\n");
  }

  return [
    "Calendar creation preview is unsupported.",
    `- Reason: ${preview.reason}`,
    "- No event was created.",
  ].join("\n");
}

function decision(mode, values) {
  return {
    mode,
    intent: "calendar.create",
    execution: "preview_only",
    sideEffects: [],
    readyForSafeCreateTool: false,
    ...values,
  };
}

function normalizeRequest(input) {
  const timezone = clean(input.timezone) || defaultTimezone;
  const calendarInput = clean(input.calendar).toLowerCase();
  const start = clean(input.start);
  const end = clean(input.end);
  const durationMinutes = parsePositiveInteger(input.duration);
  const normalized = {
    title: clean(input.title),
    date: clean(input.date),
    start,
    end,
    durationMinutes,
    timezone,
    timezoneSource: clean(input.timezone) ? "explicit" : "default",
    calendar: calendarInput === "personal" || !calendarInput ? "primary" : calendarInput,
    guests: normalizeGuests(input.guests),
  };

  if (isValidTime(start) && durationMinutes) {
    normalized.end = addMinutes(start, durationMinutes);
  } else if (isValidTime(start) && isValidTime(end)) {
    normalized.durationMinutes = minutesBetween(start, end);
  }

  return normalized;
}

function approvalReasonFor(input, request) {
  const operation = clean(input.operation || "create").toLowerCase();
  if (operation !== "create") return "Editing, deleting, or moving an existing Calendar event requires approval.";
  if (input.recurring) return "Recurring Calendar events require approval.";
  if (Number(input.eventCount ?? 1) !== 1 || input.multipleEvents) return "Creating multiple Calendar events requires approval.";
  if (request.guests.length > 0 || input.hasGuests) return "Guests, invitations, or notifications to another person require approval.";
  if (input.affectsOtherPeople) return "Calendar actions affecting other people require approval.";
  if (input.sensitiveContent) return "Sensitive Calendar content requires approval.";
  if (input.inferredSubstantiveContent && isReferenceDerived(input.source)) {
    return "Uncertain screenshot or OCR-derived substantive Calendar content requires approval.";
  }
  if (input.requiresBrowserSubmission || input.bookingOrPayment) {
    return "Booking, payment, or browser submission activity requires approval.";
  }
  if (request.calendar !== "primary") return "A named non-primary or shared Calendar requires approval.";
  return "";
}

function clarificationFor(input, request) {
  if (!request.title) return "What is the event title?";
  if (!isValidDate(request.date)) return "What date should I use? Please use YYYY-MM-DD.";
  if (!isValidTime(request.start)) return "What start time should I use? Please use HH:MM.";
  if (!request.durationMinutes || request.durationMinutes <= 0) {
    return "What duration or end time should I use?";
  }
  if (!request.end) {
    return "This event would cross midnight. What explicit end time and date should I use?";
  }
  if (!isValidTimezone(request.timezone)) return "What timezone should I use? Please provide a valid IANA timezone.";
  if (clean(input.end) && clean(input.duration) && isValidTime(clean(input.end))) {
    const suppliedDuration = parsePositiveInteger(input.duration);
    if (suppliedDuration !== minutesBetween(request.start, clean(input.end))) {
      return "The duration and end time disagree. Which should I use?";
    }
  }
  if (input.possibleDuplicate) return "This may duplicate an existing event. Should I continue with the preview?";
  if (input.guestsUnclear) return "Should this remain a personal event with no guests?";
  return "";
}

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeGuests(guests) {
  if (!guests) return [];
  return (Array.isArray(guests) ? guests : [guests]).map(clean).filter(Boolean);
}

function parsePositiveInteger(value) {
  const text = clean(value);
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [hours, minutes] = value.split(":").map(Number);
  return hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60;
}

function isValidTimezone(value) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function addMinutes(time, duration) {
  const total = toMinutes(time) + duration;
  if (total >= 24 * 60) return "";
  return fromMinutes(total);
}

function minutesBetween(start, end) {
  const difference = toMinutes(end) - toMinutes(start);
  return difference > 0 ? difference : null;
}

function toMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function fromMinutes(total) {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function isReferenceDerived(source) {
  return ["image", "ocr", "screenshot", "reference"].includes(clean(source).toLowerCase());
}
