# M6 notification delivery and Telegram contact checks

The API writes a `request_notifications` event in the same PostgreSQL transaction as a created or accepted request. Only the bot worker sends Telegram messages. Declines create no notification event. All event/request/user foreign keys cascade on account deletion.

## Queue and recovery

The `notifications` queue carries a strict `{ eventId: UUID }` payload. It never contains the invitation message, public nickname, Telegram ID, username, token or a contact URL. Stable job IDs are `request-<request UUID>-created` and `request-<request UUID>-accepted`. Hyphens are intentional: [BullMQ forbids colons in custom job IDs](https://docs.bullmq.io/guide/jobs/job-ids). Redis job IDs alone cannot ensure idempotency after automatic removal, so the worker also uses an atomic PostgreSQL claim and a terminal event marker.

An API-side `squad-requests-maintenance-v1` scheduler runs every 60 seconds. Each run expires up to 500 due pending requests with `FOR UPDATE SKIP LOCKED` and a conditional pending-state update, then dispatches up to 100 outbox events. A failed enqueue is isolated from later events. Unqueued events are retried on the next scan; events previously enqueued are checked again after 15 minutes to recover from Redis data loss. A retained failed/completed job is settled instead of receiving a fresh retry budget.

The outbox's internal `delivered_at` column is a **terminal processing marker**, including successful sends, events skipped because they are no longer valid, and exhausted delivery attempts. It must not be interpreted as a Telegram read receipt or proof that a message was delivered. A later moderation/operations milestone can introduce separate delivered/skipped/failed outcomes without placing contacts in the outbox.

Normal repeated or concurrent processing sends once: an atomic expiring 60-second claim excludes competing attempts and the terminal marker survives Redis cleanup. A stalled-job retry that encounters an active uncompleted claim waits for its remaining lease instead of completing the job and losing the event. There remains an unavoidable external-side-effect window: Telegram may accept a message just before a process/network/DB failure prevents recording its marker. A retry can then deliver a duplicate. Telegram `sendMessage` offers no application idempotency key; this implementation does not claim exactly-once delivery. Bounded retry exhaustion or permanent failure can also leave a notification undelivered; request state remains available in the Mini App.

## Privacy and state checks

Before sending, the worker locks both participant rows in UUID order, followed by the request row. Request/block API mutations use the same order. Expiry only locks request rows and never acquires a participant lock afterwards. The notification transaction holds these locks through the short Telegram operation, serializing normal delivery with block changes. A transaction can hold the pair's locks for roughly two contact-timeout periods on acceptance; it has a 30-second timeout. This cannot recall a message already accepted by Telegram or give an absolute wall-clock guarantee: an ambiguous network response, transaction timeout or process failure can release DB locks while an external delivery remains in flight. The client must refresh the accepted contact before starting a new conversation.

The worker skips deleted requests, wrong event recipients, outdated request states, expired pending requests, banned/bot-blocked participants, outdated age/rules consent, and either direction of a block. Created events additionally require both profiles to remain published and Steam-linked. The new-request text contains only a safe public nickname, allowlisted CS2 roles and a FACEIT level whose Steam ID matches the linked Steam account. It includes a Mini App button and no contact. Russian is the default; English text is in a secondary translation file.

An accepted event rechecks the accepted participant's current contact using `getChat`, then includes only their current validated `@username`. Contacts are never written into request rows, event rows, Redis jobs or logs. They are checked again by the API when an accepted request's contact is opened. A missing username, known bot-blocked flag, participant block or deleted account prevents later checked disclosure; messages already received in Telegram cannot be recalled. `getChat` does not guarantee immediate bot-block detection: the cached flag is set after Telegram403, including delivery failures. Username/block checks are point-in-time and cannot revoke a previously revealed contact.

## Telegram adapter and retry limits

The shared adapter uses HTTPS POST with JSON, a configurable short timeout, a 64 KiB response bound and fixed errors. It validates the returned private chat's ID against the requested identity. `ChatFullInfo.username` is preferred; the first `active_usernames` entry is a fallback for collectible aliases. Username validation matches the existing Telegram authentication boundary: 1–32 ASCII letters, digits or underscores. Short collectible usernames are supported. Response descriptions, raw exceptions and token-bearing URLs never escape the adapter.

Telegram403 marks the affected user `bot_blocked=true`, settles the event and does not retry. A genuine private `/start` clears this cached flag. Missing/invalid contacts and permanent400 errors are settled without revealing a contact. Network/5xx failures use bounded retries with exponential backoff. Telegram429 uses `parameters.retry_after` in seconds, converted to milliseconds (fallback one second, maximum one hour), extends the queue's global cooldown and consumes the regular retry budget. Backoff never retries earlier than this bounded cooldown. Exhausted events are settled; they are not retried indefinitely.

| Variable | Default | Allowed range |
| --- | --- | --- |
| `NOTIFICATION_CONCURRENCY` | `3` | 1–10 |
| `NOTIFICATION_RATE_LIMIT_PER_SECOND` | `25` | 1–25 |
| `NOTIFICATION_MAX_ATTEMPTS` | `5` | 1–10 |
| `NOTIFICATION_BACKOFF_MS` | `1000` | 250–60000 ms |
| `TELEGRAM_CONTACT_TIMEOUT_MS` | `5000` | 500–10000 ms |

Both API and bot read these settings from the same environment. The notification worker sets global concurrency and the BullMQ limiter to at most 25 jobs/messages per second across replicas. Telegram can apply stricter per-chat/flood controls;429 handling remains necessary. Existing bot command replies are outside this notification queue.

## Official API verification

Verified against official documentation on 2026-10-13; no live token or Telegram account was used:

- [`getChat`](https://core.telegram.org/bots/api#getchat): `chat_id`, up-to-date `ChatFullInfo` response.
- [`ChatFullInfo`](https://core.telegram.org/bots/api#chatfullinfo): `id`, `type`, optional `username`, optional `active_usernames` for private chats.
- [`sendMessage`](https://core.telegram.org/bots/api#sendmessage): `chat_id`, `text`, `reply_markup` and returned `Message`.
- [`InlineKeyboardButton`](https://core.telegram.org/bots/api#inlinekeyboardbutton): a private-chat `web_app` launch button.
- [`ResponseParameters`](https://core.telegram.org/bots/api#responseparameters): `retry_after` is seconds.
- [Telegram username FAQ](https://telegram.org/faq#q-what-are-collectible-usernames-how-are-they-different-from-basic-usernames): collectible aliases and their normal contact links.
- [Telegram bot limits](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this): approximate broadcast and per-chat limits.
- [BullMQ rate limiting](https://docs.bullmq.io/guide/rate-limiting): global limiter and manual cooldown.
- [BullMQ retries](https://docs.bullmq.io/guide/retrying-failing-jobs): bounded attempts and custom backoff.
- [BullMQ Job Schedulers](https://docs.bullmq.io/guide/job-schedulers): `upsertJobScheduler` for repeat maintenance.

Automated tests use only in-memory DB doubles and mocked Telegram responses for the worker/adapter, and a separate local test database for request transactions. Real Telegram bot-block behavior, notification receipt, Mini App launch from messages and real-device contact opening still require a dedicated test bot/account.
