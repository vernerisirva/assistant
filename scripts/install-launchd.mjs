#!/usr/bin/env node
/**
 * Installs or refreshes the Gateway LaunchAgent through OpenClaw's own
 * installer, run with the same OpenClaw CLI that normal Gateway operations use
 * (see scripts/lib/launchd.mjs).
 *
 *   npm run install:launchd                 converge; restarts only when needed
 *   npm run install:launchd -- --dry-run    print the plan; write and start nothing
 *   npm run install:launchd -- --force      ask OpenClaw to reinstall even when it matches
 *
 * Add --json for machine-readable output. Tokens are never printed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawConfigPath, resolveOpenClawRuntime, resolveOpenClawStateDir } from "./lib/commands.mjs";
import { projectPath } from "./lib/config.mjs";
import { mergedEnv, readEnvFile } from "./lib/env.mjs";
import { createSecretRedactor } from "./lib/live-cron.mjs";
import {
  GATEWAY_WRAPPER_PATH,
  buildInstallEnvironment,
  ensureGatewayToken,
  formatGatewayLaunchdPlan,
  planGatewayLaunchdInstall,
} from "./lib/launchd.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");

export function parseInstallLaunchdArgs(argv) {
  const options = { dryRun: false, force: false, json: false };
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--json") options.json = true;
    else throw new Error(`Unknown install:launchd option: ${arg}`);
  }
  return options;
}

/** Resolves everything the install needs and returns the plan. It writes nothing. */
export function prepareLaunchdInstall({
  root = projectRoot,
  env = mergedEnv(projectPath(root, ".env")),
  options = {},
  readVersion,
  readText = readTextIfExists,
} = {}) {
  const home = typeof env.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : homedir();
  const configPath = resolveOpenClawConfigPath(env, root);
  const stateDir = resolveOpenClawStateDir(env, root);
  const configText = readText(configPath);
  if (configText === null) {
    throw new Error(`Rendered OpenClaw config not found: ${configPath}. Run npm run render:config first.`);
  }
  const config = JSON.parse(configText);
  const runtime = resolveOpenClawRuntime({ env, verify: true, ...(readVersion ? { readVersion } : {}) });
  const plan = planGatewayLaunchdInstall({
    projectRoot: root,
    home,
    runtime,
    existingWrapper: readText(join(home, GATEWAY_WRAPPER_PATH)),
    config,
    force: options.force === true,
  });
  return { plan, config, configPath, stateDir };
}

export async function runInstallLaunchd(
  argv,
  { root = projectRoot, env = mergedEnv(projectPath(root, ".env")), platform = process.platform, readVersion } = {},
) {
  const options = parseInstallLaunchdArgs(argv);
  const { plan, config, configPath, stateDir } = prepareLaunchdInstall({ root, env, options, readVersion });
  if (options.dryRun) return { dryRun: true, plan, installedService: describeInstalledService(plan) };
  if (platform !== "darwin") {
    throw new Error("install:launchd installs a macOS LaunchAgent; run it on the Mac that hosts the Gateway.");
  }
  if (plan.projectChange && !options.force) {
    throw new Error(
      `The installed Gateway runs from ${plan.projectChange.from}, but this checkout is ${plan.projectChange.to}. ` +
        "Run npm run install:launchd from the checkout the Gateway should use, or add --force to move it here.",
    );
  }

  if (plan.wrapper.action !== "unchanged") {
    mkdirSync(dirname(plan.wrapper.path), { recursive: true, mode: 0o700 });
    writeFileSync(plan.wrapper.path, plan.wrapper.content, { mode: 0o700 });
    chmodSync(plan.wrapper.path, 0o700);
  }

  const token = ensureGatewayToken(config);
  if (token.changed) {
    writeFileSync(configPath, `${JSON.stringify(token.config, null, 2)}\n`, { mode: 0o600 });
    chmodSync(configPath, 0o600);
  }

  const redact = createSecretRedactor({ env, config: token.config });
  const installEnv = buildInstallEnvironment({
    processEnv: process.env,
    dotEnvKeys: Object.keys(readEnvFile(projectPath(root, ".env"))),
    configPath,
    stateDir,
  });
  const run = (args) => runOpenClawOrThrow(plan.install.command, args, { env: installEnv, cwd: root, redact });

  const installed = parseJsonQuietly(run(plan.install.args).stdout);
  const installResult = typeof installed?.result === "string" ? installed.result : "unknown";
  const restarted = installResult === "already-installed" && plan.restartIfAlreadyInstalled;
  if (restarted) run(["gateway", "restart", "--json"]);

  return { dryRun: false, plan, token: token.token, install: installResult, restarted };
}

export function formatInstallLaunchdResult(result) {
  const { content, ...wrapper } = result.plan.wrapper;
  if (result.dryRun) {
    const installed = result.installedService;
    return [
      formatGatewayLaunchdPlan(result.plan, { dryRun: true }),
      installed.exists
        ? `Installed now: ${installed.comment ?? "a LaunchAgent"} at ${result.plan.plistPath}; ${installed.usesWrapper ? "it already starts through this wrapper" : "it does not start through this wrapper"}.`
        : `Installed now: no LaunchAgent at ${result.plan.plistPath}.`,
      "",
      `Wrapper that ${wrapper.action === "unchanged" ? "is installed" : "would be written"} (${wrapper.mode}):`,
      content,
    ].join("\n");
  }
  return [
    `OpenClaw install result: ${result.install}.`,
    `Runtime: ${result.plan.runtime.command} (OpenClaw ${result.plan.runtime.version}).`,
    `Wrapper: ${wrapper.path} (${wrapper.action === "unchanged" ? "unchanged" : `${wrapper.action}d`}).`,
    `Gateway token: ${result.token} (not shown).`,
    `Restarted: ${result.restarted ? "yes, to load the new wrapper" : "no"}.`,
    `Logs: ${result.plan.logs.stdout}`,
  ].join("\n");
}

/** Best effort and read-only: which LaunchAgent is installed now. Environment and arguments are not printed. */
function describeInstalledService(plan) {
  if (!existsSync(plan.plistPath)) return { exists: false };
  try {
    const plist = JSON.parse(
      execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plan.plistPath], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments : [];
    return {
      exists: true,
      comment: typeof plist.Comment === "string" ? plist.Comment : null,
      usesWrapper: args.includes(plan.wrapper.path),
    };
  } catch {
    return { exists: true, comment: null, usesWrapper: false };
  }
}

function runOpenClawOrThrow(command, args, { env, cwd, redact }) {
  const result = spawnSync(command, args, { encoding: "utf8", env, cwd, timeout: 180_000 });
  const action = `openclaw ${args.slice(0, 2).join(" ")}`;
  if (result.error) throw new Error(redact(`${action} failed: ${result.error.message}`));
  if (result.status !== 0) {
    const line = [result.stderr, result.stdout]
      .flatMap((text) => String(text ?? "").split(/\r?\n/))
      .map((entry) => entry.trim())
      .find(Boolean);
    throw new Error(redact(`${action} failed: ${line ?? `exit code ${result.status}`}`));
  }
  return result;
}

function parseJsonQuietly(text) {
  const value = String(text ?? "");
  const start = value.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(value.slice(start, value.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
}

function readTextIfExists(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const argv = process.argv.slice(2);
    const options = parseInstallLaunchdArgs(argv);
    const result = await runInstallLaunchd(argv);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatInstallLaunchdResult(result));
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
