#!/usr/bin/env bash
# One-time portless setup for vayada local dev.
#
# Prereqs:
#   npm install -g portless    # requires Node 24+ (engines pin in root package.json)
#
# This script:
#   1. Installs the portless local CA into the system trust store (sudo prompt).
#   2. Registers the three FastAPI backends as static aliases so portless
#      proxies the named URL to the existing uvicorn port. The TypeScript
#      apps/api and Next.js apps register themselves via package.json when
#      launched through portless.
#
# Naming scheme (full project at https://linear.app project "Adopt portless for local dev URLs"):
#
#   apps/api (TypeScript, registered via package.json):
#     api.localhost                      apps/api               (port 8003)
#
#   Frontends (Next.js, registered via package.json):
#     marketplace.localhost              marketplace-web        (port 3000)
#     admin.localhost                    vayada-admin           (port 3001)
#     booking.localhost                  booking-web            (port 3002)
#     admin.booking.localhost            booking-admin          (port 3003)
#     pms.localhost                      pms-web                (port 3004)
#     landing.localhost                  landing                (port 3006)
#
#   Backends (FastAPI, registered here as static aliases):
#     api.marketplace.localhost          marketplace-api        (port 8000)
#     api.booking.localhost              booking-api            (port 8001)
#     api.pms.localhost                  pms-api                (port 8002)
#
# Run apps/api and frontends via `portless` from each app dir, or from the
# monorepo root to start all workspace apps. Legacy FastAPI backends still run
# via uvicorn or Docker Compose.

set -euo pipefail

if ! command -v portless >/dev/null 2>&1; then
  echo "portless not installed. Run: npm install -g portless" >&2
  exit 1
fi

echo "==> Trusting portless local CA (may prompt for sudo)"
portless trust

echo "==> Registering FastAPI backends as static aliases"
portless alias api.marketplace 8000
portless alias api.booking 8001
portless alias api.pms 8002

echo
echo "==> Active routes:"
portless list
