# Telegram Setup

1. Open Telegram and message `@BotFather`.
2. Create a bot and copy the bot token into `TELEGRAM_BOT_TOKEN` in `.env`.
3. Get your numeric Telegram user ID from a trusted Telegram user info bot or from OpenClaw onboarding.
4. Put the numeric ID in `TELEGRAM_USER_ID`.
5. Keep `dmPolicy` as `allowlist`.
6. Render config with `npm run render:config`.
7. Run OpenClaw diagnostics with `npm run doctor`.
8. Start the gateway with `npm run start:openclaw`.

Secret handling: `.env` and the rendered `.openclaw/openclaw.json` are local secrets. The rendered config includes `TELEGRAM_BOT_TOKEN`. Both files are gitignored; do not share them, commit them, force-add them, or paste their contents into tickets, issues, chats, or logs.

The first version uses one Telegram bot. Specialist agents are hidden behind the personal agent.
