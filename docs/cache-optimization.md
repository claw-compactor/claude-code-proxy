# Cache Optimization Guide

## 命中率原理
Anthropic 的 `cache_control` 只缓存 **system 前缀**（由 `cacheControl.systemPrefixChars` 决定）。

缓存命中需要满足：
- 同一 session（cache key 含 `x-session-id` / `session_id`）
- system 前缀文本一致（归一化后）
- tools schema 一致（hash 纳入 key）
- 模型一致（纳入 key）

命中指标：
- `cache_creation_input_tokens` > 0 ⇒ 建立缓存
- `cache_read_input_tokens` > 0 ⇒ 命中缓存

## 推荐调用姿势（稳定命中）
- **固定 session id**：同一对话始终带 `x-session-id`（强烈推荐）。
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
    "debounceWhitespace": true
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
   - `CACHE_CTX`：显示 cache key 和命中估算（hit/miss）。
   - `CACHE_TTFT`：对比缓存/未缓存 TTFT（首字节延迟）。
3. **Dashboard/metrics**：
   - `/metrics` 返回聚合 cache stats（hitRate, TTFT）。

如果命中率偏低，优先检查 session id 是否稳定，以及 system 前缀是否被动态内容污染。
