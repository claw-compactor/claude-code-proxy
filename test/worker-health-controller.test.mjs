/**
 * WorkerHealthController tests — state machine + circuit breaker
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWorkerHealthController } from "../controllers/worker-health-controller.mjs";

const workers = [{ name: "1" }, { name: "2" }];

describe("worker health controller", () => {
  it("should mark limited and recover after cooldown", async () => {
    const hc = createWorkerHealthController({
      workers,
      healthCheckMs: 50,
    });

    hc.markLimited("1", "rate limit");
    assert.equal(hc.isHealthy("1"), false);

    // wait for cooldown
    await new Promise((r) => setTimeout(r, 60));
    hc.tick();

    assert.equal(hc.isHealthy("1"), true);
  });

  it("should open circuit after repeated failures", () => {
    const hc = createWorkerHealthController({
      workers,
      circuitFailThreshold: 2,
      circuitOpenMs: 60_000,
      circuitWindowMs: 60_000,
    });

    hc.recordFailure("2", "cli_crash");
    hc.recordFailure("2", "cli_crash");

    assert.equal(hc.isHealthy("2"), false);
    const state = hc.getState("2");
    assert.ok(state.circuitOpenUntil > Date.now());
  });

  it("should report all-limited status when all unhealthy", () => {
    const hc = createWorkerHealthController({
      workers,
      healthCheckMs: 1000,
    });

    hc.markLimited("1", "rate limit");
    hc.markLimited("2", "rate limit");

    const status = hc.getAllLimitedStatus();
    assert.ok(status);
    assert.ok(status.nextReset);
  });
});
