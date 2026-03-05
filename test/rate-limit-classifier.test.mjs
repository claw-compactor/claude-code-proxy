/**
 * Tests for lib/rate-limit-classifier.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRateLimit,
  computeResetTimestamp,
  computeRoutingStatus,
} from "../lib/rate-limit-classifier.mjs";

describe("classifyRateLimit", () => {
  it("should return unknown for null input", () => {
    const result = classifyRateLimit(null);
    assert.equal(result.tier, "unknown");
    assert.equal(result.effectiveUtil, -1);
    assert.equal(result.bottleneck, "none");
  });

  it("should return unknown for undefined input", () => {
    const result = classifyRateLimit(undefined);
    assert.equal(result.tier, "unknown");
  });

  it("should classify available (<75%)", () => {
    const result = classifyRateLimit({ h5Utilization: 0.3, d7Utilization: 0.2 });
    assert.equal(result.tier, "available");
    assert.equal(result.effectiveUtil, 0.3);
    assert.equal(result.bottleneck, "five_hour");
  });

  it("should classify strained (75-99%)", () => {
    const result = classifyRateLimit({ h5Utilization: 0.85, d7Utilization: 0.5 });
    assert.equal(result.tier, "strained");
    assert.equal(result.effectiveUtil, 0.85);
  });

  it("should classify saturated (>=99%)", () => {
    const result = classifyRateLimit({ h5Utilization: 0.2, d7Utilization: 1.0 });
    assert.equal(result.tier, "saturated");
    assert.equal(result.effectiveUtil, 1.0);
    assert.equal(result.bottleneck, "seven_day");
  });

  it("should classify rejected status as saturated", () => {
    const result = classifyRateLimit({ h5Utilization: 0.5, d7Utilization: 0.5, status: "rejected" });
    assert.equal(result.tier, "saturated");
    assert.equal(result.effectiveUtil, 0.5);
  });

  it("should use representative as bottleneck when provided", () => {
    const result = classifyRateLimit({
      h5Utilization: 0.3, d7Utilization: 0.9,
      representative: "five_hour",
    });
    assert.equal(result.bottleneck, "five_hour");
  });

  it("should use seven_day as bottleneck when d7 >= h5", () => {
    const result = classifyRateLimit({ h5Utilization: 0.5, d7Utilization: 0.5 });
    assert.equal(result.bottleneck, "seven_day");
  });

  it("should handle 0% utilization as available", () => {
    const result = classifyRateLimit({ h5Utilization: 0, d7Utilization: 0 });
    assert.equal(result.tier, "available");
    assert.equal(result.effectiveUtil, 0);
  });

  it("should handle exactly 75% as strained", () => {
    const result = classifyRateLimit({ h5Utilization: 0.75, d7Utilization: 0 });
    assert.equal(result.tier, "strained");
  });

  it("should handle exactly 99% as saturated", () => {
    const result = classifyRateLimit({ h5Utilization: 0.99, d7Utilization: 0 });
    assert.equal(result.tier, "saturated");
  });
});

describe("computeResetTimestamp", () => {
  it("should return null for null probe", () => {
    assert.equal(computeResetTimestamp(null), null);
  });

  it("should return null for non-429 probe", () => {
    assert.equal(computeResetTimestamp({ status: "ok", lastProbeAt: 1000, retryMs: 5000 }), null);
  });

  it("should compute timestamp for 429 probe with retryMs", () => {
    const result = computeResetTimestamp({
      status: "rate_limited",
      lastProbeAt: 1000,
      retryMs: 5000,
    });
    assert.equal(result, 6000);
  });

  it("should return null if lastProbeAt is missing", () => {
    assert.equal(computeResetTimestamp({ status: "rate_limited", retryMs: 5000 }), null);
  });

  it("should return null if retryMs is missing", () => {
    assert.equal(computeResetTimestamp({ status: "rate_limited", lastProbeAt: 1000 }), null);
  });
});

describe("computeRoutingStatus", () => {
  it("should return preferred for available tier", () => {
    assert.equal(computeRoutingStatus("available", false, 3), "preferred");
  });

  it("should return preferred for unknown tier", () => {
    assert.equal(computeRoutingStatus("unknown", false, 2), "preferred");
  });

  it("should return active for strained tier without cooldown", () => {
    assert.equal(computeRoutingStatus("strained", false, 2), "active");
  });

  it("should return avoided for saturated tier with alternatives", () => {
    assert.equal(computeRoutingStatus("saturated", false, 2), "avoided");
  });

  it("should return blocked for cooldown with alternatives", () => {
    assert.equal(computeRoutingStatus("saturated", true, 2), "blocked");
  });

  it("should return active for saturated tier without alternatives", () => {
    assert.equal(computeRoutingStatus("saturated", false, 0), "active");
  });

  it("should return preferred for available tier in cooldown without alternatives", () => {
    assert.equal(computeRoutingStatus("available", true, 0), "preferred");
  });

  it("should return blocked for strained tier in cooldown with alternatives", () => {
    assert.equal(computeRoutingStatus("strained", true, 1), "blocked");
  });
});
