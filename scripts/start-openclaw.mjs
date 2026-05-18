#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergedEnv } from "./lib/env.mjs";
import {
  buildOpenClawGatewayArgs,
  requestedOpenClawConfigPath,
  resolveOpenClawStateDir,
} from "./lib/commands.mjs";
import { projectPath, safeGeneratedPath } from "./lib/config.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");
const env = mergedEnv(projectPath(projectRoot, ".env"));
const requestedConfigPath = requestedOpenClawConfigPath(env);

let configPath;
let stateDir;
try {
  configPath = safeGeneratedPath(projectRoot, requestedConfigPath);
  stateDir = resolveOpenClawStateDir(env, projectRoot);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (!existsSync(configPath)) {
  console.error(`Missing rendered OpenClaw config at ${requestedConfigPath}. Run npm run render:config first.`);
  process.exit(1);
}

const child = spawn("openclaw", buildOpenClawGatewayArgs(), {
  cwd: projectRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    ...env,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
  },
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
