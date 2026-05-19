# Min Golf Setup

Min Golf Phase 1 is a read-only tee-time availability finder. The assistant can prepare a browser search plan, inspect visible availability after you are logged in, and summarize options. It must not book, pay, check in, cancel, edit, add players, or submit account-changing forms.

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

## Approval Rule

Reading visible tee-time availability is allowed. Booking, payment, cancellation, adding players, removing players, editing bookings, cart booking, and check-in require explicit Telegram approval. Phase 1 does not perform those actions even with approval; it only prepares and summarizes options.
