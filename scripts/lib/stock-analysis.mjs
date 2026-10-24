/**
 * Analysis of one stock event: what a bounded research turn submits, checked
 * strictly, and what is worked out from it.
 *
 * The research turn reads the official release and its documents and submits
 * structured findings: importance, the report's figures with their periods
 * and where each was read, guidance, deadlines, and, only when the user has
 * one, what the event means for their own thesis. This module refuses
 * anything it cannot trace or check:
 *
 * - every figure names its unit, scale and currency, its period, whether it
 *   is reported or adjusted, and the official page and place it came from,
 *   which must be one of the pages the brief listed;
 * - every figure, every number in quoted guidance and every deadline must
 *   appear on its cited page as the helper itself read it, and a positive
 *   figure the page shows only as negative is refused; a PDF or a page the
 *   helper can't read yields no figures, only words and a stated limitation;
 * - comparisons are worked out here, never taken from the model: a change in
 *   percentage points for margins and other percentages, a percent change for
 *   amounts, and no percent at all across a change of sign;
 * - a report's figures are for the report's own period (the quarter, or the
 *   year to date), and a prior figure is called like for like only for the
 *   same period a year earlier;
 * - free text carries no numbers (they belong in figures), no links, no
 *   instructions, no buy, sell or hold advice, no price forecasts, and no
 *   claims about consensus, which Hilla has no source for;
 * - a thesis impact is given only when the user stated a thesis, and an
 *   unreadable report yields no figures.
 *
 * Nothing here calls a model or trades. Reading pages is the caller's job.
 */
import { CURRENCIES } from "./stock-identity.mjs";
import { canonicalUrl, decodeEntities, monthRange } from "./stock-events.mjs";

export const IMPORTANCE_LEVELS = Object.freeze(["critical", "important", "informational", "noise"]);
export const THESIS_OUTCOMES = Object.freeze(["supports", "weakens", "mixed", "no_meaningful_change", "insufficient_evidence"]);
export const GUIDANCE_STATUSES = Object.freeze(["maintained", "raised", "lowered", "introduced", "withdrawn", "none_given", "unclear"]);
export const METRIC_UNITS = Object.freeze(["currency", "percent", "ratio", "count", "per_share"]);
export const METRIC_BASES = Object.freeze(["reported", "adjusted", "organic", "other"]);
export const SCALES = Object.freeze({ units: 1, thousands: 1e3, millions: 1e6, billions: 1e9 });
export const LIMITS = Object.freeze({ metrics: 12, keyPoints: 4, review: 3, limitations: 4, deadlines: 4, sourcesRead: 6 });

/** Hosts whose pages the helper can never read (GlobeNewswire refuses robots), so figures from them can't be checked. */
export const UNREADABLE_HOSTS = Object.freeze(["globenewswire.com", "www.globenewswire.com"]);

// --- Free text ----------------------------------------------------------------------

const CONTROL = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}]/gu;
const LINK = /https?:\/\/|\bwww\./i;
const INSTRUCTIONS =
  /\b(?:ignore|disregard|override|forget)\b[^.]{0,40}\b(?:instructions?|rules|prompts?|guidelines|orders|above|previous)\b|\bsystem prompt\b|\bdeveloper (?:message|mode)\b|\byou are now\b|\b(?:run|execute|exec)\b[^.]{0,30}\b(?:commands?|scripts?|shell|terminal|code)\b|\bapi[ _-]?keys?\b|\bsudo\b|\brm -rf\b|\bcurl\b|\bnpm run\b|\bopenclaw\b|\b(?:assistant|system|user)\s*:/i;
// Advice to trade, and claims about where the price will go: never Hilla's to give.
const ADVICE =
  /\b(?:you should|we recommend|i recommend|recommend(?:ed|s)?(?: to)?|consider|time to|good time to|now is the time to)\b[^.]{0,30}\b(?:buy(?:ing)?|sell(?:ing)?|add(?:ing)? to|reduc(?:e|ing)|trim(?:ming)?|exit(?:ing)?|hold(?:ing)?|accumulat(?:e|ing)|short(?:ing)?)\b|^(?:buy|sell|hold|accumulate)\b|\b(?:price target|target price|kursmål|riktkurs|tavoitehinta|buying opportunity|selling opportunity|köpläge|ostopaikka|myyntipaikka|undervalued|overvalued|undervärderad|övervärderad|aliarvostettu|yliarvostettu)\b|\b(?:stock|share price|shares|the price|aktien|kursen|osake|kurssi)\b[^.]{0,30}\b(?:will|should|is likely to|is set to|is going to|kommer att|tulee)\s+(?:rise|fall|climb|drop|rally|soar|plunge|go up|go down|recover|outperform|underperform|stiga|falla|nousta|laskea)\b/i;
// Orders, money transfers and BankID: what external text might try to make Hilla do.
const TRADING = /\b(?:place|execute|submit|send)\w*\b[^.]{0,20}\borders?\b|\b(?:market|limit|stop) orders?\b|\btransfer\w*\b[^.]{0,20}\b(?:money|funds|cash|shares)\b|\bbankid\b/i;
// Hilla has no source for market consensus, so analysis never claims one.
const CONSENSUS =
  /\b(?:consensus|konsensus|analysts?['’]? (?:expectations?|estimates?|forecasts?)|market expectations?|(?:beat|beats|missed|misses|above|below|ahead of|short of|in line with|exceeded|fell short of) (?:the )?(?:market['’]?s? )?(?:consensus|expectations?|estimates?|forecasts?)|förväntningar|odotukset)\b/i;
// Years, period labels and product names such as 5G or XC90 are not figures; any other number belongs in a figure.
const NOT_FIGURES = /\b(?:19|20)\d{2}(?:\/\d{2,4})?\b|\b[QqHh][1-4]\b|\b(?:3|6|9|12)M\b|\p{L}-?\d+|\b\d[GD]\b/gu;

/** One line of analysis text, or a problem. The problem never repeats the text. */
export function checkAnalysisText(value, { max, numbers = false }) {
  if (typeof value !== "string") return { problem: "must be text" };
  const text = value.normalize("NFC").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (!text) return { problem: "is empty" };
  if (text.length > max) return { problem: `is longer than ${max} characters` };
  if (LINK.test(text)) return { problem: "has a link; sources go in source fields" };
  if (INSTRUCTIONS.test(text)) return { problem: "reads like instructions, not analysis" };
  if (TRADING.test(text)) return { problem: "reads like an order to trade or move money, which Hilla never does" };
  if (ADVICE.test(text)) return { problem: "gives trading advice or a price forecast; say what to read, verify or decide instead" };
  if (CONSENSUS.test(text)) return { problem: "claims market expectations or consensus, which no checked source gives" };
  if (!numbers && /\d/.test(text.replace(NOT_FIGURES, " "))) return { problem: "has a number; numbers go in metrics or deadlines, with their source" };
  return { value: text };
}

function checkTextList(raw, { field, max, itemMax, numbers = false }) {
  if (raw === undefined) return { value: [] };
  if (!Array.isArray(raw) || raw.length > max) return { problem: `${field}: must be a list of at most ${max} short items` };
  const items = [];
  for (const [index, item] of raw.entries()) {
    const text = checkAnalysisText(item, { max: itemMax, numbers });
    if (text.problem) return { problem: `${field}[${index}]: ${text.problem}` };
    items.push(text.value);
  }
  return { value: items };
}

// --- Periods -------------------------------------------------------------------------------

const MONTH_DAY_NAMES = {
  jan: 1, january: 1, januari: 1, tammikuuta: 1,
  feb: 2, february: 2, februari: 2, helmikuuta: 2,
  mar: 3, march: 3, mars: 3, maaliskuuta: 3,
  apr: 4, april: 4, huhtikuuta: 4,
  may: 5, maj: 5, toukokuuta: 5,
  jun: 6, june: 6, juni: 6, kesäkuuta: 6,
  jul: 7, july: 7, juli: 7, heinäkuuta: 7,
  aug: 8, august: 8, augusti: 8, elokuuta: 8,
  sep: 9, sept: 9, september: 9, syyskuuta: 9,
  oct: 10, october: 10, okt: 10, oktober: 10, lokakuuta: 10,
  nov: 11, november: 11, marraskuuta: 11,
  dec: 12, december: 12, joulukuuta: 12,
};

/** "30 Sep 2026", "September 30, 2026", "2026-09-30", "30.9.2026" → { month, day, year }, or null. */
function pointInTime(text) {
  const lower = text.toLowerCase();
  let match = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(lower);
  if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  match = /(?<!\d)(\d{1,2})\.(\d{1,2})\.(20\d{2})(?!\d)/.exec(lower);
  if (match) return { year: Number(match[3]), month: Number(match[2]), day: Number(match[1]) };
  match = /(?<![\p{L}\d])(\d{1,2})\.?\s+(\p{L}{3,12})\.?\s+(20\d{2})(?!\d)/u.exec(lower);
  if (match && MONTH_DAY_NAMES[match[2]]) return { year: Number(match[3]), month: MONTH_DAY_NAMES[match[2]], day: Number(match[1]) };
  match = /(?<!\p{L})(\p{L}{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})(?!\d)/u.exec(lower);
  if (match && MONTH_DAY_NAMES[match[1]]) return { year: Number(match[3]), month: MONTH_DAY_NAMES[match[1]], day: Number(match[2]) };
  return null;
}

/** A month range as a period: January–September is nine months, July–September a quarter. */
function periodFromMonths(from, to, year) {
  if (from === 1 && to === 3) return { type: "Q", n: 1, year };
  if (from === 1 && to === 6) return { type: "H", n: 1, year };
  if (from === 1 && to === 9) return { type: "9M", n: 0, year };
  if (from === 1 && to === 12) return { type: "FY", n: 0, year };
  if (from === 7 && to === 12) return { type: "H", n: 2, year };
  if (to - from === 2 && to % 3 === 0) return { type: "Q", n: to / 3, year };
  return null;
}

/**
 * "Q3 2026", "2026 Q3", "H1 2026", "9M 2026", "FY 2025/26", "2025",
 * "January–September 2026", "7–9/2026" or a balance-sheet date such as
 * "30 Sep 2026" → { type: Q | H | 9M | FY | D, n, year, month?, day? }; null
 * when the label is not a period these rules know.
 */
export function parsePeriod(label) {
  const text = String(label ?? "").trim();
  const date = pointInTime(text);
  if (date) return { type: "D", n: 0, year: date.year, month: date.month, day: date.day };
  const slashed = /(?<!\d)(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*\/\s*(20\d{2})(?!\d)/.exec(text);
  if (slashed) return periodFromMonths(Number(slashed[1]), Number(slashed[2]), Number(slashed[3]));
  const year = (() => {
    const split = /\b(20\d{2})\s*\/\s*(\d{2,4})\b/.exec(text);
    if (split) return split[2].length === 2 ? Number(`20${split[2]}`) : Number(split[2]);
    const plain = /\b(20\d{2})\b/.exec(text);
    return plain ? Number(plain[1]) : null;
  })();
  if (!year) return null;
  const quarter = /\bQ([1-4])\b/i.exec(text);
  if (quarter) return { type: "Q", n: Number(quarter[1]), year };
  const half = /\bH([12])\b/i.exec(text);
  if (half) return { type: "H", n: Number(half[1]), year };
  if (/\b9M\b|\bnine months\b/i.test(text)) return { type: "9M", n: 0, year };
  if (/\b6M\b|\bsix months\b/i.test(text)) return { type: "H", n: 1, year };
  const months = monthRange(text);
  if (months) return periodFromMonths(months.from, months.to, year);
  if (/^(?:FY\s*)?20\d{2}(?:\s*\/\s*\d{2,4})?$/i.test(text) || /\b(?:FY|full[- ]year|financial year|fiscal year|helår|räkenskapsår|tilikausi)\b/i.test(text)) return { type: "FY", n: 0, year };
  return null;
}

/** Whether two periods are the same period a year apart, the only comparison called like for like. */
export function periodsComparable(current, prior) {
  const now = parsePeriod(current);
  const before = parsePeriod(prior);
  if (!now || !before) return { comparable: false, reason: "the periods could not be read" };
  if (now.type !== before.type) return { comparable: false, reason: "different kinds of period" };
  if (now.n !== before.n) return { comparable: false, reason: "not the same period a year earlier" };
  if (now.type === "D" && (now.month !== before.month || now.day !== before.day)) return { comparable: false, reason: "not the same date a year earlier" };
  if (now.year - before.year !== 1) return { comparable: false, reason: "not the same period a year earlier" };
  return { comparable: true, reason: null };
}

/**
 * Whether a figure's period belongs to the report: its quarter, the year to
 * date that ends with it, or a balance-sheet date of the report's year. A
 * report of unknown period accepts any period.
 */
export function periodMatchesReport(label, report) {
  if (!report?.period || !report.fiscalYear) return true;
  const period = parsePeriod(label);
  if (!period) return false;
  if (period.type === "D") return period.year === report.fiscalYear || period.year === report.fiscalYear - 1;
  if (period.year !== report.fiscalYear) return false;
  const quarter = { Q1: 1, Q2: 2, H1: 2, Q3: 3, Q4: 4, FY: 4 }[report.period];
  if (period.type === "Q") return period.n === quarter;
  if (period.type === "H") return (period.n === 1 && quarter === 2) || (period.n === 2 && quarter === 4);
  if (period.type === "9M") return quarter === 3;
  if (period.type === "FY") return quarter === 4;
  return false;
}

// --- Pages ---------------------------------------------------------------------------------

/** A page's readable text: no scripts, styles or tags, entities decoded. */
export function pageText(html) {
  return decodeEntities(
    String(html ?? "")
      .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const numberKey = (value) => String(Math.round(Math.abs(value) * 1e6));

function readNumber(part) {
  const text = part.replace(/[.,]+$/, "");
  if (!/\d/.test(text)) return [];
  const commas = (text.match(/,/g) ?? []).length;
  const dots = (text.match(/\./g) ?? []).length;
  if (commas > 0 && dots > 0) {
    const decimal = text.lastIndexOf(",") > text.lastIndexOf(".") ? "," : ".";
    const other = decimal === "," ? /\./g : /,/g;
    return [Number(text.replace(other, "").replace(decimal, "."))];
  }
  const separator = commas > 0 ? "," : dots > 0 ? "." : null;
  if (!separator) return [Number(text)];
  const count = separator === "," ? commas : dots;
  if (count > 1) return [Number(text.replaceAll(separator, ""))];
  const after = text.length - text.indexOf(separator) - 1;
  const asDecimal = Number(text.replace(separator, "."));
  // "1,234" or "1.234" is a thousand and some, or one and a fraction: both readings are kept.
  return after === 3 ? [Number(text.replace(separator, "")), asDecimal] : [asDecimal];
}

/**
 * Every number a page shows, keyed by magnitude, with the signs it appears
 * with: "1 234,5", "1,234.5", "12.0%" and "−56" all count. Separators that
 * could mean either are read both ways.
 */
export function pageNumbers(text) {
  const numbers = new Map();
  const note = (value, negative) => {
    if (!Number.isFinite(value)) return;
    const entry = numbers.get(numberKey(value)) ?? { positive: false, negative: false };
    if (negative) entry.negative = true;
    else entry.positive = true;
    numbers.set(numberKey(value), entry);
  };
  for (const match of String(text ?? "").matchAll(/(^|[\s(:;/])?([-−–])?(\d(?:[\d.,]|\s(?=\d{3}(?!\d)))*)/g)) {
    const negative = Boolean(match[2]) && match[1] !== undefined;
    const parts = match[3].trim().split(/\s+/);
    for (const value of readNumber(parts.join(""))) note(value, negative);
    if (parts.length > 1) parts.forEach((part, index) => readNumber(part).forEach((value) => note(value, negative && index === 0)));
  }
  return numbers;
}

/** Whether a figure appears on a page: found, and whether the page shows it only as negative. */
export function numberOnPage(value, numbers) {
  const entry = numbers.get(numberKey(value));
  if (!entry) return { found: false, signConflict: false };
  return { found: true, signConflict: value > 0 && entry.negative && !entry.positive };
}

const DATE_MONTHS = {
  en: ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"],
  sv: ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"],
  fi: ["tammikuuta", "helmikuuta", "maaliskuuta", "huhtikuuta", "toukokuuta", "kesäkuuta", "heinäkuuta", "elokuuta", "syyskuuta", "lokakuuta", "marraskuuta", "joulukuuta"],
};

/** Whether a page states a date (YYYY-MM-DD) in one of the ways English, Swedish and Finnish releases write it. */
export function dateOnPage(date, text) {
  const [year, month, day] = date.split("-").map(Number);
  const page = ` ${String(text ?? "").toLowerCase()} `;
  const names = [...new Set(Object.values(DATE_MONTHS).map((list) => list[month - 1]))];
  const forms = [
    date,
    `${day}.${month}.${year}`,
    `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`,
    ...names.flatMap((name) => [` ${day} ${name}`, ` ${day}. ${name}`, `${name} ${day},`, `${name} ${day} `, `${name.slice(0, 3)} ${day},`, ` ${day} ${name.slice(0, 3)} `]),
  ];
  return forms.some((form) => page.includes(form));
}

// --- Figures --------------------------------------------------------------------------------

function hostOf(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "https:" ? parsed.host : null;
  } catch {
    return null;
  }
}

const isOfficial = (item) => item?.evidence === "official_disclosure" || item?.evidence === "company_release";

/** A link as it is compared: https only, canonical (no tracking, fragment or trailing slash). */
export const sourceKey = (url) => (hostOf(url) ? canonicalUrl(url) : null);

/**
 * The pages an analysis may read and cite: exactly the official pages and
 * documents of the event, and of related releases such as the previous
 * report, that the brief lists. News and talk about them never count.
 */
export function analysisSources(event, related = []) {
  const urls = [];
  for (const item of [event, ...related]) {
    if (!isOfficial(item)) continue;
    for (const source of item.sources ?? []) {
      if (source.role === "coverage") continue;
      for (const link of [source.url, ...(source.documents ?? [])]) {
        if (hostOf(link) && !urls.some((url) => sourceKey(url) === sourceKey(link))) urls.push(link);
      }
    }
  }
  return urls.map((url) => ({ url, checkable: !UNREADABLE_HOSTS.includes(hostOf(url)) && !/\.pdf(?:$|[?#])/i.test(url) }));
}

function checkSource(raw, { field, allowedUrls }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problem: `${field}: must be {url, location}` };
  if (!allowedUrls.includes(sourceKey(raw.url))) return { problem: `${field}.url: must be one of the official pages or documents the brief lists` };
  const location = typeof raw.location === "string" ? raw.location.normalize("NFC").replace(CONTROL, " ").replace(/\s+/g, " ").trim() : "";
  if (!location || location.length > 80 || LINK.test(location) || INSTRUCTIONS.test(location)) return { problem: `${field}.location: say where in it, such as "page 3, income statement" (at most 80 characters)` };
  return { value: { url: String(raw.url), location } };
}

function checkPoint(raw, field) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problem: `${field}: must be {period, value}` };
  const period = typeof raw.period === "string" ? raw.period.trim() : "";
  if (!period || period.length > 40 || /[<>`|\\]/.test(period) || !parsePeriod(period)) return { problem: `${field}.period: must name the period, such as "Q3 2026", "January–September 2026" or "30 Sep 2026"` };
  if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) return { problem: `${field}.value: must be a number as the source states it` };
  return { value: { period, value: raw.value } };
}

/** One reported figure, checked. Returns { value } or { problem }. */
export function normalizeMetric(raw, { allowedUrls, readUrls, report = null }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problem: "must be an object" };
  const allowed = ["id", "name", "unit", "basis", "currency", "scale", "current", "prior", "source"];
  const extra = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (extra.length > 0) return { problem: `unknown keys ${extra.join(", ")} (allowed: ${allowed.join(", ")})` };
  if (typeof raw.id !== "string" || !/^[a-z][a-z0-9_]{1,39}$/.test(raw.id)) return { problem: "id: a short snake_case name such as operating_margin" };
  const name = checkAnalysisText(raw.name, { max: 60 });
  if (name.problem) return { problem: `name: ${name.problem}` };
  if (!METRIC_UNITS.includes(raw.unit)) return { problem: `unit: must be ${METRIC_UNITS.join(", ")}` };
  if (!METRIC_BASES.includes(raw.basis)) return { problem: `basis: must be ${METRIC_BASES.join(", ")}; say adjusted whenever the source does` };
  const needsCurrency = raw.unit === "currency" || raw.unit === "per_share";
  if (needsCurrency && !CURRENCIES.includes(raw.currency)) return { problem: `currency: must be ${CURRENCIES.join(", ")} for amounts` };
  if (!needsCurrency && raw.currency !== undefined && raw.currency !== null) return { problem: "currency: only amounts have a currency" };
  const needsScale = raw.unit === "currency" || raw.unit === "count";
  if (needsScale && !SCALES[raw.scale]) return { problem: `scale: must be ${Object.keys(SCALES).join(", ")}, as the source's table states it` };
  if (!needsScale && raw.scale !== undefined && raw.scale !== null) return { problem: "scale: only amounts and counts have a scale" };
  const current = checkPoint(raw.current, "current");
  if (current.problem) return current;
  if (!periodMatchesReport(current.value.period, report)) return { problem: `current.period: must be the report's own period (${report.period} ${report.fiscalYear}, or the year to date ending with it)` };
  const prior = raw.prior === undefined || raw.prior === null ? { value: null } : checkPoint(raw.prior, "prior");
  if (prior.problem) return prior;
  if (raw.unit === "percent" || raw.unit === "ratio") {
    for (const point of [current.value, prior.value].filter(Boolean)) {
      if (Math.abs(point.value) > 1000) return { problem: `${raw.unit} values above 1000 are not plausible; check the unit` };
    }
  }
  const source = checkSource(raw.source, { field: "source", allowedUrls });
  if (source.problem) return source;
  if (!readUrls.includes(sourceKey(source.value.url))) return { problem: "source.url: must be one of the sources you list as read" };
  return {
    value: {
      id: raw.id,
      name: name.value,
      unit: raw.unit,
      basis: raw.basis,
      currency: needsCurrency ? raw.currency : null,
      scale: needsScale ? raw.scale : null,
      current: current.value,
      prior: prior.value,
      source: source.value,
    },
  };
}

const UNCHECKABLE =
  "the helper couldn't read the cited page (a PDF, or a site that refuses automated reading), so nothing from it can be checked: cite a release page that shows it, or leave it out and say in limitations which figures are only in the report document";

/** The page the helper read for a cited link, or null when it couldn't read it. */
function readPage(pages, url) {
  const page = pages?.get(sourceKey(url));
  return page?.status === "ok" ? page : null;
}

/**
 * Checks a figure against the page it cites, as the helper read it: both
 * values must appear on it, and a positive value the page shows only as
 * negative is refused. A page the helper couldn't read checks nothing, so
 * its figure is refused.
 */
export function checkMetricOnPage(metric, pages) {
  const page = readPage(pages, metric.source.url);
  if (!page) return { problem: `source: ${UNCHECKABLE}` };
  for (const [label, point] of [["current", metric.current], ["prior", metric.prior]]) {
    if (!point) continue;
    const found = numberOnPage(point.value, page.numbers);
    if (!found.found) return { problem: `${label}.value: ${point.value} does not appear on the cited page; give it exactly as that page writes it (same scale, such as 1234.5 for "1 234,5"), cite the page that shows it, or leave the figure out` };
    if (found.signConflict) return { problem: `${label}.value: the page shows ${point.value} only as negative; check the sign` };
  }
  return { problem: null };
}

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * The change a figure shows, worked out here: percentage points for
 * percentages, a percent change for amounts with a positive prior, and no
 * percent when the prior is zero or negative or the sign changes.
 */
export function compareMetric(metric) {
  if (!metric.prior) return { kind: "none", comparable: false, reason: "no prior figure" };
  const { comparable, reason } = periodsComparable(metric.current.period, metric.prior.period);
  const now = metric.current.value;
  const before = metric.prior.value;
  if (metric.unit === "percent") return { kind: "points", change: round(now - before, 1), comparable, reason };
  if (before > 0 && now >= 0) return { kind: "percent", change: round(((now - before) / before) * 100, 1), comparable, reason };
  return { kind: "direction", change: null, from: before, to: now, comparable, reason: reason ?? (before === 0 ? "the prior figure is zero" : "the figure changed sign or was negative") };
}

/** The importance a research turn may give: at most one step from the first sorting, and never critical for news or talk. */
export function refineLevel(triaged, proposed, { official }) {
  const order = IMPORTANCE_LEVELS;
  const from = order.indexOf(triaged);
  const to = order.indexOf(proposed);
  if (from < 0 || to < 0) return triaged;
  const level = order[Math.max(from - 1, Math.min(from + 1, to))];
  return level === "critical" && !official ? "important" : level;
}

// --- The submission ---------------------------------------------------------------------------

/**
 * Checks one analysis submission for an event. `context`: { event, record,
 * sources, pages }: `sources` are the pages the brief listed (from
 * analysisSources), and `pages` maps a cited link's sourceKey to what the
 * helper read there ({status: "ok", text, numbers}, or another status when
 * it couldn't). Returns { ok, analysis } or { ok: false, problems }.
 */
export function validateAnalysis(input, { event, record, sources, pages = new Map() }) {
  const allowedUrls = sources.map((source) => sourceKey(source.url));
  const problems = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, problems: ["the analysis must be a JSON object"] };
  const allowed = ["request", "eventId", "importance", "sourcesRead", "metrics", "guidance", "keyPoints", "thesisImpact", "review", "deadlines", "eligibility", "limitations"];
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length > 0) problems.push(`${extra.join(", ")}: unknown keys (allowed: ${allowed.join(", ")})`);

  let importance = null;
  if (!input.importance || typeof input.importance !== "object") problems.push("importance: must be {level, reason}");
  else {
    if (!IMPORTANCE_LEVELS.includes(input.importance.level)) problems.push(`importance.level: must be ${IMPORTANCE_LEVELS.join(", ")}`);
    else if (input.importance.level === "critical" && !isOfficial(event)) problems.push("importance.level: only an official release can be critical");
    const reason = checkAnalysisText(input.importance.reason, { max: 200 });
    if (reason.problem) problems.push(`importance.reason: ${reason.problem}`);
    else if (IMPORTANCE_LEVELS.includes(input.importance.level)) importance = { level: input.importance.level, reason: reason.value };
  }

  const sourcesRead = [];
  if (!Array.isArray(input.sourcesRead) || input.sourcesRead.length === 0 || input.sourcesRead.length > LIMITS.sourcesRead) {
    problems.push(`sourcesRead: list the official pages and documents you opened, at most ${LIMITS.sourcesRead}, each {url, read}`);
  } else {
    for (const [index, entry] of input.sourcesRead.entries()) {
      if (!allowedUrls.includes(sourceKey(entry?.url))) problems.push(`sourcesRead[${index}].url: must be one of the official pages or documents the brief lists`);
      else if (typeof entry.read !== "boolean") problems.push(`sourcesRead[${index}].read: true when you could read it, false when you couldn't`);
      else sourcesRead.push({ url: String(entry.url), read: entry.read });
    }
  }
  const readUrls = sourcesRead.filter((entry) => entry.read).map((entry) => sourceKey(entry.url));
  const report = event.type === "report" ? event.report : null;

  const metrics = [];
  if (input.metrics !== undefined) {
    if (!Array.isArray(input.metrics) || input.metrics.length > LIMITS.metrics) problems.push(`metrics: at most ${LIMITS.metrics}`);
    else {
      const ids = new Set();
      for (const [index, raw] of input.metrics.entries()) {
        const metric = normalizeMetric(raw, { allowedUrls, readUrls, report });
        if (metric.problem) {
          problems.push(`metrics[${index}].${metric.problem}`);
          continue;
        }
        if (ids.has(metric.value.id)) {
          problems.push(`metrics[${index}].id: used twice; one figure per metric, from the source you trust for it`);
          continue;
        }
        const checked = checkMetricOnPage(metric.value, pages);
        if (checked.problem) {
          problems.push(`metrics[${index}].${checked.problem}`);
          continue;
        }
        ids.add(metric.value.id);
        metrics.push(metric.value);
      }
    }
  }
  if (Array.isArray(input.metrics) && input.metrics.length > 0 && readUrls.length === 0) problems.push("metrics: no source was read, so there can be no figures; say the release couldn't be read in limitations");

  let guidance = null;
  if (input.guidance !== undefined && input.guidance !== null) {
    const raw = input.guidance;
    if (!GUIDANCE_STATUSES.includes(raw?.status)) problems.push(`guidance.status: must be ${GUIDANCE_STATUSES.join(", ")}`);
    else {
      const text = raw.text === undefined || raw.text === null ? { value: null } : checkAnalysisText(raw.text, { max: 240, numbers: true });
      const source = raw.status === "none_given" ? { value: null } : checkSource(raw.source, { field: "guidance.source", allowedUrls });
      if (text.problem) problems.push(`guidance.text: ${text.problem}`);
      if (source.problem) problems.push(source.problem);
      if (!text.problem && !source.problem) {
        // Numbers in quoted guidance must be on the page it cites, like any figure.
        const numbers = numbersIn(text.value ?? "");
        const page = source.value ? readPage(pages, source.value.url) : null;
        const missing = page ? numbers.filter((value) => !numberOnPage(value, page.numbers).found) : [];
        if (numbers.length > 0 && !page) problems.push(`guidance.text: ${UNCHECKABLE.replace("which figures are only in the report document", "that the outlook's numbers couldn't be checked")}; or describe the outlook without numbers`);
        else if (missing.length > 0) problems.push(`guidance.text: ${missing.join(", ")} not on the cited page; quote the guidance as the page states it`);
        else guidance = { status: raw.status, text: text.value, source: source.value };
      }
    }
  }

  const keyPoints = checkTextList(input.keyPoints, { field: "keyPoints", max: LIMITS.keyPoints, itemMax: 200 });
  if (keyPoints.problem) problems.push(keyPoints.problem);
  const review = checkTextList(input.review, { field: "review", max: LIMITS.review, itemMax: 160 });
  if (review.problem) problems.push(review.problem);
  const limitations = checkTextList(input.limitations, { field: "limitations", max: LIMITS.limitations, itemMax: 200 });
  if (limitations.problem) problems.push(limitations.problem);
  if (sourcesRead.length > 0 && readUrls.length === 0 && (limitations.value ?? []).length === 0) problems.push("limitations: say that the release or report could not be read");
  // Words from a page the helper can't check (a PDF, GlobeNewswire) come with a stated limitation.
  const uncheckable = new Set(sources.filter((source) => !source.checkable).map((source) => sourceKey(source.url)));
  const unchecked = readUrls.some((url) => uncheckable.has(url)) || Boolean(guidance?.source && !readPage(pages, guidance.source.url));
  if (unchecked && readUrls.length > 0 && (limitations.value ?? []).length === 0) problems.push("limitations: you used a page the helper can't check (a PDF, or a site that refuses automated reading); say which facts come from it and couldn't be checked");

  // The thesis is the user's: impact only when they stated one, never invented.
  let thesisImpact = null;
  if (record.thesis) {
    const raw = input.thesisImpact;
    if (!raw || typeof raw !== "object") problems.push("thesisImpact: the user has a thesis, so give {outcome, reason, metricIds}");
    else if (!THESIS_OUTCOMES.includes(raw.outcome)) problems.push(`thesisImpact.outcome: must be ${THESIS_OUTCOMES.join(", ")}`);
    else {
      const reason = checkAnalysisText(raw.reason, { max: 300 });
      const metricIds = Array.isArray(raw.metricIds) ? raw.metricIds.filter((id) => typeof id === "string") : [];
      if (reason.problem) problems.push(`thesisImpact.reason: ${reason.problem}`);
      else if (metricIds.some((id) => !metrics.some((metric) => metric.id === id))) problems.push("thesisImpact.metricIds: must name figures in metrics");
      else if (["supports", "weakens", "mixed"].includes(raw.outcome) && metricIds.length === 0 && !guidance) problems.push("thesisImpact: a supported, weakened or mixed thesis needs the figures or guidance it rests on; otherwise say insufficient_evidence");
      else thesisImpact = { outcome: raw.outcome, reason: reason.value, metricIds };
    }
  } else if (input.thesisImpact !== undefined && input.thesisImpact !== null) {
    problems.push("thesisImpact: the user has no thesis for this stock; leave it out rather than assume one");
  }

  const deadlines = [];
  if (input.deadlines !== undefined) {
    if (!Array.isArray(input.deadlines) || input.deadlines.length > LIMITS.deadlines) problems.push(`deadlines: at most ${LIMITS.deadlines}`);
    else {
      for (const [index, raw] of input.deadlines.entries()) {
        const label = checkAnalysisText(raw?.label, { max: 80 });
        const date = typeof raw?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) && Number.isFinite(Date.parse(`${raw.date}T00:00:00Z`)) ? raw.date : null;
        const source = checkSource(raw?.source, { field: `deadlines[${index}].source`, allowedUrls });
        if (label.problem) problems.push(`deadlines[${index}].label: ${label.problem}`);
        else if (!date) problems.push(`deadlines[${index}].date: must be YYYY-MM-DD as the release states it`);
        else if (source.problem) problems.push(source.problem);
        else if (!readPage(pages, source.value.url)) problems.push(`deadlines[${index}].source: the helper couldn't read the cited page, so its date can't be checked; cite a release page that states it, or leave the deadline out and point to the official release`);
        else if (!dateOnPage(date, readPage(pages, source.value.url).text)) problems.push(`deadlines[${index}].date: not stated on the cited page; give only dates the release itself gives`);
        else deadlines.push({ label: label.value, date, source: source.value });
      }
    }
  }
  let eligibility = null;
  if (input.eligibility !== undefined && input.eligibility !== null) {
    const text = checkAnalysisText(input.eligibility, { max: 240 });
    if (text.problem) problems.push(`eligibility: ${text.problem}`);
    else eligibility = text.value;
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    analysis: {
      importance,
      sourcesRead,
      metrics: metrics.map((metric) => ({ ...metric, comparison: compareMetric(metric) })),
      guidance,
      keyPoints: keyPoints.value,
      thesisImpact,
      review: review.value,
      deadlines,
      eligibility,
      limitations: limitations.value,
    },
  };
}

/** The numbers in a line of text, such as guidance: "growth of 5–7 percent" → [5, 7]. Years and period labels are left out. */
export function numbersIn(text) {
  const values = [];
  for (const match of String(text).replace(NOT_FIGURES, " ").matchAll(/\d+(?:[.,]\d+)?/g)) values.push(Number(match[0].replace(",", ".")));
  return values;
}

// --- Text -------------------------------------------------------------------------------------

const SCALE_SUFFIX = { units: "", thousands: "k", millions: "m", billions: "bn" };

/** A number with spaces between thousands, as Swedish and Finnish readers expect, and a true minus sign. */
export function formatNumber(value, { digits } = {}) {
  const decimals = String(Math.abs(value)).split(".")[1]?.length ?? 0;
  const fixed = digits ?? Math.min(3, decimals);
  const [whole, fraction] = Math.abs(value).toFixed(fixed).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${value < 0 ? "−" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

function formatValue(metric, value) {
  if (metric.unit === "percent") return `${formatNumber(value)}%`;
  if (metric.unit === "ratio") return `${formatNumber(value)}x`;
  if (metric.unit === "per_share") return `${metric.currency} ${formatNumber(value)}`;
  if (metric.unit === "count") return `${formatNumber(value)}${SCALE_SUFFIX[metric.scale]}`;
  return `${metric.currency} ${formatNumber(value)}${SCALE_SUFFIX[metric.scale]}`;
}

/** The basis worth saying: adjusted or organic, unless the figure's name already says it. Reported and other add nothing for the reader. */
function basisTag(metric) {
  if (metric.basis !== "adjusted" && metric.basis !== "organic") return "";
  return new RegExp(`\\b${metric.basis}\\b`, "i").test(metric.name) ? "" : ` (${metric.basis})`;
}

/** "Net sales, Q3 2026: SEK 1 234.5m (Q3 2025: SEK 1 100m), +12.2%" or "Operating margin, Q3 2026: 12% (Q3 2025: 16%), −4.0 percentage points". */
export function metricLine(metric) {
  const base = `${metric.name}${basisTag(metric)}, ${metric.current.period}: ${formatValue(metric, metric.current.value)}`;
  if (!metric.prior) return base;
  const prior = ` (${metric.prior.period}: ${formatValue(metric, metric.prior.value)})`;
  const comparison = metric.comparison ?? compareMetric(metric);
  const signed = (change) => `${change > 0 ? "+" : change < 0 ? "−" : "±"}${formatNumber(Math.abs(change), { digits: 1 })}`;
  let change = "";
  if (comparison.kind === "points") change = `, ${signed(comparison.change)} percentage points`;
  else if (comparison.kind === "percent") change = `, ${signed(comparison.change)}%`;
  else if (comparison.kind === "direction") change = comparison.to > comparison.from ? ", up" : comparison.to < comparison.from ? ", down" : ", unchanged";
  const like = comparison.comparable ? "" : ` (${comparison.reason ?? "not like for like"})`;
  return `${base}${prior}${change}${like}`;
}

export const THESIS_TEXT = Object.freeze({
  supports: "Supports it",
  weakens: "Weakens it",
  mixed: "Mixed",
  no_meaningful_change: "No meaningful change",
  insufficient_evidence: "Not enough evidence yet",
});

export const GUIDANCE_TEXT = Object.freeze({
  maintained: "maintained",
  raised: "raised",
  lowered: "lowered",
  introduced: "introduced",
  withdrawn: "withdrawn",
  none_given: "none given",
  unclear: "unclear from the release",
});
