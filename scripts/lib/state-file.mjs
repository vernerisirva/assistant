/**
 * Durable writes and a short cross-process lock for small local state files.
 *
 * A state file is replaced, never rewritten in place: the new content goes to a
 * temporary file next to it, is flushed to disk and renamed over the old file.
 * A reader therefore sees the old file or the new one, and a write that fails
 * part-way (a full disk, a killed process) leaves the old file as it was.
 *
 * The lock serializes read-modify-write cycles across processes, so two writers
 * cannot lose each other's changes. It follows the weekly plan store's lock,
 * synchronously, for writes that hold it for milliseconds: a holder that has
 * kept it for half a minute has died, and its lock is taken over.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Replaces `path` with `text` through a flushed temporary file, readable only by its owner. */
export function writeFileAtomicSync(path, text, { mode = 0o600 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    const descriptor = openSync(temporary, "wx", mode);
    try {
      writeFileSync(descriptor, text);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Runs `fn` while holding `<path>.lock`, waiting up to `timeoutMs` for another
 * holder. A holder removes the lock only while it still carries its own token.
 * @throws Error with code FILE_LOCKED when the lock stays busy
 */
export function withFileLockSync(path, fn, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS, clock = Date.now } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const token = randomBytes(8).toString("hex");
  const started = clock();
  for (;;) {
    let descriptor;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const held = readLock(lockPath);
      if (!held) continue;
      if (clock() - held.mtimeMs >= staleMs) {
        if (readLock(lockPath)?.token === held.token) rmSync(lockPath, { force: true });
        continue;
      }
      if (clock() - started >= timeoutMs) {
        const busy = new Error(`${basename(path)} is being updated by another process; try again in a moment.`);
        busy.code = "FILE_LOCKED";
        throw busy;
      }
      Atomics.wait(sleeper, 0, 0, LOCK_RETRY_MS);
      continue;
    }
    try {
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, at: new Date(clock()).toISOString() }));
    } catch (error) {
      closeSync(descriptor);
      rmSync(lockPath, { force: true });
      throw error;
    }
    closeSync(descriptor);
    try {
      return fn();
    } finally {
      if (readLock(lockPath)?.token === token) rmSync(lockPath, { force: true });
    }
  }
}

/** `{ token, mtimeMs }` of a lock file, or null when it is gone. Unreadable content has no token. */
function readLock(lockPath) {
  let mtimeMs;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return { token: JSON.parse(readFileSync(lockPath, "utf8")).token ?? null, mtimeMs };
  } catch {
    return { token: null, mtimeMs };
  }
}
