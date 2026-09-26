import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listMemoryEntries, rememberMemoryEntry } from "../scripts/lib/memory.mjs";
import { runMemoryCli } from "../scripts/memory.mjs";
import {
  PLAYBOOK_LIMITS,
  classifyPlaybookRequest,
  findPlaybook,
  formatPlaybook,
  formatPlaybookList,
  isExplicitPlaybookConsent,
  isProfileText,
  listCoachingSettings,
  listPlaybooks,
  playbookKinds,
  savePlaybook,
  updatePlaybook,
} from "../scripts/lib/playbooks.mjs";
import { PLAYBOOK_GUIDE_PATH, formatPlaybookCliResult, parsePlaybookArgs, runPlaybookCli } from "../scripts/playbook.mjs";

const NOW = "2026-09-26T10:00:00.000Z";
const badShotReset = Object.freeze({
  domain: "golf",
  name: "Bad-shot reset",
  trigger: "After a poor shot",
  steps: ["Walk away from the shot", "Slow exhale", "Drop your shoulders", "Say: next shot", "Assess the lie and pick the target"],
  cue: "next shot",
});
const preRound = Object.freeze({
  domain: "golf",
  name: "Pre-round routine",
  trigger: "Before the round",
  steps: ["Visualize the first tee shot", "Pick the target", "Commit"],
  cue: "commit",
});

function withMemory() {
  const dir = mkdtempSync(join(tmpdir(), "hilla-playbooks-"));
  let ids = 0;
  return {
    path: join(dir, "preferences.json"),
    idGenerator: () => `mem-${(ids += 1)}`,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function save(memory, playbook, replyText = "Save that as my routine", options = {}) {
  return savePlaybook(memory.path, playbook, { replyText, now: NOW, idGenerator: memory.idGenerator, ...options });
}

describe("playbook store", () => {
  it("saves an explicitly requested playbook as one ordinary memory entry", () => {
    const memory = withMemory();
    try {
      const result = save(memory, badShotReset, "Save that as my bad-shot reset");

      assert.equal(result.status, "saved");
      assert.equal(result.replaced, false);
      const entries = listMemoryEntries(memory.path);
      assert.equal(entries.length, 1);
      assert.deepEqual(entries[0], {
        id: "mem-1",
        category: "golf",
        key: "bad-shot-reset",
        value: "After a poor shot: Walk away from the shot; Slow exhale; Drop your shoulders; Say: next shot; Assess the lie and pick the target. Cue: next shot.",
        sensitivity: "low",
        source: "telegram",
        createdAt: NOW,
        updatedAt: NOW,
        playbook: {
          name: "Bad-shot reset",
          trigger: "After a poor shot",
          steps: [...badShotReset.steps],
          cue: "next shot",
        },
      });
    } finally {
      memory.cleanup();
    }
  });

  it("never saves without the user's explicit words", () => {
    const memory = withMemory();
    try {
      for (const replyText of ["That reset worked really well today", "", undefined, "Maybe save it later", "No, don't save it", "Should I save it?", "Not now"]) {
        const result = savePlaybook(memory.path, badShotReset, { replyText, now: NOW, idGenerator: memory.idGenerator });
        assert.equal(result.status, "not_saved", String(replyText));
        assert.match(result.reason, /Offer once and save only after a clear yes/);
      }
      assert.equal(existsSync(memory.path), false);
    } finally {
      memory.cleanup();
    }
  });

  it("refuses traits, feelings, judgements, and health details, even when asked", () => {
    const memory = withMemory();
    try {
      for (const [change, message] of [
        [{ trigger: "When I feel nervous" }, /states a feeling, trait, or judgement/],
        [{ steps: ["I always choke, so slow down"] }, /states a feeling, trait, or judgement/],
        [{ steps: ["Remind myself I lack confidence"] }, /states a feeling, trait, or judgement/],
        [{ trigger: "User is anxious before meetings" }, /states a feeling, trait, or judgement/],
        [{ name: "My weakness under pressure" }, /states a feeling, trait, or judgement/],
        [{ domain: "sleep", name: "Wind-down", trigger: "At 22:00", steps: ["Take my sleeping pills"] }, /sensitive-memory approval flow/],
      ]) {
        assert.throws(() => save(memory, { ...badShotReset, ...change }, "Remember this exactly"), message, JSON.stringify(change));
      }
      assert.equal(existsSync(memory.path), false);
      assert.equal(isProfileText("Before presentations: review the opening sentence for two minutes"), false);
    } finally {
      memory.cleanup();
    }
  });

  it("sends conditions, symptoms, treatments, and medicines to the sensitive-memory flow instead", () => {
    const memory = withMemory();
    try {
      for (const change of [
        { name: "Asthma routine", trigger: "When symptoms start", steps: ["Use my inhaler"] },
        { name: "Migraine routine", trigger: "At the first sign", steps: ["Dim the lights"] },
        { name: "Evening", trigger: "After dinner", steps: ["Take medication"] },
        { name: "Diabetes check", trigger: "Before the round", steps: ["Check blood sugar"] },
        { name: "Knee", trigger: "If my knee pain flares", steps: ["Stop and stretch"] },
        { name: "Low days", trigger: "When depression hits", steps: ["Call a friend"] },
        { name: "Physio", trigger: "Every morning", steps: ["Do the physio exercises"] },
      ]) {
        assert.throws(
          () => save(memory, { ...badShotReset, domain: "general", cue: undefined, ...change }, "Remember this as my routine"),
          /includes a health detail\. Health details are sensitive memory and go through the sensitive-memory approval flow/,
          change.name,
        );
      }
      assert.equal(existsSync(memory.path), false);

      // Ordinary golf and work language is not a health detail.
      const ok = save(memory, { domain: "work", name: "Shutdown", trigger: "At 17:30", steps: ["Write tomorrow's first task", "Close the laptop"] });
      assert.equal(ok.status, "saved");
      const windDown = save(memory, { domain: "sleep", name: "Wind-down", trigger: "At 22:15", steps: ["Put the phone and tablet away", "Read ten pages"] });
      assert.equal(windDown.status, "saved");
    } finally {
      memory.cleanup();
    }
  });

  it("keeps playbooks short and in the four domains", () => {
    const memory = withMemory();
    try {
      for (const [change, message] of [
        [{ domain: "health" }, /domain must be one of: golf, work, sleep, general/],
        [{ steps: [] }, /at least one step/],
        [{ steps: Array.from({ length: PLAYBOOK_LIMITS.maxSteps + 1 }, (_, index) => `Step ${index}`) }, /at most 8 steps/],
        [{ steps: ["x".repeat(PLAYBOOK_LIMITS.step + 1)] }, /step must be at most 120 characters/],
        [{ name: " " }, /name is required/],
        [{ trigger: undefined }, /trigger is required/],
        [{ mood: "calm" }, /A playbook has only name, domain, trigger, steps, cue; not mood/],
      ]) {
        assert.throws(() => save(memory, { ...badShotReset, ...change }), message, JSON.stringify(change));
      }
      assert.equal(existsSync(memory.path), false);
    } finally {
      memory.cleanup();
    }
  });

  it("does not overwrite a saved playbook, or a routine saved as plain text, unless asked to replace it", () => {
    const memory = withMemory();
    try {
      save(memory, badShotReset);
      assert.throws(() => save(memory, { ...badShotReset, steps: ["Exhale"] }), (error) => error.code === "PLAYBOOK_EXISTS");

      // A request to save is not a request to replace what is already saved.
      const before = readFileSync(memory.path, "utf8");
      const notAsked = save(memory, { ...badShotReset, steps: ["Exhale"] }, "Save that as my bad-shot reset", { replace: true });
      assert.equal(notAsked.status, "not_saved");
      assert.match(notAsked.reason, /does not ask to replace it/);
      assert.equal(readFileSync(memory.path, "utf8"), before);

      const replaced = save(memory, { ...badShotReset, steps: ["Exhale", "Next shot"] }, "Replace my bad-shot reset with this one", { replace: true });
      assert.equal(replaced.replaced, true);
      assert.deepEqual(replaced.playbook.steps, ["Exhale", "Next shot"]);
      assert.equal(save(memory, { ...badShotReset, steps: ["Exhale"] }, "Yes", { replace: true }).replaced, true);
      assert.equal(listMemoryEntries(memory.path).length, 1);

      rememberMemoryEntry(memory.path, { category: "sleep", key: "wind-down-routine", value: "Phone away, dim lights, read", source: "telegram" }, { now: NOW, idGenerator: memory.idGenerator });
      assert.throws(
        () => save(memory, { domain: "sleep", name: "Wind-down routine", trigger: "At 22:30", steps: ["Stretch"] }),
        (error) => error.code === "PLAYBOOK_EXISTS",
      );
    } finally {
      memory.cleanup();
    }
  });

  it("finds a playbook by name, key, or a unique partial name, and asks when several fit", () => {
    const memory = withMemory();
    try {
      save(memory, badShotReset);
      save(memory, preRound);
      save(memory, { ...preRound, name: "Pre-putt routine", trigger: "Over a putt", steps: ["Read the line"] });

      for (const name of ["bad-shot reset", "Bad shot reset", "bad-shot-reset", "my bad-shot reset", "bad shot", "golf/bad-shot-reset"]) {
        const result = findPlaybook(memory.path, { name });
        assert.equal(result.status, "found", name);
        assert.equal(result.playbook.key, "bad-shot-reset", name);
      }

      const unclear = findPlaybook(memory.path, { name: "pre" });
      assert.equal(unclear.status, "clarify");
      assert.deepEqual(unclear.candidates, ["Pre-putt routine (golf)", "Pre-round routine (golf)"]);
      assert.equal(unclear.question, "Which one do you mean: Pre-putt routine (golf) or Pre-round routine (golf)?");

      assert.equal(findPlaybook(memory.path, { name: "shutdown" }).status, "not_found");
      assert.equal(findPlaybook(memory.path, { name: "bad-shot reset", domain: "work" }).status, "not_found");
      assert.equal(findPlaybook(memory.path, { name: "work/bad-shot-reset" }).status, "not_found");
    } finally {
      memory.cleanup();
    }
  });

  it("lists playbooks and coaching settings, but no other memory", () => {
    const memory = withMemory();
    try {
      const plain = (category, key, value, sensitivity = "low") =>
        rememberMemoryEntry(memory.path, { category, key, value, sensitivity, source: "telegram" }, { now: NOW, idGenerator: memory.idGenerator });
      plain("golf", "home_course", "Lakes course");
      plain("health", "daily_stretching", "15 minutes");
      plain("golf", "cue-word", "commit");
      plain("golf", "pre-round-routine", "Before the round: target, breath, commit. Cue: commit");
      plain("sleep", "wind-down-routine", "Details", "sensitive");
      save(memory, badShotReset);

      const golf = listPlaybooks(memory.path, { domain: "golf" });
      assert.deepEqual(golf.map((view) => [view.key, view.format]), [["bad-shot-reset", "structured"], ["pre-round-routine", "plain"]]);
      assert.deepEqual(
        { trigger: golf[1].trigger, steps: golf[1].steps, cue: golf[1].cue },
        { trigger: "Before the round", steps: ["target", "breath", "commit"], cue: "commit" },
      );
      assert.deepEqual(listPlaybooks(memory.path).map((view) => view.key), ["bad-shot-reset", "pre-round-routine"]);
      assert.deepEqual(listCoachingSettings(memory.path), [{ key: "golf/cue-word", value: "commit" }]);
      assert.deepEqual(listPlaybooks(memory.path, { domain: "work" }), []);

      assert.equal(
        formatPlaybookList(golf, listCoachingSettings(memory.path)),
        [
          "Saved playbooks:",
          "- Bad-shot reset (golf/bad-shot-reset): After a poor shot: Walk away from the shot; Slow exhale; Drop your shoulders; Say: next shot; Assess the lie and pick the target. Cue: next shot.",
          "- Pre round routine (golf/pre-round-routine): Before the round: target; breath; commit. Cue: commit.",
          "Coaching settings: golf/cue-word: commit",
        ].join("\n"),
      );
      assert.equal(formatPlaybookList([]), "No saved playbooks.");
    } finally {
      memory.cleanup();
    }
  });

  it("changes one exact step, cue, or trigger and keeps the rest as saved", () => {
    const memory = withMemory();
    try {
      save(memory, preRound);
      const change = (edit, replyText = "Change my pre-round routine") =>
        updatePlaybook(memory.path, { name: "pre-round routine" }, edit, { replyText, now: "2026-09-26T11:00:00.000Z" });

      assert.deepEqual(change({ addStep: { text: "One slow breath", before: "target" } }, "Add one breath before the target step").playbook.steps, [
        "Visualize the first tee shot",
        "One slow breath",
        "Pick the target",
        "Commit",
      ]);
      assert.deepEqual(change({ addStep: { text: "Walk to the ball", after: "commit" } }).playbook.steps.at(-1), "Walk to the ball");
      assert.deepEqual(change({ addStep: "Smile" }).playbook.steps.at(-1), "Smile");
      assert.deepEqual(change({ removeStep: "Visualize" }, "Remove visualization from my pre-round routine").playbook.steps, [
        "One slow breath",
        "Pick the target",
        "Commit",
        "Walk to the ball",
        "Smile",
      ]);
      assert.deepEqual(change({ replaceStep: { from: "smile", to: "Relax the grip" } }).playbook.steps.at(-1), "Relax the grip");
      assert.equal(change({ setCue: "trust it" }, "Change my golf cue to trust it").playbook.cue, "trust it");
      assert.equal(change({ setCue: null }).playbook.cue, null);
      const updated = change({ setTrigger: "On the first tee" });
      assert.equal(updated.status, "updated");
      assert.equal(updated.changed, "setTrigger");

      const [entry] = listMemoryEntries(memory.path);
      assert.equal(entry.id, "mem-1");
      assert.equal(entry.createdAt, NOW);
      assert.equal(entry.updatedAt, "2026-09-26T11:00:00.000Z");
      assert.equal(entry.value, "On the first tee: One slow breath; Pick the target; Commit; Walk to the ball; Relax the grip.");
    } finally {
      memory.cleanup();
    }
  });

  it("asks instead of guessing an unclear routine or step, and writes nothing", () => {
    const memory = withMemory();
    try {
      save(memory, preRound);
      save(memory, { ...preRound, name: "Pre-putt routine", trigger: "Over a putt", steps: ["Read the line", "Pick the target"] });
      const before = readFileSync(memory.path, "utf8");

      const routine = updatePlaybook(memory.path, { name: "pre" }, { setCue: "go" }, { replyText: "Change the cue to go" });
      assert.equal(routine.status, "clarify");
      assert.match(routine.question, /^Which one do you mean: /);

      const step = updatePlaybook(memory.path, { name: "pre-round routine" }, { removeStep: "t" }, { replyText: "Remove that step" });
      assert.equal(step.status, "clarify");
      assert.match(step.question, /^Which step do you mean: "Visualize the first tee shot" or "Pick the target" or "Commit"\?$/);

      const missing = updatePlaybook(memory.path, { name: "pre-round routine" }, { removeStep: "breathing" }, { replyText: "Remove the breathing" });
      assert.equal(missing.status, "clarify");
      assert.equal(missing.question, 'I couldn\'t find a step matching "breathing". The steps are: 1. Visualize the first tee shot; 2. Pick the target; 3. Commit. Which one?');

      const unknown = updatePlaybook(memory.path, { name: "shutdown" }, { setCue: "done" }, { replyText: "Change it" });
      assert.equal(unknown.status, "clarify");
      assert.match(unknown.question, /I couldn't find that routine\. Your playbooks are: Pre-putt routine \(golf\), Pre-round routine \(golf\)\. Which one\?/);

      assert.equal(readFileSync(memory.path, "utf8"), before);
    } finally {
      memory.cleanup();
    }

    const empty = withMemory();
    try {
      const none = updatePlaybook(empty.path, { name: "bad-shot reset" }, { setCue: "go" }, { replyText: "Change it" });
      assert.equal(none.question, "You have no saved playbooks yet. Do you want to save this as a new one?");
      assert.equal(existsSync(empty.path), false);
    } finally {
      empty.cleanup();
    }
  });

  it("turns a routine saved as plain text into a structured one on its first change", () => {
    const memory = withMemory();
    try {
      rememberMemoryEntry(
        memory.path,
        { category: "golf", key: "pre-round-routine", value: "Before the round: target, breath, commit", source: "telegram" },
        { now: NOW, idGenerator: memory.idGenerator },
      );

      const result = updatePlaybook(memory.path, { name: "pre-round routine" }, { addStep: { text: "One slow breath", before: "target" } }, { replyText: "Add one breath before the target step" });

      assert.equal(result.status, "updated");
      assert.equal(result.converted, true);
      const [entry] = listMemoryEntries(memory.path);
      assert.deepEqual(entry.playbook, { name: "Pre round routine", trigger: "Before the round", steps: ["One slow breath", "target", "breath", "commit"], cue: null });
      assert.equal(entry.value, "Before the round: One slow breath; target; breath; commit.");
    } finally {
      memory.cleanup();
    }
  });

  it("needs explicit words for a change, one change at a time, and keeps at least one step", () => {
    const memory = withMemory();
    try {
      save(memory, { ...badShotReset, steps: ["Exhale"] });
      const before = readFileSync(memory.path, "utf8");

      assert.equal(updatePlaybook(memory.path, { name: "bad-shot reset" }, { setCue: "go" }, { replyText: "that went well" }).status, "not_saved");
      assert.throws(() => updatePlaybook(memory.path, { name: "bad-shot reset" }, { setCue: "go", setTrigger: "x" }, { replyText: "Change it" }), /exactly one playbook change/);
      assert.throws(() => updatePlaybook(memory.path, { name: "bad-shot reset" }, { rename: "x" }, { replyText: "Change it" }), /Unknown playbook change: rename/);
      assert.throws(() => updatePlaybook(memory.path, { name: "bad-shot reset" }, "setCue", { replyText: "Change it" }), /must be an object/);
      assert.throws(() => updatePlaybook(memory.path, { name: "bad-shot reset" }, { removeStep: "Exhale" }, { replyText: "Remove it" }), /at least one step/);
      assert.throws(() => updatePlaybook(memory.path, { name: "bad-shot reset" }, { addStep: "I always choke here" }, { replyText: "Add it" }), /feeling, trait, or judgement/);

      assert.equal(readFileSync(memory.path, "utf8"), before);
    } finally {
      memory.cleanup();
    }
  });

  it("leaves plain memory entries exactly as they were", () => {
    const memory = withMemory();
    try {
      const entry = rememberMemoryEntry(memory.path, { category: "food", key: "breakfast", value: "yogurt" }, { now: NOW, idGenerator: () => "mem-9" });
      assert.deepEqual(Object.keys(entry), ["id", "category", "key", "value", "sensitivity", "source", "createdAt", "updatedAt"]);
      assert.throws(
        () => rememberMemoryEntry(memory.path, { category: "golf", key: "x", value: "y", sensitivity: "sensitive", playbook: { name: "x" } }),
        /sensitive details use the sensitive-memory flow/,
      );
    } finally {
      memory.cleanup();
    }
  });

  it("formats a playbook for Telegram without a model", () => {
    assert.equal(
      formatPlaybook({ ...badShotReset, key: "bad-shot-reset" }),
      [
        "Bad-shot reset (golf)",
        "When: After a poor shot",
        "1. Walk away from the shot",
        "2. Slow exhale",
        "3. Drop your shoulders",
        "4. Say: next shot",
        "5. Assess the lie and pick the target",
        "Cue: next shot",
      ].join("\n"),
    );
  });
});

describe("playbook consent", () => {
  it("accepts explicit requests and plain yeses, and nothing else", () => {
    for (const reply of [
      "Yes",
      "Yes, save it",
      "yes please",
      "Go ahead",
      "ok",
      "Sure",
      "Remember this as my meeting prep routine",
      "Save that as my bad-shot reset",
      "Change my golf cue word to commit",
      "Add one breath before the target step",
      "Remove visualization from my pre-round routine",
      "My pre-round routine is target, breath, commit",
      "Can you remember my bad-shot reset?",
      "Use this as my shutdown routine from now on",
    ]) {
      assert.equal(isExplicitPlaybookConsent(reply), true, reply);
    }
    for (const reply of [
      "That reset worked really well today",
      "That was useful",
      "Maybe save it later",
      "Probably",
      "No, don't save it",
      "Not now",
      "Should I save it?",
      "Do you think it's worth saving?",
      "",
      undefined,
    ]) {
      assert.equal(isExplicitPlaybookConsent(reply), false, String(reply));
    }
  });
});

describe("playbook CLI", () => {
  const stdinOf = (value) => [Buffer.from(typeof value === "string" ? value : JSON.stringify(value))];

  it("parses commands and refuses options a command does not take", () => {
    assert.deepEqual(parsePlaybookArgs(["list", "--domain", "golf"]), { command: "list", options: { jsonStdin: false, replace: false, domain: "golf" } });
    assert.deepEqual(parsePlaybookArgs(["save", "--json-stdin", "--replace"]), { command: "save", options: { jsonStdin: true, replace: true } });

    assert.throws(() => parsePlaybookArgs(["delete"]), /Unknown playbook command: delete/);
    assert.throws(() => parsePlaybookArgs(["save"]), /pass --json-stdin with a quoted heredoc/);
    assert.throws(() => parsePlaybookArgs(["update", "--replace"]), /update does not accept --replace/);
    assert.throws(() => parsePlaybookArgs(["save", "--name", "x"]), /save does not accept --name/);
    assert.throws(() => parsePlaybookArgs(["show"]), /show requires --name/);
    assert.throws(() => parsePlaybookArgs(["list", "--domain"]), /--domain requires a value/);
    assert.throws(() => parsePlaybookArgs(["guide", "--domain", "golf"]), /guide does not accept --domain/);
  });

  it("saves, lists, shows, and changes a playbook with the user's words taken literally from stdin", async () => {
    const memory = withMemory();
    try {
      const run = (argv, stdin) => runPlaybookCli(argv, { memoryPath: memory.path, stdin: stdin ?? [], now: NOW, idGenerator: memory.idGenerator });
      const step = "Run `npm test` once, then check $HOME's \"notes\"";

      const saved = await run(["save", "--json-stdin"], stdinOf({ replyText: "Save that as my stuck reset", domain: "work", name: "Stuck reset", trigger: "When a task stalls", steps: [step, "Write the next question"] }));
      assert.equal(saved.status, "saved");
      assert.match(saved.text, /^Saved Stuck reset \(work\)\.\nStuck reset \(work\)\nWhen: When a task stalls\n1\. Run `npm test` once/);
      assert.equal(listMemoryEntries(memory.path)[0].playbook.steps[0], step);

      const listed = await run(["list", "--domain", "work"]);
      assert.equal(listed.playbooks.length, 1);
      assert.match(listed.text, /^Saved playbooks:\n- Stuck reset \(work\/stuck-reset\)/);

      const shown = await run(["show", "--name", "stuck reset"]);
      assert.equal(shown.status, "found");
      assert.equal(shown.text, formatPlaybook(shown.playbook));

      const updated = await run(["update", "--json-stdin"], stdinOf({ replyText: "Add a break after the question", name: "stuck reset", change: { addStep: { text: "Take a two-minute break", after: "question" } } }));
      assert.equal(updated.status, "updated");
      assert.match(updated.text, /^Updated Stuck reset\./);

      const refused = await run(["save", "--json-stdin"], stdinOf({ replyText: "That worked well", domain: "work", name: "Other", trigger: "Later", steps: ["x"] }));
      assert.equal(refused.status, "not_saved");
      assert.match(refused.text, /^Nothing was saved\./);

      await assert.rejects(run(["update", "--json-stdin"], stdinOf({ replyText: "Change it", name: "stuck reset", change: { setCue: "go" }, extra: 1 })), /not extra/);
      await assert.rejects(run(["save", "--json-stdin"], stdinOf("")), /needs a JSON object on stdin/);
      await assert.rejects(run(["save", "--json-stdin"], stdinOf("[1]")), /must be an object/);
    } finally {
      memory.cleanup();
    }
  });

  it("serves the guide with the saved playbooks, and still serves it when memory cannot be read", async () => {
    const memory = withMemory();
    try {
      const empty = await runPlaybookCli(["guide"], { memoryPath: memory.path });
      assert.match(empty.text, /^No saved playbooks\.\n\n# Playbooks And Debriefs\n/);
      assert.equal(formatPlaybookCliResult("guide", empty), empty.text);

      writeFileSync(memory.path, "{ broken");
      const broken = await runPlaybookCli(["guide"], { memoryPath: memory.path });
      assert.match(broken.text, /^Saved playbooks could not be read: /);
      assert.match(broken.text, /## Routing Examples/);
    } finally {
      memory.cleanup();
    }
  });

  it("explains itself as explicit memory with no other side effects", async () => {
    const help = await runPlaybookCli(["help"]);
    assert.deepEqual(help.commands, ["guide", "list", "show", "save", "update"]);
    assert.match(help.safety, /written only with the user's explicit words/);
    assert.match(help.safety, /Nothing touches Todoist, Calendar, reminders, or messages/);
  });

  it("shows playbooks in the ordinary memory list", async () => {
    const memory = withMemory();
    try {
      save(memory, badShotReset);
      const listed = await runMemoryCli(["list", "--category", "golf"], { memoryPath: memory.path });
      assert.equal(listed.entries[0].key, "bad-shot-reset");
      assert.deepEqual(listed.entries[0].playbook.steps, [...badShotReset.steps]);
    } finally {
      memory.cleanup();
    }
  });

  it("cannot reach Todoist, Calendar, Telegram, or the network", () => {
    for (const path of ["scripts/lib/playbooks.mjs", "scripts/playbook.mjs"]) {
      const source = readFileSync(path, "utf8");
      assert.doesNotMatch(source, /from "\.\/(lib\/)?(todoist|calendar|weekly-plan|routine|openrouter|quiet-ops|live-cron)[^"]*"/, path);
      assert.doesNotMatch(source, /child_process|\bfetch\(|message send/, path);
    }
  });
});

// The guide's "Routing Examples" and the recognizer must agree: message, label,
// and the expected kind (null where coaching or another path answers).
const playbookRoutingExamples = [
  ["Use my pre-round routine", "use the saved playbook", playbookKinds.use],
  ["Coach me using my normal routine", "use the saved playbook", playbookKinds.use],
  ["What's my bad-shot reset?", "show the playbook", playbookKinds.show],
  ["Show my playbooks", "show the playbooks", playbookKinds.show],
  ["Remember this as my meeting prep routine", "save, with the user's words", playbookKinds.save],
  ["Change my golf cue word to commit", "coaching setting through the memory command, or ask which", playbookKinds.setting],
  ["Add one breath before the target step", "change one exact step, or ask which", playbookKinds.update],
  ["Remove visualization from my pre-round routine", "change one exact step, or ask which", playbookKinds.update],
  ["That reset worked really well today", "offer to save; nothing is saved", playbookKinds.offer],
  ["Debrief my round", "coaching debrief ending with Keep, Adjust, Possible lesson", null],
];

describe("playbook recognition", () => {
  const guide = readFileSync(PLAYBOOK_GUIDE_PATH, "utf8");

  it("keeps the guide's routing examples and this table in step", () => {
    const examples = guide.slice(guide.indexOf("## Routing Examples")).split("\n").filter((line) => line.startsWith("- `"));
    assert.deepEqual(examples, playbookRoutingExamples.map(([message, label]) => `- \`${message}\` → ${label}`));
  });

  it("classifies every routing example the way the guide says", () => {
    for (const [message, , kind] of playbookRoutingExamples) {
      assert.equal(classifyPlaybookRequest(message)?.kind ?? null, kind, message);
    }
  });

  it("marks only saving and changing as memory writes", () => {
    for (const [message, , kind] of playbookRoutingExamples.filter(([, , kind]) => kind)) {
      const expected = [playbookKinds.save, playbookKinds.update, playbookKinds.setting].includes(kind) ? "memory" : "nothing";
      assert.equal(classifyPlaybookRequest(message).writes, expected, message);
    }
  });

  it("leaves tasks, scheduled routines, other memory, and negated requests alone", () => {
    for (const message of [
      "Add a task to buy milk",
      "Change my meeting to 3pm",
      "What's my home course?",
      "Remember that I prefer early workouts",
      "Run the tests",
      "Change my morning-brief routine to 07:30",
      "Skip the midday check-in routine today",
      "Move my reminder routine to Friday",
      "Don't save that as my routine",
    ]) {
      assert.equal(classifyPlaybookRequest(message), null, message);
    }
  });
});
