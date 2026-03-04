# Storage Architecture (Redis-first)

## 改前（分散存储清单）

- **worker stats**：`server.mjs` 内存对象（`workerStats`）
  - 进程重启后丢失，仅靠 `metrics-store` 的历史快照做 best-effort seed
- **cache stats**：`server.mjs` 内存对象（`cacheStats` + `recentKeys`）
  - 仅内存，重启后全部清零
- **session cache stats**：`session-cache-stats.mjs` 内存 `Map`
  - 仅内存，重启后全部清零
- **metrics time-series**：`metrics-store.mjs`
  - Redis ZSET `metrics:ts` + 本地 `data/metrics.jsonl`
- **token stats**：`token-tracker.mjs`
  - Redis HASH `tokens:models` / `tokens:requests` + 本地 `data/tokens.json`

## 改后（统一存储层）

统一由 `storage-backend.mjs` 提供 **Redis 优先 + 本地 fallback** 的存储层，核心数据域：

- **cache hit/miss + TTFT**
  - Redis: `analytics:cache` (JSON)
  - Redis: `cache:events` (ZSET, 用于 5m/15m/1h/24h 窗口统计)
  - Local: `data/storage-backup.json`
- **worker stats**
  - Redis: `analytics:workers` (JSON)
  - Local: `data/storage-backup.json`
- **session stats**
  - Redis: `sessions:summary` (HASH { sessionId: JSON })
  - Redis: `sessions:events:<sessionId>` (ZSET, 事件保留 24h)
  - Local fallback: 内存 Map（与旧版行为一致）
- **metrics time-series**（保持不变）
  - Redis: `metrics:ts` (ZSET)
  - Local: `data/metrics.jsonl`
- **token stats**（保持不变）
  - Redis: `tokens:models` / `tokens:requests`
  - Local: `data/tokens.json`

### 统一存储模块

- `storage-backend.mjs`
  - `createStorageBackend`：Redis-first + 本地备份
  - `createCacheStatsStore`：cache 统计 + 窗口计数
  - `createSessionStatsStore`：session 统计（Redis 事件 + 本地 fallback）
  - `createWorkerStatsStore`：worker 统计持久化

### TTL 与清理策略

- `sessions:events:<sessionId>`：保留 `sessionStats.ttlMs`（默认 24h），写入时清理过期成员
- `cache:events`：保留 24h 窗口（用于 5m/15m/1h/24h 统计）
- 本地备份：`data/storage-backup.json` 定期覆盖写入

### 迁移策略（best-effort）

启动时：
1. 先加载本地 `data/storage-backup.json`
2. 若 Redis 可用，将本地快照写入 Redis（`analytics:*` / `sessions:summary`）
3. Redis 无法连接时保持内存 + 本地备份继续写

### 排障

- Redis 不可用：日志出现 `[Redis] Connection failed`，系统自动转入本地 fallback
- 窗口统计缺失：检查 Redis ZSET `cache:events` / `sessions:events:*` 是否存在
- 需要清理：可手动删除 `analytics:*` / `cache:*` / `sessions:*` 键后重启

## 实测结果（2026-03-04）

- **多 worker + 多 session 写入**：用 worker2/3 发送 3 个 session（sess-a/b/c），`/metrics` 的 sessions 中可见三条记录，且 `requests1h=1`。
- **窗口统计变化**：
  - 初始：`cacheWindows` 5m/15m/1h/24h = `requests=4, hits=0`
  - 追加一次请求后：5m/15m/1h/24h = `requests=5, hits=1`（sess-a 出现 1 次 hit）
- **重启持久性**：连续重启两次后，`cacheWindows` 仍为 `requests=5, hits=1`，1h 窗口未丢。
- **Redis 故障 fallback**：停 Redis 后重启 proxy，日志出现：
  - `[Redis] Connection failed: Connection is closed. — running in memory-only mode`
  - `[TokenTracker] Loaded from file ...`
  - `[MetricsStore] Loaded ... from file`
- **Redis 恢复**：恢复 Redis 后重启 proxy，日志出现：
  - `[Redis] Connected and ready`
  - `[Storage] Migrated local analytics snapshot to Redis`
