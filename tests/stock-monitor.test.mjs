import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyQuietJob } from "../scripts/lib/quiet-ops.mjs";
import { createSourceFetcher } from "../scripts/lib/stock-http.mjs";
import { isinCheckDigit } from "../scripts/lib/stock-identity.mjs";
import {
  STOCK_MONITOR_JOB,
  buildStockMonitorJob,
  createMonitorStore,
  dueChecks,
  emptyMonitorState,
  formatMonitorStatus,
  mergeCalendar,
  monitorAuthorization,
  monitorStatusView,
  nextReportDate,
  planStockMonitorInstall,
  runStockMonitor,
  sourceGaps,
  sourceHealthLines,
  stockMonitorJobArgs,
  stockMonitorJobMismatches,
  stockMonitorSettings,
} from "../scripts/lib/stock-monitor.mjs";
import { createWatchlistStore, runStockAction } from "../scripts/lib/stock-watchlist.mjs";

const SCHEDULES = JSON.parse(readFileSync("config/schedules.json", "utf8"));
const SETTINGS = stockMonitorSettings(SCHEDULES);
const POLICY = Object.freeze({ stockMonitoring: { enabled: true } });
const isin = (first11) => `${first11}${isinCheckDigit(first11)}`;
const EXAMPLE = Object.freeze({ companyName: "Example AB", ticker: "EXAM B", exchange: "XSTO", shareClass: "B", isin: isin("SE000000002"), currency: "SEK", country: "SE", verification: { source: "esma-firds", checkedAt: "2026-10-22T08:00:00.000Z" } });
const OTHER = Object.freeze({ ...EXAMPLE, companyName: "Other AB", ticker: "OTHR", shareClass: null, isin: isin("SE000000009") });

/** A fake source whose items and outcome a test controls. */
function fakeSource({ key = "exchange", kind = "disclosures", flag = "companyNews", evidence = "official_disclosure", covers = () => true } = {}) {
  const source = {
    key,
    kind,
    name: `${key} feed`,
    label: `${key} announcements`,
    evidence,
    items: [],
    outcome: null,
    calls: 0,
    enabledFor: (monitoring) => Boolean(monitoring[flag]),
    coverage: (security) => (covers(security) ? { status: "available", note: null } : { status: "unsupported", note: "not covered here" }),
    async check() {
      source.calls += 1;
      if (source.outcome) return source.outcome;
      return { status: "ok", items: source.items.map((item) => ({ ...item })) };
    },
  };
  return source;
}

function harness({ sources = [fakeSource()], policy = POLICY, settings = SETTINGS } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "hilla-stock-monitor-"));
  let watchlistStore = createWatchlistStore({ stateDir });
  let monitorStore = createMonitorStore({ stateDir });
  let counter = 0;
  const random = () => Buffer.from([0, 0, 0, (counter += 1)]);
  const follow = (security, extra = {}) => {
    const now = new Date("2026-10-20T08:00:00.000Z");
    const preview = runStockAction("add", { security, ...extra }, { store: watchlistStore, now, random });
    const saved = runStockAction("add", { security, ...extra, approval: { digest: preview.digest, replyText: "yes" } }, { store: watchlistStore, now, random });
    assert.equal(saved.status, "saved", JSON.stringify(saved));
    return saved.security.id;
  };
  const run = (iso, extra = {}) =>
    runStockMonitor({ watchlistStore, monitorStore, settings, policy, sources, fetcher: { requestsUsed: () => 0, robots: {} }, now: new Date(iso), scheduled: true, ...extra });
  const state = (id) => monitorStore.read(id);
  const restart = () => {
    watchlistStore = createWatchlistStore({ stateDir });
    monitorStore = createMonitorStore({ stateDir });
  };
  return { stateDir, follow, run, state, restart, sources, get watchlistStore() { return watchlistStore; }, get monitorStore() { return monitorStore; }, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

const report = (id, title, publishedAt, extra = {}) => ({ documentId: id, url: `https://exchange.example/view?id=${id}`, title, publishedAt, language: "en", ...extra });

describe("stock monitor settings", () => {
  it("reads config/schedules.json with conservative limits", () => {
    assert.equal(SETTINGS.timezone, "Europe/Stockholm");
    assert.deepEqual(SETTINGS.checkEveryMinutes, { disclosures: 60, calendar: 1440, news: 240, forums: 720 });
    assert.equal(SETTINGS.limits.maxSecurities, 25);
    assert.equal(SETTINGS.limits.maxRequestsPerRun, 80);
    assert.equal(SETTINGS.limits.catchUpDays, 7);
  });

  it("refuses anything checked more often than hourly, and limits out of bounds", () => {
    assert.throws(() => stockMonitorSettings({ stockWatch: { checkEveryMinutes: { disclosures: 5 } } }), /more often than hourly/);
    assert.throws(() => stockMonitorSettings({ stockWatch: { limits: { maxRequestsPerRun: 10_000 } } }), /maxRequestsPerRun/);
    assert.throws(() => stockMonitorSettings({ stockWatch: { minute: 75 } }), /minute/);
  });

  it("runs only while the policy authorizes it", () => {
    assert.equal(monitorAuthorization({ stockMonitoring: { enabled: true } }, { today: "2026-10-22" }).authorized, true);
    assert.equal(monitorAuthorization({ stockMonitoring: { enabled: false } }, { today: "2026-10-22" }).authorized, false);
    assert.equal(monitorAuthorization({}, { today: "2026-10-22" }).authorized, false);
    assert.equal(monitorAuthorization({ stockMonitoring: { enabled: true, authorizedUntil: "2026-10-01" } }, { today: "2026-10-22" }).authorized, false);
  });
});

describe("stock monitor runs", () => {
  it("does nothing, calls no source and sends nothing when nobody is followed", async () => {
    const h = harness();
    try {
      const result = await h.run("2026-10-22T08:07:00.000Z");
      assert.equal(result.text, "NO_REPLY");
      assert.equal(result.report.followed, 0);
      assert.equal(h.sources[0].calls, 0);
    } finally {
      h.cleanup();
    }
  });

  it("stores history from the first check as baseline, then only what is new", async () => {
    const h = harness();
    try {
      const id = h.follow(EXAMPLE);
      h.sources[0].items = [report("1", "Example AB: Interim report January–June 2026", "2026-07-17T05:30:00Z"), report("2", "Example AB appoints new CFO", "2026-09-01T06:00:00Z")];
      const first = await h.run("2026-10-22T08:07:00.000Z");
      assert.equal(first.report.baseline, 2);
      assert.equal(first.report.added, 0, "history is never news");
      assert.ok(h.state(id).events.every((event) => event.baseline));

      h.sources[0].items.unshift(report("3", "Example AB: Interim report January–September 2026", "2026-10-22T08:30:00Z"));
      const second = await h.run("2026-10-22T09:07:00.000Z");
      assert.equal(second.report.added, 1);
      const fresh = h.state(id).events.find((event) => !event.baseline);
      assert.equal(fresh.type, "report");
      assert.equal(fresh.report.period, "Q3");
      assert.equal(fresh.catchUp, undefined);
      assert.equal(second.text, "NO_REPLY", "this monitor records; it sends nothing");
    } finally {
      h.cleanup();
    }
  });

  it("checks a source again only when its interval has passed", async () => {
    const h = harness();
    try {
      h.follow(EXAMPLE);
      await h.run("2026-10-22T08:07:00.000Z");
      await h.run("2026-10-22T08:37:00.000Z");
      assert.equal(h.sources[0].calls, 1);
      await h.run("2026-10-22T09:07:00.000Z");
      assert.equal(h.sources[0].calls, 2);
    } finally {
      h.cleanup();
    }
  });

  it("never creates a duplicate after a restart or a retry of the same run", async () => {
    const h = harness();
    try {
      const id = h.follow(EXAMPLE);
      await h.run("2026-10-22T08:07:00.000Z");
      h.sources[0].items = [report("3", "Example AB: Interim report January–September 2026", "2026-10-22T08:30:00Z")];
      await h.run("2026-10-22T09:07:00.000Z");
      h.restart();
      await h.run("2026-10-22T10:07:00.000Z");
      await h.run("2026-10-22T11:07:00.000Z");
      const events = h.state(id).events;
      assert.equal(events.length, 1);
      assert.equal(events[0].sources.length, 1);
    } finally {
      h.cleanup();
    }
  });

  it("records a failing source as failing, never as nothing new, and backs off", async () => {
    const h = harness();
    try {
      const id = h.follow(EXAMPLE);
      await h.run("2026-10-22T08:07:00.000Z");
      h.sources[0].outcome = { status: "error", reason: "Timed out." };
      const failed = await h.run("2026-10-22T09:07:00.000Z");
      assert.deepEqual(failed.report.failures.map((failure) => failure.status), ["error"]);
      let notes = h.state(id).sources.exchange;
      assert.equal(notes.health, "degraded");
      assert.equal(notes.lastSuccessAt, "2026-10-22T08:07:00.000Z");
      assert.equal(notes.lastError, "Timed out.");
      const record = h.watchlistStore.listWithIssues().records[0];
      assert.match(sourceHealthLines(record, h.state(id), h.sources).join("\n"), /exchange announcements: failing lately \(Timed out\.\); last checked 22 Oct/);
      // A first failure is retried at the usual interval; repeated failures back off, doubling each time.
      await h.run("2026-10-22T10:07:00.000Z");
      assert.equal(h.sources[0].calls, 3);
      await h.run("2026-10-22T11:07:00.000Z");
      assert.equal(h.sources[0].calls, 3, "two failures: two hours");
      await h.run("2026-10-22T12:07:00.000Z");
      assert.equal(h.sources[0].calls, 4);
      notes = h.state(id).sources.exchange;
      assert.equal(notes.consecutiveFailures, 3);
      assert.equal(notes.health, "failing");
      assert.equal(notes.retryAfter, "2026-10-22T16:07:00.000Z");
    } finally {
      h.cleanup();
    }
  });

  it("waits out a rate limit for as long as the source asked", async () => {
    const h = harness();
    try {
      const id = h.follow(EXAMPLE);
      h.sources[0].outcome = { status: "rate_limited", retryAfter: "7200", reason: "The source asked to slow down (HTTP 429)." };
      await h.run("2026-10-22T08:07:00.000Z");
      assert.equal(h.state(id).sources.exchange.retryAfter, "2026-10-22T10:07:00.000Z");
      h.sources[0].outcome = null;
      await h.run("2026-10-22T09:07:00.000Z");
      assert.equal(h.sources[0].calls, 1);
      await h.run("2026-10-22T10:08:00.000Z");
      assert.equal(h.sources[0].calls, 2);
      assert.equal(h.state(id).sources.exchange.health, "ok");
    } finally {
      h.cleanup();
    }
  });

  it("catches up after the computer slept, and keeps items older than the window as missed", async () => {
    const h = harness();
    try {
      const id = h.follow(EXAMPLE);
      await h.run("2026-10-01T08:07:00.000Z");
      h.sources[0].items = [
        report("10", "Example AB appoints new CFO", "2026-10-20T06:00:00Z"),
        report("11", "Example AB receives order worth SEK 50 million", "2026-10-05T06:00:00Z"),
      ];
      const result = await h.run("2026-10-22T08:07:00.000Z");
      assert.equal(result.report.catchUp, 2);
      assert.equal(result.report.missed, 1);
      const events = h.state(id).events;
      assert.ok(events.every((event) => event.catchUp));
      assert.equal(events.find((event) => event.title.includes("order")).missed, true);
      assert.equal(events.find((event) => event.title.includes("CFO")).missed, undefined);
    } finally {
      h.cleanup();
    }
  });

  it("keeps to the per-run check limit and defers the rest, most overdue first", async () => {
    const sources = [fakeSource({ key: "a" }), fakeSource({ key: "b" })];
    const h = harness({ sources, settings: { ...SETTINGS, limits: { ...SETTINGS.limits, maxSourceChecksPerRun: 2 } } });
    try {
      h.follow(EXAMPLE);
      h.follow(OTHER);
      const first = await h.run("2026-10-22T08:07:00.000Z");
      assert.equal(first.report.checked, 2);
      assert.equal(first.report.deferred, 2);
      const second = await h.run("2026-10-22T08:37:00.000Z");
      assert.equal(second.report.checked, 2, "the deferred ones come first next time");
      assert.equal(sources[0].calls + sources[1].calls, 4);
    } finally {
      h.cleanup();
    }
  });

  it("counts a check that ran out of request budget as deferred, not failed", async () => {
    const h = harness();
    try {
      const id = h.follow(EXAMPLE);
      h.sources[0].outcome = { status: "budget", reason: "used up" };
      const result = await h.run("2026-10-22T08:07:00.000Z");
      assert.equal(result.report.deferred, 1);
      assert.equal(result.report.failures.length, 0);
      assert.equal(h.state(id), null, "nothing was recorded for it");
    } finally {
      h.cleanup();
    }
  });

  it("skips paused stocks, switched-off sources and sources that don't cover the listing", async () => {
    const forums = fakeSource({ key: "forum", kind: "forums", flag: "forums", evidence: "forum" });
    const usOnly = fakeSource({ key: "us", covers: (security) => security.exchange === "XNAS" });
    const h = harness({ sources: [fakeSource(), forums, usOnly] });
    try {
      h.follow(EXAMPLE);
      const pausedId = h.follow(OTHER);
      runStockAction("settings", { id: pausedId, status: "paused" }, { store: h.watchlistStore, now: new Date("2026-10-21T08:00:00Z") });
      await h.run("2026-10-22T08:07:00.000Z");
      assert.equal(h.sources[0].calls, 1, "only the followed stock");
      assert.equal(forums.calls, 0, "forums are off by default");
      assert.equal(usOnly.calls, 0);
    } finally {
      h.cleanup();
    }
  });

  it("stops entirely when the policy switches monitoring off", async () => {
    const h = harness({ policy: { stockMonitoring: { enabled: false } } });
    try {
      h.follow(EXAMPLE);
      const result = await h.run("2026-10-22T08:07:00.000Z");
      assert.equal(result.report.authorized, false);
      assert.equal(h.sources[0].calls, 0);
    } finally {
      h.cleanup();
    }
  });

  it("isolates a corrupt monitor note: that stock is skipped and reported, the others run", async () => {
    const h = harness();
    try {
      const brokenId = h.follow(EXAMPLE);
      h.follow(OTHER);
      await h.run("2026-10-22T08:07:00.000Z");
      writeFileSync(join(h.monitorStore.root, `${brokenId}.json`), "{ broken", { mode: 0o600 });
      const result = await h.run("2026-10-22T09:07:00.000Z");
      assert.equal(result.report.checked, 1);
      assert.match(result.report.issues.join(" "), /could not be read/);
      assert.equal(readFileSync(join(h.monitorStore.root, `${brokenId}.json`), "utf8"), "{ broken", "never overwritten");
    } finally {
      h.cleanup();
    }
  });

  it("removes the notes of a security that left the watchlist", async () => {
    const h = harness();
    try {
      const id = h.follow(EXAMPLE);
      await h.run("2026-10-22T08:07:00.000Z");
      const preview = runStockAction("remove", { id }, { store: h.watchlistStore, now: new Date("2026-10-22T08:10:00Z") });
      runStockAction("remove", { id, approval: { digest: preview.digest, replyText: "yes" } }, { store: h.watchlistStore, now: new Date("2026-10-22T08:10:00Z") });
      await h.run("2026-10-22T09:07:00.000Z");
      assert.equal(h.state(id), null);
    } finally {
      h.cleanup();
    }
  });

  it("works with the real fetcher and an empty network: no request without a followed stock", async () => {
    const h = harness();
    try {
      const fetcher = createSourceFetcher({ fetchImpl: async () => assert.fail("no request expected"), sleep: async () => {} });
      const result = await h.run("2026-10-22T08:07:00.000Z", { fetcher });
      assert.equal(result.report.requests, 0);
    } finally {
      h.cleanup();
    }
  });
});

describe("report calendar", () => {
  const source = { key: "calendar", name: "Company financial calendar" };
  const now = new Date("2026-10-01T08:00:00Z");

  it("keeps a confirmed date, notes a moved date, and never lets an estimate replace a confirmation", () => {
    let calendar = mergeCalendar({ entries: [] }, [{ kind: "interim", fiscalYear: 2026, period: "Q3", date: "2026-10-23", status: "confirmed" }], { now, source });
    assert.equal(nextReportDate(calendar, { today: "2026-10-01" }).date, "2026-10-23");
    calendar = mergeCalendar(calendar, [{ kind: "interim", fiscalYear: 2026, period: "Q3", date: "2026-10-28", status: "confirmed" }], { now, source });
    const entry = nextReportDate(calendar, { today: "2026-10-01" });
    assert.deepEqual([entry.date, entry.previousDate], ["2026-10-28", "2026-10-23"]);
    calendar = mergeCalendar(calendar, [{ kind: "interim", fiscalYear: 2026, period: "Q3", date: "2026-10-30", status: "estimated" }], { now, source });
    assert.equal(nextReportDate(calendar, { today: "2026-10-01" }).date, "2026-10-28");
  });

  it("knows no date when no source stated one", () => {
    assert.equal(nextReportDate({ entries: [] }, { today: "2026-10-01" }), null);
    assert.equal(nextReportDate(undefined, { today: "2026-10-01" }), null);
  });
});

describe("monitor status and the scheduled job", () => {
  it("summarizes health without company names", async () => {
    const h = harness();
    try {
      h.follow(EXAMPLE);
      await h.run("2026-10-22T08:07:00.000Z");
      const view = monitorStatusView({ watchlistStore: h.watchlistStore, monitorStore: h.monitorStore, jobs: [{ name: STOCK_MONITOR_JOB, enabled: true, lastStatus: "ok" }], sources: h.sources, now: new Date("2026-10-22T08:10:00Z"), settings: SETTINGS });
      const text = formatMonitorStatus(view);
      assert.match(text, /Stock monitor job: on, last run ok\./);
      assert.match(text, /exchange announcements: 1 ok/);
      assert.ok(!text.includes("Example"), "no company names in the health view");
    } finally {
      h.cleanup();
    }
  });

  it("is one hourly command job announced to the allowlisted user, not best-effort", () => {
    const job = buildStockMonitorJob(SCHEDULES, { telegramUserId: "123456789", projectRoot: "/repo", nodePath: "/usr/bin/node" });
    assert.equal(job.name, STOCK_MONITOR_JOB);
    assert.deepEqual(job.argv, ["/usr/bin/node", "scripts/stocks.mjs", "monitor", "--scheduled"]);
    assert.deepEqual(job.schedule, { expr: "7 * * * *", tz: "Europe/Stockholm" });
    const args = stockMonitorJobArgs(job);
    assert.ok(args.includes("--announce"));
    assert.ok(!args.join(" ").includes("--best-effort"));
    assert.equal(classifyQuietJob({ name: STOCK_MONITOR_JOB }), "stock-watch");
    assert.throws(() => buildStockMonitorJob(SCHEDULES, { telegramUserId: "", projectRoot: "/repo", nodePath: "/usr/bin/node" }), /TELEGRAM_USER_ID/);
  });

  it("adds, edits or leaves the job, and refuses duplicates", () => {
    const job = buildStockMonitorJob(SCHEDULES, { telegramUserId: "123456789", projectRoot: "/repo", nodePath: "/usr/bin/node" });
    assert.equal(planStockMonitorInstall([], job).action, "add");
    const live = {
      id: "j1",
      name: job.name,
      enabled: true,
      payload: { kind: "command", argv: job.argv, cwd: job.cwd, timeoutSeconds: job.timeoutSeconds },
      schedule: { kind: "cron", expr: job.schedule.expr, timezone: job.schedule.tz },
      delivery: { mode: "announce", channel: "telegram", to: job.delivery.to, accountId: "main", bestEffort: false },
    };
    assert.deepEqual(stockMonitorJobMismatches(live, job), []);
    assert.equal(planStockMonitorInstall([live], job).action, "unchanged");
    assert.deepEqual(planStockMonitorInstall([{ ...live, enabled: false }], job).mismatches, ["enabled"]);
    assert.equal(planStockMonitorInstall([live, { ...live, id: "j2" }], job).action, "refuse");
  });

  it("orders due checks by how overdue they are", () => {
    const source = fakeSource();
    const records = [{ id: "sw-00000001", status: "watching", monitoring: { companyNews: true }, security: EXAMPLE }, { id: "sw-00000002", status: "watching", monitoring: { companyNews: true }, security: OTHER }];
    const states = new Map([
      ["sw-00000001", { ...emptyMonitorState("sw-00000001"), sources: { exchange: { lastAttemptAt: "2026-10-22T07:00:00Z" } } }],
      ["sw-00000002", { ...emptyMonitorState("sw-00000002"), sources: { exchange: { lastAttemptAt: "2026-10-22T03:00:00Z" } } }],
    ]);
    const due = dueChecks(records, states, [source], { now: new Date("2026-10-22T08:07:00Z"), settings: SETTINGS });
    assert.deepEqual(due.map((entry) => entry.record.id), ["sw-00000002", "sw-00000001"]);
  });
});

describe("report dates from the company's own notices", () => {
  it("adds a confirmed date from a notice, and records a moved date as an event of its own", async () => {
    const h = harness();
    try {
      const id = h.follow(EXAMPLE);
      h.sources[0].items = [report("n1", "Example AB publishes its interim report January–September 2026 on 23 October", "2026-10-01T06:00:00Z")];
      await h.run("2026-10-02T08:07:00.000Z");
      let calendar = h.state(id).calendar;
      assert.deepEqual(calendar.entries.map((entry) => [entry.kind, entry.period, entry.fiscalYear, entry.date, entry.status]), [["interim", "Q3", 2026, "2026-10-23", "confirmed"]]);
      assert.ok(h.state(id).events.every((event) => event.type !== "report"), "a notice is never a published report");

      h.sources[0].items.unshift(report("n2", "Example AB moves its interim report January–September 2026 to 28 October", "2026-10-05T06:00:00Z"));
      h.sources[0].items[0].title = "Example AB changes the date of its interim report January–September 2026 to 28 October";
      await h.run("2026-10-05T08:07:00.000Z");
      calendar = h.state(id).calendar;
      assert.deepEqual([calendar.entries[0].date, calendar.entries[0].previousDate], ["2026-10-28", "2026-10-23"]);
      const moved = h.state(id).events.find((event) => event.type === "report_date_changed");
      assert.match(moved.title, /Report date moved: interim report Q3 2026 from 2026-10-23 to 2026-10-28/);
      assert.equal(moved.baseline, false);
    } finally {
      h.cleanup();
    }
  });
});

describe("report documents and the run deadline", () => {
  it("confirms a new report's document by reading its first bytes, and records a failure as not retrieved", async () => {
    const source = fakeSource();
    source.documentHosts = ["docs.example"];
    const h = harness({ sources: [source] });
    try {
      const id = h.follow(EXAMPLE);
      await h.run("2026-10-22T08:07:00.000Z");
      source.items = [
        report("r1", "Example AB: Interim report January–September 2026", "2026-10-22T08:30:00Z", { attachments: ["https://docs.example/q3.pdf"] }),
        report("r2", "Example AB: Annual report 2025", "2026-10-22T08:31:00Z", { attachments: ["https://docs.example/missing.pdf"] }),
      ];
      const requests = [];
      const fetcher = {
        robots: {},
        requestsUsed: () => requests.length,
        async get(url, options) {
          requests.push({ url, options });
          return url.endsWith("q3.pdf") ? { status: "ok", body: "%PDF-1.7 ..." } : { status: "not_found", reason: "Not found (HTTP 404)." };
        },
      };
      const result = await h.run("2026-10-22T09:07:00.000Z", { fetcher });
      assert.deepEqual(result.report.documents, { checked: 2, retrieved: 1, failed: 1 });
      assert.ok(requests.every((request) => request.options.firstBytes === 2048 && request.options.hosts.includes("docs.example")));
      const events = h.state(id).events;
      const q3 = events.find((event) => event.report?.period === "Q3");
      assert.deepEqual([q3.report.documentRetrieved, q3.report.document.type], [true, "pdf"]);
      const annual = events.find((event) => event.report?.kind === "annual");
      assert.equal(annual.report.documentRetrieved, false);
      assert.match(annual.report.document.problem, /Not found/);
      // Checked once: the next run does not read them again.
      await h.run("2026-10-22T10:07:00.000Z", { fetcher });
      assert.equal(requests.length, 2);
    } finally {
      h.cleanup();
    }
  });

  it("defers checks it can't start before the job's timeout instead of overrunning it", async () => {
    const sources = [fakeSource({ key: "a" }), fakeSource({ key: "b" })];
    const h = harness({ sources });
    try {
      h.follow(EXAMPLE);
      let calls = 0;
      // The first check takes the whole run's time.
      const clock = () => (calls++ < 2 ? 0 : 3_600_000);
      const result = await h.run("2026-10-22T08:07:00.000Z", { clock });
      assert.equal(result.report.checked, 1);
      assert.equal(result.report.deferred, 1);
    } finally {
      h.cleanup();
    }
  });
});

describe("partly checked sources", () => {
  it("records what a partly read source found, and never calls it healthy", async () => {
    const h = harness();
    try {
      const id = h.follow(EXAMPLE);
      h.sources[0].outcome = { status: "ok", items: [report("p1", "Example AB appoints new CFO", "2026-10-22T06:00:00Z")], partial: "the full feed could not be read (HTTP 500.)" };
      const result = await h.run("2026-10-22T08:07:00.000Z");
      assert.deepEqual(result.report.failures.map((failure) => failure.status), ["partial"]);
      const notes = h.state(id).sources.exchange;
      assert.equal(notes.health, "partial");
      assert.equal(h.state(id).events.length, 1, "what was read is kept");
      const record = h.watchlistStore.listWithIssues().records[0];
      assert.match(sourceHealthLines(record, h.state(id), h.sources).join("\n"), /checked only in part \(the full feed could not be read/);
      assert.deepEqual(sourceGaps(record, h.state(id), h.sources).map((gap) => gap.problem), ["checked only in part: the full feed could not be read (HTTP 500.)"]);
    } finally {
      h.cleanup();
    }
  });
});
