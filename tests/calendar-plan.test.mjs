import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  formatCalendarPlan,
  planCalendarSnapshot,
} from "../scripts/lib/calendar-plan.mjs";
import { parseCalendarPlanArgs, runCalendarPlanCli } from "../scripts/calendar-plan.mjs";

const fixturePath = "tests/fixtures/calendar-events.json";
const events = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("read-only calendar planning", () => {
  it("builds a concise day plan from a supplied event snapshot", () => {
    const plan = planCalendarSnapshot(events, {
      range: "today",
      date: "2026-07-09",
      timezone: "Europe/Stockholm",
    });

    assert.equal(plan.readOnly, true);
    assert.deepEqual(plan.sideEffects, []);
    assert.equal(plan.days.length, 1);
    assert.equal(plan.days[0].busyEvents.length, 3);
    assert.equal(plan.days[0].pressure, "medium");
    assert.deepEqual(plan.days[0].freeBlocks.map((block) => block.durationMinutes), [60, 120, 240]);
    assert.ok(plan.days[0].windows.focus);
    assert.ok(plan.days[0].windows.workout);
    assert.ok(plan.days[0].windows.admin);
    assert.match(plan.days[0].suggestedPlan, /focus|workout|admin/i);
  });

  it("flags back-to-back meetings and groups them into a cluster", () => {
    const [day] = planCalendarSnapshot(events, {
      range: "today",
      date: "2026-07-09",
    }).days;

    assert.equal(day.meetingClusters.length, 1);
    assert.equal(day.meetingClusters[0].eventCount, 2);
    assert.deepEqual(day.risks, [{ type: "back-to-back", start: "09:00", end: "11:00" }]);
  });

  it("summarizes a calendar week without changing events", () => {
    const plan = planCalendarSnapshot(events, {
      range: "week",
      date: "2026-07-09",
    });

    assert.equal(plan.days.length, 7);
    assert.equal(plan.summary.busyEventCount, 5);
    assert.ok(plan.summary.freeMinutes > 0);
    assert.equal(plan.readOnly, true);
    assert.deepEqual(plan.sideEffects, []);
  });

  it("handles an empty calendar as an open planning day", () => {
    const [day] = planCalendarSnapshot([], {
      range: "today",
      date: "2026-07-09",
    }).days;

    assert.equal(day.pressure, "low");
    assert.equal(day.busyEvents.length, 0);
    assert.equal(day.freeBlocks.length, 1);
    assert.equal(day.freeBlocks[0].durationMinutes, 600);
    assert.match(formatCalendarPlan({
      range: "today",
      date: "2026-07-09",
      timezone: "Europe/Stockholm",
      readOnly: true,
      sideEffects: [],
      days: [day],
      summary: { busyEventCount: 0, freeMinutes: 600, pressure: "low" },
    }), /No busy events/i);
  });

  it("uses proposal-only wording for suggested calendar changes", () => {
    const output = formatCalendarPlan(planCalendarSnapshot(events, {
      range: "today",
      date: "2026-07-09",
    }));

    assert.match(output, /Proposed change: block .* for focused work\. Ask me to create it if you want\./i);
    assert.doesNotMatch(output, /created|updated|deleted|invited|RSVP/i);
  });

  it("rejects invalid or incomplete normalized events", () => {
    assert.throws(
      () => planCalendarSnapshot([{ start: "2026-07-09T07:00:00.000Z", end: "2026-07-09T08:00:00.000Z" }], {
        range: "today",
        date: "2026-07-09",
      }),
      /title is required/i,
    );
    assert.throws(
      () => planCalendarSnapshot([{ title: "Broken", start: "2026-07-09T08:00:00.000Z", end: "2026-07-09T07:00:00.000Z" }], {
        range: "today",
        date: "2026-07-09",
      }),
      /end must be after start/i,
    );
  });
});

describe("calendar planning CLI", () => {
  it("parses an explicit event snapshot path and rejects ambiguous dates", () => {
    assert.deepEqual(parseCalendarPlanArgs([
      "today",
      "--events-json",
      fixturePath,
      "--date",
      "2026-07-09",
    ]), {
      range: "today",
      options: {
        eventsJsonPath: fixturePath,
        date: "2026-07-09",
      },
    });
    assert.throws(
      () => parseCalendarPlanArgs(["today", "--events-json", fixturePath, "--date", "tomorrow"]),
      /YYYY-MM-DD/i,
    );
  });

  it("reads the supplied snapshot only and returns a day plan", async () => {
    const plan = await runCalendarPlanCli(["today", "--events-json", fixturePath, "--date", "2026-07-09"]);

    assert.equal(plan.readOnly, true);
    assert.deepEqual(plan.sideEffects, []);
    assert.equal(plan.days[0].busyEvents.length, 3);
  });
});
