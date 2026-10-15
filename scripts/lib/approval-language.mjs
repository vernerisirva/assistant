export const approvalLanguagePolicy = {
  mode: "flexible-explicit",
  requiresPendingApprovalPrompt: true,
  acceptedExamples: [
    "approve",
    "ok",
    "okay",
    "that's ok",
    "yes do it",
    "go ahead",
    "proceed",
    "sounds good",
    "looks good",
    "sure",
  ],
  rejectedExamples: [
    "no",
    "do not approve",
    "stop",
    "cancel",
    "is that ok?",
    "maybe ok",
  ],
};

const acceptedPhrases = new Set([
  "approve",
  "approved",
  "confirm",
  "confirmed",
  "ok",
  "okay",
  "ok do it",
  "okay do it",
  "ok go ahead",
  "okay go ahead",
  "thats ok",
  "that is ok",
  "thats is ok",
  "yes",
  "yes please",
  "yes do it",
  "yes go ahead",
  "yes that is ok",
  "yes thats ok",
  "go ahead",
  "proceed",
  "do it",
  "sounds good",
  "looks good",
  "sure",
  "fine",
  "all good",
  "that works",
  "thats fine",
  "that is fine",
  "you can do that",
  // Swedish: the user writes to Hilla in Swedish.
  "ja",
  "ja tack",
  "japp",
  "jepp",
  "okej",
  "okei",
  "kör",
  "kör på",
  "kör bara",
  "ja kör",
  "ok kör",
  "okej kör",
  "visst",
  "absolut",
  "självklart",
  "låter bra",
  "det låter bra",
  "ser bra ut",
  "det ser bra ut",
  "det går bra",
  "godkänt",
  "godkänd",
  "godkänner",
  "jag godkänner",
  "gör det",
  "ja gör det",
  // Finnish.
  "joo",
  "juu",
  "kyllä",
  "kyllä kiitos",
  "joo kiitos",
  "selvä",
  "käy",
  "käy hyvin",
  "ok käy",
  "sopii",
  "sopii hyvin",
  "näyttää hyvältä",
  "kuulostaa hyvältä",
  "hyväksyn",
  "hyväksytty",
  "tee se",
  "jatka",
]);

const denialPatterns = [
  /\bno\b/,
  /\bdeny\b/,
  /\bdenied\b/,
  /\bcancel\b/,
  /\bstop\b/,
  /\bdo not\b/,
  /\bdont\b/,
  /\bdon t\b/,
  /\bnot ok\b/,
  /\bnot okay\b/,
  /\bdo not approve\b/,
];

const hedgePatterns = [
  /\bmaybe\b/,
  /\bprobably\b/,
  /\bperhaps\b/,
  /\bnot sure\b/,
  /\bif\b/,
  /\bcan you\b/,
  /\bcould you\b/,
  /\bshould i\b/,
];

// A question mark in any script, an ellipsis, or two or more dots in a row:
// "ok？", "ok ❓", "ok…" and "ok..." ask or hesitate just like "ok?".
const QUESTION_OR_HESITATION = /[?¿؟⸮‽⁇⁈⁉❓❔？]|…|\.{2,}/u;
// The only emoji that may accompany a plain approval: 👍 (any skin tone), 👌, ✅, ✔ and ☑.
const POSITIVE_EMOJI = /\u{1F44D}[\u{1F3FB}-\u{1F3FF}]?|\u{1F44C}[\u{1F3FB}-\u{1F3FF}]?|\u2705|\u2714|\u2611/gu;
// What is left of a plain reply: letters, digits, spaces and . , ! ' ’ ‘ -
const PLAIN_REPLY = /^[\p{L}\p{M}\p{N}\s.,!'’‘-]*$/u;

/**
 * The reply's words in comparable form, or null when the reply is not plain.
 * The raw text is checked before normalization, because normalizing alone would
 * turn "ok？", "ok…" and "ok 👎" into "ok". Any other emoji, symbol or
 * emoticon (":/", "🤔", "❌") makes the reply something to ask about, not an
 * approval.
 */
export function approvalReplyText(message) {
  if (message === undefined || message === null) return null;
  const raw = String(message).normalize("NFC").trim();
  if (!raw || raw.length > 240 || QUESTION_OR_HESITATION.test(raw)) return null;
  const words = raw.replace(/\uFE0F/g, "").replace(POSITIVE_EMOJI, " ");
  if (!PLAIN_REPLY.test(words)) return null;
  return normalizeApprovalText(words) || null;
}

export function isApprovalMessage(message, { hasPendingApproval = false } = {}) {
  if (!hasPendingApproval) return false;

  const normalized = approvalReplyText(message);
  if (!normalized) return false;
  if (denialPatterns.some((pattern) => pattern.test(normalized))) return false;
  if (hedgePatterns.some((pattern) => pattern.test(normalized))) return false;

  return acceptedPhrases.has(normalized);
}

/** Lower case, apostrophes dropped, everything but letters and digits (in any script) as single spaces. */
export function normalizeApprovalText(message) {
  return String(message)
    .normalize("NFC")
    .toLowerCase()
    .replace(/[’‘']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
