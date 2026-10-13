# M7 moderation

## Reports and blocks

`POST /api/reports` accepts exactly one CS2 `profileId` or owned `requestId`, one reason (`SPAM`, `HARASSMENT`, `CHEATING`, `FAKE_PROFILE`, `CONTACT_SPAM`, `UNDERAGE`, `OTHER`), and optional `details`. Details are normalized Unicode text, at most 500 code points. They are private evidence, so unlike public bios they may contain contact information. The strict response contains only report ID, status, creation time and duplicate flag. No endpoint returns another user's reports or evidence.

The caller needs current age/rules confirmation and a Telegram username. A profile must be visible under the base feed eligibility rules, or belong to a participant in the caller's own request history. This historical path survives unpublication, banning and blocking. Unknown/invisible profiles and foreign/unknown requests return the same `404 REPORT_TARGET_NOT_FOUND`; self-reporting is rejected. An existing OPEN report against the same target within a rolling 24 hours is returned without consuming quota, even if automatic protection has since hidden that player. Reports have a dedicated per-user minute limiter and a serialized rolling daily quota (`REPORTS_PER_DAY=10`); a daily-limit response includes `resetAt` and `Retry-After`.

Automatic protection counts distinct reporters during the last seven days, excluding dismissed reports and reporters currently banned, without linked Steam, or whose account is not older than 24 hours. At `REPORTS_AUTO_HIDE_THRESHOLD=3` all target profiles become unpublished and moderation-hidden, with the previous publication flag retained. The user is flagged for review. This is reversible, does not delete data or ban the account, and cannot be bypassed by editing or publishing a profile. The threshold is a spam safeguard rather than a finding that a report is true. Organized reports from established accounts remain a limitation requiring human review. Dismissing a report does not automatically restore visibility. After reviewing and restoring, dismiss old invalid reports so they do not count toward a later automatic hide.

`GET /api/blocks?limit=20&cursor=...` returns only the caller's blocks using signed keyset pagination, public card projections, and a `profileId` for unblocking. It never returns Telegram contacts, Steam IDs or libraries. Unpublished profiles can remain in this personal management list; unsafe legacy cards are `null`. `DELETE /api/blocks/:profileId` works without Steam/publication, including unpublished targets; missing/foreign blocks use the same 404. Creating a block from a request/report works after either profile is hidden. Blocks cancel pending requests in either direction and prevent future invitations/contact checks. Unblocking only removes the caller's own block and does not restore invitations.

The report dialog confirms intent and offers blocking separately. If a report succeeds but blocking fails, the acknowledgement remains and retry sends only the block action. Reports never imply that a particular moderation outcome is guaranteed.

## Bot administration

Set `ADMIN_TELEGRAM_IDS` to comma-separated numeric Telegram IDs. Empty means nobody is an admin. There is no admin Mini App or HTTP API. Commands are private-chat-only; groups are ignored and outsiders receive the normal unknown-command reply. Both handlers and service methods check the configured IDs. Admin commands/callbacks share a bounded 30-per-minute per-admin quota.

Additional handler/queue/health details: [bot moderation operations](moderation-admin.md).

| Command | Behavior |
| --- | --- |
| `/admin` | Help |
| `/reports` | OPEN reports, three per page, signed actor-bound Next callback |
| `/report <report UUID>` | Reason, state, private explanation, internal IDs and safe profile summary |
| `/user <user UUID>` | Ban/publication flags, dates and aggregate request/block/report counts |
| `/ban <user UUID> <reason>` | Prepare a five-minute, single-use confirmation |
| `/unban <user UUID>` | Prepare a separate confirmation; profiles remain hidden |
| `/hide <user UUID>` | Hide profiles and flag for review |
| `/unhide <user UUID>` | Recheck current consent, username, Steam and valid CS2 fields; restore only previously published profiles |
| `/dismiss <report UUID> [note]` | DISMISSED, resolution time and reviewer |
| `/action <report UUID> [note]` | ACTIONED; does not itself ban/hide a player |
| `/stats` | Aggregate users, published profiles, UTC-day requests and OPEN reports |

No username appears in default admin report lists/details/summaries or notifications. Contact-containing explanations are replaced with a neutral hidden-evidence label. The separate **Show contact** button fetches a current validated username with Telegram `getChat` and records the explicit access in the audit. Report explanations are never copied into audit records. Resolution notes remain private on the report. Administrators must avoid copying private information into external messages or screenshots.

A confirmed ban sets the banned flag, hides profiles, cancels pending requests both ways across games, revokes every session and queues one neutral notice on the transition to banned. It includes `SUPPORT_CONTACT` when configured. Authentication/API/feed reject banned users. Unban restores access only; a separate review and `/unhide` is necessary. Confirmation secrets are hashed in PostgreSQL, bound to an admin and target, expire after five minutes and cannot be replayed. Mutations lock user rows in UUID order before confirmation/request/report rows.

`AdminAuditLog` is append-only in application code: commands, failures, confirmations and explicit contact access create records; no code updates or deletes audit rows. It contains admin Telegram ID, fixed action/result codes, nullable internal target/report references and time. The reason field stores only fixed administrative codes, never report evidence, private invitation text or contacts. Target/report FKs use SET NULL so account deletion and retention preserve the log. Database owners can still alter data directly; database access is outside the bot authorization boundary.

## Notifications and retention

Report creation atomically inserts one moderation outbox event per configured admin. Redis receives only `{eventId}` with stable `moderation-<UUID>` job IDs on the existing notifications queue. The bot checks configuration again before delivery. Messages contain only report ID, reason and internal reporter/target UUIDs. Ban notices use an outbox event bound to the consumed confirmation. Leases and terminal DB markers suppress ordinary duplicate processing. As with M6, a crash after Telegram accepts a message but before recording its marker can cause a duplicate; exactly-once external delivery is not promised. The queue uses bounded retries, exponential backoff, shared concurrency/rate limits and Telegram Retry-After handling. Exhausted/skipped events are terminal. See [notification guarantees](notifications.md).

Every 60 seconds API maintenance processes bounded batches: up to 500 resolved reports older than `REPORT_RETENTION_DAYS=180`, up to 500 EXPIRED/CANCELED/DECLINED requests older than 90 days, and up to 500 confirmation rows expired over seven days ago. Age uses resolution time, falling back to creation for legacy rows. OPEN reports, PENDING and ACCEPTED requests are retained. Each cleanup phase has its own transaction and SKIP LOCKED where needed to avoid broad locks and report/request FK lock cycles. Notification children cascade; report/audit references to removed requests/reports become NULL. Cleanup is eventual while the API worker runs, not an exact deletion deadline.

On confirmed account deletion, reports **by** the user cascade. Reports **about** them retain only reason and moderation metadata: private details/old resolution note are erased, target and reviewer links are removed, state becomes REVIEWED, resolution time is set to deletion time and note is the fixed `ACCOUNT_DELETED` code. They then age out under report retention. Other users' reports reviewed by this user lose the reviewer FK. Sessions, accounts, stats, profiles, games owned, requests and blocks cascade; catalog entries remain. Audit records survive with nullable references. Messages already delivered to Telegram and separately stored backups are not recalled or rewritten; restrict backup access and expiry separately.

## Migration and review

`202610150001_m7_moderation` adds moderation flags, typed report reasons, optional game/request references, resolution metadata, audit, hashed confirmations and moderation outbox tables/indexes. Legacy unknown report reasons become OTHER; old comments are truncated to 500 characters. Back up first. There is no destructive rollback migration; restoring the pre-upgrade backup with the matching code is the recovery path.

Manual review with two test users and one configured admin:

1. Both users accept current rules/age, link Steam and publish CS2 profiles. In feed/lists/notifications, verify no Telegram contacts or hidden activity are shown.
2. User A reports B from a profile and from an owned request. Try OTHER with 500 characters, cancel, repeat, and daily cooldown. Verify one OPEN duplicate, a neutral acknowledgement, and independent optional blocking/retry.
3. Block B, unpublish A, and unblock B in settings. Verify pending requests canceled, contact checks blocked, and unblocking works with B hidden. A third account must not read or report a foreign request.
4. Admin privately checks every command, pages OPEN reports, reads details, explicitly requests a contact and confirms a ban. Verify revoked sessions, feed removal, pending cancellation and one neutral notice. Replay/expire the confirmation; another admin must not consume it. Try the same commands as a regular user and in a group.
5. Unban B: profile stays hidden. `/unhide` restores only valid previously published profiles; invalid consent/Steam/profile prevents restore. Dismiss/action a report and inspect audit records without private text.
6. Delete B with confirmation. Verify sessions/data gone, reports about B anonymized and audit retained. Check `/rules`, `/privacy`, `/help` and profile links in RU/EN on Telegram mobile and desktop.

Automatic hide needs three **distinct** established Steam-linked reporters by default; two test users cannot demonstrate that threshold. Use isolated fixtures (automated integration tests cover it) or additional dedicated test accounts, never production accounts.
