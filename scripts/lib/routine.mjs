/**
 * Routine briefing templates, and the check a scheduled routine's findings
 * pass before anything reaches Telegram.
 *
 * Asked for in chat, a routine is a briefing template. On its schedule
 * (`--scheduled`) nobody asked for it, and the user follows Todoist directly,
 * so it looks only for what needs their attention and hands its findings to
 * `buildRoutineNotice`. That text is what the job sends: the findings in one
 * fixed shape, or NO_REPLY, which the Gateway's cron delivery never posts.
 */
const titleByRoutine = {
  "morning-brief": "Morning Brief",
  "midday-check-in": "Midday Check-In",
  "workout-window": "Workout Window",
  "evening-review": "Evening Review",
  "weekly-review": "Weekly Review",
};

const agentByRoutine = {
  "morning-brief": "personal",
  "midday-check-in": "health",
  "workout-window": "health",
  "evening-review": "personal",
  "weekly-review": "personal",
};

// The part of the user's time a routine looks at when it hunts for what needs them.
const scopeByRoutine = {
  "morning-brief": "today",
  "midday-check-in": "the rest of today",
  "workout-window": "this evening",
  "evening-review": "tomorrow",
  "weekly-review": "the coming week and what is still open from this one",
};

const allowedWithoutApproval = [
  "summarize-configured-gmail-and-calendar",
  "read-configured-todoist-tasks",
  "read-local-memory",
  "draft-email-calendar-plan-grocery-and-health-recommendations",
  "send-check-ins",
];

const approvalRequired = [
  "email sends, deletes, archives, labels, or moves",
  "calendar changes or invite responses",
  "Todoist task changes",
  "Min Golf bookings or booking changes",
  "purchases, payments, deliveries, or browser submissions",
  "sensitive memory storage",
];

/** What may make a scheduled routine write to the user. A plan already in Todoist is none of these. */
export const ATTENTION_KINDS = Object.freeze(["decision", "change", "deadline", "approval", "conflict", "failure"]);

const NOTICE_LIMITS = Object.freeze({ items: 3, whatChanged: 300, whyItMatters: 300, decision: 240, source: 200 });

// Text that would turn a notice back into the noise it replaces: a session
// copied from a planned workout, or a question about Hilla's own messages.
const NOISE_PATTERNS = Object.freeze([
  {
    pattern: /\d\s*[×x]\s*\d|\b\d+\s*(?:reps|repetitions|repetitioner|toistoa)\b/i,
    problem: "an exercise prescription: planned sessions stay in Todoist",
  },
  {
    pattern:
      /\b(?:timing|tone|detail\w*|frequency)\b[^.?!]*\b(?:check-?ins?|reviews?|nudges?|messages?)\b|\b(?:these|future)\s+(?:check-?ins?|reviews|nudges|messages)\b|\btidpunkt,?\s+ton\b|\bdetaljniv|\b(?:dessa|framtida)\s+(?:check-?ins?|genomgångar|nudgar|meddelanden)|\b(?:näiden|tulevien)\s+(?:viestien|muistutusten|katsausten)\b/i,
    problem: "a question about Hilla's own messages: the user can ask for changes any time",
  },
]);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function routineIds(schedules) {
  return [
    ...schedules.daily.map((routine) => routine.id),
    schedules.weekly.id,
  ];
}

export function buildRoutineBrief(
  routineId,
  {
    schedules,
    food,
    memoryEntries = [],
    now = new Date().toISOString(),
    scheduled = false,
  },
) {
  if (!routineIds(schedules).includes(routineId)) {
    throw new Error(`Unknown routine: ${routineId}`);
  }

  const sections = sectionsForRoutine(routineId, { scheduled });
  const title = titleByRoutine[routineId];
  const agent = agentByRoutine[routineId];
  const memoryContext = formatMemoryContext(memoryEntries);

  return {
    routineId,
    title,
    agent,
    now,
    timezone: schedules.timezone,
    scheduled,
    sections,
    foodSections: food.groceryPlanning.sections,
    memoryContext,
    memoryRule:
      "Use memory for personalization, but ask before storing inferred memories. Sensitive memory requires Telegram approval.",
    allowedWithoutApproval,
    approvalRequired,
    telegramPrompt: buildTelegramPrompt({
      routineId,
      title,
      agent,
      sections,
      memoryContext,
      scheduled,
    }),
  };
}

/**
 * The text a scheduled routine sends: each qualifying finding as What changed,
 * Why it matters and Decision needed, with a verified deadline and a source
 * when given, or NO_REPLY when nothing qualifies. A finding that fails a check
 * is dropped with its reasons, so nothing unchecked reaches the user.
 */
export function buildRoutineNotice(routineId, findings, { schedules, now = new Date() }) {
  if (!routineIds(schedules).includes(routineId)) {
    throw new Error(`Unknown routine: ${routineId}`);
  }
  if (!findings || typeof findings !== "object" || !Array.isArray(findings.items)) {
    throw new Error('Findings must be a JSON object like {"items": []}.');
  }

  const localNow = localMinute(now, schedules.timezone);
  const included = [];
  const dropped = [];
  findings.items.forEach((raw, index) => {
    const { item, problems } = checkNoticeItem(raw, localNow);
    if (problems.length === 0 && included.length >= NOTICE_LIMITS.items) {
      problems.push(`more than ${NOTICE_LIMITS.items} items; send only the most important`);
    }
    if (problems.length > 0) dropped.push({ index, problems });
    else included.push(item);
  });

  return {
    routineId,
    text: included.length > 0 ? included.map(formatNoticeItem).join("\n\n") : "NO_REPLY",
    included: included.length,
    dropped,
  };
}

// "YYYY-MM-DD HH:mm" on the user's clock, which orders like the deadlines it is compared with.
function localMinute(now, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function checkNoticeItem(raw, localNow) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { item: null, problems: ["not an object"] };

  const text = (field) => (typeof raw[field] === "string" ? raw[field].replace(/\s+/g, " ").trim() : "");
  const item = {
    kind: raw.kind,
    whatChanged: text("whatChanged"),
    whyItMatters: text("whyItMatters"),
    decision: text("decision"),
    deadline: null,
    source: text("source"),
  };
  const problems = [];

  if (!ATTENTION_KINDS.includes(item.kind)) {
    problems.push(`kind must be ${ATTENTION_KINDS.join(", ")}: a planned task, workout, meal or recap is not news`);
  }
  for (const field of ["whatChanged", "whyItMatters", "decision"]) {
    if (!item[field]) problems.push(`${field} is missing`);
  }
  for (const field of ["whatChanged", "whyItMatters", "decision", "source"]) {
    if (item[field].length > NOTICE_LIMITS[field]) problems.push(`${field} is longer than ${NOTICE_LIMITS[field]} characters`);
  }
  if (item.kind === "change" && !item.source) problems.push("a change needs its source");

  if (raw.deadline !== undefined && raw.deadline !== null && raw.deadline !== "") {
    const deadline = parseDeadline(raw.deadline);
    if (!deadline) problems.push("deadline must be YYYY-MM-DD or YYYY-MM-DD HH:mm");
    else if (deadline.day < localNow.slice(0, 10) || (deadline.time && `${deadline.day} ${deadline.time}` <= localNow)) problems.push("the deadline has passed");
    else item.deadline = deadline;
  } else if (item.kind === "deadline") {
    problems.push("a deadline needs its verified date");
  }

  for (const { pattern, problem } of NOISE_PATTERNS) {
    if (["whatChanged", "whyItMatters", "decision", "source"].some((field) => pattern.test(item[field]))) problems.push(problem);
  }
  return { item, problems };
}

function parseDeadline(value) {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})(?: ([01]\d|2[0-3]):([0-5]\d))?$/.exec(value.trim()) : null;
  if (!match) return null;

  const [, year, month, day, hour, minute] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return { day: `${year}-${month}-${day}`, time: hour ? `${hour}:${minute}` : null, date };
}

function formatNoticeItem(item) {
  const { date, time } = item.deadline ?? {};
  const deadline = date
    ? `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}${time ? `, ${time}` : ""}`
    : null;
  return [
    `What changed: ${item.whatChanged}`,
    `Why it matters: ${item.whyItMatters}`,
    `Decision needed: ${item.decision}`,
    ...(deadline ? [`Deadline: ${deadline}`] : []),
    ...(item.source ? [`Source: ${item.source}`] : []),
  ].join("\n");
}

function sectionsForRoutine(routineId, { scheduled }) {
  // The weekly review looks only for decisions, asked for or not.
  if (scheduled || routineId === "weekly-review") return attentionSections();

  switch (routineId) {
    case "morning-brief":
      return [
        section("calendar-pressure", "Summarize today's calendar pressure: name only conflicts, deadlines, or tight transitions."),
        section("must-do-tasks", "List up to 3 must-do tasks from overdue and today context; do not pad the list."),
        section("quick-wins", "List 1-2 quick wins that reduce friction or close small open loops."),
        section("health-routine-anchor", "Choose one realistic health/routine anchor for food, movement, sleep, or recovery."),
        section("one-thing-to-avoid", "Name one thing to avoid today that would create preventable friction."),
        section("suggested-day-plan", "Give a simple suggested plan for morning, midday, and afternoon."),
        section("proposed-changes", "Propose Todoist or Calendar changes only if useful; label them as suggestions requiring a separate user action."),
      ];
    case "midday-check-in":
      return [
        section("food", "Check lunch, snack, hydration, and evening meal friction."),
        section("movement", "Suggest one realistic movement reset: named movements with repetitions or seconds."),
        section("energy", "Ask one concise energy or stress question if useful."),
        section("schedule-pressure", "Adapt the afternoon plan to calendar pressure."),
      ];
    case "workout-window":
      return [
        section(
          "day-type",
          "First classify today as training, golf/active, rest/no-workout, or unclear from calendar, memory, and recent user messages.",
        ),
        section(
          "availability",
          "For a training day, find a realistic workout or movement window from calendar pressure.",
        ),
        section(
          "workout",
          "For a training day, suggest one primary workout and one lighter fallback, each with named exercises, sets × reps or time, rest and total minutes.",
        ),
        section(
          "golf-active",
          "For a golf/active day, avoid pushing a gym workout; suggest a specific warm-up or mobility routine (named movements with hold times or repetitions), recovery, fueling, or hydration support.",
        ),
        section(
          "rest-day",
          "If today is rest/no-workout day, send a soft recovery check-in or offer to skip today's workout-window routine instead of disabling future days.",
        ),
        section(
          "unclear",
          "If the day type is unclear, ask one concise question instead of assuming.",
        ),
        section("friction", "Reduce setup friction with a concrete next action."),
      ];
    case "evening-review":
      return [
        section("today", "Briefly reflect on tasks, food, workout, and energy."),
        section("tomorrow", "Preview tomorrow's calendar and obvious prep."),
        section("admin-actions", "List pending drafts or approvals."),
        section("meal-prep", "Name any simple meal prep or grocery needs."),
        section("memory-suggestions", "Suggest useful memories to store, but do not store inferred memories without asking."),
      ];
    default:
      throw new Error(`Unknown routine: ${routineId}`);
  }
}

// One section per attention kind, then what never counts as news.
function attentionSections() {
  return [
    section("decision", "A meaningful decision the user has not made yet."),
    section("change", "A new outside development, such as an email, a Calendar change or published news, that changes an existing plan."),
    section("deadline", "A deadline that needs a choice, not just doing a task already planned in Todoist."),
    section("approval", "An approval or essential missing information the user still owes; npm run --silent pending lists what Hilla is waiting for."),
    section("conflict", "A real scheduling conflict or an unforeseen blocker."),
    section("failure", "A connection Hilla relies on that stopped working and needs the user to fix it, such as an expired sign-in; not a source that was merely unavailable this time."),
    section(
      "not-news",
      "Leave out what is already planned in Todoist or the weekly plan (tasks, workouts, stretching, meals, prep, shopping), exercise lists, start times, water or kit tips, motivation, recaps, generic priorities, and alerts the stock watch, renewal watch or weekly plan already sent.",
    ),
  ];
}

function section(id, instruction) {
  return { id, instruction };
}

function formatMemoryContext(memoryEntries) {
  const usableEntries = memoryEntries.filter((entry) => entry.sensitivity !== "sensitive");

  if (usableEntries.length === 0) {
    return ["No stored preferences yet."];
  }

  return usableEntries
    .map((entry) => `${entry.category}/${entry.key}: ${entry.value}`)
    .toSorted();
}

function buildTelegramPrompt({ routineId, title, agent, sections, memoryContext, scheduled }) {
  const sectionLines = sections.map((entry) => `- ${entry.id}: ${entry.instruction}`).join("\n");
  const memoryLines = memoryContext.map((entry) => `- ${entry}`).join("\n");
  const attention = scheduled || routineId === "weekly-review";
  const routineLines = scheduled
    ? scheduledRules(routineId)
    : routineId === "weekly-review"
      ? [
        "",
        "Weekly review rules:",
        `- Keep this short enough for Telegram: at most ${NOTICE_LIMITS.items} items, each as What changed, Why it matters and Decision needed, with a Deadline or Source when known. If nothing qualifies, say so in one line.`,
        "- Use configured Calendar, Gmail, Todoist, routine, health, food, and memory context only as read-only inputs.",
        "- Proposed actions only: if you suggest Todoist or Calendar changes, phrase them as proposed actions requiring confirmation.",
        "- Do not modify Todoist, Calendar, Gmail, memory, or routines from the weekly review.",
      ]
      : routineId === "morning-brief"
        ? [
          "",
          "Morning brief rules:",
          "- Keep this short enough for Telegram: seven compact sections, with no motivational filler.",
          "- Use configured Calendar, Gmail, Todoist, food, health, and memory context only as read-only inputs.",
          "- Proposed Todoist or Calendar changes only if useful: state them as suggestions, and require a separate explicit user action before any change.",
          "- Do not modify Todoist, Calendar, Gmail, memory, or routines from the morning brief.",
          "- Do not send email, edit Calendar events, book anything, make purchases, or submit browser forms from the morning brief.",
        ]
        : [];
  const closingLines = scheduled
    ? []
    : [
      "",
      "Keep the Telegram reply concise, practical, and non-shaming.",
      "Draft or recommend freely; ask for approval before side effects.",
    ];

  return [
    `${title} (${agent})${scheduled ? ", scheduled" : ""}`,
    "",
    "Use memory:",
    memoryLines,
    "",
    attention ? `Look at ${scopeByRoutine[routineId]} for:` : "Cover:",
    sectionLines,
    ...routineLines,
    ...closingLines,
  ].join("\n");
}

function scheduledRules(routineId) {
  const submit = `npm run --silent routine -- ${routineId} --scheduled --findings-json-stdin`;
  return [
    "",
    "Scheduled rules:",
    "- Nobody asked for this message. The user follows Todoist directly, so write only about what needs their attention, and never make up a decision to have something to send.",
    "- News about something that also has a Todoist task is still news: say what changed, never what the task says.",
    `- Submit at most ${NOTICE_LIMITS.items} findings that qualify to ${submit} through a quoted heredoc, and return its text exactly as your final answer. With nothing to report submit {"items": []}; the text is then NO_REPLY.`,
    `- Each finding: {"kind": "${ATTENTION_KINDS.join("|")}", "whatChanged": "...", "whyItMatters": "...", "decision": "the choice, check or approval needed", "deadline": "YYYY-MM-DD or YYYY-MM-DD HH:mm, only when verified", "source": "where you read it; a change needs one"}.`,
    "- No greeting, advice, encouragement, exercise list or closing question, and never ask about timing, tone or detail level.",
    "- Read-only: do not modify Todoist, Calendar, Gmail, memory, or routines, and ask for approval before any side effect.",
  ];
}
