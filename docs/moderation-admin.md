# Telegram moderation operations

Set `ADMIN_TELEGRAM_IDS` to a comma-separated list of positive numeric Telegram IDs and restart the bot. The default is empty: nobody has admin access. These identities do not need a Squad account. Use a dedicated test bot to validate access before configuring real administrators. Never put the bot token in commands, reports or logs.

Admin commands and callbacks run only in the administrator's own private chat. Group/inline callbacks are ignored. Other private users receive exactly the same response as an unknown command. No admin route exists in the public API or Mini App. The bot enforces 30 commands/callbacks per minute per configured administrator; rate-limit outcomes are audited too. This local quota assumes one polling bot process; do not run multiple polling replicas.

| Command | Effect |
| --- | --- |
| `/admin` | Command reference. |
| `/reports` | OPEN reports, newest first; three per page with a signed, admin-bound keyset button. |
| `/report <UUID>` | Report detail, internal IDs and safe public summary. |
| `/user <UUID>` | Publication/moderation/ban state, creation date and report/request/block counts. |
| `/ban <UUID> <reason>` | Prepare a five-minute, single-use confirmation. |
| `/unban <UUID>` | Prepare a confirmation to restore account access. |
| `/hide <UUID>` | Unpublish all profiles and flag for review, remembering which were published. |
| `/unhide <UUID>` | Validate current consent, Steam and CS2 profile; restore only previously published profiles and clear the hide flag. |
| `/dismiss <report UUID> [note]` | Set DISMISSED and save a private resolution note. |
| `/action <report UUID> [note]` | Set ACTIONED and save a private note; it does not automatically ban a user. |
| `/stats` | Total users, published profiles, requests since midnight UTC and open reports. |

Every recognized action, including reads, Show contact, preparation, confirmation, invalid/not-found attempts and rate-limit outcomes, creates an append-only `admin_audit_log` row. The application never updates or deletes audit rows. Reasons in this log are fixed action/result codes, never evidence, messages, contacts or arbitrary administrator notes. The ban preparation reason is private in the confirmation row; report resolution notes are private on the report. A registered administrator's Squad ID becomes `resolved_by`; otherwise it is null. User/report references use SET NULL so the audit survives deletion/retention.

Report details may contain contact evidence, so any details containing contact-like text are fully redacted from the bot's default report display. Unsafe public names are replaced with the generic player label. Neither report reads nor lists reveal Telegram usernames. The explicit **Show contact** button on `/report` or `/user` performs a new bounded Telegram `getChat` check and displays only the target's current validated username. It never displays the reporter's contact or unredacts their evidence. This disclosure is audited. Telegram contact checks are point-in-time, as described in [requests](requests.md).

Ban/unban confirmation callbacks contain a random 24-byte secret, with only its SHA-256 hash persisted. They are bound to the administrator, expire after five minutes, and are consumed under row lock. The action locks all involved users in UUID order before the confirmation/report row. Confirming a ban atomically restricts access, hides profiles, cancels all pending requests in either direction/across games, revokes every session and writes one neutral ban-notice outbox event for the transition. A repeated ban on an already banned user sends no extra notice. Unban restores access and leaves profiles hidden; use `/unhide` after review. Drafts that were hidden are not inadvertently published by unhide. Invalid/currently banned profiles cannot be restored.

Moderation events share the existing `notifications` queue with request notifications, so they share its global concurrency and at-most-25-jobs/second limiter. Redis payloads contain only `{eventId}`. New-report notifications contain a report UUID, enum reason and internal user IDs; no details, messages or Telegram usernames. Removed administrators and deleted reports are skipped at delivery. A ban notice uses `SUPPORT_CONTACT` when configured (`@username` or `https://t.me/username`), otherwise a neutral administrator fallback. Missing/blocked recipients and permanent failures settle the event; 429/backoff and bounded retries reuse the M6 policy. Atomic claims and terminal markers make normal duplicate jobs idempotent, but a process failure after Telegram accepts a message and before its marker commits can still produce a duplicate. No exactly-once delivery claim is made.

The bot writes an atomic health heartbeat every 15 seconds only when its polling loop, database probe and shared notification worker/Redis probe are healthy. Unhealthy, stale or missing heartbeats fail the container check. An unavailable DB/Redis cannot make the readiness heartbeat healthy. Docker restart-on-failure restarts a process that exits; Docker health status alone does not restart an otherwise running unhealthy process.

Public `/rules`, `/privacy` and `/help` commands and their fixed `/start rules`, `/start privacy`, `/start help` payloads are available in private chats in Russian and English. Their age, report-retention and support settings come from validated configuration. Sending a teammate request expresses the sender's consent; acceptance expresses the recipient's consent before mutual contact exchange.

Verified protocol references: [Telegram InlineKeyboardButton](https://core.telegram.org/bots/api#inlinekeyboardbutton) defines callback data's 1–64-byte bound; [CallbackQuery](https://core.telegram.org/bots/api#callbackquery) requires answering callbacks to clear the client spinner. [BullMQ rate limiting](https://docs.bullmq.io/guide/rate-limiting) documents that a queue's limiter is global across its workers. Live Telegram delivery, real account contact changes and Redis transport were not exercised by these deterministic bot tests.
