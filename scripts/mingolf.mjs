#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const sourceUrl = "https://mingolf.golf.se/";

const forbiddenActions = [
  "book-tee-time",
  "pay-greenfee",
  "add-player",
  "remove-player",
  "cancel-tee-time",
  "edit-booking",
  "book-cart",
  "check-in",
];

export function parseMinGolfArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const value = rest[index + 1];

    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }
    index += 1;

    switch (arg) {
      case "--club":
        options.club = value;
        break;
      case "--area":
        options.area = value;
        break;
      case "--date":
        options.date = value;
        break;
      case "--from":
        options.from = value;
        break;
      case "--to":
        options.to = value;
        break;
      case "--players":
        options.players = positiveInteger(value, "--players");
        break;
      case "--holes":
        options.holes = positiveInteger(value, "--holes");
        break;
      default:
        throw new Error(`Unknown Min Golf option: ${arg}`);
    }
  }

  return { command, options };
}

export function buildMinGolfSearchPlan(options = {}) {
  const criteria = normalizeSearchCriteria(options);

  return {
    phase: "min-golf-availability-search",
    readOnly: true,
    sourceUrl,
    criteria,
    browserSteps: [
      `Open ${sourceUrl}.`,
      "If no saved session is active, ask the user to log in directly in the browser. Do not request, store, or echo Golf-ID, BankID, or password details.",
      "Open Hitta starttid.",
      "Set players, club or area, date, time window, and holes from the criteria.",
      "Click Visa starttider/search only.",
      "Summarize visible tee times with club, course, date, time, price or greenfee if visible, booking fee if visible, remaining spots, and cancellation or no-show notes if visible.",
      "Do not click Boka, pay, check in, cancel, edit, add players, or submit any form that changes the account or booking state.",
    ],
    forbiddenActions,
    approvalReminder:
      "Booking, payment, cancellation, adding players, editing bookings, cart booking, and check-in require explicit Telegram approval and are out of Phase 1.",
  };
}

export async function runMinGolfCli(argv) {
  const parsed = parseMinGolfArgs(argv);

  if (parsed.command === "help") {
    return {
      commands: ["search"],
      examples: [
        'npm run mingolf -- search --club "Stockholms Golfklubb" --date 2026-05-23 --from 08:00 --to 12:00 --players 2',
        'npm run mingolf -- search --area Stockholm --date 2026-05-23 --players 1 --holes 18',
      ],
      phase1Boundary:
        "This helper only prepares a read-only browser plan. Booking, payment, cancellation, adding players, editing bookings, cart booking, and check-in require explicit Telegram approval and are not performed by this command.",
    };
  }

  if (parsed.command === "search") {
    return buildMinGolfSearchPlan(parsed.options);
  }

  throw new Error(`Unknown Min Golf command: ${parsed.command}`);
}

function normalizeSearchCriteria(options) {
  const club = textOrNull(options.club);
  const area = textOrNull(options.area);
  const date = textOrNull(options.date);
  const from = textOrNull(options.from);
  const to = textOrNull(options.to);
  const players = options.players === undefined ? 1 : positiveInteger(options.players, "--players");
  const holes = options.holes === undefined ? null : positiveInteger(options.holes, "--holes");

  if (!date) {
    throw new Error("--date is required for Min Golf tee-time search.");
  }
  if (!club && !area) {
    throw new Error("--club or --area is required for Min Golf tee-time search.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("--date must use YYYY-MM-DD.");
  }
  if (from && !/^\d{2}:\d{2}$/.test(from)) {
    throw new Error("--from must use HH:mm.");
  }
  if (to && !/^\d{2}:\d{2}$/.test(to)) {
    throw new Error("--to must use HH:mm.");
  }

  return {
    club,
    area,
    date,
    from,
    to,
    players,
    holes,
  };
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function textOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const result = await runMinGolfCli(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
