/**
 * Token Health Manager — unified state machine for worker/token health.
 *
 * Each token has an independent health state:
 *   healthy ──[auth/server error]──> degraded
 *   degraded ──[success/heal OK]──> healthy
 *   degraded ──[3 consecutive failures]──> unhealthy
 *   unhealthy ──[success/heal OK]──> healthy
 *   unhealthy ──[maxHealAttempts heal failures]──> dead
 *   dead ──[deadBackoffMs elapsed + probe success]──> healthy
 *
 * Routing weights:
 *   healthy: 1.0 | degraded: 0.3 | unhealthy: 0 | dead: 0
 *
 * Adaptive probe intervals:
 *   healthy: healthyProbeMs | degraded/unhealthy: degradedProbeMs | dead: deadBackoffMs
 *
 * 429 (rate_limited) does NOT enter the state machine — existing cooldown handles it.
 */

const STATES = Object.freeze({
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  UNHEALTHY: "unhealthy",
  DEAD: "dead",
});

const ROUTING_WEIGHT = Object.freeze({
  [STATES.HEALTHY]: 1.0,
  [STATES.DEGRADED]: 0.3,
  [STATES.UNHEALTHY]: 0,
  [STATES.DEAD]: 0,
});

const CONSECUTIVE_FAIL_THRESHOLD = 3;

/**
 * @param {Object} opts
 * @param {Array<{name: string}>} opts.tokenPool - Token pool entries
 * @param {number} [opts.maxHealAttempts=5] - Heal failures before dead
 * @param {number} [opts.deadBackoffMs=1_800_000] - 30 min dead backoff
 * @param {number} [opts.degradedProbeMs=60_000] - 1 min degraded/unhealthy probe
 * @param {number} [opts.healthyProbeMs=300_000] - 5 min healthy probe
 * @param {Object} [opts.eventLog] - Event log instance for push()
 * @param {Function} [opts.log] - Logging function
 * @returns {Readonly<TokenHealthManager>}
 */
export function createTokenHealthManager(opts = {}) {
  const {
    tokenPool = [],
    maxHealAttempts = 5,
    deadBackoffMs = 1_800_000,
    degradedProbeMs = 60_000,
    healthyProbeMs = 300_000,
    eventLog = null,
    log = console.log,
  } = opts;

  // Per-token health state (internal mutable state; API returns frozen snapshots)
  const _states = new Map();

  for (const entry of tokenPool) {
    _states.set(entry.name, {
      healthState: STATES.HEALTHY,
      consecutiveErrors: 0,
      healAttempts: 0,
      lastErrorAt: 0,
      lastSuccessAt: Date.now(),
      deadSince: 0,
    });
  }

  function _getOrInit(tokenName) {
    if (!_states.has(tokenName)) {
      _states.set(tokenName, {
        healthState: STATES.HEALTHY,
        consecutiveErrors: 0,
        healAttempts: 0,
        lastErrorAt: 0,
        lastSuccessAt: Date.now(),
        deadSince: 0,
      });
    }
    return _states.get(tokenName);
  }

  function _transition(tokenName, fromState, toState) {
    log(`[TokenHealth] ${tokenName}: ${fromState} -> ${toState}`);
    if (eventLog) {
      eventLog.push("token_health", { token: tokenName, from: fromState, to: toState });
    }
  }

  /**
   * Report an error for a token. Moves through state machine:
   * - 429 (rate_limited) is ignored — handled by cooldown/reroute.
   * - auth_error / server_error: healthy→degraded, degraded→unhealthy (after threshold).
   */
  function reportError(tokenName, statusCode, errorType) {
    if (statusCode === 429) return;

    const s = _getOrInit(tokenName);
    const prev = s.healthState;
    s.consecutiveErrors += 1;
    s.lastErrorAt = Date.now();

    if (prev === STATES.HEALTHY) {
      s.healthState = STATES.DEGRADED;
      _transition(tokenName, prev, STATES.DEGRADED);
    } else if (prev === STATES.DEGRADED && s.consecutiveErrors >= CONSECUTIVE_FAIL_THRESHOLD) {
      s.healthState = STATES.UNHEALTHY;
      _transition(tokenName, prev, STATES.UNHEALTHY);
    }
  }

  /**
   * Report a successful request for a token. Resets to healthy.
   */
  function reportSuccess(tokenName) {
    const s = _getOrInit(tokenName);
    const prev = s.healthState;

    s.consecutiveErrors = 0;
    s.healAttempts = 0;
    s.lastSuccessAt = Date.now();
    s.deadSince = 0;

    if (prev !== STATES.HEALTHY) {
      s.healthState = STATES.HEALTHY;
      _transition(tokenName, prev, STATES.HEALTHY);
    }
  }

  /**
   * Report result of a health probe (heal attempt).
   * @param {string} tokenName
   * @param {boolean} success
   */
  function reportHealResult(tokenName, success) {
    const s = _getOrInit(tokenName);
    const prev = s.healthState;

    if (success) {
      s.consecutiveErrors = 0;
      s.healAttempts = 0;
      s.deadSince = 0;
      if (prev !== STATES.HEALTHY) {
        s.healthState = STATES.HEALTHY;
        _transition(tokenName, prev, STATES.HEALTHY);
      }
      s.lastSuccessAt = Date.now();
      return;
    }

    // Heal failed
    s.healAttempts += 1;
    s.lastErrorAt = Date.now();

    if (prev === STATES.UNHEALTHY && s.healAttempts >= maxHealAttempts) {
      s.healthState = STATES.DEAD;
      s.deadSince = Date.now();
      _transition(tokenName, prev, STATES.DEAD);
    }
  }

  /**
   * Whether this token should be included in routing.
   * Dead tokens become routable again after deadBackoffMs (for re-probe).
   */
  function shouldRoute(tokenName) {
    const s = _getOrInit(tokenName);
    if (s.healthState === STATES.HEALTHY || s.healthState === STATES.DEGRADED) {
      return true;
    }
    if (s.healthState === STATES.DEAD) {
      return Date.now() - s.deadSince >= deadBackoffMs;
    }
    return false;
  }

  /**
   * Get routing weight for weighted selection among routable tokens.
   */
  function getRoutingWeight(tokenName) {
    const s = _getOrInit(tokenName);
    if (s.healthState === STATES.DEAD && Date.now() - s.deadSince >= deadBackoffMs) {
      return 0.1;
    }
    return ROUTING_WEIGHT[s.healthState] ?? 0;
  }

  /**
   * Get adaptive probe interval for this token.
   */
  function getProbeInterval(tokenName) {
    const s = _getOrInit(tokenName);
    switch (s.healthState) {
      case STATES.HEALTHY:
        return healthyProbeMs;
      case STATES.DEGRADED:
      case STATES.UNHEALTHY:
        return degradedProbeMs;
      case STATES.DEAD:
        return deadBackoffMs;
      default:
        return healthyProbeMs;
    }
  }

  /**
   * Get health state for a specific token.
   */
  function getHealthState(tokenName) {
    const s = _getOrInit(tokenName);
    return s.healthState;
  }

  /**
   * Snapshot of all token health states (frozen).
   */
  function getSnapshot() {
    const snap = {};
    for (const [name, s] of _states) {
      snap[name] = Object.freeze({ ...s });
    }
    return Object.freeze(snap);
  }

  return Object.freeze({
    reportError,
    reportSuccess,
    reportHealResult,
    shouldRoute,
    getRoutingWeight,
    getProbeInterval,
    getHealthState,
    getSnapshot,
    STATES,
  });
}
