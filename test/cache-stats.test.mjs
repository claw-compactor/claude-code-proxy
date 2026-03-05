/**
 * Cache stats store tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createStorageBackend, createCacheStatsStore } from "../storage-backend.mjs";
import { createMockDisabledRedis } from "./helpers.mjs";
import { randomUUID } from "crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "test-data-cache");

async function createFreshStorage() {
  await mkdir(CACHE_DIR, { recursive: true });
  const storage = createStorageBackend({
    redis: createMockDisabledRedis(),
    localFile: join(CACHE_DIR, `storage-${randomUUID()}.json`),
  });
  await storage.ready;
  return storage;
}

describe("cache stats", () => {
  it("should track hits and misses", async () => {
    const storage = await createFreshStorage();
    const store = createCacheStatsStore({ storage, maxRecentKeys: 5 });
    await store.load();

    store.recordCacheKey("abc");
    store.recordCacheKey("abc");
    store.recordCacheKey("def");

    const stats = store.getCacheStats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 2);
    assert.ok(stats.hitRate.endsWith("%"));
  });

  it("should record candidates and applied counts", async () => {
    const storage = await createFreshStorage();
    const store = createCacheStatsStore({ storage, maxRecentKeys: 5 });
    await store.load();

    store.recordCacheCandidate(2);
    store.recordCacheApplied(1);

    const stats = store.getCacheStats();
    assert.ok(stats.candidates >= 2);
    assert.ok(stats.applied >= 1);
  });
});
