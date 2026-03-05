/**
 * Tests for lib/token-pool.mjs
 *
 * Covers: buildTokenPool, createTokenPoolManager (getNextToken, cooldowns, rate headers)
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildTokenPool, createTokenPoolManager } from "../lib/token-pool.mjs";

describe("buildTokenPool", () => {
  it("should build tokens from workers", () => {
    const workers = [
      { name: "1", token: "tok1" },
      { name: "2", token: "tok2" },
    ];
    const pool = buildTokenPool(workers);
    assert.equal(pool.length, 2);
    assert.equal(pool[0].name, "1");
    assert.equal(pool[0].type, "oauth_flat");
  });

  it("should skip disabled workers", () => {
    const workers = [
      { name: "1", token: "tok1" },
      { name: "2", token: "tok2", disabled: true },
    ];
    const pool = buildTokenPool(workers);
    assert.equal(pool.length, 1);
    assert.equal(pool[0].name, "1");
  });

  it("should skip workers without tokens", () => {
    const workers = [{ name: "1" }, { name: "2", token: "tok2" }];
    const pool = buildTokenPool(workers);
    assert.equal(pool.length, 1);
    assert.equal(pool[0].name, "2");
  });
});

describe("createTokenPoolManager", () => {
  describe("getNextToken", () => {
    it("should return the only token when pool has one entry", () => {
      const pool = [{ name: "1", token: "tok1", type: "oauth_flat" }];
      const manager = createTokenPoolManager(pool);
      assert.equal(manager.getNextToken(), pool[0]);
    });

    it("should round-robin when no utilization data", () => {
      const pool = [
        { name: "1", token: "tok1", type: "oauth_flat" },
        { name: "2", token: "tok2", type: "oauth_flat" },
      ];
      const manager = createTokenPoolManager(pool);
      const first = manager.getNextToken();
      const second = manager.getNextToken();
      // Should cycle through the pool
      assert.ok(first.name !== second.name || pool.length === 1);
    });

    it("should prefer lower utilization tokens", () => {
      const pool = [
        { name: "high", token: "tok1", type: "oauth_flat" },
        { name: "low", token: "tok2", type: "oauth_flat" },
      ];
      const manager = createTokenPoolManager(pool);

      // Simulate rate limit headers to inject utilization data
      manager.captureUnifiedRateHeaders(
        { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.8" } },
        pool[0]
      );
      manager.captureUnifiedRateHeaders(
        { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.2" } },
        pool[1]
      );

      const picked = manager.getNextToken();
      assert.equal(picked.name, "low");
    });

    it("should skip tokens in cooldown when alternatives available", () => {
      const pool = [
        { name: "cooled", token: "tok1", type: "oauth_flat" },
        { name: "ok", token: "tok2", type: "oauth_flat" },
      ];
      const manager = createTokenPoolManager(pool);
      manager.setTokenCooldown(pool[0], 60_000, "test");

      // Inject utilization so it doesn't fallback to round-robin
      manager.captureUnifiedRateHeaders(
        { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.1" } },
        pool[0]
      );
      manager.captureUnifiedRateHeaders(
        { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.5" } },
        pool[1]
      );

      const picked = manager.getNextToken();
      assert.equal(picked.name, "ok");
    });


    it("should prefer available tier over strained tier", () => {
      const pool = [
        { name: "strained", token: "tok1", type: "oauth_flat" },
        { name: "available", token: "tok2", type: "oauth_flat" },
      ];
      const manager = createTokenPoolManager(pool);

      // strained: 85% h5
      manager.captureUnifiedRateHeaders(
        { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.85", "anthropic-ratelimit-unified-7d-utilization": "0.1" } },
        pool[0]
      );
      // available: 30% h5
      manager.captureUnifiedRateHeaders(
        { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.30", "anthropic-ratelimit-unified-7d-utilization": "0.1" } },
        pool[1]
      );

      const picked = manager.getNextToken();
      assert.equal(picked.name, "available");
    });

    it("should avoid saturated tokens when alternatives exist", () => {
      const pool = [
        { name: "saturated", token: "tok1", type: "oauth_flat" },
        { name: "ok", token: "tok2", type: "oauth_flat" },
      ];
      const manager = createTokenPoolManager(pool);

      manager.captureUnifiedRateHeaders(
        { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.2", "anthropic-ratelimit-unified-7d-utilization": "1.0" } },
        pool[0]
      );
      manager.captureUnifiedRateHeaders(
        { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.5", "anthropic-ratelimit-unified-7d-utilization": "0.3" } },
        pool[1]
      );

      const picked = manager.getNextToken();
      assert.equal(picked.name, "ok");
    });

    it("should pick lowest effectiveUtil among strained tokens", () => {
      const pool = [
        { name: "high", token: "tok1", type: "oauth_flat" },
        { name: "low", token: "tok2", type: "oauth_flat" },
      ];
      const manager = createTokenPoolManager(pool);

      manager.captureUnifiedRateHeaders(
        { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.90", "anthropic-ratelimit-unified-7d-utilization": "0.85" } },
        pool[0]
      );
      manager.captureUnifiedRateHeaders(
        { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.78", "anthropic-ratelimit-unified-7d-utilization": "0.76" } },
        pool[1]
      );

      const picked = manager.getNextToken();
      assert.equal(picked.name, "low");
    });

    it("should round-robin among available tokens", () => {
      const pool = [
        { name: "a", token: "tok1", type: "oauth_flat" },
        { name: "b", token: "tok2", type: "oauth_flat" },
      ];
      const manager = createTokenPoolManager(pool);

      manager.captureUnifiedRateHeaders(
        { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.20", "anthropic-ratelimit-unified-7d-utilization": "0.10" } },
        pool[0]
      );
      manager.captureUnifiedRateHeaders(
        { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.30", "anthropic-ratelimit-unified-7d-utilization": "0.15" } },
        pool[1]
      );

      const picks = new Set();
      for (let i = 0; i < 4; i++) picks.add(manager.getNextToken().name);
      assert.equal(picks.size, 2, "should use both available tokens via round-robin");
    });
  });

  describe("cooldowns", () => {
    it("should set and get cooldown", () => {
      const pool = [{ name: "1", token: "tok1", type: "oauth_flat" }];
      const manager = createTokenPoolManager(pool);

      manager.setTokenCooldown(pool[0], 5000, "test");
      const remaining = manager.getTokenCooldownMs(pool[0]);
      assert.ok(remaining > 0);
      assert.ok(remaining <= 5000);
    });

    it("should return 0 when no cooldown", () => {
      const pool = [{ name: "1", token: "tok1", type: "oauth_flat" }];
      const manager = createTokenPoolManager(pool);
      assert.equal(manager.getTokenCooldownMs(pool[0]), 0);
    });
  });

  describe("getTokenRoutingSnapshot", () => {
    it("should return snapshot for each token", () => {
      const pool = [
        { name: "1", token: "tok1", type: "oauth_flat" },
        { name: "2", token: "tok2", type: "oauth_flat" },
      ];
      const manager = createTokenPoolManager(pool);

      manager.captureUnifiedRateHeaders(
        { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.50", "anthropic-ratelimit-unified-7d-utilization": "1.0" } },
        pool[0]
      );

      const snapshot = manager.getTokenRoutingSnapshot(null);
      assert.ok(snapshot["1"]);
      assert.ok(snapshot["2"]);
      assert.equal(snapshot["1"].tier, "saturated");
      assert.equal(snapshot["1"].effectiveUtil, 1.0);
      assert.equal(snapshot["2"].tier, "unknown");
    });
  });

  describe("rate headers", () => {
    it("should capture and expose unified rate limits", () => {
      const pool = [{ name: "1", token: "tok1", type: "oauth_flat" }];
      const manager = createTokenPoolManager(pool);

      manager.captureUnifiedRateHeaders(
        {
          headers: {
            "anthropic-ratelimit-unified-status": "active",
            "anthropic-ratelimit-unified-5h-status": "normal",
            "anthropic-ratelimit-unified-5h-utilization": "0.35",
            "anthropic-ratelimit-unified-7d-status": "normal",
            "anthropic-ratelimit-unified-7d-utilization": "0.20",
            "anthropic-organization-id": "org-123",
          },
        },
        pool[0]
      );

      const limits = manager.getUnifiedRateLimits();
      assert.equal(limits["1"].status, "active");
      assert.equal(limits["1"].h5Utilization, 0.35);
      assert.equal(limits["1"].d7Utilization, 0.20);
      assert.equal(limits["1"].orgId, "org-123");
    });
  });
});
