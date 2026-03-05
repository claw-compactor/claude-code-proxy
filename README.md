# claude-code-proxy

OpenAI-compatible and native Anthropic API proxy for Claude. Routes requests across multiple independent OAuth accounts for load distribution, with rate-limit-aware smart routing, aggressive token refresh, prompt caching optimization, and a real-time monitoring dashboard.

## Architecture

```
Clients
 ├─ OpenAI format   (/v1/chat/completions)
 └─ Anthropic format (/v1/messages)
         │
         ▼
┌──────────────────────────────────────────┐
│      claude-code-proxy  (port 8403)      │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │   Rate-Limit-Aware Smart Router   │  │
│  │                                    │  │
│  │  available (<75%) → round-robin    │  │
│  │  strained (75-99%) → lowest util  │  │
│  │  saturated (≥99%) → avoided       │  │
│  └────┬──────┬──────┬──────┬─────────┘  │
│       │      │      │      │            │
│   Token 1  Token 2  Token 3  Token 4    │
│   (Org A)  (Org B)  (Org C)  (Org D)   │
│                                          │
│  Fair Queue · Per-Model Rate Limiter     │
│  Session Affinity · Prompt Caching       │
│  Token Refresh · Circuit Breaker         │
│  Auto-Heal · System Reaper               │
└──────────────────┬───────────────────────┘
                   │
                   ▼
         Anthropic Messages API
        (api.anthropic.com)
```

## Features

- **Dual format support**: OpenAI `/v1/chat/completions` and native Anthropic `/v1/messages`
- **Rate-limit-aware routing**: Classifies tokens by utilization tier, avoids saturated accounts
- **Prompt caching**: System prefix caching + tool/message breakpoint injection (~88% cache hit rate)
- **Aggressive token refresh**: Parallel startup refresh, 50% lifetime proactive renewal, keychain/CLI recovery
- **Fair queuing**: Per-source isolation with configurable concurrency limits
- **Session affinity**: Sticky routing for conversation cache optimization
- **Circuit breaker**: Health state machine with automatic recovery
- **Auto-heal**: Request-level auth failure recovery with token refresh retry
- **Real-time dashboard**: Live metrics, rate limits, cache stats, worker health
- **Redis persistence**: Cross-restart state with local JSON fallback

## Quick Start

### Prerequisites

- Node.js 20+ (tested on v25.6.0)
- Redis (recommended; proxy degrades gracefully without it)
- One or more Claude accounts with OAuth tokens

### Install

```bash
git clone git@github.com:claw-compactor/claude-code-proxy.git
cd claude-code-proxy
npm install
cp proxy.config.sample.json proxy.config.json
```

### Configure Tokens

Each worker needs an OAuth access token and refresh token from the Claude Code OAuth flow:

```bash
# On each Claude account:
claude auth login
# Copy accessToken + refreshToken into proxy.config.json
```

Workers with `refreshToken` auto-renew. For independent rate limit pools, use tokens from **different Claude organizations**.

### Run

```bash
# Foreground
node server.mjs

# Background with logging
./start.sh --bg       # Logs to /tmp/claude-proxy.log

# Development (auto-reload)
npm run dev
```

## API Reference

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | OpenAI-compatible chat completion (sync + streaming) |
| `/v1/messages` | POST | Native Anthropic Messages API (sync + streaming) |
| `/health` | GET | Health check with worker status, queue depth |
| `/metrics` | GET | Comprehensive metrics JSON |
| `/dashboard` | GET | Real-time monitoring dashboard |
| `/portal` | GET | Portal page with embedded dashboard |
| `/events` | GET | SSE stream for live dashboard updates |
| `/models` | GET | List supported models |
| `/worker/:name/disable` | POST | Graceful drain + disable worker |
| `/worker/:name/enable` | POST | Re-enable worker |
| `/zombies` | GET | List detected orphan processes |

### Supported Models

| Alias | Anthropic Model ID |
|-------|--------------------|
| `haiku`, `haiku-4.5`, `claude-haiku-4-5` | `claude-haiku-4-5-20251001` |
| `sonnet`, `sonnet-4.6`, `claude-sonnet-4-6` | `claude-sonnet-4-6` |
| `opus`, `opus-4.6`, `claude-opus-4-6` | `claude-opus-4-6` |
| `claude-code` (default) | `claude-sonnet-4-6` |

### OpenAI Format

```bash
curl -X POST http://localhost:8403/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  -d '{
    "model": "sonnet",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100,
    "stream": true
  }'
```

### Native Anthropic Format

```bash
curl -X POST http://localhost:8403/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "sonnet",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100,
    "stream": true
  }'
```

Native Anthropic requests are passed through without format conversion. SSE events are piped directly, preserving all Anthropic-specific features (tool use, cache metrics, etc.).

### Explicit Token Routing

Route to a specific worker by name:

```bash
# Via header
curl ... -H "x-token-name: 3"

# Via body
curl ... -d '{"tokenName": "3", ...}'
```

Controlled by `routing.allowExplicitTokenOverride` (default: `true`).

### Usage Fields

Responses include Anthropic cache usage:

```json
{
  "usage": {
    "input_tokens": 100,
    "output_tokens": 50,
    "cache_creation_input_tokens": 10,
    "cache_read_input_tokens": 90,
    "prompt_tokens": 200,
    "completion_tokens": 50,
    "total_tokens": 250
  }
}
```

## Project Structure

```
claude-code-proxy/
├── server.mjs                    Main server: wiring, routes, lifecycle
│
├── lib/                          Core modules (extracted from server.mjs)
│   ├── anthropic-client.mjs      Anthropic API client (stream + sync + native)
│   ├── request-handler.mjs       Request processing pipeline
│   ├── format-converter.mjs      Format conversion + caching helpers
│   ├── anthropic-compat.mjs      Anthropic↔OpenAI format translation
│   ├── rate-limit-classifier.mjs Rate limit tier classification
│   ├── token-pool.mjs            Token selection + cooldowns
│   ├── worker-router.mjs         Rate-limit-aware load balancing
│   ├── worker-state.mjs          Runtime worker enable/disable
│   ├── token-health-probe.mjs    Periodic token validity probes
│   ├── cli-runner.mjs            Claude CLI spawn/execute
│   ├── fallback-client.mjs       Last-resort OpenAI-compatible API
│   └── admin-routes.mjs          /health, /metrics, /events, /dashboard
│
├── controllers/
│   ├── metrics-controller.mjs    Metrics aggregation + response builder
│   ├── storage-controller.mjs    Unified Redis/local persistence
│   └── worker-health-controller.mjs  Health state machine + circuit breaker
│
├── [Root modules]
│   ├── config-loader.mjs         Config loading + validation
│   ├── token-refresh.mjs         OAuth token auto-refresh
│   ├── auto-heal.mjs             Request-level auth failure recovery
│   ├── fair-queue.mjs            Per-source fair queuing
│   ├── rate-limiter.mjs          Local per-model rate limiting
│   ├── session-affinity.mjs      Session → worker sticky routing
│   ├── session-cache-stats.mjs   Per-session cache analytics
│   ├── metrics-store.mjs         Time-series metrics + Redis persistence
│   ├── event-log.mjs             Circular event buffer
│   ├── process-registry.mjs      CLI process lifecycle tracking
│   ├── token-tracker.mjs         Per-model token accounting
│   ├── redis-client.mjs          ioredis connection factory
│   ├── storage-backend.mjs       Unified persistence (Redis/local)
│   ├── system-reaper.mjs         Orphan process cleanup
│   ├── response-formats.mjs      OpenAI response format builders
│   ├── worker-pool.mjs           CLI worker warm-pool
│   └── retry.mjs                 Exponential backoff
│
├── test/                         23 test files, 221 tests
│   ├── format-converter.test.mjs
│   ├── rate-limit-classifier.test.mjs
│   ├── token-pool.test.mjs
│   ├── worker-router.test.mjs
│   ├── integration.test.mjs
│   └── ...
│
├── dashboard.html                Real-time monitoring UI
├── portal.html                   Portal page with iframe
├── proxy.config.json             Active configuration (gitignored)
├── proxy.config.sample.json      Configuration template
├── start.sh                      Launch script (fg/bg)
└── data/                         Persistent state (JSON backups)
```

## Core Systems

### Rate-Limit-Aware Routing

The proxy classifies each token by Anthropic's unified rate limits (5-hour and 7-day windows):

| Tier | Utilization | Behavior |
|------|-------------|----------|
| **available** | < 75% | Round-robin (even distribution) |
| **strained** | 75% – 99% | Route to lowest utilization |
| **saturated** | ≥ 99% or rejected | Avoided; used only as last resort |
| **unknown** | No probe data | Treated as available (backward compat) |

The routing applies to both:
- **API Direct path** (`lib/token-pool.mjs`): Token selection for direct Anthropic API calls
- **CLI path** (`lib/worker-router.mjs`): Worker selection for CLI-routed requests

Session affinity only applies when the target worker is in the current tier's filtered pool, preventing sticky routing to saturated workers.

### Prompt Caching

The proxy maximizes Anthropic prompt cache usage through three layers:

1. **System prefix caching**: The first ~1200 chars of the system prompt are marked with `cache_control: { type: "ephemeral" }`, with a normalized cache key to handle whitespace variations.

2. **Tool definition caching**: The last tool in the `tools` array gets a cache breakpoint, caching all tool definitions (they rarely change within a session).

3. **Conversation history caching**: The second-to-last message gets a cache breakpoint, caching all prior conversation turns.

This achieves ~88% cache hit rate on multi-turn conversations, reducing input costs significantly.

Cache keys are scoped by: tenant + session + model + system prefix hash + tools hash.

### Token Refresh

Aggressive proactive refresh ensures tokens never expire during requests:

| Feature | Detail |
|---------|--------|
| **Startup refresh** | Immediately refreshes all expired/near-expiry tokens in parallel |
| **Half-life refresh** | Refreshes at 50% remaining lifetime (~4h for 8h tokens) |
| **Proactive margin** | 1 hour before expiry |
| **Check interval** | Every 30 seconds |
| **Credential recovery** | On `invalid_grant`: re-reads macOS Keychain → tries `claude auth status` |
| **Coalescing** | Concurrent 401s share a single refresh call |
| **Persistence** | Atomic write to `proxy.config.json` + macOS Keychain |
| **Backoff** | Exponential backoff on failures (max 5 min) |

### Fair Queuing

Per-source isolation prevents any single client from monopolizing the proxy:

- Global concurrent request limit (default: 6)
- Per-source queue depth limits
- Per-source concurrency limits (configurable per source name)
- Round-robin scheduling across sources

### Circuit Breaker

Worker health state machine:

```
healthy → degraded → open → recovering → healthy
```

- Tracks consecutive failures within a time window
- Opens circuit after threshold failures (rejects new requests)
- Auto-recovers after cooldown period with probe requests

### Auto-Heal

Request-level auth failure recovery:

1. Detects 401/auth errors in CLI output
2. Triggers OAuth token refresh
3. Cooldown period (prevents refresh storms)
4. Retries on same worker with fresh token
5. Falls back to alternate worker if retry fails

## Configuration Reference

Full template: `proxy.config.sample.json`

### `server`

| Key | Default | Description |
|-----|---------|-------------|
| `port` | `8403` | Listen port |
| `authToken` | `""` | Bearer token for client auth (empty = open) |

### `workers[]`

| Key | Description |
|-----|-------------|
| `name` | Unique worker identifier |
| `token` | OAuth access token (`sk-ant-oat01-...`) |
| `refreshToken` | OAuth refresh token (`sk-ant-ort01-...`) |
| `expiresAt` | Token expiry (unix ms) |
| `disabled` | Set `true` to skip this worker |
| `note` | Human-readable description |

### `routing`

| Key | Default | Description |
|-----|---------|-------------|
| `primaryWorker` | `"3"` | Preferred worker for CLI fallback |
| `useCliAgents` | `false` | Enable CLI agent mode (tool-enabled) |
| `allowExplicitTokenOverride` | `true` | Allow `x-token-name` header |
| `healthCheckMs` | `30000` | Health check interval |

### `rateLimits`

Per-model local rate limits (applied before Anthropic's):

```json
{
  "sonnet": { "requestsPerMin": 57, "tokensPerMin": 190000 },
  "opus":   { "requestsPerMin": 28, "tokensPerMin": 57000 },
  "haiku":  { "requestsPerMin": 95, "tokensPerMin": 380000 }
}
```

### `cacheControl`

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Toggle cache_control injection |
| `systemPrefixChars` | `1200` | Stable prefix length to cache |
| `minSystemPrefixChars` | `200` | Min prefix to bother caching |
| `normalizeSystemPrefix` | `true` | Normalize whitespace for stable keys |
| `debounceWhitespace` | `true` | Collapse whitespace noise |
| `sessionScope` | `"x-session-id"` | Session key source (`"none"` for cross-session sharing) |

### `queue`

| Key | Default | Description |
|-----|---------|-------------|
| `maxConcurrent` | `6` | Global concurrent request limit |
| `maxQueueTotal` | `200` | Total queue depth |
| `maxQueuePerSource` | `50` | Per-source queue depth |
| `queueTimeoutMs` | `300000` | Max queue wait (5 min) |
| `sourceConcurrencyLimits` | `{}` | Per-source caps (e.g., `{"batch": 15}`) |

### `timeouts`

| Key | Default | Description |
|-----|---------|-------------|
| `streamTimeoutMs` | `7200000` | Max streaming response time (2h) |
| `syncTimeoutMs` | `1800000` | Max sync response time (30min) |

### `heartbeat`

Per-model SSE keepalive intervals (ms) to prevent client timeouts:

```json
{ "opus": 600000, "sonnet": 300000, "haiku": 180000 }
```

### `sessionStats`

| Key | Default | Description |
|-----|---------|-------------|
| `ttlMs` | `86400000` | Session event retention (24h) |
| `cleanupIntervalMs` | `300000` | Prune interval (5 min) |
| `topN` | `50` | Default sessions in `/metrics` |

### `autoHeal`

| Key | Default | Description |
|-----|---------|-------------|
| `cooldownMs` | `60000` | Cooldown after auth failure |
| `maxRetries` | `1` | Retries per request |
| `circuitThreshold` | `3` | Failures to open circuit |
| `circuitResetMs` | `60000` | Circuit breaker cooldown |

## Monitoring

### Dashboard (`/dashboard`)

Real-time monitoring dashboard showing:

- Active/queued requests per worker
- Token usage and costs by model
- Rate limit utilization (5h and 7d windows) with tier badges
- Routing status per worker (PREFERRED / ACTIVE / AVOIDED / BLOCKED)
- Bottleneck indicators (which rate limit window is limiting)
- Reset countdowns for rate-limited workers
- Request latency percentiles (P50, P95, P99)
- Cache hit rates and TTFT comparison (cached vs uncached)
- Per-session cache analytics (5m/15m/1h hit rates)
- Event log (last 100 events)

### Metrics (`/metrics`)

JSON endpoint with paginated session analytics:

```
GET /metrics?sessions_limit=50&sessions_offset=0
```

Key fields:
- `workerStats`: Per-worker request/error counts (realtime)
- `workerStatsWindow`: Per-worker 1h delta (for comparison after restarts)
- `unifiedRateLimits`: Raw 5h/7d utilization per worker
- `rateLimitEnhanced`: Tier classification, routing status, reset countdown per worker
- `tokenRefreshStatus`: Per-worker refresh state, expiry, error history
- `cache`: Hit rate, TTFT averages, candidate/applied counts
- `sessionCacheAnalytics`: Per-session cache performance (paginated)
- `queue`: Active/queued counts, per-source breakdown
- `tokenProbe`: Health probe results per worker

## Testing

```bash
# Run all 221 tests
npm test

# Run specific test file
node --test test/format-converter.test.mjs

# Run with verbose output
node --test --test-reporter=spec
```

Test coverage includes:
- Format conversion + caching helpers (46 tests)
- Rate limit classification (24 tests)
- Token pool tiered selection (16 tests)
- Worker routing (18 tests)
- Token health probes (12 tests)
- Worker state management (10 tests)
- Integration tests (API + streaming)
- Rate limiter, metrics store, event log, process registry
- Redis client, storage backend, auto-heal, session stats

## Security

- **Never commit real tokens.** `proxy.config.json` is in `.gitignore`.
- Use `proxy.config.sample.json` as a template.
- Tokens can be injected via `WORKERS` env var.
- Set `server.authToken` to require bearer auth from all clients.
- Error messages are sanitized — no token values in responses.
- macOS Keychain used for secure credential storage.

## Design Principles

- **Dependency injection**: All modules use factory functions with explicit deps
- **Immutability**: Public methods return new objects, never mutate state
- **Pure functions**: Format converters and classifiers have no side effects
- **Many small files**: High cohesion, low coupling (see `lib/`)
- **Redis-first with fallback**: Graceful degradation when Redis unavailable
- **Zero external API dependencies**: Uses only `node:https` (no SDK)
- **Single runtime dependency**: `ioredis` for Redis

## Additional Documentation

- `docs/architecture.md` — Module dependency graph and relationships
- `docs/auto-heal.md` — Auto-heal trigger conditions and circuit breaker
- `docs/cache-optimization.md` — Cache hit-rate tactics and anti-patterns
- `docs/cache-test-results.md` — Prompt caching smoke test results
- `docs/session-analytics.md` — Per-session cache tracking
- `docs/storage-architecture.md` — Redis-first persistence design
- `docs/worker3-watchdog.md` — External watchdog script
