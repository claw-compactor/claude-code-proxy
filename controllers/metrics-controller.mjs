/**
 * MetricsController — unified metrics response + window aggregation helpers.
 */

function ts() {
  return new Date().toISOString();
}

export function createMetricsController({
  metricsStore,
  queue,
  registry,
  rateLimiter,
  tokenTracker,
  sessionStatsStore,
  cacheStatsStore,
  workerHealth,
  autoHeal,
  config,
  workerStats,
  sessionAffinity,
  systemReaper,
  getUnifiedRateLimits,
  tokenRefresher,
  activeConnections = null,
  getWorkerTokenReason = null,
  tokenHealthProbe = null,
  getTokenRoutingSnapshot = null,
  logger = console,
} = {}) {
  function computeWorkerWindowStats(windowMs = 60 * 60 * 1000) {
    const cutoff = Date.now() - windowMs;
    const raw = metricsStore.getRawBuffer().filter((e) => (e.ts || 0) * 1000 >= cutoff && e.workers);
    if (raw.length === 0) return { windowMs, traffic: {}, samples: 0 };

    const sorted = raw.sort((a, b) => a.ts - b.ts);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const names = new Set([
      ...Object.keys(first.workers || {}),
      ...Object.keys(last.workers || {}),
    ]);
    const traffic = {};
    for (const name of names) {
      const f = first.workers?.[name] || { r: 0, e: 0 };
      const l = last.workers?.[name] || { r: 0, e: 0 };
      const reqDelta = l.r - f.r;
      const errDelta = l.e - f.e;
      traffic[name] = {
        requests: reqDelta >= 0 ? reqDelta : l.r || 0,
        errors: errDelta >= 0 ? errDelta : l.e || 0,
      };
    }
    return { windowMs, traffic, samples: sorted.length, startTs: first.ts, endTs: last.ts };
  }

  function seedWorkerStatsFromHistory() {
    const raw = metricsStore.getRawBuffer();
    if (!raw || raw.length === 0) return false;
    const last = raw[raw.length - 1];
    if (!last?.workers) return false;
    for (const [name, stats] of Object.entries(last.workers)) {
      if (!workerStats.traffic[name]) {
        workerStats.traffic[name] = { requests: 0, errors: 0, lastReqAt: null };
      }
      workerStats.traffic[name].requests = stats.r || 0;
      workerStats.traffic[name].errors = stats.e || 0;
      workerStats.traffic[name].lastReqAt = stats.last || null;
    }
    return true;
  }

  async function buildMetricsResponse(url) {
    const qs = queue.getStats();
    const rs = registry.getStats();

    const sessionLimitRaw = parseInt(url.searchParams.get("sessions_limit") || "", 10);
    const sessionOffsetRaw = parseInt(url.searchParams.get("sessions_offset") || "0", 10);
    const defaultSessionLimit = config.sessionStats?.topN ?? 50;
    const sessionLimit = Number.isFinite(sessionLimitRaw)
      ? Math.max(1, Math.min(sessionLimitRaw, 500))
      : defaultSessionLimit;
    const sessionOffset = Number.isFinite(sessionOffsetRaw) ? Math.max(0, sessionOffsetRaw) : 0;
    const sessions = sessionStatsStore
      ? await sessionStatsStore.getStats({ limit: sessionLimit, offset: sessionOffset })
      : { total: 0, limit: sessionLimit, offset: sessionOffset, retentionMs: 0, items: [] };
    const cacheWindows = cacheStatsStore ? await cacheStatsStore.getWindowStats() : null;

    const workers = config.workers.map((w) => {
      const state = workerHealth.getState(w.name);
      const until = state.limitedUntil || null;
      const auto = autoHeal.getWorkerState(w.name);
      return {
        name: w.name,
        disabled: !!w.disabled,
        disabledReason: w.disabledReason || null,
        tokenReason: getWorkerTokenReason ? getWorkerTokenReason(w) : null,
        limited: !!state.limited,
        limitedAt: state.limitedAt || null,
        limitedUntil: until,
        limitedRemainingSec: state.limited && until
          ? Math.max(0, Math.round((until - Date.now()) / 1000))
          : null,
        circuitState: state.circuitOpenUntil && Date.now() < state.circuitOpenUntil ? "open" : "closed",
        circuitOpenUntil: state.circuitOpenUntil || null,
        autoHeal: {
          cooldownUntil: auto.cooldownUntil || null,
          cooldownRemainingSec: auto.cooldownUntil ? Math.max(0, Math.round((auto.cooldownUntil - Date.now()) / 1000)) : null,
          circuitState: auto.circuitState,
          circuitOpenUntil: auto.circuitOpenUntil || null,
          circuitRemainingSec: auto.circuitOpenUntil ? Math.max(0, Math.round((auto.circuitOpenUntil - Date.now()) / 1000)) : null,
        },
      };
    });

    const autoHealStats = autoHeal.getStats();

    return {
      rateLimits: config.rateLimits,
      rateUsage: rateLimiter.stats(),
      tokens: tokenTracker.getStats(),
      cliRouters: workers,
      loadBalanceMode: workerHealth.getLoadBalanceMode(),
      primaryRouter: config.routing.primaryWorker,
      queue: qs,
      processes: rs,
      sessions,
      cacheWindows,
      config: {
        version: config.dashboard.version,
        useCliAgents: config.routing.useCliAgents,
        workerCount: config.workers.length,
        loadBalanceAlgorithm: "least-utilization",
        maxConcurrent: config.queue.maxConcurrent,
        maxQueueTotal: config.queue.maxQueueTotal,
        maxQueuePerSource: config.queue.maxQueuePerSource,
        sourceConcurrencyLimits: config.queue.sourceConcurrencyLimits,
        defaultSourceConcurrency: config.queue.defaultSourceConcurrency,
        queueTimeoutMs: config.queue.queueTimeoutMs,
        heartbeatByModel: config.heartbeat,
        defaultHeartbeatMs: config.heartbeat.default,
        streamTimeoutMs: config.timeouts.streamTimeoutMs,
        syncTimeoutMs: config.timeouts.syncTimeoutMs,
        maxProcessAgeMs: config.process.maxProcessAgeMs,
        maxIdleMs: config.process.maxIdleMs,
        reaperIntervalMs: config.process.reaperIntervalMs,
        sessionAffinityTtlMs: config.sessionAffinity?.ttlMs ?? 30 * 60 * 1000,
        sessionStats: config.sessionStats,
        cacheControl: config.cacheControl,
        sseKeepaliveMs: 30_000,
        maxRetries: config.retry.maxRetries,
        retryBaseMs: config.retry.retryBaseMs,
      },
      sessionAffinity: sessionAffinity.getStats(),
      cache: cacheStatsStore?.getCacheStats?.() || {},
      workerStats,
      workerStatsWindow: computeWorkerWindowStats(),
      autoHeal: autoHealStats,
      auto_heal_triggered: autoHealStats.triggered,
      auto_heal_success: autoHealStats.success,
      auto_heal_fail: autoHealStats.fail,
      last_heal_at: autoHealStats.lastHealAt,
      heal_reason: autoHealStats.lastHealReason,
      circuit_state: autoHeal.getWorkerState(config.routing.primaryWorker).circuitState,
      activeConnections: (() => {
        if (!activeConnections) return {};
        if (activeConnections instanceof Map) return Object.fromEntries(activeConnections);
        return { ...activeConnections };
      })(),
      systemReaper: systemReaper.getStats(),
      unifiedRateLimits: getUnifiedRateLimits?.() || {},
      rateLimitEnhanced: getTokenRoutingSnapshot?.() || {},
      tokenRefreshStatus: tokenRefresher?.getStatus?.() || null,
      tokenProbe: tokenHealthProbe?.getResults?.() || {},
      generatedAt: ts(),
    };
  }

  return Object.freeze({
    computeWorkerWindowStats,
    seedWorkerStatsFromHistory,
    buildMetricsResponse,
  });
}
