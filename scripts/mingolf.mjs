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
      case "--course":
        options.course = value;
        break;
      case "--time":
        options.time = value;
        break;
      case "--price":
        options.price = value;
        break;
      case "--payment":
        options.payment = value;
        break;
      case "--cancellation":
        options.cancellation = value;
        break;
      case "--notes":
        options.notes = value;
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

export function buildMinGolfBookingApproval(options = {}) {
  const details = normalizeBookingDetails(options);
  const target = [
    details.club,
    details.course,
    `${details.date} ${details.time}`,
    `${details.players} player${details.players === 1 ? "" : "s"}`,
  ].filter(Boolean).join(" / ");

  return {
    phase: "min-golf-booking-assist",
    requiresTelegramApproval: true,
    approvalPhrase: "approve Min Golf booking",
    sourceUrl,
    bookingDetails: details,
    approvalPrompt: {
      agent: "admin",
      action: "book-tee-time",
      target,
      expectedEffect:
        "Book the selected Min Golf tee time if the final booking summary exactly matches these details and no payment or strong authentication is required.",
      risk:
        "Wrong club, time, player count, price, cancellation rule, no-show rule, or payment requirement could create a booking you did not intend.",
      approvalOptions: [
        'Reply "approve Min Golf booking" to allow this exact booking attempt.',
        "Reply with changes to adjust the booking details.",
        "Reply deny to stop.",
      ],
    },
    browserStepsAfterApproval: [
      "Confirm the latest Telegram message explicitly says approve Min Golf booking.",
      `Open ${sourceUrl}.`,
      "If no saved session is active, ask the user to log in directly in the browser. Do not request, store, or echo Golf-ID, BankID, or password details.",
      "Return to Hitta starttid and locate the selected tee time.",
      "Select the tee time only if the visible club, course, date, time, player count, price, and cancellation information exactly matches the approved details.",
      "Review the final booking summary. If it exactly matches the approval and no hard stop is present, complete the non-payment booking.",
      "After completion, summarize the booking confirmation details back to Telegram.",
    ],
    hardStops: [
      "missing-telegram-approval",
      "details-mismatch",
      "tee-time-unavailable",
      "payment-required",
      "bankid-or-strong-auth",
      "sweetspot-redirect",
      "terms-or-cancellation-rules-changed",
      "unexpected-account-change",
    ],
    paymentPolicy:
      "Stop before payment, BankID, card entry, Swish, invoice, part payment, or any checkout page. Ask the user to take over or approve a separate future payment flow.",
  };
}

export async function runMinGolfCli(argv) {
  const parsed = parseMinGolfArgs(argv);

  if (parsed.command === "help") {
    return {
      commands: ["search", "booking-request"],
      examples: [
        'npm run mingolf -- search --club "Stockholms Golfklubb" --date 2026-05-23 --from 08:00 --to 12:00 --players 2',
        'npm run mingolf -- search --area Stockholm --date 2026-05-23 --players 1 --holes 18',
        'npm run mingolf -- booking-request --club "Stockholms Golfklubb" --course "Gamla banan" --date 2026-05-23 --time 09:40 --players 2 --price "650 SEK/player" --payment pay-later --cancellation "Cancel by 18:00 the day before"',
      ],
      phase1Boundary:
        "Search only prepares a read-only browser plan. Booking, payment, cancellation, adding players, editing bookings, cart booking, and check-in require explicit Telegram approval.",
      phase2Boundary:
        "Booking-request only drafts an approval prompt and post-approval browser checklist. It stops before payment, BankID, Sweetspot redirects, changed terms, or mismatched details.",
    };
  }

  if (parsed.command === "search") {
    return buildMinGolfSearchPlan(parsed.options);
  }

  if (parsed.command === "booking-request") {
    return buildMinGolfBookingApproval(parsed.options);
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

function normalizeBookingDetails(options) {
  const club = textOrNull(options.club);
  const course = textOrNull(options.course);
  const date = textOrNull(options.date);
  const time = textOrNull(options.time);
  const price = textOrNull(options.price);
  const payment = textOrNull(options.payment);
  const cancellation = textOrNull(options.cancellation);
  const notes = textOrNull(options.notes);
  const players = options.players === undefined ? null : positiveInteger(options.players, "--players");

  if (!club) {
    throw new Error("--club is required for Min Golf booking approval.");
  }
  if (!date) {
    throw new Error("--date is required for Min Golf booking approval.");
  }
  if (!time) {
    throw new Error("--time is required for Min Golf booking approval.");
  }
  if (!players) {
    throw new Error("--players is required for Min Golf booking approval.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("--date must use YYYY-MM-DD.");
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    throw new Error("--time must use HH:mm.");
  }

  return {
    club,
    course,
    date,
    time,
    players,
    price,
    payment,
    cancellation,
    notes,
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
