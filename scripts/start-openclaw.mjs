#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergedEnv } from "./lib/env.mjs";
import { buildOpenClawGatewayArgs, requestedOpenClawConfigPath } from "./lib/commands.mjs";
import { projectPath, safeGeneratedPath } from "./lib/config.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");
const env = mergedEnv(projectPath(projectRoot, ".env"));
const requestedConfigPath = requestedOpenClawConfigPath(env);

let configPath;
try {
  configPath = safeGeneratedPath(projectRoot, requestedConfigPath);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (!existsSync(configPath)) {
  console.error(`Missing rendered OpenClaw config at ${requestedConfigPath}. Run npm run render:config first.`);
  process.exit(1);
}

const child = spawn("openclaw", buildOpenClawGatewayArgs(configPath), {
  stdio: "inherit",
  env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
});

child.on("error", (error) => {
  console.error(`Failed to start OpenClaw: ${error.message}`);
  if (error.code === "ENOENT") {
    console.error("Install OpenClaw with: npm install -g openclaw@latest");
  }
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
