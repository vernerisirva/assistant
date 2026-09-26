import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MIN_OPENCLAW_VERSION,
  buildOpenClawGatewayArgs,
  commandExists,
  compareOpenClawVersions,
  parseOpenClawVersion,
  readOpenClawVersion,
  resolveOpenClawCommand,
  resolveOpenClawConfigPath,
  resolveOpenClawRuntime,
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

describe("OpenClaw runtime resolution", () => {
  function fakeExecutable(path, version) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\necho "OpenClaw ${version} (abc1234)"\n`);
    chmodSync(path, 0o755);
    return path;
  }

  function machine() {
    const home = mkdtempSync(join(tmpdir(), "openclaw-home-test-"));
    const managed = join(home, ".openclaw/bin/openclaw");
    const nvmBin = join(home, ".nvm/versions/node/v22.22.2/bin");
    return { home, managed, nvmBin };
  }

  const versions = (map) => (command) => map[command] ?? null;

  it("prefers the managed install over a stale nvm openclaw on PATH", () => {
    const { home, managed, nvmBin } = machine();
    fakeExecutable(managed, "2026.7.1-2");
    const stale = fakeExecutable(join(nvmBin, "openclaw"), "2026.5.12");
    const readVersion = versions({ [managed]: "2026.7.1-2", [stale]: "2026.5.12" });

    assert.equal(resolveOpenClawCommand({ HOME: home, PATH: nvmBin }), managed);
    assert.deepEqual(resolveOpenClawRuntime({ env: { HOME: home, PATH: nvmBin }, verify: true, readVersion }), {
      command: managed,
      source: "managed",
      version: "2026.7.1-2",
    });
  });

  it("uses an explicit OPENCLAW_CLI first, and verifies it when asked", () => {
    const { home, managed } = machine();
    fakeExecutable(managed, "2026.7.1-2");
    const explicit = fakeExecutable(join(home, "tools/openclaw"), "2026.8.0");

    assert.equal(resolveOpenClawCommand({ HOME: home, PATH: "", OPENCLAW_CLI: explicit }), explicit);
    assert.deepEqual(
      resolveOpenClawRuntime({ env: { HOME: home, PATH: "", OPENCLAW_CLI: explicit }, verify: true, readVersion: versions({ [explicit]: "2026.8.0" }) }),
      { command: explicit, source: "explicit", version: "2026.8.0" },
    );
    assert.throws(
      () => resolveOpenClawRuntime({ env: { HOME: home, PATH: "", OPENCLAW_CLI: join(home, "missing/openclaw") }, verify: true }),
      /OPENCLAW_CLI is set to .*missing\/openclaw, which is not an executable file/,
    );
  });

  it("accepts openclaw on PATH only when it is new enough", () => {
    const { home, nvmBin } = machine();
    const onPath = fakeExecutable(join(nvmBin, "openclaw"), "2026.5.12");

    assert.throws(
      () => resolveOpenClawCommand({ HOME: home, PATH: nvmBin }, { readVersion: versions({ [onPath]: "2026.5.12" }) }),
      /openclaw on PATH \(.*\) is OpenClaw 2026\.5\.12, older than the required 2026\.7\.1/,
    );
    assert.equal(resolveOpenClawCommand({ HOME: home, PATH: nvmBin }, { readVersion: versions({ [onPath]: "2026.7.3" }) }), onPath);
  });

  it("fails clearly when no runtime exists, instead of guessing an install path", () => {
    const { home } = machine();
    assert.throws(
      () => resolveOpenClawCommand({ HOME: home, PATH: "" }),
      /No OpenClaw runtime found\. OPENCLAW_CLI is not set, .*\.openclaw\/bin\/openclaw does not exist, and there is no openclaw on PATH\./,
    );
  });

  it("rejects a managed install that is too old when verifying", () => {
    const { home, managed } = machine();
    fakeExecutable(managed, "2026.5.12");
    assert.throws(
      () => resolveOpenClawRuntime({ env: { HOME: home, PATH: "" }, verify: true, readVersion: versions({ [managed]: "2026.5.12" }) }),
      /The managed OpenClaw .* is OpenClaw 2026\.5\.12, older than the required 2026\.7\.1/,
    );
  });

  it("reads and compares OpenClaw versions", () => {
    const { home } = machine();
    const cli = fakeExecutable(join(home, "bin/openclaw"), "2026.7.1-2");

    assert.equal(readOpenClawVersion(cli), "2026.7.1-2");
    assert.equal(readOpenClawVersion(join(home, "bin/missing")), null);
    assert.equal(parseOpenClawVersion("OpenClaw 2026.5.12 (f066dd2)"), "2026.5.12");
    assert.equal(compareOpenClawVersions("2026.7.1-2", MIN_OPENCLAW_VERSION), 1);
    assert.equal(compareOpenClawVersions("2026.7.1", "2026.7.1-0"), 0);
    assert.equal(compareOpenClawVersions("2026.5.12", "2026.7.1"), -1);
    assert.equal(compareOpenClawVersions("2026.10.0", "2026.9.9"), 1);
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
