# Cache Smoke Test Results

运行脚本：`scripts/cache-smoke.sh`（三轮）

## Round 1
- **A: 完全相同 prompt**
  - A1 usage: input=95 output=12 cache_create=0 cache_read=0 total=107
  - A2 usage: input=95 output=12 cache_create=0 cache_read=0 total=107
- **B: system 空白/换行微扰**
  - B1 usage: input=102 output=7 cache_create=0 cache_read=0 total=109
  - B2 usage: input=102 output=13 cache_create=0 cache_read=0 total=115
- **C: 多 session 并发 (>=3)**
  - c1 usage: input=95 output=11 cache_create=0 cache_read=0 total=106
  - c2 usage: input=95 output=12 cache_create=0 cache_read=0 total=107
  - c3 usage: input=95 output=12 cache_create=0 cache_read=0 total=107
- **本地缓存统计 (/metrics)**
  - hits=16 misses=5 hitRate=76.2% lastHitAt=2026-03-04T19:27:38.110Z
- **异常与处理**
  - usage 里 cache_* 始终为 0：判定上游未回传或未触发 cache usage；本地 hit/miss 统计仍正常工作（/metrics 可用）。

## Round 2
- **A: 完全相同 prompt**
  - A1 usage: input=95 output=12 cache_create=0 cache_read=0 total=107
  - A2 usage: input=95 output=12 cache_create=0 cache_read=0 total=107
- **B: system 空白/换行微扰**
  - B1 usage: input=102 output=13 cache_create=0 cache_read=0 total=115
  - B2 usage: input=102 output=12 cache_create=0 cache_read=0 total=114
- **C: 多 session 并发 (>=3)**
  - c1 usage: input=95 output=11 cache_create=0 cache_read=0 total=106
  - c2 usage: input=95 output=12 cache_create=0 cache_read=0 total=107
  - c3 usage: input=95 output=12 cache_create=0 cache_read=0 total=107
- **本地缓存统计 (/metrics)**
  - hits=23 misses=5 hitRate=82.1% lastHitAt=2026-03-04T19:27:48.841Z
- **异常与处理**
  - cache_* usage 仍为 0：保持本地统计，不影响命中率观测。

## Round 3
- **A: 完全相同 prompt**
  - A1 usage: input=95 output=12 cache_create=0 cache_read=0 total=107
  - A2 usage: input=95 output=12 cache_create=0 cache_read=0 total=107
- **B: system 空白/换行微扰**
  - B1 usage: input=102 output=12 cache_create=0 cache_read=0 total=114
  - B2 usage: input=102 output=12 cache_create=0 cache_read=0 total=114
- **C: 多 session 并发 (>=3)**
  - c1 usage: input=95 output=12 cache_create=0 cache_read=0 total=107
  - c2 usage: input=95 output=12 cache_create=0 cache_read=0 total=107
  - c3 usage: input=95 output=12 cache_create=0 cache_read=0 total=107
- **本地缓存统计 (/metrics)**
  - hits=30 misses=5 hitRate=85.7% lastHitAt=2026-03-04T19:27:59.700Z
- **异常与处理**
  - cache_* usage 仍为 0：已在文档注明“上游缺失但本地命中仍有效”。
