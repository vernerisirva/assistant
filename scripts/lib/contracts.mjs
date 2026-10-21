/**
 * The private contract register: insurance, electricity, broadband, mobile,
 * gym and other recurring contracts the user asked Hilla to keep track of.
 *
 * Contract details are private financial information, so the register is not
 * memory. It lives in its own folder under the ignored runtime state
 * (`<stateDir>/contracts/records/`), one owner-only file per contract in an
 * owner-only folder, and every change is written atomically under one
 * register lock. A record that cannot be read is reported and skipped, never
 * allowed to hide the others, and never overwritten by a later change.
 *
 * Nothing is stored without the user's yes. Every change is first returned as
 * a preview with a digest. The same change is committed only when it comes
 * back with that digest and the user's own approving reply, so what is stored
 * is exactly what they saw. Turning the renewal watch on or off for one
 * contract is the exception: it changes no contract details and runs on the
 * user's request.
 *
 * The register holds what a renewal decision needs and nothing more: no
 * identity, account, policy, card or registration numbers, no contact
 * details, no passwords, no links, no documents. Text that looks like any of
 * those, or like instructions, is refused rather than stored, and problems
 * name the field without echoing its value. Unknown values stay unknown
 * (null), and "none" records that a date does not apply.
 *
 * Nothing in this module cancels, switches, signs, buys or contacts anyone.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { isApprovalMessage } from "./approval-language.mjs";
import {
  NOTICE_UNITS,
  addDays,
  addMonths,
  contractKeyDates,
  daysBetween,
  describeNoticeLength,
  formatContractDate,
  isIsoDate,
  nextKeyDate,
} from "./contract-dates.mjs";
import { withFileLockSync, writeFileAtomicSync } from "./state-file.mjs";

export const CONTRACT_SCHEMA_VERSION = 1;
export const CONTRACT_ID_PATTERN = /^ct-[0-9a-f]{8}$/;
export const CONTRACT_ACTIONS = Object.freeze(["add", "update", "renew", "end", "remove", "monitor"]);
/** True once the daily renewal watch exists; until then a watched contract only records the wish. */
export const RENEWAL_WATCH_LIVE = false;

const INSURANCE = ["car_insurance", "home_insurance", "pet_insurance", "other_insurance"];
const INSURANCE_WORDS = ["insurance", "försäkring", "vakuutus"];

export const CONTRACT_CATEGORIES = Object.freeze({
  car_insurance: { label: "Car insurance", words: ["car", "bil", "bilförsäkring", "auto", "autovakuutus", ...INSURANCE_WORDS] },
  home_insurance: { label: "Home insurance", words: ["home", "house", "hem", "hemförsäkring", "villaförsäkring", "kotivakuutus", ...INSURANCE_WORDS] },
  pet_insurance: { label: "Pet insurance", words: ["pet", "dog", "cat", "djurförsäkring", "hundförsäkring", "kattförsäkring", "lemmikkivakuutus", ...INSURANCE_WORDS] },
  other_insurance: { label: "Insurance", words: INSURANCE_WORDS },
  electricity: { label: "Electricity", words: ["electricity", "power", "el", "elavtal", "elhandel", "elnät", "sähkö", "sähkösopimus"] },
  broadband: { label: "Broadband", words: ["broadband", "internet", "fiber", "fibre", "bredband", "laajakaista", "wifi"] },
  mobile: { label: "Mobile", words: ["mobile", "phone", "cell", "mobil", "mobilabonnemang", "sim", "liittymä", "puhelin"] },
  gym: { label: "Gym", words: ["gym", "membership", "gymkort", "träning", "kuntosali", "sali"] },
  streaming: { label: "Streaming", words: ["streaming", "tv", "music", "film"] },
  other: { label: "Subscription", words: ["subscription", "abonnemang", "tilaus"] },
});

export const PRICE_PERIODS = Object.freeze({ month: 12, quarter: 4, year: 1 });
export const CURRENCIES = Object.freeze(["SEK", "EUR", "NOK", "DKK", "USD", "GBP"]);
const AUTO_RENEWAL = ["yes", "no", "unknown"];
const SOURCE_TYPES = ["user_message", "document", "screenshot"];
const END_REASONS = ["cancelled", "switched", "expired", "other"];

/** The user-editable fields, in display order. */
export const CONTRACT_FIELDS = Object.freeze([
  "category",
  "provider",
  "product",
  "label",
  "startDate",
  "renewalDate",
  "autoRenewal",
  "bindingEndDate",
  "discountEndDate",
  "priceGuaranteeEndDate",
  "cancellationDeadline",
  "noticePeriod",
  "currentPrice",
  "nextPrice",
  "terms",
  "notes",
  "source",
]);
const DATE_FIELDS = ["startDate", "renewalDate", "bindingEndDate", "discountEndDate", "priceGuaranteeEndDate", "cancellationDeadline"];
const TERM_DATES = ["bindingEndDate", "discountEndDate", "priceGuaranteeEndDate", "cancellationDeadline"];

export const FIELD_LABELS = Object.freeze({
  category: "Type",
  provider: "Provider",
  product: "Product",
  label: "Label",
  startDate: "Started",
  renewalDate: "Renewal date",
  autoRenewal: "Renews automatically",
  bindingEndDate: "Binding period ends",
  discountEndDate: "Discount ends",
  priceGuaranteeEndDate: "Price guarantee ends",
  cancellationDeadline: "Last day to cancel",
  noticePeriod: "Notice period",
  currentPrice: "Price",
  nextPrice: "Price after the change",
  terms: "Terms",
  notes: "Notes",
  source: "Source",
  status: "Status",
  monitoring: "Renewal watch",
});

/**
 * Terms a comparison can use, per category. Anything else belongs in notes,
 * or nowhere: the register keeps what a renewal decision needs.
 */
export const TERM_FIELDS = Object.freeze({
  coverage: { kind: "text", max: 80, categories: INSURANCE, label: "Coverage" },
  deductible: { kind: "money", categories: INSURANCE, label: "Deductible" },
  addOns: { kind: "list", max: 6, itemMax: 60, categories: INSURANCE, label: "Add-ons" },
  insuredItem: { kind: "text", max: 60, categories: INSURANCE, label: "Insured" },
  agreement: { kind: "enum", values: ["supply", "grid"], categories: ["electricity"], label: "Agreement" },
  priceModel: { kind: "enum", values: ["fixed", "variable", "spot"], categories: ["electricity"], label: "Price model" },
  fixedPriceOrePerKwh: { kind: "number", min: 0, max: 1000, categories: ["electricity"], label: "Fixed price", unit: "öre/kWh" },
  markupOrePerKwh: { kind: "number", min: 0, max: 500, categories: ["electricity"], label: "Markup", unit: "öre/kWh" },
  monthlyFeeSek: { kind: "number", min: 0, max: 2000, categories: ["electricity"], label: "Monthly fee", unit: "SEK" },
  pricesIncludeVat: { kind: "boolean", categories: ["electricity"], label: "Prices include VAT" },
  annualConsumptionKwh: { kind: "integer", min: 100, max: 200_000, categories: ["electricity"], label: "Yearly use", unit: "kWh" },
  priceArea: { kind: "enum", values: ["SE1", "SE2", "SE3", "SE4"], categories: ["electricity"], label: "Price area" },
  downloadMbps: { kind: "number", min: 0.1, max: 100_000, categories: ["broadband", "mobile"], label: "Download", unit: "Mbit/s" },
  uploadMbps: { kind: "number", min: 0.1, max: 100_000, categories: ["broadband", "mobile"], label: "Upload", unit: "Mbit/s" },
  dataGb: { kind: "data", categories: ["mobile"], label: "Data" },
  access: { kind: "text", max: 80, categories: ["gym"], label: "Access" },
  includes: { kind: "list", max: 6, itemMax: 60, categories: ["electricity", "broadband", "mobile", "gym", "streaming", "other"], label: "Includes" },
});

// --- Free text ---------------------------------------------------------------

const CONTROL = /[\u{0}-\u{1f}\u{7f}]/gu;
const MARKUP = /[*_`[\]<>|\\~#]/g;
const ISO_DATES = /\b\d{4}-\d{2}-\d{2}\b/g;
// Eight or more digits in a row, allowing single spaces, dots or dashes:
// personal identity, account, card, policy and phone numbers all look like this.
const LONG_NUMBER = /\d(?:[\s.-]?\d){7,}/;
const IDENTIFIER_WORDS =
  /\b(?:personnummer|samordningsnummer|henkilötunnus|hetu|social security|ssn|passport|passnummer|id[- ]?(?:number|nummer|card|kort)|(?:policy|customer|client|account|member(?:ship)?|contract|agreement|order|invoice|reference|ref) ?(?:no|nr|number|id)\b|(?:försäkrings|kund|konto|avtals|medlems|order|faktura|referens|kort|bank|clearing)(?:nummer|nr)|(?:asiakas|vakuutus|tili|sopimus|jäsen|lasku)(?:numero|nro)|iban|bic|swift|bankgiro|plusgiro|ocr)\b/i;
const CREDENTIAL_WORDS =
  /\b(?:password|passcode|lösenord|salasana|pin(?:[- ]?(?:kod|code|koodi))?|bankid|login|log-?in|logga in|inloggning|användarnamn|username|cvc|cvv|security code|säkerhetskod)\b/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const LINK = /https?:\/\/|\bwww\./i;
const PHONE = /(?:\+|00)\d[\d\s-]{6,}\d/;
// Swedish (ABC 123, ABC 12A) and Finnish (ABC-123) registration plates, in capitals.
const PLATE = /\b(?!(?:SEK|EUR|NOK|DKK|USD|GBP|KWH|MWH|VAT|BMW|KIA|BYD|AMG|GMC)\b)[A-ZÅÄÖ]{3} ?\d{2}[A-Z\d]\b|\b[A-ZÅÄÖ]{2,3}-\d{1,3}\b/;
const MONEY_TEXT = /\d[\d\s.,]*\s?(?:kr|kronor|sek|eur|euro|euros|nok|dkk|usd|gbp|öre)\b|\d[\d\s.,]*\s?[€$£]|[€$£]\s?\d/i;
const INSTRUCTIONS =
  /\b(?:ignore|disregard|override|forget)\b[^.]{0,40}\b(?:instructions?|rules|prompts?|guidelines|orders|above|previous)\b|\bsystem prompt\b|\bdeveloper (?:message|mode)\b|\byou are now\b|\bas an ai\b|\b(?:run|execute|exec)\b[^.]{0,30}\b(?:commands?|scripts?|shell|terminal|code)\b|\bapi[ _-]?keys?\b|\btokens?\b|\bsudo\b|\brm -rf\b|\bcurl\b|\bwget\b|<\s*script|\bnpm run\b|\bopenclaw\b|\b(?:assistant|system|user)\s*:/i;

const TEXT_RULES = [
  [(text) => LINK.test(text), "leave links out; the register keeps no links"],
  [(text) => EMAIL.test(text), "leave email addresses out"],
  [(text) => CREDENTIAL_WORDS.test(text), "leave passwords, codes and login details out"],
  [(text) => IDENTIFIER_WORDS.test(text), "leave identity, policy, customer, account and card numbers out"],
  [(text) => LONG_NUMBER.test(text.replace(ISO_DATES, " ")) || PHONE.test(text), "looks like an identity, account, card, policy or phone number; leave it out"],
  [(text) => PLATE.test(text), "looks like a registration number; leave it out"],
  [(text) => MONEY_TEXT.test(text), "put prices and fees in their price fields, not in text"],
  [(text) => INSTRUCTIONS.test(text), "reads like instructions, not contract facts; leave it out"],
];

/** One line of stored text, or a problem. The problem never repeats the text itself. */
export function checkContractText(value, { max }) {
  if (typeof value !== "string") return { problem: "must be text" };
  const text = value.normalize("NFC").replace(CONTROL, " ").replace(MARKUP, " ").replace(/\s+/g, " ").trim();
  if (!text) return { problem: "is empty" };
  if (text.length > max) return { problem: `is longer than ${max} characters` };
  for (const [breaks, message] of TEXT_RULES) {
    if (breaks(text)) return { problem: message };
  }
  return { value: text };
}

// --- Normalizing input ----------------------------------------------------------

/**
 * Checks and normalizes contract fields. With `complete`, the result is a
 * whole contract (category and provider required, absent fields unknown);
 * otherwise only the given fields are returned, as a change. Problems name
 * the field and never echo its value.
 */
export function normalizeContractFields(input, { complete = false, category: knownCategory } = {}) {
  const problems = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { value: null, problems: ["the contract must be a JSON object"] };
  for (const key of Object.keys(input)) {
    if (!CONTRACT_FIELDS.includes(key)) problems.push(`${key}: unknown field (allowed: ${CONTRACT_FIELDS.join(", ")})`);
  }
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
  const value = {};
  const set = (key, result) => {
    if (result.problem) problems.push(`${key}: ${result.problem}`);
    else value[key] = result.value;
  };

  if (has("category")) set("category", CONTRACT_CATEGORIES[input.category] ? { value: input.category } : { problem: `must be one of ${Object.keys(CONTRACT_CATEGORIES).join(", ")}` });
  else if (complete) problems.push("category: is required");
  if (has("provider")) set("provider", checkContractText(input.provider, { max: 60 }));
  else if (complete) problems.push("provider: is required");
  for (const [key, max] of [["product", 80], ["label", 40], ["notes", 200]]) {
    if (has(key)) set(key, input[key] === null ? { value: null } : checkContractText(input[key], { max }));
  }
  for (const key of DATE_FIELDS) {
    if (has(key)) set(key, normalizeDate(input[key], { allowNone: key !== "startDate" }));
  }
  if (has("autoRenewal")) set("autoRenewal", AUTO_RENEWAL.includes(input.autoRenewal) ? { value: input.autoRenewal } : { problem: `must be ${AUTO_RENEWAL.join(", ")}` });
  if (has("noticePeriod")) set("noticePeriod", normalizeNoticePeriod(input.noticePeriod));
  if (has("currentPrice")) set("currentPrice", normalizePrice(input.currentPrice));
  if (has("nextPrice")) set("nextPrice", normalizePrice(input.nextPrice, { basis: true }));
  if (has("source")) set("source", normalizeSource(input.source));

  const category = value.category ?? knownCategory;
  if (has("terms")) set("terms", normalizeTerms(input.terms, category));

  if (complete) {
    for (const key of CONTRACT_FIELDS) if (!(key in value)) value[key] = defaultFieldValue(key);
  }
  return { value, problems };
}

function defaultFieldValue(key) {
  if (key === "autoRenewal") return "unknown";
  if (key === "terms") return {};
  if (key === "source") return { type: "user_message", document: null };
  return null;
}

function normalizeDate(value, { allowNone }) {
  if (value === null) return { value: null };
  if (allowNone && value === "none") return { value: "none" };
  if (isIsoDate(value)) return { value };
  return { problem: `must be a YYYY-MM-DD date${allowNone ? ', "none" when it does not apply,' : ""} or null when unknown` };
}

function normalizeNoticePeriod(value) {
  if (value === null) return { value: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { problem: "must be {value, unit, verified} or null when unknown" };
  const extra = Object.keys(value).filter((key) => !["value", "unit", "verified"].includes(key));
  if (extra.length > 0) return { problem: `unknown keys ${extra.join(", ")}` };
  if (!NOTICE_UNITS.includes(value.unit)) return { problem: `unit must be ${NOTICE_UNITS.join(", ")}` };
  const max = value.unit === "days" ? 365 : 24;
  if (!Number.isInteger(value.value) || value.value < 1 || value.value > max) return { problem: `value must be a whole number from 1 to ${max}` };
  if (value.verified !== undefined && typeof value.verified !== "boolean") return { problem: "verified must be true or false" };
  return { value: { value: value.value, unit: value.unit, verified: value.verified === true } };
}

function normalizeMoney(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { problem: "must be {amount, currency}" };
  if (typeof value.amount !== "number" || !Number.isFinite(value.amount) || value.amount < 0 || value.amount > 1_000_000) {
    return { problem: "amount must be a number from 0 to 1000000" };
  }
  const currency = value.currency ?? "SEK";
  if (!CURRENCIES.includes(currency)) return { problem: `currency must be ${CURRENCIES.join(", ")}` };
  return { value: { amount: Math.round(value.amount * 100) / 100, currency } };
}

function normalizePrice(value, { basis = false } = {}) {
  if (value === null) return { value: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { problem: "must be {amount, currency, period} or null when unknown" };
  const allowed = ["amount", "currency", "period", ...(basis ? ["basis"] : [])];
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) return { problem: `unknown keys ${extra.join(", ")}` };
  const money = normalizeMoney(value);
  if (money.problem) return money;
  if (!PRICE_PERIODS[value.period]) return { problem: `period must be ${Object.keys(PRICE_PERIODS).join(", ")}` };
  const price = { ...money.value, period: value.period };
  if (basis) {
    if (value.basis === undefined || value.basis === null) price.basis = null;
    else {
      const text = checkContractText(value.basis, { max: 60 });
      if (text.problem) return { problem: `basis ${text.problem}` };
      price.basis = text.value;
    }
  }
  return { value: price };
}

function normalizeSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { problem: "must be {type, document}" };
  const extra = Object.keys(value).filter((key) => !["type", "document"].includes(key));
  if (extra.length > 0) return { problem: `unknown keys ${extra.join(", ")}` };
  if (!SOURCE_TYPES.includes(value.type)) return { problem: `type must be ${SOURCE_TYPES.join(", ")}` };
  if (value.document === undefined || value.document === null) return { value: { type: value.type, document: null } };
  const text = checkContractText(value.document, { max: 60 });
  return text.problem ? { problem: `document ${text.problem}` } : { value: { type: value.type, document: text.value } };
}

function normalizeTerms(value, category) {
  if (value === null) return { value: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { problem: "must be an object" };
  if (!category) return { problem: "need the contract's category" };
  const allowed = Object.entries(TERM_FIELDS).filter(([, spec]) => spec.categories.includes(category)).map(([key]) => key);
  const terms = {};
  for (const [key, raw] of Object.entries(value)) {
    const spec = TERM_FIELDS[key];
    if (!spec || !spec.categories.includes(category)) return { problem: `${key} is not a term for ${category} (allowed: ${allowed.join(", ") || "none"})` };
    if (raw === null) continue;
    const result = normalizeTerm(raw, spec);
    if (result.problem) return { problem: `${key} ${result.problem}` };
    terms[key] = result.value;
  }
  return { value: terms };
}

function normalizeTerm(raw, spec) {
  switch (spec.kind) {
    case "text":
      return checkContractText(raw, { max: spec.max });
    case "money":
      return normalizeMoney(raw);
    case "enum":
      return spec.values.includes(raw) ? { value: raw } : { problem: `must be ${spec.values.join(", ")}` };
    case "boolean":
      return typeof raw === "boolean" ? { value: raw } : { problem: "must be true or false" };
    case "number":
    case "integer": {
      const ok = typeof raw === "number" && Number.isFinite(raw) && raw >= spec.min && raw <= spec.max && (spec.kind === "number" || Number.isInteger(raw));
      return ok ? { value: raw } : { problem: `must be a ${spec.kind === "integer" ? "whole number" : "number"} from ${spec.min} to ${spec.max}` };
    }
    case "data":
      if (raw === "unlimited") return { value: raw };
      return typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= 10_000 ? { value: raw } : { problem: 'must be a number of GB or "unlimited"' };
    case "list": {
      if (!Array.isArray(raw) || raw.length > spec.max) return { problem: `must be a list of at most ${spec.max} short items` };
      const items = [];
      for (const item of raw) {
        const text = checkContractText(item, { max: spec.itemMax });
        if (text.problem) return { problem: `item ${text.problem}` };
        items.push(text.value);
      }
      return { value: items };
    }
    default:
      return { problem: "has an unknown kind" };
  }
}

/** Problems with the contract as a whole: dates in an impossible order, mixed currencies. */
export function contractConsistencyProblems(fields) {
  const problems = [];
  const date = (key) => (isIsoDate(fields[key]) ? fields[key] : null);
  if (date("startDate") && date("renewalDate") && date("startDate") >= date("renewalDate")) {
    problems.push("startDate: must be before renewalDate");
  }
  if (date("cancellationDeadline") && date("renewalDate") && date("cancellationDeadline") > date("renewalDate")) {
    problems.push("cancellationDeadline: is after renewalDate; check which date is which");
  }
  if (fields.currentPrice && fields.nextPrice && fields.currentPrice.currency !== fields.nextPrice.currency) {
    problems.push("nextPrice: must use the same currency as currentPrice");
  }
  return problems;
}

// --- Records ---------------------------------------------------------------------

export function newContractId(random = randomBytes) {
  return `ct-${random(4).toString("hex")}`;
}

/** A canonical, order-independent digest of what the user is asked to approve. */
export function changeDigest(action, { id = null, revision = 0, payload }) {
  return createHash("sha256").update(canonicalJson({ action, id, revision, payload })).digest("hex").slice(0, 16);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Field-by-field differences between two versions, as `{ field, from, to }`. */
export function changedFields(before, after) {
  return CONTRACT_FIELDS.filter((key) => canonicalJson(before[key]) !== canonicalJson(after[key])).map((key) => ({
    field: key,
    from: before[key] ?? null,
    to: after[key] ?? null,
  }));
}

function parseStoredRecord(document, expectedId) {
  if (!document || typeof document !== "object") throw new Error("is not a JSON object");
  if (document.schemaVersion !== CONTRACT_SCHEMA_VERSION) throw new Error(`has unsupported schema version ${document.schemaVersion}`);
  if (document.id !== expectedId) throw new Error("has an id that does not match its file name");
  if (!["active", "ended"].includes(document.status)) throw new Error("has an unknown status");
  if (!Number.isInteger(document.revision) || document.revision < 1) throw new Error("has no valid revision");
  if (!Array.isArray(document.history)) throw new Error("has no history");
  if (!document.monitoring || typeof document.monitoring.enabled !== "boolean") throw new Error("has no monitoring setting");
  const fields = Object.fromEntries(CONTRACT_FIELDS.map((key) => [key, document[key]]));
  const { problems } = normalizeContractFields(fields, { complete: true });
  const consistency = contractConsistencyProblems(fields);
  if (problems.length > 0 || consistency.length > 0) throw new Error(`has invalid fields (${[...problems, ...consistency].map((problem) => problem.split(":")[0]).join(", ")})`);
  return document;
}

// --- Store -----------------------------------------------------------------------

export function resolveContractsDir(stateDir) {
  if (!stateDir) throw new Error("A state directory is required for the contract register.");
  return join(stateDir, "contracts");
}

/**
 * The register on disk. Folders are owner-only (0700) and record files
 * owner-only (0600); both are re-applied on every write. Writes replace a
 * file atomically, and `withLock` serializes read-check-write cycles across
 * processes.
 */
export function createContractStore({ stateDir }) {
  const root = resolveContractsDir(stateDir);
  const recordsDir = join(root, "records");
  const recordPath = (id) => join(recordsDir, `${requireContractId(id)}.json`);

  function ensurePrivateDirs() {
    for (const dir of [root, recordsDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
  }

  function read(id) {
    const path = recordPath(id);
    if (!existsSync(path)) {
      const missing = new Error(`No contract with id ${id}.`);
      missing.code = "CONTRACT_NOT_FOUND";
      throw missing;
    }
    let document;
    try {
      document = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw unreadableRecord(id, "is not valid JSON");
    }
    try {
      return parseStoredRecord(document, id);
    } catch (error) {
      throw unreadableRecord(id, error.message);
    }
  }

  /** Unreadable files are reported, never allowed to hide the other contracts. */
  function listWithIssues() {
    if (!existsSync(recordsDir)) return { records: [], issues: [] };
    const records = [];
    const issues = [];
    for (const name of readdirSync(recordsDir).filter((entry) => entry.endsWith(".json")).sort()) {
      const id = name.slice(0, -".json".length);
      if (!CONTRACT_ID_PATTERN.test(id)) {
        issues.push({ file: name, id: null, message: `Contract record file ${name} has an unexpected file name.`, reason: "has an unexpected file name" });
        continue;
      }
      try {
        records.push(read(id));
      } catch (error) {
        issues.push({ file: name, id, message: error.message, reason: error.reason ?? "could not be read" });
      }
    }
    return { records, issues };
  }

  function write(record) {
    ensurePrivateDirs();
    writeFileAtomicSync(recordPath(record.id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return record;
  }

  function remove(id) {
    rmSync(recordPath(id), { force: true });
  }

  function withLock(fn) {
    ensurePrivateDirs();
    return withFileLockSync(join(root, "register"), fn);
  }

  /** Folders or files that someone other than the owner could read. */
  function permissionProblems() {
    const problems = [];
    const check = (path, expected) => {
      if (!existsSync(path)) return;
      const mode = statSync(path).mode & 0o777;
      if (mode & 0o077) problems.push({ path: relative(dirname(root), path), mode: mode.toString(8).padStart(4, "0"), expected });
    };
    check(root, "0700");
    check(recordsDir, "0700");
    if (existsSync(recordsDir)) {
      for (const name of readdirSync(recordsDir).filter((entry) => entry.endsWith(".json"))) check(join(recordsDir, name), "0600");
    }
    return problems;
  }

  return { root, recordsDir, read, listWithIssues, write, remove, withLock, permissionProblems, exists: (id) => existsSync(recordPath(id)) };
}

function requireContractId(id) {
  if (typeof id !== "string" || !CONTRACT_ID_PATTERN.test(id)) throw new Error("A contract id looks like ct-1a2b3c4d.");
  return id;
}

function unreadableRecord(id, reason) {
  const error = new Error(`Contract record ${id} could not be read: it ${reason}.`);
  error.code = "CONTRACT_UNREADABLE";
  error.reason = reason;
  return error;
}

// --- Finding one contract ----------------------------------------------------------

const STOP_WORDS = new Set(["my", "the", "a", "an", "our", "this", "that", "for", "with", "at", "of", "min", "mitt", "mina", "minun", "contract", "contracts", "agreement", "avtal", "avtalet", "sopimus", "one"]);

function tokens(text) {
  return String(text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function recordTokens(record) {
  return [record.id, ...CONTRACT_CATEGORIES[record.category].words, ...tokens(CONTRACT_CATEGORIES[record.category].label), ...tokens(record.provider), ...tokens(record.product), ...tokens(record.label)];
}

/**
 * Exactly one contract for an id or the user's own words ("my car
 * insurance", "If", "the Volvo"), or the candidates to ask about. Every word
 * must match the record's type, provider, product or label, so "If" with two
 * If contracts is ambiguous and "If car" is not. Ended contracts are left out
 * unless `includeEnded`.
 */
export function resolveContract(records, selector = {}, { includeEnded = false } = {}) {
  if (selector.id !== undefined) {
    const record = records.find((candidate) => candidate.id === selector.id);
    if (!record || (!includeEnded && record.status !== "active")) return { status: "none", candidates: [] };
    return { status: "resolved", record, candidates: [record] };
  }
  const pool = records.filter((record) => includeEnded || record.status === "active");
  const words = tokens(selector.target).filter((word) => !STOP_WORDS.has(word));
  const matches = words.length === 0
    ? pool
    : pool.filter((record) => {
        const hay = recordTokens(record);
        return words.every((word) => hay.some((candidate) => candidate === word || (word.length >= 3 && candidate.startsWith(word))));
      });
  if (matches.length === 1) return { status: "resolved", record: matches[0], candidates: matches };
  return { status: matches.length === 0 ? "none" : "ambiguous", candidates: matches };
}

/** Active contracts the new one would duplicate: same type, provider and label. */
export function findDuplicates(records, fields) {
  const same = (left, right) => String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
  return records.filter(
    (record) => record.status === "active" && record.category === fields.category && same(record.provider, fields.provider) && same(record.label, fields.label),
  );
}

// --- Actions -----------------------------------------------------------------------

/**
 * Runs one register action. Without `input.approval` it is always a preview
 * and nothing is written. With `{ approval: { digest, replyText } }` the same
 * change is committed when the digest still matches and the reply is a plain
 * approval. `monitor` needs no approval.
 */
export function runContractAction(action, input, { store, now = new Date(), today, random = randomBytes }) {
  if (!CONTRACT_ACTIONS.includes(action)) throw new Error(`Unknown contract action: ${action}`);
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid(["the input must be a JSON object"]);
  const { approval, ...payload } = input;
  if (approval !== undefined && action === "monitor") return invalid(["approval: monitor runs on the user's request and takes no approval"]);
  const context = { store, now, today, random, approval };
  switch (action) {
    case "add":
      return addContract(payload, context);
    case "update":
      return updateContract(payload, context);
    case "renew":
      return renewContract(payload, context);
    case "end":
      return endContract(payload, context);
    case "remove":
      return removeContract(payload, context);
    case "monitor":
      return monitorContract(payload, context);
    default:
      throw new Error(`Unknown contract action: ${action}`);
  }
}

function addContract(payload, context) {
  const { monitor, ...fields } = payload;
  if (monitor !== undefined && typeof monitor !== "boolean") return invalid(["monitor: must be true or false"]);
  const { value, problems } = normalizeContractFields(fields, { complete: true });
  if (problems.length > 0) return invalid(problems);
  const consistency = contractConsistencyProblems(value);
  if (consistency.length > 0) return invalid(consistency);
  const draft = { ...value, monitoring: { enabled: monitor === true } };
  const { records } = context.store.listWithIssues();
  const duplicates = findDuplicates(records, draft);
  if (duplicates.length > 0) return duplicateResult(draft, duplicates);
  const digest = changeDigest("add", { payload: draft });

  if (context.approval === undefined) {
    return {
      ok: true,
      status: "preview",
      action: "add",
      digest,
      questions: intakeQuestions(draft),
      telegramText: formatAddPreview(draft, context),
      guidance: "Nothing is saved yet. Send telegramText unchanged (one short sentence before it is fine) and wait for the user's reply. Save only after a plain yes: run add again with the same contract and {\"approval\": {\"digest\": \"<digest>\", \"replyText\": \"<their exact reply>\"}}. If they change something, run a new preview instead.",
    };
  }
  const refusal = approvalRefusal(context.approval, digest);
  if (refusal) return refusal;

  return context.store.withLock(() => {
    const again = findDuplicates(context.store.listWithIssues().records, draft);
    if (again.length > 0) return duplicateResult(draft, again);
    const at = context.now.toISOString();
    const record = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      id: uniqueId(context),
      revision: 1,
      status: "active",
      ...Object.fromEntries(CONTRACT_FIELDS.map((key) => [key, value[key]])),
      monitoring: { enabled: monitor === true, since: monitor === true ? at : null, until: null },
      endedOn: null,
      endReason: null,
      createdAt: at,
      updatedAt: at,
      history: [{ at, revision: 1, kind: "created", changes: [], reason: null }],
    };
    context.store.write(record);
    return {
      ok: true,
      status: "saved",
      action: "add",
      contract: summarizeContract(record, context),
      telegramText: formatSaved(record, context),
    };
  });
}

function uniqueId(context) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = newContractId(context.random);
    if (!context.store.exists(id)) return id;
  }
  throw new Error("Could not pick a new contract id.");
}

function updateContract(payload, context) {
  const extra = Object.keys(payload).filter((key) => !["id", "target", "changes", "reason"].includes(key));
  if (extra.length > 0) return invalid([`${extra.join(", ")}: unknown keys (update takes id or target, changes and reason)`]);
  if (!payload.changes || typeof payload.changes !== "object" || Array.isArray(payload.changes) || Object.keys(payload.changes).length === 0) {
    return invalid(["changes: must be an object with at least one field to change"]);
  }
  return changeRecord("update", payload, context, (record) => {
    const { value, problems } = normalizeContractFields(withMergedTerms(payload.changes, record), { category: record.category });
    if (problems.length > 0) return { problems };
    // A new category can make its existing terms invalid; they are checked again below.
    const next = { ...record, ...value };
    if (value.category && value.category !== record.category && !("terms" in value)) {
      const { problems: termProblems } = normalizeContractFields({ terms: record.terms }, { category: value.category });
      if (termProblems.length > 0) return { problems: [`terms: the existing terms do not fit ${value.category}; send terms with the change`] };
    }
    return { next, kind: "updated" };
  });
}

/**
 * Term changes add to the stored terms: `{"terms": {"annualConsumptionKwh": 9000}}`
 * keeps the price model and fees, and a term set to null removes just that
 * term. `"terms": null` clears them all.
 */
function withMergedTerms(changes, record) {
  if (!changes.terms || typeof changes.terms !== "object" || Array.isArray(changes.terms)) return changes;
  return { ...changes, terms: { ...record.terms, ...changes.terms } };
}

function renewContract(payload, context) {
  const allowed = ["id", "target", "renewalDate", "extendBy", "currentPrice", "nextPrice", "noticePeriod", "terms", "reason", ...TERM_DATES, "autoRenewal"];
  const extra = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (extra.length > 0) return invalid([`${extra.join(", ")}: unknown keys for renew`]);
  if (!("currentPrice" in payload)) return invalid(['currentPrice: say what the new term costs ({amount, currency, period}), "unchanged" if the user said so, or null when unknown']);
  if ((payload.renewalDate === undefined) === (payload.extendBy === undefined)) return invalid(["renewalDate or extendBy: give exactly one of them"]);
  return changeRecord("renew", payload, context, (record) => {
    if (!isIsoDate(record.renewalDate)) return { problems: ["renewalDate: this contract has no renewal date to renew from; use update to set its dates"] };
    let renewalDate = payload.renewalDate;
    if (payload.extendBy !== undefined) {
      const extend = payload.extendBy;
      if (!extend || !Number.isInteger(extend.value) || extend.value < 1 || extend.value > 60 || !["months", "years"].includes(extend.unit)) {
        return { problems: ["extendBy: must be {value: 1-60, unit: months or years}"] };
      }
      renewalDate = addMonths(record.renewalDate, extend.unit === "years" ? extend.value * 12 : extend.value);
    }
    const changes = { renewalDate, startDate: record.renewalDate };
    // Dates that belonged to the old term no longer apply; they become unknown unless given.
    for (const key of TERM_DATES) {
      if (key in payload) changes[key] = payload[key];
      else if (isIsoDate(record[key]) && record[key] <= record.renewalDate) changes[key] = null;
    }
    changes.nextPrice = "nextPrice" in payload ? payload.nextPrice : null;
    if (payload.currentPrice !== "unchanged") changes.currentPrice = payload.currentPrice;
    for (const key of ["noticePeriod", "terms", "autoRenewal"]) if (key in payload) changes[key] = payload[key];
    const { value, problems } = normalizeContractFields(withMergedTerms(changes, record), { category: record.category });
    if (problems.length > 0) return { problems };
    if (!isIsoDate(value.renewalDate) || value.renewalDate <= record.renewalDate) {
      return { problems: ["renewalDate: the new renewal date must be a date after the current one"] };
    }
    return { next: { ...record, ...value }, kind: "renewed" };
  });
}

function endContract(payload, context) {
  const extra = Object.keys(payload).filter((key) => !["id", "target", "endedOn", "endReason", "reason"].includes(key));
  if (extra.length > 0) return invalid([`${extra.join(", ")}: unknown keys for end`]);
  if (!END_REASONS.includes(payload.endReason)) return invalid([`endReason: must be ${END_REASONS.join(", ")}`]);
  return changeRecord("end", payload, context, (record) => {
    const endedOn = payload.endedOn === undefined ? { value: null } : normalizeDate(payload.endedOn, { allowNone: false });
    if (endedOn.problem) return { problems: [`endedOn: ${endedOn.problem}`] };
    return {
      next: { ...record, status: "ended", endedOn: endedOn.value, endReason: payload.endReason, monitoring: { enabled: false, since: null, until: null } },
      kind: "ended",
    };
  });
}

function removeContract(payload, context) {
  const extra = Object.keys(payload).filter((key) => !["id", "target"].includes(key));
  if (extra.length > 0) return invalid([`${extra.join(", ")}: unknown keys for remove`]);
  const { records, issues } = context.store.listWithIssues();
  // An unreadable record can be removed by its id, so a broken file never has to stay.
  const broken = payload.id !== undefined ? issues.find((issue) => issue.id === payload.id) : null;
  const resolution = broken ? null : resolveSelector(records, payload, { includeEnded: true });
  if (resolution && resolution.status !== "resolved") return resolution;
  const record = resolution?.record ?? null;
  const id = record?.id ?? broken.id;
  const digest = changeDigest("remove", { id, revision: record?.revision ?? 0, payload: { id } });
  if (context.approval === undefined) {
    return {
      ok: true,
      status: "preview",
      action: "remove",
      digest,
      contractId: id,
      telegramText: record
        ? `Delete ${describeContractName(record)} from your contract register, with its history? This can't be undone. To keep the history, I can mark it ended instead. Reply yes to delete.`
        : "One contract record in your register can't be read. Delete that record file? This can't be undone. Reply yes to delete.",
      guidance: "Nothing is deleted yet. Delete only after a plain yes, with the digest and their exact reply as approval.",
    };
  }
  const refusal = approvalRefusal(context.approval, digest);
  if (refusal) return refusal;
  return context.store.withLock(() => {
    if (record && context.store.read(id).revision !== record.revision) return changedSincePreview();
    // A file shown as unreadable that has since been fixed is not deleted on that preview.
    if (!record && !context.store.listWithIssues().issues.some((issue) => issue.id === id)) return changedSincePreview();
    context.store.remove(id);
    return {
      ok: true,
      status: "removed",
      action: "remove",
      contractId: id,
      telegramText: record ? `Deleted ${describeContractName(record)} from your contract register.` : "Deleted the unreadable contract record.",
    };
  });
}

function monitorContract(payload, context) {
  const extra = Object.keys(payload).filter((key) => !["id", "target", "enabled", "until"].includes(key));
  if (extra.length > 0) return invalid([`${extra.join(", ")}: unknown keys for monitor`]);
  if (typeof payload.enabled !== "boolean") return invalid(["enabled: must be true or false"]);
  const until = payload.until === undefined ? { value: null } : normalizeDate(payload.until, { allowNone: false });
  if (until.problem) return invalid([`until: ${until.problem}`]);
  return context.store.withLock(() => {
    const resolution = resolveSelector(context.store.listWithIssues().records, payload);
    if (resolution.status !== "resolved") return resolution;
    const record = resolution.record;
    const at = context.now.toISOString();
    const monitoring = payload.enabled
      ? { enabled: true, since: record.monitoring.enabled ? record.monitoring.since : at, until: until.value }
      : { enabled: false, since: null, until: null };
    if (canonicalJson(monitoring) === canonicalJson(record.monitoring)) {
      return { ok: true, status: "unchanged", action: "monitor", contract: summarizeContract(record, context), telegramText: formatMonitoring(record, context) };
    }
    const next = bumpRevision({ ...record, monitoring }, at, "monitoring", [{ field: "monitoring", from: record.monitoring, to: monitoring }], null);
    context.store.write(next);
    return { ok: true, status: "saved", action: "monitor", contract: summarizeContract(next, context), telegramText: formatMonitoring(next, context) };
  });
}

/**
 * The shared preview-then-commit path for changes to one existing contract.
 * `build(record)` returns `{ next, kind }` or `{ problems }`. The commit
 * re-reads the record under the lock and refuses when it changed since the
 * preview, so a stale approval never overwrites newer details.
 */
function changeRecord(action, payload, context, build) {
  let reason = null;
  if (payload.reason !== undefined && payload.reason !== null) {
    const text = checkContractText(payload.reason, { max: 200 });
    if (text.problem) return invalid([`reason: ${text.problem}`]);
    reason = text.value;
  }
  const resolution = resolveSelector(context.store.listWithIssues().records, payload);
  if (resolution.status !== "resolved") return resolution;
  const record = resolution.record;
  const built = build(record);
  if (built.problems) return invalid(built.problems);
  const consistency = contractConsistencyProblems(built.next);
  if (consistency.length > 0) return invalid(consistency);
  const changes = [...changedFields(record, built.next), ...systemChanges(record, built.next)];
  if (changes.length === 0) {
    return { ok: true, status: "unchanged", action, contract: summarizeContract(record, context), telegramText: `That doesn't change anything stored for ${describeContractName(record)}.` };
  }
  const digest = changeDigest(action, { id: record.id, revision: record.revision, payload: { changes, reason } });

  if (context.approval === undefined) {
    return {
      ok: true,
      status: "preview",
      action,
      digest,
      contractId: record.id,
      telegramText: formatChangePreview(action, record, built.next, changes, context),
      guidance: "Nothing is saved yet. Send telegramText unchanged and wait for the user's reply. Save only after a plain yes: run the same command again with {\"id\": \"<contractId>\"}, the same change and {\"approval\": {\"digest\": \"<digest>\", \"replyText\": \"<their exact reply>\"}}.",
    };
  }
  const refusal = approvalRefusal(context.approval, digest);
  if (refusal) return refusal;
  return context.store.withLock(() => {
    const current = context.store.read(record.id);
    if (current.revision !== record.revision) return changedSincePreview();
    const next = bumpRevision(built.next, context.now.toISOString(), built.kind, changes, reason);
    context.store.write(next);
    return { ok: true, status: "saved", action, contract: summarizeContract(next, context), telegramText: formatChangeSaved(action, next, context) };
  });
}

function systemChanges(before, after) {
  return ["status", "endedOn", "endReason", "monitoring"]
    .filter((key) => canonicalJson(before[key]) !== canonicalJson(after[key]))
    .map((key) => ({ field: key, from: before[key] ?? null, to: after[key] ?? null }));
}

function bumpRevision(record, at, kind, changes, reason) {
  const revision = record.revision + 1;
  return { ...record, revision, updatedAt: at, history: [...record.history, { at, revision, kind, changes, reason }] };
}

function resolveSelector(records, payload, options) {
  const hasId = payload.id !== undefined;
  const hasTarget = payload.target !== undefined;
  if (hasId === hasTarget) return invalid(["id or target: give exactly one (an id from list, or the user's words for the contract)"]);
  if (hasId && (typeof payload.id !== "string" || !CONTRACT_ID_PATTERN.test(payload.id))) return invalid(["id: looks like ct-1a2b3c4d"]);
  if (hasTarget && (typeof payload.target !== "string" || payload.target.length > 80)) return invalid(["target: must be the user's words for the contract, at most 80 characters"]);
  const resolution = resolveContract(records, hasId ? { id: payload.id } : { target: payload.target }, options);
  if (resolution.status === "resolved") return resolution;
  if (resolution.status === "none") {
    return { ok: false, status: "not_found", telegramText: "I couldn't find that contract in your register.", candidates: [] };
  }
  return {
    ok: false,
    status: "ambiguous",
    candidates: resolution.candidates.map((record) => ({ id: record.id, name: describeContractName(record) })),
    telegramText: `Which one do you mean? ${resolution.candidates.map((record) => describeContractName(record)).join("; ")}.`,
    guidance: "Nothing was changed. Ask the user which contract they mean, then run the command again with its id.",
  };
}

function approvalRefusal(approval, digest) {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) return invalid(["approval: must be {digest, replyText}"]);
  if (approval.digest !== digest) return changedSincePreview();
  if (!isApprovalMessage(approval.replyText, { hasPendingApproval: true })) {
    return {
      ok: false,
      status: "not_approved",
      message: "The reply is not a plain yes, so nothing was saved. Ask the user to confirm the shown details, or make the change they asked for and show a new preview.",
    };
  }
  return null;
}

function changedSincePreview() {
  return {
    ok: false,
    status: "changed_since_preview",
    message: "These details differ from what the user was shown, or the contract changed since. Nothing was saved. Run the command again without approval and show the new preview.",
  };
}

function duplicateResult(draft, duplicates) {
  return {
    ok: false,
    status: "duplicate",
    candidates: duplicates.map((record) => ({ id: record.id, name: describeContractName(record) })),
    telegramText: `You already have ${describeContractName(duplicates[0])} in your register. Is this the same contract (I'll update it), or a second one (give it a label, such as the car or the address)?`,
    guidance: "Nothing was saved. Update the existing contract, or add this one with a distinguishing label.",
  };
}

function invalid(problems) {
  return { ok: false, status: "invalid", problems, message: "Nothing was saved. Fix every listed problem and run the command again; never guess a value the user or document did not give." };
}

// --- Questions -------------------------------------------------------------------

/**
 * What is materially missing, most important first. Only gaps that change a
 * deadline or a comparison are asked about; a contract is saved without them
 * and the gaps stay recorded as unknown.
 */
export function intakeQuestions(fields) {
  const questions = [];
  const renews = fields.autoRenewal !== "no";
  const variablePrice = fields.category === "electricity" && ["variable", "spot"].includes(fields.terms?.priceModel);
  if (fields.renewalDate === null) questions.push({ field: "renewalDate", question: "When does it renew or end?" });
  if (isIsoDate(fields.renewalDate) && renews && fields.noticePeriod === null && !isIsoDate(fields.cancellationDeadline)) {
    questions.push({ field: "noticePeriod", question: "Is there a notice period for cancelling? The terms or renewal notice usually say." });
  }
  if (isIsoDate(fields.renewalDate) && fields.autoRenewal === "unknown") questions.push({ field: "autoRenewal", question: "Does it renew automatically?" });
  if (fields.currentPrice === null && !variablePrice) questions.push({ field: "currentPrice", question: "What does it cost now?" });
  if (fields.nextPrice === null && (isIsoDate(fields.discountEndDate) || isIsoDate(fields.priceGuaranteeEndDate))) {
    questions.push({ field: "nextPrice", question: "Do you know the price after the discount or guarantee ends?" });
  }
  if (fields.category === "electricity") {
    if (!fields.terms?.agreement) questions.push({ field: "terms.agreement", question: "Is this your electricity supplier (elhandel) or your grid operator (elnät)?" });
    if (!fields.terms?.annualConsumptionKwh) questions.push({ field: "terms.annualConsumptionKwh", question: "About how many kWh do you use a year? It's on your bill." });
  }
  if (INSURANCE.includes(fields.category) && !fields.terms?.deductible) questions.push({ field: "terms.deductible", question: "What's the deductible (självrisk)?" });
  return questions;
}

// --- Text ------------------------------------------------------------------------

export function formatInt(value) {
  const sign = value < 0 ? "-" : "";
  return `${sign}${String(Math.abs(Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`;
}

/** "5 400 SEK", "129,90 SEK": spaces between thousands and a decimal comma, as in Swedish. */
export function formatMoney({ amount, currency }) {
  const cents = Math.round(amount * 100);
  const whole = formatInt(Math.trunc(cents / 100));
  return `${cents % 100 === 0 ? whole : `${whole},${String(Math.abs(cents % 100)).padStart(2, "0")}`} ${currency}`;
}

/** A price per year, or null when unknown. */
export function annualPrice(price) {
  return price ? { amount: Math.round(price.amount * PRICE_PERIODS[price.period] * 100) / 100, currency: price.currency } : null;
}

/** "5 400 SEK a year", or "399 SEK a month (4 788 SEK a year)". */
export function formatPrice(price) {
  const base = `${formatMoney(price)} a ${price.period}`;
  return price.period === "year" ? base : `${base} (${formatMoney(annualPrice(price))} a year)`;
}

export function describeContractName(record) {
  const category = CONTRACT_CATEGORIES[record.category].label;
  return `${category} (${record.provider}${record.label ? `, ${record.label}` : ""})`;
}

const KEY_DATE_TEXT = {
  cancellation_deadline: "last day to cancel",
  notice_deadline: "last day to give notice",
  discount_end: "discount ends",
  price_guarantee_end: "price guarantee ends",
  binding_end: "binding period ends",
};

/** "discount ends 1 Mar 2027", "last day to give notice 30 Jan 2027 (30 days' notice, not checked against the terms)". */
export function describeKeyDate(entry, { record, today, withDate = true }) {
  const label =
    entry.kind === "renewal"
      ? { yes: "renews", no: "ends", unknown: "renews or ends" }[record.autoRenewal]
      : KEY_DATE_TEXT[entry.kind];
  const notes = [];
  if (entry.kind === "notice_deadline") notes.push(`${entry.basis}${entry.provisional ? ", not checked against the terms" : ""}`);
  if (entry.kind === "renewal" && entry.provisional) notes.push("notice period unknown, so the real deadline may be earlier");
  return `${label}${withDate ? ` ${formatContractDate(entry.date, { today })}` : ""}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
}

function priceSummary(record) {
  if (record.currentPrice) return formatPrice(record.currentPrice);
  if (record.category === "electricity" && ["variable", "spot"].includes(record.terms?.priceModel)) return "variable price";
  return "price unknown";
}

const TERM_DATE_LINES = [
  ["discountEndDate", "Discount ends", "Discount"],
  ["priceGuaranteeEndDate", "Price guarantee ends", "Price guarantee"],
  ["bindingEndDate", "Binding period ends", "Binding period"],
  ["cancellationDeadline", "Last day to cancel", "Cancellation deadline"],
];

/** The record as the user sees it in a preview or a detail view. Unknowns that matter are said, never filled. */
export function formatContractLines(fields, { today }) {
  const lines = [`${CONTRACT_CATEGORIES[fields.category].label} · ${fields.provider}${fields.product ? ` — ${fields.product}` : ""}${fields.label ? ` (${fields.label})` : ""}`];
  lines.push(`Price: ${priceSummary(fields)}`);
  if (fields.nextPrice) lines.push(`Then: ${formatPrice(fields.nextPrice)}${fields.nextPrice.basis ? ` (${fields.nextPrice.basis})` : ""}`);
  if (isIsoDate(fields.renewalDate)) {
    const renewal = { yes: "Renews automatically", no: "Ends (doesn't renew)", unknown: "Renews or ends" }[fields.autoRenewal];
    lines.push(`${renewal}: ${formatContractDate(fields.renewalDate, { today })}`);
  } else if (fields.renewalDate === "none") lines.push("Renewal: none (runs until cancelled)");
  for (const [key, label, noneLabel] of TERM_DATE_LINES) {
    if (fields[key] === "none") lines.push(`${noneLabel}: none`);
    else if (isIsoDate(fields[key])) lines.push(`${label}: ${formatContractDate(fields[key], { today })}`);
  }
  if (fields.noticePeriod) {
    lines.push(`Notice period: ${describeNoticeLength(fields.noticePeriod)}${fields.noticePeriod.verified ? "" : " (not checked against the terms)"}`);
  }
  const terms = Object.entries(fields.terms ?? {}).map(([key, value]) => `${TERM_FIELDS[key].label}: ${formatTermValue(key, value)}`);
  if (terms.length > 0) lines.push(terms.join(" · "));
  if (fields.startDate) lines.push(`Started: ${formatContractDate(fields.startDate, { today })}`);
  if (fields.notes) lines.push(`Notes: ${fields.notes}`);
  return lines;
}

function formatTermValue(key, value) {
  const spec = TERM_FIELDS[key];
  if (spec.kind === "money") return formatMoney(value);
  if (spec.kind === "list") return value.join(", ");
  if (spec.kind === "boolean") return value ? "yes" : "no";
  if (key === "agreement") return value === "supply" ? "supply (elhandel)" : "grid (elnät)";
  if (spec.kind === "data") return value === "unlimited" ? "unlimited" : `${value} GB`;
  return spec.unit ? `${String(value).replace(".", ",")} ${spec.unit}` : String(value);
}

function unknownsLine(fields) {
  const unknown = intakeQuestions(fields).map(({ field }) => ({
    renewalDate: "renewal date",
    noticePeriod: "notice period",
    autoRenewal: "whether it renews automatically",
    currentPrice: "current price",
    nextPrice: isIsoDate(fields.discountEndDate) ? "price after the discount" : "price after the price guarantee",
    "terms.agreement": "supplier or grid agreement",
    "terms.annualConsumptionKwh": "yearly use in kWh",
    "terms.deductible": "deductible",
  })[field]);
  return unknown.length > 0 ? `Not known yet: ${unknown.join(", ")}.` : null;
}

function watchLine(monitoring) {
  if (!monitoring.enabled) return "Renewal watch: off";
  return RENEWAL_WATCH_LIVE ? "Renewal watch: on" : "Renewal watch: on (alerts start once the renewal watch is switched on)";
}

function formatAddPreview(draft, { today }) {
  const lines = ["Here's what I'd save to your contract register:", "", ...formatContractLines(draft, { today }), watchLine(draft.monitoring)];
  const unknown = unknownsLine(draft);
  if (unknown) lines.push("", unknown);
  lines.push("", "Save it? It stays in a private register on this computer and is used only for your renewals. Reply yes to save, or tell me what to change.");
  return lines.join("\n");
}

function formatSaved(record, { today }) {
  const next = nextKeyDate(record, { today });
  const lines = [`Saved to your private contract register: ${describeContractName(record)}.`];
  if (next) lines.push(`Next: ${describeKeyDate(next, { record, today })}.`);
  else if (!isIsoDate(record.renewalDate)) lines.push("It has no upcoming dates yet; tell me when it renews or ends and I'll add it.");
  if (record.monitoring.enabled && !RENEWAL_WATCH_LIVE) lines.push("Renewal alerts aren't switched on yet. Until then, ask me any time what's coming up.");
  return lines.join("\n");
}

function formatChangeValue(field, value, { today }) {
  if (value === null || value === undefined) return "unknown";
  if (value === "none") return "none";
  if (DATE_FIELDS.includes(field) || field === "endedOn") return formatContractDate(value, { today });
  if (field === "currentPrice" || field === "nextPrice") return formatPrice(value);
  if (field === "noticePeriod") return `${describeNoticeLength(value)}${value.verified ? "" : " (not checked)"}`;
  if (field === "terms") {
    const entries = Object.entries(value);
    return entries.length === 0 ? "none" : entries.map(([key, term]) => `${TERM_FIELDS[key].label} ${formatTermValue(key, term)}`).join(", ");
  }
  if (field === "category") return CONTRACT_CATEGORIES[value].label;
  if (field === "monitoring") return value.enabled ? "on" : "off";
  if (field === "source") return value.document ?? value.type.replace("_", " ");
  return String(value);
}

function formatChangePreview(action, before, after, changes, { today }) {
  const title = {
    update: `Change to save for ${describeContractName(before)}:`,
    renew: `Renewal to save for ${describeContractName(before)}:`,
    end: `Mark ${describeContractName(before)} as ended:`,
  }[action];
  const lines = [title];
  for (const change of changes.filter((entry) => !["endReason"].includes(entry.field))) {
    if (change.field === "status") {
      lines.push(`- Status: ended (${after.endReason}${after.endedOn ? `, ${formatContractDate(after.endedOn, { today })}` : ""})`);
      continue;
    }
    if (change.field === "endedOn") continue;
    lines.push(`- ${FIELD_LABELS[change.field]}: ${formatChangeValue(change.field, change.from, { today })} → ${formatChangeValue(change.field, change.to, { today })}`);
  }
  if (action === "end") lines.push("This only updates your register; it doesn't cancel anything with the provider.");
  lines.push("", "Save this? Reply yes to save, or tell me what to change.");
  return lines.join("\n");
}

function formatChangeSaved(action, record, { today }) {
  if (action === "end") return `Marked ${describeContractName(record)} as ended in your register. Its history is kept and it's no longer watched.`;
  const next = nextKeyDate(record, { today });
  return [`Saved: ${describeContractName(record)} is updated.`, next ? `Next: ${describeKeyDate(next, { record, today })}.` : null].filter(Boolean).join("\n");
}

function formatMonitoring(record) {
  if (!record.monitoring.enabled) return `Renewal watch is off for ${describeContractName(record)}. Its details stay in your register.`;
  return RENEWAL_WATCH_LIVE
    ? `Renewal watch is on for ${describeContractName(record)}.`
    : `Noted: watch ${describeContractName(record)}. Renewal alerts aren't switched on yet; until then, ask me any time what's coming up.`;
}

/** What a list or another command may hand back about one contract. */
export function summarizeContract(record, { today }) {
  const next = nextKeyDate(record, { today });
  return {
    id: record.id,
    name: describeContractName(record),
    category: record.category,
    provider: record.provider,
    product: record.product,
    label: record.label,
    status: record.status,
    price: record.currentPrice,
    annualPrice: annualPrice(record.currentPrice),
    nextDate: next ? { kind: next.kind, date: next.date, provisional: next.provisional, text: describeKeyDate(next, { record, today }) } : null,
    monitoring: record.monitoring.enabled,
  };
}

export function formatContractList(records, issues, { today, all = false }) {
  const active = records.filter((record) => record.status === "active");
  const ended = records.filter((record) => record.status === "ended");
  const lines = [];
  if (active.length === 0) lines.push("Your contract register is empty.");
  else {
    lines.push(`Your contracts (${active.length})`);
    for (const record of sortForList(active, today)) {
      const next = nextKeyDate(record, { today });
      lines.push(`- ${CONTRACT_CATEGORIES[record.category].label} · ${record.provider}${record.label ? ` (${record.label})` : ""}: ${priceSummary(record)} · ${next ? describeKeyDate(next, { record, today }) : "no upcoming dates"}`);
    }
  }
  if (all && ended.length > 0) {
    lines.push("", "Ended");
    for (const record of ended) {
      lines.push(`- ${CONTRACT_CATEGORIES[record.category].label} · ${record.provider}: ${record.endReason}${record.endedOn ? ` ${formatContractDate(record.endedOn, { today })}` : ""}`);
    }
  } else if (ended.length > 0) lines.push(`(${ended.length} ended contract${ended.length === 1 ? "" : "s"} not shown.)`);
  if (issues.length > 0) lines.push("", issueSentence(issues));
  return lines.join("\n");
}

function sortForList(records, today) {
  return [...records].sort((left, right) => {
    const a = nextKeyDate(left, { today })?.date ?? "9999";
    const b = nextKeyDate(right, { today })?.date ?? "9999";
    return a.localeCompare(b) || left.provider.localeCompare(right.provider);
  });
}

function issueSentence(issues) {
  return `${issues.length === 1 ? "One contract record" : `${issues.length} contract records`} couldn't be read, so ${issues.length === 1 ? "it isn't" : "they aren't"} shown. Ask me to check the contract register.`;
}

export function formatContractDetail(record, { today }) {
  const lines = formatContractLines(record, { today });
  lines.push(record.status === "ended" ? `Status: ended (${record.endReason}${record.endedOn ? `, ${formatContractDate(record.endedOn, { today })}` : ""})` : watchLine(record.monitoring));
  const upcoming = contractKeyDates(record).filter((entry) => entry.date >= today);
  if (record.status === "active" && upcoming.length > 0) lines.push(`Coming up: ${upcoming.map((entry) => describeKeyDate(entry, { record, today })).join("; ")}.`);
  const unknown = record.status === "active" ? unknownsLine(record) : null;
  if (unknown) lines.push(unknown);
  const history = record.history.slice(-3).map((entry) => `${formatContractDate(entry.at.slice(0, 10), { today })} ${entry.kind}`);
  lines.push(`History: ${history.join(" · ")}`);
  return lines.join("\n");
}

/** Every date of the active contracts from today to `days` ahead, earliest first. */
export function upcomingContractDates(records, { today, days }) {
  const until = addDays(today, days);
  const entries = [];
  for (const record of records.filter((candidate) => candidate.status === "active")) {
    for (const entry of contractKeyDates(record)) {
      if (entry.date >= today && entry.date <= until) entries.push({ record, entry, daysLeft: daysBetween(today, entry.date) });
    }
  }
  return entries.sort((left, right) => left.entry.date.localeCompare(right.entry.date));
}

export function formatUpcoming(records, issues, { today, days }) {
  const entries = upcomingContractDates(records, { today, days });
  const lines = [];
  if (entries.length === 0) lines.push(`Nothing in your contracts in the next ${days} days.`);
  else {
    lines.push(`Coming up in the next ${days} days`);
    for (const { record, entry, daysLeft } of entries) {
      const when = daysLeft === 0 ? "today" : `in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
      lines.push(`- ${formatContractDate(entry.date, { today })} (${when}): ${CONTRACT_CATEGORIES[record.category].label} · ${record.provider} — ${describeKeyDate(entry, { record, today, withDate: false })}`);
    }
  }
  const undated = records.filter((record) => record.status === "active" && !contractKeyDates(record).some((entry) => entry.date >= today));
  if (undated.length > 0) lines.push("", `No upcoming dates known for: ${undated.map((record) => describeContractName(record)).join("; ")}.`);
  if (issues.length > 0) lines.push("", issueSentence(issues));
  return lines.join("\n");
}

/** A redacted health view: counts and problems, never contract details. */
export function registerStatus(store) {
  const { records, issues } = store.listWithIssues();
  const permissions = store.permissionProblems();
  const active = records.filter((record) => record.status === "active");
  return {
    contracts: records.length,
    active: active.length,
    ended: records.length - active.length,
    watched: active.filter((record) => record.monitoring.enabled).length,
    unreadable: issues.map((issue) => ({ file: issue.file, reason: issue.reason })),
    permissions: { ok: permissions.length === 0, problems: permissions },
  };
}

export function formatRegisterStatus(status) {
  const lines = [
    status.contracts === 0
      ? "Contract register: empty."
      : `Contract register: ${status.contracts} contract${status.contracts === 1 ? "" : "s"} (${status.active} active, ${status.ended} ended), ${status.watched} with the renewal watch on.`,
    status.permissions.ok ? "Storage: private (owner-only folder and files)." : `Storage: ${status.permissions.problems.length} path(s) readable by others; run the register check again after fixing permissions.`,
  ];
  if (status.unreadable.length > 0) {
    lines.push(`Unreadable: ${status.unreadable.map((issue) => `${issue.file} (${issue.reason})`).join("; ")}. Remove it with the user's OK, or fix the file.`);
  }
  if (!RENEWAL_WATCH_LIVE) lines.push("Renewal alerts: not switched on yet.");
  return lines.join("\n");
}
