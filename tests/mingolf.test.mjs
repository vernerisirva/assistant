import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMinGolfBookingApproval,
  buildMinGolfSearchPlan,
  parseMinGolfArgs,
} from "../scripts/mingolf.mjs";

describe("Min Golf search helper", () => {
  it("parses a tee-time search request", () => {
    const parsed = parseMinGolfArgs([
      "search",
      "--club",
      "Stockholms Golfklubb",
      "--date",
      "2026-05-23",
      "--from",
      "08:00",
      "--to",
      "12:00",
      "--players",
      "2",
    ]);

    assert.deepEqual(parsed, {
      command: "search",
      options: {
        club: "Stockholms Golfklubb",
        date: "2026-05-23",
        from: "08:00",
        to: "12:00",
        players: 2,
      },
    });
  });

  it("requires a club or area and date for search plans", () => {
    assert.throws(
      () => buildMinGolfSearchPlan({ club: "Stockholms Golfklubb" }),
      /--date is required/,
    );
    assert.throws(
      () => buildMinGolfSearchPlan({ date: "2026-05-23" }),
      /--club or --area is required/,
    );
  });

  it("builds a read-only browser plan with booking actions forbidden", () => {
    const plan = buildMinGolfSearchPlan({
      club: "Stockholms Golfklubb",
      date: "2026-05-23",
      from: "08:00",
      to: "12:00",
      players: 2,
      holes: 18,
    });

    assert.equal(plan.readOnly, true);
    assert.equal(plan.sourceUrl, "https://mingolf.golf.se/");
    assert.deepEqual(plan.criteria, {
      club: "Stockholms Golfklubb",
      area: null,
      date: "2026-05-23",
      from: "08:00",
      to: "12:00",
      players: 2,
      holes: 18,
    });
    assert.ok(plan.browserSteps.some((step) => /Hitta starttid/.test(step)));
    assert.ok(plan.browserSteps.some((step) => /Visa starttider/.test(step)));
    assert.ok(plan.browserSteps.some((step) => /Do not click Boka/.test(step)));
    assert.ok(plan.forbiddenActions.includes("book-tee-time"));
    assert.ok(plan.forbiddenActions.includes("pay-greenfee"));
    assert.ok(plan.forbiddenActions.includes("check-in"));
  });

  it("parses a tee-time booking approval request", () => {
    const parsed = parseMinGolfArgs([
      "booking-request",
      "--club",
      "Stockholms Golfklubb",
      "--course",
      "Gamla banan",
      "--date",
      "2026-05-23",
      "--time",
      "09:40",
      "--players",
      "2",
      "--price",
      "650 SEK/player",
      "--payment",
      "pay-later",
      "--cancellation",
      "Cancel by 18:00 the day before",
    ]);

    assert.deepEqual(parsed, {
      command: "booking-request",
      options: {
        club: "Stockholms Golfklubb",
        course: "Gamla banan",
        date: "2026-05-23",
        time: "09:40",
        players: 2,
        price: "650 SEK/player",
        payment: "pay-later",
        cancellation: "Cancel by 18:00 the day before",
      },
    });
  });

  it("builds a complete approval prompt for booking assist", () => {
    const request = buildMinGolfBookingApproval({
      club: "Stockholms Golfklubb",
      course: "Gamla banan",
      date: "2026-05-23",
      time: "09:40",
      players: 2,
      price: "650 SEK/player",
      payment: "pay-later",
      cancellation: "Cancel by 18:00 the day before",
    });

    assert.equal(request.phase, "min-golf-booking-assist");
    assert.equal(request.requiresTelegramApproval, true);
    assert.equal(request.approvalLanguage.acceptsNaturalLanguage, true);
    assert.ok(request.approvalLanguage.acceptedExamples.includes("approve"));
    assert.ok(request.approvalLanguage.acceptedExamples.includes("that's ok"));
    assert.equal(request.approvalPrompt.agent, "admin");
    assert.equal(request.approvalPrompt.action, "book-tee-time");
    assert.match(request.approvalPrompt.target, /Stockholms Golfklubb/);
    assert.match(request.approvalPrompt.target, /2026-05-23/);
    assert.match(request.approvalPrompt.expectedEffect, /book/i);
    assert.match(request.approvalPrompt.risk, /payment/i);
    assert.match(request.approvalPrompt.risk, /no-show/i);
    assert.ok(request.approvalPrompt.approvalOptions.some((option) =>
      option.includes("approve"),
    ));
    assert.ok(request.browserStepsAfterApproval.some((step) => /exactly matches/i.test(step)));
    assert.ok(request.hardStops.includes("payment-required"));
    assert.ok(request.hardStops.includes("bankid-or-strong-auth"));
    assert.ok(request.hardStops.includes("sweetspot-redirect"));
  });

  it("requires exact tee-time details before drafting booking approval", () => {
    assert.throws(
      () => buildMinGolfBookingApproval({
        club: "Stockholms Golfklubb",
        date: "2026-05-23",
        players: 2,
      }),
      /--time is required/,
    );
  });
});
