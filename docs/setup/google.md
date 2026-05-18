# Google Setup

Google is used for Gmail and Google Calendar.

The Google values in `.env` are local configuration for this repository. OpenClaw's Gmail helper may still prompt for, create, or use its own Google authentication flow. Use the same Gmail account from `GMAIL_ACCOUNT` and Google Cloud project from `GOOGLE_CLOUD_PROJECT` when following those prompts.

## Gmail

OpenClaw provides Gmail Pub/Sub helper commands:

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

Verify or create the Gmail Pub/Sub topic and subscription according to the OpenClaw prompts. Keep the account and project aligned with the `.env` values so diagnostics, rendered config, and the OpenClaw helper all point at the same Google setup.

The assistant may summarize Gmail and draft responses. Sending, archiving, deleting, labeling, or moving email requires Telegram approval.

## Google Calendar

Calendar access is still a setup path in this first skeleton, not an implemented runtime mutation. Configure it later through an OpenClaw-compatible tool, script, or skill. The assistant may read calendar context, flag conflicts, and draft changes once the integration exists. Creating, editing, deleting, or responding to events requires Telegram approval.
