/**
 * StorageController — unified storage access with Redis/local fallback.
 * Wraps storage-backend + cache/session/worker stores into a single interface.
 */

import {
  createStorageBackend,
  createCacheStatsStore,
  createSessionStatsStore,
  createWorkerStatsStore,
} from "../storage-backend.mjs";

function ts() {
  return new Date().toISOString();
}

export function createStorageController({
  redis,
  storageConfig = {},
  cacheConfig = {},
  sessionConfig = {},
  logger = console,
} = {}) {
  const storage = createStorageBackend({ redis, ...storageConfig });
  const cacheStats = createCacheStatsStore({
    storage,
    maxRecentKeys: cacheConfig.keyMaxEntries,
  });
  const sessionStats = createSessionStatsStore({
    storage,
    ttlMs: sessionConfig.ttlMs,
    cleanupIntervalMs: sessionConfig.cleanupIntervalMs,
    topN: sessionConfig.topN,
  });
  const workerStatsStore = createWorkerStatsStore({ storage });

  async function init() {
    await storage.ready;
    await cacheStats.load();
    await workerStatsStore.load();
    logger.log(`[${ts()}] STORAGE_READY redis=${storage.isRedisReady?.()}`);
  }

  return Object.freeze({
    storage,
    cacheStats,
    sessionStats,
    workerStatsStore,
    init,
  });
}
