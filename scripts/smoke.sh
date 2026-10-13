#!/usr/bin/env bash
set -Eeuo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
origin=${SMOKE_ORIGIN:-http://127.0.0.1:8088}
[[ "$origin" =~ ^https?://(127\.0\.0\.1|localhost|[A-Za-z0-9.-]+)(:[0-9]+)?/?$ ]] || { printf '%s\n' 'Invalid SMOKE_ORIGIN' >&2; exit 1; }
origin=${origin%/}
fail() { printf '%s\n' "$1" >&2; exit 1; }
for endpoint in health ready; do
  body=$(curl --silent --fail --max-time 10 --retry 3 --retry-delay 2 --retry-connrefused "$origin/$endpoint" 2>/dev/null) || fail 'API health/readiness failed'
  [[ "$body" =~ ^\{[[:space:]]*\"status\"[[:space:]]*:[[:space:]]*\"ok\"[[:space:]]*\}$ ]] || fail 'Unexpected health response'
done
curl --silent --fail --max-time 10 --output /dev/null "$origin/" 2>/dev/null || fail 'Frontend unavailable'
for service in api bot postgres redis miniapp; do
  container=$(docker compose --profile app ps -q "$service" 2>/dev/null) || fail 'Cannot inspect stack'
  [[ -n "$container" && "$container" != *$'\n'* ]] || fail 'Expected one container per service'
  state=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null) || fail 'Cannot inspect health'
  [[ "$state" == 'running healthy' ]] || fail 'A service is not healthy'
done
printf '%s\n' 'API, readiness, frontend and container health: OK'
