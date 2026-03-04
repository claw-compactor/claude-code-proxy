# Session Cache Analytics

This proxy tracks per-session prompt cache activity so you can see which clients are benefiting from cache hits (and which aren’t).

## Fields (per session)

Returned under `/metrics` → `sessions.items[]`:

- `sessionId`: Session key derived from `x-session-id` (or `anonymous` if missing).
- `requests5m` / `requests15m` / `requests1h`: Requests seen in the last 5/15/60 minutes.
- `hits`: Total cache hits within the retention window.
- `misses`: Total cache misses within the retention window.
- `hitRate`: Overall hit rate (hits / total) for the retention window.
- `hitRate5m` / `hitRate15m` / `hitRate1h`: Hit rate by recent windows.
- `lastHitAt` / `lastHitIso`: Timestamp of the most recent cache hit.
- `lastReqAt` / `lastReqIso`: Timestamp of the most recent request (hit or miss).

## Query Parameters

`/metrics?sessions_limit=50&sessions_offset=0`

- `sessions_limit`: Max sessions to return (default: `sessionStats.topN`, capped at 500).
- `sessions_offset`: Pagination offset.

## Observability Tips

- **Low hit rates across all sessions** usually indicate:
  - `cacheControl.enabled` is off
  - System prompts are too short (`minSystemPrefixChars` not met)
  - Session IDs are missing so everything buckets under `anonymous`
- **A single session with high misses** often means the system prompt is changing too frequently.
- **`lastHitAt` stale** but requests still flowing → cache keys are likely drifting (new tools schema, system prefix changes, etc.).

## Configuration

Configure in `proxy.config.json`:

```json
"sessionStats": {
  "ttlMs": 86400000,
  "cleanupIntervalMs": 300000,
  "topN": 50
}
```

- `ttlMs`: Retain session events for this long (default 24h).
- `cleanupIntervalMs`: How often expired sessions are pruned.
- `topN`: Default number of sessions returned when no `sessions_limit` is provided.
