#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergedEnv, requiredEnvReport, REQUIRED_ENV_KEYS } from "./lib/env.mjs";
import { readJson, projectPath, safeGeneratedPath } from "./lib/config.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");

export function buildOpenClawConfig(env, root = projectRoot) {
  const agents = readJson(projectPath(root, "config/agents.json"));
  const telegramUserId = env.TELEGRAM_USER_ID;

  return {
    stateDir: projectPath(root, env.OPENCLAW_STATE_DIR || ".openclaw/state"),
    models: {
      default: env.PRIMARY_MODEL,
      routine: env.ROUTINE_MODEL,
    },
    agents: {
      defaults: {
        sandbox: {
          mode: "off",
        },
      },
      list: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        default: Boolean(agent.default),
        workspace: projectPath(root, agent.workspace),
        agentDir: projectPath(root, agent.agentDir),
        model: env[agent.modelEnv],
      })),
    },
    bindings: [
      {
        agentId: "personal",
        match: {
          channel: "telegram",
          accountId: "main",
        },
      },
    ],
    channels: {
      telegram: {
        defaultAccount: "main",
        dmPolicy: "allowlist",
        allowFrom: [telegramUserId],
        capabilities: {
          inlineButtons: "allowlist",
        },
        accounts: {
          main: {
            botToken: env.TELEGRAM_BOT_TOKEN,
            dmPolicy: "allowlist",
            allowFrom: [telegramUserId],
            capabilities: {
              inlineButtons: "allowlist",
            },
            execApprovals: {
              enabled: true,
              approvers: [telegramUserId],
            },
          },
        },
      },
    },
  };
}

export function writeOpenClawConfig(env, root = projectRoot) {
  const configEnv = env === undefined ? mergedEnv(projectPath(root, ".env")) : env;
  const report = requiredEnvReport(configEnv, REQUIRED_ENV_KEYS);
  if (report.missing.length > 0) {
    throw new Error(`Missing environment keys: ${report.missing.join(", ")}`);
  }

  const outputPath = safeGeneratedPath(root, configEnv.OPENCLAW_CONFIG_PATH || ".openclaw/openclaw.json");
  const config = buildOpenClawConfig(configEnv, root);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
  return outputPath;
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const outputPath = writeOpenClawConfig();
    console.log(`Rendered OpenClaw config: ${outputPath}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
