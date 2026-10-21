/**
 * Calendar dates for contracts.
 *
 * Contract dates are plain YYYY-MM-DD calendar days in the user's time zone
 * (Europe/Stockholm), never instants: a renewal on 1 March is 1 March whatever
 * the clock does around a daylight-saving change. Every calculation here works
 * on calendar days and months, and "today" is the only place a time zone
 * enters.
 *
 * A contract's dates mean different things, and this module keeps them apart:
 *
 * - renewalDate: the day the next term starts, or the day the contract ends
 *   when it does not renew;
 * - bindingEndDate: the end of a minimum commitment, from which leaving costs
 *   no penalty;
 * - discountEndDate and priceGuaranteeEndDate: the price changes, the contract
 *   carries on;
 * - cancellationDeadline: the last day to give notice, when the provider
 *   states it;
 * - a notice deadline worked out from the notice period and the renewal date.
 *
 * Nothing here invents a date. An unknown notice period gives no notice
 * deadline, and a deadline worked out from a notice period the user has not
 * checked, or a renewal whose notice period is unknown, is marked provisional.
 */

export const CONTRACT_TIMEZONE = "Europe/Stockholm";
export const NOTICE_UNITS = Object.freeze(["days", "months", "calendar_months"]);

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Key date kinds in the order they are listed when two fall on the same day. */
export const KEY_DATE_KINDS = Object.freeze([
  "cancellation_deadline",
  "notice_deadline",
  "discount_end",
  "price_guarantee_end",
  "binding_end",
  "renewal",
]);

export function isIsoDate(value) {
  const match = ISO_DATE.exec(typeof value === "string" ? value : "");
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  return year >= 1900 && year <= 2200 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Today's date where the user is, as YYYY-MM-DD. */
export function localDate(now = new Date(), timezone = CONTRACT_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(date, days) {
  return new Date(toUtcMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** N calendar months later (or earlier), on the same day, or the month's last day when it is shorter. */
export function addMonths(date, months) {
  const [year, month, day] = parts(date);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  return isoFrom(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
}

/** 29 Feb plus a year is 28 Feb. */
export function addYears(date, years) {
  return addMonths(date, years * 12);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from, to) {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

export function lastDayOfMonth(date) {
  const [year, month] = parts(date);
  return isoFrom(year, month, daysInMonth(year, month));
}

/**
 * The last day notice can be given so the contract ends before `date`, the
 * day its next term would start.
 *
 * - days: at least N days before that date;
 * - months: N months before it, on the same day of the month (or that
 *   month's last day when it is shorter);
 * - calendar_months: notice runs to the end of the Nth calendar month after
 *   the month it is given in (a Swedish "kalendermånad"), so it must be given
 *   by the last day of the month whose notice ends in time.
 */
export function noticeDeadline(date, noticePeriod) {
  const { value, unit } = noticePeriod;
  if (unit === "days") return addDays(date, -value);
  if (unit === "months") return addMonths(date, -value);
  if (unit === "calendar_months") {
    const lastDay = addDays(date, -1);
    const lastEndingMonth = lastDayOfMonth(lastDay) === lastDay ? lastDay : addMonths(lastDayOfMonth(lastDay), -1);
    return lastDayOfMonth(addMonths(firstOfMonth(lastEndingMonth), -value));
  }
  throw new Error(`Unknown notice period unit: ${unit}`);
}

/**
 * Every date the record holds or implies, earliest first, with what it means.
 * Each entry is `{ kind, date, deadline, provisional, basis }`:
 *
 * - `deadline`: the user has to act by this date (give notice, or switch or
 *   negotiate before the price changes or the contract renews). A renewal is
 *   a deadline itself only when no cancellation or notice deadline comes
 *   before it.
 * - `provisional`: the date is an assumption that needs checking, such as a
 *   renewal whose notice period is unknown (the real deadline may be earlier)
 *   or a notice deadline worked out from an unverified notice period.
 * - `basis`: why the date is what it is, such as "30 days' notice".
 *
 * "none" and unknown dates add nothing.
 */
export function contractKeyDates(record) {
  const entries = [];
  const add = (kind, date, extra = {}) => {
    if (isIsoDate(date)) entries.push({ kind, date, deadline: true, provisional: false, basis: null, ...extra });
  };

  add("discount_end", record.discountEndDate);
  add("price_guarantee_end", record.priceGuaranteeEndDate);
  add("binding_end", record.bindingEndDate);
  add("cancellation_deadline", record.cancellationDeadline);

  if (isIsoDate(record.renewalDate)) {
    const renews = record.autoRenewal !== "no";
    const explicit = isIsoDate(record.cancellationDeadline) && record.cancellationDeadline <= record.renewalDate;
    const notice = renews && !explicit && record.noticePeriod ? record.noticePeriod : null;
    if (notice) {
      add("notice_deadline", noticeDeadline(record.renewalDate, notice), {
        provisional: notice.verified !== true,
        basis: describeNoticePeriod(notice),
      });
    }
    const unknownNotice = renews && !explicit && !notice;
    add("renewal", record.renewalDate, {
      deadline: !renews || unknownNotice,
      provisional: unknownNotice,
      basis: unknownNotice ? "notice period unknown" : null,
    });
  }

  return entries.sort((left, right) => left.date.localeCompare(right.date) || KEY_DATE_KINDS.indexOf(left.kind) - KEY_DATE_KINDS.indexOf(right.kind));
}

/** The earliest deadline on or after `today`, or null. */
export function earliestActionDeadline(record, { today }) {
  return contractKeyDates(record).find((entry) => entry.deadline && entry.date >= today) ?? null;
}

/** The first key date on or after `today`, deadline or not, or null. */
export function nextKeyDate(record, { today }) {
  return contractKeyDates(record).find((entry) => entry.date >= today) ?? null;
}

/** "30 days' notice", "1 month's notice", "2 calendar months' notice". */
export function describeNoticePeriod(noticePeriod) {
  if (!noticePeriod) return null;
  const length = describeNoticeLength(noticePeriod);
  return `${length}${noticePeriod.value === 1 ? "'s" : "'"} notice`;
}

/** "30 days", "1 month", "2 calendar months". */
export function describeNoticeLength({ value, unit }) {
  const noun = { days: "day", months: "month", calendar_months: "calendar month" }[unit];
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

/** "1 Mar 2027", or "1 Mar" in the year `today` falls in. */
export function formatContractDate(date, { today } = {}) {
  const [year, month, day] = parts(date);
  const sameYear = today && Number(today.slice(0, 4)) === year;
  return `${day} ${MONTHS[month - 1]}${sameYear ? "" : ` ${year}`}`;
}

function firstOfMonth(date) {
  const [year, month] = parts(date);
  return isoFrom(year, month, 1);
}

function parts(date) {
  if (!isIsoDate(date)) throw new Error(`Not a calendar date: ${date}`);
  return date.split("-").map(Number);
}

function toUtcMs(date) {
  const [year, month, day] = parts(date);
  return Date.UTC(year, month - 1, day);
}

function isoFrom(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
