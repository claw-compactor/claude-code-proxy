/**
 * Tests for lib/token-health-manager.mjs
 *
 * Verifies: state transitions, routing weights, probe intervals, snapshots.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTokenHealthManager } from "../lib/token-health-manager.mjs";

const POOL = [{ name: "1" }, { name: "2" }];

function createManager(overrides = {}) {
  return createTokenHealthManager({
    tokenPool: POOL,
    maxHealAttempts: 3,
    deadBackoffMs: 100, // short for tests
    degradedProbeMs: 50,
    healthyProbeMs: 200,
    log: () => {}, // silence logs in tests
    ...overrides,
  });
}

describe("token-health-manager", () => {
  describe("initial state", () => {
    it("should start all tokens as healthy", () => {
      const m = createManager();
      const snap = m.getSnapshot();
      assert.equal(snap["1"].healthState, "healthy");
      assert.equal(snap["2"].healthState, "healthy");
    });

    it("should route all tokens initially", () => {
      const m = createManager();
      assert.equal(m.shouldRoute("1"), true);
      assert.equal(m.shouldRoute("2"), true);
    });

    it("should return full weight for healthy tokens", () => {
      const m = createManager();
      assert.equal(m.getRoutingWeight("1"), 1.0);
      assert.equal(m.getRoutingWeight("2"), 1.0);
    });
  });

  describe("state transitions", () => {
    it("healthy -> degraded on auth/server error", () => {
      const m = createManager();
      m.reportError("1", 500, "server_error");
      assert.equal(m.getHealthState("1"), "degraded");
      assert.equal(m.getHealthState("2"), "healthy"); // independent
    });

    it("degraded -> healthy on success", () => {
      const m = createManager();
      m.reportError("1", 500, "server_error");
      assert.equal(m.getHealthState("1"), "degraded");
      m.reportSuccess("1");
      assert.equal(m.getHealthState("1"), "healthy");
    });

    it("degraded -> unhealthy after 3 consecutive errors", () => {
      const m = createManager();
      m.reportError("1", 500, "server_error"); // healthy -> degraded (consec=1)
      m.reportError("1", 500, "server_error"); // degraded (consec=2)
      m.reportError("1", 500, "server_error"); // degraded -> unhealthy (consec=3)
      assert.equal(m.getHealthState("1"), "unhealthy");
    });

    it("unhealthy -> healthy on success", () => {
      const m = createManager();
      for (let i = 0; i < 3; i++) m.reportError("1", 500, "server_error");
      assert.equal(m.getHealthState("1"), "unhealthy");
      m.reportSuccess("1");
      assert.equal(m.getHealthState("1"), "healthy");
    });

    it("unhealthy -> dead after maxHealAttempts failed heals", () => {
      const m = createManager({ maxHealAttempts: 3 });
      for (let i = 0; i < 3; i++) m.reportError("1", 500, "server_error");
      assert.equal(m.getHealthState("1"), "unhealthy");
      m.reportHealResult("1", false);
      m.reportHealResult("1", false);
      m.reportHealResult("1", false);
      assert.equal(m.getHealthState("1"), "dead");
    });

    it("dead -> healthy on successful heal", () => {
      const m = createManager({ maxHealAttempts: 1 });
      for (let i = 0; i < 3; i++) m.reportError("1", 500, "server_error");
      m.reportHealResult("1", false);
      assert.equal(m.getHealthState("1"), "dead");
      m.reportHealResult("1", true);
      assert.equal(m.getHealthState("1"), "healthy");
    });

    it("429 does NOT enter state machine", () => {
      const m = createManager();
      m.reportError("1", 429, "rate_limited");
      assert.equal(m.getHealthState("1"), "healthy");
    });

    it("success resets consecutive errors", () => {
      const m = createManager();
      m.reportError("1", 500, "server_error"); // degraded, consec=1
      m.reportError("1", 500, "server_error"); // still degraded, consec=2
      m.reportSuccess("1"); // healthy, consec=0
      m.reportError("1", 500, "server_error"); // degraded, consec=1
      assert.equal(m.getHealthState("1"), "degraded");
    });
  });

  describe("routing", () => {
    it("healthy tokens should be routable with weight 1.0", () => {
      const m = createManager();
      assert.equal(m.shouldRoute("1"), true);
      assert.equal(m.getRoutingWeight("1"), 1.0);
    });

    it("degraded tokens should be routable with weight 0.3", () => {
      const m = createManager();
      m.reportError("1", 500, "server_error");
      assert.equal(m.shouldRoute("1"), true);
      assert.equal(m.getRoutingWeight("1"), 0.3);
    });

    it("unhealthy tokens should NOT be routable", () => {
      const m = createManager();
      for (let i = 0; i < 3; i++) m.reportError("1", 500, "server_error");
      assert.equal(m.shouldRoute("1"), false);
      assert.equal(m.getRoutingWeight("1"), 0);
    });

    it("dead tokens should NOT be routable before backoff", () => {
      const m = createManager({ maxHealAttempts: 1, deadBackoffMs: 1_000_000 });
      for (let i = 0; i < 3; i++) m.reportError("1", 500, "server_error");
      m.reportHealResult("1", false);
      assert.equal(m.getHealthState("1"), "dead");
      assert.equal(m.shouldRoute("1"), false);
    });

    it("dead tokens become routable after deadBackoffMs", async () => {
      const m = createManager({ maxHealAttempts: 1, deadBackoffMs: 50 });
      for (let i = 0; i < 3; i++) m.reportError("1", 500, "server_error");
      m.reportHealResult("1", false);
      assert.equal(m.shouldRoute("1"), false);
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(m.shouldRoute("1"), true);
      assert.ok(m.getRoutingWeight("1") > 0);
    });
  });

  describe("probe intervals", () => {
    it("healthy -> healthyProbeMs", () => {
      const m = createManager({ healthyProbeMs: 300_000 });
      assert.equal(m.getProbeInterval("1"), 300_000);
    });

    it("degraded -> degradedProbeMs", () => {
      const m = createManager({ degradedProbeMs: 60_000 });
      m.reportError("1", 500, "server_error");
      assert.equal(m.getProbeInterval("1"), 60_000);
    });

    it("unhealthy -> degradedProbeMs", () => {
      const m = createManager({ degradedProbeMs: 60_000 });
      for (let i = 0; i < 3; i++) m.reportError("1", 500, "server_error");
      assert.equal(m.getProbeInterval("1"), 60_000);
    });

    it("dead -> deadBackoffMs", () => {
      const m = createManager({ maxHealAttempts: 1, deadBackoffMs: 1_800_000 });
      for (let i = 0; i < 3; i++) m.reportError("1", 500, "server_error");
      m.reportHealResult("1", false);
      assert.equal(m.getProbeInterval("1"), 1_800_000);
    });
  });

  describe("snapshot", () => {
    it("should return frozen snapshot", () => {
      const m = createManager();
      const snap = m.getSnapshot();
      assert.ok(Object.isFrozen(snap));
      assert.ok(Object.isFrozen(snap["1"]));
    });

    it("should include all tracked fields", () => {
      const m = createManager();
      m.reportError("1", 500, "server_error");
      const snap = m.getSnapshot();
      const s = snap["1"];
      assert.equal(s.healthState, "degraded");
      assert.equal(s.consecutiveErrors, 1);
      assert.equal(s.healAttempts, 0);
      assert.ok(s.lastErrorAt > 0);
      assert.ok(s.lastSuccessAt > 0);
    });

    it("tokens are independent", () => {
      const m = createManager();
      m.reportError("1", 500, "server_error");
      const snap = m.getSnapshot();
      assert.equal(snap["1"].healthState, "degraded");
      assert.equal(snap["2"].healthState, "healthy");
    });
  });

  describe("unknown tokens", () => {
    it("should auto-initialize unknown token names", () => {
      const m = createManager();
      assert.equal(m.getHealthState("unknown"), "healthy");
      assert.equal(m.shouldRoute("unknown"), true);
    });
  });
});
