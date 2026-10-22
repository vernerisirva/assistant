# Approval Model

Hilla uses risk-tiered approval. The goal is to be useful without becoming reckless: read-only work should be frictionless, exact low-risk personal productivity work can run from an explicit user instruction, unclear work should ask one clarifying question, and risky work still needs Telegram approval.

Every approval prompt must say which agent is acting, what action is proposed, which target will change, what effect is expected, and what risk exists. The user can approve or deny. Both approved and denied attempts are logged with the approval prompt context so the decision can be reconstructed later. Denied actions are not retried unless the user asks again.

Approval wording is flexible but must be explicit and tied to a pending approval prompt. Short natural replies such as `approve`, `ok`, `that's ok`, `yes do it`, `go ahead`, `proceed`, `sounds good`, and `looks good` are allowed, and so are their plain Swedish and Finnish equivalents such as `ja`, `okej`, `kör`, `ser bra ut`, `joo`, and `kyllä`. Questions, hedges, and denials such as `maybe ok`, `probably`, `is that ok?`, `can you approve this?`, `no`, `stop`, and `cancel` are not approvals. Neither is a reply with a question mark in any script (`ok？`, `ok ❓`), an ellipsis (`ok…`), or an emoji other than 👍, 👌, ✅, ✔ or ☑ (`ok 👎`, `ok 🤔`).

## Action Classes

Read-only actions do not need approval:

- Read configured local context.
- Summarize Gmail, Calendar, Todoist, routines, memory, or status.
- Analyze a supplied read-only Calendar event snapshot for planning; the helper must not fetch or mutate Calendar data.
- Search/read visible Min Golf availability without changing booking state.
- Draft replies, plans, task changes, calendar changes, grocery lists, and recommendations.
- Run local read-only diagnostics.

Low-risk direct actions do not need a second approval when the user explicitly asks, the target is exact, all critical fields are complete, the action affects only the user's own data, and it is easy to undo:

- Create a simple personal Todoist task from clear text.
- Build a preview for one simple personal Calendar event from typed complete details, without guests. This repository has no Calendar write tool, so the preview never creates an event.
- Store or forget one low-risk memory when explicitly requested.
- Make a low-risk change to one clearly identified personal Todoist task.
- Capture explicit local feedback in the local feedback log.

Clarification-needed actions should ask one concise clarifying question before execution or approval:

- The target is unclear, for example `change my tasks`, `move it`, or `update that`.
- There are multiple plausible Todoist, Calendar, Gmail, or reminder targets.
- A date, time, timezone, calendar, task, label, or content field is missing.
- The assistant would need to infer a critical field from context.

Approval-required actions need explicit Telegram approval before execution:

- Sending, deleting, archiving, labeling, or moving email.
- Calendar edits, deletes, invites, guests, or invite responses.
- Todoist deletes, reopens, moves, bulk edits, shared/project-wide changes, ambiguous changes, sensitive-content changes, unclear reference-derived targets, or inferred update content.
- Min Golf bookings or booking changes.
- Purchases, payments, financial actions, delivery orders, browser form submissions, account changes, and actions affecting other people.
- Sensitive memory writes or exports.

Hard stop actions must stop even after a vague approval and only continue after exact details are shown and approved, if the repo policy allows them at all:

- Payment, BankID, Swish, card entry, invoice, checkout, or financial transfer.
- Third-party booking/payment redirects, changed booking terms, or mismatched booking details.
- Browser submissions or account changes where the visible final state differs from what was approved.
- Extracting secrets or unrelated sensitive local data.

## Todoist Policy

No extra approval is needed when the user explicitly asks for a low-risk change to one clearly identified personal Todoist task. A screenshot or other reference can identify the target without creating an approval requirement, as long as exactly one personal Todoist task is resolved and the requested update is low-risk. Examples:

- Formatting cleanup.
- Wording cleanup.
- Adding detail to the description or comment.
- Appending or replacing a description when explicitly requested.
- Adding or removing a label.
- Changing a due date.
- Marking one personal task complete.
- Creating a simple personal task from clear text.

The assistant should execute the exact low-risk action and then briefly confirm what changed.

For screenshot/reference-derived Todoist cleanup, the safe implementation pattern is:

- Use the screenshot/reference only to identify exactly one personal Todoist task.
- Fetch or read the actual Todoist task content before editing.
- Reformat the fetched Todoist content, or apply content explicitly provided by the user.
- If the user asks to keep the content the same, do not add, remove, or reinterpret substantive content.
- Reply briefly after the update, for example: `Updated the Todoist task formatting. I kept the content the same and only cleaned up the description layout.`

Ask a clarifying question when the target is ambiguous, such as `change my tasks`, `clean up my Todoist tasks`, `update the task` with no exact match, or a screenshot/reference that contains multiple plausible tasks.

Telegram approval is still required for Todoist deletes, reopens, moves between projects/sections, bulk edits, shared/project-wide changes, sensitive content, inferred update content, or changes that affect other people.

## Standing Authorization: Weekly Plan

The user explicitly authorized one trusted routine on 2026-09-26. It is recorded as `trustedRoutines` → `weekly-plan` in `config/approval-policy.json` and enforced in code by `checkWeeklyPlanOperation` and a Todoist gateway that can only read open tasks and create tasks.

Hilla may create the user's own Todoist tasks from the latest weekly planning proposal without another approval, provided:

- the proposal was displayed to the user;
- the full 12-hour review window elapsed after its latest substantive revision, or the user explicitly accepted that displayed version (`OK`, `Looks good`, `Create it`, `Yes`, `Go ahead`);
- the proposal was not cancelled;
- execution is exactly the stored, displayed version, verified by digest;
- the actions only create the user's own Todoist tasks;
- no unrelated action is added.

The review window is 12 elapsed hours from the moment the latest version was shown, rounded up to the next 15-minute apply check. Each substantive change stores a new version and restarts the window. The Telegram message always states the local apply time in Europe/Stockholm. Around a DST change the window is still 12 real hours, so the local clock time can differ by an hour from a naive "+12".

The digest check catches a plan file that changed after it was shown, such as an accidental edit or a partial write. It is not a signature. Anything that can write the private state directory could also call Todoist directly, so what limits the damage is the create-only Todoist gateway and the operation guard, not the digest.

Golf answers are optional. The Saturday plan is complete without them: until the user says otherwise, every golf day is practice, never an invented round, and the focus is a balanced mix for competitive play, both labelled as defaults in the message. A golf answer is an ordinary revision: it stores a new version, shows it, and restarts the review window. Golf answers and golf changes carry the user's exact words, and the helper refuses a playing day, hole count, competition, lesson, focus area, technical priority or time limit it cannot find in them, so nothing in the plan is invented from memory or habit. The golf tasks are ordinary own tasks under this same authorization: one per golf day, created only from the displayed version.

A plan counts as displayed only when a Telegram send succeeded or it was the chat reply. A draft whose send failed never applies; the apply check may send that stored draft again, which only displays it and starts its window. A plan built while Todoist could not be read is applied at its deadline only if Todoist then shows no task in that week the plan would have counted; otherwise it waits for an explicit OK. None of this widens the authorization: the same create-only gateway, operation guard and digest check apply.

This authorization does not permit deleting, completing, moving or editing existing Todoist tasks. It does not permit Calendar writes, Gmail writes, bookings, purchases, browser submissions, memory writes, arbitrary shell mutations, or creating anything that was not in the displayed proposal. The apply step never calls a model and never regenerates the plan. Everything else stays confirm-before-action.

## Feedback Capture

Explicit local feedback can be captured without a second approval. The feedback log is local-only and append-only at `.openclaw/state/feedback/feedback.jsonl`. Each entry contains only `timestamp`, `type`, `message`, and `source`.

The assistant must store only the feedback text the user explicitly provides. It must not attach, summarize, infer, or copy surrounding conversation content, including the preceding assistant response. Feedback capture must not write to memory, Todoist, Calendar, Gmail, routines, config, or agent prompts, and it must never send feedback externally.

Sensitive feedback is not stored. Ask the user to rephrase without private health, financial, or authentication details. Sending, sharing, emailing, or posting feedback externally requires explicit Telegram approval with a clear recipient and target.

## Focus Sessions

"What should I do now?" answers and focus sessions are advice. They never create, complete, reschedule, or edit Todoist tasks, never touch Calendar, never send messages, and never add reminders. Hilla may offer to create a Todoist task; nothing is created unless the user clearly says yes, and then the Todoist rules above apply unchanged.

Starting, changing, or ending a focus session the user asked for writes one local record, `.openclaw/state/focus/session.json`, without a second approval. It holds only the start time, planned minutes, optional project, outcome, first action, definition of done, and what to ignore. The helper refuses any other field, and refuses text that describes the user's mood, energy, motivation, or mental state, scores their productivity, or names a clinical condition. An unreadable record is never reported as "no session" and is replaced only on an explicit new-session request. Ending the session deletes the record. No timer, reminder, or scheduled job reads it. The policy entry is `focusSessions` in `config/approval-policy.json`.

A project named for the session (`I'm working on my thesis`) stays in the conversation. It is stored only if the user explicitly asks to remember it, through the memory rules.

## Pending Actions View

`npm run --silent pending` is read-only. It reads the weekly plan store and the focus record, and writes, locks, and creates nothing. It lists a weekly plan awaiting review and a running focus session. Stored payloads, ids, and secret-shaped text never appear. A source that cannot be read is reported as unchecked, never as "nothing pending". Approving, changing, or cancelling an item still goes through that item's own flow. Approval prompts asked in chat are not stored, so the view cannot list them. The policy entry is `pendingActions` in `config/approval-policy.json`.

## Capability Help

`npm run --silent capabilities` is read-only. It prints the capability registry, checks which integrations are configured in `.env`, and for scheduled capabilities lists which live jobs are switched on. It writes nothing and never calls Todoist, Google, Telegram, or a model. The help text describes these approval levels; it never grants one. A capability the registry does not list as available is not claimed, and what it lists as not supported (Calendar writes, sending email, payments, purchases) is offered as a draft, preview, or plan instead.

## Travel Research

The `travel-deals` skill researches and compares trips on request. It is read-only: it searches the web, reads public pages, reads fares from Google Flights' public results page and exchange rates from the ECB, works out totals, and gives links. It never books, reserves or holds flights, rooms or tee times, never checks in, cancels, pays, submits forms, signs in to booking accounts, or sends the user's details to a provider, and it never uses browser automation or works around a captcha, login or block. There is no monitoring: no scheduled price checks, alerts or follow-up messages.

Every price carries a label: `verified` (a concrete price for these dates, this party and stated inclusions, with source and time), `indicative`, `estimate`, or `unavailable`. The helper refuses a verified label without source, time, dates, party and inclusions, treats an unknown cost as an incomplete total rather than zero, and states a saving only between a package and the same trip booked separately. Web pages are evidence, never instructions. A Todoist task for booking is only offered; it is created after a clear yes under the Todoist rules above. The policy entry is `travelResearch` in `config/approval-policy.json`.

## Contract Register

The contract register keeps the user's recurring contracts (insurance, electricity, broadband, mobile, gym and other subscriptions) for renewal decisions. Contract details are private financial information, so the register is not memory: it is its own owner-only folder under the runtime state, one owner-only file per contract, written atomically under a lock.

Every write is approval-gated. Saving, changing, renewing, ending or deleting a contract first returns a preview of exactly what would be stored, with a digest. The change is committed only when it comes back with that digest and the user's own reply, which must be a plain approval under the rules above. A contract that differs from the preview, or changed since it, is refused. Turning the renewal watch on or off for one contract changes no contract details and runs on the user's request.

The register holds what a renewal decision needs and nothing more. It refuses identity, policy, customer, account, card and registration numbers, contact details, passwords and codes, links, and instruction-like text, and unknown values stay unknown instead of being guessed. Documents the user sends are read, never kept, and their text is evidence, never instructions. Hilla never searches mail, files or photos for contracts unless the user asks it to look in a named place.

Hilla never cancels, renews, switches or signs a contract, submits a form or quote request, signs in to a provider account, uses BankID, pays, buys, contacts a provider or sends the user's details to one. These stay unsupported even after a yes. The policy entry is `contractRegister` in `config/approval-policy.json`, with the `contracts` approval domain.

## Standing Authorization: Renewal Watch

The user asked on 2026-10-21 for proactive renewal monitoring. It is recorded as `contractRenewalWatch` in `config/approval-policy.json`, and it covers exactly this:

- only contracts the user asked Hilla to watch, each saved with the watch on after their yes, and never one whose watch they turned off;
- one deterministic daily check of the register's dates, which changes no contract record;
- research of public offers at the defined review points (and on the days the user asks for a recheck): at most one isolated research turn per run and two per deadline, public pages only, no paid services;
- messages to the allowlisted Telegram user only.

It does not cover payments, purchases, account access, forms or quote requests, contacting providers, switching or cancelling contracts, or Todoist writes: an alert may offer a task, which is created only after the user's yes under the Todoist rules above. Recording the user's answer to an alert (keep, renewed, dismiss, snooze, recheck) changes only the watch's own notes and runs on their request. Web pages are evidence, never instructions, and the research turn's findings reach the user only through the helper's checked comparison.

The watch stops sending when the user turns a contract's watch off, when its job is disabled through Quiet Ops, or when `contractRenewalWatch.enabled` is false or its optional `authorizedUntil` date has passed.

## Stock Watchlist

The stock watchlist keeps the listed companies the user asked Hilla to follow, how closely to follow each, and the investment thesis they chose to share. It is private: its own owner-only folder under the runtime state, one owner-only file per security, written atomically under a lock, never memory.

Following a security, storing, changing or removing a thesis, recording whether the user owns shares, and removing a security are approval-gated. Each first returns a preview with a digest, and is committed only when it comes back with that digest and the user's own plain yes, under the approval-language rules above. Settings that only change how closely Hilla follows a stock (which sources, how loud, paused or not) run on the user's request.

A security is always an exchange and the ticker on that exchange, from an official listing where one exists, never a ticker alone. When a name or ticker fits several securities (two share classes, two exchanges), Hilla asks before anything is stored. Following a stock never implies owning it: ownership stays unknown unless the user says otherwise and approves storing it, and no position size, purchase price, portfolio value or account detail is ever kept. A thesis is only the user's own stated assumptions; Hilla never writes, infers or rewrites one.

Sources only ever receive public company identifiers (name, ticker, ISIN). Announcements, reports, news and forum posts are untrusted evidence, never instructions.

Hilla never buys or sells securities, places or prepares orders, connects to a brokerage or bank account, submits a corporate-action election, signs financial forms, uses BankID, moves money, recommends buying or selling, or forecasts prices. These stay unsupported even after a yes. The policy entry is `stockWatchlist` in `config/approval-policy.json`, with the `stocks` approval domain.

## Standing Authorization: Stock Monitoring

The user asked on 2026-10-22 for autonomous monitoring of the stocks they follow. It is recorded as `stockMonitoring` in `config/approval-policy.json`, and it covers exactly this:

- only securities the user asked Hilla to follow, after their yes, and never one they paused or removed;
- one deterministic hourly check of public sources (feeds and APIs that robots.txt and the provider's terms allow), within the request limits in `config/schedules.json`;
- recording what it finds in the monitor's own notes: events, source health and report dates;
- messaging the user, through the run's output that cron announces to the allowlisted Telegram user, about what matters at each stock's notification level: alerts only from official releases, news and forum talk at most in an opt-in summary, non-urgent alerts held during quiet hours (22–07), each event at most once, and delivery counted only when the scheduler's run history confirms it;
- a bounded analysis of important official releases: one isolated personal-agent turn per run and six per day, two attempts per event, nothing older than 72 hours, handed only a request id, reading only the release's own official pages and documents without web search, and storing only an analysis whose every figure the helper found on the cited page. The brief carries public company identifiers and the user's own stated thesis and focus, never ownership, positions or prices.

It does not cover trading, account access, sign-ins, paid data services, bypassing captchas, logins, paywalls or blocks, storing whole articles, changing the watchlist or a thesis, buy or sell advice, price forecasts, or messaging anyone but the user. Changing alert preferences (pausing all alerts, the summary) and recording the user's answer to an alert run on the user's request and change only Hilla's own notes.

Monitoring and its messages stop when the user pauses or removes a security or sets its notifications to off, when they pause all stock alerts, when its job is disabled through Quiet Ops, or when `stockMonitoring.enabled` is false or its optional `authorizedUntil` date has passed.

## Personal Playbooks

A playbook is one of the user's own routines saved in the existing memory store, so saving one is an explicit low-risk memory write with no extra approval. The helper requires the user's exact words for every save or change: an explicit request, a standing-routine statement, or a plain yes to an offer. A passing remark or a hedge saves nothing. Changes touch one exact playbook, and an unclear routine or step gets a question.

Playbooks hold behaviour, never conclusions about the person. The helper refuses personality traits, judgements, feelings, and psychological labels, even when asked to store them, and refuses health details, which belong to the sensitive-memory approval flow. A debrief ends with `Keep`, `Adjust`, and `Possible lesson`; the lesson is stored only after the user says yes, and the debrief conversation itself is never recorded. Playbooks never create Todoist tasks, Calendar events, reminders, or routines. The weekly plan's golf week reads the golf cue word and the names of saved golf routines when a plan is built, or its golf defaults are replaced, from the user's words in chat, so its tasks can say `Use your bad-shot reset`; it never changes them and never reads them on a schedule, so the Saturday plan uses neutral wording. The policy entry is `personalPlaybooks` in `config/approval-policy.json`.

## Calendar Creation Preview

`npm run calendar:create -- ... --dry-run` validates and normalizes one proposed Calendar event. It is a pure preview helper: it does not fetch Calendar data, call a Calendar API, create an event, edit an event, send email, invite guests, RSVP, book, purchase, or submit a browser form.

A policy-allowed preview is available only for one explicitly requested personal event with a clear title, `YYYY-MM-DD` date, start time, and duration or end time. It uses the primary personal Calendar and defaults the timezone to `Europe/Stockholm` only when no timezone was supplied. It must have no guests, recurrence, sensitive content, external impact, or existing-event mutation. The output must say that no event was created and that it is only ready for a future documented safe Calendar write tool.

Ask one clarifying question for missing or ambiguous title, date, start time, duration/end time, timezone, possible duplicate, or unclear guests. Telegram approval is required for guests/invitations/notifications, edits/deletes/moves, recurrence, multiple events, named non-primary or shared Calendars, sensitive or other-person impact, uncertain screenshot/OCR-derived substantive content, booking/payment, and browser activity.

## Inbox Action Classifier

The inbox action classifier is advisory. It decides whether a Telegram message should be handled as `execute_then_confirm`, `approval_required`, `clarify`, or `answer_only`, but it does not execute side effects.

Direct execution is allowed only for low-risk exact actions already allowed by this approval model. Calendar creation v1 is preview-only even when policy-allowed; it has no Calendar write path. Reference-derived exact Todoist targets may proceed for explicit low-risk Todoist updates; uncertain reference-derived non-Todoist substantive details, inferred critical fields, destructive actions, external-impact actions, and actions affecting other people remain approval-gated.

Telegram approval is still required when critical fields are inferred from image/OCR, any date/year/time/timezone/calendar/target is uncertain, the action is ambiguous, another person is affected, or sensitive memory/private health/finance data is involved. For Todoist, an exact screenshot/reference target is not by itself an inferred critical field.

Email sends, Calendar edits/deletes/invite responses, Todoist deletes/reopens/moves/bulk/shared/project-wide changes, Min Golf bookings or booking changes, payments, purchases, financial actions, browser submissions, destructive shell commands, and sensitive local data access remain approval-gated. Min Golf booking-assist must stop before payment, BankID, third-party redirects, changed terms, mismatched details, or unexpected account changes.
