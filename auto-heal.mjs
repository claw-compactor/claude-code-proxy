/**
 * auto-heal.mjs — Request-level auto healing for CLI worker auth failures
 *
 * Responsibilities:
 *   - Detect auth vs rate-limit vs timeout errors (classification helpers)
 *   - Trigger token refresh (coalesced per worker)
 *   - Enforce cooldown + circuit breaker
 *   - Track stats for /metrics + logs
 */

function ts() {
  return new Date().toISOString();
}

const AUTH_PATTERNS = [
  "unauthorized",
  "authentication",
  "auth error",
  "auth expired",
  "token expired",
  "invalid token",
  "invalid api key",
  "invalid auth",
  "oauth",
  "login",
  "401",
  "not authenticated",
  "sign in",
];

export function classifyCliError({ exitCode, stderr, stdout, err } = {}) {
  const errMsg = err?.message || "";
  const stderrText = stderr || "";
  const stdoutText = stdout || "";
  const combined = `${errMsg}\n${stderrText}\n${stdoutText}`.toLowerCase();

  const isTimeout = !!err?.isTimeout || /timeout/i.test(errMsg);
  if (isTimeout) {
    return { kind: "timeout", reason: "timeout", healable: false };
  }

  const isRateLimit =
    !!err?.isRateLimit ||
    /rate limit/i.test(combined) ||
    /too many requests/i.test(combined) ||
    /\b429\b/.test(combined) ||
    /overloaded/i.test(combined);
  if (isRateLimit) {
    return { kind: "rate_limit", reason: "rate_limit", healable: false };
  }

  const isAuth = AUTH_PATTERNS.some((p) => combined.includes(p));
  if (isAuth) {
    const reason = combined.includes("401") ? "auth_401" : "auth_expired";
    return { kind: "auth", reason, healable: true };
  }

  if (exitCode === 1) {
    return { kind: "cli_exit", reason: "cli_exit", healable: false };
  }

  return { kind: "other", reason: "other", healable: false };
}

export function createAutoHealManager({
  enabled = true,
  cooldownMs = 15_000,
  circuitFailThreshold = 3,
  circuitOpenMs = 60_000,
  tokenRefresher,
  tokenPool,
  log = console,
  eventLog = null,
  workerHealth = null, // optional: delegate circuit breaker to unified workerHealth
} = {}) {
  const stats = {
    triggered: 0,
    success: 0,
    fail: 0,
    lastHealAt: null,
    lastHealReason: null,
    workers: {},
  };

  const stateByWorker = new Map();

  function getState(workerName) {
    if (!stateByWorker.has(workerName)) {
      stateByWorker.set(workerName, {
        cooldownUntil: 0,
        healInFlight: null,
        failCount: 0,
        windowStart: 0,
        circuitOpenUntil: 0,
        lastHealAt: null,
        lastHealReason: null,
        triggered: 0,
        success: 0,
        fail: 0,
      });
    }
    return stateByWorker.get(workerName);
  }

  function workerStats(workerName) {
    const state = getState(workerName);
    if (!stats.workers[workerName]) {
      stats.workers[workerName] = {
        triggered: 0,
        success: 0,
        fail: 0,
        lastHealAt: null,
        lastHealReason: null,
        cooldownUntil: 0,
        circuitOpenUntil: 0,
        circuitState: "closed",
      };
    }
    stats.workers[workerName].cooldownUntil = state.cooldownUntil;
    stats.workers[workerName].circuitOpenUntil = state.circuitOpenUntil;
    stats.workers[workerName].circuitState = circuitState(workerName);
    return stats.workers[workerName];
  }

  function circuitState(workerName) {
    const state = getState(workerName);
    return Date.now() < state.circuitOpenUntil ? "open" : "closed";
  }

  async function heal(workerName, reason, reqId = "") {
    if (!enabled) return { attempted: false, skipped: "disabled" };

    const state = getState(workerName);
    const now = Date.now();
    const workerStat = workerStats(workerName);

    if (now < state.circuitOpenUntil) {
      return { attempted: false, skipped: "circuit_open" };
    }

    if (now < state.cooldownUntil) {
      return { attempted: false, skipped: "cooldown" };
    }

    if (state.healInFlight) return state.healInFlight;

    stats.triggered++;
    stats.lastHealAt = now;
    stats.lastHealReason = reason;
    workerStat.triggered++;
    workerStat.lastHealAt = now;
    workerStat.lastHealReason = reason;
    state.lastHealAt = now;
    state.lastHealReason = reason;

    state.cooldownUntil = now + cooldownMs;
    workerStat.cooldownUntil = state.cooldownUntil;

    log.log(`[${ts()}] AUTO_HEAL_START worker=${workerName} reason=${reason} reqId=${reqId}`);
    if (eventLog) eventLog.push("auto_heal_start", { worker: workerName, reason, reqId });

    const promise = (async () => {
      try {
        const entry = tokenPool?.find((t) => t.name === workerName) || null;
        if (!entry || !tokenRefresher) {
          throw new Error("no_token_entry");
        }
        const result = await tokenRefresher.handleAuthError(entry);
        if (result?.refreshed) {
          stats.success++;
          workerStat.success++;
          state.success++;
          state.failCount = 0;
          log.log(`[${ts()}] AUTO_HEAL_OK worker=${workerName} reason=${reason} reqId=${reqId}`);
          if (eventLog) eventLog.push("auto_heal_ok", { worker: workerName, reason, reqId });
          return { attempted: true, success: true, reason, newToken: result.newToken };
        }

        throw new Error("refresh_failed");
      } catch (err) {
        stats.fail++;
        workerStat.fail++;
        state.fail++;
        const nowFail = Date.now();
        if (!state.windowStart || nowFail - state.windowStart > circuitOpenMs) {
          state.windowStart = nowFail;
          state.failCount = 0;
        }
        state.failCount += 1;
        if (state.failCount >= circuitFailThreshold) {
          state.circuitOpenUntil = nowFail + circuitOpenMs;
          workerStat.circuitOpenUntil = state.circuitOpenUntil;
        }
        // Record failure to unified circuit breaker if available
        workerHealth?.recordFailure(workerName, `auto_heal_fail:${reason}`);
        log.log(`[${ts()}] AUTO_HEAL_FAIL worker=${workerName} reason=${reason} reqId=${reqId} err=${err.message}`);
        if (eventLog) eventLog.push("auto_heal_fail", { worker: workerName, reason, reqId, error: err.message });
        return { attempted: true, success: false, reason, error: err.message };
      } finally {
        state.healInFlight = null;
      }
    })();

    state.healInFlight = promise;
    return promise;
  }

  function getStats() {
    return {
      triggered: stats.triggered,
      success: stats.success,
      fail: stats.fail,
      lastHealAt: stats.lastHealAt,
      lastHealReason: stats.lastHealReason,
      workers: stats.workers,
    };
  }

  function getWorkerState(workerName) {
    const state = getState(workerName);
    return {
      cooldownUntil: state.cooldownUntil,
      cooldownRemainingMs: Math.max(0, state.cooldownUntil - Date.now()),
      circuitOpenUntil: state.circuitOpenUntil,
      circuitState: circuitState(workerName),
      inFlight: !!state.healInFlight,
    };
  }

  return Object.freeze({
    heal,
    getStats,
    getWorkerState,
    circuitState,
  });
}
