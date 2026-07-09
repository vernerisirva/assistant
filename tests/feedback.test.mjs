import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addFeedbackEntry,
  isSensitiveFeedbackMessage,
  listFeedbackEntries,
} from "../scripts/lib/feedback.mjs";
import { parseFeedbackArgs, runFeedbackCli } from "../scripts/feedback.mjs";

function withFeedbackPath() {
  const directory = mkdtempSync(join(tmpdir(), "hilla-feedback-"));
  return {
    path: join(directory, ".openclaw/state/feedback/feedback.jsonl"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe("local feedback log", () => {
  it("appends useful feedback with only explicit fields", () => {
    const feedback = withFeedbackPath();
    try {
      const entry = addFeedbackEntry(feedback.path, {
        type: "useful",
        message: "That was useful",
      }, { now: "2026-07-09T08:00:00.000Z" });

      assert.deepEqual(entry, {
        timestamp: "2026-07-09T08:00:00.000Z",
        type: "useful",
        message: "That was useful",
        source: "telegram",
      });
      assert.deepEqual(listFeedbackEntries(feedback.path), [entry]);
      assert.deepEqual(JSON.parse(readFileSync(feedback.path, "utf8")), entry);
    } finally {
      feedback.cleanup();
    }
  });

  it("appends annoying feedback and improvement ideas in order", () => {
    const feedback = withFeedbackPath();
    try {
      addFeedbackEntry(feedback.path, {
        type: "annoying",
        message: "That was annoying",
      }, { now: "2026-07-09T08:00:00.000Z" });
      addFeedbackEntry(feedback.path, {
        type: "improvement",
        message: "Morning brief was too long",
      }, { now: "2026-07-09T08:01:00.000Z" });

      assert.deepEqual(listFeedbackEntries(feedback.path), [
        {
          timestamp: "2026-07-09T08:00:00.000Z",
          type: "annoying",
          message: "That was annoying",
          source: "telegram",
        },
        {
          timestamp: "2026-07-09T08:01:00.000Z",
          type: "improvement",
          message: "Morning brief was too long",
          source: "telegram",
        },
      ]);
    } finally {
      feedback.cleanup();
    }
  });

  it("refuses sensitive feedback before creating local state", () => {
    const feedback = withFeedbackPath();
    try {
      assert.equal(isSensitiveFeedbackMessage("Feedback: my bank password was exposed"), true);
      assert.throws(
        () => addFeedbackEntry(feedback.path, {
          type: "annoying",
          message: "Feedback: my bank password was exposed",
        }),
        /Sensitive feedback is not stored/i,
      );
      assert.equal(existsSync(feedback.path), false);
    } finally {
      feedback.cleanup();
    }
  });
});

describe("feedback CLI", () => {
  it("parses add and list commands", () => {
    assert.deepEqual(parseFeedbackArgs([
      "add",
      "--type",
      "useful",
      "--message",
      "That was useful",
    ]), {
      command: "add",
      options: {
        type: "useful",
        message: "That was useful",
      },
    });
    assert.deepEqual(parseFeedbackArgs(["list"]), {
      command: "list",
      options: {},
    });
  });

  it("captures explicit feedback locally without external side effects", async () => {
    const feedback = withFeedbackPath();
    try {
      const result = await runFeedbackCli([
        "add",
        "--type",
        "improvement",
        "--message",
        "Calendar planning should show gaps between meetings",
      ], {
        feedbackPath: feedback.path,
        now: "2026-07-09T08:00:00.000Z",
      });

      assert.deepEqual(result, {
        captured: true,
        entry: {
          timestamp: "2026-07-09T08:00:00.000Z",
          type: "improvement",
          message: "Calendar planning should show gaps between meetings",
          source: "telegram",
        },
      });
      assert.deepEqual(await runFeedbackCli(["list"], { feedbackPath: feedback.path }), {
        entries: [result.entry],
      });
      for (const key of ["email", "calendar", "todoist", "memory", "routines", "external"]) {
        assert.equal(key in result, false);
      }
    } finally {
      feedback.cleanup();
    }
  });

  it("keeps generated feedback state under ignored OpenClaw runtime paths", () => {
    const gitignore = readFileSync(".gitignore", "utf8");
    assert.match(gitignore, /^\.openclaw\/$/m);
  });
});
