import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  GATEWAY_WRAPPER_PATH,
  buildGatewayWrapperScript,
  buildInstallEnvironment,
  ensureGatewayToken,
  formatGatewayLaunchdPlan,
  planGatewayLaunchdInstall,
  shellQuote,
  wrapperProjectDir,
} from "../scripts/lib/launchd.mjs";
import {
  formatInstallLaunchdResult,
  parseInstallLaunchdArgs,
  prepareLaunchdInstall,
  runInstallLaunchd,
} from "../scripts/install-launchd.mjs";

const GATEWAY_TOKEN = "super-secret-gateway-token-value";

function writeExecutable(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  return path;
}

/** A machine with the managed OpenClaw, a stale nvm OpenClaw on PATH, and a rendered project. */
function fixtureMachine({ managed = true, config = { gateway: { mode: "local", auth: { mode: "token", token: GATEWAY_TOKEN }, remote: { token: GATEWAY_TOKEN } } } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "launchd-test-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const managedCli = join(home, ".openclaw/bin/openclaw");
  const nvmBin = join(home, ".nvm/versions/node/v22.22.2/bin");
  if (managed) writeExecutable(managedCli, '#!/bin/sh\necho "OpenClaw 2026.7.1-2 (0790d9f)"\n');
  writeExecutable(join(nvmBin, "openclaw"), '#!/bin/sh\necho "OpenClaw 2026.5.12 (f066dd2)"\n');
  mkdirSync(join(project, ".openclaw"), { recursive: true });
  writeFileSync(join(project, ".openclaw/openclaw.json"), `${JSON.stringify(config, null, 2)}\n`);
  const env = { HOME: home, PATH: nvmBin, TELEGRAM_USER_ID: "123456789", HILLA_TELEGRAM_BOT_TOKEN: "891055:SECRETBOTTOKEN" };
  const versions = { [managedCli]: "2026.7.1-2", [join(nvmBin, "openclaw")]: "2026.5.12" };
  return { root, home, project, managedCli, nvmBin, env, readVersion: (command) => versions[command] ?? null };
}

describe("launchd runtime selection", () => {
  it("selects the managed OpenClaw over a stale nvm install on PATH", () => {
    const machine = fixtureMachine();
    try {
      const { plan } = prepareLaunchdInstall({ root: machine.project, env: machine.env, readVersion: machine.readVersion });

      assert.deepEqual(plan.runtime, { command: machine.managedCli, source: "managed", version: "2026.7.1-2" });
      assert.equal(plan.install.command, machine.managedCli);
      assert.equal(plan.wrapper.runs, machine.managedCli);
      assert.doesNotMatch(plan.wrapper.content, /\.nvm|v22\.22\.2|node-v\d/);
    } finally {
      rmSync(machine.root, { recursive: true, force: true });
    }
  });

  it("rejects a stale PATH OpenClaw when no managed install exists", () => {
    const machine = fixtureMachine({ managed: false });
    try {
      assert.throws(
        () => prepareLaunchdInstall({ root: machine.project, env: machine.env, readVersion: machine.readVersion }),
        /openclaw on PATH \(.*v22\.22\.2\/bin\/openclaw\) is OpenClaw 2026\.5\.12, older than the required 2026\.7\.1/,
      );
    } finally {
      rmSync(machine.root, { recursive: true, force: true });
    }
  });

  it("uses a valid explicit OPENCLAW_CLI and refuses an invalid one", () => {
    const machine = fixtureMachine();
    const explicit = writeExecutable(join(machine.home, "custom/openclaw"), '#!/bin/sh\necho "OpenClaw 2026.8.0"\n');
    try {
      const { plan } = prepareLaunchdInstall({
        root: machine.project,
        env: { ...machine.env, OPENCLAW_CLI: explicit },
        readVersion: (command) => (command === explicit ? "2026.8.0" : machine.readVersion(command)),
      });
      assert.deepEqual(plan.runtime, { command: explicit, source: "explicit", version: "2026.8.0" });

      assert.throws(
        () => prepareLaunchdInstall({ root: machine.project, env: { ...machine.env, OPENCLAW_CLI: join(machine.home, "nope") }, readVersion: machine.readVersion }),
        /OPENCLAW_CLI is set to .*nope, which is not an executable file/,
      );
    } finally {
      rmSync(machine.root, { recursive: true, force: true });
    }
  });

  it("fails clearly when no OpenClaw runtime exists at all", () => {
    const machine = fixtureMachine({ managed: false });
    try {
      assert.throws(
        () => prepareLaunchdInstall({ root: machine.project, env: { ...machine.env, PATH: "" }, readVersion: machine.readVersion }),
        /No OpenClaw runtime found/,
      );
    } finally {
      rmSync(machine.root, { recursive: true, force: true });
    }
  });

  it("asks for a rendered config before planning", () => {
    const machine = fixtureMachine();
    rmSync(join(machine.project, ".openclaw/openclaw.json"));
    try {
      assert.throws(
        () => prepareLaunchdInstall({ root: machine.project, env: machine.env, readVersion: machine.readVersion }),
        /Rendered OpenClaw config not found: .*Run npm run render:config first\./,
      );
    } finally {
      rmSync(machine.root, { recursive: true, force: true });
    }
  });
});

describe("launchd install plan", () => {
  const runtime = { command: "/Users/me/.openclaw/bin/openclaw", source: "managed", version: "2026.7.1-2" };
  const plan = (extra = {}) =>
    planGatewayLaunchdInstall({ projectRoot: "/Users/me/AI-assistant", home: "/Users/me", runtime, config: { gateway: { auth: { token: GATEWAY_TOKEN } } }, ...extra });

  it("installs through OpenClaw's own installer with the repo wrapper and the selected runtime", () => {
    const result = plan();

    assert.equal(result.label, "ai.openclaw.gateway");
    assert.equal(result.plistPath, "/Users/me/Library/LaunchAgents/ai.openclaw.gateway.plist");
    assert.equal(result.wrapper.path, `/Users/me/${GATEWAY_WRAPPER_PATH}`);
    assert.equal(result.wrapper.mode, "0700");
    assert.deepEqual(result.install, {
      command: "/Users/me/.openclaw/bin/openclaw",
      args: ["gateway", "install", "--wrapper=/Users/me/.openclaw/bin/ai-assistant-launchd-wrapper", "--port=18789", "--json"],
    });
    assert.ok(plan({ force: true }).install.args.includes("--force"));
    assert.equal(result.logs.stdout, "/Users/me/Library/Logs/openclaw/gateway.log");
    assert.equal(result.wrapper.workingDirectory, "/Users/me/AI-assistant");
  });

  it("restarts an already-installed service only when the wrapper changes", () => {
    const current = buildGatewayWrapperScript({ projectRoot: "/Users/me/AI-assistant", openclawCommand: runtime.command });

    assert.equal(plan().wrapper.action, "create");
    assert.equal(plan({ existingWrapper: "#!/bin/sh\nexec /old/node /old/dist/index.js \"$@\"\n" }).wrapper.action, "update");
    assert.equal(plan({ existingWrapper: current }).wrapper.action, "unchanged");
    assert.equal(plan({ existingWrapper: current }).restartIfAlreadyInstalled, false);
    assert.equal(plan().restartIfAlreadyInstalled, true);
  });

  it("never puts the Gateway token in the plan or its printable preview", () => {
    const result = plan();
    const text = formatGatewayLaunchdPlan(result);

    assert.equal(JSON.stringify(result).includes(GATEWAY_TOKEN), false);
    assert.equal(text.includes(GATEWAY_TOKEN), false);
    assert.match(text, /Gateway token: keep existing \(not shown\)\./);
    assert.match(text, /OpenClaw runtime: \/Users\/me\/\.openclaw\/bin\/openclaw \(managed install, OpenClaw 2026\.7\.1-2\)/);
    assert.match(plan({ config: {} }).gatewayToken, /generate new \(not shown\)/);
  });
});

describe("launchd wrapper", () => {
  it("quotes paths for sh", () => {
    assert.equal(shellQuote("/tmp/o'hara repo"), "'/tmp/o'\\''hara repo'");
  });

  it("loads the project .env, sets the project config and state, and runs the selected OpenClaw from the project", () => {
    const root = mkdtempSync(join(tmpdir(), "launchd wrapper's test-"));
    try {
      const project = join(root, "project dir");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, ".env"), "OPENCLAW_STATE_DIR=.openclaw/state\nHILLA_TELEGRAM_BOT_TOKEN=from-dotenv\n");
      const runtime = writeExecutable(
        join(root, "bin dir/openclaw"),
        '#!/bin/sh\nprintf "args=%s|" "$*"\nprintf "cwd=%s|config=%s|state=%s|token=%s|path=%s" "$(pwd -P)" "$OPENCLAW_CONFIG_PATH" "$OPENCLAW_STATE_DIR" "$HILLA_TELEGRAM_BOT_TOKEN" "$PATH"\n',
      );
      const wrapper = writeExecutable(join(root, "wrapper"), buildGatewayWrapperScript({ projectRoot: project, openclawCommand: runtime }));

      const output = execFileSync("/bin/sh", [wrapper, "gateway", "--port", "18789"], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", HOME: root },
      });
      const fields = Object.fromEntries(output.split("|").map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));

      assert.equal(fields.args, "gateway --port 18789");
      assert.equal(fields.cwd, execFileSync("/bin/sh", ["-c", 'cd "$1" && pwd -P', "sh", project], { encoding: "utf8" }).trim());
      assert.equal(fields.config, join(project, ".openclaw/openclaw.json"));
      assert.equal(fields.state, join(project, ".openclaw/state"));
      assert.equal(fields.token, "from-dotenv");
      assert.ok(fields.path.startsWith(`${join(root, "bin dir")}:/usr/bin:/bin:`), fields.path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("launchd token and install environment", () => {
  it("keeps an existing token and mirrors it for remote CLI calls", () => {
    const existing = { gateway: { auth: { mode: "token", token: GATEWAY_TOKEN }, remote: { token: GATEWAY_TOKEN } } };
    assert.deepEqual(ensureGatewayToken(existing), { config: existing, changed: false, token: "kept" });

    const mirrored = ensureGatewayToken({ gateway: { auth: { token: GATEWAY_TOKEN } } });
    assert.equal(mirrored.changed, true);
    assert.equal(mirrored.config.gateway.remote.token, GATEWAY_TOKEN);
    assert.equal(mirrored.config.gateway.auth.mode, "token");
  });

  it("creates a token when none exists", () => {
    const created = ensureGatewayToken({ gateway: { mode: "local" } }, { generateToken: () => "generated-token" });
    assert.equal(created.token, "generated");
    assert.equal(created.changed, true);
    assert.equal(created.config.gateway.auth.token, "generated-token");
    assert.equal(created.config.gateway.remote.token, "generated-token");
    assert.equal(created.config.gateway.mode, "local");
  });

  it("does not hand .env values to OpenClaw's installer, which could copy them into its service env", () => {
    const env = buildInstallEnvironment({
      processEnv: { HOME: "/Users/me", PATH: "/usr/bin", HILLA_TELEGRAM_BOT_TOKEN: "exported-by-mistake", TODOIST_API_TOKEN: "t" },
      dotEnvKeys: ["HILLA_TELEGRAM_BOT_TOKEN", "TODOIST_API_TOKEN", "OPENCLAW_CONFIG_PATH"],
      configPath: "/repo/.openclaw/openclaw.json",
      stateDir: "/repo/.openclaw/state",
    });

    assert.deepEqual(env, {
      HOME: "/Users/me",
      PATH: "/usr/bin",
      OPENCLAW_CONFIG_PATH: "/repo/.openclaw/openclaw.json",
      OPENCLAW_STATE_DIR: "/repo/.openclaw/state",
    });
  });
});

describe("install:launchd CLI", () => {
  it("parses its options", () => {
    assert.deepEqual(parseInstallLaunchdArgs(["--dry-run", "--json"]), { dryRun: true, force: false, json: true });
    assert.deepEqual(parseInstallLaunchdArgs(["--force"]), { dryRun: false, force: true, json: false });
    assert.throws(() => parseInstallLaunchdArgs(["--token=x"]), /Unknown install:launchd option/);
  });

  it("prints a dry run that writes nothing and contains no secret", async () => {
    const machine = fixtureMachine();
    try {
      const before = readdirSync(join(machine.home, ".openclaw/bin"));
      const result = await runInstallLaunchd(["--dry-run"], {
        root: machine.project,
        env: machine.env,
        readVersion: machine.readVersion,
        platform: "linux",
      });
      const text = formatInstallLaunchdResult(result);

      assert.equal(result.dryRun, true);
      assert.deepEqual(readdirSync(join(machine.home, ".openclaw/bin")), before);
      assert.equal(existsSync(join(machine.home, GATEWAY_WRAPPER_PATH)), false);
      assert.equal(result.installedService.exists, false);
      assert.match(text, /^Dry run: nothing was written and launchd was not touched\./);
      assert.match(text, /Wrapper: .*ai-assistant-launchd-wrapper would be created/);
      assert.match(text, /exec '.*\/\.openclaw\/bin\/openclaw' "\$@"/);
      for (const secret of [GATEWAY_TOKEN, "891055:SECRETBOTTOKEN"]) {
        assert.equal(text.includes(secret), false);
        assert.equal(JSON.stringify(result).includes(secret), false);
      }
    } finally {
      rmSync(machine.root, { recursive: true, force: true });
    }
  });

  it("refuses to move the live Gateway to another checkout without --force", async () => {
    const machine = fixtureMachine();
    const installedWrapper = '#!/bin/sh\nproject_dir="/Users/me/AI-assistant"\nexec /Users/me/.openclaw/bin/openclaw "$@"\n';
    writeExecutable(join(machine.home, GATEWAY_WRAPPER_PATH), installedWrapper);
    try {
      const { plan } = prepareLaunchdInstall({ root: machine.project, env: machine.env, readVersion: machine.readVersion });
      assert.deepEqual(plan.projectChange, { from: "/Users/me/AI-assistant", to: machine.project });
      assert.match(formatGatewayLaunchdPlan(plan), /Warning: the installed Gateway runs from \/Users\/me\/AI-assistant/);

      await assert.rejects(
        runInstallLaunchd([], { root: machine.project, env: machine.env, readVersion: machine.readVersion, platform: "darwin" }),
        /The installed Gateway runs from \/Users\/me\/AI-assistant, but this checkout is .*add --force to move it here/,
      );
      assert.equal(execFileSync("/bin/cat", [join(machine.home, GATEWAY_WRAPPER_PATH)], { encoding: "utf8" }), installedWrapper);
    } finally {
      rmSync(machine.root, { recursive: true, force: true });
    }
  });

  it("reads the project directory from either wrapper quoting style", () => {
    const generated = buildGatewayWrapperScript({ projectRoot: "/tmp/o'hara repo", openclawCommand: "/x/openclaw" });
    assert.equal(wrapperProjectDir(generated), "/tmp/o'hara repo");
    assert.equal(wrapperProjectDir('project_dir="/Users/me/AI-assistant"\n'), "/Users/me/AI-assistant");
    assert.equal(wrapperProjectDir("#!/bin/sh\nexec openclaw\n"), null);
    const same = planGatewayLaunchdInstall({
      projectRoot: "/tmp/o'hara repo",
      home: "/h",
      runtime: { command: "/x/openclaw", source: "managed", version: "2026.7.1-2" },
      existingWrapper: generated,
    });
    assert.equal(same.projectChange, null);
  });

  it("refuses a real install off macOS before writing anything", async () => {
    const machine = fixtureMachine();
    try {
      await assert.rejects(
        runInstallLaunchd([], { root: machine.project, env: machine.env, readVersion: machine.readVersion, platform: "linux" }),
        /installs a macOS LaunchAgent/,
      );
      assert.equal(existsSync(join(machine.home, GATEWAY_WRAPPER_PATH)), false);
    } finally {
      rmSync(machine.root, { recursive: true, force: true });
    }
  });
});
