import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const feedbackTypes = ["useful", "annoying", "improvement"];

const sensitiveFeedbackPattern = /\b(password|passcode|api key|access token|secret|bank account|bank card|card number|credit card|diagnosis|medication|medical condition|injury|private health)\b/i;

export function addFeedbackEntry(
  feedbackPath,
  input,
  { now = new Date().toISOString() } = {},
) {
  const entry = normalizeFeedbackEntry({
    timestamp: now,
    type: input?.type,
    message: input?.message,
    source: "telegram",
  });

  if (isSensitiveFeedbackMessage(entry.message)) {
    throw new Error("Sensitive feedback is not stored. Rephrase without private health, financial, or authentication details.");
  }

  mkdirSync(dirname(feedbackPath), { recursive: true });
  appendFileSync(feedbackPath, `${JSON.stringify(entry)}\n`);
  return entry;
}

export function listFeedbackEntries(feedbackPath) {
  if (!existsSync(feedbackPath)) return [];

  return readFileSync(feedbackPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => normalizeFeedbackEntry(JSON.parse(line)));
}

export function isSensitiveFeedbackMessage(message) {
  return sensitiveFeedbackPattern.test(String(message ?? ""));
}

export function feedbackTypeFromMessage(message) {
  const raw = String(message ?? "").trim();
  const normalized = raw.replace(/[.!]+$/, "").trim().toLowerCase();

  if (normalized === "that was useful") return "useful";
  if (normalized === "that was annoying") return "annoying";
  if (/^(feedback|remember as feedback|log improvement idea):\s*\S/i.test(raw)) return "improvement";
  return null;
}

export function isExternalFeedbackRequest(message) {
  const text = String(message ?? "");
  return /\b(send|share|email|forward|post)\b[\s\S]{0,80}\bfeedback\b|\bfeedback\b[\s\S]{0,80}\b(send|share|email|forward|post)\b/i.test(text);
}

function normalizeFeedbackEntry(entry = {}) {
  const timestamp = requiredText(entry.timestamp, "Feedback timestamp is required.");
  const type = requiredText(entry.type, "Feedback type is required.").toLowerCase();
  const message = requiredText(entry.message, "Feedback message is required.");
  const source = requiredText(entry.source, "Feedback source is required.").toLowerCase();

  if (!feedbackTypes.includes(type)) {
    throw new Error(`Feedback type must be one of: ${feedbackTypes.join(", ")}`);
  }

  if (source !== "telegram") {
    throw new Error("Feedback source must be telegram.");
  }

  return { timestamp, type, message, source };
}

function requiredText(value, errorMessage) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(errorMessage);
  return text;
}
