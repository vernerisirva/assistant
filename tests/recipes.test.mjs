import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RECIPE_LANGUAGES,
  RecipeInputError,
  buildShoppingList,
  catalogRecipeProblems,
  convertSourceAmount,
  cookingTask,
  detectRecipeLanguage,
  fahrenheitToCelsius,
  formatQuantity,
  englishNoteWords,
  formatRecipeClarification,
  normalizeCustomRecipe,
  parseRecipeLanguage,
  recipeIssues,
  resolveRecipe,
  roundAmount,
  termMatches,
} from "../scripts/lib/recipes.mjs";
import { TODOIST_DESCRIPTION_MAX_LENGTH } from "../scripts/lib/todoist-create.mjs";

const food = JSON.parse(readFileSync("config/food-planning.json", "utf8"));
const meal = (id) => food.weeklyMealPlan.meals.find((candidate) => candidate.id === id);
const IMPERIAL = /\b(cups?|oz|ounces?|lbs?|pounds?|tbsp|tsp|fahrenheit)\b|°F/i;
const ENGLISH = /\b(the|and|with|until|minutes|chicken|rice|salmon|onion|garlic|stir|cook|heat|bake)\b/i;

/** An English recipe as the agent passes it after translating the text: the source units are left to the planner. */
const TRANSLATED_FROM_ENGLISH = Object.freeze({
  name: "Ugnsbakad kyckling med citron",
  servings: 4,
  minutes: 50,
  oven: { temperature: 400, unit: "F", mode: "fan" },
  ingredients: [
    { name: "kycklinglårfilé", amount: 2, unit: "lb", section: "meat-fish" },
    { name: "vetemjöl", amount: 0.5, unit: "cup", section: "dry-goods" },
    { name: "matlagningsgrädde", amount: 1, unit: "cup", section: "dairy" },
    { name: "olivolja", amount: 2, unit: "tbsp", section: "dry-goods", staple: true },
    { name: ["citron", "citroner"], amount: 1, unit: "piece", section: "produce" },
    { name: "riven parmesan", amount: 3, unit: "oz", section: "dairy" },
    { name: "salt", amount: 1, unit: "tsp", staple: true },
    { name: "svartpeppar", toTaste: true, staple: true },
  ],
  steps: [
    "Sätt ugnen på {oven}.",
    "Vänd kycklingen i mjölet och lägg den i en ugnsform.",
    "Vispa ihop grädden, oljan, saltet och det rivna citronskalet och häll det över kycklingen.",
    "Strö över parmesanen och baka mitt i ugnen i 35 minuter, tills kycklingen är genomstekt.",
  ],
  storage: "Ställ in i kylen inom 2 timmar och ät inom 3 dagar.",
});

describe("recipe units", () => {
  it("converts imperial amounts by fixed factors, rounded the way a cook writes them", () => {
    assert.deepEqual(convertSourceAmount(1, "lb"), { amount: 450, unit: "g", converted: true });
    assert.deepEqual(convertSourceAmount(14.5, "oz"), { amount: 410, unit: "g", converted: true });
    assert.deepEqual(convertSourceAmount(3, "lbs"), { amount: 1350, unit: "g", converted: true });
    assert.deepEqual(convertSourceAmount(8, "fl oz"), { amount: 2.25, unit: "dl", converted: true });
    assert.deepEqual(convertSourceAmount(1, "US quart"), { amount: 9.5, unit: "dl", converted: true });
    assert.deepEqual(convertSourceAmount(1, "us pint"), { amount: 4.5, unit: "dl", converted: true });
    assert.deepEqual(convertSourceAmount(1, "UK pint"), { amount: 5.5, unit: "dl", converted: true });
  });

  it("keeps volume as volume: a cup of flour and a cup of water are both dl, never grams", () => {
    assert.deepEqual(convertSourceAmount(2, "cups"), { amount: 4.5, unit: "dl", converted: true });
    assert.deepEqual(convertSourceAmount(2, "metric cups"), { amount: 5, unit: "dl", converted: true });
    // A quarter cup reads better as spoons than as ½ dl, and is closer.
    assert.deepEqual(convertSourceAmount(0.25, "cup"), { amount: 4, unit: "msk", converted: true });
    assert.deepEqual(convertSourceAmount(2, "tbsp"), { amount: 2, unit: "msk", converted: false });
    assert.deepEqual(convertSourceAmount(1, "tsp"), { amount: 1, unit: "tsk", converted: false });
  });

  it("maps Swedish and Finnish units to one another and keeps a can a can", () => {
    assert.deepEqual(convertSourceAmount(2, "rkl"), { amount: 2, unit: "msk", converted: false });
    assert.deepEqual(convertSourceAmount(1, "tl"), { amount: 1, unit: "tsk", converted: false });
    assert.deepEqual(convertSourceAmount(1, "can"), { amount: 1, unit: "burk", converted: false });
    assert.deepEqual(convertSourceAmount(1.5, "kg"), { amount: 1500, unit: "g", converted: true });
  });

  it("refuses units it cannot convert reliably", () => {
    // A pint, quart or gallon is a fifth bigger in a British recipe than in an American one.
    for (const unit of ["handful", "stick", "sprig", "", undefined, "slice", "pint", "quart", "gallon"]) assert.equal(convertSourceAmount(1, unit), null, String(unit));
    assert.equal(convertSourceAmount(0, "g"), null);
  });

  it("converts °F to °C to the nearest 5 degrees", () => {
    assert.equal(fahrenheitToCelsius(350), 175);
    assert.equal(fahrenheitToCelsius(325), 165);
    assert.equal(fahrenheitToCelsius(375), 190);
    assert.equal(fahrenheitToCelsius(425), 220);
  });

  it("rounds scaled amounts sensibly and shows them with Swedish or Finnish units", () => {
    assert.equal(roundAmount(453.592, "g"), 450);
    assert.equal(roundAmount(133.3, "g"), 135);
    assert.equal(roundAmount(1361, "g"), 1350);
    assert.equal(roundAmount(3.333, "dl"), 3.5);
    assert.equal(roundAmount(1.333, "st"), 1.5);
    assert.equal(formatQuantity(1350, "g", "sv"), "1,35 kg");
    assert.equal(formatQuantity(2.5, "dl", "sv"), "2 ½ dl");
    assert.equal(formatQuantity(0.5, "tsk", "sv"), "½ tsk");
    assert.equal(formatQuantity(0.5, "tsk", "fi"), "½ tl");
    assert.equal(formatQuantity(2, "msk", "fi"), "2 rkl");
    assert.equal(formatQuantity(2, "st", "fi"), "2 kpl");
    assert.equal(formatQuantity(2, "burk", "sv"), "2 burkar");
    assert.equal(formatQuantity(2, "burk", "fi"), "2 tölkkiä");
    assert.equal(formatQuantity(1, "burk", "fi"), "1 tölkki");
  });

  it("reads the recipe language from the user's words", () => {
    assert.equal(parseRecipeLanguage("finska"), "fi");
    assert.equal(parseRecipeLanguage("på finska"), "fi");
    assert.equal(parseRecipeLanguage("Suomi"), "fi");
    assert.equal(parseRecipeLanguage("svenska"), "sv");
    assert.equal(parseRecipeLanguage("sv"), "sv");
    assert.equal(parseRecipeLanguage("German"), null);
    assert.deepEqual(RECIPE_LANGUAGES, ["sv", "fi"]);
  });
});

describe("the recipe catalog", () => {
  it("has a complete recipe for every dish in both Swedish and Finnish", () => {
    assert.ok(food.weeklyMealPlan.meals.length >= 4);
    for (const dish of food.weeklyMealPlan.meals) {
      assert.deepEqual(catalogRecipeProblems(dish), [], dish.id);
      for (const language of RECIPE_LANGUAGES) assert.deepEqual(recipeIssues(dish, language), [], `${dish.id} ${language}`);
    }
  });

  it("passes its own language checks, so the checks do not refuse ordinary Swedish or Finnish", () => {
    for (const dish of food.weeklyMealPlan.meals) {
      for (const language of RECIPE_LANGUAGES) assert.deepEqual(englishNoteWords(dish.storage[language]), [], `${dish.id} ${language}`);
    }
  });

  it("keeps no breakfast, snack or backup top-up lists", () => {
    for (const key of ["breakfast", "snacks", "backup"]) assert.equal(food.weeklyMealPlan[key], undefined, key);
    assert.doesNotMatch(JSON.stringify(food.groceryPlanning), /snack|breakfast|backup/);
  });

  it("writes a Swedish cooking task with the whole recipe, in metric units", () => {
    const task = cookingTask(resolveRecipe(meal("salmon-potatoes-veg"), { language: "sv", portions: 2 }));
    const lines = task.description.split("\n");

    assert.equal(task.content, "Matlagning – Ugnsbakad lax med potatis och haricots verts");
    assert.deepEqual(lines.slice(0, 4), [
      "Ugnsbakad lax med potatis och haricots verts",
      "Portioner: 2",
      "Tillagningstid: cirka 40 minuter",
      "Ugn: 200 °C (över- och undervärme)",
    ]);
    assert.ok(lines.includes("Ingredienser") && lines.includes("Gör så här") && lines.includes("Förvaring"));
    for (const line of ["- 250 g laxfilé", "- 500 g fast potatis", "- 200 g haricots verts", "- 1 citron", "- 2 msk olivolja", "- ½ tsk malen svartpeppar"]) {
      assert.ok(lines.includes(line), line);
    }
    const steps = lines.filter((line) => /^\d+\. /.test(line));
    assert.equal(steps.length, meal("salmon-potatoes-veg").steps.sv.length);
    assert.equal(steps[0], "1. Sätt ugnen på 200 °C (över- och undervärme).");
    assert.doesNotMatch(task.description, IMPERIAL);
    assert.doesNotMatch(task.description, ENGLISH);
    assert.doesNotMatch(task.description, /\{[^}]+\}/, "every placeholder is filled in");
  });

  it("writes the same recipe in Finnish, with Finnish units and word forms", () => {
    const task = cookingTask(resolveRecipe(meal("chicken-rice-veg"), { language: "fi", portions: 3 }));
    const lines = task.description.split("\n");

    assert.equal(task.content, "Ruoanlaitto – Kana-kasvispannu ja riisi");
    assert.deepEqual(lines.slice(0, 3), ["Kana-kasvispannu ja riisi", "Annokset: 3", "Valmistusaika: noin 35 minuuttia"]);
    for (const line of [
      "Ainekset",
      "Valmistus",
      "Säilytys",
      "- 450 g broilerin rintafileetä",
      "- 2 ½ dl jasmiiniriisiä",
      "- 2 punaista paprikaa",
      "- 1 keltasipuli",
      "- 2 rkl rypsiöljyä",
      "- ½ tl jauhettua mustapippuria",
    ]) {
      assert.ok(lines.includes(line), line);
    }
    assert.match(task.description, /\n1\. Huuhtele riisi kylmällä vedellä\. Kiehauta 3 ¾ dl vettä,/);
    assert.doesNotMatch(task.description, /Ingredienser|Gör så här|msk|tsk|\bst\b/);
    assert.equal(detectRecipeLanguage(task.description), "fi");
  });

  it("scales every amount, including amounts inside the steps, to the planned portions", () => {
    const recipe = resolveRecipe(meal("beef-chili-rice"), { language: "sv", portions: 4 });
    const amount = (id) => recipe.ingredients.find((ingredient) => ingredient.id === id);

    assert.equal(recipe.portions, 4);
    assert.deepEqual([amount("notfars").amount, amount("notfars").unit], [530, "g"]);
    assert.deepEqual([amount("jasminris").amount, amount("jasminris").unit], [3.5, "dl"]);
    assert.deepEqual([amount("gul-lok").amount, amount("gul-lok").unit], [1.5, "st"]);
    const task = cookingTask(recipe);
    assert.match(task.description, /\nPortioner: 4\n/);
    assert.match(task.description, /- 1 ½ burkar krossade tomater \(400 g\)/);
    assert.match(task.description, /koka upp 5 dl vatten, tillsätt riset/);
    assert.match(task.description, /i 4 matlådor\./);
  });
});

describe("recipes the user supplies", () => {
  it("converts an English recipe's units after translation: lb to g, cups to dl, tbsp to msk, °F to °C", () => {
    const recipe = normalizeCustomRecipe(TRANSLATED_FROM_ENGLISH, { language: "sv" });
    const task = cookingTask(resolveRecipe(recipe, { language: "sv" }));

    assert.match(recipe.id, /^custom-/);
    assert.deepEqual(recipe.oven, { celsius: 205, mode: "fan" });
    for (const line of ["- 910 g kycklinglårfilé", "- 1 ¼ dl vetemjöl", "- 2 ¼ dl matlagningsgrädde", "- 2 msk olivolja", "- 1 citron", "- 85 g riven parmesan", "- 1 tsk salt", "- svartpeppar efter smak"]) {
      assert.ok(task.description.split("\n").includes(line), line);
    }
    assert.match(task.description, /\nUgn: 205 °C \(varmluft\)\n/);
    assert.match(task.description, /\n1\. Sätt ugnen på 205 °C \(varmluft\)\.\n/);
    assert.doesNotMatch(task.description, IMPERIAL);
    // The source's method is kept: four steps in its order.
    assert.equal(task.description.split("\n").filter((line) => /^\d+\. /.test(line)).length, 4);
  });

  it("states a time only when the recipe gives one, and gives general storage advice when it has none", () => {
    const { minutes, storage, ...bare } = TRANSLATED_FROM_ENGLISH;
    for (const [language, heading, advice] of [
      ["sv", "Förvaring", /^Kyl ned maten skyndsamt och förvara den i kylen\./],
      ["fi", "Säilytys", /^Jäähdytä ruoka nopeasti ja säilytä se jääkaapissa\./],
    ]) {
      const source = language === "fi"
        ? { ...bare, name: "Sitruunakana", ingredients: [{ name: ["broilerin reisifilee", "broilerin reisifileetä"], amount: 2, unit: "lb", section: "meat-fish" }], steps: ["Kuumenna uuni lämpötilaan {oven}.", "Paista broileria uunissa noin 35 minuuttia, kunnes se on kypsää."] }
        : bare;
      const lines = cookingTask(resolveRecipe(normalizeCustomRecipe(source, { language }), { language })).description.split("\n");
      assert.ok(!lines.some((line) => /^(Tillagningstid|Valmistusaika):/.test(line)), "no invented time");
      assert.match(lines[lines.indexOf(heading) + 1], advice);
    }
  });

  it("refuses a recipe that is still English, and says what to translate", () => {
    const english = {
      ...TRANSLATED_FROM_ENGLISH,
      name: "Lemon chicken",
      ingredients: [{ name: "chicken thighs", amount: 2, unit: "lb" }, { name: "flour", amount: 0.5, unit: "cup" }],
      steps: ["Preheat the oven to 400°F.", "Toss the chicken with the flour and bake for 35 minutes until golden."],
    };
    const error = captureRecipeError(() => normalizeCustomRecipe(english, { language: "sv" }));
    assert.ok(error.problems.some((problem) => /Translate the ingredient names: chicken thighs, flour/.test(problem)));
    assert.ok(error.problems.some((problem) => /Translate the dish name/.test(problem)));
    assert.ok(error.problems.some((problem) => /imperial units/.test(problem)));
    assert.ok(error.problems.some((problem) => /steps read as English/.test(problem)));
  });

  it("refuses English storage advice, however short", () => {
    const error = captureRecipeError(() => normalizeCustomRecipe({ ...TRANSLATED_FROM_ENGLISH, storage: "Store in fridge." }, { language: "sv" }));
    assert.deepEqual(error.problems, ["Translate the storage advice."]);
  });

  it(`allows "to taste" only for seasoning; anything else needs an amount`, () => {
    const withIngredient = (ingredient) => normalizeCustomRecipe({ ...TRANSLATED_FROM_ENGLISH, ingredients: [...TRANSLATED_FROM_ENGLISH.ingredients, ingredient] }, { language: "sv" });
    const error = captureRecipeError(() => withIngredient({ name: "kyckling", toTaste: true }));
    assert.deepEqual(error.problems, ['How much kyckling is needed? "To taste" is only for seasoning such as salt, pepper or herbs.']);
    for (const seasoning of ["flingsalt", "färsk koriander", "chiliflakes", "olivolja till stekning"]) {
      assert.ok(withIngredient({ name: seasoning, toTaste: true }).ingredients.some((ingredient) => ingredient.toTaste && ingredient.name === seasoning), seasoning);
    }
  });

  it("refuses a Swedish recipe for a Finnish week instead of mixing languages", () => {
    const error = captureRecipeError(() => normalizeCustomRecipe(TRANSLATED_FROM_ENGLISH, { language: "fi" }));
    assert.ok(error.problems.some((problem) => /steps read as Swedish; write them in Finnish/.test(problem)));
  });

  it("asks for missing amounts, units, steps and portions instead of inventing them", () => {
    const error = captureRecipeError(() =>
      normalizeCustomRecipe(
        {
          name: "Mormors köttfärssås",
          ingredients: [
            { name: "nötfärs", amount: 500, unit: "g" },
            { name: "krossade tomater" },
            { name: "persilja", amount: 1, unit: "handful" },
          ],
          steps: ["Bryn färsen."],
        },
        { language: "sv" },
      ),
    );
    assert.deepEqual(error.problems, [
      "How many portions does the recipe make?",
      "How much krossade tomater is needed? Give an amount, or mark it as to taste if the recipe says so.",
      '"handful" for persilja can\'t be converted reliably; give it in g, dl, msk, tsk or pieces.',
      "The cooking steps are missing: send the method as numbered steps.",
    ]);
    assert.equal(
      formatRecipeClarification(error),
      [
        "To plan “Mormors köttfärssås” I need:",
        ...error.problems.map((problem) => `- ${problem}`),
        "",
        "Send what's missing, or tell me to use one of my recipes instead.",
      ].join("\n"),
    );
  });

  it("refuses to scale steps that carry fixed amounts", () => {
    const recipe = {
      ...TRANSLATED_FROM_ENGLISH,
      portions: 2,
      steps: ["Sätt ugnen på {oven}.", "Häll 2 dl grädde över kycklingen och baka i 35 minuter."],
    };
    const error = captureRecipeError(() => normalizeCustomRecipe(recipe, { language: "sv" }));
    assert.ok(error.problems.some((problem) => /fixed amounts, so they would be wrong after scaling/.test(problem)));
  });

  it("when scaling, lets steps keep only times, temperatures and sizes as numbers", () => {
    const scaled = (steps) => normalizeCustomRecipe({ ...TRANSLATED_FROM_ENGLISH, portions: 2, steps }, { language: "sv" });
    const recipe = scaled(["Sätt ugnen på {oven}.", "Skär kycklingen i bitar på 3 cm och baka i 30–35 minuter vid 200 °C.", "Låt vila i 5 min och fördela i {portions} lådor."]);
    assert.match(cookingTask(resolveRecipe(recipe, { language: "sv" })).description, /\n- 460 g kycklinglårfilé\n[\s\S]*fördela i 2 lådor\./);
    for (const step of ["Skär 2 lökar i klyftor och lägg dem runt kycklingen.", "Fördela i 4 matlådor."]) {
      const error = captureRecipeError(() => scaled(["Sätt ugnen på {oven}.", step]));
      assert.ok(error.problems.some((problem) => /fixed amounts/.test(problem)), step);
    }
  });

  it("keeps a long recipe whole: every ingredient and step reaches the task, within Todoist's limit", () => {
    const recipe = normalizeCustomRecipe(
      {
        name: "Stor långkokt gryta",
        servings: 6,
        minutes: 180,
        ingredients: Array.from({ length: 25 }, (_, index) => ({ name: `ingrediens nummer ${index + 1}`, amount: index + 1, unit: "dl", section: "other" })),
        steps: Array.from({ length: 15 }, (_, index) => `Steg ${index + 1}: rör om i grytan och låt den sjuda under lock på svag värme i 10 minuter till.`),
        storage: "Ställ in i kylen inom 2 timmar och ät inom 3 dagar.",
      },
      { language: "sv" },
    );
    const task = cookingTask(resolveRecipe(recipe, { language: "sv" }));
    for (let index = 1; index <= 25; index += 1) assert.match(task.description, new RegExp(`- ${index} dl ingrediens nummer ${index}\\n`));
    for (let index = 1; index <= 15; index += 1) assert.match(task.description, new RegExp(`\\n${index}\\. Steg ${index}: `));
    assert.ok(task.description.length < TODOIST_DESCRIPTION_MAX_LENGTH);
  });
});

describe("the grocery list", () => {
  const dish = (id, portions, date) => ({ mealId: id, date, recipe: resolveRecipe(meal(id), { language: "sv", portions }) });

  it("adds up the same ingredient across dishes exactly, as one line", () => {
    const list = buildShoppingList({ dishes: [dish("chicken-rice-veg", 3, "2026-10-12"), dish("beef-chili-rice", 3, "2026-10-15")], language: "sv" });
    const item = (name) => list.sections.flatMap((section) => section.items).find((entry) => entry.name === name);

    assert.equal(item("Jasminris").quantity, "5 dl");
    assert.equal(item("Gul lök").quantity, "2 st");
    assert.equal(item("Vitlöksklyfta").quantity, "4 st");
    assert.equal(item("Röd paprika").quantity, "3 st");
    assert.equal(item("Rapsolja").quantity, "3 msk");
    assert.deepEqual(item("Jasminris").for, ["chicken-rice-veg", "beef-chili-rice"]);
    assert.equal(list.sections.at(-1).id, "staples");
    assert.equal(list.sections.flatMap((section) => section.items).filter((entry) => entry.name === "Jasminris").length, 1);
    assert.equal(item("Vatten"), undefined, "tap water is never on the list");
  });

  it("merges volumes in different units only when the total is clean, and shows the parts otherwise", () => {
    const custom = (amount, unit) =>
      normalizeCustomRecipe(
        { name: `Sås ${unit}`, servings: 2, ingredients: [{ name: "rapsolja", amount, unit, staple: true }], steps: ["Värm oljan i en panna.", "Låt den bli het och stek grönsakerna."] },
        { language: "sv" },
      );
    const asDish = (recipe) => ({ mealId: recipe.id, date: "2026-10-12", recipe: resolveRecipe(recipe, { language: "sv" }) });
    const oil = (list) => list.sections.flatMap((section) => section.items).find((entry) => entry.name === "Rapsolja").quantity;

    assert.equal(oil(buildShoppingList({ dishes: [asDish(custom(1, "dl")), asDish(custom(2, "msk"))], language: "sv" })), "1 dl + 2 msk");
    assert.equal(oil(buildShoppingList({ dishes: [asDish(custom(1, "dl")), asDish(custom(10, "msk"))], language: "sv" })), "2 ½ dl");
  });

  it("matches the user's words in any language, by word start or end", () => {
    assert.ok(termMatches("lax", ["laxfilé"]));
    assert.ok(termMatches("salmon", ["salmon fillet"]));
    assert.ok(termMatches("ris", ["jasminris"]));
    assert.ok(!termMatches("ris", ["grisfilé"]));
    assert.ok(termMatches("turkey-pasta", ["turkey-pasta"]));
  });
});

function captureRecipeError(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof RecipeInputError, error.message);
    return error;
  }
  assert.fail("expected a RecipeInputError");
}
