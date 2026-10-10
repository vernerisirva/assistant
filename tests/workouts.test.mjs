import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assignGymSessions,
  estimateGymMinutes,
  estimateStretchMinutes,
  gymTask,
  stretchTask,
  workoutConfigProblems,
} from "../scripts/lib/workouts.mjs";
import { applyWeeklyPlanChanges, buildInitialPlanInputs, buildWeeklyPlan } from "../scripts/lib/weekly-plan.mjs";
import { applyGolfChanges, emptyGolfInputs } from "../scripts/lib/golf-week.mjs";
import { COMPETITION_ANSWER, GOLF_ANSWER } from "./fixtures/golf-answers.mjs";

const config = JSON.parse(readFileSync("config/weekly-plan.json", "utf8"));
const food = JSON.parse(readFileSync("config/food-planning.json", "utf8"));
const { gym, stretch } = config.activities;
const WEEK = "2026-09-28";

/** Phrases that describe a session instead of prescribing it. */
const VAGUE = /\ba (push|pull)\b|presses, rows|full-body strength|squat or deadlift variation|stretch for \d+ min|work on mobility|full-body stretching|stretch hips and back|\d+ min mobility/i;
const EXERCISE_LINE = /^\d+\. [A-ZÅÄÖ].+? – \d+ × \d+( sek)?( per sida)?, vila \d+ (sek|min)\./;
const MOVEMENT_LINE = /^\d+\. [A-ZÅÄÖ0-9].+? – (\d+ × )?\d+ (sek|(långsamma )?repetitioner)( per sida)?\. \S/;

function planFor({ golf = GOLF_ANSWER, targets } = {}) {
  const inputs = buildInitialPlanInputs(targets ? { targets } : {}, { config, food, weekStart: WEEK });
  inputs.golf = applyGolfChanges(emptyGolfInputs(config), golf, { weekStart: WEEK }).golf;
  return { inputs, plan: buildWeeklyPlan(inputs, { config, food }) };
}

describe("gym sessions", () => {
  it("are fully specified in config: named exercises, sets, repetitions or time, rest, warm-up and load", () => {
    assert.deepEqual(workoutConfigProblems(config.activities), []);
  });

  it("render every exercise with its sets × repetitions and rest, a warm-up, a length and load guidance", () => {
    for (const [index, session] of gym.sessions.entries()) {
      const task = gymTask(session, gym, { weekdayIndex: index });
      const lines = task.description.split("\n");
      const exercises = lines.filter((line) => /^\d+\. /.test(line));

      assert.match(task.content, /^Gym – Helkropp [AB], (måndag|tisdag)$/);
      assert.match(lines[0], new RegExp(`^${session.name} – .+ · cirka \\d+ minuter$`));
      assert.match(task.description, /\nUppvärmning – \d+ minuter\n- /);
      assert.equal(exercises.length, session.exercises.length);
      assert.ok(exercises.length >= 4);
      for (const line of exercises) assert.match(line, EXERCISE_LINE);
      assert.match(task.description, /\nBelastning: .*repetitioner kvar i reserv/);
      assert.match(task.description, /\nMål: Utför alla set med kontrollerad teknik\.$/);
      assert.doesNotMatch(task.description, VAGUE);
      assert.doesNotMatch(task.description, /\d+\s?kg\b/, "no invented weights");
    }
  });

  it("gives alternatives only where equipment may be busy, and states per-side work", () => {
    const task = gymTask(gym.sessions[0], gym, { weekdayIndex: 0 });
    assert.match(task.description, /\n1\. Knäböj – 3 × 8, vila 2 min\. .+ Alternativ: goblet squat med hantel\.\n/);
    assert.match(task.description, /\n5\. Pallof press – 3 × 12 per sida, vila 45 sek\./);
    assert.doesNotMatch(task.description, /\n3\. Hantelpress på bänk – .*Alternativ/);
  });

  it("estimates the session length from its work and rest", () => {
    assert.equal(estimateGymMinutes(gym.sessions[0]), 50);
    assert.equal(estimateGymMinutes(gym.sessions[0], { beforeGolf: true }), 45);
    assert.equal(estimateGymMinutes(gym.sessions[1]), 50);
  });

  it("the day before a round or competition, cuts a set from each leg exercise and says why", () => {
    const round = gymTask(gym.sessions[0], gym, { weekdayIndex: 1, beforeGolf: "round" });
    assert.match(round.description, /\nGolfrunda i morgon: benövningarna \(knäböj, rumänska marklyft med hantlar\) har ett set mindre/);
    assert.match(round.description, /\n1\. Knäböj – 2 × 8, vila 2 min\./);
    assert.match(round.description, /\n2\. Rumänska marklyft med hantlar – 2 × 10, vila 90 sek\./);
    assert.match(round.description, /\n3\. Hantelpress på bänk – 3 × 10, vila 90 sek\./);
    const competition = gymTask(gym.sessions[1], gym, { weekdayIndex: 4, beforeGolf: "competition" });
    assert.match(competition.description, /\nTävling i morgon: benövningarna \(bulgarisk utfallsböj\)/);
    assert.match(competition.description, /\n3\. Bulgarisk utfallsböj – 2 × 8 per sida/);
  });

  it("puts the session with less leg work on the day before golf", () => {
    const [legs, upper] = gym.sessions;
    const before = (dates) => (date) => (dates.includes(date) ? "round" : null);
    // Monday's alternating session would be the leg session; Tuesday is a round.
    const swapped = assignGymSessions(["2026-09-28", "2026-10-01"], gym.sessions, { golfTomorrow: before(["2026-09-28"]) });
    assert.equal(swapped.get("2026-09-28"), upper);
    assert.equal(swapped.get("2026-10-01"), legs);
    const only = assignGymSessions(["2026-09-29"], gym.sessions, { golfTomorrow: before(["2026-09-29"]) });
    assert.equal(only.get("2026-09-29"), upper);
    const free = assignGymSessions(["2026-09-28", "2026-10-01"], gym.sessions, { golfTomorrow: () => null });
    assert.deepEqual([...free.values()], [legs, upper]);
  });

  it("in a real week, never puts the leg session before a round and keeps no gym on round days", () => {
    for (const golf of [GOLF_ANSWER, COMPETITION_ANSWER]) {
      const { plan } = planFor({ golf, targets: { gym: 3 } });
      const rounds = plan.golf.days.filter((day) => ["round", "competition"].includes(day.role)).map((day) => day.date);
      for (const operation of plan.operations.filter((candidate) => candidate.activity === "gym")) {
        assert.ok(!rounds.includes(operation.date), `gym on round day ${operation.date}`);
        const tomorrow = new Date(Date.parse(`${operation.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
        if (rounds.includes(tomorrow)) {
          assert.match(operation.payload.content, /Helkropp B/, operation.payload.content);
          assert.match(operation.payload.description, /(Golfrunda|Tävling) i morgon:/);
        }
      }
    }
  });

  it("when the user moves gym to the day before the competition, the task lightens the legs", () => {
    const { inputs, plan } = planFor({ golf: COMPETITION_ANSWER });
    const from = plan.placements.find((entry) => entry.activity === "gym").date;
    const fromDay = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][(Date.parse(`${from}T00:00:00Z`) - Date.parse(`${WEEK}T00:00:00Z`)) / 86_400_000];
    const changed = applyWeeklyPlanChanges(inputs, plan, { moves: [{ activity: "gym", from: fromDay, to: "friday" }] }, { config, food });
    const revised = buildWeeklyPlan(changed.inputs, { config, food });
    const friday = revised.operations.find((operation) => operation.activity === "gym" && operation.date === "2026-10-02");
    assert.match(friday.payload.description, /\nTävling i morgon: benövningarna/);
  });
});

describe("stretching sessions", () => {
  it("are complete 15-minute routines of named movements with doses, sides and cues", () => {
    assert.equal(stretch.minutes, 15);
    assert.ok(stretch.routines.length >= 3);
    for (const routine of stretch.routines) {
      assert.ok(Math.abs(estimateStretchMinutes(routine) - 15) <= 2, `${routine.name}: ${estimateStretchMinutes(routine)} min`);
      const task = stretchTask(routine, stretch, { weekdayIndex: 1 });
      const lines = task.description.split("\n");
      const movements = lines.filter((line) => /^\d+\. /.test(line));

      assert.equal(task.content, "Rörlighet – Tisdag, 15 minuter");
      assert.equal(lines[0], `${routine.name} · 15 minuter`);
      assert.equal(movements.length, routine.movements.length);
      assert.ok(movements.length >= 5);
      for (const line of movements) assert.match(line, MOVEMENT_LINE);
      for (const movement of routine.movements.filter((candidate) => candidate.perSide)) {
        assert.ok(movements.some((line) => line.includes(movement.name) && line.includes("per sida")), movement.name);
      }
      assert.doesNotMatch(task.description, VAGUE);
    }
  });

  it("writes the example movements the way the user asked for them", () => {
    const task = stretchTask(stretch.routines[0], stretch, { weekdayIndex: 1 });
    assert.match(task.description, /\n1\. Höftböjarstretch i utfallsställning – 2 × 45 sek per sida\. Håll bäckenet neutralt/);
    assert.match(task.description, /\n2\. Bröstryggsrotation på alla fyra – 10 repetitioner per sida\./);
    assert.match(task.description, /\n4\. Katt–ko – 10 långsamma repetitioner\./);
    assert.match(task.description, /\n5\. Bröststretch i dörröppning – 2 × 30 sek per sida\./);
  });

  it("rotates the routines through a week of daily stretching", () => {
    const { plan } = planFor({ targets: { stretch: 7 } });
    const stretches = plan.operations.filter((operation) => operation.activity === "stretch");
    assert.equal(stretches.length, 7);
    const routines = new Set(stretches.map((operation) => operation.payload.description.split("\n")[0]));
    assert.equal(routines.size, stretch.routines.length);
    for (const operation of stretches) assert.match(operation.payload.content, /^Rörlighet – (Måndag|Tisdag|Onsdag|Torsdag|Fredag|Lördag|Söndag), 15 minuter$/);
  });
});
