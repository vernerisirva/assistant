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
  };
  jobs = [{ id: "other", name: "Unrelated", enabled: true, payload: { kind: "agentTurn" }, schedule: { kind: "cron", expr: "0 9 * * *" } }];
  const run = (argv, { input, now = new Date("2026-10-22T08:07:00.000Z") } = {}) =>
    runStocksCli(argv, { root: process.cwd(), env: ENV, stateDir, now, stdin: Readable.from(input === undefined ? [] : [JSON.stringify(input)]), cron, policy: POLICY, schedules: SCHEDULES, nodePath: "/usr/bin/node", sources: [source], fetchImpl: async () => assert.fail("no network in CLI tests") });
  return { stateDir, source, run, cronCalls, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
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
        runStocksCli(argv, { root: process.cwd(), env: ENV, stateDir: h.stateDir, now, stdin: Readable.from(input === undefined ? [] : [JSON.stringify(input)]), policy: POLICY, schedules: SCHEDULES, sources, fetchImpl: async () => assert.fail("no network") });
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
