import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildOpenClawConfig, writeOpenClawConfig } from "../scripts/render-openclaw-config.mjs";

const env = {
  TELEGRAM_BOT_TOKEN: "123:token",
  TELEGRAM_USER_ID: "987654321",
  PRIMARY_MODEL: "provider/best-general-model",
  ADMIN_MODEL: "provider/reliable-admin-model",
  HEALTH_MODEL: "provider/supportive-health-model",
  RESEARCH_MODEL: "provider/research-model",
  ROUTINE_MODEL: "provider/fast-routine-model",
  OPENCLAW_STATE_DIR: ".openclaw/state",
};

const completeEnv = {
  ASSISTANT_TIMEZONE: "Europe/Stockholm",
  OPENCLAW_CONFIG_PATH: ".openclaw/openclaw.json",
  GMAIL_ACCOUNT: "person@example.com",
  GOOGLE_CLOUD_PROJECT: "local-assistant",
  ...env,
};

const projectRoot = resolve(".");
const renderScriptUrl = pathToFileURL(resolve("scripts/render-openclaw-config.mjs")).href;

function createTempProjectRoot() {
  const root = mkdtempSync(join(tmpdir(), "openclaw-config-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "agents.json"),
    `${JSON.stringify(
      [
        {
          id: "personal",
          name: "Personal",
          default: true,
          workspace: ".openclaw/workspace-personal",
          agentDir: ".openclaw/agents/personal/agent",
          modelEnv: "PRIMARY_MODEL",
        },
      ],
      null,
      2,
    )}\n`,
  );
  return root;
}

function writeEnvFile(root, values) {
  writeFileSync(
    join(root, ".env"),
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
}

describe("buildOpenClawConfig", () => {
  it("renders four agents with per-agent models", () => {
    const config = buildOpenClawConfig(env, projectRoot);

    assert.deepEqual(
      config.agents.list.map((agent) => [agent.id, agent.model]),
      [
        ["personal", "provider/best-general-model"],
        ["admin", "provider/reliable-admin-model"],
        ["health", "provider/supportive-health-model"],
        ["research", "provider/research-model"],
      ],
    );
  });

  it("routes Telegram main account to the personal agent", () => {
    const config = buildOpenClawConfig(env, projectRoot);

    assert.deepEqual(config.bindings, [
      { agentId: "personal", match: { channel: "telegram", accountId: "main" } },
    ]);
    assert.deepEqual(config.channels.telegram.allowFrom, ["987654321"]);
    assert.equal(config.channels.telegram.accounts.main.botToken, "123:token");
  });

  it("keeps Telegram approvals pointed at the same allowlisted user", () => {
    const config = buildOpenClawConfig(env, projectRoot);

    assert.equal(config.channels.telegram.accounts.main.execApprovals.enabled, true);
    assert.deepEqual(config.channels.telegram.accounts.main.execApprovals.approvers, ["987654321"]);
  });

  it("reports missing environment keys when run as a CLI without env", () => {
    const result = spawnSync(process.execPath, ["scripts/render-openclaw-config.mjs"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {},
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing environment keys:/);
  });

  it("rejects config output paths outside .openclaw", () => {
    const root = createTempProjectRoot();
    let error;
    try {
      writeOpenClawConfig({ ...completeEnv, OPENCLAW_CONFIG_PATH: "openclaw.json" }, root);
    } catch (caughtError) {
      error = caughtError;
    }

    assert.ok(error);
    assert.match(error.message, /OPENCLAW_CONFIG_PATH must be a relative path under \.openclaw\//);
    assert.doesNotMatch(error.message, /123:token/);
    assert.equal(existsSync(join(root, "openclaw.json")), false);
  });

  it("rejects config output paths that escape the project root", () => {
    const root = createTempProjectRoot();

    assert.throws(
      () => writeOpenClawConfig({ ...completeEnv, OPENCLAW_CONFIG_PATH: "../openclaw.json" }, root),
      /OPENCLAW_CONFIG_PATH must be a relative path under \.openclaw\//,
    );
  });

  it("rejects absolute config output paths", () => {
    const root = createTempProjectRoot();

    assert.throws(
      () => writeOpenClawConfig({ ...completeEnv, OPENCLAW_CONFIG_PATH: "/tmp/openclaw.json" }, root),
      /OPENCLAW_CONFIG_PATH must be a relative path under \.openclaw\//,
    );
  });

  it("writes config output under .openclaw when env is complete", () => {
    const root = createTempProjectRoot();
    const outputPath = writeOpenClawConfig(
      { ...completeEnv, OPENCLAW_CONFIG_PATH: ".openclaw/openclaw.json" },
      root,
    );

    assert.equal(outputPath, resolve(root, ".openclaw/openclaw.json"));
    const config = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(config.channels.telegram.accounts.main.botToken, "123:token");
  });

  it("reads the default env file from the project root instead of cwd", () => {
    const root = createTempProjectRoot();
    writeEnvFile(root, completeEnv);

    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          `import { writeOpenClawConfig } from ${JSON.stringify(renderScriptUrl)};`,
          `console.log(writeOpenClawConfig(undefined, ${JSON.stringify(root)}));`,
        ].join("\n"),
      ],
      {
        cwd: tmpdir(),
        encoding: "utf8",
        env: {},
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), resolve(root, ".openclaw/openclaw.json"));
  });
});
