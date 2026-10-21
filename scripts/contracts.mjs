#!/usr/bin/env node
/**
 * Contract register and renewal watch CLI.
 *
 *   guide            the contract-renewals skill, with the register's current status (text)
 *   list             your contracts: what each costs a year and its next important date
 *   show             one contract in full, with its recent history (--id)
 *   upcoming         every contract date in the next N days (--days, default 120)
 *   status           redacted register health: counts, unreadable records, permissions
 *   find             which one contract the user's words mean
 *   add              preview a new contract, or save it after the user's yes
 *   update           preview a change, or save it after the user's yes
 *   renew            preview a renewal (new term dates and price), or save it after the user's yes
 *   end              preview marking a contract ended, or save it after the user's yes
 *   remove           preview deleting a record and its history, or delete it after the user's yes
 *   monitor          turn the renewal watch on or off for one contract, on the user's request
 *   watch            the daily renewal check; the scheduled job runs it with --scheduled,
 *                    and without it the command only previews today's alerts
 *   watch-status     redacted watch health, with the live job's state
 *   watch-install    install or update the daily job in the live scheduler (--dry-run first)
 *   watch-selftest   a deployment check with a made-up contract in a separate register
 *   research-brief   what the research agent needs for one open request (--request)
 *   research-submit  the research agent's findings, checked and stored
 *   offers           the latest comparison for one contract (--id)
 *   alerts           recent renewal alerts, to match a reply to what was sent
 *   ack              the user's answer to an alert: keep, renewed, dismiss, snooze, recheck
 *
 * Everything the user said, a document showed or research found arrives as
 * JSON on stdin through a quoted heredoc, so contract details never enter a
 * shell argument. A write is a preview unless its JSON carries the preview's
 * digest and the user's exact reply as `approval`. Nothing here cancels,
 * switches, signs, buys or contacts a provider.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawCommand, resolveOpenClawConfigPath, resolveOpenClawStateDir } from "./lib/commands.mjs";
import { projectPath, readJson } from "./lib/config.mjs";
import { CONTRACT_TIMEZONE, addDays, localDate } from "./lib/contract-dates.mjs";
import {
  CONTRACT_WATCH_JOB,
  REQUEST_ID_PATTERN,
  acknowledgeAlert,
  buildContractWatchJob,
  contractWatchJobMismatches,
  contractWatchSettings,
  createResearchAgentRunner,
  createWatchStore,
  formatWatchStatus,
  latestComparison,
  planContractWatchInstall,
  recentAlerts,
  researchBrief,
  researchHandoffMessage,
  runContractWatch,
  submitResearch,
  watchStatusView,
} from "./lib/contract-watch.mjs";
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
import { changedJobs, createGatewayCron, createOpenClawCliRunner, createSecretRedactor, publicCronJob } from "./lib/live-cron.mjs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFile), "..");
export const CONTRACT_SKILL_PATH = "agents/personal/skills/contract-renewals/SKILL.md";
const READ_COMMANDS = ["guide", "list", "show", "upcoming", "status", "find"];
const WATCH_COMMANDS = ["watch", "watch-status", "watch-install", "watch-selftest", "research-brief", "research-submit", "offers", "alerts", "ack"];
const COMMANDS = [...READ_COMMANDS, ...CONTRACT_ACTIONS, ...WATCH_COMMANDS, "help"];
const DEFAULT_UPCOMING_DAYS = 120;
/** The watch counts as running when its last scheduled check is this recent. */
const HEARTBEAT_MAX_AGE_MS = 50 * 3_600_000;
const SELFTEST_DIR = "contracts-selftest";
const STDIN_COMMANDS = new Set(["find", "research-submit", "ack", ...CONTRACT_ACTIONS]);

export function parseContractsArgs(argv) {
  const [first = "help", ...rest] = argv;
  const command = first === "--help" || first === "-h" ? "help" : first;
  if (!COMMANDS.includes(command)) throw new Error(`Unknown contracts command: ${command}. Run help for the commands.`);
  const options = {};
  const flags = { "--json-stdin": "jsonStdin", "--all": "all", "--scheduled": "scheduled", "--dry-run": "dryRun", "--deliver": "deliver", "--selftest": "selftest" };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--help" || arg === "-h") return { command: "help", options: {} };
    if (flags[arg]) options[flags[arg]] = true;
    else if (arg === "--id" || arg === "--days" || arg === "--request") {
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
    watch: ["scheduled"],
    "watch-status": [],
    "watch-install": ["dryRun"],
    "watch-selftest": ["deliver"],
    "research-brief": ["request", "selftest"],
    "research-submit": ["jsonStdin", "selftest"],
    offers: ["id"],
    alerts: ["days"],
    ack: ["jsonStdin"],
    ...Object.fromEntries(CONTRACT_ACTIONS.map((action) => [action, ["jsonStdin"]])),
  }[command];
  const flagName = (key) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new Error(`${command} does not take ${flagName(key)}.`);
  }
  if ((command === "show" || command === "offers") && (!options.id || !CONTRACT_ID_PATTERN.test(options.id))) {
    throw new Error(`${command} requires --id with a contract id such as ct-1a2b3c4d.`);
  }
  if (command === "research-brief" && (!options.request || !REQUEST_ID_PATTERN.test(options.request))) {
    throw new Error("research-brief requires --request with a request id such as rq-1a2b3c4d.");
  }
  if (options.days !== undefined) {
    const days = Number(options.days);
    if (!Number.isInteger(days) || days < 1 || days > 730) throw new Error("--days must be a whole number from 1 to 730.");
    options.days = days;
  }
  if (STDIN_COMMANDS.has(command) && !options.jsonStdin) {
    throw new Error(`${command} reads its JSON from stdin: npm run --silent contracts -- ${command} --json-stdin <<'JSON' ... JSON`);
  }
  return { command, options };
}

/**
 * Everything is injectable for tests: the live scheduler (`cron`), the
 * research turn (`runAgent`), the policy and the schedules. Left out, they come
 * from the Gateway's own CLI and the repo config.
 */
export async function runContractsCli(argv, overrides = {}) {
  const { command, options } = parseContractsArgs(argv);
  if (command === "help") return help();
  const context = createContext(overrides, { selftest: options.selftest === true });
  const { store, today, now } = context;

  switch (command) {
    case "guide":
      return guide(context);
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
      return { contract: record, telegramText: formatContractDetail(record, { today, watchRunning: context.watchRunning() }) };
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
      return { ...status, telegramText: formatRegisterStatus(status, { watchRunning: context.watchRunning() }) };
    }
    case "find":
      return find(await readJsonInput(context.stdin), context);
    case "watch":
      return watch(options, context);
    case "watch-status":
      return watchStatus(context);
    case "watch-install":
      return watchInstall(options, context);
    case "watch-selftest":
      return watchSelftest(options, context);
    case "research-brief":
      return brief(options, context);
    case "research-submit":
      return submitResearch({ store, watchStore: context.watchStore, input: await readJsonInput(context.stdin), now, today });
    case "offers": {
      const record = store.read(options.id);
      return { contractId: record.id, ...latestComparison({ record, state: context.watchStore.read(record.id), today }) };
    }
    case "alerts":
      return { alerts: recentAlerts({ store, watchStore: context.watchStore, now, days: options.days ?? 30 }), guidance: "Match the user's reply to the alert it answers; ask if more than one could fit." };
    case "ack":
      return acknowledgeAlert({ store, watchStore: context.watchStore, input: await readJsonInput(context.stdin), today });
    default: {
      const result = runContractAction(command, await readJsonInput(context.stdin), { store, now, today, watchRunning: context.watchRunning() });
      // An ended or deleted contract's watch notes (alerts, research) go with it.
      const goneId = (command === "remove" && result.status === "removed" && result.contractId) || (command === "end" && result.status === "saved" && result.contract?.id);
      if (goneId) context.watchStore.remove(goneId);
      return result;
    }
  }
}

function createContext(
  { root = projectRoot, env, stateDir, now = new Date(), stdin = process.stdin, cron, runAgent, policy, schedules, nodePath = process.execPath } = {},
  { selftest = false } = {},
) {
  const resolvedEnv = env ?? mergedEnv(projectPath(root, ".env"));
  const baseStateDir = stateDir ?? resolveOpenClawStateDir(resolvedEnv, root);
  // The self-test keeps its made-up contract in a separate register, never the real one.
  const registerDir = selftest ? join(baseStateDir, SELFTEST_DIR) : baseStateDir;
  const timezone = resolvedEnv.ASSISTANT_TIMEZONE || CONTRACT_TIMEZONE;
  const watchStore = createWatchStore({ stateDir: registerDir });
  let cronCache;
  const loadedSchedules = () => schedules ?? readJson(projectPath(root, "config/schedules.json"));
  return {
    root,
    env: resolvedEnv,
    now,
    today: localDate(now, timezone),
    timezone,
    stdin,
    nodePath,
    baseStateDir,
    store: createContractStore({ stateDir: registerDir }),
    watchStore,
    policy: () => policy ?? readJson(projectPath(root, "config/approval-policy.json")),
    schedules: loadedSchedules,
    settings: () => contractWatchSettings(loadedSchedules()),
    cron: () => (cronCache ??= cron ?? createGatewayCron({ root, env: resolvedEnv })),
    runAgent: runAgent ?? createResearchAgentRunner({ runOpenClaw: openClawRunner(root, resolvedEnv) }),
    /** Whether the daily check really ran lately: a heartbeat, not a promise. */
    watchRunning: () => {
      try {
        const lastRunAt = watchStore.readGlobal().lastRunAt;
        return Boolean(lastRunAt) && now.getTime() - Date.parse(lastRunAt) < HEARTBEAT_MAX_AGE_MS;
      } catch {
        return false;
      }
    },
  };
}

/** The Gateway's own CLI with the repo .env, config and state, as the scheduler runs it; output and failures are redacted. */
function openClawRunner(root, env) {
  const configPath = resolveOpenClawConfigPath(env, root);
  let config = {};
  try {
    config = readJson(configPath);
  } catch {
    // A missing config fails at the first call with the CLI's own message.
  }
  return createOpenClawCliRunner({
    command: () => resolveOpenClawCommand(env),
    cwd: root,
    env: { ...process.env, ...env, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: resolveOpenClawStateDir(env, root) },
    redact: createSecretRedactor({ env, config }),
  });
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
function guide(context) {
  const skill = readFileSync(projectPath(context.root, CONTRACT_SKILL_PATH), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  let statusText;
  try {
    statusText = formatRegisterStatus(registerStatus(context.store), { watchRunning: context.watchRunning() });
  } catch (error) {
    statusText = `The contract register could not be read: ${error.message}`;
  }
  return { text: `Current contract register status:\n${statusText}\n\n${skill}` };
}

/** The daily check. Only the scheduled job passes --scheduled; by hand it previews and changes nothing. */
async function watch(options, context) {
  const scheduled = options.scheduled === true;
  const result = await runContractWatch({
    store: context.store,
    watchStore: context.watchStore,
    settings: context.settings(),
    policy: context.policy(),
    now: context.now,
    runAgent: context.runAgent,
    scheduled,
    readRuns: scheduled
      ? async () => {
          const cron = context.cron();
          const matches = (await cron.list()).filter((job) => job.name === CONTRACT_WATCH_JOB);
          if (matches.length !== 1) throw new Error(matches.length === 0 ? "the renewal watch job is not in the scheduler" : "more than one renewal watch job is in the scheduler");
          return cron.runs(matches[0].id, { limit: 20 });
        }
      : null,
  });
  return { text: result.text, report: result.report };
}

async function watchStatus(context) {
  let jobs = null;
  let schedulerError = null;
  try {
    jobs = await context.cron().list();
  } catch (error) {
    schedulerError = error.message;
  }
  const view = watchStatusView({ store: context.store, watchStore: context.watchStore, jobs, now: context.now, settings: context.settings() });
  return { ...view, schedulerError, telegramText: formatWatchStatus(view, { timezone: context.timezone }) };
}

/**
 * Adds or updates the one daily job, then reads the scheduler back and proves
 * that the job matches and that no other job changed.
 */
async function watchInstall(options, context) {
  const cron = context.cron();
  const job = buildContractWatchJob(context.schedules(), { telegramUserId: context.env.TELEGRAM_USER_ID, projectRoot: context.root, nodePath: context.nodePath });
  const before = await cron.list();
  const plan = planContractWatchInstall(before, job);
  const preview = {
    action: plan.action,
    job: { name: job.name, schedule: job.schedule, argv: job.argv, cwd: job.cwd, timeoutSeconds: job.timeoutSeconds, delivery: { channel: job.delivery.channel, to: "<the allowlisted Telegram user>", bestEffort: false } },
    mismatches: plan.mismatches ?? [],
  };
  if (plan.action === "refuse") return { ok: false, ...preview, problem: plan.problem };
  if (options.dryRun || plan.action === "unchanged") return { ok: true, dryRun: Boolean(options.dryRun), ...preview };
  if (plan.action === "add") await cron.add(plan.args);
  else await cron.edit(plan.jobId, plan.args);
  const after = await cron.list();
  const live = after.filter((candidate) => candidate.name === job.name);
  const installed = live.length === 1 ? live[0] : null;
  const mismatches = installed ? contractWatchJobMismatches(installed, job) : ["missing"];
  const unrelated = changedJobs(before, after, { exceptIds: installed ? [installed.id] : [] });
  return {
    ok: Boolean(installed) && mismatches.length === 0 && unrelated.length === 0,
    action: plan.action,
    job: installed ? publicCronJob(installed, { redact: cron.redact }) : null,
    mismatches,
    unrelatedJobsChanged: unrelated,
  };
}

/**
 * The deployment check: a made-up broadband contract in a separate register,
 * with its discount ending in 50 days, through one real scheduled run with the
 * real research turn. With --deliver it prints the alert under a self-test
 * header for the scheduler to announce; otherwise NO_REPLY. The result is kept
 * in the self-test folder for inspection; the real register is never touched.
 */
async function watchSelftest(options, context) {
  const selftestDir = join(context.baseStateDir, SELFTEST_DIR);
  rmSync(selftestDir, { recursive: true, force: true });
  mkdirSync(selftestDir, { recursive: true, mode: 0o700 });
  const store = createContractStore({ stateDir: selftestDir });
  const watchStore = createWatchStore({ stateDir: selftestDir });
  const { now, today } = context;
  const contract = {
    category: "broadband",
    provider: "Selftest Fiber",
    product: "Bredband 250/250",
    currentPrice: { amount: 449, currency: "SEK", period: "month" },
    nextPrice: { amount: 549, currency: "SEK", period: "month", basis: "made-up self-test" },
    discountEndDate: addDays(today, 50),
    renewalDate: "none",
    bindingEndDate: "none",
    terms: { downloadMbps: 250, uploadMbps: 250 },
    notes: "Made-up contract for the renewal watch self-test",
    monitor: true,
  };
  const preview = runContractAction("add", contract, { store, now, today });
  runContractAction("add", { ...contract, approval: { digest: preview.digest, replyText: "yes" } }, { store, now, today });
  const startedAt = new Date().toISOString();
  const result = await runContractWatch({
    store,
    watchStore,
    settings: context.settings(),
    policy: context.policy(),
    now,
    runAgent: context.runAgent,
    scheduled: true,
    readRuns: null,
    researchMessage: (requestId) => researchHandoffMessage(requestId, { selftest: true }),
  });
  const summary = { startedAt, finishedAt: new Date().toISOString(), report: result.report, text: result.text };
  writeFileSync(join(selftestDir, "selftest-result.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  const header = "Self-test of the renewal watch: a made-up broadband contract in a separate test register. Nothing real was changed or watched.";
  return { text: options.deliver && result.text !== "NO_REPLY" ? `${header}\n\n${result.text}` : "NO_REPLY", report: result.report };
}

function brief(options, context) {
  for (const contractId of context.watchStore.ids()) {
    let state;
    try {
      state = context.watchStore.read(contractId);
    } catch {
      continue;
    }
    if (state?.research?.requestId !== options.request) continue;
    if (state.research.status !== "requested") return { ok: false, status: "closed", message: `Research request ${options.request} is no longer open. Reply exactly NO_REPLY.` };
    const record = context.store.read(contractId);
    return { ok: true, ...researchBrief(record, state, { today: context.today }), submit: `npm run --silent contracts -- research-submit${options.selftest ? " --selftest" : ""} --json-stdin` };
  }
  return { ok: false, status: "not_found", message: `No research request ${options.request} is open. Reply exactly NO_REPLY.` };
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
      "npm run --silent contracts -- alerts",
      "npm run --silent contracts -- ack --json-stdin <<'JSON'\n{\"target\":\"car insurance\",\"decision\":\"snooze\",\"until\":\"2027-01-20\",\"replyText\":\"Remind me again in two weeks\"}\nJSON",
      "npm run --silent contracts -- offers --id ct-1a2b3c4d",
      "npm run --silent contracts -- watch-status",
    ],
    safety:
      "A private local register and a daily watch that only messages you. Writes are previews until the user's yes comes back with the preview's digest. It never cancels, switches, signs or buys anything, never fills in forms and never contacts a provider.",
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
  if (command === "guide" || command === "watch" || command === "watch-selftest") return result.text;
  return JSON.stringify(result, null, 2);
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
