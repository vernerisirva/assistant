import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  FOCUS_STALE_AFTER_MINUTES,
  FOCUS_STATE_FIELDS,
  classifyFocusRequest,
  endFocusSession,
  focusKinds,
  focusShapes,
  formatFocusStatus,
  isFocusSessionCurrent,
  isPersonalStateText,
  parseAvailableMinutes,
  readFocusSession,
  resolveFocusSessionPath,
  startFocusSession,
  updateFocusSession,
} from "../scripts/lib/focus.mjs";
import { FOCUS_GUIDE_PATH, formatFocusCliResult, parseFocusArgs, runFocusCli } from "../scripts/focus.mjs";

const START = "2026-09-26T10:00:00.000Z";
const at = (minutes) => new Date(Date.parse(START) + minutes * 60_000);
const thesisBlock = Object.freeze({
  plannedMinutes: 45,
  context: "thesis",
  outcome: "Verify the final benchmark packet",
  firstAction: "Run the frozen validation script",
  definitionOfDone: "Validation passes, or the first concrete blocker is documented",
  ignore: "Anything unrelated to benchmark verification",
});

function withStateDir() {
  const stateDir = mkdtempSync(join(tmpdir(), "hilla-focus-"));
  return {
    stateDir,
    path: resolveFocusSessionPath(stateDir),
    cleanup: () => rmSync(stateDir, { recursive: true, force: true }),
  };
}

describe("focus session state", () => {
  it("stores only the task facts of the block, privately", () => {
    const state = withStateDir();
    try {
      const result = startFocusSession(state.path, thesisBlock, { now: START });

      assert.equal(result.started, true);
      assert.equal(result.replaced, null);
      assert.equal(result.status, "active");
      assert.equal(result.minutesLeft, 45);
      assert.equal(result.endsAt, "2026-09-26T10:45:00.000Z");

      const stored = JSON.parse(readFileSync(state.path, "utf8"));
      assert.deepEqual(Object.keys(stored), ["version", ...FOCUS_STATE_FIELDS]);
      assert.deepEqual(stored, { version: 1, startedAt: START, ...thesisBlock });
      assert.equal(statSync(state.path).mode & 0o777, 0o600);
    } finally {
      state.cleanup();
    }
  });

  it("keeps the optional project and ignore fields empty rather than invented", () => {
    const state = withStateDir();
    try {
      const { context, ignore, ...required } = thesisBlock;
      const result = startFocusSession(state.path, required, { now: START });

      assert.equal(result.session.context, null);
      assert.equal(result.session.ignore, null);
    } finally {
      state.cleanup();
    }
  });

  it("moves from active to overtime to stale without anything rewriting the file", () => {
    const state = withStateDir();
    try {
      startFocusSession(state.path, thesisBlock, { now: START });
      const before = readFileSync(state.path, "utf8");

      const active = readFocusSession(state.path, { now: at(20) });
      assert.equal(active.status, "active");
      assert.equal(active.minutesLeft, 25);
      assert.equal(active.elapsedMinutes, 20);
      assert.equal(isFocusSessionCurrent(active), true);

      const overtime = readFocusSession(state.path, { now: at(50) });
      assert.equal(overtime.status, "overtime");
      assert.equal(overtime.minutesLeft, 0);
      assert.equal(isFocusSessionCurrent(overtime), true);

      const stale = readFocusSession(state.path, { now: at(45 + FOCUS_STALE_AFTER_MINUTES) });
      assert.equal(stale.status, "stale");
      assert.equal(isFocusSessionCurrent(stale), false);

      assert.equal(readFileSync(state.path, "utf8"), before);
    } finally {
      state.cleanup();
    }
  });

  it("reports no session when nothing is recorded", () => {
    const state = withStateDir();
    try {
      assert.deepEqual(readFocusSession(state.path, { now: START }), { status: "none", session: null });
      assert.equal(existsSync(dirname(state.path)), false);
    } finally {
      state.cleanup();
    }
  });

  it("refuses to silently replace a running session", () => {
    const state = withStateDir();
    try {
      startFocusSession(state.path, thesisBlock, { now: START });

      assert.throws(
        () => startFocusSession(state.path, { ...thesisBlock, context: "hilla" }, { now: at(10) }),
        (error) => error.code === "FOCUS_ACTIVE" && /45-minute thesis block/.test(error.message),
      );
      assert.equal(readFocusSession(state.path, { now: at(10) }).session.context, "thesis");

      const replaced = startFocusSession(state.path, { ...thesisBlock, context: "hilla" }, { now: at(10), replace: true });
      assert.equal(replaced.replaced, "active");
      assert.equal(replaced.session.context, "hilla");
      assert.equal(replaced.session.startedAt, at(10).toISOString());
    } finally {
      state.cleanup();
    }
  });

  it("replaces a stale session without asking, and says so", () => {
    const state = withStateDir();
    try {
      startFocusSession(state.path, thesisBlock, { now: START });
      const later = at(24 * 60);

      const result = startFocusSession(state.path, { ...thesisBlock, plannedMinutes: 30 }, { now: later });

      assert.equal(result.replaced, "stale");
      assert.equal(result.status, "active");
      assert.equal(result.session.plannedMinutes, 30);
    } finally {
      state.cleanup();
    }
  });

  it("updates only the running session and reports what changed", () => {
    const state = withStateDir();
    try {
      startFocusSession(state.path, thesisBlock, { now: START });

      const result = updateFocusSession(state.path, { plannedMinutes: "60", definitionOfDone: "The first blocker is written down" }, { now: at(40) });

      assert.deepEqual(result.changed, ["plannedMinutes", "definitionOfDone"]);
      assert.equal(result.session.plannedMinutes, 60);
      assert.equal(result.session.startedAt, START);
      assert.equal(result.minutesLeft, 20);
      assert.equal(result.session.outcome, thesisBlock.outcome);

      assert.throws(() => updateFocusSession(state.path, {}, { now: at(41) }), /Nothing to update/);
      assert.throws(
        () => updateFocusSession(state.path, { outcome: "Something else" }, { now: at(60 + FOCUS_STALE_AFTER_MINUTES) }),
        (error) => error.code === "FOCUS_NONE",
      );
    } finally {
      state.cleanup();
    }
  });

  it("will not update when no session is recorded", () => {
    const state = withStateDir();
    try {
      assert.throws(() => updateFocusSession(state.path, { plannedMinutes: 30 }, { now: START }), (error) => error.code === "FOCUS_NONE");
      assert.equal(existsSync(state.path), false);
    } finally {
      state.cleanup();
    }
  });

  it("clears the record on end, and ending twice is harmless", () => {
    const state = withStateDir();
    try {
      startFocusSession(state.path, thesisBlock, { now: START });

      const ended = endFocusSession(state.path, { now: at(30) });
      assert.equal(ended.ended, true);
      assert.equal(ended.status, "active");
      assert.equal(ended.elapsedMinutes, 30);
      assert.equal(ended.session.outcome, thesisBlock.outcome);
      assert.equal(existsSync(state.path), false);

      assert.deepEqual(endFocusSession(state.path, { now: at(31) }), { ended: false, status: "none", session: null });
    } finally {
      state.cleanup();
    }
  });

  it("never reports an unreadable record as no session, and end still clears it", () => {
    const state = withStateDir();
    try {
      mkdirSync(dirname(state.path), { recursive: true });
      writeFileSync(state.path, "{ not json");

      assert.throws(() => readFocusSession(state.path, { now: START }), (error) => error.code === "FOCUS_UNREADABLE");

      writeFileSync(state.path, JSON.stringify({ version: 1, startedAt: START, ...thesisBlock, mood: "tired" }));
      assert.throws(() => readFocusSession(state.path, { now: START }), /unexpected fields mood/);

      const ended = endFocusSession(state.path, { now: START });
      assert.equal(ended.ended, true);
      assert.equal(ended.status, "unreadable");
      assert.equal(existsSync(state.path), false);
    } finally {
      state.cleanup();
    }
  });

  it("keeps an unreadable record until the user asks for a new session", () => {
    const state = withStateDir();
    try {
      mkdirSync(dirname(state.path), { recursive: true });
      writeFileSync(state.path, "garbage");

      assert.throws(
        () => startFocusSession(state.path, thesisBlock, { now: START }),
        (error) => error.code === "FOCUS_UNREADABLE" && /Replace it only when the user asked for a new session/.test(error.message),
      );
      assert.equal(readFileSync(state.path, "utf8"), "garbage");

      const result = startFocusSession(state.path, thesisBlock, { now: START, replace: true });
      assert.equal(result.replaced, "unreadable");
      assert.equal(readFocusSession(state.path, { now: at(1) }).status, "active");
    } finally {
      state.cleanup();
    }
  });

  it("rejects fields that are not task facts", () => {
    const state = withStateDir();
    try {
      for (const extra of [{ mood: "anxious" }, { energy: "low" }, { productivityScore: 3 }, { label: "procrastinator" }]) {
        assert.throws(() => startFocusSession(state.path, { ...thesisBlock, ...extra }, { now: START }), /Focus sessions store only/);
      }
      assert.equal(existsSync(state.path), false);
    } finally {
      state.cleanup();
    }
  });

  it("refuses psychological labels and feelings in any field, but not task wording", () => {
    const state = withStateDir();
    try {
      for (const [field, value] of [
        ["outcome", "Finish the draft even though I'm so anxious about it"],
        ["ignore", "User seems overwhelmed today"],
        ["definitionOfDone", "Stop when I feel exhausted"],
        ["context", "ADHD work"],
        ["ignore", "My procrastinator habits"],
        ["firstAction", "Work on the lack of focus"],
      ]) {
        assert.throws(
          () => startFocusSession(state.path, { ...thesisBlock, [field]: value }, { now: START }),
          /describes a feeling or a personal trait/,
          `${field}: ${value}`,
        );
      }
      assert.equal(existsSync(state.path), false);

      for (const value of ["Run the stress test", "Fix lazy loading in the image grid", "Handle the panic in the parser", "Write the motivation section", "Compute confidence intervals"]) {
        assert.equal(isPersonalStateText(value), false, value);
      }
    } finally {
      state.cleanup();
    }
  });

  it("refuses energy, motivation, and productivity scores, but not task wording about them", () => {
    const state = withStateDir();
    try {
      for (const value of ["low energy", "I am motivated", "Productivity 2/5", "Energy level 3", "Rated my focus 4/10", "Feeling unproductive", "lack of motivation", "I am calm", "I feel okay", "I feel focused", "Feeling great today", "User seems fine"]) {
        assert.throws(
          () => startFocusSession(state.path, { ...thesisBlock, ignore: value }, { now: START }),
          /describes a feeling or a personal trait/,
          value,
        );
      }
      assert.equal(existsSync(state.path), false);

      for (const value of ["Write the energy-consumption section", "Improve CI productivity for 3 services", "Tune the motivation chapter", "Measure focus-group results", "Add a feelings wheel to the app", "I'm done when the tests pass"]) {
        assert.equal(isPersonalStateText(value), false, value);
      }
    } finally {
      state.cleanup();
    }
  });

  it("validates the block length and the required fields", () => {
    const state = withStateDir();
    try {
      for (const plannedMinutes of [4, 481, 45.5, "abc", undefined, null]) {
        assert.throws(() => startFocusSession(state.path, { ...thesisBlock, plannedMinutes }, { now: START }), /whole number of minutes from 5 to 480/);
      }
      for (const field of ["outcome", "firstAction", "definitionOfDone"]) {
        assert.throws(() => startFocusSession(state.path, { ...thesisBlock, [field]: "  " }, { now: START }), /is required/);
      }
      assert.throws(() => startFocusSession(state.path, { ...thesisBlock, outcome: "x".repeat(201) }, { now: START }), /at most 200 characters/);
      assert.throws(() => startFocusSession(state.path, { ...thesisBlock, context: "x".repeat(61) }, { now: START }), /at most 60 characters/);

      const collapsed = startFocusSession(state.path, { ...thesisBlock, outcome: "  Verify\n the   packet " }, { now: START });
      assert.equal(collapsed.session.outcome, "Verify the packet");
    } finally {
      state.cleanup();
    }
  });

  it("formats status for Telegram without a model", () => {
    const describe = (minutes) => readableState(minutes);

    assert.equal(formatFocusStatus({ status: "none", session: null }), "No focus session is running.");
    assert.equal(
      formatFocusStatus(describe(20)),
      [
        "Focus session: 45-minute thesis block, 25 min left (until 12:45).",
        "Outcome: Verify the final benchmark packet",
        "Done for this block when: Validation passes, or the first concrete blocker is documented",
        "Ignore: Anything unrelated to benchmark verification",
      ].join("\n"),
    );
    assert.match(formatFocusStatus(describe(50)), /^Focus session: 45-minute thesis block, planned time ended at 12:45\./);
    assert.match(formatFocusStatus(describe(24 * 60)), /^An old focus session \(45-minute thesis block, started Sat 26 Sept?, 12:00\) was never ended\. It no longer counts as running; ending it clears it\.$/);
  });
});

function readableState(minutes) {
  const state = withStateDir();
  try {
    startFocusSession(state.path, thesisBlock, { now: START });
    return readFocusSession(state.path, { now: at(minutes) });
  } finally {
    state.cleanup();
  }
}

describe("focus CLI", () => {
  it("parses commands and refuses unknown or incomplete input", () => {
    assert.deepEqual(parseFocusArgs(["status"]), { command: "status", fields: {}, replace: false, jsonStdin: false });
    assert.deepEqual(parseFocusArgs(["start", "--minutes", "30", "--outcome", "O", "--first-action", "F", "--done-when", "D", "--replace"]), {
      command: "start",
      fields: { plannedMinutes: "30", outcome: "O", firstAction: "F", definitionOfDone: "D" },
      replace: true,
      jsonStdin: false,
    });
    assert.deepEqual(parseFocusArgs(["start", "--json-stdin", "--replace"]), { command: "start", fields: {}, replace: true, jsonStdin: true });

    assert.throws(() => parseFocusArgs(["pause"]), /Unknown focus command: pause/);
    assert.throws(() => parseFocusArgs(["start", "--mood", "tired"]), /Unknown focus option: --mood/);
    assert.throws(() => parseFocusArgs(["start", "--minutes"]), /--minutes requires a value/);
    assert.throws(() => parseFocusArgs(["start", "--minutes", "30", "--outcome", "O", "--first-action", "F"]), /start requires --done-when/);
    assert.throws(() => parseFocusArgs(["start", "--json-stdin", "--outcome", "O"]), /Use either --json-stdin or field flags, not both/);
    assert.throws(() => parseFocusArgs(["status", "--minutes", "30"]), /status does not accept options/);
    assert.throws(() => parseFocusArgs(["status", "--json-stdin"]), /status does not accept options/);
    assert.throws(() => parseFocusArgs(["end", "--replace"]), /end does not accept options/);
    assert.throws(() => parseFocusArgs(["update", "--replace"]), /update does not accept --replace/);
  });

  it("stores task text from stdin exactly, with quotes, backticks, and dollar signs left literal", async () => {
    const state = withStateDir();
    const env = { ASSISTANT_TIMEZONE: "Europe/Stockholm" };
    const stdinOf = (value) => [Buffer.from(typeof value === "string" ? value : JSON.stringify(value))];
    try {
      const outcome = "Fix the `npm test` failure in $HOME's \"repo\" $(date)";
      const started = await runFocusCli(["start", "--json-stdin"], {
        env,
        stateDir: state.stateDir,
        now: START,
        stdin: stdinOf({ plannedMinutes: 30, outcome, firstAction: "Run `npm test` once", definitionOfDone: "The failure is reproduced" }),
      });
      assert.equal(started.session.outcome, outcome);
      assert.equal(JSON.parse(readFileSync(state.path, "utf8")).outcome, outcome);

      const updated = await runFocusCli(["update", "--json-stdin"], { env, stateDir: state.stateDir, now: at(10), stdin: stdinOf({ plannedMinutes: 45 }) });
      assert.deepEqual(updated.changed, ["plannedMinutes"]);
      assert.equal(updated.session.outcome, outcome);

      for (const [input, message] of [
        ["", /needs a JSON object on stdin/],
        ["{ nope", /focus session JSON is not valid/],
        ["[1, 2]", /must be an object/],
        [JSON.stringify({ mood: "calm" }), /Focus sessions store only/],
      ]) {
        await assert.rejects(runFocusCli(["update", "--json-stdin"], { env, stateDir: state.stateDir, now: at(11), stdin: stdinOf(input) }), message);
      }
    } finally {
      state.cleanup();
    }
  });

  it("runs a whole session through the CLI against the given state directory", async () => {
    const state = withStateDir();
    const env = { ASSISTANT_TIMEZONE: "Europe/Stockholm" };
    try {
      const started = await runFocusCli(
        ["start", "--minutes", "30", "--context", "testing", "--outcome", "Cover the focus CLI", "--first-action", "Write the start test", "--done-when", "The CLI tests pass"],
        { env, stateDir: state.stateDir, now: START },
      );
      assert.equal(started.status, "active");
      assert.match(started.text, /^Focus session: 30-minute testing block, 30 min left \(until 12:30\)\./);

      const status = await runFocusCli(["status"], { env, stateDir: state.stateDir, now: at(10) });
      assert.equal(status.minutesLeft, 20);

      const updated = await runFocusCli(["update", "--minutes", "40"], { env, stateDir: state.stateDir, now: at(25) });
      assert.deepEqual(updated.changed, ["plannedMinutes"]);

      const ended = await runFocusCli(["end"], { env, stateDir: state.stateDir, now: at(35) });
      assert.equal(ended.ended, true);
      assert.equal(ended.text, "Focus session ended and cleared.");

      const none = await runFocusCli(["status"], { env, stateDir: state.stateDir, now: at(36) });
      assert.equal(none.status, "none");
      assert.equal(none.text, "No focus session is running.");

      const again = await runFocusCli(["end"], { env, stateDir: state.stateDir, now: at(37) });
      assert.equal(again.text, "No focus session was running.");
    } finally {
      state.cleanup();
    }
  });

  it("serves the guide with the current status, and still serves it when the record is unreadable", async () => {
    const state = withStateDir();
    const env = { ASSISTANT_TIMEZONE: "Europe/Stockholm" };
    try {
      const none = await runFocusCli(["guide"], { env, stateDir: state.stateDir, now: START });
      assert.equal(none.status, "none");
      assert.match(none.text, /^Current focus status:\nNo focus session is running\.\n\n# Focus And Next Action\n/);
      assert.equal(formatFocusCliResult("guide", none), none.text);

      await runFocusCli(
        ["start", "--minutes", "30", "--outcome", "Cover the guide", "--first-action", "Write the test", "--done-when", "It passes"],
        { env, stateDir: state.stateDir, now: START },
      );
      const running = await runFocusCli(["guide"], { env, stateDir: state.stateDir, now: at(5) });
      assert.equal(running.status, "active");
      assert.match(running.text, /^Current focus status:\nFocus session: 30-minute block, 25 min left/);

      writeFileSync(state.path, "garbage");
      const unreadable = await runFocusCli(["guide"], { env, stateDir: state.stateDir, now: at(6) });
      assert.equal(unreadable.status, "unreadable");
      assert.match(unreadable.text, /could not be read/);
      assert.match(unreadable.text, /## Routing Examples/);
    } finally {
      state.cleanup();
    }
  });

  it("explains itself as local conversation state with no scheduling", async () => {
    const help = await runFocusCli(["help"]);

    assert.deepEqual(help.commands, ["guide", "status", "start", "update", "end"]);
    assert.match(help.safety, /never creates Todoist tasks, Calendar events, reminders, or messages/);
    assert.match(help.safety, /nothing is scheduled/);
  });

  it("cannot reach Todoist, Calendar, Telegram, or the network", () => {
    for (const path of ["scripts/lib/focus.mjs", "scripts/focus.mjs"]) {
      const source = readFileSync(path, "utf8");
      assert.doesNotMatch(source, /from "\.\/(lib\/)?(todoist|calendar|weekly-plan|routine|openrouter|quiet-ops)[^"]*"/, path);
      assert.doesNotMatch(source, /child_process|\bfetch\(|message send|cron/, path);
    }
  });
});

// The prompt's "Focus routing examples" and the recognizer must agree, so each
// example is listed once here: message, qualifier, label, and expected result.
const focusRoutingExamples = [
  ["I have 45 minutes, what should I do?", "", "next action fitted to 45 minutes", {}, { kind: "next_action", availableMinutes: 45 }],
  ["What should I work on now?", "", "next action", {}, { kind: "next_action", availableMinutes: null }],
  ["I have 90 minutes before my next meeting", "", "next action fitted to 90 minutes", {}, { kind: "next_action", availableMinutes: 90 }],
  ["Start a 45-minute focus session on my thesis", "", "focus session setup", {}, { kind: "session_start", availableMinutes: 45 }],
  ["Help me focus for the next 45 minutes", "", "focus session setup", {}, { kind: "session_start", availableMinutes: 45 }],
  ["I'm stuck", "during a session", "next step inside the session", { focusActive: true }, { kind: "session_check_in", availableMinutes: null }],
  ["I'm stuck", "with no session", "one question about what they are working on", {}, { kind: "next_action", availableMinutes: null }],
  ["What next?", "during a session", "next step inside the session", { focusActive: true }, { kind: "session_check_in", availableMinutes: null }],
  ["I'm working on my thesis", "", "session context, not stored", {}, { kind: "project_context", availableMinutes: null }],
  ["End focus session", "", "end the session, then offer a debrief once", {}, { kind: "session_end", availableMinutes: null }],
  ["What's due today?", "", "Todoist question, not a recommendation", {}, null],
  ["What is a focus session?", "", "factual question", {}, null],
];

describe("focus routing examples", () => {
  const guide = readFileSync(FOCUS_GUIDE_PATH, "utf8");

  it("keeps the guide's routing examples and this table in step", () => {
    const from = guide.indexOf("## Routing Examples");
    assert.ok(from >= 0, "missing Routing Examples");
    const examples = guide.slice(from).split("\n").filter((line) => line.startsWith("- `"));

    assert.deepEqual(
      examples,
      focusRoutingExamples.map(([message, qualifier, label]) => `- \`${message}\`${qualifier ? ` ${qualifier}` : ""} → ${label}`),
    );
  });

  it("classifies every prompt routing example the way the prompt says", () => {
    for (const [message, , , options, expected] of focusRoutingExamples) {
      const result = classifyFocusRequest(message, options);
      assert.deepEqual(result && { kind: result.kind, availableMinutes: result.availableMinutes }, expected, message);
    }
  });
});

describe("focus request recognition", () => {
  const kindOf = (message, options) => classifyFocusRequest(message, options)?.kind ?? null;

  it("recognizes next-action requests and the time they state", () => {
    for (const [message, minutes] of [
      ["I have 45 minutes, what should I do?", 45],
      ["What should I work on now?", null],
      ["I have 90 minutes before my next meeting", 90],
      ["I have an hour for my thesis", 60],
      ["I need to get something useful done before lunch", null],
      ["I have 30 minutes left today", 30],
      ["What's the best use of the next hour?", 60],
      ["What should I prioritize today?", null],
    ]) {
      const result = classifyFocusRequest(message);
      assert.equal(result?.kind, focusKinds.nextAction, message);
      assert.equal(result.availableMinutes, minutes, message);
      assert.equal(result.writes, "nothing", message);
    }
  });

  it("recognizes starting a session and reads the block length when given", () => {
    for (const [message, minutes] of [
      ["Start a focus session", null],
      ["Start a 45-minute focus session on my thesis", 45],
      ["Help me focus for the next 45 minutes", 45],
      ["Help me focus on my thesis", null],
      ["Use the 45 minutes as a focus session", 45],
      ["Let's do a focus block", null],
    ]) {
      const result = classifyFocusRequest(message);
      assert.equal(result?.kind, focusKinds.sessionStart, message);
      assert.equal(result.availableMinutes, minutes, message);
      assert.equal(result.writes, "focus-state", message);
    }
  });

  it("uses the running session for in-session messages", () => {
    for (const [message, trigger] of [
      ["I'm stuck", "stuck"],
      ["This is taking longer than expected", "overrun"],
      ["I found another bug", "scope"],
      ["I'm getting distracted", "distracted"],
      ["What next?", "next"],
      ["I finished step one", "progress"],
      ["I finished that", "progress"],
      ["How much time do I have left?", "time"],
      ["Help me focus", "distracted"],
    ]) {
      const result = classifyFocusRequest(message, { focusActive: true });
      assert.equal(result?.kind, focusKinds.sessionCheckIn, message);
      assert.equal(result.trigger, trigger, message);
      assert.equal(result.usesFocusSession, true, message);
      assert.equal(result.writes, "nothing", message);
    }
  });

  it("does not fabricate a session when none is running", () => {
    for (const message of ["I'm stuck", "What next?", "I'm stuck, what should I do next?"]) {
      const result = classifyFocusRequest(message);
      assert.equal(result.kind, focusKinds.nextAction, message);
      assert.equal(result.usesFocusSession, false, message);
      assert.match(result.reason, /No focus session is running: do not invent one/, message);
    }

    for (const message of ["This is taking longer than expected", "I found another bug", "I finished step one", "Done", "I finished it", "How much time do I have left?"]) {
      assert.equal(kindOf(message), null, message);
    }
  });

  it("recognizes ending a session", () => {
    assert.equal(kindOf("End focus session"), focusKinds.sessionEnd);
    assert.equal(kindOf("Stop the focus session"), focusKinds.sessionEnd);
    for (const message of ["Done", "I finished it", "Let's stop here", "I'm done"]) {
      assert.equal(kindOf(message, { focusActive: true }), focusKinds.sessionEnd, message);
    }
  });

  it("does not read a negated request as a start or an end", () => {
    for (const message of ["Don't end the focus session", "No need to end the focus session yet", "Do not stop the focus session"]) {
      assert.notEqual(kindOf(message, { focusActive: true }), focusKinds.sessionEnd, message);
    }
    for (const message of ["I don't want to start a focus session", "Let's not do a focus session", "I'd rather not start a focus block"]) {
      assert.notEqual(kindOf(message), focusKinds.sessionStart, message);
    }
  });

  it("recognizes a project for this session without storing it", () => {
    for (const [message, project] of [
      ["I'm working on my thesis", "thesis"],
      ["I'm working on my MSc now", "msc"],
      ["Focus on Byggdagbok", "byggdagbok"],
      ["This session is for Hilla development", "hilla development"],
      ["Switch to thesis mode", "thesis"],
      ["I'm working on the thesis for the next two hours", "thesis"],
    ]) {
      const result = classifyFocusRequest(message);
      assert.equal(result?.kind, focusKinds.projectContext, message);
      assert.equal(result.project, project, message);
      assert.equal(result.writes, "nothing", message);
      assert.match(result.reason, /not stored and does not become a preference/, message);
    }
  });

  it("does not take over ordinary questions, other domains, or coaching", () => {
    for (const message of [
      "What Todoist tasks are due today?",
      "What is a focus session?",
      "How long should focus sessions be?",
      "What should I do about my knee pain?",
      "What should I do in Stockholm this weekend?",
      "I have 45 minutes of cardio planned",
      "I have 3 tasks due today",
      "I have 30 minutes, what should I eat?",
      "Let's focus on the next shot",
      "Turn on focus mode",
      "I'm working on it",
      "I'm working on my thesis, remember that",
      "Help me focus",
      "I'm procrastinating",
      "Debrief this focus session",
    ]) {
      assert.equal(kindOf(message), null, message);
    }
  });

  it("keeps recommendations small: one primary pick, at most one question", () => {
    assert.equal(focusShapes.next_action.maxQuestions, 1);
    assert.deepEqual(focusShapes.next_action.steps.slice(0, 3), [
      "one primary recommendation with a one-line reason",
      "optional fallback",
      "one thing not worth starting now",
    ]);
    assert.deepEqual(focusShapes.session_start.steps.slice(1), ["Outcome", "Start with", "Done for this block when", "Ignore"]);
    assert.equal(focusShapes.project_context.maxQuestions, 0);
    for (const kind of Object.values(focusKinds)) assert.ok(focusShapes[kind].maxQuestions <= 1, kind);
  });

  it("reads common ways of saying how much time there is", () => {
    for (const [phrase, minutes] of [
      ["I have 45 minutes", 45],
      ["I have an hour", 60],
      ["I have half an hour", 30],
      ["I have 1.5 hours", 90],
      ["I have 90 mins", 90],
      ["I have 2h", 120],
      ["a 45-minute block", 45],
      ["I have two hours", 120],
      ["I have an hour and a half", 90],
      ["no time given", null],
    ]) {
      assert.equal(parseAvailableMinutes(phrase), minutes, phrase);
    }
  });
});
