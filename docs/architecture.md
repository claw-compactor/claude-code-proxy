# Architecture & Module Relationships

```
                ┌───────────────────────┐
Clients ───────▶│      server.mjs       │
(OpenAI API)    │ (routing + orchestration)
                └──────────┬────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
StorageController     MetricsController   WorkerHealthController
(redis/local I/O)     (metrics output)    (state machine)
        │                  │                  │
        ▼                  ▼                  ▼
storage-backend      metrics-store       auto-heal + rate-limit
(cache/session/      (snapshots)         (cooldown + circuit)
 worker stats)

Other supporting modules:
- fair-queue / rate-limiter
- process-registry / system-reaper
- token-tracker / event-log
- token-refresh / session-affinity
```

## Migration Notes

- **Controllers are now the integration surface**: new logic should be added to the controller layer, not directly into `server.mjs`.
- **Worker health** now lives in `WorkerHealthController`, which handles cooldown recovery and circuit breaker state.
- **Metrics output** should go through `MetricsController` to preserve `/metrics` compatibility.
- **Storage access** should use `StorageController` to ensure Redis/local fallback remains consistent.

If you extend metrics or storage schemas, update the controller + corresponding tests first, then update `server.mjs` orchestration.
