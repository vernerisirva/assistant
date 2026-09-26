import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveFocusSessionPath, startFocusSession } from "../scripts/lib/focus.mjs";
import {
  PENDING_GUIDANCE,
  PENDING_PROVIDERS,
  collectPendingActions,
  comparePendingItems,
  formatPendingActions,
  redactPendingText,
} from "../scripts/lib/pending.mjs";
import { createWeeklyPlanStore } from "../scripts/lib/weekly-plan-store.mjs";
import { PENDING_COVERAGE, parsePendingArgs, runPendingCli } from "../scripts/pending.mjs";
import { runWeeklyPlanCli } from "../scripts/weekly-plan.mjs";

const schedules = JSON.parse(readFileSync("config/schedules.json", "utf8"));
const policy = JSON.parse(readFileSync("config/approval-policy.json", "utf8"));
// Saturday 26 Sep 2026, 09:00 in Stockholm.
const SATURDAY_0900 = new Date("2026-09-26T07:00:00.000Z");
const minutesAfter = (date, minutes) => new Date(date.getTime() + minutes * 60_000);

const fakeTodoist = () => ({
  getTasks: async () => [],
  getProjects: async () => [],
  getSections: async () => [],
  addTask: async () => {
    throw new Error("the pending view must never create tasks");
  },
});

function withState() {
  const stateDir = mkdtempSync(join(tmpdir(), "hilla-pending-"));
  return { stateDir, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

async function proposePlan(stateDir, { now = SATURDAY_0900, random = "abc123", input } = {}) {
  const argv = ["propose", "--reply", ...(input ? ["--input-json", JSON.stringify(input)] : [])];
  return runWeeklyPlanCli(argv, {
    stateDir,
    env: {},
    schedules,
    todoistClient: fakeTodoist(),
    now: () => now,
    random: () => random,
  });
}

function editPlan(stateDir, planId, edit) {
  const store = createWeeklyPlanStore({ stateDir });
  store.writePlan(edit(store.readPlan(planId)));
}

const focusBlock = { plannedMinutes: 45, context: "thesis", outcome: "Verify the final benchmark packet", firstAction: "Run the validation script", definitionOfDone: "Validation passes" };

function snapshot(dir) {
  const files = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        files[`${path}/`] = "dir";
        walk(path);
      } else {
        const stat = statSync(path);
        files[path] = `${stat.size}:${stat.mtimeMs}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
      }
    }
  };
  walk(dir);
  return files;
}

describe("pending actions", () => {
  it("says nothing is waiting when every source was checked and is empty", () => {
    const state = withState();
    try {
      const result = collectPendingActions({ stateDir: state.stateDir, now: SATURDAY_0900 });

      assert.deepEqual(result.items, []);
      assert.deepEqual(result.unavailable, []);
      assert.deepEqual(result.checked.map((entry) => entry.source), ["weekly-plan", "focus"]);
      assert.equal(formatPendingActions(result), "Nothing is waiting on you right now.");
    } finally {
      state.cleanup();
    }
  });

  it("lists a weekly plan awaiting review with its deadline and the three ways to respond", async () => {
    const state = withState();
    try {
      await proposePlan(state.stateDir);

      const result = collectPendingActions({ stateDir: state.stateDir, now: minutesAfter(SATURDAY_0900, 60), timezone: "Europe/Stockholm" });
      assert.equal(result.items.length, 1);
      const [item] = result.items;
      assert.equal(item.type, "weekly_plan");
      assert.equal(item.source, "weekly-plan");
      assert.equal(item.since, SATURDAY_0900.toISOString());
      assert.equal(item.deadline, "2026-09-26T19:00:00.000Z");
      assert.equal(
        formatPendingActions(result),
        [
          "You're waiting on 1 thing:",
          "",
          "1. Weekly plan for 28 Sep–4 Oct (v1)",
          "   Its tasks are created automatically at 21:00 on Saturday 26 Sep unless you change or cancel it.",
          "   Reply OK to create them now, ask for a change, or cancel it.",
        ].join("\n"),
      );
    } finally {
      state.cleanup();
    }
  });

  it("says when a plan's review window has already ended", async () => {
    const state = withState();
    try {
      await proposePlan(state.stateDir);

      const [item] = collectPendingActions({ stateDir: state.stateDir, now: minutesAfter(SATURDAY_0900, 13 * 60) }).items;
      assert.equal(item.detail, "Its review window ended at 21:00 on Saturday 26 Sep, so the tasks are created at the next apply check unless you cancel it now.");
      assert.equal(item.requiredAction, "You can still cancel it.");
    } finally {
      state.cleanup();
    }
  });

  it("lists a running focus session, and only notes an old one", () => {
    const state = withState();
    try {
      startFocusSession(resolveFocusSessionPath(state.stateDir), focusBlock, { now: SATURDAY_0900 });

      const active = collectPendingActions({ stateDir: state.stateDir, now: minutesAfter(SATURDAY_0900, 20) });
      assert.equal(
        formatPendingActions(active),
        [
          "You're waiting on 1 thing:",
          "",
          "1. Focus session: 45-minute thesis block, 25 min left (until 09:45)",
          "   Keep going, or say done to end it.",
        ].join("\n"),
      );

      const overtime = collectPendingActions({ stateDir: state.stateDir, now: minutesAfter(SATURDAY_0900, 60) });
      assert.equal(overtime.items[0].requiredAction, "Say done to end it, or keep going.");

      const stale = collectPendingActions({ stateDir: state.stateDir, now: minutesAfter(SATURDAY_0900, 24 * 60) });
      assert.deepEqual(stale.items, []);
      assert.match(formatPendingActions(stale), /^Nothing is waiting on you right now\.\n\nAn old focus session \(45-minute thesis block, started Sat 26 Sept?, 09:00\) was never ended\./);
    } finally {
      state.cleanup();
    }
  });

  it("orders several sources by deadline, the same way every time", async () => {
    const state = withState();
    try {
      await proposePlan(state.stateDir);
      await proposePlan(state.stateDir, { random: "def456", input: { weekStart: "2026-10-05" }, now: minutesAfter(SATURDAY_0900, 30) });
      startFocusSession(resolveFocusSessionPath(state.stateDir), focusBlock, { now: minutesAfter(SATURDAY_0900, 40) });

      const now = minutesAfter(SATURDAY_0900, 50);
      const first = collectPendingActions({ stateDir: state.stateDir, now });
      assert.deepEqual(
        first.items.map((item) => [item.type, item.deadline]),
        [
          ["focus_session", "2026-09-26T08:25:00.000Z"],
          ["weekly_plan", "2026-09-26T19:00:00.000Z"],
          ["weekly_plan", "2026-09-26T19:30:00.000Z"],
        ],
      );
      assert.match(formatPendingActions(first), /^You're waiting on 3 things:\n\n1\. Focus session: /);
      assert.equal(formatPendingActions(collectPendingActions({ stateDir: state.stateDir, now })), formatPendingActions(first));

      const shuffled = [...first.items].reverse().sort(comparePendingItems);
      assert.deepEqual(shuffled, first.items);
    } finally {
      state.cleanup();
    }
  });

  it("reports an unreadable source as unchecked instead of as nothing pending", async () => {
    const state = withState();
    try {
      await proposePlan(state.stateDir);
      const focusPath = resolveFocusSessionPath(state.stateDir);
      mkdirSync(join(state.stateDir, "focus"), { recursive: true });
      writeFileSync(focusPath, "{ not json");

      const result = collectPendingActions({ stateDir: state.stateDir, now: minutesAfter(SATURDAY_0900, 60) });
      assert.equal(result.items.length, 1, "the weekly plan is still shown");
      assert.deepEqual(result.unavailable.map((entry) => entry.source), ["focus"]);
      assert.match(formatPendingActions(result), /\n\nI couldn't check the focus session, so something there may be missing\.$/);

      rmSync(join(state.stateDir, "weekly-plan"), { recursive: true, force: true });
      const onlyFocusBroken = collectPendingActions({ stateDir: state.stateDir, now: SATURDAY_0900 });
      assert.equal(formatPendingActions(onlyFocusBroken), "I found nothing waiting on you in the weekly plan, but the focus session couldn't be checked.");
      assert.doesNotMatch(formatPendingActions(onlyFocusBroken), /Nothing is waiting on you/);
    } finally {
      state.cleanup();
    }
  });

  it("says so when every source fails, and when some plan files cannot be read", () => {
    const failing = PENDING_PROVIDERS.map((provider) => ({ ...provider, read: () => { throw new Error(`${provider.id} broke`); } }));
    const state = withState();
    try {
      const none = collectPendingActions({ stateDir: state.stateDir, now: SATURDAY_0900, providers: failing });
      assert.equal(formatPendingActions(none), "I couldn't check what's waiting on you: the weekly plan and the focus session couldn't be read.");

      mkdirSync(join(state.stateDir, "weekly-plan", "plans"), { recursive: true });
      writeFileSync(join(state.stateDir, "weekly-plan", "plans", "wp-2026-W40-bad000.json"), "garbage");
      const partial = collectPendingActions({ stateDir: state.stateDir, now: SATURDAY_0900 });
      assert.equal(partial.unavailable[0].partial, true);
      assert.equal(
        formatPendingActions(partial),
        "I found nothing waiting on you in the weekly plan and the focus session.\n\n1 weekly plan file(s) could not be read, so a plan may be missing.",
      );
    } finally {
      state.cleanup();
    }
  });

  it("notes a draft or an apply in progress without calling them pending", async () => {
    const state = withState();
    try {
      await assert.rejects(
        runWeeklyPlanCli(["propose", "--send"], {
          stateDir: state.stateDir,
          env: { TELEGRAM_USER_ID: "1" },
          schedules,
          todoistClient: fakeTodoist(),
          sendMessage: async () => {
            throw new Error("offline");
          },
          now: () => SATURDAY_0900,
          random: () => "abc123",
        }),
        /stays a draft/,
      );
      const draft = collectPendingActions({ stateDir: state.stateDir, now: SATURDAY_0900 });
      assert.deepEqual(draft.items, []);
      assert.equal(formatPendingActions(draft), "Nothing is waiting on you right now.\n\nA weekly plan draft for 28 Sep–4 Oct was never shown, so it will not apply.");

      editPlan(state.stateDir, "wp-2026-W40-abc123", (plan) => ({ ...plan, status: "applying" }));
      assert.deepEqual(collectPendingActions({ stateDir: state.stateDir, now: SATURDAY_0900 }).notes, ["The weekly plan for 28 Sep–4 Oct is being applied right now."]);

      editPlan(state.stateDir, "wp-2026-W40-abc123", (plan) => ({ ...plan, status: "applied" }));
      const applied = collectPendingActions({ stateDir: state.stateDir, now: SATURDAY_0900 });
      assert.deepEqual([applied.items, applied.notes], [[], []]);
    } finally {
      state.cleanup();
    }
  });

  it("never shows stored payloads, ids, or secrets", async () => {
    const state = withState();
    try {
      const proposal = await proposePlan(state.stateDir);
      editPlan(state.stateDir, proposal.planId, (plan) => ({
        ...plan,
        versions: plan.versions.map((version) => ({
          ...version,
          plan: {
            ...version.plan,
            operations: version.plan.operations.map((operation) => ({ ...operation, payload: { ...operation.payload, description: "token=sk-live-SECRET0123456789", project_id: "6Jf8VQXxpwv56VQ7" } })),
          },
        })),
      }));
      startFocusSession(
        resolveFocusSessionPath(state.stateDir),
        { ...focusBlock, context: "tdst-9f2c1a7e4b3d8c6a", outcome: "Private outcome text" },
        { now: SATURDAY_0900 },
      );

      const result = await runPendingCli([], {
        env: { TODOIST_API_TOKEN: "tdst-9f2c1a7e4b3d8c6a", TELEGRAM_USER_ID: "1029709001" },
        stateDir: state.stateDir,
        now: minutesAfter(SATURDAY_0900, 10),
      });
      const everything = JSON.stringify(result);
      for (const secret of ["SECRET0123456789", "6Jf8VQXxpwv56VQ7", "tdst-9f2c1a7e4b3d8c6a", proposal.planId, "1029709001", "opId", "Private outcome text", "Run the validation script"]) {
        assert.ok(!everything.includes(secret), secret);
      }
      assert.match(result.telegramText, /Focus session: 45-minute <redacted> block/);
      assert.equal(redactPendingText("my password: hunter2 and sk-or-abcdefghij"), "my <redacted> and <redacted>");
    } finally {
      state.cleanup();
    }
  });

  it("reads without changing anything, creating anything, or taking a lock", async () => {
    const state = withState();
    try {
      await proposePlan(state.stateDir);
      startFocusSession(resolveFocusSessionPath(state.stateDir), focusBlock, { now: SATURDAY_0900 });
      mkdirSync(join(state.stateDir, "memory"), { recursive: true });
      writeFileSync(join(state.stateDir, "memory", "preferences.json"), JSON.stringify({ version: 1, entries: [] }));
      const before = snapshot(state.stateDir);

      collectPendingActions({ stateDir: state.stateDir, now: minutesAfter(SATURDAY_0900, 10) });
      await runPendingCli([], { env: {}, stateDir: state.stateDir, now: minutesAfter(SATURDAY_0900, 11) });

      const after = snapshot(state.stateDir);
      assert.deepEqual(after, before);
      assert.ok(!Object.keys(after).some((path) => path.endsWith(".lock")), "no plan lock is taken");
    } finally {
      state.cleanup();
    }

    for (const path of ["scripts/lib/pending.mjs", "scripts/pending.mjs"]) {
      const source = readFileSync(path, "utf8");
      assert.doesNotMatch(source, /\b(writeFileSync|writePlan|mutatePlan|withPlanLock|rmSync|renameSync|mkdirSync|appendFileSync|startFocusSession|endFocusSession|updateFocusSession|rememberMemoryEntry)\b/, path);
      assert.doesNotMatch(source, /from "\.\/(lib\/)?(todoist|calendar|openrouter|live-cron|weekly-plan-apply)[^"]*"/, path);
      assert.doesNotMatch(source, /child_process|\bfetch\(/, path);
    }
  });

  it("never invents pending work from tasks, memory, feedback, or routines", async () => {
    const state = withState();
    try {
      for (const [dir, file, content] of [
        ["memory", "preferences.json", JSON.stringify({ version: 1, entries: [{ id: "m1", category: "health", key: "call_mom", value: "call mom weekly", sensitivity: "low", source: "telegram" }] })],
        ["feedback", "feedback.jsonl", `${JSON.stringify({ timestamp: "t", type: "improvement", message: "remind me to stretch", source: "telegram" })}\n`],
        ["routines", "skips.json", JSON.stringify({ version: 1, skips: [{ routineId: "workout-window", date: "2026-09-26" }] })],
      ]) {
        mkdirSync(join(state.stateDir, dir), { recursive: true });
        writeFileSync(join(state.stateDir, dir, file), content);
      }

      const result = await runPendingCli([], { env: {}, stateDir: state.stateDir, now: SATURDAY_0900 });
      assert.deepEqual(result.items, []);
      assert.equal(result.telegramText, "Nothing is waiting on you right now.");
      assert.doesNotMatch(result.telegramText, /mom|stretch|workout/i);
    } finally {
      state.cleanup();
    }
  });

  it("tells the agent the view is read-only and that chat approvals are not stored", async () => {
    const state = withState();
    try {
      const result = await runPendingCli([], { env: {}, stateDir: state.stateDir, now: SATURDAY_0900 });
      assert.equal(result.guidance, PENDING_GUIDANCE);
      assert.match(PENDING_GUIDANCE, /This view is read-only: approving, changing, or cancelling an item follows its own rules/);
      assert.match(PENDING_GUIDANCE, /Chat is not stored: if earlier in this conversation you sent an approval prompt or a clarifying question that blocks an action the user asked for, and it is still unanswered, add one line after telegramText starting with `Also from our chat:`/);
      assert.match(PENDING_GUIDANCE, /Never add any other question, or tasks, reminders, deadlines, or recommendations/);
      assert.equal(result.coverage, PENDING_COVERAGE);
    } finally {
      state.cleanup();
    }
  });

  it("parses only its output options", () => {
    assert.deepEqual(parsePendingArgs([]), { text: false });
    assert.deepEqual(parsePendingArgs(["--text"]), { text: true });
    assert.deepEqual(parsePendingArgs(["--json"]), { text: false });
    assert.throws(() => parsePendingArgs(["--approve"]), /Unknown pending option: --approve/);
  });

  it("matches the approval policy's read-only sources", () => {
    assert.equal(policy.pendingActions.readOnly, true);
    assert.deepEqual(policy.pendingActions.sources, PENDING_PROVIDERS.map((provider) => provider.id));
    assert.equal(policy.pendingActions.unreadableSourceIs, "reported-as-unchecked");
    for (const never of ["todoist-tasks", "recommendations", "inferred-obligations", "stored-payloads-or-ids", "secrets"]) {
      assert.ok(policy.pendingActions.neverIncludes.includes(never), never);
    }
  });
});
