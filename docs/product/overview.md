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

## Product Priorities

1. Reliable Telegram operation.
2. Clear approvals for side effects.
3. Useful routines without notification noise.
4. Better task and calendar follow-through.
5. Maintainable prompts, config, docs, and tests.

Planning docs:

- Roadmap: `docs/product/roadmap.md`
- Backlog: `docs/product/backlog.md`
