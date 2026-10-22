/**
 * Reading RSS 2.0 and Atom feeds without a parser library: just enough XML to
 * take out each item's title, link, id, date and categories.
 *
 * Feeds are untrusted input. Nothing here follows a link, runs a script or
 * expands an entity beyond the standard ones; a document that does not look
 * like a feed yields no items rather than a guess. Item bodies (descriptions,
 * summaries, content) are never returned: only what identifies an item.
 */
import { cleanExternalText, decodeEntities } from "./stock-events.mjs";

const MAX_ITEMS = 200;

/** Items of an RSS or Atom document, or null when the text is not a feed. */
export function parseFeed(xml) {
  const text = String(xml ?? "");
  if (/<!ENTITY/i.test(text)) return null; // No custom entities: they can expand without bound.
  if (/<rss[\s>]/i.test(text) || /<rdf:RDF[\s>]/i.test(text)) return blocks(text, "item").map(rssItem);
  if (/<feed[\s>]/i.test(text)) return blocks(text, "entry").map(atomEntry);
  return null;
}

function blocks(text, tag) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  return [...text.matchAll(pattern)].slice(0, MAX_ITEMS).map((match) => match[1]);
}

/** The text content of the first `<tag>`, CDATA unwrapped and entities decoded; null when absent. */
export function tagText(block, tag) {
  const match = new RegExp(`<${escapeTag(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeTag(tag)}>`, "i").exec(block);
  if (!match) return null;
  return decodeEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
}

function escapeTag(tag) {
  return tag.replace(/[:]/g, "\\:");
}

function attributes(tagSource) {
  const result = {};
  for (const match of tagSource.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) result[match[1].toLowerCase()] = decodeEntities(match[3] ?? match[4] ?? "");
  return result;
}

function categories(block) {
  return [...block.matchAll(/<category(\s[^>]*)?>([\s\S]*?)<\/category>/gi)].map((match) => ({
    domain: attributes(match[1] ?? "").domain ?? null,
    value: decodeEntities(match[2].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim(),
  }));
}

function rssItem(block) {
  const guid = tagText(block, "guid");
  return {
    title: cleanExternalText(tagText(block, "title") ?? ""),
    link: tagText(block, "link"),
    id: guid,
    publishedAt: isoDate(tagText(block, "pubDate") ?? tagText(block, "dc:date")),
    categories: categories(block),
    source: tagText(block, "source") ?? tagText(block, "News:Source"),
    // Dublin Core fields some distributors add: the release id shared by its language versions, its language, subjects and issuer.
    identifier: tagText(block, "dc:identifier"),
    language: tagText(block, "dc:language"),
    subjects: [...block.matchAll(/<dc:subject(?:\s[^>]*)?>([\s\S]*?)<\/dc:subject>/gi)].map((match) => decodeEntities(match[1]).trim()),
    contributor: tagText(block, "dc:contributor"),
  };
}

function atomEntry(block) {
  const links = [...block.matchAll(/<link(\s[^>]*)\/?>/gi)].map((match) => attributes(match[1] ?? ""));
  const link = links.find((entry) => !entry.rel || entry.rel === "alternate")?.href ?? links[0]?.href ?? null;
  const terms = [...block.matchAll(/<category(\s[^>]*)\/?>/gi)].map((match) => attributes(match[1] ?? "")).map((entry) => ({ domain: entry.scheme ?? null, value: entry.term ?? entry.label ?? "" }));
  return {
    title: cleanExternalText(tagText(block, "title") ?? ""),
    link,
    id: tagText(block, "id"),
    publishedAt: isoDate(tagText(block, "published") ?? tagText(block, "updated")),
    categories: terms,
    source: null,
  };
}

// --- iCalendar ---------------------------------------------------------------------------

/**
 * Events of an iCalendar (.ics) file: summary, start date, start time and
 * its time zone id when given, and the event's UID. Lines folded by RFC 5545
 * are joined first. Descriptions and attendees are never returned.
 */
export function parseIcs(text) {
  const source = String(text ?? "");
  if (!/^BEGIN:VCALENDAR/m.test(source)) return null;
  const lines = source.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events = [];
  let current = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") current = {};
    else if (line === "END:VEVENT") {
      if (current?.start) events.push(current);
      current = null;
    } else if (current) {
      const match = /^([A-Z-]+)((?:;[^:]*)?):(.*)$/.exec(line);
      if (!match) continue;
      const [, name, params, value] = match;
      if (name === "SUMMARY") current.summary = cleanExternalText(value.replace(/\\([,;\\n])/g, (all, char) => (char === "n" ? " " : char)), { max: 200 });
      if (name === "UID") current.uid = value.slice(0, 200);
      if (name === "DTSTART") {
        const date = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{2}(Z)?)?$/.exec(value.trim());
        if (!date) continue;
        const allDay = /VALUE=DATE(?!-)/.test(params) || date[4] === undefined || (date[4] === "00" && date[5] === "00" && !date[6]);
        current.start = {
          date: `${date[1]}-${date[2]}-${date[3]}`,
          time: allDay ? null : `${date[4]}:${date[5]}`,
          utc: Boolean(date[6]),
          tzid: /TZID=([^;:]+)/.exec(params)?.[1] ?? null,
        };
      }
    }
    if (events.length >= 200) break;
  }
  return events;
}

/** RFC 822 or ISO 8601 as an ISO timestamp in UTC; null when it isn't a date. */
export function isoDate(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
