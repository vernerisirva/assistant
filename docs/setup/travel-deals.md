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
- Exchange rates: the ECB's daily euro reference rates, fetched by `travel -- compare` when its input says `"fx": "ecb"` (or shown with `travel -- fx`), so no rate is typed by the model. Converted prices are marked approximate.
- Hotels, packages, green fees, bag fees, transfers and climate: the agent's own web search and page reading. Most of these are `indicative`. Hotel metasearch pages (Google Hotels, Kayak, Momondo) disallow automated access or need JavaScript, so hotel prices are rarely `verified`.
- No paid travel APIs, no accounts, no browser automation.

## Price labels

`verified` means a concrete price for these dates, this party and stated inclusions, with source and time. `indicative` covers "from" prices, snippets and season rates. `estimate` is a stated calculation. `unavailable` means no trustworthy price. `travel -- compare` refuses input that would make a number untrue: a verified label without evidence, an unknown cost counted as zero, a room price charged per person, a per-person "two sharing" price for a solo traveller without a supplement, a forecast for a trip more than ten days ahead, a saving between two different trips, or prices, savings, availability claims, links or instruction-like page text in free text.

## Limits

- Google Flights is a third-party page, not an API. If its markup changes, lookups come back `unreadable` and the agent falls back to indicative research and search links. The fare shown is the outbound flight plus the cheapest matching return; the return flight is picked on the booking site.
- Bag rules, hotel prices and package prices come from what pages show at the time. Nothing is held, and prices can change before booking.
- Tee-time availability is never claimed unless the agent saw times on a booking page, and even then nothing is reserved.
