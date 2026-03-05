/**
 * Redis Client — Shared Connection for All Modules
 *
 * Single ioredis connection with key prefix "ccp:" (claude-code-proxy).
 * Graceful degradation: if Redis is unreachable, modules fall back to in-memory.
 *
 * Configurable via REDIS_URL environment variable.
 */

import Redis from "ioredis";

const DEFAULTS = Object.freeze({
  url: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  keyPrefix: "ccp:",
  maxReconnectAttempts: 20,
  connectTimeout: 5000,
});

/**
 * Create a shared Redis client.
 * @param {object} [options]
 * @param {string} [options.url] - Redis URL (default: redis://127.0.0.1:6379)
 * @param {string} [options.keyPrefix] - Key prefix (default: "ccp:")
 * @returns {Promise<{client, isReady, quit, ping, prefix}>}
 */
export async function createRedisClient(options = {}) {
  const config = Object.freeze({ ...DEFAULTS, ...options });

  const client = new Redis(config.url, {
    keyPrefix: config.keyPrefix,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > config.maxReconnectAttempts) {
        console.error(`[Redis] Max reconnect attempts (${config.maxReconnectAttempts}) exceeded`);
        return null; // stop retrying
      }
      return Math.min(times * 200, 5000);
    },
    connectTimeout: config.connectTimeout,
    enableOfflineQueue: true, // queue commands during reconnect
  });

  let ready = false;

  client.on("ready", () => {
    ready = true;
    console.log("[Redis] Connected");
  });

  client.on("error", (err) => {
    // Only log non-connection errors (connection errors are handled by retryStrategy)
    if (err.code !== "ECONNREFUSED" && err.code !== "ECONNRESET") {
      console.error(`[Redis] Error: ${err.message}`);
    }
  });

  client.on("close", () => {
    ready = false;
  });

  client.on("reconnecting", (ms) => {
    console.log(`[Redis] Reconnecting in ${ms}ms...`);
  });

  await client.connect();

  // ── Write reliability: retry queue with exponential backoff ──
  let _writeErrors = 0;
  let _consecutiveWriteErrors = 0;
  let _localOnlyMode = false;
  const MAX_CONSECUTIVE_WRITE_ERRORS = 3;

  /**
   * Safe write with retry (up to 3 attempts, exponential backoff).
   * After 3 consecutive failures, switches to local-only mode.
   */
  async function safeWrite(operation) {
    if (_localOnlyMode) return null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await operation(client);
        _consecutiveWriteErrors = 0;
        return result;
      } catch (err) {
        _writeErrors++;
        _consecutiveWriteErrors++;
        if (attempt < 2) {
          const delay = Math.pow(2, attempt) * 100; // 100ms, 200ms
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    // 3 consecutive failures → switch to local-only
    if (_consecutiveWriteErrors >= MAX_CONSECUTIVE_WRITE_ERRORS) {
      _localOnlyMode = true;
      console.error(`[Redis] ⚠️ ${MAX_CONSECUTIVE_WRITE_ERRORS} consecutive write failures — switching to LOCAL-ONLY mode`);
    }
    return null;
  }

  function getWriteStats() {
    return Object.freeze({
      writeErrors: _writeErrors,
      consecutiveWriteErrors: _consecutiveWriteErrors,
      localOnlyMode: _localOnlyMode,
    });
  }

  function resetLocalOnlyMode() {
    _localOnlyMode = false;
    _consecutiveWriteErrors = 0;
    console.log("[Redis] Local-only mode reset — retrying writes");
  }

  return Object.freeze({
    client,
    isReady: () => ready,
    quit: () => client.quit(),
    ping: () => client.ping(),
    prefix: config.keyPrefix,
    safeWrite,
    getWriteStats,
    resetLocalOnlyMode,
  });
}
