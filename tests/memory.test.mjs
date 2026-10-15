import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildMemoryApprovalPrompt,
  forgetMemoryEntry,
  listMemoryEntries,
  memoryCategories,
  memoryRequiresApproval,
  rememberMemoryEntry,
} from "../scripts/lib/memory.mjs";
import { parseMemoryArgs, runMemoryCli } from "../scripts/memory.mjs";

function withMemoryPath() {
  const dir = mkdtempSync(join(tmpdir(), "assistant-memory-"));
  return {
    path: join(dir, "preferences.json"),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("memory store", () => {
  it("remembers and lists a low-risk preference", () => {
    const memory = withMemoryPath();
    try {
      const entry = rememberMemoryEntry(memory.path, {
        category: "food",
        key: "breakfast",
        value: "likes Greek yogurt with berries",
        source: "telegram",
      }, {
        now: "2026-05-26T08:00:00.000Z",
        idGenerator: () => "mem-1",
      });

      assert.deepEqual(entry, {
        id: "mem-1",
        category: "food",
        key: "breakfast",
        value: "likes Greek yogurt with berries",
        sensitivity: "low",
        source: "telegram",
        createdAt: "2026-05-26T08:00:00.000Z",
        updatedAt: "2026-05-26T08:00:00.000Z",
      });
      assert.deepEqual(listMemoryEntries(memory.path), [entry]);
    } finally {
      memory.cleanup();
    }
  });

  it("updates an existing category and key instead of duplicating it", () => {
    const memory = withMemoryPath();
    try {
      rememberMemoryEntry(memory.path, {
        category: "tone",
        key: "telegram",
        value: "concise",
      }, {
        now: "2026-05-26T08:00:00.000Z",
        idGenerator: () => "mem-1",
      });
      const updated = rememberMemoryEntry(memory.path, {
        category: "tone",
        key: "telegram",
        value: "warm and concise",
      }, {
        now: "2026-05-26T09:00:00.000Z",
        idGenerator: () => "mem-2",
      });

      assert.equal(updated.id, "mem-1");
      assert.equal(updated.value, "warm and concise");
      assert.equal(updated.createdAt, "2026-05-26T08:00:00.000Z");
      assert.equal(updated.updatedAt, "2026-05-26T09:00:00.000Z");
      assert.equal(listMemoryEntries(memory.path).length, 1);
    } finally {
      memory.cleanup();
    }
  });

  it("forgets a memory by id", () => {
    const memory = withMemoryPath();
    try {
      rememberMemoryEntry(memory.path, {
        category: "golf",
        key: "tee-time",
        value: "prefers morning tee times",
      }, {
        idGenerator: () => "mem-1",
      });

      const result = forgetMemoryEntry(memory.path, "mem-1");

      assert.equal(result.forgotten, true);
      assert.equal(result.entry.id, "mem-1");
      assert.deepEqual(listMemoryEntries(memory.path), []);
    } finally {
      memory.cleanup();
    }
  });

  it("requires approval for sensitive memory", () => {
    const input = {
      category: "health",
      key: "injury",
      value: "knee pain after running",
      sensitivity: "sensitive",
    };

    assert.equal(memoryRequiresApproval(input), true);
    assert.deepEqual(buildMemoryApprovalPrompt(input), {
      agent: "personal",
      action: "remember-sensitive-preference",
      target: "health/injury",
      expectedEffect: "Store this sensitive memory locally for future personalization.",
      risk: "Sensitive personal information may be reused in future assistant responses until forgotten.",
      approvalOptions: [
        "Reply approve, ok, that's ok, yes do it, or go ahead to remember it.",
        "Reply no, stop, or cancel to avoid storing it.",
      ],
    });
  });
});

describe("memory store durability", () => {
  const memoryModuleUrl = new URL("../scripts/lib/memory.mjs", import.meta.url).href;
  const unixOnly = { skip: process.platform === "win32" };

  it("keeps the previous memories when a write fails part-way", unixOnly, () => {
    const memory = withMemoryPath();
    try {
      rememberMemoryEntry(memory.path, { category: "food", key: "breakfast", value: "yogurt", source: "telegram" });
      const before = readFileSync(memory.path, "utf8");
      const writer = join(dirname(memory.path), "write-big.mjs");
      writeFileSync(
        writer,
        [
          `import { rememberMemoryEntry } from ${JSON.stringify(memoryModuleUrl)};`,
          `rememberMemoryEntry(process.argv[2], { category: "general", key: "big", value: "x".repeat(20000), source: "test" });`,
        ].join("\n"),
      );
      // A file-size limit makes the write fail part-way, as a full disk would.
      const result = spawnSync("/bin/sh", ["-c", 'ulimit -f 4 && exec "$0" "$@"', process.execPath, writer, memory.path], {
        encoding: "utf8",
      });

      assert.notEqual(result.status, 0, "the oversized write must fail");
      assert.equal(readFileSync(memory.path, "utf8"), before);
      assert.deepEqual(listMemoryEntries(memory.path).map((entry) => entry.key), ["breakfast"]);
    } finally {
      memory.cleanup();
    }
  });

  it("keeps every change when several processes remember and forget at once", async () => {
    const memory = withMemoryPath();
    try {
      const doomed = rememberMemoryEntry(memory.path, { category: "general", key: "to-forget", value: "x", source: "test" });
      const dir = dirname(memory.path);
      const writer = join(dir, "writer.mjs");
      writeFileSync(
        writer,
        [
          `import { existsSync, writeFileSync } from "node:fs";`,
          `import { forgetMemoryEntry, rememberMemoryEntry } from ${JSON.stringify(memoryModuleUrl)};`,
          `const [path, dir, name, forgetId] = process.argv.slice(2);`,
          `writeFileSync(dir + "/ready-" + name, "");`,
          `while (!existsSync(dir + "/go")) await new Promise((resolve) => setTimeout(resolve, 2));`,
          `if (forgetId) forgetMemoryEntry(path, forgetId);`,
          `else rememberMemoryEntry(path, { category: "general", key: name, value: name, source: "test" });`,
        ].join("\n"),
      );
      const names = Array.from({ length: 10 }, (_, index) => `k${index}`);
      const jobs = [...names.map((name) => [name, ""]), ["forget", doomed.id]];
      const children = jobs.map(([name, forgetId]) => spawn(process.execPath, [writer, memory.path, dir, name, forgetId], { stdio: "ignore" }));
      const exits = children.map((child) => new Promise((resolve) => child.on("exit", resolve)));
      // Release every writer at the same moment, once all of them are running.
      const deadline = Date.now() + 20_000;
      while (readdirSync(dir).filter((file) => file.startsWith("ready-")).length < children.length) {
        assert.ok(Date.now() < deadline, "the writers did not start");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      writeFileSync(join(dir, "go"), "");

      assert.deepEqual(await Promise.all(exits), children.map(() => 0));
      assert.deepEqual(listMemoryEntries(memory.path).map((entry) => entry.key).sort(), [...names].sort());
    } finally {
      memory.cleanup();
    }
  });

  it("keeps the memory file readable only by its owner", unixOnly, () => {
    const memory = withMemoryPath();
    try {
      rememberMemoryEntry(memory.path, { category: "food", key: "breakfast", value: "yogurt", source: "telegram" });
      assert.equal(statSync(memory.path).mode & 0o777, 0o600);
    } finally {
      memory.cleanup();
    }
  });

  it("takes over a lock left behind by a writer that died", () => {
    const memory = withMemoryPath();
    try {
      const lock = `${memory.path}.lock`;
      writeFileSync(lock, JSON.stringify({ pid: 999999, token: "dead" }));
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);

      rememberMemoryEntry(memory.path, { category: "food", key: "breakfast", value: "yogurt", source: "telegram" });

      assert.equal(existsSync(lock), false);
      assert.deepEqual(listMemoryEntries(memory.path).map((entry) => entry.key), ["breakfast"]);
    } finally {
      memory.cleanup();
    }
  });
});

describe("memory CLI", () => {
  it("parses remember commands", () => {
    assert.deepEqual(parseMemoryArgs([
      "remember",
      "--category",
      "food",
      "--key",
      "breakfast",
      "--value",
      "likes Greek yogurt",
      "--source",
      "telegram",
    ]), {
      command: "remember",
      options: {
        category: "food",
        key: "breakfast",
        value: "likes Greek yogurt",
        source: "telegram",
      },
      dryRun: false,
      approved: false,
    });
  });

  it("runs list, remember, and forget commands against the configured path", async () => {
    const memory = withMemoryPath();
    try {
      const remembered = await runMemoryCli([
        "remember",
        "--category",
        "food",
        "--key",
        "breakfast",
        "--value",
        "likes Greek yogurt",
      ], {
        memoryPath: memory.path,
        now: "2026-05-26T08:00:00.000Z",
        idGenerator: () => "mem-1",
      });

      assert.equal(remembered.entry.id, "mem-1");
      assert.equal((await runMemoryCli(["list"], { memoryPath: memory.path })).entries.length, 1);
      assert.equal((await runMemoryCli(["forget", "--id", "mem-1"], { memoryPath: memory.path })).forgotten, true);
      assert.deepEqual(await runMemoryCli(["list"], { memoryPath: memory.path }), { entries: [] });
    } finally {
      memory.cleanup();
    }
  });

  it("blocks sensitive writes until approved", async () => {
    const memory = withMemoryPath();
    try {
      await assert.rejects(
        () => runMemoryCli([
          "remember",
          "--category",
          "health",
          "--key",
          "injury",
          "--value",
          "knee pain",
          "--sensitivity",
          "sensitive",
        ], { memoryPath: memory.path }),
        /Sensitive memory requires approval/,
      );
    } finally {
      memory.cleanup();
    }
  });

  it("stores coaching playbook entries under their own categories with the normal command", async () => {
    const memory = withMemoryPath();
    try {
      for (const [category, key, value] of [
        ["golf", "cue-word", "commit"],
        ["work", "deep-work-block", "45 minutes"],
        ["sleep", "target-wake-time", "06:30"],
      ]) {
        const result = await runMemoryCli(
          ["remember", "--category", category, "--key", key, "--value", value, "--source", "telegram"],
          { memoryPath: memory.path, now: "2026-09-26T08:00:00.000Z" },
        );
        assert.equal(result.entry.sensitivity, "low");
      }

      const listed = (await runMemoryCli(["list", "--category", "sleep"], { memoryPath: memory.path })).entries;
      assert.deepEqual(listed.map((entry) => `${entry.category}/${entry.key}: ${entry.value}`), ["sleep/target-wake-time: 06:30"]);
    } finally {
      memory.cleanup();
    }
  });

  it("keeps a sensitive coaching detail behind approval in the new categories too", async () => {
    const memory = withMemoryPath();
    try {
      await assert.rejects(
        () => runMemoryCli(
          ["remember", "--category", "sleep", "--key", "medication", "--value", "sleeping pill at 22:00", "--sensitivity", "sensitive"],
          { memoryPath: memory.path },
        ),
        /Sensitive memory requires approval/,
      );
      assert.deepEqual(await runMemoryCli(["list"], { memoryPath: memory.path }), { entries: [] });
    } finally {
      memory.cleanup();
    }
  });

  it("lists the same categories in help as the store accepts", async () => {
    assert.deepEqual((await runMemoryCli(["help"])).categories, memoryCategories);
  });
});
