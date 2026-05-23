import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  approvalLanguagePolicy,
  isApprovalMessage,
} from "../scripts/lib/approval-language.mjs";

describe("approval language", () => {
  it("accepts natural approval replies when an approval is pending", () => {
    for (const phrase of [
      "approve",
      "ok",
      "okay",
      "that's ok",
      "thats is ok",
      "yes, do it",
      "go ahead",
      "proceed",
      "sounds good",
      "looks good",
      "sure",
    ]) {
      assert.equal(isApprovalMessage(phrase, { hasPendingApproval: true }), true, phrase);
    }
  });

  it("does not treat approvals as valid without a pending approval prompt", () => {
    assert.equal(isApprovalMessage("approve", { hasPendingApproval: false }), false);
  });

  it("rejects denials, questions, and ambiguous hedges", () => {
    for (const phrase of [
      "no",
      "do not approve",
      "don't do it",
      "stop",
      "cancel",
      "is that ok?",
      "can you approve this?",
      "maybe ok",
      "probably fine",
    ]) {
      assert.equal(isApprovalMessage(phrase, { hasPendingApproval: true }), false, phrase);
    }
  });

  it("documents short approval examples for prompts", () => {
    assert.ok(approvalLanguagePolicy.acceptedExamples.includes("approve"));
    assert.ok(approvalLanguagePolicy.acceptedExamples.includes("that's ok"));
    assert.ok(approvalLanguagePolicy.acceptedExamples.includes("go ahead"));
  });
});
