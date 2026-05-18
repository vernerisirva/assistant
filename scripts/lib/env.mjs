import { readFileSync, existsSync } from "node:fs";

export const REQUIRED_ENV_KEYS = [
  "ASSISTANT_TIMEZONE",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_STATE_DIR",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_USER_ID",
  "GMAIL_ACCOUNT",
  "GOOGLE_CLOUD_PROJECT",
  "PRIMARY_MODEL",
  "ADMIN_MODEL",
  "HEALTH_MODEL",
  "RESEARCH_MODEL",
  "ROUTINE_MODEL",
];

export function parseEnvText(text) {
  const env = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    const rawValue = line.slice(equalsIndex + 1).trim();
    const value = stripMatchingQuotes(rawValue);

    if (key) env[key] = value;
  }

  return env;
}

function stripMatchingQuotes(value) {
  if (value.length < 2) return value;

  const quote = value[0];
  if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
    return value.slice(1, -1);
  }

  return value;
}

export function readEnvFile(path = ".env") {
  if (!existsSync(path)) return {};
  return parseEnvText(readFileSync(path, "utf8"));
}

export function mergedEnv(path = ".env") {
  return { ...readEnvFile(path), ...process.env };
}

export function requiredEnvReport(env, requiredKeys = REQUIRED_ENV_KEYS) {
  const present = [];
  const missing = [];

  for (const key of requiredKeys) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      present.push(key);
    } else {
      missing.push(key);
    }
  }

  return { present, missing };
}
