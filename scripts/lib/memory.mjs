import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const memoryCategories = [
  "food",
  "health",
  "schedule",
  "tone",
  "golf",
  "admin",
  "general",
];

export const memorySensitivities = ["low", "sensitive"];

export function rememberMemoryEntry(
  memoryPath,
  input,
  { now = new Date().toISOString(), idGenerator = randomUUID } = {},
) {
  const entryInput = normalizeMemoryInput(input);
  const document = readMemoryDocument(memoryPath);
  const existingIndex = document.entries.findIndex(
    (entry) => entry.category === entryInput.category && entry.key === entryInput.key,
  );

  const entry = {
    id: existingIndex >= 0 ? document.entries[existingIndex].id : idGenerator(),
    category: entryInput.category,
    key: entryInput.key,
    value: entryInput.value,
    sensitivity: entryInput.sensitivity,
    source: entryInput.source,
    createdAt: existingIndex >= 0 ? document.entries[existingIndex].createdAt : now,
    updatedAt: now,
  };

  if (existingIndex >= 0) {
    document.entries[existingIndex] = entry;
  } else {
    document.entries.push(entry);
  }

  writeMemoryDocument(memoryPath, document);
  return entry;
}

export function listMemoryEntries(memoryPath, { category } = {}) {
  const requestedCategory = category ? normalizeCategory(category) : null;
  return readMemoryDocument(memoryPath).entries
    .filter((entry) => !requestedCategory || entry.category === requestedCategory)
    .toSorted((left, right) =>
      `${left.category}/${left.key}`.localeCompare(`${right.category}/${right.key}`),
    );
}

export function forgetMemoryEntry(memoryPath, id) {
  if (!id?.trim()) {
    throw new Error("Memory id is required.");
  }

  const document = readMemoryDocument(memoryPath);
  const index = document.entries.findIndex((entry) => entry.id === id);
  if (index < 0) {
    throw new Error(`Memory not found: ${id}`);
  }

  const [entry] = document.entries.splice(index, 1);
  writeMemoryDocument(memoryPath, document);
  return { forgotten: true, entry };
}

export function memoryRequiresApproval(input = {}) {
  return normalizeSensitivity(input.sensitivity ?? "low") === "sensitive";
}

export function buildMemoryApprovalPrompt(input = {}) {
  const normalized = normalizeMemoryInput(input);
  return {
    agent: "personal",
    action: "remember-sensitive-preference",
    target: `${normalized.category}/${normalized.key}`,
    expectedEffect: "Store this sensitive memory locally for future personalization.",
    risk: "Sensitive personal information may be reused in future assistant responses until forgotten.",
    approvalOptions: [
      "Reply approve, ok, that's ok, yes do it, or go ahead to remember it.",
      "Reply no, stop, or cancel to avoid storing it.",
    ],
  };
}

export function readMemoryDocument(memoryPath) {
  if (!existsSync(memoryPath)) {
    return { version: 1, entries: [] };
  }

  const document = JSON.parse(readFileSync(memoryPath, "utf8"));
  if (document.version !== 1 || !Array.isArray(document.entries)) {
    throw new Error("Unsupported memory file format.");
  }
  return document;
}

export function writeMemoryDocument(memoryPath, document) {
  mkdirSync(dirname(memoryPath), { recursive: true });
  writeFileSync(memoryPath, `${JSON.stringify(document, null, 2)}\n`);
}

function normalizeMemoryInput(input = {}) {
  const category = normalizeCategory(input.category);
  const key = normalizeText(input.key, "Memory key is required.").toLowerCase();
  const value = normalizeText(input.value, "Memory value is required.");
  const sensitivity = normalizeSensitivity(input.sensitivity ?? "low");
  const source = normalizeOptionalText(input.source) ?? "manual";

  return { category, key, value, sensitivity, source };
}

function normalizeCategory(category) {
  const normalized = normalizeText(category, "Memory category is required.").toLowerCase();
  if (!memoryCategories.includes(normalized)) {
    throw new Error(`Memory category must be one of: ${memoryCategories.join(", ")}`);
  }
  return normalized;
}

function normalizeSensitivity(sensitivity) {
  const normalized = normalizeText(sensitivity, "Memory sensitivity is required.").toLowerCase();
  if (!memorySensitivities.includes(normalized)) {
    throw new Error(`Memory sensitivity must be one of: ${memorySensitivities.join(", ")}`);
  }
  return normalized;
}

function normalizeText(value, errorMessage) {
  const text = normalizeOptionalText(value);
  if (!text) {
    throw new Error(errorMessage);
  }
  return text;
}

function normalizeOptionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}
