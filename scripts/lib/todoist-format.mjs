/**
 * Shared, conservative text normalization for Todoist task content.
 *
 * Both new task creation and exact formatting updates use these primitives so
 * Todoist formatting has one implementation instead of two subtly different
 * ones. Every helper is structural only: it never rewrites wording, never adds
 * content, and never removes substantive text.
 */

const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const LIST_LINE = /^([-*+]|\d+[.)])[ \t]+(.+)$/;
// Only bullet markers are stripped from a title. A leading number is usually
// real text ("2024. Review the year"), so removing it would delete content.
const LEADING_BULLET_MARKER = /^[-*+][ \t]+/;
const WRAPPING_BOLD_ITALIC = /^\*\*\*([^*]+)\*\*\*$/;
const WRAPPING_BOLD = /^\*\*((?:(?!\*\*).)+)\*\*$/;
const WRAPPING_BOLD_UNDERSCORE = /^__((?:(?!__).)+)__$/;
const WRAPPING_ITALIC = /^\*([^*]+)\*$/;
const WRAPPING_ITALIC_UNDERSCORE = /^_([^_]+)_$/;
const URL_PATTERN = /\bhttps?:\/\/\S+/i;

/** Indentation width used to detect Markdown indented code blocks. */
const CODE_INDENT_WIDTH = 4;
/** Indentation width from which list indentation is treated as real nesting. */
const NESTED_LIST_INDENT_WIDTH = 2;

export function normalizeLineEndings(value = "") {
  return String(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Multiline text passed through a single shell argument can arrive with literal
 * `\n` two-character sequences instead of real line breaks. Decoding is limited
 * to values that contain no real line break at all, so a genuine backslash in a
 * multiline description or fenced code block is never touched.
 */
export function hasTransportEscapes(value = "") {
  const text = String(value);
  if (text.includes("\n") || !text.includes("\\n")) return false;

  // Every backslash must belong to a newline escape. A string that also carries
  // other backslashes is literal text the user wrote, such as a Windows path
  // like `C:\notes\todo.txt`, and must not be rewritten.
  return !text.replace(/\\r\\n/g, "").replace(/\\n/g, "").includes("\\");
}

export function decodeTransportEscapes(value = "") {
  const text = String(value);
  if (!hasTransportEscapes(text)) return text;
  return text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
}

/**
 * Applied only at the shell-argument boundary, where an escaped newline is a
 * quoting artifact. Text from JSON, from stdin, or read back from the Todoist
 * API keeps every backslash it has, so a path such as `C:\notes\log.txt`
 * survives normalization unchanged.
 */
export function normalizeTransportText(value = "") {
  return decodeTransportEscapes(normalizeLineEndings(value));
}

/**
 * Normalize a Todoist description while preserving Markdown that Todoist
 * renders: links, emphasis, headings, numbered lists, and fenced code blocks
 * including their exact whitespace.
 */
export function normalizeTodoistDescription(description = "") {
  const lines = normalizeLineEndings(description).split("\n");
  const output = [];
  let fence = null;
  let pendingBlankLine = false;
  let seenContent = false;

  for (const rawLine of lines) {
    const fenceMatch = rawLine.match(FENCE_LINE);

    if (fence) {
      if (fenceMatch && closesFence(fence, fenceMatch[1], fenceMatch[2])) fence = null;
      output.push(rawLine);
      continue;
    }

    if (fenceMatch) {
      fence = fenceMatch[1];
      if (pendingBlankLine && output.length > 0) output.push("");
      pendingBlankLine = false;
      seenContent = true;
      output.push(trimLineEnd(rawLine));
      continue;
    }

    const line = normalizeDescriptionLine(rawLine, { firstContentLine: !seenContent });
    if (line === "") {
      pendingBlankLine = output.length > 0;
      continue;
    }

    if (pendingBlankLine) output.push("");
    pendingBlankLine = false;
    seenContent = true;
    output.push(line);
  }

  return output.join("\n");
}

/**
 * Split task content into a single-line title plus any overflow lines. Overflow
 * is returned verbatim so the caller can move it into the description instead
 * of dropping text the user wrote.
 */
export function splitTodoistTitle(content = "") {
  const lines = normalizeLineEndings(content).split("\n");
  const firstIndex = lines.findIndex((line) => line.trim() !== "");

  if (firstIndex === -1) return { title: "", overflow: "" };

  return {
    title: normalizeTodoistTitleLine(lines[firstIndex]),
    overflow: trimBlankEdges(lines.slice(firstIndex + 1)).join("\n"),
  };
}

/** Structural cleanup for one title line. Wording is never rewritten. */
export function normalizeTodoistTitleLine(line = "") {
  const withoutMarkers = String(line)
    .trim()
    .replace(/^#{1,6}(?:[ \t]+|$)/, "")
    .replace(LEADING_BULLET_MARKER, "")
    .replace(/\s+/g, " ")
    .trim();

  return stripWrappingEmphasis(withoutMarkers);
}

/**
 * Drop a description's first line when it only repeats the task title. A first
 * line that adds information is always kept.
 */
export function dropDuplicateTitleLine(title = "", description = "") {
  const lines = String(description).split("\n");
  const firstIndex = lines.findIndex((line) => line.trim() !== "");

  if (firstIndex === -1) return String(description);
  // A list item is content, even when its text matches the title. Dropping it
  // would delete the first step of a checklist and misnumber the rest.
  if (LIST_LINE.test(lines[firstIndex].trimStart())) return String(description);
  if (!isSameStructuralText(title, lines[firstIndex])) return String(description);

  return trimBlankEdges(lines.slice(firstIndex + 1)).join("\n");
}

export function containsUrl(value = "") {
  return URL_PATTERN.test(String(value));
}

export function comparableStructuralText(value = "") {
  return String(value)
    .replace(/^\s*#{1,6}[ \t]+/, "")
    .replace(/^\s*([-*+]|\d+[.)])[ \t]+/, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[:.]+$/, "")
    .trim()
    .toLowerCase();
}

function isSameStructuralText(title, line) {
  const wanted = comparableStructuralText(title);
  return wanted !== "" && comparableStructuralText(line) === wanted;
}

/**
 * Leading whitespace only carries meaning relative to a line above it: list
 * continuation text, nested list content, and indented code all depend on it.
 * The first line of a description is the one place where indentation cannot
 * mean any of those things, so that is the only place stray indentation is
 * removed. Everywhere else indentation is preserved as written.
 */
function normalizeDescriptionLine(rawLine, { firstContentLine = false } = {}) {
  const line = trimLineEnd(rawLine);
  if (line.trim() === "") return "";

  const indent = line.match(/^[ \t]*/)[0];
  const body = line.slice(indent.length);
  const listMatch = body.match(LIST_LINE);

  if (listMatch) {
    const nested = indentWidth(indent) >= NESTED_LIST_INDENT_WIDTH && !firstContentLine;
    return `${nested ? indent : ""}${listMatch[1]} ${listMatch[2]}`;
  }

  if (firstContentLine && indentWidth(indent) < CODE_INDENT_WIDTH) return body;

  return line;
}

function closesFence(openFence, candidate, rest) {
  return (
    candidate[0] === openFence[0] &&
    candidate.length >= openFence.length &&
    String(rest ?? "").trim() === ""
  );
}

function trimLineEnd(line) {
  return String(line).replace(/[ \t]+$/, "");
}

function indentWidth(indent) {
  return [...indent].reduce((width, character) => width + (character === "\t" ? 4 : 1), 0);
}

function trimBlankEdges(lines) {
  const copy = [...lines];
  while (copy.length > 0 && copy[0].trim() === "") copy.shift();
  while (copy.length > 0 && copy[copy.length - 1].trim() === "") copy.pop();
  return copy;
}

function stripWrappingEmphasis(value) {
  let current = value;

  for (let pass = 0; pass < 3; pass += 1) {
    const match =
      current.match(WRAPPING_BOLD_ITALIC) ??
      current.match(WRAPPING_BOLD) ??
      current.match(WRAPPING_BOLD_UNDERSCORE) ??
      current.match(WRAPPING_ITALIC) ??
      current.match(WRAPPING_ITALIC_UNDERSCORE);

    if (!match) break;
    current = match[1].trim();
  }

  return current;
}
