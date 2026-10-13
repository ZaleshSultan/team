-- Preserve legacy reports while introducing the closed moderation reason set.
ALTER TYPE "ReportStatus" ADD VALUE 'ACTIONED';
CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'HARASSMENT', 'CHEATING', 'FAKE_PROFILE', 'CONTACT_SPAM', 'UNDERAGE', 'OTHER');
CREATE TYPE "AdminConfirmationAction" AS ENUM ('BAN', 'UNBAN');
CREATE TYPE "ModerationNotificationKind" AS ENUM ('ADMIN_REPORT', 'BAN_NOTICE');

ALTER TABLE "users" ADD COLUMN "moderation_flagged_at" TIMESTAMPTZ(3);
ALTER TABLE "player_profiles" ADD COLUMN "moderation_hidden" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "moderation_was_published" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "reports" DROP CONSTRAINT "reports_reported_user_id_fkey";
ALTER TABLE "reports" RENAME COLUMN "comment" TO "details";
ALTER TABLE "reports" RENAME COLUMN "reviewed_at" TO "resolved_at";
ALTER TABLE "reports" RENAME COLUMN "reviewer_user_id" TO "resolved_by";
ALTER TABLE "reports" RENAME CONSTRAINT "reports_reviewer_user_id_fkey" TO "reports_resolved_by_fkey";
ALTER INDEX "reports_reviewer_user_id_idx" RENAME TO "reports_resolved_by_idx";
UPDATE "reports" SET "details" = left("details", 500) WHERE char_length("details") > 500;
ALTER TABLE "reports" ALTER COLUMN "details" TYPE VARCHAR(500),
  ALTER COLUMN "reported_user_id" DROP NOT NULL,
  ALTER COLUMN "reason" TYPE "ReportReason" USING
    (CASE WHEN upper("reason") IN ('SPAM', 'HARASSMENT', 'CHEATING', 'FAKE_PROFILE', 'CONTACT_SPAM', 'UNDERAGE', 'OTHER')
      THEN upper("reason") ELSE 'OTHER' END)::"ReportReason",
  ADD COLUMN "game_id" UUID,
  ADD COLUMN "request_id" UUID,
  ADD COLUMN "resolution_note" VARCHAR(500);
ALTER TABLE "reports" ADD CONSTRAINT "reports_reported_user_id_fkey" FOREIGN KEY ("reported_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "teammate_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "reports_reporter_user_id_reported_user_id_status_created_at_idx" ON "reports"("reporter_user_id", "reported_user_id", "status", "created_at");
CREATE INDEX "reports_status_resolved_at_id_idx" ON "reports"("status", "resolved_at", "id");
CREATE INDEX "reports_game_id_idx" ON "reports"("game_id");
CREATE INDEX "reports_request_id_idx" ON "reports"("request_id");
CREATE INDEX "blocks_blocker_user_id_created_at_id_idx" ON "blocks"("blocker_user_id", "created_at", "id");

CREATE TABLE "admin_audit_log" (
  "id" UUID NOT NULL, "admin_telegram_id" BIGINT NOT NULL,
  "action" VARCHAR(80) NOT NULL, "target_user_id" UUID, "report_id" UUID,
  "reason" VARCHAR(500), "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_audit_log_admin_id_positive" CHECK ("admin_telegram_id" > 0),
  CONSTRAINT "admin_audit_log_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "admin_audit_log_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "admin_audit_log_admin_telegram_id_created_at_idx" ON "admin_audit_log"("admin_telegram_id", "created_at");
CREATE INDEX "admin_audit_log_target_user_id_idx" ON "admin_audit_log"("target_user_id");
CREATE INDEX "admin_audit_log_report_id_idx" ON "admin_audit_log"("report_id");

CREATE TABLE "admin_action_confirmations" (
  "id" UUID NOT NULL, "token_hash" VARCHAR(64) NOT NULL, "admin_telegram_id" BIGINT NOT NULL,
  "target_user_id" UUID NOT NULL, "action" "AdminConfirmationAction" NOT NULL, "reason" VARCHAR(500),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expires_at" TIMESTAMPTZ(3) NOT NULL, "consumed_at" TIMESTAMPTZ(3),
  CONSTRAINT "admin_action_confirmations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_action_confirmations_admin_id_positive" CHECK ("admin_telegram_id" > 0),
  CONSTRAINT "admin_action_confirmations_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "admin_action_confirmations_token_hash_key" ON "admin_action_confirmations"("token_hash");
CREATE INDEX "admin_action_confirmations_expires_at_idx" ON "admin_action_confirmations"("expires_at");
CREATE INDEX "admin_action_confirmations_target_user_id_idx" ON "admin_action_confirmations"("target_user_id");

CREATE TABLE "moderation_notifications" (
  "id" UUID NOT NULL, "kind" "ModerationNotificationKind" NOT NULL,
  "recipient_telegram_id" BIGINT, "recipient_user_id" UUID, "report_id" UUID, "confirmation_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "enqueued_at" TIMESTAMPTZ(3), "delivered_at" TIMESTAMPTZ(3),
  "claim_token" UUID, "claimed_until" TIMESTAMPTZ(3),
  CONSTRAINT "moderation_notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "moderation_notifications_recipient_valid" CHECK (
    ("kind" = 'ADMIN_REPORT' AND "recipient_telegram_id" > 0 AND "report_id" IS NOT NULL AND "recipient_user_id" IS NULL)
    OR ("kind" = 'BAN_NOTICE' AND "recipient_user_id" IS NOT NULL AND "recipient_telegram_id" IS NULL)),
  CONSTRAINT "moderation_notifications_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "moderation_notifications_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "moderation_notifications_confirmation_id_fkey" FOREIGN KEY ("confirmation_id") REFERENCES "admin_action_confirmations"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "moderation_notifications_confirmation_id_key" ON "moderation_notifications"("confirmation_id");
CREATE UNIQUE INDEX "moderation_notifications_report_id_recipient_telegram_id_key" ON "moderation_notifications"("report_id", "recipient_telegram_id");
CREATE INDEX "moderation_notifications_dispatch_idx" ON "moderation_notifications"("enqueued_at", "delivered_at", "created_at", "id");
CREATE INDEX "moderation_notifications_claimed_until_idx" ON "moderation_notifications"("claimed_until");
CREATE INDEX "moderation_notifications_recipient_user_id_idx" ON "moderation_notifications"("recipient_user_id");
