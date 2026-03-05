/**
 * Rate-limit classifier — pure functions shared by token-pool and worker-router.
 * Classifies rate-limit data into tiers for intelligent routing decisions.
 */

/**
 * Classify a rate-limit entry into tier + effective utilization.
 *
 * @param {object|null} rateLimit - { h5Utilization, d7Utilization, status, representative }
 * @returns {{ effectiveUtil: number, tier: string, bottleneck: string }}
 */
export function classifyRateLimit(rateLimit) {
  if (!rateLimit) {
    return { effectiveUtil: -1, tier: "unknown", bottleneck: "none" };
  }

  const h5 = rateLimit.h5Utilization ?? 0;
  const d7 = rateLimit.d7Utilization ?? 0;
  const effectiveUtil = Math.max(h5, d7);

  const bottleneck = rateLimit.representative
    ? rateLimit.representative
    : d7 >= h5 ? "seven_day" : "five_hour";

  if (rateLimit.status === "rejected") {
    return { effectiveUtil, tier: "saturated", bottleneck };
  }
  if (effectiveUtil >= 0.99) {
    return { effectiveUtil, tier: "saturated", bottleneck };
  }
  if (effectiveUtil >= 0.75) {
    return { effectiveUtil, tier: "strained", bottleneck };
  }
  return { effectiveUtil, tier: "available", bottleneck };
}

/**
 * Compute the reset timestamp from probe results (429 only).
 *
 * @param {object|null} probeResult - { status, lastProbeAt, retryMs }
 * @returns {number|null} unix ms when the rate limit resets, or null
 */
export function computeResetTimestamp(probeResult) {
  if (!probeResult) return null;
  if (probeResult.status !== "rate_limited") return null;
  if (!probeResult.lastProbeAt || !probeResult.retryMs) return null;
  return probeResult.lastProbeAt + probeResult.retryMs;
}

/**
 * Derive routing status from tier + cooldown state + alternatives.
 *
 * @param {string} tier - "available" | "strained" | "saturated" | "unknown"
 * @param {boolean} hasCooldown - whether the token/worker is in cooldown
 * @param {number} alternativeCount - number of non-saturated alternatives
 * @returns {string} "preferred" | "active" | "avoided" | "blocked"
 */
export function computeRoutingStatus(tier, hasCooldown, alternativeCount) {
  if (hasCooldown && alternativeCount > 0) return "blocked";
  if (tier === "saturated" && alternativeCount > 0) return "avoided";
  if (tier === "available" || tier === "unknown") return "preferred";
  return "active";
}
