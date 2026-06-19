# Todoist Setup

Todoist is used for task and commitment tracking.

## Token

Create a personal API token in the Todoist web app:

1. Open Todoist in the browser.
2. Open Settings.
3. Open Integrations.
4. Open the Developer tab.
5. Copy the API token.

Add it to your local `.env` file:

```bash
TODOIST_API_TOKEN=your-token-here
```

Do not commit or paste the token into chats, issues, logs, or docs.

## Local Commands

Read-only examples:

```bash
npm run todoist -- projects
npm run todoist -- tasks --filter today
npm run todoist -- tasks --filter "overdue | today"
```

Draft write examples:

```bash
npm run todoist -- add --content "Buy Greek yogurt" --due tomorrow --label food --dry-run
npm run todoist -- close --task-id TASK_ID --dry-run
```

Live writes omit `--dry-run`. A clear user instruction can be enough for low-risk additive task creation:

```bash
npm run todoist -- add --content "Buy oats" --due tomorrow
npm run todoist -- close --task-id TASK_ID
```

## Approval Rule

Reading configured Todoist tasks and projects is allowed. Creating a task is allowed without a second approval only when the user explicitly asks, task content and due date/project are complete and unambiguous, the action is additive, and the task is easy to undo.

Editing, completing, reopening, deleting, moving, commenting on, or rescheduling Todoist tasks requires explicit Telegram approval. Approval is also required for task creation when details are inferred from image/OCR or the target/date is uncertain.

Todoist API docs: https://developer.todoist.com/api/v1/
