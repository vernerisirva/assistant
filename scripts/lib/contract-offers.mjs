/**
 * Comparing a contract with alternative offers. Pure: no network, files or
 * clock of its own.
 *
 * The research agent gathers the evidence; this module decides what it may be
 * called. Every offer carries one evidence level:
 *
 * - personalized_quote: a quote for the user's own details and cover. Hilla
 *   never fills in quote forms, so only the user can obtain one, and it must
 *   come from them in chat;
 * - published: a standard public price list or tariff that anyone gets. Never
 *   for insurance, whose premiums depend on the person, car or home;
 * - indicative: a promotion, "from" price, example or comparison-site figure;
 * - estimate: a calculation from a stated basis;
 * - unavailable: no trustworthy price, only a page to ask for one.
 *
 * Costs are compared over the same twelve months from the day the change would
 * take effect, counting introductory months, one-time fees and the price after
 * a discount ends. Electricity compares like with like: market-priced
 * (spot or variable) contracts on what the supplier adds to the market price,
 * fixed-price contracts on their whole cost, and only supply agreements.
 * An offer is like-for-like only when its cover, speed, data or price model
 * matches and nothing material is unknown. An unknown cost is never zero, and
 * a difference is stated only between complete, like-for-like costs.
 *
 * The recommendation follows fixed rules from these facts, never from the
 * research agent's opinion, and switching is suggested only on a published
 * price or the user's own quote that is like-for-like and clearly cheaper.
 */
import { checkLink } from "./travel-deals.mjs";
import {
  CURRENCIES,
  PRICE_PERIODS,
  TERM_FIELDS,
  annualPrice,
  checkContractText,
  describeContractName,
  formatMoney,
  formatPrice,
  normalizeContractFields,
} from "./contracts.mjs";
import { NOTICE_UNITS, describeNoticePeriod, formatContractDate, isIsoDate } from "./contract-dates.mjs";

export const EVIDENCE_LEVELS = Object.freeze(["personalized_quote", "published", "indicative", "estimate", "unavailable"]);
export const RECOMMENDATIONS = Object.freeze(["keep", "negotiate", "request_quote", "consider_switching", "insufficient_information"]);
export const MAX_OFFERS = 3;
/** A difference is material from this much a year (in SEK), or this share of the current cost, whichever is larger. */
export const MATERIAL_SEK = 300;
export const MATERIAL_SHARE = 0.05;

const EQUIVALENCE = ["equivalent", "better", "worse", "unknown"];
const ELIGIBILITY = ["open", "new_customers_only", "conditions_apply", "unknown"];
const INSURANCE = new Set(["car_insurance", "home_insurance", "pet_insurance", "other_insurance"]);
const MARKET_MODELS = new Set(["variable", "spot"]);
// Deadlines at which the price changes or the term renews: from then the price after the change applies.
const PRICE_CHANGE_KINDS = new Set(["discount_end", "price_guarantee_end", "renewal", "notice_deadline", "cancellation_deadline"]);
const OFFER_KEYS = ["id", "provider", "product", "evidence", "price", "intro", "oneTimeFees", "binding", "noticePeriod", "terms", "equivalence", "differences", "eligibility", "source", "checkedAt", "quoteLink", "basis"];
const SUBMISSION_KEYS = ["request", "contractId", "checkedAt", "offers", "consumption", "spotPrice", "currentExitFee", "limitations", "sources"];
const MAX_AGE_MS = 14 * 86_400_000;
const CLOCK_SKEW_MS = 5 * 60_000;

// --- Checking the research -------------------------------------------------------

/**
 * Checks what the research agent found. `origin` is "watch" for the
 * scheduled research and "chat" when the user asked; only chat research can
 * carry the user's own quote. Problems name the field, never echo its text.
 */
export function normalizeResearch(input, { contract, origin, now }) {
  const problems = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { value: null, problems: ["the research must be a JSON object"] };
  for (const key of Object.keys(input)) if (!SUBMISSION_KEYS.includes(key)) problems.push(`${key}: unknown key (allowed: ${SUBMISSION_KEYS.join(", ")})`);
  const value = { checkedAt: null, offers: [], consumption: null, spotPrice: null, currentExitFee: null, limitations: [], sources: [] };
  const electricity = contract.category === "electricity";

  const checkedAt = checkTime(input.checkedAt, now);
  if (checkedAt.problem) problems.push(`checkedAt: ${checkedAt.problem}`);
  else value.checkedAt = checkedAt.value;

  if (electricity && contract.terms?.agreement === "grid") {
    problems.push("this is a grid agreement (elnät), which can't be moved to another company; there is nothing to compare");
  }
  if (!Array.isArray(input.offers) || input.offers.length > MAX_OFFERS) {
    problems.push(`offers: must be a list of at most ${MAX_OFFERS} offers (an empty list when nothing usable was found)`);
  } else {
    input.offers.forEach((raw, index) => {
      const offer = normalizeOffer(raw, index, { contract, origin, now, problems });
      if (offer) value.offers.push(offer);
    });
  }
  const providers = value.offers.map((offer) => offer.provider.toLowerCase());
  if (new Set(providers).size !== providers.length) problems.push("offers: list each provider once, with its best matching plan");

  if (input.consumption !== undefined && input.consumption !== null) {
    if (!electricity) problems.push("consumption: only for electricity");
    else {
      const consumption = input.consumption;
      if (!consumption || !Number.isInteger(consumption.kwh) || consumption.kwh < 100 || consumption.kwh > 200_000 || !["user", "assumption"].includes(consumption.source)) {
        problems.push('consumption: must be {"kwh": 9000, "source": "user" or "assumption", "basis": "..."}');
      } else {
        const basis = consumption.basis === undefined ? { value: null } : checkContractText(consumption.basis, { max: 80 });
        if (basis.problem) problems.push(`consumption.basis: ${basis.problem}`);
        else if (consumption.source === "assumption" && !basis.value) problems.push("consumption.basis: say what the assumed yearly use is based on");
        else value.consumption = { kwh: consumption.kwh, source: consumption.source, basis: basis.value };
      }
    }
  }
  if (input.spotPrice !== undefined && input.spotPrice !== null) {
    if (!electricity) problems.push("spotPrice: only for electricity");
    else {
      const spot = input.spotPrice;
      const link = checkLink(spot?.source);
      const time = checkTime(spot?.checkedAt, now);
      const basis = checkContractText(spot?.basis, { max: 80 });
      if (typeof spot?.orePerKwh !== "number" || !Number.isFinite(spot.orePerKwh) || spot.orePerKwh < 0 || spot.orePerKwh > 1000) problems.push("spotPrice.orePerKwh: must be a number from 0 to 1000");
      else if (link.problem) problems.push(`spotPrice.source: ${link.problem}`);
      else if (time.problem) problems.push(`spotPrice.checkedAt: ${time.problem}`);
      else if (basis.problem) problems.push(`spotPrice.basis: ${basis.problem} (such as "SE4 average over the last 12 months")`);
      else value.spotPrice = { orePerKwh: spot.orePerKwh, source: link.value, checkedAt: time.value, basis: basis.value };
    }
  }
  if (input.currentExitFee !== undefined && input.currentExitFee !== null) {
    const fee = input.currentExitFee;
    const basis = checkContractText(fee?.basis, { max: 80 });
    if (typeof fee?.amount !== "number" || !Number.isFinite(fee.amount) || fee.amount < 0 || fee.amount > 100_000) problems.push("currentExitFee.amount: must be a number from 0 to 100000");
    else if (basis.problem) problems.push(`currentExitFee.basis: ${basis.problem}`);
    else value.currentExitFee = { amount: fee.amount, basis: basis.value };
  }
  value.limitations = textList(input.limitations, { field: "limitations", max: 4, itemMax: 160, problems });
  if (input.sources !== undefined) {
    if (!Array.isArray(input.sources) || input.sources.length > 10) problems.push("sources: must be a list of at most 10 {url, checkedAt}");
    else {
      for (const [index, source] of input.sources.entries()) {
        const link = checkLink(source?.url);
        const time = checkTime(source?.checkedAt, now);
        if (link.problem) problems.push(`sources[${index}].url: ${link.problem}`);
        else if (time.problem) problems.push(`sources[${index}].checkedAt: ${time.problem}`);
        else value.sources.push({ url: link.value, checkedAt: time.value });
      }
    }
  }
  if (electricity && value.offers.length > 0) {
    const bases = new Set(value.offers.filter((offer) => offer.evidence !== "unavailable").map((offer) => offer.terms.pricesIncludeVat));
    if (bases.size > 1) problems.push("offers: give every electricity price on the same VAT basis (all including VAT, or all excluding it)");
  }
  return { value, problems };
}

function normalizeOffer(raw, index, { contract, origin, now, problems }) {
  const at = `offers[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    problems.push(`${at}: must be an object`);
    return null;
  }
  const before = problems.length;
  const fail = (field, message) => problems.push(`${at}.${field}: ${message}`);
  for (const key of Object.keys(raw)) if (!OFFER_KEYS.includes(key)) fail(key, `unknown key (allowed: ${OFFER_KEYS.join(", ")})`);
  const expectedId = String.fromCharCode(65 + index);
  if (raw.id !== expectedId) fail("id", `must be "${expectedId}"`);
  const provider = checkContractText(raw.provider, { max: 60 });
  if (provider.problem) fail("provider", provider.problem);
  const product = raw.product === undefined || raw.product === null ? { value: null } : checkContractText(raw.product, { max: 80 });
  if (product.problem) fail("product", product.problem);
  if (!EVIDENCE_LEVELS.includes(raw.evidence)) fail("evidence", `must be ${EVIDENCE_LEVELS.join(", ")}`);
  const evidence = raw.evidence;
  const electricity = contract.category === "electricity";
  const currency = contract.currentPrice?.currency ?? contract.nextPrice?.currency ?? "SEK";

  // Where the number came from decides what it may be called.
  const fromUser = raw.source === "user";
  const source = fromUser ? { value: "user" } : checkLink(raw.source);
  if (source.problem) fail("source", `${source.problem} (the provider's own page, or "user" for an offer the user sent)`);
  if (evidence === "personalized_quote" && !(origin === "chat" && fromUser)) {
    fail("evidence", 'a personalized quote is one the user got for their own details and sent you, so it needs "source": "user" in a chat request; Hilla never requests one');
  }
  if (evidence === "published" && INSURANCE.has(contract.category)) {
    fail("evidence", "an insurance premium depends on the person, car or home, so a public figure is indicative at most, never published or a quote");
  }
  if (evidence === "published" && fromUser) fail("evidence", "an offer the user sent is indicative until you find the same price on the provider's own page");
  const checkedAt = checkTime(raw.checkedAt, now);
  if (checkedAt.problem) fail("checkedAt", checkedAt.problem);
  const basis = raw.basis === undefined || raw.basis === null ? { value: null } : checkContractText(raw.basis, { max: 120 });
  if (basis.problem) fail("basis", basis.problem);
  if (evidence === "estimate" && !basis.value) fail("basis", "an estimate needs the basis it was worked out from");

  let price = null;
  if (raw.price !== undefined && raw.price !== null) {
    if (evidence === "unavailable") fail("price", "an unavailable offer has no price");
    else {
      price = checkPrice(raw.price, currency);
      if (price.problem) fail("price", price.problem);
      price = price.value ?? null;
    }
  } else if (evidence !== "unavailable" && !electricity) fail("price", "is required unless the price is unavailable");

  let intro = null;
  if (raw.intro !== undefined && raw.intro !== null) {
    const ok = raw.intro && typeof raw.intro.amount === "number" && Number.isFinite(raw.intro.amount) && raw.intro.amount >= 0 && Number.isInteger(raw.intro.months) && raw.intro.months >= 1 && raw.intro.months <= 24;
    if (!ok || Object.keys(raw.intro).some((key) => !["amount", "months"].includes(key))) fail("intro", "must be {amount: a monthly price, months: 1-24}");
    else if (evidence === "unavailable" || (!price && !electricity)) fail("intro", "needs the regular price after the introductory months");
    else intro = { amount: raw.intro.amount, months: raw.intro.months, currency };
  }

  const oneTimeFees = [];
  if (raw.oneTimeFees !== undefined) {
    if (!Array.isArray(raw.oneTimeFees) || raw.oneTimeFees.length > 4) fail("oneTimeFees", "must be a list of at most 4 {label, amount}");
    else {
      for (const [feeIndex, fee] of raw.oneTimeFees.entries()) {
        const label = checkContractText(fee?.label, { max: 40 });
        if (label.problem) fail(`oneTimeFees[${feeIndex}].label`, label.problem);
        else if (typeof fee.amount !== "number" || !Number.isFinite(fee.amount) || fee.amount < 0 || fee.amount > 100_000) fail(`oneTimeFees[${feeIndex}].amount`, "must be a number from 0 to 100000");
        else oneTimeFees.push({ label: label.value, amount: fee.amount, currency });
      }
    }
  }

  let binding = null;
  if (raw.binding !== undefined && raw.binding !== null) {
    if (!raw.binding || !Number.isInteger(raw.binding.months) || raw.binding.months < 0 || raw.binding.months > 36) fail("binding", "must be {months: 0-36}, or null when not stated");
    else binding = { months: raw.binding.months };
  }
  let noticePeriod = null;
  if (raw.noticePeriod !== undefined && raw.noticePeriod !== null) {
    const notice = raw.noticePeriod;
    if (!notice || !NOTICE_UNITS.includes(notice.unit) || !Number.isInteger(notice.value) || notice.value < 1 || notice.value > (notice.unit === "days" ? 365 : 24)) {
      fail("noticePeriod", "must be {value, unit: days, months or calendar_months}");
    } else noticePeriod = { value: notice.value, unit: notice.unit };
  }

  const terms = normalizeContractFields({ terms: raw.terms ?? {} }, { category: contract.category });
  if (terms.problems.length > 0) for (const problem of terms.problems) fail("terms", problem.replace(/^terms: /, ""));
  const offerTerms = terms.value?.terms ?? {};
  if (electricity && evidence !== "unavailable") {
    const model = offerTerms.priceModel;
    if (!model) fail("terms.priceModel", "is required for an electricity offer (fixed, variable or spot)");
    else if (model === "fixed" && offerTerms.fixedPriceOrePerKwh === undefined) fail("terms.fixedPriceOrePerKwh", "is required for a fixed-price offer");
    else if (MARKET_MODELS.has(model) && offerTerms.markupOrePerKwh === undefined) fail("terms.markupOrePerKwh", "is required for a spot or variable offer (0 when the supplier adds nothing)");
    if (offerTerms.monthlyFeeSek === undefined) fail("terms.monthlyFeeSek", "is required (0 when there is no fixed fee)");
    if (typeof offerTerms.pricesIncludeVat !== "boolean") fail("terms.pricesIncludeVat", "say whether the prices include VAT");
    if (offerTerms.agreement === "grid") fail("terms.agreement", "only electricity supply (elhandel) can be compared");
    if (price) fail("price", "electricity offers are priced by their terms (fixed price or markup, and the monthly fee), not a single price");
  }

  if (!EQUIVALENCE.includes(raw.equivalence)) fail("equivalence", `must be ${EQUIVALENCE.join(", ")}: how its cover or service compares with the current contract`);
  if (!ELIGIBILITY.includes(raw.eligibility)) fail("eligibility", `must be ${ELIGIBILITY.join(", ")}`);
  const differences = textList(raw.differences, { field: `${at}.differences`, max: 4, itemMax: 120, problems });
  let quoteLink = null;
  if (raw.quoteLink !== undefined && raw.quoteLink !== null) {
    const link = checkLink(raw.quoteLink);
    if (link.problem) fail("quoteLink", link.problem);
    else quoteLink = link.value;
  }
  if (problems.length > before) return null;
  return {
    id: raw.id,
    provider: provider.value,
    product: product.value,
    evidence,
    price,
    intro,
    oneTimeFees,
    binding,
    noticePeriod,
    terms: offerTerms,
    equivalence: raw.equivalence,
    differences,
    eligibility: raw.eligibility,
    source: source.value,
    checkedAt: checkedAt.value,
    quoteLink,
    basis: basis.value,
  };
}

function checkPrice(raw, currency) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problem: "must be {amount, currency, period}" };
  if (Object.keys(raw).some((key) => !["amount", "currency", "period"].includes(key))) return { problem: "takes only amount, currency and period" };
  if (typeof raw.amount !== "number" || !Number.isFinite(raw.amount) || raw.amount < 0 || raw.amount > 1_000_000) return { problem: "amount must be a number from 0 to 1000000" };
  const priceCurrency = raw.currency ?? "SEK";
  if (!CURRENCIES.includes(priceCurrency)) return { problem: `currency must be ${CURRENCIES.join(", ")}` };
  if (priceCurrency !== currency) return { problem: `must be in ${currency}, like the current contract; convert it only with a stated rate in basis, as an estimate` };
  if (!PRICE_PERIODS[raw.period]) return { problem: `period must be ${Object.keys(PRICE_PERIODS).join(", ")}` };
  return { value: { amount: raw.amount, currency: priceCurrency, period: raw.period } };
}

function checkTime(value, now) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    return { problem: "must be a UTC time such as 2026-12-01T09:30:00Z" };
  }
  const at = Date.parse(value);
  if (at > now.getTime() + CLOCK_SKEW_MS) return { problem: "is in the future; give the UTC time you checked (Stockholm time with a Z is an hour or two ahead)" };
  if (at < now.getTime() - MAX_AGE_MS) return { problem: "is more than 14 days old; check the page again" };
  return { value: new Date(at).toISOString() };
}

function textList(raw, { field, max, itemMax, problems }) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > max) {
    problems.push(`${field}: must be a list of at most ${max} short texts`);
    return [];
  }
  const items = [];
  for (const [index, item] of raw.entries()) {
    const text = checkContractText(item, { max: itemMax });
    if (text.problem) problems.push(`${field}[${index}]: ${text.problem}`);
    else items.push(text.value);
  }
  return items;
}

// --- Costs over the same twelve months ---------------------------------------------

const round = (amount) => Math.round(amount);
const monthlyOf = (price) => (annualPrice(price).amount / 12);

/** Twelve months of a flat price, with any introductory months and one-time fees. */
function flatYear(price, intro, fees) {
  const introMonths = intro ? Math.min(intro.months, 12) : 0;
  const recurring = (intro ? intro.amount * introMonths : 0) + monthlyOf(price) * (12 - introMonths);
  return round(recurring + fees.reduce((sum, fee) => sum + fee.amount, 0));
}

function marketModel(model) {
  if (model === "fixed") return "fixed";
  return MARKET_MODELS.has(model) ? "market" : null;
}

/**
 * An electricity option's twelve months. Market-priced contracts are compared
 * on what the supplier adds (markup and fees), which is all that differs
 * between them; their full cost is only an illustration with a sourced spot
 * price. Fixed-price contracts are known in full.
 */
function electricityYear(terms, { kwh, spotPrice, fees = [], intro = null }) {
  const model = marketModel(terms.priceModel);
  const feeTotal = fees.reduce((sum, fee) => sum + fee.amount, 0);
  if (!model || kwh === null || terms.monthlyFeeSek === undefined) return { model, charges: null, total: null };
  const monthlyFees = intro ? intro.amount * Math.min(intro.months, 12) + terms.monthlyFeeSek * (12 - Math.min(intro.months, 12)) : terms.monthlyFeeSek * 12;
  if (model === "fixed") {
    if (terms.fixedPriceOrePerKwh === undefined) return { model, charges: null, total: null };
    return { model, charges: null, total: { amount: round((terms.fixedPriceOrePerKwh * kwh) / 100 + monthlyFees + feeTotal), certainty: "known" } };
  }
  if (terms.markupOrePerKwh === undefined) return { model, charges: null, total: null };
  const charges = round((terms.markupOrePerKwh * kwh) / 100 + monthlyFees + feeTotal);
  const total = spotPrice ? { amount: round(((spotPrice.orePerKwh + terms.markupOrePerKwh) * kwh) / 100 + monthlyFees + feeTotal), certainty: "illustration" } : null;
  return { model, charges: { amount: charges, certainty: "known" }, total };
}

/** What staying costs over the twelve months from the change, or why that isn't known. */
function currentSide(contract, deadline, research) {
  const changing = deadline ? PRICE_CHANGE_KINDS.has(deadline.kind) : false;
  if (contract.category === "electricity") {
    const kwh = research.consumption?.kwh ?? contract.terms?.annualConsumptionKwh ?? null;
    if (contract.nextPrice) return { basis: "total", amount: round(annualPrice(contract.nextPrice).amount), certainty: "stated", model: null, note: "the price after the change you gave me" };
    if (changing && deadline.kind === "price_guarantee_end") return { basis: null, amount: null, model: null, note: "the price after your price guarantee ends isn't known" };
    const year = electricityYear(contract.terms ?? {}, { kwh, spotPrice: research.spotPrice });
    if (year.model === "market" && year.charges) return { basis: "charges", amount: year.charges.amount, certainty: "known", model: "market", total: year.total };
    if (year.model === "fixed" && year.total) return { basis: "total", amount: year.total.amount, certainty: "known", model: "fixed" };
    if (contract.currentPrice) return { basis: "total", amount: round(annualPrice(contract.currentPrice).amount), certainty: "stated", model: year.model, note: "from the price you gave me" };
    return { basis: null, amount: null, model: year.model, note: kwh === null ? "your yearly use in kWh isn't known" : "your current prices aren't all known" };
  }
  if (contract.nextPrice) return { basis: "total", amount: round(annualPrice(contract.nextPrice).amount), certainty: "stated", note: "the price after the change" };
  if (changing) return { basis: null, amount: null, note: `the price after ${deadlineEvent(deadline)} isn't known` };
  if (contract.currentPrice) return { basis: "total", amount: round(annualPrice(contract.currentPrice).amount), certainty: "stated", note: "your current price" };
  return { basis: null, amount: null, note: "your current price isn't known" };
}

function deadlineEvent(deadline) {
  return {
    discount_end: "the discount ends",
    price_guarantee_end: "the price guarantee ends",
    renewal: "the renewal",
    notice_deadline: "the renewal",
    cancellation_deadline: "the renewal",
    binding_end: "the binding period",
  }[deadline.kind];
}

/**
 * What stands between an offer and a like-for-like comparison with the
 * current contract: `gaps` to show, and `worse` when it offers less (a higher
 * deductible, a slower line, less data, less cover), which never makes it the
 * one to recommend.
 */
function offerGaps(offer, contract, current) {
  const gaps = [];
  let worse = offer.equivalence === "worse";
  const mine = contract.terms ?? {};
  const theirs = offer.terms;
  if (INSURANCE.has(contract.category)) {
    if (!theirs.deductible || !mine.deductible) gaps.push("deductible not confirmed");
    else if (theirs.deductible.amount > mine.deductible.amount) {
      gaps.push(`higher deductible (${formatMoney(theirs.deductible)} vs ${formatMoney(mine.deductible)})`);
      worse = true;
    }
    if (!theirs.coverage || !mine.coverage) gaps.push("cover not confirmed");
  }
  if (contract.category === "broadband") {
    if (theirs.downloadMbps === undefined || mine.downloadMbps === undefined) gaps.push("speed not confirmed");
    else if (theirs.downloadMbps < mine.downloadMbps || (mine.uploadMbps !== undefined && (theirs.uploadMbps ?? 0) < mine.uploadMbps)) {
      gaps.push("slower than your current connection");
      worse = true;
    }
  }
  if (contract.category === "mobile") {
    if (theirs.dataGb === undefined || mine.dataGb === undefined) gaps.push("data allowance not confirmed");
    else if (mine.dataGb === "unlimited" ? theirs.dataGb !== "unlimited" : theirs.dataGb !== "unlimited" && theirs.dataGb < mine.dataGb) {
      gaps.push("less data than now");
      worse = true;
    }
  }
  if (contract.category === "electricity") {
    if (current.model && offer.model && current.model !== offer.model) gaps.push(offer.model === "fixed" ? "a fixed price, not market-linked like yours" : "market-linked, not fixed like yours");
    if (typeof mine.pricesIncludeVat !== "boolean") gaps.push("whether your current prices include VAT isn't known");
    else if (typeof theirs.pricesIncludeVat === "boolean" && theirs.pricesIncludeVat !== mine.pricesIncludeVat) gaps.push("prices on a different VAT basis");
  }
  if (offer.equivalence === "worse") gaps.push("less cover or service than now");
  if (offer.equivalence === "unknown") gaps.push("cover or service not confirmed");
  if (offer.eligibility === "conditions_apply") gaps.push("conditions apply");
  if (offer.eligibility === "unknown") gaps.push("who qualifies isn't confirmed");
  return { gaps, worse };
}

/** A finished comparison: the current side, each offer with its cost and gaps, and the recommendation. */
export function compareContractOffers({ contract, research: input, deadline = null, origin = "chat", now }) {
  const { value: research, problems } = normalizeResearch(input, { contract, origin, now });
  if (problems.length > 0) return { ok: false, problems };
  const current = currentSide(contract, deadline, research);
  const currency = contract.currentPrice?.currency ?? contract.nextPrice?.currency ?? "SEK";
  const kwh = research.consumption?.kwh ?? contract.terms?.annualConsumptionKwh ?? null;
  const exitFee = research.currentExitFee?.amount ?? 0;

  const offers = research.offers.map((offer) => {
    let cost = null;
    let model = null;
    let illustration = null;
    if (offer.evidence !== "unavailable") {
      if (contract.category === "electricity") {
        const year = electricityYear(offer.terms, { kwh, spotPrice: research.spotPrice, fees: offer.oneTimeFees, intro: offer.intro });
        model = year.model;
        const basis = current.basis === "charges" && model === "market" ? "charges" : "total";
        const figure = basis === "charges" ? year.charges : model === "fixed" ? year.total : null;
        cost = figure ? { basis, amount: figure.amount + exitFee } : null;
        illustration = model === "market" ? year.total : null;
      } else if (offer.price) {
        cost = { basis: "total", amount: flatYear(offer.price, offer.intro, offer.oneTimeFees) + exitFee };
      }
    }
    const withModel = { ...offer, model };
    const { gaps, worse } = offerGaps(withModel, contract, current);
    const comparable = cost !== null && current.amount !== null && cost.basis === current.basis;
    return {
      ...withModel,
      cost,
      illustration,
      gaps,
      worse,
      likeForLike: comparable && gaps.length === 0 && ["equivalent", "better"].includes(offer.equivalence),
      difference: comparable ? current.amount - cost.amount : null,
    };
  });

  return {
    ok: true,
    comparison: {
      category: contract.category,
      currency,
      checkedAt: research.checkedAt,
      deadline,
      current,
      kwh,
      consumption: research.consumption ?? (kwh === null ? null : { kwh, source: "register", basis: null }),
      spotPrice: research.spotPrice,
      currentExitFee: research.currentExitFee,
      offers,
      recommendation: recommend(contract, current, offers),
      limitations: research.limitations,
      sources: research.sources,
    },
  };
}

/** The material difference for this contract: 300 SEK or 5 % a year, whichever is larger. */
export function materialThreshold(amount, currency) {
  const share = Math.abs(amount ?? 0) * MATERIAL_SHARE;
  return currency === "SEK" ? Math.max(MATERIAL_SEK, share) : share;
}

/**
 * Fixed rules, in order:
 * - nothing to compare against (the price after the change is unknown):
 *   insufficient information;
 * - no priced alternative that offers at least as much: negotiate when the
 *   price is about to rise materially, otherwise insufficient information;
 * - no alternative materially cheaper: negotiate when the price is about to
 *   rise materially, otherwise keep;
 * - a materially cheaper like-for-like offer with a published price or the
 *   user's own quote: consider switching;
 * - otherwise request a quote (and ask the current provider to match).
 */
export function recommend(contract, current, offers) {
  const currency = contract.currentPrice?.currency ?? contract.nextPrice?.currency ?? "SEK";
  const rise = contract.currentPrice && contract.nextPrice ? annualPrice(contract.nextPrice).amount - annualPrice(contract.currentPrice).amount : 0;
  const threshold = materialThreshold(current.amount ?? annualPrice(contract.currentPrice)?.amount, currency);
  const risesMaterially = rise >= threshold;
  if (current.amount === null) return { kind: "insufficient_information", offer: null, reason: current.note };
  const priced = offers.filter((offer) => offer.difference !== null && !offer.worse);
  if (priced.length === 0) {
    return risesMaterially
      ? { kind: "negotiate", offer: null, reason: "your price is about to rise and I found no priced alternative" }
      : { kind: "insufficient_information", offer: null, reason: "I found no alternative with a price I could compare" };
  }
  const best = [...priced].sort((left, right) => right.difference - left.difference)[0];
  if (best.difference < threshold) {
    return risesMaterially
      ? { kind: "negotiate", offer: best.difference > 0 ? best.id : null, reason: "no alternative is clearly cheaper, but your price is about to rise" }
      : { kind: "keep", offer: null, reason: "no alternative is clearly better for the same cover" };
  }
  const switchable = priced
    .filter((offer) => offer.likeForLike && ["published", "personalized_quote"].includes(offer.evidence) && ["open", "new_customers_only"].includes(offer.eligibility) && offer.difference >= threshold)
    .sort((left, right) => right.difference - left.difference)[0];
  if (switchable) return { kind: "consider_switching", offer: switchable.id, reason: "a like-for-like offer is clearly cheaper" };
  return { kind: "request_quote", offer: best.id, reason: "a lower price looks possible, but your own terms aren't confirmed" };
}

// --- Text ----------------------------------------------------------------------------

const EVIDENCE_TEXT = {
  personalized_quote: "your quote",
  published: "published price",
  indicative: "indicative, not a quote",
  estimate: "estimate",
  unavailable: "no public price",
};

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function sourceLink(url) {
  return url === "user" ? "from you" : `[${host(url)}](${url})`;
}

function offerName(offer) {
  return `${offer.provider}${offer.product ? `, ${offer.product}` : ""}`;
}

function costText(offer, comparison) {
  const money = (amount) => formatMoney({ amount, currency: comparison.currency });
  if (offer.evidence === "unavailable") return "no public price; ask for a quote";
  if (comparison.category === "electricity") {
    const terms = offer.terms;
    const fee = `${formatMoney({ amount: terms.monthlyFeeSek, currency: "SEK" })} a month`;
    if (offer.model === "fixed") {
      const unit = `${String(terms.fixedPriceOrePerKwh).replace(".", ",")} öre/kWh fixed, ${fee}`;
      return offer.cost ? `about ${money(offer.cost.amount)} a year (${unit})` : unit;
    }
    const unit = `markup ${String(terms.markupOrePerKwh).replace(".", ",")} öre/kWh, ${fee}`;
    if (!offer.cost) return unit;
    return offer.cost.basis === "charges" ? `${money(offer.cost.amount)} a year on top of the market price (${unit})` : `about ${money(offer.cost.amount)} a year (${unit})`;
  }
  if (!offer.cost) return "price not comparable";
  const intro = offer.intro ? `, ${formatMoney(offer.intro)} a month for ${offer.intro.months} month${offer.intro.months === 1 ? "" : "s"}, then ${formatPrice(offer.price)}` : "";
  const fees = offer.oneTimeFees.length > 0 ? `, including ${offer.oneTimeFees.map((fee) => `${fee.label.toLowerCase()} ${formatMoney(fee)}`).join(" and ")}` : "";
  return `about ${money(offer.cost.amount)} over 12 months${intro}${fees}`;
}

/**
 * The difference with staying, only for a like-for-like offer: plainly for a
 * published price or the user's own quote, and only as a condition for an
 * indicative figure or an estimate.
 */
function differenceText(offer, comparison) {
  if (!offer.likeForLike || offer.difference === null) return null;
  const amount = formatMoney({ amount: Math.abs(offer.difference), currency: comparison.currency });
  const versus = comparison.current.basis === "charges" ? "your supplier's charges" : "staying";
  const text = Math.abs(offer.difference) < 50 ? `about the same as ${versus}` : `about ${amount} ${offer.difference > 0 ? "less" : "more"} than ${versus}`;
  const plain = ["published", "personalized_quote"].includes(offer.evidence) || offer.difference <= 0;
  return plain ? `${capitalize(text)}.` : `If a quote matches it: ${text}.`;
}

/** One line per offer, as the user reads it. */
export function formatOfferLine(offer, comparison) {
  const label = offer.evidence === "estimate" && offer.basis ? `estimate: ${offer.basis}` : EVIDENCE_TEXT[offer.evidence];
  const parts = [offer.evidence === "unavailable" ? `${offerName(offer)}: no public price; ask for a quote.` : `${offerName(offer)}: ${costText(offer, comparison)} (${label}).`];
  const difference = differenceText(offer, comparison);
  if (difference) parts.push(difference);
  const notes = [...offer.gaps];
  if (offer.binding?.months > 0) notes.push(`${offer.binding.months}-month binding period`);
  if (offer.eligibility === "new_customers_only") notes.push("for new customers");
  if (offer.noticePeriod) notes.push(describeNoticePeriod(offer.noticePeriod));
  notes.push(...offer.differences);
  if (comparison.category === "electricity" && offer.illustration && comparison.spotPrice) {
    notes.push(`with ${String(comparison.spotPrice.orePerKwh).replace(".", ",")} öre/kWh spot (${comparison.spotPrice.basis}) about ${formatMoney({ amount: offer.illustration.amount, currency: comparison.currency })} a year in all, an illustration, not a forecast`);
  }
  if (notes.length > 0) parts.push(`${capitalize(notes.join("; "))}.`);
  parts.push(sourceLink(offer.quoteLink ?? offer.source));
  return `- ${parts.join(" ")}`;
}

/** The current side in one sentence. */
export function formatCurrentLine(contract, comparison, { today }) {
  const pieces = [];
  if (contract.currentPrice) pieces.push(`Now ${formatPrice(contract.currentPrice)}`);
  else if (contract.category === "electricity" && contract.terms?.priceModel) pieces.push(`Now ${contract.terms.priceModel === "fixed" ? "a fixed price" : "a market-linked price"}`);
  if (contract.nextPrice) {
    const after = isIsoDate(contract.discountEndDate) ? "after the discount" : isIsoDate(contract.priceGuaranteeEndDate) ? "after the price guarantee" : "from the renewal";
    pieces.push(`${after} ${formatPrice(contract.nextPrice)}${contract.nextPrice.basis ? ` (${contract.nextPrice.basis})` : ""}`);
  }
  else if (comparison.current.amount === null && comparison.current.note) pieces.push(comparison.current.note);
  if (comparison.current.basis === "charges") {
    pieces.push(`your supplier adds about ${formatMoney({ amount: comparison.current.amount, currency: comparison.currency })} a year to the market price`);
  }
  if (comparison.category === "electricity" && comparison.consumption) {
    const { kwh, source, basis } = comparison.consumption;
    pieces.push(source === "assumption" ? `assuming ${kwh} kWh a year (${basis})` : `at ${kwh} kWh a year`);
  }
  return pieces.length > 0 ? `${capitalize(pieces.join("; "))}.` : null;
}

export function formatRecommendation(contract, comparison) {
  const { kind, offer: offerId, reason } = comparison.recommendation;
  const offer = comparison.offers.find((candidate) => candidate.id === offerId);
  const provider = contract.provider;
  switch (kind) {
    case "keep":
      return `My recommendation: keep ${provider}; ${reason}.`;
    case "negotiate":
      return offer
        ? `My recommendation: ask ${provider} to extend your discount or lower the new price, using ${offer.provider}'s offer as a reference.`
        : `My recommendation: ask ${provider} to extend your discount or lower the new price before you decide.`;
    case "request_quote":
      return `My recommendation: request a quote from ${offer.provider}, then ask ${provider} whether it can match it.`;
    case "consider_switching":
      return `My recommendation: consider switching to ${offerName(offer)}: it looks clearly cheaper for the same ${INSURANCE.has(contract.category) ? "cover" : "service"}. Check the terms before you sign; I can't switch for you.`;
    default:
      return `I can't make a responsible recommendation yet: ${reason}.`;
  }
}

/**
 * The comparison as Telegram lines: the current side, the offers, what the
 * evidence is, the recommendation and the sources with when they were checked.
 */
export function formatComparisonLines(contract, comparison, { today }) {
  const lines = [];
  const current = formatCurrentLine(contract, comparison, { today });
  if (current) lines.push(current);
  if (comparison.offers.length === 0) lines.push("I found no alternatives with a price I could check.");
  else {
    lines.push("", `Alternatives (checked ${formatContractDate(comparison.checkedAt.slice(0, 10), { today })}):`);
    for (const offer of comparison.offers) lines.push(formatOfferLine(offer, comparison));
    if (!comparison.offers.some((offer) => offer.evidence === "personalized_quote")) {
      lines.push(INSURANCE.has(contract.category)
        ? "None of these are personal quotes: insurers price by your details, which I don't send anywhere. Check cover and deductible before deciding."
        : "Check availability and the full terms before deciding.");
    }
  }
  if (comparison.category === "electricity") {
    lines.push("Grid fees and energy tax are paid to your grid operator whichever supplier you pick, so they're left out.");
  }
  lines.push("", formatRecommendation(contract, comparison));
  if (comparison.limitations.length > 0) lines.push(`Limits: ${comparison.limitations.map((limitation) => limitation.replace(/[\s.;,:!?\u2026]+$/u, "")).join("; ")}.`);
  const extra = comparison.sources.filter((source) => !comparison.offers.some((offer) => offer.source === source.url));
  if (extra.length > 0) lines.push(`Also checked: ${extra.map((source) => sourceLink(source.url)).join(", ")}`);
  return lines;
}

/** A reply for research the user asked for in chat. */
export function formatOfferReply(contract, comparison, { today }) {
  return [`${describeContractName(contract)}: better offers?`, ...formatComparisonLines(contract, comparison, { today })].join("\n");
}

function capitalize(text) {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

/** The terms an offer may carry for this category, for the research brief. */
export function offerTermKeys(category) {
  return Object.entries(TERM_FIELDS)
    .filter(([, spec]) => spec.categories.includes(category))
    .map(([key]) => key);
}
