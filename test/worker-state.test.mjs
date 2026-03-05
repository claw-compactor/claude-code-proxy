/**
 * Tests for lib/worker-state.mjs
 *
 * Covers: disable (with drain), enable, getAll, config persistence
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createWorkerState } from "../lib/worker-state.mjs";

const tmpConfigPath = () => join(tmpdir(), `test-proxy-${randomUUID().slice(0, 8)}.json`);

async function makeTestConfig(path) {
  const config = {
    workers: [
      { name: "1", bin: "claude-1" },
      { name: "2", bin: "claude-2" },
    ],
  };
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8");
  return config;
}

describe("worker-state", () => {
  let configPath;

  beforeEach(async () => {
    configPath = tmpConfigPath();
    await makeTestConfig(configPath);
  });

  afterEach(async () => {
    try { await unlink(configPath); } catch { /* ignore */ }
  });

  describe("disable", () => {
    it("should disable a worker with 0 active connections immediately", async () => {
      const pool = [
        { name: "1", bin: "claude-1" },
        { name: "2", bin: "claude-2" },
      ];
      const state = createWorkerState({
        workerPool: pool,
        configPath,
        getActiveConns: () => 0,
        drainTimeoutMs: 1000,
        log: () => {},
      });

      const result = await state.disable("1", "test");
      assert.equal(result.status, "disabled");
      assert.equal(result.drain, "drained");
      assert.equal(pool[0].disabled, true);
      assert.equal(pool[0].disabledReason, "test");
    });

    it("should return error for non-existent worker", async () => {
      const pool = [{ name: "1", bin: "claude-1" }];
      const state = createWorkerState({
        workerPool: pool,
        configPath,
        log: () => {},
      });

      const result = await state.disable("nonexistent");
      assert.equal(result.error, "worker_not_found");
    });

    it("should return already_disabled for already disabled worker", async () => {
      const pool = [{ name: "1", bin: "claude-1", disabled: true }];
      const state = createWorkerState({
        workerPool: pool,
        configPath,
        log: () => {},
      });

      const result = await state.disable("1");
      assert.equal(result.status, "already_disabled");
    });

    it("should timeout drain when connections don't clear", async () => {
      const pool = [{ name: "1", bin: "claude-1" }];
      const state = createWorkerState({
        workerPool: pool,
        configPath,
        getActiveConns: () => 5, // always has connections
        drainTimeoutMs: 200, // short timeout for test
        log: () => {},
      });

      const result = await state.disable("1");
      assert.equal(result.status, "disabled");
      assert.equal(result.drain, "timeout");
    });

    it("should persist config after disable", async () => {
      const pool = [
        { name: "1", bin: "claude-1" },
        { name: "2", bin: "claude-2" },
      ];
      const state = createWorkerState({
        workerPool: pool,
        configPath,
        getActiveConns: () => 0,
        log: () => {},
      });

      await state.disable("1", "maintenance");

      const raw = await readFile(configPath, "utf-8");
      const saved = JSON.parse(raw);
      const w1 = saved.workers.find(w => w.name === "1");
      assert.equal(w1.disabled, true);
      assert.equal(w1.disabledReason, "maintenance");
    });
  });

  describe("enable", () => {
    it("should enable a disabled worker", async () => {
      const pool = [{ name: "1", bin: "claude-1", disabled: true, disabledReason: "test" }];
      const state = createWorkerState({
        workerPool: pool,
        configPath,
        log: () => {},
      });

      const result = await state.enable("1");
      assert.equal(result.status, "enabled");
      assert.equal(pool[0].disabled, false);
      assert.equal(pool[0].disabledReason, null);
    });

    it("should return already_enabled for non-disabled worker", async () => {
      const pool = [{ name: "1", bin: "claude-1" }];
      const state = createWorkerState({
        workerPool: pool,
        configPath,
        log: () => {},
      });

      const result = await state.enable("1");
      assert.equal(result.status, "already_enabled");
    });

    it("should return error for non-existent worker", async () => {
      const pool = [{ name: "1", bin: "claude-1" }];
      const state = createWorkerState({
        workerPool: pool,
        configPath,
        log: () => {},
      });

      const result = await state.enable("nonexistent");
      assert.equal(result.error, "worker_not_found");
    });

    it("should persist config after enable", async () => {
      const pool = [{ name: "1", bin: "claude-1", disabled: true }];
      const state = createWorkerState({
        workerPool: pool,
        configPath,
        log: () => {},
      });

      await state.enable("1");

      const raw = await readFile(configPath, "utf-8");
      const saved = JSON.parse(raw);
      assert.equal(saved.workers[0].disabled, false);
    });
  });

  describe("getAll", () => {
    it("should return state for all workers", () => {
      const pool = [
        { name: "1", bin: "claude-1" },
        { name: "2", bin: "claude-2", disabled: true, disabledReason: "maintenance" },
      ];
      const state = createWorkerState({
        workerPool: pool,
        configPath,
        getActiveConns: (name) => name === "1" ? 3 : 0,
        log: () => {},
      });

      const all = state.getAll();
      assert.equal(all.length, 2);
      assert.equal(all[0].name, "1");
      assert.equal(all[0].disabled, false);
      assert.equal(all[0].activeConns, 3);
      assert.equal(all[1].name, "2");
      assert.equal(all[1].disabled, true);
      assert.equal(all[1].disabledReason, "maintenance");
    });
  });
});
