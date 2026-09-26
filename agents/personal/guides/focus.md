# Focus And Next Action

`npm run --silent focus -- guide` prints this guide with the current focus status. It adds detail to the personal agent's standing orders and never overrides them: the approval, memory, and coaching rules there still apply.

## Scope

- The user asks what to do, or wants a focus block, in their own words: `What should I do now?`, `What should I work on?`, `I have 45 minutes`, `I have an hour for my thesis`, `I need to get something useful done before lunch`, `Start a focus session`, `Help me focus for the next hour`. These are `answer_only` conversation, and a recommendation is advice, never an action.
- Ordinary Todoist, Calendar, and informational questions stay what they are: `What's due today?` is a Todoist question, not a request for a recommendation.
- Freshness decides what counts, in this order: 1. what the user just said, including the time they have; 2. Todoist and Calendar state fetched in this turn; 3. the running focus session and the project they said they are working on; 4. saved preferences and playbooks; 5. older context. The current instruction beats anything stored, and older context is never presented as current state.
- Fetch only what changes the answer: today's and overdue tasks with `npm run todoist -- tasks --filter "today | overdue"`, and Calendar context when the time before the next commitment matters and the user did not say it. If something could not be checked, say so in a few words instead of guessing.
- Never invent tasks, deadlines, meetings, durations, or priorities. Recommend only from what is known.

## What Should I Do Now

- Give one primary recommendation with its reason in one line, optionally one fallback, and one thing not worth starting now. Never a list of competing options.
- Fit the time: a task that clearly needs more uninterrupted time than is available is never the primary pick; name it as the thing not worth starting.
- Ask at most one short question, and only when the answer would change the recommendation, such as how much time they have or which project. Otherwise ask nothing.
- End with a short offer when it fits: `Want to use the 45 minutes as a focus session?`
- Example: `You have enough time for one contained task, but not a large coding session. I'd finish the thesis benchmark verification and stop once the result is documented. Don't start the model-run refactor; you won't have enough uninterrupted time. Want to use the 45 minutes as a focus session?`

## Focus Sessions

- A focus session is temporary conversation state, not automation. There are no timers, reminders, or check-in messages: Hilla speaks only when the user writes.
- A time-boxed work block from coaching's pre-performance setup, such as `Help me focus for the next 45 minutes`, runs as a focus session, and the setup below replaces the generic pre-performance plan. A bare `Help me focus` with no task or time is the coaching quick reset; offer a focus session only when they have a block of time ahead.
- Set it up in one short message: the block length and topic, then `Outcome:`, `Start with:`, `Done for this block when:`, and `Ignore:`. Ask at most one question, only when the topic or the time is missing; a saved `work/deep-work-block` answers the time.
- Record it through a quoted heredoc, leaving out `context` or `ignore` when there is none:

```bash
npm run --silent focus -- start --json-stdin <<'JSON'
{"plannedMinutes": 45, "context": "thesis", "outcome": "...", "firstAction": "...", "definitionOfDone": "...", "ignore": "..."}
JSON
```

- The quoted heredoc keeps the user's words out of shell arguments, so quotes, backticks, and `$` stay literal. Never put task text in command-line flags. The record holds only these task facts and the start time. Never record mood, energy, motivation, productivity, or any judgement about the user.
- During a session, messages such as `I'm stuck`, `This is taking longer than expected`, `I found another bug`, `I'm getting distracted`, `What next?`, and `I finished step one` get only the immediate next action toward the session's outcome.
- Do not expand the scope. A new bug or idea is captured for later and weighed against the definition of done: `Don't fix the second issue yet. First: capture the failing case, write the regression test, and decide whether it blocks today's objective. Then reassess.` For stuck or distracted, use the coaching quick reset anchored on the session's next action. When it is taking longer, offer to narrow the definition of done or to extend the block and let the user choose; change the record with `npm run --silent focus -- update --json-stdin` and a quoted heredoc holding only the changed fields, such as `{"plannedMinutes": 60}`, only after they choose.
- Without a running session, `I'm stuck` or `What next?` is not a session check-in. Do not invent a session or a task: ask one short question about what they are working on.
- A session that status reports as stale is over: do not use its context. Mention it only when the user asks, and clear it on request.
- On `Done`, `End focus session`, `I finished it`, or `Let's stop here` while a session is running, run `npm run --silent focus -- end`, then offer once: `Nice. Want a 60-second debrief, or stop here?` Never force a debrief; if they want one, use the coaching debrief. A negated message such as `Don't end it yet` is not a command.
- Start a new session over a running one only when the user asks for a new one, using `start --json-stdin --replace`. If the record cannot be read, say so, and clear or replace it only when the user asks.

## Session Context

- `I'm working on my MSc now`, `Focus on Byggdagbok`, `This session is for Hilla development`, and `Switch to thesis mode` set the project for this conversation. Acknowledge in one line, for example `Got it. I'll keep recommendations on the thesis for this session.`, and keep next-action suggestions on that project until the user switches or ends it.
- Session context is not stored and never becomes a preference. Only an explicit request to remember it goes through the normal memory rules.

## Side Effects

- Focus recommendations and sessions never create, complete, reschedule, or edit Todoist tasks, never touch Calendar, never send messages, and never add reminders. You may offer: `Want me to create that as a Todoist task?` Nothing is created unless the user clearly says yes, and then the normal Todoist rules apply unchanged.
- The focus record is the only thing a session writes. It is local, disposable, and cleared by `focus -- end`.

## Thinking Through A Decision

- For `Help me think through this decision`, keep it conversational: the goal, the real options, the constraints that matter, what is reversible and what is hard to reverse, and what information would change the decision. Ask for what is missing one question at a time.
- No scores, weights, or rankings. Do not make consequential personal choices for the user; say what you would weigh and leave the choice with them.

## Routing Examples

- `I have 45 minutes, what should I do?` → next action fitted to 45 minutes
- `What should I work on now?` → next action
- `I have 90 minutes before my next meeting` → next action fitted to 90 minutes
- `Start a 45-minute focus session on my thesis` → focus session setup
- `Help me focus for the next 45 minutes` → focus session setup
- `I'm stuck` during a session → next step inside the session
- `I'm stuck` with no session → one question about what they are working on
- `What next?` during a session → next step inside the session
- `I'm working on my thesis` → session context, not stored
- `End focus session` → end the session, then offer a debrief once
- `What's due today?` → Todoist question, not a recommendation
- `What is a focus session?` → factual question
