# Assistant

Local OpenClaw multi-agent assistant accessed through one Telegram bot.

## What This Builds

This repository stores the configuration, agent standing orders, safety policy, and helper scripts for a personal assistant that runs on this Mac. OpenClaw provides the gateway, Telegram channel, agents, sessions, tools, and automation runtime.

The first build creates a safe setup path. It does not commit real credentials and does not grant autonomous side-effect permissions. Your local `.env` file and rendered `.openclaw/openclaw.json` are local secrets, and the rendered config includes the Telegram bot token. Both files are gitignored; do not share them, commit them, force-add them, or paste their contents into tickets, issues, chats, or logs.

## Agents

- `personal`: main Telegram-facing assistant and router.
- `admin`: Gmail, Google Calendar, reminders, meeting prep, and logistics.
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

3. Fill `.env` with your Telegram bot token, Telegram numeric user ID, model names, Gmail account, and Google Cloud details.

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

## Safety

The assistant starts in confirm-before-action mode. It may summarize, draft, plan, and recommend, but sending email, changing calendar events, making purchases, submitting browser forms, editing unrelated files, or running state-changing shell commands requires Telegram approval.

See `docs/security/approval-model.md`.
