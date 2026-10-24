/**
 * Telegram is for what needs the user's attention; Todoist holds the plan.
 *
 * These tests follow a scheduled routine the way the Gateway runs it: from
 * config/schedules.json through `routines:install` into a fake Gateway, then
 * the commands the installed job's own message names (the skip check, the
 * routine template, the notice for the findings), to the final answer cron
 * delivery receives. Only the model is left out: each test hands over what a
 * model could find. A token-only NO_REPLY is what OpenClaw's cron delivery
 * never posts; the live run history records such runs as not delivered.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { buildRoutineCronJobs, routineJobName } from "../scripts/lib/routine-cron.mjs";
import { normalizeCronJob } from "../scripts/lib/live-cron.mjs";
import { buildContractWatchJob, contractWatchJobMismatches } from "../scripts/lib/contract-watch.mjs";
import { buildStockMonitorJob, stockMonitorJobMismatches } from "../scripts/lib/stock-monitor.mjs";
import { buildWeeklyPlanCronJobs } from "../scripts/lib/weekly-plan-cron.mjs";
import { runRoutineCli } from "../scripts/routine.mjs";
import { runRoutineCronCli } from "../scripts/routines-cron.mjs";
import { FAKE_TELEGRAM_ID, createFakeOpenClawCron, sampleRawJobs } from "./fixtures/fake-openclaw-cron.mjs";

const schedules = JSON.parse(readFileSync("config/schedules.json", "utf8"));
const food = JSON.parse(readFileSync("config/food-planning.json", "utf8"));
const env = { TELEGRAM_USER_ID: FAKE_TELEGRAM_ID };
const installed = { telegramUserId: FAKE_TELEGRAM_ID, projectRoot: "/repo", nodePath: "/node" };
const ROUTINE_PREFIX = "Assistant routine: ";
const QUESTION_ABOUT_MESSAGES = /timing|tone|detail level|detaljnivå|these check-ins|dessa check-ins/i;

// The day of the unwanted message: Todoist holds the gym session and the
// mobility routine, and the calendar is free tonight.
const TODOIST_TODAY = [
  {
    content: "Gym – Helkropp A, tisdag",
    description: "Uppvärmning 8 min. Knäböj – 3 × 8, vila 2 min. Rumänska marklyft – 3 × 10, vila 90 sek. 2 repetitioner i reserv. Cirka 50 minuter.",
  },
  { content: "Rörlighet – Tisdag, 15 minuter", description: "Höftböjarstretch – 2 × 45 sek per sida." },
];

/** A live job in the Gateway's own shape, as `cron list` returns it. */
function rawAgentTurn(spec, id, overrides = {}) {
  return {
    id,
    name: spec.name,
    description: spec.description,
    enabled: spec.enabled,
    createdAtMs: 1780000000000,
    updatedAtMs: 1780000000000,
    agentId: spec.agentId,
    sessionKey: spec.sessionKey,
    schedule: { kind: "cron", expr: spec.schedule.expr, tz: spec.schedule.tz },
    sessionTarget: spec.sessionTarget,
    wakeMode: spec.wakeMode,
    payload: { kind: "agentTurn", message: spec.message, timeoutSeconds: spec.timeoutSeconds },
    delivery: { mode: "announce", ...spec.delivery },
    state: { lastRunStatus: "ok", lastStatus: "ok" },
    ...overrides,
  };
}

function rawCommand(job, id, { bestEffort = false } = {}) {
  return {
    id,
    name: job.name,
    description: job.description,
    enabled: true,
    createdAtMs: 1780000000000,
    updatedAtMs: 1780000000000,
    schedule: { kind: "cron", expr: job.schedule.expr, tz: job.schedule.tz, staggerMs: 0 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "command", argv: job.argv, cwd: job.cwd, timeoutSeconds: job.timeoutSeconds },
    delivery: { mode: "announce", ...job.delivery, bestEffort },
    state: { lastRunStatus: "ok", lastStatus: "ok" },
  };
}

/**
 * The Gateway as it was before this change: every routine installed from the
 * old config, the workout window and the midday check-in on, each message
 * ending with the feedback question; next to them the weekly plan, the stock
 * watch, the renewal watch, a reminder the user asked for and old disabled jobs.
 */
function gatewayBefore() {
  const oldMessage = (spec) =>
    [
      spec.message.split("\n")[0],
      `If ${spec.routineId} is not skippedToday, run npm run routine -- ${spec.routineId} from the assistant repo and use the returned telegramPrompt as the briefing template.`,
      "Return exactly one concise Telegram check-in for Verneri as your final answer.",
      "Feedback loop: include one small line asking whether the timing, tone, or detail level should change.",
    ].join("\n");
  const routines = buildRoutineCronJobs(schedules, { telegramUserId: FAKE_TELEGRAM_ID }).map((spec) =>
    rawAgentTurn(spec, `routine-${spec.routineId}`, {
      enabled: !["morning-brief", "evening-review"].includes(spec.routineId),
      payload: { kind: "agentTurn", message: oldMessage(spec), timeoutSeconds: spec.timeoutSeconds },
    }),
  );
  const [propose, apply] = buildWeeklyPlanCronJobs(schedules, installed);
  const others = sampleRawJobs().filter((job) => !job.name.startsWith(ROUTINE_PREFIX) && !job.name.startsWith("Assistant weekly plan:"));
  return [
    ...routines,
    rawAgentTurn({ ...propose, schedule: propose.schedule }, "wp-propose"),
    rawCommand(apply, "wp-apply", { bestEffort: true }),
    rawCommand(buildStockMonitorJob(schedules, installed), "stock-monitor"),
    rawCommand(buildContractWatchJob(schedules, installed), "contract-watch"),
    ...others,
  ];
}

async function installedGateway() {
  const fake = createFakeOpenClawCron({ jobs: gatewayBefore() });
  const result = await runRoutineCronCli(["install"], { schedules, env, runOpenClaw: fake.run });
  return { fake, result };
}

const liveJob = (fake, name) => {
  const matches = fake.jobs.filter((job) => job.name === name);
  assert.equal(matches.length, 1, name);
  return matches[0];
};

/** The commands a scheduled routine's installed message tells the agent to run, in order. */
function commandsIn(message, routineId) {
  const skips = /npm run --silent routines:skips -- --json/.exec(message);
  const brief = new RegExp(`run npm run --silent routine -- (${routineId} --scheduled) from the assistant repo`).exec(message);
  const notice = new RegExp(`Pass your findings to npm run --silent routine -- (${routineId} --scheduled --findings-json-stdin) <<'JSON'`).exec(message);
  assert.ok(skips && brief && notice, `${routineId}: the installed message must name all three commands`);
  assert.ok(skips.index < brief.index && brief.index < notice.index, `${routineId}: commands out of order`);
  return { skips: ["skips", "--json"], brief: brief[1].split(" "), notice: notice[1].split(" ") };
}

/**
 * One scheduled run of a routine, from the job the Gateway holds: the skip
 * check, the template, and the notice for `findings`, which is the final
 * answer the job hands to cron delivery.
 */
async function scheduledRun(fake, routineId, findings, { now = "2026-10-20T15:30:00.000Z", stateDir } = {}) {
  const job = liveJob(fake, routineJobName(routineId));
  const commands = commandsIn(job.payload.message, routineId);
  const dir = stateDir ?? mkdtempSync(join(tmpdir(), "hilla-proactive-"));
  try {
    const skips = await runRoutineCronCli(commands.skips, { schedules, env, stateDir: dir, now: new Date(now) });
    if (skips.find((entry) => entry.routineId === routineId).skippedToday) return { job, brief: null, notice: null, finalAnswer: "NO_REPLY" };

    const brief = await runRoutineCli(commands.brief, { schedules, food, memoryEntries: [], now });
    const notice = await runRoutineCli(commands.notice, { schedules, food, memoryEntries: [], now, stdin: Readable.from([JSON.stringify(findings)]) });
    return { job, brief, notice, finalAnswer: notice.text };
  } finally {
    if (!stateDir) rmSync(dir, { recursive: true, force: true });
  }
}

describe("proactive notifications: the installed jobs", () => {
  it("switches the workout window and the midday check-in off on install, and keeps them installed", async () => {
    const { fake, result } = await installedGateway();

    for (const routineId of ["workout-window", "midday-check-in"]) {
      const job = liveJob(fake, routineJobName(routineId));
      assert.equal(job.enabled, false, routineId);
      assert.equal(job.id, `routine-${routineId}`, "disabled in place, never deleted");
    }
    assert.equal(liveJob(fake, routineJobName("weekly-review")).enabled, true);
    assert.equal(liveJob(fake, routineJobName("morning-brief")).enabled, false);
    assert.equal(liveJob(fake, routineJobName("evening-review")).enabled, false);
    assert.deepEqual(
      result.results.map((entry) => [entry.routineId, entry.action]),
      schedules.daily.map((routine) => [routine.id, "edit"]).concat([["weekly-review", "edit"]]),
    );
    assert.deepEqual(result.verification, { remainingDifferences: [], unrelatedJobsChanged: [] });
  });

  it("never switches them back on: a second install changes nothing", async () => {
    const { fake } = await installedGateway();
    const before = structuredClone(fake.jobs);
    const mutationsBefore = fake.mutations().length;

    const again = await runRoutineCronCli(["install"], { schedules, env, runOpenClaw: fake.run });

    assert.ok(again.results.every((entry) => entry.action === "unchanged"), JSON.stringify(again.results));
    assert.equal(fake.mutations().length, mutationsBefore);
    assert.deepEqual(fake.jobs, before);
  });

  it("leaves every other job exactly as it was: the weekly plan, the stock watch, the renewal watch and the user's reminder", async () => {
    const before = gatewayBefore();
    const { fake } = await installedGateway();
    const others = (jobs) => jobs.filter((job) => !job.name.startsWith(ROUTINE_PREFIX));

    assert.deepEqual(others(fake.jobs), others(before));
    assert.equal(fake.jobs.length, before.length, "nothing added or removed");
    assert.deepEqual(
      fake.mutations().map((args) => [args[1], fake.jobs.find((job) => job.id === args[2])?.name.startsWith(ROUTINE_PREFIX)]),
      fake.mutations().map((args) => [args[1], true]),
      "every change is an edit of a routine job",
    );
    // The protected jobs still match what their own installers set up, switched on.
    assert.deepEqual(stockMonitorJobMismatches(normalizeCronJob(liveJob(fake, "Assistant stocks: watch monitor")), buildStockMonitorJob(schedules, installed)), []);
    assert.deepEqual(contractWatchJobMismatches(normalizeCronJob(liveJob(fake, "Assistant contracts: renewal watch")), buildContractWatchJob(schedules, installed)), []);
    const [propose, apply] = buildWeeklyPlanCronJobs(schedules, installed);
    assert.equal(liveJob(fake, propose.name).payload.message, propose.message);
    assert.equal(liveJob(fake, propose.name).enabled, true);
    assert.deepEqual(liveJob(fake, apply.name).payload.argv, apply.argv);
    assert.equal(liveJob(fake, apply.name).enabled, true);
    assert.equal(liveJob(fake, "Renew EU health insurance card").enabled, true);
  });

  it("gives every routine a message with no feedback question, whose final answer is the routine's notice", async () => {
    const { fake } = await installedGateway();

    for (const job of fake.jobs.filter((candidate) => candidate.name.startsWith(ROUTINE_PREFIX))) {
      const routineId = job.name.slice(ROUTINE_PREFIX.length);
      commandsIn(job.payload.message, routineId);
      assert.doesNotMatch(job.payload.message, /Feedback loop|timing, tone|detail level|Telegram check-in/i, routineId);
      assert.match(job.payload.message, /return its text exactly as your final answer; with nothing to report that text is NO_REPLY/);
    }
  });
});

describe("proactive notifications: a scheduled run", () => {
  it("sends nothing for a day whose only news is the workout already in Todoist, even with the workout window switched back on", async () => {
    const { fake } = await installedGateway();
    assert.equal(liveJob(fake, routineJobName("workout-window")).enabled, false, "off, so it does not run at all");
    // The user may turn it back on in chat; its runs then follow the same rules.
    const enabled = await runRoutineCronCli(["enable", "workout-window"], { schedules, env, runOpenClaw: fake.run });
    assert.equal(enabled.changed, true);

    const run = await scheduledRun(fake, "workout-window", { items: [] });
    assert.equal(run.job.enabled, true);

    // The template asks for none of what the old check-in sent ...
    assert.match(run.brief.telegramPrompt, /Look at this evening for:/);
    assert.match(run.brief.telegramPrompt, /Leave out what is already planned in Todoist or the weekly plan \(tasks, workouts, stretching, meals, prep, shopping\), exercise lists, start times, water or kit tips, motivation/);
    assert.doesNotMatch(run.brief.telegramPrompt, /suggest one primary workout|sets × reps or time|find a realistic workout/i);
    // ... and with nothing that needs the user, the final answer is the silent token alone.
    assert.equal(run.finalAnswer, "NO_REPLY");
  });

  it("does not let the planned session through even when it is handed over as a finding", async () => {
    const { fake } = await installedGateway();
    const [gym, mobility] = TODOIST_TODAY;
    const run = await scheduledRun(fake, "workout-window", {
      items: [
        { kind: "reminder", whatChanged: `Today is gym day: Todoist has ${gym.content} and ${mobility.content}.`, whyItMatters: "The calendar is free tonight.", decision: "Aim to start at 18:00." },
        { kind: "decision", whatChanged: "The calendar is free tonight.", whyItMatters: "There is room for the planned session.", decision: gym.description },
        { kind: "decision", whatChanged: "Your meal prep is tomorrow.", whyItMatters: "It is planned.", decision: "Vill du ändra tid, ton eller detaljnivå på dessa check-ins?" },
      ],
    });

    assert.equal(run.finalAnswer, "NO_REPLY");
    assert.deepEqual(
      run.notice.dropped.map((entry) => entry.problems[0]),
      [
        "kind must be decision, change, deadline, approval, conflict, failure: a planned task, workout, meal or recap is not news",
        "an exercise prescription: planned sessions stay in Todoist",
        "a question about Hilla's own messages: the user can ask for changes any time",
      ],
    );
  });

  it("never expands a gym task into exercise instructions, even beside a real conflict", async () => {
    const { fake } = await installedGateway();
    const conflict = {
      kind: "conflict",
      whatChanged: "A 17:30–19:30 client dinner was added to tonight's calendar.",
      whyItMatters: "It overlaps the evening you planned for Helkropp A.",
      decision: "Move the gym session, or skip it this week.",
      source: "Google Calendar",
    };

    const copied = await scheduledRun(fake, "workout-window", { items: [{ ...conflict, decision: `Move it: ${TODOIST_TODAY[0].description}` }] });
    assert.equal(copied.finalAnswer, "NO_REPLY");

    const plain = await scheduledRun(fake, "workout-window", { items: [conflict] });
    assert.equal(
      plain.finalAnswer,
      [
        "What changed: A 17:30–19:30 client dinner was added to tonight's calendar.",
        "Why it matters: It overlaps the evening you planned for Helkropp A.",
        "Decision needed: Move the gym session, or skip it this week.",
        "Source: Google Calendar",
      ].join("\n"),
    );
    assert.doesNotMatch(plain.finalAnswer, /×|vila|Knäböj|repetitioner/);
  });

  it("keeps the Sunday review silent when the week holds no new decision", async () => {
    const { fake } = await installedGateway();
    const sunday = "2026-10-25T18:00:00.000Z";

    const run = await scheduledRun(fake, "weekly-review", { items: [] }, { now: sunday });
    assert.equal(run.job.enabled, true);
    assert.deepEqual(run.brief.sections.map((section) => section.id), ["decision", "change", "deadline", "approval", "conflict", "failure", "not-news"]);
    assert.doesNotMatch(run.brief.telegramPrompt, /week-recap|unfinished-tasks|health-routines|top-3-priorities|stop-or-simplify/);
    assert.equal(run.finalAnswer, "NO_REPLY");

    // A recap of the week, unfinished tasks and priorities are not decisions.
    const recap = await scheduledRun(
      fake,
      "weekly-review",
      {
        items: [
          { kind: "recap", whatChanged: "Three gym sessions, two meal preps and a golf round this week.", whyItMatters: "Good consistency.", decision: "Keep it up." },
          { kind: "priority", whatChanged: "The bike service task is still open in Todoist.", whyItMatters: "It was postponed again.", decision: "Make it a top-3 priority." },
        ],
      },
      { now: sunday },
    );
    assert.equal(recap.finalAnswer, "NO_REPLY");
    assert.equal(recap.notice.dropped.length, 2);
  });

  it("still reports an unresolved decision on Sunday, in the attention format and with nothing appended", async () => {
    const { fake } = await installedGateway();
    const run = await scheduledRun(
      fake,
      "weekly-review",
      {
        items: [
          {
            kind: "decision",
            whatChanged: "The club moved Saturday's competition tee times to 07:40, the morning of a family brunch.",
            whyItMatters: "You can't do both, and the start list closes Thursday.",
            decision: "Play the competition, or withdraw before the list closes.",
            deadline: "2026-10-29",
            source: "Gmail, Golfklubben 25 Oct",
          },
        ],
      },
      { now: "2026-10-25T18:00:00.000Z" },
    );

    assert.equal(
      run.finalAnswer,
      [
        "What changed: The club moved Saturday's competition tee times to 07:40, the morning of a family brunch.",
        "Why it matters: You can't do both, and the start list closes Thursday.",
        "Decision needed: Play the competition, or withdraw before the list closes.",
        "Deadline: Thu 29 Oct 2026",
        "Source: Gmail, Golfklubben 25 Oct",
      ].join("\n"),
    );
    assert.doesNotMatch(run.finalAnswer, QUESTION_ABOUT_MESSAGES);
  });

  it("still reports a connection that stopped working and needs the user", async () => {
    const { fake } = await installedGateway();
    const run = await scheduledRun(
      fake,
      "weekly-review",
      {
        items: [
          {
            kind: "failure",
            whatChanged: "Todoist refuses Hilla's token since Thursday.",
            whyItMatters: "Saturday's weekly plan can't see or create tasks until it is renewed.",
            decision: "Create a new Todoist token and update it in Hilla's settings.",
            source: "Todoist API, 401 Unauthorized",
          },
        ],
      },
      { now: "2026-10-25T18:00:00.000Z" },
    );

    assert.match(run.brief.telegramPrompt, /- failure: A connection Hilla relies on that stopped working and needs the user to fix it, such as an expired sign-in; not a source that was merely unavailable this time\./);
    // The first live check reported Saturday's plan, still in its review window, as an approval owed.
    assert.match(run.brief.telegramPrompt, /- approval: An approval or essential missing information the user still owes, such as a weekly plan held for an OK; npm run --silent pending lists what Hilla is waiting for\. A weekly plan in its review window is not one: it applies by itself, and its own message already told the user\./);
    assert.equal(
      run.finalAnswer,
      "What changed: Todoist refuses Hilla's token since Thursday.\nWhy it matters: Saturday's weekly plan can't see or create tasks until it is renewed.\nDecision needed: Create a new Todoist token and update it in Hilla's settings.\nSource: Todoist API, 401 Unauthorized",
    );
  });

  it("says so in one line when a routine command keeps failing, instead of going silent", async () => {
    const { fake } = await installedGateway();
    const message = liveJob(fake, routineJobName("weekly-review")).payload.message;

    assert.match(message, /If a routine command fails, fix the JSON once; if it still fails, your final answer is one short line saying the weekly-review routine could not run and why\./);
    await assert.rejects(
      runRoutineCli(["weekly-review", "--scheduled", "--findings-json-stdin"], { schedules, food, memoryEntries: [], stdin: Readable.from(['{"items": ']) }),
      /^Error: The findings are not valid JSON/,
    );
  });

  it("sends nothing on a day the user skipped, without running the routine", async () => {
    const { fake } = await installedGateway();
    const stateDir = mkdtempSync(join(tmpdir(), "hilla-proactive-skip-"));
    try {
      await runRoutineCronCli(["skip", "weekly-review", "2026-10-25"], { schedules, env, stateDir, now: new Date("2026-10-24T10:00:00.000Z") });
      const decision = { kind: "decision", whatChanged: "A real change.", whyItMatters: "It matters.", decision: "Choose." };
      const run = await scheduledRun(fake, "weekly-review", { items: [decision] }, { now: "2026-10-25T18:00:00.000Z", stateDir });

      assert.equal(run.brief, null, "the routine never ran");
      assert.equal(run.finalAnswer, "NO_REPLY");
      assert.match(run.job.payload.message, /If weekly-review is skippedToday, return exactly NO_REPLY as your final answer and do no routine work\./);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("proactive notifications: what the user asks for", () => {
  it("still shows a workout or a check-in in full when the user asks", async () => {
    // `npm run routine -- workout-window` is what the health agent runs for "Show my workout" or a workout nudge.
    const workout = await runRoutineCli(["workout-window"], { schedules, food, memoryEntries: [], now: "2026-10-20T15:30:00.000Z" });
    assert.equal(workout.scheduled, false);
    assert.match(workout.telegramPrompt, /suggest one primary workout and one lighter fallback, each with named exercises, sets × reps or time, rest and total minutes/);
    assert.doesNotMatch(workout.telegramPrompt, /NO_REPLY|findings-json-stdin/);

    const midday = await runRoutineCli(["midday-check-in"], { schedules, food, memoryEntries: [], now: "2026-10-20T10:30:00.000Z" });
    assert.deepEqual(midday.sections.map((section) => section.id), ["food", "movement", "energy", "schedule-pressure"]);

    const health = readFileSync("agents/health/AGENTS.md", "utf8");
    assert.match(health, /Use `npm run routine -- midday-check-in` and `npm run routine -- workout-window` when the user asks for the daily health loop or a workout nudge\./);
    const personal = readFileSync("agents/personal/AGENTS.md", "utf8");
    assert.match(personal, /For a briefing, run `npm run routine -- ROUTINE_ID`/);
    const soul = readFileSync("agents/personal/SOUL.md", "utf8");
    assert.match(soul, /When the user asks, for example what is in Todoist today, to see a workout, to be reminded to train tonight, or for help planning the day, answer normally and use Todoist freely\./);
  });

  it("keeps reminders the user set: the policy names them, and installs never touch them", async () => {
    const { fake } = await installedGateway();
    const reminder = liveJob(fake, "Renew EU health insurance card");
    assert.equal(reminder.enabled, true);
    assert.equal(reminder.payload.kind, "agentTurn");
    assert.match(readFileSync("agents/personal/AGENTS.md", "utf8"), /a reminder the user set always goes/);
    assert.match(readFileSync("agents/personal/SOUL.md", "utf8"), /a planning proposal or a reminder the user asked for/);
  });
});
