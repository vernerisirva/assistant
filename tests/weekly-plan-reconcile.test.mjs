import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWeeklyPlanCli } from "../scripts/weekly-plan.mjs";
import { createWeeklyPlanStore, versionEntry } from "../scripts/lib/weekly-plan-store.mjs";
import { planReconciliation } from "../scripts/lib/weekly-plan-reconcile.mjs";

const schedules = JSON.parse(readFileSync("config/schedules.json", "utf8"));
const PLAN_ID = "wp-2026-W44-abc123";
const SHOWN = "2026-10-24T07:01:13.000Z";
const DEADLINE = "2026-10-24T19:15:00.000Z";
const LATER = "2026-10-24T19:15:31.000Z";
const MESSAGE = "Maybe 9 holes on friday, 18 on saturday and sunday. Golf practice on mon-friday and gym on tuesday and thursday";
const DAY = Object.freeze({ mon: "2026-10-26", tue: "2026-10-27", wed: "2026-10-28", thu: "2026-10-29", fri: "2026-10-30", sat: "2026-10-31", sun: "2026-11-01" });
const CHANGE = Object.freeze({
  golf: {
    replyText: MESSAGE,
    addRounds: [{ day: "friday", holes: 9, tentative: true }, { day: "saturday", holes: 18 }, { day: "sunday", holes: 18 }],
    practiceDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  },
  activityDays: { gym: ["tuesday", "thursday"] },
});

/** A Todoist that behaves like the real one for the calls a reconciliation makes, and lets the test act as the user. */
function fakeTodoist() {
  const tasks = [];
  const completed = new Map();
  const calls = { addTask: [], updateTask: [], deleteTask: [], forbidden: [] };
  const failing = new Set();
  let nextId = 9000;
  const forbidden = (name) => async () => {
    calls.forbidden.push(name);
    throw new Error(`${name} must never be called here`);
  };
  const find = (id) => tasks.find((task) => task.id === id);
  return {
    tasks,
    calls,
    failing,
    async getTasks() {
      return tasks.map((task) => structuredClone(task));
    },
    async getTask(id) {
      if (find(id)) return structuredClone(find(id));
      if (completed.has(id)) return { ...structuredClone(completed.get(id)), checked: true };
      throw new Error("Todoist API request failed: 404 Task not found");
    },
    async addTask(payload) {
      calls.addTask.push(structuredClone(payload));
      if (failing.has(payload.content)) throw new Error("Todoist API request failed: 500 Internal error");
      const task = { id: String(nextId++), content: payload.content, description: payload.description ?? "", due: { date: payload.due_string, string: payload.due_string } };
      tasks.push(task);
      return structuredClone(task);
    },
    async updateTask(id, fields) {
      calls.updateTask.push({ id, fields: structuredClone(fields) });
      if (failing.has(id)) throw new Error("Todoist API request failed: 500 Internal error");
      const task = find(id);
      if (!task) throw new Error("Todoist API request failed: 404 Task not found");
      Object.assign(task, { content: fields.content, description: fields.description, due: { date: fields.due_string, string: fields.due_string } });
      return structuredClone(task);
    },
    async deleteTask(id) {
      calls.deleteTask.push(id);
      const index = tasks.findIndex((task) => task.id === id);
      if (index < 0) throw new Error("Todoist API request failed: 404 Task not found");
      tasks.splice(index, 1);
      return true;
    },
    closeTask: forbidden("closeTask"),
    reopenTask: forbidden("reopenTask"),
    moveTask: forbidden("moveTask"),
    addComment: forbidden("addComment"),
    // The user, in Todoist itself.
    edit(id, fields) {
      Object.assign(find(id), fields);
    },
    complete(id) {
      completed.set(id, find(id));
      tasks.splice(tasks.indexOf(find(id)), 1);
    },
    remove(id) {
      tasks.splice(tasks.indexOf(find(id)), 1);
    },
    addOwn(content, date) {
      const task = { id: String(nextId++), content, description: "", due: { date, string: date } };
      tasks.push(task);
      return task;
    },
    mutations() {
      return calls.addTask.length + calls.updateTask.length + calls.deleteTask.length;
    },
  };
}

describe("weekly plan: a change after the plan was applied", () => {
  let stateDir;
  let clock;
  let todoist;

  const context = (extra = {}) => ({
    stateDir,
    memoryPath: join(stateDir, "memory.json"),
    env: { TELEGRAM_USER_ID: "1029709001" },
    schedules,
    todoistClient: todoist,
    sendMessage: async () => ({ messageId: 1 }),
    now: () => clock,
    random: () => "abc123",
    sleep: async () => {},
    retryDelaysMs: [0, 0],
    lockWaitMs: 1_000,
    ...extra,
  });
  const run = (argv, extra) => runWeeklyPlanCli(argv, context(extra));
  const reconcile = (changes) => run(["reconcile", "--changes-json", JSON.stringify(changes)]);
  const approve = (proposalId, reply = "Approve") => run(["reconcile-apply", "--proposal-id", proposalId, "--reply-text", reply]);
  const plan = () => createWeeklyPlanStore({ stateDir }).readPlan(PLAN_ID);
  const at = (iso) => {
    clock = new Date(iso);
  };
  const taskOf = (opId) => todoist.tasks.find((task) => task.id === plan().apply.outcomes[opId].taskId);
  const byDay = () => {
    const days = {};
    for (const task of todoist.tasks) (days[task.due.date] ??= []).push(task.content);
    return days;
  };
  const applyWeek = async () => {
    at(SHOWN);
    await run(["propose", "--send"]);
    at(DEADLINE);
    assert.match((await run(["apply-due"])).text, /^Applied weekly plan · 26 Oct–1 Nov · v1\n/);
    at(LATER);
    return versionEntry(plan(), 1).plan.operations.length;
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "weekly-plan-reconcile-"));
    writeFileSync(join(stateDir, "memory.json"), `${JSON.stringify({ version: 1, entries: [] })}\n`);
    todoist = fakeTodoist();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("proposes exactly what the change needs, keeps what fits, and changes nothing before an explicit approval", async () => {
    const created = await applyWeek();
    const before = todoist.mutations();
    const proposal = await reconcile(CHANGE);
    assert.deepEqual([proposal.status, proposal.proposalId], ["proposed", "r1"]);
    assert.equal(todoist.mutations(), before, "proposing changes nothing in Todoist");

    const record = plan().reconciliations[0];
    const changes = record.changes.map((change) => `${change.action} ${change.fromOpId ? `${change.fromOpId}→` : ""}${change.opId}`);
    // Sunday's round is the only missing task; Monday's gym moves to Tuesday instead of a delete and a new task.
    assert.deepEqual(changes.filter((change) => change.startsWith("create")), [`create golf:${DAY.sun}`]);
    assert.ok(changes.includes(`update gym:${DAY.mon}→gym:${DAY.tue}`), changes.join(", "));
    assert.deepEqual(changes.filter((change) => change.startsWith("delete")), []);
    assert.ok(changes.includes(`update golf:${DAY.sat}`), "Saturday's practice becomes the 18-hole round");
    for (const activity of ["stretch", "mealPrep", "shopping"]) {
      assert.ok(!record.changes.some((change) => change.activity === activity), `${activity} already fits`);
    }
    assert.ok(record.kept.some((entry) => entry.opId === `gym:${DAY.thu}`), "Thursday's gym already fits");

    assert.match(proposal.telegramText, /^Weekly plan · 26 Oct–1 Nov: changes for your approval\nYour change: Gym Tue, Thu · Golf: \+ maybe 9 holes Fri/);
    assert.match(proposal.telegramText, /\n\nAdd:\n• Sun 1 Nov — Golf — 18-hole round\n/);
    assert.match(proposal.telegramText, /\n• Tue 27 Oct — Gym – Helkropp A, måndag → Gym – Helkropp A, tisdag \(title, date, from Mon\)\n/);
    // New details are named in one line each, never pasted whole.
    assert.match(proposal.telegramText, /\n• Mon 26 Oct — Golf practice — Wedges \(details\), now Session · 45 min\n/);
    assert.match(proposal.telegramText, /\n• Sat 31 Oct — Golf practice — On-course practice → Golf — 18-hole round \(title, details\)\n/);
    assert.match(proposal.telegramText, /\nUnchanged: \d+ tasks already fit\.\n/);
    assert.match(proposal.telegramText, /\nAgent: Personal\nAction: Add 1 task, change \d+ in Todoist for the weekly plan of 26 Oct–1 Nov\nExpected effect: those tasks match your change; nothing else in Todoist changes\.\nRisk: changed tasks get the new title, details or date\.\nReply Approve to make exactly these changes, or No to leave the tasks as they are\.$/);

    // No is not approval, and a question isn't either.
    for (const reply of ["No", "Is that everything?", "maybe"]) {
      const declined = await approve("r1", reply);
      assert.equal(declined.status, "not_approved", reply);
    }
    assert.equal(todoist.mutations(), before, "a declined proposal changes nothing");

    const done = await approve("r1");
    assert.equal(done.status, "applied");
    assert.match(done.telegramText, /^Changed the weekly plan's tasks · 26 Oct–1 Nov\nDone: \d+ · Failed: 0$/);
    assert.equal(todoist.calls.addTask.length - created, 1, "one task added, the week is never created again");
    assert.equal(todoist.calls.deleteTask.length, 0);
    assert.equal(todoist.calls.updateTask.length, record.changes.filter((change) => change.action === "update").length);
    const days = byDay();
    for (const [date, titles] of Object.entries(days)) {
      const golf = titles.filter((title) => title.startsWith("Golf"));
      const gym = titles.filter((title) => title.startsWith("Gym"));
      assert.ok(golf.length <= 1 && gym.length <= 1, `${date}: ${titles.join(", ")}`);
    }
    assert.deepEqual(Object.keys(days).filter((date) => days[date].some((title) => title.startsWith("Golf"))).sort(), Object.values(DAY));
    assert.deepEqual(Object.keys(days).filter((date) => days[date].some((title) => title.startsWith("Gym"))).sort(), [DAY.tue, DAY.thu]);
    assert.deepEqual(days[DAY.sat].filter((title) => title.startsWith("Golf")), ["Golf — 18-hole round"]);
    assert.match(todoist.tasks.find((task) => task.due.date === DAY.fri && task.content.startsWith("Golf")).description, /Possible round\nIf the 9-hole round is on, play it instead of this session\./);
    assert.deepEqual(todoist.calls.forbidden, []);

    // Asked again, nothing is left to change, and the approved proposal is never redone.
    const again = await reconcile(CHANGE);
    assert.equal(again.status, "unchanged");
    assert.match(again.telegramText, /^Weekly plan · 26 Oct–1 Nov: nothing to change in Todoist\n/);
    assert.match((await approve("r1")).telegramText ?? "", /^Those changes were already made\./);
    assert.equal(todoist.calls.addTask.length - created, 1);
  });

  it("leaves tasks the user changed, completed or made alone, and adds no second task for an activity already on that day", async () => {
    await applyWeek();
    todoist.edit(taskOf(`golf:${DAY.fri}`).id, { content: "Golf round — 9 holes, Friday", description: "Round · 9 holes" });
    todoist.complete(taskOf(`golf:${DAY.tue}`).id);
    const own = todoist.addOwn("Golf round — 18 holes, Sunday", DAY.sun);
    const proposal = await reconcile(CHANGE);
    const record = plan().reconciliations[0];
    const alone = Object.fromEntries(record.leftAlone.map((entry) => [entry.opId, entry.reason]));
    assert.deepEqual(alone, { [`golf:${DAY.tue}`]: "done", [`golf:${DAY.fri}`]: "edited", [`golf:${DAY.sun}`]: "covered" });
    assert.ok(!record.changes.some((change) => [taskOf(`golf:${DAY.fri}`).id, own.id].includes(change.taskId)));
    assert.ok(!record.changes.some((change) => change.opId === `golf:${DAY.sun}` || change.opId === `golf:${DAY.tue}`));
    assert.match(proposal.telegramText, /\nLeft as they are:\n• Tue 27 Oct — Golf practice — .+: already completed\n• Fri 30 Oct — Golf round — 9 holes, Friday: changed in Todoist since the plan made it\n• Sun 1 Nov — Golf round — 18 holes, Sunday: that day already has this activity in Todoist\n/);
  });

  it("adds back a session the user deleted when the change asks for that day again", async () => {
    await applyWeek();
    // As on 24 Oct: Wednesday's practice was deleted, and the user wants practice Monday to Friday.
    todoist.remove(taskOf(`golf:${DAY.wed}`).id);
    await reconcile(CHANGE);
    const record = plan().reconciliations[0];
    assert.ok(record.changes.some((change) => change.action === "create" && change.opId === `golf:${DAY.wed}`));
    // A change about something else leaves the removed session removed.
    const unrelated = await reconcile({ targets: { stretch: 4 } });
    const second = plan().reconciliations.find((entry) => entry.id === unrelated.proposalId);
    assert.ok(!second.changes.some((change) => change.opId === `golf:${DAY.wed}`));
    assert.deepEqual(second.leftAlone.find((entry) => entry.opId === `golf:${DAY.wed}`)?.reason, "removed");
    assert.match(unrelated.telegramText, /\n• Wed 28 Oct — Golf practice — .+: removed from Todoist, so not added back\n/);
    assert.equal(plan().reconciliations[0].status, "superseded", "an unapproved proposal is closed by the next one");
  });

  it("refuses a stale approval: if Todoist changed after the proposal, nothing is changed", async () => {
    await applyWeek();
    const proposal = await reconcile(CHANGE);
    const record = plan().reconciliations[0];
    const target = record.changes.find((change) => change.action === "update");
    todoist.edit(target.taskId, { description: "My own notes" });
    const before = todoist.mutations();
    const stale = await approve(proposal.proposalId);
    assert.equal(stale.status, "stale");
    assert.match(stale.telegramText, /^Todoist changed since I proposed this, so nothing was changed:\n• .+ was changed\.\n\nAsk me again and I'll compare the tasks afresh\.$/);
    assert.equal(todoist.mutations(), before);
    assert.equal(plan().reconciliations[0].status, "stale");
    assert.equal((await approve(proposal.proposalId)).status, "stale", "a stale proposal stays refused");
    // Somebody adding the very task the proposal would add makes it stale too.
    const fresh = await reconcile(CHANGE);
    todoist.addOwn("Golf — 18-hole round", DAY.sun);
    assert.equal((await approve(fresh.proposalId)).status, "stale");
  });

  it("reports partial failures as they are and retries nothing", async () => {
    await applyWeek();
    await reconcile(CHANGE);
    const record = plan().reconciliations[0];
    const failing = record.changes.find((change) => change.action === "update");
    todoist.failing.add(failing.taskId);
    const result = await approve("r1");
    assert.equal(result.status, "applied_with_errors");
    assert.match(result.telegramText, /^Changed the weekly plan's tasks, with errors · 26 Oct–1 Nov\nDone: \d+ · Failed: 1\n- .+: Todoist API request failed: 500 Internal error\n\nFailed changes are not retried\. Ask me to look again if you want them made\.$/);
    const updates = todoist.calls.updateTask.length;
    assert.match((await approve("r1")).telegramText, /^Those changes were already made\./);
    assert.equal(todoist.calls.updateTask.length, updates, "nothing is retried");
    // Asking again starts from what really happened: only the failed change is left.
    todoist.failing.clear();
    await reconcile(CHANGE);
    const next = plan().reconciliations.at(-1);
    assert.deepEqual(next.changes.map((change) => change.taskId), [failing.taskId]);
  });

  it("resumes a stopped approval without doing anything twice, and skips a change whose task changed meanwhile", async () => {
    await applyWeek();
    await reconcile(CHANGE);
    const record = plan().reconciliations[0];
    const create = record.changes.find((change) => change.action === "create");
    const update = record.changes.find((change) => change.action === "update");
    // Stopped right after the new task reached Todoist, before its outcome was saved.
    const path = join(stateDir, "weekly-plan/plans", `${PLAN_ID}.json`);
    const document = JSON.parse(readFileSync(path, "utf8"));
    document.reconciliations[0] = { ...document.reconciliations[0], status: "applying", approvedAt: LATER, outcomes: { [create.id]: { status: "in_progress" } } };
    writeFileSync(path, JSON.stringify(document));
    todoist.addOwn(create.payload.content, create.date);
    todoist.edit(update.taskId, { description: "My own notes" });
    const adds = todoist.calls.addTask.length;

    const resumed = await approve("r1");
    assert.equal(resumed.status, "applied_with_errors");
    assert.equal(todoist.calls.addTask.length, adds, "the task that reached Todoist is not added again");
    const outcomes = plan().reconciliations[0].outcomes;
    assert.deepEqual([outcomes[create.id].status, outcomes[create.id].recovered], ["done", true]);
    assert.match(outcomes[update.id].error, /^Not made: .+ was changed\.$/);
    assert.ok(!todoist.calls.updateTask.some((call) => call.id === update.taskId), "a task the user changed is never overwritten");
  });

  it("reports a plan task the user moved once, on its new day, and adds no second one there", async () => {
    await applyWeek();
    // As on 24 Oct: one of the plan's gym sessions was moved by hand to a day the change wants gym anyway.
    const monday = taskOf(`gym:${DAY.mon}`);
    todoist.edit(monday.id, { content: "Gym – Helkropp A, tisdag", due: { date: DAY.tue, string: DAY.tue } });
    const proposal = await reconcile(CHANGE);
    const record = plan().reconciliations[0];
    assert.ok(!record.changes.some((change) => change.taskId === monday.id || (change.activity === "gym" && change.date === DAY.tue)), "no second gym on Tuesday");
    assert.deepEqual(record.leftAlone.filter((entry) => entry.title === "Gym – Helkropp A, tisdag").map((entry) => [entry.date, entry.reason]), [[DAY.tue, "edited"]]);
    assert.match(proposal.telegramText, /\n• Tue 27 Oct — Gym – Helkropp A, tisdag: changed in Todoist since the plan made it\n/);
  });

  it("never changes or removes a task the apply found already in Todoist: it is the user's", async () => {
    at(SHOWN);
    await run(["propose", "--send"]);
    const v1 = versionEntry(plan(), 1).plan;
    const stretch = v1.operations.find((operation) => operation.activity === "stretch");
    // The user already had this exact task before the plan applied, so the apply reused it.
    const own = todoist.addOwn(stretch.payload.content, stretch.date);
    todoist.edit(own.id, { description: stretch.payload.description });
    at(DEADLINE);
    await run(["apply-due"]);
    assert.equal(plan().apply.outcomes[stretch.opId].status, "already_exists");
    at(LATER);
    // A change that drops that day's stretching would remove the plan's own session, but not the user's.
    const others = v1.operations.filter((operation) => operation.activity === "stretch" && operation.opId !== stretch.opId).map((operation) => operation.date);
    const proposal = await reconcile({ activityDays: { stretch: others } });
    const record = plan().reconciliations[0];
    assert.ok(!record.changes.some((change) => change.taskId === own.id), "the user's task is never touched");
    assert.deepEqual(record.leftAlone.find((entry) => entry.title === stretch.payload.content)?.reason, "yours");
    assert.match(proposal.telegramText, /: the plan didn't make it, so it stays as it is\n/);
  });

  it("refuses the whole proposal, before any change, when Todoist can't do one of its operations", async () => {
    await applyWeek();
    await reconcile(CHANGE);
    const { updateTask, ...withoutUpdates } = todoist;
    const before = todoist.mutations();
    const refused = await run(["reconcile-apply", "--proposal-id", "r1", "--reply-text", "Approve"], { todoistClient: withoutUpdates });
    assert.equal(refused.status, "proposed");
    assert.match(refused.telegramText, /^Todoist can't make all of these changes from here \(updateTask is missing\), so nothing was changed\.$/);
    assert.equal(todoist.mutations(), before, "no change was made");
    assert.equal((await approve("r1")).status, "applied", "with the full client the same proposal still goes through");
  });

  it("stops safely: no reconcile before the plan is applied, and nothing stored when the change isn't in the user's words", async () => {
    at(SHOWN);
    await run(["propose", "--send"]);
    await assert.rejects(reconcile(CHANGE), /hasn't been applied yet; change it with revise/);
    at(DEADLINE);
    await run(["apply-due"]);
    const unclear = await reconcile({ golf: { replyText: "More golf", addRounds: [{ day: "wednesday", holes: 18 }] } });
    assert.equal(unclear.status, "clarify");
    assert.equal(plan().reconciliations, undefined, "nothing stored");
    await assert.rejects(approve("r9"), /There is no open proposal r9/);
  });
});

describe("weekly plan reconciliation, approval and policy", () => {
  it("is ordinary approval-gated Todoist work, never part of the standing authorization", () => {
    const policy = JSON.parse(readFileSync("config/approval-policy.json", "utf8"));
    assert.deepEqual(policy.weeklyPlanReconciliation, {
      appliesTo: "the-applied-weekly-plans-own-tasks-for-its-week",
      writesRequire: "explicit-approval-of-the-exact-stored-proposal",
      allowedChanges: ["create-task", "change-title-description-or-date", "delete-task"],
      refusesStaleApproval: true,
      leavesAlone: [
        "tasks-changed-since-the-plan-made-them",
        "completed-tasks",
        "tasks-the-user-removed-unless-the-change-is-about-them",
        "tasks-the-plan-did-not-make",
      ],
      neverRecreatesTheWeek: true,
      partOfStandingAuthorization: false,
    });
    const trusted = policy.trustedRoutines.find((routine) => routine.id === "weekly-plan");
    for (const forbidden of ["delete-todoist-task", "modify-existing-todoist-task", "move-todoist-task"]) assert.ok(trusted.notAuthorized.includes(forbidden), forbidden);
    // The automatic apply still has no way to edit or delete; only the approval-gated reconciliation does.
    const apply = readFileSync("scripts/lib/weekly-plan-apply.mjs", "utf8");
    assert.doesNotMatch(apply, /updateTask|deleteTask|weekly-plan-reconcile/);
    const reconcile = readFileSync("scripts/lib/weekly-plan-reconcile.mjs", "utf8");
    assert.doesNotMatch(reconcile, /closeTask|reopenTask|moveTask|addComment|project_id:/);
    assert.match(reconcile, /if \(!isApprovalMessage\(replyText, \{ hasPendingApproval: true \}\)\) \{\n    return \{ status: "not_approved"/);
  });
});

describe("weekly plan reconciliation, planned", () => {
  const op = (activity, date, content, description = "") => ({ opId: `${activity}:${date}`, activity, date, payload: { content, description, due_string: date } });
  const expect = (taskId, content, date, { description = "", owned = true } = {}) => ({ taskId, content, description, due: date, owned });
  const task = (id, content, date, description = "") => ({ id, content, description, due: { date } });

  it("moves an unchanged session to its new day instead of deleting and adding, and skips days that have passed", () => {
    const planned = planReconciliation({
      expected: {
        [`gym:${DAY.mon}`]: expect("1", "Gym – Helkropp A, måndag", DAY.mon),
        [`gym:${DAY.thu}`]: expect("2", "Gym – Helkropp B, torsdag", DAY.thu),
        [`stretch:${DAY.mon}`]: expect("3", "Rörlighet – Måndag, 15 minuter", DAY.mon),
      },
      target: [op("gym", DAY.tue, "Gym – Helkropp A, tisdag"), op("gym", DAY.thu, "Gym – Helkropp B, torsdag")],
      openTasks: [task("1", "Gym – Helkropp A, måndag", DAY.mon), task("2", "Gym – Helkropp B, torsdag", DAY.thu), task("3", "Rörlighet – Måndag, 15 minuter", DAY.mon)],
      today: DAY.tue,
    });
    // Monday has passed: its stretch stays, and its gym is not moved from the past.
    assert.deepEqual(planned.changes.map((change) => [change.action, change.opId]), [["create", `gym:${DAY.tue}`]]);
    assert.deepEqual(planned.kept.map((entry) => entry.opId), [`gym:${DAY.thu}`]);

    const moved = planReconciliation({
      expected: { [`gym:${DAY.wed}`]: expect("1", "Gym – Helkropp A, onsdag", DAY.wed) },
      target: [op("gym", DAY.fri, "Gym – Helkropp A, fredag")],
      openTasks: [task("1", "Gym – Helkropp A, onsdag", DAY.wed)],
      today: DAY.mon,
    });
    assert.deepEqual(moved.changes, [
      {
        id: "c1",
        action: "update",
        opId: `gym:${DAY.fri}`,
        fromOpId: `gym:${DAY.wed}`,
        activity: "gym",
        date: DAY.fri,
        taskId: "1",
        before: { content: "Gym – Helkropp A, onsdag", description: "", due: DAY.wed },
        after: { content: "Gym – Helkropp A, fredag", description: "", due: DAY.fri },
      },
    ]);
  });

  it("removes only what the plan made and nobody changed, and reuses a task with the same title and day", () => {
    const planned = planReconciliation({
      expected: {
        [`golf:${DAY.wed}`]: expect("1", "Golf practice — Wedges", DAY.wed),
        [`golf:${DAY.thu}`]: expect("2", "Golf practice — Putting", DAY.thu),
      },
      target: [op("golf", DAY.sat, "Golf — 18-hole round")],
      openTasks: [task("1", "Golf practice — Wedges", DAY.wed), task("2", "Golf practice — Putting with Anna", DAY.thu), task("7", "Golf — 18-hole round", DAY.sat)],
      today: DAY.mon,
    });
    assert.deepEqual(planned.changes.map((change) => [change.action, change.taskId]), [["delete", "1"]]);
    assert.deepEqual(planned.leftAlone.map((entry) => [entry.opId, entry.reason]), [[`golf:${DAY.thu}`, "edited"]]);
    assert.deepEqual(planned.kept.map((entry) => [entry.opId, entry.taskId]), [[`golf:${DAY.sat}`, "7"]]);
  });
});
