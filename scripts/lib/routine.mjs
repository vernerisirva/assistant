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
  },
) {
  if (!routineIds(schedules).includes(routineId)) {
    throw new Error(`Unknown routine: ${routineId}`);
  }

  const sections = sectionsForRoutine(routineId);
  const title = titleByRoutine[routineId];
  const agent = agentByRoutine[routineId];
  const memoryContext = formatMemoryContext(memoryEntries);

  return {
    routineId,
    title,
    agent,
    now,
    timezone: schedules.timezone,
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
    }),
  };
}

function sectionsForRoutine(routineId) {
  switch (routineId) {
    case "morning-brief":
      return [
        section("calendar", "Summarize today's calendar and schedule pressure."),
        section("todoist", "Summarize overdue and today Todoist tasks."),
        section("priorities", "Name the top 1-3 priorities for the day."),
        section("meal-plan", "Draft breakfast, lunch, dinner, snack, and backup options."),
        section("workout-anchor", "Pick a realistic workout or movement anchor."),
      ];
    case "midday-check-in":
      return [
        section("food", "Check lunch, snack, hydration, and evening meal friction."),
        section("movement", "Suggest a realistic movement reset."),
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
          "For a training day, suggest one primary workout and one lighter fallback.",
        ),
        section(
          "golf-active",
          "For a golf/active day, avoid pushing a gym workout; suggest warm-up, mobility, recovery, fueling, or hydration support.",
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
    case "weekly-review":
      return [
        section("week-recap", "Summarize 1-2 important things that happened this week, including wins or friction."),
        section("unfinished-tasks", "List 1-2 unfinished Todoist/admin threads that deserve attention next week."),
        section("calendar-pressure", "Flag 1-2 upcoming Calendar pressure points, travel buffers, deadlines, or crowded days."),
        section("health-routines", "Summarize 1-2 health or routine consistency patterns, including workouts, golf, sleep, food, and groceries."),
        section("important-decisions", "Name 1-2 decisions the user should make instead of leaving open."),
        section("top-3-priorities", "Choose the top 3 priorities for next week across admin, health, relationships, and personal work."),
        section("stop-or-simplify", "Choose one thing to stop doing, simplify, defer, or make easier next week."),
      ];
    default:
      throw new Error(`Unknown routine: ${routineId}`);
  }
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

function buildTelegramPrompt({ routineId, title, agent, sections, memoryContext }) {
  const sectionLines = sections.map((entry) => `- ${entry.id}: ${entry.instruction}`).join("\n");
  const memoryLines = memoryContext.map((entry) => `- ${entry}`).join("\n");
  const weeklyLines = routineId === "weekly-review"
    ? [
      "",
      "Weekly review rules:",
      "- Keep this short enough for Telegram: use compact bullets, not a long essay.",
      "- Use configured Calendar, Gmail, Todoist, routine, health, food, and memory context only as read-only inputs.",
      "- Proposed actions only: if you suggest Todoist or Calendar changes, phrase them as proposed actions requiring confirmation.",
      "- Do not modify Todoist, Calendar, Gmail, memory, or routines from the weekly review.",
      "- End with the top 3 priorities and one thing to stop doing or simplify.",
    ]
    : [];

  return [
    `${title} (${agent})`,
    "",
    "Use memory:",
    memoryLines,
    "",
    "Cover:",
    sectionLines,
    ...weeklyLines,
    "",
    "Keep the Telegram reply concise, practical, and non-shaming.",
    "Draft or recommend freely; ask for approval before side effects.",
  ].join("\n");
}
