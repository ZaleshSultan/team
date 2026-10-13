#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
backup_dir=${BACKUP_DIR:-./backups}
keep=${BACKUP_KEEP:-14}
[[ "$keep" =~ ^[1-9][0-9]*$ ]] && (( keep <= 10000 )) || { printf '%s\n' 'Invalid BACKUP_KEEP' >&2; exit 1; }
mkdir -p -- "$backup_dir"
backup_dir=$(cd -- "$backup_dir" && pwd -P)
# The file lock prevents overlapping timer/manual backups and retention races.
exec 9>"$backup_dir/.backup.lock"
flock -n 9 || { printf '%s\n' 'A backup is already running' >&2; exit 1; }
temporary=$(mktemp "$backup_dir/.squad-backup.XXXXXXXX")
cleanup() { rm -f -- "$temporary"; }
trap cleanup EXIT
filename="$backup_dir/squad-$(date -u +%Y%m%dT%H%M%SZ)-$$.sql.gz"
# Credentials expand only INSIDE the postgres container; not in host arguments,
# command output or archive name. Never source .env as shell code.
if ! docker compose exec -T postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump --no-password --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>/dev/null | gzip -c >"$temporary"; then
  printf '%s\n' 'Database backup failed; no backups removed' >&2; exit 1
fi
gzip -t -- "$temporary" 2>/dev/null || { printf '%s\n' 'Backup verification failed' >&2; exit 1; }
mv -- "$temporary" "$filename"
mapfile -t archives < <(find "$backup_dir" -maxdepth 1 -type f -name 'squad-????????T??????Z-*.sql.gz' -printf '%f\n' | LC_ALL=C sort -r)
for ((index=keep; index<${#archives[@]}; index++)); do rm -f -- "$backup_dir/${archives[index]}"; done
printf '%s\n' 'Backup created and gzip verified; retention applied'
