/**
 * Events: what the monitor found about a watched security, normalized and
 * deduplicated.
 *
 * Every item a source returns becomes one candidate event with a type, an
 * evidence class (official disclosure, company release, news, forum), a
 * publication time and its source. Types come from fixed words in Swedish,
 * Finnish and English, never from a model, and they are only a first
 * sorting: how much an event matters is decided later, with context.
 *
 * Deduplication merges only what is provably the same item:
 *
 * - the same source document id or the same canonical URL;
 * - the same report (security, report kind and period) from several sources
 *   or languages, unless one of them is a correction, which is kept as a new
 *   version linked to the first;
 * - the same official release in two languages: same security, same type,
 *   published within ten minutes, different languages;
 * - the same normalized headline about the same security within a few days
 *   (a repost or a syndicated copy, recorded as a repeat, never as a second
 *   confirmation);
 * - a news article about a report published shortly before, recorded as
 *   coverage of that report.
 *
 * Fuzzy text similarity alone never merges two events.
 *
 * Titles are external text. They are cleaned (no markup, control characters
 * or links) and shortened, stored as data and never followed as
 * instructions. No article body is ever stored.
 */
import { createHash } from "node:crypto";

export const EVIDENCE_CLASSES = Object.freeze(["official_disclosure", "company_release", "news", "forum"]);
export const REPORT_KINDS = Object.freeze(["interim", "half_year", "year_end", "annual", "business_review", "earnings_release", "quarterly_filing", "annual_filing"]);
export const PREFILTER_LEVELS = Object.freeze(["critical", "important", "informational", "noise"]);
const TITLE_MAX = 240;
const LANGUAGE_TWIN_MS = 10 * 60_000;
const REPEAT_WINDOW_MS = 2 * 86_400_000;
const CHANNEL_WINDOW_MS = 30 * 60_000;
const COVERAGE_WINDOW_MS = 3 * 86_400_000;

// --- Text ------------------------------------------------------------------------------

const CONTROL = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}]/gu;

/** External text as one plain line: entities decoded, tags, links and control characters removed, shortened. */
export function cleanExternalText(value, { max = TITLE_MAX } = {}) {
  if (typeof value !== "string") return "";
  const text = decodeEntities(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"))
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+|\bwww\.\S+/gi, " ")
    .normalize("NFC")
    .replace(CONTROL, " ")
    .replace(/[`|\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", auml: "ä", ouml: "ö", aring: "å", Auml: "Ä", Ouml: "Ö", Aring: "Å", uuml: "ü", eacute: "é", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    }
    return named[entity] ?? match;
  });
}

/** Lower case, letters and digits only, company-name prefix removed: for exact headline comparison. */
export function headlineKey(title, { companyName = "", ticker = "" } = {}) {
  let text = String(title ?? "").normalize("NFC").toLowerCase();
  for (const prefix of [companyName, ticker].filter(Boolean)) {
    const lower = prefix.toLowerCase();
    if (text.startsWith(lower)) text = text.slice(lower.length);
  }
  return text
    .replace(/^[\s:–—-]+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A URL without fragments, tracking parameters or a trailing slash, for comparing two links. */
export function canonicalUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|fbclid$|gclid$|mc_|ref$|source$|cmpid$|ocid$)/i.test(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}

// --- Report detection ------------------------------------------------------------------

const MONTHS = {
  // English, Swedish and Finnish month stems, as they open a month range such as "January–September".
  1: ["january", "jan", "januari", "tammi", "tammikuu"],
  2: ["february", "feb", "februari", "helmi", "helmikuu"],
  3: ["march", "mar", "mars", "maalis", "maaliskuu"],
  4: ["april", "apr", "huhti", "huhtikuu"],
  5: ["may", "maj", "touko", "toukokuu"],
  6: ["june", "jun", "juni", "kesä", "kesäkuu"],
  7: ["july", "jul", "juli", "heinä", "heinäkuu"],
  8: ["august", "aug", "augusti", "elo", "elokuu"],
  9: ["september", "sep", "sept", "syys", "syyskuu"],
  10: ["october", "oct", "oktober", "okt", "loka", "lokakuu"],
  11: ["november", "nov", "marras", "marraskuu"],
  12: ["december", "dec", "joulu", "joulukuu"],
};
const MONTH_BY_WORD = new Map(Object.entries(MONTHS).flatMap(([month, words]) => words.map((word) => [word, Number(month)])));

// JavaScript's \b only knows ASCII letters, so "delårsrapport" would contain a word "årsrapport".
// Patterns here use \b as a word boundary in any script, and a pattern without a closing \b is a
// stem: "osavuosikatsau" also matches the Finnish inflections "osavuosikatsauksen" and "-kseen".
const UNICODE_BOUNDARY = String.raw`(?:(?<![\p{L}\p{N}])(?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}])(?![\p{L}\p{N}]))`;
function words(pattern) {
  return new RegExp(pattern.source.replaceAll(String.raw`\b`, UNICODE_BOUNDARY), "iu");
}

const REPORT_PATTERNS = [
  ["year_end", words(/\b(?:year[- ]end report|full[- ]year report|financial statements? (?:release|bulletin)|bokslutskommunik|tilinpäätöstiedot)/)],
  ["annual", words(/\b(?:annual (?:and sustainability )?report|integrated report|årsredovisning|års- och hållbarhetsredovisning|årsrapport|vuosikertomu|vuosiraport)/)],
  ["half_year", words(/\b(?:half[- ]year(?:ly)? (?:financial )?report|six[- ]month report|halvårsrapport|puolivuosikatsau|puolivuotiskatsau)/)],
  ["business_review", words(/\b(?:business review|liiketoimintakatsau)/)],
  ["interim", words(/\b(?:interim (?:financial )?report|interim management statement|quarterly report|q[1-4] (?:\d{4} )?report|delårsrapport|kvartalsrapport|delårsredogörelse|osavuosikatsau)/)],
  // "Results for January–September 2026": a results release with a stated period.
  ["interim", words(/\b(?:results? (?:for|of) (?:the )?(?:(?:first|second|third|fourth) quarter|q[1-4]|january|jan|full[- ]year|financial year|fiscal year|period)|resultat för (?:första|andra|tredje|fjärde|perioden|januari|helåret)|tulos (?:tammi|ensimmäiseltä|toiselta|kolmannelta|viimeiseltä))/)],
];
// Notices about a report that is still to come are calendar news, never a publication.
const NOT_YET_PUBLISHED = words(
  /\b(?:invitation|invites|inbjudan|bjuder in|kutsu|will (?:publish|present|release|report)|to (?:publish|present|release)|to be (?:published|presented|released)|publiceras|presenteras|kommer att (?:publicera|presentera)|julkaistaan|julkaisee .* (?:\d{1,2}\.\d{1,2}\.|päivänä)|webcast|telephone conference|telefonkonferens|conference call|audiocast|webbsändning|financial calendar|finansiell kalender|taloudellinen kalenteri|change of (?:date|reporting date)|changed date|date of|ändrat datum|nytt datum|datum för|päivämäärän muutos|päivämäärä)\b|\b(?:on|den|päivänä) \d{1,2}(?:st|nd|rd|th|:e|\.)? |\b\d{1,2}\.\d{1,2}\.20\d{2}\b|\bon (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(?:måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag)(?:en)? den\b|\b(?:maanantaina|tiistaina|keskiviikkona|torstaina|perjantaina)\b|\bat \d{1,2}[:.]\d{2}\s*(?:a\.?m\.?|p\.?m\.?|eet|eest|cet|cest|gmt|utc)\b|\bkl\.? \d{1,2}[:.]\d{2}\b|\bklo \d{1,2}[:.]\d{2}\b|\b\d{1,2}\.\s*(?:tammi|helmi|maalis|huhti|touko|kesä|heinä|elo|syys|loka|marras|joulu)kuuta\b/,
);
const CORRECTION = words(/^(?:correction|rättelse|korrigering|oikaisu|korjaus)\b|\((?:corrected|correction|rättad|korrigerad|oikaistu|korjattu)\)|\bcorrection to\b|\brättelse av\b|\boikaisu\b/);

/**
 * The report a headline announces as published, or null. Returns `{ kind,
 * fiscalYear, period, months, correction }`: period is Q1–Q4, H1 or FY when
 * the headline says it, and months the stated month range. An invitation or
 * a date notice is not a report.
 */
export function detectReport(title, { notice = false } = {}) {
  const text = String(title ?? "");
  // `notice` reads which report a date notice is about; a published report is never read from a notice.
  if (!notice && NOT_YET_PUBLISHED.test(text)) return null;
  const kind = REPORT_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0];
  if (!kind) return null;
  const months = monthRange(text);
  const year = reportYear(text, months);
  const quarter =
    /\bq([1-4])\b/i.exec(text)?.[1] ??
    /\b(first|second|third|fourth) quarter\b/i.exec(text)?.[1] ??
    /\b(första|andra|tredje|fjärde) kvartalet\b/i.exec(text)?.[1] ??
    /(?<!\p{L})(ensimmäisen|toisen|kolmannen|neljännen) (?:vuosi)?neljännek/iu.exec(text)?.[1] ??
    null;
  const ordinals = { first: 1, second: 2, third: 3, fourth: 4, första: 1, andra: 2, tredje: 3, fjärde: 4, ensimmäisen: 1, toisen: 2, kolmannen: 3, neljännen: 4 };
  const quarterNumber = quarter ? ordinals[String(quarter).toLowerCase()] ?? Number(quarter) : null;
  let period = quarterNumber ? `Q${quarterNumber}` : null;
  if (!period && months && months.from === 1) period = { 3: "Q1", 6: "H1", 9: "Q3", 12: "FY" }[months.to] ?? null;
  if (!period && months && months.to - months.from === 2) period = `Q${months.to / 3}`;
  if (!period && (kind === "year_end" || kind === "annual")) period = "FY";
  if (!period && kind === "half_year") period = "H1";
  if (period && !/^Q[1-4]$|^H1$|^FY$/.test(period)) period = null;
  return { kind, fiscalYear: year, period, months, correction: CORRECTION.test(text) };
}

// Month names as a single date writes them: English and Swedish, and Finnish in the partitive
// a date uses ("28. lokakuuta"). The Finnish stems above only open ranges ("tammi–syyskuu").
const FINNISH_DATE_MONTHS = ["tammikuuta", "helmikuuta", "maaliskuuta", "huhtikuuta", "toukokuuta", "kesäkuuta", "heinäkuuta", "elokuuta", "syyskuuta", "lokakuuta", "marraskuuta", "joulukuuta"];
const MONTH_NAMES = new Map([
  ...Object.entries(MONTHS).flatMap(([month, names]) => names.filter((name) => name.length >= 3 && !/kuu$/.test(name) && !["tammi", "helmi", "maalis", "huhti", "touko", "kesä", "heinä", "elo", "syys", "loka", "marras", "joulu"].includes(name)).map((name) => [name, Number(month)])),
  ...FINNISH_DATE_MONTHS.map((name, index) => [name, index + 1]),
]);

/**
 * The day a notice says a report comes out: "on 23 October 2026", "den 23
 * oktober", "October 23, 2026", "23.10.2026" or "2026-10-23". Without a year,
 * the first such day on or after the notice. Null when no single day is named.
 */
export function noticeDate(title, { publishedAt = null } = {}) {
  const text = String(title ?? "").toLowerCase();
  const iso = (year, month, day) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const valid = (year, month, day) => month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
  let found = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  if (found && valid(Number(found[1]), Number(found[2]), Number(found[3]))) return iso(found[1], Number(found[2]), Number(found[3]));
  found = /(?<!\d)(\d{1,2})\.(\d{1,2})\.(20\d{2})?(?!\d)/.exec(text);
  let day;
  let month;
  let year = null;
  if (found) [day, month, year] = [Number(found[1]), Number(found[2]), found[3] ? Number(found[3]) : null];
  else {
    // A day that opens or closes a period ("1 januari – 30 september") is not the publication day.
    const dayMonth = [...text.matchAll(/(?<![\p{L}\d])(\d{1,2})(?:st|nd|rd|th|:e|\.)?\s+(?:of\s+)?(\p{L}{3,12})(?:\s+(20\d{2}))?(?!\p{L})/gu)]
      .filter((match) => MONTH_NAMES.has(match[2]))
      .filter((match) => !/^\s*[-–—]/.test(text.slice(match.index + match[0].length)) && !/[-–—]\s*$/.test(text.slice(0, match.index)))
      .at(-1);
    const monthDay = /(?<!\p{L})(\p{L}{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})(?!\d)/u.exec(text);
    if (dayMonth) [day, month, year] = [Number(dayMonth[1]), MONTH_NAMES.get(dayMonth[2]), dayMonth[3] ? Number(dayMonth[3]) : null];
    else if (monthDay && MONTH_NAMES.has(monthDay[1])) [day, month, year] = [Number(monthDay[2]), MONTH_NAMES.get(monthDay[1]), Number(monthDay[3])];
    else return null;
  }
  if (year === null) {
    const from = publishedAt ? new Date(publishedAt) : null;
    if (!from || !Number.isFinite(from.getTime())) return null;
    year = from.getUTCFullYear();
    if (iso(year, month, day) < from.toISOString().slice(0, 10)) year += 1;
  }
  return valid(year, month, day) ? iso(year, month, day) : null;
}

/** "January–September 2026" or "1 januari–30 september" → { from: 1, to: 9 }; null without a clear range. */
export function monthRange(text) {
  for (const match of text.toLowerCase().matchAll(/(?<!\p{L})(\p{L}{3,10})\.?\s*(?:[-–—]|to|till|until)\s*(?:\d{1,2}\.?\s*)?(\p{L}{3,10})(?!\p{L})/gu)) {
    const from = MONTH_BY_WORD.get(match[1]);
    const to = MONTH_BY_WORD.get(match[2]);
    if (from && to) return { from, to };
  }
  return null;
}

/** The fiscal year a headline names: "2026", or the later year of "2025/2026". */
function reportYear(text) {
  const split = /\b(20\d{2})\s*\/\s*(20\d{2}|\d{2})\b/.exec(text);
  if (split) return split[2].length === 2 ? Number(`20${split[2]}`) : Number(split[2]);
  const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
  return years.length > 0 ? Math.max(...years) : null;
}

// --- Corporate event types ---------------------------------------------------------------

/**
 * Event types from fixed words, most specific first. The prefilter level is a
 * first guess that only orders work: a report is "important", a trading halt
 * "critical", a routine notice "informational". Context decides later.
 */
const TYPE_RULES = [
  ["trading_suspension", "critical", words(/\b(?:trading halt|halted|suspension of trading|suspended from trading|handelsstopp|observation status|observationsstatus|kaupankäynnin keskeyt|kaupankäynti keskeyte|tarkkailulistal|tarkkailuluettelo)/)],
  ["delisting", "critical", words(/\b(?:delist|avnoter|avregistrer|listalta poist|pörssilistalta poist|poistetaan pörssilistalta)/)],
  ["insolvency", "critical", words(/\b(?:bankruptcy|insolvency|konkurs|rekonstruktion|företagsrekonstruktion|yrityssaneerau|chapter 11|administration proceedings)/)],
  ["profit_warning", "critical", words(/\b(?:profit warning|vinstvarning|tulosvaroitu|negativ resultatavvikelse|lowers? (?:its )?(?:full[- ]year )?(?:outlook|guidance|forecast)|cuts? (?:its )?(?:outlook|guidance|forecast)|sänker (?:sin |sina )?(?:prognos|utsikter)|laskee (?:tulos)?ohjeistu|heikentää (?:tulos)?ohjeistu|alentaa (?:tulos)?ohjeistu|downgrades? (?:its )?(?:outlook|guidance))/)],
  ["takeover_offer", "critical", words(/\b(?:public (?:cash |tender )?offer|tender offer|takeover bid|offentligt uppköpserbjudande|uppköpserbjudande|julkinen ostotarjou|julkinen vaihtotarjou|ostotarjou)/)],
  ["rights_issue", "critical", words(/\b(?:rights issue|företrädesemission|nyemission med företrädesrätt|merkintäoikeusanti|osakeanti merkintäoikeuksin|claims issue)/)],
  ["guidance_upgrade", "important", words(/\b(?:raises? (?:its )?(?:full[- ]year )?(?:outlook|guidance|forecast)|upgrades? (?:its )?(?:outlook|guidance)|höjer (?:sin |sina )?(?:prognos|utsikter)|nostaa (?:tulos)?ohjeistu|parantaa (?:tulos)?ohjeistu|positiv resultatavvikelse|positiivinen tulosvaroitu)/)],
  ["guidance_change", "important", words(/\b(?:revised? (?:outlook|guidance)|updated? (?:outlook|guidance)|new (?:outlook|guidance)|(?:changes|updates|specifies) (?:its )?(?:outlook|guidance)|ändrad prognos|ny prognos|uppdaterad prognos|ändrar (?:sin )?prognos|tarkentaa (?:tulos)?ohjeistu|muuttaa (?:tulos)?ohjeistu|päivittää (?:tulos)?ohjeistu|tulosohjeistu)/)],
  ["share_issue", "important", words(/\b(?:directed (?:share )?issue|share issue|new share issue|issue of new shares|private placement|riktad nyemission|riktad emission|nyemission|kvittningsemission|suunnattu osakeanti|suunnattu anti|osakeanti|convertible|konvertib|vaihtovelkakirj|warrants? issue|teckningsoptioner|optio-oikeu)/)],
  ["acquisition", "important", words(/\b(?:acquires|acquisition|to acquire|agreed to acquire|merger|förvärv|fusion|yrityskaup|yritysosto|sulautu)/)],
  ["divestment", "important", words(/\b(?:divests?|divestment|divestiture|sells? (?:its |the )?(?:business|unit|subsidiary|division|stake)|avyttr|säljer (?:sitt |sin |dotterbolag|verksamhet)|myy (?:liiketoimintansa|tytäryhtiö)|luopuu)/)],
  ["management_change", "important", words(/\b(?:ceo|chief executive|cfo|chief financial|vd|verkställande direktör|koncernchef|finansdirektör|toimitusjohtaj|talousjohtaj)\b.*\b(?:resign|steps down|leaves|leaving|appoint|new|to leave|lämnar|avgår|utse|ny|tillträder|ero|jättää|nimit|uusi)|\b(?:resign|steps down|appoint|new|lämnar|avgår|utse|ny|ero|nimit|uusi)\b.*\b(?:ceo|chief executive|cfo|vd|verkställande direktör|koncernchef|finansdirektör|toimitusjohtaj|talousjohtaj)/)],
  ["major_order", "important", words(/\b(?:receives? (?:an? )?(?:major |large |significant )?order|wins? (?:an? )?(?:major |large )?(?:order|contract)|signs? (?:an? )?(?:major |large )?(?:contract|agreement)|order worth|contract worth|erhåller (?:en )?(?:stor |större )?order|tecknar (?:avtal|order)|vinner (?:upphandling|order)|saa (?:merkittävän |suuren )?tilaukse|toimitussopimu)/)],
  ["litigation", "important", words(/\b(?:lawsuit|litigation|court|arbitration|class action|ruling|verdict|stämning|stämmer|domstol|tingsrätt|hovrätt|skiljedom|skiljeförfarande|oikeudenkäyn|kanne|tuomioistuin|välimiesmenettel|oikeuden päätö)/)],
  ["regulatory", "important", words(/\b(?:regulator|regulatory decision|authority|competition authority|fda|ema|approval|approves|approved|license|licence|fined?|sanction|investigation|myndighet|konkurrensverket|finansinspektionen|godkännande|godkänner|tillstånd|sanktionsavgift|utredning|viranomai|kilpailuvirasto|finanssivalvonta|hyväksyn|hyväksyi|lupa|seuraamusmaksu|tutkinta)\b/)],
  ["dividend", "informational", words(/\b(?:dividend|utdelning|osinko|osingo)/)],
  ["buyback", "informational", words(/\b(?:buy-?back|repurchase|återköp|own shares|egna aktier|omien osakkei|omia osakkeita)/)],
  ["shareholder_meeting", "informational", words(/\b(?:annual general meeting|extraordinary general meeting|general meeting|agm|egm|årsstämma|bolagsstämma|yhtiökokou|kallelse|notice of)\b/)],
  ["board_change", "informational", words(/\b(?:board of directors|board member|chairman|chair of the board|nomination committee|styrelse|valberedning|hallitu|nimitystoimikun)/)],
  ["insider_transaction", "informational", words(/\b(?:managers[’']? transactions?|insider transaction|insynshandel|insynspersoners transaktioner|johdon liiketoim|pdmr)/)],
  ["major_holding", "informational", words(/\b(?:flagging|flaggning|major shareholder|notification of major holding|change in holding|liputusilmoitu|omistusosuuden muutos)/)],
  ["capital_markets_day", "informational", words(/\b(?:capital markets day|kapitalmarknadsdag|pääomamarkkinapäiv|investor day)/)],
];
const INSIDE_INFORMATION = words(/\b(?:inside information|insiderinformation|sisäpiiritie)/);
const REPORT_WORDS = words(/(?:report|rapport|katsau|tiedot|results?|resultat|tulos|\bq[1-4]\b)/);

/**
 * Type and prefilter level of an official or company item. `category` is the
 * source's own category, such as Nasdaq's "Inside information", when it has one.
 */
export function classifyDisclosure(title, { category = "" } = {}) {
  const report = detectReport(title);
  if (report) return { type: "report", report, prefilter: "important", insideInformation: INSIDE_INFORMATION.test(`${category} ${title}`) };
  const insideInformation = INSIDE_INFORMATION.test(`${category} ${title}`);
  if (NOT_YET_PUBLISHED.test(title) && REPORT_WORDS.test(title)) {
    return { type: "report_notice", report: null, prefilter: "informational", insideInformation };
  }
  for (const [type, level, pattern] of TYPE_RULES) {
    if (pattern.test(title)) {
      // Inside information lifts an informational type one step: the company itself judged it price-sensitive.
      const prefilter = insideInformation && level === "informational" ? "important" : level;
      return { type, report: null, prefilter, insideInformation };
    }
  }
  return { type: "other_disclosure", report: null, prefilter: insideInformation ? "important" : "informational", insideInformation };
}

// --- Events --------------------------------------------------------------------------------

/** A deterministic event id: the same first key always gives the same id, so retries and restarts never duplicate. */
export function eventId(key) {
  return `ev-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/**
 * One key per published report. A half-year report is the second quarter's
 * results and a year-end report the fourth's, whatever a source calls them,
 * so "Half-year report January–June" and a distributor's "interim, Q2" tag
 * meet. The annual report is a separate document from the year-end report.
 */
export function reportIdentity(report) {
  if (!report || !report.fiscalYear || (!report.period && !report.months)) return null;
  const period = report.period ? ({ H1: "Q2", FY: "Q4" }[report.period] ?? report.period) : `M${report.months.from}-${report.months.to}`;
  return `${report.kind === "annual" ? "annual" : "results"}:${report.fiscalYear}:${period}`;
}

function reportKey(watchId, report) {
  const identity = reportIdentity(report);
  return identity ? `report:${watchId}:${identity}` : null;
}

/**
 * One source item as a candidate event. `item`: { sourceKey, sourceName,
 * evidence, documentId, url, title, publishedAt, language, category,
 * publisher }. Returns null when the item has no usable title.
 */
export function normalizeItem(item, { watchId, security, now }) {
  const title = cleanExternalText(item.title);
  if (!title) return null;
  const evidence = EVIDENCE_CLASSES.includes(item.evidence) ? item.evidence : "news";
  const official = evidence === "official_disclosure" || evidence === "company_release";
  let classification = official ? classifyDisclosure(title, { category: item.category ?? "" }) : { type: evidence === "forum" ? "forum_discussion" : "news_article", report: null, prefilter: "informational", insideInformation: false };
  // A source's own structured tags, such as a distributor's "interim report, Q1" or "MAR", beat words in a headline.
  if (official && item.report && REPORT_KINDS.includes(item.report.kind)) {
    const fromTitle = classification.report;
    classification = {
      ...classification,
      type: "report",
      prefilter: "important",
      report: {
        kind: item.report.kind,
        fiscalYear: item.report.fiscalYear ?? fromTitle?.fiscalYear ?? null,
        period: item.report.period ?? fromTitle?.period ?? null,
        months: fromTitle?.months ?? null,
        correction: Boolean(fromTitle?.correction || CORRECTION.test(title)),
      },
    };
  }
  if (official && item.insideInformation === true && !classification.insideInformation) {
    classification = { ...classification, insideInformation: true, prefilter: classification.prefilter === "informational" ? "important" : classification.prefilter };
  }
  // The monitor's own note that an announced report date moved; its text is Hilla's, not a source's.
  if (item.calendarChange === true) classification = { type: "report_date_changed", report: null, prefilter: "informational", insideInformation: false };
  const url = canonicalUrl(item.url);
  const publishedMs = Date.parse(item.publishedAt ?? "");
  const published = Number.isFinite(publishedMs) ? new Date(publishedMs).toISOString() : null;
  const report = reportKey(watchId, classification.report);
  return {
    title,
    titleKey: headlineKey(title, security),
    type: classification.type,
    report: classification.report,
    prefilter: classification.prefilter,
    insideInformation: classification.insideInformation,
    evidence,
    language: typeof item.language === "string" && /^[a-z]{2}$/.test(item.language) ? item.language : null,
    publishedAt: published,
    discoveredAt: now.toISOString(),
    source: {
      key: item.sourceKey,
      name: item.sourceName,
      documentId: typeof item.documentId === "string" && item.documentId.length <= 200 ? item.documentId : null,
      url,
      publisher: item.publisher ? cleanExternalText(item.publisher, { max: 80 }) : null,
      category: item.category ? cleanExternalText(item.category, { max: 80 }) : null,
      // Links to the documents the release carries (the report PDF, the filing), https only.
      documents: (Array.isArray(item.attachments) ? item.attachments : []).filter((link) => typeof link === "string" && /^https:\/\//.test(link) && link.length <= 500).slice(0, 5),
    },
    keys: [
      item.documentId ? `doc:${item.sourceKey}:${item.documentId}` : null,
      // A source's own grouping of one release's language versions.
      typeof item.groupId === "string" && item.groupId.length <= 100 ? `group:${item.sourceKey}:${item.groupId}` : null,
      url ? `url:${url}` : null,
      // A correction is its own version of the report: its language versions share a key, the original's never.
      report ? (classification.report.correction ? `${report}:correction:${(published ?? now.toISOString()).slice(0, 10)}` : report) : null,
    ].filter(Boolean),
  };
}

/**
 * Merges candidates into a security's stored events. Returns `{ events, added,
 * merged }` without mutating the input: `added` are the new events, `merged`
 * the existing ones that gained a source, a language version or a repeat.
 * `baseline` marks everything found on a source's first successful check, so
 * history is never reported as new.
 */
export function mergeEvents(existing, candidates, { watchId, baseline = false, now }) {
  const events = existing.map((event) => ({ ...event, sources: [...event.sources], keys: [...event.keys] }));
  const byKey = new Map();
  for (const event of events) for (const key of event.keys) byKey.set(key, event);
  const added = [];
  const merged = new Set();

  for (const candidate of candidates) {
    const sameKey = candidate.keys.map((key) => byKey.get(key)).find(Boolean);
    const twin = sameKey ?? findTwin(events, candidate);
    if (twin) {
      if (absorb(twin, candidate)) merged.add(twin.id);
      for (const key of candidate.keys) byKey.set(key, twin);
      continue;
    }
    const covered = candidate.evidence === "news" ? findCoveredReport(events, candidate) : null;
    if (covered) {
      if (absorb(covered, candidate, { as: "coverage" })) merged.add(covered.id);
      for (const key of candidate.keys) byKey.set(key, covered);
      continue;
    }
    const firstKey = candidate.keys[0] ?? `title:${watchId}:${candidate.titleKey}:${candidate.publishedAt ?? candidate.discoveredAt}`;
    const correctionOf = candidate.report?.correction ? findCorrected(events, candidate) : null;
    const event = {
      id: eventId(`${watchId}|${firstKey}`),
      watchId,
      type: candidate.type,
      title: candidate.title,
      titleKey: candidate.titleKey,
      evidence: candidate.evidence,
      prefilter: candidate.prefilter,
      insideInformation: candidate.insideInformation,
      report: candidate.report ? { ...candidate.report, documentRetrieved: null } : null,
      correctionOf: correctionOf?.id ?? null,
      language: candidate.language,
      publishedAt: candidate.publishedAt,
      discoveredAt: candidate.discoveredAt,
      baseline,
      sources: [{ ...candidate.source, title: candidate.title, language: candidate.language, publishedAt: candidate.publishedAt, role: "original" }],
      keys: [...new Set([...candidate.keys, `id-seed:${firstKey}`])],
    };
    if (events.some((existingEvent) => existingEvent.id === event.id)) continue;
    events.push(event);
    added.push(event);
    for (const key of event.keys) byKey.set(key, event);
    // News about this report found before it (a source checked earlier) becomes its coverage too.
    if (event.type === "report" && event.evidence !== "news") {
      for (const news of coveringNews(events, event)) {
        absorb(event, { ...news, source: news.sources[0], keys: news.keys, title: news.title }, { as: "coverage" });
        for (const source of news.sources.slice(1)) event.sources.push({ ...source, role: "coverage" });
        for (const key of news.keys) byKey.set(key, event);
        events.splice(events.indexOf(news), 1);
        if (added.includes(news)) added.splice(added.indexOf(news), 1);
        merged.delete(news.id);
      }
    }
  }
  return { events, added, merged: [...merged].map((id) => events.find((event) => event.id === id)).filter(Boolean) };
}

const isCorrection = (entry) => Boolean(entry.report?.correction);

/** The same release in another language, or a repost or syndicated copy of the same headline. */
function findTwin(events, candidate) {
  const at = Date.parse(candidate.publishedAt ?? "");
  const official = candidate.evidence === "official_disclosure" || candidate.evidence === "company_release";
  for (const event of events) {
    // A correction and the release it corrects stay two versions.
    if (isCorrection(event) !== isCorrection(candidate)) continue;
    const eventAt = Date.parse(event.publishedAt ?? "");
    const close = (window) => Number.isFinite(at) && Number.isFinite(eventAt) && Math.abs(at - eventAt) <= window;
    const eventOfficial = event.evidence === "official_disclosure" || event.evidence === "company_release";
    if (official && eventOfficial && candidate.type === event.type && candidate.language && event.language && candidate.language !== event.language && close(LANGUAGE_TWIN_MS)) return event;
    if (!candidate.titleKey || candidate.titleKey !== event.titleKey || official !== eventOfficial) continue;
    // The same headline proves the same item only in narrow cases. An official release is the same one
    // when another channel (the exchange, a distributor) carries it within half an hour; from the same
    // channel, a new id is a new release, such as this week's "Managers' transactions". A news headline
    // is a syndicated copy when another publisher carries it within two days.
    if (official && !event.sources.some((source) => source.key === candidate.source.key) && close(CHANNEL_WINDOW_MS)) return event;
    if (!official && close(REPEAT_WINDOW_MS) && differentPublisher(candidate, event)) return event;
  }
  return null;
}

function differentPublisher(candidate, event) {
  const publisher = (source) => String(source.publisher ?? source.key ?? "").toLowerCase();
  return !event.sources.some((source) => publisher(source) === publisher(candidate.source));
}

/** A report published shortly before, which a news headline about the same period's results most likely covers. */
const REPORT_NEWS = words(/\b(?:report|results?|earnings|quarter|q[1-4]|rapport|resultat|kvartal|delårs|tulos|katsau|neljännek|osavuosi)/);

/**
 * News that covers a report: about results and published from an hour before
 * the report to three days after, or with the report's own headline within
 * two days either side (a news site repeating the release, whatever its clock says).
 */
function coveringNews(events, report) {
  const reportAt = Date.parse(report.publishedAt ?? "");
  if (!Number.isFinite(reportAt)) return [];
  return events.filter((event) => {
    if (event.evidence !== "news") return false;
    const at = Date.parse(event.publishedAt ?? event.discoveredAt);
    if (event.titleKey && event.titleKey === report.titleKey && Math.abs(at - reportAt) <= 2 * 86_400_000) return true;
    return REPORT_NEWS.test(event.title) && at >= reportAt - 3_600_000 && at - reportAt <= COVERAGE_WINDOW_MS;
  });
}

function findCoveredReport(events, candidate) {
  const at = Date.parse(candidate.publishedAt ?? candidate.discoveredAt);
  // A news copy of an official release, by its exact headline.
  const copy = events.find((event) => event.evidence !== "news" && event.evidence !== "forum" && candidate.titleKey && event.titleKey === candidate.titleKey && Math.abs(Date.parse(event.publishedAt ?? event.discoveredAt) - at) <= 2 * 86_400_000);
  if (copy) return copy;
  if (!REPORT_NEWS.test(candidate.title)) return null;
  return events
    .filter((event) => event.type === "report" && Number.isFinite(Date.parse(event.publishedAt ?? "")))
    .filter((event) => at >= Date.parse(event.publishedAt) - 3_600_000 && at - Date.parse(event.publishedAt) <= COVERAGE_WINDOW_MS)
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))[0] ?? null;
}

function findCorrected(events, candidate) {
  const identity = reportIdentity(candidate.report);
  if (!identity) return null;
  return events.find((event) => event.type === "report" && !event.correctionOf && !isCorrection(event) && reportIdentity(event.report) === identity) ?? null;
}

/** Adds the candidate's source to an event. `as`: original (another source of the same item), language, repeat or coverage. */
function absorb(event, candidate, { as } = {}) {
  const official = (entry) => entry.evidence === "official_disclosure" || entry.evidence === "company_release";
  // The exchange's notice and the company's own release of the same item are both sources of it; only news or talk about it is coverage.
  const role =
    as ??
    (candidate.evidence !== event.evidence && !(official(candidate) && official(event))
      ? "coverage"
      : candidate.language && event.language && candidate.language !== event.language
        ? "language_version"
        : candidate.source.key === event.sources[0]?.key || candidate.titleKey === event.titleKey
          ? "repeat"
          : "original");
  const already = event.sources.some(
    (source) => (candidate.source.documentId && source.key === candidate.source.key && source.documentId === candidate.source.documentId) || (candidate.source.url && source.url === candidate.source.url),
  );
  for (const key of candidate.keys) if (!event.keys.includes(key)) event.keys.push(key);
  if (already) return false;
  event.sources.push({ ...candidate.source, title: candidate.title, language: candidate.language, publishedAt: candidate.publishedAt, role });
  // The earliest publication time and an official source's evidence win.
  if (candidate.publishedAt && (!event.publishedAt || candidate.publishedAt < event.publishedAt) && role !== "coverage" && role !== "repeat") event.publishedAt = candidate.publishedAt;
  if (event.report && candidate.report && !event.report.fiscalYear && candidate.report.fiscalYear) event.report = { ...event.report, fiscalYear: candidate.report.fiscalYear };
  return true;
}

/** How many separate publishers carried an event. Repeats and syndicated copies of one headline count once. */
export function independentSourceCount(event) {
  const publishers = new Set();
  for (const source of event.sources) {
    if (source.role === "repeat") continue;
    publishers.add(source.publisher ?? source.key);
  }
  return publishers.size;
}
