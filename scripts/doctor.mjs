#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandExists,
  requestedOpenClawConfigPath,
  requestedOpenClawStateDir,
  resolveOpenClawStateDir,
} from "./lib/commands.mjs";
import { projectPath, safeGeneratedPath } from "./lib/config.mjs";
import { mergedEnv, requiredEnvReport, REQUIRED_ENV_KEYS } from "./lib/env.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");
const envPath = projectPath(projectRoot, ".env");
const env = mergedEnv(envPath);
const report = requiredEnvReport(env, REQUIRED_ENV_KEYS);
const requestedConfigPath = requestedOpenClawConfigPath(env);
const requestedStateDir = requestedOpenClawStateDir(env);
const hasOpenClaw = commandExists("openclaw");

let configCheck;
try {
  const configPath = safeGeneratedPath(projectRoot, requestedConfigPath);
  configCheck = [requestedConfigPath, existsSync(configPath)];
} catch (error) {
  configCheck = ["openclaw-config-path", false, error.message];
}

let stateCheck;
try {
  const stateDir = resolveOpenClawStateDir(env, projectRoot);
  stateCheck = [requestedStateDir, existsSync(stateDir)];
} catch (error) {
  stateCheck = ["openclaw-state-dir", false, error.message];
}

const checks = [
  ["node", commandExists("node")],
  ["npm", commandExists("npm") || commandExists("/opt/homebrew/bin/npm")],
  ["openclaw", hasOpenClaw],
  [".env", existsSync(envPath)],
  configCheck,
  stateCheck,
  ["required-env", report.missing.length === 0],
];

for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "PASS" : "WARN"} ${name}${detail ? `: ${detail}` : ""}`);
}

if (report.missing.length > 0) {
  console.log(`Missing environment keys: ${report.missing.join(", ")}`);
}

if (!hasOpenClaw) {
  console.log("Install OpenClaw with: npm install -g openclaw@latest");
}
