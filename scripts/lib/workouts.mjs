/**
 * Gym and mobility sessions for the weekly plan, rendered from the structured
 * sessions in config/weekly-plan.json. Every task names each exercise or
 * movement with its sets and repetitions or hold time, the rest, the side and
 * the session's length, so a task is never just "stretch for 15 minutes".
 *
 * Load is described by repetitions in reserve, never by invented weights, and
 * nothing here adds medical advice or restrictions.
 */

const WEEKDAYS = Object.freeze(["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"]);
/** Approximate seconds per repetition, used only for the session length estimate. */
const SECONDS_PER_REP = 4;
const SECONDS_PER_SLOW_REP = 6;

/** "måndag" for a Monday-based weekday index. */
export function swedishWeekday(index) {
  return WEEKDAYS[index];
}

// ---------------------------------------------------------------------------
// Gym.

/**
 * One gym session as a Todoist task. The day before a round or competition the
 * leg exercises lose a set and stop further from failure, and the task says so.
 * @param beforeGolf "round", "competition" or null
 */
export function gymTask(session, settings, { weekdayIndex, beforeGolf = null }) {
  const reduce = Boolean(beforeGolf);
  const exercises = session.exercises.map((exercise) => (reduce && exercise.legs ? { ...exercise, sets: Math.max(1, exercise.sets - 1) } : exercise));
  const lines = [`${session.name} – ${session.focus} · cirka ${estimateGymMinutes(session, { beforeGolf: reduce })} minuter`];
  if (reduce) {
    const legs = session.exercises.filter((exercise) => exercise.legs).map((exercise) => lowerFirst(exercise.name));
    const heading = settings.beforeGolf[beforeGolf];
    if (legs.length > 0) lines.push("", `${heading}: ${settings.beforeGolf.text.replace("{exercises}", legs.join(", "))}`);
  }
  lines.push("", `Uppvärmning – ${session.warmUp.minutes} minuter`, ...session.warmUp.items.map((item) => `- ${item}`));
  lines.push("", "Styrka", ...exercises.map((exercise, index) => `${index + 1}. ${exerciseLine(exercise)}`));
  lines.push("", `Belastning: ${settings.load}`, `Mål: ${settings.goal}`);
  return {
    content: `${settings.label} – ${session.name}, ${swedishWeekday(weekdayIndex)}`,
    description: lines.join("\n"),
  };
}

/** "Knäböj – 3 × 8, vila 2 min. Bröstet upp … Alternativ: goblet squat med hantel." */
export function exerciseLine(exercise) {
  const parts = [`${exercise.name} – ${volume(exercise)}, vila ${restText(exercise.restSeconds)}.`];
  if (exercise.cue) parts.push(exercise.cue);
  if (exercise.alternative) parts.push(`Alternativ: ${exercise.alternative}.`);
  return parts.join(" ");
}

function volume(exercise) {
  const side = exercise.perSide ? " per sida" : "";
  if (exercise.seconds) return `${exercise.sets} × ${exercise.seconds} sek${side}`;
  return `${exercise.sets} × ${exercise.reps}${side}`;
}

function restText(seconds) {
  return seconds >= 120 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sek`;
}

/**
 * Warm-up plus every set's work and rest, plus a minute to set up each
 * exercise, rounded up to five minutes. An estimate, stated as "cirka".
 */
export function estimateGymMinutes(session, { beforeGolf = false } = {}) {
  let seconds = session.warmUp.minutes * 60;
  for (const exercise of session.exercises) {
    const sets = beforeGolf && exercise.legs ? Math.max(1, exercise.sets - 1) : exercise.sets;
    const sides = exercise.perSide ? 2 : 1;
    const work = exercise.seconds ? exercise.seconds * sides : exercise.reps * SECONDS_PER_REP * sides;
    seconds += sets * (work + exercise.restSeconds) + 60;
  }
  return Math.ceil(seconds / 300) * 5;
}

/**
 * Which configured session each gym day gets. Sessions alternate through the
 * week, but the day before a round or competition gets the session with the
 * least leg work: swapped with another gym day when possible, otherwise
 * replaced by it.
 * @param golfTomorrow `(date) => "round" | "competition" | null`
 */
export function assignGymSessions(dates, sessions, { golfTomorrow }) {
  const legSets = (session) => session.exercises.filter((exercise) => exercise.legs).reduce((total, exercise) => total + exercise.sets, 0);
  const lightest = [...sessions].sort((a, b) => legSets(a) - legSets(b))[0];
  const assignment = dates.map((_, index) => sessions[index % sessions.length]);
  dates.forEach((date, index) => {
    if (!golfTomorrow(date) || legSets(assignment[index]) === legSets(lightest)) return;
    const swap = dates.findIndex(
      (other, candidate) => candidate !== index && !golfTomorrow(other) && legSets(assignment[candidate]) < legSets(assignment[index]),
    );
    if (swap >= 0) [assignment[index], assignment[swap]] = [assignment[swap], assignment[index]];
    else assignment[index] = lightest;
  });
  return new Map(dates.map((date, index) => [date, assignment[index]]));
}

// ---------------------------------------------------------------------------
// Mobility.

/** One mobility routine as a Todoist task: every movement with its dose and side. */
export function stretchTask(routine, settings, { weekdayIndex }) {
  const lines = [
    `${routine.name} · ${settings.minutes} minuter`,
    "",
    ...routine.movements.map((movement, index) => `${index + 1}. ${movementLine(movement)}`),
    "",
    settings.closing,
  ];
  return {
    content: `${settings.label} – ${capitalize(swedishWeekday(weekdayIndex))}, ${settings.minutes} minuter`,
    description: lines.join("\n"),
  };
}

/** "Höftböjarstretch – 2 × 45 sek per sida. Håll bäckenet neutralt." */
export function movementLine(movement) {
  const side = movement.perSide ? " per sida" : "";
  const sets = movement.sets && movement.sets > 1 ? `${movement.sets} × ` : "";
  const dose = movement.seconds
    ? `${sets}${movement.seconds} sek${side}`
    : `${sets}${movement.reps} ${movement.slow ? "långsamma " : ""}repetitioner${side}`;
  return `${movement.name} – ${dose}.${movement.cue ? ` ${movement.cue}` : ""}`;
}

/** Holds and repetitions on each side, with a little time to switch and set up, in minutes. */
export function estimateStretchMinutes(routine) {
  let seconds = 0;
  for (const movement of routine.movements) {
    const sides = movement.perSide ? 2 : 1;
    const sets = movement.sets ?? 1;
    if (movement.seconds) {
      seconds += sets * movement.seconds * sides + sets * sides * 5;
    } else {
      const perRep = movement.secondsPerRep ?? (movement.slow ? SECONDS_PER_SLOW_REP : SECONDS_PER_REP);
      seconds += sets * movement.reps * perRep * sides;
    }
    seconds += 20;
  }
  return Math.round(seconds / 60);
}

// ---------------------------------------------------------------------------
// Config checks, shared by the tests.

/** What would make a configured session vague or incomplete; [] when every task will be specific. */
export function workoutConfigProblems(activities) {
  const problems = [];
  const gym = activities.gym;
  if (!gym?.sessions?.length) problems.push("gym: no sessions");
  for (const session of gym?.sessions ?? []) {
    if (!session.name || !session.focus) problems.push(`gym: a session has no name or focus`);
    if (!(session.warmUp?.minutes > 0) || !(session.warmUp?.items?.length > 0)) problems.push(`gym ${session.name}: no warm-up`);
    if (!(session.exercises?.length >= 4)) problems.push(`gym ${session.name}: fewer than four exercises`);
    for (const exercise of session.exercises ?? []) {
      if (!exercise.name) problems.push(`gym ${session.name}: an exercise has no name`);
      if (!Number.isInteger(exercise.sets) || exercise.sets < 1) problems.push(`gym ${exercise.name}: no sets`);
      if (!(Number.isInteger(exercise.reps) && exercise.reps > 0) && !(Number.isInteger(exercise.seconds) && exercise.seconds > 0)) {
        problems.push(`gym ${exercise.name}: no repetitions or time`);
      }
      if (!Number.isInteger(exercise.restSeconds) || exercise.restSeconds < 15) problems.push(`gym ${exercise.name}: no rest`);
    }
  }
  if (!gym?.load || !gym?.goal || !gym?.beforeGolf?.text?.includes("{exercises}")) problems.push("gym: load, goal or before-golf text missing");
  const stretch = activities.stretch;
  if (!Number.isInteger(stretch?.minutes)) problems.push("stretch: no length");
  if (!stretch?.routines?.length) problems.push("stretch: no routines");
  for (const routine of stretch?.routines ?? []) {
    if (!routine.name) problems.push("stretch: a routine has no name");
    if (!(routine.movements?.length >= 5)) problems.push(`stretch ${routine.name}: fewer than five movements`);
    for (const movement of routine.movements ?? []) {
      if (!movement.name || !movement.cue) problems.push(`stretch ${routine.name}: a movement has no name or cue`);
      if (!(Number.isInteger(movement.seconds) && movement.seconds > 0) && !(Number.isInteger(movement.reps) && movement.reps > 0)) {
        problems.push(`stretch ${movement.name}: no hold time or repetitions`);
      }
    }
    const minutes = estimateStretchMinutes(routine);
    if (Math.abs(minutes - stretch.minutes) > 2) problems.push(`stretch ${routine.name}: about ${minutes} min, not ${stretch.minutes}`);
  }
  return problems;
}

function capitalize(value) {
  const text = String(value);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(value) {
  const text = String(value);
  return text.charAt(0).toLowerCase() + text.slice(1);
}
