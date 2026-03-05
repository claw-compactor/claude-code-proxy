/**
 * Tests for lib/worker-router.mjs
 *
 * Covers: getNextWorker, leastLoadedWorker, disabled/draining filtering,
 *         session affinity tiebreak, getAlternateWorker
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWorkerRouter } from "../lib/worker-router.mjs";

function makePool(names) {
  return names.map(n => ({ name: n, bin: `claude-${n}` }));
}

function makeMockHealth(overrides = {}) {
  return {
    isHealthy: (name) => overrides[name] !== false,
    getState: (name) => ({
      limited: false,
      limitedAt: 0,
      circuitOpenUntil: 0,
      ...overrides[name],
    }),
    getLoadBalanceMode: () => overrides.loadBalance ?? true,
  };
}

function makeMockAffinity(mapping = {}) {
  return {
    lookup: (key, isHealthy) => {
      const worker = mapping[key];
      if (worker && isHealthy(worker)) return { hit: true, workerName: worker };
      return { hit: false };
    },
    getStats: () => ({}),
  };
}

describe("worker-router", () => {
  describe("getNextWorker", () => {
    it("should return the only worker in a single-worker pool", () => {
      const pool = makePool(["1"]);
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => makeMockHealth(),
        getSessionAffinity: () => null,
        workerStats: { traffic: {} },
      });
      const w = router.getNextWorker();
      assert.equal(w.name, "1");
    });

    it("should prefer primary when load balance is off", () => {
      const pool = makePool(["1", "2"]);
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => makeMockHealth({ loadBalance: false }),
        getSessionAffinity: () => null,
        workerStats: { traffic: {} },
      });
      const w = router.getNextWorker();
      assert.equal(w.name, "1");
    });

    it("should load-balance by least connections", () => {
      const pool = makePool(["1", "2"]);
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => makeMockHealth(),
        getSessionAffinity: () => null,
        workerStats: { traffic: { "1": { requests: 10, errors: 0 }, "2": { requests: 0, errors: 0 } } },
      });
      // Worker 2 has fewer connections and requests
      router.workerAcquire("1");
      router.workerAcquire("1");
      const w = router.getNextWorker();
      assert.equal(w.name, "2");
    });

    it("should skip disabled workers", () => {
      const pool = [
        { name: "1", bin: "claude-1", disabled: true },
        { name: "2", bin: "claude-2" },
      ];
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => makeMockHealth(),
        getSessionAffinity: () => null,
        workerStats: { traffic: {} },
      });
      const w = router.getNextWorker();
      assert.equal(w.name, "2");
    });

    it("should skip draining workers", () => {
      const pool = [
        { name: "1", bin: "claude-1", draining: true },
        { name: "2", bin: "claude-2" },
      ];
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => makeMockHealth(),
        getSessionAffinity: () => null,
        workerStats: { traffic: {} },
      });
      const w = router.getNextWorker();
      assert.equal(w.name, "2");
    });

    it("should fall back to least-recently-limited when all unhealthy", () => {
      const pool = makePool(["1", "2"]);
      const health = {
        isHealthy: () => false, // all unhealthy
        getState: (name) => ({
          limited: true,
          limitedAt: name === "1" ? 2000 : 1000,
          circuitOpenUntil: 0,
        }),
        getLoadBalanceMode: () => true,
      };
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => health,
        getSessionAffinity: () => null,
        workerStats: { traffic: {} },
      });
      const w = router.getNextWorker();
      // Should pick the one limited earliest (2, limitedAt=1000)
      assert.equal(w.name, "2");
    });

    it("should respect session affinity when worker has fewer connections", () => {
      const pool = makePool(["1", "2"]);
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => makeMockHealth(),
        getSessionAffinity: () => makeMockAffinity({ "session-abc": "2" }),
        workerStats: { traffic: {} },
      });
      // Give worker 1 more connections
      router.workerAcquire("1");
      router.workerAcquire("1");
      const w = router.getNextWorker("session-abc");
      assert.equal(w.name, "2");
    });

    it("should prefer available workers over strained when rate limits provided", () => {
      const pool = makePool(["1", "2", "3"]);
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => makeMockHealth(),
        getSessionAffinity: () => null,
        workerStats: { traffic: {} },
        getUnifiedRateLimits: () => ({
          "1": { h5Utilization: 0.90, d7Utilization: 0.5 },  // strained
          "2": { h5Utilization: 0.30, d7Utilization: 0.2 },  // available
          "3": { h5Utilization: 0.20, d7Utilization: 0.1 },  // available
        }),
      });
      const w = router.getNextWorker();
      assert.ok(w.name === "2" || w.name === "3", `expected available worker, got ${w.name}`);
    });

    it("should avoid saturated workers when alternatives exist", () => {
      const pool = makePool(["1", "2"]);
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => makeMockHealth(),
        getSessionAffinity: () => null,
        workerStats: { traffic: {} },
        getUnifiedRateLimits: () => ({
          "1": { h5Utilization: 0.2, d7Utilization: 1.0 },   // saturated
          "2": { h5Utilization: 0.5, d7Utilization: 0.3 },   // available
        }),
      });
      const w = router.getNextWorker();
      assert.equal(w.name, "2");
    });

    it("should fall back to saturated when all workers are saturated", () => {
      const pool = makePool(["1", "2"]);
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => makeMockHealth(),
        getSessionAffinity: () => null,
        workerStats: { traffic: {} },
        getUnifiedRateLimits: () => ({
          "1": { h5Utilization: 1.0, d7Utilization: 1.0 },
          "2": { h5Utilization: 0.99, d7Utilization: 1.0 },
        }),
      });
      const w = router.getNextWorker();
      // Should still pick one — no crash
      assert.ok(w.name === "1" || w.name === "2");
    });

    it("should not apply rate-limit filter when getUnifiedRateLimits is null", () => {
      const pool = makePool(["1", "2"]);
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => makeMockHealth(),
        getSessionAffinity: () => null,
        workerStats: { traffic: {} },
        // No getUnifiedRateLimits
      });
      const w = router.getNextWorker();
      assert.ok(w.name === "1" || w.name === "2");
    });

    it("should restrict session affinity to filtered pool", () => {
      const pool = makePool(["1", "2", "3"]);
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => makeMockHealth(),
        getSessionAffinity: () => makeMockAffinity({ "sess-1": "1" }),
        workerStats: { traffic: {} },
        getUnifiedRateLimits: () => ({
          "1": { h5Utilization: 0.2, d7Utilization: 1.0, status: "rejected" }, // saturated
          "2": { h5Utilization: 0.3, d7Utilization: 0.2 },  // available
          "3": { h5Utilization: 0.2, d7Utilization: 0.1 },  // available
        }),
      });
      const w = router.getNextWorker("sess-1");
      // Session affinity points to worker 1, but it's saturated and filtered out
      assert.ok(w.name === "2" || w.name === "3", `expected non-saturated worker, got ${w.name}`);
    });
  });

  describe("workerAcquire/workerRelease", () => {
    it("should track active connections", () => {
      const pool = makePool(["1"]);
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => makeMockHealth(),
        getSessionAffinity: () => null,
        workerStats: { traffic: {} },
      });
      router.workerAcquire("1");
      router.workerAcquire("1");
      const conns = router.getActiveConnections();
      assert.equal(conns.get("1"), 2);

      router.workerRelease("1");
      assert.equal(conns.get("1"), 1);
    });

    it("should not go below 0", () => {
      const pool = makePool(["1"]);
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => makeMockHealth(),
        getSessionAffinity: () => null,
        workerStats: { traffic: {} },
      });
      router.workerRelease("1");
      router.workerRelease("1");
      assert.equal(router.getActiveConnections().get("1"), 0);
    });
  });

  describe("getAlternateWorker", () => {
    it("should return a healthy worker excluding the given name", () => {
      const pool = makePool(["1", "2", "3"]);
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => makeMockHealth(),
        getSessionAffinity: () => null,
        workerStats: { traffic: {} },
      });
      const alt = router.getAlternateWorker("1");
      assert.ok(alt);
      assert.notEqual(alt.name, "1");
    });

    it("should skip disabled workers", () => {
      const pool = [
        { name: "1", bin: "claude-1" },
        { name: "2", bin: "claude-2", disabled: true },
        { name: "3", bin: "claude-3" },
      ];
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => makeMockHealth(),
        getSessionAffinity: () => null,
        workerStats: { traffic: {} },
      });
      const alt = router.getAlternateWorker("1");
      assert.equal(alt.name, "3");
    });

    it("should return null when no alternatives available", () => {
      const pool = makePool(["1"]);
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => makeMockHealth(),
        getSessionAffinity: () => null,
        workerStats: { traffic: {} },
      });
      assert.equal(router.getAlternateWorker("1"), null);
    });
  });

  describe("enabledWorkers", () => {
    it("should filter disabled workers", () => {
      const pool = [
        { name: "1", bin: "c1" },
        { name: "2", bin: "c2", disabled: true },
        { name: "3", bin: "c3" },
      ];
      const router = createWorkerRouter({
        workerPool: pool,
        primaryWorker: "1",
        getWorkerHealth: () => makeMockHealth(),
        getSessionAffinity: () => null,
        workerStats: { traffic: {} },
      });
      const enabled = router.enabledWorkers();
      assert.equal(enabled.length, 2);
      assert.ok(enabled.every(w => w.name !== "2"));
    });
  });
});
