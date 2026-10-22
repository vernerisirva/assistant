import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalUrl, classifyDisclosure, cleanExternalText, detectReport, eventId, independentSourceCount, mergeEvents, normalizeItem, noticeDate } from "../scripts/lib/stock-events.mjs";

const NOW = new Date("2026-10-22T08:00:00.000Z");
const WATCH_ID = "sw-0000aaaa";
const SECURITY = { companyName: "Example AB", ticker: "EXAM B" };

function item(overrides) {
  return { sourceKey: "exchange", sourceName: "Exchange announcements", evidence: "official_disclosure", language: "en", publishedAt: "2026-10-22T05:30:00.000Z", ...overrides };
}

function merge(existing, items, options = {}) {
  const candidates = items.map((entry) => normalizeItem(entry, { watchId: WATCH_ID, security: SECURITY, now: NOW })).filter(Boolean);
  return mergeEvents(existing, candidates, { watchId: WATCH_ID, now: NOW, ...options });
}

describe("report detection", () => {
  it("reads report kind and period in Swedish, Finnish and English", () => {
    for (const [title, kind, year, period] of [
      ["Example AB: Interim Report January-September 2026", "interim", 2026, "Q3"],
      ["Delårsrapport januari–september 2026", "interim", 2026, "Q3"],
      ["Delårsrapport för perioden 1 januari – 30 september 2026", "interim", 2026, "Q3"],
      ["Example Oyj:n osavuosikatsaus tammi–syyskuu 2026", "interim", 2026, "Q3"],
      ["Example Q2 2026 interim report", "interim", 2026, "Q2"],
      ["Half-year report January–June 2026", "half_year", 2026, "H1"],
      ["Puolivuosikatsaus tammi–kesäkuu 2026", "half_year", 2026, "H1"],
      ["Business Review January–March 2026", "business_review", 2026, "Q1"],
      ["Bokslutskommuniké 2025", "year_end", 2025, "FY"],
      ["Tilinpäätöstiedote 2025", "year_end", 2025, "FY"],
      ["Year-end report 2025", "year_end", 2025, "FY"],
      ["Annual and Sustainability Report 2025", "annual", 2025, "FY"],
      ["Årsredovisningen för 2025 är publicerad", "annual", 2025, "FY"],
      ["Example Group’s results for January–September 2026", "interim", 2026, "Q3"],
    ]) {
      const report = detectReport(title);
      assert.ok(report, title);
      assert.equal(report.kind, kind, title);
      assert.equal(report.fiscalYear, year, title);
      assert.equal(report.period, period, title);
    }
  });

  it("keeps a broken fiscal year as a month range, never a made-up quarter", () => {
    const report = detectReport("Interim report May–July 2026");
    assert.deepEqual([report.period, report.months], [null, { from: 5, to: 7 }]);
  });

  it("never reads an invitation or a date notice as a published report", () => {
    for (const title of [
      "Invitation to presentation of Example AB’s interim report January–September 2026",
      "Inbjudan till presentation av delårsrapport för tredje kvartalet 2026",
      "Example AB publishes its interim report on 23 October",
      "Example Oyj:n osavuosikatsauksen julkistus 23.10.2026",
      "Example AB will publish its year-end report on 5 February 2027",
    ]) {
      assert.equal(detectReport(title), null, title);
      assert.equal(classifyDisclosure(title).type, "report_notice", title);
    }
  });

  it("marks corrections", () => {
    assert.equal(detectReport("Correction: Interim report January–September 2026").correction, true);
    assert.equal(detectReport("Rättelse: Delårsrapport januari–september 2026").correction, true);
    assert.equal(detectReport("Interim report January–September 2026").correction, false);
  });

  it("does not see an annual report inside the word for interim report", () => {
    assert.equal(detectReport("Delårsrapport Q3 2026").kind, "interim");
  });
});

describe("event types", () => {
  it("sorts time-critical, important and routine disclosures", () => {
    for (const [title, type, level] of [
      ["Trading halt in Example AB", "trading_suspension", "critical"],
      ["Example AB: Företrädesemission om 200 MSEK", "rights_issue", "critical"],
      ["Example AB lowers its outlook for 2026", "profit_warning", "critical"],
      ["Vinstvarning: rörelseresultatet blir lägre än väntat", "profit_warning", "critical"],
      ["Example Oyj antaa tulosvaroituksen", "profit_warning", "critical"],
      ["Example AB raises its full-year guidance", "guidance_upgrade", "important"],
      ["Example AB carries out a directed share issue", "share_issue", "important"],
      ["Example AB förvärvar Bolaget X", "acquisition", "important"],
      ["CEO of Example AB steps down", "management_change", "important"],
      ["Example AB: Managers’ transactions", "insider_transaction", "informational"],
      ["Example Oyj: Johdon liiketoimet", "insider_transaction", "informational"],
      ["Kallelse till årsstämma i Example AB", "shareholder_meeting", "informational"],
      ["Example AB repurchases own shares during week 42", "buyback", "informational"],
    ]) {
      const result = classifyDisclosure(title);
      assert.equal(result.type, type, title);
      assert.equal(result.prefilter, level, title);
    }
  });

  it("lifts a routine-looking release that the company marked as inside information", () => {
    assert.equal(classifyDisclosure("Example AB updates on the board", { category: "Inside information" }).prefilter, "important");
    assert.equal(classifyDisclosure("Something about Example AB", { category: "Insiderinformation" }).prefilter, "important");
    assert.equal(classifyDisclosure("Something about Example AB").prefilter, "informational");
  });
});

describe("external text", () => {
  it("strips markup, links, control and invisible characters, and shortens", () => {
    assert.equal(cleanExternalText("<b>Q3</b> report &amp; outlook https://evil.example/x \u202eetc"), "Q3 report & outlook etc");
    assert.equal(cleanExternalText("<![CDATA[Delårsrapport]]>"), "Delårsrapport");
    assert.equal(cleanExternalText("x".repeat(500)).length, 240);
  });

  it("compares links without tracking parameters or fragments", () => {
    assert.equal(canonicalUrl("https://WWW.Example.com/news/1/?utm_source=rss&id=2#top"), "https://example.com/news/1?id=2");
    assert.equal(canonicalUrl("javascript:alert(1)"), null);
  });

  it("gives the same event the same id on every run", () => {
    assert.equal(eventId("a"), eventId("a"));
    assert.notEqual(eventId("a"), eventId("b"));
  });
});

describe("deduplication", () => {
  it("merges the same report from the exchange, the company's distributor and its other language", () => {
    const { events, added } = merge([], [
      item({ documentId: "1001", url: "https://exchange.example/view?id=1001", title: "Example AB: Interim report January–September 2026" }),
      item({ sourceKey: "distributor", sourceName: "Distributor", evidence: "company_release", documentId: "abc", url: "https://distributor.example/abc", title: "Interim report January–September 2026", publishedAt: "2026-10-22T05:30:10.000Z" }),
      item({ documentId: "1002", url: "https://exchange.example/view?id=1002", title: "Delårsrapport januari–september 2026", language: "sv" }),
    ]);
    assert.equal(added.length, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "report");
    assert.equal(events[0].sources.length, 3);
    assert.deepEqual(events[0].report.period, "Q3");
  });

  it("does not create a second event when the same item is fetched again after a restart", () => {
    const first = merge([], [item({ documentId: "1001", url: "https://exchange.example/view?id=1001", title: "Example AB: Interim report January–September 2026" })]);
    const second = merge(first.events, [item({ documentId: "1001", url: "https://exchange.example/view?id=1001", title: "Example AB: Interim report January–September 2026" })]);
    assert.equal(second.added.length, 0);
    assert.equal(second.merged.length, 0);
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].sources.length, 1);
  });

  it("keeps a corrected report as a second version linked to the first", () => {
    const first = merge([], [item({ documentId: "1001", title: "Interim report January–September 2026" })]);
    const second = merge(first.events, [
      item({ documentId: "1005", title: "Correction: Interim report January–September 2026", publishedAt: "2026-10-22T09:00:00.000Z" }),
      item({ documentId: "1006", title: "Rättelse: Delårsrapport januari–september 2026", language: "sv", publishedAt: "2026-10-22T09:00:00.000Z" }),
    ]);
    assert.equal(second.added.length, 1, "the correction's two languages are one version");
    assert.equal(second.events.length, 2);
    assert.equal(second.added[0].correctionOf, first.events[0].id);
  });

  it("never merges two different releases published at the same moment", () => {
    const { events } = merge([], [
      item({ documentId: "2001", title: "Example AB: Interim report January–September 2026" }),
      item({ documentId: "2002", title: "Example AB appoints new CFO" }),
      item({ documentId: "2003", title: "Example AB receives order worth SEK 50 million" }),
    ]);
    assert.equal(events.length, 3);
  });

  it("merges one release carried by two channels at the same time, and keeps a recurring headline's new releases apart", () => {
    const first = merge([], [item({ documentId: "3001", title: "Example AB receives major order" })]);
    const otherChannel = merge(first.events, [item({ sourceKey: "distributor", sourceName: "Distributor", documentId: "d-77", title: "Example AB receives major order", publishedAt: "2026-10-22T05:31:00.000Z" })]);
    assert.equal(otherChannel.added.length, 0);
    assert.equal(otherChannel.events[0].sources.length, 2);
    // The same headline from the same channel with a new id is a new release, such as each week's managers' transactions.
    const weekly = merge([], [item({ documentId: "4001", title: "Example AB: Managers' transactions", publishedAt: "2026-10-20T14:30:00.000Z" })]);
    const nextDay = merge(weekly.events, [item({ documentId: "4002", title: "Example AB: Managers' transactions", publishedAt: "2026-10-21T14:30:00.000Z" })]);
    assert.equal(nextDay.added.length, 1);
    assert.equal(nextDay.events.length, 2);
    // A channel that already carries the event can't add a second release to it with the same headline.
    const both = merge([], [item({ documentId: "5001", title: "Example AB: Managers' transactions", publishedAt: "2026-10-22T10:00:00.000Z" }), item({ sourceKey: "distributor", sourceName: "Distributor", documentId: "d-5001", title: "Example AB: Managers' transactions", publishedAt: "2026-10-22T10:10:00.000Z" })]);
    assert.equal(both.events.length, 1);
    const again = merge(both.events, [item({ sourceKey: "distributor", sourceName: "Distributor", documentId: "d-5002", title: "Example AB: Managers' transactions", publishedAt: "2026-10-22T10:20:00.000Z" })]);
    assert.equal(again.events.length, 2);
    // Even across channels, the same headline a day apart is two releases.
    const later = merge(weekly.events, [item({ sourceKey: "distributor", sourceName: "Distributor", documentId: "d-88", title: "Example AB: Managers' transactions", publishedAt: "2026-10-21T14:30:00.000Z" })]);
    assert.equal(later.events.length, 2);
  });

  it("merges a syndicated news headline only across different publishers", () => {
    const news = (id, publisher, publishedAt) => item({ sourceKey: "news", sourceName: "News search", evidence: "news", documentId: id, url: `https://${id}.example/story`, publisher, title: "Example AB in talks to sell its software unit", publishedAt });
    const first = merge([], [news("a", "Outlet One", "2026-10-22T06:00:00.000Z")]);
    assert.equal(merge(first.events, [news("b", "Outlet Two", "2026-10-22T09:00:00.000Z")]).events.length, 1);
    assert.equal(merge(first.events, [news("c", "Outlet One", "2026-10-23T09:00:00.000Z")]).events.length, 2, "the same publisher's new article is a new item");
    assert.equal(merge(first.events, [news("d", "Outlet Two", "2026-10-26T09:00:00.000Z")]).events.length, 2, "older than two days is not a copy");
  });

  it("files news about a fresh report as coverage of that report, not as a new development", () => {
    const report = merge([], [item({ documentId: "1001", title: "Example AB: Interim report January–September 2026" })]);
    const news = ["Outlet One", "Outlet Two", "Outlet Three"].map((publisher, index) =>
      item({ sourceKey: "news", sourceName: "News search", evidence: "news", documentId: `n${index}`, url: `https://news${index}.example/a`, publisher, title: `Example AB beats expectations in third quarter (${publisher})`, publishedAt: "2026-10-22T07:00:00.000Z" }),
    );
    const { added, events } = merge(report.events, news);
    assert.equal(added.length, 0);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].sources.map((source) => source.role), ["original", "coverage", "coverage", "coverage"]);
  });

  it("counts a syndicated headline once, never as several confirmations", () => {
    const syndicated = ["Outlet One", "Outlet Two", "Outlet Three"].map((publisher, index) =>
      item({ sourceKey: "news", sourceName: "News search", evidence: "news", documentId: `s${index}`, url: `https://outlet${index}.example/story`, publisher, title: "Example AB said to explore sale of unit" }),
    );
    const { events } = merge([], syndicated);
    assert.equal(events.length, 1);
    assert.equal(independentSourceCount(events[0]), 1);
  });

  it("marks everything from a first check as baseline history", () => {
    const { added } = merge([], [item({ documentId: "4001", title: "Example AB: Interim report April–June 2026" })], { baseline: true });
    assert.equal(added[0].baseline, true);
  });
});

describe("report date notices", () => {
  it("reads the publication day a notice names, never a day that opens or closes the period", () => {
    const publishedAt = "2026-10-01T06:00:00Z";
    for (const [title, date] of [
      ["Example AB publishes its interim report on 23 October 2026", "2026-10-23"],
      ["Example AB publishes its interim report on 23 October", "2026-10-23"],
      ["Example AB will publish its interim report on October 23, 2026", "2026-10-23"],
      ["Delårsrapport 1 januari – 30 september 2026 publiceras den 23 oktober", "2026-10-23"],
      ["Example Oyj:n osavuosikatsaus julkaistaan 23.10.2026", "2026-10-23"],
      ["Example AB changes the date of its year-end report to 2027-02-11", "2027-02-11"],
      ["Example AB will publish its year-end report on 5 February", "2027-02-05"],
      ["Example julkaisee osavuosikatsauksen 28. lokakuuta 2026", "2026-10-28"],
      ["Example julkistaa tilinpäätöstiedotteen 4. helmikuuta", "2027-02-04"],
      ["Example julkistaa puolivuosikatsauksen 22. marraskuuta 2026", "2026-11-22"],
    ]) {
      assert.equal(noticeDate(title, { publishedAt }), date, title);
    }
    assert.equal(noticeDate("Invitation to the presentation of the interim report", { publishedAt }), null);
    assert.equal(noticeDate("Example AB publishes on 31 February", { publishedAt }), null, "no impossible dates");
  });

  it("reads which report a notice is about, without calling it published", () => {
    assert.equal(detectReport("Example AB publishes its interim report January–September 2026 on 23 October"), null);
    assert.deepEqual(detectReport("Example AB publishes its interim report January–September 2026 on 23 October", { notice: true }).period, "Q3");
  });
});

describe("news found before the report it covers", () => {
  it("files earlier news about a report as that report's coverage once the report arrives", () => {
    const news = merge([], [item({ sourceKey: "news", sourceName: "News search", evidence: "news", documentId: "n1", url: "https://news.example/q3", publisher: "Outlet", title: "Example AB's third-quarter profit beats expectations", publishedAt: "2026-10-22T06:00:00.000Z" })]);
    assert.equal(news.events.length, 1);
    const report = merge(news.events, [item({ documentId: "r1", title: "Example AB: Interim report January–September 2026", publishedAt: "2026-10-22T05:30:00.000Z" })]);
    assert.equal(report.events.length, 1, "the news is no longer a separate development");
    assert.equal(report.added.length, 1);
    assert.deepEqual(report.events[0].sources.map((source) => source.role), ["original", "coverage"]);
    // The same article seen again is still the report's coverage, never a new event.
    const again = merge(report.events, [item({ sourceKey: "news", sourceName: "News search", evidence: "news", documentId: "n1", url: "https://news.example/q3", publisher: "Outlet", title: "Example AB's third-quarter profit beats expectations", publishedAt: "2026-10-22T06:00:00.000Z" })]);
    assert.equal(again.added.length, 0);
    assert.equal(again.events.length, 1);
  });

  it("leaves unrelated news alone", () => {
    const news = merge([], [item({ sourceKey: "news", sourceName: "News search", evidence: "news", documentId: "n2", url: "https://news.example/ceo", title: "Example AB's CEO speaks at a conference", publishedAt: "2026-10-22T06:00:00.000Z" })]);
    const report = merge(news.events, [item({ documentId: "r1", title: "Example AB: Interim report January–September 2026", publishedAt: "2026-10-22T05:30:00.000Z" })]);
    assert.equal(report.events.length, 2);
  });
});

describe("notices found live", () => {
  it("reads weekday and clock-time phrasing as a date notice, in English, Swedish and Finnish", () => {
    for (const [title, date] of [
      ["KONE publishes January-September 2026 Interim Report on Wednesday, October 28, 2026 at 08:30 a.m. EET", "2026-10-28"],
      ["Example publicerar delårsrapport torsdagen den 22 januari kl. 08.15", "2027-01-22"],
      ["Example julkistaa osavuosikatsauksen keskiviikkona 28.10.2026 klo 9.30", "2026-10-28"],
    ]) {
      assert.equal(classifyDisclosure(title).type, "report_notice", title);
      assert.equal(noticeDate(title, { publishedAt: "2026-10-14T07:00:00Z" }), date, title);
    }
    assert.equal(classifyDisclosure("Invitation to Example’s Q3 2026 webcast").type, "report_notice");
    assert.equal(classifyDisclosure("Example julkaisee osavuosikatsauksen 28. lokakuuta 2026").type, "report_notice");
    assert.equal(classifyDisclosure("Example Oyj:n osavuosikatsaus tammi–syyskuu 2026").type, "report", "a period range is still the report itself");
  });

  it("files a news site's copy of an official release under that release, whatever time the news feed gives it", () => {
    const report = merge([], [item({ sourceKey: "gnw", sourceName: "GNW", documentId: "r1", title: "Example Oyj Interim Report for Q3 2026", publishedAt: "2026-10-22T05:00:00.000Z" })]);
    const copy = merge(report.events, [item({ sourceKey: "news", sourceName: "News search", evidence: "news", documentId: "n1", url: "https://example.com/newsroom/q3", title: "Example Oyj Interim Report for Q3 2026", publishedAt: "2026-10-22T01:00:00.000Z" })]);
    assert.equal(copy.added.length, 0);
    assert.equal(copy.events.length, 1);
    assert.equal(copy.events[0].sources[1].role, "coverage");
  });
});
