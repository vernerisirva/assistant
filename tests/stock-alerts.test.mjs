import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isinCheckDigit } from "../scripts/lib/stock-identity.mjs";
import { createMonitorStore, nextReportDate, runStockMonitor, stockMonitorSettings } from "../scripts/lib/stock-monitor.mjs";
import { createWatchlistStore, runStockAction } from "../scripts/lib/stock-watchlist.mjs";
import {
  acknowledgeAlerts,
  alertStatusView,
  analysisBrief,
  analysisHandoffMessage,
  createAnalysisAgentRunner,
  briefFor,
  changePreferences,
  createAlertStore,
  createPreferencesStore,
  digestPeriod,
  inQuietHours,
  recentAlerts,
  routeFor,
  runStockAlerts,
  stockAlertSettings,
  storedAnalysis,
  submitAnalysis,
  triageEvent,
} from "../scripts/lib/stock-alerts.mjs";

const SCHEDULES = JSON.parse(readFileSync("config/schedules.json", "utf8"));
const MONITOR_SETTINGS = stockMonitorSettings(SCHEDULES);
const SETTINGS = stockAlertSettings(SCHEDULES);
const POLICY = Object.freeze({ stockMonitoring: { enabled: true } });
const isin = (first11) => `${first11}${isinCheckDigit(first11)}`;
const EXAMPLE = Object.freeze({ companyName: "Example AB", ticker: "EXAM B", exchange: "XSTO", shareClass: "B", isin: isin("SE000000002"), currency: "SEK", country: "SE", identifiers: {}, verification: { source: "esma-firds", checkedAt: "2026-10-20T08:00:00.000Z" } });
const OTHER = Object.freeze({ ...EXAMPLE, companyName: "Other AB", ticker: "OTHR", shareClass: null, isin: isin("SE000000009") });
const THESIS = Object.freeze({ statement: "Margins will improve as revenue scales.", metrics: ["Operating margin", "Organic growth"], breakers: ["Sustained margin deterioration", "Material dilution"] });

const releaseUrl = (id) => `https://view.news.eu.nasdaq.com/view?id=${id}`;
const REPORT_HTML = `<html><body><h1>Example AB: Interim report January–September 2026</h1>
<p>Third quarter: net sales increased by 8% to SEK 1 234,5 m (1 143,0). Operating margin 12,0% (16,0).</p>
<p>Outlook: organic growth of 5–7% for 2026 is maintained.</p></body></html>`;
const RIGHTS_HTML = `<html><body><h1>Example AB resolves on a rights issue of approximately SEK 500 million</h1>
<p>Shareholders registered on the record date 30 October 2026 receive subscription rights. The subscription period runs from 3 November to 17 November 2026.</p></body></html>`;

function fakeSource({ key, kind = "disclosures", flag = "companyNews", evidence = "official_disclosure" }) {
  const source = {
    key,
    kind,
    name: `${key} feed`,
    label: `${key} source`,
    evidence,
    items: [],
    calendar: null,
    calls: 0,
    enabledFor: (monitoring) => Boolean(monitoring[flag]),
    coverage: () => ({ status: "available", note: null }),
    async check(security) {
      source.calls += 1;
      const items = source.items.filter((entry) => !entry.isin || entry.isin === security.isin);
      return { status: "ok", items: items.map((entry) => ({ ...entry })), ...(source.calendar ? { calendar: source.calendar } : {}) };
    },
  };
  return source;
}

/**
 * A temporary watchlist with fake sources, a fake analysis turn that reads its
 * brief and submits through the real helper, and a fake scheduler history.
 */
function harness({ settings = SETTINGS, policy = POLICY } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "hilla-stock-alerts-"));
  const sources = {
    exchange: fakeSource({ key: "exchange" }),
    distributor: fakeSource({ key: "mfn", evidence: "company_release" }),
    calendar: fakeSource({ key: "calendar", kind: "calendar", flag: "reports" }),
    news: fakeSource({ key: "news", kind: "news", flag: "generalNews", evidence: "news" }),
    forum: fakeSource({ key: "forum", kind: "forums", flag: "forums", evidence: "forum" }),
  };
  const list = Object.values(sources);
  const open = () => ({ watchlistStore: createWatchlistStore({ stateDir }), monitorStore: createMonitorStore({ stateDir }), alertStore: createAlertStore({ stateDir }), preferencesStore: createPreferencesStore({ stateDir }) });
  let stores = open();
  const pages = new Map();
  const fetchPage = async (url) => (pages.has(url) ? { status: "ok", body: pages.get(url) } : { status: "not_found", reason: "Not found (HTTP 404)." });
  const runs = [];
  let counter = 0;
  const random = (size) => {
    const buffer = Buffer.alloc(size);
    buffer.writeUInt32BE((counter += 1), size - 4);
    return buffer;
  };
  const agent = { calls: [], submissions: [], behaviour: "submit", build: null, now: null };
  agent.run = async ({ requestId, message, timeoutSeconds }) => {
    agent.calls.push({ requestId, message, timeoutSeconds });
    if (agent.behaviour === "fail") return { ok: false, error: "the turn timed out" };
    if (agent.behaviour === "silent") return { ok: true, error: null };
    const brief = briefFor({ ...stores, request: requestId });
    assert.equal(brief.ok, true, JSON.stringify(brief));
    agent.briefs = [...(agent.briefs ?? []), brief];
    const result = await submitAnalysis({ ...stores, input: { request: requestId, ...agent.build(brief) }, now: agent.now, fetchPage, settings });
    agent.submissions.push(result);
    return { ok: true, error: null };
  };
  const follow = (security, extra = {}) => {
    const now = new Date("2026-10-20T08:00:00.000Z");
    const preview = runStockAction("add", { security, ...extra }, { store: stores.watchlistStore, now, random });
    const saved = runStockAction("add", { security, ...extra, approval: { digest: preview.digest, replyText: "yes" } }, { store: stores.watchlistStore, now, random });
    assert.equal(saved.status, "saved", JSON.stringify(saved));
    return saved.security.id;
  };
  /** One scheduled run at `iso`: the checks, the alerts, and the scheduler's record of whether its output was delivered. */
  const cycle = async (iso, { delivered = true, ...extra } = {}) => {
    const now = new Date(iso);
    agent.now = now;
    await runStockMonitor({ ...stores, settings: MONITOR_SETTINGS, policy, sources: list, fetcher: { requestsUsed: () => 0, robots: {} }, now, scheduled: true, force: true });
    const result = await runStockAlerts({ ...stores, settings, policy, sources: list, now, runAgent: agent.run, readRuns: async () => runs, scheduled: true, random, ...extra });
    const printed = result.text !== "NO_REPLY";
    runs.unshift({ runAtMs: now.getTime() - 30_000, durationMs: 90_000, delivered: printed ? delivered : false, deliveryStatus: printed ? (delivered ? "delivered" : "failed") : "not-requested" });
    return result;
  };
  return {
    stateDir,
    sources,
    pages,
    agent,
    runs,
    follow,
    cycle,
    get stores() {
      return stores;
    },
    restart: () => {
      stores = open();
    },
    state: (watchId) => stores.monitorStore.read(watchId),
    alerts: (watchId) => stores.alertStore.read(watchId),
    cleanup: () => rmSync(stateDir, { recursive: true, force: true }),
  };
}

const item = (id, title, publishedAt, extra = {}) => ({ documentId: id, url: releaseUrl(id), title, publishedAt, language: "en", ...extra });

const reportAnalysis = (brief) => {
  const url = brief.event.officialSources[0].url;
  return {
    importance: { level: "important", reason: "The quarterly report, with a narrower margin" },
    sourcesRead: [{ url, read: true }],
    metrics: [
      { id: "net_sales", name: "Net sales", unit: "currency", basis: "reported", currency: "SEK", scale: "millions", current: { period: "Q3 2026", value: 1234.5 }, prior: { period: "Q3 2025", value: 1143.0 }, source: { url, location: "summary" } },
      { id: "operating_margin", name: "Operating margin", unit: "percent", basis: "reported", current: { period: "Q3 2026", value: 12.0 }, prior: { period: "Q3 2025", value: 16.0 }, source: { url, location: "summary" } },
    ],
    guidance: { status: "maintained", text: "Organic growth of 5–7% for 2026", source: { url, location: "outlook" } },
    keyPoints: ["Sales grew while the operating margin narrowed"],
    ...(brief.thesis ? { thesisImpact: { outcome: "weakens", reason: `The margin fell while sales grew, against the assumption that ${brief.thesis.statement.toLowerCase()}`, metricIds: ["operating_margin"] } } : {}),
    review: ["The explanation for the margin pressure", "Cash-flow development", "The full-year outlook"],
  };
};

const rightsAnalysis = (brief) => {
  const url = brief.event.officialSources[0].url;
  return {
    importance: { level: "critical", reason: "A rights issue with a subscription deadline" },
    sourcesRead: [{ url, read: true }],
    keyPoints: ["The company is raising new equity from existing shareholders"],
    deadlines: [
      { label: "Record date", date: "2026-10-30", source: { url, location: "timetable" } },
      { label: "Subscription period ends", date: "2026-11-17", source: { url, location: "timetable" } },
    ],
    eligibility: "Shareholders registered on the record date receive subscription rights",
    review: ["The subscription price and the terms", "How the proceeds will be used"],
  };
};

const ADVICE = /\b(?:buy|sell)\b(?! rights)|buying opportunity|will rise|increase your position|price target/i;

describe("stock alerts: importance from rules and context", () => {
  const official = (type, title, extra = {}) => ({ id: `ev-${String(Math.random()).slice(2, 14).padEnd(12, "0")}`, type, title, evidence: "official_disclosure", prefilter: "informational", insideInformation: false, publishedAt: "2026-10-22T06:00:00.000Z", discoveredAt: "2026-10-22T06:07:00.000Z", baseline: false, sources: [], keys: [], ...extra });

  it("ranks reports, halts, warnings and issues as the spec does, and history as noise", () => {
    assert.equal(triageEvent(official("report", "Interim report Q3 2026", { report: { kind: "interim", period: "Q3", fiscalYear: 2026 } })).level, "important");
    assert.equal(triageEvent(official("report", "Annual report 2025", { report: { kind: "annual", period: "FY", fiscalYear: 2025 } })).level, "informational");
    assert.equal(triageEvent(official("report", "Correction: Interim report Q3 2026", { report: { kind: "interim", period: "Q3", fiscalYear: 2026, correction: true } })).reason, "a correction to a published report");
    for (const type of ["trading_suspension", "profit_warning", "rights_issue", "takeover_offer", "insolvency", "delisting"]) assert.equal(triageEvent(official(type, "x")).level, "critical", type);
    assert.equal(triageEvent(official("report", "Interim report Q3 2026", { baseline: true })).level, "noise");
    assert.equal(triageEvent(official("buyback", "Transactions in own shares during week 42")).level, "noise");
    assert.equal(triageEvent(official("other_disclosure", "Total number of shares and votes in Example AB")).level, "noise");
  });

  it("weighs a management change by what it is and when it happens", () => {
    const warning = official("profit_warning", "Example AB lowers its outlook", { publishedAt: "2026-09-01T06:00:00.000Z" });
    const appointment = official("management_change", "Example AB appoints new CFO", { prefilter: "important" });
    const resignation = official("management_change", "Example AB's CEO resigns with immediate effect");
    assert.equal(triageEvent(appointment, { events: [warning] }).level, "informational", "a routine appointment");
    assert.equal(triageEvent(resignation).level, "important");
    const crisis = triageEvent(resignation, { events: [warning] });
    assert.equal(crisis.level, "critical", "a CEO leaving within three months of a profit warning");
    assert.match(crisis.reason, /within three months of a profit warning/);
  });

  it("treats a company's routine announcements as routine", () => {
    const earlier = [1, 2, 3].map((month) => official("acquisition", `Example AB acquires Target ${month}`, { publishedAt: `2026-0${month + 5}-01T06:00:00.000Z` }));
    assert.equal(triageEvent(official("acquisition", "Example AB acquires Target 4")).level, "important");
    assert.match(triageEvent(official("acquisition", "Example AB acquires Target 4"), { events: earlier }).reason, /routine for this company: 3 similar announcements/);
    assert.equal(triageEvent(official("major_order", "Example AB receives order")).level, "informational");
    assert.equal(triageEvent(official("major_order", "Example AB receives major order", { insideInformation: true, prefilter: "important" })).level, "important");
  });

  it("keeps news and forum talk out of alerts, and a postponed report in them", () => {
    assert.equal(triageEvent({ ...official("news_article", "Example AB issues profit warning, paper says"), evidence: "news" }).level, "informational");
    assert.equal(triageEvent({ ...official("forum_discussion", "40 new posts"), evidence: "forum" }).level, "informational");
    assert.equal(triageEvent(official("report_date_changed", "Report date moved: interim report Q3 2026 from 2026-10-23 to 2026-10-30")).level, "important");
    assert.equal(triageEvent(official("report_date_changed", "Report date moved: interim report Q3 2026 from 2026-10-30 to 2026-10-23")).level, "informational");
  });

  it("routes by the stock's notification level", () => {
    const record = (notificationLevel, status = "watching") => ({ status, notificationLevel });
    assert.equal(routeFor("important", record("important")), "alert");
    assert.equal(routeFor("important", record("critical")), "digest");
    assert.equal(routeFor("critical", record("critical")), "alert");
    assert.equal(routeFor("informational", record("all")), "also");
    assert.equal(routeFor("informational", record("important")), "digest");
    assert.equal(routeFor("critical", record("off")), "none");
    assert.equal(routeFor("critical", record("important", "paused")), "none");
    assert.equal(routeFor("noise", record("all")), "none");
    assert.equal(routeFor("important", record("important"), { missed: true }), "missed");
  });

  it("starts the analysis turn as an isolated personal-agent turn whose arguments carry only the request id", async () => {
    const calls = [];
    const runner = createAnalysisAgentRunner({ runOpenClaw: async (argv, options) => calls.push({ argv, options }) });
    const message = analysisHandoffMessage("rq-0a1b2c3d");
    assert.deepEqual(await runner({ requestId: "rq-0a1b2c3d", message, timeoutSeconds: 600 }), { ok: true, error: null });
    assert.deepEqual(calls[0].argv, ["agent", "--agent", "personal", "--session-key", "stock-analysis-rq-0a1b2c3d", "--message", message, "--json", "--timeout", "600"]);
    assert.equal(calls[0].options.timeoutMs, 660_000);
    assert.ok(!calls[0].argv.includes("--deliver"), "the turn's own reply goes nowhere");
    const failing = createAnalysisAgentRunner({ runOpenClaw: async () => { throw new Error("gateway timed out"); } });
    assert.deepEqual(await failing({ requestId: "rq-0a1b2c3d", message, timeoutSeconds: 600 }), { ok: false, error: "gateway timed out" });
  });

  it("asks the analysis for the key figures even without a comparison, in words the user can read", () => {
    const record = { status: "watching", notificationLevel: "important", ownership: "unknown", focusAreas: [], thesis: null, security: { companyName: "Example AB", ticker: "EXAM B", exchange: "XSTO", isin: EXAMPLE.isin, currency: "SEK" } };
    const event = { id: "ev-0123456789ab", type: "report", evidence: "official_disclosure", title: "Interim report January–September 2026", report: { kind: "interim", period: "Q3", fiscalYear: 2026 }, publishedAt: "2026-10-22T06:00:00.000Z", sources: [{ key: "exchange", name: "Exchange", url: releaseUrl("q3"), documents: [], role: "original" }] };
    const brief = analysisBrief({ record, event, lifecycle: null, requestId: "rq-0a1b2c3d" });
    assert.ok(brief.rules.some((rule) => /Give the key figures the release states even when it gives no comparison/.test(rule) && /or null/.test(rule)));
    assert.ok(brief.rules.some((rule) => /plain words, never the brief's own terms such as allowedSources or checkable/.test(rule)));
    assert.ok(brief.example.metrics.some((metric) => metric.prior === null), "the example shows a figure without a prior");
  });

  it("knows quiet hours and digest periods in Stockholm time", () => {
    assert.equal(inQuietHours(new Date("2026-10-22T20:30:00Z"), SETTINGS), true, "22:30 in Stockholm");
    assert.equal(inQuietHours(new Date("2026-10-22T05:30:00Z"), SETTINGS), false, "07:30 in Stockholm");
    assert.equal(digestPeriod(new Date("2026-10-22T10:00:00Z"), { mode: "daily", settings: SETTINGS }).key, "2026-10-21");
    assert.equal(digestPeriod(new Date("2026-10-22T16:07:00Z"), { mode: "daily", settings: SETTINGS }).key, "2026-10-22");
    assert.equal(digestPeriod(new Date("2026-10-23T16:07:00Z"), { mode: "weekly", settings: SETTINGS }).key, "2026-10-23", "Friday 18:07");
    assert.equal(digestPeriod(new Date("2026-10-25T10:00:00Z"), { mode: "weekly", settings: SETTINGS }).key, "2026-10-23", "a missed Friday is still this week's");
  });
});

describe("stock alerts: runs", () => {
  it("sends nothing and runs no model when nobody is followed", async () => {
    const h = harness();
    try {
      const result = await h.cycle("2026-10-22T08:07:00Z");
      assert.equal(result.text, "NO_REPLY");
      assert.equal(h.agent.calls.length, 0);
    } finally {
      h.cleanup();
    }
  });

  it("does nothing at all while stock monitoring is switched off", async () => {
    const h = harness({ policy: { stockMonitoring: { enabled: false } } });
    try {
      h.follow(EXAMPLE);
      h.sources.exchange.items = [item("t1", "Example AB: trading halt", "2026-10-22T06:00:00Z")];
      const result = await h.cycle("2026-10-22T08:07:00Z");
      assert.equal(result.text, "NO_REPLY");
      assert.equal(result.report.authorized, false);
      assert.equal(h.agent.calls.length, 0);
    } finally {
      h.cleanup();
    }
  });

  it("alerts a critical release at once with its stated deadlines, without assuming ownership or advising a trade", async () => {
    const h = harness();
    try {
      const id = h.follow(EXAMPLE);
      await h.cycle("2026-10-22T06:07:00Z");
      h.sources.exchange.items = [item("r1", "Example AB resolves on a rights issue of approximately SEK 500 million", "2026-10-22T06:30:00Z")];
      h.pages.set(releaseUrl("r1"), RIGHTS_HTML);
      h.agent.build = rightsAnalysis;
      const result = await h.cycle("2026-10-22T07:07:00Z");
      assert.equal(h.agent.calls.length, 1);
      assert.equal(h.agent.submissions[0].status, "stored", JSON.stringify(h.agent.submissions[0]));
      assert.match(result.text, /^\*\*Example AB \(EXAM B\) — rights issue \(time-sensitive\)\*\*/);
      assert.match(result.text, /Subscription period ends: 17 Nov 2026/);
      assert.match(result.text, /You haven't told me whether you own shares, so I can't say whether this applies to you\./);
      assert.match(result.text, /I never act on it for you/);
      assert.match(result.text, new RegExp(releaseUrl("r1").replace(/[?]/g, "\\?")));
      assert.doesNotMatch(result.text, ADVICE);
      const [lifecycle] = Object.values(h.alerts(id).events);
      assert.equal(lifecycle.level, "critical");
      assert.equal(lifecycle.alert.status, "sent");
    } finally {
      h.cleanup();
    }
  });

  it("sends a short factual alert when a critical release can't be analysed", async () => {
    const h = harness();
    try {
      h.follow(EXAMPLE);
      await h.cycle("2026-10-22T06:07:00Z");
      h.sources.exchange.items = [item("h1", "Example AB: trading halt pending an announcement", "2026-10-22T06:40:00Z")];
      h.agent.behaviour = "fail";
      const result = await h.cycle("2026-10-22T07:07:00Z");
      assert.equal(h.agent.calls.length, 1);
      assert.match(result.text, /trading halted \(time-sensitive\)/);
      assert.match(result.text, /Headline: “Example AB: trading halt pending an announcement”/);
      assert.match(result.text, /I haven't analysed it \(the analysis didn't finish\), so this is the headline only; the release has the details: https:\/\/view\.news\.eu\.nasdaq\.com/);
      assert.equal(result.report.fallbacks, 1);
    } finally {
      h.cleanup();
    }
  });

  it("analyses an important report once, sends one alert, and never repeats it after a restart", async () => {
    const h = harness();
    try {
      const id = h.follow(EXAMPLE, { thesis: THESIS });
      await h.cycle("2026-10-22T06:07:00Z");
      h.sources.exchange.items = [item("q3", "Example AB: Interim report January–September 2026", "2026-10-22T06:30:00Z")];
      h.pages.set(releaseUrl("q3"), REPORT_HTML);
      h.agent.build = reportAnalysis;
      const first = await h.cycle("2026-10-22T07:07:00Z");
      assert.match(first.text, /Q3 2026 report published/);
      assert.match(first.text, /Net sales, Q3 2026: SEK 1 234\.5m \(Q3 2025: SEK 1 143m\), \+8\.0%/);
      assert.match(first.text, /Operating margin, Q3 2026: 12% \(Q3 2025: 16%\), −4\.0 percentage points/);
      assert.match(first.text, /Outlook: maintained\. “Organic growth of 5–7% for 2026”/);
      assert.match(first.text, /Your thesis: Weakens it\./);
      assert.match(first.text, /Your saved thesis stays as it is unless you change it\./);
      assert.match(first.text, /Worth reviewing:\n1\. The explanation for the margin pressure/);
      assert.doesNotMatch(first.text, ADVICE);
      assert.equal(h.agent.briefs[0].thesis.statement, THESIS.statement, "the analysis is measured against the user's own thesis");
      assert.equal("ownership" in h.agent.briefs[0], false, "ownership never goes to the analysis");
      h.restart();
      const second = await h.cycle("2026-10-22T08:07:00Z");
      assert.equal(second.text, "NO_REPLY", "the same report found again is not alerted again");
      assert.equal(h.agent.calls.length, 1, "and not analysed again");
      const alerts = recentAlerts({ alertStore: h.stores.alertStore, watchlistStore: h.stores.watchlistStore, now: new Date("2026-10-22T08:10:00Z") });
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].delivery, "delivered", "confirmed only from the scheduler's history");
      const mode = statSync(join(h.stateDir, "stock-watch", "alerts", `${id}.json`)).mode & 0o777;
      assert.equal(mode, 0o600);
    } finally {
      h.cleanup();
    }
  });

  it("waits a few hours for an important release's analysis, then sends the facts", async () => {
    const h = harness();
    try {
      h.follow(EXAMPLE);
      await h.cycle("2026-10-22T06:07:00Z");
      h.sources.exchange.items = [item("q3", "Example AB: Interim report January–September 2026", "2026-10-22T06:30:00Z")];
      h.agent.behaviour = "silent";
      const first = await h.cycle("2026-10-22T07:07:00Z");
      assert.equal(first.text, "NO_REPLY");
      assert.equal(first.report.waiting, 1);
      const second = await h.cycle("2026-10-22T08:07:00Z");
      assert.equal(h.agent.calls.length, 2, "one retry an hour later");
      assert.match(second.text, /I haven't analysed it \(the analysis didn't finish\)/, "after the second attempt the facts go out at once");
      const third = await h.cycle("2026-10-22T09:07:00Z");
      assert.equal(third.text, "NO_REPLY");
      assert.equal(h.agent.calls.length, 2, "two attempts per event, no more");
    } finally {
      h.cleanup();
    }
  });

  it("keeps to the analysis budget and sends what had to wait with an honest reason", async () => {
    const h = harness({ settings: { ...SETTINGS, analysis: { ...SETTINGS.analysis, maxTurnsPerDay: 1 } } });
    try {
      h.follow(EXAMPLE);
      h.follow(OTHER);
      await h.cycle("2026-10-22T06:07:00Z");
      h.sources.exchange.items = [item("q3a", "Example AB: Interim report January–September 2026", "2026-10-22T06:30:00Z", { isin: EXAMPLE.isin }), item("q3b", "Other AB: Interim report January–September 2026", "2026-10-22T06:31:00Z", { isin: OTHER.isin })];
      h.pages.set(releaseUrl("q3a"), REPORT_HTML);
      h.agent.build = reportAnalysis;
      const first = await h.cycle("2026-10-22T07:07:00Z");
      assert.equal(h.agent.calls.length, 1, "one turn per run and per day here");
      assert.equal((first.text.match(/report published/g) ?? []).length, 1);
      const later = await h.cycle("2026-10-22T13:07:00Z");
      assert.equal(h.agent.calls.length, 1, "the day's budget is spent");
      assert.match(later.text, /I haven't analysed it \(today's analysis limit was reached\)/);
    } finally {
      h.cleanup();
    }
  });

  it("sends nothing for noise, history, news or forum talk, which wait for an opt-in summary", async () => {
    const h = harness();
    try {
      h.follow(EXAMPLE, { monitoring: { forums: true } });
      h.sources.exchange.items = [item("old", "Example AB: Interim report January–June 2026", "2026-07-15T06:00:00Z")];
      const baseline = await h.cycle("2026-10-22T06:07:00Z");
      assert.equal(baseline.text, "NO_REPLY", "a first check is history");
      h.sources.exchange.items.push(item("bb", "Example AB: Transactions in own shares during week 43", "2026-10-22T06:30:00Z"));
      h.sources.news.items = [{ documentId: "n1", url: "https://news.example/a1", title: "Example AB shares slip as analysts debate margins", publishedAt: "2026-10-22T06:40:00Z", publisher: "Example Daily", evidence: "news" }];
      h.sources.forum.items = [{ documentId: "posts-41", url: "https://forum.example/t/1", title: "12 new posts in the forum thread “Example AB”", publishedAt: "2026-10-22T06:50:00Z", evidence: "forum" }];
      const result = await h.cycle("2026-10-22T07:07:00Z");
      assert.equal(result.text, "NO_REPLY");
      assert.equal(h.agent.calls.length, 0, "no model for any of it");
      assert.deepEqual(result.report.levels, { critical: 0, important: 0, informational: 2, noise: 1 });
    } finally {
      h.cleanup();
    }
  });

  it("gathers ordinary news in a daily summary once per period, labelled, and never sends an empty one", async () => {
    const h = harness();
    try {
      h.follow(EXAMPLE);
      await h.cycle("2026-10-22T06:07:00Z");
      changePreferences({ store: h.stores.preferencesStore, input: { digest: "daily" }, now: new Date("2026-10-22T07:00:00Z"), today: "2026-10-22" });
      h.sources.exchange.items = [item("d1", "Example AB: Notice of extraordinary general meeting", "2026-10-22T08:00:00Z")];
      h.sources.news.items = [{ documentId: "n1", url: "https://news.example/a1", title: "Example AB expands in Germany", publishedAt: "2026-10-22T08:30:00Z", publisher: "Example Daily", evidence: "news" }];
      const morning = await h.cycle("2026-10-22T09:07:00Z");
      assert.equal(morning.text, "NO_REPLY", "the summary waits for its time");
      const evening = await h.cycle("2026-10-22T16:07:00Z");
      assert.match(evening.text, /^\*\*Your stocks: 22 Oct\*\*\n\nExample AB \(EXAM B\)/);
      assert.match(evening.text, /news, Example Daily \(a claim, not confirmed by the company\): “Example AB expands in Germany”/);
      assert.match(evening.text, /shareholder meeting: “Example AB: Notice of extraordinary general meeting”/);
      assert.equal((await h.cycle("2026-10-22T17:07:00Z")).text, "NO_REPLY", "one summary per period");
      const empty = await h.cycle("2026-10-23T16:07:00Z");
      assert.equal(empty.text, "NO_REPLY");
      assert.equal(empty.report.digest, "empty");
    } finally {
      h.cleanup();
    }
  });

  it("holds non-urgent alerts during quiet hours, but not critical ones", async () => {
    const h = harness();
    try {
      h.follow(EXAMPLE);
      await h.cycle("2026-10-22T19:07:00Z");
      h.sources.exchange.items = [item("q3", "Example AB: Interim report January–September 2026", "2026-10-22T20:30:00Z")];
      h.pages.set(releaseUrl("q3"), REPORT_HTML);
      h.agent.build = reportAnalysis;
      const night = await h.cycle("2026-10-22T21:07:00Z");
      assert.equal(night.text, "NO_REPLY");
      assert.equal(night.report.held, 1);
      assert.equal(h.agent.calls.length, 1, "it is analysed at night, ready for the morning");
      h.sources.exchange.items.push(item("h1", "Example AB: trading halt", "2026-10-22T23:00:00Z"));
      h.agent.behaviour = "fail";
      const halt = await h.cycle("2026-10-22T23:07:00Z");
      assert.match(halt.text, /trading halted \(time-sensitive\)/);
      assert.doesNotMatch(halt.text, /report published/);
      const morning = await h.cycle("2026-10-23T05:07:00Z");
      assert.match(morning.text, /Q3 2026 report published/);
    } finally {
      h.cleanup();
    }
  });

  it("pausing all alerts suppresses them and spends no model turns; resuming doesn't send what came meanwhile", async () => {
    const h = harness();
    try {
      h.follow(EXAMPLE);
      await h.cycle("2026-10-22T06:07:00Z");
      const paused = changePreferences({ store: h.stores.preferencesStore, input: { alertsPaused: true }, now: new Date("2026-10-22T06:30:00Z"), today: "2026-10-22" });
      assert.match(paused.telegramText, /Stock alerts are paused/);
      h.sources.exchange.items = [item("w1", "Example AB issues profit warning", "2026-10-22T06:40:00Z")];
      const quiet = await h.cycle("2026-10-22T07:07:00Z");
      assert.equal(quiet.text, "NO_REPLY");
      assert.equal(quiet.report.suppressed, 1);
      assert.equal(h.agent.calls.length, 0);
      changePreferences({ store: h.stores.preferencesStore, input: { alertsPaused: false }, now: new Date("2026-10-22T07:30:00Z"), today: "2026-10-22" });
      h.agent.behaviour = "fail";
      assert.equal((await h.cycle("2026-10-22T08:07:00Z")).text, "NO_REPLY", "the warning found while paused stays unsent");
      h.sources.exchange.items.push(item("h1", "Example AB: trading halt", "2026-10-22T08:30:00Z"));
      assert.match((await h.cycle("2026-10-22T09:07:00Z")).text, /trading halted/);
    } finally {
      h.cleanup();
    }
  });

  it("keeps what came while alerts were paused out of later summaries", async () => {
    const h = harness();
    try {
      h.follow(EXAMPLE);
      await h.cycle("2026-10-22T06:07:00Z");
      changePreferences({ store: h.stores.preferencesStore, input: { digest: "daily" }, now: new Date("2026-10-22T06:30:00Z"), today: "2026-10-22" });
      changePreferences({ store: h.stores.preferencesStore, input: { alertsPaused: true }, now: new Date("2026-10-22T06:40:00Z"), today: "2026-10-22" });
      h.sources.exchange.items = [item("e1", "Example AB: Notice of extraordinary general meeting", "2026-10-22T07:00:00Z")];
      await h.cycle("2026-10-22T07:07:00Z");
      const pausedEvening = await h.cycle("2026-10-22T16:07:00Z");
      assert.equal(pausedEvening.text, "NO_REPLY");
      assert.equal(pausedEvening.report.digest, "paused");
      changePreferences({ store: h.stores.preferencesStore, input: { alertsPaused: false }, now: new Date("2026-10-22T16:30:00Z"), today: "2026-10-22" });
      assert.equal((await h.cycle("2026-10-22T17:07:00Z")).text, "NO_REPLY", "the paused period has no summary after resuming");
      h.sources.exchange.items.push(item("a1", "Example AB: Notice of annual general meeting", "2026-10-23T08:00:00Z"));
      const next = await h.cycle("2026-10-23T16:07:00Z");
      assert.match(next.text, /Notice of annual general meeting/);
      assert.doesNotMatch(next.text, /extraordinary/);
    } finally {
      h.cleanup();
    }
  });

  it("sends nothing for a paused stock or one with notifications off", async () => {
    const h = harness();
    try {
      const id = h.follow(EXAMPLE);
      const quiet = h.follow(OTHER, { notificationLevel: "off" });
      await h.cycle("2026-10-22T19:07:00Z");
      h.sources.exchange.items = [item("q3", "Example AB: Interim report January–September 2026", "2026-10-22T20:30:00Z", { isin: EXAMPLE.isin }), item("w1", "Other AB issues profit warning", "2026-10-22T20:40:00Z", { isin: OTHER.isin })];
      h.agent.behaviour = "fail";
      const night = await h.cycle("2026-10-22T21:07:00Z");
      assert.equal(night.text, "NO_REPLY");
      runStockAction("settings", { id, status: "paused" }, { store: h.stores.watchlistStore, now: new Date("2026-10-22T22:00:00Z") });
      const morning = await h.cycle("2026-10-23T05:07:00Z");
      assert.equal(morning.text, "NO_REPLY", "the held report of a stock paused since is not sent");
      assert.equal(Object.values(h.alerts(quiet).events)[0].alert.reason, "notifications off for this stock");
    } finally {
      h.cleanup();
    }
  });

  it("prints a failed delivery again at most three times and never calls it delivered", async () => {
    const h = harness();
    try {
      h.follow(EXAMPLE);
      await h.cycle("2026-10-22T06:07:00Z");
      h.sources.exchange.items = [item("h1", "Example AB: trading halt", "2026-10-22T06:30:00Z")];
      h.agent.behaviour = "fail";
      const first = await h.cycle("2026-10-22T07:07:00Z", { delivered: false });
      assert.match(first.text, /trading halted/);
      const second = await h.cycle("2026-10-22T08:07:00Z", { delivered: false });
      assert.equal(second.text, first.text, "printed again as it was");
      assert.equal(second.report.resent, 1);
      const third = await h.cycle("2026-10-22T09:07:00Z", { delivered: false });
      assert.equal(third.text, first.text);
      const fourth = await h.cycle("2026-10-22T10:07:00Z", { delivered: false });
      assert.equal(fourth.text, "NO_REPLY", "three attempts, then it stops");
      const [alert] = recentAlerts({ alertStore: h.stores.alertStore, watchlistStore: h.stores.watchlistStore, now: new Date("2026-10-22T10:10:00Z") });
      assert.equal(alert.delivery, "failed");
      const status = alertStatusView({ alertStore: h.stores.alertStore, preferencesStore: h.stores.preferencesStore, watchlistStore: h.stores.watchlistStore, now: new Date("2026-10-22T10:10:00Z"), settings: SETTINGS });
      assert.equal(status.deliveries.delivered, 0);
      assert.equal(status.deliveries.failed, 1);
    } finally {
      h.cleanup();
    }
  });

  it("stops resending an alert the user has answered", async () => {
    const h = harness();
    try {
      h.follow(EXAMPLE);
      await h.cycle("2026-10-22T06:07:00Z");
      h.sources.exchange.items = [item("h1", "Example AB: trading halt", "2026-10-22T06:30:00Z")];
      h.agent.behaviour = "fail";
      await h.cycle("2026-10-22T07:07:00Z", { delivered: false });
      const [sent] = recentAlerts({ alertStore: h.stores.alertStore, watchlistStore: h.stores.watchlistStore, now: new Date("2026-10-22T07:30:00Z") });
      const ack = acknowledgeAlerts({ alertStore: h.stores.alertStore, watchlistStore: h.stores.watchlistStore, input: { alert: sent.id, decision: "seen", replyText: "seen it" }, now: new Date("2026-10-22T07:30:00Z") });
      assert.equal(ack.status, "saved");
      assert.equal((await h.cycle("2026-10-22T08:07:00Z")).text, "NO_REPLY");
      const [answered] = recentAlerts({ alertStore: h.stores.alertStore, watchlistStore: h.stores.watchlistStore, now: new Date("2026-10-22T08:30:00Z") });
      assert.equal(answered.answered, "seen");
    } finally {
      h.cleanup();
    }
  });

  it("lists releases found days late once, without analysis, after the computer slept", async () => {
    const h = harness();
    try {
      h.follow(EXAMPLE);
      await h.cycle("2026-10-12T06:07:00Z");
      h.sources.exchange.items = [
        item("old", "Example AB: Interim report January–September 2026", "2026-10-18T06:00:00Z"),
        item("ancient", "Example AB: Example AB acquires Target Oy", "2026-10-02T06:00:00Z"),
        item("halt", "Example AB: trading halt", "2026-10-18T09:00:00Z"),
      ];
      const woke = await h.cycle("2026-10-22T06:07:00Z");
      assert.equal(h.agent.calls.length, 0, "nothing older than three days is analysed");
      assert.match(woke.text, /\*\*Found late\*\*\nThese came out days before I found them/);
      assert.match(woke.text, /- 18 Oct · Example AB \(EXAM B\) · report: “Example AB: Interim report January–September 2026”/);
      assert.match(woke.text, /- 2 Oct · Example AB \(EXAM B\) · acquisition/);
      assert.match(woke.text, /trading halted \(time-sensitive\)\*\*\nOfficial release, 18 Oct, 11:00, via exchange feed; found after a pause in checking\./);
      assert.match(woke.text, /it was published more than a few days ago/);
      assert.equal((await h.cycle("2026-10-22T07:07:00Z")).text, "NO_REPLY");
    } finally {
      h.cleanup();
    }
  });

  it("lists ordinary news right away for a stock followed at level all", async () => {
    const h = harness();
    try {
      h.follow(EXAMPLE, { notificationLevel: "all" });
      await h.cycle("2026-10-22T06:07:00Z");
      h.sources.exchange.items = [item("dv", "Example AB: Notice of extraordinary general meeting", "2026-10-22T06:30:00Z")];
      const result = await h.cycle("2026-10-22T07:07:00Z");
      assert.match(result.text, /^\*\*Also found for your stocks\*\*\n- 22 Oct · Example AB \(EXAM B\) · shareholder meeting/);
    } finally {
      h.cleanup();
    }
  });

  it("holds everything but a notice when the alert preferences can't be read", async () => {
    const h = harness();
    try {
      h.follow(EXAMPLE);
      await h.cycle("2026-10-22T06:07:00Z");
      writeFileSync(h.stores.preferencesStore.path, "{not json", { mode: 0o600 });
      h.sources.exchange.items = [item("h1", "Example AB: trading halt", "2026-10-22T06:30:00Z")];
      const result = await h.cycle("2026-10-22T07:07:00Z");
      assert.doesNotMatch(result.text, /trading halted/);
      assert.match(result.text, /couldn't be read, so I'm not alerting/);
      assert.equal(h.agent.calls.length, 0);
    } finally {
      h.cleanup();
    }
  });
});

describe("stock alerts: end-to-end synthetic scenario", () => {
  it("follows Example AB from the watchlist to an acknowledged, thesis-aware report alert, once", async () => {
    const h = harness();
    try {
      // 1–2. The user adds Example AB, with their thesis; the resolved listing is stored.
      const id = h.follow(EXAMPLE, { thesis: THESIS, focusAreas: ["operating performance"] });
      const record = h.stores.watchlistStore.read(id);
      assert.equal(record.status, "watching");
      assert.equal(record.ownership, "unknown", "following is not owning");

      // 3. The next report date is discovered from the company's calendar.
      h.sources.calendar.calendar = [{ kind: "interim", fiscalYear: 2026, period: "Q3", date: "2026-10-23", status: "confirmed", url: "https://example.com/ir/calendar" }];
      await h.cycle("2026-10-20T08:07:00Z");
      const upcoming = nextReportDate(h.state(id).calendar, { today: "2026-10-20", events: h.state(id).events });
      assert.deepEqual([upcoming.date, upcoming.status, upcoming.period], ["2026-10-23", "confirmed", "Q3"]);

      // 4–6. The report is published and appears on the exchange, the company's distributor and a news site.
      const title = "Example AB: Interim report January–September 2026";
      h.sources.exchange.items = [item("q3", title, "2026-10-23T05:00:00Z")];
      h.sources.distributor.items = [{ documentId: "mfn-q3", groupId: "g-q3", url: "https://mfn.se/a/example-ab/q3-2026", title, publishedAt: "2026-10-23T05:00:00Z", language: "en", report: { kind: "interim", period: "Q3", fiscalYear: 2026 } }];
      h.sources.news.items = [{ documentId: "n-q3", url: "https://news.example/example-q3", title, publishedAt: "2026-10-23T05:20:00Z", publisher: "Example Daily", evidence: "news" }];
      h.pages.set(releaseUrl("q3"), REPORT_HTML);
      h.agent.build = reportAnalysis;
      const alert = await h.cycle("2026-10-23T06:07:00Z");

      // 7. One event, three sources: the repeats are its sources, never separate developments.
      const reports = h.state(id).events.filter((event) => event.type === "report" && !event.baseline);
      assert.equal(reports.length, 1);
      assert.equal(reports[0].sources.length, 3);
      assert.deepEqual(reports[0].sources.map((source) => [source.key, source.role]), [["exchange", "original"], ["mfn", "repeat"], ["news", "coverage"]], "the exchange carries the release, the company's distributor repeats it, a news site covers it");
      assert.equal(nextReportDate(h.state(id).calendar, { today: "2026-10-23", events: h.state(id).events }), null, "a published report is no longer upcoming");

      // 8–10. Figures are extracted, checked against the release page, compared with Q3 2025 and measured against the thesis.
      assert.equal(h.agent.calls.length, 1);
      assert.equal(h.agent.submissions[0].status, "stored", JSON.stringify(h.agent.submissions[0]));
      const lifecycle = h.alerts(id).events[reports[0].id];
      assert.equal(lifecycle.analysis.result.metrics.length, 2, "both figures were found on the release page");
      assert.ok(lifecycle.analysis.result.metrics.every((metric) => metric.comparison.comparable), "each against the same quarter a year earlier");
      assert.equal(lifecycle.analysis.result.thesisImpact.outcome, "weakens");
      const handoff = analysisHandoffMessage(lifecycle.analysis.requestId);
      for (const detail of ["Example", "EXAM", EXAMPLE.isin, THESIS.statement, "operating performance", title]) assert.ok(!handoff.includes(detail), `the handoff names the request only, not ${detail}`);

      // 11. One notification, through the scheduler (the fake sender), with real source links.
      assert.equal((alert.text.match(/^\*\*Example AB/gm) ?? []).length, 1);
      assert.match(alert.text, /Your thesis: Weakens it\./);
      assert.match(alert.text, /Sources:\n- Q3 2026 report release: https:\/\/view\.news\.eu\.nasdaq\.com\/view\?id=q3/);

      // 12. The monitor runs again: no duplicate, and the delivery is confirmed.
      const again = await h.cycle("2026-10-23T07:07:00Z");
      assert.equal(again.text, "NO_REPLY");
      const [sent] = recentAlerts({ alertStore: h.stores.alertStore, watchlistStore: h.stores.watchlistStore, now: new Date("2026-10-23T07:10:00Z") });
      assert.equal(sent.delivery, "delivered");

      // 13. The user acknowledges it by naming the stock.
      const ack = acknowledgeAlerts({ alertStore: h.stores.alertStore, watchlistStore: h.stores.watchlistStore, input: { target: "Example", decision: "seen", replyText: "Thanks, seen it" }, now: new Date("2026-10-23T07:30:00Z") });
      assert.equal(ack.status, "saved");
      assert.equal(h.alerts(id).events[reports[0].id].ack.decision, "seen");

      // 14. The user updates their thesis, explicitly, through preview and yes.
      const newThesis = { statement: "Recurring revenue keeps growing while margins hold.", metrics: ["Recurring revenue", "Operating margin"], breakers: ["Material dilution"] };
      const preview = runStockAction("thesis", { id, thesis: newThesis, reason: "My view changed" }, { store: h.stores.watchlistStore, now: new Date("2026-10-23T08:00:00Z") });
      assert.equal(preview.status, "preview");
      const saved = runStockAction("thesis", { id, thesis: newThesis, reason: "My view changed", approval: { digest: preview.digest, replyText: "yes" } }, { store: h.stores.watchlistStore, now: new Date("2026-10-23T08:01:00Z") });
      assert.equal(saved.status, "saved");
      const stored = storedAnalysis({ ...h.stores, eventId: reports[0].id });
      assert.equal(stored.thesisChangedSince, true, "the old analysis says it used the earlier thesis");

      // 15. Future analysis uses the new, approved thesis.
      const brief = briefFor({ ...h.stores, eventId: reports[0].id });
      assert.equal(brief.thesis.statement, newThesis.statement);
      const chat = await submitAnalysis({ ...h.stores, input: { eventId: reports[0].id, ...reportAnalysis(brief), thesisImpact: { outcome: "insufficient_evidence", reason: "One quarter says little about recurring revenue", metricIds: [] } }, now: new Date("2026-10-23T08:05:00Z"), fetchPage: async (url) => ({ status: "ok", body: h.pages.get(url) }), settings: SETTINGS });
      assert.equal(chat.status, "stored", JSON.stringify(chat));
      assert.match(chat.telegramText, /Your thesis: Not enough evidence yet\./);
      assert.equal(storedAnalysis({ ...h.stores, eventId: reports[0].id }).thesisChangedSince, false);
      assert.equal((await h.cycle("2026-10-23T09:07:00Z")).text, "NO_REPLY", "no new alert repeats what was answered in chat");
    } finally {
      h.cleanup();
    }
  });
});
