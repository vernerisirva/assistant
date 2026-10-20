# Weekly Plan

`npm run --silent weekly-plan -- guide` prints this guide with the current plan status. It adds detail to the personal agent's standing orders and never overrides them: the approval, memory, and coaching rules there still apply, and the standing authorization stays exactly as narrow as they say.

## How A Week Goes

- Saturday 09:00 the scheduled job builds next week's complete plan (golf, gym, stretching, meals with recipes, cooking and one grocery list) and sends it. Golf answers are not needed: without them every golf day is practice (never an invented round) and the focus is a balanced mix for competitive play, both labelled as defaults. The first version ends with one or two optional golf questions.
- Sending it starts the 12-hour review window. If the user doesn't reply, the deterministic apply check creates exactly the shown version's Todoist tasks when the window ends. Silence is fine; never chase the user about the questions.
- Every reply to a shown plan is one of four things. Decide which before running anything:
  - a change, golf answers included: `revise` (below). It stores a new version and restarts the window.
  - plain acceptance: `accept`. `Skip this week`: `cancel`.
  - a question about the plan: answer it from the plan; nothing changes.
  - unclear: ask one short question, only when the change cannot be made safely or meaningfully without it. A missing preference is not unclear: the plan's defaults stand.
- `What's my plan?` or `show the plan`: `npm run --silent weekly-plan -- show`. `Is a plan pending?`, `When will it apply?`, `Has it been applied?`: `npm run --silent weekly-plan -- status`, then summarize its `telegramText`.
- `Plan my next week` on another day: `npm run --silent weekly-plan -- propose --reply`, and reply with `telegramText` exactly. If that message already says which days they play or what to work on, pass it as `golf` in the input JSON, with the fields below.

## Golf Answers

- Golf answers look like `18 holes Wednesday and Saturday`, `Focus on putting`, `Saturday is a competition`, `Same as last week`, `No golf next week`, in English, Swedish (`Spelar onsdag och lördag`) or Finnish (`Pelaan keskiviikkona ja lauantaina`). Each is a revision of the version the user saw.
- Pass the user's exact message as `replyText`, with what it says mapped to fields, through a quoted heredoc:

```bash
npm run --silent weekly-plan -- revise --expect-version 1 --changes-json-stdin <<'JSON'
{"golf": {"replyText": "18 holes Wednesday and Saturday. Focus on wedges 50–100 m and putting inside 2 m. Saturday is a competition.", "addRounds": [{"day": "wednesday", "holes": 18}, {"day": "saturday", "holes": 18, "competition": true}], "focus": ["Wedges 50–100 m", "Putting inside 2 m"]}}
JSON
```

- Use what a partial answer gives and nothing more. `Playing Wednesday and Saturday` sets the playing days and keeps the default focus; `Focus on wedges and putting` sets the focus and keeps everything else; `No golf next week` is `"activeDays": 0`. Never ask again for what the user left out.
- Fields, each only when this message says it:
  - `addRounds`: `[{"day": "friday", "holes": 9, "competition": true}]`. Holes only when said. `competition` only when they call it a competition, tournament, match or similar (`tävling`, `kilpailu`, `kisa`); an important round they name otherwise is an ordinary round.
  - `rounds`: `[]` for `No rounds next week`, or `"same-as-last-week"` for `Same playing days as last week`.
  - `focus`: one or two areas in the user's own words, main focus first; `"balance"` for `No specific focus, choose the balance`; `"same-as-last-week"`.
  - `addLessons`: `[{"day": "thursday", "note": "17:00"}]`, only for a lesson they say they have. `technicalPriority`: their coach's priority in their words, such as `Clubface control`; mentioning a coach is not a lesson.
  - `restDay`: the golf-free day they name. `unavailableDays`: days with no golf, such as travel. `minutes`: `{"monday": 30}` for `I only have 30 minutes Monday`. `avoid`: `["range"]` for `No range sessions this week`.
  - `activeDays`: `0` for `No golf next week`, or fewer golf days when they ask. Six is the default; never seven.
  - `from: "normal-week"` for `Use my normal golf week`, with the days of their saved normal golf week (`golf/normal-week` in memory). If none is saved, the command asks for the days.
- Never fill a gap. Playing days, holes, competitions, lessons, focus areas, technical priorities and time limits come only from what the user said in this conversation, never from memory, earlier weeks or habit; whatever they haven't said stays the planner's labelled default. The command refuses values it cannot find in `replyText`.
- If the same message also changes something else (`… and no salmon this week`), put both in the same JSON, for example `{"golf": {...}, "excludeIngredients": ["salmon"]}`.

## Changing A Pending Plan

- Run `npm run --silent weekly-plan -- revise --expect-version N --changes-json-stdin` with the JSON in a quoted heredoc, where N is the version the user was looking at. Reply with the returned `telegramText` exactly. A revision stores a new version, restarts the 12-hour review window and never touches Todoist. A change that alters nothing keeps the version and its deadline.
- Golf changes go under `golf`, always with the user's exact message as `replyText`. Read the day a session is on from the plan they saw:
  - `Move wedges to Thursday` → `{"golf": {"replyText": "Move wedges to Thursday", "moves": [{"from": "monday", "to": "thursday"}]}}`. A practice session swaps with Thursday's, or Thursday becomes golf and its old day becomes the rest day. Rounds and lessons move the same way.
  - `Tuesday needs to be the rest day`, `Make Sunday the rest day` or `Move the rest day to Friday` → `{"golf": {"replyText": "…", "restDay": "tuesday"}}`
  - `I'm also playing Friday` or `Play 18 holes Saturday` → `{"golf": {"replyText": "…", "addRounds": [{"day": "friday"}]}}`. `I'm not playing Wednesday after all` → `"removeRounds": ["wednesday"]`.
  - `Saturday is now a competition` → `{"golf": {"replyText": "…", "addRounds": [{"day": "saturday", "competition": true}]}}`. The round keeps its known hole count.
  - `Putting should be the main focus` → `{"golf": {"replyText": "…", "focus": ["Putting", "Wedges 50–100 m"]}}`, keeping the other area second.
  - `I only have 30 minutes Monday` → `"minutes": {"monday": 30}`. `No range sessions this week` → `"avoid": ["range"]`. `No golf next week` → `"activeDays": 0`. `Lesson on Thursday` → `"addLessons": [{"day": "thursday"}]`. `My coach wants me working on clubface control` → `"technicalPriority": "Clubface control"`.
- Other changes: `Gym 3 times` → `{"targets":{"gym":3}}` (so is `Gym three days instead`); `Stretch four times` → `{"targets":{"stretch":4}}`; `Meal prep only once` → `{"targets":{"mealPrep":1}}`; `Move Friday gym to Sunday` → `{"moves":[{"activity":"gym","from":"friday","to":"sunday"}]}`; `Skip Saturday completely` → `{"skipDays":["saturday"]}`; `I'm busy on Wednesday` → `{"dayLoads":{"wednesday":"heavy"}}`.
- Food changes, with the recipe ids listed at the end of this guide: `Don't use salmon` → `{"excludeIngredients":["salmon"]}` (so is `No salmon`; any language works, `lax` too; a dish that needs it is replaced, never cooked without it); `Add pasta` → `{"addMeals":["turkey-pasta"]}` (the dish gets its own meal-prep session, so meal prep goes up by one unless a session is free); `Swap the salmon for chili` → `{"removeMeals":["salmon-potatoes-veg"],"addMeals":["beef-chili-rice"]}`; `Make 4 portions of the chili` → `{"mealPortions":{"beef-chili-rice":4}}`; `Recipes in Finnish` → `{"recipeLanguage":"fi"}` (so is `Make recipes in Finnish`; `"sv"` switches back); `Add bananas to the shopping list` → `{"addShopping":[{"name":"Bananer","section":"produce"}]}`; `I already have rice` → `{"removeShopping":["ris"]}` (it stays in the recipe).
- If `revise` returns `clarify`, nothing was stored. If you added something the user did not say, leave it out and run the command again; otherwise ask the user `telegramText`. If it reports another error, for example that an existing Todoist task cannot be moved, say so plainly.

## Food And Recipes

- Every meal-prep session cooks one dish with a complete recipe, and each dish gets its own task, `Matlagning – <dish>`, with portions, every ingredient amount and numbered steps. The one grocery task, `Matinköp för veckan`, lists exactly what those dishes need plus what the user explicitly added. Never add a dish, snack, backup meal or grocery the user did not ask for: there are no top-ups.
- Recipes are in Swedish unless the user asked for Finnish. Shopping items the user adds are named in that language too (an English name is refused: translate it and run the change again), and their section is one of `produce`, `bread`, `meat-fish`, `dairy`, `dry-goods`, `canned`, `frozen`, `other`.
- A recipe the user gives you (`Cook this on Thursday: …`) goes in `addMeals` as a complete recipe, in a quoted heredoc:

```json
{"addMeals": [{"name": "Mormors köttfärssås", "servings": 4, "portions": 3, "minutes": 45, "oven": {"temperature": 350, "unit": "F", "mode": "fan"}, "ingredients": [{"id": "fars", "name": "nötfärs", "amount": 1, "unit": "lb", "section": "meat-fish"}, {"name": ["gul lök", "gula lökar"], "amount": 1, "unit": "st", "section": "produce"}, {"name": "salt", "toTaste": true, "staple": true}], "steps": ["Sätt ugnen på {oven}.", "Bryn {fars} färs i en gryta.", "…"], "storage": "…"}]}
```

- Translate the name, every ingredient name, the steps and the storage advice into the week's recipe language, not just the title. Keep the source's own amounts and units in `amount` and `unit` (lb, oz, cups, tbsp, tsp, °F): the planner converts them, cups to dl and never to grams. Never convert, round or invent an amount yourself.
- `servings` is what the recipe makes; `portions` is what the user wants, and the recipe is scaled to it. In steps, write amounts only as `{ingredient-id}` placeholders (the ingredient's `id`, or its name in lower case with dashes), `{oven}` or `{portions}`, so they scale. Two name forms help the wording: Swedish singular and plural, `["gul lök", "gula lökar"]`, or Finnish nominative and partitive, `["keltasipuli", "keltasipulia"]`. `toTaste` is only for seasoning the recipe gives no amount for, and `staple` marks basics such as oil and salt.
- If the result is `clarify`, nothing was stored: ask the user its `telegramText`. Never fill in a missing amount, unit or step; offer one of the recipes below instead if they prefer.
- `Always give me recipes in Finnish` is an explicit request to remember: `npm run memory -- remember --category food --key recipe-language --value "finska" --source telegram`. Plans built after that use Finnish; a pending plan changes only with `recipeLanguage`.

## Gym And Stretching

- Each gym task holds a whole session: a warm-up, every exercise with sets × repetitions and rest, load as repetitions in reserve, and the total time. Each stretching task holds a 15-minute routine of named movements with hold times or repetitions per side. They come from config; never add weights, medical advice or restrictions in chat.
- The day before a round or competition the plan picks the session with less leg work and takes a set off each leg exercise, and the task says so.

## Accepting And Cancelling

- Only when the pending version is the latest plan the user saw and they reply with a plain acceptance such as `OK`, `Looks good`, `Create it`, `Yes`, `Go ahead`, `Ser bra ut` or `Näyttää hyvältä`, run `npm run --silent weekly-plan -- accept --version N --reply-text "EXACT_REPLY"` and reply with `telegramText`.
- `Skip this week`, `Cancel the weekly plan` or `Don't create these`: `npm run --silent weekly-plan -- cancel --reason "EXACT_REPLY"`, then reply with `telegramText`.

## When Something Went Wrong

- A change or golf answer after the plan was applied cannot go through `revise`: its tasks already exist. Say when they were created (`status`), and that changing or removing created tasks follows the normal Todoist rules, so ask before touching any.
- Status says a plan couldn't be delivered: it is an unshown draft and never applies; the apply check keeps sending it. If the user asks for the plan in chat, `show` says to run `npm run --silent weekly-plan -- propose --reply --input-json '{"weekStart":"YYYY-MM-DD"}'` with its Monday, and reply with that `telegramText` exactly: that shows it and starts its window.
- Status says a plan is waiting for the user's OK: Todoist couldn't be read when it was made, and that week has tasks it didn't account for, so nothing was created automatically. Explain that in a sentence; an OK, a change or a cancel decides.
- A plan stored before golf answers became optional may still be waiting for them (`awaiting_input`). Golf answers for it go through `npm run --silent weekly-plan -- answer --input-json-stdin` with `{"golf": {...}}` as above (a non-golf change can go along as `"changes"`); it builds the plan from what they said with defaults for the rest and returns it to send exactly. `propose --reply` with that week's `weekStart` builds it with defaults for everything unanswered. Either way only days that haven't passed are planned, and its window starts when it is shown.

## The Golf Week

- The golf part plans one week toward consistently good competitive golf: the user's rounds and lessons are fixed, golf tasks already in Todoist count, and practice fills the other days up to six golf days with one golf-free day. A week that has already started keeps a golf-free day in what is left and never catches up on missed days. Each golf day gets one Todoist task with the whole session in its description.
- It plans training, not swing technique. Never add mechanics or a diagnosis (`your hips fire early`, `change your grip`). A technical priority appears only in the user's or their coach's words; otherwise the plan says to work on the current priority from their lesson.
- A plan built in chat uses the user's saved golf cue word and the names of their saved pre-round routine, bad-shot reset and competition routine; the scheduled plan doesn't read them. It only reads them. Remembering anything, such as a normal golf week, follows the memory rules: only on the user's explicit request, with `npm run memory -- remember --category golf --key normal-week --value "…" --source telegram`.
- Observations such as `My putting inside 2 m was bad last week` can become the focus when the user offers them as what to work on. Never store them, and never invent statistics.
- No weather, no golf statistics, no bookings, and no scheduled or post-round messages. A debrief happens only when the user asks (`Debrief my round`).

## Never

- Never create weekly-plan tasks yourself with the Todoist helper, never rebuild the plan at apply time, and never answer the golf questions for the user.
