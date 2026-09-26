/**
 * Deterministic weekly planning for Hilla.
 *
 * The model gathers context (Calendar load, preferences, questions) and hands
 * it over as structured input. Everything after that is plain code: which day
 * each activity lands on, the food plan, the shopping list and the exact
 * Todoist payloads. A revision re-runs the same code over the stored inputs
 * plus the user's structured changes, so the plan the user sees is always the
 * plan that gets stored, and applying it never needs the model again.
 */
import { createHash } from "node:crypto";
import { isApprovalMessage, normalizeApprovalText } from "./approval-language.mjs";
import { buildTodoistCreatePlan } from "./todoist-create.mjs";
import { localDateInTimeZone } from "./routine-skips.mjs";

export const WEEKLY_PLAN_TIMEZONE = "Europe/Stockholm";
export const DEFAULT_REVIEW_WINDOW_HOURS = 12;
export const DEFAULT_APPLY_CHECK_MINUTES = 15;

/** Display order for targets and messages. */
export const TARGET_KEYS = Object.freeze(["gym", "golfRound", "golfPractice", "stretch", "mealPrep"]);
/** The least flexible activities are placed first. */
const PLACEMENT_ORDER = Object.freeze(["golfRound", "gym", "golfPractice", "mealPrep", "stretch"]);
/** Order of activities inside one day and of operations inside one date. */
const DAY_ORDER = Object.freeze(["shopping", "mealPrep", "gym", "golfPractice", "golfRound", "stretch"]);
const DEMANDING = new Set(["gym", "golfRound", "golfPractice", "mealPrep"]);
const WEEKDAYS = Object.freeze(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
const MONTHS = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
const WEEKDAY_ALIASES = Object.freeze({
  mon: "monday",
  tue: "tuesday",
  tues: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  fri: "friday",
  sat: "saturday",
  sun: "sunday",
});
const TARGET_LABELS = Object.freeze({
  gym: "Gym",
  golfRound: "Golf",
  golfPractice: "Practice",
  stretch: "Stretch",
  mealPrep: "Meal prep",
});
const SCHEDULE_LABELS = Object.freeze({
  shopping: "Shop",
  mealPrep: "Meal prep",
  gym: "Gym",
  golfPractice: "Golf practice",
  golfRound: "Golf round",
  stretch: "Stretch",
});
const DAY_LOADS = new Set(["light", "normal", "heavy", "unavailable"]);
const SECTION_LABELS = Object.freeze({
  protein: "Protein",
  vegetables: "Vegetables",
  fruit: "Fruit",
  carbs: "Carbs",
  "dairy-or-alternatives": "Dairy",
  snacks: "Snacks",
  breakfast: "Breakfast",
  pantry: "Pantry",
  "backup-meals": "Backup meals",
  other: "Other",
});

// ---------------------------------------------------------------------------
// Dates. Plan days are plain YYYY-MM-DD strings; arithmetic happens in UTC so a
// DST change can never shift a calendar day.

export function addDays(date, days) {
  assertIsoDate(date);
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Monday ... 6 = Sunday. */
export function weekdayIndex(date) {
  assertIsoDate(date);
  return (new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7;
}

export function weekdayName(date) {
  return capitalize(WEEKDAYS[weekdayIndex(date)]);
}

/** The Monday of the week after the one containing `now`, in the plan timezone. */
export function nextWeekStart(now = new Date(), timezone = WEEKLY_PLAN_TIMEZONE) {
  const today = localDateInTimeZone(now, timezone);
  return addDays(today, 7 - weekdayIndex(today));
}

export function isoWeekId(monday) {
  assertIsoDate(monday);
  const thursday = addDays(monday, 3 - weekdayIndex(monday));
  const year = Number(thursday.slice(0, 4));
  const ordinal = Math.round((Date.parse(`${thursday}T00:00:00.000Z`) - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
  const week = Math.floor((ordinal - 1) / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function weekDates(weekStart) {
  if (weekdayIndex(weekStart) !== 0) throw new Error(`Weekly plan must start on a Monday: ${weekStart}`);
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
}

/** Accepts a weekday name ("friday", "Fri") or a YYYY-MM-DD date inside the plan week. */
export function resolvePlanDay(ref, weekStart) {
  const value = String(ref ?? "").trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (!weekDates(weekStart).includes(value)) {
      throw new Error(`${value} is not part of the plan week starting ${weekStart}.`);
    }
    return value;
  }

  const name = WEEKDAY_ALIASES[value] ?? value;
  const index = WEEKDAYS.indexOf(name);
  if (index < 0) throw new Error(`Unknown day: ${ref}. Use a weekday name or a YYYY-MM-DD date.`);
  return addDays(weekStart, index);
}

/**
 * Exactly `hours` elapsed after display, then rounded up to the next apply
 * check. Elapsed time, not wall-clock time, so a DST night can never shorten
 * the review window; rounding up means the stated time is when the task
 * creation really happens. Stockholm offsets are whole hours, so rounding in
 * UTC lands on the same local quarter hour.
 */
export function computeReviewDeadline(
  displayedAt,
  { hours = DEFAULT_REVIEW_WINDOW_HOURS, roundMinutes = DEFAULT_APPLY_CHECK_MINUTES } = {},
) {
  const displayedMs = Date.parse(displayedAt);
  if (!Number.isFinite(displayedMs)) throw new Error(`Invalid display time: ${displayedAt}`);
  const step = roundMinutes * 60_000;
  return new Date(Math.ceil((displayedMs + hours * 3_600_000) / step) * step).toISOString();
}

/** "21:00 on Saturday 26 Sep" in the plan timezone. */
export function formatLocalDateTime(iso, timezone = WEEKLY_PLAN_TIMEZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.hour}:${parts.minute} on ${parts.weekday} ${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]}`;
}

export function formatWeekLabel(weekStart) {
  const end = addDays(weekStart, 6);
  return `${shortDate(weekStart)}–${shortDate(end)}`;
}

function shortDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
}

// ---------------------------------------------------------------------------
// Inputs.

/**
 * Builds the stored planner inputs for a new proposal. Targets come from the
 * agent when it supplied them, then from the previous plan, then from config,
 * so a normal week needs no questions at all.
 */
export function buildInitialPlanInputs(rawInput = {}, { config, weekStart, previousTargets } = {}) {
  const input = requireObject(rawInput ?? {}, "Weekly plan input");
  rejectUnknownKeys(input, [
    "weekStart",
    "targets",
    "days",
    "preferences",
    "food",
    "existingTasks",
    "golfPracticeFocus",
    "question",
    "notes",
  ], "weekly plan input");

  const start = input.weekStart ?? weekStart;
  weekDates(start);

  const targets = { ...config.defaultTargets, ...(previousTargets ?? {}) };
  for (const [key, value] of Object.entries(input.targets ?? {})) {
    targets[requireTargetKey(key)] = requireTargetCount(value, key, config);
  }
  for (const key of TARGET_KEYS) targets[key] = requireTargetCount(targets[key] ?? 0, key, config);

  return {
    weekStart: start,
    targets,
    days: normalizeDayLoads(input.days ?? {}, start),
    skipDays: [],
    preferences: normalizePreferences(input.preferences ?? {}, start, config),
    pins: [],
    existing: normalizeExistingTasks(input.existingTasks ?? [], start),
    food: normalizeFoodInput(input.food ?? {}),
    golfPracticeFocus: normalizeTextList(input.golfPracticeFocus, "golfPracticeFocus", { max: 5 }),
    question: normalizeOptionalText(input.question, "question", 280),
    notes: normalizeTextList(input.notes, "notes", { max: 5 }),
  };
}

function normalizeDayLoads(days, weekStart) {
  requireObject(days, "days");
  const result = {};
  for (const [ref, value] of Object.entries(days)) {
    const date = resolvePlanDay(ref, weekStart);
    const entry = typeof value === "string" ? { load: value } : requireObject(value, `days.${ref}`);
    rejectUnknownKeys(entry, ["load", "note"], `days.${ref}`);
    const load = String(entry.load ?? "normal").toLowerCase();
    if (!DAY_LOADS.has(load)) throw new Error(`Unknown day load for ${ref}: ${entry.load}`);
    result[date] = { load, ...(entry.note ? { note: normalizeOptionalText(entry.note, "day note", 120) } : {}) };
  }
  return result;
}

function normalizePreferences(preferences, weekStart, config) {
  requireObject(preferences, "preferences");
  const result = {};
  for (const key of TARGET_KEYS) {
    const fromConfig = config.preferences?.[key] ?? {};
    const supplied = preferences[key] === undefined ? null : requireObject(preferences[key], `preferences.${key}`);
    if (supplied) rejectUnknownKeys(supplied, ["preferredDays", "avoidDays"], `preferences.${key}`);
    result[key] = {
      preferredDays: (supplied?.preferredDays ?? fromConfig.preferredDays ?? []).map((ref) => resolvePlanDay(ref, weekStart)),
      avoidDays: (supplied?.avoidDays ?? fromConfig.avoidDays ?? []).map((ref) => resolvePlanDay(ref, weekStart)),
    };
  }
  for (const key of Object.keys(preferences)) requireTargetKey(key);
  return result;
}

const EXISTING_PATTERNS = [
  ["shopping", /^(grocery shopping|groceries|grocery|food shopping|shopping list|buy groceries)\b/],
  ["mealPrep", /^meal ?prep\b/],
  ["golfRound", /^(golf round|golf: ?round|play golf|18 holes|9 holes)\b/],
  ["golfPractice", /^(golf practice|golf training|driving range|range session|short game|putting practice|chipping practice)\b/],
  ["gym", /^(gym|strength|workout|weights|lifting)\b/],
  ["stretch", /^(stretch|stretching|mobility|yoga)\b/],
  ["golfPractice", /^golf\b/],
];

/**
 * Conservative: only a title that starts with the activity counts, so "Buy a
 * new gym card" is not mistaken for a gym session. Unrecognized tasks are
 * ignored rather than guessed.
 */
export function classifyExistingTask(title) {
  const normalized = String(title ?? "")
    .toLowerCase()
    .replace(/[—–]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [activity, pattern] of EXISTING_PATTERNS) {
    if (pattern.test(normalized)) return activity;
  }
  return null;
}

/** Accepts raw Todoist tasks or `{ title, date }` pairs; keeps open, classified tasks due in the week. */
export function normalizeExistingTasks(tasks, weekStart) {
  if (!Array.isArray(tasks)) throw new Error("existingTasks must be a list.");
  const dates = new Set(weekDates(weekStart));
  const result = [];
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    if (task.checked === true || task.is_completed === true || task.completed_at) continue;
    const title = String(task.title ?? task.content ?? "").trim();
    const date = String(task.date ?? task.due?.date ?? "").slice(0, 10);
    if (!title || !dates.has(date)) continue;
    const activity = classifyExistingTask(title);
    if (!activity) continue;
    result.push({ activity, date, title: title.slice(0, 120) });
  }
  return result.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

function normalizeFoodInput(food) {
  requireObject(food, "food");
  rejectUnknownKeys(food, ["mealIds", "customMeals", "excludeIngredients", "addMeals", "addShopping"], "food");
  return {
    mealIds: normalizeTextList(food.mealIds, "food.mealIds", { max: 7 }),
    customMeals: (food.customMeals ?? []).map(normalizeCustomMeal),
    excludeIngredients: normalizeTextList(food.excludeIngredients, "food.excludeIngredients", { max: 20 }).map((term) => term.toLowerCase()),
    addedMeals: (food.addMeals ?? []).map(normalizeMealRef),
    removedMealIds: [],
    extraShopping: (food.addShopping ?? []).map(normalizeShoppingItem),
    removedShopping: [],
  };
}

function normalizeMealRef(ref) {
  if (typeof ref === "string") return normalizeOptionalText(ref, "meal id", 60);
  return normalizeCustomMeal(ref);
}

function normalizeCustomMeal(meal) {
  requireObject(meal, "custom meal");
  rejectUnknownKeys(meal, ["id", "name", "portions", "ingredients"], "custom meal");
  const name = normalizeOptionalText(meal.name, "custom meal name", 80);
  if (!name) throw new Error("A custom meal needs a name.");
  const portions = meal.portions === undefined ? 2 : Number(meal.portions);
  if (!Number.isInteger(portions) || portions < 1 || portions > 8) {
    throw new Error("Custom meal portions must be an integer from 1 to 8.");
  }
  if (!Array.isArray(meal.ingredients) || meal.ingredients.length === 0) {
    throw new Error(`Custom meal "${name}" needs at least one ingredient.`);
  }
  if (meal.ingredients.length > 15) {
    throw new Error(`Custom meal "${name}" has ${meal.ingredients.length} ingredients; the limit is 15.`);
  }
  return {
    id: meal.id ? normalizeOptionalText(meal.id, "custom meal id", 60) : `custom-${slug(name)}`,
    name,
    portions,
    ingredients: meal.ingredients.map(normalizeShoppingItem),
  };
}

function normalizeShoppingItem(item) {
  const value = typeof item === "string" ? { name: item } : requireObject(item, "shopping item");
  rejectUnknownKeys(value, ["name", "section", "quantity"], "shopping item");
  const name = normalizeOptionalText(value.name, "shopping item name", 60);
  if (!name) throw new Error("A shopping item needs a name.");
  const section = String(value.section ?? "other").toLowerCase();
  return {
    name: capitalize(name),
    section: SECTION_LABELS[section] ? section : "other",
    ...(value.quantity ? { quantity: normalizeOptionalText(value.quantity, "shopping quantity", 30) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Planning.

/**
 * @returns the complete plan for one version: targets, day-by-day schedule,
 *   food, shopping list and the exact Todoist operations to create.
 */
export function buildWeeklyPlan(inputs, { config, food: foodConfig }) {
  const dates = weekDates(inputs.weekStart);
  const notes = [...inputs.notes];
  const placements = schedulePlacements({ dates, inputs, notes });
  const mealPrepDates = placements.filter((entry) => entry.activity === "mealPrep").map((entry) => entry.date).sort();
  const foodPlan = planFood({ inputs, mealPrepDates, foodConfig, notes });
  const shopping = planShopping({ inputs, foodPlan, foodConfig });
  const existingShopping = inputs.existing.find((entry) => entry.activity === "shopping");
  const shoppingDate = shopping.itemCount > 0 ? pickShoppingDate({ dates, inputs, mealPrepDates }) : null;
  shopping.date = shoppingDate;
  if (shoppingDate && existingShopping) {
    notes.push(`A grocery task is already in Todoist (${existingShopping.title}), so no new one is added.`);
  }

  const schedule = dates.map((date) => ({
    date,
    weekday: weekdayName(date),
    activities: [
      ...inputs.existing
        .filter((entry) => entry.date === date)
        .map((entry) => ({ activity: entry.activity, status: "existing", title: entry.title })),
      ...placements
        .filter((entry) => entry.date === date)
        .map((entry) => ({ activity: entry.activity, status: "new" })),
      ...(shoppingDate === date && !existingShopping ? [{ activity: "shopping", status: "new" }] : []),
    ].sort((a, b) => DAY_ORDER.indexOf(a.activity) - DAY_ORDER.indexOf(b.activity)),
  }));

  const operations = buildOperations({
    inputs,
    config,
    placements,
    foodPlan,
    shopping,
    createShoppingTask: Boolean(shoppingDate && !existingShopping),
  });

  return {
    weekStart: inputs.weekStart,
    weekEnd: dates[6],
    targets: { ...inputs.targets },
    placements,
    schedule,
    food: foodPlan,
    shopping,
    operations,
    notes,
    question: inputs.question,
  };
}

function schedulePlacements({ dates, inputs, notes }) {
  const occupancy = new Map(dates.map((date) => [date, new Set()]));
  for (const entry of inputs.existing) {
    if (entry.activity !== "shopping") occupancy.get(entry.date)?.add(entry.activity);
  }
  const placements = [];
  const skip = new Set(inputs.skipDays);

  const blocked = (activity, date, { explicit = false } = {}) => {
    if (!occupancy.has(date) || skip.has(date) || occupancy.get(date).has(activity)) return true;
    if (explicit) return false;
    if (inputs.days[date]?.load === "unavailable") return true;
    return inputs.preferences[activity]?.avoidDays.includes(date) ?? false;
  };
  const place = (activity, date, explicit) => {
    occupancy.get(date).add(activity);
    placements.push({ activity, date, ...(explicit ? { explicit: true } : {}) });
  };

  for (const activity of PLACEMENT_ORDER) {
    const target = inputs.targets[activity];
    const existingCount = inputs.existing.filter((entry) => entry.activity === activity).length;
    let need = Math.max(0, target - existingCount);

    const pins = inputs.pins
      .filter((pin) => pin.activity === activity)
      .sort((a, b) => Number(Boolean(b.explicit)) - Number(Boolean(a.explicit)) || a.date.localeCompare(b.date));
    for (const pin of pins) {
      if (need === 0) break;
      if (blocked(activity, pin.date, { explicit: pin.explicit })) continue;
      place(activity, pin.date, pin.explicit);
      need -= 1;
    }

    while (need > 0) {
      const candidates = dates
        .filter((date) => !blocked(activity, date))
        .map((date) => ({
          date,
          cost: placementCost(activity, date, { dates, inputs, occupancy }),
          preferenceRank: rankOf(inputs.preferences[activity]?.preferredDays ?? [], date),
        }))
        .filter((candidate) => Number.isFinite(candidate.cost))
        .sort(
          (a, b) =>
            a.cost - b.cost ||
            a.preferenceRank - b.preferenceRank ||
            weekdayIndex(a.date) - weekdayIndex(b.date),
        );
      if (candidates.length === 0) {
        const placed = target - existingCount - need;
        notes.push(`Only room for ${placed + existingCount} of ${target} ${SCHEDULE_LABELS[activity].toLowerCase()} sessions.`);
        break;
      }
      place(activity, candidates[0].date, false);
      need -= 1;
    }
  }

  return placements.sort(
    (a, b) => a.date.localeCompare(b.date) || DAY_ORDER.indexOf(a.activity) - DAY_ORDER.indexOf(b.activity),
  );
}

function placementCost(activity, date, { dates, inputs, occupancy }) {
  const index = weekdayIndex(date);
  const on = (offset, type) => occupancy.get(addDays(date, offset))?.has(type) ?? false;
  const activitiesToday = occupancy.get(date).size;
  const sameTypeGaps = dates
    .filter((other) => other !== date && occupancy.get(other).has(activity))
    .map((other) => Math.abs(weekdayIndex(other) - index));
  const load = inputs.days[date]?.load ?? "normal";
  let cost = 0.5 * activitiesToday;

  if (load === "heavy") cost += DEMANDING.has(activity) ? 6 : 2;
  if (load === "light" && DEMANDING.has(activity)) cost -= 1;
  if (inputs.preferences[activity]?.preferredDays.includes(date)) cost -= 4;

  switch (activity) {
    case "golfRound":
      if (on(0, "gym")) cost += 8;
      break;
    case "gym":
      if (on(0, "golfRound")) cost += 8;
      if (on(-1, "golfRound") || on(1, "golfRound")) cost += 3;
      if (on(0, "golfPractice")) cost += 2;
      for (const gap of sameTypeGaps) cost += gap === 1 ? 5 : gap === 2 ? 1 : 0;
      break;
    case "golfPractice":
      if (on(0, "golfRound")) cost += 6;
      if (on(0, "gym")) cost += 2;
      for (const gap of sameTypeGaps) cost += gap === 1 ? 1 : 0;
      break;
    case "mealPrep": {
      if (on(0, "gym")) cost += 2;
      if (on(0, "golfRound")) cost += 2;
      for (const gap of sameTypeGaps) cost += gap < 2 ? 6 : gap === 2 ? 1 : 0;
      // Spread sessions evenly with the first one early in the week.
      const ideal = Math.round((sameTypeGaps.length * 7) / Math.max(1, inputs.targets.mealPrep));
      cost += 0.75 * Math.abs(index - ideal);
      break;
    }
    case "stretch":
      if (on(-1, "gym") || on(-1, "golfRound")) cost -= 1;
      if (activitiesToday >= 2) cost += 1;
      for (const gap of sameTypeGaps) cost += gap === 1 ? 2 : 0;
      break;
    default:
      break;
  }

  return cost;
}

function pickShoppingDate({ dates, inputs, mealPrepDates }) {
  if (mealPrepDates.length > 0) return mealPrepDates[0];
  const skip = new Set(inputs.skipDays);
  return dates.find((date) => !skip.has(date) && inputs.days[date]?.load !== "unavailable") ?? dates[0];
}

function planFood({ inputs, mealPrepDates, foodConfig, notes }) {
  const catalog = foodConfig.weeklyMealPlan;
  const excluded = inputs.food.excludeIngredients;
  const removed = new Set(inputs.food.removedMealIds);
  const allMeals = knownMeals(catalog, inputs.food);
  const byId = new Map(allMeals.map((meal) => [meal.id, meal]));
  const orderedIds = [...new Set([...inputs.food.mealIds, ...catalog.meals.map((meal) => meal.id)])];
  const usable = orderedIds
    .map((id) => byId.get(id))
    .filter((meal) => meal && !removed.has(meal.id) && !mealIsExcluded(meal, excluded));

  const prep = mealPrepDates.map((date, index) => {
    const meal = usable[index];
    if (!meal) return { date, mealId: null, name: null, portions: 0 };
    return { date, mealId: meal.id, name: meal.name, portions: meal.portions ?? catalog.portionsPerPrep };
  });
  if (prep.some((session) => !session.mealId)) {
    notes.push("Not enough meals left after your changes; one meal-prep session is your choice.");
  }

  const usedIds = new Set(prep.map((session) => session.mealId).filter(Boolean));
  const extras = [];
  for (const ref of inputs.food.addedMeals) {
    const meal = typeof ref === "string" ? byId.get(ref) ?? findMealByTerm(allMeals, ref) : ref;
    if (!meal) throw new Error(`Unknown meal: ${ref}. Use a meal id or pass a custom meal with ingredients.`);
    if (removed.has(meal.id) || mealIsExcluded(meal, excluded) || usedIds.has(meal.id)) continue;
    usedIds.add(meal.id);
    extras.push({ mealId: meal.id, name: meal.name, portions: meal.portions ?? 2 });
  }

  const options = (list) => list.filter((option) => !option.items.some((item) => itemIsExcluded(item, excluded)));
  return {
    prep,
    extras,
    breakfast: options(catalog.breakfast).map((option) => option.label),
    snacks: options(catalog.snacks).map((option) => option.label),
    backup: options(catalog.backup)[0]?.label ?? null,
  };
}

/** Catalog meals plus every custom meal the user supplied, inline or up front. */
function knownMeals(catalog, food) {
  const custom = [...food.customMeals, ...food.addedMeals.filter((meal) => typeof meal === "object")];
  return [...catalog.meals, ...custom];
}

function findMealByTerm(meals, term) {
  const wanted = String(term).toLowerCase();
  return meals.find((meal) => meal.name.toLowerCase().includes(wanted) || meal.id.includes(wanted)) ?? null;
}

function mealIsExcluded(meal, excluded) {
  if (excluded.length === 0) return false;
  const name = meal.name.toLowerCase();
  return excluded.some((term) => name.includes(term)) || meal.ingredients.some((item) => itemIsExcluded(item, excluded));
}

function itemIsExcluded(item, excluded) {
  const name = String(item.name).toLowerCase();
  return excluded.some((term) => name.includes(term));
}

function planShopping({ inputs, foodPlan, foodConfig }) {
  const catalog = foodConfig.weeklyMealPlan;
  const byId = new Map(knownMeals(catalog, inputs.food).map((meal) => [meal.id, meal]));
  const excluded = inputs.food.excludeIngredients;
  const entries = [];

  for (const session of [...foodPlan.prep, ...foodPlan.extras]) {
    const meal = byId.get(session.mealId);
    if (!meal) continue;
    for (const item of meal.ingredients) entries.push(scaledItem(item, session.portions));
  }
  const chosen = (list, labels) => list.filter((option) => labels.includes(option.label));
  for (const option of [
    ...chosen(catalog.breakfast, foodPlan.breakfast),
    ...chosen(catalog.snacks, foodPlan.snacks),
    ...chosen(catalog.backup, foodPlan.backup ? [foodPlan.backup] : []),
  ]) {
    entries.push(...option.items.map((item) => scaledItem(item, 1)));
  }

  const removedNames = inputs.food.removedShopping.map((name) => name.toLowerCase());
  const kept = entries
    .filter((item) => !itemIsExcluded(item, excluded))
    .concat(inputs.food.extraShopping.map((item) => scaledItem(item, 1)))
    .filter((item) => !removedNames.some((term) => item.name.toLowerCase().includes(term)));

  const aggregated = new Map();
  for (const item of kept) {
    const key = item.name.toLowerCase();
    const current = aggregated.get(key) ?? { name: item.name, section: item.section, amounts: {}, quantities: [] };
    if (item.amount) current.amounts[item.unit] = (current.amounts[item.unit] ?? 0) + item.amount;
    if (item.quantity && !current.quantities.includes(item.quantity)) current.quantities.push(item.quantity);
    aggregated.set(key, current);
  }

  const sectionOrder = [...foodConfig.groceryPlanning.sections, "other"];
  const sections = sectionOrder
    .map((section) => ({
      id: section,
      label: SECTION_LABELS[section] ?? capitalize(section),
      items: [...aggregated.values()]
        .filter((item) => (sectionOrder.includes(item.section) ? item.section : "other") === section)
        .map((item) => ({ name: item.name, quantity: describeQuantity(item) })),
    }))
    .filter((section) => section.items.length > 0);

  return { date: null, sections, itemCount: aggregated.size };
}

function scaledItem(item, portions) {
  if (item.perPortion) {
    return { name: item.name, section: item.section, amount: item.perPortion * portions, unit: item.unit ?? "g" };
  }
  return { name: item.name, section: item.section, ...(item.quantity ? { quantity: item.quantity } : {}) };
}

function describeQuantity(item) {
  const parts = [
    ...Object.entries(item.amounts).map(([unit, amount]) => `${amount} ${unit}`),
    ...item.quantities,
  ];
  return parts.length > 0 ? parts.join(" + ") : null;
}

function buildOperations({ inputs, config, placements, foodPlan, shopping, createShoppingTask }) {
  const activities = config.activities;
  const operations = [];
  const counters = { gym: 0, stretch: 0 };
  const hasOn = (date, activity) =>
    placements.some((entry) => entry.date === date && entry.activity === activity) ||
    inputs.existing.some((entry) => entry.date === date && entry.activity === activity);

  const add = (activity, date, content, description) => {
    const plan = buildTodoistCreatePlan({ content, description, dueString: date });
    operations.push({
      opId: `${activity}:${date}`,
      kind: "create-task",
      activity,
      date,
      payload: plan.payload,
    });
  };

  if (createShoppingTask) {
    add("shopping", shopping.date, config.shoppingTaskTitle, formatShoppingDescription(shopping, foodPlan));
  }

  for (const entry of placements) {
    const { activity, date } = entry;
    const title = `${activities[activity].label} — ${weekdayName(date)}`;
    switch (activity) {
      case "gym": {
        const sessions = activities.gym.sessions;
        const lines = [sessions[counters.gym % sessions.length]];
        counters.gym += 1;
        if (hasOn(addDays(date, 1), "golfRound")) lines.push(activities.gym.beforeGolfRoundNote);
        add(activity, date, title, lines.join("\n"));
        break;
      }
      case "golfRound":
        add(activity, date, title, activities.golfRound.description);
        break;
      case "golfPractice": {
        const focus = inputs.golfPracticeFocus.length > 0 ? inputs.golfPracticeFocus : activities.golfPractice.focus;
        add(activity, date, title, `${activities.golfPractice.description}\nFocus: ${focus.join(", ")}.`);
        break;
      }
      case "stretch": {
        const routines = activities.stretch.routines;
        const routine = routines[counters.stretch % routines.length];
        counters.stretch += 1;
        add(activity, date, title, [`${activities.stretch.minutes} min mobility:`, ...routine.map((line) => `- ${line}`)].join("\n"));
        break;
      }
      case "mealPrep": {
        const session = foodPlan.prep.find((candidate) => candidate.date === date);
        const lines = [
          session?.mealId
            ? `Cook: ${session.name}, ${session.portions} portions.`
            : "Cook a simple high-protein meal of your choice.",
          "Portion into containers.",
        ];
        if (createShoppingTask && shopping.date === date) lines.push("Do the grocery shopping first.");
        add(activity, date, title, lines.join("\n"));
        break;
      }
      default:
        break;
    }
  }

  return operations.sort(
    (a, b) => a.date.localeCompare(b.date) || DAY_ORDER.indexOf(a.activity) - DAY_ORDER.indexOf(b.activity),
  );
}

function formatShoppingDescription(shopping, foodPlan) {
  const blocks = shopping.sections.map((section) =>
    [
      `${section.label}:`,
      ...section.items.map((item) => `- ${item.name}${item.quantity ? ` (${item.quantity})` : ""}`),
    ].join("\n"),
  );
  const meals = [...foodPlan.prep, ...foodPlan.extras].filter((session) => session.mealId);
  if (meals.length > 0) {
    blocks.push(["For:", ...meals.map((session) => `- ${session.name} x${session.portions}`)].join("\n"));
  }
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Revisions.

const CHANGE_KEYS = Object.freeze([
  "targets",
  "moves",
  "skipDays",
  "unskipDays",
  "dayLoads",
  "excludeIngredients",
  "allowIngredients",
  "addMeals",
  "removeMeals",
  "addShopping",
  "removeShopping",
  "note",
]);

/**
 * Applies one structured modification to the stored inputs of the current
 * version. Placements that the change does not touch stay pinned, so "gym 3
 * times" adds a session instead of reshuffling the week.
 */
export function applyWeeklyPlanChanges(previousInputs, previousPlan, rawChanges, { config, food } = {}) {
  const changes = requireObject(rawChanges ?? {}, "Weekly plan changes");
  rejectUnknownKeys(changes, CHANGE_KEYS, "weekly plan changes");
  const substantive = Object.keys(changes).filter((key) => key !== "note");
  if (substantive.length === 0) throw new Error("A weekly plan revision needs at least one change.");

  const inputs = structuredClone(previousInputs);
  const weekStart = inputs.weekStart;
  const summary = [];
  let pins = previousPlan.placements.map((entry) => ({ ...entry }));

  for (const [key, value] of Object.entries(changes.targets ?? {})) {
    const activity = requireTargetKey(key);
    const next = requireTargetCount(value, key, config);
    const before = inputs.targets[activity];
    if (next === before) continue;
    inputs.targets[activity] = next;
    summary.push(`${TARGET_LABELS[activity]} ${before} → ${next}`);
    if (next < before) {
      const existingCount = inputs.existing.filter((entry) => entry.activity === activity).length;
      const keep = pins
        .filter((pin) => pin.activity === activity)
        .sort((a, b) => Number(Boolean(b.explicit)) - Number(Boolean(a.explicit)) || a.date.localeCompare(b.date))
        .slice(0, Math.max(0, next - existingCount));
      pins = pins.filter((pin) => pin.activity !== activity || keep.includes(pin));
    }
  }

  for (const move of changes.moves ?? []) {
    requireObject(move, "move");
    rejectUnknownKeys(move, ["activity", "from", "to"], "move");
    const activity = requireTargetKey(move.activity);
    const from = resolvePlanDay(move.from, weekStart);
    const to = resolvePlanDay(move.to, weekStart);
    const pin = pins.find((candidate) => candidate.activity === activity && candidate.date === from);
    if (!pin) {
      const existing = inputs.existing.find((entry) => entry.activity === activity && entry.date === from);
      throw new Error(
        existing
          ? `The ${SCHEDULE_LABELS[activity].toLowerCase()} on ${weekdayName(from)} is an existing Todoist task; the weekly plan does not move existing tasks.`
          : `There is no planned ${SCHEDULE_LABELS[activity].toLowerCase()} on ${weekdayName(from)} to move.`,
      );
    }
    if (pins.some((candidate) => candidate !== pin && candidate.activity === activity && candidate.date === to) ||
        inputs.existing.some((entry) => entry.activity === activity && entry.date === to)) {
      throw new Error(`${weekdayName(to)} already has ${SCHEDULE_LABELS[activity].toLowerCase()}.`);
    }
    pin.date = to;
    pin.explicit = true;
    inputs.skipDays = inputs.skipDays.filter((date) => date !== to);
    summary.push(`${SCHEDULE_LABELS[activity]} ${shortWeekday(from)} → ${shortWeekday(to)}`);
  }

  for (const ref of changes.skipDays ?? []) {
    const date = resolvePlanDay(ref, weekStart);
    if (!inputs.skipDays.includes(date)) inputs.skipDays.push(date);
    pins = pins.filter((pin) => pin.date !== date);
    summary.push(`Nothing new on ${shortWeekday(date)}`);
  }
  for (const ref of changes.unskipDays ?? []) {
    const date = resolvePlanDay(ref, weekStart);
    inputs.skipDays = inputs.skipDays.filter((candidate) => candidate !== date);
    summary.push(`${shortWeekday(date)} available again`);
  }
  inputs.skipDays.sort();

  if (changes.dayLoads !== undefined) {
    const loads = normalizeDayLoads(changes.dayLoads, weekStart);
    for (const [date, entry] of Object.entries(loads)) {
      inputs.days[date] = entry;
      if (entry.load === "unavailable") pins = pins.filter((pin) => pin.date !== date || pin.explicit);
      summary.push(`${shortWeekday(date)}: ${entry.load}`);
    }
  }

  for (const term of normalizeTextList(changes.excludeIngredients, "excludeIngredients", { max: 20 })) {
    const lower = term.toLowerCase();
    if (!inputs.food.excludeIngredients.includes(lower)) inputs.food.excludeIngredients.push(lower);
    summary.push(`No ${lower}`);
  }
  for (const term of normalizeTextList(changes.allowIngredients, "allowIngredients", { max: 20 })) {
    const lower = term.toLowerCase();
    inputs.food.excludeIngredients = inputs.food.excludeIngredients.filter((candidate) => candidate !== lower);
    summary.push(`${capitalize(lower)} allowed again`);
  }
  const mealName = (id) =>
    [...(food?.weeklyMealPlan?.meals ?? []), ...inputs.food.customMeals].find((meal) => meal.id === id)?.name ?? id;
  for (const ref of changes.addMeals ?? []) {
    const meal = normalizeMealRef(ref);
    inputs.food.addedMeals.push(meal);
    inputs.food.removedMealIds = inputs.food.removedMealIds.filter((id) => id !== (meal.id ?? meal));
    summary.push(`Added ${typeof meal === "string" ? mealName(meal) : meal.name}`);
  }
  for (const id of normalizeTextList(changes.removeMeals, "removeMeals", { max: 10 })) {
    if (!inputs.food.removedMealIds.includes(id)) inputs.food.removedMealIds.push(id);
    inputs.food.addedMeals = inputs.food.addedMeals.filter((meal) => (typeof meal === "string" ? meal : meal.id) !== id);
    summary.push(`Removed ${mealName(id)}`);
  }
  for (const item of changes.addShopping ?? []) {
    const normalized = normalizeShoppingItem(item);
    inputs.food.extraShopping.push(normalized);
    inputs.food.removedShopping = inputs.food.removedShopping.filter(
      (name) => name.toLowerCase() !== normalized.name.toLowerCase(),
    );
    summary.push(`Shopping + ${normalized.name}`);
  }
  for (const name of normalizeTextList(changes.removeShopping, "removeShopping", { max: 20 })) {
    inputs.food.removedShopping.push(name);
    inputs.food.extraShopping = inputs.food.extraShopping.filter(
      (item) => item.name.toLowerCase() !== name.toLowerCase(),
    );
    summary.push(`Shopping − ${capitalize(name)}`);
  }

  inputs.pins = pins.map(({ activity, date, explicit }) => ({ activity, date, ...(explicit ? { explicit: true } : {}) }));
  return {
    inputs,
    summary,
    note: normalizeOptionalText(changes.note, "note", 200),
  };
}

function shortWeekday(date) {
  return weekdayName(date).slice(0, 3);
}

// ---------------------------------------------------------------------------
// Integrity.

export function digestPlan(plan) {
  const canonical = JSON.stringify({
    weekStart: plan.weekStart,
    targets: plan.targets,
    schedule: plan.schedule,
    food: plan.food,
    shopping: plan.shopping,
    operations: plan.operations,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Deterministic request id per operation, so a retried create can be recognized by Todoist. */
export function operationRequestId(planId, version, opId) {
  const hex = createHash("sha256").update(`${planId}|v${version}|${opId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Authorization.

/**
 * The standing authorization for this routine, mirrored in
 * config/approval-policy.json. It covers creating the user's own Todoist tasks
 * from the displayed plan and nothing else.
 */
export const WEEKLY_PLAN_AUTHORIZATION = Object.freeze({
  routineId: "weekly-plan",
  allowedOperationKinds: Object.freeze(["create-task"]),
  allowedPayloadFields: Object.freeze(["content", "description", "due_string", "project_id", "section_id"]),
  reviewWindowHours: DEFAULT_REVIEW_WINDOW_HOURS,
});

export function checkWeeklyPlanOperation(operation) {
  if (!operation || typeof operation !== "object") return deny("not an operation");
  if (!WEEKLY_PLAN_AUTHORIZATION.allowedOperationKinds.includes(operation.kind)) {
    return deny(`operation kind "${operation.kind}" is not covered by the weekly-plan authorization`);
  }
  const payload = operation.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return deny("missing task payload");
  for (const field of Object.keys(payload)) {
    if (!WEEKLY_PLAN_AUTHORIZATION.allowedPayloadFields.includes(field)) {
      return deny(`task field "${field}" is not covered by the weekly-plan authorization`);
    }
  }
  if (typeof payload.content !== "string" || payload.content.trim() === "") return deny("missing task title");
  return { allowed: true, reason: null };
}

function deny(reason) {
  return { allowed: false, reason };
}

const EXTRA_ACCEPTANCE = new Set([
  "create it",
  "create them",
  "create these",
  "create the tasks",
  "yes create it",
  "yes create them",
  "ok create them",
  "ok create it",
  "go ahead and create them",
]);

/**
 * Explicit acceptance of the displayed plan. Reuses the repo's approval
 * language, plus a few "create it" phrasings. Questions, hedges, denials and
 * acceptance mixed with a change ("ok but no salmon") are not acceptance.
 */
export function isWeeklyPlanAcceptance(message) {
  if (isApprovalMessage(message, { hasPendingApproval: true })) return true;
  const raw = String(message ?? "").trim();
  if (!raw || raw.length > 240 || raw.includes("?")) return false;
  return EXTRA_ACCEPTANCE.has(normalizeApprovalText(raw));
}

// ---------------------------------------------------------------------------
// Messages.

export function formatPlanMessage(document, { version, deadline, changeSummary = [], timezone = WEEKLY_PLAN_TIMEZONE }) {
  const entry = document.versions.find((candidate) => candidate.version === version);
  if (!entry) throw new Error(`Plan ${document.planId} has no version ${version}.`);
  const plan = entry.plan;
  const lines = [
    `${version === 1 ? "Next week's plan" : "Updated plan"} · ${formatWeekLabel(plan.weekStart)} · v${version}`,
  ];
  if (changeSummary.length > 0) lines.push(`Changes: ${changeSummary.join(" · ")}`);

  lines.push("", "Targets", TARGET_KEYS.map((key) => `${TARGET_LABELS[key]} ${plan.targets[key]}`).join(" · "));

  lines.push("", "Schedule");
  for (const day of plan.schedule) {
    const labels = day.activities.map(
      (activity) => `${SCHEDULE_LABELS[activity.activity]}${activity.status === "existing" ? " (in Todoist)" : ""}`,
    );
    lines.push(`${day.weekday.slice(0, 3)} — ${labels.length > 0 ? labels.join(" · ") : "Rest"}`);
  }

  lines.push("", "Food");
  for (const session of plan.food.prep) {
    lines.push(
      session.mealId
        ? `• ${session.name} ×${session.portions} (prep ${weekdayName(session.date).slice(0, 3)})`
        : `• Meal of your choice (prep ${weekdayName(session.date).slice(0, 3)})`,
    );
  }
  for (const extra of plan.food.extras) lines.push(`• ${extra.name} ×${extra.portions}`);
  if (plan.food.breakfast.length > 0) lines.push(`• Breakfast: ${plan.food.breakfast.join(" / ")}`);
  if (plan.food.backup) lines.push(`• Backup: ${plan.food.backup}`);

  if (plan.shopping.sections.length > 0) {
    const items = plan.shopping.sections.flatMap((section) => section.items.map((item) => item.name));
    lines.push(
      "",
      `Shopping${plan.shopping.date ? ` (${weekdayName(plan.shopping.date).slice(0, 3)})` : ""}`,
      items.join(", "),
    );
  }

  if (plan.notes.length > 0) lines.push("", ...plan.notes.map((note) => `Note: ${note}`));
  if (plan.question) lines.push("", `Question: ${plan.question}`);

  const count = plan.operations.length;
  const when = formatLocalDateTime(deadline, timezone);
  lines.push(
    "",
    count > 0
      ? `I'll create ${count} Todoist task${count === 1 ? "" : "s"} at ${when} unless you change or cancel the plan.`
      : `Nothing new to add to Todoist; I'll close this plan at ${when} unless you change it.`,
    changeSummary.length > 0
      ? `The 12-hour review window restarted with this change. Reply OK to ${count > 0 ? "create them" : "close it"} now, or tell me what else to change.`
      : `Reply OK to ${count > 0 ? "create them" : "close it"} now, or tell me what to change, e.g. "Gym 3 times", "Move Friday gym to Sunday", "No salmon", "Add bananas" or "Skip this week".`,
  );

  return lines.join("\n");
}

export function formatApplySummary(document) {
  const entry = document.versions.find((candidate) => candidate.version === document.apply?.version);
  const outcomes = document.apply?.outcomes ?? {};
  const operations = entry?.plan.operations ?? [];
  const byStatus = (status) => operations.filter((operation) => outcomes[operation.opId]?.status === status);
  const created = byStatus("created");
  const existing = byStatus("already_exists");
  const failed = byStatus("failed");
  const past = byStatus("skipped_past_date");
  const title =
    document.status === "applied"
      ? "Applied weekly plan"
      : document.status === "applied_with_errors"
        ? "Applied weekly plan, with errors"
        : "Weekly plan could not be applied";

  const counts = [`Created: ${created.length}`, `Already existed: ${existing.length}`, `Failed: ${failed.length}`];
  if (past.length > 0) counts.push(`Skipped (date passed): ${past.length}`);
  const lines = [`${title} · ${formatWeekLabel(document.weekStart)} · v${document.apply.version}`, counts.join(" · ")];
  const errors = new Set(failed.map((operation) => outcomes[operation.opId].error));
  if (failed.length > 1 && errors.size === 1) {
    lines.push("", `Reason: ${[...errors][0]}`);
  } else if (failed.length > 0) {
    lines.push("", "Failed:");
    for (const operation of failed) lines.push(`- ${operation.payload.content}: ${outcomes[operation.opId].error}`);
  } else if (document.failureReason) {
    lines.push("", `Reason: ${document.failureReason}`);
  }
  if (failed.length > 0) {
    lines.push("", "Failed items are not retried automatically. Ask me if you want them created.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Small validators.

function requireTargetKey(key) {
  if (!TARGET_KEYS.includes(key)) {
    throw new Error(`Unknown activity: ${key}. Use one of ${TARGET_KEYS.join(", ")}.`);
  }
  return key;
}

function requireTargetCount(value, key, config) {
  const max = config?.maxSessionsPerActivity ?? 7;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > max) {
    throw new Error(`Target for ${key} must be an integer from 0 to ${max}.`);
  }
  return count;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown field in ${label}: ${key}. Allowed: ${allowed.join(", ")}.`);
  }
}

function normalizeTextList(value, label, { max }) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  if (value.length > max) throw new Error(`${label} accepts at most ${max} entries.`);
  return value.map((entry) => normalizeOptionalText(entry, label, 120)).filter(Boolean);
}

function normalizeOptionalText(value, label, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length > maxLength) throw new Error(`${label} must be at most ${maxLength} characters.`);
  return text || null;
}

function rankOf(list, value) {
  const index = list.indexOf(value);
  return index < 0 ? 99 : index;
}

function capitalize(value) {
  const text = String(value);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

/** A real calendar date: JavaScript would quietly turn 2026-02-30 into 2 March. */
function assertIsoDate(date) {
  const ms = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00.000Z`) : NaN;
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid date: ${date}`);
  }
}
