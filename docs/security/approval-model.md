# Approval Model

The assistant uses risk-tiered approval. It may read configured channels, summarize, draft, plan, and recommend. It may also perform low-risk additive actions without a second approval when the user's instruction is explicit, all critical fields are complete and unambiguous, the action affects only the user's own data, and the action is easy to undo.

Every approval prompt must say which agent is acting, what action is proposed, which target will change, what effect is expected, and what risk exists. The user can approve or deny. Both approved and denied attempts are logged with the approval prompt context so the decision can be reconstructed later. Denied actions are not retried unless the user asks again.

Approval wording is flexible but must be explicit and tied to a pending approval prompt. Short natural replies such as `approve`, `ok`, `that's ok`, `yes do it`, `go ahead`, `proceed`, `sounds good`, and `looks good` are allowed. Questions, hedges, and denials such as `maybe ok`, `probably`, `is that ok?`, `can you approve this?`, `no`, `stop`, and `cancel` are not approvals.

Low-risk additive actions include creating a Calendar event from details the user typed directly, creating a Todoist task from clear text, and storing a low-risk memory when the user explicitly asks the assistant to remember it. Forgetting one memory by user request is allowed.

Telegram approval is still required when critical fields are inferred from image/OCR, any date/year/time/timezone/calendar/target is uncertain, the action is ambiguous, the action edits/deletes/moves/completes/sends/invites, another person is affected, or sensitive memory/private health/finance data is involved.

Email sends, Calendar edits/deletes/invite responses, Todoist edits/completions/deletions/reschedules, Min Golf bookings or booking changes, payments, purchases, financial actions, browser submissions, destructive shell commands, and sensitive local data access remain approval-gated. Min Golf booking-assist must stop before payment, BankID, third-party redirects, changed terms, mismatched details, or unexpected account changes.
