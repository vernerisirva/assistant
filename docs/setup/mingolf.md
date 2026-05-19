# Min Golf Setup

Min Golf Phase 1 is a read-only tee-time availability finder. Phase 2 adds booking-assist: the assistant can draft an exact booking approval request and then attempt a non-payment booking only after explicit Telegram approval. It must not pay, check in, cancel, edit, add players, or continue through unexpected account-changing forms.

## Login

Use the Min Golf website or booking app directly when login is needed. Do not put Golf-ID, BankID, passwords, or Min Golf session data in `.env`.

Official entry points:

- Min Golf booking: https://golf.se/mingolfbokning
- Min Golf booking help: https://help.golf.se/min-golf---bokningsapp/min-golf-bokning/
- Tee-time purchase terms: https://help.golf.se/ovrigt/regelverk-for-git-och-min-golf/allmanna-kopevillkor-starttidsbokning-i-min-golf/

## Local Commands

Create a read-only browser search plan:

```bash
npm run mingolf -- search --club "Stockholms Golfklubb" --date 2026-05-23 --from 08:00 --to 12:00 --players 2
```

Area-based example:

```bash
npm run mingolf -- search --area Stockholm --date 2026-05-23 --players 1 --holes 18
```

The command returns JSON with criteria, browser steps, and forbidden actions. It does not log in, book, pay, or change anything.

Draft a booking approval request from an exact visible tee time:

```bash
npm run mingolf -- booking-request --club "Stockholms Golfklubb" --course "Gamla banan" --date 2026-05-23 --time 09:40 --players 2 --price "650 SEK/player" --payment pay-later --cancellation "Cancel by 18:00 the day before"
```

The booking request returns an approval prompt with the required fields: agent, action, target, expected effect, risk, and approval options. The user must reply with `approve Min Golf booking` before the assistant attempts the exact booking.

## Phase 2 Stop Rules

After approval, the assistant still stops if:

- The final booking summary does not exactly match the approved club, course, date, time, player count, price, payment rule, or cancellation rule.
- The time is no longer available.
- Payment is required, including Swish, card, invoice, part payment, or checkout.
- BankID or another strong authentication step appears.
- The flow redirects to Sweetspot or another booking system.
- Terms, cancellation rules, or no-show rules changed from what was approved.
- Any unexpected account change appears.

## Approval Rule

Reading visible tee-time availability and drafting booking approval requests is allowed. Booking, payment, cancellation, adding players, removing players, editing bookings, cart booking, and check-in require explicit Telegram approval. Phase 2 can attempt only a non-payment tee-time booking that exactly matches the approved details; payment and strong authentication remain manual stop points.
