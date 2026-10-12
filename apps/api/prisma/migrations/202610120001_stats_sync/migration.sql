CREATE TABLE "stats_sync" (
  "user_id" UUID NOT NULL,
  "status" VARCHAR(10) NOT NULL DEFAULT 'IDLE',
  "last_attempt_at" TIMESTAMPTZ(3),
  "last_success_at" TIMESTAMPTZ(3),
  "next_refresh_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "manual_available_at" TIMESTAMPTZ(3),
  "last_error_code" VARCHAR(80),
  "lock_token" UUID,
  "locked_until" TIMESTAMPTZ(3),
  CONSTRAINT "stats_sync_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "stats_sync_status_check" CHECK ("status" IN ('IDLE', 'QUEUED', 'RUNNING', 'FAILED')),
  CONSTRAINT "stats_sync_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "stats_sync_next_refresh_at_user_id_idx" ON "stats_sync"("next_refresh_at", "user_id");
