/**
 * Claude Code Proxy v0.5.0
 *
 * Central proxy for multiple OpenClaw instances.
 * Wraps claude CLI into OpenAI-compatible API with:
 *   - Fair queuing (round-robin between sources)
 *   - Rate limiting (95% of Max plan limits)
 *   - Priority by model (opus=high, sonnet=normal, haiku=low)
 *   - Authentication via Bearer token
 *   - Per-source metrics & monitoring
 *   - Process registry with zombie detection & reaper
 *   - Retry with exponential backoff + jitter
 *   - Stream heartbeat & execution timeout
 *   - Graceful shutdown
 *
 * All OpenClaw instances point their claude-code provider to this proxy.
 * Requests are queued fairly and processed through local claude CLI,
 * using the Max subscription (flat monthly fee, no per-token cost).
 */

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createFairQueue } from "./fair-queue.mjs";
import { createProcessRegistry } from "./process-registry.mjs";
import { createRetryPolicy } from "./retry.mjs";
import { createEventLog } from "./event-log.mjs";
import { createTokenTracker } from "./token-tracker.mjs";
import { createMetricsStore } from "./metrics-store.mjs";
import { createRateLimiter } from "./rate-limiter.mjs";
import { createRedisClient } from "./redis-client.mjs";
import { createSessionAffinity } from "./session-affinity.mjs";
import { createSystemReaper } from "./system-reaper.mjs";
import { createWarmPool } from "./worker-pool.mjs";
import { loadConfig } from "./config-loader.mjs";
import { createTokenRefresher } from "./token-refresh.mjs";
import {
  sseChunk, sseToolCallStartChunk, sseToolCallDeltaChunk, sseFinishChunk,
  completionResponse, completionResponseWithTools,
  convertToolsToAnthropic, convertMessagesToAnthropic,
} from "./response-formats.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Configuration — loaded from proxy.config.json (single source of truth)
// Env vars override config file values for debugging only.
// ============================================================

const CONFIG = loadConfig();

const PORT = CONFIG.server.port;
const AUTH_TOKEN = CONFIG.server.authToken;
const CLAUDE_BIN = CONFIG.workers[0]?.bin || "claude";

// ============================================================
// CLI Router Objects: smart routing with failover
// Routing strategy:
//   - Default: all traffic to PRIMARY_WORKER
//   - On rate limit: switch entirely to the other CLI router
//   - Every HEALTH_CHECK_MS: probe if cooled-down router is back
//   - When recovered: resume load-balancing (round-robin)
// ============================================================

const PRIMARY_WORKER = CONFIG.routing.primaryWorker;
const HEALTH_CHECK_MS = CONFIG.routing.healthCheckMs;
const USE_CLI_AGENTS = CONFIG.routing.useCliAgents;

const _workerPool = CONFIG.workers;

// Worker health state
const _workerHealth = new Map(); // name -> { limited: boolean, limitedAt: number, limitedUntil: number }
for (const w of _workerPool) {
  _workerHealth.set(w.name, { limited: false, limitedAt: 0, limitedUntil: 0 });
}

// Round-robin index for load-balancing mode
let _rrIndex = 0;

console.log(`[CLIRouter] Pool: ${_workerPool.map((w) => `${w.name}=${w.bin}`).join(" | ")}`);
console.log(`[CLIRouter] Primary: ${PRIMARY_WORKER} | Health check: ${HEALTH_CHECK_MS / 1000}s`);

// ============================================================
// Fallback API: last-resort model when all CLI routers fail
// Forwards as an OpenAI-compatible /v1/chat/completions request
// ============================================================

const FALLBACK_API = CONFIG.fallback;
const FALLBACK_TIMEOUT_MS = 15_000;
console.log(`[Fallback] ${FALLBACK_API.name} → ${FALLBACK_API.baseUrl} model=${FALLBACK_API.model}`);

// ============================================================
// Anthropic Direct API — for tool-enabled requests (bypass CLI)
// When request includes `tools`, call Anthropic API directly so the
// gateway receives tool_calls in OpenAI format and executes them.
// CLI path remains for text-only requests (flat fee via Max sub).
// ============================================================

const ANTHROPIC_API_BASE = CONFIG.anthropic.apiBase;
const ANTHROPIC_API_VERSION = CONFIG.anthropic.apiVersion;

const ANTHROPIC_MODEL_IDS = CONFIG.anthropic.models;

// Token pool for API direct — least-utilization routing with round-robin tiebreaker.
// Each token represents an independent OAuth credential with its own rate limits.
// OAuth requires `anthropic-beta: oauth-2025-04-20` header to work with the raw API.
const TOKEN_POOL = (() => {
  const tokens = [];
  // Worker tokens from config (each worker can have its own OAuth token)
  for (const w of _workerPool) {
    if (w.token) tokens.push({ name: w.name, token: w.token, type: "oauth_flat" });
  }
  // Fallback to process-level CLAUDE_CODE_OAUTH_TOKEN (env only — not in config file for security)
  if (tokens.length === 0) {
    const oat = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oat) tokens.push({ name: "default", token: oat, type: "oauth_flat" });
  }
  // Last resort: API key (per-token billing, env only)
  if (tokens.length === 0) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (key) tokens.push({ name: "apikey", token: key, type: "api_key_billed" });
  }
  return tokens;
})();
let _tokenRrIndex = 0;
/**
 * Pick the best token: least-utilization first, round-robin as tiebreaker.
 *
 * Priority order:
 *   1. Skip tokens in cooldown (429 backoff)
 *   2. Among available tokens, pick the one with lowest 5h utilization %
 *   3. Ties broken by round-robin index for fairness
 *   4. If no utilization data yet (cold start), fall back to pure round-robin
 */
function getNextToken() {
  if (TOKEN_POOL.length <= 1) return TOKEN_POOL[0];

  const now = Date.now();
  const rrBase = _tokenRrIndex++;

  // Build candidates with utilization scores
  const candidates = TOKEN_POOL.map((entry, idx) => {
    const cooldownUntil = _tokenCooldowns.get(entry.name) || 0;
    const inCooldown = cooldownUntil > now;
    const rl = _unifiedRateLimits.get(entry.name);
    // Use 5h utilization as primary score (0-1), fallback to 0 if unknown
    const utilization = rl ? rl.h5Utilization : -1; // -1 = no data yet
    return { entry, idx, inCooldown, utilization };
  });

  // Separate available from cooled-down
  const available = candidates.filter(c => !c.inCooldown);
  const pool = available.length > 0 ? available : candidates; // if all cooled, pick least cooldown

  // Check if we have ANY utilization data
  const hasData = pool.some(c => c.utilization >= 0);

  if (!hasData) {
    // Cold start: pure round-robin
    const idx = rrBase % TOKEN_POOL.length;
    return TOKEN_POOL[idx];
  }

  // Sort: lowest utilization first, round-robin index as tiebreaker
  pool.sort((a, b) => {
    // Tokens without data go last
    if (a.utilization < 0 && b.utilization >= 0) return 1;
    if (b.utilization < 0 && a.utilization >= 0) return -1;
    // Lower utilization = better
    const diff = a.utilization - b.utilization;
    if (Math.abs(diff) > 0.001) return diff;
    // Tiebreaker: distribute evenly via round-robin offset
    return ((a.idx - rrBase % pool.length) + pool.length) % pool.length
         - ((b.idx - rrBase % pool.length) + pool.length) % pool.length;
  });

  return pool[0].entry;
}

// Token cooldowns for Anthropic API direct (per OAuth token)
const _tokenCooldowns = new Map(); // name -> unix ms
function setTokenCooldown(tokenEntry, ms, reason) {
  const until = Date.now() + ms;
  _tokenCooldowns.set(tokenEntry.name, until);
  console.log(`[${ts()}] TOKEN_COOLDOWN_SET token=${tokenEntry.name} ms=${ms} reason=${reason || ""}`);
}
function getTokenCooldownMs(tokenEntry) {
  const until = _tokenCooldowns.get(tokenEntry.name) || 0;
  return Math.max(0, until - Date.now());
}
async function waitForTokenCooldown(tokenEntry) {
  let waitMs = getTokenCooldownMs(tokenEntry);
  while (waitMs > 0) {
    const sleepMs = Math.min(waitMs, 5000);
    console.log(`[${ts()}] TOKEN_COOLDOWN token=${tokenEntry.name} waiting ${sleepMs}ms`);
    await new Promise((r) => setTimeout(r, sleepMs));
    waitMs = getTokenCooldownMs(tokenEntry);
  }
}

// ── Unified rate limit tracking (per-token, from Anthropic response headers) ──
const _unifiedRateLimits = new Map(); // tokenName -> { status, 5hUtilization, 7dUtilization, fallbackPct, overageStatus, orgId, updatedAt }
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

// ── Token refresher: auto-refresh OAuth tokens on 401 + proactive pre-expiry ──
const tokenRefresher = createTokenRefresher({
  tokenPool: TOKEN_POOL,
  configPath: join(__dirname, "proxy.config.json"),
  proactiveMarginMs: 300_000, // 5 min before expiry
  maxBackoffMs: 300_000,
});

// Backward compat: ANTHROPIC_AUTH still used for logging/health checks
const ANTHROPIC_AUTH = TOKEN_POOL.length > 0 ? TOKEN_POOL[0] : null;
if (TOKEN_POOL.length > 0) {
  console.log(`[ApiDirect] Token pool: ${TOKEN_POOL.length} token(s) — [${TOKEN_POOL.map(t => `${t.name}:${t.type}`).join(", ")}] — ALL requests via API direct`);
} else {
  console.log(`[ApiDirect] No tokens configured — falling back to CLI workers`);
}

// ============================================================
// Worker traffic & error tracking — exposed via /metrics for dashboard
// ============================================================
const workerStats = {
  // Per-worker traffic: { "1": { requests: 0, errors: 0 }, "3": { ... } }
  traffic: Object.fromEntries(_workerPool.map(w => [w.name, { requests: 0, errors: 0, lastReqAt: null }])),
  // Error categories: { cli_crash: N, cli_killed: N, context_overflow: N, ... }
  errors: {
    cli_crash: 0,       // code=1 — CLI error (nested session, auth, prompt too long, etc.)
    cli_killed: 0,      // code=143 — SIGTERM (reaper killed, heartbeat timeout)
    context_overflow: 0, // fallback API "Context size exceeded"
    api_error: 0,       // Anthropic API errors (401, 429, 500)
    stream_retry: 0,    // quick-fail retries on alternate worker
    timeout: 0,         // heartbeat or exec timeout
    queue_timeout: 0,   // queue timeout (waited too long)
    safety_refusal: 0,  // model refused task citing safety/authorization
    auth_expired: 0,    // OAuth token 401 errors (auto-refresh triggered)
    other: 0,
  },
  // Recent error log (ring buffer, last 100)
  recentErrors: [],
};
function recordWorkerRequest(workerName) {
  const w = workerStats.traffic[workerName];
  if (w) { w.requests++; w.lastReqAt = Date.now(); }
}
function recordWorkerError(workerName, category, detail) {
  const w = workerStats.traffic[workerName];
  if (w) w.errors++;
  if (workerStats.errors[category] !== undefined) workerStats.errors[category]++;
  else workerStats.errors.other++;
  workerStats.recentErrors.push({ ts: Date.now(), worker: workerName, category, detail: (detail || "").slice(0, 200) });
  if (workerStats.recentErrors.length > 100) workerStats.recentErrors.shift();
}

// _loadBalanceMode starts true: round-robin across all healthy workers
// Falls back to single-worker mode when one worker is rate-limited
let _loadBalanceMode = true;

// Active connection tracking — for least-connections routing
const _activeConns = new Map(_workerPool.map(w => [w.name, 0]));
function workerAcquire(name) { _activeConns.set(name, (_activeConns.get(name) || 0) + 1); }
function workerRelease(name) { const v = _activeConns.get(name) || 0; _activeConns.set(name, Math.max(0, v - 1)); }
// Round-robin tiebreaker index — prevents pool[0] bias when workers have equal load
let _leastLoadedRrIndex = 0;
function leastLoadedWorker(pool) {
  // Collect candidates with identical (conns, totalRequests) as the minimum
  let minConns = Infinity;
  let minTotal = Infinity;
  // First pass: find the minimum (conns, total) pair
  for (const w of pool) {
    const c = _activeConns.get(w.name) ?? 0;
    const t = workerStats.traffic[w.name]?.requests ?? 0;
    if (c < minConns || (c === minConns && t < minTotal)) {
      minConns = c;
      minTotal = t;
    }
  }
  // Second pass: collect all workers tied at the minimum
  const tied = pool.filter(w => {
    const c = _activeConns.get(w.name) ?? 0;
    const t = workerStats.traffic[w.name]?.requests ?? 0;
    return c === minConns && t === minTotal;
  });
  // Round-robin among tied candidates (avoids pool[0] bias)
  if (tied.length === 1) return tied[0];
  const pick = tied[_leastLoadedRrIndex % tied.length];
  _leastLoadedRrIndex = (_leastLoadedRrIndex + 1) % tied.length;
  return pick;
}

/**
 * Get the next worker, respecting session affinity when available.
 *
 * @param {string} [sessionKey] - Session key for affinity lookup
 * @returns {object} worker from _workerPool
 */
function getNextWorker(sessionKey) {
  const isHealthy = (name) => isWorkerHealthy(name);
  const healthy = _workerPool.filter((w) => isHealthy(w.name));

  if (healthy.length === 0) {
    // All workers limited — pick the one that was limited longest ago
    const sorted = [..._workerPool].sort(
      (a, b) => _workerHealth.get(a.name).limitedAt - _workerHealth.get(b.name).limitedAt,
    );
    console.log(`[CLIRouter] ALL LIMITED — trying oldest-limited: ${sorted[0].name}`);
    return sorted[0];
  }

  if (healthy.length === 1) {
    return healthy[0];
  }

  // Degraded mode: only use primary
  if (!_loadBalanceMode) {
    const primary = healthy.find((w) => w.name === PRIMARY_WORKER);
    return primary || healthy[0];
  }

  // --- Least-connections is primary strategy ---
  // Session affinity is only a tiebreaker when workers have equal load.
  const least = leastLoadedWorker(healthy);
  const leastConns = _activeConns.get(least.name) || 0;

  if (sessionKey) {
    const aff = sessionAffinity.lookup(sessionKey, isHealthy);
    if (aff?.hit) {
      const affinityWorker = _workerPool.find((w) => w.name === aff.workerName);
      if (affinityWorker) {
        const affConns = _activeConns.get(affinityWorker.name) || 0;
        // Use affinity only if it's strictly less loaded (not just equal)
        if (affConns < leastConns) return affinityWorker;
      }
    }
  }

  return least;
}

function parseResetTimeFromText(text) {
  if (!text) return null;
  const m = text.match(/reset[s]?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3].toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour == 12) hour = 0;
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

function markWorkerLimited(workerName, errText = "") {
  const h = _workerHealth.get(workerName);
  if (h && !h.limited) {
    h.limited = true;
    h.limitedAt = Date.now();
    const resetAt = parseResetTimeFromText(errText);
    h.limitedUntil = resetAt || (Date.now() + HEALTH_CHECK_MS);
    _loadBalanceMode = false; // back to single-worker mode
    const other = _workerPool.find((w) => w.name !== workerName);
    const untilStr = h.limitedUntil ? new Date(h.limitedUntil).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "unknown";
    console.log(`[CLIRouter] ${workerName} RATE LIMITED — switching all traffic to ${other?.name || "?"} (cooldown until ${untilStr})`);
    eventLog.push("worker_limited", { worker: workerName, switchedTo: other?.name, limitedUntil: h.limitedUntil || null });
  }
}

function markWorkerRecovered(workerName) {
  const h = _workerHealth.get(workerName);
  if (h && h.limited) {
    h.limited = false;
    h.limitedAt = 0;
    h.limitedUntil = 0;
    _loadBalanceMode = true; // both workers healthy → share the load
    console.log(`[CLIRouter] ${workerName} RECOVERED — entering load-balance mode (round-robin)`);
    eventLog.push("worker_recovered", { worker: workerName, loadBalance: true });
  }
}

function isRateLimitError(exitCode, stderr) {
  if (!stderr) return false;
  const lower = stderr.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("overloaded") ||
    lower.includes("you've hit your limit")
  );
}

function isWorkerHealthy(name) {
  const h = _workerHealth.get(name);
  if (!h?.limited) return true;
  if (h.limitedUntil && Date.now() >= h.limitedUntil) {
    markWorkerRecovered(name);
    return true;
  }
  return false;
}

// Health check timer: every HEALTH_CHECK_MS, try to recover limited workers
setInterval(() => {
  for (const w of _workerPool) {
    const h = _workerHealth.get(w.name);
    if (!h?.limited) continue;
    const until = h.limitedUntil || (h.limitedAt + HEALTH_CHECK_MS);
    if (Date.now() >= until) {
      console.log(`[CLIRouter] Health check: ${w.name} cooldown expired (${Math.round((Date.now() - h.limitedAt) / 1000)}s) — marking recovered`);
      markWorkerRecovered(w.name);
    }
  }
}, Math.min(HEALTH_CHECK_MS, 60000)); // Check at least every 60s

// Whitelist of env vars safe to pass to CLI workers.
// Everything else is blocked to prevent parent-process leakage
// (e.g. CLAUDECODE causing "nested session" crash).
const WORKER_ENV_WHITELIST = new Set([
  // System essentials
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
  "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  // Node.js
  "NODE_PATH", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS",
  // SSH (agent forwarding, keys)
  "SSH_AUTH_SOCK", "SSH_AGENT_PID",
  // Proxy/network
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  // Anthropic (will be overridden per-worker below)
  "ANTHROPIC_API_KEY",
]);

function workerEnv(worker) {
  // Start from a clean env — only whitelisted vars from parent process
  const env = {};
  for (const key of WORKER_ENV_WHITELIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Ensure /opt/homebrew/bin + wrapper scripts dir are in PATH
  const path = env.PATH || "/usr/bin:/bin";
  const homeDir = process.env.HOME || "/Users/duke_nukem_opcdbase"; // HOME stays as env (system var)
  const extraPaths = [`${homeDir}/.openclaw/bin`, "/opt/homebrew/bin"];
  let finalPath = path;
  for (const p of extraPaths) {
    if (!finalPath.includes(p)) finalPath = `${p}:${finalPath}`;
  }
  env.PATH = finalPath;
  // Per-worker OAuth token (overrides any inherited value)
  if (worker.token) {
    env.CLAUDE_CODE_OAUTH_TOKEN = worker.token;
  }
  // Headless / non-interactive mode — prevent ALL macOS interactive prompts
  env.CI = "true";                          // suppress macOS permission popups
  env.TERM_PROGRAM = "dumb";               // skip terminal-specific osascript detection
  env.TERM = "dumb";                       // reinforce non-interactive terminal
  env.NO_COLOR = "1";                      // no ANSI escape codes
  env.ELECTRON_NO_ATTACH_CONSOLE = "1";    // suppress Electron console
  env.ELECTRON_RUN_AS_NODE = "1";          // skip Electron UI/keychain integration
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"; // skip telemetry/updates
  env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY = "1";      // skip interactive surveys
  // Prevent macOS Keychain access prompts: if safeStorage is attempted,
  // the OS prompts because node isn't in the Keychain ACL.
  // Setting ELECTRON_RUN_AS_NODE bypasses Electron's safeStorage layer.
  return env;
}
const MAX_CONCURRENT = CONFIG.queue.maxConcurrent;
const MAX_QUEUE_TOTAL = CONFIG.queue.maxQueueTotal;
const MAX_QUEUE_PER_SOURCE = CONFIG.queue.maxQueuePerSource;
const QUEUE_TIMEOUT_MS = CONFIG.queue.queueTimeoutMs;
const MAX_RETRIES = CONFIG.retry.maxRetries;
const RETRY_BASE_MS = CONFIG.retry.retryBaseMs;
const STREAM_TIMEOUT_MS = CONFIG.timeouts.streamTimeoutMs;
const SYNC_TIMEOUT_MS = CONFIG.timeouts.syncTimeoutMs;

// Per-model heartbeat timeouts — autonomous agents may go silent during tool execution
const HEARTBEAT_BY_MODEL = Object.freeze(CONFIG.heartbeat);
const DEFAULT_HEARTBEAT_MS = CONFIG.heartbeat.default;
const MAX_PROCESS_AGE_MS = CONFIG.process.maxProcessAgeMs;
const MAX_IDLE_MS = CONFIG.process.maxIdleMs;
const REAPER_INTERVAL_MS = CONFIG.process.reaperIntervalMs;

// Warm Worker Pool: pre-spawns CLI processes to eliminate cold-start latency
const WARM_POOL_ENABLED = CONFIG.warmPool.enabled;
const WARM_POOL_SIZE = CONFIG.warmPool.size;
const WARM_POOL_MAX_AGE_MS = CONFIG.warmPool.maxAgeMs;

// ============================================================
// Rate Limits — 95% of Claude Max plan limits (shared globally)
// ============================================================

const RATE_LIMITS = CONFIG.rateLimits;

// Model priority mapping
const MODEL_PRIORITY = { opus: "high", sonnet: "normal", haiku: "low" };

// Model name -> CLI flag
const MODEL_MAP = {
  "claude-code": "sonnet",
  sonnet: "sonnet",
  "sonnet-4.6": "sonnet",
  "claude-sonnet-4-6": "sonnet",
  opus: "opus",
  "opus-4.6": "opus",
  "claude-opus-4-6": "opus",
  haiku: "haiku",
  "haiku-4.5": "haiku",
  "claude-haiku-4-5": "haiku",
};

function resolveModel(model) {
  const stripped = (model || "sonnet").replace("claude-code/", "");
  return MODEL_MAP[stripped] || "sonnet";
}

// ============================================================
// Redis + Module Instances
// ============================================================

// Redis — connect first, then pass to all modules
let redis = null;
try {
  redis = await createRedisClient();
  console.log("[Redis] Connected and ready");
} catch (err) {
  console.warn(`[Redis] Connection failed: ${err.message} — running in memory-only mode`);
  redis = null;
}

const SOURCE_CONCURRENCY_LIMITS = CONFIG.queue.sourceConcurrencyLimits;
const DEFAULT_SOURCE_CONCURRENCY = CONFIG.queue.defaultSourceConcurrency;

const queue = createFairQueue({
  maxConcurrent: MAX_CONCURRENT,
  maxPerSource: MAX_QUEUE_PER_SOURCE,
  maxTotal: MAX_QUEUE_TOTAL,
  queueTimeoutMs: QUEUE_TIMEOUT_MS,
  maxLeaseMs: STREAM_TIMEOUT_MS + 60_000, // stream timeout + 1 min grace
  maxConcurrentPerSource: SOURCE_CONCURRENCY_LIMITS,
  defaultMaxConcurrentPerSource: DEFAULT_SOURCE_CONCURRENCY,
});

const rateLimiter = createRateLimiter({ limits: RATE_LIMITS, redis });

const registry = createProcessRegistry({
  maxProcessAgeMs: MAX_PROCESS_AGE_MS,
  maxIdleMs: MAX_IDLE_MS,
  reaperIntervalMs: REAPER_INTERVAL_MS,
  redis,
});

const retryPolicy = createRetryPolicy({
  maxRetries: MAX_RETRIES,
  baseDelayMs: RETRY_BASE_MS,
});

const eventLog = createEventLog({ maxEvents: 500, redis });
const tokenTracker = createTokenTracker({ redis });

// Metrics store: persistent time-series data for dashboard charts
const metricsStore = createMetricsStore({ redis });

// System reaper: periodic cleanup of orphan OS processes
const systemReaper = createSystemReaper(CONFIG.systemReaper);

// Session affinity: sticky routing for conversation sessions
const sessionAffinity = createSessionAffinity({ ttlMs: 5 * 60 * 1000 }); // 5 min — short TTL for better distribution

// Warm worker pool: pre-spawns CLI processes to eliminate 2-5s cold start
const warmPool = createWarmPool({
  maxWarmPerKey: WARM_POOL_SIZE,
  maxWarmAgeMs: WARM_POOL_MAX_AGE_MS,
  enabled: WARM_POOL_ENABLED,
  buildArgs: (model, isStream) => buildCliArgs(null, model, null, isStream),
  buildEnv: (worker) => workerEnv(worker),
  log: (msg) => console.log(`[${ts()}] ${msg}`),
});

// Wire reaper events into event log + SSE
registry.onReap((zombie) => {
  const ageS = Math.round(zombie.age / 1000);
  const idleS = Math.round(zombie.idle / 1000);
  eventLog.push("reap", {
    pid: zombie.pid,
    reqId: zombie.requestId,
    model: zombie.model,
    mode: zombie.mode,
    source: zombie.source,
    ageSec: ageS,
    idleSec: idleS,
  });
  sseBroadcast("reap", {
    pid: zombie.pid,
    reqId: zombie.requestId,
    model: zombie.model,
    ageSec: ageS,
    idleSec: idleS,
  });
});

// Wire system reaper events into event log + SSE
systemReaper.onReap((result) => {
  eventLog.push("system_reap", {
    category: result.category,
    pid: result.pid,
    ppid: result.ppid,
    ageSec: result.ageSec,
    command: result.command,
    killed: result.killed,
  });
  sseBroadcast("system_reap", {
    category: result.category,
    pid: result.pid,
    ageSec: result.ageSec,
    killed: result.killed,
  });
});

// Start the system reaper periodic sweep
systemReaper.start();

// ============================================================
// SSE Broadcast — real-time stream to dashboard subscribers
// ============================================================

let sseClients = new Set();

function sseBroadcast(event, data) {
  if (sseClients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients = new Set([...sseClients].filter((c) => c !== client));
    }
  }
}

/**
 * Gather current metrics snapshot for the metrics store sampler.
 */
function gatherMetricsSnapshot() {
  const qs = queue.getStats();
  const rs = registry.getStats();
  const counts = eventLog.getCounts();
  return {
    tokens: tokenTracker.getTotals(),
    tokensByModel: tokenTracker.getByModel(),
    queue: { active: qs.active, totalQueued: qs.totalQueued, metrics: qs.metrics },
    processes: rs,
    liveTokens: rs.liveTokens,
    events: counts,
    errorsByCategory: { ...workerStats.errors },
    sessionAffinity: sessionAffinity.getStats(),
    systemReaper: systemReaper.getStats(),
    warmPool: warmPool.status(),
  };
}

// ============================================================
// Auth & Source identification
// ============================================================

function authenticate(req) {
  const authHeader = req.headers["authorization"] || "";
  const apiKey = req.headers["x-api-key"] || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  // Accept any of: Bearer token, x-api-key, or query param
  return bearer === AUTH_TOKEN || apiKey === AUTH_TOKEN || AUTH_TOKEN === "local-proxy";
}

function identifySource(req) {
  // Priority: explicit header > api key > remote IP
  return (
    req.headers["x-openclaw-source"] ||
    req.headers["x-source"] ||
    req.headers["x-api-key"] ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

// ============================================================
// Claude CLI execution
// ============================================================

// Max prompt characters (~50K chars ≈ ~12K tokens, leaves room for CLI agent's own tool calls).
// Opus has 200K token context; we reserve most of it for the agent's multi-turn tool execution.
const MAX_PROMPT_CHARS = CONFIG.limits.maxPromptChars;
const MAX_BODY_BYTES = CONFIG.limits?.maxBodyBytes || 5_000_000;
// Anthropic direct API context guard (token estimation, not exact)
const MAX_PROMPT_TOKENS = CONFIG.limits?.maxPromptTokens || 190000;
const APPROX_CHARS_PER_TOKEN = 3; // conservative to avoid 200k hard limit

function extractPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { prompt: "", systemPrompt: null };
  }

  let systemPrompt = null;
  const systemMsg = messages.find((m) => m.role === "system" || m.role === "developer");
  if (systemMsg) {
    systemPrompt = typeof systemMsg.content === "string"
      ? systemMsg.content
      : JSON.stringify(systemMsg.content);
  }

  // Collect all non-system messages
  const allParts = [];
  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") continue;
    const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    if (msg.role === "user") allParts.push(text);
    else if (msg.role === "assistant") allParts.push(`[Previous assistant]: ${text}`);
  }

  // Truncate from the front (keep recent messages) to fit within MAX_PROMPT_CHARS.
  // Always keep the LAST message (the actual user request).
  let totalLen = 0;
  const kept = [];
  for (let i = allParts.length - 1; i >= 0; i--) {
    const part = allParts[i];
    if (totalLen + part.length > MAX_PROMPT_CHARS && kept.length > 0) {
      // Budget exceeded — prepend a truncation notice and stop
      kept.unshift("[... earlier conversation history truncated ...]");
      break;
    }
    totalLen += part.length;
    kept.unshift(part);
  }

  return { prompt: kept.join("\n\n"), systemPrompt };
}

// --- Anthropic Direct API context guard (approximate token count) ---
function contentCharLen(block) {
  if (!block) return 0;
  if (block.type === "text") return (block.text || "").length;
  if (block.type === "tool_result") return String(block.content || "").length;
  if (block.type === "tool_use") return (block.name || "").length + JSON.stringify(block.input || {}).length;
  try { return JSON.stringify(block).length; } catch { return 0; }
}

function estimateAnthropicChars(system, messages) {
  let chars = system ? system.length : 0;
  for (const msg of messages || []) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) chars += contentCharLen(block);
    } else if (msg.content) {
      chars += String(msg.content).length;
    }
  }
  return chars;
}

function truncateContentBlock(block, budget) {
  if (!block || budget <= 0) return null;
  if (block.type === "text") return { ...block, text: (block.text || "").slice(-budget) };
  if (block.type === "tool_result") return { ...block, content: String(block.content || "").slice(-budget) };
  return null;
}

function trimAnthropicMessages(system, messages, maxTokens) {
  const maxChars = Math.floor(maxTokens * APPROX_CHARS_PER_TOKEN);
  let working = Array.isArray(messages) ? messages.map(m => ({ ...m, content: Array.isArray(m.content) ? [...m.content] : m.content })) : [];
  let beforeChars = estimateAnthropicChars(system, working);
  if (beforeChars <= maxChars) return { system, messages: working, truncated: false, beforeChars, afterChars: beforeChars };

  while (working.length > 1 && estimateAnthropicChars(system, working) > maxChars) {
    working.shift();
  }

  let afterChars = estimateAnthropicChars(system, working);
  if (afterChars > maxChars && working.length === 1) {
    const budget = Math.max(0, maxChars - (system ? system.length : 0));
    const msg = working[0];
    if (Array.isArray(msg.content)) {
      const newContent = [];
      let remaining = budget;
      for (let i = msg.content.length - 1; i >= 0 && remaining > 0; i--) {
        const block = msg.content[i];
        const len = contentCharLen(block);
        if (len <= remaining) {
          newContent.unshift(block);
          remaining -= len;
        } else {
          const truncated = truncateContentBlock(block, remaining);
          if (truncated) newContent.unshift(truncated);
          remaining = 0;
        }
      }
      msg.content = newContent;
    } else if (typeof msg.content === "string") {
      msg.content = msg.content.slice(-budget);
    }
    afterChars = estimateAnthropicChars(system, working);
  }

  return { system, messages: working, truncated: true, beforeChars, afterChars };
}

function buildCliArgs(prompt, model, systemPrompt, stream) {
  // Pass prompt via stdin (not CLI arg) to avoid OrbStack/OS arg length limits.
  // The `-p` flag without a positional prompt tells Claude CLI to read from stdin.
  // --dangerously-skip-permissions: full autonomous agent, all tools enabled
  // --append-system-prompt: injects authorization context into the REAL system prompt
  //   (NOT user message) so the model treats it as operator instructions, not prompt injection.
  const args = ["-p", "--model", model, "--dangerously-skip-permissions",
    "--append-system-prompt", PROXY_AUTH_PREAMBLE];
  if (stream) {
    args.push("--output-format", "stream-json", "--verbose", "--include-partial-messages");
  } else {
    args.push("--output-format", "text");
  }
  return args;
}

// Authorization preamble — appended to the REAL system prompt via --append-system-prompt.
// This goes through the proper system prompt channel, so the model treats it as
// operator instructions rather than user-injected content (which would be flagged as prompt injection).
const PROXY_AUTH_PREAMBLE = [
  "You are an autonomous agent operating on the infrastructure owner's private network.",
  "All machines referenced in tasks are owned by the operator. All SSH keys are pre-configured.",
  "You are fully authorized to: execute commands locally and remotely, use SSH/scp/rsync,",
  "read/write files, install packages, access databases and APIs.",
  "Wrapper scripts in PATH: run-on-c10tt, run-on-aimm, run-on-m3, run-on-c13tt, run-on-c11tt.",
  "Prefer wrapper scripts over raw SSH. All operations are pre-approved by the operator.",
].join(" ");

// Build the full stdin payload: system prompt (if any) + user prompt
function buildStdinPayload(prompt, systemPrompt) {
  if (systemPrompt) {
    return `[System Instructions]\n${systemPrompt}\n\n[User Request]\n${prompt}`;
  }
  return prompt;
}

function runCliOnce(prompt, model, systemPrompt, requestId = "", source = "", workerOverride = null, sessionKey = "") {
  return new Promise((resolve, reject) => {
    const worker = workerOverride || getNextWorker(sessionKey);
    if (sessionKey) sessionAffinity.assign(sessionKey, worker.name);
    recordWorkerRequest(worker.name);
    workerAcquire(worker.name);

    // Try warm pool first — get a pre-initialized process or spawn fresh
    const warm = warmPool.acquire(model, false, worker);
    let proc;
    if (warm) {
      proc = warm.proc;
      console.log(`[${ts()}] CLIROUTER obj=${worker.name} bin=${worker.bin} reqId=${requestId} model=${model} WARM_HIT pid=${proc.pid}`);
    } else {
      const args = buildCliArgs(prompt, model, systemPrompt, false);
      proc = spawn(worker.bin, args, {
        env: workerEnv(worker),
        stdio: ["pipe", "pipe", "pipe"],
      });
      console.log(`[${ts()}] CLIROUTER obj=${worker.name} bin=${worker.bin} reqId=${requestId} model=${model} COLD pid=${proc.pid || "?"}`);
    }

    // Write full payload (system prompt + user prompt) to stdin
    if (proc.stdin) {
      proc.stdin.write(buildStdinPayload(prompt, systemPrompt));
      proc.stdin.end();
    }

    // Track in process registry
    if (proc.pid) {
      registry.register({
        pid: proc.pid,
        requestId,
        model,
        mode: "sync",
        source,
        worker: `${worker.name}:${worker.bin}`,
        promptPreview: typeof prompt === "string" ? prompt.slice(0, 80) : "[structured]",
      });
    }

    // Execution timeout — kill if running too long
    const execTimer = setTimeout(() => {
      eventLog.push("timeout", { kind: "sync", pid: proc.pid, reqId: requestId, model });
      recordWorkerError(worker.name, "timeout", `sync_timeout pid=${proc.pid}`);
      console.log(`[${ts()}] SYNC_TIMEOUT pid=${proc.pid} reqId=${requestId} model=${model}`);
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      const err = new Error(`Execution timeout after ${SYNC_TIMEOUT_MS}ms`);
      err.exitCode = -1;
      err.workerName = worker.name;
      reject(err);
    }, SYNC_TIMEOUT_MS);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
      if (proc.pid) registry.touch(proc.pid);
    });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      clearTimeout(execTimer);
      workerRelease(worker.name);
      if (proc.pid) registry.unregister(proc.pid);
      // Detect rate limit from stderr/stdout
      const rateErr = isRateLimitError(code, stderr) || isRateLimitError(code, stdout);
      if (rateErr) {
        markWorkerLimited(worker.name, stderr || stdout);
      }
      if (code !== 0) {
        const err = new Error(`CLI exit ${code}: ${stderr}`);
        err.exitCode = code;
        err.workerName = worker.name;
        err.isRateLimit = rateErr;
        reject(err);
      } else {
        resolve(stdout.trim());
      }
    });
    proc.on("error", (err) => {
      clearTimeout(execTimer);
      workerRelease(worker.name);
      if (proc.pid) registry.unregister(proc.pid);
      err.workerName = worker.name;
      reject(err);
    });
  });
}

/**
 * Run CLI with retry + exponential backoff + jitter.
 * Uses retry policy for consistent retry behavior.
 */
async function runCli(prompt, model, systemPrompt, requestId = "", source = "", sessionKey = "") {
  return retryPolicy.withRetry(
    () => runCliOnce(prompt, model, systemPrompt, requestId, source, null, sessionKey),
    {
      onRetry: (attempt, error, delayMs) => {
        eventLog.push("retry", { reqId: requestId, attempt: attempt + 1, model, delay: delayMs, error: error.message });
        console.log(
          `[${ts()}] RETRY attempt=${attempt + 1}/${MAX_RETRIES} ` +
          `model=${model} delay=${delayMs}ms err=${error.message}`
        );
      },
    },
  );
}

function spawnCliStream(prompt, model, systemPrompt, worker) {
  // Try warm pool first
  const warm = warmPool.acquire(model, true, worker);
  let proc;
  if (warm) {
    proc = warm.proc;
    console.log(`[${ts()}] STREAM_SPAWN worker=${worker.name} model=${model} WARM_HIT pid=${proc.pid}`);
  } else {
    const args = buildCliArgs(prompt, model, systemPrompt, true);
    proc = spawn(worker.bin, args, {
      env: workerEnv(worker),
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log(`[${ts()}] STREAM_SPAWN worker=${worker.name} model=${model} COLD pid=${proc.pid || "?"}`);
  }
  // Write full payload (system prompt + user prompt) to stdin
  if (proc.stdin) {
    proc.stdin.write(buildStdinPayload(prompt, systemPrompt));
    proc.stdin.end();
  }
  proc._workerName = worker.name;
  proc._spawnedAt = Date.now();
  return proc;
}

function trackStreamProc(proc, requestId, model, source, worker) {
  if (proc.pid) {
    registry.register({
      pid: proc.pid,
      requestId,
      model,
      mode: "stream",
      source,
      worker: `${worker.name}:${worker.bin}`,
      promptPreview: "[stream]",
      liveInputTokens: 0,
      liveOutputTokens: 0,
    });
    proc.on("close", () => registry.unregister(proc.pid));
    proc.on("error", () => registry.unregister(proc.pid));
  }
}

// Pick a specific worker by name, or fallback to round-robin
function getWorkerByName(name) {
  return _workerPool.find((w) => w.name === name) || null;
}

function getAlternateWorker(excludeName) {
  const healthy = _workerPool.filter(
    (w) => w.name !== excludeName && isWorkerHealthy(w.name)
  );
  return healthy.length > 0 ? healthy[0] : null;
}

function getAllLimitedStatus() {
  const limited = _workerPool.filter((w) => !isWorkerHealthy(w.name));
  if (limited.length !== _workerPool.length || limited.length === 0) return null;
  let nextReset = null;
  for (const w of limited) {
    const h = _workerHealth.get(w.name);
    const until = h?.limitedUntil || (h?.limitedAt ? h.limitedAt + HEALTH_CHECK_MS : null);
    if (until && (!nextReset || until < nextReset)) nextReset = until;
  }
  return { nextReset };
}

function formatLimitNotice(resetAt) {
  if (!resetAt) return `[Claude limit reached — switching to ${FALLBACK_API.name} fallback]`;
  const t = new Date(resetAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `[Claude limit reached — switching to ${FALLBACK_API.name} fallback until ${t}]`;
}

// ============================================================
// Fallback API: stream from an OpenAI-compatible HTTP endpoint
// Used as last resort when all CLI routers fail
// ============================================================

function streamFromFallbackApi(messages, model, reqId, source, res) {
  const fb = FALLBACK_API;
  const url = new URL(`${fb.baseUrl}/chat/completions`);
  const isHttps = url.protocol === "https:";
  const doRequest = isHttps ? httpsRequest : httpRequest;

  const body = JSON.stringify({
    model: fb.model,
    messages,
    stream: true,
  });

  console.log(`[${ts()}] FALLBACK reqId=${reqId} api=${fb.name} model=${fb.model} src=${source}`);
  eventLog.push("fallback", { reqId, model, source, fallbackApi: fb.name, fallbackModel: fb.model });

  // Safe write helper — prevent writing to already-closed response
  const safeWrite = (data) => { if (!res.writableEnded) res.write(data); };
  const safeEnd = () => { if (!res.writableEnded) res.end(); };

  const apiReq = doRequest(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fb.apiKey}`,
        "content-length": Buffer.byteLength(body),
      },
    },
    (apiRes) => {
      if (apiRes.statusCode !== 200) {
        let errBody = "";
        apiRes.on("data", (d) => { errBody += d.toString(); });
        apiRes.on("end", () => {
        clearTimeout(fallbackTimer);
          console.log(`[${ts()}] FALLBACK_ERROR reqId=${reqId} status=${apiRes.statusCode} body=${errBody.slice(0, 200)}`);
          recordWorkerError("fallback", errBody.includes("Context size") ? "context_overflow" : "api_error", `HTTP ${apiRes.statusCode} ${errBody.slice(0, 100)}`);
          safeWrite(sseChunk(reqId, `[Fallback ${fb.name} error: HTTP ${apiRes.statusCode}]`));
          safeWrite(sseChunk(reqId, null, "stop"));
          safeWrite("data: [DONE]\n\n");
          safeEnd();
        });
        return;
      }

      // Pipe the SSE stream from the fallback API directly to the client
      let buf = "";
      let outputChars = 0;
      apiRes.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") {
            if (trimmed === "data: [DONE]") {
              safeWrite("data: [DONE]\n\n");
            }
            continue;
          }
          if (trimmed.startsWith("data: ")) {
            try {
              const ev = JSON.parse(trimmed.slice(6));
              const delta = ev.choices?.[0]?.delta?.content;
              const finish = ev.choices?.[0]?.finish_reason;
              if (delta) {
                safeWrite(sseChunk(reqId, delta));
                outputChars += delta.length;
                sseBroadcast("chunk", { reqId, model: fb.model, source, text: delta, tokens: outputChars, worker: "fallback" });
              }
              if (finish) {
                safeWrite(sseChunk(reqId, null, finish));
              }
            } catch { /* skip malformed */ }
          }
        }
      });
      apiRes.on("end", () => {
        clearTimeout(fallbackTimer);
        tokenTracker.record(reqId, fb.model, 0, Math.ceil(outputChars / 4));
        eventLog.push("complete", { reqId, mode: "fallback", model: fb.model, source, exitCode: 0, outputChars });
        sseBroadcast("complete", { reqId, model: fb.model, source, exitCode: 0, worker: "fallback" });
        if (outputChars === 0) {
          safeWrite(sseChunk(reqId, `[Fallback ${fb.name}: empty response]`));
        }
        safeWrite(sseChunk(reqId, null, "stop"));
        safeWrite("data: [DONE]\n\n");
        safeEnd();
      });
    },
  );

  const fallbackTimer = setTimeout(() => {
    console.log(`[${ts()}] FALLBACK_TIMEOUT reqId=${reqId} waited=${FALLBACK_TIMEOUT_MS}ms`);
    recordWorkerError("fallback", "timeout", `timeout ${FALLBACK_TIMEOUT_MS}ms`);
    safeWrite(sseChunk(reqId, `[Fallback ${fb.name} timeout after ${FALLBACK_TIMEOUT_MS}ms]`));
    safeWrite(sseChunk(reqId, null, "stop"));
    safeWrite("data: [DONE]\n\n");
    safeEnd();
    try { apiReq.destroy(new Error("fallback timeout")); } catch { /* ignore */ }
  }, FALLBACK_TIMEOUT_MS);

  apiReq.on("error", (err) => {
    clearTimeout(fallbackTimer);
    console.log(`[${ts()}] FALLBACK_NET_ERROR reqId=${reqId} err=${err.message}`);
    safeWrite(sseChunk(reqId, `[Fallback ${fb.name} unreachable: ${err.message}]`));
    safeWrite(sseChunk(reqId, null, "stop"));
    safeWrite("data: [DONE]\n\n");
    safeEnd();
  });

  apiReq.write(body);
  apiReq.end();
}

function fetchFallbackSync(messages, model, reqId, source) {
  const fb = FALLBACK_API;
  const url = new URL(`${fb.baseUrl}/chat/completions`);
  const isHttps = url.protocol === "https:";
  const doRequest = isHttps ? httpsRequest : httpRequest;

  const body = JSON.stringify({
    model: fb.model,
    messages,
    stream: false,
  });

  console.log(`[${ts()}] FALLBACK_SYNC reqId=${reqId} api=${fb.name} model=${fb.model} src=${source}`);
  eventLog.push("fallback", { reqId, mode: "sync", model, source, fallbackApi: fb.name, fallbackModel: fb.model });

  return new Promise((resolve, reject) => {
    const apiReq = doRequest(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${fb.apiKey}`,
          "content-length": Buffer.byteLength(body),
        },
      },
      (apiRes) => {
        let buf = "";
        apiRes.on("data", (d) => { buf += d.toString(); });
        apiRes.on("end", () => {
          clearTimeout(fallbackTimer);
          if (apiRes.statusCode !== 200) {
            console.log(`[${ts()}] FALLBACK_SYNC_ERROR reqId=${reqId} status=${apiRes.statusCode} body=${buf.slice(0, 200)}`);
            recordWorkerError("fallback", buf.includes("Context size") ? "context_overflow" : "api_error", `HTTP ${apiRes.statusCode} ${buf.slice(0, 100)}`);
            return reject(new Error(`Fallback HTTP ${apiRes.statusCode}`));
          }
          try {
            const json = JSON.parse(buf);
            const content = json.choices?.[0]?.message?.content || json.choices?.[0]?.text || "";
            if (!content) return resolve("");
            return resolve(content);
          } catch (err) {
            return reject(err);
          }
        });
      },
    );

    

    apiReq.on("error", (err) => {
      
      console.log(`[${ts()}] FALLBACK_SYNC_NET_ERROR reqId=${reqId} err=${err.message}`);
      reject(err);
    });

    apiReq.write(body);
    apiReq.end();
  });
}

// Response formatting imported from response-formats.mjs

/**
 * Stream response from Anthropic Messages API, converting to OpenAI SSE.
 * Handles text content + tool_use blocks.
 */
function streamFromAnthropicDirect(body, model, reqId, source, res, release, tokenEntry) {
  const anthropicModel = ANTHROPIC_MODEL_IDS[model] || ANTHROPIC_MODEL_IDS.sonnet;
  const anthropicTools = body.tools ? convertToolsToAnthropic(body.tools) : [];
  const { system, messages } = convertMessagesToAnthropic(body.messages);
  const trimmed = trimAnthropicMessages(system, messages, MAX_PROMPT_TOKENS);
  if (trimmed.truncated) {
    console.log(`[${ts()}] CONTEXT_TRUNCATED reqId=${reqId} beforeChars=${trimmed.beforeChars} afterChars=${trimmed.afterChars}`);
  }

  const requestBody = {
    model: anthropicModel,
    max_tokens: body.max_tokens || 16384,
    stream: true,
    messages: trimmed.messages,
  };
  if (trimmed.system) requestBody.system = trimmed.system;
  if (anthropicTools.length > 0) requestBody.tools = anthropicTools;
  if (body.tool_choice) {
    if (body.tool_choice === "auto") requestBody.tool_choice = { type: "auto" };
    else if (body.tool_choice === "none") requestBody.tool_choice = { type: "none" };
    else if (body.tool_choice === "required") requestBody.tool_choice = { type: "any" };
    else if (body.tool_choice?.type === "function") {
      requestBody.tool_choice = { type: "tool", name: body.tool_choice.function.name };
    }
  }

  const bodyStr = JSON.stringify(requestBody);
  const authHeaderName = tokenEntry.type === "oauth_flat" ? "authorization" : "x-api-key";
  const liveToken = tokenRefresher.getActiveToken(tokenEntry.name) || tokenEntry.token;
  const authHeaderValue = tokenEntry.type === "oauth_flat" ? `Bearer ${liveToken}` : liveToken;
  console.log(
    `[${ts()}] ANTHROPIC_STREAM reqId=${reqId} model=${anthropicModel} ` +
    `tools=${anthropicTools.length} msgs=${messages.length} auth=${tokenEntry.type} token=${tokenEntry.name} src=${source}`
  );
  eventLog.push("anthropic_direct", {
    reqId, model: anthropicModel, tools: anthropicTools.length, source, auth: tokenEntry.type, token: tokenEntry.name,
  });

  const safeWrite = (data) => { if (!res.writableEnded) res.write(data); };
  const safeEnd = () => { if (!res.writableEnded) res.end(); };
  let released = false;
  const doRelease = () => { if (!released) { released = true; release(); } };

  const url = new URL(`${ANTHROPIC_API_BASE}/v1/messages`);
  const headers = {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_API_VERSION,
    ...(tokenEntry.type === "oauth_flat" ? { "anthropic-beta": "oauth-2025-04-20" } : {}),
    "content-length": String(Buffer.byteLength(bodyStr)),
  };
  headers[authHeaderName] = authHeaderValue;

  const apiReq = httpsRequest(url, { method: "POST", headers }, (apiRes) => {
    captureUnifiedRateHeaders(apiRes, tokenEntry);
    if (apiRes.statusCode !== 200) {
      let errBody = "";
      apiRes.on("data", (d) => { errBody += d.toString(); });
      apiRes.on("end", () => {

        if (apiRes.statusCode === 429) {
          const retryHeader = apiRes.headers["retry-after"];
          let retryMs = 30000;
          if (retryHeader) {
            const sec = Number(retryHeader);
            if (!Number.isNaN(sec)) retryMs = Math.max(retryMs, sec * 1000);
          }
          setTokenCooldown(tokenEntry, retryMs, "anthropic_429");
        }

        // 401: OAuth token expired — trigger auto-refresh for next requests
        if (apiRes.statusCode === 401) {
          recordWorkerError(tokenEntry.name, "auth_expired", `401: ${errBody.slice(0, 100)}`);
          tokenRefresher.handleAuthError(tokenEntry).then(result => {
            if (result.refreshed) {
              console.log(`[${ts()}] TOKEN_REFRESHED token=${tokenEntry.name} — next requests use new token`);
            }
          }).catch(err => {
            console.error(`[${ts()}] TOKEN_REFRESH_FAIL token=${tokenEntry.name} err=${err.message}`);
          });
        }

        console.log(`[${ts()}] ANTHROPIC_ERROR reqId=${reqId} status=${apiRes.statusCode} body=${errBody.slice(0, 500)}`);
        eventLog.push("error", { reqId, mode: "anthropic_direct", model, source, status: apiRes.statusCode });
        safeWrite(sseChunk(reqId, `[Anthropic API error: HTTP ${apiRes.statusCode}]`));
        safeWrite(sseFinishChunk(reqId, "stop"));
        safeWrite("data: [DONE]\n\n");
        safeEnd();
        doRelease();
      });
      return;
    }

    let buf = "";
    let toolCallIndex = -1;
    const toolCalls = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let outputChars = 0;

    apiRes.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        let ev;
        try { ev = JSON.parse(trimmed.slice(6)); } catch { continue; }

        if (ev.type === "message_start") {
          inputTokens = ev.message?.usage?.input_tokens || 0;
        } else if (ev.type === "content_block_start") {
          const block = ev.content_block;
          if (block?.type === "tool_use") {
            toolCallIndex++;
            toolCalls.push({ index: toolCallIndex, id: block.id, name: block.name, arguments: "" });
            safeWrite(sseToolCallStartChunk(reqId, toolCallIndex, block.id, block.name));
          }
          // text blocks and thinking blocks: no special start action needed
        } else if (ev.type === "content_block_delta") {
          if (ev.delta?.type === "text_delta" && ev.delta.text) {
            safeWrite(sseChunk(reqId, ev.delta.text));
            outputChars += ev.delta.text.length;
            sseBroadcast("chunk", { reqId, model, source, text: ev.delta.text, tokens: outputChars, worker: tokenEntry.name });
          } else if (ev.delta?.type === "input_json_delta" && ev.delta.partial_json !== undefined) {
            const tc = toolCalls[toolCalls.length - 1];
            if (tc) {
              tc.arguments += ev.delta.partial_json;
              safeWrite(sseToolCallDeltaChunk(reqId, tc.index, ev.delta.partial_json));
            }
          }
          // thinking_delta: skip silently
        } else if (ev.type === "message_delta") {
          outputTokens = ev.usage?.output_tokens || outputTokens;
          const stop = ev.delta?.stop_reason;
          if (stop) {
            const finish = stop === "tool_use" ? "tool_calls"
              : stop === "end_turn" ? "stop"
              : stop === "max_tokens" ? "length"
              : "stop";
            safeWrite(sseFinishChunk(reqId, finish));
          }
        }
        // message_stop, content_block_stop, ping: no action needed
      }
    });

    apiRes.on("end", () => {
      tokenTracker.record(reqId, model, inputTokens, outputTokens);
      eventLog.push("complete", {
        reqId, mode: "anthropic_direct", model, source,
        inputTokens, outputTokens, toolCalls: toolCalls.length,
      });
      sseBroadcast("complete", { reqId, model, source, inputTokens, outputTokens, worker: tokenEntry.name });
      safeWrite("data: [DONE]\n\n");
      safeEnd();
      doRelease();
    });

    apiRes.on("error", (err) => {
      console.log(`[${ts()}] ANTHROPIC_STREAM_ERR reqId=${reqId} err=${err.message}`);
      safeWrite(sseChunk(reqId, `[Anthropic stream error: ${err.message}]`));
      safeWrite("data: [DONE]\n\n");
      safeEnd();
      doRelease();
    });
  });

  // Client disconnect: abort Anthropic API request
  res.on("close", () => {
    if (!apiReq.destroyed) {
      console.log(`[${ts()}] CLIENT_DISCONNECT reqId=${reqId} — aborting Anthropic API request`);
      apiReq.destroy();
    }
    doRelease();
  });

  

  apiReq.on("error", (err) => {
    
    console.log(`[${ts()}] ANTHROPIC_NET_ERR reqId=${reqId} err=${err.message}`);
    eventLog.push("error", { reqId, mode: "anthropic_direct", model, source, error: err.message });
    safeWrite(sseChunk(reqId, `[Anthropic API unreachable: ${err.message}]`));
    safeWrite(sseFinishChunk(reqId, "stop"));
    safeWrite("data: [DONE]\n\n");
    safeEnd();
    doRelease();
  });

  apiReq.write(bodyStr);
  apiReq.end();
}

/**
 * Call Anthropic Messages API synchronously (non-streaming).
 * Returns { content, toolCalls, usage, stopReason }.
 */
function callAnthropicDirect(body, model, reqId, source, tokenEntry) {
  return new Promise((resolve, reject) => {
    const anthropicModel = ANTHROPIC_MODEL_IDS[model] || ANTHROPIC_MODEL_IDS.sonnet;
    const anthropicTools = body.tools ? convertToolsToAnthropic(body.tools) : [];
    const { system, messages } = convertMessagesToAnthropic(body.messages);
    const trimmed = trimAnthropicMessages(system, messages, MAX_PROMPT_TOKENS);
    if (trimmed.truncated) {
      console.log(`[${ts()}] CONTEXT_TRUNCATED reqId=${reqId} beforeChars=${trimmed.beforeChars} afterChars=${trimmed.afterChars}`);
    }

    const requestBody = {
      model: anthropicModel,
      max_tokens: body.max_tokens || 16384,
      messages: trimmed.messages,
    };
    if (trimmed.system) requestBody.system = trimmed.system;
    if (anthropicTools.length > 0) requestBody.tools = anthropicTools;

    const bodyStr = JSON.stringify(requestBody);
    const authHeaderName = tokenEntry.type === "oauth_flat" ? "authorization" : "x-api-key";
    const liveTokenSync = tokenRefresher.getActiveToken(tokenEntry.name) || tokenEntry.token;
    const authHeaderValue = tokenEntry.type === "oauth_flat" ? `Bearer ${liveTokenSync}` : liveTokenSync;
    console.log(
      `[${ts()}] ANTHROPIC_SYNC reqId=${reqId} model=${anthropicModel} ` +
      `tools=${anthropicTools.length} auth=${tokenEntry.type} token=${tokenEntry.name} src=${source}`
    );

    const url = new URL(`${ANTHROPIC_API_BASE}/v1/messages`);
    const headers = {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_API_VERSION,
      ...(tokenEntry.type === "oauth_flat" ? { "anthropic-beta": "oauth-2025-04-20" } : {}),
      "content-length": String(Buffer.byteLength(bodyStr)),
    };
    headers[authHeaderName] = authHeaderValue;

    const timer = setTimeout(() => {
      apiReq.destroy();
      reject(new Error(`Anthropic API timeout after ${SYNC_TIMEOUT_MS}ms`));
    }, SYNC_TIMEOUT_MS);

    const apiReq = httpsRequest(url, { method: "POST", headers }, (apiRes) => {
      captureUnifiedRateHeaders(apiRes, tokenEntry);
      let resBody = "";
      apiRes.on("data", (d) => { resBody += d.toString(); });
      apiRes.on("end", () => {

        clearTimeout(timer);
        if (apiRes.statusCode !== 200) {
          if (apiRes.statusCode === 429) {
            const retryHeader = apiRes.headers["retry-after"];
            let retryMs = 30000;
            if (retryHeader) {
              const sec = Number(retryHeader);
              if (!Number.isNaN(sec)) retryMs = Math.max(retryMs, sec * 1000);
            }
            setTokenCooldown(tokenEntry, retryMs, "anthropic_429");
          }
          // 401: trigger refresh and mark error for retry
          if (apiRes.statusCode === 401) {
            recordWorkerError(tokenEntry.name, "auth_expired", `401: ${resBody.slice(0, 100)}`);
            tokenRefresher.handleAuthError(tokenEntry).then(refreshResult => {
              const err = new Error(`Anthropic API HTTP 401: auth error`);
              err.statusCode = 401;
              err.refreshed = refreshResult.refreshed;
              reject(err);
            }).catch(() => {
              const err = new Error(`Anthropic API HTTP 401: auth error (refresh failed)`);
              err.statusCode = 401;
              err.refreshed = false;
              reject(err);
            });
            return;
          }
          return reject(new Error(`Anthropic API HTTP ${apiRes.statusCode}: ${resBody.slice(0, 500)}`));
        }
        try {
          const result = JSON.parse(resBody);
          let textContent = "";
          const toolCalls = [];
          for (const block of (result.content || [])) {
            if (block.type === "text") textContent += block.text;
            else if (block.type === "tool_use") {
              toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
            }
          }
          resolve({
            content: textContent || null,
            toolCalls,
            usage: {
              prompt_tokens: result.usage?.input_tokens || 0,
              completion_tokens: result.usage?.output_tokens || 0,
              total_tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
            },
            stopReason: result.stop_reason,
          });
        } catch (err) {
          reject(new Error(`Failed to parse Anthropic response: ${err.message}`));
        }
      });
    });

    

  apiReq.on("error", (err) => {
    
      clearTimeout(timer);
      reject(err);
    });

    apiReq.write(bodyStr);
    apiReq.end();
  });
}

/**
 * Handle ALL requests via direct Anthropic API with token round-robin.
 * Supports both tool-enabled and text-only requests.
 */
async function handleApiDirect(body, model, stream, source, req, res) {
  const priority = MODEL_PRIORITY[model] || "normal";
  const estTokens = Math.min(Math.ceil(JSON.stringify(body.messages).length / 4), 5000);
  const reqId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  let release;
  try {
    release = await queue.acquire(source, priority);
  } catch (err) {
    return sendJson(res, 503, {
      error: { message: `Queue full: ${err.message}`, type: "queue_full", retry_after_ms: 10000 },
    }, { "retry-after": "10" });
  }

  let rateWaitTotal = 0;
  while (true) {
    const rateCheck = rateLimiter.check(model, estTokens);
    if (rateCheck.ok) break;
    if (rateWaitTotal >= 300000) {
      release();
      return sendJson(res, 503, {
        error: { message: "Rate limit wait exceeded", type: "rate_limit_timeout" },
      });
    }
    const sleepMs = Math.min(rateCheck.waitMs, 5000);
    await new Promise(r => setTimeout(r, sleepMs));
    rateWaitTotal += sleepMs;
  }

  rateLimiter.record(model, estTokens);
  const tokenEntry = getNextToken();
  await waitForTokenCooldown(tokenEntry);
  recordWorkerRequest(tokenEntry.name);
  eventLog.push("request", {
    reqId, mode: stream ? "stream_tools" : "sync_tools", model, source, priority,
    toolCount: body.tools?.length || 0, worker: tokenEntry.name,
  });
  sseBroadcast("request", {
    reqId, mode: stream ? "stream_tools" : "sync_tools", model, source, priority, worker: tokenEntry.name,
  });
  console.log(
    `[${ts()}] ${stream ? "STREAM" : "SYNC"}_API src=${source} model=${model} ` +
    `tools=${body.tools?.length || 0} token=${tokenEntry.name} reqId=${reqId}`
  );

  if (stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);

    streamFromAnthropicDirect(body, model, reqId, source, res, release, tokenEntry);
  } else {
    try {
      const result = await callAnthropicDirect(body, model, reqId, source, tokenEntry);
      release();
      tokenTracker.record(reqId, model, result.usage.prompt_tokens, result.usage.completion_tokens);
      eventLog.push("complete", {
        reqId, mode: "anthropic_direct_sync", model, source, ...result.usage,
      });
      sseBroadcast("complete", {
        reqId, model, source, worker: tokenEntry.name,
        inputTokens: result.usage.prompt_tokens,
        outputTokens: result.usage.completion_tokens,
      });
      sendJson(res, 200, completionResponseWithTools(
        reqId, result.content, result.toolCalls, model, result.usage,
      ));
    } catch (err) {
      // 401 with successful refresh — retry once with new token
      if (err.statusCode === 401 && err.refreshed) {
        console.log(`[${ts()}] RETRY_AFTER_REFRESH reqId=${reqId} token=${tokenEntry.name}`);
        try {
          const retryResult = await callAnthropicDirect(body, model, reqId + "-retry", source, tokenEntry);
          release();
          tokenTracker.record(reqId, model, retryResult.usage.prompt_tokens, retryResult.usage.completion_tokens);
          eventLog.push("complete", {
            reqId, mode: "anthropic_direct_sync_retry", model, source, ...retryResult.usage,
          });
          sseBroadcast("complete", {
            reqId, model, source, worker: tokenEntry.name,
            inputTokens: retryResult.usage.prompt_tokens,
            outputTokens: retryResult.usage.completion_tokens,
          });
          sendJson(res, 200, completionResponseWithTools(
            reqId, retryResult.content, retryResult.toolCalls, model, retryResult.usage,
          ));
          return;
        } catch (retryErr) {
          console.error(`[${ts()}] RETRY_FAILED reqId=${reqId} ${retryErr.message}`);
          // Fall through to normal error handling
        }
      }
      release();
      console.error(`[${ts()}] TOOL_REQ_ERROR reqId=${reqId} src=${source} ${err.message}`);
      eventLog.push("error", { reqId, mode: "anthropic_direct", model, source, error: err.message });
      sseBroadcast("error", { reqId, model, source, worker: tokenEntry.name, error: err.message });
      sendJson(res, 500, { error: { message: err.message, type: "anthropic_api_error" } });
    }
  }
}

// ============================================================
// Request handler: /v1/chat/completions
// ============================================================

async function handleCompletions(req, res) {
  const source = identifySource(req);

  let rawBody;
  try {
    rawBody = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    return sendJson(res, 413, { error: { message: err.message || "Payload too large" } });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return sendJson(res, 400, { error: { message: "Invalid JSON body" } });
  }

  const { messages, model: rawModel = "claude-code", stream = false } = body;
  if (!messages || !Array.isArray(messages)) {
    return sendJson(res, 400, { error: { message: "messages array required" } });
  }

  // API direct path: only when CLI agent mode is off and tokens are available
  if (!USE_CLI_AGENTS && TOKEN_POOL.length > 0) {
    return handleApiDirect(body, resolveModel(rawModel), stream, source, req, res);
  }

  const { prompt, systemPrompt } = extractPrompt(messages);
  if (!prompt) {
    return sendJson(res, 400, { error: { message: "No user message found" } });
  }

  // Session affinity: derive a key so the same conversation sticks to the same worker
  const sessionKey = sessionAffinity.deriveKey({
    source,
    sessionId: req.headers["x-session-id"] || "",
    systemPrompt: systemPrompt || "",
  });

  const model = resolveModel(rawModel);
  const priority = MODEL_PRIORITY[model] || "normal";
  // Estimated tokens for rate-limiter: use a small fixed cap.
  // chars/4 wildly over-estimates (code/JSON has low token density).
  // The real rate limit is Anthropic's 429 response; our limiter is
  // just a courtesy throttle.  Cap at 5000 so ~11 opus requests/min
  // can coexist (57000/5000).  If Anthropic 429s, the retry loop handles it.
  const estTokens = Math.min(Math.ceil(prompt.length / 4), 5000);
  const reqId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  // Acquire slot via fair queue (waits for turn, never rejects)
  let release;
  try {
    release = await queue.acquire(source, priority);
  } catch (err) {
    // Only rejects if queue is truly full (100+ pending)
    console.log(`[${ts()}] QUEUE_FULL src=${source} model=${model} ${err.message}`);
    return sendJson(res, 503, {
      error: { message: `Queue full, try again shortly: ${err.message}`, type: "queue_full", retry_after_ms: 10000 },
    }, { "retry-after": "10" });
  }

  // Wait for rate limit window (sleep instead of rejecting)
  let rateWaitTotal = 0;
  const MAX_RATE_WAIT_MS = 300000;
  while (true) {
    const rateCheck = rateLimiter.check(model, estTokens);
    if (rateCheck.ok) break;
    if (rateWaitTotal >= MAX_RATE_WAIT_MS) {
      release();
      console.log(`[${ts()}] RATE_TIMEOUT src=${source} model=${model} waited ${rateWaitTotal}ms`);
      return sendJson(res, 503, {
        error: { message: `Rate limit wait exceeded ${MAX_RATE_WAIT_MS}ms`, type: "rate_limit_timeout" },
      });
    }
    const sleepMs = Math.min(rateCheck.waitMs, 5000);
    console.log(`[${ts()}] RATE_WAIT src=${source} model=${model} sleeping ${sleepMs}ms (${rateCheck.reason})`);
    await new Promise((r) => setTimeout(r, sleepMs));
    rateWaitTotal += sleepMs;
  }

  rateLimiter.record(model, estTokens);
  eventLog.push("request", { reqId, mode: stream ? "stream" : "sync", model, source, priority });
  sseBroadcast("request", { reqId, mode: stream ? "stream" : "sync", model, source, priority, promptPreview: prompt.slice(0, 80) });
  console.log(`[${ts()}] ${stream ? "STREAM" : "SYNC"} src=${source} model=${model} prio=${priority} session=${sessionKey.slice(0, 30)} prompt=${prompt.slice(0, 60)}...`);

  if (stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",       // hint to reverse proxies: don't buffer
    });
    res.flushHeaders();                 // force headers out immediately
    if (res.socket) {
      res.socket.setNoDelay(true);      // disable Nagle — send chunks immediately
    }
    // Immediate keepalive: prevents Gateway from timing out while CLI spawns.
    // Without this, there's a 4-10s gap between headers and first CLI output,
    // causing ~49% of requests to be disconnected by Gateway.
    res.write(":proxy-accepted\n\n");

    const allLimited = getAllLimitedStatus();
    if (allLimited) {
      const notice = formatLimitNotice(allLimited.nextReset);
      res.write(sseChunk(reqId, notice));
      streamFromFallbackApi(messages, model, reqId, source, res);
      return;
    }

    // Stream with auto-retry: if a worker fails quickly (<5s, no content),
    // automatically retry on a different worker before giving up.
    // If ALL CLI routers fail, fall back to the API endpoint (e.g. MiniMax).
    const QUICK_FAIL_MS = 5000;
    const MAX_RETRIES = _workerPool.length;  // try each router once
    const inputEstimate = Math.ceil(prompt.length / 4);
    const originalMessages = messages;  // preserve for fallback API
    let retryCount = 0;
    const triedRouters = new Set();
    let activeProc = null;  // track current CLI process for client-disconnect cleanup

    // If client disconnects, kill the CLI process to free resources
    res.on("close", () => {
      if (activeProc && !activeProc.killed) {
        console.log(`[${ts()}] CLIENT_DISCONNECT reqId=${reqId} — killing CLI pid=${activeProc.pid}`);
        try { activeProc.kill("SIGTERM"); } catch { /* ignore */ }
      }
    });

    function pipeStream(workerOverride, isRetry) {
      const worker = workerOverride || getNextWorker(sessionKey);
      // Bind this session to the chosen worker
      sessionAffinity.assign(sessionKey, worker.name);
      triedRouters.add(worker.name);
      console.log(`[${ts()}] CLIROUTER obj=${worker.name} bin=${worker.bin} reqId=${reqId} model=${model} src=${source}${isRetry ? ` RETRY#${retryCount}` : ""}`);
      recordWorkerRequest(worker.name);
      workerAcquire(worker.name);
      const proc = spawnCliStream(prompt, model, systemPrompt, worker);
      activeProc = proc;  // update for client-disconnect handler
      trackStreamProc(proc, reqId, model, source, worker);

      let buffer = "";
      let stderrBuf = "";
      let sentContent = false;
      let reqTokens = { input: 0, output: 0 };
      let outputChars = 0;
      const spawnedAt = Date.now();

      proc.stderr.on("data", (d) => { stderrBuf += d.toString(); });

      // First-byte warning: if CLI hasn't produced stdout within 8s, log a warning.
      // This helps diagnose macOS auth dialogs, slow spawns, or keychain prompts.
      const FIRST_BYTE_WARN_MS = 8_000;
      const firstByteTimer = setTimeout(() => {
        console.log(`[${ts()}] SLOW_SPAWN pid=${proc.pid} reqId=${reqId} model=${model} router=${worker.name} elapsed=${FIRST_BYTE_WARN_MS}ms — no stdout yet (possible macOS dialog or slow startup)`);
        eventLog.push("timeout", { kind: "slow_spawn", pid: proc.pid, reqId, model, source, elapsed: FIRST_BYTE_WARN_MS });
      }, FIRST_BYTE_WARN_MS);

      const heartbeatMs = HEARTBEAT_BY_MODEL[model] || DEFAULT_HEARTBEAT_MS;
      let heartbeatTimer = setTimeout(() => {
        eventLog.push("timeout", { kind: "heartbeat", pid: proc.pid, reqId, model, source, heartbeatMs });
        console.log(`[${ts()}] HEARTBEAT_TIMEOUT pid=${proc.pid} reqId=${reqId} model=${model} src=${source} limit=${heartbeatMs}ms`);
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      }, heartbeatMs);

      function resetHeartbeat() {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = setTimeout(() => {
          eventLog.push("timeout", { kind: "heartbeat", pid: proc.pid, reqId, model, source, heartbeatMs });
          console.log(`[${ts()}] HEARTBEAT_TIMEOUT pid=${proc.pid} reqId=${reqId} model=${model} src=${source} limit=${heartbeatMs}ms`);
          try { proc.kill("SIGTERM"); } catch { /* ignore */ }
        }, heartbeatMs);
      }

      const execTimer = setTimeout(() => {
        eventLog.push("timeout", { kind: "stream_exec", pid: proc.pid, reqId, model });
        console.log(`[${ts()}] STREAM_TIMEOUT pid=${proc.pid} reqId=${reqId} model=${model} age=${STREAM_TIMEOUT_MS}ms`);
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      }, STREAM_TIMEOUT_MS);

      // SSE keepalive: send comment lines to prevent upstream (Gateway) HTTP timeout.
      // SSE spec allows `:comment\n\n` — client parsers ignore it but the TCP stays alive.
      // Phase 1: fast keepalive (5s) during CLI startup; Phase 2: slow (30s) after first content.
      const FAST_KEEPALIVE_MS = 5_000;
      const SLOW_KEEPALIVE_MS = 30_000;
      let keepaliveMs = FAST_KEEPALIVE_MS;
      let keepaliveInterval = setInterval(() => {
        if (!res.writableEnded) {
          try { res.write(":keepalive\n\n"); } catch { /* ignore write errors */ }
        }
      }, keepaliveMs);
      function slowDownKeepalive() {
        if (keepaliveMs === FAST_KEEPALIVE_MS) {
          keepaliveMs = SLOW_KEEPALIVE_MS;
          clearInterval(keepaliveInterval);
          keepaliveInterval = setInterval(() => {
            if (!res.writableEnded) {
              try { res.write(":keepalive\n\n"); } catch { /* ignore */ }
            }
          }, SLOW_KEEPALIVE_MS);
        }
      }

      proc.stdout.on("data", (data) => {
        clearTimeout(firstByteTimer); // CLI is alive — cancel slow-spawn warning
        resetHeartbeat();
        slowDownKeepalive(); // CLI is producing output, switch to slow keepalive
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            const canWrite = !res.writableEnded;
            // stream_event: incremental deltas from --include-partial-messages
            if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
              const text = ev.event.delta?.text;
              if (text) {
                if (canWrite) res.write(sseChunk(reqId, text));
                outputChars += text.length;
                sentContent = true;
                sseBroadcast("chunk", { reqId, model, source, text, tokens: outputChars, worker: worker.name });
              }
            } else if (ev.type === "stream_event" && ev.event?.type === "message_delta") {
              const usage = ev.event.usage;
              if (usage) {
                // Total input = non-cached + cache-created + cache-read
                const totalInput = (usage.input_tokens || 0)
                  + (usage.cache_creation_input_tokens || 0)
                  + (usage.cache_read_input_tokens || 0);
                reqTokens = { input: totalInput, output: usage.output_tokens || 0 };
              }
            } else if (ev.type === "assistant" && ev.message?.content) {
              if (!sentContent) {
                for (const b of ev.message.content) {
                  if (b.type === "text" && b.text) {
                    if (canWrite) res.write(sseChunk(reqId, b.text));
                    outputChars += b.text.length;
                    sentContent = true;
                    sseBroadcast("chunk", { reqId, model, source, text: b.text, tokens: outputChars, worker: worker.name });
                  }
                }
              }
            } else if (ev.type === "content_block_delta" && ev.delta?.text) {
              if (canWrite) res.write(sseChunk(reqId, ev.delta.text));
              outputChars += ev.delta.text.length;
              sentContent = true;
              sseBroadcast("chunk", { reqId, model, source, text: ev.delta.text, tokens: outputChars, worker: worker.name });
            } else if (ev.type === "result" && ev.result && !sentContent) {
              if (canWrite) res.write(sseChunk(reqId, ev.result));
              sentContent = true;
            }
            // Capture token usage (include cached tokens in total input)
            const usage = ev.usage || ev.message?.usage;
            if (usage) {
              const totalInput = (usage.input_tokens || usage.prompt_tokens || 0)
                + (usage.cache_creation_input_tokens || 0)
                + (usage.cache_read_input_tokens || 0);
              reqTokens = {
                input: totalInput,
                output: usage.output_tokens || usage.completion_tokens || 0,
              };
            }
          } catch { /* non-JSON line, skip */ }
        }
        if (proc.pid) {
          const liveInput = reqTokens.input > 0 ? reqTokens.input : inputEstimate;
          const liveOutput = reqTokens.output > 0 ? reqTokens.output : Math.ceil(outputChars / 4);
          registry.touch(proc.pid, { liveInputTokens: liveInput, liveOutputTokens: liveOutput });
        }
      });

      proc.on("close", (code) => {
        clearTimeout(firstByteTimer);
        clearTimeout(heartbeatTimer);
        clearTimeout(execTimer);
        clearInterval(keepaliveInterval);
        workerRelease(worker.name);

        // Quick-fail auto-retry: if worker failed fast with no content, try another
        const elapsed = Date.now() - proc._spawnedAt;
        if (code !== 0 && !sentContent && elapsed < QUICK_FAIL_MS && retryCount < MAX_RETRIES) {
          // Find an untried router, or any alternate
          const untried = _workerPool.find(
            (w) => !triedRouters.has(w.name) && isWorkerHealthy(w.name)
          );
          const alt = untried || getAlternateWorker(worker.name);
          if (alt) {
            retryCount++;
            console.log(`[${ts()}] STREAM_RETRY reqId=${reqId} failedRouter=${worker.name} code=${code} elapsed=${elapsed}ms -> retrying on ${alt.name} (attempt ${retryCount}/${MAX_RETRIES})`);
            recordWorkerError(worker.name, "stream_retry", `code=${code} elapsed=${elapsed}ms`);
            eventLog.push("retry", { reqId, model, source, failedWorker: worker.name, retryWorker: alt.name, code, elapsed, retryCount });
            pipeStream(alt, true);
            return;  // don't finalize response — retry will handle it
          }
        }

        release();
        if (code !== 0) {
          const diag = stderrBuf.trim() || buffer.trim().slice(0, 200) || "(no output)";
          console.log(`[${ts()}] CLI_EXIT reqId=${reqId} code=${code} sent=${sentContent} router=${worker.name} stderr=${diag.slice(0, 300)}`);
          const errCat = code === 143 ? "cli_killed" : "cli_crash";
          recordWorkerError(worker.name, errCat, `code=${code} ${diag.slice(0, 100)}`);
        }
        const rateErr = isRateLimitError(code, stderrBuf) || isRateLimitError(code, buffer);
        if (proc._workerName && rateErr) {
          markWorkerLimited(proc._workerName, stderrBuf || buffer);
        }
        // Flush remaining buffer
        const canWrite = !res.writableEnded;
        if (buffer.trim()) {
          try {
            const ev = JSON.parse(buffer);
            if (ev.type === "assistant" && ev.message?.content) {
              for (const b of ev.message.content) {
                if (b.type === "text" && b.text && canWrite) res.write(sseChunk(reqId, b.text));
              }
            } else if (ev.type === "result" && ev.result && !sentContent && canWrite) {
              res.write(sseChunk(reqId, ev.result));
            }
            const usage = ev.usage || ev.message?.usage;
            if (usage) {
              const totalInput = (usage.input_tokens || usage.prompt_tokens || 0)
                + (usage.cache_creation_input_tokens || 0)
                + (usage.cache_read_input_tokens || 0);
              reqTokens = { input: totalInput, output: usage.output_tokens || usage.completion_tokens || 0 };
            }
          } catch { /* ignore */ }
        }
        const finalInput = reqTokens.input > 0 ? reqTokens.input : inputEstimate;
        const finalOutput = reqTokens.output > 0 ? reqTokens.output : Math.ceil(outputChars / 4);
        tokenTracker.record(reqId, model, finalInput, finalOutput);
        eventLog.push("complete", {
          reqId, mode: "stream", model, source, exitCode: code,
          inputTokens: finalInput, outputTokens: finalOutput,
        });
        sseBroadcast("complete", { reqId, model, source, exitCode: code, inputTokens: finalInput, outputTokens: finalOutput, worker: worker.name });

        // Detect model safety refusals — log for diagnostics
        // (The auth preamble should prevent most, but model training may still override)
        if (sentContent && outputChars < 2000) {
          const outputSnapshot = (buffer || "").toLowerCase();
          const REFUSAL_PATTERNS = [
            "i cannot", "i can't", "i'm not able", "i am not able",
            "i won't", "i will not", "safety concern", "unauthorized access",
            "not authorized", "security risk", "i must decline",
            "cannot assist with", "unable to comply", "not comfortable",
          ];
          const isRefusal = REFUSAL_PATTERNS.some(p => outputSnapshot.includes(p));
          if (isRefusal) {
            console.log(`[${ts()}] SAFETY_REFUSAL reqId=${reqId} model=${model} router=${worker.name} outputLen=${outputChars} — model appears to have refused the task`);
            eventLog.push("error", { kind: "safety_refusal", reqId, model, source, outputChars });
            recordWorkerError(worker.name, "other", `safety_refusal model=${model}`);
          }
        }

        if (code !== 0 && !sentContent) {
          // All CLI routers failed — fall back to API endpoint
          console.log(`[${ts()}] ALL_CLI_FAILED reqId=${reqId} retryCount=${retryCount} -> falling back to ${FALLBACK_API.name}`);
          streamFromFallbackApi(originalMessages, model, reqId, source, res);
          return;  // fallback handles res.end()
        }
        if (canWrite) {
          res.write(sseChunk(reqId, null, "stop"));
          res.write("data: [DONE]\n\n");
          res.end();
        }
      });

      proc.on("error", (err) => {
        clearTimeout(firstByteTimer);
        clearTimeout(heartbeatTimer);
        clearTimeout(execTimer);
        clearInterval(keepaliveInterval);
        workerRelease(worker.name);
        // Quick-fail auto-retry on spawn error too
        if (!sentContent && retryCount < MAX_RETRIES) {
          const untried = _workerPool.find(
            (w) => !triedRouters.has(w.name) && isWorkerHealthy(w.name)
          );
          const alt = untried || getAlternateWorker(worker.name);
          if (alt) {
            retryCount++;
            console.log(`[${ts()}] STREAM_RETRY reqId=${reqId} failedRouter=${worker.name} error=${err.message} -> retrying on ${alt.name} (attempt ${retryCount}/${MAX_RETRIES})`);
            pipeStream(alt, true);
            return;
          }
        }
        release();
        // All CLI routers errored — fall back to API endpoint
        console.log(`[${ts()}] ALL_CLI_FAILED reqId=${reqId} error=${err.message} -> falling back to ${FALLBACK_API.name}`);
        streamFromFallbackApi(originalMessages, model, reqId, source, res);
      });
    }

    // Start the stream pipeline (first attempt, no retry flag)
    pipeStream(null, false);
  } else {
    try {
      const allLimited = getAllLimitedStatus();
      if (allLimited) {
        const notice = formatLimitNotice(allLimited.nextReset);
        try {
          const fbResult = await fetchFallbackSync(messages, model, reqId, source);
          release();
          const combined = fbResult ? `${notice}

${fbResult}` : notice;
          sendJson(res, 200, completionResponse(reqId, combined, model));
          return;
        } catch (err) {
          release();
          const retrySec = allLimited.nextReset ? Math.max(0, Math.round((allLimited.nextReset - Date.now()) / 1000)) : null;
          return sendJson(res, 503, {
            error: { message: `Claude limit reached; retry after ${retrySec ?? "unknown"}s`, type: "rate_limited" },
            retry_after_sec: retrySec,
          });
        }
      }
      const result = await runCli(prompt, model, systemPrompt, reqId, source, sessionKey);
      release();
      // Estimate tokens for sync: prompt chars/4 for input, result chars/4 for output
      const syncInputTokens = Math.ceil(prompt.length / 4);
      const syncOutputTokens = Math.ceil(result.length / 4);
      tokenTracker.record(reqId, model, syncInputTokens, syncOutputTokens);
      eventLog.push("complete", {
        reqId, mode: "sync", model, source,
        inputTokens: syncInputTokens, outputTokens: syncOutputTokens,
      });
      sendJson(res, 200, completionResponse(reqId, result, model));
    } catch (err) {
      if (err.isRateLimit) {
        const allLimited = getAllLimitedStatus();
        const notice = formatLimitNotice(allLimited?.nextReset);
        try {
          const fbResult = await fetchFallbackSync(messages, model, reqId, source);
          release();
          const combined = fbResult ? `${notice}

${fbResult}` : notice;
          sendJson(res, 200, completionResponse(reqId, combined, model));
          return;
        } catch (fbErr) {
          release();
          const retrySec = allLimited?.nextReset ? Math.max(0, Math.round((allLimited.nextReset - Date.now()) / 1000)) : null;
          return sendJson(res, 503, {
            error: { message: `Claude limit reached; retry after ${retrySec ?? "unknown"}s`, type: "rate_limited" },
            retry_after_sec: retrySec,
          });
        }
      }
      release();
      eventLog.push("error", { reqId, mode: "sync", model, source, error: err.message });
      console.error(`[${ts()}] ERROR src=${source} ${err.message}`);
      sendJson(res, 500, { error: { message: err.message, type: "internal_error" } });
    }
  }
}

// ============================================================
// Other endpoints
// ============================================================

function handleModels(req, res) {
  const models = Object.keys(MODEL_MAP).map((id) => ({
    id: `claude-code/${id}`,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "claude-code-proxy",
  }));
  sendJson(res, 200, { object: "list", data: models });
}

function handleHealth(req, res) {
  const qs = queue.getStats();
  const rs = registry.getStats();
  const workers = _workerPool.map((w) => {
    const h = _workerHealth.get(w.name);
    const until = h.limitedUntil || null;
    return {
      name: w.name,
      bin: w.bin,
      limited: h.limited,
      limitedAt: h.limitedAt || null,
      limitedAgoSec: h.limited ? Math.round((Date.now() - h.limitedAt) / 1000) : null,
      limitedUntil: until,
      limitedUntilIso: until ? new Date(until).toISOString() : null,
      limitedRemainingSec: h.limited && until ? Math.max(0, Math.round((until - Date.now()) / 1000)) : null,
    };
  });
  sendJson(res, 200, {
    status: "ok",
    version: CONFIG.dashboard.version,
    claude_bin: CLAUDE_BIN,
    port: PORT,
    redis: redis ? { connected: redis.isReady() } : { connected: false },
    cliRouters: workers,
    primaryRouter: PRIMARY_WORKER,
    queue: { active: qs.active, queued: qs.totalQueued, max: qs.maxConcurrent, sources: qs.sourceCount, activeBySource: qs.activeBySource },
    processes: { tracked: rs.total, byMode: rs.byMode, liveTokens: rs.liveTokens },
    tokens: tokenTracker.getTotals(),
    sessionAffinity: sessionAffinity.getStats(),
    workerStats,
    dashboard: CONFIG.dashboard,
    portal: CONFIG.portal,
  });
}

function handleMetrics(req, res) {
  const qs = queue.getStats();
  const rs = registry.getStats();
  const workers = _workerPool.map((w) => {
    const h = _workerHealth.get(w.name);
    const until = h.limitedUntil || null;
    return {
      name: w.name,
      limited: h.limited,
      limitedAt: h.limitedAt || null,
      limitedUntil: until,
      limitedRemainingSec: h.limited && until ? Math.max(0, Math.round((until - Date.now()) / 1000)) : null,
    };
  });
  sendJson(res, 200, {
    rateLimits: RATE_LIMITS,
    rateUsage: rateLimiter.stats(),
    tokens: tokenTracker.getStats(),
    cliRouters: workers,
    loadBalanceMode: _loadBalanceMode,
    primaryRouter: PRIMARY_WORKER,
    queue: qs,
    processes: rs,
    config: {
      version: CONFIG.dashboard.version,
      useCliAgents: USE_CLI_AGENTS,
      workerCount: _workerPool.length,
      loadBalanceAlgorithm: "least-utilization",
      maxConcurrent: MAX_CONCURRENT,
      maxQueueTotal: MAX_QUEUE_TOTAL,
      maxQueuePerSource: MAX_QUEUE_PER_SOURCE,
      sourceConcurrencyLimits: SOURCE_CONCURRENCY_LIMITS,
      defaultSourceConcurrency: DEFAULT_SOURCE_CONCURRENCY,
      queueTimeoutMs: QUEUE_TIMEOUT_MS,
      heartbeatByModel: HEARTBEAT_BY_MODEL,
      defaultHeartbeatMs: DEFAULT_HEARTBEAT_MS,
      streamTimeoutMs: STREAM_TIMEOUT_MS,
      syncTimeoutMs: SYNC_TIMEOUT_MS,
      maxProcessAgeMs: MAX_PROCESS_AGE_MS,
      maxIdleMs: MAX_IDLE_MS,
      reaperIntervalMs: REAPER_INTERVAL_MS,
      sessionAffinityTtlMs: 5 * 60 * 1000,
      sseKeepaliveMs: 30_000,
      maxRetries: MAX_RETRIES,
      retryBaseMs: RETRY_BASE_MS,
    },
    sessionAffinity: sessionAffinity.getStats(),
    workerStats,
    activeConnections: Object.fromEntries(_activeConns),
    systemReaper: systemReaper.getStats(),
    unifiedRateLimits: getUnifiedRateLimits(),
    tokenRefreshStatus: tokenRefresher.getStatus(),
  });
}

function handleSystemReaper(req, res) {
  const stats = systemReaper.getStats();
  sendJson(res, 200, {
    stats,
    config: systemReaper.config,
  });
}

async function handleSystemReaperSweep(req, res) {
  const result = systemReaper.sweep();
  sendJson(res, 200, { result });
}

function handleWarmPool(req, res) {
  sendJson(res, 200, warmPool.status());
}

function handleZombies(req, res) {
  const zombies = registry.getZombies();
  const qs = queue.getStats();
  sendJson(res, 200, {
    processes: registry.getAll(),
    zombies,
    stats: registry.getStats(),
    activeLeases: qs.activeLeases,
  });
}

async function handleKillZombie(req, res) {
  let body;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    return sendJson(res, 413, { error: { message: err.message || "Payload too large" } });
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: { message: "Invalid JSON body" } });
  }

  const { pid } = parsed;
  if (!pid) return sendJson(res, 400, { error: { message: "pid required" } });

  const result = registry.kill(Number(pid));
  eventLog.push("kill", { pid: Number(pid), manual: true });
  sendJson(res, 200, { result });
}

function handleEvents(req, res, url) {
  const sinceId = parseInt(url.searchParams.get("since_id") || "0", 10);
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);
  const type = url.searchParams.get("type") || null;
  const events = eventLog.getRecent({ sinceId, limit, type });
  sendJson(res, 200, { events, counts: eventLog.getCounts() });
}

function handleMetricsHistory(req, res, url) {
  const window = url.searchParams.get("window") || "1h";
  const validWindows = ["1h", "6h", "1d", "7d"];
  if (!validWindows.includes(window)) {
    return sendJson(res, 400, { error: { message: `Invalid window. Use: ${validWindows.join(", ")}` } });
  }
  const points = metricsStore.query(window);
  sendJson(res, 200, { window, points, count: points.length, bufferSize: metricsStore.getBufferSize() });
}

async function handlePortal(req, res) {
  try {
    const html = await readFile(join(__dirname, "portal.html"), "utf-8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    sendJson(res, 500, { error: { message: "Portal file not found: " + err.message } });
  }
}

async function handleProxyDashboard(req, res) {
  try {
    const html = await readFile(join(__dirname, "dashboard.html"), "utf-8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    sendJson(res, 500, { error: { message: "Dashboard file not found: " + err.message } });
  }
}

// ============================================================
// Utilities
// ============================================================

function ts() {
  return new Date().toISOString();
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(body));
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        const err = new Error(`Payload too large (>${maxBytes} bytes)`);
        return reject(err);
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", (err) => reject(err));
  });
}

function handleSSEStream(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });
  res.write("event: connected\ndata: {}\n\n");

  sseClients = new Set([...sseClients, res]);
  console.log(`[${ts()}] SSE_CLIENT connected (${sseClients.size} total)`);

  req.on("close", () => {
    sseClients = new Set([...sseClients].filter((c) => c !== res));
    console.log(`[${ts()}] SSE_CLIENT disconnected (${sseClients.size} total)`);
  });
}

// ============================================================
// HTTP Server
// ============================================================

const server = createServer(async (req, res) => {
  // Enable TCP keepalive on every connection — detect dead tunnel clients faster
  // Without this, half-open TCP connections (dead SSH tunnel) can persist for hours
  const socket = req.socket;
  if (socket && !socket._keepaliveSet) {
    socket.setKeepAlive(true, 30_000); // probe every 30s after idle
    socket.setTimeout(660_000);        // 11 min hard socket timeout (> stream timeout)
    socket.on("timeout", () => socket.destroy());
    socket._keepaliveSet = true;
  }

  const url = new URL(req.url, `http://0.0.0.0:${PORT}`);

  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, authorization, x-api-key, x-openclaw-source, x-source, x-session-id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Auth check (skip for health, dashboard, events)
  const noAuthPaths = ["/health", "/dashboard", "/dashboard/", "/dashboard/proxy", "/dashboard/proxy/", "/events", "/metrics/history", "/stream", "/system-reaper"];
  if (!noAuthPaths.includes(url.pathname) && !authenticate(req)) {
    return sendJson(res, 401, { error: { message: "Unauthorized" } });
  }

  try {
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      await handleCompletions(req, res);
    } else if (url.pathname === "/v1/models" && req.method === "GET") {
      handleModels(req, res);
    } else if (url.pathname === "/health" && req.method === "GET") {
      handleHealth(req, res);
    } else if (url.pathname === "/metrics" && req.method === "GET") {
      handleMetrics(req, res);
    } else if (url.pathname === "/rate-limits" && req.method === "GET") {
      handleMetrics(req, res); // backward compat
    } else if (url.pathname === "/zombies" && req.method === "GET") {
      handleZombies(req, res);
    } else if (url.pathname === "/zombies" && req.method === "POST") {
      await handleKillZombie(req, res);
    } else if (url.pathname === "/system-reaper" && req.method === "GET") {
      handleSystemReaper(req, res);
    } else if (url.pathname === "/system-reaper" && req.method === "POST") {
      await handleSystemReaperSweep(req, res);
    } else if (url.pathname === "/warm-pool" && req.method === "GET") {
      handleWarmPool(req, res);
    } else if (url.pathname === "/events" && req.method === "GET") {
      handleEvents(req, res, url);
    } else if (url.pathname === "/metrics/history" && req.method === "GET") {
      handleMetricsHistory(req, res, url);
    } else if (url.pathname === "/stream" && req.method === "GET") {
      handleSSEStream(req, res);
    } else if (url.pathname === "/token-refresh" && req.method === "POST") {
      const chunks = []; for await (const c of req) chunks.push(c);
      const { tokenName } = JSON.parse(Buffer.concat(chunks).toString());
      const entry = TOKEN_POOL.find(t => t.name === tokenName);
      if (!entry) return sendJson(res, 404, { error: { message: `Token ${tokenName} not found` } });
      const result = await tokenRefresher.handleAuthError(entry);
      sendJson(res, 200, { result, status: tokenRefresher.getStatus() });
    } else if (url.pathname === "/dashboard/proxy" || url.pathname === "/dashboard/proxy/") {
      await handleProxyDashboard(req, res);
    } else if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
      await handlePortal(req, res);
    } else {
      sendJson(res, 404, { error: { message: "Not found" } });
    }
  } catch (err) {
    console.error(`[${ts()}] UNHANDLED ${err.message}`);
    sendJson(res, 500, { error: { message: "Internal server error" } });
  }
});

// ============================================================
// Graceful shutdown
// ============================================================

function shutdown(signal) {
  console.log(`[${ts()}] SHUTDOWN signal=${signal}`);

  // Kill all tracked processes
  const allProcs = registry.getAll();
  for (const entry of allProcs) {
    console.log(`[${ts()}] SHUTDOWN_KILL pid=${entry.pid} reqId=${entry.requestId} model=${entry.model}`);
    registry.kill(entry.pid);
  }

  warmPool.shutdown();
  registry.destroy();
  queue.destroy();
  metricsStore.destroy();
  systemReaper.destroy();
  sessionAffinity.shutdown();
  tokenRefresher.destroy();

  // Close Redis connection
  if (redis) {
    redis.quit().catch(() => {});
  }

  server.close(() => {
    console.log(`[${ts()}] SHUTDOWN complete`);
    process.exit(0);
  });

  // Force exit after 5s if graceful close hangs
  setTimeout(() => {
    console.error(`[${ts()}] SHUTDOWN forced after 5s timeout`);
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ============================================================
// Start server (with EADDRINUSE auto-recovery)
// ============================================================

// Kill stale process holding our port and retry once.
// This handles the case where a previous instance didn't shut down cleanly.
let _listenRetried = false;
server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && !_listenRetried) {
    _listenRetried = true;
    console.warn(`[Startup] Port ${PORT} in use — killing stale process and retrying...`);
    try {
      // Find PID(s) holding the port and kill them
      // Try lsof first, fall back to pgrep (lsof may not be in LaunchAgent PATH)
      let pids = [];
      try {
        const lsofOut = execSync(`/usr/sbin/lsof -ti :${PORT}`, { encoding: "utf8", timeout: 5000 }).trim();
        pids = lsofOut.split("\n").filter(Boolean).map(Number).filter(p => p !== process.pid);
      } catch {
        // Fallback: find node processes running server.mjs
        try {
          const pgrepOut = execSync(`pgrep -f "node.*server\\.mjs"`, { encoding: "utf8", timeout: 5000 }).trim();
          pids = pgrepOut.split("\n").filter(Boolean).map(Number).filter(p => p !== process.pid);
        } catch { /* no matches */ }
      }
      for (const pid of pids) {
        console.warn(`[Startup] Killing stale PID ${pid} on port ${PORT}`);
        try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
      }
      // Wait briefly for port to free up, then retry
      setTimeout(() => {
        console.log(`[Startup] Retrying listen on port ${PORT}...`);
        server.listen(PORT, "0.0.0.0");
      }, 1500);
    } catch (killErr) {
      console.error(`[Startup] Failed to kill stale process: ${killErr.message}`);
      process.exit(1);
    }
  } else {
    console.error(`[Startup] Server error: ${err.message}`);
    process.exit(1);
  }
});

server.listen(PORT, "0.0.0.0", async () => {
  // Wait for all persistent stores to load from Redis / files
  await Promise.all([
    metricsStore.ready,
    tokenTracker.ready,
    eventLog.ready,
    registry.ready,
  ]);

  eventLog.push("startup", { version: "0.5.0", port: PORT, redis: !!redis });

  // Seed token tracker from all raw metrics snapshots (sums across server restarts)
  const rawSnapshots = metricsStore.getRawBuffer();
  tokenTracker.seedFromHistory(rawSnapshots);

  metricsStore.startSampler(gatherMetricsSnapshot);
  tokenRefresher.start();

  // Pre-warm worker pool: spawn processes for the most common configs
  if (WARM_POOL_ENABLED) {
    const prewarmConfigs = [];
    for (const worker of _workerPool) {
      // Pre-warm sync sonnet (most common: batch labeler, general queries)
      prewarmConfigs.push({ model: "sonnet", isStream: false, worker, count: 1 });
      // Pre-warm stream sonnet (most common streaming config)
      prewarmConfigs.push({ model: "sonnet", isStream: true, worker, count: 1 });
    }
    warmPool.prewarm(prewarmConfigs);
    console.log(`[WarmPool] Pre-warmed ${prewarmConfigs.length} worker(s) across ${_workerPool.length} CLI router(s)`);
  }

  console.log(`Claude Code Proxy v0.5.1`);
  console.log(`Listening on http://0.0.0.0:${PORT}`);
  console.log(`CLI Routers: ${_workerPool.map((w) => `obj${w.name}=${w.bin}`).join(" | ")} | Primary: obj${PRIMARY_WORKER}`);
  console.log(`Auth token: ${AUTH_TOKEN === "local-proxy" ? "(open - no auth)" : "(enabled)"}`);
  console.log(`Concurrent: ${MAX_CONCURRENT} | Queue: ${MAX_QUEUE_TOTAL} total, ${MAX_QUEUE_PER_SOURCE}/source`);
  console.log(`Queue timeout: ${QUEUE_TIMEOUT_MS}ms`);
  console.log(`Models: ${Object.keys(MODEL_MAP).join(", ")}`);
  console.log(`Rate limits: sonnet ${RATE_LIMITS.sonnet.requestsPerMin}/min, opus ${RATE_LIMITS.opus.requestsPerMin}/min, haiku ${RATE_LIMITS.haiku.requestsPerMin}/min`);
  console.log(`Reaper: age=${MAX_PROCESS_AGE_MS}ms idle=${MAX_IDLE_MS}ms interval=${REAPER_INTERVAL_MS}ms`);
  const srcLimits = Object.keys(SOURCE_CONCURRENCY_LIMITS).length > 0
    ? Object.entries(SOURCE_CONCURRENCY_LIMITS).map(([k, v]) => `${k}:${v}`).join(", ")
    : "none";
  console.log(`Source concurrency limits: ${srcLimits} (default=${DEFAULT_SOURCE_CONCURRENCY || "unlimited"})`);
  console.log(`Timeouts: sync=${SYNC_TIMEOUT_MS}ms stream=${STREAM_TIMEOUT_MS}ms`);
  console.log(`Heartbeat: opus=${HEARTBEAT_BY_MODEL.opus}ms sonnet=${HEARTBEAT_BY_MODEL.sonnet}ms haiku=${HEARTBEAT_BY_MODEL.haiku}ms`);
  console.log(`Warm pool: ${WARM_POOL_ENABLED ? `enabled (size=${WARM_POOL_SIZE}, maxAge=${WARM_POOL_MAX_AGE_MS}ms)` : "disabled"}`);
  console.log(`Metrics store: ${metricsStore.getBufferSize()} historical snapshots loaded`);
});
