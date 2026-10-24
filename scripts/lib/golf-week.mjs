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
 * Answers are optional. Without them the week is still complete and labelled
 * as defaults: no playing days means practice days, never invented rounds, and
 * no focus means a balanced mix for competitive play.
 *
 * Everything after that is plain code. Rounds, lessons, the practice days the
 * user names and golf tasks already in Todoist are anchors; practice fills the
 * other days up to six golf days with one golf-free day. That is a default,
 * not a rule: when the user wants golf every day (seven days, every day, no
 * rest day) or names golf on all seven days, the week has seven. Golf days are
 * not hard days: a practice day is full, moderate or light depending on what
 * surrounds it, several full rounds shrink the practice around them, a week
 * without a golf-free day keeps practice moderate and light next to a full
 * round, and the day before a competition is light preparation. A round the
 * user only might play is noted on its day, never planned as a round. The plan
 * says what to practise, never how to swing: a technical priority appears only
 * in the user's (or their coach's) words.
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

/** Golf days in a week the user said nothing about: six, and one golf-free day. */
export const DEFAULT_GOLF_DAYS = 6;
/** Golf every day, when the user wants it. */
export const MAX_GOLF_DAYS = 7;
export const GOLF_AVOIDABLE = Object.freeze(["range", "on-course"]);
export const GOLF_ROLES_WITH_TASKS = Object.freeze(["practice", "round", "competition", "lesson"]);

export const GOLF_QUESTIONS = Object.freeze({
  rounds: "Which days are you playing next week, and roughly 9 or 18 holes?",
  focus: "What 1–2 things do you want to focus on?",
  events: "Any competition, lesson or other important golf event?",
});

/** The plan's optional questions, asked once with the first version shown. */
export const GOLF_REFINEMENTS = Object.freeze({
  rounds: "Which days will you play golf, if any? Roughly 9 or 18 holes, and is any of it a competition or a lesson?",
  focus: "What would you like to focus on in your golf practice?",
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
  ["wedges", /\b(wedg\p{L}*|inspel\p{L}*|lähestym\p{L}*)|\b\d{2,3}\s*(-|–|to)\s*\d{2,3}\s*(m|metres?|meters?|yards?|yds)\b|\b(inside|under|within)\s+\d{2,3}\s*(m|metres?|meters?|yards?|yds)\b/iu],
  ["short-game", /\b(short ?game|chip\p{L}*|pitch\p{L}*|bunker\p{L}*|bunkk\p{L}*|sand ?shots?|up[- ]and[- ]downs?|around the greens?|närspel\p{L}*|lähipel\p{L}*|lyhy\p{L}*\s+pel\p{L}*)/iu],
  ["scoring", /\b(scoring|pressure|score\p{L}*|paine\p{L}*)/iu],
  ["on-course", /\b(course management|strategy|strategi\p{L}*|decision\p{L}*|päätök\p{L}*|club selection|mailavalin\p{L}*|target selection|game ?plan|on[- ]course|banspel\p{L}*|kenttäpel\p{L}*)/iu],
  ["process", /\b(mental\p{L}*|mentaal\p{L}*|henkinen|henkis\p{L}*|routine\p{L}*|rutin\p{L}*|rutiin\p{L}*|pre-?shot|commit\p{L}*|confidence|självförtroende|itseluottam\p{L}*|nerves|patience|reset)/iu],
  ["range", /\b(driv\p{L}*|draiv\p{L}*|tee ?shots?|avauslyön\p{L}*|irons?|raut\p{L}*|raud\p{L}*|long ?game|pitk\p{L}*\s+pel\p{L}*|ball[- ]?striking|full swing|swing\p{L}*|sving\p{L}*|club ?face|strike|contact|osum\p{L}*|hybrids?|woods?|fairway\p{L}*|järn\p{L}*|utslag\p{L}*)/iu],
]);

export function golfFocusKind(text) {
  return FOCUS_KIND_PATTERNS.find(([, pattern]) => pattern.test(String(text ?? "")))?.[0] ?? "general";
}

// ---------------------------------------------------------------------------
// Grounding: is a value in the user's words? Lenient about phrasing and
// language (English, Swedish and Finnish), strict about substance: a weekday
// that was never mentioned cannot become a playing day.

// Day names and abbreviations take only a short ending, so "sun" never
// matches "sunny". A Swedish day name also starts a compound through the
// genitive s: "onsdagskvällen", "lördagsmorgon". A Finnish day name takes its
// case endings ("keskiviikkona", "keskiviikosta", "lauantain"); the two-letter
// Finnish abbreviations count only inside a range ("ma–pe"), because "to" and
// "la" are ordinary words.
const DAY_WORDS = Object.freeze([
  { words: ["monday", "mon", "mån"], swedish: ["måndag", "mandag"], finnish: "maanantai" },
  { words: ["tuesday", "tue", "tues", "tis"], swedish: ["tisdag"], finnish: "tiistai" },
  { words: ["wednesday", "wed", "weds", "ons"], swedish: ["onsdag"], finnish: "keskiviik" },
  { words: ["thursday", "thu", "thur", "thurs", "tors", "tor"], swedish: ["torsdag"], finnish: "torstai" },
  { words: ["friday", "fri", "fre"], swedish: ["fredag"], finnish: "perjantai" },
  { words: ["saturday", "sat", "lör"], swedish: ["lördag", "lordag"], finnish: "lauantai" },
  { words: ["sunday", "sun", "sön"], swedish: ["söndag", "sondag"], finnish: "sunnuntai" },
]);
const MONTH_WORDS = Object.freeze([
  ["jan", "january", "januari", "tammikuu", "tammikuuta", "tammikuun"],
  ["feb", "february", "februari", "helmikuu", "helmikuuta", "helmikuun"],
  ["mar", "march", "mars", "maaliskuu", "maaliskuuta", "maaliskuun"],
  ["apr", "april", "huhtikuu", "huhtikuuta", "huhtikuun"],
  ["may", "maj", "toukokuu", "toukokuuta", "toukokuun"],
  ["jun", "june", "juni", "kesäkuu", "kesäkuuta", "kesäkuun"],
  ["jul", "july", "juli", "heinäkuu", "heinäkuuta", "heinäkuun"],
  ["aug", "august", "augusti", "elokuu", "elokuuta", "elokuun"],
  ["sep", "sept", "september", "syyskuu", "syyskuuta", "syyskuun"],
  ["oct", "october", "okt", "oktober", "lokakuu", "lokakuuta", "lokakuun"],
  ["nov", "november", "marraskuu", "marraskuuta", "marraskuun"],
  ["dec", "december", "joulukuu", "joulukuuta", "joulukuun"],
]);
const NUMBER_WORDS = Object.freeze({
  1: ["one", "single", "yksi", "yhden"],
  2: ["two", "couple", "två", "kaksi", "kahden"],
  3: ["three", "tre", "kolme"],
  4: ["four", "fyra", "neljä"],
  5: ["five", "fem", "viisi"],
  6: ["six", "sex", "kuusi"],
  7: ["seven", "sju", "seitsemän"],
  9: ["nine", "nio", "yhdeksän"],
  15: ["fifteen", "femton", "a quarter of an hour", "kvart", "viisitoista", "vartti", "varttitunti"],
  18: ["eighteen", "arton", "full round", "full rounds", "kahdeksantoista", "täysi kierros", "täyden kierroksen"],
  20: ["twenty", "tjugo", "kaksikymmentä"],
  30: ["thirty", "trettio", "half an hour", "half hour", "halvtimme", "kolmekymmentä", "puoli tuntia", "puolen tunnin"],
  40: ["forty", "fyrtio", "neljäkymmentä"],
  45: ["forty-five", "forty five", "fyrtiofem", "three quarters of an hour", "neljäkymmentäviisi", "kolme varttia"],
  60: ["sixty", "an hour", "one hour", "1 hour", "1 h", "1h", "en timme", "1 timme", "kuusikymmentä", "tunti", "tunnin", "yksi tunti"],
  90: ["ninety", "nittio", "an hour and a half", "one and a half hours", "1.5 hours", "1.5 h", "1,5 h", "1,5 timme", "en och en halv timme", "yhdeksänkymmentä", "puolitoista tuntia", "puolentoista tunnin"],
  120: ["two hours", "2 hours", "2 h", "2h", "två timmar", "kaksi tuntia", "kahden tunnin"],
});

const word = (body) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "iu");
// A competition or a lesson needs the user to name one: an "important round"
// is an ordinary round, and a coach's advice is not a booked lesson. A Finnish
// "tunti" is only an hour; it is a lesson with a prefix that says so.
const COMPETITION_PATTERN = word(
  "competition\\p{L}*|comps?|tournament\\p{L}*|\\p{L}*tävling\\p{L}*|(?:serie|lag|klubb)?match\\p{L}*|qualif\\p{L}*|championship\\p{L}*|\\p{L}*mästerskap\\p{L}*|club champs|cup|medal|stableford|scramble|kilpailu\\p{L}*|kilpaile\\p{L}*|(?:seura|golf|joukkue)?kis[ao]\\p{L}*|turnau\\p{L}*|\\p{L}*mestaruu\\p{L}*|karsin\\p{L}*|reikäpel\\p{L}*",
);
const LESSON_PATTERN = word(
  "lesson\\p{L}*|(?:golf|privat|grupp|tränar)?lektion\\p{L}*|coaching session|session with (?:my|the) (?:coach|pro|instructor|trainer|tränare)|tränarpass|(?:golf|oppi|yksityis|ryhmä|valmennus|pro)-?tun(?:ti\\p{L}*|n[ie]\\p{L}*)|valmennu\\p{L}*|valmentaja(?:n|ni)? kanssa",
);
const BALANCE_PATTERN = word("balance\\p{L}*|balanced|choose|you choose|you pick|pick for me|up to you|your call|whatever|no specific|no particular|nothing specific|nothing in particular|anything|mixed|a mix|välj\\p{L}*|du väljer|blandat|valfritt|valitse\\p{L}*|sinä valitset|saat valita|tasapain\\p{L}*|monipuoli\\p{L}*|sekalai\\p{L}*|ei mitään erityis\\p{L}*|ei erityis\\p{L}*|mitä tahansa|ihan sama");
const SAME_PATTERN = word("same|samma|like last week|as last week|as before|som förra veckan|unchanged|oförändrat|sama\\p{L}*|kuin viime viikolla|kuten viime viikolla|ennallaan");
const NORMAL_PATTERN = word("normal|usual|regular|typical|vanlig\\p{L}*|normaal\\p{L}*|tavalli\\p{L}*|tavanomai\\p{L}*");
const NO_ROUNDS_PATTERN = word("no (?:full )?rounds?|not playing|won['’]?t (?:be )?play\\p{L}*|will not play|not going to play|no 18|no 9|inga rundor|ingen runda|spelar inte|inte spela|just practi[cs]e|only practi[cs]e|practi[cs]e only|en pelaa|ei kierroks\\p{L}*|ei kierrosta|ei yhtään kierrosta|vain harjoittel\\p{L}*|pelkkää harjoittelua|pelkästään harjoittel\\p{L}*");
const NO_GOLF_PATTERN = word("no golf|not playing golf|no golfing|skip golf|skipping golf|without golf|ingen golf|inte golf|golf[- ]?free|break from golf|pause golf|ei golfia|ei golffia|en golfaa|en pelaa golfia|golfvapaa\\p{L}*|golftauko|tauko golfista|ilman golfia");
// Golf on all seven days, said outright: the user need not repeat a number
// when they say every day or that they don't need a rest day.
const SEVEN_DAYS_PATTERN = word("(?:7|seven|sju|seitsemän\\p{L}*)\\s+(?:golf\\s*)?(?:days?|dagar\\p{L}*|golfdagar\\p{L}*|päiv\\p{L}*|golfpäiv\\p{L}*)");
const EVERY_DAY_PATTERN = word("every ?day|each day|all week|the whole week|all (?:seven|7) days|varje dag|alla dagar\\p{L}*|alla (?:sju|7) dagar|hela veckan|joka päivä|jokaisena päivänä|päivittäin|koko viikon|kaikkina päivinä");
const NO_REST_PATTERN = word(
  [
    "no (?:rest|recovery|golf[- ]?free) ?days?|no days? off|without (?:a |any )?(?:(?:rest|recovery|golf[- ]?free) ?days?|days? off)",
    "(?:don['’]?t|do not|doesn['’]?t|does not|won['’]?t|will not) need (?:a |any |the )?(?:(?:rest|recovery|golf[- ]?free) ?days?|days? off)",
    "no need for (?:a |any )?(?:rest|recovery|golf[- ]?free) ?days?|skip(?:ping)? the rest ?day",
    "(?:ingen|inga|utan|behöver (?:ingen|inga|inte någon|inte en)) (?:vilodag|återhämtningsdag|ledig dag|lediga dagar|golffri dag|golffria dagar)\\p{L}*",
    "(?:ei|en tarvitse|ei tarvita|ei tarvitse|emme tarvitse|ilman) (?:yhtään |mitään )?(?:lepopäiv|palautuspäiv|vapaapäiv|golfvapaa)\\p{L}*",
    "(?:lepopäiv|palautuspäiv|vapaapäiv)\\p{L}* (?:ei|en) (?:tarvita|tarvitse)",
  ].join("|"),
);
// A reply that says no never borrows the question it answers.
const DENIAL_PATTERN = word("no|nope|nah|not|don['’]?t|do not|nej|nä|nää|inte|ei|en");
const WEEKDAYS_PATTERN = word("weekdays|every weekday|vardagar\\p{L}*|varje vardag|arkipäivi\\p{L}*|arkisin");
// A round the user only might play: "Maybe 9 holes on Friday". A day named
// with one of these in the same clause is a possibility, not a round.
const HEDGE_PATTERN = word("maybe|might|perhaps|possibl\\p{L}*|potentially|tentative\\p{L}*|not sure|unsure|kanske|eventuell\\p{L}*|möjligen|möjligtvis|inte säker|osäker\\p{L}*|ehkä|ehkäpä|kenties|mahdollisesti|saatan|saattaa|en ole varma|epävarm\\p{L}*");

const STOPWORDS = new Set(
  (
    "a an the and or but for with from into in on at to of by as is are was were be been am i me my mine you your we our it its this that " +
    "these those next last week weeks day days some more less much very really just also want wants would like get getting bit lot lots " +
    "inside under within over around about between " +
    "focus focusing work working practice practise practicing practising improve improving better main second primary secondary " +
    "thing things area areas game games shot shots play playing golf m meter meters metre metres yard yards yds " +
    "och att på med för vill jobba träna träning fokus mer min mitt mina nästa vecka veckan spel spelet slag golfen " +
    "ja tai että haluan haluaisin keskity keskityn keskittyä keskitytään harjoitella harjoittelen harjoittelu harjoitus harjoituksia " +
    "treenata treeni enemmän vähemmän ensi viikko viikolla viikon viikkoa pelata pelaan golfia golffia lyönti lyönnit parantaa"
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
    word(`(?:${DAY_WORDS[index].words.join("|")})(?:s|en|ens|ar|arna)?`),
    word(`(?:${DAY_WORDS[index].swedish.join("|")})(?:s\\p{L}*|en|ens|ar|arna)?`),
    word(`${DAY_WORDS[index].finnish}\\p{L}*`),
    new RegExp(escapeRegExp(date)),
    new RegExp(`(?<!\\d)${dayOfMonth}(?:st|nd|rd|th|:e)(?![\\p{L}\\p{N}])`, "iu"),
    new RegExp(`(?<![\\d.])${dayOfMonth}\\s*[./]\\s*${month}(?![\\d])`, "u"),
    new RegExp(`(?<![\\d.])${dayOfMonth}\\.?\\s+(?:${months})(?![\\p{L}])`, "iu"),
    new RegExp(`(?<![\\p{L}])(?:${months})\\.?\\s+${dayOfMonth}(?!\\d)`, "iu"),
  ];
  if (index >= 5) patterns.push(word("weekends?|helg(?:en)?|viikonlop\\p{L}*"));
  if (today && date === today) patterns.push(word("today|tonight|idag|i dag|ikväll|i kväll|tänään|tänä iltana"));
  if (today && date === addDays(today, 1)) patterns.push(word("tomorrow|imorgon|i morgon|imorrn|huomenna"));
  return sources.some((source) => patterns.some((pattern) => pattern.test(source)) || coveredDays(source).has(index));
}

const FINNISH_SHORT_DAYS = Object.freeze(["ma", "ti", "ke", "to", "pe", "la", "su"]);
const DAY_WORD_PATTERNS = DAY_WORDS.map(
  (day) => new RegExp(`^(?:(?:${day.words.join("|")})s?|(?:${day.swedish.join("|")})(?:s\\p{L}*|en|ens|ar|arna)?|${day.finnish}\\p{L}*)$`, "iu"),
);
const RANGE_SEPARATOR = /^\s*(?:[-–—]|to|till|until|through|thru|tom|asti)\s*$/iu;

/** The weekday (0 = Monday) one word names, or -1; a two-letter Finnish abbreviation only with `short`. */
function dayOfWord(text, { short = false } = {}) {
  const index = DAY_WORD_PATTERNS.findIndex((pattern) => pattern.test(text));
  if (index >= 0 || !short) return index;
  return FINNISH_SHORT_DAYS.indexOf(text.toLowerCase());
}

/**
 * Weekdays a text covers without naming each one: a range ("mon-friday",
 * "Monday to Friday", "mån–fre", "maanantaista perjantaihin", "ma–pe"),
 * weekdays, or every day.
 */
function coveredDays(text) {
  const source = String(text ?? "");
  const covered = new Set();
  if (EVERY_DAY_PATTERN.test(source)) return new Set([0, 1, 2, 3, 4, 5, 6]);
  if (WEEKDAYS_PATTERN.test(source)) [0, 1, 2, 3, 4].forEach((index) => covered.add(index));
  const words = [...source.matchAll(/\p{L}+/gu)];
  for (let first = 0; first < words.length; first += 1) {
    const from = dayOfWord(words[first][0], { short: true });
    if (from < 0) continue;
    for (const second of [first + 1, first + 2]) {
      if (second >= words.length) break;
      const to = dayOfWord(words[second][0], { short: true });
      if (to < 0) continue;
      const between = source.slice(words[first].index + words[first][0].length, words[second].index);
      const abbreviated = dayOfWord(words[first][0]) < 0 || dayOfWord(words[second][0]) < 0;
      const dash = /^\s*[-–—]\s*$/u.test(between);
      // Finnish says a range with cases alone: "maanantaista perjantaihin".
      const finnish = second === first + 1 && /^\s+$/u.test(between) && /st[aä]$/iu.test(words[first][0]) && !abbreviated;
      if (abbreviated ? !dash : !RANGE_SEPARATOR.test(between) && !finnish) continue;
      for (let step = 0, index = from; step < 7; step += 1, index = (index + 1) % 7) {
        covered.add(index);
        if (index === to) break;
      }
      break;
    }
  }
  return covered;
}

/** Days named in a clause that also hedges ("Maybe 9 holes on Friday, 18 on Saturday" hedges only Friday). */
function hedgedDates(weekStart, text, { today = null } = {}) {
  const hedged = new Set();
  for (const clause of String(text ?? "").split(/[.!?;\n]+|,|\s(?:but|men|mutta)\s/iu)) {
    if (!HEDGE_PATTERN.test(clause)) continue;
    for (const date of weekDates(weekStart)) {
      if (dayMentioned(date, [clause], { today })) hedged.add(date);
    }
  }
  return hedged;
}

/** "Mon–Fri" for three or more days in a row, otherwise "Mon, Wed". */
function dayList(dates) {
  const sorted = [...dates].sort();
  const parts = [];
  for (let start = 0; start < sorted.length; ) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === addDays(sorted[end], 1)) end += 1;
    if (end - start >= 2) parts.push(`${shortWeekday(sorted[start])}–${shortWeekday(sorted[end])}`);
    else for (let index = start; index <= end; index += 1) parts.push(shortWeekday(sorted[index]));
    start = end + 1;
  }
  return parts.join(", ");
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

/** The golf part before the user has said anything about the week: the planner's defaults. */
export function emptyGolfInputs(config) {
  const activeDays = config?.golf?.activeDays ?? DEFAULT_GOLF_DAYS;
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

/**
 * Which of the week's two optional answers are still defaults: the playing
 * days (`rounds`) and the focus. Complete when both are known, or the user
 * said no golf at all. A plan never waits for them; plans stored before the
 * answers became optional (`awaiting_input`) still report what they asked.
 */
export function golfInputStatus(golf) {
  if (golf.activeDaysExplicit && golf.activeDays === 0) return { complete: true, missing: [] };
  const missing = [];
  if (!golf.roundsKnown) missing.push("rounds");
  if (!golf.focus) missing.push("focus");
  return { complete: missing.length === 0, missing };
}

/**
 * A golf answer or change with values that cannot be traced to the user's
 * words. Each problem says what to leave out (`drop`, see
 * withoutRefusedGolfChanges) and the question to ask instead.
 */
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
  "practiceDays",
  "minutes",
  "avoid",
  "allow",
  "activeDays",
  "moves",
]);

/**
 * Applies one golf answer or change. `replyText` is the user's exact message,
 * and every new playing day, hole count, competition, lesson, practice day,
 * focus area, technical priority and time limit must be found in it (or, for
 * "use my normal golf week", in the saved normal week). Ungrounded values come
 * back as problems, each with the question to ask and what to leave out
 * (`drop`, see withoutRefusedGolfChanges), so the clear part of an answer can
 * still be planned while the rest is asked.
 *
 * In a plan that was already built (`context.plan`), today's practice sessions
 * and rest day are kept where they are first, so a change moves only what it
 * names, as the rest of the weekly plan does. The first playing days or focus
 * the user gives replace defaults that nobody chose, so the practice around
 * them is planned afresh; only sessions the user moved stay put.
 *
 * Six golf days are the default, not a limit: seven come from the user, said
 * outright (seven days, every day, no rest day) or by naming golf on every
 * day. A round on a day the user hedges ("Maybe 9 holes on Friday") is only a
 * possibility, whatever the mapping says. A reply to the question the plan
 * asked about this change (`context.question`) is read together with it, so
 * "Yes" or "18" can answer it, unless the reply says no.
 *
 * @returns {{ golf, summary: string[], problems: { field, reason, question, drop }[] }}
 */
export function applyGolfChanges(previous, rawChanges, context) {
  const changes = requireObject(rawChanges, "golf");
  rejectUnknownKeys(changes, GOLF_CHANGE_KEYS, "golf");
  const replyText = requireReplyText(changes.replyText);
  const { weekStart, today = null, previousWeek = null, normalWeekText = null, plan = null, saved, question = null } = context;
  const golf = structuredClone(previous);
  const before = { roundsKnown: golf.roundsKnown, focusMode: golf.focus?.mode ?? null };
  if (plan) keepCurrentWeek(golf, plan);
  const summary = [];
  const problems = [];
  const answered = question && !DENIAL_PATTERN.test(replyText) ? [String(question)] : [];
  const said = [replyText, ...answered].join("\n");
  const sources = [replyText, ...answered];
  const resolve = (ref) => resolvePlanDay(ref, weekStart);
  const flag = (field, reason, question, drop) => problems.push({ field, reason, question, drop });
  const mentioned = (date) => dayMentioned(date, sources, { today });
  const name = (date) => weekdayName(date);
  const hedged = hedgedDates(weekStart, replyText, { today });

  if (changes.from !== undefined) {
    if (changes.from !== "normal-week") throw new Error(`Unknown golf answer source: ${changes.from}. Use "normal-week".`);
    if (!NORMAL_PATTERN.test(said)) {
      flag("from", "The user did not refer to their normal golf week.", GOLF_QUESTIONS.rounds, { key: "from" });
    } else if (!normalWeekText) {
      flag("from", "No normal golf week is saved.", `I don't have your normal golf week saved. ${GOLF_QUESTIONS.rounds}`, { key: "from" });
    } else {
      sources.push(normalWeekText);
    }
  }

  // Seven golf days need the user's say-so: said outright, or golf named on
  // every day, which is checked once all of this answer's days are in.
  let activeDaysSet = false;
  let sevenFromNamedDays = false;
  if (changes.activeDays !== undefined) {
    const count = Number(changes.activeDays);
    if (!Number.isInteger(count) || count < 0 || count > MAX_GOLF_DAYS) throw new Error(`activeDays must be a whole number from 0 to ${MAX_GOLF_DAYS}.`);
    if (count === 0 && !NO_GOLF_PATTERN.test(said)) {
      flag("activeDays", "The user did not say no golf.", "No golf at all next week?", { key: "activeDays" });
    } else if (count > 0 && count < MAX_GOLF_DAYS && !numberMentioned(count, sources)) {
      flag("activeDays", `The user did not ask for ${count} golf days.`, "How many golf days do you want next week?", { key: "activeDays" });
    } else {
      sevenFromNamedDays =
        count === MAX_GOLF_DAYS && !numberMentioned(count, sources) && ![SEVEN_DAYS_PATTERN, EVERY_DAY_PATTERN, NO_REST_PATTERN].some((pattern) => pattern.test(said));
      if (count === 0) {
        golf.rounds = [];
        golf.lessons = [];
        golf.pins = [];
        setOptional(golf, "tentativeRounds", []);
        setOptional(golf, "practiceDays", []);
        golf.roundsKnown = true;
        summary.push("No golf this week");
      } else if (count !== golf.activeDays) {
        summary.push(`Golf days ${golf.activeDays} → ${count}`);
      }
      if (count === MAX_GOLF_DAYS) golf.restDays = [];
      golf.activeDays = count;
      golf.activeDaysExplicit = true;
      activeDaysSet = true;
    }
  }

  // Only what the answer adds needs the user's words: "Saturday is now a
  // competition" keeps Saturday's known hole count without repeating it.
  const groundRound = (round, before, where) => {
    if (!mentioned(round.date)) flag("rounds", `${name(round.date)} is not in the user's words.`, GOLF_QUESTIONS.rounds, where);
    if (round.holes !== null && round.holes !== before?.holes && !numberMentioned(round.holes, sources)) {
      flag("holes", `${round.holes} holes is not in the user's words.`, `Roughly 9 or 18 holes on ${name(round.date)}?`, { ...where, field: "holes" });
    }
    if (round.competition && !before?.competition && !COMPETITION_PATTERN.test(sources.join("\n"))) {
      flag("competition", `A competition on ${name(round.date)} is not in the user's words.`, `Is ${name(round.date)}'s round a competition?`, { ...where, field: "competition" });
    }
  };
  const merged = (raw, before) => ({
    date: raw.date,
    holes: raw.holes === undefined ? before?.holes ?? null : raw.holes,
    competition: raw.competition === undefined ? before?.competition ?? false : raw.competition,
  });
  const isTentative = (given) => given.tentative === true || hedged.has(given.date);
  const tentativeOn = (date) => (golf.tentativeRounds ?? []).find((round) => round.date === date) ?? null;
  // A possible round is noted on its day; only a round the user will play is a round.
  const placeRound = (round, tentative) => {
    golf.rounds = golf.rounds.filter((existing) => existing.date !== round.date);
    const possible = (golf.tentativeRounds ?? []).filter((existing) => existing.date !== round.date);
    if (tentative) {
      setOptional(golf, "tentativeRounds", sortByDate([...possible, round]));
      return;
    }
    setOptional(golf, "tentativeRounds", possible);
    golf.rounds = sortByDate([...golf.rounds, round]);
    golf.restDays = golf.restDays.filter((date) => date !== round.date);
  };

  if (changes.rounds !== undefined) {
    if (changes.rounds === "same-as-last-week") {
      if (!SAME_PATTERN.test(said)) {
        flag("rounds", "The user did not ask for last week's playing days.", GOLF_QUESTIONS.rounds, { key: "rounds" });
      } else if (!previousWeek?.golf?.roundsKnown) {
        flag("rounds", "Last week's playing days are not saved.", `I don't have last week's playing days. ${GOLF_QUESTIONS.rounds}`, { key: "rounds" });
      } else {
        // Same days and holes; a competition belongs to its own week.
        golf.rounds = previousWeek.golf.rounds.map((round) => ({
          date: addDays(weekStart, weekdayIndex(round.date)),
          holes: round.holes,
          competition: false,
        }));
        setOptional(golf, "tentativeRounds", []);
        golf.roundsKnown = true;
        summary.push("Golf: same playing days as last week");
      }
    } else {
      const given = requireList(changes.rounds, "rounds", 7).map((raw) => normalizeRound(raw, resolve));
      const rounds = given.map((round) => merged(round, null));
      if (rounds.length === 0 && !NO_ROUNDS_PATTERN.test(said) && !NO_GOLF_PATTERN.test(said)) {
        flag("rounds", "The user did not say they are not playing.", GOLF_QUESTIONS.rounds, { key: "rounds" });
      }
      rounds.forEach((round, index) => groundRound(round, null, { key: "rounds", index }));
      golf.rounds = [];
      setOptional(golf, "tentativeRounds", []);
      const latest = new Map(given.map((round, index) => [round.date, index]));
      for (const index of latest.values()) placeRound(rounds[index], isTentative(given[index]));
      golf.roundsKnown = true;
      summary.push(rounds.length === 0 ? "Golf: no rounds" : `Golf: ${rounds.map((round, index) => describeRound(round, isTentative(given[index]))).join(", ")}`);
    }
  }
  for (const [index, raw] of requireList(changes.addRounds ?? [], "addRounds", 7).entries()) {
    const given = normalizeRound(raw, resolve);
    const before = golf.rounds.find((existing) => existing.date === given.date) ?? tentativeOn(given.date);
    const round = merged(given, before);
    groundRound(round, before, { key: "addRounds", index });
    placeRound(round, isTentative(given));
    golf.roundsKnown = true;
    summary.push(`Golf: + ${describeRound(round, isTentative(given))}`);
  }
  for (const ref of requireList(changes.removeRounds ?? [], "removeRounds", 7)) {
    const date = resolve(ref);
    if (!golf.rounds.some((round) => round.date === date) && !tentativeOn(date)) throw new Error(`There is no round on ${name(date)} to remove.`);
    golf.rounds = golf.rounds.filter((round) => round.date !== date);
    setOptional(golf, "tentativeRounds", (golf.tentativeRounds ?? []).filter((round) => round.date !== date));
    golf.roundsKnown = true;
    summary.push(`Golf: no round ${shortWeekday(date)}`);
  }

  const groundLesson = (lesson, where) => {
    if (!mentioned(lesson.date)) flag("lessons", `${name(lesson.date)} is not in the user's words.`, `Which day is the lesson?`, where);
    if (!LESSON_PATTERN.test(sources.join("\n"))) flag("lessons", "A lesson is not in the user's words.", `Do you have a lesson on ${name(lesson.date)}?`, where);
  };
  if (changes.lessons !== undefined) {
    const lessons = requireList(changes.lessons, "lessons", 7).map((raw) => normalizeLesson(raw, resolve));
    lessons.forEach((lesson, index) => groundLesson(lesson, { key: "lessons", index }));
    golf.lessons = sortByDate(uniqueByDate(lessons));
    summary.push(lessons.length === 0 ? "Golf: no lessons" : `Golf: lesson ${lessons.map((lesson) => shortWeekday(lesson.date)).join(", ")}`);
  }
  for (const [index, raw] of requireList(changes.addLessons ?? [], "addLessons", 7).entries()) {
    const lesson = normalizeLesson(raw, resolve);
    groundLesson(lesson, { key: "addLessons", index });
    golf.lessons = sortByDate([...golf.lessons.filter((existing) => existing.date !== lesson.date), lesson]);
    golf.restDays = golf.restDays.filter((date) => date !== lesson.date);
    summary.push(`Golf: + lesson ${shortWeekday(lesson.date)}`);
  }
  for (const ref of requireList(changes.removeLessons ?? [], "removeLessons", 7)) {
    const date = resolve(ref);
    golf.lessons = golf.lessons.filter((lesson) => lesson.date !== date);
    summary.push(`Golf: no lesson ${shortWeekday(date)}`);
  }

  // The days the user names for practice are golf days, never the golf-free
  // one; a golf-free or unavailable day named in the same answer still wins.
  if (changes.practiceDays !== undefined) {
    const named = [];
    for (const [index, ref] of requireList(changes.practiceDays, "practiceDays", 7).entries()) {
      const date = resolve(ref);
      if (mentioned(date)) named.push(date);
      else flag("practiceDays", `${name(date)} is not in the user's words.`, "Which days do you want to practise?", { key: "practiceDays", index });
    }
    const days = [...new Set(named)].sort();
    setOptional(golf, "practiceDays", days);
    golf.restDays = golf.restDays.filter((date) => !days.includes(date));
    golf.unavailableDays = golf.unavailableDays.filter((date) => !days.includes(date));
    summary.push(days.length > 0 ? `Golf: practice ${dayList(days)}` : "Golf: no set practice days");
  }

  if (changes.focus !== undefined) {
    if (changes.focus === "balance") {
      if (!BALANCE_PATTERN.test(said)) flag("focus", "The user did not ask you to choose the practice balance.", GOLF_QUESTIONS.focus, { key: "focus" });
      golf.focus = { mode: "balance", areas: [] };
      summary.push("Golf: balanced practice");
    } else if (changes.focus === "same-as-last-week") {
      if (!SAME_PATTERN.test(said)) {
        flag("focus", "The user did not ask for last week's focus.", GOLF_QUESTIONS.focus, { key: "focus" });
      } else if (!previousWeek?.golf?.focus) {
        flag("focus", "Last week's focus is not saved.", `I don't have last week's focus. ${GOLF_QUESTIONS.focus}`, { key: "focus" });
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
          flag("focus", `"${area}" is not in the user's words.`, GOLF_QUESTIONS.focus, { key: "focus" });
        }
      }
      golf.focus = { mode: "areas", areas: uniqueText(areas) };
      summary.push(`Golf: focus ${golf.focus.areas.map(lowerFirst).join(", ")}`);
    }
    // The sessions follow the new focus. After an earlier focus its upkeep
    // sessions stay where they are; a balanced or default week chose every
    // session for that mix, so only the ones the user moved stay.
    golf.pins = golf.pins.filter((pin) => pin.focusIndex === null && (pin.explicit || before.focusMode === "areas"));
  }

  if (changes.technicalPriority !== undefined) {
    if (changes.technicalPriority === null) {
      golf.technicalPriority = null;
    } else {
      const priority = normalizeShortText(changes.technicalPriority, "technicalPriority", 80);
      if (priority.toLowerCase() !== String(golf.technicalPriority ?? "").toLowerCase() && !sharesWords(priority, sources)) {
        flag("technicalPriority", `"${priority}" is not in the user's words.`, "What does your coach want you to work on?", { key: "technicalPriority" });
      }
      golf.technicalPriority = priority;
      summary.push(`Golf: technical priority ${lowerFirst(priority)}`);
    }
  }

  if (changes.restDay !== undefined) {
    const date = resolve(changes.restDay);
    if (!mentioned(date)) flag("restDay", `${name(date)} is not in the user's words.`, "Which day should be golf-free?", { key: "restDay" });
    if (golf.rounds.some((round) => round.date === date) || golf.lessons.some((lesson) => lesson.date === date)) {
      flag("restDay", `The user plays or has a lesson on ${name(date)}.`, `You're playing on ${name(date)}. Which day should be golf-free?`, { key: "restDay" });
    }
    golf.restDays = [date];
    golf.pins = golf.pins.filter((pin) => pin.date !== date);
    setOptional(golf, "practiceDays", (golf.practiceDays ?? []).filter((day) => day !== date));
    // Naming a golf-free day ends a week of golf every day.
    if (golf.activeDays >= MAX_GOLF_DAYS) {
      summary.push(`Golf days ${golf.activeDays} → ${DEFAULT_GOLF_DAYS}`);
      golf.activeDays = DEFAULT_GOLF_DAYS;
    }
    summary.push(`Golf: rest day ${shortWeekday(date)}`);
  }

  for (const [index, ref] of requireList(changes.unavailableDays ?? [], "unavailableDays", 7).entries()) {
    const date = resolve(ref);
    if (!mentioned(date)) flag("unavailableDays", `${name(date)} is not in the user's words.`, "Which days can't you play golf?", { key: "unavailableDays", index });
    if (!golf.unavailableDays.includes(date)) golf.unavailableDays = [...golf.unavailableDays, date].sort();
    golf.pins = golf.pins.filter((pin) => pin.date !== date);
    setOptional(golf, "practiceDays", (golf.practiceDays ?? []).filter((day) => day !== date));
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
      const question = `How much time do you have for golf on ${name(date)}?`;
      if (!mentioned(date)) flag("minutes", `${name(date)} is not in the user's words.`, question, { key: "minutes", day: ref });
      if (!numberMentioned(minutes, sources)) flag("minutes", `${minutes} minutes is not in the user's words.`, question, { key: "minutes", day: ref });
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

  // The first playing days or focus replace defaults nobody chose: the
  // practice and the golf-free day are planned around them afresh, worded
  // with the saved routines the chat reply may read (`context.saved`).
  if (plan && ((!before.roundsKnown && golf.roundsKnown) || (!before.focusMode && golf.focus))) {
    golf.pins = golf.pins.filter((pin) => pin.explicit);
    golf.previousRestDays = [];
    if (saved !== undefined) golf.saved = saved;
  }

  for (const [index, raw] of requireList(changes.moves ?? [], "moves", 7).entries()) {
    if (!plan) throw new Error("Golf sessions can be moved once the plan has been built and shown.");
    requireObject(raw, "golf move");
    rejectUnknownKeys(raw, ["from", "to"], "golf move");
    const from = resolve(raw.from);
    const to = resolve(raw.to);
    if (from === to) continue;
    if (!mentioned(to)) flag("moves", `${name(to)} is not in the user's words.`, "Which day should it move to?", { key: "moves", index });
    summary.push(moveGolfDay(golf, plan, from, to));
  }

  // Golf named on every day of the week is the user's own seven-day week, and
  // more named days than the week had raise its count: the newer words win.
  const named = new Set([...golf.rounds, ...golf.lessons].map((entry) => entry.date).concat(golf.practiceDays ?? []));
  if (golf.activeDays > 0 && named.size > golf.activeDays) {
    if (activeDaysSet && !sevenFromNamedDays) {
      flag("activeDays", `The user named golf on ${named.size} days but asked for ${golf.activeDays}.`, `You've named golf on ${named.size} days. How many golf days do you want?`, { key: "activeDays" });
    } else {
      summary.push(named.size >= MAX_GOLF_DAYS ? "Golf: every day, no golf-free day" : `Golf days ${golf.activeDays} → ${named.size}`);
      golf.activeDays = named.size;
      golf.activeDaysExplicit = true;
      if (named.size >= MAX_GOLF_DAYS) golf.restDays = [];
    }
  }
  if (sevenFromNamedDays && named.size < MAX_GOLF_DAYS) {
    flag("activeDays", "The user did not ask for golf every day.", "Golf on all seven days next week, with no golf-free day?", { key: "activeDays" });
  }

  return { golf, summary, problems };
}

/**
 * The golf change without the values its problems refused (each problem's
 * `drop`), so what the user did say can be planned while the rest is asked.
 * A list that names all playing days or lessons is left out whole when one
 * entry is refused, since what is left would say there are no others. Null
 * when nothing is left.
 */
export function withoutRefusedGolfChanges(rawChanges, problems) {
  const changes = structuredClone(rawChanges);
  const entries = new Map();
  for (const { drop } of problems) {
    if (!drop || changes[drop.key] === undefined) continue;
    const { key, index, field, day } = drop;
    if (day !== undefined) {
      delete changes[key][day];
    } else if (index === undefined) {
      delete changes[key];
    } else if (field) {
      if (changes[key][index] && typeof changes[key][index] === "object") delete changes[key][index][field];
    } else {
      if (!entries.has(key)) entries.set(key, new Set());
      entries.get(key).add(index);
    }
  }
  for (const [key, indexes] of entries) {
    if (!Array.isArray(changes[key])) continue;
    if (key === "rounds" || key === "lessons") delete changes[key];
    else changes[key] = changes[key].filter((_, index) => !indexes.has(index));
  }
  for (const [key, value] of Object.entries(changes)) {
    const emptied = Array.isArray(value) ? value.length === 0 && rawChanges[key]?.length > 0 : key === "minutes" && Object.keys(value).length === 0 && Object.keys(rawChanges.minutes).length > 0;
    if (emptied) delete changes[key];
  }
  return Object.keys(changes).some((key) => key !== "replyText") ? changes : null;
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
  // onto the golf-free day makes its old day the golf-free one, and a named
  // practice day moves with it.
  golf.pins = golf.pins.filter((pin) => pin.date !== from && pin.date !== to);
  golf.pins.push({ date: to, kind: source.kind, focusIndex: source.focusIndex ?? null, explicit: true });
  if (target?.role === "practice") golf.pins.push({ date: from, kind: target.kind, focusIndex: target.focusIndex ?? null, explicit: true });
  if (target?.role === "rest") {
    golf.restDays = [from];
    setOptional(golf, "practiceDays", (golf.practiceDays ?? []).map((date) => (date === from ? to : date)).sort());
  }
  golf.pins.sort((a, b) => a.date.localeCompare(b.date));
  return `Golf: ${lowerFirst(source.label)} ${shortWeekday(from)} → ${shortWeekday(to)}`;
}

/** `holes`, `competition` and `tentative` stay undefined when the answer does not mention them. */
function normalizeRound(raw, resolve) {
  const value = requireObject(raw, "round");
  rejectUnknownKeys(value, ["day", "holes", "competition", "tentative"], "round");
  let holes;
  if (value.holes !== undefined && value.holes !== null) {
    holes = Number(value.holes);
    if (!Number.isInteger(holes) || holes < 1 || holes > 36) throw new Error("Round holes must be a whole number from 1 to 36.");
  }
  if (value.competition !== undefined && typeof value.competition !== "boolean") throw new Error("Round competition must be true or false.");
  if (value.tentative !== undefined && typeof value.tentative !== "boolean") throw new Error("Round tentative must be true or false.");
  return { date: resolve(value.day), holes, competition: value.competition, tentative: value.tentative };
}

function normalizeLesson(raw, resolve) {
  const value = typeof raw === "string" ? { day: raw } : requireObject(raw, "lesson");
  rejectUnknownKeys(value, ["day", "note"], "lesson");
  return { date: resolve(value.day), note: value.note ? normalizeShortText(value.note, "lesson note", 80) : null };
}

function describeRound(round, tentative = false) {
  const day = shortWeekday(round.date);
  const text = round.competition ? `${day} competition${round.holes ? ` (${round.holes} holes)` : ""}` : round.holes ? `${round.holes} holes ${day}` : `round ${day}`;
  return tentative ? `maybe ${text}` : text;
}

/** Optional golf lists stay out of the stored inputs while empty, so plans that never used them keep their shape. */
function setOptional(golf, key, list) {
  if (list.length > 0) golf[key] = list;
  else delete golf[key];
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
  // Practice days the user named are golf days, never the golf-free one.
  const namedPractice = candidates.filter((date) => (golf.practiceDays ?? []).includes(date));
  // Days that have passed are not caught up: what is left of the week keeps a
  // golf-free day instead of packing the missed golf days into it, unless the
  // user wants golf every day.
  const remaining = dates.filter((date) => !passed(date)).length;
  const wanted = noGolf ? 0 : golf.activeDays;
  const everyDayWanted = wanted >= MAX_GOLF_DAYS;
  const target = remaining < dates.length ? Math.min(wanted, Math.max(0, remaining - (everyDayWanted ? 0 : 1))) : wanted;
  if (target < wanted) {
    notes.push(
      everyDayWanted
        ? `The week has already started, so golf is planned on the ${remaining} days left; missed golf days aren't caught up.`
        : `The week has already started, so the ${remaining} days left get ${target} golf day${target === 1 ? "" : "s"} and keep a golf-free day; missed golf days aren't caught up.`,
    );
  }
  let need = Math.max(0, target - anchors.length, namedPractice.length);
  if (need > candidates.length) {
    notes.push(`Only room for ${anchors.length + candidates.length} golf days this week.`);
    need = candidates.length;
  }
  if (anchors.length >= 7 && !everyDayWanted) notes.push("There's no golf-free day this week.");

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
    candidates
      .filter((date) => !namedPractice.includes(date))
      .sort((a, b) => restScore(a) - restScore(b) || b.localeCompare(a))
      .slice(0, restCount),
  );
  for (const date of dates) {
    const day = days.get(date);
    if (day.role) continue;
    const reason = offReason(date);
    if (reason === "rest" || chosenRest.has(date)) day.role = "rest";
    else if (reason) Object.assign(day, { role: "off", reason });
    else day.role = "practice";
  }

  // How much each practice day can take. Without a golf-free day left in the
  // week, practice stays moderate, and light next to a full round.
  const fullRounds = dates.filter((date) => isHigh(days.get(date))).length;
  const practiceDates = dates.filter((date) => days.get(date).role === "practice");
  const everyDay = practiceDates.length > 0 && dates.every((date) => passed(date) || !["rest", "off"].includes(days.get(date).role));
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
    if (everyDay) lower(isHigh(at(date, -1)) || isHigh(at(date, 1)) ? "light" : "moderate");
    day.intensity = cap;
  }
  // ...and at least every third golf day in a row is a light one.
  if (everyDay) {
    let streak = 0;
    for (const date of dates.filter((candidate) => !passed(candidate))) {
      const day = days.get(date);
      if (day.role === "practice" && ["light", "prep"].includes(day.intensity)) {
        streak = 0;
      } else if (++streak >= 3 && day.role === "practice") {
        day.intensity = "light";
        streak = 0;
      }
    }
  }
  if (everyDay && everyDayWanted) {
    const light = practiceDates.filter((date) => days.get(date).intensity === "light");
    notes.push(
      light.length > 0
        ? `Golf every day, as you asked: practice stays moderate, and ${dayList(light).replace(/, ([^,]+)$/, " and $1")} ${light.length === 1 ? "is" : "are"} light.`
        : "Golf every day, as you asked: practice stays moderate.",
    );
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

  // A round the user only might play is noted on its day, which keeps what the
  // plan has there: one golf task at most, and never an invented booking.
  for (const round of golf.tentativeRounds ?? []) {
    const day = days.get(round.date);
    if (!day || !["practice", "rest"].includes(day.role)) continue;
    day.possibleRound = { holes: round.holes ?? null, ...(round.competition ? { competition: true } : {}) };
    const weekday = weekdayName(round.date);
    const what = round.competition ? "competition" : round.holes ? `${round.holes}-hole round` : "round";
    notes.push(
      day.role === "practice"
        ? `${weekday}'s ${what} is only a possibility, so ${weekday} keeps its practice. If it's on, tell me and I'll make ${weekday} the round.`
        : `${weekday}'s ${what} is only a possibility, so ${weekday} stays golf-free. If it's on, tell me and I'll add it.`,
    );
  }

  const list = dates.map((date) => publicDay(days.get(date)));
  // What the week assumed because the user hasn't said it; absent when they
  // have, so a plan built from complete answers keeps its earlier shape.
  const assumed = noGolf ? [] : golfInputStatus(golf).missing;
  return {
    direction: settings.direction ?? null,
    targetDays: target,
    activeDays: list.filter((day) => GOLF_ROLES_WITH_TASKS.includes(day.role) || day.role === "existing").length,
    restDays: list.filter((day) => day.role === "rest").length,
    focus: golf.focus ? structuredClone(golf.focus) : null,
    technicalPriority: golf.technicalPriority ?? null,
    saved: golf.saved ?? null,
    ...(assumed.length > 0 ? { assumed } : {}),
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
        ...(day.possibleRound ? { possibleRound: day.possibleRound } : {}),
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
      return day.possibleRound ? { ...base, possibleRound: day.possibleRound } : base;
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
    if (day.possibleRound) lines.push("", "Possible round", `If the ${possibleRoundName(day.possibleRound)} is on, play it instead of this session.`);
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

function possibleRoundName(round) {
  if (round.competition) return "competition";
  return round.holes ? `${round.holes}-hole round` : "round";
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

/** The questions a plan stored before the answers became optional (`awaiting_input`) asked. */
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
  for (const round of golf.tentativeRounds ?? []) parts.push(describeRound(round, true));
  for (const lesson of golf.lessons) parts.push(`lesson ${shortWeekday(lesson.date)}`);
  if (golf.practiceDays?.length > 0) parts.push(`practice ${dayList(golf.practiceDays)}`);
  if (golf.focus?.mode === "areas") parts.push(`focus: ${golf.focus.areas.map(lowerFirst).join(", ")}`);
  if (golf.focus?.mode === "balance") parts.push("balanced practice");
  if (golf.technicalPriority) parts.push(`technical priority: ${lowerFirst(golf.technicalPriority)}`);
  for (const date of golf.restDays) parts.push(`rest day ${shortWeekday(date)}`);
  for (const date of golf.unavailableDays) parts.push(`no golf ${shortWeekday(date)}`);
  for (const [date, minutes] of Object.entries(golf.minutes).sort()) parts.push(`${shortWeekday(date)} ${minutes} min`);
  if (golf.avoid.includes("range")) parts.push("no range");
  if (golf.avoid.includes("on-course")) parts.push("no on-course practice");
  if (golf.activeDaysExplicit && golf.activeDays !== DEFAULT_GOLF_DAYS) parts.push(`${golf.activeDays} golf days`);
  return parts.join(" · ");
}

/** The proposal's golf section. Defaults are labelled as defaults. */
export function formatGolfSection(week) {
  const anchors = week.days.filter((day) => day.role !== "rest" && day.role !== "off" && day.role !== "practice");
  if (week.targetDays === 0 && anchors.length === 0) return ["Golf", "No golf this week."];
  const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const assumed = week.assumed ?? [];
  const lines = [
    `Golf · ${plural(week.activeDays, "golf day")}${week.restDays > 0 ? `, ${plural(week.restDays, "rest day")}` : ""}`,
  ];
  if (week.direction) lines.push(`Long-term direction: ${lowerFirst(week.direction)}`);
  if (week.focus?.mode === "areas") lines.push(`This week's focus: ${week.focus.areas.map((area, index) => `${index + 1}. ${area}`).join(" · ")}`);
  if (week.focus?.mode === "balance") lines.push("This week's focus: a balanced mix");
  if (assumed.includes("focus")) lines.push("This week's focus: a balanced mix for competitive play (default: you haven't named a focus)");
  if (assumed.includes("rounds")) lines.push("Playing days: not given yet, so every golf day is practice, not a round (default)");
  for (const day of week.days) lines.push(golfDayLine(day));
  for (const note of week.notes) lines.push(`Note: ${note}`);
  return lines;
}

/**
 * The plan's optional golf questions, for the answers it assumed. Asked once,
 * with the first version shown; the plan applies as shown without them.
 */
export function formatGolfRefinements(assumed = []) {
  const questions = ["rounds", "focus"].filter((key) => assumed.includes(key)).map((key) => GOLF_REFINEMENTS[key]);
  if (questions.length === 0) return [];
  if (questions.length === 1) return ["One thing you can help me improve:", questions[0]];
  return ["Two things you can help me improve:", ...questions.map((question, index) => `${index + 1}. ${question}`)];
}

function golfDayLine(day) {
  const line = golfDayText(day);
  return day.alongside ? `${line} · also in Todoist: ${day.alongside}` : line;
}

function golfDayText(day) {
  const name = shortWeekday(day.date);
  const possible = day.possibleRound ? ` · possible ${day.possibleRound.competition ? "competition" : day.possibleRound.holes ? `${day.possibleRound.holes} holes` : "round"}` : "";
  switch (day.role) {
    case "practice": {
      const size = day.holes ? `${day.holes} holes` : `${day.limitMinutes ?? day.minutes} min`;
      const test = day.pressure && day.kind !== "scoring" ? " · pressure test" : "";
      return `${name} — ${day.label} · ${size}${test}${possible}`;
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
      return `${name} — Rest${possible}`;
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
