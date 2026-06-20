import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

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
      /Delete, complete, reopen, move between projects\/sections, bulk edits, ambiguous targets, OCR\/image-derived details, and inferred task changes require Telegram approval/i,
    );
  });

  it("teaches the admin agent low-risk Todoist updates can proceed from explicit instructions", () => {
    const adminAgent = agents.find((agent) => agent.id === "admin");
    const prompt = readFileSync(`${adminAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /Low-risk Todoist changes/);
    assert.match(prompt, /rename a task/i);
    assert.match(prompt, /append a description or comment/i);
    assert.match(prompt, /replace a description/i);
    assert.match(prompt, /change due date/i);
    assert.match(prompt, /add or remove labels/i);
    assert.match(prompt, /exact task/i);
    assert.match(prompt, /without a second approval/i);
    assert.match(prompt, /Delete, complete, reopen, move/i);
    assert.match(prompt, /bulk/i);
    assert.match(prompt, /OCR/i);
  });

  it("teaches the admin agent the low-risk additive action exception", () => {
    const adminAgent = agents.find((agent) => agent.id === "admin");
    const prompt = readFileSync(`${adminAgent.promptDir}/AGENTS.md`, "utf8");

    assert.match(prompt, /Low-risk additive actions/);
    assert.match(prompt, /explicitly asks/i);
    assert.match(prompt, /complete and unambiguous/i);
    assert.match(prompt, /additive/i);
    assert.match(prompt, /easy to undo/i);
    assert.match(prompt, /create a Calendar event/i);
    assert.match(prompt, /create a Todoist task/i);
    assert.match(prompt, /OCR/i);
    assert.match(prompt, /inferred/i);
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
    assert.match(prompt, /image\/OCR/i);
    assert.match(prompt, /inferred/i);
  });
});
