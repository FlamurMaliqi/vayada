#!/usr/bin/env bash
# Start the transitional portless stack with Docker support services.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.portless.yml)
BACKEND_SERVICES=(
  marketplace-postgres
  booking-postgres
  auth-postgres
  pms-postgres
  auth-db-migrate
  minio
  minio-setup
  marketplace-backend
  booking-backend
  pms-backend
)

cd "$ROOT_DIR"

if [[ "${1:-}" == "--stop" ]]; then
  docker compose "${COMPOSE_FILES[@]}" stop "${BACKEND_SERVICES[@]}"
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

echo "==> Starting Docker databases and FastAPI backends"
docker compose "${COMPOSE_FILES[@]}" up -d "${BACKEND_SERVICES[@]}"

echo "==> Ensuring portless API aliases exist"
portless alias api.marketplace 8000
portless alias api.booking 8001
portless alias api.pms 8002

echo
echo "==> Starting portless apps"
echo "    Apps: https://api.localhost, https://marketplace.localhost, https://booking.localhost, https://pms.localhost, https://admin.localhost"
echo "    Stop portless apps with Ctrl-C. Stop Docker backends with: $0 --stop"
echo

exec portless
