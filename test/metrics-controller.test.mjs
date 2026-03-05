/**
 * MetricsController tests — response compatibility
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMetricsController } from "../controllers/metrics-controller.mjs";
import { createWorkerHealthController } from "../controllers/worker-health-controller.mjs";

const fakeConfig = {
  rateLimits: { sonnet: { requestsPerMin: 1, tokensPerMin: 1 } },
  routing: { primaryWorker: "1", useCliAgents: true },
  dashboard: { version: "0.0.0" },
  queue: {
    maxConcurrent: 1,
    maxQueueTotal: 1,
    maxQueuePerSource: 1,
    sourceConcurrencyLimits: {},
    defaultSourceConcurrency: 0,
    queueTimeoutMs: 1000,
  },
  heartbeat: { default: 1000 },
  timeouts: { streamTimeoutMs: 1000, syncTimeoutMs: 1000 },
  process: { maxProcessAgeMs: 1000, maxIdleMs: 1000, reaperIntervalMs: 1000 },
  sessionAffinity: { ttlMs: 1000 },
  sessionStats: { topN: 50 },
  cacheControl: {},
  retry: { maxRetries: 1, retryBaseMs: 1000 },
  workers: [{ name: "1" }],
};

describe("metrics controller", () => {
  it("should include legacy fields for /metrics compatibility", async () => {
    const workerHealth = createWorkerHealthController({ workers: [{ name: "1" }] });

    const controller = createMetricsController({
      metricsStore: { getRawBuffer: () => [] },
      queue: { getStats: () => ({ active: 0, totalQueued: 0, metrics: { totalProcessed: 0 }, activeBySource: {} }) },
      registry: { getStats: () => ({ total: 0, byMode: { sync: 0, stream: 0 }, liveTokens: { input: 0, output: 0, total: 0 } }) },
      rateLimiter: { stats: () => ({}) },
      tokenTracker: { getStats: () => ({}) },
      sessionStatsStore: { getStats: async () => ({ total: 0, limit: 50, offset: 0, retentionMs: 0, items: [] }) },
      cacheStatsStore: { getWindowStats: async () => ({}), getCacheStats: () => ({}) },
      workerHealth,
      autoHeal: {
        getStats: () => ({ triggered: 0, success: 0, fail: 0, lastHealAt: null, lastHealReason: null, workers: {} }),
        getWorkerState: () => ({ cooldownUntil: 0, circuitState: "closed", circuitOpenUntil: 0 }),
      },
      config: fakeConfig,
      workerStats: { traffic: {}, errors: {}, recentErrors: [] },
      sessionAffinity: { getStats: () => ({}) },
      systemReaper: { getStats: () => ({}) },
      getUnifiedRateLimits: () => ({}),
      tokenRefresher: { getStatus: () => ({}) },
      activeConnections: new Map(),
    });

    const url = new URL("http://localhost:8403/metrics");
    const payload = await controller.buildMetricsResponse(url);

    assert.ok(payload.rateLimits);
    assert.ok(payload.rateUsage);
    assert.ok(payload.tokens);
    assert.ok(payload.cliRouters);
    assert.ok(payload.queue);
    assert.ok(payload.processes);
    assert.ok(payload.auto_heal_triggered !== undefined);
    assert.ok(payload.auto_heal_success !== undefined);
    assert.ok(payload.auto_heal_fail !== undefined);
    assert.ok(payload.workerStatsWindow);
  });
});
