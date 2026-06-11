import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as routineSkipsModule from "../scripts/lib/routine-skips.mjs";
import {
  DEFAULT_ROUTINE_SKIP_STORE,
  addRoutineSkip,
  assertValidDate,
  assertValidRoutineId,
  isRoutineSkipped,
  localDateInTimeZone,
  normalizeRoutineSkipStore,
  readRoutineSkipStore,
  removeRoutineSkip,
  resolveRoutineSkipStorePath,
  routineSkipStatus,
  writeRoutineSkipStoreFile,
} from "../scripts/lib/routine-skips.mjs";

const routineIds = [
  "morning-brief",
  "midday-check-in",
  "workout-window",
  "evening-review",
  "weekly-review",
];

describe("routine skip store", () => {
  it("exports only the supported routine skip helpers", () => {
    assert.deepEqual(Object.keys(routineSkipsModule).sort(), [
      "DEFAULT_ROUTINE_SKIP_STORE",
      "DEFAULT_ROUTINE_SKIP_TIMEZONE",
      "addRoutineSkip",
      "assertValidDate",
      "assertValidRoutineId",
      "isRoutineSkipped",
      "localDateInTimeZone",
      "normalizeRoutineSkipStore",
      "readRoutineSkipStore",
      "removeRoutineSkip",
      "resolveRoutineSkipStorePath",
      "routineSkipStatus",
      "writeRoutineSkipStoreFile",
    ]);
  });

  it("normalizes missing or malformed store shapes", () => {
    assert.deepEqual(normalizeRoutineSkipStore(null), DEFAULT_ROUTINE_SKIP_STORE);
    assert.deepEqual(normalizeRoutineSkipStore({ version: 2, skips: "nope" }), {
      version: 1,
      skips: [],
    });
    assert.deepEqual(
      normalizeRoutineSkipStore({
        skips: [
          {
            routineId: "morning-brief",
            date: "2026-06-11",
            timezone: "Europe/Stockholm",
            createdAt: "2026-06-10T20:15:00.000Z",
            source: "telegram",
          },
          null,
        ],
      }),
      {
        version: 1,
        skips: [
          {
            routineId: "morning-brief",
            date: "2026-06-11",
            timezone: "Europe/Stockholm",
            createdAt: "2026-06-10T20:15:00.000Z",
            source: "telegram",
          },
        ],
      },
    );
  });

  it("adds a routine skip idempotently and detects only the matching date", () => {
    const first = addRoutineSkip(DEFAULT_ROUTINE_SKIP_STORE, {
      routineIds,
      routineId: "morning-brief",
      date: "2026-06-11",
      now: new Date("2026-06-10T20:15:00.000Z"),
    });

    assert.equal(first.result.added, true);
    assert.deepEqual(first.store.skips, [
      {
        routineId: "morning-brief",
        date: "2026-06-11",
        timezone: "Europe/Stockholm",
        source: "telegram",
        createdAt: "2026-06-10T20:15:00.000Z",
      },
    ]);
    assert.equal(isRoutineSkipped(first.store, "morning-brief", "2026-06-11"), true);
    assert.equal(isRoutineSkipped(first.store, "morning-brief", "2026-06-12"), false);
    assert.equal(isRoutineSkipped(first.store, "midday-check-in", "2026-06-11"), false);
    assert.equal(isRoutineSkipped(first.store, "morning-brief", "2026-06-11", "UTC"), false);

    const second = addRoutineSkip(first.store, {
      routineIds,
      routineId: "morning-brief",
      date: "2026-06-11",
      now: new Date("2026-06-10T22:15:00.000Z"),
    });

    assert.equal(second.result.added, false);
    assert.equal(second.store.skips.length, 1);
    assert.equal(second.store.skips[0].createdAt, "2026-06-10T20:15:00.000Z");
  });

  it("removes a routine skip and treats removing a missing skip as a no-op", () => {
    const added = addRoutineSkip(DEFAULT_ROUTINE_SKIP_STORE, {
      routineIds,
      routineId: "midday-check-in",
      date: "2026-06-11",
      source: "test",
      now: new Date("2026-06-10T20:15:00.000Z"),
    }).store;

    const removed = removeRoutineSkip(added, {
      routineIds,
      routineId: "midday-check-in",
      date: "2026-06-11",
    });

    assert.equal(removed.result.removed, true);
    assert.deepEqual(removed.store, { version: 1, skips: [] });
    assert.equal(isRoutineSkipped(removed.store, "midday-check-in", "2026-06-11"), false);

    const missing = removeRoutineSkip(removed.store, {
      routineIds,
      routineId: "midday-check-in",
      date: "2026-06-11",
    });

    assert.equal(missing.result.removed, false);
    assert.deepEqual(missing.store, removed.store);
  });

  it("rejects unknown routine ids and invalid dates", () => {
    assert.throws(
      () =>
        addRoutineSkip(DEFAULT_ROUTINE_SKIP_STORE, {
          routineIds,
          routineId: "sleep-window",
          date: "2026-06-11",
        }),
      /Unknown routine id: sleep-window/,
    );
    assert.throws(
      () =>
        removeRoutineSkip(DEFAULT_ROUTINE_SKIP_STORE, {
          routineIds,
          routineId: "morning-brief",
          date: "2026-02-31",
        }),
      /Invalid date: 2026-02-31/,
    );
    assert.throws(() => assertValidDate("2026-6-11"), /Invalid date: 2026-6-11/);
    assert.doesNotThrow(() => assertValidRoutineId("weekly-review", routineIds));
  });

  it("reports skippedToday for each configured routine id", () => {
    const withMorning = addRoutineSkip(DEFAULT_ROUTINE_SKIP_STORE, {
      routineIds,
      routineId: "morning-brief",
      date: "2026-06-11",
    }).store;
    const withWeekly = addRoutineSkip(withMorning, {
      routineIds,
      routineId: "weekly-review",
      date: "2026-06-11",
    }).store;
    const withYesterday = addRoutineSkip(withWeekly, {
      routineIds,
      routineId: "midday-check-in",
      date: "2026-06-10",
    }).store;

    assert.deepEqual(
      routineSkipStatus(withYesterday, {
        routineIds,
        now: new Date("2026-06-10T22:30:00.000Z"),
      }),
      [
        {
          routineId: "morning-brief",
          date: "2026-06-11",
          timezone: "Europe/Stockholm",
          skippedToday: true,
        },
        {
          routineId: "midday-check-in",
          date: "2026-06-11",
          timezone: "Europe/Stockholm",
          skippedToday: false,
        },
        {
          routineId: "workout-window",
          date: "2026-06-11",
          timezone: "Europe/Stockholm",
          skippedToday: false,
        },
        {
          routineId: "evening-review",
          date: "2026-06-11",
          timezone: "Europe/Stockholm",
          skippedToday: false,
        },
        {
          routineId: "weekly-review",
          date: "2026-06-11",
          timezone: "Europe/Stockholm",
          skippedToday: true,
        },
      ],
    );
  });

  it("handles Europe/Stockholm local date rollover", () => {
    assert.equal(localDateInTimeZone(new Date("2026-06-10T21:59:59.000Z")), "2026-06-10");
    assert.equal(localDateInTimeZone(new Date("2026-06-10T22:00:00.000Z")), "2026-06-11");
  });

  it("returns an empty store and warning for malformed JSON in non-strict reads", () => {
    const directory = mkdtempSync(join(tmpdir(), "routine-skips-"));
    const storePath = join(directory, "skips.json");
    writeFileSync(storePath, "{ nope");

    try {
      const issues = [];

      assert.deepEqual(readRoutineSkipStore(storePath, { issues }), { version: 1, skips: [] });
      assert.equal(issues.length, 1);
      assert.equal(issues[0].severity, "warn");
      assert.equal(issues[0].type, "malformed-json");
      assert.equal(issues[0].path, storePath);
      assert.match(issues[0].message, /malformed routine skip state/i);
      assert.throws(
        () => readRoutineSkipStore(storePath, { strict: true }),
        (error) =>
          error instanceof Error &&
          error.message.startsWith(`Malformed routine skip state at ${storePath}`),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes JSON and creates timestamped backups when a file exists", () => {
    const directory = mkdtempSync(join(tmpdir(), "routine-skips-"));
    const storePath = resolveRoutineSkipStorePath(directory);
    const existing = `${JSON.stringify({ version: 1, skips: [] }, null, 2)}\n`;
    const store = {
      version: 1,
      skips: [
        {
          routineId: "evening-review",
          date: "2026-06-11",
          timezone: "Europe/Stockholm",
          source: "telegram",
          createdAt: "2026-06-10T20:15:00.000Z",
        },
      ],
    };

    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, existing);

    try {
      const result = writeRoutineSkipStoreFile(storePath, store, {
        now: new Date("2026-06-10T09:15:30.000Z"),
      });
      const expectedBackupPath = `${storePath}.bak.20260610T091530000Z`;

      assert.equal(result.path, storePath);
      assert.equal(result.backupPath, expectedBackupPath);
      assert.equal(existsSync(expectedBackupPath), true);
      assert.equal(readFileSync(expectedBackupPath, "utf8"), existing);
      assert.equal(readFileSync(storePath, "utf8"), `${JSON.stringify(store, null, 2)}\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
