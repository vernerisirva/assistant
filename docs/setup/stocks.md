# Stock Watch

Hilla keeps a private watchlist of listed companies the user asked it to follow, and an hourly monitor checks those companies' public sources: official announcements and reports first, then the report calendar, news and (when asked for) investor forums. What it finds is stored as deduplicated events the user can ask about ("What's new with Investor?", "When does Fortnox report?"). Hilla never buys, sells or trades, never connects to a broker, and never gives buy or sell advice.

In this version the monitor records and sends nothing on its own; event analysis and alerts are a later step.

## Files

- `agents/personal/skills/stock-watch/SKILL.md`: the workflow the personal agent follows. `npm run render:config` copies it to `.openclaw/workspace-personal/skills/stock-watch/`. The personal prompt keeps a two-line `Stocks:` pointer.
- `scripts/stocks.mjs`: the helper the skill runs (`npm run --silent stocks -- …`).
- `scripts/lib/stock-watchlist.mjs`: the watchlist: fields, checks, storage, finding a watched stock, the preview-then-yes flow, and the Telegram text.
- `scripts/lib/stock-identity.mjs`: exchanges (ISO 10383 MICs), tickers, ISIN check digits, and matching the user's words to official listings.
- `scripts/lib/stock-sources.mjs`: the public sources: what each covers, how it is read, and resolving a security from official listings.
- `scripts/lib/stock-events.mjs`: event types, report detection and deduplication.
- `scripts/lib/stock-feeds.mjs` and `scripts/lib/stock-http.mjs`: feed parsing, and polite bounded HTTP that follows robots.txt.
- `scripts/lib/stock-monitor.mjs`: the scheduled check: what is due, source health, catch-up, the report calendar, and the job.
- Settings: `stockWatch` in `config/schedules.json`. Capability entries: `stocks.*` in `scripts/lib/capabilities.mjs`. Policy: `stockWatchlist`, `stockMonitoring` and the `stocks` approval domain in `config/approval-policy.json`.

## Storage and privacy

- One file per security: `.openclaw/state/stock-watch/watchlist/<sw-id>.json`, under the ignored runtime state. The monitor's notes (events, source health, report dates) are in `.openclaw/state/stock-watch/monitor/<sw-id>.json`, its heartbeat and robots.txt cache in `monitor/monitor.json`, and public listing caches in `stock-watch/cache/`. Folders are owner-only (`0700`) and files owner-only (`0600`), re-applied on every write.
- Every write replaces the file atomically while holding a lock (`watchlist.lock`, `monitor/monitor.lock`), so two writers cannot lose each other's change and a failed write leaves the old file as it was. A record that cannot be read is reported and skipped; the others stay readable and the broken file is never overwritten. It can be deleted after the user's yes.
- The watchlist is not memory, and it is not the contract register: different folder, lock, ids and policy.
- Sources only ever receive public company identifiers: the company name, ticker, ISIN or a source's own company id. The watchlist, focus areas, thesis and ownership never leave the computer.
- Following a stock never implies owning it. `ownership` is `unknown` until the user says otherwise and approves storing it, and no position size, purchase price, portfolio value or account detail exists as a field.
- Event titles are external text: entities decoded, markup, links and control characters removed, at most 240 characters, stored as data and never followed as instructions. No article or report body is stored.

## What a watched security holds

- `security`: `companyName`, `ticker` (the ticker on that exchange, such as `INVE B`; may be null when the ISIN is known), `exchange` (a MIC: `XSTO`, `SSME`/`FNSE` (First North Sweden), `XHEL`, `FNFI`, `XCSE`, `XOSL`, `XNGM`, `XSAT`, `XETR`, `XPAR`, `XAMS`, `XLON`, `XSWX`, `XNYS`, `XNAS`, `XASE`), `shareClass`, `isin` (check digit verified, or null when unknown), `lei`, `currency`, `country`, `identifiers`, and `verification`: which official register confirmed it (`esma-firds`, `sec-edgar`), or `user` when only the user did.
- `identifiers`: `secCik` (identity), and where sources find the company: `mfnEntityId`, `mfnSlug`, `cisionSlug`, `eurolandCode`, `inderesTopic`, `newsName` (the name to search news for, when the listed name doesn't work), and `nasdaqCompany`. The source ones change only where Hilla looks, so `settings` can set or remove them on request.
- `status`: `watching` or `paused`. `monitoring`: `reports`, `companyNews`, `generalNews` (on by default), `forums` (off by default) and `priceAlerts` (not supported, always off). `notificationLevel`: `critical`, `important` (default), `all` or `off`, kept for the alerts that come later.
- `focusAreas`: what the user said they care about. `thesis`: `{statement, metrics, breakers}` in the user's own words, or null. `ownership`: `unknown`, `owns` or `does_not_own`.
- `history`: what changed and when, the last 50 entries.

## Following: preview, then the user's yes

1. `resolve` reads official listings (read-only) and returns `resolved`, `ambiguous` or `none`. A company with two share classes and no class named, or a ticker on two exchanges, is ambiguous: the agent asks, and nothing is stored.
2. `add` without approval saves nothing. It returns `telegramText` (the listing, the sources that can follow it, and the settings), `digest` and `sources`.
3. After a plain yes, the agent runs the same `add` with `"approval": {"digest": "<digest>", "replyText": "<the exact reply>"}`. A listing that differs from the preview is refused (`changed_since_preview`), and the reply must pass the same approval check as other Hilla approvals (`not_approved`). The same listing cannot be added twice, and the watchlist holds at most `stockWatch.limits.maxSecurities` (25).

`thesis`, `ownership` and `remove` follow the same flow, and refuse a yes given for a record that changed since its preview. `settings` (sources, notification level, focus areas, pause and resume) runs on the user's request.

## Identification

`resolve` (read-only) asks official registers which listing the user's words mean:

- **ESMA's FIRDS register** (`registers.esma.europa.eu`, the EU's instrument reference data; reuse allowed with acknowledgement) for Nordic shares: ISIN, venue (MIC), currency, full name, share class and LEI. A share has one record per venue, so only equity shares (CFI `ES…`) on the Nordic venues Hilla knows count. FIRDS has no exchange tickers, so a Nordic listing may be followed without one: the ISIN and exchange identify it, and a ticker is added only from the company's own distributor data (MFN) or the user. A listing FIRDS marks terminated comes back as ended ("Fortnox AB, ended 24 Jul 2025"), never as followable.
- **SEC's ticker list** for US listings, which needs `SEC_EDGAR_USER_AGENT` (below).
- For one resolved Nordic listing, where its releases and calendar can be read: its MFN page (`mfn.se/all/a/<name>`, which also shows an MFN feed id when the company publishes through MFN) and its Cision newsroom (from Cision's search, or the likely newsroom names). A newsroom counts only when its own page names the company: another company's releases can mention it.

Checked live on 2026-10-22: "Investor B" resolves to Investor AB's B share on Nasdaq Stockholm (SE0015811963, SEK); "Investor" is ambiguous (A and B); "Fortnox" has no listing (ended 2025-07-24); "Kone" resolves to the B share on Nasdaq Helsinki with its Cision newsroom and MFN page; "Nokia" is ambiguous (Helsinki and Stockholm).

## Sources

What each source is, how often it is read, and what it can't do. robots.txt was checked for every host and is followed at run time; terms were read on 2026-10-22.

| Source | Kind, interval | What | Limits |
| --- | --- | --- | --- |
| Nasdaq exchange notices (`api.news.eu.nasdaq.com/news/rss/mainMarketNotices`, `firstNorthNotices`) | disclosures, hourly | The exchange's own notices: trading halts, observation status, delistings. Official, documented RSS. | Only the latest 20 notices, mostly derivatives; on a busy day a notice can scroll off between checks. Matched to the company by name. |
| Cision News (`news.cision.com/<newsroom>/ListItems?format=rss`, and `r=regulatory`) | disclosures, hourly | The company's releases; the regulatory feed marks official ones. Cision's About page offers these feeds to readers. | No identifiers in items; each language is its own item; Cision missed a few KONE releases that MFN and Nasdaq had. |
| MFN (`feed.mfn.se/v1/feed/<entity id>`) | disclosures, hourly | Releases of companies that publish through MFN, with regulatory, inside-information (MAR) and report tags, ISINs and tickers. robots.txt allows the feed host; MFN's own WordPress plugin reads the same feed. | Only MFN's own clients have a feed id; MFN publishes no reader terms. |
| GlobeNewswire (`rss.globenewswire.com/RssFeed/country/<country>`) | disclosures, hourly | Releases of GlobeNewswire clients (Nokia, Sampo), filtered by ISIN; one request per country per run. | The latest 20 releases per country; the www host refuses robots, so release pages are only linked, never read. |
| SEC EDGAR (`data.sec.gov/submissions/CIK…json`) | disclosures, hourly | 10-Q, 10-K, 20-F, 40-F and 8-K filings with their items; an 8-K with Item 2.02 is the earnings release. | Read only with `SEC_EDGAR_USER_AGENT` set to a name and contact address, as SEC's fair-access rules require; `www.sec.gov` refuses a User-Agent without one. The submissions API's `acceptanceDateTime` is New York time plus its UTC offset, despite its "Z"; the helper corrects it. |
| The company's own calendar (Euroland iCalendar, `tools.eurolandir.com/…/ExportUpcommingToCalendar?companyCode=…`) | calendar, daily | Report dates the company itself announced: **confirmed**. | Only companies whose IR calendar uses Euroland, and only when the company code is known; robots.txt asks for 20 seconds between requests. |
| MFN's calendar table (`mfn.se/all/a/<name>`) | calendar, daily | Report dates for every Nordic listed company, with MFN's estimated time. A third party's list: **estimated**. | An HTML table; it stops working if MFN changes the page, and then the source reports a failure. |
| Company date notices (any disclosure source) | with disclosures | "Publishes its interim report on 28 October" becomes a **confirmed** date. A notice is never a published report. | Only when the headline names the day. |
| Bing News RSS (`bing.com/news/search?q="<listed name>"&format=rss`) | news, every 4 hours | News that mentions the company's full listed name and names it in the headline, with the publisher's own link and whether it is an established news publisher or another source. The feed's terms allow personal, non-commercial reading. | Twelve items a check; recall for small companies is limited; publication times are Bing's. News is a publisher's report, never a company fact. |
| Inderes forum (`forum.inderes.com/t/<id>.json`) | forums, every 12 hours | Activity in the company's thread: how many new posts since the last check, with a link. Never usernames or post text. | Mostly Finnish companies; the thread id is set by hand (`settings` → `sources.inderesTopic`), because the forum's search is closed to robots. |

Optional, off: **Nasdaq company news** (`api.news.eu.nasdaq.com/news/query.action`), every Nordic company announcement by company name, is undocumented (the backend of nasdaq.com's company news page) and nasdaq.com's terms forbid automated capture from its service; whether they cover this API is unclear. It is read only when the owner sets `stockWatch.sources."nasdaq-company-news": true`.

Not used, with why: Nasdaq's screener and quote APIs (`api.nasdaq.com`: robots.txt disallows everything), Google News RSS (robots.txt disallows `/rss`), Yahoo Finance RSS (robots.txt disallows everything), Dagens industri and Kauppalehti (block AI agents or all robots; text and data mining reserved), Placera and its forum (their terms forbid automatic tools, RSS included), GDELT (throttled, little Nordic coverage), Reddit (robots.txt disallows everything; the Data API needs an app the owner registers), Nordnet's forum (forbids automatic collection) and GlobeNewswire's www host (refuses robots). `SOURCES_NOT_USED` in `stock-sources.mjs` keeps this list.

Price alerts and real-time market data are not supported: Nasdaq's free delayed trade files exist, but nothing in v1 uses prices.

## Events and deduplication

Every item becomes one candidate event with a type, an evidence class (`official_disclosure`, `company_release`, `news`, `forum`), its publication time in UTC and its source. Types come from a source's own tags (such as a distributor's report and inside-information tags) or fixed words in Swedish, Finnish and English, never from a model, and they are only a first sorting (`prefilter`: critical, important, informational).

- A report is detected only when it is published. An invitation to a presentation, a date notice ("publishes its interim report on 23 October") or a financial calendar is a `report_notice`, never a publication.
- The same item from the same source (document id or canonical URL) is stored once, so retries and restarts never duplicate it. Event ids are derived from the item, so the same event always has the same id.
- One report (security, kind, fiscal year and period) from several sources or languages is one event with several sources. A correction (`Correction:`, `Rättelse:`, `Oikaisu:`) is a new version linked to the original.
- The same official release in two languages (same type, published within ten minutes, or the distributor's own group id) is one event.
- The same headline about the same security within four days is a repeat: one event, never a second confirmation. News about a report published shortly before is filed as coverage of that report, so five articles about one quarterly report stay one event.
- Fuzzy text similarity alone never merges anything.

## Monitor

One command job, `Assistant stocks: watch monitor`, runs `node scripts/stocks.mjs monitor --scheduled` at minute 7 of every hour (Europe/Stockholm). It runs no model and prints `NO_REPLY`.

- **What is due:** each followed (not paused) security's sources that its settings switch on and that can cover it, when their interval has passed: company announcements every 60 minutes, the report calendar daily, news every 4 hours, forums every 12 hours (`stockWatch.checkEveryMinutes`, never under 60). Most overdue first.
- **Limits** (`stockWatch.limits`): at most 25 securities, 40 source checks and 80 requests per run, 3 requests per check, 50 items per check, at least one second between requests to one host (longer when robots.txt asks, up to 30 seconds), 20-second timeouts and 3 MB responses, and 3 report-document checks. A shared feed (a country feed, the exchange notices) is fetched once per run for every company that reads it. Checks stop starting two minutes before the job's 15-minute timeout. A check that the run's budget or time cannot fit is deferred to the next run and counted, never dropped silently. Official sources go first, so a report is known before news about it.
- **Robots.txt and refusals:** each host's robots.txt is read before its first request and again after a day, and followed (RFC 9309: a missing file allows everything, an unreachable one allows nothing). Only https GETs without cookies; redirects only to the source's own hosts. A 429 or 503 is a rate limit and a 401/403 a refusal: the source waits (at least as long as `Retry-After` asks), and nothing is worked around.
- **Health:** per security and source, the last attempt, last success, newest item seen, health (`ok`, `degraded`, `failing`, `blocked`), the last error and consecutive failures. A first failure is retried at the usual interval; repeated failures back off, doubling up to a day. A failing source is reported as unchecked, never as "nothing new".
- **History and catch-up:** what a source returns on its first successful check is `baseline` history, never news. When a source's last success is more than two intervals old (the computer slept or was offline), the next check is a catch-up and its new events are marked `catchUp`; anything published before the catch-up window (`catchUpDays`, 7) is marked `missed` and kept, but not as news.
- **Report documents:** when a new report's release links its document (the report PDF on Nasdaq's or MFN's storage, or the EDGAR filing), the first 2 kB are read within three days of finding it. The event records whether the report itself could be retrieved (`documentRetrieved`) and what it is (PDF or HTML). The document is never stored. A Cision or GlobeNewswire release without a document link leaves it unknown.
- **Retention:** the newest 300 events per security; baseline history goes first.

## Report calendar

A report date exists only when a source stated it: the company's own calendar file or its date notice (confirmed), or MFN's calendar table (estimated). Each entry is one upcoming report (kind and period) with its date, time when given, its source, and `status`: `confirmed` (the company or the exchange stated it) or `estimated` (a third party did). A confirmed date is never replaced by an estimate, a moved date keeps the earlier one as `previousDate`, and no date is ever invented: without an entry the date is unknown. A date arriving never marks a report as published; only the publication itself does.

## Commands

```bash
npm run --silent stocks -- list              # the watchlist: followed or paused, and what is checked
npm run --silent stocks -- show --id sw-1a2b3c4d   # one security, its sources' health and next report date
npm run --silent stocks -- events --days 1   # what the monitor found (--all adds first-check history)
npm run --silent stocks -- calendar          # next report dates, confirmed or estimated
npm run --silent stocks -- status            # counts, unreadable records, permissions; no company names
npm run --silent stocks -- monitor-status    # the job, the last run, source health in counts
npm run --silent stocks -- guide             # the skill text with the watchlist status
npm run --silent stocks -- help
```

Writes and lookups read JSON from stdin through a quoted heredoc, so the user's words never enter a shell argument:

```bash
npm run --silent stocks -- resolve --json-stdin <<'JSON'
{"query": "Investor B"}
JSON
```

## Installing and checking

```bash
npm run --silent stocks -- monitor-install --dry-run   # what would be added or updated, nothing changed
npm run --silent stocks -- monitor-install            # add or update the job, then prove it matches and no other job changed
npm run --silent stocks -- monitor                    # by hand: a preview that checks nothing and writes nothing
npm run --silent stocks -- check --id sw-1a2b3c4d     # check one security's sources now, on the user's request
```

`monitor-install` refuses when more than one job has the monitor's name. Pause the whole monitor with `npm run quiet:disable -- "Assistant stocks: watch monitor"` (after the user's approval, like any job), one security with `settings` (`status: paused`), or everything at once with `stockMonitoring.enabled: false`.

## Not supported

Buying or selling securities, placing or preparing orders, brokerage or bank connections, corporate-action elections (subscribing in a rights issue, accepting an offer), BankID, payments, price alerts, sub-hourly or real-time market monitoring, paid data services, and forums or sites that need a login or forbid automated reading. Hilla can say what to read and where; the user acts themselves.

## InvestmentAgent

The user's separate InvestmentAgent project (`github.com/vernerisirva/investmentagent`) ranks Swedish and Finnish Nasdaq-listed companies with a frozen methodology and publishes a daily universe snapshot keyed by ISIN. Hilla does not use it, change it or depend on it. A read-only link is possible later: Hilla could read that public snapshot to show a followed company's InvestmentAgent rank and data-quality flags next to its events. That would add a dependency on another repository's file layout and is left out of this version.
