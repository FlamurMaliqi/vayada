#!/usr/bin/env bash

workos_local_validate_origin() {
  local label="$1"
  local origin="${2:-}"

  if [[ -z "$origin" ]]; then
    echo "Missing ${label} origin." >&2
    return 1
  fi

  if [[ ! "$origin" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
    echo "Invalid ${label} origin '${origin}'; expected an exact http(s) origin without credentials, path, query, or fragment." >&2
    return 1
  fi

  if [[ "$origin" =~ :([0-9]+)$ ]]; then
    local port="${BASH_REMATCH[1]}"
    if ((10#$port < 1 || 10#$port > 65535)); then
      echo "Invalid ${label} origin '${origin}'; port must be between 1 and 65535." >&2
      return 1
    fi
  fi
}

workos_local_callback_url() {
  local label="$1"
  local origin="${2:-}"
  workos_local_validate_origin "$label" "$origin" || return 1
  printf '%s/auth/oauth/google/callback\n' "$origin"
}
