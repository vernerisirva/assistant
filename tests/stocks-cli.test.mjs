import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { formatStocksCliResult, parseStocksArgs, runStocksCli } from "../scripts/stocks.mjs";
import { isinCheckDigit } from "../scripts/lib/stock-identity.mjs";
import { STOCK_MONITOR_JOB } from "../scripts/lib/stock-monitor.mjs";

const SCHEDULES = JSON.parse(readFileSync("config/schedules.json", "utf8"));
const POLICY = JSON.parse(readFileSync("config/approval-policy.json", "utf8"));
const ENV = { TELEGRAM_USER_ID: "123456789", ASSISTANT_TIMEZONE: "Europe/Stockholm" };
const isin = (first11) => `${first11}${isinCheckDigit(first11)}`;
const EXAMPLE = Object.freeze({ companyName: "Example AB", ticker: "EXAM B", exchange: "XSTO", shareClass: "B", isin: isin("SE000000002"), currency: "SEK", country: "SE", identifiers: {}, verification: { source: "user", checkedAt: null } });

function fakeSource() {
  const source = {
    key: "exchange",
    kind: "disclosures",
    name: "Example exchange feed",
    label: "Example exchange announcements",
    evidence: "official_disclosure",
    items: [],
    calls: 0,
    enabledFor: (monitoring) => monitoring.companyNews || monitoring.reports,
    coverage: () => ({ status: "available", note: null }),
    async check() {
      source.calls += 1;
      return { status: "ok", items: source.items.map((item) => ({ ...item })) };
    },
  };
  return source;
}

function harness() {
  const stateDir = mkdtempSync(join(tmpdir(), "hilla-stocks-cli-"));
  const source = fakeSource();
  const cronCalls = [];
  let jobs = [];
  const cron = {
    redact: (text) => text,
    list: async () => jobs,
    add: async (args) => {
      cronCalls.push(["add", ...args]);
      jobs = [{ id: "j1", name: args[args.indexOf("--name") + 1], enabled: true, payload: { kind: "command", argv: JSON.parse(args[args.indexOf("--command-argv") + 1]), cwd: args[args.indexOf("--command-cwd") + 1], timeoutSeconds: Number(args[args.indexOf("--timeout-seconds") + 1]) }, schedule: { kind: "cron", expr: args[args.indexOf("--cron") + 1], timezone: args[args.indexOf("--tz") + 1] }, delivery: { mode: "announce", channel: "telegram", to: args[args.indexOf("--to") + 1], accountId: "main", bestEffort: false } }, { id: "other", name: "Unrelated", enabled: true, payload: { kind: "agentTurn" }, schedule: { kind: "cron", expr: "0 9 * * *" } }];
    },
    edit: async (id, args) => cronCalls.push(["edit", id, ...args]),
    runs: async () => runs,
  };
  const runs = [];
  // The analysis turn: a test sets `agent.turn`; by default it submits nothing. The real Gateway is never called.
  const agent = { calls: [], turn: async () => ({ ok: false, error: "no agent in this test" }) };
  const runAgent = async (request) => {
    agent.calls.push(request);
    return agent.turn(request);
  };
  jobs = [{ id: "other", name: "Unrelated", enabled: true, payload: { kind: "agentTurn" }, schedule: { kind: "cron", expr: "0 9 * * *" } }];
  const network = { fetch: async () => assert.fail("no network in CLI tests") };
  const run = (argv, { input, now = new Date("2026-10-22T08:07:00.000Z") } = {}) =>
    runStocksCli(argv, { root: process.cwd(), env: ENV, stateDir, now, stdin: Readable.from(input === undefined ? [] : [JSON.stringify(input)]), cron, runAgent, policy: POLICY, schedules: SCHEDULES, nodePath: "/usr/bin/node", sources: [source], fetchImpl: (...args) => network.fetch(...args), sleep: async () => {} });
  return { stateDir, source, run, cronCalls, runs, agent, network, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

describe("stocks CLI arguments", () => {
  it("parses commands and refuses what a command does not take", () => {
    assert.deepEqual(parseStocksArgs(["list"]), { command: "list", options: {} });
    assert.deepEqual(parseStocksArgs(["events", "--days", "3", "--all"]), { command: "events", options: { days: 3, all: true } });
    assert.throws(() => parseStocksArgs(["list", "--id", "sw-1a2b3c4d"]), /list does not take --id/);
    assert.throws(() => parseStocksArgs(["show"]), /requires --id/);
    assert.throws(() => parseStocksArgs(["add"]), /reads its JSON from stdin/);
    assert.throws(() => parseStocksArgs(["buy"]), /Unknown stocks command/);
    assert.throws(() => parseStocksArgs(["events", "--days", "0"]), /--days/);
    assert.equal(parseStocksArgs(["--help"]).command, "help");
    assert.deepEqual(parseStocksArgs(["analysis-brief", "--request", "rq-1a2b3c4d", "--selftest"]), { command: "analysis-brief", options: { request: "rq-1a2b3c4d", selftest: true } });
    assert.throws(() => parseStocksArgs(["analysis-brief"]), /takes --request .* or --event/);
    assert.throws(() => parseStocksArgs(["analysis-brief", "--request", "rq-1a2b3c4d", "--event", "ev-0123456789ab"]), /not both/);
    assert.throws(() => parseStocksArgs(["analysis-brief", "--request", "rq-nothex!"]), /--request must be a request id/);
    assert.throws(() => parseStocksArgs(["analysis"]), /requires --event/);
    assert.throws(() => parseStocksArgs(["preferences"]), /reads its JSON from stdin/);
    assert.throws(() => parseStocksArgs(["analysis-submit"]), /reads its JSON from stdin/);
    assert.throws(() => parseStocksArgs(["selftest", "--deliver"]), /reads its JSON from stdin/);
  });
});

describe("stocks CLI", () => {
  it("follows a stock through preview and yes, lists and shows it", async () => {
    const h = harness();
    try {
      const preview = await h.run(["add", "--json-stdin"], { input: { security: EXAMPLE, focusAreas: ["dividend"] } });
      assert.equal(preview.status, "preview");
      assert.match(preview.telegramText, /Example exchange announcements/);
      assert.match(preview.telegramText, /not checked against an official listing/);
      const saved = await h.run(["add", "--json-stdin"], { input: { security: EXAMPLE, focusAreas: ["dividend"], approval: { digest: preview.digest, replyText: "Yes" } } });
      assert.equal(saved.status, "saved");
      assert.match(saved.telegramText, /Scheduled checks aren't running yet/, "no monitoring is promised before the job runs");
      const list = await h.run(["list"]);
      assert.equal(list.securities.length, 1);
      assert.match(list.telegramText, /Example AB \(EXAM B, Nasdaq Stockholm\): following/);
      const show = await h.run(["show", "--id", saved.security.id]);
      assert.match(show.telegramText, /Example exchange announcements: not checked yet\./);
      assert.match(show.telegramText, /Next report: no date announced by a source I check\./);
    } finally {
      h.cleanup();
    }
  });

  it("records new events in a scheduled run, lists them, and does nothing by hand without --scheduled", async () => {
    const h = harness();
    try {
      const preview = await h.run(["add", "--json-stdin"], { input: { security: EXAMPLE } });
      const saved = await h.run(["add", "--json-stdin"], { input: { security: EXAMPLE, approval: { digest: preview.digest, replyText: "ok" } } });
      const byHand = await h.run(["monitor"]);
      assert.match(byHand.text, /^NO_REPLY \(preview/);
      assert.equal(h.source.calls, 0);

      const first = await h.run(["monitor", "--scheduled"]);
      assert.equal(first.text, "NO_REPLY");
      h.source.items = [{ documentId: "1", url: "https://exchange.example/view?id=1", title: "Example AB: Interim report January–September 2026", publishedAt: "2026-10-22T08:30:00.000Z", language: "en" }];
      await h.run(["monitor", "--scheduled"], { now: new Date("2026-10-22T09:07:00.000Z") });
      const events = await h.run(["events", "--days", "1"], { now: new Date("2026-10-22T09:10:00.000Z") });
      assert.equal(events.events.length, 1);
      assert.match(events.telegramText, /report: “Example AB: Interim report January–September 2026” \(official\) https:\/\/exchange\.example\/view\?id=1/);
      const status = await h.run(["monitor-status"], { now: new Date("2026-10-22T09:10:00.000Z") });
      assert.match(status.telegramText, /Stock monitor job: not set up\./);
      assert.match(status.telegramText, /Example exchange announcements: 1 ok/);
      assert.equal(saved.status, "saved");
    } finally {
      h.cleanup();
    }
  });

  it("installs one job, proves it matches, and changes no other job", async () => {
    const h = harness();
    try {
      const dry = await h.run(["monitor-install", "--dry-run"]);
      assert.equal(dry.action, "add");
      assert.equal(dry.job.delivery.to, "<the allowlisted Telegram user>");
      assert.equal(h.cronCalls.length, 0);
      const installed = await h.run(["monitor-install"]);
      assert.equal(installed.ok, true, JSON.stringify(installed));
      assert.deepEqual(installed.unrelatedJobsChanged, []);
      assert.equal(installed.job.name, STOCK_MONITOR_JOB);
      const again = await h.run(["monitor-install"]);
      assert.equal(again.action, "unchanged");
    } finally {
      h.cleanup();
    }
  });

  it("prints the guide with the watchlist status, and only text for guide and monitor", async () => {
    const h = harness();
    try {
      const guide = await h.run(["guide"]);
      assert.match(guide.text, /^Current stock watchlist status:\nStock watchlist: empty\./);
      assert.match(guide.text, /# Stock Watch/);
      assert.equal(formatStocksCliResult("guide", guide), guide.text);
      assert.equal(formatStocksCliResult("list", { a: 1 }), JSON.stringify({ a: 1 }, null, 2));
    } finally {
      h.cleanup();
    }
  });

  it("keeps the watchlist out of the state folder's other features", async () => {
    const h = harness();
    try {
      const preview = await h.run(["add", "--json-stdin"], { input: { security: EXAMPLE } });
      await h.run(["add", "--json-stdin"], { input: { security: EXAMPLE, approval: { digest: preview.digest, replyText: "yes" } } });
      assert.ok(existsSync(join(h.stateDir, "stock-watch", "watchlist")));
      assert.ok(!existsSync(join(h.stateDir, "contracts")));
      assert.ok(!existsSync(join(h.stateDir, "memory")));
    } finally {
      h.cleanup();
    }
  });
});

describe("what the events view says about coverage", () => {
  it("names every followed source that is not fully checked, never just 'nothing new'", async () => {
    const h = harness();
    const second = {
      key: "second",
      kind: "news",
      name: "Second feed",
      label: "Second source",
      evidence: "news",
      calls: 0,
      enabledFor: () => true,
      coverage: () => ({ status: "available", note: null }),
      async check() {
        return { status: "ok", items: [] };
      },
    };
    try {
      const run = (argv, { input, now = new Date("2026-10-22T08:07:00.000Z"), sources = [h.source, second] } = {}) =>
        runStocksCli(argv, { root: process.cwd(), env: ENV, stateDir: h.stateDir, now, stdin: Readable.from(input === undefined ? [] : [JSON.stringify(input)]), cron: { list: async () => [], runs: async () => [] }, runAgent: async () => ({ ok: false, error: "no agent" }), policy: POLICY, schedules: SCHEDULES, sources, fetchImpl: async () => assert.fail("no network") });
      const preview = await run(["add", "--json-stdin"], { input: { security: EXAMPLE } });
      await run(["add", "--json-stdin"], { input: { security: EXAMPLE, approval: { digest: preview.digest, replyText: "yes" } } });
      // Only the first source is checked; the second has no notes yet.
      await run(["monitor", "--scheduled"], { sources: [h.source] });
      const events = await run(["events", "--days", "1"], { now: new Date("2026-10-22T08:10:00.000Z") });
      assert.match(events.telegramText, /^No new events in the last 1 day from the sources that were checked; the ones below weren't, so this is incomplete\./);
      assert.doesNotMatch(events.telegramText, /Nothing new found/);
      assert.match(events.telegramText, /Not fully checked, so they may have news I haven't seen:\n- Example AB \(EXAM B, Nasdaq Stockholm\): Second source, not checked yet/);
      assert.equal(events.notFullyChecked.length, 1);
    } finally {
      h.cleanup();
    }
  });
});

describe("stocks CLI alerts and analysis", () => {
  const REPORT_URL = "https://exchange.example/view?id=q3";
  const REPORT_HTML = "<html><body><h1>Example AB: Interim report January–September 2026</h1><p>Net sales SEK 1 234,5 m (1 143,0). Operating margin 12,0% (16,0).</p></body></html>";
  const at = (iso) => ({ now: new Date(iso) });
  async function follow(h, extra = {}) {
    const preview = await h.run(["add", "--json-stdin"], { input: { security: EXAMPLE, ...extra } });
    const saved = await h.run(["add", "--json-stdin"], { input: { security: EXAMPLE, ...extra, approval: { digest: preview.digest, replyText: "yes" } } });
    return saved.security.id;
  }
  const analysis = (sales) => ({
    importance: { level: "important", reason: "The quarterly report" },
    sourcesRead: [{ url: REPORT_URL, read: true }],
    metrics: [
      { id: "net_sales", name: "Net sales", unit: "currency", basis: "reported", currency: "SEK", scale: "millions", current: { period: "Q3 2026", value: sales }, prior: { period: "Q3 2025", value: 1143 }, source: { url: REPORT_URL, location: "summary" } },
      { id: "operating_margin", name: "Operating margin", unit: "percent", basis: "reported", current: { period: "Q3 2026", value: 12 }, prior: { period: "Q3 2025", value: 16 }, source: { url: REPORT_URL, location: "summary" } },
    ],
    keyPoints: ["Sales grew while the margin narrowed"],
    thesisImpact: { outcome: "weakens", reason: "The margin fell against the margin-improvement assumption", metricIds: ["operating_margin"] },
    review: ["The explanation for the margin pressure"],
  });

  it("prints an alert from the scheduled run, matches a reply to it, and pauses alerts on request", async () => {
    const h = harness();
    try {
      await follow(h);
      await h.run(["monitor", "--scheduled"]);
      h.source.items = [{ documentId: "h1", url: "https://exchange.example/view?id=h1", title: "Example AB: trading halt", publishedAt: "2026-10-22T08:30:00.000Z", language: "en" }];
      const result = await h.run(["monitor", "--scheduled"], at("2026-10-22T09:07:00.000Z"));
      assert.match(formatStocksCliResult("monitor", result), /^\*\*Example AB \(EXAM B\) — trading halted \(time-sensitive\)\*\*/);
      assert.equal(h.agent.calls.length, 1, "one analysis turn, which failed here, so the facts went out at once");
      const alerts = await h.run(["alerts"], at("2026-10-22T09:10:00.000Z"));
      assert.equal(alerts.alerts.length, 1);
      assert.equal(alerts.alerts[0].delivery, "printed", "not confirmed until the scheduler says so");
      const ack = await h.run(["ack", "--json-stdin"], { input: { alert: alerts.alerts[0].id, decision: "seen" }, ...at("2026-10-22T09:12:00.000Z") });
      assert.equal(ack.telegramText, "Noted.");
      const events = await h.run(["events", "--days", "1"], at("2026-10-22T09:13:00.000Z"));
      assert.match(events.telegramText, /trading halt: “Example AB: trading halt” .*\[time-sensitive\]/);
      assert.deepEqual([events.events[0].alert.alert, events.events[0].alert.answered], ["sent", "seen"]);
      const paused = await h.run(["preferences", "--json-stdin"], { input: { alertsPaused: true }, ...at("2026-10-22T09:14:00.000Z") });
      assert.match(paused.telegramText, /^Stock alerts are paused: I keep checking and recording/);
      const status = await h.run(["monitor-status"], at("2026-10-22T09:15:00.000Z"));
      assert.match(status.telegramText, /\nAlerts: paused; summary off\.\nAnalysis: 0 done, 0 running, 1 failed; 1 of 6 model turns used today\.\nMessages: 0 delivered, 1 awaiting confirmation, 0 failed, 0 unconfirmed\./);
      const digest = await h.run(["digest"], at("2026-10-22T09:16:00.000Z"));
      assert.match(digest.telegramText, /^Nothing for a summary right now/);
    } finally {
      h.cleanup();
    }
  });

  it("previews a summary on request, whatever the time, without sending or marking anything", async () => {
    const h = harness();
    try {
      await follow(h);
      await h.run(["monitor", "--scheduled"]);
      h.source.items = [{ documentId: "e1", url: "https://exchange.example/view?id=e1", title: "Example AB: Notice of extraordinary general meeting", publishedAt: "2026-10-22T08:30:00.000Z", language: "en" }];
      assert.equal((await h.run(["monitor", "--scheduled"], at("2026-10-22T09:07:00.000Z"))).text, "NO_REPLY", "ordinary news waits for a summary");
      const preview = await h.run(["digest"], at("2026-10-22T09:10:00.000Z"));
      assert.match(preview.telegramText, /^\*\*Your stocks: the week to \d+ Oct\*\*\n\nExample AB \(EXAM B\)\n- 22 Oct · shareholder meeting: “Example AB: Notice of extraordinary general meeting”/);
      const again = await h.run(["digest"], at("2026-10-22T09:11:00.000Z"));
      assert.equal(again.telegramText, preview.telegramText, "a preview marks nothing as sent");
    } finally {
      h.cleanup();
    }
  });

  it("lets the analysis turn read its brief and submit through the CLI, checking figures against the page it cites", async () => {
    const h = harness();
    try {
      const id = await follow(h, { thesis: { statement: "Margins will improve as revenue scales." } });
      await h.run(["monitor", "--scheduled"]);
      h.source.items = [{ documentId: "q3", url: REPORT_URL, title: "Example AB: Interim report January–September 2026", publishedAt: "2026-10-22T08:30:00.000Z", language: "en" }];
      const requested = [];
      h.network.fetch = async (url) => {
        requested.push(url);
        if (url === REPORT_URL) return new Response(REPORT_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
        return new Response("", { status: 404 });
      };
      h.agent.turn = async ({ requestId, message }) => {
        assert.match(message, new RegExp(`analysis-brief --request ${requestId}\\n`));
        const brief = await h.run(["analysis-brief", "--request", requestId], at("2026-10-22T09:08:00.000Z"));
        assert.equal(brief.ok, true, JSON.stringify(brief));
        assert.equal(brief.thesis.statement, "Margins will improve as revenue scales.");
        assert.equal(brief.submit, "npm run --silent stocks -- analysis-submit --json-stdin");
        const wrong = await h.run(["analysis-submit", "--json-stdin"], { input: { request: requestId, ...analysis(1250) }, ...at("2026-10-22T09:09:00.000Z") });
        assert.equal(wrong.status, "invalid");
        assert.match(wrong.problems.join(" "), /1250 does not appear on the cited page/);
        const right = await h.run(["analysis-submit", "--json-stdin"], { input: { request: requestId, ...analysis(1234.5) }, ...at("2026-10-22T09:10:00.000Z") });
        assert.equal(right.status, "stored", JSON.stringify(right));
        return { ok: true, error: null };
      };
      const result = await h.run(["monitor", "--scheduled"], at("2026-10-22T09:07:00.000Z"));
      assert.match(result.text, /Net sales, Q3 2026: SEK 1 234\.5m \(Q3 2025: SEK 1 143m\), \+8\.0%/);
      assert.match(result.text, /Your thesis: Weakens it\./);
      assert.deepEqual(requested.slice(0, 2), ["https://exchange.example/robots.txt", REPORT_URL], "robots.txt first, then only the cited page");
      const [event] = (await h.run(["events", "--days", "1"], at("2026-10-22T09:20:00.000Z"))).events;
      const stored = await h.run(["analysis", "--event", event.id], at("2026-10-22T09:20:00.000Z"));
      assert.equal(stored.status, "analysed");
      assert.equal(stored.thesisChangedSince, false);
      const removePreview = await h.run(["remove", "--json-stdin"], { input: { id } });
      await h.run(["remove", "--json-stdin"], { input: { id, approval: { digest: removePreview.digest, replyText: "yes" } } });
      assert.ok(!existsSync(join(h.stateDir, "stock-watch", "alerts", `${id}.json`)), "a removed stock's alert notes go with it");
    } finally {
      h.cleanup();
    }
  });
});
