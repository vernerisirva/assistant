/**
 * On-demand coaching recognition.
 *
 * Coaching is conversation only. This helper mirrors "Coaching routing
 * examples" in agents/personal/AGENTS.md so `npm run inbox:debug` and the tests
 * can show which mode and context a message gets. Nothing executes on its
 * result: it cannot create tasks, events, reminders, routines, or memory.
 */

export const coachingKinds = Object.freeze({
  coaching: "coaching",
  playbook: "playbook",
  golfTechnique: "golf_technique",
  sleepHealth: "sleep_health",
  support: "support",
});

export const coachingModes = Object.freeze({
  quickReset: "quick_reset",
  inPerformance: "in_performance",
  prePerformance: "pre_performance",
  debrief: "debrief",
  sleep: "sleep_coaching",
  clarify: "clarify",
});

export const coachingContexts = Object.freeze({
  golf: "golf",
  work: "work",
  sleep: "sleep",
  general: "general",
});

// Mirrors "Coaching modes" in agents/personal/AGENTS.md. Questions are ones the
// user has to answer; a self-talk cue such as "What does this shot require?"
// does not count.
export const coachingModeContracts = Object.freeze({
  quick_reset: contract(0, 1, ["short acknowledgement", "one question only if needed", "one reset action", "one cue or next step"]),
  in_performance: contract(0, 0, ["immediate reset", "next controllable action", "at most one cue"]),
  pre_performance: contract(0, 3, ["one to three questions only if the answer is unknown", "process goal", "pre-shot or pre-task routine", "response to the predictable setback", "one cue word"]),
  debrief: contract(3, 5, ["three to five short prompts in one message", "one thing to keep", "one thing to adjust", "optional lesson the user may choose to save"]),
  sleep_coaching: contract(0, 3, ["up to three schedule questions", "one small plan with clock times", "normal wake time tomorrow"]),
  clarify: contract(1, 1, ["one question: what is coming up, or what just happened?"]),
});

const modeGuidance = Object.freeze({
  quick_reset: "Quick reset: return to the next controllable action.",
  in_performance: "In-performance: immediate reset and next action, no questions.",
  pre_performance: "Pre-performance setup: up to three questions, then a compact process plan.",
  debrief: "Debrief: three to five reflective prompts, then one thing to keep and one to adjust; a lesson is saved only if the user says yes.",
  sleep_coaching: "Sleep coaching, health's domain: up to three schedule questions, then a small plan; no diagnosis.",
  clarify: "Coaching request without a situation: ask one question about what is coming up or what just happened.",
});

const CANT = "(?:can'?t|cannot|can not)";

const distressPattern = new RegExp(
  `\\b(suicid\\w*|kill(ing)? myself|end (it all|my life)|want to die|(don'?t|do not) want to (live|be here)|self[- ]?harm\\w*|(hurt|harm)(ing)? myself|(feel|feeling|felt) hopeless|hopelessness|${CANT} (cope|go on)|not coping|panic attacks?|struggling with my mental health)\\b`,
);
const factualQuestionPattern =
  /^(what('?s| is| are| does| causes)|why (do|does|is|are)|how (much|many|long)|is it (normal|true|bad|ok|okay|healthy)|are there|does|do (people|adults|golfers)|explain|tell me about)\b/;
const firstPersonPattern = /\b(i|i'm|im|i've|i'd|me|my|myself)\b/;
const readQuestionPattern = /\?$|^(do you|what|which|when|where|how|did i|have i)\b/;

// A message that also asks for a task, event, reminder, email, booking, or
// purchase keeps its normal action classification: coaching never masks an
// action or its approval requirement.
const actionRequestPattern =
  /\b(todoist|calendar|remind me|set (a )?reminder|add\b.*\b(task|event|reminder|list)|create (a |an )?(task|event|reminder)|schedule (a|an|my|the|it|this|that)|reschedule|move (my|the|this|that|it) (meeting|event|task|round|tee time|call)|cancel (my|the|this|that|it|a)|book(ing)? (a |an |the |my )?(tee|golf|time|round|lesson|table|slot)|boka|reserve (a|an|the|my)|(send|reply|forward|write|draft|archive|delete) (an? |the |this |that )?(e-?mail|mail|message|invite|text)|invite (\w+ )?to|rsvp|buy|order (a|an|some|the|food|takeaway|delivery|groceries)|purchase|pay (for|the|my|a|an|it|this|that))\b/;

const sleepContextPattern =
  /\b(sleep\w*|slept|insomnia|bed ?time|go(ing)? to bed|in bed|wind(ing)?[- ]?down|wake[- ]?up|wake at|wake(-?up)? time|waking|woke|nap(s|ping)?|melatonin|lights out|awake at night)\b/;
const golfContextPattern =
  /\b(golf\w*|pre-?round|post-?round|(my|the|this|today'?s|tomorrow'?s|next|a) round(?! of)|holes?|tee( box| shot)?|fairways?|putt\w*|driver|irons?|wedges?|bunkers?|birdie|bogey|bogeys|double bogey|on the course|driving range|the range|swing|shots?|scorecard|handicap|caddie|playing partners?|slice|slicing|hook(ing)?|shank\w*)\b/;
const workContextPattern =
  /\b(work(ing)?|job|office|tasks?|feature|bug|code|coding|meetings?|presentation|presenting|present to|interview\w*|pitch(ing)?|(my|the|a|this) (talk|speech)|demo|standup|stand-up|deadline|project|report|writing|inbox|focus block|deep[- ]work|work block|work session|colleague|boss|manager|client|slides)\b/;
const focusPattern = new RegExp(
  `\\b(focus\\w*|concentrat\\w*|procrastinat\\w*|distracted|staring at|${CANT} (get started|start)|context[- ]switching)\\b`,
);

const debriefPattern =
  /\b(debrief\w*|post-?round (review|debrief|reflection)|(review|reflect on) (my|the|today'?s|this) (round|practice|meeting|session|presentation|interview|work|day))\b/;
const inPerformancePattern =
  /(\b(on the course|(this|that|the last|last|next) hole|after (two|three|four|five|six|\d+) (bad )?holes|(on|at) the (first|\d+(st|nd|rd|th)) (hole|tee|green)|mid-?round|(during|in) (this|the|my) (round|meeting|presentation|interview|work block|focus block|block)|in (this|the|a) meeting|just (made|hit|missed|three-?putted|shanked|topped|duffed|chunked|lost|blew|doubled)|(double|triple) bogey|(three|four)-?putt\w*|losing (my )?confidence with (my )?(driver|irons?|putter|wedges?))\b|\+\d+ (after|through|thru)\b)/;
const prePerformancePattern =
  /\b(pre-?round|pre-?shot routine|before (my|the|this|a|tomorrow'?s|today'?s) (round|game|match|practice|lesson|tournament|meeting|presentation|interview|talk|pitch|call|demo|exam)|prepare|preparing|prep (me|for)|get (me )?ready|getting ready|warm[- ]?up|first[- ]tee (nerves|jitters)|practice (session|intention|plan)|(for|over) the next \d+ ?(minutes?|mins?|hours?)|focus block|deep[- ]work block|work block|(round|tournament|match|presentation|interview|pitch|demo|exam) (today|tomorrow|tonight|later))\b/;
const performanceEventPattern =
  /\b(round|golf|practice|lesson|tournament|match|game|presentation|interview|pitch|talk|speech|demo|exam|focus block|deep[- ]work|work block|\d+ ?(minutes?|mins?|hours?))\b/;
const mentalSignalPattern =
  /\b(mental(ly)?|mindset|nerves|nervous|jitters|anxious|calm|confident|confidence|focus\w*|head ?space|present)\b/;
const resetPattern = new RegExp(
  `\\b(reset( me)?|refocus|re-?center|calm (me )?down|settle (down|my nerves|me)|get back on track|stay present|be present|(help me|need to|want to|trying to) (focus|concentrate)|(lost|losing|lose) (my )?(focus|concentration|confidence|cool|temper|head)|${CANT} (focus|concentrate|get started|start|stop thinking)|distracted|zon(ed|ing) out|overthink\\w*|over-thinking|in my head|spiral\\w*|procrastinat\\w*|staring at|keep (switching|checking)|context[- ]switching|tilt(ing|ed)?|frustrat\\w*|annoyed|angry|anger|mad at myself|pissed( off)?|furious|irritated|rattled|fed up|gutted|embarrassed|chok(e|es|ed|ing)|nerves|nervous|jitters|anxious|shaky|doubt(ing)? myself|(no|zero|low) confidence|perfectionis\\w*|${CANT} let (it|this|that) go|next shot)\\b`,
);
const coachAskPattern = /\b(coach(ing)?|mindset|mental(?! health)(ly)?|mental game|pep talk|in the zone|head ?space)\b/;

const golfMechanicsPattern =
  /\b(swing|grip|takeaway|backswing|downswing|follow[- ]through|slice|slicing|hook(ing)?|shank\w*|ball position|stance|posture|club ?face|release|wrists?|hip (turn|rotation)|weight (shift|transfer)|impact position|chicken wing|over the top|early extension|casting)\b/;
const techniqueAskPattern =
  /\b(how (do|can|should) i (fix|stop|cure|correct|improve|change|get rid of)|fix (my|the|this)|what'?s wrong with (my|the)|(swing|technique|technical) (tips?|advice|help|fix|thoughts?|drills?)|drills? for|mechanics|technique)\b/;

// Possible medical symptoms, medication, or impairment point to a professional
// on their own. Persistence ("for months", "every night") only counts next to
// an actual sleep problem, so a nightly habit stays ordinary sleep coaching.
const sleepMedicalPattern = new RegExp(
  `\\b(insomnia|(sleep )?apn(o)?ea|snor\\w*|gasp\\w*|stop(s|ped)? breathing|pauses? in (my )?breathing|restless legs|sleepwalk\\w*|night terrors?|narcolep\\w*|sleeping pills?|sleep(ing)? (medication|meds|tablets?)|melatonin|prescri\\w*|${CANT} function|(falling asleep|nodding off|dozing off) (at|while|when) (work|driving|the wheel))\\b`,
);
const sleepProblemPattern = new RegExp(
  `\\b(${CANT} sleep|haven'?t slept|not sleeping|trouble sleeping|struggl\\w* to (fall )?(asleep|sleep)|sleep(ing)? (badly|poorly|problems?|issues?)|slept (badly|poorly|terribly)|poor sleep|bad sleep|waking up|wake up (at|every|several|multiple)|awake (at night|for hours)|lying awake)\\b`,
);
const persistencePattern =
  /\b((for|in|over) (weeks|months|years|a month|a year)|been (weeks|months|years)|(weeks|months|years) (now|straight)|every night|most nights|night after night|chronic\w*|persistent\w*)\b/;
const sleepCoachingPattern = new RegExp(
  `\\b(help|plan|tonight|tomorrow|${CANT} sleep|trouble sleeping|slept (badly|poorly|terribly)|poor sleep|bad night|wind(ing)?[- ]?down)\\b`,
);

const playbookItemPattern =
  /\b(cue( word)?|swing thought|(bad[- ]shot|bad[- ]hole|pressure[- ]shot) (reset|routine)|reset routine|pre-?(round|shot|putt) routine|(deep[- ]work|focus|work) block|work reset|(target )?wake(-?up)? time|wind[- ]?down routine|bed ?time( routine)?)\b/;
const explicitSetPattern = /\b(remember|save|store|keep in mind|from now on|going forward|use (this|that|it))\b/;
const declarativeSetPattern = /\bmy \S+(?: \S+){0,3} (is|are)\b/;
// "My bedtime is midnight and I can't sleep" asks for help; it does not set a
// playbook entry, so a statement that also asks for something is not a write.
const inPassingPattern = new RegExp(`\\b(help|coach|but|because|${CANT})\\b`);
const sensitiveDetailPattern =
  /\b(medication|meds|pills?|prescri\w*|diagnos\w*|disorder|therap\w*|psychiatr\w*|psycholog\w*|depress\w*|panic|anxiety attacks?|adhd|insomnia)\b/;

export function classifyCoachingRequest(message) {
  const text = normalizeCoachingText(message);
  if (!text) return null;

  if (distressPattern.test(text)) {
    return outcome(coachingKinds.support, {
      context: coachingContexts.general,
      reason: "Significant distress: respond with care and point to support, with urgent help first for any risk of self-harm; do not turn it into performance coaching.",
    });
  }

  if (/\bmental health\b/.test(text)) return null;
  if (isFactualQuestion(text)) return null;
  if (actionRequestPattern.test(text)) return null;

  const context = detectContext(text);

  // Checked before sleep health so a playbook entry that carries a medication
  // or condition is reported as sensitive memory, not as a low-risk write.
  if (isPlaybookEntry(text)) {
    const sensitive = sensitiveDetailPattern.test(text);
    return outcome(coachingKinds.playbook, {
      context,
      approvalRequired: sensitive,
      reason: sensitive
        ? "Coaching playbook entry with a health or mental-health detail: sensitive memory needs Telegram approval before it is stored."
        : "Explicit coaching playbook entry: one low-risk memory write through the normal memory command, confirmed in one line.",
    });
  }

  if (context === coachingContexts.sleep && isSleepHealthConcern(text)) {
    return outcome(coachingKinds.sleepHealth, {
      context,
      agent: "health",
      reason: "Persistent or severe sleep trouble, or possible medical symptoms: no diagnosis; suggest a doctor or 1177 for an assessment before any habit tips.",
    });
  }

  if (golfMechanicsPattern.test(text) && techniqueAskPattern.test(text)) {
    return outcome(coachingKinds.golfTechnique, {
      context: coachingContexts.golf,
      reason: "Explicit technique request: answer it as general guidance and point to the user's golf coach for mechanics; do not recast it as a purely mental problem.",
    });
  }

  const mode = detectMode(text, context);
  if (!mode) return null;

  return outcome(coachingKinds.coaching, {
    context,
    mode,
    agent: context === coachingContexts.sleep ? "health" : "personal",
    reason: modeGuidance[mode],
  });
}

export function normalizeCoachingText(message) {
  return String(message ?? "")
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function detectContext(text) {
  if (sleepContextPattern.test(text)) return coachingContexts.sleep;
  if (golfContextPattern.test(withoutHumanCoach(text))) return coachingContexts.golf;
  if (workContextPattern.test(text) || focusPattern.test(text)) return coachingContexts.work;
  return coachingContexts.general;
}

function detectMode(text, context) {
  if (debriefPattern.test(text)) return coachingModes.debrief;
  if (context === coachingContexts.sleep) {
    return resetPattern.test(text) || coachAskPattern.test(text) || sleepCoachingPattern.test(text)
      ? coachingModes.sleep
      : null;
  }
  if (inPerformancePattern.test(text)) return coachingModes.inPerformance;
  if (prePerformancePattern.test(text) && isPerformancePreparation(text)) return coachingModes.prePerformance;
  if (resetPattern.test(text)) return coachingModes.quickReset;
  if (coachAskPattern.test(withoutHumanCoach(text))) return coachingModes.clarify;
  return null;
}

// Agenda, notes, and logistics for a meeting stay admin meeting prep. A meeting
// only becomes coaching when the user asks for the mental side of it.
function isPerformancePreparation(text) {
  return performanceEventPattern.test(text) || mentalSignalPattern.test(text) || coachAskPattern.test(text);
}

function isPlaybookEntry(text) {
  if (!playbookItemPattern.test(text) || readQuestionPattern.test(text)) return false;
  if (explicitSetPattern.test(text)) return true;
  return declarativeSetPattern.test(text) && !inPassingPattern.test(text) && !resetPattern.test(text);
}

function isSleepHealthConcern(text) {
  return sleepMedicalPattern.test(text) || (sleepProblemPattern.test(text) && persistencePattern.test(text));
}

function isFactualQuestion(text) {
  return factualQuestionPattern.test(text) && !firstPersonPattern.test(text) && !coachAskPattern.test(text);
}

// "My golf coach said..." is about the user's human coach, not a request for
// coaching from Hilla.
function withoutHumanCoach(text) {
  return text.replace(/\b(my|a|the) (golf |swing |putting )?coach(es)?\b/g, "$1 instructor");
}

function contract(minQuestions, maxQuestions, shape) {
  return Object.freeze({ minQuestions, maxQuestions, shape: Object.freeze(shape) });
}

function outcome(kind, { context, mode = null, agent = "personal", approvalRequired = false, reason }) {
  return {
    kind,
    context,
    mode,
    agent,
    contract: mode ? coachingModeContracts[mode] : null,
    sideEffects: kind === coachingKinds.playbook ? "memory" : "none",
    approvalRequired,
    reason,
  };
}
