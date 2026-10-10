import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWeeklyPlanCli } from "../scripts/weekly-plan.mjs";
import { createWeeklyPlanStore, versionEntry } from "../scripts/lib/weekly-plan-store.mjs";
import { applyWeeklyPlanChanges, buildInitialPlanInputs, buildWeeklyPlan, digestPlan } from "../scripts/lib/weekly-plan.mjs";
import { applyGolfChanges, emptyGolfInputs } from "../scripts/lib/golf-week.mjs";
import { ingredientLine, resolveRecipe } from "../scripts/lib/recipes.mjs";
import { GOLF_ANSWER, answerJson } from "./fixtures/golf-answers.mjs";

const config = JSON.parse(readFileSync("config/weekly-plan.json", "utf8"));
const food = JSON.parse(readFileSync("config/food-planning.json", "utf8"));
const schedules = JSON.parse(readFileSync("config/schedules.json", "utf8"));
const LEGACY_PLAN = readFileSync("tests/fixtures/legacy-weekly-plan.json", "utf8");
const LEGACY_SHOW = readFileSync("tests/fixtures/legacy-weekly-plan-show.txt", "utf8");
const WEEK = "2026-09-28";
const VOLUME_ML = Object.freeze({ ml: 1, dl: 100, l: 1000, krm: 1, tsk: 5, msk: 15 });
const COOKING_PREFIX = Object.freeze({ sv: "Matlagning", fi: "Ruoanlaitto" });
const TOP_UP = /top-?up|backup|snack|breakfast|frukost|mellanmål|skyr|cottage cheese|frozen berries|apples|tinned tuna|wholegrain bread|of your choice|cook a simple|\bcook:/i;

function planFor(input = {}, { golf = GOLF_ANSWER } = {}) {
  const inputs = buildInitialPlanInputs(input, { config, food, weekStart: WEEK });
  if (golf) inputs.golf = applyGolfChanges(emptyGolfInputs(config), golf, { weekStart: WEEK }).golf;
  return { inputs, plan: buildWeeklyPlan(inputs, { config, food }) };
}

function revise(previous, changes) {
  const { inputs, summary } = applyWeeklyPlanChanges(previous.inputs, previous.plan, changes, { config, food });
  return { inputs, summary, plan: buildWeeklyPlan(inputs, { config, food }) };
}

const opsOf = (plan, activity) => plan.operations.filter((operation) => operation.activity === activity);
const shoppingItems = (plan) => plan.shopping.sections.flatMap((section) => section.items.map((item) => ({ ...item, section: section.id })));

/** Amount per name and dimension: grams, millilitres, or the count unit. */
function totals(entries) {
  const result = new Map();
  for (const { name, amount, unit } of entries) {
    if (amount === undefined) continue;
    const [key, value] = VOLUME_ML[unit] ? ["ml", amount * VOLUME_ML[unit]] : [unit, amount];
    const byUnit = result.get(name) ?? new Map();
    byUnit.set(key, Math.round(((byUnit.get(key) ?? 0) + value) * 1e6) / 1e6);
    result.set(name, byUnit);
  }
  return result;
}

/**
 * The invariants the user asked for, checked on any plan: every dish has its
 * own cooking task with the whole recipe, every grocery comes from a planned
 * dish or the user, and the amounts on the list are the recipes' amounts.
 */
function assertFoodInvariants(plan, { removed = [] } = {}) {
  const language = plan.food.language;
  const cooking = opsOf(plan, "mealPrep");
  assert.equal(cooking.length, plan.food.prep.length, "one cooking task per planned dish, and none without a dish");
  for (const session of plan.food.prep) {
    const operation = cooking.find((candidate) => candidate.date === session.date);
    assert.ok(operation, `no cooking task on ${session.date}`);
    assert.equal(operation.payload.content, `${COOKING_PREFIX[language]} – ${session.name}`);
    assert.equal(operation.payload.due_string, session.date);
    const meal = food.weeklyMealPlan.meals.find((candidate) => candidate.id === session.mealId);
    if (meal) {
      // Every ingredient line and step of the catalog recipe, scaled, and nothing cut.
      const recipe = resolveRecipe(meal, { language, portions: session.portions });
      const lines = operation.payload.description.split("\n");
      for (const ingredient of recipe.ingredients) assert.ok(lines.includes(`- ${ingredientLine(ingredient, language)}`), `${session.mealId}: ${ingredientLine(ingredient, language)}`);
      assert.deepEqual(lines.filter((line) => /^\d+\. /.test(line)), recipe.steps.map((step, index) => `${index + 1}. ${step}`));
      assert.deepEqual(
        session.ingredients,
        recipe.ingredients.filter((ingredient) => !ingredient.water).map((ingredient) => ({
          name: ingredient.forms[0].charAt(0).toUpperCase() + ingredient.forms[0].slice(1),
          ...(ingredient.toTaste ? { toTaste: true } : { amount: ingredient.amount, unit: ingredient.unit }),
        })),
      );
    }
    assert.match(operation.payload.description, language === "fi" ? new RegExp(`\\nAnnokset: ${session.portions}\\n`) : new RegExp(`\\nPortioner: ${session.portions}\\n`));
    assert.doesNotMatch(operation.payload.description, TOP_UP);
  }

  const recipeNames = new Set(plan.food.prep.flatMap((session) => session.ingredients.map((ingredient) => ingredient.name)));
  const items = shoppingItems(plan);
  for (const item of items) {
    assert.ok(recipeNames.has(item.name) || item.user, `${item.name} is on the list but in no planned dish and not added by the user`);
    if (!item.user) assert.ok(item.for?.length > 0, `${item.name} has no dish`);
  }
  for (const name of recipeNames) {
    assert.ok(items.some((item) => item.name === name) || removed.some((term) => name.toLowerCase().includes(term)), `${name} is missing from the list`);
  }
  const needed = totals(plan.food.prep.flatMap((session) => session.ingredients));
  for (const item of items.filter((candidate) => !candidate.user || candidate.amounts)) {
    if (!needed.has(item.name)) continue;
    assert.deepEqual(totals((item.amounts ?? []).map((entry) => ({ name: item.name, ...entry }))).get(item.name), needed.get(item.name), `${item.name} amounts`);
  }

  const shopping = opsOf(plan, "shopping");
  assert.ok(shopping.length <= 1, "one grocery task at most");
  if (shopping.length === 1) {
    assert.equal(shopping[0].date, plan.shopping.date);
    for (const item of items) assert.match(shopping[0].payload.description, new RegExp(`\\n- ${escape(item.name)}${item.quantity ? ` – ${escape(item.quantity)}` : ""}\\n|\\n- ${escape(item.name)}${item.quantity ? ` – ${escape(item.quantity)}` : ""}$`));
    assert.doesNotMatch(shopping[0].payload.description, TOP_UP);
  }
  for (const operation of plan.operations) assert.doesNotMatch(operation.payload.content, TOP_UP);
}

function escape(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("weekly plan food: cooking tasks and the grocery list come from the same recipes", () => {
  it("gives every planned dish its own cooking task with the whole recipe, on its day", () => {
    const { plan } = planFor();
    assert.deepEqual(plan.food.prep.map((session) => [session.mealId, session.portions]), [["chicken-rice-veg", 3], ["salmon-potatoes-veg", 2]]);
    assertFoodInvariants(plan);
    const tuesday = opsOf(plan, "mealPrep")[0];
    assert.equal(tuesday.payload.content, "Matlagning – Kyckling med ris och grönsaker");
    assert.match(tuesday.payload.description, /^Kyckling med ris och grönsaker\nPortioner: 3\nTillagningstid: cirka 35 minuter\n\nHandla först: /);
  });

  it("derives one consolidated grocery list only from the planned dishes, with nothing bought just in case", () => {
    const { plan } = planFor();
    const items = shoppingItems(plan);
    assert.equal(opsOf(plan, "shopping").length, 1);
    assert.ok(items.every((item) => item.for?.length > 0), "every item is for a planned dish");
    assert.deepEqual(items.filter((item) => item.section === "meat-fish").map((item) => `${item.name} – ${item.quantity}`), ["Kycklingfilé – 450 g", "Laxfilé – 250 g"]);
    assert.doesNotMatch(JSON.stringify({ food: plan.food, shopping: plan.shopping }), TOP_UP);
    // The ingredients of dishes that are not planned are not bought.
    for (const absent of ["Nötfärs", "Kalkonfärs", "Kidneybönor (380 g)", "Pasta (penne)"]) assert.ok(!items.some((item) => item.name === absent), absent);
  });

  it("adds up an ingredient shared by two dishes into one line with the exact total", () => {
    const { plan } = planFor({ food: { mealIds: ["chicken-rice-veg", "beef-chili-rice"] } });
    assertFoodInvariants(plan);
    const item = (name) => shoppingItems(plan).find((candidate) => candidate.name === name);
    assert.equal(item("Jasminris").quantity, "5 dl");
    assert.deepEqual(item("Jasminris").for, ["chicken-rice-veg", "beef-chili-rice"]);
    assert.equal(item("Gul lök").quantity, "2 st");
    assert.equal(item("Salt").quantity, "2 tsk");
  });

  it("replacing one meal changes that cooking task and its groceries together, and nothing else", () => {
    const before = planFor();
    const after = revise(before, { removeMeals: ["salmon"], addMeals: ["chili"] });
    assertFoodInvariants(after.plan);

    assert.deepEqual(after.summary, ["Added Chili con carne med ris", "Removed Ugnsbakad lax med potatis och haricots verts"]);
    assert.deepEqual(after.plan.food.prep.map((session) => [session.date, session.mealId]), [["2026-09-29", "chicken-rice-veg"], ["2026-10-02", "beef-chili-rice"]]);
    const names = shoppingItems(after.plan).map((item) => item.name);
    for (const gone of ["Laxfilé", "Fast potatis", "Haricots verts", "Citron", "Olivolja"]) assert.ok(!names.includes(gone), gone);
    for (const added of ["Nötfärs", "Krossade tomater (400 g)", "Kidneybönor (380 g)"]) assert.ok(names.includes(added), added);
    assert.equal(shoppingItems(after.plan).find((item) => item.name === "Jasminris").quantity, "5 dl");
    // Tuesday's cooking task is the same task as before.
    assert.deepEqual(opsOf(after.plan, "mealPrep")[0], opsOf(before.plan, "mealPrep")[0]);
    assert.equal(opsOf(after.plan, "mealPrep")[1].payload.content, "Matlagning – Chili con carne med ris");
  });

  it('"No salmon" replaces the dish rather than cooking it without its main ingredient', () => {
    const after = revise(planFor(), { excludeIngredients: ["lax"] });
    assertFoodInvariants(after.plan);
    assert.deepEqual(after.plan.food.prep.map((session) => session.mealId), ["chicken-rice-veg", "beef-chili-rice"]);
    assert.doesNotMatch(JSON.stringify(after.plan.operations), /lax|salmon/i);
  });

  it("a dish the user adds gets its own cooking task, so it never reaches the list without one", () => {
    const after = revise(planFor(), { addMeals: ["turkey-pasta"] });
    assertFoodInvariants(after.plan);
    assert.equal(after.plan.targets.mealPrep, 3);
    assert.deepEqual(after.summary, ["Added Pasta med kalkonfärs och tomatsås", "Meal prep 2 → 3"]);
    const pasta = after.plan.food.prep.find((session) => session.mealId === "turkey-pasta");
    assert.equal(opsOf(after.plan, "mealPrep").find((operation) => operation.date === pasta.date).payload.content, "Matlagning – Pasta med kalkonfärs och tomatsås");
    assert.equal(after.plan.food.extras, undefined);
  });

  it('"Meal prep once, with the pasta" keeps one session and cooks the pasta in it', () => {
    const after = revise(planFor(), { targets: { mealPrep: 1 }, addMeals: ["turkey-pasta"] });
    assertFoodInvariants(after.plan);
    assert.deepEqual(after.plan.food.prep.map((session) => session.mealId), ["turkey-pasta"]);
    assert.ok(!after.summary.some((line) => /Meal prep 1 → 2/.test(line)));
  });

  it("explicit additions still reach the one grocery list; things the user has at home leave it", () => {
    const after = revise(planFor(), {
      addShopping: [{ name: "Bananer", section: "produce", quantity: "6 st" }, { name: "Kaffe", section: "dry-goods" }],
      removeShopping: ["ris"],
    });
    assertFoodInvariants(after.plan, { removed: ["ris"] });
    const items = shoppingItems(after.plan);
    assert.deepEqual(items.filter((item) => item.user).map((item) => [item.name, item.quantity, item.section]), [["Bananer", "6 st", "produce"], ["Kaffe", null, "dry-goods"]]);
    assert.ok(!items.some((item) => item.name === "Jasminris"));
    const description = opsOf(after.plan, "shopping")[0].payload.description;
    assert.match(description, /\n- Bananer – 6 st\n/);
    assert.match(description, /\n\nInte med – du har redan hemma\n- Jasminris$/);
    // The rice is still in the recipe.
    assert.match(opsOf(after.plan, "mealPrep")[0].payload.description, /\n- 2 ½ dl jasminris\n/);
    assert.equal(opsOf(after.plan, "shopping").length, 1);
  });

  it("with no cooking there is no grocery task unless the user adds something", () => {
    const none = planFor({ targets: { mealPrep: 0 } });
    assert.equal(opsOf(none.plan, "shopping").length, 0);
    assert.match(JSON.stringify(none.plan.food), /"prep":\[\]/);
    const added = revise(none, { addShopping: [{ name: "Bananer", section: "produce" }] });
    assert.equal(opsOf(added.plan, "shopping").length, 1);
    assert.deepEqual(shoppingItems(added.plan).map((item) => item.name), ["Bananer"]);
  });

  it("never invents a cooking task: with too few complete recipes, it plans fewer sessions and says so", () => {
    const after = revise(planFor(), { excludeIngredients: ["kyckling", "lax", "nötfärs"] });
    assertFoodInvariants(after.plan);
    assert.deepEqual(after.plan.food.prep.map((session) => session.mealId), ["turkey-pasta"]);
    assert.equal(opsOf(after.plan, "mealPrep").length, 1);
    assert.ok(after.plan.notes.some((note) => /Only 1 dish with a complete recipe is left after your changes, so meal prep is 1 instead of 2/.test(note)));
    assert.doesNotMatch(JSON.stringify(after.plan), /of your choice|Cook a simple/i);
  });

  it("scales a dish to the portions the user asks for, in the recipe and the list alike", () => {
    const after = revise(planFor({ food: { mealIds: ["beef-chili-rice"] } }), { mealPortions: { chili: 4 } });
    assertFoodInvariants(after.plan);
    assert.deepEqual(after.summary, ["Chili con carne med ris ×4"]);
    const chili = after.plan.food.prep.find((session) => session.mealId === "beef-chili-rice");
    assert.equal(chili.portions, 4);
    assert.equal(shoppingItems(after.plan).find((item) => item.name === "Nötfärs").quantity, "530 g");
    assert.match(opsOf(after.plan, "mealPrep").find((operation) => operation.date === chili.date).payload.description, /\nPortioner: 4\n[\s\S]*\n- 530 g nötfärs\n/);
  });

  it("plans a recipe the user supplies from English, converted, with its cooking task and groceries", () => {
    const after = revise(planFor(), {
      addMeals: [
        {
          name: "Ugnsbakad kyckling med citron",
          servings: 4,
          portions: 2,
          oven: { temperature: 350, unit: "F" },
          ingredients: [
            { id: "kyckling", name: "kycklinglårfilé", amount: 2, unit: "lb", section: "meat-fish" },
            { id: "gradde", name: "matlagningsgrädde", amount: 1, unit: "cup", section: "dairy" },
            { name: ["citron", "citroner"], amount: 1, unit: "piece", section: "produce" },
          ],
          steps: ["Sätt ugnen på {oven}.", "Lägg {kyckling} kyckling i en form och häll över {gradde} grädde.", "Baka i 35 minuter, tills kycklingen är genomstekt."],
        },
      ],
    });
    assertFoodInvariants(after.plan);
    const session = after.plan.food.prep.find((candidate) => candidate.mealId === "custom-ugnsbakad-kyckling-med-citron");
    const task = opsOf(after.plan, "mealPrep").find((operation) => operation.date === session.date).payload;
    assert.equal(task.content, "Matlagning – Ugnsbakad kyckling med citron");
    assert.match(task.description, /\nPortioner: 2\nUgn: 175 °C\n[\s\S]*\n- 460 g kycklinglårfilé\n- 1 ¼ dl matlagningsgrädde\n- ½ citron\n/);
    assert.match(task.description, /\n2\. Lägg 460 g kyckling i en form och häll över 1 ¼ dl grädde\.\n/);
    assert.equal(shoppingItems(after.plan).find((item) => item.name === "Kycklinglårfilé").quantity, "460 g");
    assert.doesNotMatch(task.description, /\b(lb|cups?|°F)\b/);
  });

  it("writes Finnish recipes, groceries and titles when the user asks for Finnish", () => {
    const after = revise(planFor(), { recipeLanguage: "finska" });
    assertFoodInvariants(after.plan);
    assert.deepEqual(after.summary, ["Recipes in Finnish"]);
    assert.equal(after.plan.food.language, "fi");
    assert.deepEqual(opsOf(after.plan, "mealPrep").map((operation) => operation.payload.content), ["Ruoanlaitto – Kana-kasvispannu ja riisi", "Ruoanlaitto – Uunilohi, perunat ja vihreät pavut"]);
    const shopping = opsOf(after.plan, "shopping")[0].payload;
    assert.equal(shopping.content, "Viikon ruokaostokset");
    assert.match(shopping.description, /^Viikon ruoanlaittoa varten\n- Kana-kasvispannu ja riisi – 3 annosta \(tiistai\)\n/);
    assert.match(shopping.description, /\n\nLiha, broileri ja kala\n- Broilerin rintafilee – 450 g\n- Lohifilee – 250 g\n/);
  });

  it("refuses to switch languages while a supplied recipe exists only in the old one", () => {
    const withRecipe = revise(planFor(), {
      addMeals: [{ name: "Kycklinggryta", servings: 2, ingredients: [{ name: "kycklingfilé", amount: 300, unit: "g", section: "meat-fish" }], steps: ["Skär kycklingen i bitar och bryn den i en gryta.", "Låt grytan sjuda under lock i 20 minuter."] }],
    });
    assert.throws(() => revise(withRecipe, { recipeLanguage: "fi" }), /Kycklinggryta is written in Swedish\. Send it again in Finnish, or remove it/);
  });

  it("counts cooking and grocery tasks already in Todoist in Swedish or Finnish", () => {
    const { plan } = planFor({
      existingTasks: [
        { content: "Matlagning – Kyckling med ris och grönsaker", due: { date: "2026-09-29" } },
        { content: "Matinköp för veckan", due: { date: "2026-09-29" } },
        { content: "Rörlighet – Onsdag, 15 minuter", due: { date: "2026-09-30" } },
      ],
    });
    assert.equal(opsOf(plan, "mealPrep").length, 1);
    assert.equal(opsOf(plan, "shopping").length, 0);
    assert.ok(plan.notes.some((note) => /A grocery task is already in Todoist \(Matinköp för veckan\)/.test(note)));
    assert.ok(opsOf(plan, "stretch").every((operation) => operation.date !== "2026-09-30"));
  });
});

describe("weekly plan food: plans stored before this change", () => {
  const fixture = () => JSON.parse(LEGACY_PLAN);

  it("rebuilds the same golf week, golf tasks and schedule from a stored plan's inputs", () => {
    const stored = fixture().versions[0];
    const rebuilt = buildWeeklyPlan(stored.inputs, { config, food, today: "2026-09-26" });
    assert.deepEqual(rebuilt.golf, stored.plan.golf);
    assert.deepEqual(opsOf(rebuilt, "golf"), opsOf(stored.plan, "golf"));
    assert.deepEqual(
      rebuilt.placements.map(({ activity, date }) => `${activity}:${date}`),
      stored.plan.placements.map(({ activity, date }) => `${activity}:${date}`),
    );
  });

  it("keeps every stored version's digest", () => {
    for (const entry of fixture().versions) assert.equal(digestPlan(entry.plan), entry.digest);
  });

  describe("through the CLI", () => {
    let stateDir;
    let todoist;
    let clock;
    const run = (argv) =>
      runWeeklyPlanCli(argv, {
        stateDir,
        memoryPath: join(stateDir, "memory.json"),
        env: { TELEGRAM_USER_ID: "1029709001" },
        schedules,
        todoistClient: todoist,
        sendMessage: async () => ({ messageId: 1 }),
        now: () => clock,
        sleep: async () => {},
        retryDelaysMs: [0, 0],
      });
    const document = () => createWeeklyPlanStore({ stateDir }).readPlan("wp-2026-W40-abc123");

    beforeEach(() => {
      stateDir = mkdtempSync(join(tmpdir(), "weekly-plan-legacy-"));
      mkdirSync(join(stateDir, "weekly-plan/plans"), { recursive: true });
      writeFileSync(join(stateDir, "weekly-plan/plans/wp-2026-W40-abc123.json"), LEGACY_PLAN);
      todoist = fakeTodoist();
      clock = new Date("2026-09-26T09:00:00.000Z");
    });
    afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

    it("shows a stored plan exactly as it was shown", async () => {
      assert.equal((await run(["show"])).telegramText, LEGACY_SHOW);
    });

    it("applies exactly the stored operations, never regenerated with the new recipes", async () => {
      clock = new Date(fixture().reviewDeadline);
      const result = await run(["apply-due"]);
      assert.match(result.text, /^Applied weekly plan · 28 Sep–4 Oct · v2/);
      const stored = versionEntry(fixture(), 2).plan.operations.map((operation) => operation.payload);
      assert.deepEqual(todoist.calls.addTask.map((call) => call.payload), stored);
      assert.ok(stored.some((payload) => payload.content === "Grocery shopping for next week"), "the old wording is what was shown");
      assert.equal(document().status, "applied");
      assert.deepEqual(document().versions, fixture().versions);
    });

    it("accepts a stored plan as shown", async () => {
      const accepted = await run(["accept", "--version", "2", "--reply-text", "OK"]);
      assert.equal(accepted.status, "applied");
      assert.deepEqual(todoist.calls.addTask.map((call) => call.payload), versionEntry(fixture(), 2).plan.operations.map((operation) => operation.payload));
    });

    it("builds a revision with the new rules, cooks the old extra dish, and drops the old top-ups", async () => {
      const revised = await run(["revise", "--expect-version", "2", "--changes-json", '{"targets":{"gym":3}}']);
      assert.equal(revised.version, 3);
      assert.equal(revised.reviewDeadline, "2026-09-26T21:00:00.000Z", "the 12-hour window restarts");
      assert.match(revised.telegramText, /^Updated plan · 28 Sep–4 Oct · v3\nChanges: Gym 2 → 3 · Meal prep 2 → 3\n/);
      const plan = versionEntry(document(), 3).plan;
      assertFoodInvariants(plan, { removed: [] });
      assert.deepEqual(plan.food.prep.map((session) => session.mealId), ["chicken-rice-veg", "salmon-potatoes-veg", "turkey-pasta"]);
      assert.ok(shoppingItems(plan).some((item) => item.name === "Bananas" && item.user), "the user's own addition stays");
      assert.doesNotMatch(JSON.stringify(plan), /Skyr|Eggs \+ bread|Easy tuna pasta|Cottage cheese/);
      // Versions 1 and 2 are kept exactly as they were.
      assert.deepEqual(document().versions.slice(0, 2), fixture().versions);
      assert.equal(todoist.calls.addTask.length, 0);
    });
  });
});

describe("weekly plan food through the CLI", () => {
  let stateDir;
  let memoryPath;
  let clock;
  let todoist;
  let sent;
  const PLAN = "wp-2026-W42-abc123";

  const run = (argv, extra = {}) =>
    runWeeklyPlanCli(argv, {
      stateDir,
      memoryPath,
      env: { TELEGRAM_USER_ID: "1029709001" },
      schedules,
      todoistClient: todoist,
      sendMessage: async (text) => {
        sent.push(text);
        return { messageId: sent.length };
      },
      now: () => clock,
      random: () => "abc123",
      sleep: async () => {},
      retryDelaysMs: [0, 0],
      ...extra,
    });
  const at = (iso) => {
    clock = new Date(iso);
  };
  const store = () => createWeeklyPlanStore({ stateDir });
  const plan = () => store().readPlan(PLAN);
  const planFile = () => readFileSync(join(stateDir, "weekly-plan/plans", `${PLAN}.json`), "utf8");
  const remember = (entries) =>
    writeFileSync(memoryPath, `${JSON.stringify({ version: 1, entries: entries.map((entry, index) => ({ id: `m${index}`, sensitivity: "low", source: "telegram", createdAt: "x", updatedAt: "x", ...entry })) })}\n`);

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "weekly-plan-food-"));
    memoryPath = join(stateDir, "memory.json");
    remember([]);
    todoist = fakeTodoist();
    sent = [];
    at("2026-10-10T07:00:00.000Z"); // Saturday 09:00 Stockholm
  });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  it("lists the recipe ids at the end of the guide", async () => {
    const guide = await run(["guide"], { root: process.cwd() });
    assert.match(guide.text, /\n\n## Recipe Ids\n\n- `chicken-rice-veg`: Kyckling med ris och grönsaker \/ Kana-kasvispannu ja riisi\n/);
    for (const meal of food.weeklyMealPlan.meals) assert.ok(guide.text.includes(`- \`${meal.id}\`: `), meal.id);
  });

  it("ignores dishes and groceries the scheduled run tries to add, since the user chose none of them", async () => {
    await run([
      "propose",
      "--send",
      "--input-json",
      JSON.stringify({ food: { addShopping: ["Chips", { name: "Skyr", section: "dairy" }], addMeals: ["turkey-pasta"], customMeals: [{ name: "Reservmat" }], excludeIngredients: ["lax"] } }),
    ]);
    const base = plan().awaiting.baseInputs.food;
    assert.deepEqual([base.addedMeals, base.customMeals, base.extraShopping], [[], [], []]);
    assert.deepEqual(base.excludeIngredients, ["lax"], "an exclusion only removes, so it is kept");

    const shown = await run(["answer", "--input-json", answerJson(GOLF_ANSWER)]);
    assert.equal(shown.status, "pending");
    const v1 = versionEntry(plan(), 1).plan;
    assertFoodInvariants(v1);
    assert.doesNotMatch(JSON.stringify(v1), /Chips|Skyr|Reservmat|turkey-pasta|laxfilé/);
  });

  it("uses a saved recipe-language preference, and records the language with the plan", async () => {
    remember([{ category: "food", key: "recipe-language", value: "finska" }]);
    await run(["propose", "--send"]);
    const shown = await run(["answer", "--input-json", answerJson(GOLF_ANSWER)]);
    const v1 = versionEntry(plan(), 1).plan;
    assert.equal(v1.food.language, "fi");
    assert.ok(opsOf(v1, "mealPrep").every((operation) => operation.payload.content.startsWith("Ruoanlaitto – ")));
    assert.match(shown.telegramText, /\n• Recipes in Finnish\n/);
  });

  it("asks for what a supplied recipe is missing and stores nothing", async () => {
    await run(["propose", "--send"]);
    await run(["answer", "--input-json", answerJson(GOLF_ANSWER)]);
    const before = planFile();
    const result = await run([
      "revise",
      "--expect-version",
      "1",
      "--changes-json",
      JSON.stringify({ addMeals: [{ name: "Mormors köttfärssås", servings: 4, ingredients: [{ name: "nötfärs", amount: 500, unit: "g" }, { name: "krossade tomater" }] }] }),
    ]);
    assert.equal(result.status, "clarify");
    assert.deepEqual(result.problems, [
      "How much krossade tomater is needed? Give an amount, or mark it as to taste if the recipe says so.",
      "The cooking steps are missing: send the method as numbered steps.",
    ]);
    assert.match(result.telegramText, /^To plan “Mormors köttfärssås” I need:\n- How much krossade tomater/);
    assert.equal(planFile(), before, "nothing was stored");
  });

  it("asks the same way when the recipe comes with the golf answer", async () => {
    await run(["propose", "--send"]);
    const result = await run(["answer", "--input-json", answerJson(GOLF_ANSWER, { changes: { addMeals: [{ name: "Gryta" }] } })]);
    assert.equal(result.status, "clarify");
    assert.equal(plan().status, "awaiting_input");
    assert.equal(plan().currentVersion, 0);
  });

  it("runs the whole week end to end: ask, answer, inspect, revise a meal, deterministic apply, no duplicates", async () => {
    const memoryBefore = createHash("sha256").update(readFileSync(memoryPath)).digest("hex");

    // 1. Saturday 09:00: a new weekly proposal asks the golf questions.
    assert.equal((await run(["propose", "--send"])).status, "awaiting_input");
    assert.equal(sent.length, 1);

    // 2–3. The golf answer builds and shows the complete plan.
    at("2026-10-10T09:40:00.000Z");
    const shown = await run(["answer", "--input-json", answerJson(GOLF_ANSWER)]);
    assert.equal(shown.status, "pending");
    assert.equal(shown.reviewDeadline, "2026-10-10T21:45:00.000Z");
    const v1 = versionEntry(plan(), 1).plan;
    assert.equal(v1.golf.activeDays, 6);
    assert.equal(opsOf(v1, "golf").length, 6);

    // 4. Gym and stretching tasks are specific.
    for (const operation of opsOf(v1, "gym")) {
      assert.match(operation.payload.content, /^Gym – Helkropp [AB], /);
      assert.ok(operation.payload.description.split("\n").filter((line) => /^\d+\. .+ – \d+ × \d+/.test(line)).length >= 5);
    }
    for (const operation of opsOf(v1, "stretch")) {
      assert.match(operation.payload.content, /^Rörlighet – [A-ZÅÄÖ][a-zåäö]+, 15 minuter$/);
      assert.ok(operation.payload.description.split("\n").filter((line) => /^\d+\. .+ – .*(sek|repetitioner)/.test(line)).length >= 5);
    }

    // 5–6. Every recipe task and the grocery list agree.
    assertFoodInvariants(v1);
    assert.match(shown.telegramText, /\nFood\n• Kyckling med ris och grönsaker ×3 \(prep [A-Z][a-z]{2}\)\n• Ugnsbakad lax med potatis och haricots verts ×2 \(prep [A-Z][a-z]{2}\)\n/);
    assert.match(shown.telegramText, /\nShopping \([A-Z][a-z]{2}\)\n.*Kycklingfilé.*\nCheck you have: /);

    // 7–9. Revising one meal changes its cooking task and groceries together and restarts the window.
    at("2026-10-10T18:30:00.000Z");
    const revised = await run(["revise", "--expect-version", "1", "--changes-json", '{"removeMeals":["salmon-potatoes-veg"],"addMeals":["beef-chili-rice"]}']);
    assert.equal(revised.version, 2);
    assert.equal(revised.reviewDeadline, "2026-10-11T06:30:00.000Z");
    assert.match(revised.telegramText, /^Updated plan · 12 Oct–18 Oct · v2\nChanges: Added Chili con carne med ris · Removed Ugnsbakad lax med potatis och haricots verts\n/);
    const v2 = versionEntry(plan(), 2).plan;
    assertFoodInvariants(v2);
    const salmonDate = v1.food.prep.find((session) => session.mealId === "salmon-potatoes-veg").date;
    assert.equal(opsOf(v2, "mealPrep").find((operation) => operation.date === salmonDate).payload.content, "Matlagning – Chili con carne med ris");
    assert.ok(!shoppingItems(v2).some((item) => item.name === "Laxfilé"));
    assert.ok(shoppingItems(v2).some((item) => item.name === "Nötfärs"));
    assert.deepEqual(opsOf(v2, "golf"), opsOf(v1, "golf"), "golf is untouched by a food change");
    assert.deepEqual(versionEntry(plan(), 1).plan, v1, "the shown v1 is kept as it was");

    // 10. The deterministic executor applies exactly v2 at its deadline.
    at("2026-10-11T06:29:00.000Z");
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    at("2026-10-11T06:30:00.000Z");
    const applied = await run(["apply-due"]);
    assert.match(applied.text, /^Applied weekly plan · 12 Oct–18 Oct · v2\nCreated: \d+ · Already existed: 0 · Failed: 0/);
    assert.deepEqual(todoist.calls.addTask.map((call) => call.payload), v2.operations.map((operation) => operation.payload));

    // 11–12. Repeating the apply creates nothing, and nothing is duplicated.
    at("2026-10-11T06:45:00.000Z");
    assert.equal((await run(["apply-due"])).text, "NO_REPLY");
    assert.equal((await run(["accept", "--plan-id", PLAN, "--version", "2", "--reply-text", "OK"])).applied, false);
    assert.equal(todoist.calls.addTask.length, v2.operations.length);
    const keys = todoist.tasks.map((task) => `${task.due.date} ${task.content}`);
    assert.equal(new Set(keys).size, keys.length, "no duplicate tasks");
    assert.deepEqual(todoist.calls.forbidden, [], "no existing task is edited, completed, moved or deleted");
    assert.equal(createHash("sha256").update(readFileSync(memoryPath)).digest("hex"), memoryBefore, "memory is never written");
  });
});

function fakeTodoist(initial = []) {
  const tasks = initial.map((task) => ({ ...task }));
  const calls = { addTask: [], forbidden: [] };
  let nextId = 7000;
  const forbidden = (name) => async () => {
    calls.forbidden.push(name);
    throw new Error(`${name} must never be called by the weekly plan`);
  };
  return {
    tasks,
    calls,
    async getTasks() {
      return tasks.map((task) => ({ ...task }));
    },
    async addTask(payload, options) {
      calls.addTask.push({ payload: structuredClone(payload), requestId: options?.requestId });
      const task = { id: String(nextId++), content: payload.content, due: { date: payload.due_string, string: payload.due_string } };
      tasks.push(task);
      return task;
    },
    updateTask: forbidden("updateTask"),
    closeTask: forbidden("closeTask"),
    reopenTask: forbidden("reopenTask"),
    deleteTask: forbidden("deleteTask"),
    moveTask: forbidden("moveTask"),
    addComment: forbidden("addComment"),
  };
}
