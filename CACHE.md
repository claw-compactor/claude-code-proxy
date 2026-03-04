# Anthropic Prompt Cache 快速配置说明

## 目的
- 提升 Anthropic prompt cache 命中率，缩短 TTFT。
- 仅对稳定的 system 前缀打 `cache_control`，避免高波动字段进入缓存段。

## 开启/调参
在 `proxy.config.json`：

```json
"sessionAffinity": { "ttlMs": 1800000 },
"cacheControl": {
  "enabled": true,
  "systemPrefixChars": 1200,
  "minSystemPrefixChars": 200,
  "keyMaxEntries": 5000
}
```

也可用环境变量覆盖（调试用）：
- `SESSION_AFFINITY_TTL_MS`
- `CACHE_CONTROL_ENABLED`
- `CACHE_CONTROL_SYSTEM_PREFIX_CHARS`
- `CACHE_CONTROL_MIN_SYSTEM_PREFIX_CHARS`
- `CACHE_CONTROL_KEY_MAX_ENTRIES`

## 观测方式
### 日志
- `CACHE_CTX`: 规范化 key + candidate/applied + 命中估计
- `CACHE_APPLY`: 本次请求是否应用 cache_control、前缀长度
- `CACHE_TTFT`: 首 token 时间，含 cached/uncached 滚动均值

### /metrics
- `cache` 字段：
  - `candidates / applied`
  - `hits / misses / hitRate`
  - `ttftCachedAvg / ttftUncachedAvg`

### /health
- `cache` 字段汇总（快速检查）

## 使用建议
- System prompt 稳定段尽量放前面，动态字段放后面。
- 避免将时间戳/随机数/用户 ID 放入缓存段。
- 当 `ttftCachedAvg` 明显低于 `ttftUncachedAvg` 时，说明缓存收益稳定。
