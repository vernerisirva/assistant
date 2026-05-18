import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { safeGeneratedPath, safeOpenClawPath } from "./config.mjs";

export const DEFAULT_OPENCLAW_CONFIG_PATH = ".openclaw/openclaw.json";
export const DEFAULT_OPENCLAW_STATE_DIR = ".openclaw/state";

export function commandExists(command) {
  if (typeof command !== "string" || command.length === 0) return false;

  if (command.includes("/") || command.includes("\\")) {
    return isExecutableFile(command);
  }

  const searchPaths = (process.env.PATH || "").split(delimiter).filter(Boolean);
  return searchPaths.some((path) => isExecutableFile(join(path, command)));
}

function isExecutableFile(path) {
  try {
    if (!existsSync(path)) return false;
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function buildOpenClawGatewayArgs() {
  return ["gateway", "--verbose"];
}

export function requestedOpenClawConfigPath(env = {}) {
  return env.OPENCLAW_CONFIG_PATH || DEFAULT_OPENCLAW_CONFIG_PATH;
}

export function resolveOpenClawConfigPath(env = {}, projectRoot) {
  return safeGeneratedPath(projectRoot, requestedOpenClawConfigPath(env));
}

export function requestedOpenClawStateDir(env = {}) {
  return env.OPENCLAW_STATE_DIR || DEFAULT_OPENCLAW_STATE_DIR;
}

export function resolveOpenClawStateDir(env = {}, projectRoot) {
  return safeOpenClawPath(projectRoot, requestedOpenClawStateDir(env), "OPENCLAW_STATE_DIR");
}
