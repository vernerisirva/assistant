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
npm run todoist -- exact-update --task-id TASK_ID --action format-description --dry-run
npm run todoist -- exact-update --task-id TASK_ID --action append-detail --detail "Keep this easy after golf" --dry-run
```

Live writes omit `--dry-run`. A clear user instruction can be enough for low-risk task creation or low-risk exact task updates:

```bash
npm run todoist -- add --content "Buy oats" --due tomorrow
npm run todoist -- exact-update --task-id TASK_ID --action format-description
npm run todoist -- exact-update --task-id TASK_ID --action wording-description --replacement-description "Same meaning, cleaner wording"
npm run todoist -- exact-update --task-id TASK_ID --action append-detail --detail "User-provided detail"
npm run todoist -- exact-update --match-content "Gym workout" --action complete
npm run todoist -- close --task-id TASK_ID
```

`exact-update` first resolves exactly one task by `--task-id` or exact `--match-content`. If more than one task matches, it returns `clarification_needed` instead of guessing.

## Approval Rule

Reading configured Todoist tasks and projects is allowed. Creating a task is allowed without a second approval only when the user explicitly asks, task content and due date/project are complete and unambiguous, the action is additive, and the task is easy to undo.

The assistant may also proceed without a second approval when the exact task is clear and the user explicitly asks to rename it, append a description or comment, replace a description, change due date, or add/remove labels. Replacing a description requires explicit wording such as "replace/update the description."

Reopening, deleting, moving between projects/sections, bulk editing, shared/project-wide changes, ambiguous task targets, sensitive content, inferred update content, and changes affecting other people require explicit Telegram approval. Screenshot/reference-derived exact task targets may proceed without extra approval for explicit low-risk formatting, wording, or detail updates. In that case, use the screenshot/reference only to identify the task, then fetch/read and reformat the actual Todoist content. Approval is still required for task creation when details are inferred from image/OCR or the target/date is uncertain.

For screenshot/reference-derived formatting cleanup, the safe pattern is:

1. Resolve exactly one personal Todoist task.
2. Fetch/read the actual Todoist task content.
3. Transform only the fetched content or explicit user-provided text.
4. Update the task and confirm briefly.

Todoist API docs: https://developer.todoist.com/api/v1/
