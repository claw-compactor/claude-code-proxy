/**
 * Warm Worker Pool — pre-spawns CLI processes to eliminate cold-start latency.
 *
 * How it works:
 * 1. CLI processes are pre-spawned with -p flag (read from stdin) + model args
 * 2. They initialize (Node.js startup, auth check, config load) then block on stdin
 * 3. When a request arrives, a warm process is grabbed and stdin is written immediately
 * 4. Process handles the request, exits, and a replacement is pre-spawned async
 *
 * The -p flag is the key: CLI starts, initializes, then waits for stdin EOF.
 * Pre-spawning moves the 2-5s cold start to happen BEFORE the request arrives.
 */

import { spawn } from "node:child_process";

/**
 * @param {object} config
 * @param {number} [config.maxWarmPerKey=2]     Max warm procs per (model, stream, worker) combo
 * @param {number} [config.maxWarmAgeMs=300000] Kill warm procs older than this (5 min)
 * @param {number} [config.sweepIntervalMs=30000] Stale check interval (30s)
 * @param {boolean} [config.enabled=true]
 * @param {function} config.buildArgs           (model, isStream) => string[]
 * @param {function} config.buildEnv            (worker) => object
 * @param {function} [config.log]               (msg) => void
 */
export function createWarmPool(config = {}) {
  const {
    maxWarmPerKey = 2,
    maxWarmAgeMs = 300_000,
    sweepIntervalMs = 30_000,
    enabled = true,
    buildArgs,
    buildEnv,
    log = console.log,
  } = config;

  // Pool: key → [WarmEntry]
  const pools = new Map();

  const stats = {
    hits: 0,
    misses: 0,
    spawns: 0,
    staleKills: 0,
    errors: 0,
  };

  function poolKey(model, isStream, workerName) {
    return `${model}:${isStream ? "stream" : "sync"}:${workerName}`;
  }

  function getPool(key) {
    if (!pools.has(key)) pools.set(key, []);
    return pools.get(key);
  }

  function isAlive(proc) {
    return !proc.killed && proc.exitCode === null && proc.signalCode === null;
  }

  /**
   * Pre-spawn a warm process. It will initialize and block waiting for stdin.
   * Returns the spawned process, or null on failure.
   */
  function warmUp(model, isStream, worker) {
    if (!enabled) return null;

    const key = poolKey(model, isStream, worker.name);
    const pool = getPool(key);

    // Don't exceed max per key
    const alive = pool.filter((e) => isAlive(e.proc));
    if (alive.length >= maxWarmPerKey) return null;

    try {
      const args = buildArgs(model, isStream);
      const env = buildEnv(worker);
      const proc = spawn(worker.bin, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (!proc.pid) {
        stats.errors++;
        return null;
      }

      const entry = { proc, createdAt: Date.now(), model, isStream, worker, key };

      // Clean up pool entry if process dies while warm
      const cleanup = () => {
        const idx = pool.indexOf(entry);
        if (idx !== -1) pool.splice(idx, 1);
      };
      proc.on("close", cleanup);
      proc.on("error", () => {
        cleanup();
        stats.errors++;
      });

      // Discard any stdout/stderr while warm (shouldn't produce any, but be safe)
      proc.stdout.resume();
      proc.stderr.resume();

      pool.push(entry);
      stats.spawns++;
      log(`[WarmPool] SPAWN key=${key} pid=${proc.pid} poolSize=${pool.length}`);

      return proc;
    } catch (err) {
      stats.errors++;
      log(`[WarmPool] SPAWN_ERROR key=${key} err=${err.message}`);
      return null;
    }
  }

  /**
   * Acquire a warm process for the given config.
   * Returns { proc, warm: true } if a warm process is available.
   * Returns null if none available (caller should spawn fresh).
   *
   * IMPORTANT: caller must re-attach stdout/stderr listeners and write stdin.
   * The returned proc has stdout/stderr in flowing mode (resume'd) — caller
   * should call proc.stdout.removeAllListeners() + re-pipe as needed.
   */
  function acquire(model, isStream, worker) {
    if (!enabled) {
      stats.misses++;
      return null;
    }

    const key = poolKey(model, isStream, worker.name);
    const pool = getPool(key);

    while (pool.length > 0) {
      const entry = pool.shift();
      const { proc } = entry;

      // Skip dead processes
      if (!isAlive(proc)) continue;

      // Skip stale processes
      const age = Date.now() - entry.createdAt;
      if (age > maxWarmAgeMs) {
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
        stats.staleKills++;
        log(`[WarmPool] STALE key=${key} pid=${proc.pid} age=${Math.round(age / 1000)}s`);
        continue;
      }

      // Good warm process — hand it off
      stats.hits++;
      log(`[WarmPool] HIT key=${key} pid=${proc.pid} age=${Math.round(age / 1000)}s`);

      // Remove the warm-state stdout/stderr drain listeners
      // Caller will re-attach their own listeners
      proc.stdout.removeAllListeners("data");
      proc.stdout.pause();
      proc.stderr.removeAllListeners("data");
      proc.stderr.pause();
      // Remove our close/error cleanup listeners (caller manages lifecycle now)
      proc.removeAllListeners("close");
      proc.removeAllListeners("error");

      // Schedule replacement async
      setImmediate(() => warmUp(model, isStream, worker));

      return { proc, warm: true };
    }

    // No warm process available
    stats.misses++;
    log(`[WarmPool] MISS key=${key}`);

    // Pre-spawn for next time
    setImmediate(() => warmUp(model, isStream, worker));

    return null;
  }

  /**
   * Sweep: kill warm processes that are too old or dead.
   */
  function sweep() {
    const now = Date.now();
    for (const [key, pool] of pools) {
      for (let i = pool.length - 1; i >= 0; i--) {
        const entry = pool[i];

        if (!isAlive(entry.proc)) {
          pool.splice(i, 1);
          continue;
        }

        const age = now - entry.createdAt;
        if (age > maxWarmAgeMs) {
          pool.splice(i, 1);
          try { entry.proc.kill("SIGTERM"); } catch { /* ignore */ }
          stats.staleKills++;
          log(`[WarmPool] SWEEP_STALE key=${key} pid=${entry.proc.pid} age=${Math.round(age / 1000)}s`);
        }
      }
      // Remove empty pool entries
      if (pool.length === 0) pools.delete(key);
    }
  }

  // Periodic sweep
  const sweepTimer = setInterval(sweep, sweepIntervalMs);
  if (sweepTimer.unref) sweepTimer.unref();

  /**
   * Pre-warm specific configurations. Call on startup if you know
   * which (model, worker) combos will be used.
   */
  function prewarm(configs) {
    if (!enabled) return;
    for (const { model, isStream, worker, count } of configs) {
      const n = count || 1;
      for (let i = 0; i < n; i++) {
        warmUp(model, isStream, worker);
      }
    }
  }

  /**
   * Shutdown: kill all warm processes and stop sweep timer.
   */
  function shutdown() {
    clearInterval(sweepTimer);
    for (const [, pool] of pools) {
      for (const entry of pool) {
        try { entry.proc.kill("SIGTERM"); } catch { /* ignore */ }
      }
      pool.length = 0;
    }
    pools.clear();
    log("[WarmPool] SHUTDOWN — all warm processes killed");
  }

  /**
   * Status snapshot for dashboard / diagnostics.
   */
  function status() {
    const poolStatus = {};
    for (const [key, pool] of pools) {
      const alive = pool.filter((e) => isAlive(e.proc));
      poolStatus[key] = {
        warm: alive.length,
        oldest: alive.length > 0 ? Math.round((Date.now() - alive[0].createdAt) / 1000) : 0,
      };
    }
    return {
      enabled,
      maxWarmPerKey,
      maxWarmAgeMs,
      stats: { ...stats },
      hitRate: stats.hits + stats.misses > 0
        ? Math.round((stats.hits / (stats.hits + stats.misses)) * 100)
        : 0,
      pools: poolStatus,
    };
  }

  return Object.freeze({
    acquire,
    warmUp,
    prewarm,
    sweep,
    shutdown,
    status,
    get stats() { return { ...stats }; },
  });
}
