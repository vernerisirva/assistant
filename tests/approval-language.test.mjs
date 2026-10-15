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

  it("checks the raw reply, so a question mark in any script, an ellipsis or a non-positive emoji is not an approval", () => {
    for (const phrase of [
      "ok？",
      "ok ❓",
      "ok ❔",
      "yes ⁉\uFE0F",
      "ok‽",
      "¿ok",
      "ok…",
      "ok...",
      "ok..",
      "fine…",
      "ok 🤔",
      "ok 👎",
      "okay ❌",
      "sure 🙄",
      "ok ✋",
      "ok ❤\uFE0F",
      "ok :/",
      "o\u200Bk",
      "👍",
    ]) {
      assert.equal(isApprovalMessage(phrase, { hasPendingApproval: true }), false, phrase);
    }
  });

  it("accepts a plain approval with ordinary punctuation or a positive emoji", () => {
    for (const phrase of ["OK!", "Looks good.", "that’s ok", "ok 👍", "OK 👍🏼", "ok ✅", "yes please", "Ok, go ahead!"]) {
      assert.equal(isApprovalMessage(phrase, { hasPendingApproval: true }), true, phrase);
    }
  });

  it("accepts plain Swedish and Finnish approvals", () => {
    for (const phrase of ["ja", "Ja tack", "japp", "okej", "kör", "Kör på!", "visst", "absolut", "låter bra", "Ser bra ut", "godkänt", "gör det", "joo", "kyllä", "selvä", "käy", "sopii", "näyttää hyvältä", "hyväksyn"]) {
      assert.equal(isApprovalMessage(phrase, { hasPendingApproval: true }), true, phrase);
    }
  });

  it("rejects Swedish and Finnish replies that ask, hedge, refuse or change something", () => {
    for (const phrase of ["ja?", "kanske", "nej", "inte nu", "vänta", "ja men utan lax", "kör men flytta gymmet", "ehkä", "ei", "joo mutta ei lohta", "en tiedä"]) {
      assert.equal(isApprovalMessage(phrase, { hasPendingApproval: true }), false, phrase);
    }
  });

  it("refuses a reply longer than 240 characters", () => {
    assert.equal(isApprovalMessage(`ok${"!".repeat(238)}`, { hasPendingApproval: true }), true);
    assert.equal(isApprovalMessage(`ok${"!".repeat(239)}`, { hasPendingApproval: true }), false);
  });

  it("documents short approval examples for prompts", () => {
    assert.ok(approvalLanguagePolicy.acceptedExamples.includes("approve"));
    assert.ok(approvalLanguagePolicy.acceptedExamples.includes("that's ok"));
    assert.ok(approvalLanguagePolicy.acceptedExamples.includes("go ahead"));
  });
});
