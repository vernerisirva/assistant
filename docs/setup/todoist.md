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

## Creating A Task

`--content` plus optional `--due`, `--label`, `--priority`, `--project-id`, and `--section-id` is enough for a one-line task.

The canonical command for anything with a multiline description is `--task-json`:

```bash
npm run todoist -- add --task-json '{"content":"Review AI research updates","description":"Goal:\nFind 1-3 AI/LLM updates worth reading or testing.\n\nSources:\n- [Hugging Face Daily Papers](https://huggingface.co/papers)\n- [arXiv cs.CL](https://arxiv.org/list/cs.CL/recent)\n\nDone when:\n- One useful paper is identified.","dueString":"tomorrow"}' --dry-run --text
```

Keep the JSON inside single quotes and use one backslash for `\n`. The CLI parses the JSON, so `\n` becomes a real line break before the payload reaches Todoist. Never hand-escape multiline Markdown inside a plain `--description` shell argument; Todoist must never receive a literal `\n`.

Individual flags and `--task-json` can be combined, and an explicit flag wins over the same field in the JSON. Both routes build the payload through the same pipeline, so formatting does not depend on how the command was written.

`--dry-run` prints the exact payload without calling Todoist. Add `--text` for a readable preview that shows the description line by line plus any `Adjusted:` and `Check:` notes. The dry-run payload is byte-for-byte what a real `add` sends.

Supported `--task-json` fields: `content`, `description`, `dueString`, `dueLang`, `priority`, `projectId`, `sectionId`, `parentId`, `labels`, `deadlineDate`. Common aliases such as `due`, `due_string`, and `project_id` are accepted. Anything else is rejected instead of being forwarded to Todoist.

## Task Formatting

One pipeline in `scripts/lib/todoist-create.mjs` builds every creation payload, using the shared primitives in `scripts/lib/todoist-format.mjs`. The exact-update formatting cleanup uses the same primitives, so `add` and `update` cannot drift apart.

Title (`content`):

- One short actionable line naming the task.
- Headings, leading bullets, and Markdown that only wraps the whole title are removed.
- Extra title lines are moved into the description rather than dropped.
- Whitespace is collapsed; wording is never rewritten.
- A URL in the title, a title repeating the due date, and a very long title produce a `Check:` warning, not a silent edit.

Description:

- CRLF becomes LF, escaped newlines from shell transport become real line breaks, and leading/trailing blank lines are removed.
- Three or more blank lines collapse to one blank line between sections.
- Malformed bullet and numbered-list spacing is normalized; nested list indentation is kept.
- Markdown links, bold, italic, headings, numbered lists, tables, indented code, and fenced code blocks are preserved exactly, including whitespace inside fences.
- A first description line that only repeats the title is dropped; a first line that adds information is kept.

Validation rejects empty content, a non-string description, an out-of-range priority, non-string labels, unsupported fields, a title longer than 500 characters, and a description longer than 16384 characters. A multiline title is rejected on `update`, where there is no fetched description to merge it into.

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
