# Approval Model

The assistant starts in confirm-before-action mode. It may read configured channels, summarize, draft, plan, and recommend, but it must ask in Telegram before changing external state.

Every approval prompt must say which agent is acting, what action is proposed, which target will change, what effect is expected, and what risk exists. The user can approve or deny. Both approved and denied attempts are logged with the approval prompt context so the decision can be reconstructed later. Denied actions are not retried unless the user asks again.

Trusted routines can be added later only as narrow named exceptions, such as drafting a weekly grocery list or suggesting a gym block. Email sends, calendar changes, Todoist task changes, Min Golf booking changes or payments, purchases, financial actions, browser submissions, destructive shell commands, and sensitive local data access remain approval-gated unless the policy is explicitly changed.
