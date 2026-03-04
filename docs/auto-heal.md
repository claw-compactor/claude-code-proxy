# 自动修复机制 (Auto-Heal)

当 CLI worker 遇到可自愈的认证异常时，代理会自动触发“刷新 + 冷却 + 重试”流程，尽量避免人工介入。

## 触发条件

只对**可自愈**错误触发：

- 401 / auth expired / OAuth 失效（CLI stderr/stdout 中包含 auth/401 相关文本）
- CLI_EXIT 且包含认证相关文案

**不会触发刷新**：

- 429 / rate limit（进入限流冷却，走降级/切换，不刷 token）
- timeout（仅记录，不触发刷新）

## 修复流程

1. 请求级检测到 auth 错误
2. 触发 token refresh（同一 worker 并发合并，只跑一次）
3. 设置短暂 cooldown，避免并发风暴
4. **同 worker 自动重试 1 次**（可配置）
5. 若仍失败 → 切换到健康次优 worker

## 熔断（Circuit Breaker）

- 若在窗口内连续修复失败超过阈值，则进入熔断状态
- 熔断期间不会重复触发 auto-heal
- 熔断状态会暴露到 `/health` 和 `/metrics`

## 监控字段

`/metrics` 新增：

- `auto_heal_triggered`
- `auto_heal_success`
- `auto_heal_fail`
- `last_heal_at`
- `heal_reason`

每个 worker 状态中包含：

- `autoHeal.cooldownRemainingSec`
- `autoHeal.circuitState` (open/closed)
- `autoHeal.circuitRemainingSec`

## 配置项

在 `proxy.config.json` 添加：

```json
"autoHeal": {
  "enabled": true,
  "maxRetriesPerRequest": 1,
  "cooldownMs": 15000,
  "circuitFailThreshold": 3,
  "circuitOpenMs": 60000
}
```

- `enabled`：是否启用自动修复（默认 true）
- `maxRetriesPerRequest`：刷新成功后，**同 worker** 重试次数
- `cooldownMs`：触发修复后的短暂冷却
- `circuitFailThreshold`：窗口内失败阈值
- `circuitOpenMs`：熔断时长（同时作为失败窗口长度）

## 排障建议

- 若出现频繁 `AUTO_HEAL_FAIL`：检查 refresh token 是否失效
- 若熔断频繁：提高 `circuitOpenMs` 或检查 worker token 配置
- 若 429 频繁：提升账号池或降低本地并发/速率限制
