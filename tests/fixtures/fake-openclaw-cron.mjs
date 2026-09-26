/**
 * An in-memory stand-in for `openclaw cron` against a Gateway, for tests.
 *
 * It answers the same subcommands the repo uses, prints JSON the way the
 * OpenClaw 2026.7 CLI does, and applies `cron edit` as a patch with the same
 * rules: a cron schedule keeps its stagger unless --exact is given and keeps
 * its timezone unless --tz is given, and payload and delivery fields merge.
 * Every call is recorded, so a test can prove that no mutation ran.
 */
export const FAKE_TELEGRAM_ID = "123456789";
const MUTATIONS = new Set(["enable", "disable", "edit", "add", "rm"]);

export function createFakeOpenClawCron({ jobs = sampleRawJobs(), schedulerEnabled = true, fail } = {}) {
  const state = { jobs: structuredClone(jobs), nextId: 1 };
  const calls = [];

  async function run(args) {
    calls.push([...args]);
    if (fail) {
      const failure = fail(args);
      if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
    }
    const [group, command, ...rest] = args;
    if (group !== "cron") throw new Error(`fake openclaw: unsupported command ${group}`);
    switch (command) {
      case "list":
        return JSON.stringify({
          jobs: state.jobs.map((job) => ({ ...job, status: job.enabled === false ? "disabled" : job.state?.lastRunStatus ?? "idle" })),
          total: state.jobs.length,
          offset: 0,
          limit: state.jobs.length,
          hasMore: false,
          nextOffset: null,
          // The real CLI previews the delivery target, Telegram id included.
          deliveryPreviews: Object.fromEntries(state.jobs.map((job) => [job.id, { label: `announce -> ${job.delivery?.to}`, detail: "explicit" }])),
        });
      case "status":
        return `\n${JSON.stringify({ enabled: schedulerEnabled, storage: "sqlite", jobs: state.jobs.length, nextWakeAtMs: 1790424000000 })}`;
      case "get":
        return JSON.stringify(findJob(rest[0]));
      case "enable":
      case "disable": {
        const job = findJob(rest[0]);
        job.enabled = command === "enable";
        job.updatedAtMs = (job.updatedAtMs ?? 0) + 1;
        return JSON.stringify(job, null, 2);
      }
      case "edit": {
        const job = findJob(rest[0]);
        applyEdit(job, parseFlags(rest.slice(1)));
        job.updatedAtMs = (job.updatedAtMs ?? 0) + 1;
        return JSON.stringify(job, null, 2);
      }
      case "add": {
        const job = createJob(parseFlags(rest), `fake-added-${state.nextId++}`);
        state.jobs.push(job);
        return JSON.stringify(job, null, 2);
      }
      default:
        throw new Error(`fake openclaw: unsupported cron command ${command}`);
    }
  }

  function findJob(id) {
    const job = state.jobs.find((candidate) => candidate.id === id);
    if (!job) throw new Error(`openclaw cron ${id ? "get" : "?"} failed: GatewayClientRequestError: cron job not found: ${id}`);
    return job;
  }

  return {
    run,
    calls,
    get jobs() {
      return state.jobs;
    },
    mutations: () => calls.filter((args) => MUTATIONS.has(args[1])),
  };
}

export function sampleRawJobs() {
  const telegram = { mode: "announce", channel: "telegram", to: `telegram:${FAKE_TELEGRAM_ID}`, accountId: "main", bestEffort: true };
  const agentTurn = (agentId, name, schedule, extra = {}) => ({
    id: extra.id,
    name,
    description: extra.description ?? `${name} description`,
    enabled: extra.enabled ?? true,
    createdAtMs: 1780000000000,
    updatedAtMs: 1780000000000,
    agentId,
    sessionKey: `agent:${agentId}:telegram:main:direct:${FAKE_TELEGRAM_ID}`,
    schedule,
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: `${name} prompt`, timeoutSeconds: 180 },
    delivery: telegram,
    state: extra.state ?? {},
    ...(extra.deleteAfterRun ? { deleteAfterRun: true } : {}),
  });
  const stockholm = (expr, staggerMs) => ({ kind: "cron", expr, tz: "Europe/Stockholm", ...(staggerMs === undefined ? {} : { staggerMs }) });

  return [
    {
      id: "wp-apply",
      name: "Assistant weekly plan: apply due plans",
      description: "Every 15 min: create due weekly plan tasks.",
      enabled: true,
      createdAtMs: 1790418614921,
      updatedAtMs: 1790423100114,
      schedule: stockholm("*/15 * * * *", 0),
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "command", argv: ["/usr/bin/node", "scripts/weekly-plan.mjs", "apply-due"], cwd: "/repo", timeoutSeconds: 300 },
      delivery: telegram,
      state: { nextRunAtMs: 1790424000000, lastRunAtMs: 1790423100019, lastRunStatus: "ok", lastStatus: "ok" },
    },
    agentTurn("health", "Assistant routine: workout-window", stockholm("30 17 * * *"), {
      id: "routine-workout",
      state: { nextRunAtMs: 1790436600000, lastRunAtMs: 1790350200024, lastRunStatus: "error", lastStatus: "error", lastErrorReason: "auth" },
    }),
    agentTurn("health", "Assistant routine: midday-check-in", stockholm("30 12 * * *"), {
      id: "routine-midday",
      state: { nextRunAtMs: 1790505000000, lastRunAtMs: 1790418600021, lastRunStatus: "ok", lastStatus: "ok" },
    }),
    agentTurn("personal", "Assistant routine: weekly-review", stockholm("0 19 * * 0"), { id: "routine-weekly" }),
    agentTurn("personal", "Assistant weekly plan: propose", stockholm("0 9 * * 6", 0), {
      id: "wp-propose",
      state: { nextRunAtMs: 1790924400000 },
    }),
    agentTurn("personal", "Renew EU health insurance card", { kind: "at", at: "2028-12-18T08:00:00.000Z" }, {
      id: "one-shot-card",
      deleteAfterRun: true,
      state: { nextRunAtMs: Date.parse("2028-12-18T08:00:00.000Z") },
    }),
    agentTurn("personal", "Assistant weather: morning", stockholm("0 8 * * *", 0), { id: "weather-morning", enabled: false }),
    agentTurn("personal", "Assistant routine: evening-review", stockholm("0 21 * * *"), { id: "routine-evening", enabled: false }),
    agentTurn("personal", "Assistant routine: morning-brief", stockholm("0 8 * * *"), { id: "routine-morning", enabled: false }),
    agentTurn("personal", "Sunday golf weekly plan", stockholm("30 18 * * 0"), { id: "legacy-sunday-golf", enabled: false }),
    agentTurn("personal", "Weekly food shopping and prep plan", { kind: "every", everyMs: 604800000, anchorMs: 1784478600000 }, {
      id: "legacy-food-every",
      enabled: false,
    }),
  ];
}

function parseFlags(args) {
  const flags = {};
  for (const arg of args) {
    if (!arg.startsWith("--")) throw new Error(`fake openclaw: unexpected positional ${arg}`);
    const index = arg.indexOf("=");
    if (index === -1) flags[arg.slice(2)] = true;
    else flags[arg.slice(2, index)] = arg.slice(index + 1);
  }
  return flags;
}

function applyEdit(job, flags) {
  if (flags.enable) job.enabled = true;
  if (flags.disable) job.enabled = false;
  if (flags.name) job.name = flags.name;
  if (flags.description !== undefined) job.description = flags.description;
  if (flags.agent) job.agentId = flags.agent;
  if (flags.session) job.sessionTarget = flags.session;
  if (flags["session-key"]) job.sessionKey = flags["session-key"];
  if (flags.wake) job.wakeMode = flags.wake;
  if (flags.cron) {
    const previous = job.schedule ?? {};
    job.schedule = {
      kind: "cron",
      expr: flags.cron,
      tz: flags.tz ?? (previous.kind === "cron" ? previous.tz : undefined),
      ...(flags.exact ? { staggerMs: 0 } : previous.kind === "cron" && previous.staggerMs !== undefined ? { staggerMs: previous.staggerMs } : {}),
    };
  }
  if (flags.at) job.schedule = { kind: "at", at: new Date(Date.parse(flags.at)).toISOString() };
  if (flags.message !== undefined || flags["timeout-seconds"] !== undefined) {
    job.payload = {
      ...job.payload,
      kind: "agentTurn",
      ...(flags.message !== undefined ? { message: flags.message } : {}),
      ...(flags["timeout-seconds"] !== undefined ? { timeoutSeconds: Number(flags["timeout-seconds"]) } : {}),
    };
  }
  if (flags.announce || flags.channel || flags.to || flags.account || flags["best-effort-deliver"]) {
    job.delivery = {
      ...job.delivery,
      ...(flags.announce ? { mode: "announce" } : {}),
      ...(flags.channel ? { channel: flags.channel } : {}),
      ...(flags.to ? { to: flags.to } : {}),
      ...(flags.account ? { accountId: flags.account } : {}),
      ...(flags["best-effort-deliver"] ? { bestEffort: true } : {}),
    };
  }
}

function createJob(flags, id) {
  if (!flags.name || !flags.cron) throw new Error("fake openclaw: add needs --name and --cron");
  const job = {
    id,
    name: flags.name,
    enabled: !flags.disabled,
    createdAtMs: 1790500000000,
    updatedAtMs: 1790500000000,
    schedule: { kind: "cron", expr: flags.cron, tz: flags.tz, ...(flags.exact ? { staggerMs: 0 } : {}) },
    sessionTarget: flags.session ?? "isolated",
    wakeMode: flags.wake ?? "now",
    payload: { kind: "agentTurn" },
    delivery: {},
    state: {},
  };
  applyEdit(job, { ...flags, cron: undefined, name: undefined });
  return job;
}
