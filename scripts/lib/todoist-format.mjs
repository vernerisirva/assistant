/**
 * Shared, conservative text normalization for Todoist task content.
 *
 * Both new task creation and exact formatting updates use these primitives so
 * Todoist formatting has one implementation instead of two subtly different
 * ones. Every helper is structural only: it never rewrites wording, never adds
 * content, and never removes substantive text.
 */

const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/;
const LIST_LINE = /^([-*+]|\d+[.)])[ \t]+(.+)$/;
const HEADING_MARKER = /^#{1,6}[ \t]+/;
const LEADING_LIST_MARKER = /^([-*+]|\d+[.)])[ \t]+/;
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
  return !text.includes("\n") && text.includes("\\n");
}

export function decodeTransportEscapes(value = "") {
  const text = String(value);
  if (!hasTransportEscapes(text)) return text;
  return text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
}

export function normalizeTransportText(value = "") {
  return decodeTransportEscapes(normalizeLineEndings(value));
}

/**
 * Normalize a Todoist description while preserving Markdown that Todoist
 * renders: links, emphasis, headings, numbered lists, and fenced code blocks
 * including their exact whitespace.
 */
export function normalizeTodoistDescription(description = "") {
  const lines = normalizeTransportText(description).split("\n");
  const output = [];
  let fence = null;
  let pendingBlankLine = false;

  for (const rawLine of lines) {
    const fenceMatch = rawLine.match(FENCE_LINE);

    if (fence) {
      if (fenceMatch && closesFence(fence, fenceMatch[1])) fence = null;
      output.push(rawLine);
      continue;
    }

    if (fenceMatch) {
      fence = fenceMatch[1];
      if (pendingBlankLine && output.length > 0) output.push("");
      pendingBlankLine = false;
      output.push(trimLineEnd(rawLine));
      continue;
    }

    const line = normalizeDescriptionLine(rawLine);
    if (line === "") {
      pendingBlankLine = output.length > 0;
      continue;
    }

    if (pendingBlankLine) output.push("");
    pendingBlankLine = false;
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
  const lines = normalizeTransportText(content).split("\n");
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
    .replace(HEADING_MARKER, "")
    .replace(LEADING_LIST_MARKER, "")
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
    .replace(/[:.!?]+$/, "")
    .trim()
    .toLowerCase();
}

function isSameStructuralText(title, line) {
  const wanted = comparableStructuralText(title);
  return wanted !== "" && comparableStructuralText(line) === wanted;
}

function normalizeDescriptionLine(rawLine) {
  const line = trimLineEnd(rawLine);
  if (line.trim() === "") return "";

  const indent = line.match(/^[ \t]*/)[0];
  const body = line.slice(indent.length);
  const listMatch = body.match(LIST_LINE);

  if (listMatch) {
    const keptIndent = indentWidth(indent) >= NESTED_LIST_INDENT_WIDTH ? indent : "";
    return `${keptIndent}${listMatch[1]} ${listMatch[2]}`;
  }

  if (indentWidth(indent) >= CODE_INDENT_WIDTH) return line;

  return body;
}

function closesFence(openFence, candidate) {
  return candidate[0] === openFence[0] && candidate.length >= openFence.length;
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
      current.match(WRAPPING_BOLD) ??
      current.match(WRAPPING_BOLD_UNDERSCORE) ??
      current.match(WRAPPING_ITALIC) ??
      current.match(WRAPPING_ITALIC_UNDERSCORE);

    if (!match) break;
    current = match[1].trim();
  }

  return current;
}
