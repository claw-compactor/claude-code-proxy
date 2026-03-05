/**
 * Session stats window aggregation tests (5m/15m/1h/24h)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSessionStatsStore } from "../storage-backend.mjs";

function createLocalStorage() {
  const values = {};
  return {
    isRedisReady: () => false,
    getLocalValue: (k) => values[k],
    setLocalValue: (k, v) => { values[k] = v; },
  };
}

describe("session stats windows", () => {
  it("should include 5m/15m/1h/24h fields for local fallback", async () => {
    const storage = createLocalStorage();
    const store = createSessionStatsStore({ storage, ttlMs: 24 * 60 * 60 * 1000 });

    await store.record("session-a", true);
    const stats = await store.getStats({ limit: 10, offset: 0 });

    assert.equal(stats.items.length, 1);
    const item = stats.items[0];
    assert.ok(item.requests5m >= 1);
    assert.ok(item.requests15m >= 1);
    assert.ok(item.requests1h >= 1);
    assert.ok(item.requests24h >= 1);
    assert.ok(item.hitRate24h.endsWith("%"));
  });

  it("should track hit/miss counts across windows", async () => {
    const storage = createLocalStorage();
    const store = createSessionStatsStore({ storage, ttlMs: 24 * 60 * 60 * 1000 });

    await store.record("session-b", true);
    await store.record("session-b", false);
    const stats = await store.getStats({ limit: 10, offset: 0 });

    const item = stats.items[0];
    assert.equal(item.hits, 1);
    assert.equal(item.misses, 1);
    assert.ok(parseFloat(item.hitRate24h) >= 0);
  });
});
