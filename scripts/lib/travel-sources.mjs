/**
 * Live sources for the travel-deals skill: Google Flights' public results page
 * and the European Central Bank's daily reference rates.
 *
 * Each lookup is one plain GET. Google Flights' robots.txt allows
 * `/travel/flights?q=...`, and the page lists current fares for the exact
 * dates and party size with taxes and required fees included. The request
 * sends the browser User-Agent that OpenClaw's own web_fetch tool sends, so
 * the helper reads the same page the agent's fetch tool would, and turns it
 * into numbers without a model in between.
 *
 * Nothing here submits a form, sends a cookie, signs in, or retries. A
 * consent, captcha, "unusual traffic" or other redirect ends the run as
 * `blocked`, and the remaining lookups are skipped rather than worked around.
 * A fare is kept only when the page confirms that its prices include taxes
 * and fees, and when the page's own passenger count, departure and return
 * dates, and the fare's trip type match the request, so a page Google
 * interpreted differently never yields a price.
 *
 * A round-trip page lists departing flights only. Each fare is "From N ...
 * round trip total": that outbound flight plus the cheapest return Google
 * pairs with it, which can be another airline, a long layover or a separate
 * ticket, and other returns cost more. Google shows the returns only after a
 * flight is selected, on /travel/flights/search and /travel/flights/booking,
 * which its robots.txt disallows, so the helper never sees a return flight.
 */

export const GOOGLE_FLIGHTS_URL = "https://www.google.com/travel/flights";
export const ECB_RATES_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

// DEFAULT_FETCH_USER_AGENT in OpenClaw 2026.7.1's web_fetch. Without a browser
// User-Agent, Google Flights redirects to an "unsupported browser" page.
export const FETCH_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** Hard cap on Google Flights requests in one helper run. */
export const MAX_FLIGHT_LOOKUPS = 8;
export const FLIGHT_LOOKUP_PAUSE_MS = 1500;
const FETCH_TIMEOUT_MS = 20_000;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The natural-language query Google Flights understands, with IATA codes. */
export function googleFlightsQuery({ from, to, depart, returnDate = null, adults = 1 }) {
  const party = adults > 1 ? ` for ${adults} adults` : "";
  return returnDate ? `Flights to ${to} from ${from} on ${depart} through ${returnDate}${party}` : `One way flights to ${to} from ${from} on ${depart}${party}`;
}

/** The results page for one search. `language` only changes the page language. */
export function googleFlightsUrl(search, { language = "en" } = {}) {
  const url = new URL(GOOGLE_FLIGHTS_URL);
  url.searchParams.set("q", googleFlightsQuery(search));
  url.searchParams.set("curr", "SEK");
  url.searchParams.set("hl", language);
  url.searchParams.set("gl", "se");
  return url.toString();
}

/**
 * Fares from one Google Flights results page.
 *
 * Status: `ok` with at least one fare; `no_listings` when the page lists
 * none; `mismatch` when it lists fares, but for another date, trip type or
 * passenger count; `unreadable` when the page is not a results page.
 */
export function parseGoogleFlightsPage(html, { depart, returnDate = null, adults = 1 }) {
  const page = String(html ?? "");
  const title =
    decodeEntities(page.match(/<title>([^<]*)<\/title>/)?.[1] ?? "")
      .replace(/\s*\|\s*Google Flights\s*$/, "")
      .trim() || null;
  if (!/Google Flights/.test(page)) return { status: "unreadable", title, offers: [], reason: "The page is not a Google Flights results page." };

  const labels = [...new Set([...page.matchAll(/aria-label="(From [^"]*)"/g)].map((match) => decodeEntities(match[1])))];
  if (labels.length === 0) return { status: "no_listings", title, offers: [], reason: "The page listed no fares for this search." };

  // Verified means taxes, party and both dates are confirmed by the page itself.
  if (!/Prices include required taxes \+ fees for \d+ adults?\./.test(page)) {
    return { status: "unreadable", title, offers: [], reason: "The page does not confirm that its prices include taxes and fees." };
  }
  const pageAdults = pagePassengers(page);
  if (pageAdults !== adults) {
    return {
      status: "mismatch",
      title,
      offers: [],
      reason:
        pageAdults === null ? "The page does not say how many passengers its prices are for." : `The page priced ${pageAdults} passenger(s), not ${adults}.`,
    };
  }
  const priced = pageDates(page);
  if (priced.depart === null) return { status: "unreadable", title, offers: [], reason: "The page does not show which dates it priced." };
  if (!dateLabelMatches(priced.depart, depart) || (returnDate ? !dateLabelMatches(priced.return, returnDate) : priced.return !== null)) {
    return {
      status: "mismatch",
      title,
      offers: [],
      reason: `The page priced ${[priced.depart, priced.return].filter(Boolean).join(" – ")}, not the dates asked for.`,
    };
  }

  const parsed = labels.map(parseFareLabel).filter(Boolean);
  const offers = parsed
    .filter((offer) => offer.roundTrip === Boolean(returnDate) && sameCalendarDay(offer.departDate, depart))
    .map((offer) => ({ ...offer, departDate: depart, arriveDate: isoOnOrAfter(depart, offer.arriveDate) }))
    .filter((offer) => offer.arriveDate !== null)
    .sort((left, right) => left.priceSek - right.priceSek);
  if (offers.length === 0) {
    return {
      status: parsed.length === 0 ? "unreadable" : "mismatch",
      title,
      offers: [],
      reason: parsed.length === 0 ? "The fares on the page could not be read." : "The listed fares are for another date or trip type.",
    };
  }
  return { status: "ok", title, offers, taxesIncluded: true };
}

/**
 * One fare label, such as "From 1626 Swedish kronor round trip total.
 * Nonstop flight with Finnair. Leaves Copenhagen Airport at 6:05 AM on
 * Friday, November 13 and arrives at Helsinki Airport at 8:40 AM on Friday,
 * November 13. Total duration 1 hr 35 min." Anything else returns null. The
 * label describes one flight; on a round-trip page that is the outbound one.
 */
export function parseFareLabel(label) {
  const text = String(label ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const price = text.match(/^From (\d[\d,]*) Swedish kronor( round trip total)?\./);
  if (!price) return null;

  const rest = text.slice(price[0].length);
  const flight = rest.match(/(?:^|\s|\.)(Nonstop|(\d+) stops?) flight with (.+?)\.(?=\s|$)/);
  const leg = rest.match(
    /Leaves (.+?) at (\d{1,2}:\d{2}\s?[AP]M) on (\w+), (\w+) (\d{1,2}) and arrives at (.+?) at (\d{1,2}:\d{2}\s?[AP]M) on (\w+), (\w+) (\d{1,2})\./,
  );
  if (!flight || !leg) return null;

  const departDate = monthDay(leg[4], leg[5], leg[3]);
  const arriveDate = monthDay(leg[9], leg[10], leg[8]);
  if (!departDate || !arriveDate) return null;

  const fareNote = rest.slice(0, flight.index + (flight[0].startsWith(".") ? 1 : 0)).trim();
  const operatedBy = rest.match(/Operated by (.+?)\.(?=\s+Leaves)/)?.[1] ?? null;
  // "overnight" only when Google says so: a long stop on a next-day arrival is not proof of one.
  const layovers = [...rest.matchAll(/Layover \(\d+ of \d+\) is an? (.+?) layover at (.+?) in ([^.]+)\./g)].map((match) => {
    const duration = match[1].replace(/\s*overnight$/, "");
    return { duration, minutes: durationMinutes(duration), overnight: /overnight$/.test(match[1]), airport: match[2], city: match[3] };
  });
  const duration = rest.match(/Total duration ([^.]+)\./)?.[1] ?? null;

  return {
    priceSek: Number(price[1].replace(/,/g, "")),
    roundTrip: Boolean(price[2]),
    stops: flight[1] === "Nonstop" ? 0 : Number(flight[2]),
    airlines: flight[3],
    operatedBy,
    fareNote: fareNote || null,
    departAirport: leg[1],
    departTime: clock24(leg[2]),
    departDate,
    arriveAirport: leg[6],
    arriveTime: clock24(leg[7]),
    arriveDate,
    duration,
    durationMinutes: durationMinutes(duration),
    layovers,
    // Google marks an itinerary sold as separate tickets; an unmarked fare is one booking.
    separateTickets: /\bSeparate tickets\b|\bself[- ]transfer\b/i.test(rest),
  };
}

/** "3 hr 50 min", "9 hr", "45 min" or "1 day 2 hr" as minutes, or null. */
export function durationMinutes(text) {
  const value = String(text ?? "").trim();
  if (!/^(?:\d+ days?)?\s*(?:\d+ hr)?\s*(?:\d+ min)?$/.test(value) || !/\d/.test(value)) return null;
  const part = (unit) => Number(value.match(new RegExp(`(\\d+) ${unit}`))?.[1] ?? 0);
  return part("days?") * 1440 + part("hr") * 60 + part("min");
}

/**
 * Looks up fares for each search in turn, at most MAX_FLIGHT_LOOKUPS. After a
 * block the rest are `skipped`; nothing is retried.
 */
export async function lookUpFlights(searches, { fetchImpl = globalThis.fetch, now = () => new Date(), pause = sleep, pauseMs = FLIGHT_LOOKUP_PAUSE_MS } = {}) {
  if (searches.length > MAX_FLIGHT_LOOKUPS) {
    throw new Error(`At most ${MAX_FLIGHT_LOOKUPS} flight lookups per run; this asked for ${searches.length}. Narrow the airports or dates.`);
  }

  const results = [];
  let blocked = null;
  for (const [index, search] of searches.entries()) {
    const url = googleFlightsUrl(search);
    if (blocked) {
      results.push({ ...search, url, status: "skipped", offers: [], reason: `Skipped: an earlier lookup was ${blocked}.` });
      continue;
    }
    if (index > 0) await pause(pauseMs);

    const checkedAt = now().toISOString();
    const page = await fetchPage(url, fetchImpl);
    if (page.status !== "ok") {
      if (page.status === "blocked") blocked = page.reason.replace(/^[A-Z]/, (letter) => letter.toLowerCase()).replace(/\.$/, "");
      results.push({ ...search, url, checkedAt, status: page.status, offers: [], reason: page.reason });
      continue;
    }
    results.push({ ...search, url, checkedAt, ...parseGoogleFlightsPage(page.body, search) });
  }
  return results;
}

/** ECB reference rates as SEK per unit of each currency. */
export function parseEcbRates(xml) {
  const text = String(xml ?? "");
  const date = text.match(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1];
  const perEuro = Object.fromEntries(
    [...text.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]\s*\/>/g)].map((match) => [match[1], Number(match[2])]),
  );
  const sekPerEuro = perEuro.SEK;
  if (!date || !Number.isFinite(sekPerEuro) || sekPerEuro <= 0) throw new Error("The ECB rates could not be read.");

  const sekPerUnit = { EUR: sekPerEuro };
  for (const [currency, rate] of Object.entries(perEuro)) {
    if (currency !== "SEK" && Number.isFinite(rate) && rate > 0) sekPerUnit[currency] = round(sekPerEuro / rate, 6);
  }
  return { date, source: ECB_RATES_URL, publisher: "European Central Bank euro reference rates", sekPerUnit };
}

export async function fetchEcbRates({ fetchImpl = globalThis.fetch } = {}) {
  const page = await fetchPage(ECB_RATES_URL, fetchImpl, { expectHost: "www.ecb.europa.eu", expectPath: "/stats/eurofxref/eurofxref-daily.xml" });
  if (page.status !== "ok") throw new Error(`The ECB rates are unavailable: ${page.reason}`);
  return parseEcbRates(page.body);
}

async function fetchPage(url, fetchImpl, { expectHost = "www.google.com", expectPath = "/travel/flights" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { "user-agent": FETCH_USER_AGENT, "accept-language": "en" },
      redirect: "follow",
      signal: controller.signal,
    });
    const finalUrl = new URL(response.url || url);
    if (response.status === 429 || response.status === 403 || response.status === 503) {
      return { status: "blocked", reason: `Refused with HTTP ${response.status}.` };
    }
    if (finalUrl.hostname !== expectHost || finalUrl.pathname !== expectPath) {
      return { status: "blocked", reason: `Redirected to ${finalUrl.hostname}${finalUrl.pathname}, which Hilla does not read.` };
    }
    if (!response.ok) return { status: "error", reason: `HTTP ${response.status}.` };
    return { status: "ok", body: await response.text() };
  } catch (error) {
    return { status: "error", reason: error.name === "AbortError" ? "Timed out." : `Request failed: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function pagePassengers(page) {
  const fromTaxes = page.match(/Prices include required taxes \+ fees for (\d+) adults?\./);
  if (fromTaxes) return Number(fromTaxes[1]);
  const fromButton = page.match(/aria-label="(\d+) passengers?, change number of passengers\."/);
  return fromButton ? Number(fromButton[1]) : null;
}

/** The dates in the page's own search form, such as "Fri, Nov 13"; a one-way page has no return. */
function pageDates(page) {
  const value = (label) => {
    const input = page.match(new RegExp(`<input[^>]*placeholder="${label}"[^>]*>`))?.[0];
    const text = input?.match(/\svalue="([^"]*)"/)?.[1];
    return text ? decodeEntities(text).trim() || null : null;
  };
  return { depart: value("Departure"), return: value("Return") };
}

/** "Fri, Nov 13" names the same weekday, month and day as the ISO date. */
function dateLabelMatches(label, isoDate) {
  const match = String(label ?? "").match(/^([A-Z][a-z]{2}), ([A-Z][a-z]{2,3}) (\d{1,2})$/);
  if (!match) return false;
  const date = new Date(`${isoDate}T12:00:00Z`);
  return (
    WEEKDAYS[date.getUTCDay()].startsWith(match[1]) && MONTHS[date.getUTCMonth()].startsWith(match[2].slice(0, 3)) && Number(match[3]) === date.getUTCDate()
  );
}

/** "November", "13", "Friday" → { month: 11, day: 13, weekday: 5 }. */
function monthDay(monthName, day, weekdayName) {
  const month = MONTHS.indexOf(monthName) + 1;
  const weekday = WEEKDAYS.indexOf(weekdayName);
  const dayNumber = Number(day);
  if (month < 1 || weekday < 0 || dayNumber < 1 || dayNumber > 31) return null;
  return { month, day: dayNumber, weekday };
}

/** Month, day and weekday must all match, so a fare for another year never passes. */
function sameCalendarDay(parsed, isoDate) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  return parsed.month === date.getUTCMonth() + 1 && parsed.day === date.getUTCDate() && parsed.weekday === date.getUTCDay();
}

/** The ISO date of an arrival on the departure day or up to two days later. */
function isoOnOrAfter(isoDate, parsed) {
  for (let offset = 0; offset <= 2; offset += 1) {
    const date = new Date(Date.parse(`${isoDate}T12:00:00Z`) + offset * 86_400_000);
    const iso = date.toISOString().slice(0, 10);
    if (sameCalendarDay(parsed, iso)) return iso;
  }
  return null;
}

function clock24(text) {
  const match = String(text).match(/^(\d{1,2}):(\d{2})\s?([AP])M$/);
  if (!match) return text;
  const hours = (Number(match[1]) % 12) + (match[3] === "P" ? 12 : 0);
  return `${String(hours).padStart(2, "0")}:${match[2]}`;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
