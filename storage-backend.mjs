/**
 * Unified Storage Backend — Redis-first with local fallback
 *
 * Provides a simple persistence layer for analytics (cache/session/worker stats)
 * with best-effort migration from local backup to Redis on startup.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = Object.freeze({
  backend: "redis",
  localFile: join(__dirname, "data", "storage-backup.json"),
  ttlMs: 24 * 60 * 60 * 1000,
});

function now() {
  return Date.now();
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createStorageBackend({ redis, ...opts } = {}) {
  const config = Object.freeze({ ...DEFAULTS, ...opts });
  const state = { values: {}, loadedAt: null };
  let saveTimer = null;

  function isRedisReady() {
    return config.backend === "redis" && !!redis?.isReady?.() && redis.isReady();
  }

  async function ensureLocalDir() {
    const dir = dirname(config.localFile);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }

  async function loadLocal() {
    try {
      await ensureLocalDir();
      if (!existsSync(config.localFile)) return false;
      const raw = await readFile(config.localFile, "utf-8");
      const data = safeJsonParse(raw);
      if (!data || typeof data !== "object") return false;
      if (data.values && typeof data.values === "object") {
        state.values = data.values;
        state.loadedAt = data.savedAt || null;
        return true;
      }
    } catch (err) {
      console.error(`[Storage] Local load error: ${err.message}`);
    }
    return false;
  }

  function scheduleLocalSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        await ensureLocalDir();
        const payload = JSON.stringify(
          { values: state.values, savedAt: new Date().toISOString() },
          null,
          2
        );
        await writeFile(config.localFile, payload, "utf-8");
      } catch (err) {
        console.error(`[Storage] Local save error: ${err.message}`);
      }
    }, 1000);
    if (saveTimer.unref) saveTimer.unref();
  }

  function getLocalValue(key) {
    return state.values[key] || null;
  }

  function setLocalValue(key, value) {
    state.values[key] = value;
    scheduleLocalSave();
  }

  async function getRedisValue(key) {
    if (!isRedisReady()) return null;
    const raw = await redis.client.get(key);
    if (!raw) return null;
    return safeJsonParse(raw);
  }

  async function setRedisValue(key, value, ttlMs = 0) {
    if (!isRedisReady()) return false;
    const payload = JSON.stringify(value);
    if (ttlMs && ttlMs > 0) {
      await redis.client.set(key, payload, "PX", ttlMs);
    } else {
      await redis.client.set(key, payload);
    }
    return true;
  }

  async function getRedisHash(hashKey) {
    if (!isRedisReady()) return null;
    const raw = await redis.client.hgetall(hashKey);
    if (!raw || Object.keys(raw).length === 0) return null;
    const out = {};
    for (const [field, json] of Object.entries(raw)) {
      const parsed = safeJsonParse(json);
      if (parsed) out[field] = parsed;
    }
    return out;
  }

  async function setRedisHash(hashKey, obj) {
    if (!isRedisReady() || !obj || typeof obj !== "object") return false;
    const pipeline = redis.client.pipeline();
    for (const [field, value] of Object.entries(obj)) {
      pipeline.hset(hashKey, field, JSON.stringify(value));
    }
    await pipeline.exec();
    return true;
  }

  async function migrateLocalToRedis() {
    if (!isRedisReady()) return false;
    const values = state.values || {};
    const cache = values["analytics:cache"];
    const workers = values["analytics:workers"];
    const sessions = values["sessions:summary"];

    try {
      if (cache) await setRedisValue("analytics:cache", cache);
      if (workers) await setRedisValue("analytics:workers", workers);
      if (sessions && typeof sessions === "object") {
        await setRedisHash("sessions:summary", sessions);
      }
      if (cache || workers || sessions) {
        console.log("[Storage] Migrated local analytics snapshot to Redis");
      }
      return true;
    } catch (err) {
      console.error(`[Storage] Migration error: ${err.message}`);
      return false;
    }
  }

  const ready = (async () => {
    await loadLocal();
    if (isRedisReady()) {
      await migrateLocalToRedis();
    }
  })();

  return Object.freeze({
    ready,
    isRedisReady,
    getLocalValue,
    setLocalValue,
    getRedisValue,
    setRedisValue,
    getRedisHash,
    setRedisHash,
    migrateLocalToRedis,
    config,
    redis,
  });
}

// --------------------------------------------------
// Cache stats store
// --------------------------------------------------

export function createCacheStatsStore({ storage, maxRecentKeys = 5000 } = {}) {
  const recentKeys = new Map();
  let stats = {
    candidates: 0,
    applied: 0,
    hits: 0,
    misses: 0,
    lastHitAt: null,
    ttftCachedAvg: null,
    ttftUncachedAvg: null,
  };

  const WINDOWS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000, 24 * 60 * 60 * 1000];
  const EVENTS_KEY = "cache:events";

  function recordCacheCandidate(count) {
    if (count > 0) stats.candidates += count;
    persist();
  }

  function recordCacheApplied(count) {
    if (count > 0) stats.applied += count;
    persist();
  }

  function recordCacheKey(cacheKeyHash) {
    if (!cacheKeyHash) return { seen: false };
    const tsNow = now();
    const seen = recentKeys.has(cacheKeyHash);
    recentKeys.set(cacheKeyHash, tsNow);
    if (recentKeys.size > maxRecentKeys) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, ts] of recentKeys) {
        if (ts < oldestAt) { oldestAt = ts; oldestKey = key; }
      }
      if (oldestKey) recentKeys.delete(oldestKey);
    }
    if (seen) {
      stats.hits++;
      stats.lastHitAt = tsNow;
    } else {
      stats.misses++;
    }
    recordCacheEvent(seen);
    persist();
    return { seen };
  }

  function recordCacheTtft(ttftMs, cached) {
    const key = cached ? "ttftCachedAvg" : "ttftUncachedAvg";
    const prev = stats[key];
    stats[key] = prev == null ? ttftMs : Math.round(prev * 0.8 + ttftMs * 0.2);
    persist();
  }

  function getCacheStats() {
    const total = stats.hits + stats.misses;
    return {
      candidates: stats.candidates,
      applied: stats.applied,
      hits: stats.hits,
      misses: stats.misses,
      hitRate: total > 0 ? (stats.hits / total * 100).toFixed(1) + "%" : "0%",
      lastHitAt: stats.lastHitAt,
      lastHitIso: stats.lastHitAt ? new Date(stats.lastHitAt).toISOString() : null,
      ttftCachedAvg: stats.ttftCachedAvg,
      ttftUncachedAvg: stats.ttftUncachedAvg,
      recentKeys: recentKeys.size,
    };
  }

  function recordCacheEvent(hit) {
    if (!storage?.isRedisReady?.() || !storage.isRedisReady()) return;
    const tsNow = now();
    const member = `${tsNow}:${hit ? 1 : 0}:${Math.random().toString(36).slice(2, 8)}`;
    const cutoff = tsNow - WINDOWS[WINDOWS.length - 1];
    const client = storage.redis?.client;
    if (!client) return;
    const pipe = client.pipeline();
    pipe.zadd(EVENTS_KEY, tsNow, member);
    pipe.zremrangebyscore(EVENTS_KEY, "-inf", cutoff);
    pipe.exec().catch(() => {});
  }

  async function getWindowStats() {
    if (!storage?.isRedisReady?.() || !storage.isRedisReady()) return null;
    const client = storage.redis?.client;
    if (!client) return null;
    const tsNow = now();
    const out = {};
    for (const win of WINDOWS) {
      const cutoff = tsNow - win;
      const events = await client.zrangebyscore(EVENTS_KEY, cutoff, "+inf");
      let hits = 0;
      for (const ev of events) {
        const parts = String(ev).split(":");
        if (parts[1] === "1") hits++;
      }
      const reqs = events.length;
      out[win] = {
        requests: reqs,
        hits,
        hitRate: reqs > 0 ? (hits / reqs * 100).toFixed(1) + "%" : "0%",
      };
    }
    return out;
  }

  function persist() {
    storage?.setLocalValue?.("analytics:cache", stats);
    if (storage?.isRedisReady?.() && storage.isRedisReady()) {
      storage.setRedisValue?.("analytics:cache", stats).catch?.(() => {});
    }
  }

  async function load() {
    const fromRedis = storage?.isRedisReady?.() && storage.isRedisReady()
      ? await storage.getRedisValue?.("analytics:cache")
      : null;
    const fromLocal = storage?.getLocalValue?.("analytics:cache");
    const loaded = fromRedis || fromLocal;
    if (loaded && typeof loaded === "object") {
      stats = { ...stats, ...loaded };
    }
  }

  return {
    load,
    recordCacheCandidate,
    recordCacheApplied,
    recordCacheKey,
    recordCacheTtft,
    getCacheStats,
    getWindowStats,
  };
}

// --------------------------------------------------
// Session stats store (Redis-backed, local fallback)
// --------------------------------------------------

export function createSessionStatsStore({ storage, ttlMs = 24 * 60 * 60 * 1000, cleanupIntervalMs = 5 * 60 * 1000, topN = 50 } = {}) {
  const local = new Map();
  let lastCleanup = 0;
  let localSaveTimer = null;

  function normalizeSessionId(raw) {
    const id = raw == null ? "" : String(raw).trim();
    return id || "anonymous";
  }

  async function record(sessionId, hit) {
    const tsNow = now();
    const key = normalizeSessionId(sessionId);

    if (storage?.isRedisReady?.() && storage.isRedisReady()) {
      const summaryKey = "sessions:summary";
      const eventsKey = `sessions:events:${key}`;
      const client = storage.redis?.client || storage.config.redis?.client;
      if (client) {
        const raw = await client.hget(summaryKey, key);
        const prev = raw ? safeJsonParse(raw) : null;
        const next = {
          hits: (prev?.hits || 0) + (hit ? 1 : 0),
          misses: (prev?.misses || 0) + (hit ? 0 : 1),
          lastHitAt: hit ? tsNow : (prev?.lastHitAt || null),
          lastReqAt: tsNow,
        };
        const member = `${tsNow}:${hit ? 1 : 0}:${Math.random().toString(36).slice(2, 8)}`;
        const cutoff = tsNow - ttlMs;
        const pipe = client.pipeline();
        pipe.hset(summaryKey, key, JSON.stringify(next));
        pipe.zadd(eventsKey, tsNow, member);
        pipe.zremrangebyscore(eventsKey, "-inf", cutoff);
        pipe.exec().catch(() => {});
      }
      return;
    }

    // Local fallback
    const entry = local.get(key) || { events: [], lastHitAt: null, lastReqAt: null, hits: 0, misses: 0 };
    entry.events.push({ ts: tsNow, hit: !!hit });
    entry.lastReqAt = tsNow;
    if (hit) {
      entry.lastHitAt = tsNow;
      entry.hits++;
    } else {
      entry.misses++;
    }
    local.set(key, entry);
    prune(tsNow);
    scheduleLocalSummarySave();
  }

  function prune(tsNow, force = false) {
    if (!force && tsNow - lastCleanup < cleanupIntervalMs) return;
    const cutoff = tsNow - ttlMs;
    for (const [key, entry] of local) {
      if ((entry.lastReqAt || 0) < cutoff) {
        local.delete(key);
        continue;
      }
      while (entry.events.length && entry.events[0].ts < cutoff) {
        entry.events.shift();
      }
    }
    lastCleanup = tsNow;
  }

  function scheduleLocalSummarySave() {
    if (!storage?.setLocalValue) return;
    if (localSaveTimer) return;
    localSaveTimer = setTimeout(() => {
      localSaveTimer = null;
      const summary = {};
      for (const [sessionId, entry] of local) {
        summary[sessionId] = {
          hits: entry.hits || 0,
          misses: entry.misses || 0,
          lastHitAt: entry.lastHitAt || null,
          lastReqAt: entry.lastReqAt || null,
        };
      }
      storage.setLocalValue("sessions:summary", summary);
    }, 1000);
    if (localSaveTimer.unref) localSaveTimer.unref();
  }

  function computeWindowStats(entry, tsNow) {
    const windows = {
      five: 5 * 60 * 1000,
      fifteen: 15 * 60 * 1000,
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
    };
    let req5m = 0, req15m = 0, req1h = 0, req24h = 0;
    let hits = 0, misses = 0;
    let hits5m = 0, hits15m = 0, hits1h = 0, hits24h = 0;
    for (const ev of entry.events) {
      if (ev.hit) hits++;
      else misses++;
      const age = tsNow - ev.ts;
      if (age <= windows.day) {
        req24h++;
        if (ev.hit) hits24h++;
        if (age <= windows.hour) {
          req1h++;
          if (ev.hit) hits1h++;
          if (age <= windows.fifteen) {
            req15m++;
            if (ev.hit) hits15m++;
            if (age <= windows.five) {
              req5m++;
              if (ev.hit) hits5m++;
            }
          }
        }
      }
    }
    const total = hits + misses;
    return {
      requests5m: req5m,
      requests15m: req15m,
      requests1h: req1h,
      requests24h: req24h,
      hits,
      misses,
      hitRate: total > 0 ? (hits / total * 100).toFixed(1) + "%" : "0%",
      hitRate5m: req5m > 0 ? (hits5m / req5m * 100).toFixed(1) + "%" : "0%",
      hitRate15m: req15m > 0 ? (hits15m / req15m * 100).toFixed(1) + "%" : "0%",
      hitRate1h: req1h > 0 ? (hits1h / req1h * 100).toFixed(1) + "%" : "0%",
      hitRate24h: req24h > 0 ? (hits24h / req24h * 100).toFixed(1) + "%" : "0%",
    };
  }

  async function getStats({ limit = topN, offset = 0 } = {}) {
    const tsNow = now();

    if (storage?.isRedisReady?.() && storage.isRedisReady()) {
      const client = storage.redis?.client || storage.config.redis?.client;
      if (!client) return { total: 0, limit, offset, retentionMs: ttlMs, items: [] };
      const summary = await client.hgetall("sessions:summary");
      const items = [];
      for (const [sessionId, json] of Object.entries(summary || {})) {
        const data = safeJsonParse(json) || {};
        items.push({ sessionId, ...data });
      }
      items.sort((a, b) => (b.lastReqAt || 0) - (a.lastReqAt || 0));
      const safeOffset = Math.max(0, offset || 0);
      const safeLimit = Math.max(1, limit || topN);
      const slice = items.slice(safeOffset, safeOffset + safeLimit);

      // Compute window stats per session
      for (const item of slice) {
        const eventsKey = `sessions:events:${item.sessionId}`;
        const windows = {
          five: tsNow - 5 * 60 * 1000,
          fifteen: tsNow - 15 * 60 * 1000,
          hour: tsNow - 60 * 60 * 1000,
          day: tsNow - 24 * 60 * 60 * 1000,
        };
        const ev5 = await client.zrangebyscore(eventsKey, windows.five, "+inf");
        const ev15 = await client.zrangebyscore(eventsKey, windows.fifteen, "+inf");
        const ev1h = await client.zrangebyscore(eventsKey, windows.hour, "+inf");
        const ev24h = await client.zrangebyscore(eventsKey, windows.day, "+inf");
        const hits5m = ev5.filter((ev) => String(ev).split(":")[1] === "1").length;
        const hits15m = ev15.filter((ev) => String(ev).split(":")[1] === "1").length;
        const hits1h = ev1h.filter((ev) => String(ev).split(":")[1] === "1").length;
        const hits24h = ev24h.filter((ev) => String(ev).split(":")[1] === "1").length;
        item.requests5m = ev5.length;
        item.requests15m = ev15.length;
        item.requests1h = ev1h.length;
        item.requests24h = ev24h.length;
        item.hitRate5m = ev5.length > 0 ? (hits5m / ev5.length * 100).toFixed(1) + "%" : "0%";
        item.hitRate15m = ev15.length > 0 ? (hits15m / ev15.length * 100).toFixed(1) + "%" : "0%";
        item.hitRate1h = ev1h.length > 0 ? (hits1h / ev1h.length * 100).toFixed(1) + "%" : "0%";
        item.hitRate24h = ev24h.length > 0 ? (hits24h / ev24h.length * 100).toFixed(1) + "%" : "0%";
        const hits = (item.hits || 0);
        const misses = (item.misses || 0);
        const total = hits + misses;
        item.hitRate = total > 0 ? (hits / total * 100).toFixed(1) + "%" : "0%";
        item.lastHitIso = item.lastHitAt ? new Date(item.lastHitAt).toISOString() : null;
        item.lastReqIso = item.lastReqAt ? new Date(item.lastReqAt).toISOString() : null;
      }

      return {
        total: items.length,
        limit: safeLimit,
        offset: safeOffset,
        retentionMs: ttlMs,
        items: slice,
      };
    }

    // Local fallback
    prune(tsNow, true);
    const items = [];
    for (const [sessionId, entry] of local) {
      const stats = computeWindowStats(entry, tsNow);
      items.push({
        sessionId,
        ...stats,
        lastHitAt: entry.lastHitAt,
        lastHitIso: entry.lastHitAt ? new Date(entry.lastHitAt).toISOString() : null,
        lastReqAt: entry.lastReqAt,
        lastReqIso: entry.lastReqAt ? new Date(entry.lastReqAt).toISOString() : null,
      });
    }
    items.sort((a, b) => (b.lastReqAt || 0) - (a.lastReqAt || 0));
    const safeOffset = Math.max(0, offset || 0);
    const safeLimit = Math.max(1, limit || topN);
    return {
      total: local.size,
      limit: safeLimit,
      offset: safeOffset,
      retentionMs: ttlMs,
      items: items.slice(safeOffset, safeOffset + safeLimit),
    };
  }

  function getConfig() {
    return { ttlMs, cleanupIntervalMs, topN };
  }

  return {
    record,
    getStats,
    getConfig,
  };
}

// --------------------------------------------------
// Worker stats persistence helpers
// --------------------------------------------------

export function createWorkerStatsStore({ storage } = {}) {
  let workerStats = null;

  async function load() {
    const fromRedis = storage?.isRedisReady?.() && storage.isRedisReady()
      ? await storage.getRedisValue?.("analytics:workers")
      : null;
    const fromLocal = storage?.getLocalValue?.("analytics:workers");
    workerStats = fromRedis || fromLocal || null;
    return workerStats;
  }

  function save(stats) {
    workerStats = stats;
    storage?.setLocalValue?.("analytics:workers", stats);
    if (storage?.isRedisReady?.() && storage.isRedisReady()) {
      storage.setRedisValue?.("analytics:workers", stats).catch?.(() => {});
    }
  }

  function get() {
    return workerStats;
  }

  return { load, save, get };
}
