/**
 * Who a listed security is: exchange, ticker, share class, ISIN, currency.
 *
 * A ticker alone never identifies a company. The same letters can mean
 * different companies on different exchanges, and one company can have
 * several share classes (Investor A and B) or listings. A security is
 * therefore always an exchange (its ISO 10383 MIC) plus the ticker on that
 * exchange, with the ISIN when an official source gives it.
 *
 * `matchListings` turns the user's words into candidates from official
 * listings. It never picks one of several plausible securities: a company
 * name with two share classes, or a ticker listed on two exchanges, comes
 * back ambiguous so the user is asked.
 */

/** The exchanges a watched security can be on. `region` decides which official sources can cover it. */
export const EXCHANGES = Object.freeze({
  XSTO: { name: "Nasdaq Stockholm", country: "SE", region: "nordic" },
  // ESMA's FIRDS register lists First North Sweden shares under SSME; FNSE is the older code.
  SSME: { name: "Nasdaq First North Growth Market Sweden", country: "SE", region: "nordic" },
  FNSE: { name: "Nasdaq First North Growth Market Sweden", country: "SE", region: "nordic" },
  XHEL: { name: "Nasdaq Helsinki", country: "FI", region: "nordic" },
  FNFI: { name: "Nasdaq First North Growth Market Finland", country: "FI", region: "nordic" },
  XCSE: { name: "Nasdaq Copenhagen", country: "DK", region: "nordic" },
  XOSL: { name: "Oslo Børs", country: "NO", region: "europe" },
  XNGM: { name: "Nordic Growth Market", country: "SE", region: "europe" },
  XSAT: { name: "Spotlight Stock Market", country: "SE", region: "europe" },
  XETR: { name: "Xetra", country: "DE", region: "europe" },
  XPAR: { name: "Euronext Paris", country: "FR", region: "europe" },
  XAMS: { name: "Euronext Amsterdam", country: "NL", region: "europe" },
  XLON: { name: "London Stock Exchange", country: "GB", region: "europe" },
  XSWX: { name: "SIX Swiss Exchange", country: "CH", region: "europe" },
  XNYS: { name: "New York Stock Exchange", country: "US", region: "us" },
  XNAS: { name: "Nasdaq (US)", country: "US", region: "us" },
  XASE: { name: "NYSE American", country: "US", region: "us" },
});

export const CURRENCIES = Object.freeze(["SEK", "EUR", "NOK", "DKK", "ISK", "USD", "GBP", "GBX", "CHF"]);

const TICKER = /^[A-Z0-9][A-Z0-9 .&-]{0,15}$/;
const SHARE_CLASS = /^(?:[A-Z]|PREF|SDB|ADR|ADS)$/;
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const CIK = /^\d{10}$/;

/** True for a well-formed ISIN whose check digit is right. */
export function isValidIsin(value) {
  if (typeof value !== "string" || !ISIN.test(value)) return false;
  return luhnSum(isinDigits(value)) % 10 === 0;
}

/** The check digit that completes the first 11 characters of an ISIN. */
export function isinCheckDigit(first11) {
  if (typeof first11 !== "string" || !/^[A-Z]{2}[A-Z0-9]{9}$/.test(first11)) throw new Error("An ISIN starts with two letters and nine letters or digits.");
  return String((10 - (luhnSum(`${isinDigits(first11)}0`) % 10)) % 10);
}

function isinDigits(text) {
  return [...text].map((char) => (char >= "A" && char <= "Z" ? String(char.charCodeAt(0) - 55) : char)).join("");
}

function luhnSum(digits) {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum;
}

/** "inve b" → "INVE B", "brk-b" → "BRK-B": upper case, single spaces. Null when it can't be a ticker. */
export function normalizeTicker(value) {
  if (typeof value !== "string") return null;
  const ticker = value.normalize("NFC").trim().toUpperCase().replace(/\s+/g, " ");
  return TICKER.test(ticker) ? ticker : null;
}

/** A SEC Central Index Key, zero-padded to ten digits as EDGAR's URLs need it. */
export function normalizeCik(value) {
  const digits = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,10}$/.test(digits)) return null;
  const padded = digits.padStart(10, "0");
  return CIK.test(padded) && padded !== "0000000000" ? padded : null;
}

/**
 * Checks the identifying fields of one security. Returns `{ value, problems }`;
 * problems name the field, never its value.
 */
export function normalizeSecurity(input) {
  const problems = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { value: null, problems: ["security: must be a JSON object"] };
  const allowed = ["companyName", "ticker", "exchange", "shareClass", "isin", "lei", "currency", "country", "identifiers", "verification"];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) problems.push(`security.${key}: unknown field (allowed: ${allowed.join(", ")})`);

  const companyName = typeof input.companyName === "string" ? input.companyName.normalize("NFC").replace(/[\u{0}-\u{1f}\u{7f}<>`|\\]/gu, " ").replace(/\s+/g, " ").trim() : "";
  if (!companyName || companyName.length > 80 || /https?:|www\.|@/i.test(companyName)) problems.push("security.companyName: must be the company's name, at most 80 characters");
  // ESMA's register has no tickers, so a listing it confirmed by ISIN may come without one.
  const ticker = input.ticker === undefined || input.ticker === null ? null : normalizeTicker(input.ticker);
  if (input.ticker !== undefined && input.ticker !== null && !ticker) problems.push("security.ticker: must be the ticker on that exchange, such as INVE B or MSFT");
  if (!ticker && !isValidIsin(typeof input.isin === "string" ? input.isin.trim().toUpperCase() : "")) problems.push("security.ticker: give the ticker on that exchange, or the ISIN");
  const exchange = typeof input.exchange === "string" ? input.exchange.trim().toUpperCase() : "";
  if (!EXCHANGES[exchange]) problems.push(`security.exchange: must be one of ${Object.keys(EXCHANGES).join(", ")}`);
  let shareClass = null;
  if (input.shareClass !== undefined && input.shareClass !== null) {
    shareClass = typeof input.shareClass === "string" ? input.shareClass.trim().toUpperCase() : "";
    if (!SHARE_CLASS.test(shareClass)) problems.push("security.shareClass: must be a share class such as A, B, PREF or SDB, or null");
  }
  let isin = null;
  if (input.isin !== undefined && input.isin !== null) {
    isin = typeof input.isin === "string" ? input.isin.trim().toUpperCase() : "";
    if (!isValidIsin(isin)) problems.push("security.isin: is not a valid ISIN; leave it null when unknown");
  }
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  if (!CURRENCIES.includes(currency)) problems.push(`security.currency: must be one of ${CURRENCIES.join(", ")}`);
  const country = typeof input.country === "string" ? input.country.trim().toUpperCase() : EXCHANGES[exchange]?.country ?? "";
  if (!/^[A-Z]{2}$/.test(country)) problems.push("security.country: must be a two-letter country code");

  let lei = null;
  if (input.lei !== undefined && input.lei !== null) {
    lei = typeof input.lei === "string" ? input.lei.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{18}\d{2}$/.test(lei)) problems.push("security.lei: is not a legal entity identifier; leave it null when unknown");
  }
  const identifiers = normalizeIdentifiers(input.identifiers, problems);
  const verification = normalizeVerification(input.verification, problems);
  if (problems.length > 0) return { value: null, problems };
  return { value: { companyName, ticker, exchange, shareClass, isin, lei, currency, country, identifiers, verification }, problems };
}

/** Source-specific ids. Only known keys with their own exact formats are kept. */
const companyText = (value) => (typeof value === "string" && /^[\p{L}\p{N}][\p{L}\p{N} .,&'()-]{1,79}$/u.test(value.trim()) ? value.trim() : null);
const slug = (value) => (typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value) ? value : null);

/**
 * Where each source finds the company. They change where Hilla looks, never
 * which security it is, so they can be set or corrected on request.
 */
export const SOURCE_IDENTIFIERS = Object.freeze(["nasdaqCompany", "mfnEntityId", "mfnSlug", "cisionSlug", "eurolandCode", "inderesTopic", "newsName"]);

const IDENTIFIER_FORMATS = Object.freeze({
  secCik: (value) => normalizeCik(value),
  // The exact name Nasdaq lists the company's announcements under, such as "KONE Oyj".
  nasdaqCompany: companyText,
  mfnEntityId: (value) => (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : null),
  mfnSlug: slug,
  cisionSlug: slug,
  eurolandCode: (value) => (typeof value === "string" && /^[a-z]{1,3}-[a-z0-9]{1,12}$/.test(value) ? value : null),
  inderesTopic: (value) => (Number.isInteger(value) && value > 0 && value < 100_000_000 ? value : null),
  // The name news headlines use, when it differs from the listing's ("KONE" for "KONE Corporation").
  newsName: companyText,
});

export function normalizeIdentifiers(value, problems) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    problems.push("security.identifiers: must be an object");
    return {};
  }
  const identifiers = {};
  for (const [key, raw] of Object.entries(value)) {
    const format = IDENTIFIER_FORMATS[key];
    if (!format) {
      problems.push(`security.identifiers.${key}: unknown identifier (allowed: ${Object.keys(IDENTIFIER_FORMATS).join(", ")})`);
      continue;
    }
    if (raw === null) continue;
    const normalized = format(raw);
    if (!normalized) problems.push(`security.identifiers.${key}: has the wrong format`);
    else identifiers[key] = normalized;
  }
  return identifiers;
}

/** Which official register confirmed a listing: ESMA's FIRDS (EU venues), SEC's ticker list, or only the user. */
export const VERIFICATION_SOURCES = Object.freeze(["esma-firds", "sec-edgar", "user"]);

function normalizeVerification(value, problems) {
  if (value === undefined || value === null) return { source: "user", checkedAt: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    problems.push("security.verification: must be {source, checkedAt}");
    return null;
  }
  const extra = Object.keys(value).filter((key) => !["source", "checkedAt"].includes(key));
  if (extra.length > 0) problems.push(`security.verification: unknown keys ${extra.join(", ")}`);
  if (!VERIFICATION_SOURCES.includes(value.source)) problems.push(`security.verification.source: must be ${VERIFICATION_SOURCES.join(", ")}`);
  const checkedAt = value.checkedAt ?? null;
  if (checkedAt !== null && !(typeof checkedAt === "string" && Number.isFinite(Date.parse(checkedAt)))) problems.push("security.verification.checkedAt: must be a timestamp or null");
  return { source: value.source, checkedAt };
}

/** The identity two records must not share: one exchange listing, or one ISIN on one exchange. */
export function sameListing(left, right) {
  if (left.exchange !== right.exchange) return false;
  if (left.ticker && left.ticker === right.ticker) return true;
  return Boolean(left.isin && right.isin && left.isin === right.isin);
}

/** "Investor AB (INVE B, Nasdaq Stockholm)", or the ISIN when no ticker is known. */
export function describeSecurity(security) {
  return `${security.companyName} (${security.ticker ?? security.isin}, ${EXCHANGES[security.exchange]?.name ?? security.exchange})`;
}

// --- Matching the user's words to official listings ----------------------------------

const NAME_NOISE = new Set(["ab", "abp", "oyj", "oy", "asa", "as", "a/s", "plc", "inc", "inc.", "corp", "corp.", "corporation", "co", "company", "ltd", "limited", "sa", "se", "nv", "ag", "publ", "(publ)", "the", "group", "holding", "holdings"]);
const CLASS_WORDS = /\b(?:class|serie|series|sarja|aktie|aktier|share|shares|osake|osakkeet|-?osake)\b/g;

function words(text) {
  return String(text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[()]/g, " ")
    .split(/[^\p{L}\p{N}&./-]+/u)
    .filter(Boolean);
}

/** The words of a company name that tell it apart: no "AB", "Oyj", "Inc" or "(publ)". */
export function nameKey(name) {
  return words(name)
    .filter((word) => !NAME_NOISE.has(word))
    .join(" ");
}

/**
 * Splits the user's words into a name and an optional share class:
 * "Investor B" → { name: "investor", shareClass: "B" }, "Investor" → no class.
 */
export function parseSecurityQuery(query) {
  const text = String(query ?? "").normalize("NFC").trim();
  const cleaned = text
    .toLowerCase()
    // "B-aktie", "B-osake", "B-sarja": the class letter before a hyphenated share word.
    .replace(/(^|\s)([a-d])-(?=aktie|aktier|share|shares|osake|osakkeet|sarja)/g, "$1$2 ")
    .replace(CLASS_WORDS, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned.split(" ");
  const last = parts.at(-1) ?? "";
  if (parts.length > 1 && /^[a-d]$/.test(last)) return { text, name: parts.slice(0, -1).join(" "), shareClass: last.toUpperCase() };
  return { text, name: cleaned, shareClass: null };
}

/**
 * Candidates for the user's words among official listings, best first.
 * A listing matches on its exact ticker, ISIN or the distinguishing words of
 * its name. `status` is `resolved` only when exactly one listing fits:
 * a name with two share classes and no class given, or a ticker on two
 * exchanges, is `ambiguous`.
 *
 * Each listing: { companyName, ticker, exchange, shareClass, isin, currency, country, identifiers }.
 */
export function matchListings(listings, query, { exchange = null } = {}) {
  const parsed = parseSecurityQuery(query);
  const pool = exchange ? listings.filter((listing) => listing.exchange === exchange) : listings;
  const ticker = normalizeTicker(parsed.text);
  const isin = parsed.text.trim().toUpperCase();
  const byIsin = isValidIsin(isin) ? pool.filter((listing) => listing.isin === isin) : [];
  if (byIsin.length > 0) return resolution(byIsin, "isin");
  const byTicker = ticker ? pool.filter((listing) => listing.ticker && (listing.ticker === ticker || listing.ticker.replace(/[ .-]/g, "") === ticker.replace(/[ .-]/g, ""))) : [];
  if (byTicker.length > 0) return resolution(byTicker, "ticker");

  const key = nameKey(parsed.name);
  if (!key) return { status: "none", match: null, candidates: [] };
  const exact = pool.filter((listing) => nameKey(listing.companyName) === key);
  const prefix = exact.length > 0 ? [] : pool.filter((listing) => nameKey(listing.companyName).startsWith(`${key} `) || nameKey(listing.companyName) === key);
  let candidates = exact.length > 0 ? exact : prefix;
  if (parsed.shareClass) {
    const sameClass = candidates.filter((listing) => listing.shareClass === parsed.shareClass);
    if (sameClass.length > 0) candidates = sameClass;
    else if (candidates.length > 0) return { status: "ambiguous", match: "name", candidates, note: `No ${parsed.shareClass} share found for that name.` };
  }
  return resolution(candidates, "name");
}

function resolution(candidates, match) {
  if (candidates.length === 0) return { status: "none", match: null, candidates: [] };
  return { status: candidates.length === 1 ? "resolved" : "ambiguous", match, candidates };
}
