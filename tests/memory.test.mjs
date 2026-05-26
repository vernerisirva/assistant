import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildMemoryApprovalPrompt,
  forgetMemoryEntry,
  listMemoryEntries,
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
});
