# Routine Skip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add routine-only one-day skips so a scheduled assistant routine can be suppressed for a specific Europe/Stockholm date without disabling future runs.

**Architecture:** Add a focused routine skip store helper in `scripts/lib/routine-skips.mjs`, then thread it into the existing routines CLI, routine cron status, scheduled routine prompt text, and assistant status output. The skip layer stores explicit `(routineId, date, timezone)` entries and is read-only during scheduled cron runs.

**Tech Stack:** Node.js ESM, built-in `node:test`, local JSON state under `.openclaw/state/routines/skips.json`, existing cron-store backup pattern, existing `routines-cron` and `assistant-status` helpers, no new dependencies.

---

### File Structure

- Create `scripts/lib/routine-skips.mjs`: validate routine ids/dates, normalize skip store data, add/remove/idempotently inspect skips, read/write `skips.json` with backups.
- Create `tests/routine-skips.test.mjs`: unit coverage for skip store behavior, validation, tolerant status reads, strict mutation reads, and backup writes.
- Modify `scripts/lib/routine-cron.mjs`: include skip state in `routineCronStatus()` and inject skip-aware instructions into scheduled routine cron messages.
- Modify `scripts/routines-cron.mjs`: add `skips`, `skip`, and `unskip` commands, plus JSON/dry-run support.
- Modify `tests/routine-cron.test.mjs`: CLI and prompt tests for skip commands and scheduled `NO_REPLY` behavior.
- Modify `scripts/lib/assistant-status.mjs`: load routine skip state, include skip load warnings, and pass skip state into routine summaries.
- Modify `scripts/assistant-status.mjs`: format skipped routines as `enabled, skipped today`.
- Modify `tests/assistant-status.test.mjs`: verify assistant status reports `skippedToday`.
- Modify `package.json`: add `routines:skips`, `routines:skip`, and `routines:unskip` scripts.
- Modify `agents/personal/AGENTS.md`: teach approval-gated routine-only skip/unskip behavior.
- Modify `tests/agent-boundaries.test.mjs`: guard the Personal prompt skip rules.
- Modify `docs/operations/daily-operation.md`: document routine skip inspection and control commands.

### Task 1: Routine Skip Store

**Files:**
- Create: `scripts/lib/routine-skips.mjs`
- Create: `tests/routine-skips.test.mjs`

- [ ] **Step 1: Write the failing skip store tests**

Create `tests/routine-skips.test.mjs` with:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addRoutineSkip,
  isRoutineSkipped,
  localDateInTimeZone,
  normalizeRoutineSkipStore,
  readRoutineSkipStore,
  removeRoutineSkip,
  resolveRoutineSkipStorePath,
  routineSkipStatus,
  writeRoutineSkipStoreFile,
} from "../scripts/lib/routine-skips.mjs";

const routineIds = ["morning-brief", "midday-check-in", "workout-window", "evening-review", "weekly-review"];

describe("routine skip store", () => {
  it("adds a skip idempotently and detects the skipped local date", () => {
    const first = addRoutineSkip(
      { version: 1, skips: [] },
      {
        routineIds,
        routineId: "workout-window",
        date: "2026-06-11",
        timezone: "Europe/Stockholm",
        source: "telegram",
        now: new Date("2026-06-11T09:30:00.000Z"),
      },
    );
    const second = addRoutineSkip(first.store, {
      routineIds,
      routineId: "workout-window",
      date: "2026-06-11",
      timezone: "Europe/Stockholm",
      source: "telegram",
      now: new Date("2026-06-11T10:00:00.000Z"),
    });

    assert.equal(first.result.action, "skip");
    assert.equal(first.result.added, true);
    assert.equal(second.result.added, false);
    assert.equal(second.store.skips.length, 1);
    assert.equal(isRoutineSkipped(second.store, "workout-window", "2026-06-11", "Europe/Stockholm"), true);
    assert.equal(isRoutineSkipped(second.store, "workout-window", "2026-06-12", "Europe/Stockholm"), false);
  });

  it("removes a skip and treats missing removals as no-op", () => {
    const skipped = addRoutineSkip(
      { version: 1, skips: [] },
      {
        routineIds,
        routineId: "workout-window",
        date: "2026-06-11",
        timezone: "Europe/Stockholm",
        source: "telegram",
        now: new Date("2026-06-11T09:30:00.000Z"),
      },
    ).store;

    const removed = removeRoutineSkip(skipped, {
      routineIds,
      routineId: "workout-window",
      date: "2026-06-11",
      timezone: "Europe/Stockholm",
    });
    const removedAgain = removeRoutineSkip(removed.store, {
      routineIds,
      routineId: "workout-window",
      date: "2026-06-11",
      timezone: "Europe/Stockholm",
    });

    assert.equal(removed.result.removed, true);
    assert.equal(removedAgain.result.removed, false);
    assert.equal(removedAgain.store.skips.length, 0);
  });

  it("rejects unknown routine ids and invalid dates", () => {
    assert.throws(
      () => addRoutineSkip({ version: 1, skips: [] }, {
        routineIds,
        routineId: "not-a-routine",
        date: "2026-06-11",
        timezone: "Europe/Stockholm",
      }),
      /Unknown routine id: not-a-routine/,
    );
    assert.throws(
      () => addRoutineSkip({ version: 1, skips: [] }, {
        routineIds,
        routineId: "workout-window",
        date: "2026-02-31",
        timezone: "Europe/Stockholm",
      }),
      /Invalid routine skip date: 2026-02-31/,
    );
  });

  it("reports skippedToday for configured routine ids", () => {
    const store = {
      version: 1,
      skips: [
        {
          routineId: "workout-window",
          date: "2026-06-11",
          timezone: "Europe/Stockholm",
          createdAt: "2026-06-11T09:30:00.000Z",
          source: "telegram",
        },
      ],
    };

    const status = routineSkipStatus(store, {
      routineIds,
      now: new Date("2026-06-11T10:00:00.000Z"),
      timezone: "Europe/Stockholm",
    });

    assert.equal(status.today, "2026-06-11");
    assert.equal(status.routines.find((entry) => entry.routineId === "workout-window").skippedToday, true);
    assert.equal(status.routines.find((entry) => entry.routineId === "midday-check-in").skippedToday, false);
  });

  it("calculates local dates in Europe/Stockholm", () => {
    assert.equal(
      localDateInTimeZone(new Date("2026-06-10T22:30:00.000Z"), "Europe/Stockholm"),
      "2026-06-11",
    );
  });

  it("tolerates malformed skip state for status reads and blocks strict reads", () => {
    const directory = mkdtempSync(join(tmpdir(), "routine-skips-"));
    const path = join(directory, ".openclaw/state/routines/skips.json");
    mkdirSync(join(directory, ".openclaw/state/routines"), { recursive: true });
    writeFileSync(path, "{ broken json");
    const issues = [];

    try {
      const tolerant = readRoutineSkipStore(path, { issues, strict: false });
      assert.deepEqual(tolerant, { version: 1, skips: [] });
      assert.equal(issues.length, 1);
      assert.equal(issues[0].type, "malformed-json");
      assert.throws(() => readRoutineSkipStore(path, { strict: true }), /Malformed routine skip state/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes skip state with a timestamped backup", () => {
    const directory = mkdtempSync(join(tmpdir(), "routine-skips-"));
    const path = resolveRoutineSkipStorePath(join(directory, ".openclaw/state"));
    mkdirSync(join(directory, ".openclaw/state/routines"), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ version: 1, skips: [] })}\n`);

    try {
      const result = writeRoutineSkipStoreFile(
        path,
        normalizeRoutineSkipStore({ version: 1, skips: [{ routineId: "workout-window", date: "2026-06-11", timezone: "Europe/Stockholm" }] }),
        { now: new Date("2026-06-11T09:30:00.000Z") },
      );

      assert.equal(existsSync(path), true);
      assert.equal(existsSync(result.backupPath), true);
      assert.equal(JSON.parse(readFileSync(path, "utf8")).skips.length, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/routine-skips.test.mjs
```

Expected: fail with `Cannot find module '../scripts/lib/routine-skips.mjs'`.

- [ ] **Step 3: Implement the skip store helper**

Create `scripts/lib/routine-skips.mjs` with:

```js
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatBackupTimestamp } from "./cron-store.mjs";

export const DEFAULT_ROUTINE_SKIP_TIMEZONE = "Europe/Stockholm";
export const DEFAULT_ROUTINE_SKIP_STORE = { version: 1, skips: [] };

export function resolveRoutineSkipStorePath(stateDir) {
  return join(stateDir, "routines/skips.json");
}

export function normalizeRoutineSkipStore(value) {
  const skips = Array.isArray(value?.skips) ? value.skips : [];
  return {
    version: value?.version ?? 1,
    skips: skips
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        routineId: String(entry.routineId ?? ""),
        date: String(entry.date ?? ""),
        timezone: String(entry.timezone ?? DEFAULT_ROUTINE_SKIP_TIMEZONE),
        ...(entry.createdAt ? { createdAt: String(entry.createdAt) } : {}),
        ...(entry.source ? { source: String(entry.source) } : {}),
      }))
      .filter((entry) => entry.routineId && entry.date),
  };
}

export function readRoutineSkipStore(path, { issues = [], strict = false } = {}) {
  if (!existsSync(path)) return { ...DEFAULT_ROUTINE_SKIP_STORE, skips: [] };

  try {
    return normalizeRoutineSkipStore(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (strict) {
      throw new Error(`Malformed routine skip state at ${path}: ${error.message}`);
    }
    issues.push({
      severity: "warn",
      type: "malformed-json",
      path,
      message: `Routine skip state is malformed: ${error.message}`,
    });
    return { ...DEFAULT_ROUTINE_SKIP_STORE, skips: [] };
  }
}

export function writeRoutineSkipStoreFile(path, store, { now = new Date(), backup = true } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  let backupPath = null;

  if (backup && existsSync(path)) {
    backupPath = `${path}.bak.${formatBackupTimestamp(now)}`;
    copyFileSync(path, backupPath);
  }

  writeFileSync(path, `${JSON.stringify(normalizeRoutineSkipStore(store), null, 2)}\n`);
  return { path, backupPath };
}

export function addRoutineSkip(
  store,
  {
    routineIds,
    routineId,
    date,
    timezone = DEFAULT_ROUTINE_SKIP_TIMEZONE,
    source = "telegram",
    now = new Date(),
  },
) {
  const validRoutineId = assertValidRoutineId(routineId, routineIds);
  const validDate = assertValidDate(date);
  const normalized = normalizeRoutineSkipStore(store);
  const existing = normalized.skips.find((entry) =>
    entry.routineId === validRoutineId &&
    entry.date === validDate &&
    entry.timezone === timezone
  );

  if (existing) {
    return {
      store: normalized,
      result: { action: "skip", routineId: validRoutineId, date: validDate, timezone, added: false },
    };
  }

  return {
    store: {
      ...normalized,
      skips: [
        ...normalized.skips,
        {
          routineId: validRoutineId,
          date: validDate,
          timezone,
          createdAt: now.toISOString(),
          source,
        },
      ],
    },
    result: { action: "skip", routineId: validRoutineId, date: validDate, timezone, added: true },
  };
}

export function removeRoutineSkip(
  store,
  {
    routineIds,
    routineId,
    date,
    timezone = DEFAULT_ROUTINE_SKIP_TIMEZONE,
  },
) {
  const validRoutineId = assertValidRoutineId(routineId, routineIds);
  const validDate = assertValidDate(date);
  const normalized = normalizeRoutineSkipStore(store);
  const skips = normalized.skips.filter((entry) =>
    entry.routineId !== validRoutineId ||
    entry.date !== validDate ||
    entry.timezone !== timezone
  );

  return {
    store: { ...normalized, skips },
    result: {
      action: "unskip",
      routineId: validRoutineId,
      date: validDate,
      timezone,
      removed: skips.length !== normalized.skips.length,
    },
  };
}

export function routineSkipStatus(
  store,
  {
    routineIds,
    now = new Date(),
    timezone = DEFAULT_ROUTINE_SKIP_TIMEZONE,
  },
) {
  const today = localDateInTimeZone(now, timezone);
  return {
    today,
    timezone,
    routines: routineIds.map((routineId) => ({
      routineId,
      skippedToday: isRoutineSkipped(store, routineId, today, timezone),
      skipDate: isRoutineSkipped(store, routineId, today, timezone) ? today : null,
    })),
  };
}

export function isRoutineSkipped(
  store,
  routineId,
  date,
  timezone = DEFAULT_ROUTINE_SKIP_TIMEZONE,
) {
  const normalized = normalizeRoutineSkipStore(store);
  return normalized.skips.some((entry) =>
    entry.routineId === routineId &&
    entry.date === date &&
    entry.timezone === timezone
  );
}

export function localDateInTimeZone(now = new Date(), timezone = DEFAULT_ROUTINE_SKIP_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

export function assertValidRoutineId(routineId, routineIds) {
  if (!routineIds.includes(routineId)) {
    throw new Error(`Unknown routine id: ${routineId}`);
  }
  return routineId;
}

export function assertValidDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw new Error(`Invalid routine skip date: ${date}`);
  }

  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid routine skip date: ${date}`);
  }

  return date;
}
```

- [ ] **Step 4: Run skip store tests**

Run:

```bash
node --test tests/routine-skips.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit skip store helper**

Stage only these files:

```bash
git add scripts/lib/routine-skips.mjs tests/routine-skips.test.mjs
git commit -m "Add routine skip store"
```

### Task 2: Routines CLI Skip Commands

**Files:**
- Modify: `scripts/routines-cron.mjs`
- Modify: `package.json`
- Modify: `tests/routine-cron.test.mjs`

- [ ] **Step 1: Add failing CLI tests**

In `tests/routine-cron.test.mjs`, extend the imports:

```js
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

Add these tests near the existing routine cron CLI tests:

```js
describe("routine skip CLI", () => {
  it("parses skip, unskip, and skips commands", () => {
    assert.deepEqual(parseRoutineCronArgs(["skips", "--json"]), {
      command: "skips",
      options: { json: true },
    });
    assert.deepEqual(parseRoutineCronArgs(["skip", "workout-window", "2026-06-11", "--dry-run"]), {
      command: "skip",
      options: { routineId: "workout-window", date: "2026-06-11", dryRun: true },
    });
    assert.deepEqual(parseRoutineCronArgs(["unskip", "workout-window", "2026-06-11"]), {
      command: "unskip",
      options: { routineId: "workout-window", date: "2026-06-11" },
    });
  });

  it("runs skip and unskip mutations against the skip store", async () => {
    const directory = mkdtempSync(join(tmpdir(), "routine-skip-cli-"));
    const stateDir = join(directory, ".openclaw/state");
    const writes = [];

    try {
      const skipped = await runRoutineCronCli(["skip", "workout-window", "2026-06-11"], {
        root: directory,
        schedules,
        stateDir,
        existingCronStore: { version: 1, jobs: [] },
        existingCronState: { version: 1, jobs: {} },
        readSkipStoreForMutation: () => ({ version: 1, skips: [] }),
        writeSkipStore: (store) => writes.push(store),
        now: new Date("2026-06-11T09:30:00.000Z"),
      });

      assert.equal(skipped.restartRequired, false);
      assert.equal(skipped.result.action, "skip");
      assert.equal(skipped.result.routineId, "workout-window");
      assert.equal(writes[0].skips.length, 1);

      const unskipped = await runRoutineCronCli(["unskip", "workout-window", "2026-06-11"], {
        root: directory,
        schedules,
        stateDir,
        existingCronStore: { version: 1, jobs: [] },
        existingCronState: { version: 1, jobs: {} },
        readSkipStoreForMutation: () => writes[0],
        writeSkipStore: (store) => writes.push(store),
        now: new Date("2026-06-11T09:31:00.000Z"),
      });

      assert.equal(unskipped.restartRequired, false);
      assert.equal(unskipped.result.action, "unskip");
      assert.equal(unskipped.result.removed, true);
      assert.equal(writes[1].skips.length, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lists routine skip status without requiring approval or writes", async () => {
    const result = await runRoutineCronCli(["skips", "--json"], {
      schedules,
      existingCronStore: { version: 1, jobs: [] },
      existingCronState: { version: 1, jobs: {} },
      readSkipStoreForStatus: () => ({
        version: 1,
        skips: [
          {
            routineId: "workout-window",
            date: "2026-06-11",
            timezone: "Europe/Stockholm",
            createdAt: "2026-06-11T09:30:00.000Z",
            source: "telegram",
          },
        ],
      }),
      now: new Date("2026-06-11T10:00:00.000Z"),
    });

    assert.equal(result.today, "2026-06-11");
    assert.equal(result.routines.find((entry) => entry.routineId === "workout-window").skippedToday, true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/routine-cron.test.mjs
```

Expected: fail because `skips`, `skip`, and `unskip` are unknown commands.

- [ ] **Step 3: Implement routines CLI skip commands**

In `scripts/routines-cron.mjs`, import:

```js
import {
  addRoutineSkip,
  readRoutineSkipStore,
  removeRoutineSkip,
  resolveRoutineSkipStorePath,
  routineSkipStatus,
  writeRoutineSkipStoreFile,
} from "./lib/routine-skips.mjs";
```

Update the command validation list in `parseRoutineCronArgs()`:

```js
const readCommands = new Set(["plan", "status", "skips"]);
const mutationCommands = new Set(["install", "enable", "disable", "set-time", "skip", "unskip"]);
```

Add parse branches:

```js
if (command === "skips") {
  if (operands.length > 0) throw new Error("skips does not accept operands.");
  return { command, options };
}

if (command === "skip" || command === "unskip") {
  if (operands.length !== 2) throw new Error(`${command} requires exactly ROUTINE_ID and YYYY-MM-DD.`);
  return {
    command,
    options: {
      ...options,
      routineId: operands[0],
      date: operands[1],
    },
  };
}
```

Add default parameters to `runRoutineCronCli()`:

```js
skipStorePath = resolveRoutineSkipStorePath(stateDir),
readSkipStoreForStatus = () => readRoutineSkipStore(skipStorePath, { strict: false }),
readSkipStoreForMutation = () => readRoutineSkipStore(skipStorePath, { strict: true }),
writeSkipStore = (store) => writeRoutineSkipStoreFile(skipStorePath, store),
```

Add command handling before existing cron mutations:

```js
if (parsed.command === "skips") {
  return routineSkipStatus(readSkipStoreForStatus(), {
    routineIds: routineIds(schedules),
    now,
    timezone: schedules.timezone,
  });
}

if (parsed.command === "skip" || parsed.command === "unskip") {
  const existingSkipStore = readSkipStoreForMutation();
  const update = parsed.command === "skip"
    ? addRoutineSkip(existingSkipStore, {
        routineIds: routineIds(schedules),
        routineId: parsed.options.routineId,
        date: parsed.options.date,
        timezone: schedules.timezone,
        source: "telegram",
        now,
      })
    : removeRoutineSkip(existingSkipStore, {
        routineIds: routineIds(schedules),
        routineId: parsed.options.routineId,
        date: parsed.options.date,
        timezone: schedules.timezone,
      });

  if (!parsed.options.dryRun) {
    writeSkipStore(update.store);
  }

  return {
    dryRun: parsed.options.dryRun === true,
    restartRequired: false,
    result: update.result,
  };
}
```

Add a formatter branch:

```js
if (command === "skips") return formatRoutineSkips(result);
```

Add format helpers:

```js
function formatRoutineSkips(result) {
  return result.routines
    .map((entry) => `${entry.skippedToday ? "SKIPPED" : "active"} ${entry.routineId} ${result.today} ${result.timezone}`)
    .join("\n");
}
```

Add mutation format support:

```js
if (["skip", "unskip"].includes(result.result.action)) {
  const dryRun = result.dryRun ? "DRY RUN " : "";
  const state = result.result.action === "skip"
    ? result.result.added ? "added" : "already present"
    : result.result.removed ? "removed" : "not present";
  return `${dryRun}${result.result.action} ${result.result.routineId} ${result.result.date} (${state}).`;
}
```

- [ ] **Step 4: Add package scripts**

In `package.json`, add:

```json
"routines:skips": "node scripts/routines-cron.mjs skips",
"routines:skip": "node scripts/routines-cron.mjs skip",
"routines:unskip": "node scripts/routines-cron.mjs unskip"
```

- [ ] **Step 5: Run routine CLI tests**

Run:

```bash
node --test tests/routine-cron.test.mjs tests/routine-skips.test.mjs
```

Expected: all tests pass.

- [ ] **Step 6: Commit CLI skip commands**

Stage only these files:

```bash
git add scripts/routines-cron.mjs package.json tests/routine-cron.test.mjs
git commit -m "Add routine skip CLI commands"
```

### Task 3: Routine and Assistant Status Integration

**Files:**
- Modify: `scripts/lib/routine-cron.mjs`
- Modify: `scripts/lib/assistant-status.mjs`
- Modify: `scripts/assistant-status.mjs`
- Modify: `tests/routine-cron.test.mjs`
- Modify: `tests/assistant-status.test.mjs`

- [ ] **Step 1: Add failing routine status skip test**

In `tests/routine-cron.test.mjs`, add to the `"reports routine status with next run information"` test expected object:

```js
skippedToday: false,
skipDate: null,
```

Add a new test:

```js
it("marks enabled routines skipped today without disabling them", () => {
  const jobs = buildRoutineCronJobs(schedules, { telegramUserId: "1029709001" });
  const upserted = upsertRoutineCronJobs({ version: 1, jobs: [] }, jobs, {
    nowMs: 1779900000000,
    idGenerator: () => "routine-id",
  }).store;

  const status = routineCronStatus(upserted, { version: 1, jobs: {} }, {
    skipStore: {
      version: 1,
      skips: [
        {
          routineId: "workout-window",
          date: "2026-06-11",
          timezone: "Europe/Stockholm",
        },
      ],
    },
    now: new Date("2026-06-11T10:00:00.000Z"),
    timezone: "Europe/Stockholm",
  });

  const workout = status.find((entry) => entry.routineId === "workout-window");
  assert.equal(workout.enabled, true);
  assert.equal(workout.skippedToday, true);
  assert.equal(workout.skipDate, "2026-06-11");
});
```

- [ ] **Step 2: Add failing assistant status skip test**

In `tests/assistant-status.test.mjs`, update a `buildAssistantStatus()` call to include:

```js
skipStore: {
  version: 1,
  skips: [
    {
      routineId: "midday-check-in",
      date: "2026-06-11",
      timezone: "Europe/Stockholm",
    },
  ],
},
```

Add assertions:

```js
const midday = status.automation.routines.find((routine) => routine.routineId === "midday-check-in");
assert.equal(midday.skippedToday, true);
assert.equal(midday.skipDate, "2026-06-11");
```

Add a formatter assertion:

```js
assert.match(formatAssistantStatus({
  overall: "running",
  telegram: { enabled: true, provider: "@hilla_assistant_bot", allowFromCount: 1 },
  automation: {
    summary: { enabledJobs: 2, totalJobs: 3, dailyRecurringJobs: 1 },
    routines: [{ routineId: "workout-window", enabled: true, skippedToday: true, skipDate: "2026-06-11" }],
  },
  recentActivity: { gatewayReadyAt: "2026-06-11T10:48:38.193+02:00", lastScheduledRunAt: null },
  recentIssues: [],
  suggestedActions: [],
}), /workout-window enabled, skipped today/);
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
node --test tests/routine-cron.test.mjs tests/assistant-status.test.mjs
```

Expected: fail because status objects do not yet include `skippedToday`.

- [ ] **Step 4: Implement routine status skip fields**

In `scripts/lib/routine-cron.mjs`, import:

```js
import {
  DEFAULT_ROUTINE_SKIP_TIMEZONE,
  isRoutineSkipped,
  localDateInTimeZone,
} from "./routine-skips.mjs";
```

Change the signature:

```js
export function routineCronStatus(
  existingStore,
  existingState = {},
  {
    skipStore = { version: 1, skips: [] },
    now = new Date(),
    timezone = DEFAULT_ROUTINE_SKIP_TIMEZONE,
  } = {},
) {
```

Inside the function, compute:

```js
const today = localDateInTimeZone(now, timezone);
```

Add fields to each routine status:

```js
const skippedToday = isRoutineSkipped(skipStore, routineIdFromJobName(job.name), today, timezone);
return {
  routineId: routineIdFromJobName(job.name),
  name: job.name,
  enabled: job.enabled !== false,
  cron: job.schedule?.expr,
  timezone: job.schedule?.tz,
  nextRunAt: state.nextRunAtMs ? new Date(state.nextRunAtMs).toISOString() : null,
  lastStatus: state.lastStatus ?? null,
  skippedToday,
  skipDate: skippedToday ? today : null,
};
```

- [ ] **Step 5: Implement assistant status skip loading**

In `scripts/lib/assistant-status.mjs`, import:

```js
import { readRoutineSkipStore, resolveRoutineSkipStorePath } from "./routine-skips.mjs";
```

Add `skipStore = { version: 1, skips: [] }` to `buildAssistantStatus()` parameters.

Change the routine status call to:

```js
routines: routineCronStatus(cronStore, safeCronState, {
  skipStore,
  now,
  timezone: "Europe/Stockholm",
}),
```

In `loadAssistantStatusInputs()`, read the skip store:

```js
const skipStorePath = resolveRoutineSkipStorePath(resolvedStateDir);
const skipStore = readRoutineSkipStore(skipStorePath, { issues: loadIssues, strict: false });
```

Return `skipStore` and add `skipStorePath` to `paths`.

- [ ] **Step 6: Implement assistant status formatting**

In `scripts/assistant-status.mjs`, change the routine mapping to:

```js
.map((routine) => {
  const state = routine.enabled ? "enabled" : "disabled";
  return `${routine.routineId} ${state}${routine.skippedToday ? ", skipped today" : ""}`;
})
```

- [ ] **Step 7: Run status tests**

Run:

```bash
node --test tests/routine-cron.test.mjs tests/assistant-status.test.mjs
```

Expected: all tests pass.

- [ ] **Step 8: Commit status integration**

Stage only these files:

```bash
git add scripts/lib/routine-cron.mjs scripts/lib/assistant-status.mjs scripts/assistant-status.mjs tests/routine-cron.test.mjs tests/assistant-status.test.mjs
git commit -m "Show routine skip state in status"
```

### Task 4: Scheduled Prompt and Personal Prompt Updates

**Files:**
- Modify: `scripts/lib/routine-cron.mjs`
- Modify: `agents/personal/AGENTS.md`
- Modify: `tests/routine-cron.test.mjs`
- Modify: `tests/agent-boundaries.test.mjs`

- [ ] **Step 1: Add failing scheduled prompt tests**

In `tests/routine-cron.test.mjs`, inside `"builds Telegram cron jobs from the routine schedule"`, add:

```js
assert.match(job.message, /npm run --silent routines:skips -- --json/);
assert.match(job.message, /NO_REPLY/);
assert.match(job.message, /skip store/i);
```

- [ ] **Step 2: Add failing Personal prompt tests**

In `tests/agent-boundaries.test.mjs`, add:

```js
it("teaches the personal agent routine-only skip controls", () => {
  const personalAgent = agents.find((agent) => agent.id === "personal");
  const prompt = readFileSync(`${personalAgent.promptDir}/AGENTS.md`, "utf8");

  assert.match(prompt, /Routine skips/);
  assert.match(prompt, /npm run routines:skips/);
  assert.match(prompt, /npm run routines:skip -- ROUTINE_ID YYYY-MM-DD/);
  assert.match(prompt, /npm run routines:unskip -- ROUTINE_ID YYYY-MM-DD/);
  assert.match(prompt, /requires Telegram approval/i);
  assert.match(prompt, /temporary and routine-only/i);
  assert.match(prompt, /does not skip one-shot reminders/i);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
node --test tests/routine-cron.test.mjs tests/agent-boundaries.test.mjs
```

Expected: fail because prompts do not yet mention skips.

- [ ] **Step 4: Update scheduled routine prompt text**

In `scripts/lib/routine-cron.mjs`, update `buildRoutineMessage(routine)` so the returned array starts with:

```js
`Scheduled assistant routine: ${routine.id}.`,
`First run npm run --silent routines:skips -- --json from the assistant repo and inspect ${routine.id} for today's Europe/Stockholm date.`,
`If ${routine.id} is skippedToday, return exactly NO_REPLY as your final answer and do no routine work.`,
`If ${routine.id} is not skippedToday, run npm run routine -- ${routine.id} from the assistant repo and use the returned telegramPrompt as the briefing template.`,
```

Keep the existing context-gathering, final-answer, side-effect, and feedback lines after those four lines.

- [ ] **Step 5: Update Personal standing orders**

In `agents/personal/AGENTS.md`, add after the Routine section:

```md
Routine skips:
- Use `npm run routines:skips` to inspect temporary routine-only skips. Read-only skip inspection is allowed without extra approval.
- Use `npm run routines:skip -- ROUTINE_ID YYYY-MM-DD` only after Telegram approval when the user wants to skip a routine for one local Europe/Stockholm date.
- Use `npm run routines:unskip -- ROUTINE_ID YYYY-MM-DD` only after Telegram approval when the user wants to undo a temporary skip.
- Approval prompts for skip/unskip must include agent, action, target routine id and date, expected effect, risk, and approval options.
- Routine skips are temporary and routine-only; they do not skip one-shot reminders, AGM reminders, golf reminders, gym card reminders, or arbitrary cron jobs.
- Use disable/enable controls for recurring changes, not skip.
```

- [ ] **Step 6: Run prompt tests**

Run:

```bash
node --test tests/routine-cron.test.mjs tests/agent-boundaries.test.mjs
```

Expected: all tests pass.

- [ ] **Step 7: Commit prompt updates**

Stage only these files:

```bash
git add scripts/lib/routine-cron.mjs agents/personal/AGENTS.md tests/routine-cron.test.mjs tests/agent-boundaries.test.mjs
git commit -m "Teach routines to honor temporary skips"
```

### Task 5: Documentation, Render, and Smoke Test

**Files:**
- Modify: `docs/operations/daily-operation.md`
- Generated by command: `.openclaw/workspace-personal/AGENTS.md`
- Generated by command: `.openclaw/openclaw.json`

- [ ] **Step 1: Document skip commands**

In `docs/operations/daily-operation.md`, add a section after routine status:

````md
Inspect temporary routine-only skips:

```bash
npm run routines:skips
```

Skip or unskip one assistant routine for one Europe/Stockholm date:

```bash
npm run routines:skip -- workout-window 2026-06-11
npm run routines:unskip -- workout-window 2026-06-11
```

Routine skips do not disable future runs and do not affect one-shot reminders. The cron prompts must be rendered once with skip awareness; after that, changing `skips.json` does not require a gateway restart.
````

- [ ] **Step 2: Run full tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Render config and verify generated prompt**

Run:

```bash
npm run render:config
rg -n "routines:skips|NO_REPLY|Routine skips" .openclaw/workspace-personal/AGENTS.md .openclaw/openclaw.json
```

Expected: `routines:skips` and `NO_REPLY` appear in rendered routine cron payloads, and `Routine skips` appears in the Personal workspace prompt.

- [ ] **Step 4: Restart gateway once**

Run:

```bash
launchctl kickstart -k gui/501/ai.openclaw.gateway
sleep 5
npm run doctor
```

Expected: gateway restarts, `npm run doctor` passes.

- [ ] **Step 5: Smoke test skip behavior locally**

Run:

```bash
npm run routines:skip -- workout-window 2026-06-11
npm run --silent assistant:status -- --json | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s); const r=j.automation.routines.find(x=>x.routineId==='workout-window'); console.log(JSON.stringify({overall:j.overall, routine:r}, null, 2));})"
```

Expected: status JSON shows `workout-window` with `"enabled": true`, `"skippedToday": true`, and `"skipDate": "2026-06-11"`.

- [ ] **Step 6: Undo smoke skip unless the user wants it active**

Run:

```bash
npm run routines:unskip -- workout-window 2026-06-11
```

Expected: skip is removed. If Verneri wants to keep today’s workout-window skipped, do not run this step.

- [ ] **Step 7: Commit docs and generated runtime update**

Stage only these files:

```bash
git add docs/operations/daily-operation.md .openclaw/workspace-personal/AGENTS.md .openclaw/openclaw.json
git commit -m "Document routine skip operations"
```

If generated `.openclaw` files are intentionally ignored and cannot be committed, commit only `docs/operations/daily-operation.md` and state that generated files were rendered locally.

### Final Verification

- [ ] **Step 1: Run complete verification**

Run:

```bash
npm test
npm run doctor
npm run --silent assistant:status -- --json
```

Expected:

- `npm test` passes.
- `npm run doctor` passes.
- Assistant status is `running` or explains only real current warnings.
- Telegram is enabled for `@hilla_assistant_bot`.

- [ ] **Step 2: Ask Telegram for status**

Ask:

```text
what is running right now?
```

Expected: Telegram reports routine skip state if a skip is active, and no longer suggests disabling the recurring workout-window when only today is skipped.
