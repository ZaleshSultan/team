-- Keep the existing request/block tables and the reciprocal pending-pair
-- uniqueness invariant. Rename the legacy spelling without rewriting rows.
ALTER TYPE "TeammateRequestStatus" RENAME VALUE 'CANCELLED' TO 'CANCELED';

-- PostgreSQL LEFT counts characters, matching the normalized Unicode API limit.
-- Legacy messages longer than the new 200-character maximum are truncated.
ALTER TABLE "teammate_requests"
  ALTER COLUMN "message" TYPE VARCHAR(200) USING LEFT("message", 200),
  ADD COLUMN "expires_at" TIMESTAMPTZ(3);

UPDATE "teammate_requests" SET "expires_at" = "created_at" + INTERVAL '7 days';
ALTER TABLE "teammate_requests"
  ALTER COLUMN "expires_at" SET DEFAULT (now() + INTERVAL '7 days'),
  ALTER COLUMN "expires_at" SET NOT NULL;

-- Existing inbox (to_user_id,status,created_at) and daily-quota
-- (from_user_id,created_at) indexes are retained.
CREATE INDEX "teammate_requests_from_user_id_status_created_at_id_idx"
  ON "teammate_requests" ("from_user_id", "status", "created_at", "id");
CREATE INDEX "teammate_requests_status_expires_at_id_idx"
  ON "teammate_requests" ("status", "expires_at", "id");

CREATE TYPE "RequestNotificationKind" AS ENUM ('CREATED', 'ACCEPTED');
CREATE TABLE "request_notifications" (
  "id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "recipient_user_id" UUID NOT NULL,
  "kind" "RequestNotificationKind" NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "enqueued_at" TIMESTAMPTZ(3),
  "delivered_at" TIMESTAMPTZ(3),
  "claim_token" UUID,
  "claimed_until" TIMESTAMPTZ(3),
  CONSTRAINT "request_notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "request_notifications_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "teammate_requests" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "request_notifications_recipient_user_id_fkey"
    FOREIGN KEY ("recipient_user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "request_notifications_request_id_kind_key"
  ON "request_notifications" ("request_id", "kind");
CREATE INDEX "request_notifications_recipient_user_id_idx"
  ON "request_notifications" ("recipient_user_id");
CREATE INDEX "request_notifications_dispatch_idx"
  ON "request_notifications" ("enqueued_at", "delivered_at", "created_at", "id");
CREATE INDEX "request_notifications_claimed_until_idx"
  ON "request_notifications" ("claimed_until");
