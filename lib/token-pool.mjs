/**
 * Token pool management for Anthropic Direct API.
 * Handles token selection (tiered rate-limit-aware + round-robin),
 * cooldowns (429 backoff), and unified rate limit header capture.
 */

import { classifyRateLimit, computeResetTimestamp, computeRoutingStatus } from "./rate-limit-classifier.mjs";

/**
 * Build the token pool from config workers + environment variables.
 * Returns a frozen array of token entries.
 */
export function buildTokenPool(workers) {
  const tokens = [];
  for (const w of workers) {
    if (w.disabled) continue;
    if (w.token) tokens.push({ name: w.name, token: w.token, type: "oauth_flat" });
  }
  if (tokens.length === 0) {
    const oat = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oat) tokens.push({ name: "default", token: oat, type: "oauth_flat" });
  }
  if (tokens.length === 0) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (key) tokens.push({ name: "apikey", token: key, type: "api_key_billed" });
  }
  return tokens;
}

/**
 * Create a token pool manager.
 *
 * @param {Array} tokenPool - Array of { name, token, type } entries
 */
export function createTokenPoolManager(tokenPool, { healthManager } = {}) {
  let _tokenRrIndex = 0;
  const _tokenCooldowns = new Map(); // name -> unix ms
  const _unifiedRateLimits = new Map(); // tokenName -> rate limit data
  const _authErrors = new Map(); // name -> { since: ms, count: number } — tracks 401/403 from probes

  /**
   * Pick the best token: tiered rate-limit-aware selection.
   *
   * 1. No data → round-robin (backward compatible)
   * 2. With data → prefer "available" (<75%), then "strained", then "saturated"
   * 3. Cooldown tokens are skipped unless no alternative
   */
  function getNextToken() {
    if (tokenPool.length <= 1) return tokenPool[0];

    const now = Date.now();
    const rrBase = _tokenRrIndex++;

    const candidates = tokenPool.map((entry, idx) => {
      const cooldownUntil = _tokenCooldowns.get(entry.name) || 0;
      const inCooldown = cooldownUntil > now;
      const hasAuthError = _authErrors.has(entry.name);
      const rl = _unifiedRateLimits.get(entry.name);
      const { effectiveUtil, tier } = classifyRateLimit(rl);
      return { entry, idx, inCooldown, hasAuthError, effectiveUtil, tier };
    });

    // Prefer tokens without auth errors, not in cooldown, and routable by health manager
    const healthy = candidates.filter(c =>
      !c.inCooldown && !c.hasAuthError && (!healthManager || healthManager.shouldRoute(c.entry.name))
    );
    const notCooled = healthy.length > 0 ? healthy : candidates.filter(c => !c.inCooldown);
    const pool = notCooled.length > 0 ? notCooled : candidates;

    const hasData = pool.some(c => c.effectiveUtil >= 0);
    if (!hasData) {
      return tokenPool[rrBase % tokenPool.length];
    }

    // Tiered selection: available > strained > saturated > unknown
    const tierOrder = ["available", "unknown", "strained", "saturated"];
    for (const t of tierOrder) {
      const bucket = pool.filter(c => c.tier === t);
      if (bucket.length === 0) continue;

      if (t === "available" || t === "unknown") {
        // Sort by health weight descending, then round-robin within top tier
        if (healthManager && bucket.length > 1) {
          bucket.sort((a, b) => healthManager.getRoutingWeight(b.entry.name) - healthManager.getRoutingWeight(a.entry.name));
          const topWeight = healthManager.getRoutingWeight(bucket[0].entry.name);
          const topTier = bucket.filter(c => healthManager.getRoutingWeight(c.entry.name) === topWeight);
          return topTier[rrBase % topTier.length].entry;
        }
        return bucket[rrBase % bucket.length].entry;
      }
      // For strained/saturated: pick lowest effectiveUtil
      bucket.sort((a, b) => a.effectiveUtil - b.effectiveUtil);
      return bucket[0].entry;
    }

    // Fallback (should not reach): round-robin
    return tokenPool[rrBase % tokenPool.length];
  }

  /**
   * Mark a token as having an auth error (401/403 from probe or request).
   * Tokens with auth errors are deprioritized in getNextToken.
   */
  function markTokenAuthError(tokenName) {
    const existing = _authErrors.get(tokenName);
    const count = (existing?.count || 0) + 1;
    _authErrors.set(tokenName, { since: existing?.since || Date.now(), count });
    console.log(`[${new Date().toISOString()}] TOKEN_AUTH_ERROR token=${tokenName} count=${count}`);
  }

  /**
   * Clear auth error state (e.g., after successful token refresh).
   */
  function clearTokenAuthError(tokenName) {
    if (_authErrors.has(tokenName)) {
      _authErrors.delete(tokenName);
      console.log(`[${new Date().toISOString()}] TOKEN_AUTH_ERROR_CLEARED token=${tokenName}`);
    }
  }

  function setTokenCooldown(tokenEntry, ms, reason) {
    const until = Date.now() + ms;
    _tokenCooldowns.set(tokenEntry.name, until);
    console.log(`[${new Date().toISOString()}] TOKEN_COOLDOWN_SET token=${tokenEntry.name} ms=${ms} reason=${reason || ""}`);
  }

  function getTokenCooldownMs(tokenEntry) {
    const until = _tokenCooldowns.get(tokenEntry.name) || 0;
    return Math.max(0, until - Date.now());
  }

  async function waitForTokenCooldown(tokenEntry) {
    let waitMs = getTokenCooldownMs(tokenEntry);
    while (waitMs > 0) {
      const sleepMs = Math.min(waitMs, 5000);
      console.log(`[${new Date().toISOString()}] TOKEN_COOLDOWN token=${tokenEntry.name} waiting ${sleepMs}ms`);
      await new Promise((r) => setTimeout(r, sleepMs));
      waitMs = getTokenCooldownMs(tokenEntry);
    }
  }

  function captureUnifiedRateHeaders(apiRes, tokenEntry) {
    const h = apiRes.headers;
    const data = {
      status: h["anthropic-ratelimit-unified-status"] || null,
      h5Status: h["anthropic-ratelimit-unified-5h-status"] || null,
      h5Utilization: parseFloat(h["anthropic-ratelimit-unified-5h-utilization"]) || 0,
      d7Status: h["anthropic-ratelimit-unified-7d-status"] || null,
      d7Utilization: parseFloat(h["anthropic-ratelimit-unified-7d-utilization"]) || 0,
      fallbackPct: parseFloat(h["anthropic-ratelimit-unified-fallback-percentage"]) || 1,
      overageStatus: h["anthropic-ratelimit-unified-overage-status"] || null,
      orgId: h["anthropic-organization-id"] || null,
      representative: h["anthropic-ratelimit-unified-representative-claim"] || null,
      updatedAt: Date.now(),
    };
    _unifiedRateLimits.set(tokenEntry.name, data);
  }

  function getUnifiedRateLimits() {
    const result = {};
    for (const [name, data] of _unifiedRateLimits) {
      result[name] = { ...data };
    }
    return result;
  }

  /**
   * Build a routing snapshot for each token — used by metrics/dashboard.
   *
   * @param {function|null} getProbeResults - () => { tokenName: probeResult }
   * @returns {object} { tokenName: { effectiveUtil, tier, bottleneck, inCooldown, routingStatus, resetAt, resetInSec, probeStatus } }
   */
  function getTokenRoutingSnapshot(getProbeResults) {
    const now = Date.now();
    const probeResults = getProbeResults?.() || {};
    const nonSaturatedCount = tokenPool.filter(e => {
      const rl = _unifiedRateLimits.get(e.name);
      const { tier } = classifyRateLimit(rl);
      return tier !== "saturated";
    }).length;

    const snapshot = {};
    for (const entry of tokenPool) {
      const rl = _unifiedRateLimits.get(entry.name);
      const { effectiveUtil, tier, bottleneck } = classifyRateLimit(rl);
      const cooldownUntil = _tokenCooldowns.get(entry.name) || 0;
      const inCooldown = cooldownUntil > now;
      const altCount = tier === "saturated" ? nonSaturatedCount : tokenPool.length - 1;
      const routingStatus = computeRoutingStatus(tier, inCooldown, altCount);
      const probe = probeResults[entry.name] || null;
      const resetAt = computeResetTimestamp(probe);
      const resetInSec = resetAt ? Math.max(0, Math.round((resetAt - now) / 1000)) : null;
      snapshot[entry.name] = {
        h5Utilization: rl?.h5Utilization ?? null,
        d7Utilization: rl?.d7Utilization ?? null,
        effectiveUtil,
        tier,
        bottleneck,
        inCooldown,
        routingStatus,
        resetAt,
        resetInSec,
        probeStatus: probe?.status || null,
      };
    }
    return snapshot;
  }

  return Object.freeze({
    getNextToken,
    setTokenCooldown,
    getTokenCooldownMs,
    waitForTokenCooldown,
    captureUnifiedRateHeaders,
    getUnifiedRateLimits,
    getTokenRoutingSnapshot,
    markTokenAuthError,
    clearTokenAuthError,
  });
}
