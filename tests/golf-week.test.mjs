import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GOLF_QUESTIONS,
  MAX_GOLF_DAYS,
  applyGolfChanges,
  deriveGolfWeek,
  emptyGolfInputs,
  formatGolfClarification,
  formatGolfFollowUp,
  formatGolfQuestion,
  golfFocusKind,
  golfInputStatus,
  readSavedGolfRoutines,
} from "../scripts/lib/golf-week.mjs";
import { applyWeeklyPlanChanges, buildInitialPlanInputs, buildWeeklyPlan, formatPlanMessage } from "../scripts/lib/weekly-plan.mjs";
import { COMPETITION_ANSWER, GOLF_ANSWER } from "./fixtures/golf-answers.mjs";

const config = JSON.parse(readFileSync("config/weekly-plan.json", "utf8"));
const food = JSON.parse(readFileSync("config/food-planning.json", "utf8"));
const WEEK = "2026-09-28";
const DAY = Object.freeze({
  mon: "2026-09-28",
  tue: "2026-09-29",
  wed: "2026-09-30",
  thu: "2026-10-01",
  fri: "2026-10-02",
  sat: "2026-10-03",
  sun: "2026-10-04",
});

/** Applies golf answers in order, as the user gives them; every step must be grounded. */
function answered(...answers) {
  let golf = emptyGolfInputs(config);
  for (const answer of answers) {
    const result = applyGolfChanges(golf, answer, { weekStart: WEEK });
    assert.deepEqual(result.problems, [], answer.replyText);
    golf = result.golf;
  }
  return golf;
}

function problemsOf(answer, context = {}) {
  return applyGolfChanges(emptyGolfInputs(config), answer, { weekStart: WEEK, ...context }).problems.map((problem) => problem.reason);
}

function weekFor(golf, { existing = [], days = {}, skipDays = [], today = null } = {}) {
  return deriveGolfWeek({ golf, weekStart: WEEK, existing, dayLoads: days, skipDays, today, config });
}

function planWith(golf, input = {}) {
  const inputs = buildInitialPlanInputs(input, { config, weekStart: WEEK });
  inputs.golf = golf;
  return { inputs, plan: buildWeeklyPlan(inputs, { config, food }) };
}

const roles = (week) => week.days.map((day) => day.role);
const dayOf = (week, date) => week.days.find((day) => day.date === date);
const golfOps = (plan) => plan.operations.filter((operation) => operation.activity === "golf");
const practice = (week) => week.days.filter((day) => day.role === "practice");

describe("golf week input readiness", () => {
  it("asks for the playing days when only the focus is known", () => {
    const golf = answered({ replyText: "Focus on putting", focus: ["Putting"] });
    assert.deepEqual(golfInputStatus(golf), { complete: false, missing: ["rounds"] });
    assert.equal(
      formatGolfFollowUp({ golf, missing: ["rounds"] }),
      `Got it: focus: putting.\n\n${GOLF_QUESTIONS.rounds} If you're not playing a round, say "No rounds next week".`,
    );
  });

  it("asks for the focus when only the playing days are known", () => {
    const golf = answered({ replyText: "18 holes Wednesday", addRounds: [{ day: "wednesday", holes: 18 }] });
    assert.deepEqual(golfInputStatus(golf), { complete: false, missing: ["focus"] });
    assert.match(formatGolfFollowUp({ golf, missing: ["focus"] }), /^Got it: 18 holes Wed\.\n\nWhat 1–2 things do you want to focus on\? Or say "Choose the balance for me"\.$/);
  });

  it("asks both, in one compact message, before anything is known", () => {
    const question = formatGolfQuestion({ weekStart: WEEK });
    assert.equal(
      question,
      [
        "Next week's plan · 28 Sep–4 Oct",
        "",
        "Before I build next week's golf plan:",
        "",
        "1. Which days are you playing next week, and roughly 9 or 18 holes?",
        "2. What 1–2 things do you want to focus on?",
        "3. Any competition, lesson or other important golf event?",
        "",
        "You can answer naturally, e.g.",
        "\"18 holes Wednesday and Saturday. Focus on wedges 50–100 m and putting inside 2 m. Saturday is a competition.\"",
        "",
        "Then you'll get the full plan to review. Nothing goes into Todoist before you've seen it.",
      ].join("\n"),
    );
    const lastWeek = formatGolfQuestion({ weekStart: WEEK, previousWeek: { golf: answered(GOLF_ANSWER) } });
    assert.match(lastWeek, /\n\nLast week: 18 holes Wed · 18 holes Sat · focus: wedges 50–100 m, putting inside 2 m\.\n\n/);
  });

  it("is complete with playing days and focus, or with no golf at all", () => {
    assert.equal(golfInputStatus(answered(GOLF_ANSWER)).complete, true);
    assert.equal(golfInputStatus(answered({ replyText: "No golf next week, I'm travelling", activeDays: 0 })).complete, true);
    assert.equal(golfInputStatus(emptyGolfInputs(config)).complete, false);
  });

  it("takes competitions and lessons as fixed points of the week", () => {
    const golf = answered(
      COMPETITION_ANSWER,
      { replyText: "And a lesson on Thursday at 17", addLessons: [{ day: "thursday", note: "17:00" }] },
    );
    const week = weekFor(golf);
    assert.equal(dayOf(week, DAY.sat).role, "competition");
    assert.equal(dayOf(week, DAY.thu).role, "lesson");
    assert.equal(dayOf(week, DAY.fri).kind, "comp-prep");
  });

  it("refuses a playing day, hole count, competition or lesson the user never mentioned", () => {
    assert.deepEqual(problemsOf({ replyText: "Focus on putting", focus: ["Putting"], addRounds: [{ day: "friday" }] }), [
      "Friday is not in the user's words.",
    ]);
    assert.deepEqual(problemsOf({ replyText: "Playing Wednesday", addRounds: [{ day: "wednesday", holes: 18 }] }), [
      "18 holes is not in the user's words.",
    ]);
    assert.deepEqual(problemsOf({ replyText: "Playing Saturday", addRounds: [{ day: "saturday", competition: true }] }), [
      "A competition on Saturday is not in the user's words.",
    ]);
    assert.deepEqual(problemsOf({ replyText: "Thursday is free", addLessons: [{ day: "thursday" }] }), ["A lesson is not in the user's words."]);
    // An important round is not a competition, and a coach's advice is not a lesson.
    assert.deepEqual(problemsOf({ replyText: "Saturday is an important golf event", addRounds: [{ day: "saturday", competition: true }] }), [
      "A competition on Saturday is not in the user's words.",
    ]);
    assert.deepEqual(problemsOf({ replyText: "Thursday my coach wants me working on putting", addLessons: [{ day: "thursday" }] }), [
      "A lesson is not in the user's words.",
    ]);
    assert.deepEqual(problemsOf({ replyText: "Saturday is the club championship", addRounds: [{ day: "saturday", competition: true }] }), []);
    assert.deepEqual(problemsOf({ replyText: "Lesson with my coach on Thursday", addLessons: [{ day: "thursday" }] }), []);
    // Not saying anything about rounds is not the same as "no rounds".
    assert.deepEqual(problemsOf({ replyText: "Focus on wedges", focus: ["Wedges"], rounds: [] }), ["The user did not say they are not playing."]);
  });

  it("refuses a focus area or technical priority that is not in the user's words", () => {
    assert.deepEqual(problemsOf({ replyText: "Putting this week", focus: ["Driver accuracy"] }), ['"Driver accuracy" is not in the user\'s words.']);
    assert.deepEqual(problemsOf({ replyText: "Work on wedges", focus: ["Wedges"], technicalPriority: "Shallow the club" }), [
      '"Shallow the club" is not in the user\'s words.',
    ]);
    assert.deepEqual(problemsOf({ replyText: "My coach wants me working on clubface control", technicalPriority: "Clubface control" }), []);
  });

  it("refuses a time limit the user never gave", () => {
    assert.deepEqual(problemsOf({ replyText: "Busy Monday", minutes: { monday: 30 } }), ["30 minutes is not in the user's words."]);
    assert.deepEqual(problemsOf({ replyText: "I only have half an hour on Monday", minutes: { monday: 30 } }), []);
  });

  it("understands Swedish day names, weekends, and dates", () => {
    assert.deepEqual(problemsOf({ replyText: "18 hål onsdag och lördag", addRounds: [{ day: "wednesday", holes: 18 }, { day: "saturday", holes: 18 }] }), []);
    assert.deepEqual(problemsOf({ replyText: "9 holes at the weekend", addRounds: [{ day: "saturday", holes: 9 }, { day: "sunday", holes: 9 }] }), []);
    assert.deepEqual(problemsOf({ replyText: "Round on the 30th", addRounds: [{ day: "wednesday" }] }), []);
    assert.deepEqual(problemsOf({ replyText: "Round on 3 Oct", addRounds: [{ day: "saturday" }] }), []);
    // "18 holes" is a hole count, not the 18th.
    assert.deepEqual(problemsOf({ replyText: "18 holes", addRounds: [{ day: "sunday" }] }), ["Sunday is not in the user's words."]);
  });

  it('accepts "choose the practice balance for me" as a focus answer, and only when asked', () => {
    const golf = answered(
      { replyText: "No specific technical focus — choose the practice balance", focus: "balance" },
      { replyText: "18 holes Saturday", addRounds: [{ day: "saturday", holes: 18 }] },
    );
    assert.deepEqual(golf.focus, { mode: "balance", areas: [] });
    assert.equal(golfInputStatus(golf).complete, true);
    assert.deepEqual(problemsOf({ replyText: "Putting", focus: "balance" }), ["The user did not ask you to choose the practice balance."]);
  });

  it('accepts "I won\'t play any full rounds next week" as an answer about playing days', () => {
    const golf = answered({ replyText: "I won’t play any full rounds next week, focus on short game", rounds: [], focus: ["Short game"] });
    assert.equal(golfInputStatus(golf).complete, true);
    assert.deepEqual(golf.rounds, []);
    const week = weekFor(golf);
    assert.equal(practice(week).length, 6);
    assert.ok(week.days.every((day) => day.role !== "round" && day.role !== "competition"));
  });

  it('uses last week\'s playing days only when asked, and never last week\'s competition', () => {
    const previousWeek = { golf: answered(COMPETITION_ANSWER) };
    const golf = applyGolfChanges(emptyGolfInputs(config), { replyText: "Same playing days as last week", rounds: "same-as-last-week" }, { weekStart: "2026-10-05", previousWeek });
    assert.deepEqual(golf.problems, []);
    assert.deepEqual(golf.golf.rounds, [
      { date: "2026-10-07", holes: 18, competition: false },
      { date: "2026-10-10", holes: 18, competition: false },
    ]);
    assert.deepEqual(problemsOf({ replyText: "Same playing days as last week", rounds: "same-as-last-week" }), ["Last week's playing days are not saved."]);
  });

  it('uses a saved normal golf week for "use my normal golf week", and asks when none is saved', () => {
    const answer = { replyText: "Use my normal golf week", from: "normal-week", addRounds: [{ day: "wednesday", holes: 18 }, { day: "saturday", holes: 18 }] };
    assert.deepEqual(problemsOf(answer, { normalWeekText: "18 holes Wednesday evening and Saturday morning" }), []);
    const missing = applyGolfChanges(emptyGolfInputs(config), answer, { weekStart: WEEK }).problems;
    assert.match(missing[0].reason, /No normal golf week is saved/);
    assert.equal(
      formatGolfClarification(missing),
      "I don't have your normal golf week saved. Which days are you playing next week, and roughly 9 or 18 holes?",
    );
  });

  it("asks which day stays golf-free when the named rounds and lessons cover all seven days", () => {
    const everyDay = {
      replyText: "18 holes Monday, Tuesday, Wednesday, Thursday, Friday and Saturday, and a lesson on Sunday",
      addRounds: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].map((day) => ({ day, holes: 18 })),
      addLessons: [{ day: "sunday" }],
    };
    const result = applyGolfChanges(emptyGolfInputs(config), everyDay, { weekStart: WEEK });
    assert.deepEqual(result.problems.map((problem) => problem.reason), ["That would be golf on all seven days."]);
    assert.equal(formatGolfClarification(result.problems), "That's golf every day next week. Which day should be golf-free?");
    const sixDays = { ...everyDay, replyText: everyDay.replyText.replace(", and a lesson on Sunday", ""), addLessons: [] };
    assert.deepEqual(problemsOf(sixDays), []);
  });

  it("refuses seven golf days and needs the user's words for fewer", () => {
    assert.deepEqual(problemsOf({ replyText: "Golf every day, 7 days", activeDays: 7 }), ["Seven golf days would leave no golf-free day."]);
    assert.deepEqual(problemsOf({ replyText: "Fewer golf days please", activeDays: 4 }), ["The user did not ask for 4 golf days."]);
    assert.deepEqual(problemsOf({ replyText: "Only four golf days this week", activeDays: 4 }), []);
    assert.deepEqual(problemsOf({ replyText: "Make it lighter", activeDays: 0 }), ["The user did not say no golf."]);
  });
});

describe("golf week planning", () => {
  it("plans exactly six golf days and one golf-free day", () => {
    for (const answer of [GOLF_ANSWER, COMPETITION_ANSWER, { replyText: "No rounds, choose the balance", rounds: [], focus: "balance" }]) {
      const week = weekFor(answered(answer));
      assert.equal(week.activeDays, 6, answer.replyText);
      assert.equal(week.restDays, 1, answer.replyText);
      assert.equal(roles(week).filter((role) => role === "rest").length, 1);
    }
    assert.equal(config.golf.activeDays, MAX_GOLF_DAYS);
  });

  it("never adds a seventh golf day, and never plans a round the user did not name", () => {
    const week = weekFor(answered(GOLF_ANSWER));
    assert.deepEqual(week.days.filter((day) => day.role === "round").map((day) => day.date), [DAY.wed, DAY.sat]);
    assert.ok(roles(week).includes("rest"));
    // Even with every other day free, practice stops at six golf days.
    const fewer = weekFor(answered(GOLF_ANSWER, { replyText: "Only five golf days", activeDays: 5 }));
    assert.equal(fewer.activeDays, 5);
    assert.equal(fewer.restDays, 2);
  });

  it("counts golf tasks already in Todoist toward the six days and plans nothing new on them", () => {
    const existing = [
      { date: DAY.mon, title: "Golf practice — Putting", golfKind: "practice" },
      { date: DAY.wed, title: "Golf round: Bro Hof", golfKind: "round" },
    ];
    const golf = answered(GOLF_ANSWER);
    const week = weekFor(golf, { existing });
    assert.equal(week.activeDays, 6);
    assert.equal(dayOf(week, DAY.mon).role, "existing");
    assert.equal(dayOf(week, DAY.wed).role, "existing", "the user's Wednesday round is that existing task");
    const { plan } = planWith(golf, {
      existingTasks: [
        { content: "Golf practice — Putting", due: { date: DAY.mon } },
        { content: "Golf round: Bro Hof", due: { date: DAY.wed } },
      ],
    });
    assert.equal(golfOps(plan).length, 4);
    assert.ok(golfOps(plan).every((operation) => ![DAY.mon, DAY.wed].includes(operation.date)));
  });

  it("gives the user's round its own task when the existing golf task that day is not a round", () => {
    const existing = [
      { date: DAY.wed, title: "Golf practice — Putting", golfKind: "practice" },
      { date: DAY.sat, title: "Golf with Anna", golfKind: "golf" },
    ];
    const golf = answered(GOLF_ANSWER);
    const week = weekFor(golf, { existing });
    assert.equal(dayOf(week, DAY.wed).role, "round", "a practice task does not stand in for the round");
    assert.equal(dayOf(week, DAY.wed).alongside, "Golf practice — Putting");
    assert.equal(dayOf(week, DAY.sat).role, "existing", "a plain golf task that day is taken as the round");
    assert.equal(week.activeDays, 6, "the day still counts once");
    const { plan } = planWith(golf, {
      existingTasks: [
        { content: "Golf practice — Putting", due: { date: DAY.wed } },
        { content: "Golf with Anna", due: { date: DAY.sat } },
      ],
    });
    assert.deepEqual(golfOps(plan).filter((operation) => operation.date === DAY.wed).map((operation) => operation.payload.content), ["Golf — 18-hole round"]);
    assert.equal(golfOps(plan).filter((operation) => operation.date === DAY.sat).length, 0);
    const text = formatPlanMessage({ planId: "x", versions: [{ version: 1, plan }] }, { version: 1, deadline: "2026-09-26T19:00:00.000Z" });
    assert.match(text, /\nWed — 18 holes · process: commitment · also in Todoist: Golf practice — Putting\n/);
    assert.match(text, /\nSat — Golf with Anna \(in Todoist\)\n/);
  });

  it("puts less practice around several full rounds", () => {
    const sessionMinutes = (week) => practice(week).reduce((total, day) => total + (day.minutes ?? 0), 0);
    const oneRound = weekFor(answered({ replyText: "18 holes Saturday, focus wedges", addRounds: [{ day: "saturday", holes: 18 }], focus: ["Wedges"] }));
    const threeRounds = weekFor(
      answered({
        replyText: "18 holes Tuesday, Thursday and Saturday, focus wedges",
        addRounds: [{ day: "tuesday", holes: 18 }, { day: "thursday", holes: 18 }, { day: "saturday", holes: 18 }],
        focus: ["Wedges"],
      }),
    );
    assert.ok(practice(oneRound).some((day) => day.intensity === "full"));
    assert.ok(practice(threeRounds).every((day) => day.intensity === "light"), "three full rounds keep every practice light");
    assert.ok(sessionMinutes(threeRounds) < sessionMinutes(oneRound) / 2);
    const twoRounds = weekFor(answered(GOLF_ANSWER));
    assert.ok(practice(twoRounds).every((day) => day.intensity !== "full"), "two full rounds cap practice at moderate");
  });

  it("builds a competition week around the competition: preparation the day before, no range work right before, rest after", () => {
    const week = weekFor(answered(COMPETITION_ANSWER, { replyText: "Driver too as the second focus", focus: ["Wedges 50–100 m", "Driver"] }));
    assert.equal(dayOf(week, DAY.sat).role, "competition");
    assert.equal(dayOf(week, DAY.fri).kind, "comp-prep");
    assert.equal(dayOf(week, DAY.fri).intensity, "prep");
    assert.equal(dayOf(week, DAY.sun).role, "rest", "the golf-free day follows the competition");
    assert.notEqual(dayOf(week, DAY.thu).kind, "range", "no technical range work two days before the competition");
    assert.notEqual(dayOf(week, DAY.thu).intensity, "full");
    const range = practice(week).filter((day) => day.kind === "range");
    assert.ok(range.every((day) => day.date < DAY.thu), "heavier technical work comes earlier in the week");
  });

  it("gives the main focus the most sessions, the second fewer, and keeps the rest as upkeep", () => {
    const week = weekFor(answered({ replyText: "No rounds next week. Focus wedges and putting", rounds: [], focus: ["Wedges", "Putting"] }));
    const sessions = practice(week);
    const count = (index) => sessions.filter((day) => day.focusIndex === index).length;
    assert.equal(sessions.length, 6);
    assert.equal(count(0), 3);
    assert.equal(count(1), 2);
    assert.equal(sessions.filter((day) => day.focusIndex === null).length, 1);
    // Not every session is a test: the last session of each focus is.
    assert.equal(sessions.filter((day) => day.pressure).length, 2 + (sessions.some((day) => day.kind === "scoring") ? 1 : 0));
    assert.ok(sessions.some((day) => !day.pressure));
  });

  it("maps focus areas to the session that trains them, keeping the user's words as the label", () => {
    assert.equal(golfFocusKind("Wedges 50–100 m"), "wedges");
    assert.equal(golfFocusKind("Putting inside 2 m"), "putting");
    assert.equal(golfFocusKind("Putting under pressure"), "putting");
    assert.equal(golfFocusKind("60–90 metres"), "wedges");
    assert.equal(golfFocusKind("Bunker play"), "short-game");
    assert.equal(golfFocusKind("Driver off the tee"), "range");
    assert.equal(golfFocusKind("Course management"), "on-course");
    assert.equal(golfFocusKind("Commitment"), "process");
    assert.equal(golfFocusKind("Something new"), "general");
    const week = weekFor(answered(GOLF_ANSWER));
    assert.ok(practice(week).some((day) => day.label === "Wedges 50–100 m" && day.kind === "wedges"));
  });

  it("keeps the golf-free day after a full round or on a heavy work day", () => {
    const heavy = weekFor(answered(GOLF_ANSWER), { days: { [DAY.tue]: { load: "heavy" } } });
    assert.equal(dayOf(heavy, DAY.tue).role, "rest");
    const unavailable = weekFor(answered(GOLF_ANSWER), { days: { [DAY.fri]: { load: "unavailable" } } });
    assert.equal(dayOf(unavailable, DAY.fri).role, "off");
    assert.equal(unavailable.activeDays, 6, "an unavailable day is the golf-free day");
    assert.equal(unavailable.restDays, 0);
  });

  it("plans nothing on days that have already passed when the answers arrive mid-week", () => {
    const week = weekFor(answered(GOLF_ANSWER), { today: DAY.wed });
    assert.equal(dayOf(week, DAY.mon).role, "off");
    assert.equal(dayOf(week, DAY.tue).role, "off");
    assert.match(week.notes.join(" "), /Only room for 5 golf days/);
  });

  it("writes one task per golf day with the whole session, due on its day", () => {
    const { plan } = planWith(answered(COMPETITION_ANSWER));
    const ops = golfOps(plan);
    assert.equal(ops.length, 6);
    assert.equal(new Set(ops.map((operation) => operation.date)).size, 6, "one main golf task per day");
    for (const operation of ops) {
      assert.equal(operation.payload.due_string, operation.date);
      assert.equal(operation.opId, `golf:${operation.date}`);
      assert.deepEqual(Object.keys(operation.payload).sort(), ["content", "description", "due_string"]);
    }
    const wedges = ops.find((operation) => operation.payload.content === "Golf practice — Wedges 50–100 m");
    const lines = wedges.payload.description.split("\n");
    assert.deepEqual(lines.slice(0, 3), ["Focus", "Wedges 50–100 m", ""]);
    const session = /^Session · (\d+) min$/.exec(lines[3]);
    assert.ok(session, lines[3]);
    const blocks = lines.slice(4, lines.indexOf("", 4));
    assert.ok(blocks.length >= 3 && blocks.every((line) => /^- .+: \d+ min$/.test(line)), blocks.join("\n"));
    assert.equal(blocks.reduce((total, line) => total + Number(/(\d+) min$/.exec(line)[1]), 0), Number(session[1]), "the blocks add up to the session");
    assert.match(wedges.payload.description, /\n\nMental focus\nTarget → breath → commit\.\n\nSuccess\n/);

    assert.equal(ops.find((operation) => operation.date === DAY.wed).payload.content, "Golf — 18-hole round");
    const competition = ops.find((operation) => operation.date === DAY.sat).payload;
    assert.equal(competition.content, "Golf — Competition");
    assert.match(competition.description, /^18 holes\.\n\nProcess objective\nUse the pre-shot routine on every shot\.\n\nBefore the round\n/);
    assert.match(competition.description, /\n\nAfter a bad shot\nAcknowledge, exhale, next shot\.\n/);
    assert.match(ops.find((operation) => operation.date === DAY.fri).payload.description, /No swing changes this close to the competition/);
  });

  it("shows the golf week in the proposal with its focus and every day", () => {
    const { plan } = planWith(answered(COMPETITION_ANSWER));
    const lines = [
      "Golf · 6 golf days, 1 rest day",
      "Long-term direction: competitive performance",
      "This week's focus: 1. Wedges 50–100 m · 2. Putting inside 2 m",
    ];
    const text = formatPlanMessage({ planId: "x", versions: [{ version: 1, plan }] }, { version: 1, deadline: "2026-09-26T19:00:00.000Z" });
    assert.ok(text.includes(lines.join("\n")), text);
    assert.match(text, /\nWed — 18 holes · process: commitment\n/);
    assert.match(text, /\nFri — Competition preparation · 40 min\n/);
    assert.match(text, /\nSat — Competition · 18 holes · process: routine\n/);
    assert.match(text, /\nSun — Rest\n/);
    assert.match(text, /\n\nGym, stretching and meal prep\nGym 2 · Stretch 3 · Meal prep 2\n/);
    assert.match(text, /\n\nFood\n/);
    assert.ok(text.length < 4096, `${text.length} characters`);
  });
});

describe("golf week revisions", () => {
  const shown = () => planWith(answered(COMPETITION_ANSWER));
  const revise = (previous, golf, extra = {}) => {
    const { inputs, summary } = applyWeeklyPlanChanges(previous.inputs, previous.plan, { golf, ...extra }, { config, food });
    return { inputs, summary, plan: buildWeeklyPlan(inputs, { config, food }) };
  };
  const sessionsOf = (plan) => Object.fromEntries(plan.golf.days.map((day) => [day.date, day.role === "practice" ? `${day.kind}:${day.focusIndex}` : day.role]));

  it('"Move wedges to Thursday" swaps that session and keeps the rest of the week', () => {
    const before = shown();
    const wedgesDay = before.plan.golf.days.find((day) => day.kind === "wedges" && day.date !== DAY.thu);
    const thursday = sessionsOf(before.plan)[DAY.thu];
    const weekday = new Date(`${wedgesDay.date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }).toLowerCase();
    const after = revise(before, { replyText: "Move wedges to Thursday", moves: [{ from: weekday, to: "thursday" }] });
    const sessions = sessionsOf(after.plan);
    assert.equal(sessions[DAY.thu], `wedges:0`);
    assert.equal(sessions[wedgesDay.date], thursday);
    for (const date of [DAY.wed, DAY.fri, DAY.sat, DAY.sun]) assert.equal(sessions[date], sessionsOf(before.plan)[date], date);
    assert.deepEqual(after.summary, [`Golf: wedges 50–100 m ${wedgesDay.date === DAY.mon ? "Mon" : "Tue"} → Thu`]);
  });

  it('"Tuesday needs to be the rest day" moves the golf-free day and keeps six golf days', () => {
    const after = revise(shown(), { replyText: "Tuesday needs to be the rest day", restDay: "tuesday" });
    assert.equal(dayOf(after.plan.golf, DAY.tue).role, "rest");
    assert.equal(dayOf(after.plan.golf, DAY.sun).role, "practice");
    assert.equal(after.plan.golf.activeDays, 6);
    assert.deepEqual(after.summary, ["Golf: rest day Tue"]);
  });

  it('"I\'m also playing Friday" adds a round; removing one gives the day back to practice', () => {
    const before = planWith(answered(GOLF_ANSWER));
    const added = revise(before, { replyText: "I'm also playing Friday", addRounds: [{ day: "friday" }] });
    assert.equal(dayOf(added.plan.golf, DAY.fri).role, "round");
    assert.equal(added.plan.golf.activeDays, 6, "still six golf days, with less practice");
    assert.equal(practice(added.plan.golf).length, 3);
    const removed = revise(added, { replyText: "Not playing Wednesday after all", removeRounds: ["wednesday"] });
    assert.notEqual(dayOf(removed.plan.golf, DAY.wed).role, "round");
    assert.equal(removed.plan.golf.activeDays, 6);
  });

  it('"Saturday is now a competition" keeps its hole count and adds competition preparation', () => {
    const after = revise(planWith(answered(GOLF_ANSWER)), { replyText: "Saturday is now a competition", addRounds: [{ day: "saturday", competition: true }] });
    const saturday = dayOf(after.plan.golf, DAY.sat);
    assert.equal(saturday.role, "competition");
    assert.equal(saturday.holes, 18);
    assert.equal(dayOf(after.plan.golf, DAY.fri).kind, "comp-prep");
  });

  it('"Putting should be the main focus" reorders the focus', () => {
    const after = revise(shown(), { replyText: "Putting should be the main focus", focus: ["Putting inside 2 m", "Wedges 50–100 m"] });
    assert.deepEqual(after.plan.golf.focus.areas, ["Putting inside 2 m", "Wedges 50–100 m"]);
    const main = practice(after.plan.golf).filter((day) => day.focusIndex === 0);
    assert.ok(main.length >= 1 && main.every((day) => day.kind === "putting"));
  });

  it('"I only have 30 minutes Monday" shortens Monday instead of moving things around', () => {
    const before = shown();
    const after = revise(before, { replyText: "I only have 30 minutes Monday", minutes: { monday: 30 } });
    const monday = dayOf(after.plan.golf, DAY.mon);
    assert.equal(monday.intensity, "light");
    assert.ok((monday.limitMinutes ?? monday.minutes) <= 30);
    assert.equal(monday.kind, dayOf(before.plan.golf, DAY.mon).kind, "the same session, shorter");
  });

  it('"No range sessions this week" replaces range work', () => {
    const before = planWith(answered({ replyText: "No rounds, focus on driver and putting", rounds: [], focus: ["Driver", "Putting"] }));
    assert.ok(practice(before.plan.golf).some((day) => day.kind === "range"));
    const after = revise(before, { replyText: "No range sessions this week", avoid: ["range"] });
    assert.ok(practice(after.plan.golf).every((day) => day.kind !== "range"));
    assert.equal(after.plan.golf.activeDays, 6);
  });

  it("refuses a change that would invent a day or put two golf items on one day", () => {
    const before = shown();
    assert.throws(() => revise(before, { replyText: "Move wedges", moves: [{ from: "monday", to: "wednesday" }] }), /Wednesday already has a round/);
    assert.throws(() => revise(before, { replyText: "Move prep", moves: [{ from: "friday", to: "monday" }] }), /Competition preparation stays on the day before the competition/);
    assert.throws(() => revise(before, { replyText: "Play Sunday too", addRounds: [{ day: "sunday", holes: 9 }] }), /9 holes is not in the user's words/);
  });

  it("does not change the plan for a change that alters nothing", () => {
    const before = shown();
    const after = revise(before, { replyText: "Make Sunday the rest day", restDay: "sunday" });
    assert.deepEqual(after.plan.golf, before.plan.golf);
    assert.deepEqual(after.plan.operations, before.plan.operations);
  });

  it("keeps the golf week where it was when something else changes", () => {
    const before = shown();
    const { inputs } = applyWeeklyPlanChanges(before.inputs, before.plan, { dayLoads: { thursday: "heavy" }, targets: { gym: 3 } }, { config, food });
    const after = buildWeeklyPlan(inputs, { config, food });
    for (const day of before.plan.golf.days.filter((entry) => entry.role === "practice" && entry.date !== DAY.thu)) {
      assert.equal(dayOf(after.golf, day.date).kind, day.kind, day.date);
    }
    assert.equal(dayOf(after.golf, DAY.thu).intensity, "light", "a heavy day keeps its session, lighter");
  });
});

describe("golf week boundaries", () => {
  const mechanics = /\b(shallow|hips?|grip|wrist|release|swing plane|takeaway|backswing|downswing|weight shift|posture|stance|ball position|over the top|early extension|casting)\b/i;

  it("never diagnoses or prescribes swing mechanics; a technical priority comes only from the user", () => {
    const week = (focus, extra = {}) =>
      planWith(answered({ replyText: `No rounds. Focus ${focus.join(" and ")}`, rounds: [], focus, ...extra })).plan;
    for (const plan of [week(["Driver", "Irons"]), week(["Wedges", "Short game"]), week(["Putting"]), planWith(answered(COMPETITION_ANSWER)).plan]) {
      for (const operation of golfOps(plan)) {
        assert.doesNotMatch(`${operation.payload.content}\n${operation.payload.description}`, mechanics, operation.payload.content);
      }
    }
    const unknown = golfOps(week(["Driver"])).find((operation) => /Technical priority/.test(operation.payload.description));
    assert.match(unknown.payload.description, /Technical priority\nYour current one from your lesson or coach\./);
    const coached = golfOps(week(["Driver"], { replyText: "No rounds. Focus driver. My coach wants me working on clubface control", technicalPriority: "Clubface control" }));
    assert.match(coached.find((operation) => /Technical priority/.test(operation.payload.description)).payload.description, /Technical priority\nClubface control/);
  });

  it("uses the user's saved cue word and routines, reading them only", () => {
    const directory = mkdtempSync(join(tmpdir(), "golf-week-memory-"));
    const memoryPath = join(directory, "preferences.json");
    const memory = {
      version: 1,
      entries: [
        { id: "a", category: "golf", key: "cue-word", value: "\"commit\"", sensitivity: "low", source: "telegram", createdAt: "x", updatedAt: "x" },
        { id: "b", category: "golf", key: "bad-shot-reset", value: "After a poor shot: walk away, exhale, next shot", sensitivity: "low", source: "telegram", createdAt: "x", updatedAt: "x" },
        { id: "c", category: "golf", key: "pre-round-routine", value: "Before a round: putts, chips, three tee shots", sensitivity: "low", source: "telegram", createdAt: "x", updatedAt: "x" },
        { id: "d", category: "golf", key: "normal-week", value: "18 holes Wednesday and Saturday", sensitivity: "low", source: "telegram", createdAt: "x", updatedAt: "x" },
        { id: "e", category: "golf", key: "secret-thing", value: "private", sensitivity: "sensitive", source: "telegram", createdAt: "x", updatedAt: "x" },
      ],
    };
    const raw = `${JSON.stringify(memory, null, 2)}\n`;
    writeFileSync(memoryPath, raw);
    try {
      const routines = readSavedGolfRoutines(memoryPath);
      assert.deepEqual(routines.saved, { cueWord: "commit", preRoundRoutine: "Pre round routine", badShotReset: "Bad shot reset", competitionRoutine: null });
      assert.equal(routines.normalWeek, "18 holes Wednesday and Saturday");
      const golf = { ...answered(COMPETITION_ANSWER), saved: routines.saved };
      const ops = golfOps(planWith(golf).plan);
      const round = ops.find((operation) => operation.date === DAY.wed).payload.description;
      assert.match(round, /\nMental focus\nTarget → breath → commit\. Cue: commit\.\n/);
      assert.match(round, /\nAfter a bad shot\nUse your bad shot reset, then make the next decision\.\n/);
      assert.match(round, /\nBefore the round\nYour pre round routine\.\n/);
      assert.equal(readFileSync(memoryPath, "utf8"), raw, "memory is never written");
      assert.deepEqual(readSavedGolfRoutines(join(directory, "missing.json")).saved, { cueWord: null, preRoundRoutine: null, badShotReset: null, competitionRoutine: null });
      writeFileSync(memoryPath, "{ not json");
      assert.equal(readSavedGolfRoutines(memoryPath).unreadable, true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("has no path to memory writes, weather, scheduling, or a model", () => {
    const source = readFileSync("scripts/lib/golf-week.mjs", "utf8");
    for (const forbidden of ["rememberMemoryEntry", "writeMemoryDocument", "savePlaybook", "updatePlaybook", "weather", "cron", "openrouter", "fetch(", "addTask", "sendMessage"]) {
      assert.ok(!source.includes(forbidden), forbidden);
    }
    const apply = readFileSync("scripts/lib/weekly-plan-apply.mjs", "utf8");
    for (const forbidden of ["golf-week", "deriveGolfWeek", "applyGolfChanges", "readSavedGolfRoutines"]) {
      assert.ok(!apply.includes(forbidden), `apply must not ${forbidden}`);
    }
  });

  it("adds no scheduled or post-round coaching: the golf text only invites a debrief on request", () => {
    const ops = golfOps(planWith(answered(COMPETITION_ANSWER)).plan);
    for (const operation of ops) assert.doesNotMatch(operation.payload.description, /I'll (message|remind|check in)|reminder|after your round I/i);
    assert.match(ops.find((operation) => operation.date === DAY.wed).payload.description, /Say “Debrief my round” to go through it\./);
  });
});
