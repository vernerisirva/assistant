/**
 * The golf part of the weekly plan: one week of training toward consistently
 * good competitive golf, built around what the user said about that week.
 *
 * Week-specific facts come only from the user's own words: which days they
 * play and roughly how many holes, competitions and lessons, the one or two
 * things to work on, and how much time a day has. applyGolfChanges checks each
 * such value against the words it came with and refuses one it cannot find
 * there, so a model mapping the reply cannot fill a gap from memory or habit.
 * Saved playbooks only shape the wording: the user's cue word and the names of
 * their own routines.
 *
 * Everything after that is plain code. Rounds, lessons and golf tasks already
 * in Todoist are anchors; practice fills the other days up to six golf days,
 * and at least one day stays golf-free. Six golf days are not six hard days: a
 * practice day is full, moderate or light depending on what surrounds it,
 * several full rounds shrink the practice around them, and the day before a
 * competition is light preparation. The plan says what to practise, never how
 * to swing: a technical priority appears only in the user's (or their
 * coach's) words.
 */
import { listMemoryEntries } from "./memory.mjs";
import { listPlaybooks } from "./playbooks.mjs";
import {
  addDays,
  formatWeekLabel,
  resolvePlanDay,
  shortWeekday,
  weekDates,
  weekdayIndex,
  weekdayName,
} from "./weekly-plan-dates.mjs";

export const MAX_GOLF_DAYS = 6;
export const GOLF_AVOIDABLE = Object.freeze(["range", "on-course"]);
export const GOLF_ROLES_WITH_TASKS = Object.freeze(["practice", "round", "competition", "lesson"]);

export const GOLF_QUESTIONS = Object.freeze({
  rounds: "Which days are you playing next week, and roughly 9 or 18 holes?",
  focus: "What 1–2 things do you want to focus on?",
  events: "Any competition, lesson or other important golf event?",
});

const MAX_FOCUS_AREAS = 2;
const INTENSITY_RANK = Object.freeze({ light: 0, moderate: 1, full: 2 });
/** The least a session needs from its day to be worth doing in full. */
const KIND_DEMAND = Object.freeze({
  range: "full",
  "on-course": "moderate",
  wedges: "moderate",
  "short-game": "moderate",
  scoring: "moderate",
  general: "moderate",
  putting: "light",
  process: "light",
});
const MAINTENANCE_ORDER = Object.freeze(["scoring", "on-course", "short-game", "putting", "wedges", "range"]);
const BALANCE_ORDER = Object.freeze(["wedges", "putting", "short-game", "range", "scoring", "on-course"]);
/** Practice days → [sessions on the main focus, sessions on the second focus]; the rest is upkeep. */
const FOCUS_SHARE = Object.freeze([[0, 0], [1, 0], [1, 1], [2, 1], [2, 1], [2, 2], [3, 2]]);
const SELF_CONTAINED = new Set(["scoring", "comp-prep", "process"]);
const OFF_REASONS = Object.freeze({ unavailable: " (unavailable)", skipped: " (skipped)", past: " (passed)" });
/** Existing task kinds that can stand in for the user's round that day. */
const ROUND_LIKE = new Set(["round", "competition", "golf"]);

// ---------------------------------------------------------------------------
// What a focus area trains. The user's words stay the label; this only picks
// which kind of session fits them. The first match wins, so "putting under
// pressure" is a putting session.

const FOCUS_KIND_PATTERNS = Object.freeze([
  ["putting", /\b(putt\p{L}*|green ?reading|lag ?putt\p{L}*|(3|three)[- ]?putt\p{L}*)/iu],
  ["wedges", /\b(wedg\p{L}*|inspel\p{L}*)|\b\d{2,3}\s*(-|–|to)\s*\d{2,3}\s*(m|metres?|meters?|yards?|yds)\b|\b(inside|under|within)\s+\d{2,3}\s*(m|metres?|meters?|yards?|yds)\b/iu],
  ["short-game", /\b(short ?game|chip\p{L}*|pitch\p{L}*|bunker\p{L}*|sand ?shots?|up[- ]and[- ]downs?|around the greens?|närspel\p{L}*)/iu],
  ["scoring", /\b(scoring|pressure|score\p{L}*)/iu],
  ["on-course", /\b(course management|strategy|decision\p{L}*|club selection|target selection|game ?plan|on[- ]course|banspel\p{L}*)/iu],
  ["process", /\b(mental\p{L}*|routine\p{L}*|pre-?shot|commit\p{L}*|confidence|nerves|patience|reset)/iu],
  ["range", /\b(driv\p{L}*|tee ?shots?|irons?|long ?game|ball[- ]?striking|full swing|swing\p{L}*|club ?face|strike|contact|hybrids?|woods?|fairway\p{L}*|järn\p{L}*|utslag\p{L}*)/iu],
]);

export function golfFocusKind(text) {
  return FOCUS_KIND_PATTERNS.find(([, pattern]) => pattern.test(String(text ?? "")))?.[0] ?? "general";
}

// ---------------------------------------------------------------------------
// Grounding: is a value in the user's words? Lenient about phrasing and
// language (English and Swedish), strict about substance: a weekday that was
// never mentioned cannot become a playing day.

const DAY_WORDS = Object.freeze([
  ["monday", "mon", "måndag", "mån", "mandag"],
  ["tuesday", "tue", "tues", "tisdag", "tis"],
  ["wednesday", "wed", "weds", "onsdag", "ons"],
  ["thursday", "thu", "thur", "thurs", "torsdag", "tors", "tor"],
  ["friday", "fri", "fredag", "fre"],
  ["saturday", "sat", "lördag", "lör", "lordag"],
  ["sunday", "sun", "söndag", "sön", "sondag"],
]);
const MONTH_WORDS = Object.freeze([
  ["jan", "january", "januari"],
  ["feb", "february", "februari"],
  ["mar", "march", "mars"],
  ["apr", "april"],
  ["may", "maj"],
  ["jun", "june", "juni"],
  ["jul", "july", "juli"],
  ["aug", "august", "augusti"],
  ["sep", "sept", "september"],
  ["oct", "october", "okt", "oktober"],
  ["nov", "november"],
  ["dec", "december"],
]);
const NUMBER_WORDS = Object.freeze({
  1: ["one", "single"],
  2: ["two", "couple", "två"],
  3: ["three", "tre"],
  4: ["four", "fyra"],
  5: ["five", "fem"],
  6: ["six", "sex"],
  9: ["nine", "nio"],
  15: ["fifteen", "femton", "a quarter of an hour", "kvart"],
  18: ["eighteen", "arton", "full round", "full rounds"],
  20: ["twenty", "tjugo"],
  30: ["thirty", "trettio", "half an hour", "half hour", "halvtimme"],
  40: ["forty", "fyrtio"],
  45: ["forty-five", "forty five", "fyrtiofem", "three quarters of an hour"],
  60: ["sixty", "an hour", "one hour", "1 hour", "1 h", "1h", "en timme", "1 timme"],
  90: ["ninety", "nittio", "an hour and a half", "one and a half hours", "1.5 hours", "1.5 h", "1,5 h", "1,5 timme", "en och en halv timme"],
  120: ["two hours", "2 hours", "2 h", "2h", "två timmar"],
});

const word = (body) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "iu");
const COMPETITION_PATTERN = word("competition\\p{L}*|comps?|tournament\\p{L}*|tävling\\p{L}*|match\\p{L}*|qualif\\p{L}*|championship\\p{L}*|club champs|cup|medal|stableford|scramble|important");
const LESSON_PATTERN = word("lesson\\p{L}*|lektion\\p{L}*|coach\\p{L}*|tränare\\p{L}*|instructor\\p{L}*|pro");
const BALANCE_PATTERN = word("balance\\p{L}*|balanced|choose|you choose|you pick|pick for me|up to you|your call|whatever|no specific|no particular|nothing specific|nothing in particular|anything|mixed|a mix|välj\\p{L}*|du väljer|blandat|valfritt");
const SAME_PATTERN = word("same|samma|like last week|as last week|as before|som förra veckan|unchanged|oförändrat");
const NORMAL_PATTERN = word("normal|usual|regular|typical|vanlig\\p{L}*");
const NO_ROUNDS_PATTERN = word("no (?:full )?rounds?|not playing|won['’]?t (?:be )?play\\p{L}*|will not play|not going to play|no 18|no 9|inga rundor|ingen runda|spelar inte|inte spela|just practi[cs]e|only practi[cs]e|practi[cs]e only");
const NO_GOLF_PATTERN = word("no golf|not playing golf|no golfing|skip golf|skipping golf|without golf|ingen golf|inte golf|golf[- ]?free|break from golf|pause golf");

const STOPWORDS = new Set(
  (
    "a an the and or but for with from into in on at to of by as is are was were be been am i me my mine you your we our it its this that " +
    "these those next last week weeks day days some more less much very really just also want wants would like get getting bit lot lots " +
    "inside under within over around about between " +
    "focus focusing work working practice practise practicing practising improve improving better main second primary secondary " +
    "thing things area areas game games shot shots play playing golf m meter meters metre metres yard yards yds " +
    "och att på med för vill jobba träna träning fokus mer min mitt mina nästa vecka veckan spel spelet slag golfen"
  ).split(" "),
);

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dayMentioned(date, sources, { today = null } = {}) {
  const index = weekdayIndex(date);
  const dayOfMonth = Number(date.slice(8, 10));
  const month = Number(date.slice(5, 7));
  const months = MONTH_WORDS[month - 1].join("|");
  const patterns = [
    word(`(?:${DAY_WORDS[index].join("|")})(?:s|en|ens|ar|arna)?`),
    new RegExp(escapeRegExp(date)),
    new RegExp(`(?<!\\d)${dayOfMonth}(?:st|nd|rd|th|:e)(?![\\p{L}\\p{N}])`, "iu"),
    new RegExp(`(?<![\\d.])${dayOfMonth}\\s*[./]\\s*${month}(?![\\d])`, "u"),
    new RegExp(`(?<![\\d.])${dayOfMonth}\\.?\\s+(?:${months})(?![\\p{L}])`, "iu"),
    new RegExp(`(?<![\\p{L}])(?:${months})\\.?\\s+${dayOfMonth}(?!\\d)`, "iu"),
  ];
  if (index >= 5) patterns.push(word("weekends?|helg(?:en)?"));
  if (today && date === today) patterns.push(word("today|tonight|idag|i dag|ikväll|i kväll"));
  if (today && date === addDays(today, 1)) patterns.push(word("tomorrow|imorgon|i morgon|imorrn"));
  return sources.some((source) => patterns.some((pattern) => pattern.test(source)));
}

function numberMentioned(value, sources) {
  const patterns = [
    new RegExp(`(?<![\\d.,])${value}(?!\\d)`),
    ...(NUMBER_WORDS[value] ?? []).map((phrase) => word(escapeRegExp(phrase))),
  ];
  return sources.some((source) => patterns.some((pattern) => pattern.test(source)));
}

/** Meaningful words, cut to four letters so "putting" and "putts", or "wedge" and "wedges", match. */
function stemsOf(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token && !STOPWORDS.has(token) && (/^\d+$/.test(token) || token.length >= 3))
    .map((token) => (/^\d+$/.test(token) ? token : token.slice(0, 4)));
}

function sharesWords(value, sources) {
  const wanted = stemsOf(value);
  if (wanted.length === 0) return false;
  const available = new Set(sources.flatMap(stemsOf));
  return wanted.some((stem) => available.has(stem));
}

// ---------------------------------------------------------------------------
// Inputs.

/** The golf part before the user has said anything about the week. */
export function emptyGolfInputs(config) {
  const activeDays = config?.golf?.activeDays ?? MAX_GOLF_DAYS;
  if (!Number.isInteger(activeDays) || activeDays < 0 || activeDays > MAX_GOLF_DAYS) {
    throw new Error(`config golf.activeDays must be a whole number from 0 to ${MAX_GOLF_DAYS}.`);
  }
  return {
    roundsKnown: false,
    rounds: [],
    focus: null,
    lessons: [],
    technicalPriority: null,
    restDays: [],
    unavailableDays: [],
    minutes: {},
    avoid: [],
    activeDays,
    activeDaysExplicit: false,
    pins: [],
    previousRestDays: [],
    saved: null,
  };
}

/** Complete when the week's playing days and focus are known, or the user said no golf at all. */
export function golfInputStatus(golf) {
  if (golf.activeDaysExplicit && golf.activeDays === 0) return { complete: true, missing: [] };
  const missing = [];
  if (!golf.roundsKnown) missing.push("rounds");
  if (!golf.focus) missing.push("focus");
  return { complete: missing.length === 0, missing };
}

/** A golf answer or change that cannot be traced to the user's words. Nothing is stored. */
export class GolfInputError extends Error {
  constructor(problems) {
    super(problems.map((problem) => problem.reason).join(" "));
    this.name = "GolfInputError";
    this.problems = problems;
  }
}

const GOLF_CHANGE_KEYS = Object.freeze([
  "replyText",
  "from",
  "rounds",
  "addRounds",
  "removeRounds",
  "lessons",
  "addLessons",
  "removeLessons",
  "focus",
  "technicalPriority",
  "restDay",
  "unavailableDays",
  "availableDays",
  "minutes",
  "avoid",
  "allow",
  "activeDays",
  "moves",
]);

/**
 * Applies one golf answer or change. `replyText` is the user's exact message,
 * and every new playing day, hole count, competition, lesson, focus area,
 * technical priority and time limit must be found in it (or, for "use my
 * normal golf week", in the saved normal week). Ungrounded values come back as
 * problems with the question to ask instead; the caller stores nothing then.
 *
 * In a plan that was already built (`context.plan`), today's practice sessions
 * and rest day are kept where they are first, so a change moves only what it
 * names, as the rest of the weekly plan does.
 *
 * @returns {{ golf, summary: string[], problems: { field, reason, question }[] }}
 */
export function applyGolfChanges(previous, rawChanges, context) {
  const changes = requireObject(rawChanges, "golf");
  rejectUnknownKeys(changes, GOLF_CHANGE_KEYS, "golf");
  const replyText = requireReplyText(changes.replyText);
  const { weekStart, today = null, previousWeek = null, normalWeekText = null, plan = null } = context;
  const golf = structuredClone(previous);
  if (plan) keepCurrentWeek(golf, plan);
  const summary = [];
  const problems = [];
  const sources = [replyText];
  const resolve = (ref) => resolvePlanDay(ref, weekStart);
  const flag = (field, reason, question = null) => problems.push({ field, reason, question });
  const mentioned = (date) => dayMentioned(date, sources, { today });
  const name = (date) => weekdayName(date);

  if (changes.from !== undefined) {
    if (changes.from !== "normal-week") throw new Error(`Unknown golf answer source: ${changes.from}. Use "normal-week".`);
    if (!NORMAL_PATTERN.test(replyText)) {
      flag("from", "The user did not refer to their normal golf week.", GOLF_QUESTIONS.rounds);
    } else if (!normalWeekText) {
      flag("from", "No normal golf week is saved.", `I don't have your normal golf week saved. ${GOLF_QUESTIONS.rounds}`);
    } else {
      sources.push(normalWeekText);
    }
  }

  if (changes.activeDays !== undefined) {
    const count = Number(changes.activeDays);
    if (!Number.isInteger(count) || count < 0) throw new Error(`activeDays must be a whole number from 0 to ${MAX_GOLF_DAYS}.`);
    if (count > MAX_GOLF_DAYS) {
      flag("activeDays", "Seven golf days would leave no golf-free day.", "I keep at least one golf-free day each week. Shall I plan six golf days?");
    } else if (count === 0 ? !NO_GOLF_PATTERN.test(replyText) : !numberMentioned(count, sources)) {
      flag("activeDays", count === 0 ? "The user did not say no golf." : `The user did not ask for ${count} golf days.`);
    } else {
      if (count === 0) {
        golf.rounds = [];
        golf.lessons = [];
        golf.pins = [];
        golf.roundsKnown = true;
        summary.push("No golf this week");
      } else if (count !== golf.activeDays) {
        summary.push(`Golf days ${golf.activeDays} → ${count}`);
      }
      golf.activeDays = count;
      golf.activeDaysExplicit = true;
    }
  }

  // Only what the answer adds needs the user's words: "Saturday is now a
  // competition" keeps Saturday's known hole count without repeating it.
  const groundRound = (round, before = null) => {
    if (!mentioned(round.date)) flag("rounds", `${name(round.date)} is not in the user's words.`, GOLF_QUESTIONS.rounds);
    if (round.holes !== null && round.holes !== before?.holes && !numberMentioned(round.holes, sources)) {
      flag("holes", `${round.holes} holes is not in the user's words.`, `Roughly 9 or 18 holes on ${name(round.date)}?`);
    }
    if (round.competition && !before?.competition && !COMPETITION_PATTERN.test(sources.join("\n"))) {
      flag("competition", `A competition on ${name(round.date)} is not in the user's words.`);
    }
  };
  const merged = (raw, before) => ({
    date: raw.date,
    holes: raw.holes === undefined ? before?.holes ?? null : raw.holes,
    competition: raw.competition === undefined ? before?.competition ?? false : raw.competition,
  });

  if (changes.rounds !== undefined) {
    if (changes.rounds === "same-as-last-week") {
      if (!SAME_PATTERN.test(replyText)) {
        flag("rounds", "The user did not ask for last week's playing days.", GOLF_QUESTIONS.rounds);
      } else if (!previousWeek?.golf?.roundsKnown) {
        flag("rounds", "Last week's playing days are not saved.", `I don't have last week's playing days. ${GOLF_QUESTIONS.rounds}`);
      } else {
        // Same days and holes; a competition belongs to its own week.
        golf.rounds = previousWeek.golf.rounds.map((round) => ({
          date: addDays(weekStart, weekdayIndex(round.date)),
          holes: round.holes,
          competition: false,
        }));
        golf.roundsKnown = true;
        summary.push("Golf: same playing days as last week");
      }
    } else {
      const rounds = requireList(changes.rounds, "rounds", 7).map((raw) => merged(normalizeRound(raw, resolve), null));
      if (rounds.length === 0 && !NO_ROUNDS_PATTERN.test(replyText) && !NO_GOLF_PATTERN.test(replyText)) {
        flag("rounds", "The user did not say they are not playing.", GOLF_QUESTIONS.rounds);
      }
      rounds.forEach((round) => groundRound(round));
      golf.rounds = sortByDate(uniqueByDate(rounds));
      golf.roundsKnown = true;
      summary.push(rounds.length === 0 ? "Golf: no rounds" : `Golf: ${rounds.map(describeRound).join(", ")}`);
    }
  }
  for (const raw of requireList(changes.addRounds ?? [], "addRounds", 7)) {
    const given = normalizeRound(raw, resolve);
    const before = golf.rounds.find((existing) => existing.date === given.date) ?? null;
    const round = merged(given, before);
    groundRound(round, before);
    golf.rounds = sortByDate([...golf.rounds.filter((existing) => existing.date !== round.date), round]);
    golf.restDays = golf.restDays.filter((date) => date !== round.date);
    golf.roundsKnown = true;
    summary.push(`Golf: + ${describeRound(round)}`);
  }
  for (const ref of requireList(changes.removeRounds ?? [], "removeRounds", 7)) {
    const date = resolve(ref);
    if (!golf.rounds.some((round) => round.date === date)) throw new Error(`There is no round on ${name(date)} to remove.`);
    golf.rounds = golf.rounds.filter((round) => round.date !== date);
    golf.roundsKnown = true;
    summary.push(`Golf: no round ${shortWeekday(date)}`);
  }

  const groundLesson = (lesson) => {
    if (!mentioned(lesson.date)) flag("lessons", `${name(lesson.date)} is not in the user's words.`, `Which day is the lesson?`);
    if (!LESSON_PATTERN.test(sources.join("\n"))) flag("lessons", "A lesson is not in the user's words.");
  };
  if (changes.lessons !== undefined) {
    const lessons = requireList(changes.lessons, "lessons", 7).map((raw) => normalizeLesson(raw, resolve));
    lessons.forEach(groundLesson);
    golf.lessons = sortByDate(uniqueByDate(lessons));
    summary.push(lessons.length === 0 ? "Golf: no lessons" : `Golf: lesson ${lessons.map((lesson) => shortWeekday(lesson.date)).join(", ")}`);
  }
  for (const raw of requireList(changes.addLessons ?? [], "addLessons", 7)) {
    const lesson = normalizeLesson(raw, resolve);
    groundLesson(lesson);
    golf.lessons = sortByDate([...golf.lessons.filter((existing) => existing.date !== lesson.date), lesson]);
    golf.restDays = golf.restDays.filter((date) => date !== lesson.date);
    summary.push(`Golf: + lesson ${shortWeekday(lesson.date)}`);
  }
  for (const ref of requireList(changes.removeLessons ?? [], "removeLessons", 7)) {
    const date = resolve(ref);
    golf.lessons = golf.lessons.filter((lesson) => lesson.date !== date);
    summary.push(`Golf: no lesson ${shortWeekday(date)}`);
  }

  if (changes.focus !== undefined) {
    if (changes.focus === "balance") {
      if (!BALANCE_PATTERN.test(replyText)) flag("focus", "The user did not ask you to choose the practice balance.", GOLF_QUESTIONS.focus);
      golf.focus = { mode: "balance", areas: [] };
      summary.push("Golf: balanced practice");
    } else if (changes.focus === "same-as-last-week") {
      if (!SAME_PATTERN.test(replyText)) {
        flag("focus", "The user did not ask for last week's focus.", GOLF_QUESTIONS.focus);
      } else if (!previousWeek?.golf?.focus) {
        flag("focus", "Last week's focus is not saved.", `I don't have last week's focus. ${GOLF_QUESTIONS.focus}`);
      } else {
        golf.focus = structuredClone(previousWeek.golf.focus);
        summary.push("Golf: same focus as last week");
      }
    } else {
      const areas = requireList(changes.focus, "focus", MAX_FOCUS_AREAS).map((area) => normalizeShortText(area, "focus area", 60));
      if (areas.length === 0) throw new Error("focus needs one or two areas, \"balance\" or \"same-as-last-week\".");
      const known = new Set((golf.focus?.areas ?? []).map((area) => area.toLowerCase()));
      for (const area of areas) {
        if (!known.has(area.toLowerCase()) && !sharesWords(area, sources)) {
          flag("focus", `"${area}" is not in the user's words.`, GOLF_QUESTIONS.focus);
        }
      }
      golf.focus = { mode: "areas", areas: uniqueText(areas) };
      summary.push(`Golf: focus ${golf.focus.areas.map(lowerFirst).join(", ")}`);
    }
    // The sessions follow the new focus; upkeep sessions stay where they are.
    golf.pins = golf.pins.filter((pin) => pin.focusIndex === null);
  }

  if (changes.technicalPriority !== undefined) {
    if (changes.technicalPriority === null) {
      golf.technicalPriority = null;
    } else {
      const priority = normalizeShortText(changes.technicalPriority, "technicalPriority", 80);
      if (priority.toLowerCase() !== String(golf.technicalPriority ?? "").toLowerCase() && !sharesWords(priority, sources)) {
        flag("technicalPriority", `"${priority}" is not in the user's words.`);
      }
      golf.technicalPriority = priority;
      summary.push(`Golf: technical priority ${lowerFirst(priority)}`);
    }
  }

  if (changes.restDay !== undefined) {
    const date = resolve(changes.restDay);
    if (!mentioned(date)) flag("restDay", `${name(date)} is not in the user's words.`, "Which day should be golf-free?");
    if (golf.rounds.some((round) => round.date === date) || golf.lessons.some((lesson) => lesson.date === date)) {
      flag("restDay", `The user plays or has a lesson on ${name(date)}.`, `You're playing on ${name(date)}. Which day should be golf-free?`);
    }
    golf.restDays = [date];
    golf.pins = golf.pins.filter((pin) => pin.date !== date);
    summary.push(`Golf: rest day ${shortWeekday(date)}`);
  }

  for (const ref of requireList(changes.unavailableDays ?? [], "unavailableDays", 7)) {
    const date = resolve(ref);
    if (!mentioned(date)) flag("unavailableDays", `${name(date)} is not in the user's words.`);
    if (!golf.unavailableDays.includes(date)) golf.unavailableDays = [...golf.unavailableDays, date].sort();
    golf.pins = golf.pins.filter((pin) => pin.date !== date);
    summary.push(`Golf: no golf ${shortWeekday(date)}`);
  }
  for (const ref of requireList(changes.availableDays ?? [], "availableDays", 7)) {
    const date = resolve(ref);
    golf.unavailableDays = golf.unavailableDays.filter((candidate) => candidate !== date);
    summary.push(`Golf: ${shortWeekday(date)} available`);
  }

  if (changes.minutes !== undefined) {
    for (const [ref, value] of Object.entries(requireObject(changes.minutes, "minutes"))) {
      const date = resolve(ref);
      if (value === null) {
        delete golf.minutes[date];
        summary.push(`Golf: ${shortWeekday(date)} no time limit`);
        continue;
      }
      const minutes = Number(value);
      if (!Number.isInteger(minutes) || minutes < 10 || minutes > 240) throw new Error("minutes must be whole minutes from 10 to 240.");
      if (!mentioned(date)) flag("minutes", `${name(date)} is not in the user's words.`);
      if (!numberMentioned(minutes, sources)) flag("minutes", `${minutes} minutes is not in the user's words.`);
      golf.minutes = { ...golf.minutes, [date]: minutes };
      summary.push(`Golf: ${shortWeekday(date)} ${minutes} min`);
    }
  }

  for (const kind of requireList(changes.avoid ?? [], "avoid", GOLF_AVOIDABLE.length)) {
    if (!GOLF_AVOIDABLE.includes(kind)) throw new Error(`avoid accepts ${GOLF_AVOIDABLE.join(" or ")}.`);
    if (!golf.avoid.includes(kind)) golf.avoid = [...golf.avoid, kind];
    golf.pins = golf.pins.filter((pin) => pin.kind !== kind);
    summary.push(kind === "range" ? "Golf: no range sessions" : "Golf: no on-course practice");
  }
  for (const kind of requireList(changes.allow ?? [], "allow", GOLF_AVOIDABLE.length)) {
    if (!GOLF_AVOIDABLE.includes(kind)) throw new Error(`allow accepts ${GOLF_AVOIDABLE.join(" or ")}.`);
    golf.avoid = golf.avoid.filter((candidate) => candidate !== kind);
    summary.push(kind === "range" ? "Golf: range sessions allowed" : "Golf: on-course practice allowed");
  }

  // Never a seven-day golf week, even from named rounds and lessons: ask
  // which day stays golf-free instead of dropping one the user named.
  const golfDates = new Set([...golf.rounds, ...golf.lessons].map((entry) => entry.date));
  if (golfDates.size >= 7) {
    flag("rounds", "That would be golf on all seven days.", "That's golf every day next week. Which day should be golf-free?");
  }

  for (const raw of requireList(changes.moves ?? [], "moves", 7)) {
    if (!plan) throw new Error("Golf sessions can be moved once the plan has been built and shown.");
    requireObject(raw, "golf move");
    rejectUnknownKeys(raw, ["from", "to"], "golf move");
    const from = resolve(raw.from);
    const to = resolve(raw.to);
    if (from === to) continue;
    if (!mentioned(to)) flag("moves", `${name(to)} is not in the user's words.`);
    summary.push(moveGolfDay(golf, plan, from, to));
  }

  return { golf, summary, problems };
}

/**
 * A shown week keeps its practice sessions and its golf-free day unless a
 * change names them, whatever else in the weekly plan changes.
 */
export function keepCurrentGolfWeek(previous, plan) {
  const golf = structuredClone(previous);
  if (plan) keepCurrentWeek(golf, plan);
  return golf;
}

function keepCurrentWeek(golf, plan) {
  const pinned = new Set(golf.pins.map((pin) => pin.date));
  for (const day of plan.days ?? []) {
    if (day.role === "practice" && day.kind !== "comp-prep" && !pinned.has(day.date)) {
      golf.pins.push({ date: day.date, kind: day.kind, focusIndex: day.focusIndex ?? null });
    }
  }
  golf.pins.sort((a, b) => a.date.localeCompare(b.date));
  golf.previousRestDays = (plan.days ?? []).filter((day) => day.role === "rest").map((day) => day.date);
}

function moveGolfDay(golf, plan, from, to) {
  const source = plan.days.find((day) => day.date === from);
  const target = plan.days.find((day) => day.date === to);
  if (source?.role === "existing") {
    throw new Error(`${weekdayName(from)}'s golf is an existing Todoist task; the weekly plan does not move existing tasks.`);
  }
  if (!source || !GOLF_ROLES_WITH_TASKS.includes(source.role)) throw new Error(`There is no planned golf on ${weekdayName(from)} to move.`);
  if (source.kind === "comp-prep") {
    throw new Error("Competition preparation stays on the day before the competition; move the competition instead.");
  }
  if (target && ["round", "competition", "lesson", "existing"].includes(target.role)) {
    throw new Error(`${weekdayName(to)} already has ${target.role === "existing" ? "a golf task in Todoist" : `a ${target.role}`}. Say which session should go there instead.`);
  }
  if (target?.kind === "comp-prep") {
    throw new Error(`${weekdayName(to)} is competition preparation, the day before the competition. Pick another day.`);
  }
  if (target?.role === "off") throw new Error(`${weekdayName(to)} is not available for golf this week.`);

  golf.restDays = golf.restDays.filter((date) => date !== to);
  if (source.role === "round" || source.role === "competition") {
    golf.rounds = sortByDate(golf.rounds.map((round) => (round.date === from ? { ...round, date: to } : round)));
    golf.pins = golf.pins.filter((pin) => pin.date !== to);
    return `Golf: ${source.role} ${shortWeekday(from)} → ${shortWeekday(to)}`;
  }
  if (source.role === "lesson") {
    golf.lessons = sortByDate(golf.lessons.map((lesson) => (lesson.date === from ? { ...lesson, date: to } : lesson)));
    golf.pins = golf.pins.filter((pin) => pin.date !== to);
    return `Golf: lesson ${shortWeekday(from)} → ${shortWeekday(to)}`;
  }

  // A practice session swaps with whatever is on the target day; moving it
  // onto the golf-free day makes its old day the golf-free one.
  golf.pins = golf.pins.filter((pin) => pin.date !== from && pin.date !== to);
  golf.pins.push({ date: to, kind: source.kind, focusIndex: source.focusIndex ?? null });
  if (target?.role === "practice") golf.pins.push({ date: from, kind: target.kind, focusIndex: target.focusIndex ?? null });
  if (target?.role === "rest") golf.restDays = [from];
  golf.pins.sort((a, b) => a.date.localeCompare(b.date));
  return `Golf: ${lowerFirst(source.label)} ${shortWeekday(from)} → ${shortWeekday(to)}`;
}

/** `holes` and `competition` stay undefined when the answer does not mention them. */
function normalizeRound(raw, resolve) {
  const value = requireObject(raw, "round");
  rejectUnknownKeys(value, ["day", "holes", "competition"], "round");
  let holes;
  if (value.holes !== undefined && value.holes !== null) {
    holes = Number(value.holes);
    if (!Number.isInteger(holes) || holes < 1 || holes > 36) throw new Error("Round holes must be a whole number from 1 to 36.");
  }
  if (value.competition !== undefined && typeof value.competition !== "boolean") throw new Error("Round competition must be true or false.");
  return { date: resolve(value.day), holes, competition: value.competition };
}

function normalizeLesson(raw, resolve) {
  const value = typeof raw === "string" ? { day: raw } : requireObject(raw, "lesson");
  rejectUnknownKeys(value, ["day", "note"], "lesson");
  return { date: resolve(value.day), note: value.note ? normalizeShortText(value.note, "lesson note", 80) : null };
}

function describeRound(round) {
  const day = shortWeekday(round.date);
  if (round.competition) return `${day} competition${round.holes ? ` (${round.holes} holes)` : ""}`;
  return round.holes ? `${round.holes} holes ${day}` : `round ${day}`;
}

// ---------------------------------------------------------------------------
// The week.

/**
 * Derives the golf week from the golf inputs and the rest of the weekly plan's
 * facts. Deterministic: the same inputs always give the same week.
 *
 * @param existing open golf tasks already in Todoist for the week, `{ date, title, golfKind }`
 * @param dayLoads the weekly plan's Calendar-based loads (`heavy`, `unavailable`, ...)
 * @param skipDays days the plan keeps free of anything new
 * @param today the local date when the plan is built; earlier days get nothing new
 */
export function deriveGolfWeek({ golf, weekStart, existing = [], dayLoads = {}, skipDays = [], today = null, config }) {
  const settings = config.golf;
  const dates = weekDates(weekStart);
  const notes = [];
  const days = new Map(dates.map((date) => [date, { date, role: null }]));
  const skip = new Set(skipDays);
  const passed = (date) => Boolean(today) && date < today;
  const noGolf = golf.activeDaysExplicit && golf.activeDays === 0;

  for (const task of existing) {
    const day = days.get(task.date);
    if (!day || day.role) continue;
    Object.assign(day, { role: "existing", existingKind: task.golfKind ?? "golf", title: task.title });
  }
  // An existing golf task stands in for the user's round only when its title
  // reliably names a round (or just "golf"). A practice or lesson task that
  // day stays as it is, and the round gets its own task.
  for (const round of golf.rounds) {
    const day = days.get(round.date);
    if (!day) continue;
    if (skip.has(round.date) || passed(round.date)) {
      notes.push(`${weekdayName(round.date)} is ${skip.has(round.date) ? "skipped" : "already past"}, so its round isn't in the plan.`);
      continue;
    }
    if (day.role === "existing" && ROUND_LIKE.has(day.existingKind)) {
      day.round = round;
      continue;
    }
    const alongside = day.role === "existing" ? day.title : null;
    Object.assign(day, { role: round.competition ? "competition" : "round", round, ...(alongside ? { alongside } : {}) });
  }
  for (const lesson of golf.lessons) {
    const day = days.get(lesson.date);
    if (!day) continue;
    if (skip.has(lesson.date) || passed(lesson.date)) {
      notes.push(`${weekdayName(lesson.date)} is ${skip.has(lesson.date) ? "skipped" : "already past"}, so its lesson isn't in the plan.`);
      continue;
    }
    if (day.role && !(day.role === "existing" && !["lesson", "golf"].includes(day.existingKind))) {
      day.lesson = lesson;
      continue;
    }
    const alongside = day.role === "existing" ? day.title : null;
    Object.assign(day, { role: "lesson", lesson, ...(alongside ? { alongside } : {}) });
  }
  for (const date of golf.restDays) {
    if (days.get(date)?.role === "existing") notes.push(`${weekdayName(date)} already has a golf task in Todoist, so it isn't golf-free.`);
  }

  const offReason = (date) => {
    if (passed(date)) return "past";
    if (skip.has(date)) return "skipped";
    if (golf.restDays.includes(date)) return "rest";
    if (golf.unavailableDays.includes(date) || dayLoads[date]?.load === "unavailable") return "unavailable";
    return null;
  };
  const anchors = dates.filter((date) => days.get(date).role);
  const candidates = dates.filter((date) => !days.get(date).role && !offReason(date));
  const target = noGolf ? 0 : golf.activeDays;
  let need = Math.max(0, target - anchors.length);
  if (need > candidates.length) {
    notes.push(`Only room for ${anchors.length + candidates.length} golf days this week.`);
    need = candidates.length;
  }
  if (anchors.length >= 7) notes.push("There's no golf-free day this week.");

  const isHigh = (day) => {
    if (!day) return false;
    const round = day.round;
    if (round) return round.competition || (round.holes ?? 18) >= 18;
    return day.role === "existing" && ["round", "competition"].includes(day.existingKind);
  };
  const isCompetition = (day) =>
    Boolean(day) && (day.role === "competition" || Boolean(day.round?.competition) || (day.role === "existing" && day.existingKind === "competition"));
  const at = (date, offset) => days.get(addDays(date, offset));

  // The golf-free day: after a competition or a full round, or on a heavy
  // work day; never the day before a competition when avoidable. Later days
  // win ties, and the week's previous golf-free day stays when it still fits.
  const restScore = (date) => {
    let score = 0;
    const load = dayLoads[date]?.load;
    if (load === "heavy") score -= 4;
    if (load === "light") score += 1;
    const previous = at(date, -1);
    if (isCompetition(previous)) score -= 3;
    else if (isHigh(previous)) score -= 2;
    else if (previous?.round) score -= 1;
    if (isCompetition(at(date, 1))) score += 3;
    if ((golf.previousRestDays ?? []).includes(date)) score -= 5;
    return score;
  };
  const restCount = candidates.length - need;
  const chosenRest = new Set(
    [...candidates].sort((a, b) => restScore(a) - restScore(b) || b.localeCompare(a)).slice(0, restCount),
  );
  for (const date of dates) {
    const day = days.get(date);
    if (day.role) continue;
    const reason = offReason(date);
    if (reason === "rest" || chosenRest.has(date)) day.role = "rest";
    else if (reason) Object.assign(day, { role: "off", reason });
    else day.role = "practice";
  }

  // How much each practice day can take.
  const fullRounds = dates.filter((date) => isHigh(days.get(date))).length;
  const practiceDates = dates.filter((date) => days.get(date).role === "practice");
  for (const date of practiceDates) {
    const day = days.get(date);
    if (isCompetition(at(date, 1))) {
      Object.assign(day, { intensity: "prep", kind: "comp-prep", focusIndex: null });
      continue;
    }
    let cap = "full";
    const lower = (to) => {
      if (INTENSITY_RANK[to] < INTENSITY_RANK[cap]) cap = to;
    };
    if (isCompetition(at(date, -1))) lower("light");
    if (dayLoads[date]?.load === "heavy") lower("light");
    const minutes = golf.minutes[date];
    if (minutes !== undefined) lower(minutes < 45 ? "light" : minutes < 60 ? "moderate" : "full");
    if (isHigh(at(date, -1)) || isHigh(at(date, 1))) lower("moderate");
    if (isCompetition(at(date, 2))) lower("moderate");
    if (fullRounds >= 3) lower("light");
    else if (fullRounds === 2) lower("moderate");
    day.intensity = cap;
  }

  // Which session goes where: the user's moves first, then the pool.
  const free = practiceDates.filter((date) => days.get(date).kind !== "comp-prep");
  const playing = dates.filter((date) => {
    const day = days.get(date);
    return day.round || (day.role === "existing" && ["round", "competition"].includes(day.existingKind));
  }).length;
  const pool = sessionPool(free.length, golf, { playing });
  const assignment = new Map();
  for (const pin of golf.pins) {
    if (!free.includes(pin.date) || assignment.has(pin.date)) continue;
    if (golf.avoid.includes(pin.kind)) continue;
    if (pin.focusIndex !== null && !golf.focus?.areas?.[pin.focusIndex]) continue;
    const index = pool.findIndex((session) => session.kind === pin.kind && session.focusIndex === pin.focusIndex);
    pool.splice(index >= 0 ? index : pool.length - 1, 1);
    assignment.set(pin.date, { kind: pin.kind, focusIndex: pin.focusIndex });
  }
  const open = free.filter((date) => !assignment.has(date));
  const sessionCost = (date, session, chosen) => {
    const day = days.get(date);
    const demand = INTENSITY_RANK[KIND_DEMAND[session.kind]];
    const capacity = INTENSITY_RANK[day.intensity];
    let cost = demand > capacity ? (session.kind === "range" ? 12 : 5) * (demand - capacity) : 0.5 * (capacity - demand);
    const position = weekdayIndex(date);
    // Development work early in the week, transfer and testing later.
    if (session.focusIndex === 0) cost += 0.3 * position;
    if (session.focusIndex === 1) cost += 0.1 * position;
    if (session.kind === "range" && isCompetition(at(date, 2))) cost += 8;
    if (session.kind === "range" && (isHigh(at(date, -1)) || isHigh(at(date, 1)))) cost += 3;
    if (chosen.get(addDays(date, 1))?.kind === session.kind) cost += 2;
    return cost;
  };
  let best = null;
  let bestCost = Infinity;
  for (const order of permutations(pool)) {
    const chosen = new Map(assignment);
    open.forEach((date, index) => chosen.set(date, order[index]));
    let cost = 0;
    for (const [date, session] of chosen) cost += sessionCost(date, session, chosen);
    if (cost < bestCost - 1e-9) {
      best = chosen;
      bestCost = cost;
    }
  }
  for (const [date, session] of best ?? assignment) Object.assign(days.get(date), session);

  // Test what was trained: the last session of a focus that has several, and
  // every second session of a balanced week. Learning sessions end with a
  // routine finish instead, so not every session is a test.
  const sessions = practiceDates.map((date) => days.get(date)).filter((day) => !SELF_CONTAINED.has(day.kind));
  if (golf.focus?.mode === "areas") {
    for (const index of [0, 1]) {
      const ofFocus = sessions.filter((day) => day.focusIndex === index);
      if (ofFocus.length >= 2) ofFocus.at(-1).pressure = true;
    }
  } else {
    sessions.forEach((day, index) => {
      if (index % 2 === 1) day.pressure = true;
    });
  }

  // Labels, minutes and the rounds' process objectives.
  for (const date of practiceDates) {
    const day = days.get(date);
    const kindSettings = settings.sessions[day.kind];
    day.pressure = Boolean(day.pressure) || day.kind === "scoring";
    day.label = day.focusIndex !== null && day.focusIndex !== undefined ? golf.focus.areas[day.focusIndex] : kindSettings.label;
    if (day.kind === "on-course") {
      day.holes = kindSettings.holes;
    } else {
      day.minutes = sessionBlocks(day, kindSettings).reduce((total, [, minutes]) => total + minutes, 0);
      if (golf.minutes[date] !== undefined && golf.minutes[date] < day.minutes) day.limitMinutes = golf.minutes[date];
    }
  }
  const objectives = settings.roundObjectives;
  let normalRounds = 0;
  for (const date of dates) {
    const day = days.get(date);
    if (day.role === "competition") {
      Object.assign(day, { holes: day.round.holes, objective: objectives[settings.competitionObjective ?? 0] });
    } else if (day.role === "round") {
      Object.assign(day, { holes: day.round.holes, objective: objectives[normalRounds % objectives.length] });
      normalRounds += 1;
    }
  }

  const list = dates.map((date) => publicDay(days.get(date)));
  return {
    direction: settings.direction ?? null,
    targetDays: target,
    activeDays: list.filter((day) => GOLF_ROLES_WITH_TASKS.includes(day.role) || day.role === "existing").length,
    restDays: list.filter((day) => day.role === "rest").length,
    focus: golf.focus ? structuredClone(golf.focus) : null,
    technicalPriority: golf.technicalPriority ?? null,
    saved: golf.saved ?? null,
    days: list,
    notes,
  };
}

function publicDay(day) {
  const base = { date: day.date, role: day.role };
  switch (day.role) {
    case "practice":
      return {
        ...base,
        kind: day.kind,
        focusIndex: day.focusIndex ?? null,
        label: day.label,
        intensity: day.intensity,
        ...(day.minutes !== undefined ? { minutes: day.minutes } : {}),
        ...(day.holes !== undefined ? { holes: day.holes } : {}),
        ...(day.limitMinutes !== undefined ? { limitMinutes: day.limitMinutes } : {}),
        pressure: day.pressure,
      };
    case "round":
    case "competition":
      return {
        ...base,
        holes: day.holes ?? null,
        objective: day.objective,
        ...(day.lesson ? { lesson: day.lesson } : {}),
        ...(day.alongside ? { alongside: day.alongside } : {}),
      };
    case "lesson":
      return { ...base, note: day.lesson.note ?? null, ...(day.alongside ? { alongside: day.alongside } : {}) };
    case "existing":
      return {
        ...base,
        title: day.title,
        existingKind: day.existingKind,
        ...(day.round ? { round: { holes: day.round.holes, competition: day.round.competition } } : {}),
      };
    case "off":
      return { ...base, reason: day.reason };
    default:
      return base;
  }
}

function sessionPool(count, golf, { playing }) {
  if (count === 0) return [];
  const avoid = new Set(golf.avoid);
  const allowed = (kind) => !avoid.has(kind) && (kind !== "on-course" || playing <= 1);
  const kindFor = (area) => {
    const kind = golfFocusKind(area);
    if (!avoid.has(kind)) return kind;
    return kind === "range" && !avoid.has("on-course") ? "on-course" : "general";
  };
  const pool = [];
  if (golf.focus?.mode === "areas") {
    const [first, second] = golf.focus.areas;
    const [main, other] = FOCUS_SHARE[Math.min(count, 6)];
    for (let index = 0; index < main; index += 1) pool.push({ kind: kindFor(first), focusIndex: 0 });
    for (let index = 0; second && index < other; index += 1) pool.push({ kind: kindFor(second), focusIndex: 1 });
    const covered = new Set(pool.map((session) => session.kind));
    const upkeep = MAINTENANCE_ORDER.filter((kind) => allowed(kind) && !covered.has(kind));
    for (let index = 0; pool.length < count; index += 1) pool.push({ kind: upkeep[index % upkeep.length] ?? "scoring", focusIndex: null });
  } else {
    const order = BALANCE_ORDER.filter(allowed);
    for (let index = 0; pool.length < count; index += 1) pool.push({ kind: order[index % order.length], focusIndex: null });
  }
  return pool;
}

/** Every distinct ordering, in a fixed order; identical sessions are not repeated. */
function* permutations(items) {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  const seen = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const key = `${items[index].kind}|${items[index].focusIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) yield [items[index], ...tail];
  }
}

const finishCount = (intensity) => (intensity === "light" ? 5 : 10);

/** The session's blocks as `[text, minutes]`: the day's variant, then a finish that tests or rehearses. */
function sessionBlocks(day, kindSettings) {
  const variants = kindSettings.variants;
  const blocks = [...(variants[day.intensity] ?? variants.moderate ?? variants.prep ?? [])];
  if (kindSettings.selfContained) return blocks;
  const count = finishCount(day.intensity);
  const finish = (day.pressure ? kindSettings.pressure : kindSettings.routine).replaceAll("{n}", String(count));
  if (day.intensity === "light") return [...blocks, [finish, 5]];
  if (day.intensity === "moderate") return [...blocks, [finish, 10]];
  return [...blocks, [finish, 10], [day.pressure ? "Record the result" : "Note one thing that improved", 5]];
}

// ---------------------------------------------------------------------------
// Todoist tasks: one per golf day, with the whole plan in the description.

export function golfTask(day, week, settings) {
  const saved = week.saved ?? {};
  const mental = `${settings.mentalFocus}${saved.cueWord ? ` Cue: ${saved.cueWord}.` : ""}`;
  const badShot = saved.badShotReset ? `Use your ${lowerFirst(saved.badShotReset)}, then make the next decision.` : settings.badShot;
  const golfTitle = settings.titles.golf;

  if (day.role === "practice") {
    const kindSettings = settings.sessions[day.kind];
    const lines = ["Focus", focusLine(day, week)];
    if (day.kind === "on-course") {
      lines.push("", `Session · ${day.holes} holes`, ...kindSettings.steps.map((step) => `- ${step}`));
      if (day.pressure) lines.push(`- ${kindSettings.pressure}`);
    } else {
      lines.push("", `Session · ${day.minutes} min`, ...sessionBlocks(day, kindSettings).map(([text, minutes]) => `- ${text}: ${minutes} min`));
      if (day.limitMinutes) lines.push(`Only ${day.limitMinutes} min that day: do the blocks in order and stop there.`);
    }
    if (day.kind === "range") lines.push("", "Technical priority", week.technicalPriority ?? "Your current one from your lesson or coach.");
    lines.push("", "Mental focus", mental);
    if (day.kind === "comp-prep") {
      const routine = saved.competitionRoutine ?? saved.preRoundRoutine;
      if (routine) lines.push(`Rehearse your ${lowerFirst(routine)}.`);
    }
    lines.push("", "Success", successLine(day, kindSettings));
    return { content: `${settings.titles.practice} — ${day.label}`, description: lines.join("\n") };
  }

  if (day.role === "round" || day.role === "competition") {
    const competition = day.role === "competition";
    const lines = [];
    if (competition && day.holes) lines.push(`${day.holes} holes.`, "");
    lines.push("Process objective", day.objective.text);
    const routine = competition ? saved.competitionRoutine ?? saved.preRoundRoutine : saved.preRoundRoutine;
    if (routine) lines.push("", "Before the round", `Your ${lowerFirst(routine)}.`);
    else if (competition) lines.push("", "Before the round", settings.competitionWarmUp);
    lines.push("", "Mental focus", mental, "", "After a bad shot", badShot);
    if (day.lesson) lines.push("", "Lesson", day.lesson.note ?? "Lesson that day as well.");
    lines.push(
      "",
      "Afterwards",
      competition
        ? "Judge the day on the process objective, not only the score. Say “Debrief my round” to go through it."
        : "Note two decisions to keep and one to change. Say “Debrief my round” to go through it.",
    );
    const title = competition ? "Competition" : day.holes ? `${day.holes}-hole round` : "Round";
    return { content: `${golfTitle} — ${title}`, description: lines.join("\n") };
  }

  if (day.role === "lesson") {
    const lines = [];
    if (day.note) lines.push(day.note, "");
    lines.push(
      "Before",
      "Bring your current technical priority and one question for your coach.",
      "",
      "Afterwards",
      "Write down the one or two things your coach wants you to work on, and tell me if this week's practice should change.",
    );
    return { content: `${golfTitle} — Lesson`, description: lines.join("\n") };
  }

  throw new Error(`A ${day.role} day has no golf task.`);
}

function focusLine(day, week) {
  if (day.kind === "comp-prep") return "Feel and routine before the competition.";
  if (day.focusIndex !== null && day.focusIndex !== undefined) return day.label;
  if (day.kind === "scoring") return "Scoring under pressure.";
  return week.focus?.mode === "areas" ? `${day.label}, to keep it sharp.` : `${day.label}, as part of a balanced week.`;
}

function successLine(day, kindSettings) {
  if (kindSettings.success) return kindSettings.success;
  if (day.kind === "on-course") return "The full routine on every shot; judge it on commitment, not the score.";
  if (day.pressure) return `All ${finishCount(day.intensity)} test shots with the full routine; write down the score.`;
  return "Every ball has a clear target; note one thing that improved.";
}

// ---------------------------------------------------------------------------
// Messages.

/** The Saturday question: one compact message, answered naturally. */
export function formatGolfQuestion({ weekStart, previousWeek = null }) {
  const lines = [
    `Next week's plan · ${formatWeekLabel(weekStart)}`,
    "",
    "Before I build next week's golf plan:",
    "",
    `1. ${GOLF_QUESTIONS.rounds}`,
    `2. ${GOLF_QUESTIONS.focus}`,
    `3. ${GOLF_QUESTIONS.events}`,
    "",
    "You can answer naturally, e.g.",
    "\"18 holes Wednesday and Saturday. Focus on wedges 50–100 m and putting inside 2 m. Saturday is a competition.\"",
  ];
  const last = previousWeek?.golf ? describeGolfInput(previousWeek.golf) : null;
  if (last) lines.push("", `Last week: ${last}.`);
  lines.push("", "Then you'll get the full plan to review. Nothing goes into Todoist before you've seen it.");
  return lines.join("\n");
}

/** Asks only for what is still missing, after saying what was understood. */
export function formatGolfFollowUp({ golf, missing }) {
  const known = describeGolfInput(golf);
  const lines = known ? [`Got it: ${known}.`, ""] : [];
  if (missing.includes("rounds")) lines.push(`${GOLF_QUESTIONS.rounds} If you're not playing a round, say "No rounds next week".`);
  if (missing.includes("focus")) {
    lines.push(`${missing.includes("rounds") ? "And what" : "What"} 1–2 things do you want to focus on? Or say "Choose the balance for me".`);
  }
  return lines.join("\n");
}

/** The question to ask when an answer could not be traced to the user's words. */
export function formatGolfClarification(problems) {
  return problems.find((problem) => problem.question)?.question ?? GOLF_QUESTIONS.rounds;
}

/** "18 holes Wed · competition Sat · focus: wedges, putting" */
export function describeGolfInput(golf) {
  if (golf.activeDaysExplicit && golf.activeDays === 0) return "no golf";
  const parts = [];
  if (golf.roundsKnown && golf.rounds.length === 0) parts.push("no rounds");
  for (const round of golf.rounds) {
    const day = shortWeekday(round.date);
    if (round.competition) parts.push(`competition ${day}${round.holes ? ` (${round.holes} holes)` : ""}`);
    else parts.push(round.holes ? `${round.holes} holes ${day}` : `round ${day}`);
  }
  for (const lesson of golf.lessons) parts.push(`lesson ${shortWeekday(lesson.date)}`);
  if (golf.focus?.mode === "areas") parts.push(`focus: ${golf.focus.areas.map(lowerFirst).join(", ")}`);
  if (golf.focus?.mode === "balance") parts.push("balanced practice");
  if (golf.technicalPriority) parts.push(`technical priority: ${lowerFirst(golf.technicalPriority)}`);
  for (const date of golf.restDays) parts.push(`rest day ${shortWeekday(date)}`);
  for (const date of golf.unavailableDays) parts.push(`no golf ${shortWeekday(date)}`);
  for (const [date, minutes] of Object.entries(golf.minutes).sort()) parts.push(`${shortWeekday(date)} ${minutes} min`);
  if (golf.avoid.includes("range")) parts.push("no range");
  if (golf.avoid.includes("on-course")) parts.push("no on-course practice");
  if (golf.activeDaysExplicit && golf.activeDays !== MAX_GOLF_DAYS) parts.push(`${golf.activeDays} golf days`);
  return parts.join(" · ");
}

/** The proposal's golf section. */
export function formatGolfSection(week) {
  const anchors = week.days.filter((day) => day.role !== "rest" && day.role !== "off" && day.role !== "practice");
  if (week.targetDays === 0 && anchors.length === 0) return ["Golf", "No golf this week."];
  const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const lines = [
    `Golf · ${plural(week.activeDays, "golf day")}${week.restDays > 0 ? `, ${plural(week.restDays, "rest day")}` : ""}`,
  ];
  if (week.direction) lines.push(`Long-term direction: ${lowerFirst(week.direction)}`);
  if (week.focus?.mode === "areas") lines.push(`This week's focus: ${week.focus.areas.map((area, index) => `${index + 1}. ${area}`).join(" · ")}`);
  if (week.focus?.mode === "balance") lines.push("This week's focus: a balanced mix");
  for (const day of week.days) lines.push(golfDayLine(day));
  for (const note of week.notes) lines.push(`Note: ${note}`);
  return lines;
}

function golfDayLine(day) {
  const line = golfDayText(day);
  return day.alongside ? `${line} · also in Todoist: ${day.alongside}` : line;
}

function golfDayText(day) {
  const name = shortWeekday(day.date);
  switch (day.role) {
    case "practice": {
      const size = day.holes ? `${day.holes} holes` : `${day.limitMinutes ?? day.minutes} min`;
      const test = day.pressure && day.kind !== "scoring" ? " · pressure test" : "";
      return `${name} — ${day.label} · ${size}${test}`;
    }
    case "round":
      return `${name} — ${day.holes ? `${day.holes} holes` : "Round"} · process: ${day.objective.short}${day.lesson ? " · lesson" : ""}`;
    case "competition":
      return `${name} — Competition${day.holes ? ` · ${day.holes} holes` : ""} · process: ${day.objective.short}`;
    case "lesson":
      return `${name} — Lesson`;
    case "existing":
      return `${name} — ${day.title} (in Todoist)`;
    case "off":
      return `${name} — No golf${OFF_REASONS[day.reason] ?? ""}`;
    default:
      return `${name} — Rest`;
  }
}

// ---------------------------------------------------------------------------
// Existing tasks and saved routines.

/** What an existing golf task in Todoist is, from its title alone. */
export function classifyGolfTitle(title) {
  const text = String(title ?? "").toLowerCase();
  if (/\b(competition|tournament|qualifier|championship|club champs|medal)\b|tävling/.test(text)) return "competition";
  if (/\blesson\b|lektion/.test(text)) return "lesson";
  if (/\b(round|holes?|\d+[- ]hole|play golf)\b/.test(text)) return "round";
  if (/\b(practice|practise|training|range|short game|putting|chipping|wedges?|bunker)\b/.test(text)) return "practice";
  return "golf";
}

/**
 * Read-only snapshot of the user's saved golf cue word and routines, and a
 * saved normal golf week. Only names and the cue word are used, and only in
 * the wording of golf tasks; nothing here is ever written.
 */
export function readSavedGolfRoutines(memoryPath) {
  const saved = { cueWord: null, preRoundRoutine: null, badShotReset: null, competitionRoutine: null };
  if (!memoryPath) return { saved, normalWeek: null, unreadable: false };
  try {
    const entries = listMemoryEntries(memoryPath, { category: "golf" }).filter((entry) => entry.sensitivity === "low");
    saved.cueWord = clip(entries.find((entry) => entry.key === "cue-word")?.value, 40);
    const normalWeek = clip(entries.find((entry) => /^normal-(golf-)?week$/.test(entry.key))?.value, 300);
    for (const playbook of listPlaybooks(memoryPath, { domain: "golf" })) {
      const label = clip(playbook.name ?? String(playbook.key).replace(/-/g, " "), 60);
      const text = `${playbook.key} ${label}`.toLowerCase();
      if (/competition|tournament|tävling/.test(text)) saved.competitionRoutine ??= label;
      else if (/pre-?round/.test(text)) saved.preRoundRoutine ??= label;
      else if (/bad-?shot|reset/.test(text)) saved.badShotReset ??= label;
    }
    return { saved, normalWeek, unreadable: false };
  } catch {
    return { saved, normalWeek: null, unreadable: true };
  }
}

// ---------------------------------------------------------------------------
// Small helpers.

function requireReplyText(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("A golf answer needs replyText: the user's exact message.");
  }
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length > 4000) throw new Error("replyText must be at most 4000 characters.");
  return text;
}

function normalizeShortText(value, label, maxLength) {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) throw new Error(`${label} must not be empty.`);
  if (text.length > maxLength) throw new Error(`${label} must be at most ${maxLength} characters.`);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function clip(value, maxLength) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  return text ? text.slice(0, maxLength) : null;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

function requireList(value, label, max) {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  if (value.length > max) throw new Error(`${label} accepts at most ${max} entries.`);
  return value;
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown field in ${label}: ${key}. Allowed: ${allowed.join(", ")}.`);
  }
}

function sortByDate(list) {
  return [...list].sort((a, b) => a.date.localeCompare(b.date));
}

function uniqueByDate(list) {
  return [...new Map(list.map((entry) => [entry.date, entry])).values()];
}

function uniqueText(list) {
  return [...new Map(list.map((entry) => [entry.toLowerCase(), entry])).values()];
}

function lowerFirst(text) {
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}
