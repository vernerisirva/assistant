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
  "thats ok",
  "that is ok",
  "thats is ok",
  "yes",
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

export function isApprovalMessage(message, { hasPendingApproval = false } = {}) {
  if (!hasPendingApproval) return false;
  if (message === undefined || message === null) return false;

  const raw = String(message).trim();
  if (!raw || raw.length > 240 || raw.includes("?")) return false;

  const normalized = normalizeApprovalText(raw);
  if (!normalized) return false;
  if (denialPatterns.some((pattern) => pattern.test(normalized))) return false;
  if (hedgePatterns.some((pattern) => pattern.test(normalized))) return false;

  return acceptedPhrases.has(normalized);
}

export function normalizeApprovalText(message) {
  return String(message)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
