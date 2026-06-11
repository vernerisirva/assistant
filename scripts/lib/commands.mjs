import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { safeGeneratedPath, safeOpenClawPath } from "./config.mjs";

export const DEFAULT_OPENCLAW_CONFIG_PATH = ".openclaw/openclaw.json";
export const DEFAULT_OPENCLAW_STATE_DIR = ".openclaw/state";

export function commandExists(command, env = process.env) {
  if (typeof command !== "string" || command.length === 0) return false;

  if (command.includes("/") || command.includes("\\")) {
    return isExecutableFile(command);
  }

  const searchPaths = (env.PATH || "").split(delimiter).filter(Boolean);
  return searchPaths.some((path) => isExecutableFile(join(path, command)));
}

export function resolveOpenClawCommand(env = process.env) {
  if (commandExists("openclaw", env)) return "openclaw";

  for (const candidate of candidateOpenClawCommands(env.HOME)) {
    if (commandExists(candidate, env)) return candidate;
  }

  return null;
}

function candidateOpenClawCommands(home) {
  const candidates = [];

  if (typeof home === "string" && home.length > 0) {
    const nvmNodeVersionsDir = join(home, ".nvm/versions/node");

    try {
      const versions = readdirSync(nvmNodeVersionsDir).sort().reverse();
      for (const version of versions) {
        candidates.push(join(nvmNodeVersionsDir, version, "bin/openclaw"));
      }
    } catch {
      // NVM is optional; continue with common global install locations.
    }
  }

  candidates.push("/opt/homebrew/bin/openclaw", "/usr/local/bin/openclaw");
  return candidates;
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
  return safeRuntimeOpenClawPath(projectRoot, requestedOpenClawConfigPath(env), "OPENCLAW_CONFIG_PATH");
}

export function requestedOpenClawStateDir(env = {}) {
  return env.OPENCLAW_STATE_DIR || DEFAULT_OPENCLAW_STATE_DIR;
}

export function resolveOpenClawStateDir(env = {}, projectRoot) {
  return safeRuntimeOpenClawPath(projectRoot, requestedOpenClawStateDir(env), "OPENCLAW_STATE_DIR");
}

function safeRuntimeOpenClawPath(projectRoot, requestedPath, envName) {
  if (typeof requestedPath === "string" && isAbsolute(requestedPath)) {
    const outputPath = resolve(requestedPath);
    const generatedRoot = resolve(projectRoot, ".openclaw");
    const relativeOutput = relative(generatedRoot, outputPath);

    if (
      relativeOutput !== "" &&
      relativeOutput !== ".." &&
      !relativeOutput.startsWith(`..${sep}`) &&
      !isAbsolute(relativeOutput)
    ) {
      return outputPath;
    }

    throw new Error(`${envName} must be a relative path under .openclaw/`);
  }

  return envName === "OPENCLAW_CONFIG_PATH"
    ? safeGeneratedPath(projectRoot, requestedPath)
    : safeOpenClawPath(projectRoot, requestedPath, envName);
}
