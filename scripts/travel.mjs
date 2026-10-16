#!/usr/bin/env node
/**
 * Travel & Deals helper for the travel-deals skill
 * (agents/personal/skills/travel-deals/SKILL.md).
 *
 *   flights  live Google Flights fares for up to 8 route/date lookups, with a
 *            Telegram summary and ready-made verified cost lines
 *   dates    a spread of departure dates from a flexible window
 *   fx       today's ECB reference rates as SEK per unit
 *   links    provider search links for a route, dates and party
 *   compare  totals, honesty checks and the Telegram reply for 1-3 options
 *
 * Research only. It never books, reserves, submits a form, signs in, stores
 * anything, or creates a task, reminder or scheduled job. flights and fx make
 * plain GET requests; dates, links and compare work offline on their input.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectPath } from "./lib/config.mjs";
import { mergedEnv } from "./lib/env.mjs";
import {
  DEFAULT_TIMEZONE,
  MAX_DATE_PAIRS,
  buildComparison,
  cleanFlightResults,
  dayDiff,
  isIsoDate,
  localDate,
  sampleDepartureDates,
  searchLinks,
  summarizeFlightLookups,
} from "./lib/travel-deals.mjs";
import { MAX_FLIGHT_LOOKUPS, fetchEcbRates, lookUpFlights } from "./lib/travel-sources.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");

const COMMANDS = ["flights", "dates", "fx", "links", "compare", "help"];
const VALUE_FLAGS = Object.freeze({
  "--from": "from",
  "--to": "to",
  "--depart": "depart",
  "--return": "returnDate",
  "--dates": "dates",
  "--depart-between": "window",
  "--nights": "nights",
  "--weekdays": "weekdays",
  "--max-dates": "maxDates",
  "--adults": "adults",
  "--rooms": "rooms",
  "--city": "city",
  "--input-json": "inputJson",
});
const SWITCHES = Object.freeze({ "--one-way": "oneWay", "--json-stdin": "jsonStdin", "--text": "text" });
const BOOKING_HORIZON_DAYS = 330;

export const TRAVEL_USAGE = [
  "Usage:",
  "  travel flights --from CPH[,MMX] --to AGP[,FAO] (--depart D [--return R | --one-way] | --dates D/R[,D/R] | --depart-between A..B --nights N [--weekdays fri] [--max-dates 4]) [--adults N] [--text]",
  "  travel dates --depart-between A..B --nights N [--weekdays fri,sat] [--max-dates 4]",
  "  travel fx",
  "  travel links --from CPH --to HEL --depart D [--return R] [--adults N] [--rooms N] [--city NAME]",
  "  travel compare --json-stdin [--text]",
].join("\n");

export function parseTravelArgs(argv) {
  const [command = "help", ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new Error(`Unknown travel command: ${command}\n${TRAVEL_USAGE}`);
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (SWITCHES[arg]) {
      options[SWITCHES[arg]] = true;
      continue;
    }
    const key = VALUE_FLAGS[arg];
    if (!key) throw new Error(`Unknown travel option: ${arg}\n${TRAVEL_USAGE}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
    options[key] = value;
    index += 1;
  }
  return options;
}

export async function runTravelCli(
  argv,
  { root = projectRoot, env, now = new Date(), stdin = process.stdin, fetchImpl = globalThis.fetch, pause, pauseMs } = {},
) {
  const options = parseTravelArgs(argv);
  const resolvedEnv = env ?? mergedEnv(projectPath(root, ".env"));
  const timezone = String(resolvedEnv.ASSISTANT_TIMEZONE ?? "").trim() || DEFAULT_TIMEZONE;
  const today = localDate(now, timezone);

  switch (options.command) {
    case "help":
      return { usage: TRAVEL_USAGE };
    case "dates":
      return {
        pairs: datePairs(options, today),
        note: "Departure dates spread across the window and across weekdays. Check each one; never assume the cheapest.",
      };
    case "fx": {
      const fx = await fetchEcbRates({ fetchImpl });
      return {
        fx,
        note: 'compare fetches these itself when its input says "fx": "ecb". Converted prices are approximate: banks and card issuers use their own rates.',
      };
    }
    case "links":
      return { links: linksFor(options, today), note: "Search pages with live prices on each provider's own site. Nothing is booked." };
    case "flights":
      return flights(options, { today, now, timezone, fetchImpl, pause, pauseMs });
    case "compare": {
      const input = await readInput(options, stdin);
      // "fx": "ecb" fetches the official rates here, so no rate is ever typed by the model.
      if (input !== null && typeof input === "object" && input.fx === "ecb") {
        try {
          input.fx = await fetchEcbRates({ fetchImpl });
        } catch (error) {
          return { ok: false, problems: [`fx ${error.message} Give every price in SEK, or try again later.`], warnings: [], telegramText: null };
        }
      }
      const result = buildComparison(input, { now, timezone });
      return result.ok
        ? { ...result, guidance: "Send telegramText as your reply, word for word. Never change a price, total, label or link in it." }
        : {
            ...result,
            telegramText: null,
            guidance: "Nothing to send yet: fix these problems in the input and run compare again. Never write the totals yourself.",
          };
    }
    default:
      throw new Error(TRAVEL_USAGE);
  }
}

async function flights(options, { today, now, timezone, fetchImpl, pause, pauseMs }) {
  const origins = airportList(options.from, "--from");
  const destinations = airportList(options.to, "--to");
  const adults = partySize(options.adults ?? "1", "--adults");
  const pairs = datePairs(options, today);
  const searches = pairs.flatMap((pair) =>
    origins.flatMap((from) => destinations.map((to) => ({ from, to, depart: pair.depart, returnDate: pair.return ?? null, adults }))),
  );
  if (searches.length > MAX_FLIGHT_LOOKUPS) {
    throw new Error(`That is ${searches.length} lookups; the limit is ${MAX_FLIGHT_LOOKUPS} per run. Use fewer airports or dates (--max-dates).`);
  }

  const fetched = await lookUpFlights(searches, {
    fetchImpl,
    now: () => now,
    ...(pause ? { pause } : {}),
    ...(pauseMs !== undefined ? { pauseMs } : {}),
  });
  const results = cleanFlightResults(fetched);
  const summary = summarizeFlightLookups(results, { adults, timezone });
  return {
    source: "Google Flights",
    adults,
    lookups: results.map((result) => ({
      from: result.from,
      to: result.to,
      depart: result.depart,
      return: result.returnDate,
      url: result.url,
      checkedAt: result.checkedAt ?? null,
      status: result.status,
      ...(result.title ? { title: result.title } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      // Round-trip offers describe the outbound flight only; their price includes a return never seen.
      ...(result.returnDate && result.offers.length > 0 ? { returnFlight: "not_seen" } : {}),
      offers: result.offers.slice(0, 3),
    })),
    lowest: summary.lowest,
    costLines: summary.costLines,
    telegramText: summary.telegramText,
    guidance:
      'For a flight-only question, send telegramText word for word. For a whole trip, copy a costLines entry into compare unchanged. These are verified listings for these dates and this party; bags and golf bags are extra unless stated. A round-trip entry ("returnFlight": "not_seen") is the outbound flight shown plus a return you have not seen: never describe the return flight or call it a confirmed itinerary. To see both flights, look up each direction with --one-way.',
  };
}

function datePairs(options, today) {
  const pairs = [];
  if (options.window) {
    const [start, end] = String(options.window).split("..");
    const nights = options.nights === undefined ? null : integer(options.nights, "--nights");
    if (nights === null && !options.oneWay) throw new Error("--depart-between needs --nights, or --one-way.");
    const weekdays = options.weekdays ? options.weekdays.split(",").map((day) => day.trim().toLowerCase().slice(0, 3)) : null;
    const max = options.maxDates === undefined ? 4 : integer(options.maxDates, "--max-dates");
    const sampled = sampleDepartureDates({ start, end, nights: nights ?? 1, weekdays, max });
    pairs.push(...sampled.map((pair) => ({ depart: pair.depart, return: options.oneWay ? null : pair.return, weekday: pair.weekday })));
  } else if (options.dates) {
    for (const entry of String(options.dates).split(",")) {
      const [depart, returnDate] = entry.trim().split("/");
      pairs.push({ depart, return: returnDate ?? null });
    }
    if (pairs.length > MAX_DATE_PAIRS) throw new Error(`At most ${MAX_DATE_PAIRS} date pairs.`);
  } else if (options.depart) {
    if (!options.returnDate && !options.oneWay) throw new Error("--depart needs --return, or --one-way for a one-way trip.");
    pairs.push({ depart: options.depart, return: options.oneWay ? null : options.returnDate });
  } else {
    throw new Error(`Give dates: --depart and --return, --dates, or --depart-between with --nights.\n${TRAVEL_USAGE}`);
  }

  for (const pair of pairs) {
    if (!isIsoDate(pair.depart) || (pair.return !== null && !isIsoDate(pair.return)))
      throw new Error(`Dates must be YYYY-MM-DD: ${pair.depart}${pair.return ? `/${pair.return}` : ""}.`);
    if (pair.return !== null && pair.return <= pair.depart) throw new Error(`The return (${pair.return}) must be after the departure (${pair.depart}).`);
    if (pair.depart < today) throw new Error(`${pair.depart} is in the past.`);
    if (dayDiff(today, pair.depart) > BOOKING_HORIZON_DAYS)
      throw new Error(`${pair.depart} is more than ${BOOKING_HORIZON_DAYS} days ahead; fares aren't listed that far out.`);
  }
  return pairs;
}

function linksFor(options, today) {
  const from = options.from ? airportList(options.from, "--from") : [];
  const to = options.to ? airportList(options.to, "--to") : [];
  if (!isIsoDate(options.depart ?? "") || options.depart < today) throw new Error("--depart must be a future date, YYYY-MM-DD.");
  if (options.returnDate !== undefined && (!isIsoDate(options.returnDate) || options.returnDate <= options.depart)) {
    throw new Error("--return must be a date after --depart.");
  }
  const city =
    options.city === undefined
      ? null
      : String(options.city)
          .replace(/[^\p{L}\p{N} .,'-]/gu, "")
          .trim()
          .slice(0, 40) || null;
  const links = searchLinks({
    from,
    to,
    depart: options.depart,
    returnDate: options.returnDate ?? null,
    adults: partySize(options.adults ?? "1", "--adults"),
    rooms: partySize(options.rooms ?? "1", "--rooms"),
    city,
  });
  if (links.length === 0) throw new Error("Give --from and --to for flight links, or --city with --return for hotel links.");
  return links;
}

function airportList(value, flag) {
  if (!value) throw new Error(`${flag} needs one to three IATA airport codes, such as CPH or CPH,MMX.`);
  const codes = [
    ...new Set(
      String(value)
        .split(",")
        .map((code) => code.trim().toUpperCase()),
    ),
  ];
  if (codes.length > 3 || !codes.every((code) => /^[A-Z]{3}$/.test(code)))
    throw new Error(`${flag} needs one to three IATA airport codes, such as CPH or CPH,MMX.`);
  return codes;
}

function partySize(value, flag) {
  const count = integer(value, flag);
  if (count < 1 || count > 9) throw new Error(`${flag} must be 1 to 9.`);
  return count;
}

function integer(value, flag) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${flag} must be a whole number.`);
  return Number(value);
}

async function readInput(options, stdin) {
  if (options.inputJson !== undefined && options.jsonStdin) throw new Error("Use either --input-json or --json-stdin.");
  let text = options.inputJson;
  if (text === undefined) {
    if (!options.jsonStdin) throw new Error("compare needs --json-stdin (a quoted heredoc) or --input-json.");
    const chunks = [];
    for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    text = Buffer.concat(chunks).toString("utf8");
  }
  try {
    return JSON.parse(String(text).trim());
  } catch (error) {
    throw new Error(`The compare input is not valid JSON: ${error.message}`);
  }
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const argv = process.argv.slice(2);
    const options = parseTravelArgs(argv);
    const result = await runTravelCli(argv);
    if (options.text && result.telegramText) console.log(result.telegramText);
    else if (result.usage) console.log(result.usage);
    else console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
