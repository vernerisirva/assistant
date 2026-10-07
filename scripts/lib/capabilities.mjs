/**
 * What Hilla can do: the one authoritative capability registry.
 *
 * Help answers ("What can you do?", "What can you do with Todoist?", "What
 * needs my approval?") come from this list, never from the model's memory or
 * from prose in the standing orders. A capability that is not listed here as
 * available must not be claimed. A new capability adds its entry here, and
 * tests/capabilities.test.mjs pins the entries whose loss would matter.
 *
 * Each entry has one side-effect profile. When the same area has actions with
 * different boundaries, such as creating a Todoist task and deleting one, they
 * are separate entries:
 *
 * - effect: what it changes. `none` reads, advises, or messages you;
 *   `local` changes only Hilla's own records or schedule; `external` changes
 *   your data in another service (Todoist, Min Golf).
 * - approval: `none` (nothing to approve), `on_request` (done when you ask,
 *   with no second OK), `required` (only after you approve the exact action),
 *   or `standing` (runs under a standing authorization you granted).
 * - automatic: runs on its own, on a schedule, without a message from you.
 * - status: `available`; `not_available`, a boundary people often assume,
 *   shown as "Not supported" with an alternative; or `disabled`, which exists
 *   somewhere but is not a product capability and shows only in the developer
 *   view.
 * - partOf: the entry describes one part of another entry in more detail,
 *   such as the weekly plan's golf week. It shares that entry's side-effect
 *   profile and live jobs, and the footers count the whole only once.
 *
 * Two small overlays are cheap and deterministic: whether an integration is
 * configured in .env, and which scheduled jobs the live scheduler has switched
 * on. Neither is a health check: configured is not the same as working.
 */
import { todoistTokenStatus } from "./todoist.mjs";
import { routineJobName } from "./routine-cron.mjs";
import { WEEKLY_PLAN_APPLY_JOB, WEEKLY_PLAN_PROPOSE_JOB } from "./weekly-plan-cron.mjs";

export const CAPABILITY_CATEGORIES = Object.freeze([
  { id: "planning", title: "Planning & focus" },
  { id: "pending", title: "Pending" },
  { id: "coaching", title: "Coaching" },
  { id: "memory", title: "Memory & playbooks" },
  { id: "todoist", title: "Todoist" },
  { id: "calendar", title: "Calendar" },
  { id: "email", title: "Email" },
  { id: "golf", title: "Golf tee times" },
  { id: "health", title: "Food & training" },
  { id: "research", title: "Research" },
  { id: "weekly-plan", title: "Weekly plan" },
  { id: "routines", title: "Check-ins & routines" },
  { id: "system", title: "Status & controls" },
]);

/** Topics that cut across categories. A category id also works as a topic. */
export const CAPABILITY_TAGS = Object.freeze([
  { id: "golf", title: "Golf" },
  { id: "work", title: "Work" },
  { id: "focus", title: "Focus" },
  { id: "sleep", title: "Sleep" },
  { id: "food", title: "Food" },
  { id: "fitness", title: "Training" },
  { id: "health", title: "Health" },
  { id: "planning", title: "Planning" },
  { id: "todoist", title: "Todoist" },
  { id: "calendar", title: "Calendar" },
  { id: "coaching", title: "Coaching" },
]);

export const CAPABILITY_STATUSES = Object.freeze(["available", "not_available", "disabled"]);
export const CAPABILITY_EFFECTS = Object.freeze(["none", "local", "external"]);
export const CAPABILITY_APPROVALS = Object.freeze(["none", "on_request", "required", "standing"]);

/** Configuration an entry needs. "configured" means set up, never "working". */
export const CAPABILITY_SETUP = Object.freeze({
  todoist: { title: "Todoist", configured: (env) => todoistTokenStatus(env).configured },
  google: { title: "Google Calendar and Gmail", configured: (env) => Boolean(String(env.GMAIL_ACCOUNT ?? "").trim()) },
});

/** Every configured routine check-in, in config/schedules.json order. */
export const CHECK_IN_ROUTINES = Object.freeze([
  { routineId: "morning-brief", label: "morning brief" },
  { routineId: "midday-check-in", label: "midday check-in" },
  { routineId: "workout-window", label: "workout window" },
  { routineId: "evening-review", label: "evening review" },
  { routineId: "weekly-review", label: "Sunday weekly review" },
]);

const available = (entry) => ({ status: "available", automatic: false, tags: [], ...entry });
const unsupported = (entry) => ({ status: "not_available", automatic: false, effect: "none", approval: "none", examples: [], tags: [], ...entry });

export const CAPABILITIES = Object.freeze(
  [
    available({
      id: "planning.next-action",
      category: "planning",
      title: "What to do now",
      summary: "one next step that fits the time you have.",
      limit: "Advice only: it never creates, completes or moves tasks.",
      examples: ["I have 45 minutes. What should I do?", "What should I work on now?"],
      tags: ["focus", "work", "todoist", "calendar"],
      effect: "none",
      approval: "none",
    }),
    available({
      id: "planning.focus-session",
      category: "planning",
      title: "Focus sessions",
      summary: "a work block with a clear outcome, and help when you're stuck.",
      limit: "No timers or reminders. It keeps a short note of the block, deleted when you say done.",
      examples: ["Start a 45-minute focus session on my thesis", "I'm stuck", "Done"],
      tags: ["focus", "work"],
      effect: "local",
      approval: "on_request",
    }),
    available({
      id: "planning.project-focus",
      category: "planning",
      title: "Project focus",
      summary: "keep my suggestions on one project for now.",
      limit: "Not saved unless you ask me to remember it.",
      examples: ["I'm working on my thesis", "Switch to thesis mode"],
      tags: ["focus", "work"],
      effect: "none",
      approval: "none",
    }),
    available({
      id: "planning.decision",
      category: "planning",
      title: "Think a decision through",
      summary: "options, constraints and what's hard to undo; you decide.",
      examples: ["Help me think through this decision"],
      tags: ["work"],
      effect: "none",
      approval: "none",
    }),
    available({
      id: "pending.view",
      category: "pending",
      title: "What's waiting on you",
      summary: "a weekly plan awaiting review, or a running focus session.",
      limit: "Read-only, built from what's stored.",
      examples: ["Anything waiting on me?", "What do I need to approve?"],
      tags: ["planning"],
      effect: "none",
      approval: "none",
    }),
    available({
      id: "coaching.performance",
      category: "coaching",
      title: "Performance coaching",
      summary: "golf and work: resets, round or presentation prep, staying present.",
      limit: "Conversation only, and only when you ask: it never creates tasks, reminders or events.",
      examples: ["Coach me before my round", "I just made a double bogey", "Help me prepare for my presentation"],
      tags: ["golf", "work", "focus"],
      effect: "none",
      approval: "none",
    }),
    available({
      id: "coaching.sleep",
      category: "coaching",
      title: "Sleep and recovery coaching",
      summary: "a small plan for tonight and a steady wake time.",
      limit: "Habit coaching, not medical advice.",
      examples: ["Sleep coach", "Help me wind down tonight"],
      tags: ["sleep", "health"],
      effect: "none",
      approval: "none",
    }),
    available({
      id: "coaching.debrief",
      category: "coaching",
      title: "Debriefs",
      summary: "review a round or work session: keep, adjust, one lesson.",
      limit: "The lesson is saved only if you say yes.",
      examples: ["Debrief my round", "Debrief this focus session"],
      tags: ["golf", "work"],
      effect: "none",
      approval: "none",
    }),
    available({
      id: "memory.preferences",
      category: "memory",
      title: "Remember things",
      summary: "remember, show or forget preferences you ask me to keep.",
      limit: "Only when you ask. If I notice something worth keeping, I ask first.",
      examples: ["Remember that I prefer short messages", "What do you remember about me?", "Forget that"],
      effect: "local",
      approval: "on_request",
    }),
    available({
      id: "memory.sensitive",
      category: "memory",
      title: "Remember private details",
      summary: "health or other sensitive details you want kept.",
      limit: "I show you the exact wording first and store it only after your yes.",
      examples: ["Remember that my knee hurts after running"],
      tags: ["health"],
      effect: "local",
      approval: "required",
    }),
    available({
      id: "memory.playbooks",
      category: "memory",
      title: "Personal playbooks",
      summary: "your own routines, like a bad-shot reset, used first when I coach.",
      limit: "Saved or changed only when you ask or say yes. They never create tasks, events or reminders.",
      examples: ["Save that as my bad-shot reset", "Use my pre-round routine", "Show my playbooks"],
      tags: ["coaching", "golf", "work", "sleep"],
      effect: "local",
      approval: "on_request",
    }),
    available({
      id: "todoist.read",
      category: "todoist",
      title: "Check your tasks",
      summary: "what's due, overdue or in a project.",
      examples: ["What's due today?", "What's overdue?"],
      tags: ["planning"],
      requires: "todoist",
      effect: "none",
      approval: "none",
    }),
    available({
      id: "todoist.create",
      category: "todoist",
      title: "Add tasks",
      summary: "from clear text, in a project or section you name; ‘remind me to…’ too.",
      limit: "I check for duplicates first; if one might exist, nothing is created and I ask.",
      examples: ["Add ‘Buy dog food’ for tomorrow", "Remind me to call dad tomorrow", "Add ‘Ask about pricing’ to my Work project"],
      requires: "todoist",
      effect: "external",
      approval: "on_request",
    }),
    available({
      id: "todoist.update",
      category: "todoist",
      title: "Change one task",
      summary: "rename, tidy, comment on, reschedule, label or complete it.",
      limit: "One exact task at a time. If more than one could match, I ask which.",
      examples: ["Change ‘Call dad’ to Friday", "Mark ‘Buy oats’ done", "Add a comment to ‘Prepare slides’: check the budget first"],
      requires: "todoist",
      effect: "external",
      approval: "on_request",
    }),
    available({
      id: "todoist.delete",
      category: "todoist",
      title: "Delete or reopen a task",
      summary: "one exact task at a time.",
      examples: ["Delete ‘Old errand’"],
      requires: "todoist",
      effect: "external",
      approval: "required",
    }),
    unsupported({
      id: "todoist.bulk",
      category: "todoist",
      title: "Bulk task changes or moves between projects",
      alternative: "I can change one task at a time.",
    }),
    available({
      id: "calendar.read",
      category: "calendar",
      title: "Read your schedule",
      summary: "how busy a day or week is, and good windows for focus or workouts.",
      limit: "Suggestions only: I never change your calendar.",
      examples: ["How busy is my afternoon?", "Where can I fit a workout this week?"],
      tags: ["planning", "fitness"],
      requires: "google",
      effect: "none",
      approval: "none",
    }),
    available({
      id: "calendar.preview",
      category: "calendar",
      title: "Preview a new event",
      summary: "check one new event's details. Creating it isn't currently supported.",
      limit: "One personal event on your main calendar, without guests or repeats.",
      examples: ["Preview an event: Gym, Friday 17:30, one hour"],
      effect: "none",
      approval: "none",
    }),
    unsupported({
      id: "calendar.write",
      category: "calendar",
      title: "Create or change Calendar events",
      alternative: "I can preview a new event or suggest a change for you to make.",
    }),
    available({
      id: "email.summary",
      category: "email",
      title: "Email summaries and drafts",
      summary: "what's important, and replies drafted for you to send.",
      limit: "I don't send, archive, label or delete email.",
      examples: ["Anything important in my email?", "Draft a reply to Anna saying I'll be late"],
      requires: "google",
      effect: "none",
      approval: "none",
    }),
    unsupported({
      id: "email.send",
      category: "email",
      title: "Send, archive or delete email",
      alternative: "I can draft the reply for you to send.",
    }),
    available({
      id: "golf.tee-times",
      category: "golf",
      title: "Find tee times",
      summary: "search Min Golf by club, date, time and players.",
      limit: "You log in to Min Golf yourself; I never ask for your Golf-ID, password or BankID.",
      examples: ["Find a tee time at Stockholms GK on Saturday morning for two"],
      tags: ["golf"],
      effect: "none",
      approval: "none",
    }),
    available({
      id: "golf.booking",
      category: "golf",
      title: "Book a tee time",
      summary: "I draft the exact booking for your OK, then try it if no payment is needed.",
      limit: "You log in yourself. I stop before any payment, BankID, redirect or changed terms.",
      examples: ["Book the 09:40 at Stockholms GK for two"],
      tags: ["golf"],
      effect: "external",
      approval: "required",
    }),
    unsupported({
      id: "golf.payment",
      category: "golf",
      title: "Pay for, cancel or check in to a booking",
      alternative: "I stop before payment; you finish it in Min Golf.",
      tags: ["golf"],
    }),
    {
      id: "golf.weather",
      category: "golf",
      title: "Golf weather alerts",
      status: "disabled",
      automatic: false,
      effect: "none",
      approval: "none",
      examples: [],
      tags: ["golf"],
      alternative: "I can look up the forecast when you ask.",
      note: "The weather jobs in the scheduler are switched off, and the script they call is not on main.",
    },
    available({
      id: "health.food",
      category: "health",
      title: "Meals and groceries",
      summary: "a day's eating plan, simple meals, grocery lists, craving help.",
      limit: "Suggestions only; I don't order or buy anything.",
      examples: ["What should I eat today?", "Make me a grocery list for the week"],
      tags: ["food", "health"],
      effect: "none",
      approval: "none",
    }),
    available({
      id: "health.training",
      category: "health",
      title: "Workouts and movement",
      summary: "workout and movement ideas that fit your day.",
      limit: "Suggestions only; nothing goes in Todoist or your calendar unless you ask.",
      examples: ["Give me a 30-minute workout"],
      tags: ["fitness", "health"],
      effect: "none",
      approval: "none",
    }),
    available({
      id: "research.lookup",
      category: "research",
      title: "Research and comparisons",
      summary: "current facts and side-by-side comparisons, with sources.",
      limit: "I don't book, buy or sign in anywhere.",
      examples: ["Compare these two running shoes", "Is the outdoor pool open this weekend?"],
      effect: "none",
      approval: "none",
    }),
    unsupported({
      id: "research.purchases",
      category: "research",
      title: "Buy or order things online",
      alternative: "I can compare options and prepare the details.",
      tags: ["food"],
    }),
    available({
      id: "weekly-plan.plan",
      category: "weekly-plan",
      title: "Weekly plan",
      summary: "every Saturday I ask about your golf week, then propose next week's food, gym, stretching and golf; unless you cancel, its Todoist tasks are added 12 hours after you last saw it.",
      limit:
        "Say OK to add them right away, or ask for a change, which restarts the 12 hours. You can also ask for a plan on another day. It only adds new tasks of your own: nothing is edited or deleted, and Calendar and email are never touched.",
      examples: ["Change next week's plan to three gym sessions", "Plan my next week", "Skip this week"],
      tags: ["planning", "food", "fitness", "golf", "todoist"],
      requires: "todoist",
      automatic: true,
      effect: "external",
      approval: "standing",
      schedule: {
        mode: "all",
        jobs: [
          { job: WEEKLY_PLAN_PROPOSE_JOB, label: "the Saturday proposal" },
          { job: WEEKLY_PLAN_APPLY_JOB, label: "the automatic apply check" },
        ],
      },
    }),
    available({
      id: "weekly-plan.golf",
      category: "weekly-plan",
      title: "Golf training week",
      summary:
        "part of the weekly plan: I ask which days you're playing (9 or 18 holes), your 1–2 focus areas and any competition or lesson, then plan six golf days and a rest day toward competitive golf.",
      limit:
        "Playing days, competitions and technique come only from you, never guessed. Each golf day gets one Todoist task with a full session plan, added 12 hours after you see the plan unless you change or cancel it; OK adds them now.",
      examples: ["Plan my golf week", "Move wedges to Thursday", "Saturday is now a competition"],
      tags: ["golf", "planning", "fitness", "todoist"],
      requires: "todoist",
      automatic: true,
      partOf: "weekly-plan.plan",
      effect: "external",
      approval: "standing",
      schedule: {
        mode: "all",
        jobs: [
          { job: WEEKLY_PLAN_PROPOSE_JOB, label: "the Saturday proposal" },
          { job: WEEKLY_PLAN_APPLY_JOB, label: "the automatic apply check" },
        ],
      },
    }),
    available({
      id: "routines.briefings",
      category: "routines",
      title: "Briefings",
      summary: "any check-in whenever you ask, such as a morning brief or weekly review.",
      limit: "They suggest changes but make none.",
      examples: ["Give me my morning brief", "Evening review"],
      tags: ["planning", "health", "fitness"],
      effect: "none",
      approval: "none",
    }),
    available({
      id: "routines.check-ins",
      category: "routines",
      title: "Scheduled check-ins",
      summary: "check-in messages at set times; they change nothing.",
      examples: ["Which check-ins are on?"],
      tags: ["planning", "health", "fitness"],
      automatic: true,
      effect: "none",
      approval: "none",
      schedule: {
        mode: "each",
        jobs: CHECK_IN_ROUTINES.map(({ routineId, label }) => ({ job: routineJobName(routineId), label })),
      },
    }),
    available({
      id: "routines.controls",
      category: "routines",
      title: "Change a check-in",
      summary: "turn a scheduled check-in on or off, or change its time.",
      examples: ["Turn off the workout window", "Move the midday check-in to 13:15"],
      effect: "local",
      approval: "on_request",
    }),
    available({
      id: "routines.skip",
      category: "routines",
      title: "Skip a check-in for a day",
      summary: "skip one check-in on one date, or undo the skip.",
      examples: ["Skip the workout window tomorrow"],
      effect: "local",
      approval: "required",
    }),
    unsupported({
      id: "coaching.scheduled",
      category: "coaching",
      title: "Unprompted or scheduled coaching",
      alternative: "I coach whenever you ask.",
    }),
    available({
      id: "system.status",
      category: "system",
      title: "Assistant status",
      summary: "whether I'm running, and what ran or failed recently.",
      examples: ["Are you running?", "Why did you message me?", "What failed recently?"],
      effect: "none",
      approval: "none",
    }),
    available({
      id: "system.schedule",
      category: "system",
      title: "Scheduled messages",
      summary: "every automatic message and reminder, and whether I'm too noisy.",
      examples: ["What automatic messages do you send?", "Are you too noisy?"],
      effect: "none",
      approval: "none",
    }),
    available({
      id: "system.schedule-change",
      category: "system",
      title: "Pause or move a scheduled message",
      summary: "turn one off or on, change its time, or move a reminder.",
      examples: ["Move the gym card reminder to Friday at 09:00"],
      effect: "local",
      approval: "required",
    }),
    available({
      id: "system.feedback",
      category: "system",
      title: "Feedback",
      summary: "tell me something was useful or annoying, or suggest an improvement.",
      limit: "Only your words go in a private local log, and it's never sent anywhere.",
      examples: ["That was useful", "Feedback: the morning brief is too long"],
      effect: "local",
      approval: "on_request",
    }),
  ].map((entry) => Object.freeze(entry)),
);

/** Tried first in the "Try:" line of the full list. */
export const TRY_FIRST = Object.freeze(["planning.next-action", "coaching.performance", "pending.view"]);

/**
 * The entries a view shows. Filters combine: `--tag golf --requires-approval`
 * is the golf actions that need an OK. A topic or category view keeps its
 * "not supported" boundaries; the automatic, approval, and read-only views list
 * only what Hilla does. Disabled entries appear only with `all`.
 */
export function selectCapabilities(filters = {}, registry = CAPABILITIES) {
  const boundaryView = filters.automatic || filters.requiresApproval || filters.readOnly;
  const matches = (entry) =>
    (!filters.category || entry.category === filters.category) &&
    (!filters.tag || entry.category === filters.tag || entry.tags.includes(filters.tag)) &&
    (!filters.automatic || entry.automatic) &&
    (!filters.requiresApproval || entry.approval === "required") &&
    (!filters.readOnly || entry.effect === "none");

  return sortCapabilities(
    registry.filter((entry) => {
      if (entry.status === "disabled" && !filters.all) return false;
      if (entry.status !== "available" && boundaryView) return false;
      return matches(entry);
    }),
    registry,
  );
}

export function capabilityById(id, registry = CAPABILITIES) {
  return registry.find((entry) => entry.id === id);
}

/** Category order first, then registry order, so every view is stable. */
export function sortCapabilities(entries, registry = CAPABILITIES) {
  const categoryIndex = (entry) => CAPABILITY_CATEGORIES.findIndex((category) => category.id === entry.category);
  const registryIndex = (entry) => registry.indexOf(entry);
  return [...entries].sort((left, right) => categoryIndex(left) - categoryIndex(right) || registryIndex(left) - registryIndex(right));
}

/** Which integrations are set up in the environment. Nothing is contacted. */
export function capabilitySetup(env = {}) {
  return Object.fromEntries(
    Object.entries(CAPABILITY_SETUP).map(([id, check]) => [id, check.configured(env) ? "configured" : "missing"]),
  );
}

/** Whether a view needs the live scheduler: only when it shows a scheduled entry. */
export function needsScheduleOverlay(entries) {
  return entries.some((entry) => entry.status === "available" && entry.schedule);
}

/**
 * What the live scheduler has switched on, per scheduled entry. `snapshot` is
 * `loadLiveCronSnapshot` output, or null when the scheduler was not read. A
 * scheduler that could not be read is reported as unchecked, never as off.
 * Jobs are matched by their exact name, and only their enabled flag is used.
 */
export function scheduleOverlay(entries, snapshot) {
  const overlay = {};
  for (const entry of entries) {
    if (entry.status !== "available" || !entry.schedule) continue;
    const { mode } = entry.schedule;
    if (!snapshot?.available || !Array.isArray(snapshot.jobs)) {
      overlay[entry.id] = { mode, state: "unchecked", jobs: [] };
      continue;
    }

    const schedulerOff = snapshot.scheduler?.enabled === false;
    const jobs = entry.schedule.jobs.map(({ job, label }) => {
      const live = snapshot.jobs.filter((candidate) => candidate?.name === job);
      const state = live.length === 0 ? "missing" : !schedulerOff && live.some((candidate) => candidate.enabled === true) ? "on" : "off";
      return { label, state };
    });
    const onCount = jobs.filter((job) => job.state === "on").length;
    const missingCount = jobs.filter((job) => job.state === "missing").length;
    overlay[entry.id] = {
      mode,
      state: onCount === jobs.length ? "on" : missingCount === jobs.length ? "missing" : onCount === 0 ? "off" : "partly_on",
      jobs,
      ...(schedulerOff ? { schedulerOff: true } : {}),
    };
  }
  return overlay;
}

/**
 * The view as data: the selected entries with their overlays, plus what the
 * footer says. Only registry text and overlay states appear, never job names
 * or ids, env values, or anything read from stored state.
 */
export function buildCapabilityView({ filters = {}, setup = {}, schedule = {}, registry = CAPABILITIES } = {}) {
  const normalized = normalizeFilters(filters);
  const entries = selectCapabilities(normalized, registry);
  // A part is described by its whole in the footers, so it is never counted twice.
  const availableEntries = registry.filter((entry) => entry.status === "available" && !entry.partOf);
  const titles = (list) => list.map((entry) => lowerFirst(entry.title));

  return {
    title: viewTitle(normalized),
    filters: normalized,
    capabilities: entries.map((entry) => ({
      id: entry.id,
      category: entry.category,
      title: entry.title,
      status: entry.status,
      summary: entry.summary ?? null,
      limit: entry.limit ?? null,
      alternative: entry.alternative ?? null,
      examples: [...entry.examples],
      tags: [...entry.tags],
      automatic: entry.automatic,
      effect: entry.effect,
      approval: entry.approval,
      requires: entry.requires ?? null,
      setup: entry.requires ? (setup[entry.requires] ?? "unchecked") : null,
      schedule: entry.status === "available" && entry.schedule ? (schedule[entry.id] ?? { mode: entry.schedule.mode, state: "unchecked", jobs: [] }) : null,
      ...(normalized.all && entry.note ? { note: entry.note } : {}),
    })),
    footer: {
      tryExamples: TRY_FIRST.map((id) => registry.find((entry) => entry.id === id))
        .filter((entry) => entry?.status === "available" && entry.examples.length > 0)
        .map((entry) => entry.examples[0]),
      direct: titles(availableEntries.filter((entry) => entry.approval === "on_request" && entry.effect !== "none")),
      standing: titles(availableEntries.filter((entry) => entry.approval === "standing")),
      automaticWriters: titles(availableEntries.filter((entry) => entry.automatic && entry.effect !== "none")),
    },
  };
}

function normalizeFilters(filters) {
  return {
    category: filters.category ?? null,
    tag: filters.tag ?? null,
    automatic: Boolean(filters.automatic),
    requiresApproval: Boolean(filters.requiresApproval),
    readOnly: Boolean(filters.readOnly),
    all: Boolean(filters.all),
  };
}

function viewTitle(filters) {
  if (filters.automatic) return "What I do automatically";
  if (filters.requiresApproval) return "What needs your OK first";
  if (filters.readOnly) return "What only reads or advises";
  if (filters.category) return `${titleOf(CAPABILITY_CATEGORIES, filters.category)}: what I can do`;
  if (filters.tag) return `${topicTitle(filters.tag)}: what I can do`;
  return filters.all ? "Hilla capabilities, including unavailable ones" : "Here's what I can do";
}

/** Every topic a view can use: the tags and categories of available entries. */
export function capabilityTopics(registry = CAPABILITIES) {
  const used = new Set();
  for (const entry of registry) {
    if (entry.status !== "available") continue;
    used.add(entry.category);
    for (const tag of entry.tags) used.add(tag);
  }
  return [...used].sort();
}

function topicTitle(topic) {
  return CAPABILITY_TAGS.find((tag) => tag.id === topic)?.title ?? titleOf(CAPABILITY_CATEGORIES, topic);
}

function titleOf(list, id) {
  return list.find((entry) => entry.id === id)?.title ?? id;
}

/**
 * Telegram-ready text built from the view, without a model. The full list is
 * one line per capability; a narrowed view adds each limit and an example.
 */
export function formatCapabilityView(view) {
  const { filters } = view;
  const narrowed = Boolean(filters.category || filters.tag || filters.automatic || filters.requiresApproval || filters.readOnly);
  const detailed = narrowed || filters.all;
  const lines = [view.title, ""];

  if (view.capabilities.length === 0) {
    lines.push("Nothing I can do matches that. Ask “What can you do?” to see everything.");
    return lines.join("\n");
  }

  // The full list keeps to one Telegram message: its boundaries share one line.
  const inline = (entry) => detailed || entry.status === "available";
  for (const category of CAPABILITY_CATEGORIES) {
    const entries = view.capabilities.filter((entry) => entry.category === category.id && inline(entry));
    if (entries.length === 0) continue;
    lines.push(category.title, ...entries.flatMap((entry) => entryLines(entry, { detailed, filters })), "");
  }

  const boundaries = view.capabilities.filter((entry) => !inline(entry)).map((entry) => lowerFirst(entry.title));
  if (boundaries.length > 0) {
    lines.push(`Not supported directly: ${boundaries.join("; ")}. Ask and I'll say what I can do instead.`, "");
  }

  lines.push(...footerLines(view, { narrowed }));
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

function entryLines(entry, { detailed, filters }) {
  if (entry.status !== "available") {
    const lines = [`- ${entry.status === "disabled" ? "Disabled" : "Not supported"}: ${lowerFirst(entry.title)}. ${entry.alternative}`];
    if (entry.note) lines.push(`  ${entry.note}`);
    return lines;
  }

  // A view of only approval-gated or only automatic entries needs no label.
  const label =
    entry.approval === "required" && !filters.requiresApproval ? " (needs your OK)" : entry.automatic && !filters.automatic ? " (automatic)" : "";
  const notes = [
    entry.setup === "missing" ? `Needs ${CAPABILITY_SETUP[entry.requires]?.title ?? entry.requires}, which isn't set up here.` : null,
    entry.schedule ? describeSchedule(entry.schedule) : null,
  ].filter(Boolean);
  if (!detailed) return [`- ${entry.title}${label} — ${[entry.summary, ...notes].join(" ")}`];

  const lines = [`- ${entry.title}${label} — ${entry.summary}`];
  const detail = [entry.limit, ...notes].filter(Boolean).join(" ");
  if (detail) lines.push(`  ${detail}`);
  if (entry.examples.length > 0) lines.push(`  Try: ${entry.examples.slice(0, 2).map(quote).join(" · ")}`);
  return lines;
}

/** What the live scheduler has switched on, in one sentence. */
export function describeSchedule(schedule) {
  if (schedule.state === "unchecked") return "I couldn't check what's switched on right now.";
  if (schedule.schedulerOff) return "The scheduler is switched off, so none of this runs right now.";

  const labelsWith = (state) => schedule.jobs.filter((job) => job.state === state).map((job) => job.label);
  const on = labelsWith("on");
  const off = labelsWith("off");
  const missing = labelsWith("missing");

  // One feature made of several jobs: a job that was never installed is "not
  // set up", which is not the same as one that was switched off.
  if (schedule.mode === "all") {
    if (schedule.state === "on") return "Switched on.";
    if (schedule.state === "missing") return "Not set up here.";
    if (on.length === 0 && missing.length === 0) return "Switched off right now.";
    const parts = [
      off.length > 0 ? `${joinWords(off)} ${off.length === 1 ? "is" : "are"} off` : null,
      missing.length > 0 ? `${joinWords(missing)} ${missing.length === 1 ? "isn't" : "aren't"} set up` : null,
    ].filter(Boolean);
    return `${on.length === 0 ? "Not running right now" : "Only partly on right now"}: ${parts.join(", and ")}.`;
  }

  return [
    on.length > 0 ? `On now: ${joinWords(on)}.` : "None are on right now.",
    off.length > 0 ? `Off: ${joinWords(off)}.` : null,
    missing.length > 0 ? `Not set up: ${joinWords(missing)}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function footerLines({ filters, footer }, { narrowed }) {
  if (filters.automatic) {
    return [
      footer.automaticWriters.length > 0
        ? `Only the ${joinWords(footer.automaticWriters)} can change anything on its own. Everything else waits for you to ask.`
        : "None of these change anything; they only message you.",
    ];
  }
  if (filters.requiresApproval) {
    return [
      "For these I show you the exact action, what it changes and the risk, and act only after a clear yes.",
      ...(footer.direct.length > 0 ? [`Done when you ask, with no second OK: ${joinWords(footer.direct)}.`] : []),
      ...(footer.standing.length > 0
        ? [`The ${joinWords(footer.standing)} runs under the standing permission you gave it: it applies after its review window unless you cancel.`]
        : []),
    ];
  }
  if (narrowed) return [];
  return [
    ...(footer.tryExamples.length > 0 ? [`Try: ${footer.tryExamples.map(quote).join(" · ")}`] : []),
    "Ask “What can you do with golf?”, “What can you do automatically?” or “What needs my approval?” for more.",
  ];
}

function quote(text) {
  return `“${text}”`;
}

function lowerFirst(text) {
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

function joinWords(words) {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
