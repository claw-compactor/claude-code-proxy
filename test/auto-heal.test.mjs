/**
 * Tests for auto-heal.mjs
 *
 * Verifies:
 *  - Auth error triggers refresh and succeeds
 *  - Consecutive failures open circuit breaker
 *  - 429 classification does NOT trigger healable flag
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAutoHealManager, classifyCliError } from "../auto-heal.mjs";

const tokenPool = [{ name: "1", token: "tok", type: "oauth_flat" }];

describe("auto-heal", () => {
  it("should refresh on auth error and mark success", async () => {
    const tokenRefresher = {
      handleAuthError: async () => ({ refreshed: true, newToken: "new" }),
    };
    const autoHeal = createAutoHealManager({
      tokenRefresher,
      tokenPool,
      cooldownMs: 1,
      circuitFailThreshold: 3,
      circuitOpenMs: 10000,
    });

    const result = await autoHeal.heal("1", "auth_401", "req-1");
    const stats = autoHeal.getStats();

    assert.equal(result.success, true);
    assert.equal(stats.triggered, 1);
    assert.equal(stats.success, 1);
    assert.equal(stats.fail, 0);
    assert.equal(stats.lastHealReason, "auth_401");
  });

  it("should open circuit after consecutive failures", async () => {
    const tokenRefresher = {
      handleAuthError: async () => ({ refreshed: false }),
    };
    const autoHeal = createAutoHealManager({
      tokenRefresher,
      tokenPool,
      cooldownMs: 0,
      circuitFailThreshold: 2,
      circuitOpenMs: 60_000,
    });

    await autoHeal.heal("1", "auth_expired", "req-a");
    await autoHeal.heal("1", "auth_expired", "req-b");

    const state = autoHeal.getWorkerState("1");
    assert.equal(state.circuitState, "open");
    assert.ok(state.circuitOpenUntil > Date.now());
  });

  it("should classify 429 as non-healable", () => {
    const classification = classifyCliError({
      exitCode: 1,
      stderr: "HTTP 429 Too Many Requests",
      stdout: "",
    });
    assert.equal(classification.kind, "rate_limit");
    assert.equal(classification.healable, false);
  });

  it("should classify 401 as healable auth error", () => {
    const classification = classifyCliError({
      exitCode: 1,
      stderr: "HTTP 401 Unauthorized",
      stdout: "",
    });
    assert.equal(classification.kind, "auth");
    assert.equal(classification.healable, true);
  });
});
