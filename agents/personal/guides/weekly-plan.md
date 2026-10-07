# Weekly Plan

`npm run --silent weekly-plan -- guide` prints this guide with the current plan status. It adds detail to the personal agent's standing orders and never overrides them: the approval, memory, and coaching rules there still apply, and the standing authorization stays exactly as narrow as they say.

## How A Week Goes

- Saturday 09:00 the scheduled job stores next week's context and sends the golf questions: which days the user plays and roughly 9 or 18 holes, their 1–2 focus areas, and any competition, lesson or other important golf event. No plan exists yet, nothing can be accepted or applied, and no review window runs.
- The user answers in chat. Store the answer with `answer`. While playing days or focus are missing it asks for them; once both are known it builds the whole plan (food, shopping, gym, stretching and golf) as v1 and returns it. Reply with its `telegramText` exactly: that is when the 12-hour review window starts.
- A change stores a new version with `revise` and restarts the window. `OK` applies the shown version at once. `Skip this week` cancels. After the window, the deterministic apply check creates exactly the shown version's Todoist tasks.
- `What's my plan?` or `show the plan`: `npm run --silent weekly-plan -- show`. `Is a plan pending?`, `When will it apply?`, `Has it been applied?`: `npm run --silent weekly-plan -- status`, then summarize its `telegramText`.
- `Plan my next week` on another day: `npm run --silent weekly-plan -- propose --reply`, and reply with `telegramText` exactly. If that message already says which days they play or what to work on, pass it as `golf` in the input JSON, as below.

## Golf Answers

- Golf answers look like `18 holes Wednesday and Saturday`, `Focus on putting`, `Saturday is a competition`, `Same as last week`, `No golf next week`. Check the status first: an answer only fits a plan that is waiting for golf answers.
- Pass the user's exact message as `replyText`, with what it says mapped to fields, through a quoted heredoc:

```bash
npm run --silent weekly-plan -- answer --input-json-stdin <<'JSON'
{"golf": {"replyText": "18 holes Wednesday and Saturday. Focus on wedges 50–100 m and putting inside 2 m. Saturday is a competition.", "addRounds": [{"day": "wednesday", "holes": 18}, {"day": "saturday", "holes": 18, "competition": true}], "focus": ["Wedges 50–100 m", "Putting inside 2 m"]}}
JSON
```

- Fields, each only when this message says it:
  - `addRounds`: `[{"day": "friday", "holes": 9, "competition": true}]`. Holes only when said. `competition` for a competition, match, or another round they call important.
  - `rounds`: `[]` for `No rounds next week`, or `"same-as-last-week"` for `Same playing days as last week`.
  - `focus`: one or two areas in the user's own words, main focus first; `"balance"` for `No specific focus, choose the balance`; `"same-as-last-week"`.
  - `addLessons`: `[{"day": "thursday", "note": "17:00"}]`. `technicalPriority`: their coach's priority in their words, such as `Clubface control`.
  - `restDay`: the golf-free day they name. `unavailableDays`: days with no golf, such as travel. `minutes`: `{"monday": 30}` for `I only have 30 minutes Monday`. `avoid`: `["range"]` for `No range sessions this week`.
  - `activeDays`: `0` for `No golf next week`, or fewer golf days when they ask. Six is the default; never seven.
  - `from: "normal-week"` for `Use my normal golf week`, with the days of their saved normal golf week (`golf/normal-week` in memory). If none is saved, the command asks for the days.
- Never fill a gap. Playing days, holes, competitions, lessons, focus areas, technical priorities and time limits come only from what the user said in this conversation, never from memory, earlier weeks or habit. The command refuses values it cannot find in `replyText`.
- Results:
  - `needs_input`: reply with `telegramText` exactly. It says what was understood and asks only for what is missing.
  - `clarify`: nothing was stored. If you added something the user did not say, leave it out and run the command again; otherwise ask the user `telegramText`.
  - `pending`: the full plan, v1. Reply with `telegramText` exactly.
- If the same message also changes something else (`… and no salmon this week`), add `"changes": {"excludeIngredients": ["salmon"]}` to the same JSON, using the change mapping below.

## Changing A Pending Plan

- Run `npm run --silent weekly-plan -- revise --expect-version N --changes-json-stdin` with the JSON in a quoted heredoc, where N is the version the user was looking at. Reply with the returned `telegramText` exactly. A revision stores a new version, restarts the 12-hour review window and never touches Todoist. A change that alters nothing keeps the version and its deadline.
- Golf changes go under `golf`, always with the user's exact message as `replyText`. Read the day a session is on from the plan they saw:
  - `Move wedges to Thursday` → `{"golf": {"replyText": "Move wedges to Thursday", "moves": [{"from": "monday", "to": "thursday"}]}}`. A practice session swaps with Thursday's, or Thursday becomes golf and its old day becomes the rest day. Rounds and lessons move the same way.
  - `Tuesday needs to be the rest day` or `Make Sunday the rest day` → `{"golf": {"replyText": "…", "restDay": "tuesday"}}`
  - `I'm also playing Friday` → `{"golf": {"replyText": "…", "addRounds": [{"day": "friday"}]}}`. `I'm not playing Wednesday after all` → `"removeRounds": ["wednesday"]`.
  - `Saturday is now a competition` → `{"golf": {"replyText": "…", "addRounds": [{"day": "saturday", "competition": true}]}}`. The round keeps its known hole count.
  - `Putting should be the main focus` → `{"golf": {"replyText": "…", "focus": ["Putting", "Wedges 50–100 m"]}}`, keeping the other area second.
  - `I only have 30 minutes Monday` → `"minutes": {"monday": 30}`. `No range sessions this week` → `"avoid": ["range"]`. `No golf next week` → `"activeDays": 0`. `Lesson on Thursday` → `"addLessons": [{"day": "thursday"}]`. `My coach wants me working on clubface control` → `"technicalPriority": "Clubface control"`.
- Other changes: `Gym 3 times` → `{"targets":{"gym":3}}`; `Stretch four times` → `{"targets":{"stretch":4}}`; `Meal prep only once` → `{"targets":{"mealPrep":1}}`; `Move Friday gym to Sunday` → `{"moves":[{"activity":"gym","from":"friday","to":"sunday"}]}`; `Don't use salmon` → `{"excludeIngredients":["salmon"]}`; `Add pasta` → `{"addMeals":["turkey-pasta"]}`; `Add bananas to the shopping list` → `{"addShopping":[{"name":"Bananas","section":"fruit"}]}`; `Skip Saturday completely` → `{"skipDays":["saturday"]}`; `I'm busy on Wednesday` → `{"dayLoads":{"wednesday":"heavy"}}`.
- If a change is unclear, ask one short question instead of guessing. If `revise` returns `clarify`, handle it as for answers. If it reports another error, for example that an existing Todoist task cannot be moved, say so plainly.

## Accepting And Cancelling

- Only when the pending version is the latest plan the user saw and they reply with a plain acceptance such as `OK`, `Looks good`, `Create it`, `Yes` or `Go ahead`, run `npm run --silent weekly-plan -- accept --version N --reply-text "EXACT_REPLY"` and reply with `telegramText`.
- `Skip this week`, `Cancel the weekly plan` or `Don't create these`: `npm run --silent weekly-plan -- cancel --reason "EXACT_REPLY"`, then reply with `telegramText`. This also works while the plan waits for golf answers.

## The Golf Week

- The golf part plans one week toward consistently good competitive golf: the user's rounds and lessons are fixed, golf tasks already in Todoist count, and practice fills the other days up to six golf days with one golf-free day. Each golf day gets one Todoist task with the whole session in its description.
- It plans training, not swing technique. Never add mechanics or a diagnosis (`your hips fire early`, `change your grip`). A technical priority appears only in the user's or their coach's words; otherwise the plan says to work on the current priority from their lesson.
- It uses the user's saved golf cue word and the names of their saved pre-round routine, bad-shot reset and competition routine. It only reads them. Remembering anything, such as a normal golf week, follows the memory rules: only on the user's explicit request, with `npm run memory -- remember --category golf --key normal-week --value "…" --source telegram`.
- Observations such as `My putting inside 2 m was bad last week` can become the focus when the user offers them as what to work on. Never store them, and never invent statistics.
- No weather, no golf statistics, no bookings, and no scheduled or post-round messages. A debrief happens only when the user asks (`Debrief my round`).

## Never

- Never create weekly-plan tasks yourself with the Todoist helper, never rebuild the plan at apply time, and never answer the golf questions for the user.
