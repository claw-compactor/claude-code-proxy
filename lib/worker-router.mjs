/**
 * Worker routing: rate-limit-aware least-connections load balancing
 * with session affinity tiebreaker.
 * Extracted from server.mjs — depends on workerHealth + sessionAffinity.
 */

import { classifyRateLimit } from "./rate-limit-classifier.mjs";

/**
 * Create a worker router.
 *
 * @param {object} opts
 * @param {Array} opts.workerPool - Array of worker configs
 * @param {string} opts.primaryWorker - Name of primary worker
 * @param {function} opts.getWorkerHealth - () => workerHealthController instance
 * @param {function} opts.getSessionAffinity - () => sessionAffinity instance
 * @param {object} opts.workerStats - { traffic: { name: { requests, errors } } }
 */
export function createWorkerRouter({
  workerPool,
  primaryWorker,
  getWorkerHealth,
  getSessionAffinity,
  workerStats,
  getUnifiedRateLimits = null,
}) {
  const _activeConns = new Map(workerPool.map(w => [w.name, 0]));
  let _leastLoadedRrIndex = 0;

  const enabledWorkers = () => workerPool.filter(w => !w.disabled);

  function workerAcquire(name) {
    _activeConns.set(name, (_activeConns.get(name) || 0) + 1);
  }

  function workerRelease(name) {
    const v = _activeConns.get(name) || 0;
    _activeConns.set(name, Math.max(0, v - 1));
  }

  function leastLoadedWorker(pool) {
    let minConns = Infinity;
    let minTotal = Infinity;
    for (const w of pool) {
      const c = _activeConns.get(w.name) ?? 0;
      const t = workerStats.traffic[w.name]?.requests ?? 0;
      if (c < minConns || (c === minConns && t < minTotal)) {
        minConns = c;
        minTotal = t;
      }
    }
    const tied = pool.filter(w => {
      const c = _activeConns.get(w.name) ?? 0;
      const t = workerStats.traffic[w.name]?.requests ?? 0;
      return c === minConns && t === minTotal;
    });
    if (tied.length === 1) return tied[0];
    const pick = tied[_leastLoadedRrIndex % tied.length];
    _leastLoadedRrIndex = (_leastLoadedRrIndex + 1) % tied.length;
    return pick;
  }

  /**
   * Classify healthy workers into rate-limit tiers, returning the best pool.
   */
  function _rateLimitFilteredPool(healthy) {
    const rateLimits = getUnifiedRateLimits?.() || {};
    const classified = healthy.map(w => {
      const rl = rateLimits[w.name] || null;
      const { effectiveUtil, tier } = classifyRateLimit(rl);
      return { worker: w, effectiveUtil, tier };
    });

    const available = classified.filter(c => c.tier === "available" || c.tier === "unknown");
    if (available.length > 0) return available.map(c => c.worker);

    const strained = classified.filter(c => c.tier === "strained");
    if (strained.length > 0) {
      strained.sort((a, b) => a.effectiveUtil - b.effectiveUtil);
      return strained.map(c => c.worker);
    }

    // All saturated — degrade to original pool
    return healthy;
  }

  /**
   * Get the next worker, respecting rate limits and session affinity.
   */
  function getNextWorker(sessionKey) {
    const workerHealth = getWorkerHealth();
    const sessionAffinity = getSessionAffinity();
    const isHealthy = (name) => {
      const w = workerPool.find(x => x.name === name);
      if (w?.disabled || w?.draining) return false;
      return workerHealth?.isHealthy(name);
    };
    const enabled = enabledWorkers();
    const pool = enabled.length > 0 ? enabled : workerPool;
    const healthy = pool.filter((w) => isHealthy(w.name));

    if (healthy.length === 0) {
      const sorted = [...pool].sort(
        (a, b) => (workerHealth?.getState(a.name)?.limitedAt || 0) - (workerHealth?.getState(b.name)?.limitedAt || 0),
      );
      console.log(`[CLIRouter] ALL LIMITED — trying oldest-limited: ${sorted[0].name}`);
      return sorted[0];
    }

    if (healthy.length === 1) {
      return healthy[0];
    }

    if (!workerHealth?.getLoadBalanceMode()) {
      const primary = healthy.find((w) => w.name === primaryWorker);
      return primary || healthy[0];
    }

    // Apply rate-limit tier filtering
    const filtered = getUnifiedRateLimits ? _rateLimitFilteredPool(healthy) : healthy;

    const least = leastLoadedWorker(filtered);
    const leastConns = _activeConns.get(least.name) || 0;

    // Session affinity only applies within the filtered pool
    if (sessionKey && sessionAffinity) {
      const aff = sessionAffinity.lookup(sessionKey, isHealthy);
      if (aff?.hit) {
        const affinityWorker = filtered.find((w) => w.name === aff.workerName);
        if (affinityWorker) {
          const affConns = _activeConns.get(affinityWorker.name) || 0;
          if (affConns < leastConns) return affinityWorker;
        }
      }
    }

    return least;
  }

  function getWorkerByName(name) {
    const enabled = enabledWorkers();
    const pool = enabled.length > 0 ? enabled : workerPool;
    return pool.find((w) => w.name === name) || null;
  }

  function getAlternateWorker(excludeName) {
    const workerHealth = getWorkerHealth();
    const enabled = enabledWorkers();
    const pool = enabled.length > 0 ? enabled : workerPool;
    const healthy = pool.filter(
      (w) => w.name !== excludeName && !w.disabled && !w.draining && workerHealth?.isHealthy(w.name)
    );
    return healthy.length > 0 ? healthy[0] : null;
  }

  function getActiveConnections() {
    return _activeConns;
  }

  return Object.freeze({
    getNextWorker,
    getWorkerByName,
    getAlternateWorker,
    workerAcquire,
    workerRelease,
    leastLoadedWorker,
    getActiveConnections,
    enabledWorkers,
  });
}
