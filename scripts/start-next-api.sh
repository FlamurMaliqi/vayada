#!/usr/bin/env sh

set -eu

: "${APPLICATION_RELEASE:?APPLICATION_RELEASE is required}"

npm --workspace @vayada/backend-migration run target:migrate:dist -- \
  --env production \
  --git-sha "$APPLICATION_RELEASE"

exec npm --workspace vayada-api run start
