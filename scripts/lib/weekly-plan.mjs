/**
 * Deterministic weekly planning for Hilla.
 *
 * The model gathers context (Calendar load, preferences, questions) and hands
 * it over as structured input. Everything after that is plain code: which day
 * each activity lands on, the food plan, the shopping list and the exact
 * Todoist payloads. A revision re-runs the same code over the stored inputs
 * plus the user's structured changes, so the plan the user sees is always the
 * plan that gets stored, and applying it never needs the model again.
 *
 * Food follows one rule: every cooking session is a dish with a complete
 * recipe (recipes.mjs), every planned dish gets its own cooking task, and the
 * grocery list is derived from exactly those scaled recipes plus what the user
 * explicitly added. Nothing is bought "just in case".
 */
import { createHash } from "node:crypto";
import { isApprovalMessage, normalizeApprovalText } from "./approval-language.mjs";
import { buildTodoistCreatePlan } from "./todoist-create.mjs";
import { localDateInTimeZone } from "./routine-skips.mjs";
import {
  DEFAULT_RECIPE_LANGUAGE,
  buildShoppingList,
  cookingTask,
  ingredientNames,
  localWeekday,
  localizedMealName,
  mealNames,
  normalizeCustomRecipe,
  parseRecipeLanguage,
  recipeIssues,
  resolveRecipe,
  sectionId,
  shoppingTask,
  termMatches,
} from "./recipes.mjs";
import { assignGymSessions, gymTask, stretchTask } from "./workouts.mjs";
import {
  GOLF_ROLES_WITH_TASKS,
  GolfInputError,
  applyGolfChanges,
  classifyGolfTitle,
  deriveGolfWeek,
  formatGolfSection,
  golfTask,
  keepCurrentGolfWeek,
} from "./golf-week.mjs";
import {
  MONTHS,
  addDays,
  assertIsoDate,
  formatWeekLabel,
  resolvePlanDay,
  shortWeekday,
  weekDates,
  weekdayIndex,
  weekdayName,
} from "./weekly-plan-dates.mjs";

export { addDays, formatWeekLabel, resolvePlanDay, weekDates, weekdayIndex, weekdayName };

export const WEEKLY_PLAN_TIMEZONE = "Europe/Stockholm";
export const DEFAULT_REVIEW_WINDOW_HOURS = 12;
export const DEFAULT_APPLY_CHECK_MINUTES = 15;

/** Display order for targets and messages. Golf is not a count: it is the golf week (golf-week.mjs). */
export const TARGET_KEYS = Object.freeze(["gym", "stretch", "mealPrep"]);
/**
 * Golf used to be two counts. The Saturday job's message and plans stored
 * before the golf week still name them, so they are accepted and ignored on
 * input, and refused as changes with a pointer to the golf changes instead.
 */
const LEGACY_GOLF_TARGETS = Object.freeze(["golfRound", "golfPractice"]);
/** The least flexible activities are placed first. */
const PLACEMENT_ORDER = Object.freeze(["gym", "mealPrep", "stretch"]);
/** Order of activities inside one day and of operations inside one date. */
const DAY_ORDER = Object.freeze(["shopping", "mealPrep", "gym", "golf", "golfPractice", "golfRound", "stretch"]);
const DEMANDING = new Set(["gym", "mealPrep"]);
const TARGET_LABELS = Object.freeze({
  gym: "Gym",
  stretch: "Stretch",
  mealPrep: "Meal prep",
});
const SCHEDULE_LABELS = Object.freeze({
  shopping: "Shop",
  mealPrep: "Meal prep",
  gym: "Gym",
  golf: "Golf",
  golfPractice: "Golf practice",
  golfRound: "Golf round",
  stretch: "Stretch",
});
const DAY_LOADS = new Set(["light", "normal", "heavy", "unavailable"]);
const LANGUAGE_NAMES = Object.freeze({ sv: "Swedish", fi: "Finnish" });
const MAX_MEAL_PORTIONS = 8;

// ---------------------------------------------------------------------------
// Dates. Plan days are plain YYYY-MM-DD strings (weekly-plan-dates.mjs).

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

// ---------------------------------------------------------------------------
// Inputs.

/**
 * Builds the stored planner inputs for a new proposal. Targets come from the
 * agent when it supplied them, then from the previous plan, then from config,
 * so a normal week needs no questions at all. The golf week is not part of
 * these inputs: it comes from the user's own answers (golf-week.mjs), and
 * `golf` stays null until they are complete. A saved practice focus passed as
 * golfPracticeFocus is not that week's focus, so it is accepted and ignored.
 *
 * @param food the food config, needed to give dishes the user added their
 *   own cooking sessions
 * @param language the recipe language when the input names none: a saved
 *   preference, else the food config's default
 */
export function buildInitialPlanInputs(rawInput = {}, { config, food: foodConfig, weekStart, previousTargets, language } = {}) {
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

  const targets = { ...config.defaultTargets };
  for (const key of TARGET_KEYS) {
    if (previousTargets?.[key] !== undefined) targets[key] = previousTargets[key];
  }
  for (const [key, value] of Object.entries(input.targets ?? {})) {
    if (LEGACY_GOLF_TARGETS.includes(key)) continue;
    targets[requireTargetKey(key)] = requireTargetCount(value, key, config);
  }
  for (const key of Object.keys(targets)) {
    if (!TARGET_KEYS.includes(key)) delete targets[key];
  }
  for (const key of TARGET_KEYS) targets[key] = requireTargetCount(targets[key] ?? 0, key, config);
  normalizeTextList(input.golfPracticeFocus, "golfPracticeFocus", { max: 5 });

  const inputs = {
    weekStart: start,
    targets,
    days: normalizeDayLoads(input.days ?? {}, start),
    skipDays: [],
    preferences: normalizePreferences(input.preferences ?? {}, start, config),
    pins: [],
    existing: normalizeExistingTasks(input.existingTasks ?? [], start),
    food: normalizeFoodInput(input.food ?? {}, { language: language ?? defaultLanguage(foodConfig) }),
    golf: null,
    question: normalizeOptionalText(input.question, "question", 280),
    notes: normalizeTextList(input.notes, "notes", { max: 5 }),
  };
  if (foodConfig) {
    const known = [...foodConfig.weeklyMealPlan.meals, ...inputs.food.customMeals, ...inputs.food.addedMeals.filter((meal) => typeof meal === "object")];
    inputs.food.addedMeals = inputs.food.addedMeals.map((ref) => {
      if (typeof ref !== "string") return ref;
      const meal = known.find((candidate) => candidate.id === ref) ?? findMealByTerm(known, ref);
      if (!meal) throw new Error(`Unknown meal: ${ref}. Use a meal id or pass a complete recipe.`);
      return meal.id;
    });
    if (input.targets?.mealPrep === undefined) makeRoomForAddedMeals(inputs, foodConfig, { config, summary: [] });
  }
  return inputs;
}

function defaultLanguage(foodConfig) {
  return foodConfig?.weeklyMealPlan?.defaultLanguage ?? DEFAULT_RECIPE_LANGUAGE;
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
  for (const key of Object.keys(preferences)) {
    if (!LEGACY_GOLF_TARGETS.includes(key)) requireTargetKey(key);
  }
  return result;
}

const EXISTING_PATTERNS = [
  ["shopping", /^(grocery shopping|groceries|grocery|food shopping|shopping list|buy groceries|matinköp|veckohandla|veckohandling|ruokaostokset|viikon ruokaostokset)\b/],
  ["mealPrep", /^(meal ?prep|matlagning|ruoanlaitto)\b/],
  ["golf", /^(golf|play golf|\d+ holes|driving range|range session|short game|putting practice|chipping practice)\b/],
  ["gym", /^(gym|strength|workout|weights|lifting|styrketräning|kuntosali)\b/],
  ["stretch", /^(stretch|stretching|mobility|yoga|rörlighet|liikkuvuus|venyttely)\b/],
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
    result.push({ activity, date, title: title.slice(0, 120), ...(activity === "golf" ? { golfKind: classifyGolfTitle(title) } : {}) });
  }
  return result.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

/**
 * A custom meal must be a complete recipe in the week's recipe language
 * (recipes.mjs refuses anything less, saying what is missing). Shopping items
 * here are the user's own explicit additions.
 */
function normalizeFoodInput(food, { language }) {
  requireObject(food, "food");
  rejectUnknownKeys(food, ["mealIds", "customMeals", "excludeIngredients", "addMeals", "addShopping", "language", "portions"], "food");
  const recipeLanguage = food.language === undefined || food.language === null ? language : requireRecipeLanguage(food.language);
  return {
    language: recipeLanguage,
    mealIds: normalizeTextList(food.mealIds, "food.mealIds", { max: 7 }),
    customMeals: (food.customMeals ?? []).map((meal) => normalizeCustomRecipe(meal, { language: recipeLanguage })),
    excludeIngredients: normalizeTextList(food.excludeIngredients, "food.excludeIngredients", { max: 20 }).map((term) => term.toLowerCase()),
    addedMeals: (food.addMeals ?? []).map((ref) => normalizeMealRef(ref, recipeLanguage)),
    removedMealIds: [],
    extraShopping: (food.addShopping ?? []).map(normalizeShoppingItem),
    removedShopping: [],
    portions: normalizePortionMap(food.portions ?? {}, "food.portions"),
  };
}

function normalizeMealRef(ref, language) {
  if (typeof ref === "string") return normalizeOptionalText(ref, "meal id", 60);
  return normalizeCustomRecipe(ref, { language });
}

function normalizePortionMap(value, label) {
  requireObject(value, label);
  const result = {};
  for (const [ref, count] of Object.entries(value)) result[ref] = requirePortions(count, ref);
  return result;
}

function requirePortions(value, ref) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_MEAL_PORTIONS) {
    throw new Error(`Portions for ${ref} must be a whole number from 1 to ${MAX_MEAL_PORTIONS}.`);
  }
  return count;
}

function requireRecipeLanguage(value) {
  const language = parseRecipeLanguage(value);
  if (!language) throw new Error(`Recipes can be in Swedish (sv) or Finnish (fi), not ${value}.`);
  return language;
}

function normalizeShoppingItem(item) {
  const value = typeof item === "string" ? { name: item } : requireObject(item, "shopping item");
  rejectUnknownKeys(value, ["name", "section", "quantity"], "shopping item");
  const name = normalizeOptionalText(value.name, "shopping item name", 60);
  if (!name) throw new Error("A shopping item needs a name.");
  return {
    name: capitalize(name),
    section: sectionId(value.section),
    ...(value.quantity ? { quantity: normalizeOptionalText(value.quantity, "shopping quantity", 30) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Planning.

/**
 * @param today the local date the plan is built on, or null. Nothing new is
 *   placed before it, which matters when golf answers arrive after the week
 *   has started.
 * @returns the complete plan for one version: targets, the golf week,
 *   day-by-day schedule, food, shopping list and the exact Todoist operations
 *   to create.
 */
export function buildWeeklyPlan(inputs, { config, food: foodConfig, today = null }) {
  const dates = weekDates(inputs.weekStart);
  const notes = [...inputs.notes];
  const golf = inputs.golf
    ? deriveGolfWeek({
        golf: inputs.golf,
        weekStart: inputs.weekStart,
        existing: inputs.existing.filter((entry) => entry.activity === "golf"),
        dayLoads: inputs.days,
        skipDays: inputs.skipDays,
        today,
        config,
      })
    : null;
  const golfDays = new Map((golf?.days ?? []).map((day) => [day.date, day]));
  // Every meal-prep session cooks a dish with a complete recipe, so there are
  // never more sessions than such dishes.
  const menu = planMenu(inputs, foodConfig);
  const wantedMealPrep = Math.max(0, inputs.targets.mealPrep - inputs.existing.filter((entry) => entry.activity === "mealPrep").length);
  if (wantedMealPrep > menu.queue.length) {
    notes.push(
      `Only ${menu.queue.length} dish${menu.queue.length === 1 ? "" : "es"} with a complete recipe ${menu.queue.length === 1 ? "is" : "are"} left after your changes, so meal prep is ${menu.queue.length} instead of ${wantedMealPrep}. Name a dish or send me a recipe to add one.`,
    );
  }
  const placements = schedulePlacements({ dates, inputs, notes, golfDays, today, menu });
  const mealPrepDates = placements.filter((entry) => entry.activity === "mealPrep").map((entry) => entry.date).sort();
  const { food: foodPlan, recipes } = planFood({ placements, menu, notes, target: inputs.targets.mealPrep });
  const shopping = planShopping({ inputs, foodPlan, recipes });
  const existingShopping = inputs.existing.find((entry) => entry.activity === "shopping");
  const shoppingDate = shopping.itemCount > 0 ? pickShoppingDate({ dates, inputs, mealPrepDates, today }) : null;
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
      ...(GOLF_ROLES_WITH_TASKS.includes(golfDays.get(date)?.role) ? [{ activity: "golf", status: "new" }] : []),
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
    golf,
    golfDays,
    recipes,
    shopping,
    createShoppingTask: Boolean(shoppingDate && !existingShopping),
  });

  return {
    weekStart: inputs.weekStart,
    weekEnd: dates[6],
    targets: { ...inputs.targets },
    ...(golf ? { golf } : {}),
    placements,
    schedule,
    food: foodPlan,
    shopping,
    operations,
    notes,
    question: inputs.question,
  };
}

function schedulePlacements({ dates, inputs, notes, golfDays, today, menu }) {
  const occupancy = new Map(dates.map((date) => [date, new Set()]));
  for (const entry of inputs.existing) {
    if (entry.activity !== "shopping") occupancy.get(entry.date)?.add(entry.activity);
  }
  const placements = [];
  const skip = new Set(inputs.skipDays);

  const blocked = (activity, date, { explicit = false } = {}) => {
    if (!occupancy.has(date) || skip.has(date) || occupancy.get(date).has(activity)) return true;
    if (today && date < today) return true;
    if (explicit) return false;
    if (inputs.days[date]?.load === "unavailable") return true;
    return inputs.preferences[activity]?.avoidDays.includes(date) ?? false;
  };
  // A meal-prep session keeps its dish across revisions.
  const place = (activity, date, explicit, mealId) => {
    occupancy.get(date).add(activity);
    placements.push({ activity, date, ...(explicit ? { explicit: true } : {}), ...(mealId ? { mealId } : {}) });
  };
  const keepsDish = (pin) => Number(Boolean(pin.mealId && menu.eligible.has(pin.mealId)));

  for (const activity of PLACEMENT_ORDER) {
    const target = inputs.targets[activity];
    const existingCount = inputs.existing.filter((entry) => entry.activity === activity).length;
    let need = Math.max(0, target - existingCount);
    if (activity === "mealPrep") need = Math.min(need, menu.queue.length);

    const pins = inputs.pins
      .filter((pin) => pin.activity === activity)
      .sort(
        (a, b) =>
          keepsDish(b) - keepsDish(a) ||
          Number(Boolean(b.explicit)) - Number(Boolean(a.explicit)) ||
          a.date.localeCompare(b.date),
      );
    for (const pin of pins) {
      if (need === 0) break;
      if (blocked(activity, pin.date, { explicit: pin.explicit })) continue;
      place(activity, pin.date, pin.explicit, activity === "mealPrep" ? pin.mealId : null);
      need -= 1;
    }

    while (need > 0) {
      const candidates = dates
        .filter((date) => !blocked(activity, date))
        .map((date) => ({
          date,
          cost: placementCost(activity, date, { dates, inputs, occupancy, golfDays }),
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
        const placed = placements.filter((entry) => entry.activity === activity).length;
        notes.push(`Only room for ${placed + existingCount} of ${target} ${SCHEDULE_LABELS[activity].toLowerCase()} sessions.`);
        break;
      }
      place(activity, candidates[0].date, false, null);
      need -= 1;
    }
  }

  return placements.sort(
    (a, b) => a.date.localeCompare(b.date) || DAY_ORDER.indexOf(a.activity) - DAY_ORDER.indexOf(b.activity),
  );
}

function placementCost(activity, date, { dates, inputs, occupancy, golfDays }) {
  const index = weekdayIndex(date);
  const on = (offset, type) => occupancy.get(addDays(date, offset))?.has(type) ?? false;
  const golf = (offset) => golfLoad(addDays(date, offset), { golfDays, occupancy });
  const golfToday = golf(0);
  const golfBefore = golf(-1);
  const golfAfter = golf(1);
  const activitiesToday = occupancy.get(date).size + (golfToday.load && !on(0, "golf") ? 1 : 0);
  const sameTypeGaps = dates
    .filter((other) => other !== date && occupancy.get(other).has(activity))
    .map((other) => Math.abs(weekdayIndex(other) - index));
  const load = inputs.days[date]?.load ?? "normal";
  let cost = 0.5 * activitiesToday;

  if (load === "heavy") cost += DEMANDING.has(activity) ? 6 : 2;
  if (load === "light" && DEMANDING.has(activity)) cost -= 1;
  if (inputs.preferences[activity]?.preferredDays.includes(date)) cost -= 4;

  // Golf is physical load: no gym on a round day or the day before a
  // competition, little next to a full round, and the golf-free day stays a
  // recovery day when the week allows it.
  switch (activity) {
    case "gym":
      if (golfToday.load === "high") cost += 8;
      if (golfAfter.competition) cost += 8;
      else if (golfBefore.load === "high" || golfAfter.load === "high") cost += 3;
      if (golfToday.load === "medium") cost += 2;
      if (golfToday.rest) cost += 3;
      for (const gap of sameTypeGaps) cost += gap === 1 ? 5 : gap === 2 ? 1 : 0;
      break;
    case "mealPrep": {
      if (on(0, "gym")) cost += 2;
      if (golfToday.load === "high") cost += 2;
      for (const gap of sameTypeGaps) cost += gap < 2 ? 6 : gap === 2 ? 1 : 0;
      // Spread sessions evenly with the first one early in the week.
      const ideal = Math.round((sameTypeGaps.length * 7) / Math.max(1, inputs.targets.mealPrep));
      cost += 0.75 * Math.abs(index - ideal);
      break;
    }
    case "stretch":
      if (on(-1, "gym") || golfBefore.load === "high") cost -= 1;
      if (activitiesToday >= 2) cost += 1;
      for (const gap of sameTypeGaps) cost += gap === 1 ? 2 : 0;
      break;
    default:
      break;
  }

  return cost;
}

/**
 * How much golf a day carries: `high` for a full round or competition,
 * `medium` for a 9-hole round, a lesson or a full practice, `low` for a light
 * one. A golf task already in Todoist counts too, by its title.
 */
function golfLoad(date, { golfDays, occupancy }) {
  const day = golfDays.get(date);
  if (!day) return { load: occupancy.get(date)?.has("golf") ? "medium" : null, competition: false, rest: false };
  switch (day.role) {
    case "competition":
      return { load: "high", competition: true, rest: false };
    case "round":
      return { load: (day.holes ?? 18) >= 18 ? "high" : "medium", competition: false, rest: false };
    case "existing": {
      // The user's own words about that day beat the task title.
      const round = day.round;
      const playing = round ? round.competition || (round.holes ?? 18) >= 18 : ["round", "competition"].includes(day.existingKind);
      return {
        load: playing ? "high" : "medium",
        competition: round ? round.competition : day.existingKind === "competition",
        rest: false,
      };
    }
    case "lesson":
      return { load: "medium", competition: false, rest: false };
    case "practice":
      return { load: day.intensity === "light" || day.intensity === "prep" ? "low" : "medium", competition: false, rest: false };
    case "rest":
      return { load: null, competition: false, rest: true };
    default:
      return { load: null, competition: false, rest: false };
  }
}

function pickShoppingDate({ dates, inputs, mealPrepDates, today }) {
  if (mealPrepDates.length > 0) return mealPrepDates[0];
  const skip = new Set(inputs.skipDays);
  const open = dates.filter((date) => !today || date >= today);
  return open.find((date) => !skip.has(date) && inputs.days[date]?.load !== "unavailable") ?? open[0] ?? dates[6];
}

/**
 * Which dishes this week can be cooked: every recipe that is complete in the
 * week's language and not removed or excluded. The queue fills free sessions
 * in order: dishes the user added, then their preferred meals, then the
 * catalog. Dishes the user added that cannot be cooked are reported, never
 * planned without a recipe.
 */
function planMenu(inputs, foodConfig) {
  const language = inputs.food.language ?? defaultLanguage(foodConfig);
  const catalog = foodConfig.weeklyMealPlan.meals;
  const known = [...catalog, ...inputs.food.customMeals, ...inputs.food.addedMeals.filter((meal) => typeof meal === "object")];
  const byId = new Map(known.map((meal) => [meal.id, meal]));
  const removed = new Set(inputs.food.removedMealIds);
  const excluded = inputs.food.excludeIngredients;
  const issues = [];
  const usable = (meal) => !removed.has(meal.id) && !mealIsExcluded(meal, excluded) && recipeIssues(meal, language).length === 0;

  const added = [];
  for (const ref of inputs.food.addedMeals) {
    const meal = typeof ref === "string" ? byId.get(ref) ?? findMealByTerm(known, ref) : ref;
    if (!meal) throw new Error(`Unknown meal: ${ref}. Use a meal id or pass a complete recipe.`);
    if (removed.has(meal.id) || added.includes(meal.id)) continue;
    const problems = recipeIssues(meal, language);
    if (problems.length > 0) {
      issues.push(`${problems[0]} Send me the whole recipe (ingredients with amounts and the steps) to cook it.`);
      continue;
    }
    if (mealIsExcluded(meal, excluded)) {
      issues.push(`${localizedMealName(meal, language)} isn't planned: it contains something you excluded.`);
      continue;
    }
    added.push(meal.id);
  }
  const preferred = inputs.food.mealIds.filter((id) => byId.has(id));
  for (const id of preferred) {
    const meal = byId.get(id);
    if (meal.custom === undefined && typeof meal.name === "string" && !removed.has(id)) {
      issues.push(`${recipeIssues(meal, language)[0]} Send me the whole recipe to cook it.`);
    }
  }
  const queue = [...new Set([...added, ...preferred, ...catalog.map((meal) => meal.id)])].filter((id) => usable(byId.get(id)));
  return {
    language,
    byId,
    known,
    added,
    queue,
    eligible: new Set(queue),
    issues: [...new Set(issues)],
    portionsFor: (meal) => inputs.food.portions?.[meal.id] ?? meal.portions ?? meal.servings,
  };
}

/**
 * Gives each meal-prep session its dish: a session keeps the dish it had in
 * the version the user saw while that dish is still possible, so changing one
 * meal changes only that session. Then each recipe is scaled once; the cooking
 * task and the grocery list both use the result.
 */
function planFood({ placements, menu, notes, target }) {
  const sessions = placements.filter((entry) => entry.activity === "mealPrep");
  const used = new Set();
  for (const session of sessions) {
    if (session.mealId && menu.eligible.has(session.mealId) && !used.has(session.mealId)) used.add(session.mealId);
    else delete session.mealId;
  }
  for (const session of sessions) {
    if (session.mealId) continue;
    // There are never more sessions than dishes in the queue (schedulePlacements caps them).
    session.mealId = menu.queue.find((id) => !used.has(id));
    used.add(session.mealId);
  }

  const recipes = new Map();
  const prep = sessions.map((session) => {
    const meal = menu.byId.get(session.mealId);
    const recipe = resolveRecipe(meal, { language: menu.language, portions: menu.portionsFor(meal) });
    recipes.set(session.date, recipe);
    return {
      date: session.date,
      mealId: meal.id,
      name: recipe.name,
      portions: recipe.portions,
      ...(recipe.minutes ? { minutes: recipe.minutes } : {}),
      ingredients: recipe.ingredients
        .filter((ingredient) => !ingredient.water)
        .map((ingredient) => ({
          name: capitalize(ingredient.forms[0]),
          ...(ingredient.toTaste ? { toTaste: true } : { amount: ingredient.amount, unit: ingredient.unit }),
        })),
    };
  });

  for (const id of menu.added) {
    if (!used.has(id)) {
      notes.push(`${localizedMealName(menu.byId.get(id), menu.language)} isn't planned: there's no free meal-prep session. Say "Meal prep ${target + 1} times" to cook it too.`);
    }
  }
  notes.push(...menu.issues);
  return { food: { language: menu.language, prep }, recipes };
}

function findMealByTerm(meals, term) {
  return meals.find((meal) => termMatches(term, mealNames(meal))) ?? null;
}

/** A dish is excluded when its name or any of its ingredients matches an excluded term, in any language. */
function mealIsExcluded(meal, excluded) {
  if (excluded.length === 0) return false;
  const names = mealNames(meal);
  return excluded.some(
    (term) => termMatches(term, names) || (meal.ingredients ?? []).some((ingredient) => termMatches(term, ingredientNames(ingredient))),
  );
}

/** The week's one grocery list: the scaled recipes, the user's additions, minus what they already have. */
function planShopping({ inputs, foodPlan, recipes }) {
  return buildShoppingList({
    dishes: foodPlan.prep.map((session) => ({ mealId: session.mealId, date: session.date, recipe: recipes.get(session.date) })),
    extras: inputs.food.extraShopping,
    removed: inputs.food.removedShopping,
    language: foodPlan.language,
  });
}

/** "round" or "competition" when golf of that kind is planned or already in Todoist on `date`. */
function golfEventOn(date, { golfDays, inputs }) {
  const day = golfDays.get(date);
  if (day) {
    if (day.role === "competition" || day.role === "round") return day.role;
    if (day.role === "existing") {
      if (day.round) return day.round.competition ? "competition" : "round";
      if (["round", "competition"].includes(day.existingKind)) return day.existingKind;
    }
    return null;
  }
  const entry = inputs.existing.find(
    (candidate) => candidate.date === date && candidate.activity === "golf" && ["round", "competition"].includes(candidate.golfKind),
  );
  return entry?.golfKind ?? null;
}

function buildOperations({ inputs, config, placements, golf, golfDays, recipes, shopping, createShoppingTask }) {
  const activities = config.activities;
  const operations = [];
  let stretchCount = 0;
  const golfTomorrow = (date) => golfEventOn(addDays(date, 1), { golfDays, inputs });
  const gymSessions = assignGymSessions(
    placements.filter((entry) => entry.activity === "gym").map((entry) => entry.date),
    activities.gym.sessions,
    { golfTomorrow },
  );

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
    const task = shoppingTask(shopping, { weekdayOf: (date, language) => localWeekday(weekdayIndex(date), language) });
    add("shopping", shopping.date, task.content, task.description);
  }

  // One main golf task per golf day; existing golf tasks are never touched.
  for (const day of golf?.days ?? []) {
    if (!GOLF_ROLES_WITH_TASKS.includes(day.role)) continue;
    const task = golfTask(day, golf, config.golf);
    add("golf", day.date, task.content, task.description);
  }

  for (const entry of placements) {
    const { activity, date } = entry;
    switch (activity) {
      case "gym": {
        const task = gymTask(gymSessions.get(date), activities.gym, { weekdayIndex: weekdayIndex(date), beforeGolf: golfTomorrow(date) });
        add(activity, date, task.content, task.description);
        break;
      }
      case "stretch": {
        const routines = activities.stretch.routines;
        const task = stretchTask(routines[stretchCount % routines.length], activities.stretch, { weekdayIndex: weekdayIndex(date) });
        stretchCount += 1;
        add(activity, date, task.content, task.description);
        break;
      }
      case "mealPrep": {
        const task = cookingTask(recipes.get(date), { shopFirst: createShoppingTask && shopping.date === date });
        add(activity, date, task.content, task.description);
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
  "mealPortions",
  "recipeLanguage",
  "golf",
  "note",
]);

const GOLF_CHANGE_HINT =
  'Golf is planned as a golf week: change it with {"golf": {"replyText": "EXACT USER WORDS", ...}}, for example "activeDays": 0 for no golf, "addRounds", "restDay" or "moves" (see the weekly-plan guide).';

/**
 * Applies one structured modification to the stored inputs of the current
 * version. Placements that the change does not touch stay pinned, so "gym 3
 * times" adds a session instead of reshuffling the week; the golf week keeps
 * its sessions and golf-free day the same way.
 *
 * A dish the user adds is cooked in a free meal-prep session, or gets a new
 * one (meal prep +1, shown in the change summary), so no dish is ever on the
 * food plan or the shopping list without its own cooking task.
 *
 * @param golfContext `{ today, previousWeek, normalWeekText }` for golf changes
 * @throws GolfInputError when a golf change cannot be traced to the user's words
 * @throws RecipeInputError when a recipe the user supplied is incomplete
 */
export function applyWeeklyPlanChanges(previousInputs, previousPlan, rawChanges, { config, food, golfContext = {} } = {}) {
  const changes = requireObject(rawChanges ?? {}, "Weekly plan changes");
  rejectUnknownKeys(changes, CHANGE_KEYS, "weekly plan changes");
  const substantive = Object.keys(changes).filter((key) => key !== "note");
  if (substantive.length === 0) throw new Error("A weekly plan revision needs at least one change.");
  if (previousInputs.golf === undefined && LEGACY_GOLF_TARGETS.some((key) => previousInputs.targets?.[key] > 0)) {
    throw new Error(
      "This plan was made before the golf week planner, so it can still be accepted or cancelled but not changed. Cancel it and ask for a new plan to change it.",
    );
  }

  if (!food?.weeklyMealPlan) throw new Error("The food config is required to change a weekly plan.");

  const inputs = structuredClone(previousInputs);
  const weekStart = inputs.weekStart;
  const summary = [];
  // Plans stored before recipes were required have no language or portions,
  // and keep each session's dish only in food.prep.
  inputs.food.language ??= defaultLanguage(food);
  inputs.food.portions ??= {};
  let pins = previousPlan.placements.map((entry) => {
    const mealId = entry.activity === "mealPrep" ? entry.mealId ?? previousPlan.food?.prep?.find((session) => session.date === entry.date)?.mealId : null;
    return { ...entry, ...(mealId ? { mealId } : {}) };
  });
  if (inputs.golf && previousPlan.golf) inputs.golf = keepCurrentGolfWeek(inputs.golf, previousPlan.golf);
  const addedIds = () => inputs.food.addedMeals.map((meal) => (typeof meal === "string" ? meal : meal.id));

  for (const [key, value] of Object.entries(changes.targets ?? {})) {
    if (LEGACY_GOLF_TARGETS.includes(key)) throw new Error(GOLF_CHANGE_HINT);
    const activity = requireTargetKey(key);
    const next = requireTargetCount(value, key, config);
    const before = inputs.targets[activity];
    if (next === before) continue;
    inputs.targets[activity] = next;
    summary.push(`${TARGET_LABELS[activity]} ${before} → ${next}`);
    if (next < before) {
      const existingCount = inputs.existing.filter((entry) => entry.activity === activity).length;
      // Sessions cooking a dish the user asked for go last.
      const asked = new Set(addedIds());
      const keep = pins
        .filter((pin) => pin.activity === activity)
        .sort(
          (a, b) =>
            Number(asked.has(b.mealId)) - Number(asked.has(a.mealId)) ||
            Number(Boolean(b.explicit)) - Number(Boolean(a.explicit)) ||
            a.date.localeCompare(b.date),
        )
        .slice(0, Math.max(0, next - existingCount));
      pins = pins.filter((pin) => pin.activity !== activity || keep.includes(pin));
    }
  }

  for (const move of changes.moves ?? []) {
    requireObject(move, "move");
    rejectUnknownKeys(move, ["activity", "from", "to"], "move");
    if (move.activity === "golf" || LEGACY_GOLF_TARGETS.includes(move.activity)) throw new Error(GOLF_CHANGE_HINT);
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
  const knownMeals = () => [...food.weeklyMealPlan.meals, ...inputs.food.customMeals, ...inputs.food.addedMeals.filter((meal) => typeof meal === "object")];
  const resolveMealId = (ref) => {
    const meals = knownMeals();
    return meals.find((meal) => meal.id === ref)?.id ?? findMealByTerm(meals, ref)?.id ?? null;
  };
  const mealName = (id) => {
    const meal = knownMeals().find((candidate) => candidate.id === id);
    return meal ? localizedMealName(meal, inputs.food.language) : id;
  };

  // The language first, so a recipe added in the same change is checked against it.
  if (changes.recipeLanguage !== undefined) {
    const next = requireRecipeLanguage(changes.recipeLanguage);
    if (next !== inputs.food.language) {
      const planned = new Set([...inputs.food.mealIds, ...addedIds()]);
      const written = knownMeals().filter((meal) => meal.custom && meal.language !== next && planned.has(meal.id) && !inputs.food.removedMealIds.includes(meal.id));
      if (written.length > 0) {
        throw new Error(
          `${written.map((meal) => meal.name).join(" and ")} ${written.length === 1 ? "is" : "are"} written in ${LANGUAGE_NAMES[inputs.food.language]}. Send ${written.length === 1 ? "it" : "them"} again in ${LANGUAGE_NAMES[next]}, or remove ${written.length === 1 ? "it" : "them"}, before the recipes switch to ${LANGUAGE_NAMES[next]}.`,
        );
      }
      inputs.food.language = next;
      summary.push(`Recipes in ${LANGUAGE_NAMES[next]}`);
    }
  }

  const newlyAdded = [];
  for (const ref of changes.addMeals ?? []) {
    const meal = normalizeMealRef(ref, inputs.food.language);
    let id;
    if (typeof meal === "string") {
      id = resolveMealId(meal);
      if (!id) throw new Error(`Unknown meal: ${meal}. Use a meal id or pass a complete recipe.`);
      if (!addedIds().includes(id)) inputs.food.addedMeals.push(id);
    } else {
      id = meal.id;
      inputs.food.addedMeals = inputs.food.addedMeals.filter((entry) => (typeof entry === "string" ? entry : entry.id) !== id);
      inputs.food.addedMeals.push(meal);
    }
    inputs.food.removedMealIds = inputs.food.removedMealIds.filter((entry) => entry !== id);
    newlyAdded.push(id);
    summary.push(`Added ${mealName(id)}`);
  }
  for (const ref of normalizeTextList(changes.removeMeals, "removeMeals", { max: 10 })) {
    const id = resolveMealId(ref) ?? ref;
    const name = mealName(id);
    if (!inputs.food.removedMealIds.includes(id)) inputs.food.removedMealIds.push(id);
    inputs.food.addedMeals = inputs.food.addedMeals.filter((meal) => (typeof meal === "string" ? meal : meal.id) !== id);
    summary.push(`Removed ${name}`);
  }
  if (changes.mealPortions !== undefined) {
    for (const [ref, count] of Object.entries(requireObject(changes.mealPortions, "mealPortions"))) {
      const id = resolveMealId(ref);
      if (!id) throw new Error(`Unknown meal: ${ref}.`);
      inputs.food.portions[id] = requirePortions(count, ref);
      summary.push(`${mealName(id)} ×${inputs.food.portions[id]}`);
    }
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

  if (changes.golf !== undefined) {
    if (!inputs.golf) throw new Error("This plan has no golf week to change.");
    const result = applyGolfChanges(inputs.golf, changes.golf, { ...golfContext, weekStart, plan: previousPlan.golf ?? null });
    if (result.problems.length > 0) throw new GolfInputError(result.problems);
    inputs.golf = result.golf;
    summary.push(...result.summary);
  }

  // A dish added before every dish needed its own session (a plan's "extras")
  // gets one now, as if it had just been added.
  const waiting = [...newlyAdded, ...(previousPlan.food?.extras ?? []).map((extra) => extra.mealId)];
  if (waiting.length > 0) {
    pins = makeRoomForAddedMeals(inputs, food, {
      config,
      pins,
      onlyIds: waiting,
      explicitTarget: changes.targets?.mealPrep !== undefined,
      summary,
    });
  }

  inputs.pins = pins.map(({ activity, date, explicit, mealId }) => ({
    activity,
    date,
    ...(explicit ? { explicit: true } : {}),
    ...(mealId ? { mealId } : {}),
  }));
  return {
    inputs,
    summary,
    note: normalizeOptionalText(changes.note, "note", 200),
  };
}

/**
 * Dishes the user added need a session each. Free sessions are used first;
 * when there are none, meal prep grows by the missing number. When the same
 * change also set the number of sessions, that number stands: the latest
 * sessions give up their automatically chosen dish instead.
 * @param onlyIds the dishes added in this change; all added dishes when null
 * @returns the pins, possibly with dishes released
 */
function makeRoomForAddedMeals(inputs, foodConfig, { config, pins = [], onlyIds = null, explicitTarget = false, summary }) {
  const menu = planMenu(inputs, foodConfig);
  const sessions = Math.max(0, inputs.targets.mealPrep - inputs.existing.filter((entry) => entry.activity === "mealPrep").length);
  const mealPins = pins.filter((pin) => pin.activity === "mealPrep");
  const kept = new Set(mealPins.map((pin) => pin.mealId).filter((id) => id && menu.eligible.has(id)));
  const waiting = menu.added.filter((id) => !kept.has(id) && (!onlyIds || onlyIds.includes(id)));
  const missing = waiting.length - (sessions - kept.size);
  if (missing <= 0) return pins;
  if (!explicitTarget) {
    const next = inputs.targets.mealPrep + missing;
    const max = config.maxSessionsPerActivity ?? 7;
    if (next > max) throw new Error(`There's no room for another meal-prep session (at most ${max}). Remove a meal first.`);
    summary.push(`${TARGET_LABELS.mealPrep} ${inputs.targets.mealPrep} → ${next}`);
    inputs.targets.mealPrep = next;
    return pins;
  }
  const released = mealPins
    .filter((pin) => pin.mealId && !menu.added.includes(pin.mealId))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, missing);
  return pins.map((pin) => {
    if (!released.includes(pin)) return pin;
    const { mealId, ...rest } = pin;
    return rest;
  });
}

// ---------------------------------------------------------------------------
// Integrity.

/** A plan stored before the golf week has no `golf`, which JSON leaves out, so its digest is unchanged. */
export function digestPlan(plan) {
  const canonical = JSON.stringify({
    weekStart: plan.weekStart,
    targets: plan.targets,
    golf: plan.golf,
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
  const targets = TARGET_KEYS.map((key) => `${TARGET_LABELS[key]} ${plan.targets[key]}`).join(" · ");
  const labelsOf = (day, { withGolf }) =>
    day.activities
      .filter((activity) => withGolf || activity.activity !== "golf")
      .map((activity) => `${SCHEDULE_LABELS[activity.activity]}${activity.status === "existing" ? " (in Todoist)" : ""}`);

  if (plan.golf) {
    // The golf week has its own section; the schedule below lists the rest.
    lines.push("", ...formatGolfSection(plan.golf));
    lines.push("", "Gym, stretching and meal prep", targets);
    for (const day of plan.schedule) {
      const labels = labelsOf(day, { withGolf: false });
      if (labels.length > 0) lines.push(`${day.weekday.slice(0, 3)} — ${labels.join(" · ")}`);
    }
  } else {
    lines.push("", "Targets", targets, "", "Schedule");
    for (const day of plan.schedule) {
      const labels = labelsOf(day, { withGolf: true });
      lines.push(`${day.weekday.slice(0, 3)} — ${labels.length > 0 ? labels.join(" · ") : "Rest"}`);
    }
  }

  // Plans stored before recipes were required have no food language; they
  // show their extras, breakfast and backup lines exactly as before.
  const recipePlan = Boolean(plan.food.language);
  lines.push("", "Food");
  for (const session of plan.food.prep) {
    lines.push(
      session.mealId
        ? `• ${session.name} ×${session.portions} (prep ${weekdayName(session.date).slice(0, 3)})`
        : `• Meal of your choice (prep ${weekdayName(session.date).slice(0, 3)})`,
    );
  }
  for (const extra of plan.food.extras ?? []) lines.push(`• ${extra.name} ×${extra.portions}`);
  if (plan.food.breakfast?.length > 0) lines.push(`• Breakfast: ${plan.food.breakfast.join(" / ")}`);
  if (plan.food.backup) lines.push(`• Backup: ${plan.food.backup}`);
  if (recipePlan && plan.food.prep.length === 0) lines.push("• No meal prep this week");
  if (recipePlan && plan.food.language !== DEFAULT_RECIPE_LANGUAGE) lines.push(`• Recipes in ${LANGUAGE_NAMES[plan.food.language]}`);

  if (plan.shopping.sections.length > 0) {
    const names = (sections) => sections.flatMap((section) => section.items.map((item) => item.name));
    const toBuy = recipePlan ? names(plan.shopping.sections.filter((section) => section.id !== "staples")) : names(plan.shopping.sections);
    const staples = recipePlan ? names(plan.shopping.sections.filter((section) => section.id === "staples")) : [];
    lines.push("", `Shopping${plan.shopping.date ? ` (${weekdayName(plan.shopping.date).slice(0, 3)})` : ""}`);
    if (toBuy.length > 0) lines.push(toBuy.join(", "));
    if (staples.length > 0) lines.push(`Check you have: ${staples.join(", ")}`);
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
      : `Reply OK to ${count > 0 ? "create them" : "close it"} now, or tell me what to change, e.g. ${
          plan.golf ? '"Move wedges to Thursday", "Gym 3 times", "No salmon"' : '"Gym 3 times", "Move Friday gym to Sunday", "No salmon", "Add bananas"'
        } or "Skip this week".`,
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
