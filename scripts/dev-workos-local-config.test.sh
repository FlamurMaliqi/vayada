#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/workos-local-config.sh"

assert_callback() {
  local origin="$1"
  local expected="$2"
  local actual
  actual="$(workos_local_callback_url test "$origin")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Expected callback '$expected', got '$actual'." >&2
    exit 1
  fi
}

assert_invalid_origin() {
  local origin="$1"
  local expected_error="$2"
  local output
  if output="$(workos_local_callback_url test "$origin" 2>&1)"; then
    echo "Expected origin '$origin' to be rejected." >&2
    exit 1
  fi
  if [[ "$output" != *"$expected_error"* ]]; then
    echo "Expected '$expected_error' in error, got '$output'." >&2
    exit 1
  fi
}

assert_callback \
  "https://marketplace.localhost" \
  "https://marketplace.localhost/auth/oauth/google/callback"
assert_callback \
  "https://marketplace.localhost:1355" \
  "https://marketplace.localhost:1355/auth/oauth/google/callback"
assert_callback \
  "https://vay-1195.marketplace.localhost" \
  "https://vay-1195.marketplace.localhost/auth/oauth/google/callback"
assert_callback \
  "http://localhost:3000" \
  "http://localhost:3000/auth/oauth/google/callback"

assert_invalid_origin "" "Missing test origin"
assert_invalid_origin "https://marketplace.localhost/path" "expected an exact http(s) origin"
assert_invalid_origin "https://user@marketplace.localhost" "expected an exact http(s) origin"
assert_invalid_origin "https://marketplace.localhost:65536" "port must be between 1 and 65535"

echo "WorkOS local auth origin checks passed."
