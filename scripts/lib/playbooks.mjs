/**
 * Personal playbooks: the user's own reusable routines, such as a bad-shot
 * reset or a meeting-prep checklist, so coaching and focus use the routine the
 * user already chose instead of inventing a new technique every time.
 *
 * A playbook is an ordinary entry in the existing memory store: the category is
 * its domain, the key is a slug of its name, and `value` is a one-line
 * rendering that every existing memory reader shows unchanged. The structured
 * form (trigger, steps, cue) sits beside it in the same entry. There is no
 * second store. A routine saved as plain text through coaching's memory command
 * is read as a playbook too, and becomes structured on its first change.
 *
 * Every write needs the user's own words: an explicit request to save or change
 * the routine, or a plain yes to Hilla's offer. A passing remark saves nothing.
 * Trait, feeling, and judgement statements and health details are refused, so
 * a playbook stays a user-controlled instruction and never becomes a profile.
 *
 * classifyPlaybookRequest mirrors the routing examples in
 * agents/personal/guides/playbooks.md for `npm run inbox:debug` and the tests.
 * Nothing executes on its result.
 */
import { isApprovalMessage, normalizeApprovalText } from "./approval-language.mjs";
import { isPersonalStateText } from "./focus.mjs";
import { listMemoryEntries, readMemoryDocument, rememberMemoryEntry } from "./memory.mjs";

export const PLAYBOOK_DOMAINS = Object.freeze(["golf", "work", "sleep", "general"]);
export const PLAYBOOK_LIMITS = Object.freeze({ name: 60, trigger: 120, step: 120, cue: 40, maxSteps: 8 });
// Single values that coaching stores with the normal memory command. They are
// listed next to the playbooks so coaching sees everything in one read.
export const COACHING_SETTING_KEYS = Object.freeze(["golf/cue-word", "work/deep-work-block", "sleep/target-wake-time"]);
export const PLAYBOOK_UPDATE_OPERATIONS = Object.freeze(["setCue", "setTrigger", "addStep", "removeStep", "replaceStep"]);

const PLAYBOOK_FIELDS = new Set(["name", "domain", "trigger", "steps", "cue"]);
// A plain entry counts as a playbook when its key names a routine, as
// coaching's `golf/bad-shot-reset` or `sleep/wind-down-routine` do.
const plainRoutineKeyPattern = /(?:^|[-_])(?:routine|reset|checklist|prep|setup|playbook|wind-down|shutdown|start)$/;

// Playbooks hold behaviour, never conclusions about the person. On top of the
// focus guard for feelings and clinical terms, these catch trait and
// judgement statements ("I always choke", "lacks confidence") and health
// details, which belong to the sensitive-memory flow.
const judgementPatterns = [
  /\b(i|you|user|he|she|they)\s+(always|never|usually|often|tend to|keep)\s+(choke|chokes|choking|panic|panics|freeze|freezes|lose|loses|procrastinate|procrastinates|fail|fails|give up|gives up|overthink|overthinks|struggle|struggles|get (anxious|nervous|tense)|gets (anxious|nervous|tense))\b/i,
  /\b(i|you|user|he|she|they)\s+(struggle|struggles|lack|lacks|lose focus|loses focus|choke|chokes|procrastinate|procrastinates|am anxious|is anxious|are anxious|get anxious|gets anxious|am insecure|is insecure)\b/i,
  /\b(lacks?|low|no|poor)\s+(confidence|self[- ]belief|willpower|discipline)\b/i,
  /\b(weakness(es)?|weak point|character flaw|personality|insecurit(y|ies))\b/i,
];
// Conditions, symptoms, treatments, and medicines. A heuristic backstop: the
// guide sends every health detail to the sensitive-memory flow first.
const healthDetailPattern = new RegExp(
  [
    "pills?", "meds", "medication\\w*", "medicines?", "drugs?", "sleeping tablets?", "doses?", "dosage", "prescri\\w*", "antibiotics?",
    "insulin", "inhalers?", "melatonin", "diagnos\\w*", "symptoms?", "disorders?", "illness\\w*", "sick(ness)?",
    "(medical|health|heart|chronic) conditions?", "asthma\\w*", "migraines?", "diabet\\w*", "blood (sugar|pressure|tests?)",
    "allerg\\w*", "epilep\\w*", "seizures?", "pain", "injur(y|ies|ed)", "surgery", "doctor", "physio\\w*", "1177",
    "insomnia", "apn(o)?ea", "panic attacks?", "depress\\w*", "ptsd", "self[- ]?harm\\w*", "suicid\\w*", "pregnan\\w*",
  ].map((term) => `\\b${term}\\b`).join("|"),
  "i",
);

export function isProfileText(value) {
  const text = String(value ?? "");
  return isPersonalStateText(text) || judgementPatterns.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Consent. Mirrors the weekly plan's `--reply-text`: the exact user words that
// asked for the write are required, and a remark or a hedge is not a request.

const acceptedReplies = new Set(["yes please", "please do", "yes save it", "save it", "do it please", "yes do", "yep", "yeah"]);
const refusalStartPattern = /^(no|nope|nah|stop|cancel|not now|not yet|never mind|nevermind|don'?t|do not|leave it|skip it)\b/;
const hedgePattern = /\b(maybe|probably|perhaps|not sure|i guess|might|later)\b/;
const adviceQuestionPattern = /^(should|would it|is it worth|do you think|does it make sense)\b/;
const politeRequestPattern = /^(can|could|would|will) you (please )?(remember|save|store|keep|add|change|update|set|remove|replace|rename|make)\b/;
const instructionPattern = /\b(remember|save|store|keep|record|add|change|update|set|replace|swap|remove|delete|drop|rename|make (it|that|this)|use (this|that|it)|from now on|going forward)\b/;
const standingRoutinePattern = /\bmy [\w' -]{0,40}\b(routine|reset|playbook|checklist|setup|prep|cue(?: word)?)\b[\w' -]{0,20}\b(is|are|goes)\b/;

const replaceInstructionPattern = /\b(replace|overwrite|instead|swap it|new version|start over|redo)\b/;

/**
 * Replacing a saved playbook needs the user to ask for the replacement itself,
 * or a plain yes to an offer to replace it; a request to save is not enough.
 */
export function isExplicitReplaceConsent(replyText) {
  if (!isExplicitPlaybookConsent(replyText)) return false;
  const raw = String(replyText).trim();
  const text = raw.toLowerCase();
  return (
    isApprovalMessage(raw, { hasPendingApproval: true }) ||
    acceptedReplies.has(normalizeApprovalText(raw)) ||
    /^yes\b/.test(text) ||
    replaceInstructionPattern.test(text)
  );
}

export function isExplicitPlaybookConsent(replyText) {
  const raw = String(replyText ?? "").trim();
  if (!raw || raw.length > 2000) return false;
  const text = raw.toLowerCase().replace(/[‘’`]/g, "'").replace(/\s+/g, " ");

  if (refusalStartPattern.test(text) || hedgePattern.test(text) || adviceQuestionPattern.test(text)) return false;
  if (isApprovalMessage(raw, { hasPendingApproval: true }) || acceptedReplies.has(normalizeApprovalText(raw))) return true;
  if (/^yes\b/.test(text) && !text.includes("?")) return true;
  if (politeRequestPattern.test(text)) return true;
  if (text.includes("?")) return false;
  return instructionPattern.test(text) || standingRoutinePattern.test(text);
}

// ---------------------------------------------------------------------------
// Reading.

/** Playbooks in the memory store, structured or plain, sorted by domain and key. */
export function listPlaybooks(memoryPath, { domain } = {}) {
  const requested = domain ? normalizeDomain(domain) : null;
  return listMemoryEntries(memoryPath)
    .filter((entry) => PLAYBOOK_DOMAINS.includes(entry.category) && entry.sensitivity === "low")
    .filter((entry) => !requested || entry.category === requested)
    .filter((entry) => entry.playbook || plainRoutineKeyPattern.test(entry.key))
    .map(toView);
}

/** Coaching's single-value settings such as the golf cue word. */
export function listCoachingSettings(memoryPath, { domain } = {}) {
  const requested = domain ? normalizeDomain(domain) : null;
  return listMemoryEntries(memoryPath)
    .filter((entry) => COACHING_SETTING_KEYS.includes(`${entry.category}/${entry.key}`))
    .filter((entry) => !requested || entry.category === requested)
    .map((entry) => ({ key: `${entry.category}/${entry.key}`, value: entry.value }));
}

/**
 * Finds one playbook by name or key. Returns `found`, `clarify` with the
 * candidates when several fit, or `not_found`; it never picks one of several.
 */
export function findPlaybook(memoryPath, { name, domain } = {}) {
  // `golf/bad-shot-reset`, as list prints it, names the domain and the key.
  const qualified = String(name ?? "").trim().match(new RegExp(`^(${PLAYBOOK_DOMAINS.join("|")})/(.+)$`, "i"));
  if (qualified) return findPlaybook(memoryPath, { name: qualified[2], domain: domain ?? qualified[1].toLowerCase() });

  const query = normalizeName(name);
  if (!query) throw new Error("A playbook name is required.");
  const views = listPlaybooks(memoryPath, { domain });
  const slug = slugify(name);

  const exact = views.filter((view) => view.key === slug || normalizeName(view.name) === query);
  const matches = exact.length > 0 ? exact : views.filter((view) => nameTokens(query).every((token) => haystack(view).includes(token)));

  if (matches.length === 1) return { status: "found", playbook: matches[0] };
  if (matches.length > 1) {
    return {
      status: "clarify",
      candidates: matches.map(label),
      question: `Which one do you mean: ${matches.map(label).join(" or ")}?`,
    };
  }
  return { status: "not_found", candidates: views.map(label) };
}

// ---------------------------------------------------------------------------
// Writing. Every write goes through rememberMemoryEntry.

export function savePlaybook(memoryPath, input, { replyText, replace = false, now, idGenerator } = {}) {
  if (!isExplicitPlaybookConsent(replyText)) {
    return notSaved("The reply is not an explicit request to save a routine. Offer once and save only after a clear yes.");
  }

  const playbook = normalizePlaybook(input);
  const domain = normalizeDomain(input.domain);
  const key = slugify(playbook.name);
  if (!key) throw new Error("A playbook name needs at least one letter or digit.");

  const existing = readMemoryDocument(memoryPath).entries.find((entry) => entry.category === domain && entry.key === key);
  if (existing && !replace) {
    const error = new Error(
      `${domain}/${key} is already saved. Change it with update, or replace it only when the user asked to replace it.`,
    );
    error.code = "PLAYBOOK_EXISTS";
    throw error;
  }
  if (existing && !isExplicitReplaceConsent(replyText)) {
    return notSaved(`${domain}/${key} is already saved, and the reply does not ask to replace it. Ask whether to replace it; nothing was changed.`);
  }

  const entry = rememberMemoryEntry(
    memoryPath,
    { category: domain, key, value: renderPlaybookValue(playbook), sensitivity: "low", source: "telegram", playbook },
    { now, idGenerator },
  );
  return { status: "saved", replaced: Boolean(existing), playbook: toView(entry) };
}

/**
 * Applies exactly one change to one playbook. An unclear playbook or step
 * returns `clarify` and writes nothing.
 */
export function updatePlaybook(memoryPath, target, change, { replyText, now } = {}) {
  if (!isExplicitPlaybookConsent(replyText)) {
    return notSaved("The reply is not an explicit request to change a routine. Ask what they want changed.");
  }

  const operation = pickOperation(change);
  const found = findPlaybook(memoryPath, target);
  if (found.status === "clarify") return found;
  if (found.status === "not_found") {
    return {
      status: "clarify",
      candidates: found.candidates,
      question: found.candidates.length > 0
        ? `I couldn't find that routine. Your playbooks are: ${found.candidates.join(", ")}. Which one?`
        : "You have no saved playbooks yet. Do you want to save this as a new one?",
    };
  }

  const current = found.playbook;
  const next = { name: current.name, trigger: current.trigger, steps: [...current.steps], cue: current.cue };
  const { key, value } = operation;

  if (key === "setCue") {
    next.cue = value === null || value === "" ? null : value;
  } else if (key === "setTrigger") {
    next.trigger = value;
  } else if (key === "addStep") {
    const text = typeof value === "string" ? value : value?.text;
    const anchor = typeof value === "object" && value ? value.before ?? value.after ?? null : null;
    if (anchor === null) {
      next.steps.push(text);
    } else {
      const index = resolveStep(next.steps, anchor);
      if (index.status !== "found") return index;
      next.steps.splice(value.before !== undefined ? index.index : index.index + 1, 0, text);
    }
  } else if (key === "removeStep") {
    const index = resolveStep(next.steps, value);
    if (index.status !== "found") return index;
    if (next.steps.length === 1) {
      throw new Error("A playbook needs at least one step. Forget the whole playbook instead if that is what the user asked.");
    }
    next.steps.splice(index.index, 1);
  } else if (key === "replaceStep") {
    const index = resolveStep(next.steps, value?.from);
    if (index.status !== "found") return index;
    next.steps[index.index] = value?.to;
  }

  const playbook = normalizePlaybook({ ...next, trigger: next.trigger ?? current.trigger }, { triggerRequired: current.format === "structured" });
  const entry = rememberMemoryEntry(
    memoryPath,
    { category: current.domain, key: current.key, value: renderPlaybookValue(playbook), sensitivity: "low", source: "telegram", playbook },
    { now },
  );
  return { status: "updated", changed: key, converted: current.format === "plain", playbook: toView(entry) };
}

// ---------------------------------------------------------------------------
// Formatting, built without a model.

export function renderPlaybookValue({ trigger, steps, cue }) {
  return `${trigger ? `${trigger}: ` : ""}${steps.join("; ")}.${cue ? ` Cue: ${cue}.` : ""}`;
}

export function formatPlaybook(view) {
  return [
    `${view.name} (${view.domain})`,
    ...(view.trigger ? [`When: ${view.trigger}`] : []),
    ...view.steps.map((step, index) => `${index + 1}. ${step}`),
    ...(view.cue ? [`Cue: ${view.cue}`] : []),
  ].join("\n");
}

export function formatPlaybookList(views, settings = []) {
  const lines = views.length > 0
    ? ["Saved playbooks:", ...views.map((view) => `- ${view.name} (${view.domain}/${view.key}): ${renderPlaybookValue(view)}`)]
    : ["No saved playbooks."];
  if (settings.length > 0) {
    lines.push(`Coaching settings: ${settings.map((setting) => `${setting.key}: ${setting.value}`).join("; ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Recognition. Mirrors the routing examples in agents/personal/guides/playbooks.md.

export const playbookKinds = Object.freeze({
  use: "playbook_use",
  show: "playbook_show",
  save: "playbook_save",
  update: "playbook_update",
  offer: "playbook_offer",
  setting: "coaching_setting",
});

const ROUTINE = "(?:routine|reset|playbook|checklist|setup|set-up|prep|warm-?up|shutdown|wind-?down|ritual)";
const updatePattern = new RegExp(`^(?:please |ok(?:ay)?,? )?(?:change|update|set|add|remove|delete|drop|replace|swap|rename)\\b.*\\b(?:${ROUTINE}s?|steps?|cue(?: word)?|playbooks?)\\b`);
const savePattern = new RegExp(
  `\\b(?:remember|save|store|keep|make)\\b.*\\b(?:as|to be)\\b.*\\b(?:my|a)\\b.*\\b(?:${ROUTINE}|playbook)\\b|^(?:save|remember|store) (?:that|this|it)$`,
);
const showPattern = new RegExp(
  `^(?:what(?:'s| is| are| was)|show(?: me)?|list|remind me(?: of)?|tell me|read me|give me)\\b.*\\b(?:my|the)\\b.*\\b(?:${ROUTINE}s?|playbooks?)\\b|\\bwhat (?:playbooks?|routines?) do i have\\b`,
);
const usePattern = new RegExp(
  `\\b(?:use|run|do|go through|walk me through|apply|follow)\\b.*\\bmy\\b.*\\b${ROUTINE}\\b|\\busing my (?:normal |usual |own |saved )?(?:${ROUTINE}|playbook)\\b`,
);
const offerPattern = new RegExp(
  `\\b(?:that|this|the|my)\\b.*\\b(?:${ROUTINE}|cue|technique|approach|sequence)\\b.*\\b(?:worked|helped|was (?:great|useful|good|perfect))\\b`,
);
const negatedPattern = /\b(?:don'?t|do not|never|no need to|rather not|let'?s not)\b/;
// A cue word, deep-work block, or wake time on its own is one of coaching's
// single-value settings, changed with the memory command rather than a playbook.
const settingChangePattern =
  /^(?:please |ok(?:ay)?,? )?(?:change|update|set|make)\b.*\b(?:cue word|deep[- ]work block|(?:target )?wake(?:-?up)? time)\b/;
const routineWordPattern = new RegExp(`\\b(?:${ROUTINE}s?|playbooks?|steps?)\\b`);
// Scheduled routines and reminders are not playbooks; changing them keeps its
// own approval rule.
const scheduledRoutinePattern =
  /\b(?:morning[- ]brief|midday[- ]check-?in|workout[- ]window|evening[- ]review|weekly[- ]review|weekly plan|check-?ins?|reminders?|schedules?|scheduled|cron|jobs?|notifications?|alarms?)\b/;

export function classifyPlaybookRequest(message) {
  const text = String(message ?? "")
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .trim();
  if (!text || scheduledRoutinePattern.test(text)) return null;
  const negated = negatedPattern.test(text);

  if (!negated && settingChangePattern.test(text) && !routineWordPattern.test(text)) {
    return outcome(
      playbookKinds.setting,
      "memory",
      "A single coaching setting such as the golf cue word is changed with the memory command; if a routine's cue could be meant, ask which.",
    );
  }
  if (!negated && updatePattern.test(text)) {
    return outcome(playbookKinds.update, "memory", "Change one exact playbook through the helper with the user's words; an unclear routine or step gets one question.");
  }
  if (!negated && savePattern.test(text)) {
    return outcome(playbookKinds.save, "memory", "Explicit request: save the routine as a playbook with the user's words, then confirm in one line.");
  }
  if (showPattern.test(text)) {
    return outcome(playbookKinds.show, "nothing", "Read the saved playbook and show it in a few lines; nothing is written.");
  }
  if (usePattern.test(text)) {
    return outcome(playbookKinds.use, "nothing", "Use the saved playbook when it fits the situation; if none fits, coach normally.");
  }
  if (offerPattern.test(text)) {
    return outcome(playbookKinds.offer, "nothing", "A passing remark saves nothing: offer once to save it as a playbook.");
  }
  return null;
}

function outcome(kind, writes, reason) {
  return { kind, writes, reason };
}

// ---------------------------------------------------------------------------
// Validation.

function normalizePlaybook(input, { triggerRequired = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A playbook must be an object.");
  const unknown = Object.keys(input).filter((field) => input[field] !== undefined && !PLAYBOOK_FIELDS.has(field));
  if (unknown.length > 0) throw new Error(`A playbook has only ${[...PLAYBOOK_FIELDS].join(", ")}; not ${unknown.join(", ")}.`);

  const name = text(input.name, "name", PLAYBOOK_LIMITS.name, true);
  const trigger = text(input.trigger, "trigger", PLAYBOOK_LIMITS.trigger, triggerRequired)?.replace(/[\s:.]+$/, "") ?? null;
  if (!Array.isArray(input.steps) || input.steps.length === 0) throw new Error("A playbook needs at least one step.");
  if (input.steps.length > PLAYBOOK_LIMITS.maxSteps) {
    throw new Error(`A playbook has at most ${PLAYBOOK_LIMITS.maxSteps} steps; keep it short.`);
  }
  const steps = input.steps.map((step) => text(step, "step", PLAYBOOK_LIMITS.step, true).replace(/\.+$/, ""));
  const cue = text(input.cue, "cue", PLAYBOOK_LIMITS.cue, false)?.replace(/^["“']+|["”'.\s]+$/g, "") || null;
  return { name, trigger, steps, cue };
}

function text(value, field, limit, required) {
  const cleaned = value === undefined || value === null ? "" : String(value).replace(/\s+/g, " ").trim();
  if (!cleaned) {
    if (required) throw new Error(`A playbook ${field} is required.`);
    return null;
  }
  if (cleaned.length > limit) throw new Error(`A playbook ${field} must be at most ${limit} characters.`);
  if (healthDetailPattern.test(cleaned)) {
    throw new Error(`The playbook ${field} includes a health detail. Health details are sensitive memory and go through the sensitive-memory approval flow, never a playbook.`);
  }
  if (isProfileText(cleaned)) {
    throw new Error(
      `The playbook ${field} states a feeling, trait, or judgement. Save the behaviour instead, with a situation as the trigger: for example "Before a presentation: review the opening sentence for two minutes".`,
    );
  }
  return cleaned;
}

function normalizeDomain(domain) {
  const value = String(domain ?? "").trim().toLowerCase();
  if (!PLAYBOOK_DOMAINS.includes(value)) throw new Error(`A playbook domain must be one of: ${PLAYBOOK_DOMAINS.join(", ")}`);
  return value;
}

function pickOperation(change) {
  if (!change || typeof change !== "object" || Array.isArray(change)) throw new Error("A playbook change must be an object.");
  const keys = Object.keys(change).filter((key) => change[key] !== undefined);
  const unknown = keys.filter((key) => !PLAYBOOK_UPDATE_OPERATIONS.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown playbook change: ${unknown.join(", ")}. Use one of ${PLAYBOOK_UPDATE_OPERATIONS.join(", ")}.`);
  if (keys.length !== 1) throw new Error("Make exactly one playbook change at a time.");
  return { key: keys[0], value: change[keys[0]] };
}

/** Exact step text first, then a unique partial match; never a guess among several. */
function resolveStep(steps, target) {
  const wanted = normalizeName(target);
  if (!wanted) throw new Error("Name the step to change.");
  const exact = steps.findIndex((step) => normalizeName(step) === wanted);
  if (exact >= 0) return { status: "found", index: exact };

  const partial = steps.map((step, index) => [normalizeName(step), index]).filter(([step]) => step.includes(wanted));
  if (partial.length === 1) return { status: "found", index: partial[0][1] };
  const listed = steps.map((step, index) => `${index + 1}. ${step}`).join("; ");
  return {
    status: "clarify",
    candidates: partial.length > 1 ? partial.map(([, index]) => steps[index]) : steps,
    question: partial.length > 1
      ? `Which step do you mean: ${partial.map(([, index]) => `"${steps[index]}"`).join(" or ")}?`
      : `I couldn't find a step matching "${target}". The steps are: ${listed}. Which one?`,
  };
}

function toView(entry) {
  if (entry.playbook) {
    const { name, trigger, steps, cue } = entry.playbook;
    return { id: entry.id, domain: entry.category, key: entry.key, name, trigger, steps: [...steps], cue: cue ?? null, format: "structured", updatedAt: entry.updatedAt };
  }
  return { id: entry.id, domain: entry.category, key: entry.key, ...parsePlainRoutine(entry.key, entry.value), format: "plain", updatedAt: entry.updatedAt };
}

/**
 * Reads a routine saved as plain text, such as "After a poor shot: exhale,
 * accept, next shot. Cue: commit", into a trigger, steps, and a cue.
 */
function parsePlainRoutine(key, value) {
  let rest = String(value ?? "").trim();
  let cue = null;
  const cueMatch = rest.match(/(?:^|[.;]\s*)cue:\s*([^.;]+)\.?\s*$/i);
  if (cueMatch) {
    cue = cueMatch[1].trim();
    rest = rest.slice(0, cueMatch.index).trim();
  }
  let trigger = null;
  const triggerMatch = rest.match(/^([^:;]{3,60}):\s+(.+)$/);
  if (triggerMatch) {
    trigger = triggerMatch[1].trim();
    rest = triggerMatch[2];
  }
  const separator = rest.includes(";") ? ";" : ",";
  const steps = rest.split(separator).map((step) => step.trim().replace(/\.+$/, "")).filter(Boolean);
  const name = key.replace(/[-_]+/g, " ");
  return { name: name.charAt(0).toUpperCase() + name.slice(1), trigger, steps: steps.length > 0 ? steps : [rest], cue };
}

function label(view) {
  return `${view.name} (${view.domain})`;
}

function haystack(view) {
  return `${normalizeName(view.name)} ${view.key.replace(/[-_]+/g, " ")}`;
}

const NAME_STOPWORDS = new Set(["my", "the", "a", "an", "routine", "playbook", "for", "of"]);

function nameTokens(query) {
  const tokens = query.split(" ").filter((token) => token && !NAME_STOPWORDS.has(token));
  return tokens.length > 0 ? tokens : query.split(" ").filter(Boolean);
}

function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[‘’`'"“”]/g, "")
    .replace(/[^a-z0-9åäö]+/g, " ")
    .trim()
    .replace(/^(?:my|the) /, "");
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9åäö]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function notSaved(reason) {
  return { status: "not_saved", reason };
}
