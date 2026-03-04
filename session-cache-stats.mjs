/**
 * Session Cache Stats
 * Tracks per-session cache hits/misses over rolling windows.
 */

export function createSessionCacheStats({
  ttlMs = 24 * 60 * 60 * 1000,
  cleanupIntervalMs = 5 * 60 * 1000,
  topN = 50,
} = {}) {
  const sessions = new Map();
  let lastCleanup = 0;

  function normalizeSessionId(raw) {
    const id = raw == null ? "" : String(raw).trim();
    return id || "anonymous";
  }

  function pruneExpired(now, force = false) {
    if (!force && now - lastCleanup < cleanupIntervalMs) return;
    const cutoff = now - ttlMs;
    for (const [key, entry] of sessions) {
      if ((entry.lastReqAt || 0) < cutoff) {
        sessions.delete(key);
        continue;
      }
      while (entry.events.length && entry.events[0].ts < cutoff) {
        entry.events.shift();
      }
    }
    lastCleanup = now;
  }

  function record(sessionId, hit) {
    const now = Date.now();
    const key = normalizeSessionId(sessionId);
    const entry = sessions.get(key) || { events: [], lastHitAt: null, lastReqAt: null };
    entry.events.push({ ts: now, hit: !!hit });
    entry.lastReqAt = now;
    if (hit) entry.lastHitAt = now;
    sessions.set(key, entry);
    pruneExpired(now);
  }

  function computeWindowStats(entry, now) {
    const windows = {
      five: 5 * 60 * 1000,
      fifteen: 15 * 60 * 1000,
      hour: 60 * 60 * 1000,
    };
    let req5m = 0, req15m = 0, req1h = 0;
    let hits = 0, misses = 0;
    let hits5m = 0, hits15m = 0, hits1h = 0;
    for (const ev of entry.events) {
      if (ev.hit) hits++;
      else misses++;
      const age = now - ev.ts;
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
    const total = hits + misses;
    const hitRate5m = req5m > 0 ? (hits5m / req5m * 100).toFixed(1) + "%" : "0%";
    const hitRate15m = req15m > 0 ? (hits15m / req15m * 100).toFixed(1) + "%" : "0%";
    const hitRate1h = req1h > 0 ? (hits1h / req1h * 100).toFixed(1) + "%" : "0%";
    return {
      requests5m: req5m,
      requests15m: req15m,
      requests1h: req1h,
      hits,
      misses,
      hitRate: total > 0 ? (hits / total * 100).toFixed(1) + "%" : "0%",
      hitRate5m,
      hitRate15m,
      hitRate1h,
    };
  }

  function getStats({ limit = topN, offset = 0 } = {}) {
    const now = Date.now();
    pruneExpired(now, true);
    const items = [];
    for (const [sessionId, entry] of sessions) {
      const stats = computeWindowStats(entry, now);
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
      total: sessions.size,
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
