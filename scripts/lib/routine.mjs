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
        section("availability", "Find a realistic workout or movement window."),
        section("workout", "Suggest one primary workout and one lighter fallback."),
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
        section("calendar", "Review the week ahead and pressure points."),
        section("food-plan", "Plan simple repeatable meals for the week."),
        section("grocery-plan", "Draft groceries grouped by store section."),
        section("workouts", "Place realistic workout anchors."),
        section("admin-friction", "Identify open admin loops."),
        section("one-adjustment", "Choose one small adjustment for next week."),
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

function buildTelegramPrompt({ title, agent, sections, memoryContext }) {
  const sectionLines = sections.map((entry) => `- ${entry.id}: ${entry.instruction}`).join("\n");
  const memoryLines = memoryContext.map((entry) => `- ${entry}`).join("\n");

  return [
    `${title} (${agent})`,
    "",
    "Use memory:",
    memoryLines,
    "",
    "Cover:",
    sectionLines,
    "",
    "Keep the Telegram reply concise, practical, and non-shaming.",
    "Draft or recommend freely; ask for approval before side effects.",
  ].join("\n");
}
