/**
 * Plain calendar-day helpers shared by the weekly planner and its golf week.
 * Plan days are YYYY-MM-DD strings; arithmetic happens in UTC so a DST change
 * can never shift a calendar day.
 */

export const WEEKDAYS = Object.freeze(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
export const MONTHS = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
const WEEKDAY_ALIASES = Object.freeze({
  mon: "monday",
  tue: "tuesday",
  tues: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  fri: "friday",
  sat: "saturday",
  sun: "sunday",
});

export function addDays(date, days) {
  assertIsoDate(date);
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Monday ... 6 = Sunday. */
export function weekdayIndex(date) {
  assertIsoDate(date);
  return (new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7;
}

export function weekdayName(date) {
  return capitalize(WEEKDAYS[weekdayIndex(date)]);
}

export function shortWeekday(date) {
  return weekdayName(date).slice(0, 3);
}

export function weekDates(weekStart) {
  if (weekdayIndex(weekStart) !== 0) throw new Error(`Weekly plan must start on a Monday: ${weekStart}`);
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
}

/** Accepts a weekday name ("friday", "Fri") or a YYYY-MM-DD date inside the plan week. */
export function resolvePlanDay(ref, weekStart) {
  const value = String(ref ?? "").trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (!weekDates(weekStart).includes(value)) {
      throw new Error(`${value} is not part of the plan week starting ${weekStart}.`);
    }
    return value;
  }

  const name = WEEKDAY_ALIASES[value] ?? value;
  const index = WEEKDAYS.indexOf(name);
  if (index < 0) throw new Error(`Unknown day: ${ref}. Use a weekday name or a YYYY-MM-DD date.`);
  return addDays(weekStart, index);
}

/** "28 Sep–4 Oct" for the week starting on `weekStart`. */
export function formatWeekLabel(weekStart) {
  return `${shortDate(weekStart)}–${shortDate(addDays(weekStart, 6))}`;
}

function shortDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
}

/** A real calendar date: JavaScript would quietly turn 2026-02-30 into 2 March. */
export function assertIsoDate(date) {
  const ms = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00.000Z`) : NaN;
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid date: ${date}`);
  }
}

function capitalize(value) {
  const text = String(value);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
