#!/usr/bin/env bash
# Start the local Vayada stack with WorkOS/AuthKit on portless.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/workos-local-config.sh"
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.portless.yml)
BACKEND_SERVICES=(
  marketplace-postgres
  booking-postgres
  auth-postgres
  pms-postgres
  auth-db-migrate
  minio
  minio-setup
  media-cdn
  marketplace-backend
  booking-backend
  pms-backend
)
COMPOSE_CONTAINERS=(
  vayada-marketplace-postgres
  vayada-booking-postgres
  vayada-auth-postgres
  vayada-pms-postgres
  vayada-auth-db-migrate
  vayada-minio
  vayada-minio-setup
  vayada-media-cdn
  vayada-marketplace-backend
  vayada-booking-backend
  vayada-pms-backend
)

cd "$ROOT_DIR"

if [[ "${1:-}" == "--stop" ]]; then
  docker compose "${COMPOSE_FILES[@]}" stop "${BACKEND_SERVICES[@]}"
  portless proxy stop >/dev/null 2>&1 || true
  exit 0
fi

if ! command -v portless >/dev/null 2>&1; then
  echo "portless is not installed. Run: npm install -g portless" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not on PATH." >&2
  exit 1
fi

if ! command -v workos >/dev/null 2>&1; then
  echo "WorkOS CLI is not installed. Run: npm install -g workos" >&2
  exit 1
fi

for container in "${COMPOSE_CONTAINERS[@]}"; do
  owner="$(docker inspect "$container" --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' 2>/dev/null || true)"
  if [[ -n "$owner" && "$owner" != "$ROOT_DIR" ]]; then
    echo "Docker container '$container' is owned by another Vayada checkout:" >&2
    echo "  $owner" >&2
    echo "Remove that stale stack first, then rerun npm run dev:workos-local." >&2
    echo "Suggested: docker rm -f ${COMPOSE_CONTAINERS[*]}" >&2
    exit 1
  fi
done

if [[ ! -f apps/api/.env ]]; then
  echo "Missing apps/api/.env with local WorkOS settings." >&2
  exit 1
fi

set -a
source apps/api/.env
set +a

if [[ -z "${WORKOS_API_KEY:-}" ]]; then
  echo "Missing WORKOS_API_KEY in apps/api/.env." >&2
  exit 1
fi

if [[ "${WORKOS_API_KEY:-}" == sk_live_* ]]; then
  echo "Refusing to start local AuthKit with a production WorkOS API key." >&2
  echo "Use the staging WorkOS project locally and copy production branding into staging." >&2
  exit 1
fi

ensure_workos_role() {
  local slug="$1"
  local name="$2"
  if WORKOS_MODE=agent workos role get "$slug" --json >/dev/null 2>&1; then
    return
  fi
  WORKOS_MODE=agent workos role create --slug="$slug" --name="$name" --json >/dev/null
}

workos_config_has() {
  local kind="$1"
  local value="$2"
  WORKOS_MODE=agent workos config "$kind" list --json 2>/dev/null | grep -Fq "\"$value\""
}

ensure_workos_redirect() {
  local url="$1"
  if workos_config_has redirect "$url"; then
    return
  fi
  if ! WORKOS_MODE=agent workos config redirect add "$url" --json >/dev/null; then
    echo "Failed to register WorkOS redirect URI '$url'." >&2
    return 1
  fi
}

ensure_workos_cors() {
  local origin="$1"
  if workos_config_has cors "$origin"; then
    return
  fi
  if ! WORKOS_MODE=agent workos config cors add "$origin" --json >/dev/null; then
    echo "Failed to register WorkOS CORS origin '$origin'." >&2
    return 1
  fi
}

get_portless_origin() {
  local name="$1"
  local origin
  origin="$(portless get "$name" 2>/dev/null || true)"
  if ! workos_local_validate_origin "portless '$name'" "$origin"; then
    echo "Could not resolve a valid portless URL for '$name'." >&2
    return 1
  fi
  printf '%s\n' "$origin"
}

echo "==> Ensuring WorkOS local role slugs exist"
ensure_workos_role platform_admin "Platform Admin"
ensure_workos_role hotel_owner "Hotel Owner"
ensure_workos_role creator_owner "Creator Owner"

unset BOOKING_DATABASE_URL
unset BOOKING_RESERVATIONS_READ_DATABASE_URL
unset BOOKING_PUBLIC_API_URL
unset PMS_API_URL
unset PMS_PUBLIC_API_URL
unset AUTH_COOKIE_DOMAIN

export PORTLESS_PORT="${PORTLESS_PORT:-443}"
export PORTLESS_SYNC_HOSTS="${PORTLESS_SYNC_HOSTS:-0}"

echo "==> Starting portless proxy with wildcard routing"
portless proxy start --wildcard

echo "==> Ensuring portless API aliases exist"
portless alias api 8003
portless alias api.marketplace 8000
portless alias api.booking 8001
portless alias api.pms 8002
portless alias media 9002

# Preserve every worktree-qualified hostname. Browsers do not scope cookies by
# port, and AuthKit validates the exact browser origin for CORS and CSRF.
API_ORIGIN="$(get_portless_origin api)"
PORT_SUFFIX=""
if [[ "$API_ORIGIN" =~ :([0-9]+)$ ]]; then
  export PORTLESS_PORT="${BASH_REMATCH[1]}"
  PORT_SUFFIX=":${PORTLESS_PORT}"
fi
ADMIN_ORIGIN="$(get_portless_origin admin)"
BOOKING_ADMIN_ORIGIN="$(get_portless_origin admin.booking)"
BOOKING_ORIGIN="$(get_portless_origin booking)"
PMS_ORIGIN="$(get_portless_origin pms)"
MARKETPLACE_ORIGIN="$(get_portless_origin marketplace)"
AFFILIATE_ORIGIN="$(get_portless_origin affiliate)"
LANDING_ORIGIN="$(get_portless_origin landing)"
MARKETPLACE_API_ORIGIN="$(get_portless_origin api.marketplace)"
BOOKING_API_ORIGIN="$(get_portless_origin api.booking)"
PMS_API_ORIGIN="$(get_portless_origin api.pms)"
# Keep media canonical because Next image allowlists use this exact local host.
MEDIA_CDN_ORIGIN="https://media.localhost${PORT_SUFFIX}"
BOOKING_PORTLESS_HOST="${BOOKING_ORIGIN#*://}"
unset AUTH_GATEWAY_UPSTREAM_ORIGIN AUTH_PUBLIC_ORIGIN
AUTH_GATEWAY_UPSTREAM_ORIGIN="http://127.0.0.1:8003"

export AUTH_COOKIE_SECRET="${AUTH_COOKIE_SECRET:-local-dev-auth-cookie-secret-0123456789abcdef}"
export TARGET_DATABASE_URL="${TARGET_DATABASE_URL:-${AUTH_DATABASE_URL:-}}"
export API_RUNTIME="${API_RUNTIME:-next}"
export PUBLIC_HOTEL_PROFILE_SOURCE="${PUBLIC_HOTEL_PROFILE_SOURCE:-target}"
export BOOKING_DOMAIN_RESOLUTION_SOURCE="${BOOKING_DOMAIN_RESOLUTION_SOURCE:-target}"
export PUBLIC_BOOKABILITY_SOURCE="${PUBLIC_BOOKABILITY_SOURCE:-target}"
export BOOKING_SETTINGS_SOURCE="${BOOKING_SETTINGS_SOURCE:-target}"
export BOOKING_RESERVATIONS_SOURCE="${BOOKING_RESERVATIONS_SOURCE:-target}"
export FINANCE_SOURCE="${FINANCE_SOURCE:-target}"
export BOOKING_CHECKOUT_COMMAND_SOURCE="${BOOKING_CHECKOUT_COMMAND_SOURCE:-target}"
export BOOKING_HOST_BASE="${BOOKING_HOST_BASE:-${BOOKING_PORTLESS_HOST}}"
export PMS_OPERATIONS_SOURCE="${PMS_OPERATIONS_SOURCE:-target}"
export PMS_OPERATIONS_ALLOWED_ORIGINS="${PMS_OPERATIONS_ALLOWED_ORIGINS:-${PMS_ORIGIN},${BOOKING_ADMIN_ORIGIN},${MARKETPLACE_ORIGIN}}"
export HOTEL_SETUP_BASE_URL="${HOTEL_SETUP_BASE_URL:-${MARKETPLACE_ORIGIN}/setup}"
export HOTEL_SETUP_MARKETPLACE_ORIGIN="${HOTEL_SETUP_MARKETPLACE_ORIGIN:-${MARKETPLACE_ORIGIN}}"
export HOTEL_SETUP_BOOKING_ADMIN_ORIGIN="${HOTEL_SETUP_BOOKING_ADMIN_ORIGIN:-${BOOKING_ADMIN_ORIGIN}}"
export HOTEL_SETUP_PMS_ORIGIN="${HOTEL_SETUP_PMS_ORIGIN:-${PMS_ORIGIN}}"
export AUTH_LOGOUT_URL="${AUTH_LOGOUT_URL:-${ADMIN_ORIGIN}/login}"
export AUTH_ALLOWED_ORIGINS="${API_ORIGIN},${ADMIN_ORIGIN},${BOOKING_ADMIN_ORIGIN},${BOOKING_ORIGIN},${PMS_ORIGIN},${MARKETPLACE_ORIGIN},${AFFILIATE_ORIGIN},${LANDING_ORIGIN}"
export AUTH_COOKIE_SECURE=true
export AUTH_COMPATIBILITY_CALLBACK_ORIGIN="$API_ORIGIN"
export AUTH_PLATFORM_ADMIN_ORIGIN="$ADMIN_ORIGIN"
export AUTH_MARKETPLACE_WEB_ORIGIN="$MARKETPLACE_ORIGIN"
export AUTH_BOOKING_ADMIN_ORIGIN="$BOOKING_ADMIN_ORIGIN"
export AUTH_PMS_WEB_ORIGIN="$PMS_ORIGIN"
export AUTH_AFFILIATE_DASHBOARD_ORIGIN="$AFFILIATE_ORIGIN"
# Marketplace ships its first-party gateway in VAY-1197. Later surface tickets
# append their names; an explicit override can still restore compatibility mode.
export AUTH_FIRST_PARTY_SURFACES="${AUTH_FIRST_PARTY_SURFACES-marketplace-web}"
export AUTH_BOOKING_ADMIN_LOGOUT_URL="${AUTH_BOOKING_ADMIN_LOGOUT_URL:-${BOOKING_ADMIN_ORIGIN}/login}"
export AUTH_PMS_WEB_LOGOUT_URL="${AUTH_PMS_WEB_LOGOUT_URL:-${PMS_ORIGIN}/login}"
export AUTH_AFFILIATE_DASHBOARD_LOGOUT_URL="${AUTH_AFFILIATE_DASHBOARD_LOGOUT_URL:-${AFFILIATE_ORIGIN}/login}"
export AUTH_MARKETPLACE_WEB_LOGOUT_URL="${AUTH_MARKETPLACE_WEB_LOGOUT_URL:-${MARKETPLACE_ORIGIN}/login}"
export AUTH_LEGACY_MARKETPLACE_JWT_SECRET="${AUTH_LEGACY_MARKETPLACE_JWT_SECRET:-your-secret-key-change-in-production}"
export AUTH_LEGACY_BOOKING_JWT_SECRET="${AUTH_LEGACY_BOOKING_JWT_SECRET:-local-legacy-booking-secret}"
export AUTH_LEGACY_PMS_JWT_SECRET="${AUTH_LEGACY_PMS_JWT_SECRET:-local-legacy-pms-secret}"
export AUTH_LEGACY_AFFILIATE_PMS_JWT_SECRET="${AUTH_LEGACY_AFFILIATE_PMS_JWT_SECRET:-local-legacy-affiliate-secret}"
export PLATFORM_MEDIA_BUCKET="vayada-media-local"
export PLATFORM_MEDIA_CDN_BASE_URL="$MEDIA_CDN_ORIGIN"
export PLATFORM_MEDIA_CDN_ORIGIN_HOST="127.0.0.1"
unset AWS_SESSION_TOKEN AWS_SECURITY_TOKEN AWS_PROFILE
export AWS_REGION="us-east-1"
export AWS_ACCESS_KEY_ID="minioadmin"
export AWS_SECRET_ACCESS_KEY="minioadmin"
export AWS_ENDPOINT_URL_S3="http://127.0.0.1:9000"

echo "==> Ensuring WorkOS local app URLs are registered"
for origin in \
  "$API_ORIGIN" \
  "$ADMIN_ORIGIN" \
  "$BOOKING_ADMIN_ORIGIN" \
  "$PMS_ORIGIN" \
  "$MARKETPLACE_ORIGIN" \
  "$AFFILIATE_ORIGIN"; do
  ensure_workos_redirect "$(workos_local_callback_url "WorkOS callback" "$origin")"
done
for origin in \
  "$API_ORIGIN" \
  "$ADMIN_ORIGIN" \
  "$BOOKING_ADMIN_ORIGIN" \
  "$BOOKING_ORIGIN" \
  "$PMS_ORIGIN" \
  "$MARKETPLACE_ORIGIN" \
  "$AFFILIATE_ORIGIN" \
  "$LANDING_ORIGIN"; do
  ensure_workos_cors "$origin"
done

echo "==> Starting Docker databases and FastAPI backends"
docker compose "${COMPOSE_FILES[@]}" up -d "${BACKEND_SERVICES[@]}"

echo "==> Applying target identity/API migrations to local target DB"
npm --workspace @vayada/backend-migration run target:migrate -- --env local

if [[ "${SKIP_SEED:-0}" != "1" ]]; then
  if [[ ! -x .venv/bin/python ]]; then
    python3 -m venv .venv
  fi
  if ! .venv/bin/python - <<'PY' >/dev/null 2>&1
import asyncpg, bcrypt
PY
  then
    .venv/bin/python -m pip install asyncpg bcrypt
  fi
  PYTHON_BIN=.venv/bin/python npm run seed:test-data
fi

children=()

cleanup() {
  if ((${#children[@]})); then
    kill "${children[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup INT TERM EXIT

start_app() {
  local dir="$1"
  local app_port="$2"
  shift 2
  (
    cd "$dir"
    env "$@" PORTLESS_APP_PORT="$app_port" portless run npm run dev
  ) &
  children+=("$!")
}

start_api() {
  (
    cd apps/api
    npm run dev
  ) &
  children+=("$!")
}

COMMON_FRONTEND_ENV=(
  "NEXT_PUBLIC_AUTH_API_URL=${API_ORIGIN}"
  "NEXT_PUBLIC_PLATFORM_MEDIA_API_URL=${API_ORIGIN}"
  "NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED=true"
  "NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED=true"
  "NEXT_PUBLIC_PMS_URL=${PMS_ORIGIN}"
  "NEXT_PUBLIC_PMS_FRONTEND_URL=${PMS_ORIGIN}"
  "NEXT_PUBLIC_MARKETPLACE_URL=${MARKETPLACE_ORIGIN}"
  "NEXT_PUBLIC_MARKETING_URL=${LANDING_ORIGIN}"
  "NEXT_PUBLIC_BOOKING_ADMIN_URL=${BOOKING_ADMIN_ORIGIN}"
  "NEXT_PUBLIC_APP_URL=${MARKETPLACE_ORIGIN}"
)

echo
echo "==> Starting local apps"
echo "    Admin: ${ADMIN_ORIGIN}"
echo "    Booking tenant: https://hotel-alpenrose.${BOOKING_HOST_BASE}"
echo "    Stop with Ctrl-C. Stop Docker services with: npm run dev:workos-local -- --stop"
echo

start_api
start_app apps/marketplace-web 3000 "${COMMON_FRONTEND_ENV[@]}" \
  "AUTH_PUBLIC_ORIGIN=${MARKETPLACE_ORIGIN}" \
  "AUTH_GATEWAY_UPSTREAM_ORIGIN=${AUTH_GATEWAY_UPSTREAM_ORIGIN}" \
  "NEXT_PUBLIC_API_URL=${MARKETPLACE_API_ORIGIN}"
start_app apps/vayada-admin 3001 "${COMMON_FRONTEND_ENV[@]}" \
  "AUTH_PUBLIC_ORIGIN=${ADMIN_ORIGIN}" \
  "AUTH_GATEWAY_UPSTREAM_ORIGIN=${AUTH_GATEWAY_UPSTREAM_ORIGIN}" \
  "NEXT_PUBLIC_API_URL=${API_ORIGIN}"
start_app apps/booking-web 3002 "${COMMON_FRONTEND_ENV[@]}" \
  "NEXT_PUBLIC_BOOKING_WEB_API_URL=${API_ORIGIN}" \
  "NEXT_PUBLIC_API_URL=${BOOKING_API_ORIGIN}" \
  "BOOKING_WEB_API_URL=http://127.0.0.1:8003" \
  "BOOKING_API_URL=http://127.0.0.1:8001"
start_app apps/booking-admin 3003 "${COMMON_FRONTEND_ENV[@]}" \
  "AUTH_PUBLIC_ORIGIN=${BOOKING_ADMIN_ORIGIN}" \
  "AUTH_GATEWAY_UPSTREAM_ORIGIN=${AUTH_GATEWAY_UPSTREAM_ORIGIN}" \
  "NEXT_PUBLIC_API_URL=${API_ORIGIN}" \
  "NEXT_PUBLIC_PMS_API_URL=${PMS_API_ORIGIN}"
start_app apps/pms-web 3004 "${COMMON_FRONTEND_ENV[@]}" \
  "AUTH_PUBLIC_ORIGIN=${PMS_ORIGIN}" \
  "AUTH_GATEWAY_UPSTREAM_ORIGIN=${AUTH_GATEWAY_UPSTREAM_ORIGIN}" \
  "NEXT_PUBLIC_PMS_API_URL=${PMS_API_ORIGIN}" \
  "NEXT_PUBLIC_PMS_OPERATIONS_API_URL=${API_ORIGIN}"
start_app apps/affiliate-dashboard 3005 "${COMMON_FRONTEND_ENV[@]}" \
  "AUTH_PUBLIC_ORIGIN=${AFFILIATE_ORIGIN}" \
  "AUTH_GATEWAY_UPSTREAM_ORIGIN=${AUTH_GATEWAY_UPSTREAM_ORIGIN}" \
  "NEXT_PUBLIC_API_URL=${API_ORIGIN}"
start_app apps/landing 3006 "${COMMON_FRONTEND_ENV[@]}" "NEXT_PUBLIC_API_URL=${MARKETPLACE_API_ORIGIN}"

wait
