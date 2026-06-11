import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function resolveCronStorePath(stateDir) {
  return join(stateDir, "cron/jobs.json");
}

export function resolveCronStatePath(stateDir) {
  return join(stateDir, "cron/jobs-state.json");
}

export function readJsonIfExists(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readExistingCronStore(jobsPath) {
  if (!existsSync(jobsPath)) return { version: 1, jobs: [] };

  const parsed = JSON.parse(readFileSync(jobsPath, "utf8"));
  if (Array.isArray(parsed.jobs)) return parsed;
  return { version: parsed.version ?? 1, jobs: [] };
}

export function readExistingCronState(stateDir) {
  const statePath = resolveCronStatePath(stateDir);
  if (!existsSync(statePath)) return { version: 1, jobs: {} };

  const parsed = JSON.parse(readFileSync(statePath, "utf8"));
  if (parsed && typeof parsed === "object" && parsed.jobs && typeof parsed.jobs === "object") {
    return parsed;
  }
  return { version: parsed.version ?? 1, jobs: {} };
}

export function writeCronStoreFile(jobsPath, store, { now = new Date(), backup = true } = {}) {
  mkdirSync(dirname(jobsPath), { recursive: true });
  let backupPath = null;

  if (backup && existsSync(jobsPath)) {
    backupPath = `${jobsPath}.bak.${formatBackupTimestamp(now)}`;
    copyFileSync(jobsPath, backupPath);
  }

  writeFileSync(jobsPath, `${JSON.stringify(store, null, 2)}\n`);
  return { path: jobsPath, backupPath };
}

export function formatBackupTimestamp(now) {
  const date = now instanceof Date ? now : new Date(now);
  return date.toISOString().replace(/[-:.]/g, "");
}
