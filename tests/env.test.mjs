import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseEnvText,
  requiredEnvReport,
  REQUIRED_ENV_KEYS,
} from "../scripts/lib/env.mjs";

describe("parseEnvText", () => {
  it("parses key values, ignores comments, and strips surrounding quotes", () => {
    const env = parseEnvText(`
      # comment
      ASSISTANT_TIMEZONE=Europe/Stockholm
      TELEGRAM_USER_ID="123456789"
      EMPTY=
    `);

    assert.equal(env.ASSISTANT_TIMEZONE, "Europe/Stockholm");
    assert.equal(env.TELEGRAM_USER_ID, "123456789");
    assert.equal(env.EMPTY, "");
  });

  it("strips only matching quote pairs", () => {
    const env = parseEnvText(`
      DOUBLE="value"
      SINGLE='value'
      LEADING="value
      TRAILING=value"
      MIXED="value'
    `);

    assert.equal(env.DOUBLE, "value");
    assert.equal(env.SINGLE, "value");
    assert.equal(env.LEADING, '"value');
    assert.equal(env.TRAILING, 'value"');
    assert.equal(env.MIXED, '"value\'');
  });
});

describe("requiredEnvReport", () => {
  it("requires Google Pub/Sub setup values", () => {
    assert.equal(REQUIRED_ENV_KEYS.includes("GOOGLE_PUBSUB_TOPIC"), true);
    assert.equal(REQUIRED_ENV_KEYS.includes("GOOGLE_PUBSUB_SUBSCRIPTION"), true);
  });

  it("separates present and missing keys", () => {
    const report = requiredEnvReport(
      { TELEGRAM_USER_ID: "123456789", GMAIL_ACCOUNT: "" },
      ["TELEGRAM_USER_ID", "GMAIL_ACCOUNT", "PRIMARY_MODEL"],
    );

    assert.deepEqual(report.present, ["TELEGRAM_USER_ID"]);
    assert.deepEqual(report.missing, ["GMAIL_ACCOUNT", "PRIMARY_MODEL"]);
  });
});

describe("validate-env", () => {
  it("validates --example against the file without process env overlay", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-env-test-"));
    const scriptPath = fileURLToPath(
      new URL("../scripts/validate-env.mjs", import.meta.url),
    );
    const env = { ...process.env };

    for (const key of REQUIRED_ENV_KEYS) env[key] = "from-process-env";
    writeFileSync(join(cwd, ".env.example"), "ASSISTANT_TIMEZONE=UTC\n");

    const result = spawnSync(process.execPath, [scriptPath, "--example"], {
      cwd,
      env,
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Missing required environment keys in \.env\.example:/,
    );
    assert.match(result.stderr, /- TELEGRAM_BOT_TOKEN/);
  });
});
