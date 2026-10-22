import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GUIDANCE_TEXT,
  analysisAllowedHosts,
  checkAnalysisText,
  compareMetric,
  dateOnPage,
  formatNumber,
  metricLine,
  numberOnPage,
  pageNumbers,
  pageText,
  parsePeriod,
  periodMatchesReport,
  periodsComparable,
  refineLevel,
  validateAnalysis,
} from "../scripts/lib/stock-analysis.mjs";

const RELEASE = "https://mfn.se/a/example-ab/example-ab-interim-report-q3-2026";
const PDF = "https://storage.mfn.se/abc123/example-ab-q3-2026.pdf";
// A synthetic release page as a distributor serves it: Swedish number formats, prior year in parentheses.
const RELEASE_HTML = `<!doctype html><html><head><script>var tracking = 987654;</script></head><body>
<h1>Example AB: Interim report January&ndash;September 2026</h1>
<p>Third quarter 2026: Net sales increased by 8% to SEK 1&nbsp;234,5 m (1&nbsp;143,0). Operating profit SEK 148 m (183).
Operating margin 12,0% (16,0). Adjusted operating margin 12,4% (15,9). Earnings per share SEK 0,52 (&minus;0,10).
Free cash flow SEK &ndash;56 m (35). Net debt SEK 2&nbsp;100 m (1&nbsp;800) at 30 September 2026.
Number of shares 120&nbsp;000&nbsp;000 (100&nbsp;000&nbsp;000) after the directed issue.</p>
<p>January&ndash;September: net sales SEK 3&nbsp;512,0 m (3&nbsp;301,2).</p>
<p>Outlook: Example AB maintains its outlook of organic growth of 5&ndash;7% for 2026.</p>
<p>The subscription period runs from 28 October to 12 November 2026.</p>
</body></html>`;

const EVENT = Object.freeze({
  id: "ev-0123456789ab",
  type: "report",
  evidence: "official_disclosure",
  title: "Example AB: Interim report January–September 2026",
  report: { kind: "interim", period: "Q3", fiscalYear: 2026, correction: false },
  sources: [{ key: "mfn", name: "MFN", url: RELEASE, documents: [PDF], role: "original" }],
});
const RECORD = Object.freeze({ id: "sw-0000aaaa", revision: 3, thesis: null, ownership: "unknown", focusAreas: [], security: { companyName: "Example AB", ticker: "EXAM B", currency: "SEK" } });
const WITH_THESIS = Object.freeze({ ...RECORD, thesis: { statement: "Margins will improve as revenue scales.", metrics: ["Operating margin"], breakers: ["Material dilution"], setAt: "2026-10-01T08:00:00.000Z" } });
const HOSTS = analysisAllowedHosts(EVENT);
const text = pageText(RELEASE_HTML);
const PAGES = new Map([
  [RELEASE, { status: "ok", text, numbers: pageNumbers(text) }],
  [PDF, { status: "pdf" }],
]);

const metric = (overrides = {}) => ({
  id: "net_sales",
  name: "Net sales",
  unit: "currency",
  basis: "reported",
  currency: "SEK",
  scale: "millions",
  current: { period: "Q3 2026", value: 1234.5 },
  prior: { period: "Q3 2025", value: 1143.0 },
  source: { url: RELEASE, location: "summary" },
  ...overrides,
});
const submission = (overrides = {}) => ({
  request: "rq-1a2b3c4d",
  importance: { level: "important", reason: "The quarterly report, with a weaker margin" },
  sourcesRead: [{ url: RELEASE, read: true }, { url: PDF, read: true }],
  metrics: [metric()],
  keyPoints: ["Sales grew while the margin narrowed"],
  review: ["Read the explanation for the margin pressure"],
  ...overrides,
});
const validate = (input, { record = RECORD, pages = PAGES, event = EVENT } = {}) => validateAnalysis(input, { event, record, allowedHosts: HOSTS, pages });

describe("analysis: comparisons with earlier periods", () => {
  it("compares a quarter with the same quarter a year earlier, in percent, worked out by the helper", () => {
    const result = validate(submission());
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    const [sales] = result.analysis.metrics;
    assert.deepEqual(sales.comparison, { kind: "percent", change: 8, comparable: true, reason: null });
    assert.equal(metricLine(sales), "Net sales, Q3 2026: SEK 1 234.5m (Q3 2025: SEK 1 143m), +8.0%");
    assert.equal(sales.checked, "on_page");
  });

  it("accepts the year to date of the report's own period, and labels a quarter compared with the one before", () => {
    const ytd = validate(submission({ metrics: [metric({ id: "net_sales_ytd", current: { period: "January–September 2026", value: 3512.0 }, prior: { period: "January–September 2025", value: 3301.2 } })] }));
    assert.equal(ytd.ok, true, JSON.stringify(ytd.problems));
    assert.equal(ytd.analysis.metrics[0].comparison.comparable, true);
    const sequential = validate(submission({ metrics: [metric({ prior: { period: "Q2 2026", value: 1143.0 } })] }));
    assert.equal(sequential.ok, true);
    assert.equal(sequential.analysis.metrics[0].comparison.comparable, false);
    assert.match(metricLine(sequential.analysis.metrics[0]), /\(not the same period a year earlier\)$/);
  });

  it("refuses figures for another period than the report's", () => {
    const wrong = validate(submission({ metrics: [metric({ current: { period: "Q2 2026", value: 1234.5 } })] }));
    assert.equal(wrong.ok, false);
    assert.match(wrong.problems.join(" "), /current.period: must be the report's own period \(Q3 2026/);
    const unreadable = validate(submission({ metrics: [metric({ current: { period: "recently", value: 1234.5 } })] }));
    assert.match(unreadable.problems.join(" "), /current.period: must name the period/);
  });

  it("reads the period labels Nordic reports use", () => {
    const cases = {
      "Q3 2026": { type: "Q", n: 3, year: 2026 },
      "2026 Q3": { type: "Q", n: 3, year: 2026 },
      "July–September 2026": { type: "Q", n: 3, year: 2026 },
      "7–9/2026": { type: "Q", n: 3, year: 2026 },
      "1–9/2026": { type: "9M", n: 0, year: 2026 },
      "tammi–syyskuu 2026": { type: "9M", n: 0, year: 2026 },
      "januari–juni 2026": { type: "H", n: 1, year: 2026 },
      "FY 2025/26": { type: "FY", n: 0, year: 2026 },
      2025: { type: "FY", n: 0, year: 2025 },
      "30 Sep 2026": { type: "D", n: 0, year: 2026, month: 9, day: 30 },
      "30.9.2026": { type: "D", n: 0, year: 2026, month: 9, day: 30 },
    };
    for (const [label, expected] of Object.entries(cases)) assert.deepEqual(parsePeriod(label), expected, label);
    assert.equal(parsePeriod("last quarter"), null);
    assert.deepEqual(periodsComparable("30 Sep 2026", "30 Sep 2025"), { comparable: true, reason: null });
    assert.equal(periodsComparable("Q3 2026", "9M 2025").reason, "different kinds of period");
    assert.equal(periodMatchesReport("9M 2026", { period: "Q3", fiscalYear: 2026 }), true);
    assert.equal(periodMatchesReport("H1 2026", { period: "Q2", fiscalYear: 2026 }), true);
    assert.equal(periodMatchesReport("FY 2026", { period: "Q4", fiscalYear: 2026 }), true);
    assert.equal(periodMatchesReport("Q3 2025", { period: "Q3", fiscalYear: 2026 }), false);
  });
});

describe("analysis: units, signs and bases", () => {
  it("scales amounts as the source states them and refuses missing or misplaced units", () => {
    const missingScale = validate(submission({ metrics: [metric({ scale: undefined })] }));
    assert.match(missingScale.problems.join(" "), /scale: must be units, thousands, millions, billions/);
    const percentWithCurrency = validate(submission({ metrics: [metric({ id: "operating_margin", name: "Operating margin", unit: "percent", currency: "SEK", scale: undefined, current: { period: "Q3 2026", value: 12 }, prior: { period: "Q3 2025", value: 16 } })] }));
    assert.match(percentWithCurrency.problems.join(" "), /currency: only amounts have a currency/);
    const noCurrency = validate(submission({ metrics: [metric({ currency: undefined })] }));
    assert.match(noCurrency.problems.join(" "), /currency: must be/);
    // The page writes "SEK 1 234,5 m": the same figure in thousands is not on the page.
    const rescaled = validate(submission({ metrics: [metric({ scale: "thousands", current: { period: "Q3 2026", value: 1234500 }, prior: { period: "Q3 2025", value: 1143000 } })] }));
    assert.match(rescaled.problems.join(" "), /does not appear on the cited page; give it exactly as that page writes it/);
    assert.equal(metricLine({ ...metric(), currency: "EUR", scale: "billions", current: { period: "Q3 2026", value: 1.2 }, prior: null }), "Net sales, Q3 2026: EUR 1.2bn");
  });

  it("keeps negative figures negative, never a percent change across a change of sign, and refuses a dropped minus", () => {
    const result = validate(
      submission({
        metrics: [
          metric({ id: "free_cash_flow", name: "Free cash flow", current: { period: "Q3 2026", value: -56 }, prior: { period: "Q3 2025", value: 35 } }),
          metric({ id: "eps", name: "Earnings per share", unit: "per_share", scale: undefined, current: { period: "Q3 2026", value: 0.52 }, prior: { period: "Q3 2025", value: -0.1 } }),
        ],
      }),
    );
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    const [cash, eps] = result.analysis.metrics;
    assert.equal(cash.comparison.kind, "direction");
    assert.equal(metricLine(cash), "Free cash flow, Q3 2026: SEK −56m (Q3 2025: SEK 35m), down");
    assert.equal(metricLine(eps), "Earnings per share, Q3 2026: SEK 0.52 (Q3 2025: SEK −0.1), up");
    const dropped = validate(submission({ metrics: [metric({ id: "free_cash_flow", name: "Free cash flow", current: { period: "Q3 2026", value: 56 }, prior: { period: "Q3 2025", value: 35 } })] }));
    assert.match(dropped.problems.join(" "), /shows 56 only as negative; check the sign/);
  });

  it("gives margins in percentage points, never as a percent change", () => {
    const result = validate(submission({ metrics: [metric({ id: "operating_margin", name: "Operating margin", unit: "percent", currency: undefined, scale: undefined, current: { period: "Q3 2026", value: 12.0 }, prior: { period: "Q3 2025", value: 16.0 } })] }));
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    const line = metricLine(result.analysis.metrics[0]);
    assert.equal(line, "Operating margin, Q3 2026: 12% (Q3 2025: 16%), −4.0 percentage points");
    assert.doesNotMatch(line, /25(\.0)?%/, "a fall from 16 to 12 is 4 points, not 25 percent");
    assert.deepEqual(compareMetric({ unit: "percent", current: { period: "Q3 2026", value: 12.4 }, prior: { period: "Q3 2025", value: 15.9 } }).change, -3.5);
  });

  it("says when a figure is adjusted, and refuses a figure without its basis", () => {
    const result = validate(submission({ metrics: [metric({ id: "adjusted_margin", name: "Operating margin", unit: "percent", basis: "adjusted", currency: undefined, scale: undefined, current: { period: "Q3 2026", value: 12.4 }, prior: { period: "Q3 2025", value: 15.9 } })] }));
    assert.match(metricLine(result.analysis.metrics[0]), /^Operating margin \(adjusted\), Q3 2026: 12.4%/);
    assert.match(validate(submission({ metrics: [metric({ basis: undefined })] })).problems.join(" "), /basis: must be reported, adjusted, organic, other/);
  });
});

describe("analysis: guidance, balance sheet and dilution", () => {
  it("quotes guidance only with numbers its page states", () => {
    const kept = validate(submission({ guidance: { status: "maintained", text: "Organic growth of 5–7% for 2026", source: { url: RELEASE, location: "outlook" } } }));
    assert.equal(kept.ok, true, JSON.stringify(kept.problems));
    assert.equal(GUIDANCE_TEXT[kept.analysis.guidance.status], "maintained");
    const invented = validate(submission({ guidance: { status: "raised", text: "Organic growth of 9–11% for 2026", source: { url: RELEASE, location: "outlook" } } }));
    assert.match(invented.problems.join(" "), /guidance.text: 9, 11 not on the cited page/);
    assert.match(validate(submission({ guidance: { status: "better", source: { url: RELEASE, location: "outlook" } } })).problems.join(" "), /guidance.status/);
  });

  it("compares net debt at the same date a year earlier", () => {
    const result = validate(submission({ metrics: [metric({ id: "net_debt", name: "Net debt", current: { period: "30 Sep 2026", value: 2100 }, prior: { period: "30 Sep 2025", value: 1800 } })] }));
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(metricLine(result.analysis.metrics[0]), "Net debt, 30 Sep 2026: SEK 2 100m (30 Sep 2025: SEK 1 800m), +16.7%");
  });

  it("shows dilution as the change in the number of shares", () => {
    const result = validate(submission({ metrics: [metric({ id: "shares_outstanding", name: "Number of shares", unit: "count", currency: undefined, scale: "units", current: { period: "30 Sep 2026", value: 120000000 }, prior: { period: "30 Sep 2025", value: 100000000 } })] }));
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(metricLine(result.analysis.metrics[0]), "Number of shares, 30 Sep 2026: 120 000 000 (30 Sep 2025: 100 000 000), +20.0%");
  });
});

describe("analysis: missing, unreadable and contradictory evidence", () => {
  it("leaves out what the release doesn't give, and refuses an invented figure", () => {
    const none = validate(submission({ metrics: [] }));
    assert.equal(none.ok, true);
    assert.deepEqual(none.analysis.metrics, []);
    const invented = validate(submission({ metrics: [metric({ id: "ebitda", name: "EBITDA", current: { period: "Q3 2026", value: 311.7 }, prior: null })] }));
    assert.match(invented.problems.join(" "), /311.7 does not appear on the cited page/);
  });

  it("says when the report couldn't be read, and then has no figures", () => {
    const unread = [{ url: RELEASE, read: false }];
    const withFigures = validate(submission({ sourcesRead: unread }));
    assert.equal(withFigures.ok, false);
    assert.match(withFigures.problems.join(" "), /no source was read, so there can be no figures/);
    assert.match(validate(submission({ sourcesRead: unread, metrics: [] })).problems.join(" "), /limitations: say that the release or report could not be read/);
    const honest = validate(submission({ sourcesRead: unread, metrics: [], keyPoints: [], limitations: ["The release page could not be opened"] }));
    assert.equal(honest.ok, true);
  });

  it("keeps one figure per metric, checks a figure against the page it cites, and marks a PDF figure as not re-checked", () => {
    const twice = validate(submission({ metrics: [metric(), metric({ current: { period: "Q3 2026", value: 1240 } })] }));
    assert.match(twice.problems.join(" "), /used twice/);
    // A figure from the PDF cited as if the release page showed it: refused.
    const miscited = validate(submission({ metrics: [metric({ id: "order_intake", name: "Order intake", current: { period: "Q3 2026", value: 1402.3 }, prior: null })] }));
    assert.match(miscited.problems.join(" "), /1402.3 does not appear on the cited page/);
    const fromPdf = validate(submission({ metrics: [metric({ id: "order_intake", name: "Order intake", current: { period: "Q3 2026", value: 1402.3 }, prior: null, source: { url: PDF, location: "page 4, order intake" } })] }));
    assert.equal(fromPdf.ok, true);
    assert.equal(fromPdf.analysis.metrics[0].checked, "pdf_not_rechecked");
    assert.match(metricLine(fromPdf.analysis.metrics[0]), /\[from the report document, not re-checked\]$/);
  });

  it("refuses sources outside the official release, and figures from a page not read", () => {
    const outside = validate(submission({ metrics: [metric({ source: { url: "https://evil.example/numbers", location: "table" } })] }));
    assert.match(outside.problems.join(" "), /source.url: must be an https page or document of the official release/);
    const unlisted = validate(submission({ sourcesRead: [{ url: PDF, read: true }] }));
    assert.match(unlisted.problems.join(" "), /must be one of the sources you list as read/);
    assert.ok(HOSTS.includes("mfn.se") && HOSTS.includes("storage.mfn.se") && !HOSTS.includes("evil.example"));
  });
});

describe("analysis: thesis impact without overclaiming", () => {
  it("gives no thesis impact when the user stated no thesis", () => {
    const invented = validate(submission({ thesisImpact: { outcome: "supports", reason: "Growth continues", metricIds: ["net_sales"] } }));
    assert.match(invented.problems.join(" "), /the user has no thesis for this stock; leave it out/);
  });

  it("asks for the thesis impact when there is one, resting on named figures or guidance", () => {
    assert.match(validate(submission(), { record: WITH_THESIS }).problems.join(" "), /thesisImpact: the user has a thesis/);
    const unsupported = validate(submission({ thesisImpact: { outcome: "weakens", reason: "The margin fell", metricIds: [] } }), { record: WITH_THESIS });
    assert.match(unsupported.problems.join(" "), /needs the figures or guidance it rests on; otherwise say insufficient_evidence/);
    const unknownFigure = validate(submission({ thesisImpact: { outcome: "weakens", reason: "The margin fell", metricIds: ["operating_margin"] } }), { record: WITH_THESIS });
    assert.match(unknownFigure.problems.join(" "), /must name figures in metrics/);
    const margin = metric({ id: "operating_margin", name: "Operating margin", unit: "percent", currency: undefined, scale: undefined, current: { period: "Q3 2026", value: 12.0 }, prior: { period: "Q3 2025", value: 16.0 } });
    const weakens = validate(submission({ metrics: [metric(), margin], thesisImpact: { outcome: "weakens", reason: "The margin fell while sales grew, against the margin-improvement assumption for this quarter", metricIds: ["operating_margin"] } }), { record: WITH_THESIS });
    assert.equal(weakens.ok, true, JSON.stringify(weakens.problems));
    assert.equal(weakens.analysis.thesisImpact.outcome, "weakens");
    const cautious = validate(submission({ metrics: [], thesisImpact: { outcome: "insufficient_evidence", reason: "One quarter doesn't settle the margin question" } }), { record: WITH_THESIS });
    assert.equal(cautious.ok, true);
  });

  it("refuses advice, price forecasts, consensus claims and numbers in free text", () => {
    const cases = [
      ["You should consider selling before the next report", /trading advice or a price forecast/],
      ["The stock will rise after this report", /trading advice or a price forecast/],
      ["This is definitely a buying opportunity", /trading advice or a price forecast/],
      ["Results beat consensus", /market expectations or consensus/],
      ["Revenue rose 8% in the quarter", /has a number/],
      ["See https://example.com/more", /has a link/],
    ];
    for (const [point, problem] of cases) assert.match(validate(submission({ keyPoints: [point] })).problems.join(" "), problem, point);
    assert.match(validate(submission({ thesisImpact: { outcome: "weakens", reason: "Time to sell", metricIds: ["net_sales"] } }), { record: WITH_THESIS }).problems.join(" "), /trading advice/);
    for (const fine of ["Read the outlook section", "Check whether the dilution changes your valuation assumptions", "Nokia's 5G orders grew in Q3", "Decide whether this changes your risk tolerance"]) {
      assert.equal(checkAnalysisText(fine, { max: 200 }).value, fine, fine);
    }
  });
});

describe("analysis: deadlines, importance and page reading", () => {
  it("takes only deadlines the release states", () => {
    const stated = validate(submission({ deadlines: [{ label: "Subscription period ends", date: "2026-11-12", source: { url: RELEASE, location: "timetable" } }] }));
    assert.equal(stated.ok, true, JSON.stringify(stated.problems));
    const guessed = validate(submission({ deadlines: [{ label: "Subscription period ends", date: "2026-11-19", source: { url: RELEASE, location: "timetable" } }] }));
    assert.match(guessed.problems.join(" "), /not stated on the cited page/);
    assert.equal(dateOnPage("2026-11-12", "päättyy 12.11.2026"), true);
    assert.equal(dateOnPage("2026-11-12", "ends on November 12, 2026"), true);
    assert.equal(dateOnPage("2026-11-02", "ends on 12 November 2026"), false);
  });

  it("lets the analysis move importance one step at most, and never makes news critical", () => {
    assert.equal(refineLevel("important", "noise", { official: true }), "informational");
    assert.equal(refineLevel("informational", "critical", { official: true }), "important");
    assert.equal(refineLevel("important", "critical", { official: false }), "important");
    assert.equal(refineLevel("critical", "critical", { official: true }), "critical");
    assert.match(validate(submission({ importance: { level: "critical", reason: "Very urgent" } }), { event: { ...EVENT, evidence: "news" } }).problems.join(" "), /only an official release can be critical/);
  });

  it("reads Swedish, Finnish and English number formats from a page, and only the visible text", () => {
    const numbers = pageNumbers(pageText(RELEASE_HTML));
    for (const value of [1234.5, 1143, 148, 12, 0.52, -0.1, -56, 2100, 120000000, 3512, 5, 7]) assert.equal(numberOnPage(value, numbers).found, true, String(value));
    assert.equal(numberOnPage(987654, numbers).found, false, "script contents are not page text");
    const english = pageNumbers("Net sales of $1,234.5 million and 1,234 units; margin 12.0%");
    assert.equal(numberOnPage(1234.5, english).found, true);
    assert.equal(numberOnPage(1234, english).found, true);
    assert.equal(numberOnPage(1.234, english).found, true, "an ambiguous separator is read both ways");
    assert.equal(formatNumber(1234567.5), "1 234 567.5");
    assert.equal(formatNumber(-0.25), "−0.25");
  });
});
