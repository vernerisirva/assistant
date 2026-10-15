import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ECB_RATES_URL,
  FETCH_USER_AGENT,
  MAX_FLIGHT_LOOKUPS,
  fetchEcbRates,
  googleFlightsQuery,
  googleFlightsUrl,
  lookUpFlights,
  parseEcbRates,
  parseFareLabel,
  parseGoogleFlightsPage,
} from "../scripts/lib/travel-sources.mjs";

// Synthetic pages in the shape Google Flights serves: fare details live in
// aria-labels, the passenger count in a button label and the taxes note.
function fareLabel({
  price,
  roundTrip = true,
  note = "",
  stops = 0,
  airlines = "Finnair",
  operatedBy = null,
  from = "Copenhagen Airport",
  depart = "6:05 AM",
  weekday = "Friday",
  date = "November 13",
  to = "Helsinki Airport",
  arrive = "8:40 AM",
  arriveWeekday = weekday,
  arriveDate = date,
  duration = "1 hr 35 min",
  layovers = [],
}) {
  const stopText = stops === 0 ? "Nonstop" : `${stops} stop${stops === 1 ? "" : "s"}`;
  return [
    `From ${price} Swedish kronor${roundTrip ? " round trip total" : ""}.${note}`,
    ` ${stopText} flight with ${airlines}.`,
    operatedBy ? ` Operated by ${operatedBy}.` : "",
    ` Leaves ${from} at ${depart} on ${weekday}, ${date} and arrives at ${to} at ${arrive} on ${arriveWeekday}, ${arriveDate}.`,
    ` Total duration ${duration}. `,
    ...layovers.map((layover, index) => ` Layover (${index + 1} of ${layovers.length}) is a ${layover} layover at Riga Airport in Riga.`),
    " Select flight",
  ].join("");
}

function flightsPage({ adults = 1, labels = [], title = "Copenhagen to Helsinki", taxes = true, button = true } = {}) {
  const escape = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return [
    `<!doctype html><html><head><title>${title} | Google Flights</title></head><body>`,
    button ? `<button aria-label="${adults} passenger${adults === 1 ? "" : "s"}, change number of passengers."></button>` : "",
    ...labels.map((label) => `<li><div aria-label="${escape(label)}"></div></li>`),
    taxes ? `<span>Prices include required taxes + fees for ${adults} adult${adults === 1 ? "" : "s"}.</span>` : "",
    "</body></html>",
  ].join("\n");
}

function fakeFetch(respond) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const page = respond(url, calls.length);
    if (page instanceof Error) throw page;
    const status = page.status ?? 200;
    return { status, ok: status >= 200 && status < 300, url: page.url ?? url, text: async () => page.body ?? "" };
  };
  return { impl, calls };
}

const search = { from: "CPH", to: "HEL", depart: "2026-11-13", returnDate: "2026-11-15", adults: 1 };
const noPause = async () => {};
const fixedNow = () => new Date("2026-10-15T12:00:00Z");

describe("Google Flights query and URL", () => {
  it("asks for the exact airports, dates and party in a public results URL", () => {
    assert.equal(googleFlightsQuery(search), "Flights to HEL from CPH on 2026-11-13 through 2026-11-15");
    assert.equal(googleFlightsQuery({ ...search, adults: 2 }), "Flights to HEL from CPH on 2026-11-13 through 2026-11-15 for 2 adults");
    assert.equal(googleFlightsQuery({ ...search, returnDate: null }), "One way flights to HEL from CPH on 2026-11-13");
    const url = new URL(googleFlightsUrl(search));
    assert.equal(url.origin + url.pathname, "https://www.google.com/travel/flights");
    assert.deepEqual([...url.searchParams.keys()], ["q", "curr", "hl", "gl"]);
    assert.equal(url.searchParams.get("curr"), "SEK");
  });
});

describe("parseFareLabel", () => {
  it("reads a nonstop round-trip fare with its operator", () => {
    const fare = parseFareLabel(fareLabel({ price: "1626", operatedBy: "Nordic Reg for Finnair" }));
    assert.equal(fare.priceSek, 1626);
    assert.equal(fare.roundTrip, true);
    assert.equal(fare.stops, 0);
    assert.equal(fare.airlines, "Finnair");
    assert.equal(fare.operatedBy, "Nordic Reg for Finnair");
    assert.equal(fare.fareNote, null);
    assert.equal(fare.departTime, "06:05");
    assert.equal(fare.arriveTime, "08:40");
    assert.deepEqual(fare.departDate, { month: 11, day: 13, weekday: 5 });
    assert.equal(fare.duration, "1 hr 35 min");
  });

  it("keeps the fare note, stops, layovers and a next-day arrival", () => {
    const fare = parseFareLabel(
      fareLabel({
        price: "12,184",
        note: "This price does not include overhead bin access.",
        stops: 1,
        airlines: "Pegasus",
        depart: "8:10 PM",
        arrive: "12:40 AM",
        arriveWeekday: "Saturday",
        arriveDate: "November 14",
        layovers: ["10 hr 5 min overnight"],
      }),
    );
    assert.equal(fare.priceSek, 12184);
    assert.equal(fare.fareNote, "This price does not include overhead bin access.");
    assert.equal(fare.stops, 1);
    assert.equal(fare.departTime, "20:10");
    assert.equal(fare.arriveTime, "00:40");
    assert.deepEqual(fare.arriveDate, { month: 11, day: 14, weekday: 6 });
    assert.deepEqual(fare.layovers, [{ duration: "10 hr 5 min", overnight: true, airport: "Riga Airport", city: "Riga" }]);
  });

  it("reads one-way fares and refuses anything that is not a fare", () => {
    assert.equal(parseFareLabel(fareLabel({ price: "929", roundTrip: false })).roundTrip, false);
    assert.equal(parseFareLabel("From 929 euros round trip total. Nonstop flight with Finnair."), null);
    assert.equal(parseFareLabel("From 929 Swedish kronor. Select flight"), null);
    assert.equal(parseFareLabel("Change number of passengers"), null);
  });
});

describe("parseGoogleFlightsPage", () => {
  it("returns matching fares sorted by price, once each", () => {
    const cheap = fareLabel({ price: "1626", operatedBy: "Nordic Reg for Finnair" });
    const page = flightsPage({ labels: [fareLabel({ price: "1716", depart: "8:55 AM", arrive: "11:30 AM" }), cheap, cheap] });
    const result = parseGoogleFlightsPage(page, search);
    assert.equal(result.status, "ok");
    assert.equal(result.title, "Copenhagen to Helsinki");
    assert.equal(result.taxesIncluded, true);
    assert.deepEqual(
      result.offers.map((offer) => offer.priceSek),
      [1626, 1716],
    );
    assert.equal(result.offers[0].departDate, "2026-11-13");
    assert.equal(result.offers[0].arriveDate, "2026-11-13");
  });

  it("refuses fares priced for another number of passengers", () => {
    const result = parseGoogleFlightsPage(flightsPage({ adults: 1, labels: [fareLabel({ price: "1626" })] }), { ...search, adults: 2 });
    assert.equal(result.status, "mismatch");
    assert.deepEqual(result.offers, []);
    assert.match(result.reason, /priced 1 passenger\(s\), not 2/);

    const unknown = parseGoogleFlightsPage(flightsPage({ labels: [fareLabel({ price: "1626" })], taxes: false, button: false }), search);
    assert.equal(unknown.status, "mismatch");
    assert.match(unknown.reason, /does not say how many passengers/);
  });

  it("refuses fares for another date, year or trip type", () => {
    // 13 November is a Friday in 2026; a Thursday label means another year.
    const otherYear = flightsPage({ labels: [fareLabel({ price: "999", weekday: "Thursday" })] });
    assert.equal(parseGoogleFlightsPage(otherYear, search).status, "mismatch");
    const otherDay = flightsPage({ labels: [fareLabel({ price: "999", date: "November 14", weekday: "Saturday" })] });
    assert.equal(parseGoogleFlightsPage(otherDay, search).status, "mismatch");
    const oneWay = flightsPage({ labels: [fareLabel({ price: "929", roundTrip: false })] });
    assert.equal(parseGoogleFlightsPage(oneWay, search).status, "mismatch");
    assert.equal(parseGoogleFlightsPage(oneWay, { ...search, returnDate: null }).status, "ok");
  });

  it("says when a page lists no fares, or is not a results page at all", () => {
    assert.equal(parseGoogleFlightsPage(flightsPage({ labels: [] }), search).status, "no_listings");
    assert.equal(parseGoogleFlightsPage("<html><title>Before you continue</title></html>", search).status, "unreadable");
    const garbled = flightsPage({ labels: ["From 1626 Swedish kronor round trip total. Something else entirely."] });
    assert.equal(parseGoogleFlightsPage(garbled, search).status, "unreadable");
  });

  it("decodes entities in names", () => {
    const page = flightsPage({ labels: [fareLabel({ price: "2530", stops: 1, airlines: "KLM & Transavia", layovers: ["4 hr 15 min"] })] });
    assert.match(page, /KLM &amp; Transavia/);
    const offer = parseGoogleFlightsPage(page, search).offers[0];
    assert.equal(offer.airlines, "KLM & Transavia");
  });
});

describe("lookUpFlights", () => {
  it("makes one plain GET per search to the results page, pausing between them", async () => {
    const { impl, calls } = fakeFetch(() => ({ body: flightsPage({ labels: [fareLabel({ price: "1626" })] }) }));
    let pauses = 0;
    const results = await lookUpFlights([search, { ...search, from: "MMX" }], {
      fetchImpl: impl,
      now: fixedNow,
      pause: async () => {
        pauses += 1;
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(pauses, 1);
    for (const call of calls) {
      const url = new URL(call.url);
      assert.equal(url.origin + url.pathname, "https://www.google.com/travel/flights");
      assert.equal(call.init.method, undefined, "GET only");
      assert.equal(call.init.body, undefined);
      assert.equal(call.init.headers["user-agent"], FETCH_USER_AGENT);
      assert.equal(call.init.headers.cookie, undefined, "no cookies");
      assert.deepEqual(Object.keys(call.init.headers).sort(), ["accept-language", "user-agent"]);
    }
    assert.deepEqual(
      results.map((result) => result.status),
      ["ok", "ok"],
    );
    assert.equal(results[0].checkedAt, "2026-10-15T12:00:00.000Z");
    assert.equal(results[0].url, googleFlightsUrl(search));
  });

  it("stops after a consent, captcha or other redirect and never retries", async () => {
    const { impl, calls } = fakeFetch(() => ({ url: "https://consent.google.com/m?continue=x", body: "<html>Before you continue</html>" }));
    const results = await lookUpFlights([search, { ...search, depart: "2026-11-20", returnDate: "2026-11-22" }, { ...search, from: "MMX" }], {
      fetchImpl: impl,
      now: fixedNow,
      pause: noPause,
    });
    assert.equal(calls.length, 1, "nothing after the block");
    assert.deepEqual(
      results.map((result) => result.status),
      ["blocked", "skipped", "skipped"],
    );
    assert.match(results[0].reason, /consent\.google\.com/);
    assert.match(results[1].reason, /earlier lookup was redirected/);
    for (const result of results) assert.deepEqual(result.offers, []);
  });

  it("treats rate limits and the unsupported-browser page as blocks", async () => {
    const limited = await lookUpFlights([search], { fetchImpl: fakeFetch(() => ({ status: 429 })).impl, now: fixedNow, pause: noPause });
    assert.equal(limited[0].status, "blocked");
    const unsupported = await lookUpFlights([search], {
      fetchImpl: fakeFetch(() => ({ url: "https://www.google.com/travel/flights/unsupported", body: "" })).impl,
      now: fixedNow,
      pause: noPause,
    });
    assert.equal(unsupported[0].status, "blocked");
    const sorry = await lookUpFlights([search], {
      fetchImpl: fakeFetch(() => ({ url: "https://www.google.com/sorry/index", body: "" })).impl,
      now: fixedNow,
      pause: noPause,
    });
    assert.equal(sorry[0].status, "blocked");
  });

  it("reports a network error for that lookup and carries on", async () => {
    const { impl, calls } = fakeFetch((url, count) =>
      count === 1 ? new Error("getaddrinfo ENOTFOUND") : { body: flightsPage({ labels: [fareLabel({ price: "1626" })] }) },
    );
    const results = await lookUpFlights([search, { ...search, from: "MMX" }], { fetchImpl: impl, now: fixedNow, pause: noPause });
    assert.equal(calls.length, 2);
    assert.equal(results[0].status, "error");
    assert.match(results[0].reason, /ENOTFOUND/);
    assert.equal(results[1].status, "ok");
  });

  it(`refuses more than ${MAX_FLIGHT_LOOKUPS} lookups before fetching anything`, async () => {
    const { impl, calls } = fakeFetch(() => ({ body: "" }));
    const searches = Array.from({ length: MAX_FLIGHT_LOOKUPS + 1 }, () => search);
    await assert.rejects(lookUpFlights(searches, { fetchImpl: impl, now: fixedNow, pause: noPause }), /At most 8 flight lookups/);
    assert.equal(calls.length, 0);
  });
});

describe("ECB rates", () => {
  const xml = `<?xml version="1.0"?><gesmes:Envelope><Cube><Cube time='2026-10-14'>
    <Cube currency='USD' rate='1.1195'/><Cube currency='DKK' rate='7.4754'/><Cube currency='SEK' rate='11.1580'/><Cube currency='TRY' rate='55.2921'/>
  </Cube></Cube></gesmes:Envelope>`;

  it("turns euro reference rates into SEK per unit", () => {
    const fx = parseEcbRates(xml);
    assert.equal(fx.date, "2026-10-14");
    assert.equal(fx.source, ECB_RATES_URL);
    assert.equal(fx.sekPerUnit.EUR, 11.158);
    assert.equal(fx.sekPerUnit.DKK, Number((11.158 / 7.4754).toFixed(6)));
    assert.equal(fx.sekPerUnit.TRY, Number((11.158 / 55.2921).toFixed(6)));
    assert.equal(fx.sekPerUnit.SEK, undefined);
  });

  it("fails loudly rather than inventing a rate", async () => {
    assert.throws(() => parseEcbRates("<Cube time='2026-10-14'><Cube currency='USD' rate='1.1'/></Cube>"), /could not be read/);
    const moved = fakeFetch(() => ({ url: "https://www.ecb.europa.eu/home/html/index.en.html", body: xml }));
    await assert.rejects(fetchEcbRates({ fetchImpl: moved.impl }), /unavailable/);
    const fine = fakeFetch(() => ({ body: xml }));
    assert.equal((await fetchEcbRates({ fetchImpl: fine.impl })).sekPerUnit.EUR, 11.158);
    assert.equal(fine.calls[0].url, ECB_RATES_URL);
  });
});
