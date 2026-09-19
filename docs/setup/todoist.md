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

The canonical command for anything with a multiline description, an apostrophe, or quotes is `--task-json-stdin` with a quoted heredoc:

```bash
npm run todoist -- add --task-json-stdin --dry-run --text <<'JSON'
{
  "content": "Review AI research updates",
  "description": "Goal:\nFind 1-3 AI/LLM updates worth reading or testing.\n\nSources:\n- [Hugging Face Daily Papers](https://huggingface.co/papers)\n- [arXiv cs.CL](https://arxiv.org/list/cs.CL/recent)\n\nDone when:\n- One useful paper is identified.",
  "dueString": "tomorrow"
}
JSON
```

The task text never enters a shell argument, so nothing in it can break the quoting. The quoted `<<'JSON'` delimiter passes the body literally, so `$HOME`, `$(command)`, and backticks stay literal. `\n` in the JSON becomes a real line break before the payload reaches Todoist.

`--task-json '{...}'` is kept for backwards compatibility and is fine for simple text, but a single apostrophe such as `Call O'Connor` breaks the surrounding single-quoted argument, so prefer stdin for anything user-supplied. Never hand-escape multiline Markdown into a plain `--description` argument: the command refuses a literal `\n` there and tells you to use stdin.

Individual flags, `--task-json`, and `--task-json-stdin` all feed the same normalization and plan builder, and an explicit flag wins over the same field in the JSON. `--task-json` and `--task-json-stdin` cannot be combined. Invalid or empty stdin fails with a clear error and sends nothing.

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

- CRLF becomes LF and leading/trailing blank lines are removed.
- A run of blank lines collapses to one blank line between sections.
- Malformed bullet and numbered-list spacing is normalized.
- Indentation is preserved. List continuation text, nested list content, intentionally indented text, and indented code keep their indentation. The one exception is the first line of a description, where leading whitespace cannot relate to anything above it and is treated as a quoting artifact.
- Trailing whitespace is removed outside fenced code blocks. Todoist renders real line breaks as line breaks, so a trailing double space is not a hard break there. Inside a fence, whitespace is untouched.
- Markdown links, bold, italic, headings, numbered lists, tables, indented code, and fenced code blocks are preserved exactly, including whitespace inside fences.
- A first description line that only repeats the title is dropped; a first line that adds information is kept. A list item is never dropped, even when its text matches the title, so the first step of a checklist survives.
- Backslashes are never rewritten, anywhere. A Windows path such as `C:\notes\log.txt`, a regex, or a `\n` inside a code block reaches Todoist exactly as written, whether it came from JSON, from stdin, or was read back from Todoist.
- A literal `\n` in a plain `--content` / `--description` / `--detail` / `--replacement-description` shell argument is ambiguous: it is either multiline text that lost its line breaks in quoting, or a backslash the user actually wrote. The command refuses the value and names the stdin interface rather than guessing, so Todoist never receives a literal `\n` meant as a line break and never loses a backslash meant literally. Pass such text as JSON on stdin.

A dry run distinguishes a description that is being set, one being explicitly cleared (`(empty)`), and one an update leaves alone (`(unchanged)`). Labels being cleared show as `(cleared)`. The preview never says a field changes unless that field is in the wire payload, and an explicit clear really does reach Todoist as `""`.

Title normalization removes heading markers, a leading bullet, and Markdown that wraps the whole title. A leading number is left alone, because `2024. Review the year` is text rather than list syntax.

Validation rejects empty content, a non-string title or description, an out-of-range priority, non-string labels, unsupported fields, a title longer than 500 characters, and a description longer than 16384 characters. A multiline title is rejected on `update`, where there is no fetched description to merge it into, and an update that would change no field at all is rejected too.

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
