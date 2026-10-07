-- CreateEnum
CREATE TYPE "SteamLinkStatus" AS ENUM ('PENDING', 'STARTED', 'VERIFYING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "TeammateRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'REVIEWED', 'DISMISSED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "telegram_id" BIGINT NOT NULL,
    "username" VARCHAR(32),
    "language" VARCHAR(10) NOT NULL DEFAULT 'ru',
    "age_confirmed_at" TIMESTAMPTZ(3),
    "age_minimum_confirmed" INTEGER,
    "rules_accepted_at" TIMESTAMPTZ(3),
    "rules_version" VARCHAR(50),
    "is_banned" BOOLEAN NOT NULL DEFAULT false,
    "bot_blocked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "privacy_settings" (
    "user_id" UUID NOT NULL,
    "share_steam_activity" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "privacy_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "steam_links" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "start_code_hash" VARCHAR(64) NOT NULL,
    "callback_state_hash" VARCHAR(64),
    "browser_binding_hash" VARCHAR(64),
    "status" "SteamLinkStatus" NOT NULL DEFAULT 'PENDING',
    "return_to" TEXT,
    "realm" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "failure_code" VARCHAR(100),

    CONSTRAINT "steam_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "steam_openid_nonces" (
    "nonce" VARCHAR(255) NOT NULL,
    "steam_link_id" UUID NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "steam_openid_nonces_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "steam_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "steam_id64" BIGINT NOT NULL,
    "persona_name" VARCHAR(100),
    "profile_url" TEXT,
    "avatar_url" TEXT,
    "profile_visibility" INTEGER,
    "game_details_public" BOOLEAN,
    "time_created" TIMESTAMPTZ(3),
    "vac_bans" INTEGER,
    "game_bans" INTEGER,
    "days_since_last_ban" INTEGER,
    "community_banned" BOOLEAN,
    "economy_ban" VARCHAR(50),
    "linked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "synced_at" TIMESTAMPTZ(3),

    CONSTRAINT "steam_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faceit_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "player_id" VARCHAR(100) NOT NULL,
    "steam_id64" BIGINT NOT NULL,
    "nickname" VARCHAR(100) NOT NULL,
    "profile_url" TEXT,
    "level" INTEGER,
    "elo" INTEGER,
    "kd" DOUBLE PRECISION,
    "win_rate" DOUBLE PRECISION,
    "favorite_maps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "linked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "synced_at" TIMESTAMPTZ(3),

    CONSTRAINT "faceit_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "steam_app_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "has_mic" BOOLEAN NOT NULL DEFAULT false,
    "region" VARCHAR(50) NOT NULL,
    "play_times" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "looking_for" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bio" VARCHAR(500) NOT NULL DEFAULT '',
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "player_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_games" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "steam_app_id" INTEGER NOT NULL,
    "game_id" UUID,
    "name" VARCHAR(200),
    "playtime_total" INTEGER NOT NULL,
    "playtime_2weeks" INTEGER,
    "synced_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_clusters" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_cluster_members" (
    "cluster_id" UUID NOT NULL,
    "game_id" UUID NOT NULL,

    CONSTRAINT "game_cluster_members_pkey" PRIMARY KEY ("cluster_id","game_id")
);

-- CreateTable
CREATE TABLE "teammate_requests" (
    "id" UUID NOT NULL,
    "from_user_id" UUID NOT NULL,
    "to_user_id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "status" "TeammateRequestStatus" NOT NULL DEFAULT 'PENDING',
    "message" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "teammate_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocks" (
    "id" UUID NOT NULL,
    "blocker_user_id" UUID NOT NULL,
    "blocked_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "reporter_user_id" UUID NOT NULL,
    "reported_user_id" UUID NOT NULL,
    "reason" VARCHAR(100) NOT NULL,
    "comment" VARCHAR(1000),
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMPTZ(3),
    "reviewer_user_id" UUID,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_id_key" ON "users"("telegram_id");

-- CreateIndex
CREATE INDEX "users_is_banned_idx" ON "users"("is_banned");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "steam_links_start_code_hash_key" ON "steam_links"("start_code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "steam_links_callback_state_hash_key" ON "steam_links"("callback_state_hash");

-- CreateIndex
CREATE INDEX "steam_links_user_id_created_at_idx" ON "steam_links"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "steam_links_expires_at_idx" ON "steam_links"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "steam_openid_nonces_steam_link_id_key" ON "steam_openid_nonces"("steam_link_id");

-- CreateIndex
CREATE INDEX "steam_openid_nonces_expires_at_idx" ON "steam_openid_nonces"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "steam_accounts_user_id_key" ON "steam_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "steam_accounts_steam_id64_key" ON "steam_accounts"("steam_id64");

-- CreateIndex
CREATE INDEX "steam_accounts_synced_at_idx" ON "steam_accounts"("synced_at");

-- CreateIndex
CREATE UNIQUE INDEX "steam_accounts_user_id_steam_id64_key" ON "steam_accounts"("user_id", "steam_id64");

-- CreateIndex
CREATE UNIQUE INDEX "faceit_accounts_user_id_key" ON "faceit_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "faceit_accounts_player_id_key" ON "faceit_accounts"("player_id");

-- CreateIndex
CREATE UNIQUE INDEX "faceit_accounts_steam_id64_key" ON "faceit_accounts"("steam_id64");

-- CreateIndex
CREATE INDEX "faceit_accounts_level_elo_idx" ON "faceit_accounts"("level", "elo");

-- CreateIndex
CREATE INDEX "faceit_accounts_synced_at_idx" ON "faceit_accounts"("synced_at");

-- CreateIndex
CREATE UNIQUE INDEX "faceit_accounts_user_id_steam_id64_key" ON "faceit_accounts"("user_id", "steam_id64");

-- CreateIndex
CREATE UNIQUE INDEX "games_slug_key" ON "games"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "games_steam_app_id_key" ON "games"("steam_app_id");

-- CreateIndex
CREATE INDEX "player_profiles_game_id_is_published_created_at_id_idx" ON "player_profiles"("game_id", "is_published", "created_at", "id");

-- CreateIndex
CREATE INDEX "player_profiles_game_id_is_published_region_has_mic_created_idx" ON "player_profiles"("game_id", "is_published", "region", "has_mic", "created_at", "id");

-- CreateIndex
CREATE INDEX "player_profiles_roles_idx" ON "player_profiles" USING GIN ("roles");

-- CreateIndex
CREATE INDEX "player_profiles_languages_idx" ON "player_profiles" USING GIN ("languages");

-- CreateIndex
CREATE INDEX "player_profiles_looking_for_idx" ON "player_profiles" USING GIN ("looking_for");

-- CreateIndex
CREATE UNIQUE INDEX "player_profiles_user_id_game_id_key" ON "player_profiles"("user_id", "game_id");

-- CreateIndex
CREATE INDEX "user_games_steam_app_id_playtime_2weeks_idx" ON "user_games"("steam_app_id", "playtime_2weeks");

-- CreateIndex
CREATE INDEX "user_games_game_id_idx" ON "user_games"("game_id");

-- CreateIndex
CREATE INDEX "user_games_synced_at_idx" ON "user_games"("synced_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_games_user_id_steam_app_id_key" ON "user_games"("user_id", "steam_app_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_clusters_slug_key" ON "game_clusters"("slug");

-- CreateIndex
CREATE INDEX "game_cluster_members_game_id_idx" ON "game_cluster_members"("game_id");

-- CreateIndex
CREATE INDEX "teammate_requests_from_user_id_created_at_idx" ON "teammate_requests"("from_user_id", "created_at");

-- CreateIndex
CREATE INDEX "teammate_requests_to_user_id_status_created_at_idx" ON "teammate_requests"("to_user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "teammate_requests_from_user_id_to_user_id_game_id_status_idx" ON "teammate_requests"("from_user_id", "to_user_id", "game_id", "status");

-- CreateIndex
CREATE INDEX "teammate_requests_game_id_idx" ON "teammate_requests"("game_id");

-- CreateIndex
CREATE INDEX "blocks_blocked_user_id_idx" ON "blocks"("blocked_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "blocks_blocker_user_id_blocked_user_id_key" ON "blocks"("blocker_user_id", "blocked_user_id");

-- CreateIndex
CREATE INDEX "reports_status_created_at_idx" ON "reports"("status", "created_at");

-- CreateIndex
CREATE INDEX "reports_reported_user_id_created_at_idx" ON "reports"("reported_user_id", "created_at");

-- CreateIndex
CREATE INDEX "reports_reporter_user_id_idx" ON "reports"("reporter_user_id");

-- CreateIndex
CREATE INDEX "reports_reviewer_user_id_idx" ON "reports"("reviewer_user_id");

-- AddForeignKey
ALTER TABLE "privacy_settings" ADD CONSTRAINT "privacy_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "steam_links" ADD CONSTRAINT "steam_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "steam_openid_nonces" ADD CONSTRAINT "steam_openid_nonces_steam_link_id_fkey" FOREIGN KEY ("steam_link_id") REFERENCES "steam_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "steam_accounts" ADD CONSTRAINT "steam_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "faceit_accounts" ADD CONSTRAINT "faceit_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "faceit_accounts" ADD CONSTRAINT "faceit_accounts_user_id_steam_id64_fkey" FOREIGN KEY ("user_id", "steam_id64") REFERENCES "steam_accounts"("user_id", "steam_id64") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_profiles" ADD CONSTRAINT "player_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_profiles" ADD CONSTRAINT "player_profiles_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_games" ADD CONSTRAINT "user_games_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_games" ADD CONSTRAINT "user_games_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_cluster_members" ADD CONSTRAINT "game_cluster_members_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "game_clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_cluster_members" ADD CONSTRAINT "game_cluster_members_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teammate_requests" ADD CONSTRAINT "teammate_requests_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teammate_requests" ADD CONSTRAINT "teammate_requests_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teammate_requests" ADD CONSTRAINT "teammate_requests_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_user_id_fkey" FOREIGN KEY ("blocker_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_user_id_fkey" FOREIGN KEY ("blocked_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reported_user_id_fkey" FOREIGN KEY ("reported_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reviewer_user_id_fkey" FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Application invariants not representable in Prisma 6 schema syntax.
ALTER TABLE "users" ADD CONSTRAINT "users_telegram_id_positive"
  CHECK ("telegram_id" > 0);
ALTER TABLE "users" ADD CONSTRAINT "users_age_minimum_positive"
  CHECK ("age_minimum_confirmed" IS NULL OR "age_minimum_confirmed" > 0);

ALTER TABLE "steam_accounts" ADD CONSTRAINT "steam_accounts_public_stats_valid"
  CHECK (
    "steam_id64" > 0
    AND ("profile_visibility" IS NULL OR "profile_visibility" BETWEEN 1 AND 3)
    AND ("vac_bans" IS NULL OR "vac_bans" >= 0)
    AND ("game_bans" IS NULL OR "game_bans" >= 0)
    AND ("days_since_last_ban" IS NULL OR "days_since_last_ban" >= 0)
  );

ALTER TABLE "faceit_accounts" ADD CONSTRAINT "faceit_accounts_public_stats_valid"
  CHECK (
    "steam_id64" > 0
    AND ("level" IS NULL OR "level" BETWEEN 1 AND 10)
    AND ("elo" IS NULL OR "elo" >= 0)
    AND ("kd" IS NULL OR "kd" >= 0)
    AND ("win_rate" IS NULL OR "win_rate" BETWEEN 0 AND 100)
  );

ALTER TABLE "games" ADD CONSTRAINT "games_steam_app_id_positive"
  CHECK ("steam_app_id" IS NULL OR "steam_app_id" > 0);
ALTER TABLE "user_games" ADD CONSTRAINT "user_games_playtime_valid"
  CHECK (
    "steam_app_id" > 0
    AND "playtime_total" >= 0
    AND ("playtime_2weeks" IS NULL OR "playtime_2weeks" >= 0)
  );

ALTER TABLE "teammate_requests" ADD CONSTRAINT "teammate_requests_no_self"
  CHECK ("from_user_id" <> "to_user_id");

-- One pending request per pair/game, including reciprocal requests. A resolved
-- request does not occupy this key; exclusion of all past contacts is service logic.
CREATE UNIQUE INDEX "teammate_requests_pending_pair_key"
  ON "teammate_requests" (
    "game_id",
    LEAST("from_user_id", "to_user_id"),
    GREATEST("from_user_id", "to_user_id")
  ) WHERE "status" = 'PENDING';

ALTER TABLE "blocks" ADD CONSTRAINT "blocks_no_self"
  CHECK ("blocker_user_id" <> "blocked_user_id");
ALTER TABLE "reports" ADD CONSTRAINT "reports_no_self"
  CHECK ("reporter_user_id" <> "reported_user_id");
