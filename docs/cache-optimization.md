# Cache Optimization Guide

## 命中率原理
Anthropic 的 `cache_control` 只缓存 **system 前缀**（由 `cacheControl.systemPrefixChars` 决定）。

缓存命中需要满足：
- 同一 session（当 `cacheControl.sessionScope` = `x-session-id` 时，cache key 会包含 `x-session-id` / `session_id`）
- system 前缀文本一致（归一化后）
- tools schema 一致（hash 纳入 key）
- 模型一致（纳入 key）

命中指标：
- `cache_creation_input_tokens` > 0 ⇒ 建立缓存
- `cache_read_input_tokens` > 0 ⇒ 命中缓存

## 推荐调用姿势（稳定命中）
- **固定 session id**：同一对话始终带 `x-session-id`（强烈推荐）。
- **可选跨 session 命中**：如需跨 session 命中，把 `cacheControl.sessionScope` 设为 `none`（命中率会提高，但不同对话共享缓存要谨慎）。
- **system 保持稳定**：把不变的指令放在 system 前缀；把动态内容放到 user 消息。
- **启用归一化**：`cacheControl.normalizeSystemPrefix=true` + `debounceWhitespace=true`（cache key 会折叠空白/换行，system 实际内容保持原样）。
- **合理前缀长度**：`systemPrefixChars` 设在 800~1600 之间，确保缓存覆盖核心指令。

推荐配置（保持 session 维度策略）：
```json
{
  "sessionAffinity": { "ttlMs": 1800000 },
  "cacheControl": {
    "enabled": true,
    "systemPrefixChars": 1200,
    "minSystemPrefixChars": 200,
    "normalizeSystemPrefix": true,
    "debounceWhitespace": true,
    "sessionScope": "x-session-id"
  }
}
```

## 会破坏命中率的反模式
- 每次请求生成新的 `x-session-id`（导致跨请求 cache key 全变）
- 把动态内容（时间、随机数、请求计数）放入 system 前缀
- tools schema 频繁变动（新增/删改 tool 会改变 key）
- system 前缀中大量无意义空白变化（未启用归一化时尤其明显）

## 观测方法
1. **API usage**：
   - `cache_creation_input_tokens` / `cache_read_input_tokens` 在 `/v1/chat/completions` 响应中直接可见。
2. **日志**：
   - `CACHE_CTX`：显示 `cache_key_hash` + hit/miss + reason（标准化原因）。
   - `CACHE_TTFT`：对比缓存/未缓存 TTFT（首字节延迟）。
3. **Dashboard/metrics**：
   - `/metrics` 返回聚合 cache stats（hits/misses/hitRate/lastHitAt/TTFT）。

## 排障步骤
- **usage 里没有 cache_* 字段，但本地 hit 为真**：说明上游未回传 cache usage 字段，代理仍会保留本地 hit/miss 统计；以 `/metrics` 为准。
- **命中率偏低**：先检查 session id 是否稳定、system 前缀是否包含动态内容、`sessionScope` 是否符合预期。
- **key 频繁变化**：启用 `normalizeSystemPrefix` + `debounceWhitespace` 并确认 system 前缀长度满足 `minSystemPrefixChars`。
