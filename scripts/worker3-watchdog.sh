#!/bin/bash
set -euo pipefail

LOG_FILE="/tmp/worker3-watchdog.log"
PROXY_BASE_URL="${PROXY_BASE_URL:-http://127.0.0.1:8403}"
TOKEN_NAME="3"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

get_requests() {
  python3 - "$PROXY_BASE_URL/metrics" "$TOKEN_NAME" <<'PY'
import json, sys, urllib.request
url = sys.argv[1]
token = sys.argv[2]
try:
    with urllib.request.urlopen(url, timeout=10) as r:
        data = r.read()
    js = json.loads(data)
    traffic = js.get("workerStats", {}).get("traffic", {})
    w = traffic.get(token)
    if w is None:
        w = traffic.get(f"worker{token}")
    if w is None:
        w = traffic.get(str(token))
    if not w:
        print("0")
    else:
        print(int(w.get("requests", 0)))
except Exception:
    print("0")
PY
}

probe_once() {
  local before after code
  before="$(get_requests)"
  code=$(curl -s -o /tmp/worker3-watchdog-body -w "%{http_code}" \
    -X POST "$PROXY_BASE_URL/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "x-token-name: $TOKEN_NAME" \
    -d '{"model":"sonnet","messages":[{"role":"user","content":"ping"}],"max_tokens":1}')
  after="$(get_requests)"

  if [[ "$code" =~ ^2 ]]; then
    if [[ "$after" -gt "$before" ]]; then
      log "probe ok http=$code requests_before=$before requests_after=$after"
      return 0
    fi
    log "probe no-growth http=$code requests_before=$before requests_after=$after"
    return 1
  fi

  log "probe http_fail http=$code requests_before=$before requests_after=$after"
  return 1
}

log "watchdog start base=$PROXY_BASE_URL token=$TOKEN_NAME"

if probe_once; then
  exit 0
fi

log "probe retry"
if probe_once; then
  exit 0
fi

log "probe failed, starting auto-heal"

refresh_code=$(curl -s -o /tmp/worker3-watchdog-refresh -w "%{http_code}" \
  -X POST "$PROXY_BASE_URL/token-refresh" \
  -H "Content-Type: application/json" \
  -d "{\"tokenName\":\"$TOKEN_NAME\"}")
log "token-refresh http=$refresh_code"

log "restarting proxy"
"$ROOT_DIR/start.sh" --bg >/dev/null 2>&1 || true
sleep 2

log "post-heal probe"
if probe_once; then
  exit 0
fi

log "watchdog failed after auto-heal"
exit 1
