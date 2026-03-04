# Worker3 Watchdog (auto-heal)

Minimal watchdog script to keep worker3 alive. Runs a probe every 5 minutes, checks that worker3 request count increases, and auto-heals on failure.

## Manual Run

```bash
PROXY_BASE_URL=http://127.0.0.1:8403 \
  ./scripts/worker3-watchdog.sh
```

Logs are written to:

```
/tmp/worker3-watchdog.log
```

## What it does

1. Probe with `x-token-name: 3`
2. Success requires HTTP 2xx **and** `/metrics` shows worker3 `requests` increasing (one retry allowed)
3. On failure:
   - POST `/token-refresh` with `tokenName=3`
   - restart proxy (single instance) via `./start.sh --bg`
   - probe again

## Cron Example (every 5 minutes)

```
*/5 * * * * PROXY_BASE_URL=http://127.0.0.1:8403 /Users/duke_nukem_opcdbase/.openclaw/workspace/claude-code-proxy/scripts/worker3-watchdog.sh
```

> Install with `crontab -e` if desired. This doc does **not** auto-install cron.
