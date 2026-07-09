# OpenClaw Telegram Assistant Design

Date: 2026-05-18
Repository: https://github.com/vernerisirva/assistant
Status: Approved for implementation planning

## Goal

Build a local-first personal AI assistant that runs on this Mac, is accessed primarily through Telegram, and uses OpenClaw agents for multi-agent routing and long-running routines.

The assistant is for everyday life rather than coding. It should help with day planning, Gmail, Google Calendar, health, workouts, meal planning, grocery lists, research, and general personal administration. It should start with explicit approval for side effects, then later graduate trusted routine actions one by one.

## Design Principles

- One Telegram front door: the user talks to one main assistant, not a visible collection of bots.
- Hidden specialist agents: personal, admin, health, and research agents work behind the scenes.
- Local orchestration: OpenClaw, routing, prompts, approvals, schedules, and local state run on the Mac.
- Remote model flexibility: use the best available remote model by default, with per-agent model overrides and fallbacks.
- Trust first: actions that modify outside state require explicit Telegram approval until promoted later.
- Health support without tracking burden: the assistant should coach, plan, and check in without requiring manual logs.
- Practical nutrition: every day should have an eating plan and grocery support that makes healthier choices easier.

## External References

The implementation should follow current official OpenClaw behavior verified during design:

- OpenClaw recommended installation path: `npm install -g openclaw@latest` and `openclaw onboard --install-daemon` in the OpenClaw README.
- Telegram supports Bot API setup, DM allowlists, inline buttons, and execution approval routing: https://docs.openclaw.ai/channels/telegram
- Multi-agent routing supports per-agent workspaces, agent directories, sessions, channel bindings, and per-agent models: https://docs.openclaw.ai/concepts/multi-agent
- Automation supports cron, heartbeat, background tasks, hooks, and standing orders: https://docs.openclaw.ai/automation
- Gmail webhook helpers support Gmail Pub/Sub setup and webhook delivery: https://docs.openclaw.ai/cli/webhooks
- Model configuration supports model selection and failover patterns: https://docs.openclaw.ai/concepts/models

## Architecture

OpenClaw Gateway runs locally as the control plane. It owns Telegram connectivity, sessions, schedules, tool access, and delivery back to the user.

Telegram is configured as the main channel. The first user-facing version uses a single Telegram bot/account. Telegram DM access should be allowlisted to the user's numeric Telegram ID. Approval prompts should use Telegram messages, and inline buttons should be enabled where OpenClaw supports them.

The assistant uses four OpenClaw agents:

- `personal`: primary conversational assistant, router, memory keeper, and user-facing voice.
- `admin`: Gmail, Google Calendar, reminders, email drafts, meeting prep, and personal logistics.
- `health`: workouts, daily eating plans, grocery lists, meal decisions, sleep/routine support, and adaptive nudges.
- `research`: source-backed lookups, comparisons, local errands, nutrition research, and planning support.

The `personal` agent receives normal Telegram messages. It handles simple tasks directly and delegates specialist work to `admin`, `health`, or `research` when the task benefits from separation. Specialists report back through `personal`, which turns their output into one coherent Telegram response.

Each agent should have its own workspace, prompt files, standing orders, sessions, and optional model override. The workspaces are organizational boundaries, not hard security sandboxes by themselves; any sensitive tool access still needs approval policy enforcement.

## Model Strategy

The Mac runs orchestration, but the model layer should remain configurable. The default setup should use API-key based remote models because background jobs and scheduled tasks need predictable unattended access.

Initial model policy:

- `personal`: strongest general assistant model available.
- `admin`: strong, reliable model with careful instruction following.
- `health`: strong conversational model tuned through prompt behavior, not medical authority.
- `research`: model with good synthesis, browsing/tool discipline, and citation habits.

Fallback policy:

- Routine summaries and nudges may use a faster or cheaper fallback.
- High-stakes actions, approvals, health guidance, financial/purchasing decisions, and calendar/email modifications should use the primary model.
- Provider and model names belong in configuration, not hard-coded scripts.

## Google Integration

Google is the first productivity ecosystem.

Gmail:

- Use OpenClaw's Gmail Pub/Sub/webhook helper where appropriate.
- The assistant may summarize, classify, and draft responses.
- Sending, archiving, deleting, labeling, or otherwise changing email requires explicit Telegram approval.

Google Calendar:

- Use Google Calendar API access through an OpenClaw-compatible tool, script, or skill.
- The assistant may read upcoming events, detect conflicts, suggest buffers, prepare daily briefs, and draft event changes.
- Creating, editing, or deleting events requires explicit Telegram approval.

The first implementation should include setup templates and validation for Google OAuth/PubSub values, but real credentials should be configured interactively and kept out of git.

## Health And Lifestyle Agent

The health agent is a supportive coach, not a medical system and not a compliance tracker.

It should:

- Start with moderate proactive check-ins.
- Adapt timing, tone, and frequency based on user reactions.
- Encourage workouts, movement, sleep consistency, and healthier food choices.
- Help when the user wants to eat unhealthy food by discussing trade-offs and suggesting realistic alternatives.
- Avoid shame, moralizing, extreme dieting advice, or medical claims.
- Ask clarifying questions when nutrition, injury, medication, or medical conditions are involved.

The assistant does not need Apple Health, wearable data, or manual workout logs for the first version. It should infer likely support moments from calendar context and Telegram conversation.

## Food Planning And Groceries

Food planning is a first-class health routine.

Daily meal plan:

- Provide a practical daily eating plan as part of the morning brief or the prior evening review.
- Consider schedule load, likely workout timing, time available to cook, and known preferences.
- Prefer simple, repeatable meals over elaborate plans.
- Include easy backup options for busy days.

Grocery planning:

- Produce a grocery list once or twice per week.
- Group items by store section: protein, vegetables, fruit, carbs, dairy/alternatives, snacks, breakfast, pantry, and backup meals.
- Keep healthy convenience foods available so good choices are easy.
- Support ad hoc messages such as "what should I buy today?" or "what can I cook with chicken, eggs, and rice?"

Purchases:

- The assistant may build carts or shopping lists.
- It must ask for approval before placing orders, paying, booking delivery, or submitting forms.

## Daily And Weekly Routines

Initial schedule uses Europe/Stockholm time and should be configurable.

Morning brief, default 08:00:

- Calendar summary.
- Important Gmail summary.
- Top priorities.
- Today's meal plan.
- Workout or movement anchor.

Midday check-in, default 12:30:

- Food, movement, energy, and schedule pressure.
- Back off if the user repeatedly ignores it.

Workout-window nudge, default adaptive between 16:00 and 19:00:

- Pick timing from calendar availability.
- Encourage a realistic plan rather than demanding perfection.

Evening review, default 21:00:

- Tomorrow's calendar.
- Open admin actions.
- Grocery or meal prep needs.
- One small health reflection.

Weekly review, default Sunday evening:

- Calendar/email patterns.
- Health friction points from conversation.
- Food/grocery improvements.
- One small adjustment for the next week.

Event-driven routines:

- New important Gmail: summarize and suggest next action.
- Calendar conflict or tight travel buffer: flag and propose a fix.
- User expresses cravings or low motivation: switch to supportive health coach mode.

## Safety And Permissions

Allowed without extra approval:

- Read Telegram messages sent to the assistant.
- Summarize configured Gmail and Calendar content.
- Draft emails, calendar changes, plans, grocery lists, and recommendations.
- Ask clarifying questions and send check-ins.
- Run read-only project diagnostics during setup.

Approval required:

- Send, delete, archive, or label email.
- Create, edit, or delete calendar events.
- Run shell commands that change files, apps, settings, or system state.
- Use browser sessions to submit forms, purchase, book, post, or message.
- Edit or delete local files outside implementation work explicitly requested by the user.
- Access sensitive local data beyond configured assistant workspaces.
- Make purchases or financial decisions.

Approval flow:

- The assistant describes the proposed action, target, expected effect, and risk.
- The user approves or denies in Telegram.
- Approved actions are logged with timestamp, agent, requested action, decision, and result.
- Denied actions are not retried unless the user asks.

Long-term trust ladder:

- Start with confirm-before-action for all side effects.
- Promote narrow routines one at a time after repeated successful approvals.
- Keep high-risk domains permanently approval-gated unless the user explicitly changes policy.

## Repository Shape

The implementation should create a local project in this repository with:

- `README.md`: setup, runbook, and operating guide.
- `.env.example`: non-secret configuration placeholders.
- `.gitignore`: local state, credentials, logs, and OpenClaw runtime artifacts.
- `agents/personal`, `agents/admin`, `agents/health`, `agents/research`: prompts, standing orders, and per-agent notes.
- `config/`: OpenClaw configuration templates for models, Telegram, routing, approvals, schedules, and Google integration.
- `scripts/`: setup, validation, doctor, start, and backup helpers.
- `docs/`: design, implementation notes, security notes, and operating logs templates.
- `data/` or `logs/`: local runtime state ignored by git.

The first implementation target is a usable skeleton plus setup path. It should not require real credentials in git and should not assume credentials are already available.

## Testing And Verification

Implementation verification should include:

- Static validation of generated config files.
- Script checks for Node, npm, OpenClaw availability, and required environment variables.
- Dry-run approval examples for email, calendar, shell, browser, and purchase actions.
- Prompt review checks to make sure specialist agents respect approval boundaries.
- Manual Telegram pairing checklist.
- Manual Google OAuth/PubSub setup checklist.
- OpenClaw `doctor` or equivalent diagnostics after setup.

## Open Questions For Implementation Planning

These are configuration questions, not design blockers:

- Exact Telegram bot token and numeric Telegram user ID.
- Preferred model provider and model IDs.
- Gmail address and Google Cloud project details.
- Preferred wake/work hours, meal times, workout windows, and grocery shopping days.
- Food preferences, allergies, disliked foods, budget, and cooking equipment.
- Whether to use a private Telegram group/topics later for specialist visibility.

## Out Of Scope For First Build

- Automatic purchases or delivery orders.
- Wearable/Apple Health integrations.
- Fully autonomous email/calendar changes.
- Separate public-facing Telegram bots for each specialist.
- Advanced medical, nutrition, or injury diagnosis.
- Production cloud deployment.

