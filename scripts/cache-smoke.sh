#!/usr/bin/env bash
set -euo pipefail

BASE_URL=${BASE_URL:-http://localhost:8403}
AUTH_TOKEN=${AUTH_TOKEN:-local-proxy}
MODEL=${MODEL:-sonnet}

SYSTEM_TEXT=${SYSTEM_TEXT:-"You are a cache stability test harness. Follow the instructions carefully and respond in one short sentence. Keep output deterministic. This system block is intentionally long to exceed minimum cache prefix thresholds and provide a stable prefix for prompt caching. Do not mention any timestamps, random values, or external data. Always respond with the same exact wording for identical inputs. Use plain English only, no markdown."}

request_once() {
  local session_id="$1"
  local user_text="$2"
  local system_text="$3"

  local response
  response=$(SYS_TEXT="$system_text" USER_TEXT="$user_text" MODEL="$MODEL" python3 - <<'PY' | curl -sS \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -H "x-session-id: ${session_id}" \
    -d @- "${BASE_URL}/v1/chat/completions"
import json
import os
payload = {
  "model": os.environ.get("MODEL", "sonnet"),
  "messages": [
    {"role": "system", "content": os.environ["SYS_TEXT"]},
    {"role": "user", "content": os.environ["USER_TEXT"]},
  ],
  "max_tokens": 64,
}
print(json.dumps(payload))
PY
  )

  if [ -z "$response" ]; then
    echo "ERROR: empty response from ${BASE_URL}" >&2
    return 1
  fi
  echo "$response"
}

print_usage() {
  python3 -c 'import json,sys; resp=json.load(sys.stdin); usage=resp.get("usage", {}); print("usage:", {"input_tokens": usage.get("input_tokens"), "output_tokens": usage.get("output_tokens"), "cache_creation_input_tokens": usage.get("cache_creation_input_tokens"), "cache_read_input_tokens": usage.get("cache_read_input_tokens"), "prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": usage.get("completion_tokens"), "total_tokens": usage.get("total_tokens")})'
}

print_cache_metrics() {
  curl -sS \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    "${BASE_URL}/metrics" | python3 -c 'import json,sys; resp=json.load(sys.stdin); cache=resp.get("cache", {}); print("cache:", {"hits": cache.get("hits"), "misses": cache.get("misses"), "hitRate": cache.get("hitRate"), "lastHitAt": cache.get("lastHitIso") or cache.get("lastHitAt")})'
}

run_case() {
  local label="$1"
  local session="$2"
  local user="$3"
  local system="$4"
  echo "== ${label} =="
  local response
  response=$(request_once "$session" "$user" "$system")
  echo "$response" | print_usage
}

run_round() {
  local round="$1"
  echo "\n===== cache smoke round ${round} ====="

  # A) same prompt twice
  run_case "A1 same prompt" "smoke-a" "Echo: cache test" "$SYSTEM_TEXT"
  run_case "A2 same prompt" "smoke-a" "Echo: cache test" "$SYSTEM_TEXT"

  # B) whitespace perturbation in system
  local system_perturbed="${SYSTEM_TEXT}\n\n   Additional whitespace."
  run_case "B1 system whitespace" "smoke-b" "Echo: cache test" "$system_perturbed"
  run_case "B2 system whitespace" "smoke-b" "Echo: cache test" "$system_perturbed"

  # C) multi-session concurrent
  echo "== C multi-session concurrent =="
  tmp1=$(mktemp)
  tmp2=$(mktemp)
  tmp3=$(mktemp)
  request_once "smoke-c1" "Echo: cache test" "$SYSTEM_TEXT" >"$tmp1" &
  request_once "smoke-c2" "Echo: cache test" "$SYSTEM_TEXT" >"$tmp2" &
  request_once "smoke-c3" "Echo: cache test" "$SYSTEM_TEXT" >"$tmp3" &
  wait
  echo "session smoke-c1"; cat "$tmp1" | print_usage
  echo "session smoke-c2"; cat "$tmp2" | print_usage
  echo "session smoke-c3"; cat "$tmp3" | print_usage
  rm -f "$tmp1" "$tmp2" "$tmp3"

  print_cache_metrics
}

run_round "${1:-1}"
