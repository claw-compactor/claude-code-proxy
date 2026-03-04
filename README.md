# claude-code-proxy

OpenAI-compatible API proxy that routes requests to the Anthropic Claude API via OAuth tokens. Supports multiple independent accounts for load distribution, automatic token refresh, prompt caching, and a real-time monitoring dashboard.

## Architecture

```
Clients (OpenAI format)
    │
    ▼
┌──────────────────────────────────┐
│  claude-code-proxy  (port 8403)  │
│                                  │
│  ┌────────────────────────────┐  │
│  │ Least-Utilization Router   │  │
│  │ (picks token with lowest   │  │
│  │  5h utilization %)         │  │
│  └──────┬──────┬──────┬───────┘  │
│         │      │      │          │
│    Token 1  Token 2  Token 3     │
│    (Org A)  (Org B)  (Org C)     │
│                                  │
│  Fair Queue · Rate Limiter       │
│  Session Affinity · Cache Ctrl   │
│  Token Refresh · System Reaper   │
└──────────────┬───────────────────┘
               │
               ▼
      Anthropic API (api.anthropic.com)
```

### Request Flow

1. Client sends OpenAI-format request (`/v1/chat/completions`)
2. Proxy converts to Anthropic Messages API format
3. Least-utilization router picks the token with lowest 5h usage
4. Request sent to Anthropic with OAuth bearer token + beta header
5. Response converted back to OpenAI format and returned

### Key Modules

| Module | Purpose |
|--------|---------|
| `server.mjs` | Main server: routing, API translation, streaming |
| `config-loader.mjs` | Loads and validates `proxy.config.json` |
| `token-refresh.mjs` | OAuth token auto-refresh (proactive + on-401) |
| `fair-queue.mjs` | Per-source fair queuing with concurrency limits |
| `rate-limiter.mjs` | Local rate limiting (requests/min, tokens/min) |
| `session-affinity.mjs` | Sticky sessions for prompt cache optimization |
| `metrics-store.mjs` | Time-series metrics with Redis persistence |
| `process-registry.mjs` | CLI process lifecycle tracking |
| `event-log.mjs` | Structured event log with Redis persistence |
| `token-tracker.mjs` | Token usage accounting per model/source |
| `worker-pool.mjs` | CLI worker management (fallback path) |
| `system-reaper.mjs` | Automatic cleanup of stale processes |
| `response-formats.mjs` | OpenAI response format builders |
| `redis-client.mjs` | Redis connection factory |
| `retry.mjs` | Exponential backoff retry logic |

## Setup

### Prerequisites

- Node.js 20+
- Redis (for metrics persistence; proxy works without it but loses history on restart)
- One or more Claude Max subscription accounts with OAuth tokens

### Install

```bash
npm install
cp proxy.config.sample.json proxy.config.json
```

### Configure tokens

Each worker needs an OAuth access token and (optionally) a refresh token. Tokens come from the Claude Code OAuth flow:

1. Run `claude auth login` from a Claude Code CLI session
2. Copy the resulting `accessToken` and `refreshToken` into `proxy.config.json`

Workers with refresh tokens auto-renew before expiry. Workers without refresh tokens need manual token replacement every ~8 hours.

For multiple independent rate limit pools, use tokens from **different Claude accounts** (different organizations). Tokens from the same account share the same rate limits.

### Run

```bash
# Foreground
node server.mjs

# Background (via helper script)
./start.sh --bg

# Development (auto-reload on changes)
npm run dev
```

## API

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | OpenAI-compatible chat completion (sync + streaming) |
| `/health` | GET | Health check with worker status |
| `/metrics` | GET | Detailed metrics (tokens, latency, cache, queue) |
| `/dashboard` | GET | Real-time monitoring dashboard |
| `/portal` | GET | Portal page with embedded dashboard |
| `/events` | GET | SSE stream for live dashboard updates |

### Supported Models

Requests use short aliases that map to Anthropic model IDs:

| Alias | Anthropic Model |
|-------|----------------|
| `haiku`, `haiku-4.5`, `claude-haiku-4-5` | claude-haiku-4-5-20251001 |
| `sonnet`, `sonnet-4.6`, `claude-sonnet-4-6` | claude-sonnet-4-6 |
| `opus`, `opus-4.6`, `claude-opus-4-6` | claude-opus-4-6 |
| `claude-code` | claude-sonnet-4-6 (default) |

### Example Request

```bash
curl -X POST http://localhost:8403/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100
  }'
```

### Explicit Token Routing (worker3)

Optionally route a request to a specific worker by name:

- Header: `x-token-name: worker3`
- Body: `{ "tokenName": "worker3" }`

If omitted, the proxy keeps the existing least-utilization routing behavior.

```bash
curl -X POST http://localhost:8403/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-token-name: worker3" \
  -d '{
    "model": "sonnet",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100
  }'
```

## Configuration Reference

See `proxy.config.sample.json` for a full template. Key sections:

### `server`
- `port`: Listen port (default: 8403)
- `authToken`: Bearer token for client auth (empty = open)

### `workers[]`
- `name`: Unique worker identifier
- `token`: OAuth access token (`sk-ant-oat01-...`)
- `refreshToken`: OAuth refresh token (`sk-ant-ort01-...`)
- `expiresAt`: Token expiry (unix ms)
- `disabled`: Set `true` to skip this worker

### `routing`
- `primaryWorker`: Preferred worker for CLI fallback path
- `useCliAgents`: Enable CLI agent mode (tool-enabled requests)
- `loadBalance`: Reserved for future use

### `rateLimits`
Per-model local rate limits (applied before Anthropic's limits):
- `requestsPerMin`: Max requests per minute
- `tokensPerMin`: Max estimated tokens per minute

### `cacheControl`
Anthropic prompt cache optimization:
- `enabled`: Toggle cache_control injection
- `systemPrefixChars`: Stable prefix length to cache
- `minSystemPrefixChars`: Minimum prefix to bother caching

### `queue`
Fair queuing with per-source isolation:
- `maxConcurrent`: Global concurrent request limit
- `maxQueuePerSource`: Per-source queue depth
- `sourceConcurrencyLimits`: Per-source concurrent limits

### `timeouts`
- `streamTimeoutMs`: Max time for streaming responses (default: 2h)
- `syncTimeoutMs`: Max time for sync responses (default: 30min)

### `heartbeat`
Per-model SSE keepalive intervals to prevent client timeouts.

## Token Refresh

Workers with `refreshToken` set benefit from automatic renewal:

- **Proactive**: Checked every 60s; refreshed 5 minutes before expiry
- **Reactive**: On 401 auth error, triggers immediate refresh
- **Coalesced**: Concurrent 401s share a single refresh call
- **Persisted**: New tokens saved to `proxy.config.json` + macOS Keychain
- **Backoff**: Exponential backoff on refresh failures (max 5 min)

## Monitoring

### Dashboard (`/dashboard`)

Real-time dashboard showing:
- Active/queued requests per worker
- Token usage and costs by model
- Rate limit utilization (5h and 7d)
- Request latency percentiles
- Cache hit rates and TTFT comparison

### Metrics (`/metrics`)

JSON endpoint with:
- Per-model token counts and request counts
- Per-worker utilization and health
- Queue depth and wait times
- Cache statistics
- Token refresh status

## Security

- **Never commit real tokens.** `proxy.config.json` is in `.gitignore`.
- Use `proxy.config.sample.json` as a template.
- Tokens can also be injected via `WORKERS` env var (see `secrets.example`).
- Set `server.authToken` to require bearer auth from clients.

## Tests

```bash
npm test
```

Runs unit tests for: rate-limiter, token-tracker, metrics-store, event-log, process-registry, redis-client, and integration tests.
