import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { memoryCategories } from "../scripts/lib/memory.mjs";

const agents = JSON.parse(readFileSync("config/agents.json", "utf8"));
const requiredAgentIds = ["personal", "admin", "health", "research"];
const approvalFieldPhrases = [
  "agent",
  "action",
  "target",
  "expected effect",
  "risk",
  "approval options",
];
const specialistAgentIds = requiredAgentIds.filter((id) => id !== "personal");

describe("agent configuration", () => {
  it("defines the four specialist agents", () => {
    assert.deepEqual(agents.map((agent) => agent.id), requiredAgentIds);
  });

  it("uses the personal agent as the only default", () => {
    const defaultAgents = agents.filter((agent) => agent.default === true);

    assert.equal(defaultAgents.length, 1);
    assert.equal(defaultAgents[0].id, "personal");
  });

  it("ships no unresolved conflict markers in any agent prompt", () => {
    // A rebase once committed markers into a prompt and every other assertion
    // still passed, because they only check that phrases are present. The
    // markers would have gone to the model as part of its standing orders.
    // SOUL.md reaches the workspace too, so every Markdown prompt file counts.
    const checked = [];
    for (const agent of agents) {
      if (!existsSync(agent.promptDir)) continue;

      for (const file of readdirSync(agent.promptDir).filter((name) => name.endsWith(".md"))) {
        const path = `${agent.promptDir}/${file}`;
        checked.push(path);

        for (const line of readFileSync(path, "utf8").split("\n")) {
          assert.ok(
            !/^(<{7} |={7}$|>{7} )/.test(line),
            `${path} still contains a conflict marker: ${line}`,
          );
        }
      }
    }

    assert.ok(checked.includes("agents/personal/AGENTS.md"));
    assert.ok(checked.includes("agents/personal/SOUL.md"));
  });

  it("gives each agent a workspace and agent directory", () => {
    for (const agent of agents) {
      assert.match(agent.workspace, new RegExp(`workspace-${agent.id}$`));
      assert.match(agent.agentDir, new RegExp(`agents/${agent.id}/agent$`));
      assert.equal(existsSync(`${agent.promptDir}/AGENTS.md`), true);
    }
  });

  it("keeps side effects approval-gated in every agent prompt", () => {
    for (const agent of agents) {
      const prompt = readFileSync(`${agent.promptDir}/AGENTS.md`, "utf8");
      assert.match(prompt, /Confirm-before-action/);
      assert.match(prompt, /Telegram approval/);

      for (const phrase of approvalFieldPhrases) {
        assert.match(prompt.toLowerCase(), new RegExp(phrase));
      }
    }
  });

  it("defines a clear contract in every agent prompt", () => {
    for (const agent of agents) {
      const prompt = readFileSync(`${agent.promptDir}/AGENTS.md`, "utf8");

      assert.match(prompt, /Agent contract:/);
      assert.match(prompt, /Purpose:/);
      assert.match(prompt, /Primary responsibilities:/);
      assert.match(prompt, /Allowed read-only actions:/);
      assert.match(prompt, /Actions requiring explicit Telegram approval:/);
      assert.match(prompt, /Hard stop points:/);
      assert.match(prompt, /Good routing examples:/);
    }
  });

  it("keeps specialist agents hidden behind personal handoffs", () => {
    for (const agent of agents.filter((entry) =>
      specialistAgentIds.includes(entry.id),
    )) {
      const prompt = readFileSync(`${agent.promptDir}/AGENTS.md`, "utf8");

      assert.match(prompt, /handoffs? through the personal agent/i);
      assert.match(prompt, /separate Telegram bots?/i);
    }
  });

  it("retains health medical safety boundaries", () => {
    const healthAgent = agents.find((agent) => agent.id === "health");
    const prompt = readFileSync(`${healthAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /Do not diagnose medical conditions/);
    assert.match(prompt, /Do not give extreme dieting advice/);
  });

  it("teaches the admin agent to use Todoist for task management", () => {
    const adminAgent = agents.find((agent) => agent.id === "admin");
    const prompt = readFileSync(`${adminAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /Todoist/);
    assert.match(prompt, /npm run todoist/);
    assert.match(
      prompt,
      /Creating a Todoist task is allowed without a second approval only when/i,
    );
    assert.match(
      prompt,
      /Delete, reopen, move between projects\/sections, bulk edits, shared or project-wide changes, ambiguous targets, sensitive content, inferred update content, and changes affecting other people require Telegram approval/i,
    );
    assert.match(prompt, /Screenshot\/reference-derived exact task targets do not require approval by themselves/i);
    assert.match(prompt, /fetch or read the actual Todoist task content/i);
    assert.match(prompt, /keep the content the same/i);
  });

  it("teaches both task-facing agents one Todoist task-writing convention", () => {
    const adminPrompt = readFileSync(
      `${agents.find((agent) => agent.id === "admin").promptDir}/AGENTS.md`,
      "utf8",
    );
    const personalPrompt = readFileSync(
      `${agents.find((agent) => agent.id === "personal").promptDir}/AGENTS.md`,
      "utf8",
    );

    for (const prompt of [adminPrompt, personalPrompt]) {
      assert.match(prompt, /Todoist task writing/);
      assert.match(prompt, /--task-json-stdin/);
      assert.match(prompt, /quoted heredoc/i);
      assert.match(prompt, /real line break/i);
      assert.match(prompt, /one short actionable line/i);
      assert.match(prompt, /URLs out of the title/i);
      assert.match(prompt, /Markdown links?/i);
      assert.match(prompt, /user's own language|user's own wording/i);
      assert.match(prompt, /Call dad/);
    }

    assert.match(adminPrompt, /Do not repeat the due date in the title/i);
    assert.match(adminPrompt, /Scale formatting to the amount of information/i);
    assert.match(adminPrompt, /Prepare Tobias meeting/);
    assert.match(personalPrompt, /Do not invent goals, sections, or checklist items/i);
  });


  it("teaches both task-facing agents how to handle a Todoist duplicate result", () => {
    const adminPrompt = readFileSync(
      `${agents.find((agent) => agent.id === "admin").promptDir}/AGENTS.md`,
      "utf8",
    );
    const personalPrompt = readFileSync(
      `${agents.find((agent) => agent.id === "personal").promptDir}/AGENTS.md`,
      "utf8",
    );

    for (const prompt of [adminPrompt, personalPrompt]) {
      // Nothing was created, and the agent has to say so.
      assert.match(prompt, /nothing new was created|nothing was created/i);
      // The existing task is identified.
      assert.match(prompt, /name the existing task/i);
      // The create is never retried to force it through.
      assert.match(prompt, /(never|do not) (rerun|retry) the create/i);
      // A second copy is raised with the user, and the guard's real limit is
      // stated rather than promising a create that would be refused again.
      assert.match(prompt, /second copy/i);
      assert.match(prompt, /identical open title is still refused/i);
      assert.match(prompt, /tells the two apart/i);
    }

    // Duplicate handling must never become a write to the matching task.
    assert.match(
      adminPrompt,
      /never work around it by editing, completing, deleting, moving, or rescheduling/i,
    );
    assert.match(personalPrompt, /do not change the task that matched/i);

    // An uncertain result is not a duplicate claim.
    assert.match(adminPrompt, /`uncertain` result is not a duplicate claim/i);
    assert.match(adminPrompt, /I couldn't check your existing tasks/i);
    assert.match(adminPrompt, /recurring existing task, an unreadable list, or a failed check/i);
  });

  it("teaches the admin agent to comment on one exact task only", () => {
    const prompt = readFileSync(
      `${agents.find((agent) => agent.id === "admin").promptDir}/AGENTS.md`,
      "utf8",
    );

    assert.match(prompt, /Todoist comments:/);
    assert.match(prompt, /--action comment/);
    assert.match(prompt, /--detail-stdin/);
    assert.match(prompt, /Resolve exactly one task first/i);
    assert.match(prompt, /ask which task instead of commenting/i);
    assert.match(prompt, /Add exactly what the user said/i);
    assert.match(prompt, /not use a comment as a way to change the task itself/i);
  });

  it("teaches the admin agent not to report a no-op as an update", () => {
    const prompt = readFileSync(
      `${agents.find((agent) => agent.id === "admin").promptDir}/AGENTS.md`,
      "utf8",
    );

    assert.match(prompt, /no_change_needed/);
    assert.match(prompt, /nothing was sent and nothing changed/i);
    assert.match(prompt, /Never report it as an update/i);
    assert.match(prompt, /(Do not|never) retry the update/i);
  });

  it("teaches the admin agent read-only calendar planning boundaries", () => {
    const adminAgent = agents.find((agent) => agent.id === "admin");
    const prompt = readFileSync(`${adminAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /Calendar planning/);
    assert.match(prompt, /npm run calendar:plan/);
    assert.match(prompt, /read-only normalized event snapshot/i);
    assert.match(prompt, /does not fetch Calendar events/i);
    assert.match(prompt, /does not create, edit, delete, invite, RSVP, email, book, or mutate/i);
    assert.match(prompt, /Proposed change/i);
  });

  it("teaches the admin agent low-risk Todoist updates can proceed from explicit instructions", () => {
    const adminAgent = agents.find((agent) => agent.id === "admin");
    const prompt = readFileSync(`${adminAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /Low-risk Todoist changes/);
    assert.match(prompt, /formatting cleanup/i);
    assert.match(prompt, /wording cleanup/i);
    assert.match(prompt, /adding detail/i);
    assert.match(prompt, /marking one personal task complete/i);
    assert.match(prompt, /rename a task/i);
    assert.match(prompt, /append a description or comment/i);
    assert.match(prompt, /replace a description/i);
    assert.match(prompt, /change due date/i);
    assert.match(prompt, /add or remove labels/i);
    assert.match(prompt, /exact task/i);
    assert.match(prompt, /without a second approval/i);
    assert.match(prompt, /Delete, reopen, move/i);
    assert.match(prompt, /shared or project-wide/i);
    assert.match(prompt, /bulk/i);
    assert.match(prompt, /screenshot\/reference/i);
  });

  it("teaches the admin agent the low-risk additive action exception", () => {
    const adminAgent = agents.find((agent) => agent.id === "admin");
    const prompt = readFileSync(`${adminAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /Low-risk additive actions/);
    assert.match(prompt, /explicitly asks/i);
    assert.match(prompt, /complete and unambiguous/i);
    assert.match(prompt, /additive/i);
    assert.match(prompt, /easy to undo/i);
    assert.match(prompt, /Calendar creation preview/i);
    assert.match(prompt, /create a Todoist task/i);
    assert.match(prompt, /OCR/i);
    assert.match(prompt, /inferred/i);
  });

  it("teaches the admin agent the Calendar preview-only runtime boundary", () => {
    const adminAgent = agents.find((agent) => agent.id === "admin");
    const prompt = readFileSync(`${adminAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /npm run calendar:create/);
    assert.match(prompt, /pure preview/i);
    assert.match(prompt, /no event was created/i);
    assert.match(prompt, /safe write tool/i);
    assert.match(prompt, /recurring or multiple events/i);
  });

  it("teaches the admin agent to use Min Golf in read-only phase 1", () => {
    const adminAgent = agents.find((agent) => agent.id === "admin");
    const prompt = readFileSync(`${adminAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /Min Golf/);
    assert.match(prompt, /npm run mingolf/);
    assert.match(prompt, /read-only/i);
    assert.match(prompt, /booking, payment, cancellation, adding players, editing bookings, and check-in require Telegram approval/i);
  });

  it("teaches the admin agent the approval-gated Min Golf booking assist flow", () => {
    const adminAgent = agents.find((agent) => agent.id === "admin");
    const prompt = readFileSync(`${adminAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /booking-request/);
    assert.match(prompt, /natural approval replies/i);
    assert.match(prompt, /approve, ok, that's ok, yes do it, go ahead/i);
    assert.match(prompt, /stop before payment/i);
    assert.match(prompt, /Sweetspot/i);
  });

  it("teaches the personal agent to manage explicit memory safely", () => {
    const personalAgent = agents.find((agent) => agent.id === "personal");
    const prompt = readFileSync(`${personalAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /Memory/);
    assert.match(prompt, /npm run memory/);
    assert.match(prompt, /What do you remember about me\?/);
    assert.match(prompt, /Forget/);
    assert.match(prompt, /sensitive memory requires Telegram approval/i);
  });

  it("teaches the personal agent to capture explicit local feedback without memory creep", () => {
    const personalAgent = agents.find((agent) => agent.id === "personal");
    const prompt = readFileSync(`${personalAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /Feedback capture/);
    assert.match(prompt, /npm run feedback -- add/);
    assert.match(prompt, /only the explicit feedback text/i);
    assert.match(prompt, /do not attach.*conversation context/i);
    assert.match(prompt, /do not write feedback to memory/i);
    assert.match(prompt, /Sensitive feedback.*rephrase/i);
    assert.match(prompt, /never send feedback externally/i);
  });

  it("teaches the personal agent the weekly plan workflow and its narrow authorization", () => {
    const personalAgent = agents.find((agent) => agent.id === "personal");
    const prompt = readFileSync(`${personalAgent.promptDir}/AGENTS.md`, "utf8");
    const section = prompt.slice(prompt.indexOf("Weekly plan:"), prompt.indexOf("Quiet Ops:"));

    assert.match(section, /stored plan is the authority, not the chat history/);
    assert.match(section, /npm run --silent weekly-plan -- status --json/);
    assert.match(section, /revise --expect-version N --changes-json-stdin/);
    assert.match(section, /restarts the 12-hour review window and never touches Todoist/);
    assert.match(section, /`Gym 3 times` → `\{"targets":\{"gym":3\}\}`/);
    assert.match(section, /`Move Friday gym to Sunday` → `\{"moves":\[\{"activity":"gym","from":"friday","to":"sunday"\}\]\}`/);
    assert.match(section, /`Don't use salmon` → `\{"excludeIngredients":\["salmon"\]\}`/);
    assert.match(section, /accept --version N --reply-text/);
    assert.match(section, /`ok but no salmon` is a change/);
    assert.match(section, /a `yes` that answers another prompt are not acceptance/);
    assert.match(section, /weekly-plan -- cancel/);
    assert.match(section, /A cancelled plan never applies/);
    assert.match(section, /exactly the stored Todoist tasks of that shown version/);
    assert.match(section, /never deletes, completes, moves or edits existing tasks/);
    assert.match(section, /never writes Calendar, Gmail or memory, books, buys, or submits forms/);
    assert.match(section, /Never create weekly-plan tasks yourself with the Todoist helper/);
    assert.match(section, /never rebuild the plan at apply time/);
  });

  it("keeps the health agent out of weekly plan task creation", () => {
    const healthAgent = agents.find((agent) => agent.id === "health");
    const prompt = readFileSync(`${healthAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /must not create, change or apply its Todoist tasks/);
  });

  it("teaches the personal agent to run memory-aware daily routines", () => {
    const personalAgent = agents.find((agent) => agent.id === "personal");
    const prompt = readFileSync(`${personalAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /Routine/);
    assert.match(prompt, /npm run routine/);
    assert.match(prompt, /morning-brief/);
    assert.match(prompt, /evening-review/);
    assert.match(prompt, /weekly-review/);
    assert.match(prompt, /ask before storing inferred memories/i);
  });

  it("teaches the personal agent scheduled routine feedback boundaries", () => {
    const personalAgent = agents.find((agent) => agent.id === "personal");
    const prompt = readFileSync(`${personalAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /scheduled routine/i);
    assert.match(prompt, /timing, tone, or detail/i);
    assert.match(prompt, /do not silently remember/i);
    assert.match(prompt, /routines:status/);
    assert.match(prompt, /routines:disable/);
    assert.match(prompt, /routines:set-time/);
  });

  it("teaches the personal agent approval-gated routine-only skip controls", () => {
    const personalAgent = agents.find((agent) => agent.id === "personal");
    const prompt = readFileSync(`${personalAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /Routine skips/);
    assert.match(prompt, /npm run routines:skips/);
    assert.match(prompt, /npm run routines:skip -- ROUTINE_ID YYYY-MM-DD/);
    assert.match(prompt, /npm run routines:unskip -- ROUTINE_ID YYYY-MM-DD/);
    assert.match(prompt, /Read-only skip inspection is allowed without extra approval/i);
    assert.match(prompt, /requires Telegram approval/i);
    assert.match(prompt, /agent, action, target routine id and date, expected effect, risk, and approval options/i);
    assert.match(prompt, /temporary and routine-only/i);
    assert.match(prompt, /does not skip one-shot reminders/i);
    assert.match(prompt, /arbitrary cron jobs/i);
    assert.match(prompt, /skip\/unskip.*does not require a gateway restart/i);
    assert.match(prompt, /confirmation.*No gateway restart is required/i);
    assert.match(prompt, /must not say.*may need a restart/i);
    assert.match(prompt, /disable\/enable controls for recurring changes/i);
  });

  it("teaches the personal agent to use read-only assistant status checks", () => {
    const personalAgent = agents.find((agent) => agent.id === "personal");
    const prompt = readFileSync(`${personalAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /Status and control/);
    assert.match(prompt, /npm run --silent assistant:status -- --json/);
    assert.match(prompt, /first run `npm run --silent assistant:status -- --json`/i);
    assert.match(prompt, /what is running right now/i);
    assert.match(prompt, /Telegram-friendly/);
    assert.match(prompt, /Read-only status checks are allowed without extra approval/i);
    assert.match(prompt, /Do not paste raw JSON unless the user asks/i);
    assert.match(prompt, /Do not say the local status script reports/i);
  });

  it("teaches the personal agent to approval-gate quiet ops mutations", () => {
    const personalAgent = agents.find((agent) => agent.id === "personal");
    const prompt = readFileSync(`${personalAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /Quiet Ops/);
    assert.match(prompt, /npm run quiet:status -- --json/);
    assert.match(prompt, /npm run quiet:audit -- --json/);
    assert.match(prompt, /Read-only quiet-ops status and audit commands are allowed without extra approval/i);
    assert.match(prompt, /first show an approval prompt/i);
    assert.match(prompt, /exact job id or exact job name/i);
    assert.match(prompt, /Do not use fuzzy job names for mutations/i);
    assert.match(prompt, /Do not delete scheduled jobs in v1/i);
  });

  it("teaches the personal agent risk-tiered approvals", () => {
    const personalAgent = agents.find((agent) => agent.id === "personal");
    const prompt = readFileSync(`${personalAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /Risk-tiered approval/);
    assert.match(prompt, /explicit user instruction counts as approval/i);
    assert.match(prompt, /low-risk additive/i);
    assert.match(prompt, /complete and unambiguous/i);
    assert.match(prompt, /Low-risk Todoist changes also count as approved/i);
    assert.match(prompt, /append or replace a description/i);
    assert.match(prompt, /Ask for approval when/i);
    assert.match(prompt, /non-Todoist action details are read from image\/OCR/i);
    assert.match(prompt, /exact screenshot\/reference target/i);
    assert.match(prompt, /inferred/i);
  });

  it("teaches the personal and admin agents the inbox action loop", () => {
    const personalAgent = agents.find((agent) => agent.id === "personal");
    const adminAgent = agents.find((agent) => agent.id === "admin");
    const healthAgent = agents.find((agent) => agent.id === "health");
    const personalPrompt = readFileSync(`${personalAgent.promptDir}/AGENTS.md`, "utf8");
    const adminPrompt = readFileSync(`${adminAgent.promptDir}/AGENTS.md`, "utf8");
    const healthPrompt = readFileSync(`${healthAgent.promptDir}/AGENTS.md`, "utf8");

    for (const prompt of [personalPrompt, adminPrompt]) {
      assert.match(prompt, /Inbox action loop/i);
      assert.match(prompt, /execute low-risk exact actions directly and confirm/i);
      assert.match(prompt, /approval_required/i);
      assert.match(prompt, /clarify/i);
      assert.match(prompt, /answer_only/i);
      assert.match(prompt, /reference-derived non-Todoist action details/i);
    }

    assert.match(healthPrompt, /route Todoist and Calendar mutations through the personal or admin agent/i);
  });
});

describe("on-demand coaching prompts", () => {
  const promptFor = (id) => readFileSync(`${agents.find((agent) => agent.id === id).promptDir}/AGENTS.md`, "utf8");
  const between = (text, start, end) => {
    const from = text.indexOf(start);
    const to = text.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing section ${start}`);
    return text.slice(from, to);
  };
  const personalPrompt = promptFor("personal");
  const healthPrompt = promptFor("health");
  const adminPrompt = promptFor("admin");
  const coaching = between(personalPrompt, "On-demand coaching:", "Confirm-before-action:");
  const healthSleep = between(healthPrompt, "Sleep and recovery coaching:", "Confirm-before-action:");

  it("keeps coaching on demand, inside the one visible assistant", () => {
    assert.equal(agents.length, 4);
    assert.match(coaching, /The user starts every coaching conversation; coaching has no scheduled, proactive, or automatic form/);
    assert.match(coaching, /No scheduled or proactive coaching: no daily motivation, automatic mindfulness prompts, morning coaching, or unsolicited mental-performance assessments/);
    assert.match(coaching, /Coach only in reply to the user/);
    assert.match(healthSleep, /Coach only when the user asks/);
    assert.match(healthSleep, /Scheduled check-ins keep their existing scope/);
    assert.match(personalPrompt, /keep on-demand golf and work performance coaching here/);
    assert.match(coaching, /Never show mode names, labels, or JSON/);
  });

  it("recognizes coaching requests but answers factual questions as questions", () => {
    for (const request of [
      "Coach me", "Mental coach", "Performance coach", "Pre-round coach", "Golf mindset", "Help me stay present",
      "Help me focus", "Reset me", "I'm tilting", "I'm frustrated after that hole", "Help me prepare mentally",
      "I'm procrastinating", "Sleep coach", "Help me wind down tonight", "Debrief my round", "Debrief this work session",
    ]) {
      assert.ok(coaching.includes(`\`${request}\``), request);
    }
    assert.match(coaching, /is a question, not a coaching request: answer it, and route source-backed lookups to research/);
  });

  it("coaches with one practical intervention instead of a list of advice", () => {
    assert.match(coaching, /not a motivational quote generator/);
    assert.match(coaching, /name what is controllable, choose one small mental or process intervention, give one immediate action or cue/);
    assert.match(coaching, /One intervention done consistently beats five techniques at once\. Never send a long list of advice/);
    assert.match(coaching, /No motivational clichés, excessive praise, generic `believe in yourself` lines, or lectures/);
  });

  it("keeps a quick reset and an in-performance reply short", () => {
    assert.match(coaching, /Quick reset, for stress, frustration, distraction, overthinking, or lost focus: one short acknowledgement, at most one short question, one reset action, and one cue or next step/);
    assert.match(coaching, /In-performance, when the user is on the course, in a meeting, or inside a work block right now: shorter still/);
    assert.match(coaching, /Ask no questions and do not start a reflective conversation unless the user asks for one/);
    assert.match(coaching, /Ask none when the situation is clear and urgent/);
  });

  it("lets preparation ask a few questions and keeps debriefs about process", () => {
    assert.match(coaching, /ask one to three useful questions only when the answer is not already known/);
    assert.match(coaching, /Define success by the process, never by a score or an outcome/);
    assert.match(coaching, /send three to five short prompts in one message/);
    assert.match(coaching, /Keep it about process, not self-criticism/);
    assert.match(coaching, /End with one thing to keep, one thing to adjust, and optionally one lesson they may choose to save/);
    assert.match(coaching, /Never ask for something the conversation, memory, or the coaching playbook already answers/);
  });

  it("keeps golf coaching mental unless technique is explicitly asked for", () => {
    assert.match(coaching, /Use golf process language: target, decision, breath, commit, accept, next shot/);
    assert.match(coaching, /Give no technical swing instruction unless the user explicitly asks/);
    assert.match(coaching, /their golf coach, who can see the swing, is the right person for mechanics/);
    assert.match(coaching, /do not recast it as a purely mental problem/);
  });

  it("gives work coaching a concrete next-action pattern", () => {
    assert.match(coaching, /Prefer the next controllable action, a short focus window, removing one source of friction/);
    assert.match(coaching, /For the next 30 minutes your job is not to finish the feature/);
    assert.match(adminPrompt, /route mental preparation and performance coaching to personal while keeping meeting agendas, notes, and logistics here/);
    assert.match(coaching, /Agenda, notes, and logistics for a meeting stay ordinary admin meeting prep/);
  });

  it("keeps sleep coaching about habits and never diagnostic, in personal and health alike", () => {
    assert.match(coaching, /Sleep and recovery coaching is health's domain\. Whoever answers it follows the Sleep coaching rules below/);
    for (const text of [coaching, healthSleep]) {
      assert.match(text, /Coach controllable behaviour and schedule: a consistent wake time, bedtime, wind-down, light and device use, caffeine timing, evening work/);
      assert.match(text, /Ask up to three questions/);
      assert.match(text, /Do not diagnose sleep disorders or read symptoms as a diagnosis/);
      assert.match(text, /For persistent or severe sleep problems, possible medical symptoms/);
      assert.match(text, /this is beyond habit coaching and suggest seeing a doctor or contacting 1177 for an assessment/);
    }
    assert.match(healthPrompt, /Do not diagnose medical conditions/);
  });

  it("separates performance coaching from mental-health treatment", () => {
    assert.match(coaching, /It is not therapy or treatment/);
    assert.match(coaching, /Do not diagnose or label mental-health conditions, read feelings as symptoms, claim to provide psychotherapy, suggest changing or stopping prescribed treatment, or present coaching as a substitute for professional care/);
    assert.match(coaching, /normal performance emotion\. Treat it that way, without clinical words/);
    assert.match(coaching, /drop the performance framing/);
    assert.match(coaching, /point to urgent help first: 112 in Sweden, or the local emergency number/);
    assert.match(coaching, /Do not steer it back to golf or work/);
  });

  it("never lets a coaching idea create tasks, events, routines, or schedules", () => {
    assert.match(coaching, /Coaching is conversation only\. A coaching idea never creates a Todoist task, reminder, workout, routine, or Calendar event, never edits Calendar, and never changes the weekly plan/);
    assert.match(coaching, /You may offer once: `Want me to make that a Todoist task\?` Nothing is created unless the user clearly says yes, and then the normal Todoist rules apply unchanged/);
    assert.match(healthSleep, /It creates no routines, reminders, tasks, or Calendar events/);
    assert.match(personalPrompt, /Use `answer_only` for status, advice, informational, and coaching requests\. Coaching is conversation, never an action by itself/);
  });

  it("stores playbook entries only through the existing explicit memory rules", () => {
    const keys = [
      "golf/cue-word", "golf/bad-shot-reset", "golf/pre-round-routine", "work/deep-work-block",
      "work/reset-routine", "sleep/target-wake-time", "sleep/wind-down-routine",
    ];
    for (const key of keys) {
      assert.ok(coaching.includes(`\`${key}\``), key);
      assert.ok(memoryCategories.includes(key.split("/")[0]), key);
    }
    assert.match(coaching, /`npm run memory -- remember --category golf --key cue-word --value "commit" --source telegram`/);
    assert.match(coaching, /When a routine is only mentioned in passing while asking for something else, ask before saving it/);
    assert.match(coaching, /Never infer or silently store personality traits, psychological weaknesses, mental-health labels, emotional vulnerabilities, conclusions drawn from frustrated messages, or diagnoses/);
    assert.match(coaching, /`I always choke under pressure` is something said in a hard moment, not a memory/);
    assert.match(coaching, /`Do you want me to remember that as part of your coaching playbook\?`/);
    assert.match(coaching, /Offer to save the routine, never the judgement/);
    assert.match(coaching, /including workspace notes or daily memory files/);
    assert.match(coaching, /They go through the sensitive-memory approval flow and never become ordinary playbook entries/);
    assert.match(personalPrompt, /Coaching playbook entries use the same command and rules/);
  });

  it("lists the same memory categories as the memory helper", () => {
    const line = personalPrompt.split("\n").find((entry) => entry.startsWith("- Use categories: "));

    assert.deepEqual(line.slice("- Use categories: ".length).replace(/\.$/, "").split(", "), memoryCategories);
  });

  it("cannot weaken an approval boundary from inside the coaching sections", () => {
    for (const text of [coaching, healthSleep]) {
      for (const grant of [
        /without (a second |extra |further |any )?approval/i,
        /no (extra |further )?approval (is )?(needed|required)/i,
        /counts? as (an )?approval/i,
        /pre-?approved/i,
        /standing authori[sz]ation/i,
        /auto-?appl(y|ies)/i,
        /skip(ping)? (the )?approval/i,
        /--approved/,
        /--sensitivity sensitive/,
      ]) {
        assert.doesNotMatch(text, grant);
      }
    }

    // The only commands coaching may name are the memory helper's list and
    // remember, which keep their own explicit and sensitive-memory rules.
    const commands = coaching.match(/npm run [^`]+/g) ?? [];
    assert.ok(commands.length > 0);
    for (const command of commands) {
      assert.match(command, /^npm run memory -- (list|remember) /);
    }
    assert.doesNotMatch(healthSleep, /npm run/);

    // The general approval rules still follow the coaching sections.
    assert.ok(personalPrompt.indexOf("On-demand coaching:") < personalPrompt.indexOf("\nConfirm-before-action:\n"));
    assert.ok(personalPrompt.indexOf("\nConfirm-before-action:\n") < personalPrompt.indexOf("\nTone:\n"));
  });
});
