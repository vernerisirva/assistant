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

Calendar access is still a setup path in this first skeleton, not an implemented runtime mutation. Configure it later through an OpenClaw-compatible tool, script, or skill. The assistant may read calendar context, flag conflicts, and draft changes once the integration exists.

Calendar planning v1 is intentionally narrower: `npm run calendar:plan` analyzes a supplied normalized read-only event snapshot. It does not implement a Google Calendar API client and does not fetch Calendar events itself. Runtime Calendar retrieval remains handled by the existing OpenClaw/Telegram context path. The planner cannot create, edit, delete, invite, RSVP, email, book, or otherwise mutate Calendar data.

Calendar creation v1 is also intentionally narrow: `npm run calendar:create -- ... --dry-run` builds and validates a normalized creation preview only. It does not implement a Google Calendar API client or a Calendar write path, so it must never report that an event was created. Runtime Calendar retrieval remains with the existing OpenClaw/Telegram context path, and a future Calendar write tool must be explicitly documented before it can use a policy-allowed preview.

One preview is policy-allowed when the user explicitly requests exactly one low-risk personal event with a clear title, date, start, duration or end, no guests, no recurrence, no sensitive content, and no external impact. The helper defaults to the primary personal Calendar and `Europe/Stockholm` only when those fields are omitted. It asks for clarification for missing or ambiguous details and possible duplicates. Approval remains required for guests/invitations, existing event edits/deletes/moves, recurrence, multiple events, named non-primary or shared Calendars, sensitive/other-person impact, uncertain screenshot/OCR-derived substantive details, booking/payment, and browser submissions.
