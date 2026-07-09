import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildCalendarCreationPreview,
  formatCalendarCreationPreview,
} from "../scripts/lib/calendar-create.mjs";
import {
  parseCalendarCreateArgs,
  runCalendarCreateCli,
} from "../scripts/calendar-create.mjs";

const completeRequest = {
  title: "Gym",
  date: "2026-07-09",
  start: "17:30",
  duration: "60",
};

describe("Calendar creation preview", () => {
  it("builds a policy-allowed preview for one complete low-risk personal event", () => {
    const preview = buildCalendarCreationPreview(completeRequest);

    assert.equal(preview.mode, "policy_allowed_preview");
    assert.equal(preview.intent, "calendar.create");
    assert.equal(preview.approvalRequired, false);
    assert.equal(preview.readyForSafeCreateTool, true);
    assert.equal(preview.execution, "preview_only");
    assert.deepEqual(preview.sideEffects, []);
    assert.equal(preview.request.calendar, "primary");
    assert.equal(preview.request.timezone, "Europe/Stockholm");
    assert.equal(preview.request.timezoneSource, "default");
    assert.equal(preview.request.end, "18:30");
    assert.equal(Object.hasOwn(preview, "created"), false);

    const output = formatCalendarCreationPreview(preview);
    assert.match(output, /Calendar creation preview: Gym/);
    assert.match(output, /Primary personal Calendar/);
    assert.match(output, /No guests/);
    assert.match(output, /No email/);
    assert.match(output, /preview only; no event was created/i);
  });

  it("accepts an explicit end time and timezone", () => {
    const { duration, ...requestWithEnd } = completeRequest;
    const preview = buildCalendarCreationPreview({
      ...requestWithEnd,
      end: "18:45",
      timezone: "Europe/Helsinki",
    });

    assert.equal(preview.mode, "policy_allowed_preview");
    assert.equal(preview.request.durationMinutes, 75);
    assert.equal(preview.request.timezone, "Europe/Helsinki");
    assert.equal(preview.request.timezoneSource, "explicit");
  });

  it("asks one focused question when required creation details are missing or ambiguous", () => {
    const missingDuration = buildCalendarCreationPreview({
      title: "Gym",
      date: "2026-07-09",
      start: "17:30",
    });
    assert.equal(missingDuration.mode, "clarification_needed");
    assert.equal(missingDuration.approvalRequired, false);
    assert.match(missingDuration.question, /duration or end time/i);

    const ambiguousDate = buildCalendarCreationPreview({
      ...completeRequest,
      date: "tomorrow",
    });
    assert.equal(ambiguousDate.mode, "clarification_needed");
    assert.match(ambiguousDate.question, /YYYY-MM-DD/i);

    const duplicate = buildCalendarCreationPreview({
      ...completeRequest,
      possibleDuplicate: true,
    });
    assert.equal(duplicate.mode, "clarification_needed");
    assert.match(duplicate.question, /duplicate/i);

    const crossesMidnight = buildCalendarCreationPreview({
      ...completeRequest,
      start: "23:30",
      duration: "60",
    });
    assert.equal(crossesMidnight.mode, "clarification_needed");
    assert.match(crossesMidnight.question, /end time/i);
  });

  it("requires approval for guests, mutation, recurrence, multiple events, or external impact", () => {
    for (const request of [
      { ...completeRequest, guests: ["anna@example.com"] },
      { ...completeRequest, operation: "edit" },
      { ...completeRequest, recurring: true },
      { ...completeRequest, eventCount: 2 },
      { ...completeRequest, affectsOtherPeople: true },
      { ...completeRequest, sensitiveContent: true },
      { ...completeRequest, inferredSubstantiveContent: true, source: "screenshot" },
      { ...completeRequest, requiresBrowserSubmission: true },
    ]) {
      const preview = buildCalendarCreationPreview(request);
      assert.equal(preview.mode, "approval_required");
      assert.equal(preview.approvalRequired, true);
      assert.equal(preview.execution, "preview_only");
      assert.deepEqual(preview.sideEffects, []);
    }
  });

  it("requires approval for a named non-primary or shared Calendar", () => {
    const preview = buildCalendarCreationPreview({
      ...completeRequest,
      calendar: "Family",
    });

    assert.equal(preview.mode, "approval_required");
    assert.match(preview.reason, /non-primary/i);
  });

  it("returns unsupported instead of executing when a caller requests a Calendar write", () => {
    const preview = buildCalendarCreationPreview({
      ...completeRequest,
      requestExecution: true,
    });

    assert.equal(preview.mode, "unsupported");
    assert.equal(preview.approvalRequired, false);
    assert.equal(preview.execution, "preview_only");
    assert.deepEqual(preview.sideEffects, []);
    assert.match(preview.reason, /no documented safe Calendar write tool/i);
  });

  it("parses a dry-run CLI request and returns only a preview", async () => {
    const args = [
      "--title", "Gym",
      "--date", "2026-07-09",
      "--start", "17:30",
      "--duration", "60",
      "--dry-run",
    ];
    assert.deepEqual(parseCalendarCreateArgs(args), {
      options: { dryRun: true, json: false },
      request: completeRequest,
    });

    const preview = await runCalendarCreateCli(args);
    assert.equal(preview.mode, "policy_allowed_preview");
    assert.equal(preview.execution, "preview_only");
    assert.deepEqual(preview.sideEffects, []);
  });

  it("refuses a non-dry-run CLI request because v1 has no Calendar write tool", async () => {
    await assert.rejects(
      runCalendarCreateCli([
        "--title", "Gym",
        "--date", "2026-07-09",
        "--start", "17:30",
        "--duration", "60",
      ]),
      /--dry-run/i,
    );
  });

  it("keeps the helper free of Calendar clients and external call paths", () => {
    const source = readFileSync("scripts/lib/calendar-create.mjs", "utf8");

    assert.doesNotMatch(source, /\b(fetch|https?|googleapis|child_process)\b/i);
  });
});
