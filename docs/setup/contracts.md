# Contracts & Renewals

Hilla keeps a private register of the user's recurring contracts: car, home and pet insurance, electricity, broadband, mobile, gym, streaming and other subscriptions. The user gives the details once, by message, screenshot or the agreement itself, and can then ask what each costs, when it renews, and which discounts end soon. For contracts the user asks it to watch, a daily renewal check messages them before the earliest action deadline, once with current public offers compared. Hilla never cancels, renews, switches, signs or buys a contract and never contacts a provider.

## Files

- `agents/personal/skills/contract-renewals/SKILL.md`: the workflow the personal agent follows. `npm run render:config` copies it to `.openclaw/workspace-personal/skills/contract-renewals/`. The personal prompt keeps a two-line `Contracts:` pointer.
- `scripts/contracts.mjs`: the helper the skill runs (`npm run --silent contracts -- …`).
- `scripts/lib/contracts.mjs`: the register: fields, checks, storage, finding a contract, the preview-then-yes flow, and the Telegram text.
- `scripts/lib/contract-dates.mjs`: calendar dates, notice deadlines and each contract's key dates.
- `scripts/lib/contract-watch.mjs`: the daily renewal check: milestones, the research handoff, alert texts, delivery checks, replies and the scheduled job.
- `scripts/lib/contract-offers.mjs`: comparisons, pure: evidence labels, 12-month costs, like-for-like checks and the recommendation.
- Settings: `contractWatch` in `config/schedules.json`. Capability entries: `contracts.*` in `scripts/lib/capabilities.mjs`. Policy: `contractRegister`, `contractRenewalWatch` and the `contracts` approval domain in `config/approval-policy.json`.

## Storage and privacy

- One file per contract: `.openclaw/state/contracts/records/<ct-id>.json`, under the ignored runtime state. Folders are owner-only (`0700`) and files owner-only (`0600`), re-applied on every write.
- Every write replaces the file atomically (a flushed temporary file renamed over the old one) while holding `.openclaw/state/contracts/register.lock`, so two writers cannot lose each other's change and a failed write leaves the old file as it was. A record that cannot be read is reported and skipped; the other contracts stay readable, and the broken file is never overwritten. It can be deleted after the user's yes.
- A record holds only what a renewal decision needs. The helper refuses identity, policy, customer, account, card and registration numbers, phone numbers, email addresses, passwords, codes, links and instruction-like text, and its problems name the field without repeating the value. Prices go in price fields, never in text.
- The register is not memory: contract details never go into `preferences.json`, workspace notes, Todoist or Calendar. Documents are read, never kept.
- Every change keeps a history entry with the fields that changed (from and to) and the user's reason, so a renewal or a price change can be explained later.
- Each record file stores its own history, so there is no separate backup: the atomic write is the protection against a broken file, and an unreadable record never blocks the rest.

## What a contract holds

- `category`, `provider`, `product`, and a short `label` to tell two apart.
- Dates, each `YYYY-MM-DD`, `"none"` (does not apply) or `null` (unknown): `startDate`, `renewalDate` (the next term starts, or the contract ends), `bindingEndDate`, `discountEndDate`, `priceGuaranteeEndDate` and `cancellationDeadline` (only when the provider states it).
- `autoRenewal` (`yes`, `no`, `unknown`) and `noticePeriod` (`{value, unit: days | months | calendar_months, verified}`).
- `currentPrice` and `nextPrice` (`{amount, currency, period: month | quarter | year}`).
- `terms`, a short list per category: coverage, deductible, add-ons and the insured item for insurance; supply or grid agreement, price model, fixed price, markup, monthly fee, VAT basis, yearly kWh and price area for electricity; speeds and data for broadband and mobile.
- `notes`, `source` (`user_message`, `document` or `screenshot`, with a short description), `monitoring`, `status`, `history`.

The key dates are kept apart (`contractKeyDates`): a discount or price guarantee ending is a price change, not the end of the contract; an explicit cancellation deadline wins over one worked out from the notice period; a notice deadline from an unverified notice period is provisional; and a renewal with an unknown notice period is a provisional deadline, because the real one may be earlier. Calendar months clamp to the month's end (31 Jan + 1 month = 28 Feb; 29 Feb + 1 year = 28 Feb), and "today" is the Europe/Stockholm calendar day.

## Saving: preview, then the user's yes

Every write is a preview unless its JSON carries `approval`:

1. `add` (or `update`, `renew`, `end`, `remove`) without approval saves nothing. It returns `telegramText` (what would be stored, what is still unknown, and the question), `digest` and `questions`.
2. The agent sends the text unchanged and waits.
3. After a plain yes, the agent runs the same command with `"approval": {"digest": "<digest>", "replyText": "<the exact reply>"}`. The helper recomputes the digest, so a contract that differs from the preview is refused (`changed_since_preview`), and the reply must pass the same approval check as other Hilla approvals: a question, hedge, denial or emoji other than 👍👌✅ saves nothing (`not_approved`). An update also refuses when the contract changed since its preview.

`monitor` (renewal watch on or off for one contract) is the one write without a preview: it changes no contract details and runs on the user's request.

## Intake

- Typed details are taken as said. A screenshot reaches the model as an image; a PDF is read with OpenClaw's `pdf` tool (an inbound `media://inbound/…` reference). If a document cannot be read, the agent says so and asks; it never guesses from a file name or a typical value.
- The helper returns the materially missing fields, most important first: renewal date, notice period, automatic renewal, current price, the price after a discount or guarantee, and for electricity the agreement type and yearly kWh, for insurance the deductible. The agent asks two or three at most and saves the rest as unknown.
- Hilla never goes looking for contracts in Gmail, files or photos unless the user asks it to look in a named place.

## Commands

```bash
npm run --silent contracts -- list              # active contracts: price a year and next important date (--all adds ended ones)
npm run --silent contracts -- show --id ct-1a2b3c4d
npm run --silent contracts -- upcoming --days 90
npm run --silent contracts -- status            # counts, unreadable records, permissions; no contract details
npm run --silent contracts -- guide             # the skill text with the register status
npm run --silent contracts -- help
```

Writes and lookups read JSON from stdin through a quoted heredoc, so contract details never enter a shell argument:

```bash
npm run --silent contracts -- find --json-stdin <<'JSON'
{"target": "my car insurance"}
JSON
```

## Renewal watch

One command job, `Assistant contracts: renewal watch`, runs `node scripts/contracts.mjs watch --scheduled` every morning at 09:30 Europe/Stockholm. It is deterministic and runs no model unless research is due.

- **What it watches:** active contracts with the watch on (`monitoring.enabled`, set when the user asked to track one), and not past an optional `monitoring.until`. Nothing runs while `contractRenewalWatch.enabled` in the approval policy is false or its `authorizedUntil` has passed.
- **Which date:** the contract's earliest action deadline (`earliestActionDeadline`): a stated cancellation deadline, a notice deadline, a discount or price guarantee ending, the end of a binding period, or the renewal itself when its notice period is unknown (then marked provisional, and every alert says the real deadline may be earlier). A deadline that moves, for example after the user corrects the notice period, starts a new cycle.
- **Milestones** (`contractWatch.milestones`): 90 days before, a heads-up only when the comparison needs something the register lacks (a notice period, the price after the change, yearly kWh, a deductible); 60 days, research and the recommendation; 30 and 14 days, reminders with the recommendation; 7 days, the last reminder. Each is sent at most once per deadline, and only the most urgent one reached: a contract added 20 days before its deadline gets research and the 30-day alert at once, and the earlier steps are marked skipped. At most one alert per contract per day.
- **Answers** (`contracts -- ack`): `keep`, `renewed` and `dismiss` end a deadline's reminders; `snooze` sends one reminder on a chosen day before the deadline, standing in for the steps reached meanwhile; `recheck` researches again on a chosen day. `monitor` turns a contract's watch off. Answers change only the watch's own notes. When every date of a contract has passed, the user is asked once for the new terms.
- **State:** `.openclaw/state/contracts/watch/<ct-id>.json` (cycle, milestones, research, recent alerts) and `watch/watch.json` (heartbeat and a summary of the last run, in counts only), owner-only and atomic like the register. The watch never writes a contract record. Ending or deleting a contract deletes its watch notes; notes of contracts that are gone are removed on the next run.

### Research handoff

When a contract reaches its research point, the run claims a request (`rq-…`) and starts one isolated personal-agent turn through the Gateway's own CLI: `openclaw agent --agent personal --session-key contract-research-<rq> --message <fixed text> --json --timeout 900`, without `--deliver`. The message holds only the request id and the rules, never contract details. The agent runs `contracts -- research-brief --request rq-…` for the comparable facts, researches public pages within a budget of about 10 searches and 10 page opens, and submits through `contracts -- research-submit`, which checks every offer (`contract-offers.mjs`) and stores the comparison. The run waits for the turn, then reads back what was stored. Only that counts: the turn's own reply is discarded.

Bounds: one research turn per run (the next contract waits a day), two attempts per deadline, 15 minutes per turn, a 30-minute job timeout, and no new research within 30 days of the last when the contract's prices and terms are unchanged; a comparison done in chat is reused the same way. A first failure is retried the next morning unless the deadline is 14 days away or less; a second failure sends the alert without a comparison, saying offers couldn't be checked. Research the user asks for in chat runs in the chat turn and is stored the same way.

Why this design: OpenClaw 2026.7 also has cron event triggers (`--trigger-script`), which would run a model turn only when a condition script says so. They need the global `cron.triggers.enabled` switch, which lets any agent-authored trigger script run `exec` headlessly with that agent's tool policy, a wider permission than this feature needs. A second, disabled agent-turn job force-run with `cron run` would add a job that never runs on its own schedule. The command job starting one isolated turn keeps a single job, a fixed message and the existing approval boundaries.

### Delivery

Alerts are the run's stdout. The Gateway's cron announces it to the allowlisted Telegram user (`--announce --channel telegram`, not best-effort, so a failed delivery fails the run), and `NO_REPLY` posts nothing. No contract text ever enters a command line. An alert is recorded as `printed`; the next run reads the job's run history (`openclaw cron runs`, through `live-cron.mjs`'s `runs()`, which returns timing and delivery outcome only) and marks it `delivered`, or `failed` and prints it again, at most three times. An alert whose run never shows up in the history becomes `unconfirmed` after a day and is never resent, so it is never counted as sent without proof.

The scheduled check doesn't put its alerts into the chat session, so the skill has the agent read `contracts -- alerts` before answering a reply such as "I've renewed it".

## Offer comparisons

`contract-offers.mjs` is pure: no network, files or clock. Every offer carries one evidence level:

- `personalized_quote`: a quote for the user's own details and cover. Hilla never fills in quote forms, so only the user can obtain one; it must come from them in chat (`"source": "user"`), never from the scheduled research.
- `published`: a standard public price list or tariff anyone gets. Never for insurance, whose premiums depend on the person, car or home.
- `indicative`: a promotion, "from" price, example or comparison-site figure. `estimate`: a calculation with its basis. `unavailable`: no trustworthy price, only a page to ask for one.

Costs cover the same 12 months from the deadline: introductory months, then the regular price, every one-time fee, and the current contract's exit fee when the agent found one. Staying costs the price after the change (`nextPrice`); when that is unknown at a discount end, price-guarantee end or renewal, no saving is claimed and the recommendation is "not enough information". Electricity compares supply agreements only, at the yearly use in the register (or one the user gives, or a labelled assumption): market-priced (spot or variable) contracts on what the supplier adds (markup and monthly fee), fixed-price contracts on their whole cost, and a market price's full cost only as an illustration with a sourced spot price. Grid fees and energy tax are the same whichever supplier is picked and are left out; every price must be on the same VAT basis. An offer is like for like only when its cover, deductible, speed, data or price model is at least the current one's and nothing material is unknown; a higher deductible, a slower line or less data never becomes the recommendation.

The recommendation follows fixed rules: insufficient information when staying has no known cost; negotiate when the price is about to rise materially and no alternative is clearly cheaper; keep when none is; consider switching only for a like-for-like published price or the user's own quote that is cheaper by at least 300 SEK or 5 % a year; otherwise request a quote and ask the current provider to match it. A difference is said plainly only for a published price or a quote, and as "If a quote matches it" for an indicative one. Free text from web pages (names, differences, limitations) is checked like register text: no prices, links or instructions.

## Installing and checking

```bash
npm run --silent contracts -- watch-install --dry-run   # what would be added or updated, nothing changed
npm run --silent contracts -- watch-install            # add or update the job, then prove it matches and no other job changed
npm run --silent contracts -- watch-status             # the job's state, the last check, counts of deadlines, research and deliveries
npm run --silent contracts -- watch                    # preview today's alerts: no research, no state change
```

`watch-install` refuses when more than one job has the watch's name. Pause the whole watch with `npm run quiet:disable -- "Assistant contracts: renewal watch"` (after the user's approval, like any job), one contract with `monitor`, or everything at once with `contractRenewalWatch.enabled: false`.

`contracts -- watch-selftest` checks the real runtime path without touching the register: it puts a made-up broadband contract (discount ending in 50 days) in a separate register (`.openclaw/state/contracts-selftest/`), runs one scheduled check with the real research turn, and keeps `selftest-result.json` there. With `--deliver` it prints the alert under a self-test header; run as a one-off command job, that proves the scheduler's announce reaches Telegram. Delete the self-test folder afterwards.

## Not supported

Cancelling, renewing, switching or signing contracts, contacting providers, quote requests or other forms, signing in to provider accounts, BankID, payments and purchases, and paid price services. Hilla can say what to tell the provider; the user does it. The watch never creates Todoist tasks: a task is offered in an alert and created only after the user's yes, under the normal Todoist rules.
