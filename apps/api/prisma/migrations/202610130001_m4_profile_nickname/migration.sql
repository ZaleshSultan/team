-- Existing profiles retain the Steam persona fallback until an alias is saved.
ALTER TABLE "player_profiles" ADD COLUMN "nickname" VARCHAR(32);
