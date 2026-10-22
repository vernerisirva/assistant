/**
 * The public sources the stock monitor reads, and resolving a security from
 * official listings.
 *
 * Each source is an adapter: its name, the kind of check (disclosures,
 * calendar, news, forums), which monitoring setting switches it on, which
 * securities it can cover, and `check(security, context)`, which fetches
 * through the shared polite fetcher (stock-http.mjs) and returns plain items.
 * Parsing is pure and tested against samples of the real responses.
 *
 * Only sources whose robots.txt allows this kind of reading, and whose terms
 * allow or plainly intend it (published feeds, open registers), are used.
 * What was checked and left out, and why, is in `SOURCES_NOT_USED`; a source
 * whose terms are unclear stays off until the owner turns it on.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatTime } from "./stock-monitor.mjs";
import { parseFeed, parseIcs } from "./stock-feeds.mjs";
import { cleanExternalText, decodeEntities, detectReport } from "./stock-events.mjs";
import { EXCHANGES, describeSecurity, isValidIsin, matchListings, nameKey, normalizeCik, normalizeTicker } from "./stock-identity.mjs";
import { ensurePrivateDir, resolveStockWatchDir } from "./stock-watchlist.mjs";
import { writeFileAtomicSync } from "./state-file.mjs";

/** Sources that were checked and are not read, with why (research of 2026-10-22). */
export const SOURCES_NOT_USED = Object.freeze({
  "api.nasdaq.com": "robots.txt disallows every path for every user agent (Nasdaq's screener, search and quote APIs).",
  "news.google.com": "robots.txt disallows /rss for every user agent.",
  "feeds.finance.yahoo.com": "robots.txt disallows everything.",
  "www.di.se": "blocks AI agents and reserves text and data mining.",
  "www.kauppalehti.fi": "robots.txt disallows everything but partner content; its feeds need a key.",
  "www.placera.se": "its terms forbid robots and other automatic tools, its RSS feed included.",
  "api.gdeltproject.org": "throttled even at one call per ten seconds, with little Nordic coverage.",
  "www.reddit.com": "robots.txt disallows everything; the Data API needs an app registered by the owner.",
  "forum.placera.se": "its terms forbid robots and other automatic tools.",
  "www.nordnet.se": "forbids scraping and automatic data collection for any purpose.",
  "www.globenewswire.com": "refuses plain clients; GlobeNewswire's own RSS host is read instead.",
});

/**
 * Sources that work but whose terms are unclear, off unless the owner turns
 * them on in config/schedules.json `stockWatch.sources`.
 */
export const OWNER_DECISION_SOURCES = Object.freeze({
  "nasdaq-company-news":
    "Nasdaq's per-company announcement API is undocumented (it is the backend of nasdaq.com's company news page) and nasdaq.com's terms forbid automated capture from its service; whether they cover this API is unclear.",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NORDIC_EXCHANGES = new Set(["XSTO", "SSME", "FNSE", "XHEL", "FNFI", "XCSE"]);
const available = { status: "available", note: null };
const unsupported = (note) => ({ status: "unsupported", note });
const notConfigured = (note) => ({ status: "not_configured", note });
// A source for another market: not a gap in coverage, so previews and health views leave it out.
const notApplicable = (note) => ({ status: "not_applicable", note });
const disclosuresOn = (monitoring) => monitoring.reports || monitoring.companyNews;

/** An item's link only when it is an https page on the source's own hosts; anything else is dropped, never followed. */
export function linkOn(value, hosts) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" && hosts.includes(url.host) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The name the company goes by in headlines: the configured one, else the listing name without its legal form. */
export function headlineName(security) {
  if (security.identifiers?.newsName) return security.identifiers.newsName;
  const words = security.companyName.split(/\s+/).filter((word) => !/^(?:ab|abp|oyj|oy|asa|as|a\/s|plc|inc\.?|corp\.?|corporation|ltd|limited|sa|se|nv|ag|\(publ\)|publ|group|holding|ser\.?|serie|series|class|cl\.?|[a-d])$/i.test(word));
  return words.join(" ") || security.companyName;
}

/** Whether a headline names the company: its headline name as whole words, in any case. */
export function namesCompany(title, security) {
  const name = headlineName(security).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${name}(?![\\p{L}\\p{N}])`, "iu").test(String(title ?? ""));
}

// --- Nasdaq exchange notices -----------------------------------------------------------------------

/**
 * Nasdaq's official RSS feeds of exchange notices for its Nordic main
 * markets and First North (listed at subscribe.news.eu.nasdaq.com/rss): the
 * exchange's own decisions about listed shares, such as trading halts,
 * observation status and delistings. Each feed holds the latest 20 notices,
 * so on a busy day a notice can scroll off between two hourly checks.
 */
export const NASDAQ_NOTICE_FEEDS = Object.freeze([
  "https://api.news.eu.nasdaq.com/news/rss/mainMarketNotices",
  "https://api.news.eu.nasdaq.com/news/rss/firstNorthNotices",
]);

export function parseNasdaqNotices(text, { security }) {
  const feed = parseFeed(text);
  if (!feed) return null;
  const companyName = security.identifiers?.nasdaqCompany ?? null;
  return feed
    .filter((item) => {
      const company = item.categories.find((category) => /\/rss\/company$/i.test(category.domain ?? ""))?.value ?? "";
      if (companyName && company === companyName) return true;
      return namesCompany(item.title, security);
    })
    .map((item) => ({
      documentId: /[?&]id=([a-z0-9]+)/i.exec(item.link ?? "")?.[1] ?? item.id,
      url: linkOn(item.link, ["view.news.eu.nasdaq.com"]),
      title: item.title,
      publishedAt: item.publishedAt,
      language: "en",
      evidence: "official_disclosure",
      category: item.categories.find((category) => /\/rss\/category$/i.test(category.domain ?? ""))?.value ?? "Exchange notice",
    }));
}

function nasdaqNoticesSource() {
  return {
    key: "nasdaq-notices",
    kind: "disclosures",
    name: "Nasdaq exchange notices",
    label: "Nasdaq exchange notices (trading halts, observation status, delistings)",
    evidence: "official_disclosure",
    enabledFor: disclosuresOn,
    coverage: (security) => (NORDIC_EXCHANGES.has(security.exchange) ? available : notApplicable("they cover Nasdaq's Nordic markets")),
    async check(security, { fetcher }) {
      const items = [];
      for (const feedUrl of NASDAQ_NOTICE_FEEDS) {
        const page = await fetcher.get(feedUrl, { hosts: ["api.news.eu.nasdaq.com"], accept: "application/rss+xml, application/xml", shared: true });
        if (page.status !== "ok") return page;
        const parsed = parseNasdaqNotices(page.body, { security });
        if (!parsed) return { status: "error", reason: "Nasdaq returned something that is not its notice feed." };
        items.push(...parsed);
      }
      return { status: "ok", items };
    },
  };
}

// --- Nasdaq company news (owner decision) ---------------------------------------------------------------

/**
 * Nasdaq's company news service lists every company announcement on its
 * Nordic markets, per company, by the exact name Nasdaq uses ("KONE Oyj").
 * Off by default: see OWNER_DECISION_SOURCES.
 */
export function nasdaqCompanyNewsUrl(companyName, { limit = 30 } = {}) {
  const url = new URL("https://api.news.eu.nasdaq.com/news/query.action");
  const params = {
    type: "json",
    showAttachments: "true",
    showCnsSpecific: "true",
    showCompany: "true",
    countResults: "false",
    freeText: "",
    company: companyName,
    market: "",
    cnscategory: "",
    fromDate: "",
    toDate: "",
    globalGroup: "",
    globalName: "NordicAllMarkets",
    displayLanguage: "en",
    language: "",
    timeZone: "UTC",
    dateMask: "yyyy-MM-dd'T'HH:mm:ss",
    limit: String(limit),
    start: "0",
    dir: "DESC",
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Nasdaq's announcement categories that name a report. The period comes from the headline. */
const CNS_REPORT_CATEGORIES = [
  [/^interim report/i, "interim"],
  [/^half[- ]year(?:ly)? financial report/i, "half_year"],
  [/^annual financial (?:and audit )?report/i, "annual"],
  [/^financial statement release|^year[- ]end report/i, "year_end"],
];

export function parseNasdaqCompanyNews(text, { companyName }) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  const entries = document?.results?.item;
  if (!Array.isArray(entries)) return null;
  const items = [];
  for (const entry of entries) {
    if (entry?.company !== companyName || typeof entry.headline !== "string" || !Number.isInteger(entry.disclosureId)) continue;
    const category = typeof entry.cnsCategory === "string" ? entry.cnsCategory : "";
    const reportKind = CNS_REPORT_CATEGORIES.find(([pattern]) => pattern.test(category))?.[1] ?? null;
    const titleReport = reportKind ? detectReport(entry.headline) : null;
    const published = typeof entry.published === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(entry.published) ? `${entry.published}Z` : null;
    items.push({
      documentId: String(entry.disclosureId),
      url: linkOn(entry.messageUrl, ["view.news.eu.nasdaq.com"]),
      title: entry.headline,
      publishedAt: published,
      language: typeof entry.language === "string" ? entry.language : null,
      evidence: "official_disclosure",
      category,
      insideInformation: /^inside information/i.test(category),
      report: reportKind ? { kind: titleReport?.kind === "year_end" ? "year_end" : reportKind, period: titleReport?.period ?? (reportKind === "half_year" ? "H1" : reportKind === "annual" ? "FY" : null), fiscalYear: titleReport?.fiscalYear ?? null } : null,
      attachments: Array.isArray(entry.attachment) ? entry.attachment.map((attachment) => linkOn(attachment?.attachmentUrl, ["attachment.news.eu.nasdaq.com"])).filter(Boolean).slice(0, 5) : [],
    });
  }
  return items;
}

function nasdaqCompanyNewsSource() {
  return {
    key: "nasdaq-company-news",
    kind: "disclosures",
    name: "Nasdaq company news",
    label: "Nasdaq Nordic company announcements",
    evidence: "official_disclosure",
    documentHosts: ["attachment.news.eu.nasdaq.com"],
    enabledFor: disclosuresOn,
    coverage: (security) => {
      if (!NORDIC_EXCHANGES.has(security.exchange)) return notApplicable("it covers Nasdaq's Nordic markets");
      return security.identifiers?.nasdaqCompany ? available : unsupported("the company's name on Nasdaq isn't known");
    },
    async check(security, { fetcher }) {
      const companyName = security.identifiers.nasdaqCompany;
      const page = await fetcher.get(nasdaqCompanyNewsUrl(companyName), { hosts: ["api.news.eu.nasdaq.com"], accept: "application/json" });
      if (page.status !== "ok") return page;
      const items = parseNasdaqCompanyNews(page.body, { companyName });
      if (!items) return { status: "error", reason: "Nasdaq returned something that is not its announcement list." };
      return { status: "ok", items };
    },
  };
}

// --- MFN -----------------------------------------------------------------------------------------

/**
 * MFN (Modular Finance News) distributes many Swedish companies' releases.
 * The per-company JSON feed on feed.mfn.se (the one MFN's own WordPress
 * plugin reads) carries the company's ISINs and tickers, one id per release
 * and one per release group (its language versions), and tags:
 * `:regulatory`, `:regulatory:mar` (inside information) and report tags such
 * as `sub:report:interim:q3`. Only companies that publish through MFN have
 * an entity id; their company page on mfn.se shows it.
 */
export const MFN_FEED = "https://feed.mfn.se/v1/feed/";
const MFN_DOCUMENT_HOSTS = ["storage.mfn.se"];

/** A report from MFN's tags, or null. The fiscal year comes from the title, else the publication date. */
export function mfnReport(tags, { title = "", publishedAt = null } = {}) {
  // The most specific tag wins: "sub:report:interim:q1" over "sub:report:interim".
  const tag = tags.filter((entry) => entry.startsWith("sub:report:")).sort((left, right) => right.length - left.length)[0];
  if (!tag) return null;
  const quarter = /^sub:report:interim:q([1-4])$/.exec(tag)?.[1];
  const kind = tag.startsWith("sub:report:annual") ? "annual" : tag.startsWith("sub:report:interim") ? "interim" : null;
  if (!kind) return null;
  const period = kind === "annual" ? "FY" : quarter ? `Q${quarter}` : null;
  const titleYear = [...String(title).matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1])).sort().at(-1) ?? null;
  const published = publishedAt ? new Date(publishedAt) : null;
  // A Q4 or annual report is published in the following year.
  const fromDate = published ? published.getUTCFullYear() - ((period === "Q4" || period === "FY") && published.getUTCMonth() < 6 ? 1 : 0) : null;
  return { kind, period, fiscalYear: titleYear ?? fromDate };
}

/** Items of one company's MFN feed. Items authored by another company are left out. */
export function parseMfnFeed(text, { entityId }) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  if (!document || !Array.isArray(document.items)) return null;
  const items = [];
  for (const entry of document.items) {
    const authorId = entry?.author?.entity_id;
    const subjects = Array.isArray(entry?.subjects) ? entry.subjects.map((subject) => subject?.entity_id) : [];
    if (authorId !== entityId && !subjects.includes(entityId)) continue;
    const tags = Array.isArray(entry?.properties?.tags) ? entry.properties.tags.filter((tag) => typeof tag === "string") : [];
    const title = entry?.content?.title;
    const publishedAt = entry?.content?.publish_date ?? null;
    if (typeof title !== "string" || typeof entry.news_id !== "string") continue;
    items.push({
      documentId: entry.news_id,
      groupId: typeof entry.group_id === "string" ? entry.group_id : null,
      url: linkOn(entry.url, ["feed.mfn.se", "mfn.se", "www.mfn.se"]),
      title,
      publishedAt,
      language: typeof entry?.properties?.lang === "string" ? entry.properties.lang : null,
      evidence: tags.includes(":regulatory") ? "official_disclosure" : "company_release",
      insideInformation: tags.includes(":regulatory:mar"),
      report: mfnReport(tags, { title, publishedAt }),
      category: tags.filter((tag) => tag.startsWith("sub:")).join(" "),
      attachments: (Array.isArray(entry?.content?.attachments) ? entry.content.attachments : [])
        .filter((attachment) => attachment?.content_type === "application/pdf")
        .map((attachment) => linkOn(attachment.url, MFN_DOCUMENT_HOSTS))
        .filter(Boolean)
        .slice(0, 5),
    });
  }
  return items;
}

/** The MFN company a feed belongs to: its ISINs and MIC:ticker pairs. */
export function mfnCompany(text) {
  try {
    const author = JSON.parse(text)?.items?.find((entry) => entry?.author)?.author;
    if (!author || !UUID.test(author.entity_id ?? "")) return null;
    return {
      entityId: author.entity_id,
      name: cleanExternalText(author.name ?? "", { max: 80 }),
      isins: (author.isins ?? []).filter((isin) => isValidIsin(isin)),
      tickers: (author.tickers ?? []).filter((ticker) => typeof ticker === "string" && /^[A-Z]{4}:/.test(ticker)),
    };
  } catch {
    return null;
  }
}

function mfnSource() {
  return {
    key: "mfn",
    kind: "disclosures",
    name: "MFN",
    label: "Company releases via MFN",
    evidence: "company_release",
    documentHosts: MFN_DOCUMENT_HOSTS,
    enabledFor: disclosuresOn,
    coverage: (security) => (security.identifiers?.mfnEntityId ? available : unsupported("the company doesn't publish through MFN, or its MFN id isn't known")),
    async check(security, { fetcher }) {
      const entityId = security.identifiers.mfnEntityId;
      const page = await fetcher.get(`${MFN_FEED}${entityId}?limit=30`, { hosts: ["feed.mfn.se"], accept: "application/json" });
      if (page.status !== "ok") return page;
      const items = parseMfnFeed(page.body, { entityId });
      if (!items) return { status: "error", reason: "MFN returned something that is not its feed." };
      // A feed that names another company's ISIN is not this security's.
      const company = mfnCompany(page.body);
      if (company && security.isin && company.isins.length > 0 && !company.isins.includes(security.isin)) {
        return { status: "blocked", reason: "MFN's feed for that id belongs to another company; check the MFN id." };
      }
      return { status: "ok", items };
    },
  };
}

// --- MFN's financial calendar ---------------------------------------------------------------------

/**
 * MFN's company pages (mfn.se/all/a/<slug>) have a calendar table for every
 * Nordic listed company: report dates with an estimated time ("Est. tid",
 * the time of the previous report). MFN compiles it, so its dates are a
 * third party's and stay `estimated` until the company's own calendar or
 * announcement confirms them. The page also shows an MFN entity id when the
 * company publishes through MFN.
 */
export function mfnCompanyPageUrl(slug) {
  return `https://mfn.se/all/a/${encodeURIComponent(slug)}`;
}

export function parseMfnCompanyPage(html) {
  const text = String(html ?? "");
  const title = /<title>\s*MFN\.se\s*&gt;\s*([^<]{1,100})<\/title>|<title>\s*MFN\.se\s*>\s*([^<]{1,100})<\/title>/i.exec(text);
  if (!title) return null;
  const entityId = /var\s+entityId\s*=\s*"([0-9a-f-]{36})"/.exec(text)?.[1] ?? null;
  const table = /<table class="table-calender">([\s\S]*?)<\/table>/i.exec(text)?.[1] ?? "";
  const rows = [...table.matchAll(/<tr[^>]*>\s*<td[^>]*>\s*(\d{4}-\d{2}-\d{2})\s*<\/td>\s*<td[^>]*>\s*([^<]*?)\s*<\/td>\s*<td[^>]*>\s*([^<]*?)\s*<\/td>\s*<\/tr>/gi)].map((match) => ({
    date: match[1],
    time: /^\d{2}:\d{2}$/.test(match[2].trim()) ? match[2].trim() : null,
    label: cleanExternalText(decodeEntities(match[3]), { max: 120 }),
  }));
  return { name: cleanExternalText(decodeEntities(title[1] ?? title[2] ?? ""), { max: 80 }), entityId: entityId && UUID.test(entityId) ? entityId : null, calendar: rows };
}

/** "Kvartalsrapport 2026-Q3", "Bokslutskommuniké 2026", "Halvårsrapport 2026" → a calendar report, or null. */
export function mfnCalendarReport(label) {
  const quarter = /^(?:kvartalsrapport|delårsrapport|interim report|quarterly report)\s+(\d{4})-Q([1-4])$/i.exec(label);
  if (quarter) return { kind: "interim", fiscalYear: Number(quarter[1]), period: `Q${quarter[2]}` };
  const yearEnd = /^(?:bokslutskommunik[ée]|year[- ]end report)\s+(\d{4})$/i.exec(label);
  if (yearEnd) return { kind: "year_end", fiscalYear: Number(yearEnd[1]), period: "FY" };
  const half = /^(?:halvårsrapport|half[- ]year report)\s+(\d{4})$/i.exec(label);
  if (half) return { kind: "half_year", fiscalYear: Number(half[1]), period: "H1" };
  const annual = /^(?:årsredovisning|annual report)\s+(\d{4})$/i.exec(label);
  if (annual) return { kind: "annual", fiscalYear: Number(annual[1]), period: "FY" };
  return null;
}

function mfnCalendarSource() {
  return {
    key: "mfn-calendar",
    kind: "calendar",
    name: "MFN's financial calendar",
    label: "Report dates from MFN's calendar (estimated)",
    evidence: "news",
    enabledFor: (monitoring) => monitoring.reports,
    coverage: (security) => (NORDIC_EXCHANGES.has(security.exchange) && security.identifiers?.mfnSlug ? available : unsupported("the company's MFN page isn't known")),
    async check(security, { fetcher, now }) {
      const url = mfnCompanyPageUrl(security.identifiers.mfnSlug);
      const page = await fetcher.get(url, { hosts: ["mfn.se"], accept: "text/html", maxResponseBytes: 2_000_000 });
      if (page.status !== "ok") return page;
      const parsed = parseMfnCompanyPage(page.body);
      if (!parsed) return { status: "error", reason: "MFN's company page could not be read." };
      if (nameKey(parsed.name).split(" ")[0] !== nameKey(security.companyName).split(" ")[0]) {
        return { status: "blocked", reason: "That MFN page belongs to another company; check the MFN page name." };
      }
      const today = now.toISOString().slice(0, 10);
      const calendar = parsed.calendar
        .filter((row) => row.date >= today)
        .map((row) => ({ row, report: mfnCalendarReport(row.label) }))
        .filter(({ report }) => report)
        .map(({ row, report }) => ({ ...report, date: row.date, time: row.time, timezone: "Europe/Stockholm", status: "estimated", url }));
      return { status: "ok", items: [], calendar };
    },
  };
}

// --- Euroland financial calendars --------------------------------------------------------------------

/**
 * Many Nordic companies publish their own financial calendar through
 * Euroland's IR tools, which also offer it as an iCalendar file. Those are
 * the company's own announced dates, so they count as confirmed. Only report
 * events become calendar entries; roadshows and conferences are ignored.
 * robots.txt allows /tools/ with a 20-second crawl delay, which the fetcher
 * keeps.
 */
export const EUROLAND_HOSTS = Object.freeze(["tools.eurolandir.com", "tools.euroland.com"]);

export function eurolandCalendarUrl(companyCode, { language = "en-GB" } = {}) {
  return `https://tools.eurolandir.com/tools/fincalendar2/Download/ExportUpcommingToCalendar?companyCode=${encodeURIComponent(companyCode)}&lang=${encodeURIComponent(language)}`;
}

/**
 * Report dates from calendar events. A summary must name a report
 * ("Interim Report January-September", "Financial Statements Bulletin 2026");
 * the fiscal year comes from the summary, else from the date, a Q4 or annual
 * report in the first half of a year belonging to the year before.
 */
export function calendarFromEvents(events, { url = null } = {}) {
  const entries = [];
  for (const event of events) {
    const report = detectReport(String(event.summary ?? "").replace(/^[^:]{1,80}:\s*/, ""));
    if (!report || !["interim", "half_year", "year_end", "annual", "business_review"].includes(report.kind)) continue;
    const year = Number(event.start.date.slice(0, 4));
    const month = Number(event.start.date.slice(5, 7));
    const fiscalYear = report.fiscalYear ?? ((report.period === "FY" || report.period === "Q4") && month <= 6 ? year - 1 : year);
    entries.push({ kind: report.kind, fiscalYear, period: report.period, date: event.start.date, time: event.start.time, timezone: event.start.tzid, status: "confirmed", url });
  }
  return entries;
}

function eurolandSource() {
  return {
    key: "euroland-calendar",
    kind: "calendar",
    name: "the company's financial calendar (Euroland)",
    label: "Report dates from the company's own calendar",
    evidence: "official_disclosure",
    enabledFor: (monitoring) => monitoring.reports,
    coverage: (security) => (security.identifiers?.eurolandCode ? available : unsupported("the company's calendar file isn't known")),
    async check(security, { fetcher }) {
      const page = await fetcher.get(eurolandCalendarUrl(security.identifiers.eurolandCode), { hosts: [...EUROLAND_HOSTS], accept: "text/calendar" });
      if (page.status !== "ok") return page;
      const events = parseIcs(page.body);
      if (!events) return { status: "error", reason: "Euroland returned something that is not a calendar." };
      return { status: "ok", items: [], calendar: calendarFromEvents(events) };
    },
  };
}

// --- GlobeNewswire --------------------------------------------------------------------------------

/**
 * GlobeNewswire distributes many Finnish and some Swedish, Danish and
 * Norwegian companies' releases. Its public country feeds on
 * rss.globenewswire.com list the latest 20 releases with each issuer's ISIN
 * and exchange ticker, one id shared by a release's language versions, and
 * subjects such as "European Regulatory News". One request per country per
 * run covers every followed company there.
 */
export const GLOBENEWSWIRE_COUNTRY_FEEDS = Object.freeze({
  SE: "https://rss.globenewswire.com/RssFeed/country/Sweden/feedTitle/GlobeNewswire%20-%20News%20from%20Sweden",
  FI: "https://rss.globenewswire.com/RssFeed/country/Finland/feedTitle/GlobeNewswire%20-%20News%20from%20Finland",
  DK: "https://rss.globenewswire.com/RssFeed/country/Denmark/feedTitle/GlobeNewswire%20-%20News%20from%20Denmark",
  NO: "https://rss.globenewswire.com/RssFeed/country/Norway/feedTitle/GlobeNewswire%20-%20News%20from%20Norway",
});

/** Items of a GlobeNewswire feed for one ISIN. */
export function parseGlobeNewswire(text, { isin }) {
  const feed = parseFeed(text);
  if (!feed) return null;
  return feed
    .filter((item) => item.categories.some((category) => /\/rss\/isin$/i.test(category.domain ?? "") && category.value === isin))
    .map((item) => ({
      documentId: item.identifier ? `${item.identifier}:${item.language ?? ""}` : item.id,
      groupId: item.identifier,
      url: linkOn(item.link, ["www.globenewswire.com", "globenewswire.com"]),
      title: item.title,
      publishedAt: item.publishedAt,
      language: item.language,
      evidence: item.subjects.some((subject) => /regulatory/i.test(subject)) ? "official_disclosure" : "company_release",
      category: item.subjects.join("; "),
    }));
}

/** The exchange ticker GlobeNewswire gives an ISIN ("Helsinki:NOKIA" → NOKIA on Helsinki), or null. */
export function globeNewswireTicker(text, { isin, venue }) {
  const feed = parseFeed(text) ?? [];
  for (const item of feed) {
    if (!item.categories.some((category) => /\/rss\/isin$/i.test(category.domain ?? "") && category.value === isin)) continue;
    const stock = item.categories.find((category) => /\/rss\/stock$/i.test(category.domain ?? "") && category.value.startsWith(`${venue}:`));
    if (stock) return normalizeTicker(stock.value.slice(venue.length + 1));
  }
  return null;
}

function globeNewswireSource() {
  return {
    key: "globenewswire",
    kind: "disclosures",
    name: "GlobeNewswire",
    label: "Company releases via GlobeNewswire",
    evidence: "company_release",
    enabledFor: disclosuresOn,
    coverage: (security) => {
      if (!GLOBENEWSWIRE_COUNTRY_FEEDS[security.country]) return notApplicable("GlobeNewswire's country feeds don't cover this country");
      return security.isin ? available : unsupported("it needs the ISIN");
    },
    async check(security, { fetcher }) {
      const page = await fetcher.get(GLOBENEWSWIRE_COUNTRY_FEEDS[security.country], { hosts: ["rss.globenewswire.com"], accept: "application/rss+xml, application/xml", shared: true });
      if (page.status !== "ok") return page;
      const items = parseGlobeNewswire(page.body, { isin: security.isin });
      if (!items) return { status: "error", reason: "GlobeNewswire returned something that is not a feed." };
      return { status: "ok", items };
    },
  };
}

// --- Cision ---------------------------------------------------------------------------------------

/**
 * Cision News publishes an RSS feed per company newsroom, as its About page
 * offers readers: all releases, or only regulatory ones (`r=regulatory`).
 * Items carry a title, link, id and date, but no identifiers or language,
 * and each language version is its own item.
 */
export function cisionFeedUrl(slug, { regulatory = false } = {}) {
  return `https://news.cision.com/${encodeURIComponent(slug)}/ListItems?${regulatory ? "r=regulatory&" : ""}format=rss`;
}

export function parseCisionFeed(text, { regulatory = false } = {}) {
  const feed = parseFeed(text);
  if (!feed) return null;
  return feed
    .filter((item) => item.title)
    .map((item) => ({
      documentId: item.id ?? /,c(\d+)$/.exec(item.link ?? "")?.[1] ?? null,
      url: linkOn(item.link, ["news.cision.com"]),
      title: item.title,
      publishedAt: item.publishedAt,
      language: null,
      evidence: regulatory ? "official_disclosure" : "company_release",
    }));
}

/** Newsroom slugs in a Cision search result, with how many of their items name the company. */
export function cisionNewsrooms(text, { security }) {
  const counts = new Map();
  for (const item of parseFeed(text) ?? []) {
    const slug = /^https:\/\/news\.cision\.com\/(?:(?:se|fi|dk|no)\/)?([a-z0-9][a-z0-9-]{0,79})\/r\//.exec(item.link ?? "")?.[1];
    if (!slug) continue;
    const entry = counts.get(slug) ?? { slug, items: 0, naming: 0 };
    entry.items += 1;
    if (namesCompany(item.title, security)) entry.naming += 1;
    counts.set(slug, entry);
  }
  return [...counts.values()].filter((entry) => entry.naming > 0).sort((left, right) => right.naming - left.naming || right.items - left.items);
}

/** The company a Cision newsroom page is for: its page title, such as "Investor" or "KONE Oyj". */
export function cisionNewsroomName(html) {
  const title = /<title>\s*([^<]{1,100}?)\s*<\/title>/i.exec(String(html ?? ""))?.[1];
  return title ? cleanExternalText(decodeEntities(title), { max: 100 }) : null;
}

function cisionSource() {
  return {
    key: "cision",
    kind: "disclosures",
    name: "Cision",
    label: "Company releases via Cision",
    evidence: "company_release",
    enabledFor: disclosuresOn,
    coverage: (security) => (security.identifiers?.cisionSlug ? available : unsupported("the company's Cision newsroom isn't known")),
    async check(security, { fetcher }) {
      const slug = security.identifiers.cisionSlug;
      const hosts = ["news.cision.com"];
      // Regulatory releases first: they are the official ones. The full feed adds the company's other releases.
      const regulatory = await fetcher.get(cisionFeedUrl(slug, { regulatory: true }), { hosts, accept: "application/rss+xml, application/xml" });
      if (regulatory.status !== "ok") return regulatory;
      const official = parseCisionFeed(regulatory.body, { regulatory: true });
      if (!official) return { status: "error", reason: "Cision returned something that is not a feed." };
      const all = await fetcher.get(cisionFeedUrl(slug), { hosts, accept: "application/rss+xml, application/xml" });
      const others = all.status === "ok" ? parseCisionFeed(all.body) : null;
      const officialIds = new Set(official.map((item) => item.documentId));
      const items = [...official, ...(others ?? []).filter((item) => !officialIds.has(item.documentId))];
      // The regulatory releases are kept; the source is only partly checked until the full feed reads again.
      if (!others) return { status: "ok", items, partial: `the full feed could not be read (${all.status === "ok" ? "not a feed" : all.reason ?? all.status}), so only regulatory releases were checked` };
      return { status: "ok", items };
    },
  };
}

// --- SEC EDGAR ------------------------------------------------------------------------------------

/**
 * SEC EDGAR for US-listed companies: the official submissions API lists every
 * filing with its form type, acceptance time, period and 8-K items. SEC's fair
 * access rules require a User-Agent that names who is asking, with a contact
 * address (`SEC_EDGAR_USER_AGENT`), and at most ten requests a second;
 * without the address EDGAR is not read at all. SEC publishes no earnings
 * calendar: an 8-K with Item 2.02 is the results release.
 */
const EDGAR_FORMS = {
  "10-Q": { kind: "quarterly_filing", label: "quarterly report (10-Q)" },
  "10-K": { kind: "annual_filing", label: "annual report (10-K)" },
  "20-F": { kind: "annual_filing", label: "annual report (20-F)" },
  "40-F": { kind: "annual_filing", label: "annual report (40-F)" },
};
const EDGAR_8K_ITEMS = {
  "1.01": "material agreement",
  "1.02": "agreement terminated",
  "1.03": "bankruptcy or receivership",
  "1.05": "cybersecurity incident",
  "2.01": "acquisition or disposal completed",
  "2.02": "results of operations",
  "2.05": "exit or restructuring costs",
  "2.06": "material impairment",
  "3.01": "delisting notice",
  "3.02": "unregistered share sales",
  "4.02": "financial statements no longer reliable",
  "5.01": "change in control",
  "5.02": "director or officer change",
  "7.01": "Regulation FD disclosure",
  "8.01": "other events",
};

export function edgarUserAgent(env) {
  const value = String(env?.SEC_EDGAR_USER_AGENT ?? "").trim();
  return /^[^\r\n]{3,120}\s\S+@\S+\.\S+$/.test(value) ? value : null;
}

/**
 * When EDGAR accepted a filing, in real UTC. The submissions API writes
 * `acceptanceDateTime` with a "Z", but its clock reads New York time plus
 * New York's UTC offset: Microsoft's earnings 8-K accepted at 16:04 New York
 * time on 29 July 2026 shows as "2026-07-30T00:04:53.000Z". Read as UTC, many
 * filings would fall outside EDGAR's 06:00–22:00 New York hours; taking the
 * offset off once more puts every one of them inside.
 */
export function edgarAcceptedAt(shown) {
  const ms = Date.parse(String(shown ?? ""));
  if (!Number.isFinite(ms)) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  const newYorkWall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return new Date(ms - (ms - newYorkWall)).toISOString();
}

/** Filings from one EDGAR submissions document, newest first. */
export function parseEdgarSubmissions(text, { cik }) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  const recent = document?.filings?.recent;
  if (!recent || !Array.isArray(recent.accessionNumber) || normalizeCik(document.cik) !== cik) return null;
  const items = [];
  const cikNumber = String(Number(cik));
  for (let index = 0; index < Math.min(recent.accessionNumber.length, 100); index += 1) {
    const form = recent.form?.[index];
    const accession = recent.accessionNumber[index];
    if (typeof form !== "string" || typeof accession !== "string" || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const base = form.replace(/\/A$/, "");
    const amended = form.endsWith("/A");
    if (!EDGAR_FORMS[base] && base !== "8-K") continue;
    const items8k = base === "8-K" ? String(recent.items?.[index] ?? "").split(",").map((item) => item.trim()).filter(Boolean) : [];
    const primary = String(recent.primaryDocument?.[index] ?? "");
    const folder = `https://www.sec.gov/Archives/edgar/data/${cikNumber}/${accession.replace(/-/g, "")}`;
    const documentUrl = /^[A-Za-z0-9._-]{1,120}$/.test(primary) ? `${folder}/${primary}` : null;
    const reportDate = /^\d{4}-\d{2}-\d{2}$/.test(recent.reportDate?.[index] ?? "") ? recent.reportDate[index] : null;
    const accepted = recent.acceptanceDateTime?.[index] ?? null;
    let title;
    let report = null;
    if (base === "8-K") {
      const described = items8k.map((item) => EDGAR_8K_ITEMS[item]).filter(Boolean);
      title = `8-K: ${described.length > 0 ? described.join(", ") : "current report"}`;
      if (items8k.includes("2.02")) report = { kind: "earnings_release", period: null, fiscalYear: null };
    } else {
      title = `${EDGAR_FORMS[base].label}${reportDate ? ` for the period ending ${reportDate}` : ""}`;
      report = { kind: EDGAR_FORMS[base].kind, period: base === "10-Q" ? edgarQuarter(reportDate) : "FY", fiscalYear: reportDate ? Number(reportDate.slice(0, 4)) : null };
    }
    items.push({
      documentId: accession,
      url: documentUrl ?? `${folder}/`,
      title: `${amended ? "Amended " : ""}${title}`,
      publishedAt: accepted ? edgarAcceptedAt(accepted) : recent.filingDate?.[index] ? `${recent.filingDate[index]}T12:00:00.000Z` : null,
      language: "en",
      evidence: "official_disclosure",
      category: base === "8-K" ? `8-K items ${items8k.join(", ")}` : form,
      // An amendment is its own version, never the report again.
      report: amended ? null : report,
      attachments: documentUrl ? [documentUrl] : [],
      edgar: { form, items: items8k, reportDate },
    });
  }
  return items;
}

/** The calendar quarter a 10-Q's period ends in; a fiscal quarter may differ, so it is only a label. */
function edgarQuarter(reportDate) {
  const month = Number(String(reportDate ?? "").slice(5, 7));
  return month ? `Q${Math.ceil(month / 3)}` : null;
}

function edgarSource({ env }) {
  const userAgent = edgarUserAgent(env);
  return {
    key: "sec-edgar",
    kind: "disclosures",
    name: "SEC EDGAR",
    label: "SEC filings (EDGAR)",
    evidence: "official_disclosure",
    documentHosts: ["www.sec.gov"],
    userAgent,
    enabledFor: disclosuresOn,
    coverage: (security) => {
      if (EXCHANGES[security.exchange]?.region !== "us") return notApplicable("EDGAR covers US-listed companies");
      if (!security.identifiers?.secCik) return unsupported("the company's SEC CIK isn't known");
      return userAgent ? available : notConfigured("EDGAR needs SEC_EDGAR_USER_AGENT with a contact address in .env");
    },
    async check(security, { fetcher }) {
      const cik = security.identifiers.secCik;
      const page = await fetcher.get(`https://data.sec.gov/submissions/CIK${cik}.json`, { hosts: ["data.sec.gov"], userAgent, accept: "application/json" });
      if (page.status !== "ok") return page;
      const items = parseEdgarSubmissions(page.body, { cik });
      if (!items) return { status: "error", reason: "EDGAR returned something that is not this company's submissions." };
      return { status: "ok", items };
    },
  };
}

// --- News: Bing News RSS ------------------------------------------------------------------------------

/**
 * News about a company from Bing News' RSS search, whose feed terms allow
 * personal, non-commercial use in an RSS reader. An item counts only when its
 * headline names the company; the publisher's own link is taken from Bing's
 * click-through link without following it. News is a publisher's report,
 * never a company fact, and the same story from several outlets is merged as
 * repeats.
 */
const BING_MARKETS = { SE: "sv-SE", FI: "fi-FI", DK: "da-DK", NO: "nb-NO", US: "en-US", GB: "en-GB", DE: "de-DE", FR: "fr-FR", NL: "nl-NL", CH: "de-CH" };

/** Publishers whose business is financial or general news of record; others are labelled as other sources. */
const ESTABLISHED_PUBLISHERS = /\b(?:reuters|bloomberg|financial times|ft\.com|wall street journal|wsj|cnbc|associated press|ap news|barron'?s|marketwatch|the economist|dagens industri|di\.se|svenska dagbladet|svd|dagens nyheter|affärsvärlden|placera|nyhetsbyrån direkt|direkt|finwire|privata affärer|realtid|breakit|kauppalehti|helsingin sanomat|talouselämä|yle|arvopaperi|inderes|børsen|finans\.dk|e24|dagens næringsliv|handelsblatt|les echos|nikkei|forbes|fortune|the guardian|bbc)\b/i;

/**
 * The search asks for the full listed name ("Investor AB", "KONE Corporation"),
 * so an article must at least mention the company itself, and the headline
 * must then name it: "Investor" alone would match every investor in the news.
 * A news name the user set replaces both.
 */
export function bingNewsUrl(security) {
  const url = new URL("https://www.bing.com/news/search");
  url.searchParams.set("q", `"${security.identifiers?.newsName ?? security.companyName}"`);
  url.searchParams.set("format", "rss");
  url.searchParams.set("mkt", BING_MARKETS[security.country] ?? "en-US");
  url.searchParams.set("qft", 'sortbydate="1"');
  return url.toString();
}

export function parseBingNews(text, { security }) {
  const feed = parseFeed(text);
  if (!feed) return null;
  const items = [];
  for (const item of feed) {
    if (!item.title || !namesCompany(item.title, security)) continue;
    let publisherUrl = null;
    try {
      const target = new URL(item.link ?? "").searchParams.get("url");
      const parsed = target ? new URL(target) : null;
      if (parsed && (parsed.protocol === "https:" || parsed.protocol === "http:")) publisherUrl = parsed.toString();
    } catch {
      publisherUrl = null;
    }
    const publisher = cleanExternalText(item.source ?? "", { max: 80 }) || null;
    items.push({
      documentId: publisherUrl ? null : item.id,
      url: publisherUrl,
      title: item.title,
      publishedAt: item.publishedAt,
      language: null,
      evidence: "news",
      publisher,
      category: publisher && ESTABLISHED_PUBLISHERS.test(publisher) ? "established publisher" : "other source",
    });
  }
  return items;
}

function bingNewsSource() {
  return {
    key: "bing-news",
    kind: "news",
    name: "Bing News",
    label: "News (Bing News search)",
    evidence: "news",
    enabledFor: (monitoring) => monitoring.generalNews,
    coverage: () => available,
    async check(security, { fetcher }) {
      const page = await fetcher.get(bingNewsUrl(security), { hosts: ["www.bing.com"], accept: "application/rss+xml, application/xml" });
      if (page.status !== "ok") return page;
      const items = parseBingNews(page.body, { security });
      if (!items) return { status: "error", reason: "Bing returned something that is not a news feed." };
      return { status: "ok", items };
    },
  };
}

// --- Forums: the Inderes forum ---------------------------------------------------------------------

/**
 * The Inderes investor forum (forum.inderes.com, mostly Finnish companies) has
 * one long thread per company. Its robots.txt allows a topic's JSON
 * (/t/<id>.json) but not search or topic RSS, so a thread is followed by its
 * id, found once on the company's Inderes page. Only activity is recorded:
 * how many new posts since the last check and a link to the thread, never
 * usernames or post text. Forum talk is unverified discussion, never fact.
 */
export function parseInderesTopic(text, { topicId }) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  if (!document || document.id !== topicId || !Number.isInteger(document.posts_count) || typeof document.slug !== "string") return null;
  return {
    title: cleanExternalText(document.title ?? "", { max: 120 }),
    postsCount: document.posts_count,
    lastPostedAt: typeof document.last_posted_at === "string" ? new Date(document.last_posted_at).toISOString() : null,
    url: `https://forum.inderes.com/t/${encodeURIComponent(document.slug)}/${topicId}`,
  };
}

function inderesForumSource() {
  return {
    key: "inderes-forum",
    kind: "forums",
    name: "Inderes forum",
    label: "Investor discussion (Inderes forum)",
    evidence: "forum",
    enabledFor: (monitoring) => monitoring.forums,
    coverage: (security) => (security.identifiers?.inderesTopic ? available : unsupported("no Inderes forum thread is known for the company")),
    async check(security, { fetcher, notes }) {
      const topicId = security.identifiers.inderesTopic;
      const page = await fetcher.get(`https://forum.inderes.com/t/${topicId}.json`, { hosts: ["forum.inderes.com"], accept: "application/json" });
      if (page.status !== "ok") return page;
      const topic = parseInderesTopic(page.body, { topicId });
      if (!topic) return { status: "error", reason: "The forum returned something that is not that thread." };
      const seen = Number.isInteger(notes?.cursor?.postsCount) ? notes.cursor.postsCount : null;
      const fresh = seen === null ? 0 : topic.postsCount - seen;
      const items =
        fresh > 0
          ? [{ documentId: `posts-${topic.postsCount}`, url: topic.url, title: `${fresh} new post${fresh === 1 ? "" : "s"} in the Inderes forum thread “${topic.title}”`, publishedAt: topic.lastPostedAt, language: null, evidence: "forum" }]
          : [];
      return { status: "ok", items, cursor: { postsCount: topic.postsCount } };
    },
  };
}

// --- All sources ------------------------------------------------------------------------------------

/**
 * The sources this installation reads. EDGAR needs `SEC_EDGAR_USER_AGENT`;
 * sources in OWNER_DECISION_SOURCES are read only when `stockWatch.sources`
 * in config/schedules.json turns them on.
 */
export function createStockSources({ env = {}, enabled = {} } = {}) {
  return [
    nasdaqNoticesSource(),
    ...(enabled["nasdaq-company-news"] === true ? [nasdaqCompanyNewsSource()] : []),
    mfnSource(),
    cisionSource(),
    globeNewswireSource(),
    edgarSource({ env }),
    eurolandSource(),
    mfnCalendarSource(),
    bingNewsSource(),
    inderesForumSource(),
  ];
}

/**
 * Which sources can follow a security with the given monitoring settings:
 * `[{ key, label, kind, status: available | not_configured | unsupported | not_applicable, note }]`,
 * only for sources the settings switch on.
 */
export function sourceCoverage(security, monitoring, sources) {
  return sources
    .filter((source) => source.enabledFor(monitoring))
    .map((source) => {
      const coverage = source.coverage(security);
      return { key: source.key, label: source.label, kind: source.kind, status: coverage.status, note: coverage.note ?? null };
    });
}

// --- Text for people ----------------------------------------------------------------------------------

export const TYPE_TEXT = {
  report: "report",
  report_notice: "report date notice",
  report_date_changed: "report date moved",
  trading_suspension: "trading halt",
  delisting: "delisting",
  insolvency: "insolvency",
  profit_warning: "profit warning",
  takeover_offer: "takeover offer",
  rights_issue: "rights issue",
  guidance_upgrade: "guidance raised",
  guidance_change: "guidance change",
  share_issue: "share issue",
  acquisition: "acquisition",
  divestment: "divestment",
  management_change: "management change",
  major_order: "order",
  litigation: "legal",
  regulatory: "regulatory",
  dividend: "dividend",
  buyback: "buyback",
  shareholder_meeting: "shareholder meeting",
  board_change: "board",
  insider_transaction: "insider transaction",
  major_holding: "major holding",
  capital_markets_day: "capital markets day",
  other_disclosure: "announcement",
  news_article: "news",
  forum_discussion: "forum talk",
};

export const EVIDENCE_TEXT = {
  official_disclosure: "official",
  company_release: "company release",
  news: "news report, not confirmed by the company",
  forum: "forum discussion, unverified",
};

/** One event as a line: when, what kind, the headline as the source gave it, and where it came from. */
export function describeEvent(event, record, { timezone = "Europe/Stockholm" } = {}) {
  const when = event.publishedAt ? formatTime(event.publishedAt, timezone) : "date unknown";
  const kind = TYPE_TEXT[event.type] ?? "announcement";
  const original = event.sources.find((source) => source.role === "original") ?? event.sources[0];
  const flags = [
    EVIDENCE_TEXT[event.evidence],
    original?.publisher ? `${original.publisher}${original.category ? `, ${original.category}` : ""}` : null,
    event.insideInformation ? "inside information" : null,
    event.correctionOf ? "correction" : null,
    event.catchUp ? "found after a pause in checking" : null,
    event.missed ? "missed, older than the catch-up window" : null,
  ].filter(Boolean);
  const others = event.sources.length - 1;
  return `${when} · ${record.security.ticker ?? record.security.companyName} · ${kind}: “${event.title}” (${flags.join("; ")}) ${original?.url ?? original?.name ?? ""}${others > 0 ? ` (+${others} more source${others === 1 ? "" : "s"})` : ""}`.trim();
}

// --- Listing caches and resolving --------------------------------------------------------------------------

const CACHE_TTL_MS = 24 * 3_600_000;

/** Public listing data, cached for a day in the monitor's own folder. Nothing private is ever cached. */
export function createListingCache({ stateDir }) {
  const base = resolveStockWatchDir(stateDir);
  const root = join(base, "cache");
  const path = (name) => join(root, `${name}.json`);
  return {
    read(name, { now = new Date(), maxAgeMs = CACHE_TTL_MS } = {}) {
      if (!existsSync(path(name))) return null;
      try {
        const document = JSON.parse(readFileSync(path(name), "utf8"));
        if (!document || typeof document.fetchedAt !== "string" || now.getTime() - Date.parse(document.fetchedAt) > maxAgeMs) return null;
        return document;
      } catch {
        return null;
      }
    },
    write(name, data, { now = new Date() } = {}) {
      ensurePrivateDir(base, { base: join(base, "..") });
      ensurePrivateDir(root, { base: join(base, "..") });
      writeFileAtomicSync(path(name), `${JSON.stringify({ fetchedAt: now.toISOString(), data })}\n`, { mode: 0o600 });
    },
  };
}

/** SEC's ticker list (company_tickers_exchange.json) as listings: ticker, name, CIK and exchange. */
export function parseSecTickers(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(document?.fields) || !Array.isArray(document?.data)) return null;
  const at = (name) => document.fields.indexOf(name);
  const [cikAt, nameAt, tickerAt, exchangeAt] = ["cik", "name", "ticker", "exchange"].map(at);
  if ([cikAt, nameAt, tickerAt, exchangeAt].some((index) => index < 0)) return null;
  const mics = { Nasdaq: "XNAS", NYSE: "XNYS", "NYSE American": "XASE", "NYSE MKT": "XASE" };
  const listings = [];
  for (const row of document.data) {
    const exchange = mics[row[exchangeAt]];
    const ticker = normalizeTicker(String(row[tickerAt] ?? ""));
    const cik = normalizeCik(row[cikAt]);
    if (!exchange || !ticker || !cik) continue;
    listings.push({ companyName: cleanExternalText(String(row[nameAt] ?? ""), { max: 80 }), ticker, exchange, shareClass: null, isin: null, currency: "USD", country: "US", identifiers: { secCik: cik } });
  }
  return listings;
}

/**
 * ESMA's FIRDS register: the EU's official reference data for every
 * instrument traded on an EU venue. One record per venue; only equity shares
 * (CFI ES…) on the Nordic venues Hilla knows are kept. It gives the ISIN,
 * venue, currency, full name and LEI, but no exchange ticker.
 */
export const FIRDS_SELECT = "https://registers.esma.europa.eu/solr/esma_registers_firds/select";
const FIRDS_VENUES = { XSTO: "XSTO", MSTO: "XSTO", SSME: "SSME", FNSE: "SSME", XHEL: "XHEL", FNFI: "FNFI", XCSE: "XCSE", DSME: "XCSE" };
const FIRDS_FIELDS = "isin,mic,gnr_full_name,gnr_short_name,gnr_cfi_code,gnr_notional_curr_code,lei,mrkt_trdng_trmination_date,status";

export function firdsUrl(query) {
  const url = new URL(FIRDS_SELECT);
  const venues = Object.keys(FIRDS_VENUES).join(" OR ");
  const isin = String(query).trim().toUpperCase();
  let q;
  if (isValidIsin(isin)) q = `isin:${isin} AND mic:(${venues})`;
  else {
    // The longest plain word of the name, so nothing the user typed becomes query syntax.
    const word = (String(query).normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? []).filter((part) => !/^(?:ab|oyj|abp|asa|plc|inc|corp|class|serie|ser)$/i.test(part) && !/^[a-d]$/i.test(part)).sort((left, right) => right.length - left.length)[0];
    if (!word) return null;
    q = `gnr_full_name:${word}* AND mic:(${venues}) AND gnr_cfi_code:ES*`;
  }
  url.searchParams.set("q", q);
  url.searchParams.set("fl", FIRDS_FIELDS);
  url.searchParams.set("wt", "json");
  url.searchParams.set("rows", "60");
  return url.toString();
}

/** Listings from a FIRDS answer: one per share on a Nordic venue, ended listings apart. */
export function parseFirds(text, { now = new Date() } = {}) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  const docs = document?.response?.docs ?? document?.docs;
  if (!Array.isArray(docs)) return null;
  const listings = new Map();
  const ended = new Map();
  for (const doc of docs) {
    const exchange = FIRDS_VENUES[doc?.mic];
    if (!exchange || typeof doc.isin !== "string" || !isValidIsin(doc.isin) || !/^ES/.test(doc.gnr_cfi_code ?? "")) continue;
    const fullName = cleanExternalText(String(doc.gnr_full_name ?? ""), { max: 100 });
    const classMatch = /\s+(?:ser\.?|serie|series|class|cl\.?)\s*([A-D])\s*$/i.exec(fullName);
    const shortClass = /\b(?:SH|CL)\s+([A-D])\s*$/i.exec(String(doc.gnr_short_name ?? ""));
    const listing = {
      companyName: classMatch ? fullName.slice(0, classMatch.index).trim() : fullName,
      ticker: null,
      exchange,
      shareClass: (classMatch?.[1] ?? shortClass?.[1] ?? null)?.toUpperCase() ?? null,
      isin: doc.isin,
      currency: typeof doc.gnr_notional_curr_code === "string" ? doc.gnr_notional_curr_code : null,
      country: EXCHANGES[exchange].country,
      lei: typeof doc.lei === "string" ? doc.lei : null,
      identifiers: {},
    };
    const key = `${listing.isin}:${exchange}`;
    const termination = doc.mrkt_trdng_trmination_date ? Date.parse(doc.mrkt_trdng_trmination_date) : null;
    if (doc.status === "TERM" || (Number.isFinite(termination) && termination < now.getTime())) {
      ended.set(key, { ...listing, endedOn: doc.mrkt_trdng_trmination_date ? String(doc.mrkt_trdng_trmination_date).slice(0, 10) : null });
      continue;
    }
    listings.set(key, listing);
  }
  for (const key of listings.keys()) ended.delete(key);
  return { listings: [...listings.values()], ended: [...ended.values()] };
}

/**
 * Which listed security the user's words mean, from official registers:
 * ESMA's FIRDS for Nordic shares and SEC's ticker list for US ones (which
 * needs SEC_EDGAR_USER_AGENT). Then, for a single Nordic match, where its
 * releases and calendar can be read: its MFN page and id, and its Cision
 * newsroom. Returns { status: resolved | ambiguous | none, candidates,
 * ended, listingsChecked, problems }. Only public company names, tickers and
 * ISINs are sent.
 */
export async function resolveSecurity(query, { exchange = null, fetcher, cache, now = new Date(), env = {} } = {}) {
  const listingsChecked = [];
  const problems = [];
  const listings = [];
  let ended = [];
  const region = exchange ? EXCHANGES[exchange]?.region : null;

  if (region !== "us" && fetcher) {
    const url = firdsUrl(query);
    if (url) {
      const page = await fetcher.get(url, { hosts: ["registers.esma.europa.eu"], accept: "application/json" });
      const parsed = page.status === "ok" ? parseFirds(page.body, { now }) : null;
      if (parsed) {
        listingsChecked.push("esma-firds");
        listings.push(...parsed.listings.map((listing) => ({ ...listing, verification: { source: "esma-firds", checkedAt: now.toISOString() } })));
        ended = parsed.ended;
      } else problems.push(`ESMA's register could not be read: ${page.reason ?? "unexpected answer"}`);
    }
  }
  if (!region || region === "us") {
    const userAgent = edgarUserAgent(env);
    let sec = cache?.read("sec-tickers", { now })?.data ?? null;
    if (!sec && userAgent && fetcher) {
      const page = await fetcher.get("https://www.sec.gov/files/company_tickers_exchange.json", { hosts: ["www.sec.gov"], userAgent, accept: "application/json", maxResponseBytes: 6_000_000 });
      sec = page.status === "ok" ? parseSecTickers(page.body) : null;
      if (sec) cache?.write("sec-tickers", sec, { now });
      else problems.push(`SEC's ticker list is unavailable: ${page.reason ?? page.status}`);
    } else if (!sec) problems.push("US listings need SEC_EDGAR_USER_AGENT with a contact address in .env.");
    if (sec) {
      listingsChecked.push("sec-edgar");
      listings.push(...sec.map((listing) => ({ ...listing, verification: { source: "sec-edgar", checkedAt: now.toISOString() } })));
    }
  }

  const match = matchListings(listings, query, { exchange });
  const candidates = match.candidates.slice(0, 8);
  if (match.status === "resolved" && NORDIC_EXCHANGES.has(candidates[0].exchange) && fetcher) {
    candidates[0] = await discoverNordicSources(candidates[0], { fetcher, problems });
  }
  // A company whose only listing has ended is said, never followed as if listed.
  const endedMatch = match.status === "none" ? matchListings(ended, query, { exchange }) : { candidates: [] };
  return { status: match.status, match: match.match, note: match.note ?? null, candidates, ended: endedMatch.candidates.slice(0, 4), listingsChecked, problems };
}

/** Where a Nordic company's releases and calendar can be read: MFN and Cision, found by its name. */
async function discoverNordicSources(listing, { fetcher, problems }) {
  const identifiers = { ...listing.identifiers };
  let ticker = listing.ticker;
  const slugGuess = nameKey(listing.companyName).replace(/\s+/g, "-");
  if (slugGuess) {
    const page = await fetcher.get(mfnCompanyPageUrl(slugGuess), { hosts: ["mfn.se"], accept: "text/html", maxResponseBytes: 2_000_000 });
    const parsed = page.status === "ok" ? parseMfnCompanyPage(page.body) : null;
    if (parsed && nameKey(parsed.name).split(" ")[0] === slugGuess.split("-")[0]) {
      identifiers.mfnSlug = slugGuess;
      if (parsed.entityId) {
        identifiers.mfnEntityId = parsed.entityId;
        const feed = await fetcher.get(`${MFN_FEED}${parsed.entityId}?limit=1`, { hosts: ["feed.mfn.se"], accept: "application/json" });
        const company = feed.status === "ok" ? mfnCompany(feed.body) : null;
        const mic = listing.exchange === "SSME" ? "SSME" : listing.exchange;
        const tickerTag = company?.tickers.find((tag) => tag.startsWith(`${mic}:`) || tag.startsWith(`${listing.exchange}:`));
        if (company && listing.isin && !company.isins.includes(listing.isin)) delete identifiers.mfnEntityId;
        else if (tickerTag && !ticker) ticker = normalizeTicker(tickerTag.slice(tickerTag.indexOf(":") + 1));
      }
    } else if (page.status !== "ok" && page.status !== "not_found") problems.push(`MFN could not be checked: ${page.reason ?? page.status}`);
  }
  // Cision: a search names the newsroom when the company's own releases use its name; a common
  // word such as "investor" matches everyone's releases, so the likely newsroom names are tried next.
  const search = await fetcher.get(`https://news.cision.com/ListItems?q=${encodeURIComponent(headlineName(listing))}&format=rss`, { hosts: ["news.cision.com"], accept: "application/rss+xml, application/xml" });
  const candidates = [];
  if (search.status === "ok") {
    const [best] = cisionNewsrooms(search.body, { security: listing });
    if (best && best.naming >= 2) candidates.push(best.slug);
  } else problems.push(`Cision could not be checked: ${search.reason ?? search.status}`);
  if (slugGuess) {
    const suffix = { SE: "ab", FI: "oyj", DK: "a-s", NO: "asa" }[listing.country];
    for (const guess of [slugGuess, suffix ? `${slugGuess}-${suffix}` : null]) if (guess && !candidates.includes(guess)) candidates.push(guess);
  }
  // A newsroom counts only when its own page is the company's: another company's releases can name it too.
  {
    for (const candidate of candidates.slice(0, 3)) {
      const page = await fetcher.get(`https://news.cision.com/${candidate}`, { hosts: ["news.cision.com"], accept: "text/html", maxResponseBytes: 1_000_000 });
      const name = page.status === "ok" ? cisionNewsroomName(page.body) : null;
      if (name && nameKey(name).split(" ")[0] === nameKey(listing.companyName).split(" ")[0]) {
        identifiers.cisionSlug = candidate;
        break;
      }
    }
  }
  return { ...listing, ticker, identifiers };
}

export { describeSecurity };
