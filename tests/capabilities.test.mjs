import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CAPABILITIES,
  CAPABILITY_APPROVALS,
  CAPABILITY_CATEGORIES,
  CAPABILITY_EFFECTS,
  CAPABILITY_SETUP,
  CAPABILITY_STATUSES,
  CAPABILITY_TAGS,
  CHECK_IN_ROUTINES,
  TRY_FIRST,
  buildCapabilityView,
  capabilityById,
  capabilitySetup,
  capabilityTopics,
  describeSchedule,
  formatCapabilityView,
  needsScheduleOverlay,
  scheduleOverlay,
  selectCapabilities,
} from "../scripts/lib/capabilities.mjs";
import { buildInboxClassifierDebug } from "../scripts/lib/inbox-classifier-debug.mjs";
import { routineJobName } from "../scripts/lib/routine-cron.mjs";
import { WEEKLY_PLAN_APPLY_JOB, WEEKLY_PLAN_PROPOSE_JOB } from "../scripts/lib/weekly-plan-cron.mjs";
import { CAPABILITIES_GUIDE_PATH, parseCapabilitiesArgs, runCapabilitiesCli } from "../scripts/capabilities.mjs";

const policy = JSON.parse(readFileSync("config/approval-policy.json", "utf8"));
const schedules = JSON.parse(readFileSync("config/schedules.json", "utf8"));
const packageScripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
const personalPrompt = readFileSync("agents/personal/AGENTS.md", "utf8");
const focusGuide = readFileSync("agents/personal/guides/focus.md", "utf8");

const categoryIds = CAPABILITY_CATEGORIES.map((category) => category.id);
const topicIds = new Set([...categoryIds, ...CAPABILITY_TAGS.map((tag) => tag.id)]);
const availableEntries = CAPABILITIES.filter((entry) => entry.status === "available");
const ids = (entries) => entries.map((entry) => entry.id);
const SECRET = "sk-or-v1-0123456789abcdef0123456789abcdef";
const env = { TODOIST_API_TOKEN: SECRET, GMAIL_ACCOUNT: "someone@example.com", TELEGRAM_USER_ID: "123456789" };

// The live scheduler as the Gateway reports it today: the weekly plan and three
// check-ins on, the morning brief and evening review installed but off, and
// unrelated jobs Hilla must never mention.
const liveJobs = [
  { name: WEEKLY_PLAN_PROPOSE_JOB, enabled: true },
  { name: WEEKLY_PLAN_APPLY_JOB, enabled: true },
  { name: routineJobName("midday-check-in"), enabled: true },
  { name: routineJobName("workout-window"), enabled: true },
  { name: routineJobName("weekly-review"), enabled: true },
  { name: routineJobName("morning-brief"), enabled: false },
  { name: routineJobName("evening-review"), enabled: false },
  { name: "Assistant weather: golf watch", enabled: false },
  { name: "Renew EU health insurance card", enabled: true },
];

function fakeCron(jobs = liveJobs, { schedulerEnabled = true, fail = false } = {}) {
  const calls = [];
  const refuse = (name) => async () => {
    throw new Error(`capability help must never call cron.${name}`);
  };
  return {
    calls,
    list: async () => {
      calls.push("list");
      if (fail) throw new Error("Gateway unreachable");
      return jobs.map((job) => ({ ...job }));
    },
    schedulerStatus: async () => {
      calls.push("status");
      return { enabled: schedulerEnabled };
    },
    get: refuse("get"),
    enable: refuse("enable"),
    disable: refuse("disable"),
    edit: refuse("edit"),
    add: refuse("add"),
    setCronExpression: refuse("setCronExpression"),
    rescheduleOneShot: refuse("rescheduleOneShot"),
  };
}

const run = (argv, overrides = {}) => runCapabilitiesCli(argv, { env, cron: fakeCron(), ...overrides });

function viewFor(filters, { setup = { todoist: "configured", google: "configured" }, jobs = liveJobs } = {}) {
  const entries = selectCapabilities(filters);
  return buildCapabilityView({
    filters,
    setup,
    schedule: scheduleOverlay(entries, { available: true, jobs, scheduler: { enabled: true } }),
  });
}

describe("capability registry", () => {
  it("gives every entry a unique id and title", () => {
    assert.equal(new Set(ids(CAPABILITIES)).size, CAPABILITIES.length);
    assert.equal(new Set(CAPABILITIES.map((entry) => entry.title.toLowerCase())).size, CAPABILITIES.length);
    for (const entry of CAPABILITIES) assert.match(entry.id, /^[a-z-]+\.[a-z-]+$/, entry.id);
  });

  it("uses only known categories, topics, statuses, effects, approvals, and setup checks", () => {
    for (const entry of CAPABILITIES) {
      assert.ok(categoryIds.includes(entry.category), `${entry.id}: ${entry.category}`);
      assert.ok(CAPABILITY_STATUSES.includes(entry.status), entry.id);
      assert.ok(CAPABILITY_EFFECTS.includes(entry.effect), entry.id);
      assert.ok(CAPABILITY_APPROVALS.includes(entry.approval), entry.id);
      assert.equal(typeof entry.automatic, "boolean", entry.id);
      assert.equal(new Set(entry.tags).size, entry.tags.length, entry.id);
      for (const tag of entry.tags) assert.ok(topicIds.has(tag), `${entry.id}: ${tag}`);
      if (entry.requires !== undefined) assert.ok(CAPABILITY_SETUP[entry.requires], `${entry.id}: ${entry.requires}`);
    }
  });

  it("gives every available entry a summary and one to three things to say", () => {
    for (const entry of availableEntries) {
      assert.ok(entry.title.trim() && entry.summary.trim(), entry.id);
      assert.match(entry.summary, /^([a-z‘“]|I ).*[.]$/, `${entry.id} summary continues "Title — ..." and ends with a full stop`);
      assert.ok(entry.examples.length >= 1 && entry.examples.length <= 3, entry.id);
      for (const example of entry.examples) {
        assert.ok(example.trim().length > 0 && example.length <= 80, `${entry.id}: ${example}`);
        assert.doesNotMatch(example, /[“”]/, `${entry.id}: inner quotes are ‘ ’ so a Try line never nests “ ”`);
      }
    }
  });

  it("gives every unavailable entry an alternative and no examples", () => {
    for (const entry of CAPABILITIES.filter((candidate) => candidate.status !== "available")) {
      assert.ok(entry.alternative?.trim(), entry.id);
      assert.deepEqual(entry.examples, [], entry.id);
      assert.equal(entry.effect, "none", entry.id);
      assert.equal(entry.approval, "none", entry.id);
      assert.equal(entry.automatic, false, entry.id);
      if (entry.status === "disabled") assert.ok(entry.note?.trim(), entry.id);
    }
  });

  it("keeps the side-effect fields consistent with each other", () => {
    for (const entry of availableEntries) {
      if (entry.effect === "none") assert.equal(entry.approval, "none", `${entry.id} changes nothing, so there is nothing to approve`);
      if (entry.effect !== "none") assert.notEqual(entry.approval, "none", `${entry.id} changes something, so it names its approval`);
      assert.equal(Boolean(entry.schedule), entry.automatic, `${entry.id}: automatic entries, and only they, name their live jobs`);
      if (entry.approval === "standing") assert.equal(entry.automatic, true, entry.id);
    }
  });

  it("describes what the user can ask for, never agents, commands, files, or job names", () => {
    for (const entry of CAPABILITIES) {
      const text = [entry.title, entry.summary, entry.limit, entry.alternative, ...entry.examples].filter(Boolean).join(" ");
      assert.doesNotMatch(text, /\b(personal|admin|health|research|specialist) agent\b/i, entry.id);
      assert.doesNotMatch(text, /npm run|\.mjs|\.json|\.openclaw|Assistant routine:|Assistant weekly plan:/, entry.id);
    }
  });

  it("pins the capabilities whose accidental loss would matter", () => {
    for (const id of [
      "planning.next-action",
      "planning.focus-session",
      "coaching.performance",
      "coaching.debrief",
      "memory.playbooks",
      "memory.preferences",
      "pending.view",
      "todoist.create",
      "todoist.update",
      "calendar.read",
      "calendar.preview",
      "weekly-plan.plan",
    ]) {
      assert.equal(capabilityById(id)?.status, "available", id);
    }
  });

  it("points every command-backed capability at a script that exists", () => {
    // Each helper behind a capability. A capability without one is defined by
    // the standing orders or a guide, and is checked in the next test.
    const scripts = {
      "planning.focus-session": "focus",
      "pending.view": "pending",
      "memory.preferences": "memory",
      "memory.sensitive": "memory",
      "memory.playbooks": "playbook",
      "todoist.read": "todoist",
      "todoist.create": "todoist",
      "todoist.update": "todoist",
      "todoist.delete": "todoist",
      "calendar.read": "calendar:plan",
      "calendar.preview": "calendar:create",
      "golf.tee-times": "mingolf",
      "golf.booking": "mingolf",
      "weekly-plan.plan": "weekly-plan",
      "routines.briefings": "routine",
      "routines.check-ins": "routines:status",
      "routines.controls": "routines:set-time",
      "routines.skip": "routines:skip",
      "system.status": "assistant:status",
      "system.schedule": "quiet:status",
      "system.schedule-change": "quiet:reschedule",
      "system.feedback": "feedback",
    };
    for (const [id, script] of Object.entries(scripts)) {
      assert.equal(capabilityById(id)?.status, "available", id);
      assert.ok(packageScripts[script], `${id} needs npm run ${script}`);
    }

    const defined = {
      "planning.next-action": () => focusGuide.includes("## What Should I Do Now"),
      "planning.project-focus": () => focusGuide.includes("## Session Context"),
      "planning.decision": () => focusGuide.includes("## Thinking Through A Decision"),
      "coaching.performance": () => personalPrompt.includes("Golf and work coaching:"),
      "coaching.sleep": () => personalPrompt.includes("Sleep coaching:"),
      "coaching.debrief": () => personalPrompt.includes("- Debrief, after a round"),
      "email.summary": () => readFileSync("docs/setup/google.md", "utf8").includes("The assistant may summarize Gmail and draft responses."),
      "health.food": () => readFileSync("agents/health/AGENTS.md", "utf8").includes("Grocery behavior:"),
      "health.training": () => readFileSync("agents/health/AGENTS.md", "utf8").includes("Encourage workouts and movement"),
      "research.lookup": () => readFileSync("agents/research/AGENTS.md", "utf8").includes("Cite sources"),
    };
    for (const [id, check] of Object.entries(defined)) assert.ok(check(), id);

    // Nothing is listed as available without one of the two.
    assert.deepEqual(ids(availableEntries).filter((id) => !scripts[id] && !defined[id]), []);
  });

  it("names the live jobs from the same config and constants the installers use", () => {
    const configured = [...schedules.daily.map((routine) => routine.id), schedules.weekly.id];
    assert.deepEqual(CHECK_IN_ROUTINES.map((routine) => routine.routineId), configured);
    assert.deepEqual(capabilityById("routines.check-ins").schedule.jobs.map((job) => job.job), configured.map(routineJobName));
    assert.deepEqual(capabilityById("weekly-plan.plan").schedule.jobs.map((job) => job.job), [WEEKLY_PLAN_PROPOSE_JOB, WEEKLY_PLAN_APPLY_JOB]);
  });
});

describe("capability boundaries", () => {
  it("describes Calendar creation as preview-only, matching the policy", () => {
    const calendar = CAPABILITIES.filter((entry) => entry.category === "calendar");
    assert.equal(policy.calendarCreationPreview.runtimeBoundary, "preview-only-no-calendar-write-tool-configured");
    for (const entry of calendar.filter((candidate) => candidate.status === "available")) {
      assert.equal(entry.effect, "none", `${entry.id} must not claim a Calendar write`);
    }
    assert.match(capabilityById("calendar.preview").summary, /Creating it isn't supported yet/);
    assert.match(capabilityById("calendar.preview").examples[0], /^Preview/);
    assert.equal(capabilityById("calendar.write").status, "not_available");
  });

  it("lists sending email, payments, and purchases as not supported", () => {
    assert.equal(capabilityById("email.summary").effect, "none");
    assert.match(capabilityById("email.summary").limit, /I don't send, archive, label or delete email/);
    for (const id of ["email.send", "golf.payment", "research.purchases"]) assert.equal(capabilityById(id).status, "not_available", id);
    assert.match(capabilityById("golf.booking").limit, /You log in yourself\. I stop before any payment, BankID, redirect or changed terms/);
  });

  it("keeps the pending view read-only, matching the policy", () => {
    const pending = capabilityById("pending.view");
    assert.equal(policy.pendingActions.readOnly, true);
    assert.equal(pending.effect, "none");
    assert.equal(pending.approval, "none");
    assert.equal(pending.automatic, false);
  });

  it("never lets coaching or focus claim task creation or automatic behavior", () => {
    for (const entry of CAPABILITIES.filter((candidate) => candidate.category === "coaching" || candidate.category === "planning")) {
      if (entry.status !== "available") continue;
      assert.equal(entry.automatic, false, entry.id);
      assert.notEqual(entry.effect, "external", entry.id);
    }
    assert.match(capabilityById("coaching.performance").limit, /only when you ask: it never creates tasks, reminders or events/);
    assert.match(capabilityById("planning.next-action").limit, /never creates, completes or moves tasks/);
    assert.equal(capabilityById("planning.focus-session").effect, "local");
    assert.match(capabilityById("planning.focus-session").limit, /No timers or reminders/);
    assert.equal(capabilityById("coaching.scheduled").status, "not_available");
  });

  it("saves playbooks and memories only on explicit intent, and sensitive details only after approval", () => {
    assert.equal(policy.personalPlaybooks.writeRequires, "explicit-request-or-yes-in-the-users-own-words");
    assert.equal(capabilityById("memory.playbooks").approval, "on_request");
    assert.match(capabilityById("memory.playbooks").limit, /Saved or changed only when you ask or say yes/);
    assert.match(capabilityById("memory.preferences").limit, /Only when you ask\. If I notice something worth keeping, I ask first/);
    assert.equal(capabilityById("memory.sensitive").approval, "required");
    assert.match(capabilityById("coaching.debrief").limit, /saved only if you say yes/);
  });

  it("describes the weekly plan's automatic execution as narrowly as its standing authorization", () => {
    const plan = capabilityById("weekly-plan.plan");
    const trusted = policy.trustedRoutines.find((routine) => routine.id === "weekly-plan");
    assert.deepEqual(trusted.allowedOperationKinds, ["create-task"]);
    assert.equal(trusted.reviewWindowHours, 12);
    assert.equal(schedules.weeklyPlan.reviewWindowHours, 12);
    assert.equal(schedules.weeklyPlan.propose.day, "Saturday");

    assert.equal(plan.approval, "standing");
    assert.match(plan.summary, /^every Saturday/);
    assert.match(plan.summary, /change, OK or cancel it before its Todoist tasks are added/);
    assert.match(plan.limit, /Unless you cancel, its Todoist tasks are added 12 hours after you last saw it, or right away when you say OK/);
    assert.match(plan.limit, /It only adds new tasks of your own: nothing is edited or deleted, and Calendar and email are never touched/);

    // It is the only standing authorization and the only automatic writer.
    assert.deepEqual(ids(availableEntries.filter((entry) => entry.approval === "standing")), ["weekly-plan.plan"]);
    assert.deepEqual(policy.trustedRoutines.map((routine) => routine.id), ["weekly-plan"]);
    assert.deepEqual(ids(availableEntries.filter((entry) => entry.automatic && entry.effect !== "none")), ["weekly-plan.plan"]);
    assert.match(capabilityById("routines.check-ins").summary, /they change nothing/);
  });

  it("keeps the disabled weather jobs out of every normal view", () => {
    assert.equal(capabilityById("golf.weather").status, "disabled");
    for (const filters of [{}, { tag: "golf" }, { category: "golf" }, { automatic: true }, { readOnly: true }]) {
      const text = formatCapabilityView(viewFor(filters));
      assert.doesNotMatch(text, /weather/i, JSON.stringify(filters));
      assert.ok(!ids(selectCapabilities(filters)).includes("golf.weather"), JSON.stringify(filters));
    }
    const developer = formatCapabilityView(viewFor({ all: true }));
    assert.match(developer, /- Disabled: golf weather alerts\. I can look up the forecast when you ask\./);
    assert.match(developer, /switched off, and the script they call is not on main/);
  });

  it("marks approval-gated actions the same way the policy gates them", () => {
    const gated = ids(availableEntries.filter((entry) => entry.approval === "required"));
    assert.deepEqual(gated, ["memory.sensitive", "todoist.delete", "golf.booking", "routines.skip", "system.schedule-change"]);
    assert.ok(policy.lowRiskTodoistTaskChanges.approvalStillRequiredWhen.includes("delete-reopen-or-move-task"));
    assert.ok(policy.approvalRequired.find((rule) => rule.domain === "memory").actions.includes("remember-sensitive-preference"));
    assert.ok(policy.approvalRequired.find((rule) => rule.domain === "min-golf").actions.includes("book-tee-time"));
    assert.match(personalPrompt, /Actions requiring explicit Telegram approval: routine skip\/unskip, quiet-ops mutations/);

    for (const [id, action] of [
      ["todoist.create", "create-explicit-complete-todoist-task"],
      ["todoist.update", "complete-explicit-personal-todoist-task"],
      ["memory.preferences", "remember-explicit-low-risk-memory"],
      ["planning.focus-session", "manage-local-focus-session-state"],
      ["system.feedback", "capture-explicit-local-feedback"],
      ["calendar.preview", "build-explicit-complete-calendar-creation-preview"],
      ["golf.tee-times", "search-min-golf-tee-time-availability"],
    ]) {
      assert.ok(policy.allowedWithoutExtraApproval.includes(action), `${id}: ${action}`);
      assert.notEqual(capabilityById(id).approval, "required", id);
    }
  });
});

describe("capability views", () => {
  it("shows the full list in one Telegram message, one line per capability", () => {
    const text = formatCapabilityView(viewFor({}));
    assert.ok(text.length < 4096, `the full list is ${text.length} characters`);
    assert.match(text, /^Here's what I can do\n\n/);
    for (const category of CAPABILITY_CATEGORIES) assert.ok(text.includes(`\n${category.title}\n`), category.id);
    for (const entry of availableEntries) assert.ok(text.includes(`- ${entry.title}`), entry.id);
    assert.match(text, /- Book a tee time \(needs your OK\) — /);
    assert.match(text, /- Weekly plan \(automatic\) — every Saturday .* Switched on\./);
    assert.match(text, /Not supported directly: .*create or change Calendar events.*send, archive or delete email/);
    assert.match(text, /Try: “I have 45 minutes\. What should I do\?” · “Coach me before my round” · “Anything waiting on me\?”/);
    assert.doesNotMatch(text, /\n  Try:/, "the full list leaves examples to the narrowed views");
  });

  it("filters by category", () => {
    const view = viewFor({ category: "todoist" });
    assert.deepEqual(ids(view.capabilities), ["todoist.read", "todoist.create", "todoist.update", "todoist.delete", "todoist.bulk"]);
    assert.match(formatCapabilityView(view), /^Todoist: what I can do\n/);
  });

  it("filters by topic across categories, keeping that topic's boundaries", () => {
    const golf = viewFor({ tag: "golf" });
    assert.deepEqual(ids(golf.capabilities), [
      "coaching.performance",
      "coaching.debrief",
      "memory.playbooks",
      "golf.tee-times",
      "golf.booking",
      "golf.payment",
      "weekly-plan.plan",
    ]);
    const text = formatCapabilityView(golf);
    assert.match(text, /^Golf: what I can do\n/);
    assert.match(text, /  Try: “Coach me before my round”/);
    assert.match(text, /- Not supported: pay for, cancel or check in to a booking\. I stop before payment; you finish it in Min Golf\./);

    const calendar = formatCapabilityView(viewFor({ tag: "calendar" }));
    assert.match(calendar, /- Preview a new event — check one new event's details\. Creating it isn't supported yet\./);
    assert.match(calendar, /- Not supported: create or change Calendar events\. I can preview a new event or suggest a change for you to make\./);

    const todoist = ids(viewFor({ tag: "todoist" }).capabilities);
    assert.ok(todoist.includes("weekly-plan.plan") && todoist.includes("planning.next-action") && todoist.includes("todoist.create"));
    assert.ok(ids(viewFor({ tag: "sleep" }).capabilities).includes("coaching.sleep"));
    assert.ok(ids(viewFor({ tag: "work" }).capabilities).includes("planning.focus-session"));
  });

  it("lists only what runs on its own, with what is switched on", () => {
    const view = viewFor({ automatic: true });
    assert.deepEqual(ids(view.capabilities), ["weekly-plan.plan", "routines.check-ins"]);
    const text = formatCapabilityView(view);
    assert.match(text, /^What I do automatically\n/);
    assert.match(text, /On now: midday check-in, workout window and Sunday weekly review\. Off: morning brief and evening review\./);
    assert.match(text, /Only the weekly plan can change anything on its own\. Everything else waits for you to ask\./);
    assert.doesNotMatch(text, /\(automatic\)/);
  });

  it("lists what needs an OK, what is done on a plain request, and the one standing permission", () => {
    const view = viewFor({ requiresApproval: true });
    assert.ok(view.capabilities.every((entry) => entry.approval === "required"));
    const text = formatCapabilityView(view);
    assert.match(text, /^What needs your OK first\n/);
    assert.match(text, /act only after a clear yes/);
    assert.match(text, /Done when you ask, with no second OK: focus sessions, remember things, personal playbooks, add tasks, change one task, change a check-in and feedback\./);
    assert.match(text, /The weekly plan runs under the standing permission you gave it: it applies after its review window unless you cancel\./);
    assert.doesNotMatch(text, /\(needs your OK\)/);
  });

  it("lists what only reads or advises", () => {
    const view = viewFor({ readOnly: true });
    assert.ok(view.capabilities.length > 0);
    assert.ok(view.capabilities.every((entry) => entry.effect === "none" && entry.status === "available"));
    assert.ok(!ids(view.capabilities).includes("todoist.create"));
    assert.ok(ids(view.capabilities).includes("calendar.preview"));
  });

  it("combines filters and says so when nothing matches", () => {
    assert.deepEqual(ids(viewFor({ tag: "golf", requiresApproval: true }).capabilities), ["golf.booking"]);
    const text = formatCapabilityView(viewFor({ tag: "email", automatic: true }));
    assert.match(text, /Nothing I can do matches that/);
  });

  it("orders every view the same way every time", () => {
    const first = JSON.stringify(viewFor({}));
    assert.equal(JSON.stringify(viewFor({})), first);
    const shown = viewFor({}).capabilities.map((entry) => categoryIds.indexOf(entry.category));
    assert.deepEqual(shown, [...shown].sort((left, right) => left - right));
    assert.deepEqual(capabilityTopics(), [...capabilityTopics()].sort());
  });

  it("uses only available examples in the Try line", () => {
    for (const id of TRY_FIRST) assert.equal(capabilityById(id)?.status, "available", id);
    assert.deepEqual(viewFor({}).footer.tryExamples, TRY_FIRST.map((id) => capabilityById(id).examples[0]));
  });
});

describe("capability overlays", () => {
  it("reports configuration from the environment, never as proof that something works", () => {
    assert.deepEqual(capabilitySetup(env), { todoist: "configured", google: "configured" });
    assert.deepEqual(capabilitySetup({}), { todoist: "missing", google: "missing" });

    const text = formatCapabilityView(viewFor({}, { setup: capabilitySetup({ GMAIL_ACCOUNT: "someone@example.com" }) }));
    assert.match(text, /- Add tasks — .* Needs Todoist, which isn't set up here\./);
    assert.match(text, /- Weekly plan \(automatic\) — .* Needs Todoist, which isn't set up here\./);
    assert.doesNotMatch(text, /Needs Google Calendar and Gmail/);
    assert.doesNotMatch(formatCapabilityView(viewFor({})), /isn't set up here/);
  });

  it("says what the live scheduler has switched on, per entry", () => {
    const partly = [...liveJobs.filter((job) => job.name !== WEEKLY_PLAN_APPLY_JOB), { name: WEEKLY_PLAN_APPLY_JOB, enabled: false }];
    const overlay = scheduleOverlay(CAPABILITIES, { available: true, jobs: partly, scheduler: { enabled: true } });
    assert.equal(describeSchedule(overlay["weekly-plan.plan"]), "Only partly on right now: the automatic apply check is off.");

    const noPlan = scheduleOverlay(CAPABILITIES, { available: true, jobs: [], scheduler: { enabled: true } });
    assert.equal(describeSchedule(noPlan["weekly-plan.plan"]), "Switched off right now.");
    assert.equal(
      describeSchedule(noPlan["routines.check-ins"]),
      "None are on right now. Not set up: morning brief, midday check-in, workout window, evening review and Sunday weekly review.",
    );

    const schedulerOff = scheduleOverlay(CAPABILITIES, { available: true, jobs: liveJobs, scheduler: { enabled: false } });
    assert.equal(describeSchedule(schedulerOff["weekly-plan.plan"]), "The scheduler is switched off, so none of this runs right now.");
    assert.equal(schedulerOff["weekly-plan.plan"].state, "off");
  });

  it("reports a scheduler it could not read as unchecked, never as on or off", () => {
    for (const snapshot of [null, { available: false, jobs: [] }, { available: true }]) {
      const overlay = scheduleOverlay(CAPABILITIES, snapshot);
      for (const id of ["weekly-plan.plan", "routines.check-ins"]) {
        assert.equal(overlay[id].state, "unchecked", id);
        assert.equal(describeSchedule(overlay[id]), "I couldn't check what's switched on right now.");
      }
    }
  });

  it("reads the scheduler only for views that show a scheduled capability", async () => {
    assert.equal(needsScheduleOverlay(selectCapabilities({ category: "todoist" })), false);
    assert.equal(needsScheduleOverlay(selectCapabilities({ requiresApproval: true })), false);
    assert.equal(needsScheduleOverlay(selectCapabilities({})), true);

    const quiet = fakeCron();
    await run(["--category", "todoist"], { cron: quiet });
    assert.deepEqual(quiet.calls, []);

    const busy = fakeCron();
    const result = await run(["--automatic"], { cron: busy });
    assert.deepEqual([...busy.calls].sort(), ["list", "status"]);
    assert.match(result.text, /Switched on\./);
  });

  it("keeps working when the scheduler cannot be reached", async () => {
    const result = await run([], { cron: fakeCron(liveJobs, { fail: true }) });
    assert.match(result.text, /- Weekly plan \(automatic\) — .* I couldn't check what's switched on right now\./);
    assert.doesNotMatch(result.text, /Switched on\.|On now:/);
  });
});

describe("capabilities CLI", () => {
  it("parses only its own options, topics, and categories", () => {
    assert.deepEqual(parseCapabilitiesArgs([]), { command: "list", json: false, filters: {} });
    assert.deepEqual(parseCapabilitiesArgs(["--tag", "Golf", "--json"]), { command: "list", json: true, filters: { tag: "golf" } });
    assert.deepEqual(parseCapabilitiesArgs(["--automatic", "--requires-approval", "--read-only", "--all"]).filters, {
      automatic: true,
      requiresApproval: true,
      readOnly: true,
      all: true,
    });
    assert.deepEqual(parseCapabilitiesArgs(["guide"]), { command: "guide", json: false, filters: {} });
    assert.throws(() => parseCapabilitiesArgs(["--tag"]), /--tag requires a value/);
    assert.throws(() => parseCapabilitiesArgs(["--tag", "weather"]), /Unknown topic: weather\. Topics: /);
    assert.throws(() => parseCapabilitiesArgs(["--category", "golfing"]), /Unknown category: golfing/);
    assert.throws(() => parseCapabilitiesArgs(["--send"]), /Unknown capabilities option: --send/);
    assert.throws(() => parseCapabilitiesArgs(["guide", "--json"]), /guide does not accept options/);
  });

  it("returns the view as JSON-safe data with its text", async () => {
    const result = await run(["--json"]);
    const parsed = JSON.parse(JSON.stringify(result));
    assert.equal(parsed.title, "Here's what I can do");
    assert.equal(parsed.capabilities.length, CAPABILITIES.filter((entry) => entry.status !== "disabled").length);
    const plan = parsed.capabilities.find((entry) => entry.id === "weekly-plan.plan");
    assert.deepEqual(
      { automatic: plan.automatic, effect: plan.effect, approval: plan.approval, setup: plan.setup, state: plan.schedule.state },
      { automatic: true, effect: "external", approval: "standing", setup: "configured", state: "on" },
    );
    assert.deepEqual(plan.schedule.jobs, [
      { label: "the Saturday proposal", state: "on" },
      { label: "the automatic apply check", state: "on" },
    ]);
    assert.equal(parsed.text, formatCapabilityView(viewFor({})));
  });

  it("never prints secrets, chat ids, job names, or unrelated live jobs", async () => {
    for (const argv of [[], ["--json"], ["--automatic", "--json"], ["--all", "--json"], ["guide"]]) {
      const output = JSON.stringify(await run(argv));
      for (const leak of [SECRET, env.TELEGRAM_USER_ID, env.GMAIL_ACCOUNT, "Assistant routine:", "Assistant weekly plan:", "Renew EU health insurance card", "Assistant weather"]) {
        assert.ok(!output.includes(leak), `${argv.join(" ")} leaked ${leak}`);
      }
    }
  });

  it("prints the guide with the topics and the full list", async () => {
    const { text } = await run(["guide"]);
    assert.ok(text.startsWith(readFileSync(CAPABILITIES_GUIDE_PATH, "utf8").trim()));
    assert.ok(text.includes(`Topics for \`--tag\`: ${capabilityTopics().join(", ")}.`));
    assert.ok(text.endsWith(formatCapabilityView(viewFor({}))));
  });

  it("treats every help question as a plain answer, never as an action", () => {
    for (const message of [
      "What can you do?",
      "Help",
      "Show me your features",
      "What can you do with Todoist?",
      "What golf features do you have?",
      "What can you do automatically?",
      "What needs my approval?",
      "What can you do with Calendar?",
      "What could you help me with right now?",
    ]) {
      const result = buildInboxClassifierDebug({ message });
      assert.equal(result.action.mode, "answer_only", message);
      assert.equal(result.sideEffecting, false, message);
      assert.equal(result.approvalRequired, false, message);
    }
  });
});
