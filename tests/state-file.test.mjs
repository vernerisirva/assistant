import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withFileLockSync, writeFileAtomicSync } from "../scripts/lib/state-file.mjs";

function withStateDir() {
  const dir = mkdtempSync(join(tmpdir(), "assistant-state-file-"));
  return { dir, path: join(dir, "state.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("atomic state file writes", () => {
  it("replaces the file and leaves no temporary file behind", () => {
    const state = withStateDir();
    try {
      writeFileAtomicSync(state.path, "first\n");
      writeFileAtomicSync(state.path, "second\n");
      assert.equal(readFileSync(state.path, "utf8"), "second\n");
      assert.deepEqual(readdirSync(state.dir), ["state.json"]);
    } finally {
      state.cleanup();
    }
  });
});

describe("state file lock", () => {
  it("gives up with FILE_LOCKED while another writer holds a fresh lock, and leaves that lock alone", () => {
    const state = withStateDir();
    try {
      writeFileSync(`${state.path}.lock`, JSON.stringify({ pid: process.pid, token: "other" }));
      let ran = false;
      assert.throws(
        () => withFileLockSync(state.path, () => (ran = true), { timeoutMs: 40 }),
        (error) => error.code === "FILE_LOCKED",
      );
      assert.equal(ran, false);
      assert.equal(JSON.parse(readFileSync(`${state.path}.lock`, "utf8")).token, "other");
    } finally {
      state.cleanup();
    }
  });

  it("releases the lock when the change throws", () => {
    const state = withStateDir();
    try {
      assert.throws(() => withFileLockSync(state.path, () => {
        throw new Error("boom");
      }), /boom/);
      assert.equal(existsSync(`${state.path}.lock`), false);
    } finally {
      state.cleanup();
    }
  });

  it("does not remove a lock that another writer took over meanwhile", () => {
    const state = withStateDir();
    try {
      withFileLockSync(state.path, () => writeFileSync(`${state.path}.lock`, JSON.stringify({ pid: 1, token: "taken-over" })));
      assert.equal(JSON.parse(readFileSync(`${state.path}.lock`, "utf8")).token, "taken-over");
    } finally {
      state.cleanup();
    }
  });
});
