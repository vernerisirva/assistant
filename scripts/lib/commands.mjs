import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { safeGeneratedPath, safeOpenClawPath } from "./config.mjs";

export const DEFAULT_OPENCLAW_CONFIG_PATH = ".openclaw/openclaw.json";
export const DEFAULT_OPENCLAW_STATE_DIR = ".openclaw/state";
export const MANAGED_OPENCLAW_PATH = ".openclaw/bin/openclaw";
/**
 * The oldest OpenClaw whose CLI drives the SQLite-backed Gateway scheduler this
 * repo relies on. Older releases, such as a leftover global npm install, use
 * the retired jobs.json store and an older auth model.
 */
export const MIN_OPENCLAW_VERSION = "2026.7.1";

export function commandExists(command, env = process.env) {
  if (typeof command !== "string" || command.length === 0) return false;

  if (command.includes("/") || command.includes("\\")) {
    return isExecutableFile(command);
  }

  return findExecutableOnPath(command, env.PATH) !== null;
}

/**
 * Picks the OpenClaw CLI the Gateway itself runs, in this order:
 *
 * 1. OPENCLAW_CLI, the explicit override;
 * 2. the managed install at ~/.openclaw/bin/openclaw;
 * 3. `openclaw` on PATH, but only when it reports MIN_OPENCLAW_VERSION or newer.
 *
 * It never guesses further. A stale global install would drive the Gateway
 * with the wrong scheduler and auth model, so no match is an error that says
 * what was checked.
 *
 * With `verify`, the override must be an executable file and every candidate
 * must report a supported version. The launchd installer uses that, because it
 * bakes the path into the service. Everyday commands take the override as
 * given, as the weekly plan always has.
 */
export function resolveOpenClawRuntime({ env = process.env, verify = false, readVersion = readOpenClawVersion } = {}) {
  const explicit = typeof env.OPENCLAW_CLI === "string" ? env.OPENCLAW_CLI.trim() : "";
  if (explicit) {
    if (!verify) return { command: explicit, source: "explicit", version: null };
    const command = explicit.includes("/") ? resolve(explicit) : findExecutableOnPath(explicit, env.PATH);
    if (!command || !isExecutableFile(command)) {
      throw new Error(`OPENCLAW_CLI is set to ${explicit}, which is not an executable file.`);
    }
    return withSupportedVersion({ command, source: "explicit" }, readVersion);
  }

  const managed = managedOpenClawPath(env);
  if (isExecutableFile(managed)) {
    return verify ? withSupportedVersion({ command: managed, source: "managed" }, readVersion) : { command: managed, source: "managed", version: null };
  }

  const onPath = findExecutableOnPath("openclaw", env.PATH);
  if (onPath) return withSupportedVersion({ command: onPath, source: "path" }, readVersion);

  throw new Error(
    `No OpenClaw runtime found. OPENCLAW_CLI is not set, ${managed} does not exist, and there is no openclaw on PATH. ` +
      `Install OpenClaw ${MIN_OPENCLAW_VERSION} or newer, or set OPENCLAW_CLI.`,
  );
}

export function resolveOpenClawCommand(env = process.env, options = {}) {
  return resolveOpenClawRuntime({ ...options, env }).command;
}

export function managedOpenClawPath(env = process.env) {
  const home = typeof env.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : homedir();
  return join(home, MANAGED_OPENCLAW_PATH);
}

/** Reads `2026.7.1-2` from `OpenClaw 2026.7.1-2 (0790d9f)`; null when the CLI does not answer. */
export function readOpenClawVersion(command) {
  try {
    const output = execFileSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseOpenClawVersion(output);
  } catch {
    return null;
  }
}

export function parseOpenClawVersion(text) {
  return /\b(\d{4}\.\d{1,2}\.\d{1,3}(?:-\d+)?)\b/.exec(String(text ?? ""))?.[1] ?? null;
}

/** Orders `YYYY.M.P` with an optional `-N` build suffix; a missing suffix counts as 0. */
export function compareOpenClawVersions(left, right) {
  const parts = (version) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/.exec(String(version ?? ""));
    if (!match) throw new Error(`Unrecognised OpenClaw version: ${version}`);
    return match.slice(1).map((part) => Number(part ?? 0));
  };
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function withSupportedVersion(candidate, readVersion) {
  const label = { explicit: "OPENCLAW_CLI", managed: "The managed OpenClaw", path: "openclaw on PATH" }[candidate.source];
  const version = readVersion(candidate.command);
  if (!version) {
    throw new Error(`${label} (${candidate.command}) did not report a version; OpenClaw ${MIN_OPENCLAW_VERSION} or newer is required.`);
  }
  if (compareOpenClawVersions(version, MIN_OPENCLAW_VERSION) < 0) {
    throw new Error(
      `${label} (${candidate.command}) is OpenClaw ${version}, older than the required ${MIN_OPENCLAW_VERSION}. ` +
        "Upgrade it, or set OPENCLAW_CLI to the Gateway's OpenClaw.",
    );
  }
  return { ...candidate, version };
}

function findExecutableOnPath(command, searchPath = "") {
  for (const directory of String(searchPath ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
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
