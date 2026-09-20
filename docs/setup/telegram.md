# Telegram Setup

1. Open Telegram and message `@BotFather`.
2. Create a bot and copy the bot token into `HILLA_TELEGRAM_BOT_TOKEN` in `.env`.
3. Get your numeric Telegram user ID from a trusted Telegram user info bot or from OpenClaw onboarding.
4. Put the numeric ID in `TELEGRAM_USER_ID`.
5. Keep `dmPolicy` as `allowlist`.
6. Render config with `npm run render:config`.
7. Run OpenClaw diagnostics with `npm run doctor`.
8. Start the gateway with `npm run start:openclaw`.

Secret handling: `.env` is the local secret source for `HILLA_TELEGRAM_BOT_TOKEN`. The Hilla-specific name prevents updated OpenClaw versions from also creating an implicit `default` Telegram account from `TELEGRAM_BOT_TOKEN`. The rendered `.openclaw/openclaw.json` references the Hilla-specific environment variable and `.openclaw/` also contains generated local workspaces. Both paths are gitignored; do not share them, commit them, force-add them, or paste their contents into tickets, issues, chats, or logs.

The first version uses one Telegram bot. Specialist agents are hidden behind the personal agent.

## Variable Name

`HILLA_TELEGRAM_BOT_TOKEN` is the canonical name and the only one that
satisfies `npm run validate:env`, `npm run render:config` and the doctor. The
Hilla prefix keeps the token from being picked up as an implicit `default`
OpenClaw Telegram account.

The older unprefixed `TELEGRAM_BOT_TOKEN` is still read in one narrow place:
`npm run assistant:status` falls back to it so a runtime that has not been
migrated is reported accurately rather than as broken, and its value is
redacted from status output either way. That fallback deliberately does not
extend to validation, so an unmigrated `.env` fails loudly with the missing
canonical key rather than working by accident.
