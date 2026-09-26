# Product Overview

Hilla is a personal Telegram assistant that runs locally through OpenClaw. It helps with daily logistics, reminders, routines, health support, food planning, golf/admin tasks, research, and safe follow-through on personal commitments.

The product direction is practical rather than expansive:

- Keep one Telegram-facing assistant experience.
- Hide specialist agents behind the personal agent.
- Make useful low-risk actions fast.
- Keep risky or externally visible side effects approval-gated.
- Prefer small improvements that make day-to-day use clearer, quieter, and more reliable.

## Current Agents

- `personal`: main Telegram-facing assistant and router, including on-demand coaching.
- `admin`: Gmail, Calendar, Todoist, Min Golf search, reminders, meeting prep, and logistics.
- `health`: workouts, food planning, groceries, sleep consistency, and routine support.
- `research`: source-backed lookup, comparisons, and planning support.

## On-Demand Coaching

Hilla coaches when asked: golf and work performance, attention, staying present, recovering from mistakes, confidence, process routines, and sleep habits. It works like a practical coach. It asks only the questions that change the advice, picks one small intervention, and gives one action or cue. Five modes cover it: quick reset, in-performance, pre-performance setup, debrief, and sleep coaching.

Coaching is conversation only. It never creates tasks, events, reminders, or routines, runs on no schedule, and stores a playbook entry such as a golf cue word only when the user sets it explicitly. It is not therapy. It does not diagnose, and it points to professional care for persistent sleep problems or significant distress. The contract lives in `agents/personal/AGENTS.md`; `npm run inbox:debug -- "I just made a double bogey"` shows how a message would be handled.

## Playbooks And Debriefs

Hilla keeps the user's own routines so coaching stops inventing a new method each time:

- `Save that as my bad-shot reset`, `Remember this as my meeting prep routine`: saved only on an explicit request or a yes. `That reset worked really well today` gets an offer, not a save.
- `Use my pre-round routine`, `What's my bad-shot reset?`, `Show my playbooks`: coaching and focus use a saved routine that fits before anything new, unless the situation differs or the user asks for another approach.
- `Change my golf cue word to commit`, `Add one breath before the target step`: one exact change, or a question when the target is unclear.
- `Debrief my round`, `Debrief this focus session`: a few prompts, then `Keep`, `Adjust`, and `Possible lesson`. The lesson is saved only if the user says yes.

Playbooks live in the normal memory store. They hold behaviour, never conclusions about the person: `Before presentations: review the opening sentence for two minutes`, not `lacks confidence`.

## What's Waiting On You

`What are you waiting on from me?`, `Anything pending?`, or `What do I need to approve?` gets one read-only list of the things Hilla is genuinely waiting on: a weekly plan awaiting review, with the time it applies, and a running focus session. The list is built from stored state, never from conversation guesses, so a task that is due or a habit Hilla could suggest is not "pending". If a source cannot be read, Hilla says so instead of claiming nothing is waiting. Approval questions asked in chat are not stored; Hilla adds one only if it asked it earlier in the same conversation.

## Focus And Next Action

Tell Hilla the situation and it helps pick the next action:

- `I have 45 minutes, what should I do?` gets one recommendation that fits the time, optionally a fallback, and one thing not worth starting. It works from what the user just said, then Todoist and Calendar state fetched now, then the running session and project, then saved preferences, and it never invents tasks or deadlines.
- `Start a 45-minute focus session on my thesis` sets up one block: outcome, first action, done-when, and what to ignore. `I'm stuck`, `I found another bug`, or `What next?` during the block get the immediate next step, without new scope. `Done` ends it and offers an optional 60-second debrief.
- `I'm working on my thesis` keeps recommendations on the thesis for this conversation. It is not stored.

A focus session is a small local record under `.openclaw/state/focus/`, holding task facts only and deleted when the session ends. There are no timers or scheduled messages, and recommendations never create, complete, or move Todoist tasks, touch Calendar, or add reminders. Hilla may offer to create a task, and then the normal Todoist rules apply.

## Product Priorities

1. Reliable Telegram operation.
2. Clear approvals for side effects.
3. Useful routines without notification noise.
4. Better task and calendar follow-through.
5. Maintainable prompts, config, docs, and tests.

Planning docs:

- Roadmap: `docs/product/roadmap.md`
- Backlog: `docs/product/backlog.md`
