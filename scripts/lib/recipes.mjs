/**
 * Recipes for the weekly plan.
 *
 * One structured recipe is the single source for both outputs: it is scaled to
 * the planned portions once, and the cooking task and the grocery list are both
 * built from that scaled recipe, so they cannot disagree.
 *
 * Everything the user sees is Swedish or Finnish with Swedish/Finnish kitchen
 * units. A recipe the user supplies is converted here by fixed factors: pounds
 * and ounces become grams, cups become dl (volume stays volume, so a cup of
 * flour is never turned into grams), and °F becomes °C. A unit that cannot be
 * converted reliably, a missing amount or missing steps is asked for instead of
 * guessed. The model translates the text; this module refuses text that still
 * reads as English or uses imperial units.
 */

export const RECIPE_LANGUAGES = Object.freeze(["sv", "fi"]);
export const DEFAULT_RECIPE_LANGUAGE = "sv";
export const MAX_RECIPE_INGREDIENTS = 25;
export const MAX_RECIPE_STEPS = 15;
const MAX_PORTIONS = 8;
const MAX_SERVINGS = 12;

/** A recipe that cannot be planned as given. `problems` say what is missing, in plain words. */
export class RecipeInputError extends Error {
  constructor(problems, { name = null } = {}) {
    super(`Recipe${name ? ` "${name}"` : ""} is incomplete: ${problems.join(" ")}`);
    this.name = "RecipeInputError";
    this.problems = problems;
    this.recipeName = name;
  }
}

/** "fi", "finska", "suomi", "Finnish" → "fi"; the same for Swedish; anything else → null. */
export function parseRecipeLanguage(value) {
  const text = String(value ?? "")
    .toLowerCase()
    .replace(/^(på|in)\s+/, "")
    .trim();
  if (["fi", "fin", "finnish", "finska", "suomi", "suomeksi", "suomea"].includes(text)) return "fi";
  if (["sv", "swe", "swedish", "svenska", "ruotsi", "ruotsiksi", "ruotsia"].includes(text)) return "sv";
  return null;
}

// ---------------------------------------------------------------------------
// Units.

/**
 * The units a stored recipe may use. Mass is always grams (kg is only how a
 * large amount is shown). Count units keep the source's own unit (a can stays
 * one can) instead of inventing a weight.
 */
const UNITS = Object.freeze({
  g: { dimension: "mass", ml: null, label: { sv: "g", fi: "g" } },
  ml: { dimension: "volume", ml: 1, label: { sv: "ml", fi: "ml" } },
  dl: { dimension: "volume", ml: 100, label: { sv: "dl", fi: "dl" } },
  l: { dimension: "volume", ml: 1000, label: { sv: "l", fi: "l" } },
  krm: { dimension: "volume", ml: 1, label: { sv: "krm", fi: "mm" } },
  tsk: { dimension: "volume", ml: 5, label: { sv: "tsk", fi: "tl" } },
  msk: { dimension: "volume", ml: 15, label: { sv: "msk", fi: "rkl" } },
  st: { dimension: "st", ml: null, label: { sv: "st", fi: "kpl" } },
  burk: { dimension: "burk", ml: null, label: { sv: ["burk", "burkar"], fi: ["tölkki", "tölkkiä"] } },
  förp: { dimension: "förp", ml: null, label: { sv: ["förp.", "förp."], fi: ["pakkaus", "pakkausta"] } },
  knippe: { dimension: "knippe", ml: null, label: { sv: ["knippe", "knippen"], fi: ["nippu", "nippua"] } },
  nypa: { dimension: "nypa", ml: null, label: { sv: ["nypa", "nypor"], fi: ["ripaus", "ripausta"] } },
});

export const RECIPE_UNITS = Object.freeze(Object.keys(UNITS));

/**
 * Source units, metric or not, as `[unit, factor]`. Spoons map one to one
 * (a US tablespoon is 14.8 ml, a msk 15 ml). "cup" is the US cup, within a few
 * per cent of a metric one; a plain pint, quart or gallon is a fifth bigger in
 * a British recipe than in an American one, so it needs "US" or "UK".
 */
const SOURCE_UNITS = (() => {
  const table = new Map();
  const add = (names, unit, factor = 1) => {
    for (const name of names) table.set(name, [unit, factor]);
  };
  add(["g", "gr", "gram", "grams", "gramm", "grammaa"], "g");
  add(["kg", "kilo", "kilos", "kilogram", "kilograms", "kiloa"], "g", 1000);
  add(["ml", "milliliter", "milliliters", "millilitre", "millilitres", "millilitraa"], "ml");
  add(["cl", "centiliter", "centilitre"], "ml", 10);
  add(["dl", "deciliter", "decilitre", "desilitra", "desilitraa"], "dl");
  add(["l", "liter", "liters", "litre", "litres", "litra", "litraa"], "l");
  add(["krm", "kryddmått", "mm", "mausteemitta"], "krm");
  add(["tsk", "tesked", "teskedar", "tl", "teelusikka", "teelusikallista", "tsp", "tsps", "teaspoon", "teaspoons"], "tsk");
  add(["msk", "matsked", "matskedar", "rkl", "ruokalusikka", "ruokalusikallista", "tbsp", "tbsps", "tbs", "tablespoon", "tablespoons"], "msk");
  add(["st", "styck", "kpl", "kappale", "kappaletta", "piece", "pieces", "pc", "pcs", "whole", "clove", "cloves", "klyfta", "klyftor", "kynsi", "kynttä"], "st");
  add(["burk", "burkar", "tölkki", "tölkkiä", "can", "cans", "tin", "tins", "jar", "jars"], "burk");
  add(["förp", "förpackning", "förpackningar", "paket", "pkt", "pakkaus", "pakkausta", "package", "packages", "pack", "packs", "packet", "packets", "pkg"], "förp");
  add(["knippe", "knippen", "nippu", "nippua", "bunch", "bunches"], "knippe");
  add(["nypa", "nypor", "ripaus", "ripausta", "pinch", "pinches", "dash", "dashes"], "nypa");
  add(["oz", "ounce", "ounces"], "g", 28.3495);
  add(["lb", "lbs", "pound", "pounds"], "g", 453.592);
  add(["cup", "cups", "us cup", "us cups"], "dl", 2.36588);
  add(["metric cup", "metric cups"], "dl", 2.5);
  add(["imperial cup", "imperial cups", "uk cup", "uk cups"], "dl", 2.84131);
  add(["fl oz", "fl. oz", "floz", "fluid ounce", "fluid ounces"], "ml", 29.5735);
  add(["us pint", "us pints"], "ml", 473.176);
  add(["uk pint", "uk pints", "imperial pint", "imperial pints"], "ml", 568.261);
  add(["us quart", "us quarts"], "l", 0.946353);
  add(["us gallon", "us gallons"], "l", 3.78541);
  return table;
})();

/**
 * Converts a source amount to a stored metric amount. A converted value is
 * rounded the way a cook would write it, and small or large volumes move to the
 * spoon or litre that reads naturally (¼ cup becomes 4 msk, not ½ dl).
 * @returns `{ amount, unit, converted }`, or null when the unit is not known.
 */
export function convertSourceAmount(amount, rawUnit) {
  const key = String(rawUnit ?? "")
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/\s+/g, " ")
    .trim();
  const entry = SOURCE_UNITS.get(key);
  if (!entry || !Number.isFinite(amount) || amount <= 0) return null;
  const [unit, factor] = entry;
  if (factor === 1) return { amount, unit, converted: false };
  const value = amount * factor;
  if (unit === "g") return { amount: roundAmount(value, "g"), unit: "g", converted: true };
  return { ...readableVolume(value * UNITS[unit].ml), converted: true };
}

/** A volume in ml as the unit a Swedish recipe would use, rounded. */
function readableVolume(ml) {
  if (ml < 15) return { amount: roundAmount(ml / 5, "tsk"), unit: "tsk" };
  if (ml < 100) return { amount: roundAmount(ml / 15, "msk"), unit: "msk" };
  if (ml < 1000) return { amount: roundAmount(ml / 100, "dl"), unit: "dl" };
  return { amount: roundAmount(ml / 1000, "l"), unit: "l" };
}

/** 350 °F → 175 °C: to the nearest 5 °C, like an oven dial. */
export function fahrenheitToCelsius(fahrenheit) {
  return Math.round(((fahrenheit - 32) * 5) / 9 / 5) * 5;
}

/**
 * Culinary rounding, used only on amounts that were scaled or converted, so a
 * recipe's own amounts are shown exactly as written.
 */
export function roundAmount(amount, unit) {
  const step = (size) => Math.max(size, Math.round(amount / size) * size);
  switch (unit) {
    case "g":
      if (amount < 10) return step(1);
      if (amount < 250) return step(5);
      if (amount < 1000) return step(10);
      return step(50);
    case "ml":
      return amount < 100 ? step(5) : step(10);
    case "dl":
      return amount <= 3 ? step(0.25) : amount <= 10 ? step(0.5) : step(1);
    default:
      // Spoons, litres and count units: quarters for measures, halves for pieces.
      return UNITS[unit]?.dimension === "volume" ? step(0.25) : step(0.5);
  }
}

const FRACTIONS = Object.freeze({ 0.25: "¼", 0.5: "½", 0.75: "¾" });

/** 1.5 → "1 ½", 0.25 → "¼", 1.35 → "1,35". Swedish and Finnish both use a decimal comma. */
function formatNumber(value) {
  const rounded = Math.round(value * 1000) / 1000;
  const whole = Math.floor(rounded);
  const fraction = Math.round((rounded - whole) * 100) / 100;
  if (fraction === 0) return String(whole);
  if (FRACTIONS[fraction]) return whole === 0 ? FRACTIONS[fraction] : `${whole} ${FRACTIONS[fraction]}`;
  return String(Math.round(rounded * 100) / 100).replace(".", ",");
}

function unitLabel(unit, language, amount) {
  const label = UNITS[unit].label[language];
  if (!Array.isArray(label)) return label;
  return pluralForm(label, language, amount);
}

/** Swedish uses the plural above one; Finnish uses the partitive for anything but exactly one. */
function pluralForm([one, other], language, amount) {
  if (language === "fi") return amount === 1 ? one : other;
  return amount > 1 ? other : one;
}

/** "450 g", "2 ½ dl", "1,35 kg", "2 burkar". */
export function formatQuantity(amount, unit, language) {
  if (unit === "g" && amount >= 1000) return `${formatNumber(amount / 1000)} kg`;
  if (unit === "ml" && amount >= 1000) return `${formatNumber(amount / 1000)} l`;
  return `${formatNumber(amount)} ${unitLabel(unit, language, amount)}`;
}

// ---------------------------------------------------------------------------
// Names and matching.

/** A name as `[base, form after an amount]`: the Swedish plural, or the Finnish partitive. */
function nameForms(name) {
  if (Array.isArray(name)) return [String(name[0]), String(name[1] ?? name[0])];
  return [String(name), String(name)];
}

/** Every name a meal or ingredient is known by, in any language, for matching the user's words. */
function allNames(value) {
  if (!value) return [];
  if (typeof value === "string" || Array.isArray(value)) return nameForms(value);
  return Object.values(value).flatMap((entry) => nameForms(entry));
}

export function mealNames(meal) {
  return [...new Set([meal.id, ...allNames(meal.name)].map((name) => String(name).toLowerCase()))];
}

export function ingredientNames(ingredient) {
  return [...new Set([ingredient.id, ...allNames(ingredient.name)].filter(Boolean).map((name) => String(name).toLowerCase()))];
}

/**
 * Whether the user's term names this thing. A term matches a whole word or the
 * start or end of one, so "lax" matches "laxfilé" and "ris" matches "jasminris"
 * but not "grisfilé". It errs towards matching: an exclusion that catches an
 * extra dish is safer than one that misses.
 */
export function termMatches(term, names) {
  const wanted = String(term ?? "").toLowerCase().trim();
  if (!wanted) return false;
  return names.some((name) => {
    const text = String(name).toLowerCase();
    if (text === wanted) return true;
    // Several words or an id such as "turkey-pasta": the whole phrase must appear.
    if (/[^\p{L}\p{N}]/u.test(wanted)) return text.includes(wanted);
    return text
      .split(/[^\p{L}\p{N}]+/u)
      .some((word) => word === wanted || (wanted.length >= 3 && (word.startsWith(wanted) || word.endsWith(wanted))));
  });
}

export function localizedMealName(meal, language) {
  if (meal.custom) return meal.name;
  if (typeof meal.name === "string") return meal.name;
  return meal.name?.[language] ?? meal.name?.[DEFAULT_RECIPE_LANGUAGE] ?? meal.id;
}

export function slugify(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

const WATER_NAMES = new Set(["vatten", "vesi", "vettä", "water"]);

/** Tap water ("vatten", "vatten till riset") is part of the recipe, never part of the shopping. */
function isWater(forms) {
  return forms.some((form) => WATER_NAMES.has(form.toLowerCase().split(" ")[0]));
}

// ---------------------------------------------------------------------------
// Language checks for recipes the user supplies.

// Word edges are Unicode-aware: with a plain \b, the "ö" in "2 lökar" would end a word.
const IMPERIAL_TEXT =
  /(?<!\p{L})(?:cups?|oz|ounces?|lbs?|pounds?|tbsps?|tablespoons?|tsps?|teaspoons?|fl\.?\s?oz|fluid ounces?|pints?|quarts?|gallons?|inch(?:es)?|fahrenheit)(?!\p{L})|°\s*F(?!\p{L})|(?<![\p{L}\p{N}])\d+\s?F(?!\p{L})/iu;
const ENGLISH_WORDS = new Set([
  "the", "and", "with", "until", "minutes", "minute", "add", "stir", "cook", "heat", "bake", "preheat", "serve",
  "place", "pour", "into", "then", "season", "chop", "slice", "remove", "oven", "pan", "water", "boil", "simmer",
  "combine", "whisk", "drain", "about", "over", "each", "from", "your", "when", "while", "golden", "tender",
]);
/** English food words that are not also Swedish or Finnish words ("pasta", "salt", "chili" are). */
const ENGLISH_FOOD = new Set([
  "chicken", "beef", "pork", "turkey", "salmon", "fish", "rice", "onion", "onions", "garlic", "pepper", "peppers",
  "flour", "sugar", "butter", "milk", "cream", "cheese", "tomato", "tomatoes", "beans", "potato", "potatoes",
  "carrot", "carrots", "oil", "water", "egg", "eggs", "breast", "breasts", "fillet", "fillets", "ground", "minced",
  "chopped", "fresh", "dried", "sauce", "stock", "broth", "lemon", "spinach", "peas", "mushroom", "mushrooms",
  "bread", "yogurt", "ginger", "parsley", "cilantro", "thyme", "basil", "cumin", "mince", "leaves", "powder",
  "sliced", "diced", "large", "small", "medium", "canned", "with", "and", "of",
]);
const SWEDISH_WORDS = new Set([
  "och", "med", "på", "till", "att", "minuter", "tills", "låt", "rör", "stek", "koka", "hetta", "tillsätt", "skär",
  "häll", "av", "under", "den", "det", "som", "eller", "vatten", "ugnen", "lägg", "värme",
]);
const FINNISH_WORDS = new Set([
  "ja", "kanssa", "minuuttia", "kunnes", "lisää", "keitä", "paista", "sekoita", "kuumenna", "leikkaa", "kaada",
  "anna", "vettä", "uunissa", "noin", "tai", "kun", "sitten", "pannulla", "kattilassa", "lämmöllä", "uuni",
]);

function words(text) {
  return String(text).toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
}

/** "en", "sv", "fi" or null when the text gives no clear signal. */
export function detectRecipeLanguage(text) {
  const tokens = words(text);
  const count = (set) => tokens.filter((token) => set.has(token)).length;
  const en = count(ENGLISH_WORDS);
  const sv = count(SWEDISH_WORDS);
  const fi = count(FINNISH_WORDS);
  if (en >= 2 && en > sv && en > fi) return "en";
  if (sv >= 2 && sv > fi) return "sv";
  if (fi >= 2 && fi > sv) return "fi";
  return null;
}

const LANGUAGE_NAMES = Object.freeze({ sv: "Swedish", fi: "Finnish", en: "English" });

// ---------------------------------------------------------------------------
// Recipes the user supplies.

const CUSTOM_RECIPE_KEYS = Object.freeze([
  "id", "name", "language", "servings", "portions", "minutes", "oven", "ingredients", "steps", "storage",
]);
const CUSTOM_INGREDIENT_KEYS = Object.freeze(["id", "name", "amount", "unit", "section", "staple", "toTaste"]);
const OVEN_KEYS = Object.freeze(["temperature", "unit", "mode"]);
const OVEN_MODES = Object.freeze(["fan", "conventional"]);
/** Numbers a step may keep when the recipe is scaled: times, temperatures, sizes and percentages. */
const UNSCALED_NUMBER =
  /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?(?:\s*[–-]\s*\d+(?:[.,]\d+)?)?\s*(?:minuter|minut|min|sekunder|sek|timmar|timme|tim|minuuttia|minuutin|minuutti|sekuntia|tuntia|tunnin|tunti|°\s*C|°|grader|astetta|cm|mm|%)(?![\p{L}\p{N}])/giu;
const PLACEHOLDER = /\{([^{}]+)\}/g;

/**
 * Validates and converts a recipe the user supplied (through the agent): its
 * own method is kept, its units become metric, and it must already be written
 * in the plan's language. Problems are collected and thrown together, so one
 * reply can ask for everything that is missing.
 * @throws Error for a malformed object, RecipeInputError for missing or unusable content
 */
export function normalizeCustomRecipe(raw, { language = DEFAULT_RECIPE_LANGUAGE } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("A recipe must be a JSON object.");
  rejectUnknownKeys(raw, CUSTOM_RECIPE_KEYS, "recipe");
  const problems = [];
  const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim() : "";
  if (!name) problems.push("The dish needs a name.");
  if (name.length > 80) problems.push("The dish name must be at most 80 characters.");

  const recipeLanguage = raw.language === undefined ? language : parseRecipeLanguage(raw.language);
  if (!recipeLanguage) problems.push(`Unknown recipe language: ${raw.language}. Use sv or fi.`);
  else if (recipeLanguage !== language) {
    problems.push(`The recipe is in ${LANGUAGE_NAMES[recipeLanguage]}, but this week's recipes are in ${LANGUAGE_NAMES[language]}; translate it first.`);
  }

  const servings = raw.servings ?? raw.portions;
  if (!Number.isInteger(servings) || servings < 1 || servings > MAX_SERVINGS) {
    problems.push(servings === undefined ? "How many portions does the recipe make?" : `Servings must be a whole number from 1 to ${MAX_SERVINGS}.`);
  }
  const portions = raw.portions === undefined ? servings : raw.portions;
  if (raw.portions !== undefined && (!Number.isInteger(portions) || portions < 1 || portions > MAX_PORTIONS)) {
    problems.push(`Portions must be a whole number from 1 to ${MAX_PORTIONS}.`);
  }
  if (raw.minutes !== undefined && (!Number.isInteger(raw.minutes) || raw.minutes < 1 || raw.minutes > 600)) {
    problems.push("The cooking time must be whole minutes.");
  }

  const oven = normalizeOven(raw.oven, problems);
  const ingredients = normalizeCustomIngredients(raw.ingredients, problems);
  const ids = new Set(ingredients.map((ingredient) => ingredient.id));

  const steps = Array.isArray(raw.steps)
    ? raw.steps.map((step) => (typeof step === "string" ? step.replace(/\s+/g, " ").trim() : "")).filter(Boolean)
    : [];
  if (steps.length < 2) {
    problems.push("The cooking steps are missing: send the method as numbered steps.");
  } else if (steps.length > MAX_RECIPE_STEPS) {
    problems.push(`The recipe has ${steps.length} steps; the limit is ${MAX_RECIPE_STEPS}.`);
  }
  if (steps.some((step) => step.length > 400)) problems.push("Each step must be at most 400 characters.");
  for (const step of steps) {
    for (const [, key] of step.matchAll(PLACEHOLDER)) {
      if (!ids.has(key) && key !== "oven" && key !== "portions") problems.push(`Step placeholder {${key}} names no ingredient.`);
      if (key === "oven" && !oven) problems.push("A step uses {oven} but the recipe has no oven temperature.");
    }
  }
  // "Häll i 2 dl grädde" or "Skär 2 lökar" would be wrong once the recipe is scaled.
  const fixedAmount = (step) => /\d/.test(step.replace(PLACEHOLDER, "").replace(UNSCALED_NUMBER, ""));
  if (Number.isInteger(servings) && Number.isInteger(portions) && servings !== portions && steps.some(fixedAmount)) {
    problems.push("The steps contain fixed amounts, so they would be wrong after scaling; write them as {ingredient-id} placeholders or keep the recipe's own portions.");
  }

  const storage = typeof raw.storage === "string" && raw.storage.trim() ? raw.storage.replace(/\s+/g, " ").trim().slice(0, 400) : null;
  const texts = [name, ...steps, storage ?? ""];
  if (texts.some((text) => IMPERIAL_TEXT.test(text))) {
    problems.push("Convert the imperial units in the text (cups, oz, lb, °F, inches) to metric; give ingredient amounts in their own fields.");
  }
  const englishNames = ingredients.filter((ingredient) => nameForms(ingredient.name).some((form) => words(form).some((token) => ENGLISH_FOOD.has(token))));
  if (englishNames.length > 0) {
    problems.push(`Translate the ingredient names: ${englishNames.map((ingredient) => nameForms(ingredient.name)[0]).join(", ")}.`);
  }
  if (words(name).some((token) => ENGLISH_FOOD.has(token))) problems.push("Translate the dish name.");
  const detected = detectRecipeLanguage([...steps, storage ?? ""].join(" "));
  if (detected && recipeLanguage && detected !== recipeLanguage) {
    problems.push(`The steps read as ${LANGUAGE_NAMES[detected]}; write them in ${LANGUAGE_NAMES[recipeLanguage]}.`);
  }

  if (problems.length > 0) throw new RecipeInputError([...new Set(problems)], { name: name || null });
  return {
    // Never a catalog id, so a supplied recipe cannot silently replace one of the catalog's.
    id: `custom-${slugify(String(raw.id ?? name).replace(/^custom-/, ""))}`,
    custom: true,
    language: recipeLanguage,
    name,
    servings,
    portions,
    ...(raw.minutes !== undefined ? { minutes: raw.minutes } : {}),
    oven,
    ingredients,
    steps,
    storage,
  };
}

function normalizeOven(raw, problems) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    problems.push("The oven must be { temperature, unit, mode }.");
    return null;
  }
  rejectUnknownKeys(raw, OVEN_KEYS, "oven");
  const unit = String(raw.unit ?? "C").toUpperCase().replace("°", "");
  const value = Number(raw.temperature);
  if (!Number.isFinite(value) || !["C", "F"].includes(unit)) {
    problems.push("Give the oven temperature as a number in °C or °F.");
    return null;
  }
  const celsius = unit === "F" ? fahrenheitToCelsius(value) : Math.round(value);
  if (celsius < 50 || celsius > 300) problems.push(`An oven at ${celsius} °C looks wrong; check the temperature.`);
  if (raw.mode !== undefined && raw.mode !== null && !OVEN_MODES.includes(raw.mode)) {
    problems.push(`The oven mode must be fan or conventional, or left out when the recipe does not say.`);
  }
  return { celsius, mode: OVEN_MODES.includes(raw.mode) ? raw.mode : null };
}

function normalizeCustomIngredients(raw, problems) {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push("The ingredients are missing.");
    return [];
  }
  if (raw.length > MAX_RECIPE_INGREDIENTS) {
    problems.push(`The recipe has ${raw.length} ingredients; the limit is ${MAX_RECIPE_INGREDIENTS}.`);
    return [];
  }
  const result = [];
  const seen = new Set();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Each ingredient must be a JSON object.");
    rejectUnknownKeys(entry, CUSTOM_INGREDIENT_KEYS, "ingredient");
    const forms = typeof entry.name === "string" || Array.isArray(entry.name) ? nameForms(entry.name).map((form) => form.replace(/\s+/g, " ").trim()) : ["", ""];
    if (!forms[0]) {
      problems.push("Every ingredient needs a name.");
      continue;
    }
    const id = entry.id ? slugify(entry.id) : slugify(forms[0]);
    const label = forms[0];
    if (seen.has(id)) {
      problems.push(`${capitalize(label)} is listed twice; give it once with the total amount.`);
      continue;
    }
    seen.add(id);
    const ingredient = {
      id,
      name: forms[0] === forms[1] ? forms[0] : forms,
      section: sectionId(entry.section),
      ...(entry.staple === true ? { staple: true } : {}),
    };
    if (entry.toTaste === true) {
      if (entry.amount !== undefined) problems.push(`${capitalize(label)} has both an amount and "to taste"; keep one.`);
      result.push({ ...ingredient, toTaste: true });
      continue;
    }
    const amount = typeof entry.amount === "string" ? parseAmountText(entry.amount) : Number(entry.amount);
    if (entry.amount === undefined || entry.amount === null || entry.amount === "") {
      problems.push(`How much ${label} is needed? Give an amount, or mark it as to taste if the recipe says so.`);
      continue;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      problems.push(`The amount for ${label} is not a number.`);
      continue;
    }
    const converted = convertSourceAmount(amount, entry.unit);
    if (!converted) {
      problems.push(
        entry.unit
          ? `"${entry.unit}" for ${label} can't be converted reliably; give it in g, dl, msk, tsk or pieces.`
          : `Give a unit for ${label} (g, dl, msk, tsk, st).`,
      );
      continue;
    }
    result.push({ ...ingredient, amount: converted.amount, unit: converted.unit, ...(converted.converted ? { converted: true } : {}) });
  }
  return result;
}

/** "1 1/2", "1½", "0,5", "3/4" → number; anything else → NaN. */
function parseAmountText(text) {
  const value = String(text).trim().replace(",", ".").replace("½", " 1/2").replace("¼", " 1/4").replace("¾", " 3/4").trim();
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(value);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const fraction = /^(\d+)\/(\d+)$/.exec(value);
  if (fraction) return Number(fraction[1]) / Number(fraction[2]);
  return /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
}

/** One reply asking for exactly what a supplied recipe is missing. */
export function formatRecipeClarification(error) {
  const dish = error.recipeName ? `“${error.recipeName}”` : "that dish";
  return [`To plan ${dish} I need:`, ...error.problems.map((problem) => `- ${problem}`), "", "Send what's missing, or tell me to use one of my recipes instead."].join("\n");
}

// ---------------------------------------------------------------------------
// Catalog recipes and eligibility.

/**
 * Why this meal cannot be cooked from its recipe in `language`, or [] when it
 * can. A recipe stored before recipes were required (a name and a shopping
 * list) has no steps or amounts, so it is not planned.
 */
export function recipeIssues(meal, language) {
  const view = languageView(meal, language);
  if (!view) {
    return meal.custom && meal.language && meal.language !== language
      ? [`${capitalize(meal.name)} is written in ${LANGUAGE_NAMES[meal.language]}.`]
      : [`${capitalize(localizedMealName(meal, language))} has no complete recipe.`];
  }
  const issues = [];
  if (!Number.isInteger(meal.servings) || meal.servings < 1) issues.push("no portion count");
  if (!Array.isArray(view.steps) || view.steps.length < 2) issues.push("no cooking steps");
  if (!Array.isArray(meal.ingredients) || meal.ingredients.length === 0) issues.push("no ingredients");
  for (const ingredient of meal.ingredients ?? []) {
    if (ingredient.toTaste) continue;
    if (!(ingredient.amount > 0) || !UNITS[ingredient.unit]) issues.push(`no amount for ${nameForms(ingredientName(ingredient, language))[0]}`);
  }
  return issues.length > 0 ? [`${capitalize(view.name)} has no complete recipe (${issues.join(", ")}).`] : [];
}

/** The meal's text in one language, or null when the meal has none. */
function languageView(meal, language) {
  if (meal.custom || typeof meal.name === "string") {
    if (!meal.custom || meal.language !== language || !Array.isArray(meal.steps)) return null;
    return { name: meal.name, steps: meal.steps, storage: meal.storage ?? null };
  }
  const steps = meal.steps?.[language];
  if (!meal.name?.[language] || !Array.isArray(steps)) return null;
  return { name: meal.name[language], steps, storage: meal.storage?.[language] ?? null };
}

function ingredientName(ingredient, language) {
  const name = ingredient.name;
  if (typeof name === "string" || Array.isArray(name)) return name;
  return name?.[language] ?? name?.[DEFAULT_RECIPE_LANGUAGE] ?? ingredient.id;
}

/**
 * Checks a catalog recipe the way the planner relies on it: both languages,
 * every amount, known units and sections, and placeholders that resolve.
 */
export function catalogRecipeProblems(meal) {
  const problems = [];
  for (const language of RECIPE_LANGUAGES) {
    problems.push(...recipeIssues(meal, language).map((issue) => `${language}: ${issue}`));
    if (!meal.storage?.[language]) problems.push(`${language}: ${meal.id} has no storage advice.`);
    for (const ingredient of meal.ingredients ?? []) {
      if (!ingredient.name?.[language]) problems.push(`${language}: ${meal.id}/${ingredient.id} has no name.`);
    }
    const ids = new Set((meal.ingredients ?? []).map((ingredient) => ingredient.id));
    for (const step of meal.steps?.[language] ?? []) {
      for (const [, key] of step.matchAll(PLACEHOLDER)) {
        if (!ids.has(key) && key !== "portions" && !(key === "oven" && meal.oven)) problems.push(`${language}: ${meal.id} step uses unknown {${key}}.`);
      }
      if (IMPERIAL_TEXT.test(step)) problems.push(`${language}: ${meal.id} step uses an imperial unit.`);
    }
    const detected = detectRecipeLanguage((meal.steps?.[language] ?? []).join(" "));
    if (detected !== language) problems.push(`${language}: ${meal.id} steps read as ${detected ?? "unclear"}.`);
  }
  for (const ingredient of meal.ingredients ?? []) {
    if (!SHOPPING_SECTIONS.includes(ingredient.section) && !isWater(nameForms(ingredientName(ingredient, "sv")))) {
      problems.push(`${meal.id}/${ingredient.id} has an unknown section ${ingredient.section}.`);
    }
  }
  if (!Number.isInteger(meal.minutes)) problems.push(`${meal.id} has no cooking time.`);
  return problems;
}

// ---------------------------------------------------------------------------
// Scaling and the cooking task.

/**
 * The recipe in `language`, scaled to `portions`. Scaled amounts are rounded
 * once here; the cooking task and the shopping list both use these numbers.
 */
export function resolveRecipe(meal, { language, portions }) {
  const view = languageView(meal, language);
  if (!view) throw new Error(`${meal.id} has no recipe in ${language}.`);
  const servings = meal.servings;
  const planned = portions ?? meal.portions ?? servings;
  const factor = planned / servings;
  const ingredients = meal.ingredients.map((ingredient) => {
    const forms = nameForms(ingredientName(ingredient, language));
    const base = {
      id: ingredient.id,
      forms,
      names: ingredientNames(ingredient),
      section: ingredient.section ?? "other",
      ...(ingredient.staple ? { staple: true } : {}),
      ...(isWater(forms) ? { water: true } : {}),
    };
    if (ingredient.toTaste) return { ...base, toTaste: true };
    const amount = factor === 1 ? ingredient.amount : roundAmount(ingredient.amount * factor, ingredient.unit);
    return { ...base, amount, unit: ingredient.unit };
  });
  const byId = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const oven = meal.oven ? ovenText(meal.oven, language) : null;
  const steps = view.steps.map((step) =>
    step.replace(PLACEHOLDER, (match, key) => {
      if (key === "oven" && oven) return oven;
      if (key === "portions") return String(planned);
      const ingredient = byId.get(key);
      return ingredient && !ingredient.toTaste ? formatQuantity(ingredient.amount, ingredient.unit, language) : match;
    }),
  );
  return {
    mealId: meal.id,
    language,
    name: view.name,
    portions: planned,
    minutes: meal.minutes ?? null,
    oven,
    ingredients,
    steps,
    storage: view.storage,
  };
}

function ovenText(oven, language) {
  const mode = oven.mode ? LABELS[language].ovenModes[oven.mode] : null;
  return `${oven.celsius} °C${mode ? ` (${mode})` : ""}`;
}

/** "450 g kycklingfilé", "2 röda paprikor", "1 keltasipuli", "salt efter smak". */
export function ingredientLine(ingredient, language) {
  const [base, other] = ingredient.forms;
  if (ingredient.toTaste) return `${language === "fi" ? other : base} ${LABELS[language].toTaste}`;
  const { amount, unit } = ingredient;
  if (unit === "st" && base !== other) return `${formatNumber(amount)} ${pluralForm([base, other], language, amount)}`;
  const form = language === "fi" ? other : base;
  return `${formatQuantity(amount, unit, language)} ${form}`;
}

/** The Todoist task for one cooking session: the whole recipe, ready to cook from. */
export function cookingTask(recipe, { shopFirst = false } = {}) {
  const labels = LABELS[recipe.language];
  const lines = [recipe.name, `${labels.portions}: ${recipe.portions}`];
  if (recipe.minutes) lines.push(labels.time(recipe.minutes));
  if (recipe.oven) lines.push(`${labels.oven}: ${recipe.oven}`);
  if (shopFirst) lines.push("", labels.shopFirst);
  lines.push("", labels.ingredients, ...recipe.ingredients.map((ingredient) => `- ${ingredientLine(ingredient, recipe.language)}`));
  lines.push("", labels.steps, ...recipe.steps.map((step, index) => `${index + 1}. ${step}`));
  if (recipe.storage) lines.push("", labels.storage, recipe.storage);
  return { content: `${labels.cookingTitle} – ${recipe.name}`, description: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// The grocery list.

/** Store sections in walking order. Staples (oil, salt, spices) are a checklist, not shopping. */
export const SHOPPING_SECTIONS = Object.freeze(["produce", "bread", "meat-fish", "dairy", "dry-goods", "canned", "frozen", "other"]);
const SECTION_ALIASES = Object.freeze({
  protein: "meat-fish",
  vegetables: "produce",
  fruit: "produce",
  carbs: "dry-goods",
  "dairy-or-alternatives": "dairy",
  pantry: "dry-goods",
  snacks: "other",
  breakfast: "other",
  "backup-meals": "other",
});

/** A store section id; the grocery sections of plans made before this version map onto it. */
export function sectionId(value) {
  const id = String(value ?? "other").toLowerCase();
  if (SHOPPING_SECTIONS.includes(id)) return id;
  return SECTION_ALIASES[id] ?? "other";
}

/**
 * The one grocery list for the week, from the scaled recipes only, plus what
 * the user explicitly added, minus what they said they already have. The same
 * ingredient in several dishes is one line; amounts in the same unit are added
 * up exactly, and volumes in different units are merged when the total is a
 * clean amount, otherwise shown as "1 dl + 2 msk".
 */
export function buildShoppingList({ dishes, extras = [], removed = [], language }) {
  const labels = LABELS[language];
  const lines = new Map();
  const removedNames = [];
  const isRemoved = (names) => removed.some((term) => termMatches(term, names));

  for (const dish of dishes) {
    for (const ingredient of dish.recipe.ingredients) {
      if (ingredient.water) continue;
      if (isRemoved(ingredient.names)) {
        if (!removedNames.includes(capitalize(ingredient.forms[0]))) removedNames.push(capitalize(ingredient.forms[0]));
        continue;
      }
      const key = slugify(ingredient.forms[0]);
      const line = lines.get(key) ?? {
        key,
        name: capitalize(ingredient.forms[0]),
        section: ingredient.staple ? "staples" : sectionId(ingredient.section),
        amounts: {},
        toTaste: false,
        for: [],
      };
      if (ingredient.toTaste) line.toTaste = true;
      else line.amounts[ingredient.unit] = exact((line.amounts[ingredient.unit] ?? 0) + ingredient.amount);
      if (!line.for.includes(dish.mealId)) line.for.push(dish.mealId);
      lines.set(key, line);
    }
  }

  for (const item of extras) {
    const key = slugify(item.name);
    const existing = lines.get(key);
    // An item already on the list needs no second line unless the user gave its own amount.
    if (existing && !item.quantity) {
      existing.user = true;
      continue;
    }
    const line = { key: existing ? `${key}-extra` : key, name: capitalize(item.name), section: sectionId(item.section), amounts: {}, toTaste: false, for: [], user: true };
    if (item.quantity) line.quantity = item.quantity;
    lines.set(line.key, line);
  }

  const describe = (line) => {
    if (line.quantity) return line.quantity;
    const parts = mergeAmounts(line.amounts).map(([unit, amount]) => formatQuantity(amount, unit, language));
    if (line.toTaste && parts.length === 0) return labels.asNeeded;
    return parts.length > 0 ? parts.join(" + ") : null;
  };
  const sections = [...SHOPPING_SECTIONS, "staples"]
    .map((id) => ({
      id,
      label: id === "staples" ? labels.staples : labels.sections[id],
      items: [...lines.values()]
        .filter((line) => line.section === id)
        .map((line) => ({
          name: line.name,
          quantity: describe(line),
          ...(Object.keys(line.amounts).length > 0 ? { amounts: mergeAmounts(line.amounts).map(([unit, amount]) => ({ amount, unit })) } : {}),
          ...(line.for.length > 0 ? { for: line.for } : {}),
          ...(line.user ? { user: true } : {}),
        })),
    }))
    .filter((section) => section.items.length > 0);

  return {
    date: null,
    language,
    dishes: dishes.map((dish) => ({ mealId: dish.mealId, name: dish.recipe.name, portions: dish.recipe.portions, date: dish.date })),
    sections,
    removed: removedNames,
    itemCount: sections.reduce((total, section) => total + section.items.length, 0),
  };
}

/** Exact sums per unit; volumes merge into the largest unit only when that is a clean amount. */
function mergeAmounts(amounts) {
  const entries = Object.entries(amounts).sort((a, b) => RECIPE_UNITS.indexOf(a[0]) - RECIPE_UNITS.indexOf(b[0]));
  const volumes = entries.filter(([unit]) => UNITS[unit].dimension === "volume");
  if (volumes.length > 1) {
    const ml = volumes.reduce((total, [unit, amount]) => total + amount * UNITS[unit].ml, 0);
    const largest = volumes.map(([unit]) => unit).sort((a, b) => UNITS[b].ml - UNITS[a].ml)[0];
    const merged = exact(ml / UNITS[largest].ml);
    if (Number.isInteger(merged * 4)) {
      return [...entries.filter(([unit]) => UNITS[unit].dimension !== "volume"), [largest, merged]];
    }
  }
  return entries;
}

function exact(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** The single grocery task: which dishes it is for, the list by store section, then staples to check. */
export function shoppingTask(shopping, { weekdayOf }) {
  const labels = LABELS[shopping.language];
  const lines = [labels.dishesHeading];
  for (const dish of shopping.dishes) lines.push(`- ${labels.dishLine(dish.name, dish.portions, weekdayOf(dish.date, shopping.language))}`);
  for (const section of shopping.sections) {
    lines.push("", section.label, ...section.items.map((item) => `- ${item.name}${item.quantity ? ` – ${item.quantity}` : ""}`));
  }
  if (shopping.removed.length > 0) lines.push("", labels.removed, ...shopping.removed.map((name) => `- ${name}`));
  return { content: labels.shoppingTitle, description: lines.join("\n") };
}

export function shoppingTaskTitle(language) {
  return LABELS[language].shoppingTitle;
}

export function cookingTaskPrefix(language) {
  return LABELS[language].cookingTitle;
}

// ---------------------------------------------------------------------------
// Fixed wording.

const LABELS = Object.freeze({
  sv: Object.freeze({
    cookingTitle: "Matlagning",
    shoppingTitle: "Matinköp för veckan",
    portions: "Portioner",
    time: (minutes) => `Tillagningstid: cirka ${minutes} minuter`,
    oven: "Ugn",
    ovenModes: Object.freeze({ fan: "varmluft", conventional: "över- och undervärme" }),
    ingredients: "Ingredienser",
    steps: "Gör så här",
    storage: "Förvaring",
    toTaste: "efter smak",
    asNeeded: "efter behov",
    shopFirst: "Handla först: inköpslistan finns i uppgiften Matinköp för veckan.",
    dishesHeading: "Till veckans matlagning",
    dishLine: (name, portions, weekday) => `${name} – ${portions} ${portions === 1 ? "portion" : "portioner"} (${weekday})`,
    staples: "Basvaror – kolla att du har hemma",
    removed: "Inte med – du har redan hemma",
    sections: Object.freeze({
      produce: "Frukt och grönt",
      bread: "Bröd",
      "meat-fish": "Kött, fågel och fisk",
      dairy: "Mejeri och ägg",
      "dry-goods": "Torrvaror",
      canned: "Konserver",
      frozen: "Fryst",
      other: "Övrigt",
    }),
  }),
  fi: Object.freeze({
    cookingTitle: "Ruoanlaitto",
    shoppingTitle: "Viikon ruokaostokset",
    portions: "Annokset",
    time: (minutes) => `Valmistusaika: noin ${minutes} minuuttia`,
    oven: "Uuni",
    ovenModes: Object.freeze({ fan: "kiertoilma", conventional: "ylä- ja alalämpö" }),
    ingredients: "Ainekset",
    steps: "Valmistus",
    storage: "Säilytys",
    toTaste: "maun mukaan",
    asNeeded: "tarpeen mukaan",
    shopFirst: "Käy ensin kaupassa: ostoslista on tehtävässä Viikon ruokaostokset.",
    dishesHeading: "Viikon ruoanlaittoa varten",
    dishLine: (name, portions, weekday) => `${name} – ${portions} ${portions === 1 ? "annos" : "annosta"} (${weekday})`,
    staples: "Perustarvikkeet – tarkista, että ne löytyvät kotoa",
    removed: "Ei listalla – löytyy jo kotoa",
    sections: Object.freeze({
      produce: "Hedelmät ja vihannekset",
      bread: "Leipä",
      "meat-fish": "Liha, broileri ja kala",
      dairy: "Maitotuotteet ja kananmunat",
      "dry-goods": "Kuivatuotteet",
      canned: "Säilykkeet",
      frozen: "Pakasteet",
      other: "Muut",
    }),
  }),
});

const WEEKDAYS = Object.freeze({
  sv: ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"],
  fi: ["maanantai", "tiistai", "keskiviikko", "torstai", "perjantai", "lauantai", "sunnuntai"],
});

/** "måndag" or "maanantai" for a Monday-based weekday index. */
export function localWeekday(index, language) {
  return WEEKDAYS[language][index];
}

// ---------------------------------------------------------------------------

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown field in ${label}: ${key}. Allowed: ${allowed.join(", ")}.`);
  }
}

function capitalize(value) {
  const text = String(value);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
