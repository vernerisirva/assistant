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
      /creating, editing, completing, deleting, or rescheduling Todoist tasks requires Telegram approval/i,
    );
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
  });
});
