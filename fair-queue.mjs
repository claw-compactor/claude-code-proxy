/**
 * Fair Queue with Round-Robin Scheduling & Per-Source Concurrency Limits
 *
 * Ensures fair access when multiple OpenClaw instances share
 * one Claude Code proxy. Round-robin between sources,
 * priority support within each source's queue.
 *
 * Per-source concurrency limits prevent any single source from
 * monopolizing all processing slots (e.g., batch labeler vs IM).
 *
 * All public methods return new objects (immutable pattern).
 * Internal state is encapsulated in closure.
 */

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

export function createFairQueue(options = {}) {
  const {
    maxConcurrent = 10,
    maxPerSource = 20,
    maxTotal = 100,
    queueTimeoutMs = 60000,
    maxLeaseMs = 600_000,
    maxConcurrentPerSource = {},  // { "batch-labeler": 15 } — per-source active slot caps
    defaultMaxConcurrentPerSource = 0,  // 0 = no limit (backwards compatible)
  } = options;

  let activeCount = 0;
  let totalQueued = 0;
  const sourceQueues = new Map();
  let sourceOrder = [];
  let rrIndex = 0;

  // Lease tracking for slot leak detection
  let nextLeaseId = 0;
  let activeLeases = new Map(); // leaseId -> { sourceId, acquiredAt }

  // Per-source active slot counts
  let activePerSource = new Map(); // sourceId -> count

  // Metrics (cumulative)
  let metrics = {
    totalProcessed: 0,
    totalTimedOut: 0,
    totalRejected: 0,
    totalLeaked: 0,
    totalThrottled: 0,
    perSource: {},
  };

  function getSourceConcurrencyLimit(sourceId) {
    if (sourceId in maxConcurrentPerSource) {
      return maxConcurrentPerSource[sourceId];
    }
    return defaultMaxConcurrentPerSource;
  }

  function getSourceActiveCount(sourceId) {
    return activePerSource.get(sourceId) || 0;
  }

  function isSourceAtLimit(sourceId) {
    const limit = getSourceConcurrencyLimit(sourceId);
    if (limit <= 0) return false; // no limit
    return getSourceActiveCount(sourceId) >= limit;
  }

  function incrementSourceActive(sourceId) {
    activePerSource = new Map(activePerSource);
    activePerSource.set(sourceId, getSourceActiveCount(sourceId) + 1);
  }

  function decrementSourceActive(sourceId) {
    activePerSource = new Map(activePerSource);
    const current = getSourceActiveCount(sourceId);
    if (current <= 1) {
      activePerSource.delete(sourceId);
    } else {
      activePerSource.set(sourceId, current - 1);
    }
  }

  // Periodic sweep for timed-out entries + leaked slots
  const sweepInterval = setInterval(() => {
    const now = Date.now();

    // Phase 1: Clean timed-out queue entries
    for (const [sourceId, entries] of sourceQueues) {
      const expired = entries.filter((e) => now - e.enqueuedAt > queueTimeoutMs);
      for (const entry of expired) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`Queue timeout: waited ${queueTimeoutMs}ms`));
        totalQueued--;
        metrics = { ...metrics, totalTimedOut: metrics.totalTimedOut + 1 };
      }
      const remaining = entries.filter((e) => now - e.enqueuedAt <= queueTimeoutMs);
      if (remaining.length === 0) {
        sourceQueues.delete(sourceId);
        sourceOrder = sourceOrder.filter((id) => id !== sourceId);
      } else {
        sourceQueues.set(sourceId, remaining);
      }
    }

    // Phase 2: Detect and force-release leaked slots
    let leakedCount = 0;
    for (const [leaseId, lease] of activeLeases) {
      const held = now - lease.acquiredAt;
      if (held > maxLeaseMs) {
        console.warn(
          `[${new Date().toISOString()}] SLOT_LEAK leaseId=${leaseId} ` +
          `src=${lease.sourceId} held=${Math.round(held / 1000)}s, force-releasing`
        );
        activeLeases = new Map(activeLeases);
        activeLeases.delete(leaseId);
        activeCount--;
        decrementSourceActive(lease.sourceId);
        leakedCount++;
      }
    }
    if (leakedCount > 0) {
      metrics = { ...metrics, totalLeaked: metrics.totalLeaked + leakedCount };
      tryDispatch();
    }
  }, 5000);

  function grantSlot(sourceId) {
    activeCount++;
    incrementSourceActive(sourceId);
    metrics = { ...metrics, totalProcessed: metrics.totalProcessed + 1 };

    const srcStats = metrics.perSource[sourceId] || { processed: 0, throttled: 0 };
    metrics = {
      ...metrics,
      perSource: {
        ...metrics.perSource,
        [sourceId]: { ...srcStats, processed: srcStats.processed + 1 },
      },
    };

    const leaseId = nextLeaseId++;
    let released = false;
    activeLeases = new Map(activeLeases);
    activeLeases.set(leaseId, { sourceId, acquiredAt: Date.now() });

    const releaseFn = () => {
      if (released) return; // idempotent
      released = true;
      if (activeLeases.has(leaseId)) {
        activeLeases = new Map(activeLeases);
        activeLeases.delete(leaseId);
        activeCount--;
        decrementSourceActive(sourceId);
      }
      tryDispatch();
    };

    return releaseFn;
  }

  function tryDispatch() {
    while (activeCount < maxConcurrent && totalQueued > 0) {
      const entry = dequeueNext();
      if (!entry) break;
      clearTimeout(entry.timer);
      totalQueued--;

      const releaseFn = grantSlot(entry.sourceId);
      entry.resolve(releaseFn);
    }
  }

  function dequeueNext() {
    const activeSources = sourceOrder.filter((id) => {
      const q = sourceQueues.get(id);
      return q && q.length > 0;
    });

    if (activeSources.length === 0) return null;

    // Try round-robin, but skip sources that are at their concurrency limit
    const startIdx = rrIndex % activeSources.length;
    for (let i = 0; i < activeSources.length; i++) {
      const idx = (startIdx + i) % activeSources.length;
      const sourceId = activeSources[idx];

      if (isSourceAtLimit(sourceId)) continue;

      rrIndex = (idx + 1) % Math.max(activeSources.length, 1);

      const queue = sourceQueues.get(sourceId);
      const entry = queue[0];
      const rest = queue.slice(1);

      if (rest.length === 0) {
        sourceQueues.delete(sourceId);
        sourceOrder = sourceOrder.filter((id) => id !== sourceId);
      } else {
        sourceQueues.set(sourceId, rest);
      }

      return { ...entry, sourceId };
    }

    // All queued sources are at their per-source limit
    return null;
  }

  /**
   * Acquire a processing slot. Returns a Promise that resolves
   * with a release() function when a slot is available.
   *
   * @param {string} sourceId - Identifier for the requesting source
   * @param {string} priority - "high" | "normal" | "low"
   * @returns {Promise<Function>} release function to call when done
   */
  function acquire(sourceId, priority = "normal") {
    // Fast path: global slot available, source not at limit, and nothing queued
    if (activeCount < maxConcurrent && totalQueued === 0 && !isSourceAtLimit(sourceId)) {
      const releaseFn = grantSlot(sourceId);
      return Promise.resolve(releaseFn);
    }

    // Source at per-source concurrency limit — still enqueue (will dispatch when slot frees)
    if (isSourceAtLimit(sourceId)) {
      const limit = getSourceConcurrencyLimit(sourceId);
      const current = getSourceActiveCount(sourceId);
      metrics = { ...metrics, totalThrottled: metrics.totalThrottled + 1 };
      const srcStats = metrics.perSource[sourceId] || { processed: 0, throttled: 0 };
      metrics = {
        ...metrics,
        perSource: {
          ...metrics.perSource,
          [sourceId]: { ...srcStats, throttled: (srcStats.throttled || 0) + 1 },
        },
      };
      console.log(
        `[${new Date().toISOString()}] SOURCE_THROTTLE src=${sourceId} active=${current}/${limit} — queuing`
      );
    }

    // Check total queue limit
    if (totalQueued >= maxTotal) {
      metrics = { ...metrics, totalRejected: metrics.totalRejected + 1 };
      return Promise.reject(
        new Error(`Queue full: ${totalQueued}/${maxTotal} total`)
      );
    }

    // Check per-source queue limit
    const sourceQueue = sourceQueues.get(sourceId) || [];
    if (sourceQueue.length >= maxPerSource) {
      metrics = { ...metrics, totalRejected: metrics.totalRejected + 1 };
      return Promise.reject(
        new Error(`Source queue full: ${sourceQueue.length}/${maxPerSource} for ${sourceId}`)
      );
    }

    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        priority,
        sourceId,
        enqueuedAt: Date.now(),
        timer: null,
      };

      entry.timer = setTimeout(() => {
        const q = sourceQueues.get(sourceId) || [];
        const filtered = q.filter((e) => e !== entry);
        if (filtered.length === 0) {
          sourceQueues.delete(sourceId);
          sourceOrder = sourceOrder.filter((id) => id !== sourceId);
        } else {
          sourceQueues.set(sourceId, filtered);
        }
        totalQueued--;
        metrics = { ...metrics, totalTimedOut: metrics.totalTimedOut + 1 };
        reject(new Error(`Queue timeout: waited ${queueTimeoutMs}ms`));
      }, queueTimeoutMs);

      // Insert sorted by priority within this source's queue
      const newQueue = [...sourceQueue, entry].sort(
        (a, b) => (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1)
      );

      sourceQueues.set(sourceId, newQueue);

      if (!sourceOrder.includes(sourceId)) {
        sourceOrder = [...sourceOrder, sourceId];
      }

      totalQueued++;
      tryDispatch();
    });
  }

  function getStats() {
    const perSource = {};
    for (const [sourceId, entries] of sourceQueues) {
      perSource[sourceId] = entries.length;
    }

    const now = Date.now();
    const leaseList = Array.from(activeLeases.entries()).map(([id, lease]) => ({
      leaseId: id,
      sourceId: lease.sourceId,
      heldMs: now - lease.acquiredAt,
    }));

    // Per-source active counts
    const activeBySource = {};
    for (const [sourceId, count] of activePerSource) {
      activeBySource[sourceId] = count;
    }

    return {
      active: activeCount,
      maxConcurrent,
      totalQueued,
      maxTotal,
      maxPerSource,
      queueTimeoutMs,
      maxLeaseMs,
      maxConcurrentPerSource,
      defaultMaxConcurrentPerSource,
      queuedPerSource: perSource,
      activeBySource,
      sourceCount: sourceQueues.size,
      activeLeases: leaseList,
      metrics: { ...metrics },
    };
  }

  function destroy() {
    clearInterval(sweepInterval);
    for (const entries of sourceQueues.values()) {
      for (const entry of entries) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Queue destroyed"));
      }
    }
    sourceQueues.clear();
    sourceOrder = [];
    totalQueued = 0;
  }

  return { acquire, getStats, destroy };
}
