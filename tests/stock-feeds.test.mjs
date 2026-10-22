import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isoDate, parseFeed } from "../scripts/lib/stock-feeds.mjs";

describe("feed parsing", () => {
  it("reads RSS 2.0 items: title, link, guid, date and categories, never the body", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title>
      <item><title>Interim report January&#8211;September 2026</title><link>https://news.example/r/interim,c1</link><guid isPermaLink="false">ex1</guid>
        <description><![CDATA[Long body with numbers 1 2 3 and <b>markup</b>]]></description><pubDate>Fri, 16 Oct 2026 06:15:45 GMT</pubDate>
        <category domain="https://news.example/rss/stock">Helsinki:EXAM</category></item>
      <item><title><![CDATA[Notice of AGM & board]]></title><link>https://news.example/r/agm,c2</link><guid>ex2</guid><pubDate>not a date</pubDate></item>
    </channel></rss>`;
    const items = parseFeed(xml);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      title: "Interim report January–September 2026",
      link: "https://news.example/r/interim,c1",
      id: "ex1",
      publishedAt: "2026-10-16T06:15:45.000Z",
      categories: [{ domain: "https://news.example/rss/stock", value: "Helsinki:EXAM" }],
      source: null,
      identifier: null,
      language: null,
      subjects: [],
      contributor: null,
    });
    assert.equal(items[1].title, "Notice of AGM & board");
    assert.equal(items[1].publishedAt, null);
    assert.ok(!JSON.stringify(items).includes("Long body"), "bodies are never returned");
  });

  it("reads the Dublin Core fields a distributor adds: release id, language, subjects and issuer", () => {
    const [item] = parseFeed(`<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><title>Example Oyj Interim Report for Q3 2026</title>
      <category domain="https://news.example/rss/ISIN">FI0000000001</category><dc:identifier>3386019</dc:identifier><dc:language>en</dc:language>
      <dc:contributor>Example Oyj</dc:contributor><dc:subject>Earnings Releases and Operating Results</dc:subject><dc:subject>European Regulatory News</dc:subject></item></channel></rss>`);
    assert.equal(item.identifier, "3386019");
    assert.equal(item.language, "en");
    assert.equal(item.contributor, "Example Oyj");
    assert.deepEqual(item.subjects, ["Earnings Releases and Operating Results", "European Regulatory News"]);
  });

  it("reads Atom entries", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Filings</title>
      <entry><title>10-Q - Quarterly report</title><link rel="alternate" href="https://filings.example/a/1"/><id>urn:x:1</id><updated>2026-10-21T16:05:12-04:00</updated><category term="10-Q" label="form type"/></entry>
    </feed>`;
    const [entry] = parseFeed(xml);
    assert.equal(entry.title, "10-Q - Quarterly report");
    assert.equal(entry.link, "https://filings.example/a/1");
    assert.equal(entry.publishedAt, "2026-10-21T20:05:12.000Z");
    assert.deepEqual(entry.categories, [{ domain: null, value: "10-Q" }]);
  });

  it("refuses documents that are not feeds, and custom entities", () => {
    assert.equal(parseFeed("<html><body>Blocked</body></html>"), null);
    assert.equal(parseFeed(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><rss><channel><item><title>&a;</title></item></channel></rss>`), null);
  });

  it("cleans titles of markup, links and control characters", () => {
    const [item] = parseFeed(`<rss><channel><item><title>Q3 &lt;b&gt;report&lt;/b&gt; https://evil.example/x \u202e</title></item></channel></rss>`);
    assert.equal(item.title, "Q3 report");
  });

  it("turns RFC 822 and ISO dates into UTC", () => {
    assert.equal(isoDate("Thu, 22 Oct 2026 09:53:08 GMT"), "2026-10-22T09:53:08.000Z");
    assert.equal(isoDate("2026-10-22T07:30:00+02:00"), "2026-10-22T05:30:00.000Z");
    assert.equal(isoDate(""), null);
  });
});
