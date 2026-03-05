/**
 * Storage backend tests — Redis/local/fallback behavior
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStorageBackend } from "../storage-backend.mjs";
import { createTestRedis, cleanupTestRedis, createMockDisabledRedis } from "./helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, "test-data-storage");
const TEST_FILE = join(TEST_DIR, "storage-backup.json");

describe("storage-backend", () => {
  const redisInstances = [];

  after(async () => {
    for (const instance of redisInstances) {
      await cleanupTestRedis(instance);
    }
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("should persist locally when Redis is unavailable", async () => {
    const storage = createStorageBackend({
      redis: createMockDisabledRedis(),
      localFile: TEST_FILE,
    });
    await storage.ready;

    storage.setLocalValue("analytics:cache", { hits: 2, misses: 1 });
    const loaded = storage.getLocalValue("analytics:cache");

    assert.equal(loaded.hits, 2);
    assert.equal(loaded.misses, 1);
  });

  it("should read/write Redis values when ready", async () => {
    const redis = await createTestRedis();
    redisInstances.push(redis);
    const storage = createStorageBackend({
      redis,
      localFile: TEST_FILE,
    });
    await storage.ready;

    await storage.setRedisValue("analytics:workers", { a: 1 });
    const value = await storage.getRedisValue("analytics:workers");

    assert.equal(value.a, 1);
  });

  it("should migrate local snapshot into Redis", async () => {
    const redis = await createTestRedis();
    redisInstances.push(redis);
    const storage = createStorageBackend({
      redis,
      localFile: TEST_FILE,
    });
    await storage.ready;

    storage.setLocalValue("analytics:cache", { hits: 5 });
    storage.setLocalValue("analytics:workers", { traffic: { a: 2 } });
    storage.setLocalValue("sessions:summary", { s1: { hits: 1 } });

    await storage.migrateLocalToRedis();

    const cache = await storage.getRedisValue("analytics:cache");
    const workers = await storage.getRedisValue("analytics:workers");
    const sessions = await storage.getRedisHash("sessions:summary");

    assert.equal(cache.hits, 5);
    assert.equal(workers.traffic.a, 2);
    assert.equal(sessions.s1.hits, 1);
  });
});
