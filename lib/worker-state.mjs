/**
 * Worker state management — runtime disable/enable with graceful drain.
 * Provides REST API endpoints and persistence to proxy.config.json.
 */

import { writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Create a worker state manager.
 *
 * @param {object} opts
 * @param {Array} opts.workerPool - Mutable array of worker configs
 * @param {string} opts.configPath - Path to proxy.config.json
 * @param {function} opts.getActiveConns - (name) => number of active connections
 * @param {number} opts.drainTimeoutMs - Max time to wait for drain (default 60000)
 * @param {object} opts.eventLog - Event log instance (optional)
 * @param {function} opts.log - Logger
 */
export function createWorkerState({
  workerPool,
  configPath,
  getActiveConns = () => 0,
  drainTimeoutMs = 60_000,
  eventLog = null,
  log = console.log,
}) {
  const _draining = new Map(); // name -> { timer, resolve }

  /**
   * Atomically write config to disk (tmp file → rename).
   */
  async function persistConfig() {
    try {
      const raw = await readFile(configPath, "utf-8");
      const config = JSON.parse(raw);
      config.workers = workerPool.map(w => ({
        ...w,
      }));
      const tmpPath = join(dirname(configPath), `.proxy.config.${randomUUID().slice(0, 8)}.tmp`);
      await writeFile(tmpPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
      const { rename } = await import("node:fs/promises");
      await rename(tmpPath, configPath);
    } catch (err) {
      log(`[WorkerState] PERSIST_ERROR: ${err.message}`);
    }
  }

  /**
   * Disable a worker with graceful drain.
   * Returns a promise that resolves when the worker is fully disabled.
   */
  async function disable(name, reason = "manual") {
    const worker = workerPool.find(w => w.name === name);
    if (!worker) return { error: "worker_not_found" };
    if (worker.disabled) return { status: "already_disabled" };

    // Mark as draining first
    worker.draining = true;
    worker.drainingAt = Date.now();
    log(`[WorkerState] DRAIN_START worker=${name} reason=${reason}`);
    eventLog?.push("worker_drain", { worker: name, reason });

    // Wait for active connections to drain (or timeout)
    const drainResult = await new Promise((resolve) => {
      const checkDrain = () => {
        const conns = getActiveConns(name);
        if (conns === 0) {
          clearInterval(pollTimer);
          clearTimeout(hardTimer);
          resolve("drained");
        }
      };

      const pollTimer = setInterval(checkDrain, 500);
      const hardTimer = setTimeout(() => {
        clearInterval(pollTimer);
        resolve("timeout");
      }, drainTimeoutMs);

      // Check immediately
      checkDrain();
    });

    // Mark fully disabled
    worker.disabled = true;
    worker.disabledReason = reason;
    worker.disabledAt = Date.now();
    worker.draining = false;
    worker.drainingAt = null;

    log(`[WorkerState] DISABLED worker=${name} reason=${reason} drain=${drainResult}`);
    eventLog?.push("worker_disabled", { worker: name, reason, drain: drainResult });

    await persistConfig();
    return { status: "disabled", drain: drainResult };
  }

  /**
   * Enable a previously disabled worker.
   */
  async function enable(name) {
    const worker = workerPool.find(w => w.name === name);
    if (!worker) return { error: "worker_not_found" };
    if (!worker.disabled && !worker.draining) return { status: "already_enabled" };

    // Cancel any pending drain
    if (_draining.has(name)) {
      const d = _draining.get(name);
      clearTimeout(d.timer);
      _draining.delete(name);
    }

    worker.disabled = false;
    worker.disabledReason = null;
    worker.disabledAt = null;
    worker.draining = false;
    worker.drainingAt = null;

    log(`[WorkerState] ENABLED worker=${name}`);
    eventLog?.push("worker_enabled", { worker: name });

    await persistConfig();
    return { status: "enabled" };
  }

  /**
   * Get state of all workers.
   */
  function getAll() {
    return workerPool.map(w => ({
      name: w.name,
      disabled: !!w.disabled,
      disabledReason: w.disabledReason || null,
      disabledAt: w.disabledAt || null,
      draining: !!w.draining,
      drainingAt: w.drainingAt || null,
      activeConns: getActiveConns(w.name),
    }));
  }

  return Object.freeze({
    disable,
    enable,
    getAll,
    persistConfig,
  });
}
