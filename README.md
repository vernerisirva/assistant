# Assistant

Local OpenClaw multi-agent assistant accessed through one Telegram bot.

## What This Builds

This repository stores the configuration, agent standing orders, safety policy, and helper scripts for a personal assistant that runs on this Mac. OpenClaw provides the gateway, Telegram channel, agents, sessions, tools, and automation runtime.

The first build creates a safe setup path. It does not commit real credentials and does not grant autonomous side-effect permissions. Your local `.env` file is the secret source for Telegram, Google, and model credentials. The rendered `.openclaw/openclaw.json` references those env vars and `.openclaw/` also contains generated local workspaces. Both paths are gitignored; do not share them, commit them, force-add them, or paste their contents into tickets, issues, chats, or logs.

## Agents

- `personal`: main Telegram-facing assistant and router.
- `admin`: Gmail, Google Calendar, Todoist, reminders, meeting prep, and logistics.
- `health`: workouts, meal planning, groceries, sleep, routine, and healthy-choice support.
- `research`: source-backed lookup, comparisons, and planning support.

## Setup

Prerequisites:

- Node.js `>=24.0.0`.
- `npm` on your shell `PATH`. On this Mac, `/opt/homebrew/bin/npm` may be needed if `npm` is not available directly.

1. Install OpenClaw:

   ```bash
   npm install -g openclaw@latest
   openclaw onboard --install-daemon
   ```

2. Copy the environment example:

   ```bash
   cp .env.example .env
   ```

3. Fill `.env` with your Telegram bot token, Telegram numeric user ID, model names, Gmail account, Google Cloud details, and optional Todoist API token.

4. Validate local configuration:

   ```bash
   npm run validate:env
   npm run render:config
   npm run doctor
   ```

5. Start OpenClaw:

   ```bash
   npm run start:openclaw
   ```

6. After the Telegram flow works, install the same repo config as the macOS
   launchd service:

   ```bash
   npm run install:launchd
   openclaw gateway status
   ```

   Keep this repository outside macOS-protected folders such as `~/Documents`.
   The launchd service runs in the background and may not be allowed to read
   those folders without additional privacy permissions.

## Safety

The assistant starts in confirm-before-action mode. It may summarize, draft, plan, and recommend, but sending email, changing calendar events, making purchases, submitting browser forms, editing unrelated files, or running state-changing shell commands requires Telegram approval.

Todoist task writes also require Telegram approval. Reading configured Todoist tasks and projects is allowed once `TODOIST_API_TOKEN` is set locally.

Min Golf Phase 1 is read-only tee-time availability search. Phase 2 can draft exact booking approval requests and attempt a non-payment booking after Telegram approval. Payment, cancellation, adding players, editing bookings, cart booking, check-in, BankID, and third-party redirects remain stop points.

Memory Phase 1 stores explicit local preferences in `.openclaw/state/memory/preferences.json`. Low-risk preferences can be remembered when you explicitly ask; sensitive memories require Telegram approval. You can ask what the assistant remembers and ask it to forget entries.

Routine Phase 1 adds memory-aware briefing templates through `npm run routine`. These generate structured Telegram prompts for morning brief, midday check-in, workout window, evening review, and weekly review. Routine scheduling can be installed with `npm run routines:install` and controlled with `npm run routines:status`, `npm run routines:disable -- ROUTINE_ID`, `npm run routines:enable -- ROUTINE_ID`, and `npm run routines:set-time -- ROUTINE_ID HH:mm`. Scheduled check-ins ask light feedback about timing, tone, and detail level, but they do not perform side effects directly.

See `docs/security/approval-model.md`.

## Integrations

- Telegram: `docs/setup/telegram.md`
- Google: `docs/setup/google.md`
- Todoist: `docs/setup/todoist.md`
- Min Golf: `docs/setup/mingolf.md`
- Memory: `docs/setup/memory.md`
- Routines: `docs/setup/routines.md`
