# Travel & Deals Skill

Hilla's on-demand travel researcher: flights, hotels, city breaks and golf holidays, priced in full with honest labels and real links. Version 1 is research and planning only. It never books or pays, and nothing runs on a schedule.

## Files

- `agents/personal/skills/travel-deals/SKILL.md`: the workflow the personal agent follows. `npm run render:config` copies it to `.openclaw/workspace-personal/skills/travel-deals/`.
- `scripts/travel.mjs`: the helper the skill runs (`npm run --silent travel -- …`).
- `scripts/lib/travel-sources.mjs`: the two live readers, Google Flights and ECB rates.
- `scripts/lib/travel-deals.mjs`: date sampling, search links, totals, labels, honesty checks and the Telegram reply.
- Capability entries: `travel.*` in `scripts/lib/capabilities.mjs`. Policy: `travelResearch` in `config/approval-policy.json`.

## How the agent finds it

OpenClaw loads skills from `<workspace>/skills`. On the Codex harness the skill list (name, description, path) reaches the model as turn-scoped developer instructions, outside the 32 KiB project-doc budget, and the model reads `SKILL.md` when a request matches. The personal prompt also has a one-line `Travel:` pointer.

Explicit invocation: Telegram commands may only use `a-z`, `0-9` and `_`, so OpenClaw registers the skill as `/travel_deals`. `/skill travel-deals` also works. A typed `/travel-deals` is not a command; it reaches the model as ordinary text.

Check discovery with the Gateway's own CLI and config:

```bash
OPENCLAW_CONFIG_PATH="$PWD/.openclaw/openclaw.json" OPENCLAW_STATE_DIR="$PWD/.openclaw/state" ~/.openclaw/bin/openclaw skills info travel-deals --agent personal
```

## Sources

- Flights: `travel -- flights` makes one GET per route and date to Google Flights' public results page (`/travel/flights?q=…`, which Google's robots.txt allows). The page lists current fares for exact dates and party size, taxes and required fees included. The request sends the same browser User-Agent as OpenClaw's `web_fetch`, because Google serves non-browser clients an "unsupported browser" page. A fare is kept only if its date, trip type and the page's passenger count match the request. A consent, captcha or other redirect stops the run with nothing retried. There are at most 8 lookups per run, 1.5 seconds apart.
- Round trips: that page lists departing flights only. Each fare is "From N … round trip total": the outbound flight plus the cheapest return Google pairs with it. Google names the return only after a flight is selected, on `/travel/flights/search` and `/travel/flights/booking`, which robots.txt disallows, so Hilla never sees it. In a check on 16 Oct 2026, the cheapest returns on offer were a 9 to 21 hour layover (airBaltic via Riga), or another airline on a separate ticket (Ryanair out, Norwegian back), and other returns cost up to 1,000 SEK more. So a round-trip cost line carries `"returnFlight": "not_seen"`, and compare shows it as "listed (return flight not seen)", never as a verified trip. Two `--one-way` lookups, one each way, name both flights; compare adds them as two separate tickets.
- Exchange rates: the ECB's daily euro reference rates, fetched by `travel -- compare` when its input says `"fx": "ecb"` (or shown with `travel -- fx`), so no rate is typed by the model. Converted prices are marked approximate.
- Hotels, packages, green fees, bag fees, transfers and climate: the agent's own web search and page reading. Most of these are `indicative`. Hotel metasearch pages (Google Hotels, Kayak, Momondo) disallow automated access or need JavaScript, so hotel prices are rarely `verified`.
- No paid travel APIs, no accounts, no browser automation.

## Price labels

`verified` means a concrete price for these dates, this party and stated inclusions, with source and time. A Google round trip is a verified listing with an unseen return, so an option built on one is at best "partly indicative". `indicative` covers "from" prices, snippets and season rates. `estimate` is a stated calculation. `unavailable` means no trustworthy price. `travel -- compare` refuses input that would make a number untrue: a verified label without evidence (for flights: a page that does not confirm the dates, party and that taxes are included), a Google round trip without its `returnFlight` caveat, a Google fare used for another search or flown the wrong way, a flight paid for twice, an unknown cost counted as zero, a stay with no word on hotel taxes, a room price charged per person, a per-person "two sharing" price for a solo traveller without a supplement, a forecast for a trip more than ten days ahead, a saving between two different trips, or prices, savings, availability claims, links or instruction-like page text in free text.

## Limits

- Google Flights is a third-party page, not an API. If its markup changes, lookups come back `unreadable` and the agent falls back to indicative research and search links. A change that removes every fare label reads as "no fares listed", still with no price.
- Google says its prices come from partners' latest data, refreshed within 24 hours, and should be checked with the provider before booking. A listed fare is evidence of what Google showed, not a held or bookable quote. The airline may also charge in another currency (airBaltic in EUR), so the SEK amount is Google's conversion.
- A round trip's return flight is never seen, and nor is its booking page. A one-way fare whose flight is known is the closest Hilla gets to a complete itinerary.
- Bag rules, hotel prices and package prices come from what pages show at the time. Nothing is held, and prices can change before booking.
- Tee-time availability is never claimed unless the agent saw times on a booking page, and even then nothing is reserved.
