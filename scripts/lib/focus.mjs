/**
 * Focus sessions and "what should I do now?".
 *
 * Both are conversation. A focus session keeps one small record of the block
 * the user agreed to, so a later "I'm stuck" or "done" still has the right
 * context after the chat session resets, and so a read-only view can see that
 * a session is open. No timer, reminder, or scheduled message reads it, and
 * nothing in this module can reach Todoist, Calendar, or Telegram.
 *
 * The record holds task facts only: when the block started, how long it was
 * planned for, the optional project, the outcome, the first action, the
 * definition of done, and what to ignore. Mood, energy, productivity, and
 * judgements about the user are never stored. Ending the session deletes the
 * file.
 *
 * classifyFocusRequest mirrors "Focus and next action" in
 * agents/personal/AGENTS.md so `npm run inbox:debug` and the tests can show
 * which shape a message gets. Nothing executes on its result.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const FOCUS_SCHEMA_VERSION = 1;
export const FOCUS_STATE_FIELDS = Object.freeze([
  "startedAt",
  "plannedMinutes",
  "context",
  "outcome",
  "firstAction",
  "definitionOfDone",
  "ignore",
]);
export const MIN_FOCUS_MINUTES = 5;
export const MAX_FOCUS_MINUTES = 480;
// A session past its planned end counts as overtime for this long and then as
// stale. A stale session is not current, so a new "I'm stuck" hours later never
// inherits a context the user has moved on from.
export const FOCUS_STALE_AFTER_MINUTES = 120;

const TEXT_FIELDS = Object.freeze({
  context: { limit: 60, required: false, label: "project" },
  outcome: { limit: 200, required: true, label: "outcome" },
  firstAction: { limit: 200, required: true, label: "first action" },
  definitionOfDone: { limit: 200, required: true, label: "definition of done" },
  ignore: { limit: 200, required: false, label: "what to ignore" },
});
const INPUT_FIELDS = new Set(["plannedMinutes", ...Object.keys(TEXT_FIELDS)]);

// The record is for task facts. A field describing the user's mood, energy,
// motivation, or mental state, scoring their productivity, or naming a clinical
// condition is refused rather than stored. Task wording such as "stress test",
// "lazy loading", "panic handler", or "the energy-consumption section" is fine.
const personalStatePatterns = [
  /\b(i feel|i felt|i'?m feeling|i am feeling|i was feeling|user (feels|seems|is feeling))\b/i,
  /\b(i'?m|i am|feeling|felt|user is|you'?re|you are)\s+(so |very |really |a bit |kind of |quite |too |not |pretty |fairly )?(anxious|stressed|overwhelmed|tired|exhausted|drained|lazy|unmotivated|motivated|unproductive|productive|depressed|down|sad|frustrated|nervous|scared|afraid|insecure|hopeless|distracted|unfocused|burn(ed|t) out|calm|relaxed|okay|ok|fine|good|great|happy|focused|energi[sz]ed|energetic|rested|confident|excited|bored|annoyed|angry|upset|worried|lonely)\b/i,
  /\b(adhd|ocd|anxiety disorder|depression|depressive|bipolar|burn-?out|therapy|therapist|psychiatr\w*|medication|antidepressants?|self[- ]esteem|procrastinator|lacks? (focus|discipline|confidence|motivation)|lack of (focus|discipline|confidence|motivation|energy)|mood)\b/i,
  /\b((low|high|no|zero|little|lacking|out of|running on) (energy|motivation)|(energy|motivation|focus|stress|productivity) (levels?|scores?|ratings?|is (low|high|good|bad))|productivity\W*\d|rat(e|ed|ing) (my|his|her|their|the user'?s) (energy|focus|mood|productivity|motivation))\b/i,
];

export function resolveFocusSessionPath(stateDir) {
  if (!stateDir) throw new Error("A state directory is required for focus sessions.");
  return join(stateDir, "focus", "session.json");
}

/**
 * Read-only. Returns `{ status: "none" }` when no session is recorded, or the
 * session with its status: `active` before the planned end, `overtime` for a
 * while after it, and `stale` after that. An unreadable file throws, because
 * "no session" would be a false answer; `endFocusSession` still clears it.
 */
export function readFocusSession(path, { now = new Date() } = {}) {
  if (!existsSync(path)) return { status: "none", session: null };

  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw unreadable(error.message);
  }
  return describeFocusSession(parseStoredSession(document), now);
}

export function isFocusSessionCurrent(state) {
  return state?.status === "active" || state?.status === "overtime";
}

export function startFocusSession(path, input, { now = new Date(), replace = false } = {}) {
  const session = normalizeSession({ ...pickInput(input), startedAt: toIso(now) });
  const existing = readForWrite(path, now);

  if (isFocusSessionCurrent(existing) && !replace) {
    throw codedError(
      "FOCUS_ACTIVE",
      `A focus session is already running (${describeBlock(existing.session)}). End it first, or replace it only when the user asked for a new session.`,
    );
  }
  // An unreadable record is not treated as "nothing there": it is kept until
  // the user ends it or explicitly asks for a new session.
  if (existing.status === "unreadable" && !replace) {
    throw codedError("FOCUS_UNREADABLE", `${existing.error} Replace it only when the user asked for a new session.`);
  }

  writeSession(path, session);
  return {
    started: true,
    replaced: existing.status === "none" ? null : existing.status,
    ...describeFocusSession(session, now),
  };
}

export function updateFocusSession(path, changes, { now = new Date() } = {}) {
  const current = readFocusSession(path, { now });
  if (!isFocusSessionCurrent(current)) {
    throw codedError("FOCUS_NONE", "No focus session is running, so there is nothing to update.");
  }

  const input = pickInput(changes);
  const changed = Object.keys(input).filter((key) => input[key] !== undefined);
  if (changed.length === 0) throw new Error("Nothing to update: pass at least one field to change.");

  const session = normalizeSession({ ...current.session, ...input, startedAt: current.session.startedAt });
  writeSession(path, session);
  return { updated: true, changed, ...describeFocusSession(session, now) };
}

/** Deletes the record. Ending when nothing is recorded is not an error. */
export function endFocusSession(path, { now = new Date() } = {}) {
  if (!existsSync(path)) return { ended: false, status: "none", session: null };

  let state = null;
  try {
    state = readFocusSession(path, { now });
  } catch {
    // An unreadable record is cleared all the same.
  }
  rmSync(path, { force: true });
  return {
    ended: true,
    status: state?.status ?? "unreadable",
    session: state?.session ?? null,
    elapsedMinutes: state?.elapsedMinutes ?? null,
  };
}

export function describeFocusSession(session, now = new Date()) {
  const nowMs = toMs(now);
  const startedMs = Date.parse(session.startedAt);
  const endsMs = startedMs + session.plannedMinutes * 60_000;
  const staleMs = endsMs + FOCUS_STALE_AFTER_MINUTES * 60_000;
  const status = nowMs < endsMs ? "active" : nowMs < staleMs ? "overtime" : "stale";
  return {
    status,
    session,
    endsAt: new Date(endsMs).toISOString(),
    elapsedMinutes: Math.max(0, Math.floor((nowMs - startedMs) / 60_000)),
    minutesLeft: status === "active" ? Math.ceil((endsMs - nowMs) / 60_000) : 0,
  };
}

/** Plain summary for status replies, built without a model. */
export function formatFocusStatus(state, { timezone = "Europe/Stockholm" } = {}) {
  if (!state || state.status === "none") return "No focus session is running.";

  const { session } = state;
  const block = describeBlock(session);
  const details = [
    `Outcome: ${session.outcome}`,
    `Done for this block when: ${session.definitionOfDone}`,
    ...(session.ignore ? [`Ignore: ${session.ignore}`] : []),
  ];

  if (state.status === "active") {
    return [`Focus session: ${block}, ${state.minutesLeft} min left (until ${formatClock(state.endsAt, timezone)}).`, ...details].join("\n");
  }
  if (state.status === "overtime") {
    return [`Focus session: ${block}, planned time ended at ${formatClock(state.endsAt, timezone)}.`, ...details].join("\n");
  }
  return `An old focus session (${block}, started ${formatDateTime(session.startedAt, timezone)}) was never ended. It no longer counts as running; ending it clears it.`;
}

export function isPersonalStateText(value) {
  const text = String(value ?? "");
  return personalStatePatterns.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Recognition. Mirrors "Focus and next action" in agents/personal/AGENTS.md.

export const focusKinds = Object.freeze({
  nextAction: "next_action",
  sessionStart: "session_start",
  sessionCheckIn: "session_check_in",
  sessionEnd: "session_end",
  projectContext: "project_context",
});

export const focusShapes = Object.freeze({
  next_action: shape(1, [
    "one primary recommendation with a one-line reason",
    "optional fallback",
    "one thing not worth starting now",
    "optional offer to use the time as a focus session",
  ]),
  session_start: shape(1, ["block length and topic", "Outcome", "Start with", "Done for this block when", "Ignore"]),
  session_check_in: shape(1, ["the immediate next action toward the session outcome", "no new scope"]),
  session_end: shape(1, ["one-line acknowledgement", "optional 60-second debrief offer"]),
  project_context: shape(0, ["one-line acknowledgement", "recommendations stay on this project for the session"]),
});

const DURATION =
  "(?:half an hour|an hour and a half|(?:the )?(?:next|coming) hour|(?:\\d+(?:[.,]\\d+)?|a|an|one|two|three|four|five|six|ten|fifteen|twenty|thirty|forty|forty-five|fifty|sixty|ninety)\\s*-?\\s*(?:hours?|hrs?|minutes?|mins?)|\\d+(?:h|m))";
const durationPattern = new RegExp(`\\b${DURATION}\\b`);
const NUMBER_WORDS = Object.freeze({
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, fifteen: 15,
  twenty: 20, thirty: 30, forty: 40, "forty-five": 45, fifty: 50, sixty: 60, ninety: 90,
});

const aboutFocusQuestionPattern =
  /^(what(?:'s| is| are| does)|how (?:long|often|many|do|does|should)|why|is it|are there|does|do focus|explain|tell me about)\b.*\bfocus (?:sessions?|blocks?)\b/;
const endPattern =
  /\b(?:end|stop|finish|close|cancel|clear|quit|wrap up) (?:the |my |this |our |current )?focus (?:session|block|sprint)\b|^focus (?:session|block) (?:over|done|finished)$/;
const endWhileActivePattern =
  /^(?:ok(?:ay)?[, ]+)?(?:done|i'?m done|all done|done for now|finished|i'?m finished|i finished(?: it)?|finished it|i'?ve finished(?: it)?|that'?s it(?: for now)?|let'?s stop(?: here)?|stop here|let'?s call it|wrap(?:ping)? up|let'?s wrap(?: it)? up)$/;
const startPattern = new RegExp(
  `\\b(?:start|begin|kick off|set up|setup|do|run|let'?s do|let'?s start|let'?s have|time for|i want|i need|i'?d like|can we do|could we do) (?:a |an |my |the |another |one more |new )?(?:${DURATION}[- ]?(?:long )?)?focus (?:session|block|sprint)\\b|^(?:a |new )?focus (?:session|block|sprint)\\b|\\buse (?:the|my|it|that|this|those)(?: ${DURATION})? (?:as|for) a focus (?:session|block)\\b`,
);
const helpMeFocusPattern = /\bhelp me (?:focus|concentrate|lock in|get focused)\b/;
const helpMeFocusOnPattern = /\bhelp me (?:focus|concentrate) on \S/;
// "Don't end the focus session" or "I don't want to start one" is not a command.
const negatedCommandPattern = /\b(?:don'?t|do not|never|not|no need to|without|rather not|let'?s not|shouldn'?t)\b/;

const checkInTriggers = Object.freeze([
  ["stuck", /\b(?:i'?m|i am|i got|getting|i'?ve got|i'?m still|still|totally|completely|kind of) stuck\b|^stuck\b|\bi'?m blocked\b|\bi can'?t figure (?:this|it|that) out\b|\bi don'?t know (?:how to proceed|what to do next|where to start)\b/],
  ["overrun", /\b(?:taking|takes|took) (?:much |way |a lot |a bit )?longer than (?:expected|planned|i thought)\b|\brunning (?:out of|over) time\b|\b(?:not going to|won'?t) finish (?:this|it|in time)\b|\bneed more time\b/],
  ["scope", /\b(?:found|hit|spotted|noticed|there'?s) (?:another|a new|a second|one more|a different) (?:bug|issue|problem|error|failure)\b|\bshould i (?:also fix|fix that too)\b/],
  ["distracted", /\b(?:getting|got|keep getting|i'?m|i am|so) distracted\b|\blosing (?:my )?focus\b|\bcan'?t (?:focus|concentrate)\b|\bmy mind (?:is |keeps )?wander\w*/],
  ["progress", /\b(?:i )?(?:finished|completed|done with) (?:step \w+|the (?:first|second|third|next|last) (?:step|part|bit)|that(?: step| part| bit)?|part \w+)\b|\b(?:first |second |next )?step(?: \w+)? (?:is )?done\b/],
  ["time", /\bhow (?:much time|many minutes|long) (?:do i have |is |have i got )?left\b|\btime check\b/],
  ["next", /^(?:ok(?:ay)?[, ]+)?(?:what next|what now|what'?s next|next step|now what|what do i do next|what should i do next)$/],
]);
const refocusPattern = /\bhelp me (?:re)?focus\b|\bget me back on track\b|\brefocus\b/;

const whatNowPattern =
  /\bwhat should i (?:do|work on|focus on|tackle|start with|start on|prioriti[sz]e|pick up|get done)(?: (?:right )?now| next| first| today| this (?:morning|afternoon|evening)| tonight| with (?:the|my|this) (?:next |remaining |spare |free )?(?:time|hour|\d+ ?(?:minutes?|mins?|hours?))| (?:before|until|till|in the next|for the next) [\w\s':-]{1,40})?$/;
const availabilityPattern = new RegExp(
  `\\b(?:i have|i'?ve got|i got|i'?ve|got|there'?s)\\s+(?:about |around |roughly |only |just |maybe |like )?${DURATION}\\b(?!\\s+of\\b)`,
);
const somethingUsefulPattern = /\bget(?:ting)? something (?:useful|productive|meaningful|done)\b/;
const bestUsePattern =
  /\b(?:best|most useful|most important|smartest) (?:use of (?:my|the|this) (?:time|next|remaining|free)|thing to (?:do|work on|tackle)(?: now| next)?)\b/;
const whatInTimePattern = new RegExp(
  `\\bwhat (?:can|could) i (?:get done|do|finish|knock out) (?:in|with) (?:the next |the |my )?(?:${DURATION}|time)\\b`,
);
// A time budget for eating or training belongs to health, not to next-action.
const healthTopicPattern = /\bwhat (?:should|can|could) i (?:eat|cook|make|have for)\b|\b(?:workout|exercise|stretch(?:ing)?|meal|snack|recipe)\b/;

const projectPatterns = Object.freeze([
  /^(?:i'?m|i am|i'?ll be|i will be) (?:now |currently |going to be )?working on (?<project>.+?)(?: (?:now|right now|today|tonight|this (?:morning|afternoon|evening|session|week)|for (?:the )?(?:next|rest of the) .+|until .+))?$/,
  /^(?:let'?s |ok(?:ay)?,? )?(?:focus|concentrate) on (?<project>.+?)(?: (?:now|today|for now|for this session))?$/,
  /^(?:this|the|today'?s) (?:session|chat|conversation) is (?:for|about) (?<project>.+)$/,
  /^(?:switch|switching|change|go|put me) (?:to|into|in) (?<project>.+?) mode$/,
  /^(?<project>[\w' -]{2,40}) mode(?: on| please)?$/,
]);
const notAProjectPattern =
  /^(?:it|this|that|something|stuff|things|everything|nothing|sleep|dark|light|airplane|quiet|silent|dnd|do not disturb|night|low power)$|^(?:turn on|turn off|enable|disable|activate|switch on|switch off) |\b(?:focus|shot|shots|round|hole|holes|swing|putt\w*|breath\w*|target|the ball|the present|the moment|the process)\b/;

export function classifyFocusRequest(message, { focusActive = false } = {}) {
  const text = normalizeFocusText(message);
  if (!text || aboutFocusQuestionPattern.test(text)) return null;
  const negated = negatedCommandPattern.test(text);

  if (!negated && (endPattern.test(text) || (focusActive && endWhileActivePattern.test(text)))) {
    return outcome(focusKinds.sessionEnd, {
      reason: "End the session with `focus -- end`, then offer a 60-second debrief once; never force it.",
    });
  }

  // A bare "Help me focus" with no task or time is the coaching quick reset.
  // With a time budget or a topic it becomes a focus session.
  if (!negated && (startPattern.test(text) || helpMeFocusOnPattern.test(text) || (helpMeFocusPattern.test(text) && durationPattern.test(text)))) {
    const minutes = parseAvailableMinutes(text);
    return outcome(focusKinds.sessionStart, {
      minutes,
      reason: minutes
        ? "Focus session setup: outcome, first action, done-when, and what to ignore, recorded only in the local focus state."
        : "Focus session setup: ask one question if the topic or time is missing, then record outcome, first action, done-when, and what to ignore in the local focus state.",
    });
  }

  const trigger = checkInTrigger(text);
  if (trigger) {
    if (focusActive) {
      return outcome(focusKinds.sessionCheckIn, { trigger, reason: checkInGuidance[trigger] });
    }
    if (trigger === "stuck" || trigger === "next") {
      return outcome(focusKinds.nextAction, {
        trigger,
        focusSession: false,
        reason: "No focus session is running: do not invent one. Ask one short question about what they are working on, or recommend from what is actually known.",
      });
    }
    return null;
  }

  if (focusActive && refocusPattern.test(text)) {
    return outcome(focusKinds.sessionCheckIn, { trigger: "distracted", reason: checkInGuidance.distracted });
  }

  if (isNextActionRequest(text)) {
    const minutes = parseAvailableMinutes(text);
    return outcome(focusKinds.nextAction, {
      minutes,
      reason: minutes
        ? `What should I do now, with ${minutes} minutes: one primary recommendation that fits the time, optionally one fallback, and one thing not worth starting; advisory only.`
        : "What should I do now: one primary recommendation from current context, optionally one fallback, and one thing not worth starting; at most one question; advisory only.",
    });
  }

  const project = projectFrom(text);
  if (project) {
    return outcome(focusKinds.projectContext, {
      project,
      reason: `Session context: keep recommendations on ${project} for this conversation. It is not stored and does not become a preference.`,
    });
  }

  return null;
}

export function parseAvailableMinutes(message) {
  const text = normalizeFocusText(message);
  const match = text.match(durationPattern);
  if (!match) return null;

  const phrase = match[0];
  if (phrase === "half an hour") return 30;
  if (phrase === "an hour and a half") return 90;
  if (/(?:next|coming) hour$/.test(phrase)) return 60;

  const compact = phrase.match(/^(\d+)(h|m)$/);
  if (compact) return Number(compact[1]) * (compact[2] === "h" ? 60 : 1);

  const [, amount, unit] = phrase.match(/^(\S+?)\s*-?\s*(hours?|hrs?|minutes?|mins?)$/) ?? [];
  const number = NUMBER_WORDS[amount] ?? Number(String(amount).replace(",", "."));
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(/^h/.test(unit) ? number * 60 : number);
}

export function normalizeFocusText(message) {
  return String(message ?? "")
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .trim();
}

const checkInGuidance = Object.freeze({
  stuck: "In-session: shrink the problem to the next concrete step toward the session outcome; use the coaching quick-reset shape, no new scope.",
  overrun: "Taking longer: offer to narrow the definition of done or to extend the block; the user decides.",
  scope: "New issue mid-session: capture it, decide it against the definition of done, and do not expand the scope.",
  distracted: "In-session reset: the coaching quick reset, anchored on the session's next action.",
  progress: "Progress: give the next step, or offer to end the block if the definition of done is met.",
  time: "Time check: answer from `focus -- status`.",
  next: "Next step toward the session outcome, checked against the definition of done.",
});

function checkInTrigger(text) {
  return checkInTriggers.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

function isNextActionRequest(text) {
  if (healthTopicPattern.test(text)) return false;
  return (
    whatNowPattern.test(text) ||
    availabilityPattern.test(text) ||
    somethingUsefulPattern.test(text) ||
    bestUsePattern.test(text) ||
    whatInTimePattern.test(text)
  );
}

function projectFrom(text) {
  for (const pattern of projectPatterns) {
    const project = text.match(pattern)?.groups?.project;
    if (!project) continue;

    const cleaned = project.replace(/^(?:my|the|our|this) /, "").trim();
    // A comma means the message carries more than a project name.
    if (cleaned.length < 2 || cleaned.length > 60 || cleaned.includes(",") || notAProjectPattern.test(cleaned)) return null;
    return cleaned;
  }
  return null;
}

function outcome(kind, { trigger = null, minutes = null, project = null, focusSession = null, reason }) {
  return {
    kind,
    trigger,
    availableMinutes: minutes,
    project,
    usesFocusSession: focusSession ?? (kind === focusKinds.sessionCheckIn || kind === focusKinds.sessionEnd),
    writes: kind === focusKinds.sessionStart || kind === focusKinds.sessionEnd ? "focus-state" : "nothing",
    shape: focusShapes[kind],
    reason,
  };
}

function shape(maxQuestions, steps) {
  return Object.freeze({ maxQuestions, steps: Object.freeze(steps) });
}

// ---------------------------------------------------------------------------
// Validation and storage.

function pickInput(input = {}) {
  if (input === null || typeof input !== "object") throw new Error("Focus session details are required.");
  const unknown = Object.keys(input).filter((key) => input[key] !== undefined && !INPUT_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Focus sessions store only ${[...INPUT_FIELDS].join(", ")}; not ${unknown.join(", ")}.`);
  }
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function normalizeSession(input) {
  const session = { startedAt: toIso(input.startedAt), plannedMinutes: normalizeMinutes(input.plannedMinutes) };
  for (const [field, rule] of Object.entries(TEXT_FIELDS)) {
    session[field] = normalizeText(input[field], rule);
  }
  return Object.fromEntries(FOCUS_STATE_FIELDS.map((field) => [field, session[field]]));
}

function normalizeMinutes(value) {
  const minutes = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isInteger(minutes) || minutes < MIN_FOCUS_MINUTES || minutes > MAX_FOCUS_MINUTES) {
    throw new Error(`Focus session length must be a whole number of minutes from ${MIN_FOCUS_MINUTES} to ${MAX_FOCUS_MINUTES}.`);
  }
  return minutes;
}

function normalizeText(value, { limit, required, label }) {
  const text = value === undefined || value === null ? "" : String(value).replace(/\s+/g, " ").trim();
  if (!text) {
    if (required) throw new Error(`Focus session ${label} is required.`);
    return null;
  }
  if (text.length > limit) throw new Error(`Focus session ${label} must be at most ${limit} characters.`);
  if (isPersonalStateText(text)) {
    throw new Error(
      `Focus session ${label} describes a feeling or a personal trait. Record the task, not the person: for example "Ignore: email and Slack".`,
    );
  }
  return text;
}

function parseStoredSession(document) {
  if (!document || typeof document !== "object" || document.version !== FOCUS_SCHEMA_VERSION) {
    throw unreadable("unsupported format");
  }
  const { version, ...fields } = document;
  const unknown = Object.keys(fields).filter((key) => !FOCUS_STATE_FIELDS.includes(key));
  if (unknown.length > 0) throw unreadable(`unexpected fields ${unknown.join(", ")}`);
  try {
    return normalizeSession(fields);
  } catch (error) {
    throw unreadable(error.message);
  }
}

function readForWrite(path, now) {
  try {
    return readFocusSession(path, { now });
  } catch (error) {
    if (error.code !== "FOCUS_UNREADABLE") throw error;
    return { status: "unreadable", session: null, error: error.message };
  }
}

function writeSession(path, session) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, `${JSON.stringify({ version: FOCUS_SCHEMA_VERSION, ...session }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function describeBlock(session) {
  return `${session.plannedMinutes}-minute ${session.context ? `${session.context} ` : ""}block`;
}

function formatClock(iso, timezone) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

function formatDateTime(iso, timezone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function unreadable(detail) {
  return codedError("FOCUS_UNREADABLE", `The focus session record could not be read (${detail}). Ending the session clears it.`);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid time: ${value}`);
  return date.toISOString();
}

function toMs(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Invalid time: ${value}`);
  return ms;
}
