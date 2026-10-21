#!/usr/bin/env node
/**
 * Contract register CLI.
 *
 *   guide     the contract-renewals skill, with the register's current status (text)
 *   list      your contracts: what each costs a year and its next important date
 *   show      one contract in full, with its recent history (--id)
 *   upcoming  every contract date in the next N days (--days, default 120)
 *   status    redacted register health: counts, unreadable records, permissions
 *   find      which one contract the user's words mean
 *   add       preview a new contract, or save it after the user's yes
 *   update    preview a change, or save it after the user's yes
 *   renew     preview a renewal (new term dates and price), or save it after the user's yes
 *   end       preview marking a contract ended, or save it after the user's yes
 *   remove    preview deleting a record and its history, or delete it after the user's yes
 *   monitor   turn the renewal watch on or off for one contract, on the user's request
 *
 * Everything the user said or a document showed arrives as JSON on stdin
 * through a quoted heredoc, so contract details never enter a shell argument.
 * A write is a preview unless its JSON carries the preview's digest and the
 * user's exact reply as `approval`. Nothing here cancels, switches, signs,
 * buys or contacts a provider.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawStateDir } from "./lib/commands.mjs";
import { projectPath } from "./lib/config.mjs";
import { CONTRACT_TIMEZONE, localDate } from "./lib/contract-dates.mjs";
import {
  CONTRACT_ACTIONS,
  CONTRACT_ID_PATTERN,
  createContractStore,
  describeContractName,
  formatContractDetail,
  formatContractList,
  formatRegisterStatus,
  formatUpcoming,
  registerStatus,
  resolveContract,
  runContractAction,
  summarizeContract,
  upcomingContractDates,
} from "./lib/contracts.mjs";
import { mergedEnv } from "./lib/env.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");
export const CONTRACT_SKILL_PATH = "agents/personal/skills/contract-renewals/SKILL.md";
const READ_COMMANDS = ["guide", "list", "show", "upcoming", "status", "find"];
const COMMANDS = [...READ_COMMANDS, ...CONTRACT_ACTIONS, "help"];
const DEFAULT_UPCOMING_DAYS = 120;

export function parseContractsArgs(argv) {
  const [first = "help", ...rest] = argv;
  const command = first === "--help" || first === "-h" ? "help" : first;
  if (!COMMANDS.includes(command)) throw new Error(`Unknown contracts command: ${command}. Run help for the commands.`);
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--help" || arg === "-h") return { command: "help", options: {} };
    if (arg === "--json-stdin") options.jsonStdin = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--id" || arg === "--days") {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      options[arg.slice(2)] = value;
      index += 1;
    } else throw new Error(`Unknown contracts option: ${arg}`);
  }

  const allowed = {
    guide: [],
    list: ["all"],
    show: ["id"],
    upcoming: ["days"],
    status: [],
    find: ["jsonStdin"],
    help: [],
    ...Object.fromEntries(CONTRACT_ACTIONS.map((action) => [action, ["jsonStdin"]])),
  }[command];
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new Error(`${command} does not take --${key === "jsonStdin" ? "json-stdin" : key}.`);
  }
  if (command === "show" && (!options.id || !CONTRACT_ID_PATTERN.test(options.id))) throw new Error("show requires --id with a contract id such as ct-1a2b3c4d.");
  if (options.days !== undefined) {
    const days = Number(options.days);
    if (!Number.isInteger(days) || days < 1 || days > 730) throw new Error("--days must be a whole number from 1 to 730.");
    options.days = days;
  }
  if ((command === "find" || CONTRACT_ACTIONS.includes(command)) && !options.jsonStdin) {
    throw new Error(`${command} reads its JSON from stdin: npm run --silent contracts -- ${command} --json-stdin <<'JSON' ... JSON`);
  }
  return { command, options };
}

export async function runContractsCli(argv, { root = projectRoot, env, stateDir, now = new Date(), stdin = process.stdin } = {}) {
  const { command, options } = parseContractsArgs(argv);
  if (command === "help") return help();

  const resolvedEnv = env ?? mergedEnv(projectPath(root, ".env"));
  const store = createContractStore({ stateDir: stateDir ?? resolveOpenClawStateDir(resolvedEnv, root) });
  const timezone = resolvedEnv.ASSISTANT_TIMEZONE || CONTRACT_TIMEZONE;
  const today = localDate(now, timezone);

  switch (command) {
    case "guide":
      return guide({ root, store });
    case "list": {
      const { records, issues } = store.listWithIssues();
      const shown = records.filter((record) => options.all || record.status === "active");
      return {
        contracts: shown.map((record) => summarizeContract(record, { today })),
        unreadable: issues.length,
        telegramText: formatContractList(records, issues, { today, all: Boolean(options.all) }),
      };
    }
    case "show": {
      const record = store.read(options.id);
      return { contract: record, telegramText: formatContractDetail(record, { today }) };
    }
    case "upcoming": {
      const days = options.days ?? DEFAULT_UPCOMING_DAYS;
      const { records, issues } = store.listWithIssues();
      return {
        days,
        dates: upcomingContractDates(records, { today, days }).map(({ record, entry, daysLeft }) => ({ id: record.id, name: describeContractName(record), ...entry, daysLeft })),
        unreadable: issues.length,
        telegramText: formatUpcoming(records, issues, { today, days }),
      };
    }
    case "status": {
      const status = registerStatus(store);
      return { ...status, telegramText: formatRegisterStatus(status) };
    }
    case "find":
      return find(await readJsonInput(stdin), { store, today });
    default:
      return runContractAction(command, await readJsonInput(stdin), { store, now, today });
  }
}

function find(input, { store, today }) {
  const extra = Object.keys(input).filter((key) => !["target", "includeEnded"].includes(key));
  if (extra.length > 0 || typeof input.target !== "string" || input.target.length > 80) {
    throw new Error('find takes {"target": "the user\'s words for the contract", "includeEnded": false}.');
  }
  const { records, issues } = store.listWithIssues();
  const resolution = resolveContract(records, { target: input.target }, { includeEnded: input.includeEnded === true });
  return {
    status: resolution.status,
    contract: resolution.status === "resolved" ? summarizeContract(resolution.record, { today }) : null,
    candidates: resolution.status === "ambiguous" ? resolution.candidates.map((record) => ({ id: record.id, name: describeContractName(record) })) : [],
    unreadable: issues.length,
  };
}

/** The guide always prints; an unreadable register is reported, never hidden. */
function guide({ root, store }) {
  const skill = readFileSync(projectPath(root, CONTRACT_SKILL_PATH), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  let statusText;
  try {
    statusText = formatRegisterStatus(registerStatus(store));
  } catch (error) {
    statusText = `The contract register could not be read: ${error.message}`;
  }
  return { text: `Current contract register status:\n${statusText}\n\n${skill}` };
}

function help() {
  return {
    commands: COMMANDS.filter((command) => command !== "help"),
    examples: [
      "npm run --silent contracts -- list",
      "npm run --silent contracts -- upcoming --days 90",
      "npm run --silent contracts -- show --id ct-1a2b3c4d",
      "npm run --silent contracts -- add --json-stdin <<'JSON'\n{\"category\":\"car_insurance\",\"provider\":\"Example Insurance\",\"currentPrice\":{\"amount\":5400,\"currency\":\"SEK\",\"period\":\"year\"},\"renewalDate\":\"2027-03-01\",\"discountEndDate\":\"2027-03-01\",\"monitor\":true}\nJSON",
      "npm run --silent contracts -- add --json-stdin <<'JSON'\n{ ...the same contract..., \"approval\": {\"digest\": \"<digest from the preview>\", \"replyText\": \"<the user's exact reply>\"}}\nJSON",
      "npm run --silent contracts -- update --json-stdin <<'JSON'\n{\"target\":\"my electricity\",\"changes\":{\"terms\":{\"annualConsumptionKwh\":9000}},\"reason\":\"I use about 9000 kWh a year\"}\nJSON",
      "npm run --silent contracts -- monitor --json-stdin <<'JSON'\n{\"id\":\"ct-1a2b3c4d\",\"enabled\":false}\nJSON",
    ],
    safety:
      "A private local register. Writes are previews until the user's yes comes back with the preview's digest. It never cancels, switches, signs or buys anything and never contacts a provider.",
  };
}

async function readJsonInput(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("--json-stdin needs a JSON object on stdin.");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Node's message quotes the input around the error; contract details stay out of errors.
    const position = /position (\d+)/.exec(error.message)?.[1];
    throw new Error(`The contract JSON is not valid JSON${position ? ` (at character ${position})` : ""}.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The contract JSON must be an object.");
  return parsed;
}

export function formatContractsCliResult(command, result) {
  return command === "guide" ? result.text : JSON.stringify(result, null, 2);
}

if (process.argv[1] && currentFile === resolve(process.argv[1])) {
  try {
    const argv = process.argv.slice(2);
    const result = await runContractsCli(argv);
    console.log(formatContractsCliResult(parseContractsArgs(argv).command, result));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
