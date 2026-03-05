/**
 * WorkerHealthController — worker state machine with rate-limit cooldown + circuit breaker.
 *
 * Tracks:
 *  - limited: rate limit cooldown
 *  - circuit_open: repeated failures -> temporary disable
 *  - auto recovery when cooldown expires
 */

function ts() {
  return new Date().toISOString();
}

function parseResetTimeFromText(text) {
  if (!text) return null;
  const m = text.match(/reset[s]?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3].toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

export function createWorkerHealthController({
  workers = [],
  primaryWorker,
  healthCheckMs = 600000,
  loadBalanceEnabled = false,
  circuitFailThreshold = 3,
  circuitOpenMs = 60000,
  circuitWindowMs = 60000,
  logger = console,
  eventLog = null,
} = {}) {
  const state = new Map();
  let loadBalanceMode = !!loadBalanceEnabled;

  function init() {
    for (const w of workers) {
      state.set(w.name, {
        limited: false,
        limitedAt: 0,
        limitedUntil: 0,
        failCount: 0,
        windowStart: 0,
        circuitOpenUntil: 0,
      });
    }
  }

  function getState(name) {
    if (!state.has(name)) {
      state.set(name, {
        limited: false,
        limitedAt: 0,
        limitedUntil: 0,
        failCount: 0,
        windowStart: 0,
        circuitOpenUntil: 0,
      });
    }
    return state.get(name);
  }

  function isCircuitOpen(name) {
    const s = getState(name);
    return s.circuitOpenUntil && Date.now() < s.circuitOpenUntil;
  }

  function markLimited(workerName, errText = "") {
    const s = getState(workerName);
    if (s.limited) return;
    s.limited = true;
    s.limitedAt = Date.now();
    const resetAt = parseResetTimeFromText(errText);
    s.limitedUntil = resetAt || (Date.now() + healthCheckMs);
    loadBalanceMode = false; // degrade to single-worker mode
    const untilStr = s.limitedUntil
      ? new Date(s.limitedUntil).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      : "unknown";
    logger.log(`[${ts()}] WORKER_LIMITED worker=${workerName} until=${untilStr}`);
    eventLog?.push?.("worker_limited", { worker: workerName, limitedUntil: s.limitedUntil || null });
  }

  function markRecovered(workerName, reason = "cooldown_expired") {
    const s = getState(workerName);
    if (!s.limited && !isCircuitOpen(workerName)) return;
    s.limited = false;
    s.limitedAt = 0;
    s.limitedUntil = 0;
    if (!isCircuitOpen(workerName)) {
      loadBalanceMode = !!loadBalanceEnabled;
    }
    logger.log(`[${ts()}] WORKER_RECOVERED worker=${workerName} reason=${reason}`);
    eventLog?.push?.("worker_recovered", { worker: workerName, reason, loadBalance: loadBalanceMode });
  }

  function recordFailure(workerName, reason = "error") {
    const now = Date.now();
    const s = getState(workerName);
    if (!s.windowStart || now - s.windowStart > circuitWindowMs) {
      s.windowStart = now;
      s.failCount = 0;
    }
    s.failCount += 1;
    if (s.failCount >= circuitFailThreshold) {
      s.circuitOpenUntil = now + circuitOpenMs;
      loadBalanceMode = false;
      logger.log(`[${ts()}] WORKER_CIRCUIT_OPEN worker=${workerName} reason=${reason} openMs=${circuitOpenMs}`);
      eventLog?.push?.("worker_circuit_open", { worker: workerName, reason, openMs: circuitOpenMs });
    }
  }

  function isHealthy(name) {
    const s = getState(name);
    if (isCircuitOpen(name)) return false;
    if (!s.limited) return true;
    if (s.limitedUntil && Date.now() >= s.limitedUntil) {
      markRecovered(name, "cooldown_expired");
      return true;
    }
    return false;
  }

  function tick() {
    for (const w of workers) {
      const s = getState(w.name);
      if (s.limited && s.limitedUntil && Date.now() >= s.limitedUntil) {
        markRecovered(w.name, "cooldown_expired");
      }
      if (s.circuitOpenUntil && Date.now() >= s.circuitOpenUntil) {
        s.circuitOpenUntil = 0;
        s.failCount = 0;
        markRecovered(w.name, "circuit_closed");
      }
    }
  }

  function getAllLimitedStatus() {
    const limited = workers.filter((w) => !isHealthy(w.name));
    if (limited.length !== workers.length || limited.length === 0) return null;
    let nextReset = null;
    for (const w of limited) {
      const s = getState(w.name);
      const until = s.limitedUntil || (s.limitedAt ? s.limitedAt + healthCheckMs : null);
      if (until && (!nextReset || until < nextReset)) nextReset = until;
    }
    return { nextReset };
  }

  function getLoadBalanceMode() {
    return loadBalanceMode;
  }

  function setLoadBalanceMode(mode) {
    loadBalanceMode = !!mode;
  }

  function getWorkerSnapshot() {
    return workers.map((w) => {
      const s = getState(w.name);
      const limitedUntil = s.limitedUntil || null;
      return {
        name: w.name,
        limited: !!s.limited,
        limitedAt: s.limitedAt || null,
        limitedUntil,
        limitedRemainingSec: s.limited && limitedUntil
          ? Math.max(0, Math.round((limitedUntil - Date.now()) / 1000))
          : null,
        circuitOpenUntil: s.circuitOpenUntil || null,
        circuitState: isCircuitOpen(w.name) ? "open" : "closed",
      };
    });
  }

  init();

  return Object.freeze({
    getState,
    isHealthy,
    markLimited,
    markRecovered,
    recordFailure,
    tick,
    getAllLimitedStatus,
    getLoadBalanceMode,
    setLoadBalanceMode,
    getWorkerSnapshot,
  });
}
