#!/usr/bin/env node
/**
 * Capability help CLI: what Hilla can do, from the registry in
 * scripts/lib/capabilities.mjs.
 *
 *   npm run --silent capabilities                         the full list, as Telegram-ready text
 *   npm run --silent capabilities -- --tag golf           one topic: a cross-cutting tag or a category
 *   npm run --silent capabilities -- --category todoist   one section
 *   npm run --silent capabilities -- --automatic          what runs on its own
 *   npm run --silent capabilities -- --requires-approval  what needs an OK first
 *   npm run --silent capabilities -- --read-only          what only reads or advises
 *   npm run --silent capabilities -- --all                developer view, with disabled entries
 *   npm run --silent capabilities -- --json               any view as JSON
 *   npm run --silent capabilities -- guide                the help guide, with the topics and the full list
 *
 * Read-only. It checks which integrations are configured in .env and, only
 * when a view shows a scheduled capability, lists the live scheduler's jobs to
 * say which are switched on. It never calls Todoist, Google, Telegram, or a
 * model, and it writes nothing.
 *
 * The guide lives in agents/personal/guides/capabilities.md rather than in the
 * personal agent's standing orders, which must fit Codex's project-doc budget.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITY_CATEGORIES,
  buildCapabilityView,
  capabilitySetup,
  capabilityTopics,
  formatCapabilityView,
  needsScheduleOverlay,
  scheduleOverlay,
  selectCapabilities,
} from "./lib/capabilities.mjs";
import { projectPath } from "./lib/config.mjs";
import { mergedEnv } from "./lib/env.mjs";
import { createGatewayCron, loadLiveCronSnapshot } from "./lib/live-cron.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");
export const CAPABILITIES_GUIDE_PATH = "agents/personal/guides/capabilities.md";

const SWITCHES = Object.freeze({
  "--automatic": "automatic",
  "--requires-approval": "requiresApproval",
  "--read-only": "readOnly",
  "--all": "all",
});
const VALUE_FLAGS = Object.freeze({ "--category": "category", "--tag": "tag" });
const USAGE =
  "Usage: capabilities [--category ID] [--tag TOPIC] [--automatic] [--requires-approval] [--read-only] [--all] [--json], or capabilities guide.";

export function parseCapabilitiesArgs(argv) {
  if (argv[0] === "guide") {
    if (argv.length > 1) throw new Error("guide does not accept options.");
    return { command: "guide", json: false, filters: {} };
  }

  const filters = {};
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
    } else if (SWITCHES[arg]) {
      filters[SWITCHES[arg]] = true;
    } else if (VALUE_FLAGS[arg]) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      filters[VALUE_FLAGS[arg]] = value.trim().toLowerCase();
      index += 1;
    } else {
      throw new Error(`Unknown capabilities option: ${arg}. ${USAGE}`);
    }
  }

  const categories = CAPABILITY_CATEGORIES.map((category) => category.id);
  if (filters.category && !categories.includes(filters.category)) {
    throw new Error(`Unknown category: ${filters.category}. Categories: ${categories.join(", ")}.`);
  }
  const topics = capabilityTopics();
  if (filters.tag && !topics.includes(filters.tag)) {
    throw new Error(`Unknown topic: ${filters.tag}. Topics: ${topics.join(", ")}.`);
  }
  return { command: "list", json, filters };
}

/**
 * Builds one view. `cron` or `runOpenClaw` replace the live Gateway for tests.
 * Any failure to read the scheduler leaves scheduled entries unchecked.
 */
export async function runCapabilitiesCli(argv, { root = projectRoot, env, cron, runOpenClaw } = {}) {
  const options = parseCapabilitiesArgs(argv);
  const resolvedEnv = env ?? mergedEnv(projectPath(root, ".env"));
  const entries = selectCapabilities(options.filters);

  let schedule = {};
  if (needsScheduleOverlay(entries)) {
    let snapshot = null;
    try {
      snapshot = await loadLiveCronSnapshot(cron ?? createGatewayCron({ root, env: resolvedEnv, runOpenClaw }));
    } catch {
      snapshot = null;
    }
    schedule = scheduleOverlay(entries, snapshot);
  }

  const view = buildCapabilityView({ filters: options.filters, setup: capabilitySetup(resolvedEnv), schedule });
  const text = formatCapabilityView(view);
  if (options.command === "guide") {
    const guide = readFileSync(projectPath(root, CAPABILITIES_GUIDE_PATH), "utf8").trim();
    const topics = `Topics for \`--tag\`: ${capabilityTopics().join(", ")}.`;
    return { text: `${guide}\n\n${topics}\n\nThe full capability list:\n\n${text}` };
  }
  return { ...view, text };
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const argv = process.argv.slice(2);
    const options = parseCapabilitiesArgs(argv);
    const result = await runCapabilitiesCli(argv);
    console.log(options.json ? JSON.stringify(result, null, 2) : result.text);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
