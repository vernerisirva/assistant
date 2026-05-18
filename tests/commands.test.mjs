import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpenClawGatewayArgs,
  commandExists,
  resolveOpenClawConfigPath,
} from "../scripts/lib/commands.mjs";

describe("buildOpenClawGatewayArgs", () => {
  it("uses the rendered config path and verbose gateway mode", () => {
    assert.deepEqual(buildOpenClawGatewayArgs(".openclaw/openclaw.json"), [
      "gateway",
      "--config",
      ".openclaw/openclaw.json",
      "--verbose",
    ]);
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
