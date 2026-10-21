# Contracts & Renewals

Hilla keeps a private register of the user's recurring contracts: car, home and pet insurance, electricity, broadband, mobile, gym, streaming and other subscriptions. The user gives the details once, by message, screenshot or the agreement itself, and can then ask what each costs, when it renews, and which discounts end soon. Hilla never cancels, renews, switches, signs or buys a contract and never contacts a provider.

Renewal alerts are not switched on yet. A contract can already be marked as watched (`monitoring.enabled`), which records the user's wish; nothing reads it on a schedule.

## Files

- `agents/personal/skills/contract-renewals/SKILL.md`: the workflow the personal agent follows. `npm run render:config` copies it to `.openclaw/workspace-personal/skills/contract-renewals/`. The personal prompt keeps a two-line `Contracts:` pointer.
- `scripts/contracts.mjs`: the helper the skill runs (`npm run --silent contracts -- …`).
- `scripts/lib/contracts.mjs`: the register: fields, checks, storage, finding a contract, the preview-then-yes flow, and the Telegram text.
- `scripts/lib/contract-dates.mjs`: calendar dates, notice deadlines and each contract's key dates.
- Capability entries: `contracts.*` in `scripts/lib/capabilities.mjs`. Policy: `contractRegister` and the `contracts` approval domain in `config/approval-policy.json`.

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

## Not supported

Cancelling, renewing, switching or signing contracts, contacting providers, quote requests or other forms, signing in to provider accounts, BankID, payments and purchases. Hilla can say what to tell the provider; the user does it.
