import { classifyInboxAction } from "./inbox-action.mjs";

const agentHardStops = Object.freeze({
  personal: [
    "Stop before unclear targets, external side effects, destructive changes, or state-changing shell commands without explicit approval.",
  ],
  admin: [
    "Stop before sending or mutating email without approval.",
    "Stop before Calendar edits, deletes, invites, or responses without approval.",
    "Stop before Todoist destructive, bulk, shared/project-wide, ambiguous, sensitive, inferred-content, or other-person changes without approval.",
    "Stop before Min Golf booking, payment, BankID, card entry, Swish, check-in, cancellation, or changed booking terms without approval.",
  ],
  health: [
    "Stop before routine, Calendar, Todoist, purchase, delivery, browser, local file, or shell changes without approval.",
    "Stop before diagnosis, medical treatment planning, extreme dieting advice, or urgent medical/injury handling.",
  ],
  research: [
    "Stop before booking, buying, submitting forms, logging into accounts, local file edits, or state-changing shell commands without approval.",
    "Stop before presenting high-stakes or current claims without source support.",
  ],
});

const routeRules = Object.freeze([
  {
    agent: "admin",
    confidence: "high",
    reason: "Message mentions admin/logistics systems such as Gmail, Calendar, Todoist, reminders, or Min Golf.",
    pattern: /\b(gmail|email|mail|calendar|event|todoist|task|remind|reminder|min golf|tee time|tee-time|booking|book golf|boka|logistics|agenda|meeting)\b/,
  },
  {
    agent: "personal",
    confidence: "high",
    reason: "Message mentions memory or Telegram-facing coordination.",
    pattern: /\b(memory|remember|forget|store this|save this)\b/,
  },
  {
    agent: "research",
    confidence: "high",
    reason: "Message asks for source-backed or current research.",
    pattern: /\b(research|look up|lookup|source|sources|cite|citation|compare|comparison|current|latest|find information|fact check|nutrition research)\b/,
  },
  {
    agent: "health",
    confidence: "high",
    reason: "Message mentions health, workout, food, sleep, movement, groceries, or routine coaching.",
    pattern: /\b(workout|gym|training|exercise|movement|food|meal|grocery|groceries|sleep|craving|health|midday-check-in|workout-window|morning-brief|evening-review|weekly-review|routine)\b/,
  },
  {
    agent: "personal",
    confidence: "medium",
    reason: "Message is about status, memory, automatic messages, advice, or general Telegram-facing coordination.",
    pattern: /\b(status|running|automatic messages|scheduled|quiet|noise|memory|remember|forget|what next|recommend|what should i do)\b/,
  },
]);

const sideEffectRules = Object.freeze([
  {
    reason: "Email mutation requires Telegram approval.",
    approvalRequired: true,
    pattern: /\b(send|reply|forward|archive|delete|label|move)\b.*\b(email|gmail|mail)\b|\b(email|gmail|mail)\b.*\b(send|reply|forward|archive|delete|label|move)\b/,
  },
  {
    reason: "Min Golf booking-like action requires Telegram approval.",
    approvalRequired: true,
    pattern: /\b(book|booking|reserve|boka|check in|cancel|pay|payment)\b.*\b(golf|min golf|tee|tee time|tee-time)\b|\b(golf|min golf|tee|tee time|tee-time)\b.*\b(book|booking|reserve|boka|check in|cancel|pay|payment)\b/,
  },
  {
    reason: "Routine mutations require Telegram approval.",
    approvalRequired: true,
    pattern: /\b(skip|unskip|disable|enable|reschedule|set time|move|adjust|change)\b.*\b(routine|midday-check-in|workout-window|morning-brief|evening-review|weekly-review)\b|\b(routine|midday-check-in|workout-window|morning-brief|evening-review|weekly-review)\b.*\b(skip|unskip|disable|enable|reschedule|set time|move|adjust|change)\b/,
  },
  {
    reason: "Sensitive memory requires Telegram approval.",
    approvalRequired: true,
    pattern: /\b(remember|store this|save this)\b.*\b(medication|diagnosis|medical|condition|injury|password|bank|card|secret|private)\b|\b(medication|diagnosis|medical|condition|injury|password|bank|card|secret|private)\b.*\b(remember|store this|save this)\b/,
  },
  {
    reason: "Explicit low-risk memory write or forget request is a local memory side effect; sensitive memory still requires Telegram approval.",
    approvalRequired: false,
    pattern: /\b(remember|forget|store this|save this)\b/,
  },
  {
    reason: "Booking, purchase, payment, form submission, or check-in language indicates an external side effect.",
    approvalRequired: true,
    pattern: /\b(book|buy|purchase|pay|submit|send form|check in|cancel booking|reserve)\b/,
  },
]);

export function parseInboxClassifierDebugArgs(argv) {
  const options = {
    json: false,
    actionOptions: {},
    message: "",
  };
  const messageParts = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--source") {
      const source = argv[index + 1];
      if (!source || source.startsWith("--")) {
        throw new Error("--source requires a value such as screenshot or reference");
      }
      options.actionOptions.source = source;
      index += 1;
      continue;
    }

    if (arg.startsWith("--source=")) {
      options.actionOptions.source = arg.slice("--source=".length);
      continue;
    }

    if (arg === "--exact-task-target") {
      options.actionOptions.exactTaskTarget = true;
      continue;
    }

    if (arg === "--complete-details") {
      options.actionOptions.completeDetails = true;
      continue;
    }

    if (arg === "--target-calendar-clear") {
      options.actionOptions.targetCalendarClear = true;
      continue;
    }

    if (arg === "--has-guests") {
      options.actionOptions.hasGuests = true;
      continue;
    }

    if (arg === "--inferred-update-content") {
      options.actionOptions.inferredUpdateContent = true;
      continue;
    }

    if (arg === "--reference-details-certain") {
      options.actionOptions.referenceDetailsCertain = true;
      continue;
    }

    if (arg === "--calendar-recurring") {
      options.actionOptions.calendarRecurring = true;
      continue;
    }

    if (arg === "--calendar-multiple") {
      options.actionOptions.calendarMultiple = true;
      continue;
    }

    if (arg === "--possible-duplicate") {
      options.actionOptions.possibleDuplicate = true;
      continue;
    }

    messageParts.push(arg);
  }

  options.message = messageParts.join(" ").trim();
  return options;
}

export function buildInboxClassifierDebug({ message, actionOptions = {} }) {
  const raw = String(message ?? "").trim();
  const text = normalize(raw);
  const action = classifyInboxAction(raw, actionOptions);
  const route = chooseRoute(text, action);
  const sideEffect = detectSideEffect(text, action);
  const approvalRequired = Boolean(action.approvalRequired || sideEffect.approvalRequired);
  const confidence = action.mode === "clarify" ? "low" : route.confidence;
  const hardStopPoints = collectHardStopPoints(route.agent, sideEffect);

  return {
    message: raw,
    selectedAgent: route.agent,
    confidence,
    reason: buildReason(route, action, sideEffect),
    route,
    action,
    safety: sideEffect,
    sideEffecting: sideEffect.sideEffecting,
    approvalRequired,
    hardStopPoints,
  };
}

export function formatInboxClassifierDebug(result) {
  const hardStops = result.hardStopPoints.length > 0
    ? result.hardStopPoints.map((point) => `- ${point}`).join("\n")
    : "- None detected beyond normal approval policy.";
  const executableIntent = actionHasExecutableIntent(result.action);
  const note = buildLayerNote(result, executableIntent);

  return [
    `Message: ${result.message || "(empty)"}`,
    `Likely route: ${result.selectedAgent} (confidence: ${result.confidence})`,
    "",
    "Action classifier:",
    `- Handling path: ${result.action.mode}`,
    actionIntentLine(result.action, executableIntent),
    `- Base risk: ${result.action.risk}`,
    `- Reason: ${result.action.reason}`,
    "",
    "Routing/safety overlay:",
    `- Side-effect signal: ${result.sideEffecting ? "yes" : "no"}`,
    `- Approval if executed: ${result.approvalRequired ? "required" : "not required"}`,
    `- Reason: ${result.safety.reason}`,
    `- Route reason: ${result.route.reason}`,
    ...(note ? ["", `Note: ${note}`] : []),
    "",
    "Hard stop points:",
    hardStops,
  ].join("\n");
}

function chooseRoute(text, action) {
  if (action.mode === "clarify") {
    return {
      agent: "personal",
      confidence: "low",
      reason: "Message needs clarification before routing to a specialist.",
    };
  }

  if (["feedback.capture", "feedback.send"].includes(action.intent)) {
    return {
      agent: "personal",
      confidence: "high",
      reason: "Message is explicit feedback for Hilla's local improvement log.",
    };
  }

  if (action.intent === "calendar.plan") {
    return {
      agent: "admin",
      confidence: "high",
      reason: "Message asks for read-only Calendar planning from existing context.",
    };
  }

  if (action.intent === "calendar.create") {
    return {
      agent: "admin",
      confidence: "high",
      reason: "Message asks the admin agent to validate a Calendar creation request as a preview.",
    };
  }

  for (const rule of routeRules) {
    if (rule.pattern.test(text)) {
      return {
        agent: rule.agent,
        confidence: rule.confidence,
        reason: rule.reason,
      };
    }
  }

  return {
    agent: "personal",
    confidence: "low",
    reason: "No strong specialist signal was detected.",
  };
}

function detectSideEffect(text, action) {
  if (action.mode === "approval_required") {
    return {
      sideEffecting: true,
      approvalRequired: true,
      reason: action.reason,
    };
  }

  if (action.mode === "execute_then_confirm") {
    return {
      sideEffecting: true,
      approvalRequired: false,
      reason: action.reason,
    };
  }

  if (action.mode === "clarify") {
    return {
      sideEffecting: false,
      approvalRequired: false,
      reason: "Needs clarification before Hilla should treat this as an executable side effect.",
    };
  }

  for (const rule of sideEffectRules) {
    if (rule.pattern.test(text)) {
      return {
        sideEffecting: true,
        approvalRequired: rule.approvalRequired,
        reason: rule.reason,
      };
    }
  }

  return {
    sideEffecting: false,
    approvalRequired: false,
    reason: "No mutation or external side-effect signal detected.",
  };
}

function actionHasExecutableIntent(action) {
  return ["execute_then_confirm", "approval_required"].includes(action.mode);
}

function actionIntentLine(action, executableIntent) {
  if (action.intent === "calendar.create" && action.mode === "execute_then_confirm") {
    return "- Detected action intent: policy-allowed Calendar creation preview only (no event is created).";
  }
  return `- Detected executable intent: ${executableIntent ? "yes" : "no"} (intent: ${action.intent})`;
}

function buildLayerNote(result, executableIntent) {
  if (result.action.intent === "calendar.create" && result.action.mode === "execute_then_confirm") {
    return "the classifier recognizes a policy-allowed creation preview only; this repository has no Calendar write tool and creates no event.";
  }

  if (!executableIntent && result.sideEffecting) {
    return "the base classifier did not detect an executable intent, but the safety overlay found side-effect language.";
  }

  if (executableIntent && result.sideEffecting) {
    return "the base classifier detected an executable intent; the safety overlay summarizes approval implications.";
  }

  if (result.action.mode === "clarify") {
    return "the message needs clarification before Hilla should route or execute anything.";
  }

  return "";
}

function collectHardStopPoints(agent, sideEffect) {
  const points = [...(agentHardStops[agent] ?? [])];

  if (!sideEffect.sideEffecting) {
    return points.slice(0, 2);
  }

  if (
    sideEffect.approvalRequired &&
    sideEffect.reason &&
    !points.some((point) => point.includes(sideEffect.reason))
  ) {
    points.unshift(sideEffect.reason);
  }

  return points;
}

function buildReason(route, action, sideEffect) {
  const pieces = [route.reason, `Action classifier says ${action.mode}/${action.intent}: ${action.reason}`];

  if (sideEffect.sideEffecting) {
    pieces.push(sideEffect.reason);
  }

  return pieces.join(" ");
}

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}:_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
