#!/usr/bin/env node
/**
 * Pending actions CLI.
 *
 *   npm run --silent pending            what Hilla is waiting on, as JSON with telegramText
 *   npm run --silent pending -- --text  only the telegramText
 *
 * Read-only. It reads the weekly plan store and the focus record, changes
 * nothing, and never calls Todoist, Calendar, Telegram, or a model.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawStateDir } from "./lib/commands.mjs";
import { projectPath, readJson } from "./lib/config.mjs";
import { mergedEnv } from "./lib/env.mjs";
import { PENDING_GUIDANCE, collectPendingActions, formatPendingActions } from "./lib/pending.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");

export const PENDING_COVERAGE =
  "Covers a weekly plan awaiting review and a running focus session. Approval prompts and questions asked in chat are not stored, so they are not listed.";

export function parsePendingArgs(argv) {
  const options = { text: false };
  for (const arg of argv) {
    if (arg === "--text") {
      options.text = true;
    } else if (arg !== "--json") {
      throw new Error(`Unknown pending option: ${arg}`);
    }
  }
  return options;
}

export async function runPendingCli(argv, { root = projectRoot, env, stateDir, now = new Date(), providers } = {}) {
  parsePendingArgs(argv);
  const resolvedEnv = env ?? mergedEnv(projectPath(root, ".env"));
  const schedulesPath = projectPath(root, "config/schedules.json");
  const timezone = (existsSync(schedulesPath) ? readJson(schedulesPath).timezone : null) || resolvedEnv.ASSISTANT_TIMEZONE || "Europe/Stockholm";

  const result = collectPendingActions({
    stateDir: stateDir ?? resolveOpenClawStateDir(resolvedEnv, root),
    now,
    timezone,
    secrets: knownSecrets(resolvedEnv),
    ...(providers ? { providers } : {}),
  });
  return { ...result, telegramText: formatPendingActions(result), guidance: PENDING_GUIDANCE, coverage: PENDING_COVERAGE };
}

function knownSecrets(env) {
  const userId = String(env.TELEGRAM_USER_ID ?? "").trim();
  return [
    env.HILLA_TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_BOT_TOKEN,
    env.TODOIST_API_TOKEN,
    env.OPENROUTER_API_KEY,
    env.OPENCLAW_GATEWAY_TOKEN,
    /^\d{5,}$/.test(userId) ? userId : null,
  ].filter((secret) => typeof secret === "string" && secret.trim().length > 0);
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const argv = process.argv.slice(2);
    const options = parsePendingArgs(argv);
    const result = await runPendingCli(argv);
    console.log(options.text ? result.telegramText : JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
