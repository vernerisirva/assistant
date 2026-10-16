/**
 * Travel & Deals: deterministic trip pricing for the travel-deals skill.
 *
 * The agent does the research. This module does the arithmetic and the
 * honesty checks, so no total, conversion, saving, availability or confidence
 * label in the reply comes from the model:
 *
 * - Every cost line says what it is, its basis (per person, per room, per
 *   night, per round...), and how sure it is: `verified` (a concrete price for
 *   these dates, this party and stated inclusions, with source and time),
 *   `indicative`, `estimate` (with its basis) or `unavailable` (no price).
 * - A required component that is missing or unpriced makes the total
 *   incomplete ("at least ..."), never zero.
 * - Airfare pays for each direction once: a round-trip fare, or one one-way
 *   fare per direction (two separate tickets). A one-way fare alone leaves
 *   the other direction unpriced.
 * - A Google Flights round trip is a listing, not an itinerary: the outbound
 *   flight shown plus the cheapest return Google pairs with it, which Hilla
 *   never sees (`returnFlight: "not_seen"`). It is never called verified as a
 *   whole, and comparisons built on it say so.
 * - Room prices are multiplied by rooms, not travellers, and a per-person
 *   price that assumes two sharing needs a single supplement for a solo trip.
 * - Converted amounts are marked approximate, with the rate and its date.
 * - A saving is stated only between a package and the same trip booked
 *   separately: same dates, hotel, board, rounds and inclusions.
 * - Free text from the agent may not carry prices, savings, availability
 *   claims, links or instruction-like page text; links must be plain public
 *   pages without personal data.
 *
 * Nothing here books, reserves, submits, signs in or schedules anything. It
 * reads only the JSON it is given and never touches the network.
 */

export const PRICE_STATUSES = Object.freeze(["verified", "indicative", "estimate", "unavailable"]);
export const TRIP_KINDS = Object.freeze(["flights", "hotel", "trip", "golf"]);
export const COST_BASES = Object.freeze(["trip", "person", "room", "room_night", "person_night", "round", "person_direction", "golfer_direction", "unit"]);
export const BOARD_TYPES = Object.freeze(["room only", "breakfast", "half board", "full board", "all inclusive"]);
export const MAX_OPTIONS = 3;
export const MAX_DATE_PAIRS = 6;
export const DEFAULT_TIMEZONE = "Europe/Stockholm";

/** Cost items in display order: id, table row (at most 9 characters), and prose name. */
const ITEMS = [
  ["flights", "Flights", "flights"],
  ["train", "Train", "train"],
  ["baggage", "Bags", "checked bags"],
  ["golf_bag", "Golf bag", "golf bag fees"],
  ["hotel", "Hotel", "hotel"],
  ["taxes_fees", "Taxes", "hotel taxes and fees"],
  ["single_supplement", "Single", "single supplement"],
  ["package", "Package", "package"],
  ["green_fees", "Golf", "green fees"],
  ["cart", "Cart", "golf cart"],
  ["club_rental", "Clubs", "club rental"],
  ["airport_transfer", "Transfer", "airport transfer"],
  ["course_transport", "Courses", "transport to the courses"],
  ["car_rental", "Car", "rental car"],
  ["local_transport", "Transport", "local transport"],
  ["booking_fee", "Fees", "booking fees"],
  ["other", "Other", "other costs"],
];
export const COST_ITEMS = Object.freeze(ITEMS.map(([id]) => id));
const ROW_LABEL = Object.fromEntries(ITEMS.map(([id, row]) => [id, row]));
const ITEM_NAME = Object.fromEntries(ITEMS.map(([id, , name]) => [id, name]));

// Items whose whole-trip price depends on how many travel (or play).
const PARTY_ITEMS = new Set(["flights", "train", "baggage", "package", "taxes_fees", "local_transport"]);
const GOLFER_ITEMS = new Set(["golf_bag", "green_fees", "cart", "club_rental"]);
const PERSON_BASES = new Set(["person", "person_night", "person_direction"]);
const ROOM_BASES = new Set(["room", "room_night"]);
const FORECAST_HORIZON_DAYS = 10;

const REQUEST_KEYS = [
  "title",
  "kind",
  "travellers",
  "rooms",
  "golfers",
  "rounds",
  "bringClubs",
  "checkedBag",
  "currency",
  "budget",
  "allInclusive",
  "assumptions",
];
const TOP_KEYS = ["request", "fx", "options", "recommendation", "packageVsSeparate", "limitations"];
const OPTION_KEYS = [
  "id",
  "title",
  "depart",
  "return",
  "from",
  "to",
  "city",
  "why",
  "advantages",
  "tradeOffs",
  "costs",
  "golf",
  "climate",
  "links",
  "itinerary",
];
const COST_KEYS = [
  "item",
  "label",
  "amount",
  "currency",
  "per",
  "count",
  "rounds",
  "status",
  "source",
  "checkedAt",
  "forDates",
  "forParty",
  "includes",
  "excludes",
  "basis",
  "covers",
  "board",
  "optional",
  "returnFlight",
];
const GOLF_KEYS = ["rounds", "courses", "teeTimes", "handicap", "daylight", "practice"];

// --- Free text ---------------------------------------------------------------

const MONEY = /\d[\d\s.,]*\s?(?:kr|kronor|sek|eur|euros?|usd|dkk|nok|gbp|chf|lira)\b|\d[\d\s.,]*\s?[€$£₺]|[€$£₺]\s?\d/i;
const SAVINGS =
  /\b(?:saves?|saving|savings|cheaper|cheapest|lowest|discount(?:ed)?|bargain|deals?|half[- ]price|spara|sparar|billigare|billigast|lägsta|rabatt|fynd)\b|\d+\s?%\s?(?:off|rabatt)/i;
// An availability claim: a thing that can sell out, then within a few words a
// word saying it is available, or a standalone promise.
const CLAIM_NOUNS = "tee[- ]?times?|rooms?|seats?|flights?|tickets?|starttider?";
const CLAIM_WORDS = "available|left|confirmed|guaranteed|bookable|lediga?";
const AVAILABILITY_CLAIM = new RegExp(`\\b(?:${CLAIM_NOUNS})\\b([^.!?]{0,40}?)\\b(?:${CLAIM_WORDS})\\b`, "giu");
// The same claim word first: "available tee times".
const AVAILABILITY_CLAIM_FIRST = new RegExp(`\\b(?:available|bookable|confirmed|guaranteed|lediga?)\\b([^.!?]{0,20}?)\\b(?:${CLAIM_NOUNS})\\b`, "giu");
const AVAILABILITY_PROMISE = /\b(?:guaranteed|bookable|in stock|sold out|live (?:prices?|deals?|offers?))\b/giu;
const INSTRUCTIONS =
  /\b(?:ignore|disregard|override|forget)\b[^.]{0,40}\b(?:instructions?|rules|prompts?|guidelines|orders)\b|\bsystem prompt\b|\bdeveloper (?:message|mode)\b|\byou are now\b|\bas an ai\b|\b(?:run|execute|exec)\b[^.]{0,30}\b(?:commands?|scripts?|shell|terminal|code)\b|\bapi[ _-]?keys?\b|\bpasswords?\b|\btokens?\b|\bsudo\b|\brm -rf\b|\bcurl\b|\bwget\b|<\s*script|\bnpm run\b|\bopenclaw\b/i;

// Each claim is judged on its own: "not confirmed" or "no rooms left" states a
// limit, which is welcome, but a negation elsewhere never excuses another claim.
const NEGATOR = /^(?:not|no|never|isn't|aren't|wasn't|weren't|cannot|can't|without|inte|ej|un[\p{L}]+)$/iu;
const lastWord = (text) => text.trim().split(/\s+/).at(-1) ?? "";
function claimsAvailability(text) {
  for (const match of [...text.matchAll(AVAILABILITY_CLAIM), ...text.matchAll(AVAILABILITY_CLAIM_FIRST)]) {
    const between = match[1].split(/[^\p{L}'’]+/u).filter(Boolean);
    if (!between.some((word) => NEGATOR.test(word)) && !NEGATOR.test(lastWord(text.slice(0, match.index)))) return true;
  }
  for (const match of text.matchAll(AVAILABILITY_PROMISE)) {
    if (!NEGATOR.test(lastWord(text.slice(0, match.index)))) return true;
  }
  return false;
}

const TEXT_RULES = [
  [(text) => /https?:\/\/|www\./i.test(text), "put links in `links` or `source`, not in text"],
  [(text) => MONEY.test(text), "put prices in `costs`, so the helper converts and totals them"],
  [(text) => SAVINGS.test(text), "leave savings and price comparisons to the helper"],
  [claimsAvailability, "don't claim availability; tee times go in `golf.teeTimes`"],
  [(text) => INSTRUCTIONS.test(text), "this reads like instructions from a web page, not travel facts; drop it"],
];

/** One line of display text, or a problem. Markdown and HTML characters are dropped. */
export function checkText(value, { max }) {
  if (typeof value !== "string") return { problem: "must be text" };
  const text = value
    .replace(/[\u{0}-\u{1f}\u{7f}]/gu, " ")
    .replace(/[*_`[\]<>|\\~#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return { problem: "is empty" };
  if (text.length > max) return { problem: `is longer than ${max} characters` };
  for (const [breaks, message] of TEXT_RULES) {
    if (breaks(text)) return { problem: `${message} (“${text.slice(0, 60)}”)` };
  }
  return { value: text };
}

// --- Links ---------------------------------------------------------------------

const SHORTENERS = new Set(["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly", "shorturl.at", "tiny.cc", "t.ly"]);
const PRIVATE_PARAMS =
  /^(?:e-?mail|email_?address|mail|phone|tel|mobile|msisdn|name|first_?name|last_?name|full_?name|surname|passport|password|passwd|pwd|pass|token|access_?token|id_?token|auth|authorization|session|session_?id|sessionid|sid|ssn|personnummer|card|card_?number|cc|cvv|cvc|iban|dob|birth_?date|address|pnr|booking_?ref(?:erence)?|confirmation|otp|pin)$/i;
const ACCOUNT_PATHS =
  /\/(?:checkout|payment|pay|login|log-in|signin|sign-in|signup|register|my-?account|account|mybooking|my-booking|booking-confirmation|confirmation|basket)(?:[/?.#]|$)/i;

/** A public page link without personal data, or a problem. */
export function checkLink(value) {
  if (typeof value !== "string" || value.length > 500) return { problem: "must be a link of at most 500 characters" };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { problem: "is not a valid link" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { problem: "must be an http(s) link" };
  if (url.username || url.password) return { problem: "must not carry a user name or password" };
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("[") || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)) {
    return { problem: "must point at a public website" };
  }
  if (SHORTENERS.has(host)) return { problem: "is a link shortener; use the full link" };
  if (ACCOUNT_PATHS.test(url.pathname)) return { problem: "points at a checkout, payment, sign-in or account page; link the offer or search page instead" };
  for (const [key, paramValue] of url.searchParams) {
    if (PRIVATE_PARAMS.test(key)) return { problem: `has a \`${key}\` parameter, which can carry personal or session data; remove it` };
    if (/@/.test(paramValue) || /\d{13,}/.test(paramValue.replace(/[\s-]/g, "")) || /\b\d{6,8}[-+]\d{4}\b/.test(paramValue) || /^\+\d{8,}/.test(paramValue)) {
      return { problem: `has personal-looking data in \`${key}\`; remove it` };
    }
  }
  return { value: url.toString() };
}

// --- Search links ----------------------------------------------------------------

/**
 * Provider search pages for the user to open: live prices on the provider's
 * own site, built from IATA codes, dates and party size only.
 */
export function searchLinks({ from = [], to = [], depart, returnDate = null, adults = 1, rooms = 1, city = null }) {
  const links = [];
  if (from.length > 0 && to.length > 0 && depart) {
    const [origin] = from;
    const [destination] = to;
    const query = returnDate
      ? `Flights to ${destination} from ${origin} on ${depart} through ${returnDate}${adults > 1 ? ` for ${adults} adults` : ""}`
      : `One way flights to ${destination} from ${origin} on ${depart}${adults > 1 ? ` for ${adults} adults` : ""}`;
    const google = new URL("https://www.google.com/travel/flights");
    google.searchParams.set("q", query);
    google.searchParams.set("curr", "SEK");
    google.searchParams.set("hl", "en");
    google.searchParams.set("gl", "se");
    links.push({ label: "Google Flights", url: google.toString() });

    const compact = (iso) => iso.slice(2).replace(/-/g, "");
    const path = [origin, destination].map((code) => code.toLowerCase()).join("/");
    const skyscanner = new URL(`https://www.skyscanner.se/transport/flights/${path}/${compact(depart)}/${returnDate ? `${compact(returnDate)}/` : ""}`);
    skyscanner.searchParams.set("adultsv2", String(adults));
    skyscanner.searchParams.set("cabinclass", "economy");
    skyscanner.searchParams.set("rtn", returnDate ? "1" : "0");
    links.push({ label: "Skyscanner", url: skyscanner.toString() });
  }
  if (city && depart && returnDate) {
    const booking = new URL("https://www.booking.com/searchresults.html");
    booking.searchParams.set("ss", city);
    booking.searchParams.set("checkin", depart);
    booking.searchParams.set("checkout", returnDate);
    booking.searchParams.set("group_adults", String(adults));
    booking.searchParams.set("no_rooms", String(rooms));
    booking.searchParams.set("group_children", "0");
    booking.searchParams.set("selected_currency", "SEK");
    links.push({ label: "Booking.com", url: booking.toString() });
  }
  return links;
}

/** Whether a link is a Google Flights page, whatever its search. */
function isGoogleFlightsLink(link) {
  try {
    const url = new URL(link);
    return /^(?:www\.)?google\.[a-z.]+$/.test(url.hostname) && url.pathname.startsWith("/travel/flights");
  } catch {
    return false;
  }
}

/**
 * The search a Google Flights results link asks for, in the format the
 * helper and searchLinks build ("Flights to HEL from CPH on D through R for
 * 2 adults"), or null for any other link.
 */
function googleFlightsSearch(link) {
  if (!isGoogleFlightsLink(link)) return null;
  const query = new URL(link).searchParams.get("q") ?? "";
  const match = query.match(
    /^(One way flights|Flights) to ([A-Z]{3}) from ([A-Z]{3}) on (\d{4}-\d{2}-\d{2})(?: through (\d{4}-\d{2}-\d{2}))?(?: for ([2-9]) adults)?$/,
  );
  if (!match || (match[1] === "Flights") !== Boolean(match[5])) return null;
  return { to: match[2], from: match[3], depart: match[4], returnDate: match[5] ?? null, adults: Number(match[6] ?? 1) };
}

// --- Flexible dates --------------------------------------------------------------

const WEEKDAY_IDS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Up to `max` departure dates from a window, spread across it and across
 * weekdays, so a "sometime in January" search compares real dates without
 * checking every day.
 */
export function sampleDepartureDates({ start, end, nights, weekdays = null, max = 4 }) {
  if (!isIsoDate(start) || !isIsoDate(end) || start > end) throw new Error("The departure window needs two dates, START..END, with START first.");
  if (dayDiff(start, end) > 92) throw new Error("The departure window can be at most three months.");
  if (!Number.isInteger(nights) || nights < 1 || nights > 30) throw new Error("--nights must be 1 to 30.");
  if (!Number.isInteger(max) || max < 1 || max > MAX_DATE_PAIRS) throw new Error(`--max-dates must be 1 to ${MAX_DATE_PAIRS}.`);
  const allowed = weekdays === null ? null : new Set(weekdays.map((day) => WEEKDAY_IDS.indexOf(day)));
  if (allowed && [...allowed].some((index) => index < 0)) throw new Error(`Weekdays are ${WEEKDAY_IDS.join(", ")}.`);

  const candidates = [];
  for (let offset = 0; offset <= dayDiff(start, end); offset += 1) {
    const date = addDays(start, offset);
    if (!allowed || allowed.has(weekdayOf(date))) candidates.push(date);
  }
  if (candidates.length === 0) throw new Error("No departure date in the window falls on those weekdays.");

  const chosen = [candidates[0]];
  while (chosen.length < Math.min(max, candidates.length)) {
    const weekdaysChosen = new Set(chosen.map(weekdayOf));
    let best = null;
    let bestScore = -1;
    for (const date of candidates) {
      if (chosen.includes(date)) continue;
      const spread = Math.min(...chosen.map((other) => Math.abs(dayDiff(other, date))));
      const score = spread + (weekdaysChosen.has(weekdayOf(date)) ? 0 : 2);
      if (score > bestScore) {
        best = date;
        bestScore = score;
      }
    }
    chosen.push(best);
  }
  return chosen.sort().map((depart) => ({ depart, return: addDays(depart, nights), weekday: WEEKDAY_IDS[weekdayOf(depart)] }));
}

// --- Flight lookups --------------------------------------------------------------

/**
 * The flights command's reply and ready-made cost lines from lookUpFlights
 * results: the lowest fare per route and date, verified for these exact
 * dates and this party, with bags left out unless the fare says otherwise.
 *
 * A round-trip fare is Google's listed total for the outbound flight shown
 * plus the cheapest return it pairs with that flight. Google names that
 * return only on its return-selection and booking pages, which its
 * robots.txt closes to Hilla, and it can be another airline, a long layover
 * or a separate ticket. So the reply calls it a listing and describes only
 * the outbound flight, and the cost line says `returnFlight: "not_seen"`.
 */
export function summarizeFlightLookups(results, { adults = 1, timezone = DEFAULT_TIMEZONE } = {}) {
  const routes = new Set(results.map((result) => `${result.from}-${result.to}`));
  const multiRoute = routes.size > 1;
  const listings = results.some((result) => result.returnDate);
  const lines = [];
  const costLines = [];
  let lowest = null;

  const first = results[0];
  const head = multiRoute ? "Flights" : `Flights ${first.from} → ${first.to}`;
  const tripType = first.returnDate ? "round trip" : "one way";
  lines.push(`${head} · ${adults} ${adults === 1 ? "adult" : "adults"} · ${tripType}`);
  const checked = results
    .map((result) => result.checkedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  lines.push(checked ? `Google Flights, checked ${formatDateTime(checked, timezone)}` : "Google Flights could not be checked.");
  lines.push("");

  for (const result of results) {
    const route = multiRoute ? `${result.from} → ${result.to}, ` : "";
    const dates = result.returnDate ? `${formatDay(result.depart)} – ${formatDay(result.returnDate)}` : formatDay(result.depart);
    if (result.status !== "ok" || result.offers.length === 0) {
      lines.push(`${route}${dates}: ${lookupProblem(result)}`);
      continue;
    }
    const [cheapest] = result.offers;
    const nonstop = cheapest.stops > 0 ? result.offers.find((offer) => offer.stops === 0) : null;
    const listed = Boolean(result.returnDate);
    lines.push(`${route}${dates}: ${listed ? "from " : ""}${formatInt(cheapest.priceSek)} SEK`);
    lines.push(`  ${listed ? "Outbound: " : ""}${describeOffer(cheapest)}`);
    if (nonstop) lines.push(`  Nonstop ${listed ? "outbound " : ""}from ${formatInt(nonstop.priceSek)} SEK: ${describeOffer(nonstop)}`);
    if (!lowest || cheapest.priceSek < lowest.offer.priceSek) lowest = { result, offer: cheapest };
    costLines.push(flightCostLine(result, cheapest, adults));
  }

  lines.push("");
  if (lowest) {
    const { result, offer } = lowest;
    const listed = Boolean(result.returnDate);
    const route = multiRoute ? `${result.from} → ${result.to}, ` : "";
    const dates = result.returnDate ? `${formatDay(result.depart)} – ${formatDay(result.returnDate)}` : formatDay(result.depart);
    lines.push(
      `Lowest${listed ? " listed" : ""}: ${route}${dates}, ${listed ? "from " : ""}${formatInt(offer.priceSek)} SEK for ${adults === 1 ? "1 adult" : `${adults} adults`} (${offer.airlines}${listed ? " outbound" : ""}).`,
    );
    lines.push(
      listings
        ? "These are Google Flights' listed round-trip prices: the outbound flight shown plus the cheapest return Google pairs with it. I can't see that return flight: it may be another airline, a long layover or a separate ticket, and another return can cost more. Taxes and required fees are included. Checked bags and golf bags are extra unless stated. Check the whole itinerary before you buy. Prices can change; nothing is held or booked."
        : "One-way prices with taxes and required fees. Checked bags and golf bags are extra unless stated. Prices can change; nothing is held or booked.",
    );
  } else {
    lines.push("No fare could be read, so there is no verified flight price. The links show live prices.");
  }
  const linkSource = lowest?.result ?? first;
  const links = searchLinks({ from: [linkSource.from], to: [linkSource.to], depart: linkSource.depart, returnDate: linkSource.returnDate, adults });
  lines.push(`Search: ${links.map((link) => `[${link.label}](${link.url})`).join(" · ")}`);

  return {
    telegramText: lines.join("\n"),
    lowest: lowest
      ? {
          from: lowest.result.from,
          to: lowest.result.to,
          depart: lowest.result.depart,
          return: lowest.result.returnDate,
          ...lowest.offer,
          ...(lowest.result.returnDate ? { returnFlight: "not_seen" } : {}),
        }
      : null,
    costLines,
  };
}

/**
 * Fares whose airline, airport or city names pass the same text checks as the
 * agent's own text, with Markdown characters dropped. A fare carrying a link,
 * a price claim or instruction-like text is dropped, never shown.
 */
export function cleanFlightResults(results) {
  const clean = (text) => (text === null || text === undefined ? { value: text } : checkText(text, { max: 80 }));
  return results.map((result) => {
    if (!Array.isArray(result.offers) || result.offers.length === 0) return result;
    const offers = result.offers.flatMap((offer) => {
      const names = {
        airlines: clean(offer.airlines),
        operatedBy: clean(offer.operatedBy),
        departAirport: clean(offer.departAirport),
        arriveAirport: clean(offer.arriveAirport),
      };
      const layovers = offer.layovers.map((stop) => ({ ...stop, airport: clean(stop.airport), city: clean(stop.city) }));
      const checked = [...Object.values(names), ...layovers.flatMap((stop) => [stop.airport, stop.city])];
      if (checked.some((entry) => entry.problem)) return [];
      return [
        {
          ...offer,
          ...Object.fromEntries(Object.entries(names).map(([key, entry]) => [key, entry.value])),
          layovers: layovers.map((stop) => ({ ...stop, airport: stop.airport.value, city: stop.city.value })),
        },
      ];
    });
    if (offers.length > 0) return { ...result, offers };
    return { ...result, status: "unreadable", offers: [], reason: "The listed fares carried unexpected text, so none is shown." };
  });
}

function lookupProblem(result) {
  if (result.status === "no_listings") return "no fares listed for this search.";
  if (result.status === "blocked") return `not checked (${lowerFirst(result.reason ?? "blocked").replace(/\.$/, "")}).`;
  if (result.status === "skipped") return "not checked (stopped after an earlier block).";
  return `not checked (${lowerFirst(result.reason ?? "the page could not be read").replace(/\.$/, "")}).`;
}

function describeOffer(offer) {
  const stops =
    offer.stops === 0
      ? "nonstop"
      : `${offer.stops} ${offer.stops === 1 ? "stop" : "stops"}${offer.layovers[0] ? ` via ${offer.layovers.map((stop) => stop.city).join(", ")}` : ""}`;
  const parts = [`${offer.airlines}, ${stops}, ${offer.departTime}–${offer.arriveTime}${offer.arriveDate !== offer.departDate ? " (+1)" : ""}`];
  if (offer.duration) parts.push(offer.duration.replace(/\bhr\b/g, "h"));
  if (offer.fareNote && /overhead bin/i.test(offer.fareNote)) parts.push("cabin bag not included");
  return parts.join(" · ");
}

/**
 * A verified price for what the page shows: a one-way flight, or Google's
 * round-trip listing, where only the outbound flight is known.
 */
function flightCostLine(result, offer, adults) {
  const route = `${result.from}–${result.to}`;
  const stops = offer.stops === 0 ? "nonstop" : `${offer.stops} stop${offer.stops === 1 ? "" : "s"}`;
  const excludes = ["checked bags"];
  if (offer.fareNote && /overhead bin/i.test(offer.fareNote)) excludes.unshift("cabin bag (overhead bin)");
  return {
    item: "flights",
    label: (result.returnDate ? `${route} round trip, outbound ${offer.airlines} ${stops}` : `${offer.airlines} ${route} one way, ${stops}`).slice(0, 60),
    amount: offer.priceSek,
    currency: "SEK",
    per: "trip",
    status: "verified",
    source: result.url,
    checkedAt: result.checkedAt,
    forDates: result.returnDate ? [result.depart, result.returnDate] : [result.depart],
    forParty: { adults },
    includes: ["economy seats", "taxes and required fees"],
    excludes,
    ...(result.returnDate ? { returnFlight: "not_seen" } : {}),
  };
}

// --- Compare -------------------------------------------------------------------------

/**
 * Validates a trip comparison, prices every option, and builds the reply.
 * Returns `{ ok: false, problems }` when anything would make a number in the
 * reply untrue; the agent fixes the input and runs it again.
 */
export function buildComparison(input, { now = new Date(), timezone = DEFAULT_TIMEZONE } = {}) {
  const problems = [];
  const warnings = [];
  const fail = (path, message) => problems.push(`${path} ${message}`);

  if (!isPlainObject(input)) return { ok: false, problems: ["The input must be a JSON object with request and options."], warnings };
  unknownKeys(input, TOP_KEYS, "input", fail);

  const request = validateRequest(input.request, fail);
  const today = localDate(now, timezone);
  const fx = validateFx(input.fx, { now, fail, warnings });
  const options = Array.isArray(input.options) ? input.options : [];
  if (options.length < 1 || options.length > MAX_OPTIONS) fail("options", `must list 1 to ${MAX_OPTIONS} options.`);
  const validated = options.slice(0, MAX_OPTIONS).map((option, index) => validateOption(option, index, { request, today, now, fail, warnings }));
  const limitations = textList(input.limitations, "limitations", { max: 3, length: 140 }, fail);
  const recommendation = validateRecommendation(input.recommendation, validated, fail);
  const pairs = validatePairs(input.packageVsSeparate, validated, fail);

  if (problems.length > 0 || !request) return { ok: false, problems, warnings };

  const conversions = new Set(
    validated.flatMap((option) => option.costs.filter((line) => line.amount !== null && line.currency !== request.currency).map((line) => line.currency)),
  );
  if (conversions.size > 0) {
    const needed = new Set([...conversions].filter((currency) => currency !== "SEK"));
    if (request.currency !== "SEK") needed.add(request.currency);
    for (const currency of needed) {
      if (!fx?.sekPerUnit[currency]) fail("fx", `has no rate for ${currency}. Set "fx": "ecb" so the helper fetches the ECB rates.`);
    }
  }
  if (problems.length > 0) return { ok: false, problems, warnings };

  const priced = validated.map((option) => priceOption(option, request, fx));
  for (const option of priced) warnings.push(...option.notes.map((note) => `${option.id}: ${note}`));
  const comparisons = pairs.map((pair) => comparePackage(pair, priced));
  const recommended = recommendation ? describeRecommendation(recommendation, priced, request) : null;
  const telegramText = formatComparison({
    request,
    options: priced,
    fx,
    comparisons,
    recommended,
    limitations,
    fxWarnings: warnings.filter((text) => /^The exchange rates/.test(text)),
    timezone,
    now,
  });

  return {
    ok: true,
    telegramText,
    options: priced.map((option) => ({
      id: option.id,
      title: option.title,
      depart: option.depart,
      return: option.return,
      nights: option.nights,
      currency: request.currency,
      total: option.total,
      complete: option.complete,
      missing: option.missing,
      unknown: option.unknown,
      perPerson: option.perPerson,
      perRound: option.perRound,
      confidence: option.confidence,
      lines: option.lines.map((line) => ({
        item: line.item,
        status: line.status,
        amount: line.display,
        approximate: line.approximate,
        optional: line.optional,
        ...(line.returnFlight ? { returnFlight: line.returnFlight } : {}),
      })),
    })),
    comparisons,
    recommendation: recommended ? { option: recommended.option.id, cheapestComplete: recommended.cheapestComplete } : null,
    warnings,
  };
}

function validateRequest(request, fail) {
  if (!isPlainObject(request)) {
    fail("request", "must be an object.");
    return null;
  }
  unknownKeys(request, REQUEST_KEYS, "request", fail);
  const title = textField(request.title, "request.title", { max: 80 }, fail);
  if (!TRIP_KINDS.includes(request.kind)) fail("request.kind", `must be one of ${TRIP_KINDS.join(", ")}.`);
  const kind = request.kind;
  const travellers = request.travellers;
  if (!isInt(travellers, 1, 9)) fail("request.travellers", "must be 1 to 9 adults.");

  const needsRooms = kind === "hotel" || kind === "trip" || kind === "golf";
  let rooms = null;
  if (needsRooms) {
    rooms = request.rooms;
    if (!isInt(rooms, 1, 9)) fail("request.rooms", "must say how many rooms (1 to 9).");
    else if (isInt(travellers, 1, 9) && (rooms > travellers || travellers % rooms !== 0)) {
      fail("request.rooms", "must split the travellers evenly between rooms; mixed room sizes aren't supported, so compare one room type at a time.");
    }
  } else if (request.rooms !== undefined) fail("request.rooms", "only applies to trips with a stay.");

  const golf = kind === "golf";
  const golfers = golf ? (request.golfers ?? travellers) : null;
  if (golf && !isInt(golfers, 1, isInt(travellers, 1, 9) ? travellers : 9)) fail("request.golfers", "must be 1 to the number of travellers.");
  if (golf && !isInt(request.rounds, 1, 21)) fail("request.rounds", "must say how many rounds are planned (1 to 21).");
  if (!golf) {
    for (const key of ["golfers", "rounds", "bringClubs"]) if (request[key] !== undefined) fail(`request.${key}`, "only applies to golf trips.");
  }
  if (request.bringClubs !== undefined && typeof request.bringClubs !== "boolean") fail("request.bringClubs", "must be true or false.");
  if (request.checkedBag !== undefined && typeof request.checkedBag !== "boolean") fail("request.checkedBag", "must be true or false.");
  if (request.allInclusive !== undefined && typeof request.allInclusive !== "boolean") fail("request.allInclusive", "must be true or false.");

  const currency = request.currency ?? "SEK";
  if (!/^[A-Z]{3}$/.test(currency)) fail("request.currency", "must be a currency code such as SEK.");
  let budget = null;
  if (request.budget !== undefined) {
    const amount = request.budget?.amount;
    if (
      !isPlainObject(request.budget) ||
      typeof amount !== "number" ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !["trip", "person"].includes(request.budget.per ?? "trip")
    ) {
      fail("request.budget", 'must be {"amount": N, "per": "trip" | "person"} in the request currency.');
    } else {
      unknownKeys(request.budget, ["amount", "per"], "request.budget", fail);
      budget = { amount: request.budget.amount, per: request.budget.per ?? "trip" };
    }
  }
  const assumptions = textList(request.assumptions, "request.assumptions", { max: 3, length: 120 }, fail);

  return {
    title,
    kind,
    travellers,
    rooms,
    golfers,
    rounds: golf ? request.rounds : null,
    bringClubs: golf ? request.bringClubs !== false : null,
    checkedBag: request.checkedBag === true,
    currency,
    budget,
    allInclusive: request.allInclusive === true,
    assumptions,
  };
}

function validateFx(fx, { now, fail, warnings }) {
  if (fx === undefined) return null;
  if (!isPlainObject(fx) || !isIsoDate(fx.date) || !isPlainObject(fx.sekPerUnit)) {
    fail("fx", 'must be "ecb" (the helper fetches the ECB rates) or the fx object from `travel -- fx`.');
    return null;
  }
  unknownKeys(fx, ["date", "source", "publisher", "sekPerUnit"], "fx", fail);
  const source = checkLink(fx.source);
  if (source.problem) fail("fx.source", source.problem);
  const rates = {};
  for (const [currency, rate] of Object.entries(fx.sekPerUnit)) {
    if (!/^[A-Z]{3}$/.test(currency) || !(typeof rate === "number" && rate > 0 && Number.isFinite(rate)))
      fail(`fx.sekPerUnit.${currency}`, "must be a positive number.");
    else rates[currency] = rate;
  }
  const age = dayDiff(fx.date, now.toISOString().slice(0, 10));
  if (age > 7) warnings.push(`The exchange rates are ${age} days old.`);
  return { date: fx.date, source: source.value ?? null, sekPerUnit: rates };
}

function validateOption(option, index, { request, today, now, fail, warnings }) {
  const path = `options[${index}]`;
  const empty = { id: String.fromCharCode(65 + index), costs: [], links: [], advantages: [], tradeOffs: [], nights: 0 };
  if (!isPlainObject(option)) {
    fail(path, "must be an object.");
    return empty;
  }
  unknownKeys(option, OPTION_KEYS, path, fail);
  const id = String.fromCharCode(65 + index);
  if (option.id !== id) fail(`${path}.id`, `must be "${id}" (options are A, B, C in order).`);
  const at = `option ${id}`;

  const title = textField(option.title, `${at} title`, { max: 60 }, fail);
  let nights = 0;
  if (!isIsoDate(option.depart) || !isIsoDate(option.return) || option.return <= option.depart) {
    fail(`${at} dates`, "need depart and return as YYYY-MM-DD, return after depart.");
  } else {
    nights = dayDiff(option.depart, option.return);
    if (nights > 30) fail(`${at} dates`, "can span at most 30 nights.");
    if (option.depart < today) fail(`${at} depart`, "is in the past.");
  }
  const from = codeList(option.from, `${at} from`, fail);
  const to = codeList(option.to, `${at} to`, fail);
  const city = option.city === undefined ? null : textField(option.city, `${at} city`, { max: 40 }, fail);
  const why = textField(option.why, `${at} why`, { max: 240 }, fail);
  const advantages = textList(option.advantages, `${at} advantages`, { max: 3, length: 100, min: 1 }, fail);
  const tradeOffs = textList(option.tradeOffs, `${at} tradeOffs`, { max: 3, length: 100, min: 1 }, fail);
  const links = linkList(option.links, `${at} links`, fail);

  const shell = { id, depart: option.depart, return: option.return, nights, from, to };
  const rawCosts = Array.isArray(option.costs) ? option.costs : [];
  if (rawCosts.length < 1 || rawCosts.length > 16) fail(`${at} costs`, "must list 1 to 16 cost lines.");
  const hasSupplement = rawCosts.some((line) => line?.item === "single_supplement" && line?.optional !== true);
  const costs = rawCosts
    .slice(0, 16)
    .map((line, lineIndex) => validateCost(line, lineIndex, { at, option: shell, request, now, hasSupplement, fail, warnings }));

  validateStayDates(costs, shell, at, fail);
  validateSupplement(costs, request, at, fail);
  validateFlightLegs(costs, request, at, fail);

  let golf = null;
  if (request?.kind === "golf") golf = validateGolf(option.golf, `${at} golf`, { request, costs, fail });
  else if (option.golf !== undefined) fail(`${at} golf`, "only applies to golf trips.");
  const climate = option.climate === undefined ? null : validateClimate(option.climate, `${at} climate`, { depart: option.depart, today, fail });
  const itinerary =
    option.itinerary === undefined ? [] : validateItinerary(option.itinerary, `${at} itinerary`, { depart: option.depart, returnDate: option.return, fail });

  return {
    id,
    title,
    depart: option.depart,
    return: option.return,
    nights,
    from,
    to,
    city,
    why,
    advantages,
    tradeOffs,
    links,
    costs,
    golf,
    climate,
    itinerary,
  };
}

/** A day-by-day plan: one short line per day of the trip, in order, with no prices or claims. */
function validateItinerary(itinerary, at, { depart, returnDate, fail }) {
  if (!Array.isArray(itinerary) || itinerary.length < 1 || itinerary.length > 15) {
    fail(at, 'must be a list of 1 to 15 {"day": "YYYY-MM-DD", "plan": "..."} entries.');
    return [];
  }
  let previous = null;
  return itinerary.flatMap((entry, index) => {
    const path = `${at}[${index}]`;
    if (!isPlainObject(entry)) {
      fail(path, "must be an object with day and plan.");
      return [];
    }
    unknownKeys(entry, ["day", "plan"], path, fail);
    if (!isIsoDate(entry.day) || (isIsoDate(depart) && entry.day < depart) || (isIsoDate(returnDate) && entry.day > returnDate)) {
      fail(`${path}.day`, "must be a date within the trip.");
    } else if (previous !== null && entry.day <= previous) fail(`${path}.day`, "must come after the previous day.");
    previous = entry.day;
    const plan = textField(entry.plan, `${path}.plan`, { max: 120 }, fail);
    return plan ? [{ day: entry.day, plan }] : [];
  });
}

function validateCost(line, index, { at, option, request, now, hasSupplement, fail, warnings }) {
  const path = `${at} costs[${index}]`;
  if (!isPlainObject(line)) {
    fail(path, "must be an object.");
    return { item: "other", amount: null, status: "unavailable", covers: ["other"], optional: false };
  }
  unknownKeys(line, COST_KEYS, path, fail);
  const item = line.item;
  if (!COST_ITEMS.includes(item)) fail(`${path}.item`, `must be one of ${COST_ITEMS.join(", ")}.`);
  const named = `${path} (${item})`;
  const status = line.status;
  if (!PRICE_STATUSES.includes(status)) fail(`${named}.status`, `must be one of ${PRICE_STATUSES.join(", ")}.`);
  const label = line.label === undefined ? null : textField(line.label, `${named}.label`, { max: 60 }, fail);

  let amount = null;
  if (status === "unavailable") {
    if (line.amount !== undefined && line.amount !== null) fail(`${named}.amount`, "must be left out when no trustworthy price was found.");
  } else if (typeof line.amount !== "number" || !Number.isFinite(line.amount) || line.amount < 0 || line.amount > 1_000_000) {
    fail(`${named}.amount`, "must be a price (0 or more); use status unavailable when there is none.");
  } else {
    amount = line.amount;
  }
  const currency = line.currency;
  if (amount !== null && !/^[A-Z]{3}$/.test(currency ?? "")) fail(`${named}.currency`, "must be a currency code such as SEK or EUR.");
  const per = line.per;
  if ((amount !== null || per !== undefined) && !COST_BASES.includes(per)) fail(`${named}.per`, `must be one of ${COST_BASES.join(", ")}.`);
  if (ROOM_BASES.has(per) && !request?.rooms) fail(`${named}.per`, "is per room, but this request has no rooms.");
  if ((per === "round" || per === "golfer_direction") && request?.kind !== "golf") fail(`${named}.per`, "only applies to golf trips.");
  if (per === "unit" ? !isInt(line.count, 1, 99) : line.count !== undefined) fail(`${named}.count`, "is required with per unit (1 to 99), and only then.");

  const covers = line.covers === undefined ? [] : Array.isArray(line.covers) ? line.covers : null;
  if (covers === null || covers.some((covered) => !COST_ITEMS.includes(covered) || covered === "package")) {
    fail(`${named}.covers`, "must list cost items such as flights, hotel, green_fees.");
  }
  if (item === "package" && (covers ?? []).length === 0)
    fail(`${named}.covers`, "must list what the package includes, such as flights, hotel, green_fees, airport_transfer.");
  const coversGolf = item === "green_fees" || (covers ?? []).includes("green_fees");
  const perRoundExtra = (item === "cart" || item === "club_rental") && per === "round";
  if (coversGolf ? !isInt(line.rounds, 1, 21) : line.rounds !== undefined && !(perRoundExtra && isInt(line.rounds, 1, 21))) {
    fail(
      `${named}.rounds`,
      "is required for green fees (how many rounds the line pays for); a cart or club rental per round may name fewer rounds than the trip.",
    );
  }
  if (line.board !== undefined && (!BOARD_TYPES.includes(line.board) || (item !== "hotel" && item !== "package"))) {
    fail(`${named}.board`, `applies to hotel or package lines: ${BOARD_TYPES.join(", ")}.`);
  }
  if (line.optional !== undefined && typeof line.optional !== "boolean") fail(`${named}.optional`, "must be true or false.");

  const evidence = status === "verified" || status === "indicative";
  let source = null;
  if (line.source === "user") {
    // An offer the user sent (pasted text, a screenshot, a saved page) is evidence, but not one Hilla saw itself.
    if (status === "verified") fail(`${named}.source`, '"user" (an offer the user sent) can back an indicative price, never a verified one.');
    source = "user";
  } else if (line.source !== undefined) {
    const checked = checkLink(line.source);
    if (checked.problem) fail(`${named}.source`, checked.problem);
    source = checked.value ?? null;
  } else if (evidence) fail(`${named}.source`, `is required for a ${status} price: the page where it was seen, or "user" for an offer the user sent.`);

  let checkedAt = null;
  if (line.checkedAt !== undefined) {
    const time = Date.parse(line.checkedAt);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(String(line.checkedAt)) || Number.isNaN(time)) fail(`${named}.checkedAt`, "must be an ISO date and time.");
    else if (time > now.getTime() + 5 * 60_000) fail(`${named}.checkedAt`, "is in the future.");
    else if (now.getTime() - time > 30 * 86_400_000) fail(`${named}.checkedAt`, "is more than 30 days old; check the price again.");
    else checkedAt = new Date(time).toISOString();
  } else if (evidence) fail(`${named}.checkedAt`, `is required for a ${status} price: when it was seen.`);

  let forDates = null;
  if (line.forDates !== undefined) {
    if (!Array.isArray(line.forDates) || line.forDates.length < 1 || line.forDates.length > 2 || !line.forDates.every(isIsoDate)) {
      fail(`${named}.forDates`, "must be one or two YYYY-MM-DD dates.");
    } else if (isIsoDate(option.depart) && isIsoDate(option.return) && line.forDates.some((date) => date < option.depart || date > option.return)) {
      fail(`${named}.forDates`, `are outside this option's dates (${option.depart} to ${option.return}); that price is for another trip.`);
    } else if (line.forDates.length === 2 && line.forDates[1] <= line.forDates[0]) {
      fail(`${named}.forDates`, "must be in order, the second date after the first.");
    } else {
      forDates = [...line.forDates];
      // A verified quote is for this exact trip, not one nearby.
      const whole = forDates.length === 2 && forDates[0] === option.depart && forDates[1] === option.return;
      const oneLeg = forDates.length === 1 && (forDates[0] === option.depart || forDates[0] === option.return);
      if (status === "verified" && (item === "flights" || item === "train") && !whole && !oneLeg) {
        fail(`${named}.forDates`, `must be this trip's dates (${option.depart}, ${option.return}), or one of them for a one-way leg, for a verified fare.`);
      }
      if (status === "verified" && item === "package" && !whole)
        fail(`${named}.forDates`, `must be ${option.depart} to ${option.return} for a verified package.`);
      if (status === "verified" && item === "hotel" && forDates.length !== 2)
        fail(`${named}.forDates`, "must be the check-in and check-out dates for a verified hotel price.");
    }
  } else if (status === "verified") fail(`${named}.forDates`, "is required for a verified price: the dates it was quoted for.");

  // Who a price was quoted for decides what it costs this party: always for a
  // verified price, for anything that includes a room, and for whole-trip
  // prices of things everyone pays for separately.
  const roomPriced = item === "single_supplement" || item === "hotel" || (covers ?? []).includes("hotel");
  const partyPriced = per === "trip" && (PARTY_ITEMS.has(item) || GOLFER_ITEMS.has(item));
  let forParty = null;
  if (line.forParty !== undefined) {
    const party = line.forParty;
    if (!isPlainObject(party) || !isInt(party.adults, 1, 20) || (party.rooms !== undefined && !isInt(party.rooms, 1, 10))) {
      fail(`${named}.forParty`, 'must be {"adults": N} or {"adults": N, "rooms": N}: who the price was quoted for.');
    } else {
      unknownKeys(party, ["adults", "rooms"], `${named}.forParty`, fail);
      forParty = { adults: party.adults, ...(party.rooms !== undefined ? { rooms: party.rooms } : {}) };
      if (roomPriced && party.rooms === undefined && amount !== null)
        fail(`${named}.forParty.rooms`, "is required: room prices depend on how many share a room.");
    }
  } else if (status === "verified") fail(`${named}.forParty`, "is required for a verified price: who it was quoted for.");
  else if (amount !== null && roomPriced && line.optional !== true) {
    fail(`${named}.forParty`, 'is required for a price that includes a room: {"adults": N, "rooms": N} as quoted, since sharing changes the price.');
  } else if (amount !== null && partyPriced && line.optional !== true) {
    fail(`${named}.forParty`, "is required for a whole-trip price: how many people it was quoted for.");
  }

  // Hilla reads only Google Flights' first results page, which lists a round
  // trip by its outbound flight: the return flight in that price is never seen.
  let returnFlight = null;
  if (line.returnFlight !== undefined) {
    if (line.returnFlight !== "not_seen" || item !== "flights" || forDates?.length === 1) {
      fail(`${named}.returnFlight`, 'can only be "not_seen", on a round-trip flights price whose return flight wasn\'t seen.');
    } else returnFlight = "not_seen";
  }
  if (item === "flights" && amount !== null && typeof source === "string" && isGoogleFlightsLink(source)) {
    const search = googleFlightsSearch(source);
    if ((search ? search.returnDate !== null : forDates?.length === 2) && returnFlight === null) {
      fail(
        `${named}.returnFlight`,
        'must be "not_seen": a Google Flights round-trip price includes a return flight Hilla never sees. Copy the flights costLines entry unchanged.',
      );
    }
    if (search) checkGoogleSearch(search, { forDates, forParty, option, named, fail });
  }

  // Which of the trip's two journeys a travel price pays for: a round trip
  // (or a price without dates) both, a one-way fare the direction of its date.
  const travel = [item, ...(covers ?? [])].some((covered) => covered === "flights" || covered === "train");
  const legs = !travel
    ? []
    : per === "person_direction" || forDates === null || forDates.length === 2
      ? ["outbound", "return"]
      : forDates[0] === option.depart
        ? ["outbound"]
        : forDates[0] === option.return
          ? ["return"]
          : [];

  const includes = textList(line.includes, `${named}.includes`, { max: 6, length: 60 }, fail);
  if (status === "verified" && includes.length === 0)
    fail(`${named}.includes`, "is required for a verified price: what it covers, such as economy seats and taxes, or room only.");
  const excludes = textList(line.excludes, `${named}.excludes`, { max: 6, length: 60 }, fail);
  let basis = null;
  if (line.basis !== undefined) basis = textField(line.basis, `${named}.basis`, { max: 160 }, fail);
  else if (status === "estimate") fail(`${named}.basis`, "is required for an estimate: how it was worked out.");

  const normalized = {
    item,
    label,
    amount,
    currency: amount === null ? null : currency,
    per: per ?? null,
    count: per === "unit" ? line.count : null,
    rounds: coversGolf || perRoundExtra ? (line.rounds ?? null) : null,
    status,
    source,
    checkedAt,
    forDates,
    forParty,
    includes,
    excludes,
    basis,
    // A room price quoted with taxes included covers the hotel taxes too.
    covers: [...new Set([item, ...(covers ?? []), ...(roomPriced && taxesIncluded(includes, excludes) ? ["taxes_fees"] : [])])],
    board: line.board ?? null,
    optional: line.optional === true,
    returnFlight,
    legs,
    staleDays: checkedAt ? Math.floor((now.getTime() - Date.parse(checkedAt)) / 86_400_000) : null,
  };
  if (request && forParty && !normalized.optional) {
    const check = occupancyCheck(normalized, request, hasSupplement);
    if (check.problem) fail(named, check.problem);
    normalized.check = check;
  }
  return normalized;
}

/**
 * A Google Flights fare is for the search in its link: those dates, that
 * party, and that direction, so a fare copied onto another trip, or a one-way
 * fare flown the wrong way, never prices this one.
 */
function checkGoogleSearch(search, { forDates, forParty, option, named, fail }) {
  const dates = search.returnDate ? [search.depart, search.returnDate] : [search.depart];
  if (forDates && forDates.join() !== dates.join()) {
    fail(`${named}.forDates`, `must match its Google Flights search (${dates.join(" to ")}); copy the flights costLines entry unchanged.`);
  }
  if (forParty && forParty.adults !== search.adults) {
    fail(`${named}.forParty`, `must match its Google Flights search, which is for ${search.adults} ${search.adults === 1 ? "adult" : "adults"}.`);
  }
  const leg = search.depart === option.depart ? "outbound" : !search.returnDate && search.depart === option.return ? "return" : null;
  if (!leg) return;
  const [origins, destinations] = leg === "outbound" ? [option.from, option.to] : [option.to, option.from];
  if ((origins.length > 0 && !origins.includes(search.from)) || (destinations.length > 0 && !destinations.includes(search.to))) {
    fail(
      `${named}.source`,
      `is a Google Flights search from ${search.from} to ${search.to}, not this trip's ${leg} route (${origins.join("/") || "any"} → ${destinations.join("/") || "any"}).`,
    );
  }
}

/**
 * Hotel nights must add up to the trip: one hotel for the whole stay, or
 * several back to back, each with its check-in and check-out dates, so no
 * night is missing or charged twice.
 */
function validateStayDates(costs, option, at, fail) {
  const stays = costs.filter((line) => line.item === "hotel" && !line.optional);
  if (stays.length === 0 || !isIsoDate(option.depart) || !isIsoDate(option.return)) return;
  if (stays.some((line) => line.forDates?.length !== 2)) {
    if (stays.length > 1) fail(`${at} hotels`, "need their check-in and check-out dates in forDates when there is more than one.");
    return;
  }
  let night = option.depart;
  for (const [checkIn, checkOut] of stays.map((line) => line.forDates).sort((left, right) => left[0].localeCompare(right[0]))) {
    if (checkIn !== night) break;
    night = checkOut;
  }
  if (night !== option.return) fail(`${at} hotel dates`, `must cover every night from ${option.depart} to ${option.return}, one stay after another.`);
}

/**
 * A single supplement tops up a price quoted for people sharing a room. On a
 * price already quoted for this trip's occupancy it would be charged twice,
 * and it usually means the quote's party was entered wrongly.
 */
function validateSupplement(costs, request, at, fail) {
  // Every supplement, optional ones too: an all-in budget counts optional lines.
  if (!request?.rooms || !costs.some((line) => line.item === "single_supplement")) return;
  const tripPerRoom = request.travellers / request.rooms;
  const sharing = costs.some(
    (line) =>
      !line.optional &&
      line.item !== "single_supplement" &&
      line.covers?.includes("hotel") &&
      line.forParty?.rooms &&
      line.forParty.adults / line.forParty.rooms > tripPerRoom,
  );
  if (!sharing) {
    fail(
      `${at} single_supplement`,
      'only applies on top of a room price quoted for people sharing: set that price\'s forParty to the sharing it was quoted for, such as {"adults": 2, "rooms": 1}, or drop the supplement.',
    );
  }
}

/**
 * Each direction is paid for once. A round-trip fare, or a package with
 * flights, already includes the return, so a one-way fare on top of it (or a
 * second round trip) would charge a flight twice.
 */
function validateFlightLegs(costs, request, at, fail) {
  const paid = costs.filter((line) => line.amount !== null && (!line.optional || request?.allInclusive) && line.covers?.includes("flights"));
  const twice = ["outbound", "return"].filter((leg) => paid.filter((line) => line.legs?.includes(leg)).length > 1);
  if (twice.length > 0) {
    fail(
      `${at} flights`,
      `pay for the ${twice.join(" and ")} flight${twice.length > 1 ? "s" : ""} twice: a round-trip fare, or a package with flights, already includes both directions. Keep one round-trip fare, or one one-way fare each way.`,
    );
  }
}

/** Whether a room price's own inclusions say taxes are included, and nothing says they are not. */
function taxesIncluded(includes, excludes) {
  const tax = /\btax(?:es)?\b|skatt/i;
  const negated = /\b(?:not|no|excl(?:uding|udes|uded)?|without|extra|plus|additional|exkl(?:usive)?|utan|inte|tillkommer)\b/i;
  return includes.some((text) => tax.test(text) && !negated.test(text)) && !excludes.some((text) => tax.test(text));
}

/**
 * Whether a quote's party fits the trip. Underpricing (a price for fewer
 * people, a single room for two, a per-person price that assumes two sharing
 * for a solo traveller without a supplement) is always a problem; any other
 * mismatch is a problem for a verified price and a warning otherwise.
 */
function occupancyCheck(line, request, hasSupplement) {
  const { forParty } = line;
  const mismatch = (message) => (line.status === "verified" ? { problem: message } : { warning: message });
  const name = ITEM_NAME[line.item];
  const people = (count) => `${count} ${count === 1 ? "person" : "people"}`;

  const roomPriced = line.item === "single_supplement" || line.covers.includes("hotel");
  // Every whole-trip price is checked against the party; a room's is checked against its rooms below.
  if (line.per === "trip" && (!roomPriced || PARTY_ITEMS.has(line.item))) {
    const party = GOLFER_ITEMS.has(line.item) ? request.golfers : request.travellers;
    if (forParty.adults < party)
      return { problem: `is a whole-trip price for ${people(forParty.adults)}, but ${people(party)} are going; price the whole party.` };
    if (forParty.adults > party) return mismatch(`${name} price was for ${people(forParty.adults)}, not ${party}`);
  }

  if (!roomPriced || !request.rooms || forParty.rooms === undefined) return {};
  const tripPerRoom = request.travellers / request.rooms;
  const quotedPerRoom = forParty.adults / forParty.rooms;

  if (PERSON_BASES.has(line.per)) {
    if (quotedPerRoom > tripPerRoom && !hasSupplement && line.item !== "single_supplement") {
      return {
        problem: `is a per-person price for ${people(quotedPerRoom)} sharing a room, but the trip has ${people(tripPerRoom)} per room; add a single_supplement line or use the single-room price.`,
      };
    }
    if (quotedPerRoom < tripPerRoom) return mismatch(`${name} price was per person with ${quotedPerRoom} per room, not ${tripPerRoom}`);
    return {};
  }

  // Per room, per room-night, per unit, or the whole stay.
  if (quotedPerRoom < tripPerRoom)
    return { problem: `is a room price for ${people(quotedPerRoom)} per room, but ${people(tripPerRoom)} share each room; use a price for that occupancy.` };
  if (quotedPerRoom > tripPerRoom) return mismatch(`${name} price was for ${people(quotedPerRoom)} per room, not ${tripPerRoom}`);
  if (line.per === "trip" && forParty.rooms < request.rooms)
    return { problem: `is a whole-stay price for ${forParty.rooms} room(s), but the trip needs ${request.rooms}.` };
  if (line.per === "trip" && forParty.rooms > request.rooms) return mismatch(`${name} price was for ${forParty.rooms} rooms, not ${request.rooms}`);
  return {};
}

function validateGolf(golf, at, { request, costs, fail }) {
  if (!isPlainObject(golf)) {
    fail(at, "is required for a golf trip: rounds, courses with sources, and teeTimes.");
    return null;
  }
  unknownKeys(golf, GOLF_KEYS, at, fail);
  if (golf.rounds !== request.rounds) fail(`${at}.rounds`, `must match the ${request.rounds} rounds asked for.`);
  const covered = costs.filter((line) => line.covers?.includes("green_fees") && !line.optional).reduce((sum, line) => sum + (line.rounds ?? 0), 0);
  if (golf.rounds === request.rounds && covered !== request.rounds) {
    fail(`${at}.rounds`, `are ${request.rounds}, but the green-fee lines pay for ${covered}; every round needs a price line (or status unavailable).`);
  }

  const courses = Array.isArray(golf.courses) ? golf.courses : [];
  if (courses.length < 1 || courses.length > 4) fail(`${at}.courses`, "must list 1 to 4 courses, each with a source.");
  const checkedCourses = courses.slice(0, 4).map((course, index) => {
    const path = `${at}.courses[${index}]`;
    if (!isPlainObject(course)) {
      fail(path, "must be an object with name and source.");
      return null;
    }
    unknownKeys(course, ["name", "source", "note"], path, fail);
    const name = textField(course.name, `${path}.name`, { max: 60 }, fail);
    const source = checkLink(course.source ?? "");
    if (course.source === undefined) fail(`${path}.source`, "is required: the course's own page or a guide that supports it.");
    else if (source.problem) fail(`${path}.source`, source.problem);
    const note = course.note === undefined ? null : textField(course.note, `${path}.note`, { max: 100 }, fail);
    return { name, source: source.value ?? null, note };
  });

  const tee = golf.teeTimes;
  let teeTimes = null;
  if (!isPlainObject(tee) || !["not_checked", "seen"].includes(tee.status)) {
    fail(`${at}.teeTimes`, 'must be {"status": "not_checked"} or {"status": "seen", "source": ..., "checkedAt": ...}.');
  } else {
    unknownKeys(tee, ["status", "source", "checkedAt"], `${at}.teeTimes`, fail);
    const source = tee.source === undefined ? {} : checkLink(tee.source);
    if (source.problem) fail(`${at}.teeTimes.source`, source.problem);
    if (tee.status === "seen" && (tee.source === undefined || Number.isNaN(Date.parse(tee.checkedAt ?? "")))) {
      fail(`${at}.teeTimes`, "marked seen needs the source page and checkedAt.");
    }
    teeTimes = {
      status: tee.status,
      source: source.value ?? null,
      checkedAt: tee.status === "seen" && !Number.isNaN(Date.parse(tee.checkedAt ?? "")) ? new Date(tee.checkedAt).toISOString() : null,
    };
  }

  const extra = {};
  for (const key of ["handicap", "daylight", "practice"]) {
    if (golf[key] !== undefined) extra[key] = textField(golf[key], `${at}.${key}`, { max: 100 }, fail);
  }
  return { rounds: golf.rounds, courses: checkedCourses.filter(Boolean), teeTimes, ...extra };
}

function validateClimate(climate, at, { depart, today, fail }) {
  if (!isPlainObject(climate) || !["climate_average", "forecast"].includes(climate.kind)) {
    fail(at, 'must be {"kind": "climate_average" | "forecast", "summary": ..., "source": ...}.');
    return null;
  }
  unknownKeys(climate, ["kind", "summary", "source"], at, fail);
  const summary = textField(climate.summary, `${at}.summary`, { max: 120 }, fail);
  const source = checkLink(climate.source ?? "");
  if (source.problem) fail(`${at}.source`, source.problem);
  if (climate.kind === "forecast" && isIsoDate(depart) && dayDiff(today, depart) > FORECAST_HORIZON_DAYS) {
    fail(`${at}.kind`, `is a forecast, but the trip starts more than ${FORECAST_HORIZON_DAYS} days ahead; use a climate average and label it as one.`);
  }
  return { kind: climate.kind, summary, source: source.value ?? null };
}

function validateRecommendation(recommendation, options, fail) {
  if (recommendation === undefined) {
    if (options.length > 1) fail("recommendation", 'is required: {"option": "B", "why": "..."}, one clear pick.');
    return null;
  }
  if (!isPlainObject(recommendation)) {
    fail("recommendation", 'must be {"option": "B", "why": "..."}.');
    return null;
  }
  unknownKeys(recommendation, ["option", "why"], "recommendation", fail);
  if (!options.some((option) => option.id === recommendation.option)) fail("recommendation.option", "must be one of the option ids.");
  const why = textField(recommendation.why, "recommendation.why", { max: 200 }, fail);
  return { option: recommendation.option, why };
}

function validatePairs(pairs, options, fail) {
  if (pairs === undefined) return [];
  if (!Array.isArray(pairs) || pairs.length > 2) {
    fail("packageVsSeparate", 'must be a list of at most two {"package": "C", "separate": "B", "sameHotel": true} pairs.');
    return [];
  }
  return pairs.flatMap((pair, index) => {
    const path = `packageVsSeparate[${index}]`;
    if (!isPlainObject(pair)) {
      fail(path, "must be an object.");
      return [];
    }
    unknownKeys(pair, ["package", "separate", "sameHotel"], path, fail);
    const pkg = options.find((option) => option.id === pair.package);
    const separate = options.find((option) => option.id === pair.separate);
    if (!pkg || !pkg.costs.some((line) => line.item === "package")) fail(`${path}.package`, "must be an option with a package line.");
    if (!separate || separate.costs.some((line) => line.item === "package")) fail(`${path}.separate`, "must be an option booked without a package.");
    if (pair.sameHotel !== undefined && typeof pair.sameHotel !== "boolean") fail(`${path}.sameHotel`, "must be true or false.");
    return pkg && separate ? [{ package: pkg.id, separate: separate.id, sameHotel: pair.sameHotel === true }] : [];
  });
}

// --- Pricing --------------------------------------------------------------------------

/** The requirement groups a trip kind must price; any one item in a group covers it. */
export function requiredGroups(request) {
  const travel = ["flights", "train"];
  const groups = {
    flights: [["flights"]],
    hotel: [["hotel"], ["taxes_fees"]],
    trip: [travel, ["hotel"], ["taxes_fees"], ["airport_transfer", "local_transport", "car_rental"]],
    golf: [
      travel,
      ["hotel"],
      ["taxes_fees"],
      ["green_fees"],
      request.bringClubs === false ? ["club_rental"] : ["golf_bag"],
      ["airport_transfer", "car_rental"],
      ["course_transport", "car_rental"],
    ],
  }[request.kind];
  return request.checkedBag ? [...groups, ["baggage"]] : groups;
}

function multiplier(line, request, nights) {
  switch (line.per) {
    case "trip":
      return 1;
    case "person":
      return request.travellers;
    case "room":
      return request.rooms;
    case "room_night":
      return request.rooms * lineNights(line, nights);
    case "person_night":
      return request.travellers * lineNights(line, nights);
    case "round":
      // Green fees name their rounds; a cart or club rental per round is for every round.
      return request.golfers * (line.rounds ?? request.rounds);
    case "person_direction":
      return request.travellers * 2;
    case "golfer_direction":
      return request.golfers * 2;
    case "unit":
      return line.count;
    default:
      return 0;
  }
}

/** Nights a per-night price covers: its own check-in to check-out, or the whole trip. */
function lineNights(line, tripNights) {
  return line.forDates?.length === 2 ? dayDiff(line.forDates[0], line.forDates[1]) : tripNights;
}

/** Display-currency units per one unit of `currency`, through SEK. */
function rate(currency, display, fx) {
  if (currency === display) return 1;
  const sekPer = (code) => (code === "SEK" ? 1 : fx.sekPerUnit[code]);
  return sekPer(currency) / sekPer(display);
}

function priceOption(option, request, fx) {
  const lines = option.costs.map((line) => {
    if (line.amount === null) return { ...line, display: null, approximate: false };
    const converted = line.amount * multiplier(line, request, option.nights) * rate(line.currency, request.currency, fx);
    return { ...line, display: Math.round(converted), approximate: line.currency !== request.currency };
  });
  const counted = lines.filter((line) => !line.optional || request.allInclusive);
  const missing = requiredGroups(request)
    .filter((group) => !group.some((item) => counted.some((line) => line.covers.includes(item))))
    .map((group) => ITEM_NAME[group[0]]);
  // A one-way fare pays for one direction; the other is still unpriced, never free.
  const travel = requiredGroups(request).find((group) => group.includes("flights"));
  if (travel && !missing.includes(ITEM_NAME[travel[0]])) {
    const legs = new Set(counted.filter((line) => line.covers.some((item) => travel.includes(item))).flatMap((line) => line.legs));
    const mode = counted.some((line) => line.covers.includes("flights")) ? "flight" : "journey";
    for (const leg of ["outbound", "return"]) if (!legs.has(leg)) missing.push(`${leg} ${mode}`);
  }
  const unknown = [...new Set(counted.filter((line) => line.amount === null).map((line) => ITEM_NAME[line.item]))];
  const known = counted.reduce((sum, line) => sum + (line.display ?? 0), 0);
  const complete = missing.length === 0 && unknown.length === 0;

  const perPerson = request.travellers > 1 ? Math.round(known / request.travellers) : null;
  const perRound = request.kind === "golf" && request.rounds > 0 ? Math.round(known / request.travellers / request.rounds) : null;
  const approximate = counted.some((line) => line.approximate && line.display !== 0);

  return {
    ...option,
    lines,
    total: known,
    complete,
    missing,
    unknown,
    perPerson,
    perRound,
    approximate,
    confidence: confidenceOf(counted, complete),
    listedAirfare: counted.some((line) => line.returnFlight === "not_seen"),
    optionalLines: request.allInclusive ? [] : lines.filter((line) => line.optional),
    notes: optionNotes(option, counted),
  };
}

/** What the reader should know about one option beyond its numbers. */
function optionNotes(option, counted) {
  const notes = [];
  if (option.golf?.teeTimes?.status === "not_checked") notes.push("tee times not checked");
  const priced = new Set(counted.flatMap((line) => line.covers));
  for (const line of counted) {
    for (const excluded of line.excludes) {
      // An exclusion that another line already prices is not a gap.
      if (/golf ?bag/i.test(excluded) && priced.has("golf_bag")) continue;
      if (/checked bag/i.test(excluded) && priced.has("baggage")) continue;
      notes.push(`${ITEM_NAME[line.item]} excludes ${excluded}`);
    }
    if (line.check?.warning) notes.push(line.check.warning);
    if (line.staleDays >= 2) notes.push(`${ITEM_NAME[line.item]} price checked ${line.staleDays} days ago`);
    if (line.source === "user") notes.push(`${ITEM_NAME[line.item]} price is from the offer you sent, not checked by me`);
  }
  const oneWay = (leg) => counted.some((line) => line.item === "flights" && line.amount !== null && line.legs.length === 1 && line.legs[0] === leg);
  if (oneWay("outbound") && oneWay("return")) notes.push("flights are two one-way tickets, bought separately, each with its own bag fees and change rules");
  return [...new Set(notes)];
}

function confidenceOf(lines, complete) {
  if (!complete) return "incomplete";
  // A round-trip listing whose return flight was never seen is not a verified itinerary.
  if (lines.every((line) => line.status === "verified" && !line.returnFlight)) return "verified";
  return lines.some((line) => line.status === "estimate") ? "partly estimated" : "partly indicative";
}

function comparePackage(pair, options) {
  const pkg = options.find((option) => option.id === pair.package);
  const separate = options.find((option) => option.id === pair.separate);
  const reasons = [];
  if (pkg.depart !== separate.depart || pkg.return !== separate.return) reasons.push("different dates");
  if (!pair.sameHotel) reasons.push("not the same hotel");
  for (const option of [pkg, separate]) {
    if (!option.complete) reasons.push(`${option.id}'s total is incomplete (${[...option.missing, ...option.unknown].join(", ")})`);
  }
  const boardOf = (option) => option.lines.find((line) => !line.optional && line.board && (line.item === "package" || line.item === "hotel"))?.board ?? null;
  const [pkgBoard, separateBoard] = [boardOf(pkg), boardOf(separate)];
  if (!pkgBoard || !separateBoard) reasons.push("board basis not stated for both");
  else if (pkgBoard !== separateBoard) reasons.push(`${pkg.id} is ${pkgBoard}, ${separate.id} is ${separateBoard}`);
  // Every service must match, transport included: transfers are not a rental car.
  const services = (option) =>
    new Set(
      option.lines
        .filter((line) => !line.optional)
        .flatMap((line) => line.covers)
        .filter((item) => !["package", "single_supplement", "booking_fee", "other"].includes(item)),
    );
  const [pkgServices, separateServices] = [services(pkg), services(separate)];
  const onlyIn = (left, right) => [...left].filter((item) => !right.has(item)).map((item) => ITEM_NAME[item]);
  if (onlyIn(pkgServices, separateServices).length > 0) reasons.push(`only ${pkg.id} includes ${onlyIn(pkgServices, separateServices).join(", ")}`);
  if (onlyIn(separateServices, pkgServices).length > 0) reasons.push(`only ${separate.id} includes ${onlyIn(separateServices, pkgServices).join(", ")}`);

  const likeForLike = reasons.length === 0;
  const difference = likeForLike ? separate.total - pkg.total : null;
  return {
    package: pkg.id,
    separate: separate.id,
    likeForLike,
    difference,
    reasons,
    bothVerified: pkg.confidence === "verified" && separate.confidence === "verified",
  };
}

function describeRecommendation(recommendation, options, request) {
  const option = options.find((candidate) => candidate.id === recommendation.option);
  const complete = options.filter((candidate) => candidate.complete);
  const cheapest = complete.length > 0 ? complete.reduce((low, candidate) => (candidate.total < low.total ? candidate : low)) : null;
  // A listed airfare is a starting price whose return flight isn't seen, so a
  // ranking that rests on one says so and never calls that total complete.
  const lowest = (candidate) => (candidate.listedAirfare ? "the lowest listed total" : "the lowest complete total");
  let note;
  if (!option.complete) note = `Its total isn't complete yet: ${[...option.missing, ...option.unknown].join(", ")} still unpriced.`;
  else if (cheapest && cheapest.id !== option.id && cheapest.total < option.total) {
    note = `It costs ${formatInt(option.total - cheapest.total)} ${request.currency} more than ${cheapest.id}, ${lowest(cheapest)}.`;
    const pending = [option.listedAirfare ? "Its" : null, cheapest.listedAirfare ? `${cheapest.id}'s` : null].filter(Boolean);
    if (pending.length === 2) note += " Both final airfares still need confirming: their return flights aren't seen yet.";
    else if (pending.length === 1) note += ` ${pending[0]} final airfare still needs confirming: the return flight isn't seen yet.`;
  } else if (complete.length > 1) {
    note = option.listedAirfare
      ? "It also has the lowest listed total, but its final airfare still needs confirming: the return flight isn't seen yet."
      : `It is also the lowest complete total${complete.some((candidate) => candidate.listedAirfare) ? "; the other options' listed airfares can still change" : ""}.`;
  } else note = null;
  return { option, why: recommendation.why, note, cheapestComplete: cheapest?.id ?? null };
}

// --- Reply ------------------------------------------------------------------------------

function formatComparison({ request, options, fx, comparisons, recommended, limitations, fxWarnings, timezone, now }) {
  const cur = request.currency;
  const lines = [request.title];
  const party = [
    `${request.travellers} ${request.travellers === 1 ? "traveller" : "travellers"}`,
    request.rooms ? `${request.rooms} ${request.rooms === 1 ? "room" : "rooms"}` : null,
    request.kind === "golf" ? `${request.rounds} rounds${request.golfers !== request.travellers ? ` for ${request.golfers} golfers` : ""}` : null,
    `${cur}, ${{ flights: "flights only", hotel: "hotel only" }[request.kind] ?? "whole trip"}`,
  ].filter(Boolean);
  lines.push(party.join(" · "));
  if (request.assumptions.length > 0) lines.push(`Assumed: ${request.assumptions.join("; ")}.`);
  lines.push("", "```", ...costTable(options, request), "```");

  for (const option of options) {
    lines.push(
      "",
      `${option.id} · ${option.title} · ${formatRange(option.depart, option.return)} · ${option.nights} ${option.nights === 1 ? "night" : "nights"}`,
    );
    lines.push(`Why: ${option.why}`);
    const priced = option.lines.filter((line) => line.label && !line.optional).map((line) => line.label);
    if (priced.length > 0) lines.push(`Priced: ${priced.slice(0, 3).join(" · ")}`);
    if (option.golf) lines.push(golfLine(option.golf, request, timezone));
    if (option.climate) {
      lines.push(
        option.climate.kind === "climate_average"
          ? `Typical weather (climate average, not a forecast): ${option.climate.summary} ([source](${option.climate.source}))`
          : `Forecast: ${option.climate.summary} ([source](${option.climate.source}))`,
      );
    }
    if (option.itinerary.length > 0) lines.push("Plan:", ...option.itinerary.map((entry) => `${formatDay(entry.day)}: ${entry.plan}`));
    for (const advantage of option.advantages) lines.push(`+ ${advantage}`);
    for (const tradeOff of option.tradeOffs) lines.push(`− ${tradeOff}`);
    if (option.optionalLines.length > 0) {
      lines.push(
        `Optional, not in the total: ${option.optionalLines.map((line) => `${line.label ?? ITEM_NAME[line.item]} ${line.display === null ? "price unknown" : `${line.approximate ? "≈" : ""}${formatInt(line.display)} ${cur}`}`).join("; ")}`,
      );
    }
    const budget = budgetLine(option, request);
    if (budget) lines.push(budget);
    lines.push(`Price: ${confidenceText(option)}`);
    const optionLinks = linksFor(option, request);
    if (optionLinks.length > 0) lines.push(`Links: ${optionLinks.map((link) => `[${link.label}](${link.url})`).join(" · ")}`);
  }

  if (recommended) {
    lines.push(
      "",
      `Best overall value: ${recommended.option.id}, ${recommended.option.title}. ${recommended.why}${/[.!?]$/.test(recommended.why) ? "" : "."}${recommended.note ? ` ${recommended.note}` : ""}`,
    );
  }
  for (const comparison of comparisons) {
    if (comparison.likeForLike) {
      const qualifier = comparison.bothVerified ? "" : " (partly indicative or estimated prices)";
      const text =
        comparison.difference > 0
          ? `the package is ${formatInt(comparison.difference)} ${cur} less than booking the same trip separately${qualifier}.`
          : comparison.difference < 0
            ? `booking separately is ${formatInt(-comparison.difference)} ${cur} less than the package${qualifier}.`
            : `both cost the same${qualifier}.`;
      lines.push(`Package or separate (${comparison.package} vs ${comparison.separate}): same dates, hotel, board, rounds and inclusions, so ${text}`);
    } else {
      lines.push(
        `Package or separate (${comparison.package} vs ${comparison.separate}): not like-for-like (${comparison.reasons.join("; ")}), so no saving is claimed.`,
      );
    }
  }

  lines.push("");
  const checked = options
    .flatMap((option) => option.lines.map((line) => line.checkedAt))
    .filter(Boolean)
    .sort()
    .at(-1);
  lines.push(`Prices checked ${formatDateTime(checked ?? now.toISOString(), timezone)}.${fxSentence(options, request, fx)}`);
  if (request.kind === "golf") {
    lines.push(`Per round = the ${request.travellers > 1 ? "trip cost per person" : "whole trip cost"} divided by the rounds played, not the green fee.`);
  }
  if (options.some((option) => option.listedAirfare)) {
    lines.push(
      "Listed flights: Google Flights' round-trip price for the outbound flight shown plus the cheapest return Google pairs with it. I can't see that return flight (it may be another airline, a long layover or a separate ticket), and another return can cost more, so check the whole itinerary before you buy.",
    );
  }
  const limits = limitsText(options, [...fxWarnings, ...limitations]);
  if (limits) lines.push(`Limits: ${limits}`);
  lines.push("Nothing is booked or held, and prices can change. I can't book or pay; use the links to book yourself.");
  return lines.join("\n");
}

/** Notes shared by every option once, then each option's own, then the general ones. */
function limitsText(options, general) {
  const shared = options.length > 1 ? options[0].notes.filter((note) => options.every((option) => option.notes.includes(note))) : [];
  const parts = [];
  if (shared.length > 0) parts.push(`${capitalize(shared.join("; "))} (all options).`);
  for (const option of options) {
    const own = option.notes.filter((note) => !shared.includes(note));
    if (own.length > 0) parts.push(`${option.id}: ${own.map((note) => note.replace(/\.$/, "")).join("; ")}.`);
  }
  for (const note of general) parts.push(/[.!?]$/.test(note) ? note : `${note}.`);
  return parts.join(" ");
}

function costTable(options, request) {
  const width = 9;
  const cell = (text) => String(text).padStart(width);
  const rows = [`${"".padEnd(width)}${options.map((option) => cell(option.id)).join("")}`];
  rows.push(`${"Dates".padEnd(width)}${options.map((option) => cell(shortRange(option.depart, option.return))).join("")}`);

  const present = COST_ITEMS.filter((item) => options.some((option) => option.lines.some((line) => !line.optional && line.item === item)));
  const missingRows = COST_ITEMS.filter((item) => !present.includes(item) && options.some((option) => option.missing.includes(ITEM_NAME[item])));
  // A stay always shows its taxes, even when the room price includes them.
  const taxRow = requiredGroups(request).some((group) => group.includes("taxes_fees")) ? ["taxes_fees"] : [];
  for (const item of COST_ITEMS.filter((candidate) => present.includes(candidate) || missingRows.includes(candidate) || taxRow.includes(candidate))) {
    rows.push(`${ROW_LABEL[item].padEnd(width)}${options.map((option) => cell(itemCell(option, item))).join("")}`);
  }
  const total = (option) => (option.complete ? formatInt(option.total) : option.total > 0 ? `≥${formatInt(option.total)}` : "?");
  rows.push(`${"Total".padEnd(width)}${options.map((option) => cell(`${option.complete && option.approximate ? "≈" : ""}${total(option)}`)).join("")}`);
  if (request.travellers > 1) {
    rows.push(`${"Per pers.".padEnd(width)}${options.map((option) => cell(perCell(option, option.perPerson))).join("")}`);
  }
  if (request.kind === "golf") rows.push(`${"Per round".padEnd(width)}${options.map((option) => cell(perCell(option, option.perRound))).join("")}`);
  return rows.map((row) => row.trimEnd());
}

function itemCell(option, item) {
  const own = option.lines.filter((line) => !line.optional && line.item === item);
  if (own.length > 0) {
    if (own.some((line) => line.display === null)) return "?";
    const sum = own.reduce((total, line) => total + line.display, 0);
    return `${sum !== 0 && own.some((line) => line.approximate) ? "≈" : ""}${formatInt(sum)}`;
  }
  if (option.lines.some((line) => !line.optional && line.covers.includes(item))) return "incl.";
  return option.missing.includes(ITEM_NAME[item]) ? "?" : "–";
}

function perCell(option, value) {
  if (value === null) return "–";
  if (!option.complete) return option.total > 0 ? `≥${formatInt(value)}` : "?";
  return `${option.approximate ? "≈" : ""}${formatInt(value)}`;
}

function golfLine(golf, request, timezone) {
  const courses = golf.courses.map((course) => `[${course.name}](${course.source})${course.note ? ` (${course.note})` : ""}`).join(", ");
  const tee =
    golf.teeTimes?.status === "seen"
      ? `tee times were listed${golf.teeTimes.source ? ` on [the booking page](${golf.teeTimes.source})` : ""} at ${formatDateTime(golf.teeTimes.checkedAt, timezone)}; none is reserved`
      : `tee times not checked${golf.teeTimes?.source ? ` ([booking page](${golf.teeTimes.source}))` : ""}`;
  const extras = ["handicap", "daylight", "practice"].filter((key) => golf[key]).map((key) => golf[key]);
  return `Golf: ${golf.rounds} rounds · ${courses} · ${tee}${extras.length > 0 ? ` · ${extras.join(" · ")}` : ""}`;
}

function budgetLine(option, request) {
  if (!request.budget) return null;
  const limit = request.budget.per === "person" ? request.budget.amount * request.travellers : request.budget.amount;
  const label = `${formatInt(request.budget.amount)} ${request.currency}${request.budget.per === "person" ? " per person" : ""}`;
  if (option.total > limit)
    return `${option.complete ? "Over" : "Already over"} your ${label} budget by ${option.complete ? "" : "at least "}${formatInt(option.total - limit)} ${request.currency}.`;
  return option.complete
    ? `Within your ${label} budget.`
    : `Within your ${label} budget so far, but ${[...option.missing, ...option.unknown].join(", ")} still unpriced.`;
}

function confidenceText(option) {
  const counted = option.lines.filter((line) => !line.optional);
  const listed = (line) => line.returnFlight === "not_seen";
  const byStatus = (status, test = () => true) => [
    ...new Set(counted.filter((line) => line.status === status && test(line)).map((line) => ITEM_NAME[line.item])),
  ];
  const parts = [
    ["verified", byStatus("verified", (line) => !listed(line))],
    ["listed (return flight not seen)", byStatus("verified", listed)],
    ["indicative", byStatus("indicative")],
    ["estimated", byStatus("estimate")],
    ["unknown", [...byStatus("unavailable"), ...option.missing]],
  ]
    .filter(([, items]) => items.length > 0)
    .map(([status, items]) => `${joinWords(items)} ${status}`);
  if (option.confidence === "verified") return "verified (every cost is a concrete price for these dates and this party)";
  return `${option.complete ? "" : "incomplete: "}${parts.join("; ")}`;
}

function linksFor(option, request) {
  const links = [];
  const seen = new Set();
  const add = (label, url) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    links.push({ label, url });
  };
  for (const line of option.lines) if (line.source && line.source !== "user") add(capitalize(ITEM_NAME[line.item]), line.source);
  for (const link of option.links) add(link.label, link.url);
  const flies = option.lines.some((line) => line.covers.includes("flights") && line.item !== "package");
  const stays = option.lines.some((line) => line.item === "hotel");
  const generated = searchLinks({
    from: flies ? option.from : [],
    to: flies ? option.to : [],
    depart: option.depart,
    returnDate: option.return,
    adults: request.travellers,
    rooms: request.rooms ?? 1,
    city: stays ? option.city : null,
  });
  // Hotel search first: a flight price usually has its own source page already.
  const sourceHosts = new Set(links.map((link) => new URL(link.url).hostname));
  const ordered = [...generated.filter((link) => link.label === "Booking.com"), ...generated.filter((link) => link.label !== "Booking.com")];
  for (const link of ordered) if (!sourceHosts.has(new URL(link.url).hostname)) add(`${link.label} search`, link.url);
  return links.slice(0, 6);
}

function fxSentence(options, request, fx) {
  const used = [...new Set(options.flatMap((option) => option.lines.filter((line) => line.approximate).map((line) => line.currency)))];
  if (used.length === 0 || !fx) return "";
  const rates = used.map((currency) => `1 ${currency} = ${formatRate(rate(currency, request.currency, fx))} ${request.currency}`);
  return ` Converted at ${rates.join(", ")} (ECB rates of ${formatDay(fx.date, { year: true })}); amounts marked ≈ are approximate.`;
}

// --- Small helpers ----------------------------------------------------------------------

function textField(value, path, { max }, fail) {
  const checked = checkText(value, { max });
  if (checked.problem) {
    fail(path, checked.problem);
    return null;
  }
  return checked.value;
}

function textList(value, path, { max, length, min = 0 }, fail) {
  if (value === undefined && min === 0) return [];
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(path, `must be a list of ${min > 0 ? `${min} to ` : "up to "}${max} short texts.`);
    return [];
  }
  return value.map((entry, index) => textField(entry, `${path}[${index}]`, { max: length }, fail)).filter(Boolean);
}

function linkList(value, path, fail) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) {
    fail(path, 'must be a list of up to 4 {"label": ..., "url": ...} links.');
    return [];
  }
  return value.flatMap((link, index) => {
    if (!isPlainObject(link)) {
      fail(`${path}[${index}]`, "must be an object with label and url.");
      return [];
    }
    unknownKeys(link, ["label", "url"], `${path}[${index}]`, fail);
    const label = textField(link.label, `${path}[${index}].label`, { max: 40 }, fail);
    const url = checkLink(link.url);
    if (url.problem) fail(`${path}[${index}].url`, url.problem);
    return label && url.value ? [{ label, url: url.value }] : [];
  });
}

function codeList(value, path, fail) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3 || !value.every((code) => typeof code === "string" && /^[A-Z]{3}$/.test(code))) {
    fail(path, "must be up to 3 IATA airport codes, such as CPH.");
    return [];
  }
  return [...value];
}

function unknownKeys(object, allowed, path, fail) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, `isn't a known field (allowed: ${allowed.join(", ")}).`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInt(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function addDays(isoDate, days) {
  return new Date(Date.parse(`${isoDate}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function dayDiff(from, to) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

function weekdayOf(isoDate) {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

/** Today's date where the user is, as YYYY-MM-DD. */
export function localDate(now, timezone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function formatInt(value) {
  const sign = value < 0 ? "-" : "";
  return `${sign}${String(Math.abs(Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`;
}

function formatRate(value) {
  return value >= 10 ? value.toFixed(2) : value >= 1 ? value.toFixed(3) : value.toFixed(4);
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Fri 13 Nov", or "14 Oct 2026" with year. */
export function formatDay(isoDate, { year = false } = {}) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  const day = `${date.getUTCDate()} ${MONTH_SHORT[date.getUTCMonth()]}`;
  return year ? `${day} ${date.getUTCFullYear()}` : `${WEEKDAY_SHORT[date.getUTCDay()]} ${day}`;
}

/** "12–19 Jan 2027", "28 Jan – 4 Feb 2027", "28 Dec 2026 – 4 Jan 2027". */
export function formatRange(start, end) {
  const [a, b] = [new Date(`${start}T12:00:00Z`), new Date(`${end}T12:00:00Z`)];
  const month = (date) => MONTH_SHORT[date.getUTCMonth()];
  if (a.getUTCFullYear() !== b.getUTCFullYear())
    return `${a.getUTCDate()} ${month(a)} ${a.getUTCFullYear()} – ${b.getUTCDate()} ${month(b)} ${b.getUTCFullYear()}`;
  if (a.getUTCMonth() !== b.getUTCMonth()) return `${a.getUTCDate()} ${month(a)} – ${b.getUTCDate()} ${month(b)} ${b.getUTCFullYear()}`;
  return `${a.getUTCDate()}–${b.getUTCDate()} ${month(b)} ${b.getUTCFullYear()}`;
}

/** "12–19/1" or "28/1–4/2" for the table. */
function shortRange(start, end) {
  const [a, b] = [new Date(`${start}T12:00:00Z`), new Date(`${end}T12:00:00Z`)];
  if (a.getUTCMonth() === b.getUTCMonth()) return `${a.getUTCDate()}–${b.getUTCDate()}/${b.getUTCMonth() + 1}`;
  return `${a.getUTCDate()}/${a.getUTCMonth() + 1}–${b.getUTCDate()}/${b.getUTCMonth() + 1}`;
}

export function formatDateTime(iso, timezone = DEFAULT_TIMEZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}`;
}

function joinWords(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
