import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isinCheckDigit } from "../scripts/lib/stock-identity.mjs";
import { normalizeItem } from "../scripts/lib/stock-events.mjs";
import { parseIcs } from "../scripts/lib/stock-feeds.mjs";
import {
  FIRDS_SELECT,
  bingNewsUrl,
  calendarFromEvents,
  cisionNewsrooms,
  firdsUrl,
  headlineName,
  mfnCalendarReport,
  parseBingNews,
  parseFirds,
  parseInderesTopic,
  parseMfnCompanyPage,
  parseNasdaqNotices,
  resolveSecurity,
  cisionFeedUrl,
  eurolandCalendarUrl,
  createStockSources,
  edgarAcceptedAt,
  edgarUserAgent,
  mfnCompany,
  mfnReport,
  parseCisionFeed,
  parseEdgarSubmissions,
  parseGlobeNewswire,
  parseMfnFeed,
  parseSecTickers,
  sourceCoverage,
} from "../scripts/lib/stock-sources.mjs";
import { DEFAULT_MONITORING } from "../scripts/lib/stock-watchlist.mjs";

const isin = (first11) => `${first11}${isinCheckDigit(first11)}`;
const ENTITY = "1efd4898-350b-439d-b495-9b8fbddcbb24";
const OTHER_ENTITY = "2efd4898-350b-439d-b495-9b8fbddcbb25";

/** An MFN feed item in the shape the live feed returns. */
function mfnItem({ id, group = `g-${id}`, title, date, lang = "en", tags = [], author = ENTITY }) {
  return {
    news_id: id,
    group_id: group,
    url: `https://feed.mfn.se/v1/feed/${ENTITY}/item/${id}.html`,
    author: { entity_id: author, name: "Example", isins: [isin("SE000000002")], tickers: ["XSTO:EXAM B"] },
    subjects: [{ entity_id: author }],
    properties: { lang, type: tags.length > 0 ? "ir" : "pr", tags },
    content: { title, publish_date: date, html: "<p>Body that must never be stored</p>" },
  };
}

describe("MFN", () => {
  it("reads report tags, inside information and regulatory status, and never the body", () => {
    const feed = JSON.stringify({
      items: [
        mfnItem({ id: "a1", title: "25 percent organic growth in the first quarter", date: "2026-04-24T06:30:00Z", tags: [":regulatory", ":regulatory:mar", "sub:report", "sub:report:interim", "sub:report:interim:q1"] }),
        mfnItem({ id: "a2", group: "g-a1", title: "25 procent organisk tillväxt i första kvartalet", date: "2026-04-24T06:30:00Z", lang: "sv", tags: [":regulatory", ":regulatory:mar", "sub:report", "sub:report:interim", "sub:report:interim:q1"] }),
        mfnItem({ id: "a3", title: "New professorship funded", date: "2026-10-13T12:15:00Z" }),
        mfnItem({ id: "a4", title: "Someone else's release", date: "2026-10-13T12:15:00Z", author: OTHER_ENTITY }),
      ],
    });
    const items = parseMfnFeed(feed, { entityId: ENTITY });
    assert.deepEqual(items.map((item) => item.documentId), ["a1", "a2", "a3"], "another company's item is left out");
    assert.deepEqual(items[0].report, { kind: "interim", period: "Q1", fiscalYear: 2026 });
    assert.equal(items[0].evidence, "official_disclosure");
    assert.equal(items[0].insideInformation, true);
    assert.equal(items[2].evidence, "company_release");
    assert.ok(!JSON.stringify(items).includes("Body that must never be stored"));
    // Its title never says "interim report"; the tag makes it one, and the language versions share a group.
    const candidate = normalizeItem({ ...items[0], sourceKey: "mfn", sourceName: "MFN" }, { watchId: "sw-0000aaaa", security: { companyName: "Example", ticker: "EXAM B" }, now: new Date() });
    assert.equal(candidate.type, "report");
    assert.ok(candidate.keys.includes("group:mfn:g-a1"));
  });

  it("dates a Q4 or annual report to the year before its spring publication", () => {
    assert.deepEqual(mfnReport(["sub:report:annual"], { title: "Annual and Sustainability Report", publishedAt: "2026-03-20T13:17:00Z" }), { kind: "annual", period: "FY", fiscalYear: 2025 });
    assert.deepEqual(mfnReport(["sub:report:interim:q4"], { title: "Year-end report", publishedAt: "2026-02-05T07:00:00Z" }), { kind: "interim", period: "Q4", fiscalYear: 2025 });
    assert.equal(mfnReport(["sub:report:interim:q4"], { title: "Bokslutskommuniké 2025", publishedAt: "2026-02-05T07:00:00Z" }).fiscalYear, 2025);
    assert.equal(mfnReport(["sub:ci:staff"], {}), null);
  });

  it("names the company behind an MFN id, so an id can be checked against the listing", () => {
    const company = mfnCompany(JSON.stringify({ items: [mfnItem({ id: "a1", title: "x", date: "2026-01-01T00:00:00Z" })] }));
    assert.equal(company.entityId, ENTITY);
    assert.deepEqual(company.isins, [isin("SE000000002")]);
    assert.deepEqual(company.tickers, ["XSTO:EXAM B"]);
    assert.equal(parseMfnFeed("<html>", { entityId: ENTITY }), null);
  });
});

describe("GlobeNewswire", () => {
  const feed = (items) => `<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>${items.join("")}</channel></rss>`;
  const item = ({ id, lang, title, isinValue, subjects }) => `<item><guid>https://www.globenewswire.com/news-release/${id}/${lang}</guid><link>https://www.globenewswire.com/news-release/${id}/${lang}</link>
    <category domain="https://www.globenewswire.com/rss/stock">Helsinki:EXAM</category><category domain="https://www.globenewswire.com/rss/ISIN">${isinValue}</category>
    <title>${title}</title><pubDate>Thu, 22 Oct 2026 05:00 GMT</pubDate><dc:identifier>${id}</dc:identifier><dc:language>${lang}</dc:language>
    ${subjects.map((subject) => `<dc:subject>${subject}</dc:subject>`).join("")}</item>`;
  const ours = isin("FI000000004");

  it("keeps only the followed company's releases, with regulatory status and one group per release", () => {
    const text = feed([
      item({ id: "3386019", lang: "en", title: "Example Oyj Interim Report for Q3 2026", isinValue: ours, subjects: ["Earnings Releases and Operating Results", "European Regulatory News"] }),
      item({ id: "3386019", lang: "fi", title: "Example Oyj:n vuoden 2026 kolmannen neljänneksen osavuosikatsaus", isinValue: ours, subjects: ["Earnings Releases and Operating Results", "European Regulatory News"] }),
      item({ id: "3385613", lang: "fi", title: "Another company", isinValue: isin("FI000000005"), subjects: [] }),
    ]);
    const items = parseGlobeNewswire(text, { isin: ours });
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((entry) => entry.groupId), ["3386019", "3386019"]);
    assert.ok(items.every((entry) => entry.evidence === "official_disclosure"));
    assert.notEqual(items[0].documentId, items[1].documentId, "each language version is its own document");
  });
});

describe("Cision", () => {
  it("builds the per-company feed address and reads its items", () => {
    assert.equal(cisionFeedUrl("example-ab", { regulatory: true }), "https://news.cision.com/example-ab/ListItems?r=regulatory&format=rss");
    const items = parseCisionFeed(`<rss><channel><item><title>Interim Management Statement January-September 2026</title><link>https://news.cision.com/example-ab/r/interim,c4409692</link><guid isPermaLink="false">cision5443106</guid><pubDate>Fri, 16 Oct 2026 06:15:45 GMT</pubDate></item></channel></rss>`, { regulatory: true });
    assert.deepEqual(items[0], { documentId: "cision5443106", url: "https://news.cision.com/example-ab/r/interim,c4409692", title: "Interim Management Statement January-September 2026", publishedAt: "2026-10-16T06:15:45.000Z", language: null, evidence: "official_disclosure" });
  });
});

describe("SEC EDGAR", () => {
  const submissions = (cik, recent) => JSON.stringify({ cik, filings: { recent } });

  it("reads 10-Q, 10-K and 8-K filings with their period and items, and leaves amendments without a report key", () => {
    const text = submissions("789019", {
      accessionNumber: ["0000950170-26-000001", "0001193125-26-000002", "0000950170-26-000003", "0000950170-26-000004", "0000950170-26-000005"],
      filingDate: ["2026-10-28", "2026-10-28", "2026-08-01", "2026-07-30", "2026-07-15"],
      reportDate: ["2026-09-30", "2026-10-28", "2026-06-30", "2026-06-30", ""],
      acceptanceDateTime: ["2026-10-28T16:05:12.000Z", "2026-10-28T16:01:00.000Z", "2026-08-01T20:00:00.000Z", "2026-07-30T20:00:00.000Z", "2026-07-15T12:00:00.000Z"],
      form: ["10-Q", "8-K", "10-K", "10-Q/A", "S-8"],
      items: ["", "2.02,9.01", "", "", ""],
      primaryDocument: ["msft-10q.htm", "earnings.htm", "msft-10k.htm", "msft-10qa.htm", "s8.htm"],
    });
    const items = parseEdgarSubmissions(text, { cik: "0000789019" });
    assert.deepEqual(items.map((item) => item.edgar.form), ["10-Q", "8-K", "10-K", "10-Q/A"], "other forms are left out");
    assert.equal(items[0].url, "https://www.sec.gov/Archives/edgar/data/789019/000095017026000001/msft-10q.htm");
    assert.deepEqual(items[0].report, { kind: "quarterly_filing", period: "Q3", fiscalYear: 2026 });
    assert.match(items[1].title, /8-K: results of operations/);
    assert.equal(items[1].report.kind, "earnings_release");
    assert.equal(items[3].report, null, "an amendment is its own version, not the report again");
    assert.equal(items[0].publishedAt, "2026-10-28T12:05:12.000Z", "EDGAR's acceptance clock is New York time plus its offset");
    assert.equal(parseEdgarSubmissions(submissions("1234", { accessionNumber: [] }), { cik: "0000789019" }), null, "another company's document is refused");
  });

  it("is read only with a declared User-Agent that has a contact address", () => {
    assert.equal(edgarUserAgent({}), null);
    assert.equal(edgarUserAgent({ SEC_EDGAR_USER_AGENT: "Hilla" }), null);
    assert.equal(edgarUserAgent({ SEC_EDGAR_USER_AGENT: "Hilla personal research someone@example.com" }), "Hilla personal research someone@example.com");
    const [edgar] = createStockSources({ env: {} }).filter((source) => source.key === "sec-edgar");
    const microsoft = { exchange: "XNAS", country: "US", isin: "US5949181045", identifiers: { secCik: "0000789019" } };
    assert.equal(edgar.coverage(microsoft).status, "not_configured");
    const [configured] = createStockSources({ env: { SEC_EDGAR_USER_AGENT: "Hilla personal research someone@example.com" } }).filter((source) => source.key === "sec-edgar");
    assert.equal(configured.coverage(microsoft).status, "available");
    assert.equal(configured.coverage({ ...microsoft, exchange: "XSTO" }).status, "not_applicable", "another market is not a gap in coverage");
  });

  it("turns SEC's ticker list into listings with exchange and CIK, skipping OTC and unknown venues", () => {
    const listings = parseSecTickers(JSON.stringify({ fields: ["cik", "name", "ticker", "exchange"], data: [[789019, "MICROSOFT CORP", "MSFT", "Nasdaq"], [1067983, "BERKSHIRE HATHAWAY INC", "BRK-B", "NYSE"], [1, "Some OTC Co", "SOTC", "OTC"]] }));
    assert.deepEqual(listings.map((listing) => [listing.ticker, listing.exchange, listing.identifiers.secCik]), [["MSFT", "XNAS", "0000789019"], ["BRK-B", "XNYS", "0001067983"]]);
  });
});

describe("source coverage", () => {
  it("says which sources can follow a listing, and why the others can't", () => {
    const sources = createStockSources({ env: {} });
    const finnish = { companyName: "Example Oyj", ticker: "EXAM", exchange: "XHEL", country: "FI", isin: isin("FI000000004"), identifiers: {} };
    const coverage = sourceCoverage(finnish, DEFAULT_MONITORING, sources);
    assert.deepEqual(coverage.map((entry) => [entry.key, entry.status]), [
      ["nasdaq-notices", "available"],
      ["mfn", "unsupported"],
      ["cision", "unsupported"],
      ["globenewswire", "available"],
      ["sec-edgar", "not_applicable"],
      ["euroland-calendar", "unsupported"],
      ["mfn-calendar", "unsupported"],
      ["bing-news", "available"],
    ]);
    assert.ok(!createStockSources({ env: {} }).some((source) => source.key === "nasdaq-company-news"), "an owner-decision source is off unless turned on");
    assert.ok(createStockSources({ env: {}, enabled: { "nasdaq-company-news": true } }).some((source) => source.key === "nasdaq-company-news"));
    assert.ok(coverage.every((entry) => entry.status === "available" || entry.note));
    assert.deepEqual(sourceCoverage(finnish, { ...DEFAULT_MONITORING, reports: false, companyNews: false, generalNews: false }, sources), []);
  });
});

describe("financial calendars", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "DTSTART:20261028T000000",
    "SUMMARY:EXAMPLE : Interim Report for January-September 2026",
    "DESCRIPTION: For more information go to https://example.com/",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART:20261103T000000",
    "SUMMARY:EXAMPLE : London: Roadshow\\, CFO and IR",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;TZID=FLE Standard Time:20270205T090000",
    "SUMMARY:Example : Financial Statements Bulletin 2026",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART:20270428T000000",
    "SUMMARY:Example : Interim Report January-",
    " March",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("reads iCalendar events without descriptions, joining folded lines", () => {
    const events = parseIcs(ics);
    assert.equal(events.length, 4);
    assert.deepEqual(events[0].start, { date: "2026-10-28", time: null, utc: false, tzid: null });
    assert.deepEqual(events[2].start, { date: "2027-02-05", time: "09:00", utc: false, tzid: "FLE Standard Time" });
    assert.equal(events[3].summary, "Example : Interim Report January-March");
    assert.ok(!JSON.stringify(events).includes("more information"));
    assert.equal(parseIcs("<html>"), null);
  });

  it("keeps only report dates, confirmed, with the fiscal year a year-end report belongs to", () => {
    const entries = calendarFromEvents(parseIcs(ics));
    assert.deepEqual(entries.map((entry) => [entry.kind, entry.fiscalYear, entry.period, entry.date, entry.status]), [
      ["interim", 2026, "Q3", "2026-10-28", "confirmed"],
      ["year_end", 2026, "FY", "2027-02-05", "confirmed"],
      ["interim", 2027, "Q1", "2027-04-28", "confirmed"],
    ]);
  });

  it("builds the calendar address from the company's code only", () => {
    assert.equal(eurolandCalendarUrl("sf-kon"), "https://tools.eurolandir.com/tools/fincalendar2/Download/ExportUpcommingToCalendar?companyCode=sf-kon&lang=en-GB");
  });
});

describe("EDGAR acceptance times", () => {
  it("turns EDGAR's shifted acceptance clock into real UTC, in summer and winter time", () => {
    // Microsoft's earnings 8-K, accepted at 16:04 New York time on 29 July 2026.
    assert.equal(edgarAcceptedAt("2026-07-30T00:04:53.000Z"), "2026-07-29T20:04:53.000Z");
    // A January filing at 16:03 New York time, when the offset is five hours.
    assert.equal(edgarAcceptedAt("2026-01-28T02:03:00.000Z"), "2026-01-27T21:03:00.000Z");
    assert.equal(edgarAcceptedAt("not a date"), null);
  });
});

describe("Nasdaq exchange notices", () => {
  const feed = `<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
    <item><title>Trading halt in Example AB</title><link>https://view.news.eu.nasdaq.com/view?id=b111&amp;lang=en&amp;src=rss</link>
      <category domain="https:/news.eu.nasdaq.com/rss/company">Example AB</category><category domain="https:/news.eu.nasdaq.com/rss/category">Trading halt</category>
      <pubDate>Thu, 22 Oct 2026 07:13:44 GMT</pubDate></item>
    <item><title>Derivatives - New Strikes Stock Products 206/26</title><link>https://view.news.eu.nasdaq.com/view?id=b222&amp;lang=en&amp;src=rss</link>
      <category domain="https:/news.eu.nasdaq.com/rss/company">Derivatives</category><pubDate>Wed, 21 Oct 2026 15:38:31 GMT</pubDate></item>
  </channel></rss>`;
  const security = { companyName: "Example AB", ticker: "EXAM B", exchange: "XSTO", country: "SE", isin: isin("SE000000002"), identifiers: {} };

  it("keeps only notices about the followed company, as official", () => {
    const items = parseNasdaqNotices(feed, { security });
    assert.deepEqual(items.map((item) => [item.documentId, item.title, item.evidence, item.category]), [["b111", "Trading halt in Example AB", "official_disclosure", "Trading halt"]]);
    const event = normalizeItem({ ...items[0], sourceKey: "nasdaq-notices", sourceName: "Nasdaq" }, { watchId: "sw-0000aaaa", security, now: new Date() });
    assert.equal(event.type, "trading_suspension");
    assert.equal(event.prefilter, "critical");
  });
});

describe("MFN company pages", () => {
  const page = `<html><head><title>MFN.se &gt; Example</title></head><body><script>var entityId = "${ENTITY}";</script>
    <table class="table-calender"><thead><tr><td></td><td title='Tid för föregående rapport'> Est. tid*</td><td></td></tr></thead><tbody>
    <tr class=""><td align="center">2027-01-22</td><td align="center"> 08:15 </td><td align="center"> Bokslutskommuniké 2026 </td></tr>
    <tr class=""><td align="center">2026-11-06</td><td align="center"> N/A </td><td align="center"> X-dag halvårsutdelning EXAM A 1.6 </td></tr>
    <tr class=""><td align="center">2026-10-28</td><td align="center"> 07:30 </td><td align="center"> Kvartalsrapport 2026-Q3 </td></tr>
    <tr class="grey-background"><td align="center">2026-07-22</td><td align="center"> - </td><td align="center"> Kvartalsrapport 2026-Q2 </td></tr>
    </tbody></table></body></html>`;

  it("reads the company name, its MFN id and the calendar table", () => {
    const parsed = parseMfnCompanyPage(page);
    assert.equal(parsed.name, "Example");
    assert.equal(parsed.entityId, ENTITY);
    assert.deepEqual(parsed.calendar.map((row) => [row.date, row.time, row.label]), [
      ["2027-01-22", "08:15", "Bokslutskommuniké 2026"],
      ["2026-11-06", null, "X-dag halvårsutdelning EXAM A 1.6"],
      ["2026-10-28", "07:30", "Kvartalsrapport 2026-Q3"],
      ["2026-07-22", null, "Kvartalsrapport 2026-Q2"],
    ]);
    assert.equal(parseMfnCompanyPage("<html>other site</html>"), null);
  });

  it("turns calendar labels into reports, ignoring dividends and meetings", () => {
    assert.deepEqual(mfnCalendarReport("Kvartalsrapport 2026-Q3"), { kind: "interim", fiscalYear: 2026, period: "Q3" });
    assert.deepEqual(mfnCalendarReport("Bokslutskommuniké 2026"), { kind: "year_end", fiscalYear: 2026, period: "FY" });
    assert.equal(mfnCalendarReport("X-dag halvårsutdelning EXAM A 1.6"), null);
    assert.equal(mfnCalendarReport("Extra Bolagsstämma 2026"), null);
  });

  it("gives future report dates as estimated, never confirmed", async () => {
    const [source] = createStockSources({ env: {} }).filter((candidate) => candidate.key === "mfn-calendar");
    const fetcher = { get: async () => ({ status: "ok", body: page }) };
    const security = { companyName: "Example AB", exchange: "XSTO", country: "SE", identifiers: { mfnSlug: "example" } };
    const result = await source.check(security, { fetcher, now: new Date("2026-10-22T08:00:00Z") });
    assert.deepEqual(result.calendar.map((entry) => [entry.kind, entry.period, entry.date, entry.time, entry.status]), [
      ["year_end", "FY", "2027-01-22", "08:15", "estimated"],
      ["interim", "Q3", "2026-10-28", "07:30", "estimated"],
    ]);
    const other = await source.check({ ...security, companyName: "Another AB" }, { fetcher, now: new Date("2026-10-22T08:00:00Z") });
    assert.equal(other.status, "blocked", "a page about another company is refused");
  });
});

describe("news via Bing", () => {
  const security = { companyName: "KONE Corporation", exchange: "XHEL", country: "FI", identifiers: {} };
  const feed = `<rss xmlns:News="https://www.bing.com/news/search?q=x"><channel>
    <item><title>KONE wins elevator order in Riyadh</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fwww.reuters.com%2fbusiness%2fkone-order&amp;c=1</link><pubDate>Thu, 22 Oct 2026 06:00:00 GMT</pubDate><News:Source>Reuters</News:Source></item>
    <item><title>Sokerijuurikas on hyväsatoinen maanparantaja</title><link>http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fexample.fi%2fa</link><pubDate>Thu, 22 Oct 2026 05:00:00 GMT</pubDate><News:Source>Paikallislehti</News:Source></item>
    <item><title>Kone Oyj expected to post quarterly earnings</title><link>http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fcontentfarm.example%2fx</link><pubDate>Wed, 21 Oct 2026 05:00:00 GMT</pubDate><News:Source>Content Farm Daily</News:Source></item>
  </channel></rss>`;

  it("keeps only headlines that name the company, with the publisher's own link and type", () => {
    assert.equal(headlineName(security), "KONE");
    assert.equal(headlineName({ companyName: "Investor AB", identifiers: {} }), "Investor");
    assert.equal(headlineName({ companyName: "KONE Corporation", identifiers: { newsName: "KONE Oyj" } }), "KONE Oyj");
    const items = parseBingNews(feed, { security });
    assert.deepEqual(items.map((item) => [item.title, item.url, item.publisher, item.category]), [
      ["KONE wins elevator order in Riyadh", "https://www.reuters.com/business/kone-order", "Reuters", "established publisher"],
      ["Kone Oyj expected to post quarterly earnings", "https://contentfarm.example/x", "Content Farm Daily", "other source"],
    ]);
    assert.ok(items.every((item) => item.evidence === "news"));
    assert.match(bingNewsUrl(security), /q=%22KONE\+Corporation%22.*mkt=fi-FI/, "the search asks for the full listed name");
    assert.match(bingNewsUrl({ ...security, identifiers: { newsName: "KONE Oyj" } }), /q=%22KONE\+Oyj%22/);
  });
});

describe("the Inderes forum", () => {
  it("records only how many new posts a thread has, never who wrote what", async () => {
    const [source] = createStockSources({ env: {} }).filter((candidate) => candidate.key === "inderes-forum");
    let posts = 599;
    const fetcher = { get: async () => ({ status: "ok", body: JSON.stringify({ id: 3248, slug: "kone-thread", title: "Kone - thread", posts_count: posts, last_posted_at: "2026-10-12T10:05:54.600Z", post_stream: { posts: [{ username: "someone", cooked: "<p>Buy now!</p>" }] } }) }) };
    const security = { companyName: "KONE Corporation", identifiers: { inderesTopic: 3248 } };
    const first = await source.check(security, { fetcher, notes: null });
    assert.deepEqual(first.items, [], "the first check only learns where the thread is");
    assert.deepEqual(first.cursor, { postsCount: 599 });
    posts = 604;
    const second = await source.check(security, { fetcher, notes: { cursor: first.cursor } });
    assert.equal(second.items.length, 1);
    assert.match(second.items[0].title, /^5 new posts in the Inderes forum thread “Kone - thread”$/);
    assert.equal(second.items[0].url, "https://forum.inderes.com/t/kone-thread/3248");
    assert.ok(!JSON.stringify(second).includes("someone") && !JSON.stringify(second).includes("Buy now"));
    assert.equal(parseInderesTopic(JSON.stringify({ id: 1, slug: "x", posts_count: 1 }), { topicId: 3248 }), null, "another thread is refused");
  });
});

describe("ESMA's FIRDS register", () => {
  const answer = (docs) => JSON.stringify({ response: { docs } });
  const record = (overrides) => ({ isin: isin("SE000000002"), mic: "XSTO", gnr_full_name: "Example AB ser. B", gnr_short_name: "EXAMPLE/SH B", gnr_cfi_code: "ESRUFR", gnr_notional_curr_code: "SEK", lei: "549300VEBQPHRZBKUX38", status: "UNCH", ...overrides });

  it("builds queries from plain words only", () => {
    assert.match(firdsUrl(isin("SE000000002")), new RegExp(`q=isin%3A${isin("SE000000002")}`));
    const byName = new URL(firdsUrl("Example B"));
    assert.equal(byName.searchParams.get("q").startsWith("gnr_full_name:Example*"), true);
    assert.equal(new URL(firdsUrl('Example") OR *:*')).searchParams.get("q").startsWith("gnr_full_name:Example*"), true, "query syntax never gets through");
    assert.equal(firdsUrl("***"), null);
  });

  it("keeps one listing per share and Nordic venue, with its class, and sets ended listings apart", () => {
    const parsed = parseFirds(
      answer([
        record({}),
        record({ mic: "MSTO" }),
        record({ mic: "OCXE" }),
        record({ isin: isin("SE000000001"), gnr_full_name: "Example AB ser. A", gnr_short_name: "EXAMPLE/SH A", gnr_cfi_code: "ESVUFR" }),
        record({ isin: isin("SE000000009"), gnr_full_name: "Example AB TO 1", gnr_cfi_code: "RWSNCA" }),
        record({ isin: isin("SE000000017"), gnr_full_name: "Gone AB", status: "TERM", mrkt_trdng_trmination_date: "2025-07-24T23:59:59Z" }),
      ]),
      { now: new Date("2026-10-22T00:00:00Z") },
    );
    assert.deepEqual(parsed.listings.map((listing) => [listing.companyName, listing.shareClass, listing.exchange, listing.currency, listing.ticker]), [
      ["Example AB", "B", "XSTO", "SEK", null],
      ["Example AB", "A", "XSTO", "SEK", null],
    ]);
    assert.deepEqual(parsed.ended.map((listing) => [listing.companyName, listing.endedOn]), [["Gone AB", "2025-07-24"]]);
  });

  it("resolves the named share class, asks without one, and says when a listing has ended", async () => {
    const docs = [record({}), record({ isin: isin("SE000000001"), gnr_full_name: "Example AB ser. A", gnr_cfi_code: "ESVUFR" }), record({ isin: isin("SE000000017"), gnr_full_name: "Gone AB", status: "TERM", mrkt_trdng_trmination_date: "2025-07-24T23:59:59Z" })];
    const fetcher = {
      calls: [],
      async get(url) {
        this.calls.push(url);
        if (url.startsWith(FIRDS_SELECT)) return { status: "ok", body: answer(docs) };
        return { status: "not_found", reason: "not found" };
      },
    };
    const both = await resolveSecurity("Example", { fetcher, now: new Date("2026-10-22T00:00:00Z") });
    assert.equal(both.status, "ambiguous");
    const classB = await resolveSecurity("Example B", { fetcher, now: new Date("2026-10-22T00:00:00Z") });
    assert.equal(classB.status, "resolved");
    assert.equal(classB.candidates[0].verification.source, "esma-firds");
    assert.equal(classB.candidates[0].shareClass, "B");
    const gone = await resolveSecurity("Gone", { fetcher, now: new Date("2026-10-22T00:00:00Z") });
    assert.equal(gone.status, "none");
    assert.deepEqual(gone.ended.map((listing) => listing.endedOn), ["2025-07-24"]);
    assert.ok(fetcher.calls.every((url) => !url.includes("api.nasdaq.com")));
  });
});

describe("Cision newsroom discovery", () => {
  it("picks the newsroom whose releases name the company, not every search hit", () => {
    const search = `<rss><channel>
      <item><title>KONE publishes its interim report on Wednesday, October 28, 2026</title><link>https://news.cision.com/kone-oyj/r/a,c1</link></item>
      <item><title>KONE launches a new elevator</title><link>https://news.cision.com/kone-oyj/r/b,c2</link></item>
      <item><title>Analysts pick stocks for the end of the year</title><link>https://news.cision.com/op-pohjola/r/c,c3</link></item>
    </channel></rss>`;
    assert.deepEqual(cisionNewsrooms(search, { security: { companyName: "KONE Corporation", identifiers: {} } }).map((entry) => [entry.slug, entry.naming]), [["kone-oyj", 2]]);
  });
});

describe("Cision partial reads", () => {
  it("keeps the regulatory releases but reports the source as partly checked when the full feed fails", async () => {
    const [source] = createStockSources({ env: {} }).filter((candidate) => candidate.key === "cision");
    const regulatory = `<rss><channel><item><title>Interim report January–September 2026</title><link>https://news.cision.com/example-ab/r/q3,c1</link><guid>cision1</guid><pubDate>Thu, 22 Oct 2026 06:00:00 GMT</pubDate></item></channel></rss>`;
    const fetcher = { get: async (url) => (url.includes("r=regulatory") ? { status: "ok", body: regulatory } : { status: "error", reason: "HTTP 500." }) };
    const result = await source.check({ companyName: "Example AB", identifiers: { cisionSlug: "example-ab" } }, { fetcher });
    assert.equal(result.status, "ok");
    assert.equal(result.items.length, 1);
    assert.match(result.partial, /the full feed could not be read \(HTTP 500\.\), so only regulatory releases were checked/);
  });
});
