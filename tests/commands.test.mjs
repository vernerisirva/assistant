import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpenClawGatewayArgs,
  commandExists,
  resolveOpenClawCommand,
  resolveOpenClawConfigPath,
  resolveOpenClawStateDir,
} from "../scripts/lib/commands.mjs";

describe("buildOpenClawGatewayArgs", () => {
  it("uses OPENCLAW_CONFIG_PATH from the environment and verbose gateway mode", () => {
    assert.deepEqual(buildOpenClawGatewayArgs(".openclaw/openclaw.json"), [
      "gateway",
      "--verbose",
    ]);
  });
});

describe("resolveOpenClawStateDir", () => {
  it("resolves the default state directory under the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-state-test-"));

    assert.equal(resolveOpenClawStateDir({}, root), join(root, ".openclaw/state"));
  });

  it("rejects state directories outside the generated OpenClaw directory", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-state-test-"));

    assert.throws(
      () => resolveOpenClawStateDir({ OPENCLAW_STATE_DIR: "../state" }, root),
      /OPENCLAW_STATE_DIR must be a relative path under \.openclaw\//,
    );
  });
});

describe("commandExists", () => {
  it("detects node on the local machine", () => {
    assert.equal(commandExists("node"), true);
  });

  it("returns false for a command name that should not exist", () => {
    assert.equal(commandExists("assistant-command-that-does-not-exist"), false);
  });

  it("does not execute shell syntax in command names", () => {
    assert.equal(commandExists("assistant-command-that-does-not-exist; true"), false);
  });

  it("detects an executable file by exact path", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-command-test-"));
    const commandPath = join(cwd, "assistant-test-command");
    writeFileSync(commandPath, "#!/bin/sh\nexit 0\n");
    chmodSync(commandPath, 0o755);

    assert.equal(commandExists(commandPath), true);
  });
});

describe("resolveOpenClawCommand", () => {
  it("finds an NVM-installed OpenClaw command when PATH does not include it", () => {
    const home = mkdtempSync(join(tmpdir(), "openclaw-home-test-"));
    const commandDir = join(home, ".nvm/versions/node/v22.22.2/bin");
    const commandPath = join(commandDir, "openclaw");
    mkdirSync(commandDir, { recursive: true });
    writeFileSync(commandPath, "#!/bin/sh\nexit 0\n");
    chmodSync(commandPath, 0o755);

    assert.equal(resolveOpenClawCommand({ HOME: home, PATH: "" }), commandPath);
  });
});

describe("resolveOpenClawConfigPath", () => {
  it("resolves the default config path under the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-config-test-"));

    assert.equal(
      resolveOpenClawConfigPath({}, root),
      join(root, ".openclaw/openclaw.json"),
    );
  });

  it("rejects config paths outside the generated OpenClaw directory", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-config-test-"));

    assert.throws(
      () => resolveOpenClawConfigPath({ OPENCLAW_CONFIG_PATH: "../openclaw.json" }, root),
      /OPENCLAW_CONFIG_PATH must be a relative path under \.openclaw\//,
    );
  });
});
