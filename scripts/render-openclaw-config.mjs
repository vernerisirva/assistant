#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mergedEnv, requiredEnvReport, REQUIRED_ENV_KEYS } from "./lib/env.mjs";
import { readJson, projectPath, safeGeneratedPath, safeOpenClawPath } from "./lib/config.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");

export function buildOpenClawConfig(env, root = projectRoot) {
  const agents = readJson(projectPath(root, "config/agents.json"));
  const telegramUserId = env.TELEGRAM_USER_ID;
  const codexPluginPath = env.OPENCLAW_CODEX_PLUGIN_PATH?.trim();
  const modelRefs = [...new Set([env.PRIMARY_MODEL, env.ADMIN_MODEL, env.HEALTH_MODEL, env.RESEARCH_MODEL, env.ROUTINE_MODEL])];
  const modelCatalog = Object.fromEntries(
    modelRefs.filter(Boolean).map((modelRef) => [modelRef, { alias: modelRef }]),
  );

  return {
    gateway: {
      mode: "local",
    },
    plugins: {
      ...(codexPluginPath
        ? {
            load: {
              paths: [codexPluginPath],
            },
          }
        : {}),
      entries: {
        codex: {
          enabled: true,
        },
        openai: {
          enabled: true,
        },
        telegram: {
          enabled: true,
        },
        duckduckgo: {
          enabled: true,
        },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: env.PRIMARY_MODEL,
          fallbacks: [env.ROUTINE_MODEL].filter((modelRef) => modelRef && modelRef !== env.PRIMARY_MODEL),
        },
        models: modelCatalog,
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
        enabled: true,
        defaultAccount: "main",
        dmPolicy: "allowlist",
        allowFrom: [telegramUserId],
        capabilities: {
          inlineButtons: "allowlist",
        },
        accounts: {
          main: {
            botToken: "${TELEGRAM_BOT_TOKEN}",
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

export function prepareAgentWorkspaces(root = projectRoot) {
  const agents = readJson(projectPath(root, "config/agents.json"));

  for (const agent of agents) {
    const workspace = projectPath(root, agent.workspace);
    const agentDir = projectPath(root, agent.agentDir);
    const promptDir = projectPath(root, agent.promptDir);

    mkdirSync(workspace, { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    copyTextFile(projectPath(promptDir, "AGENTS.md"), projectPath(workspace, "AGENTS.md"));

    const soulPath = projectPath(promptDir, "SOUL.md");
    if (existsSync(soulPath)) {
      copyTextFile(soulPath, projectPath(workspace, "SOUL.md"));
    }
  }
}

function copyTextFile(sourcePath, destinationPath) {
  writeTextFile(destinationPath, readFileSync(sourcePath, "utf8"));
}

export function writeOpenClawConfig(env, root = projectRoot) {
  const configEnv = env === undefined ? mergedEnv(projectPath(root, ".env")) : env;
  const report = requiredEnvReport(configEnv, REQUIRED_ENV_KEYS);
  if (report.missing.length > 0) {
    throw new Error(`Missing environment keys: ${report.missing.join(", ")}`);
  }

  const outputPath = safeGeneratedPath(root, configEnv.OPENCLAW_CONFIG_PATH || ".openclaw/openclaw.json");
  safeOpenClawPath(root, configEnv.OPENCLAW_STATE_DIR || ".openclaw/state", "OPENCLAW_STATE_DIR");
  const config = buildOpenClawConfig(configEnv, root);
  preserveGatewayCredentials(config, outputPath);
  prepareAgentWorkspaces(root);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeTextFile(outputPath, `${JSON.stringify(config, null, 2)}\n`);
  return outputPath;
}

function writeTextFile(destinationPath, text) {
  try {
    writeFileSync(destinationPath, text);
    return;
  } catch (error) {
    if (error.code !== "EPERM") throw error;
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "openclaw-render-"));
  const temporaryPath = join(temporaryDirectory, "payload");
  try {
    writeFileSync(temporaryPath, text);
    execFileSync("/bin/cp", [temporaryPath, destinationPath]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function preserveGatewayCredentials(config, outputPath) {
  if (!existsSync(outputPath)) return;

  let existingConfig;
  try {
    existingConfig = JSON.parse(readFileSync(outputPath, "utf8"));
  } catch {
    return;
  }

  const existingGateway = existingConfig.gateway;
  if (!existingGateway || typeof existingGateway !== "object") return;

  config.gateway = {
    ...config.gateway,
    ...(existingGateway.auth ? { auth: existingGateway.auth } : {}),
    ...(existingGateway.remote ? { remote: existingGateway.remote } : {}),
  };
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
