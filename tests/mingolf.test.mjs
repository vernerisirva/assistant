import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMinGolfSearchPlan, parseMinGolfArgs } from "../scripts/mingolf.mjs";

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
});
