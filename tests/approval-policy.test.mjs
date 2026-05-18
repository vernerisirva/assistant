import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const policy = JSON.parse(readFileSync("config/approval-policy.json", "utf8"));

const actionsForDomain = (domain) =>
  policy.approvalRequired.find((entry) => entry.domain === domain)?.actions ?? [];

describe("approval policy", () => {
  it("keeps every side-effect domain behind Telegram approval", () => {
    const approvalDomains = policy.approvalRequired.map((entry) => entry.domain);

    assert.deepEqual(approvalDomains, [
      "email",
      "calendar",
      "shell",
      "browser",
      "todoist",
      "files",
      "sensitive-local-data",
      "purchases-and-finance",
    ]);
  });

  it("starts in confirm-before-action mode", () => {
    assert.equal(policy.initialTrustMode, "confirm-before-action");
    assert.equal(policy.approvalChannel, "telegram");
  });

  it("defines a narrow promotion process for future trusted routines", () => {
    assert.equal(policy.trustLadder[0].mode, "confirm-before-action");
    assert.equal(policy.trustLadder[1].mode, "trusted-routine");
    assert.equal(policy.trustLadder[2].mode, "permanent-approval-required");
  });

  it("keeps high-risk actions approval-gated", () => {
    assert.ok(actionsForDomain("calendar").includes("respond-to-invite"));
    assert.ok(actionsForDomain("todoist").includes("delete-task"));
    assert.ok(actionsForDomain("sensitive-local-data").includes("extract-secrets"));
    assert.ok(actionsForDomain("purchases-and-finance").includes("trade"));
  });

  it("requires complete approval prompt context", () => {
    assert.deepEqual(policy.approvalPromptRequiredFields, [
      "agent",
      "action",
      "target",
      "expectedEffect",
      "risk",
      "approvalOptions",
    ]);
  });

  it("keeps audit logs reconstructable from approval prompts", () => {
    assert.deepEqual(policy.auditLogFields, [
      "timestamp",
      "agent",
      "action",
      "target",
      "expectedEffect",
      "risk",
      "approvalOptions",
      "decision",
      "result",
    ]);
  });
});
