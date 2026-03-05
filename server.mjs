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

import { createServer } from "node:http";
// node:https moved to lib/anthropic-client.mjs
import { execSync } from "node:child_process";
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
import { createAutoHealManager, classifyCliError } from "./auto-heal.mjs";
import { createStorageController } from "./controllers/storage-controller.mjs";
import { createMetricsController } from "./controllers/metrics-controller.mjs";
import { createWorkerHealthController } from "./controllers/worker-health-controller.mjs";
import {
  sseChunk, sseToolCallStartChunk, sseToolCallDeltaChunk, sseFinishChunk,
  completionResponse, completionResponseWithTools,
  convertToolsToAnthropic, convertMessagesToAnthropic,
} from "./response-formats.mjs";
import {
  extractPrompt as _extractPrompt,
  normalizeText as _normalizeText,
  normalizeTextForKey as _normalizeTextForKey,
  stableStringify,
  hashString,
  buildCacheKey,
  splitSystemForCache as _splitSystemForCache,
  buildCacheContext as _buildCacheContext,
  buildAnthropicSystemBlocks as _buildAnthropicSystemBlocks,
  buildUsage,
  contentCharLen,
  estimateAnthropicChars,
  trimAnthropicMessages,
} from "./lib/format-converter.mjs";
import { buildTokenPool, createTokenPoolManager } from "./lib/token-pool.mjs";
import { createFallbackClient } from "./lib/fallback-client.mjs";
import { createWorkerRouter } from "./lib/worker-router.mjs";
import { createAnthropicClient } from "./lib/anthropic-client.mjs";
import { createWorkerState } from "./lib/worker-state.mjs";
import { createTokenHealthProbe } from "./lib/token-health-probe.mjs";
import { createTokenHealthManager } from "./lib/token-health-manager.mjs";
import { createCliRunner } from "./lib/cli-runner.mjs";
import { createAdminRoutes } from "./lib/admin-routes.mjs";
import { createRequestHandler } from "./lib/request-handler.mjs";
import { anthropicToOpenAI, openAIToAnthropic, openAIStreamToAnthropic } from "./lib/anthropic-compat.mjs";

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
const LOAD_BALANCE_ENABLED = CONFIG.routing.loadBalance ?? false;
const ALLOW_EXPLICIT_TOKEN_OVERRIDE = CONFIG.routing.allowExplicitTokenOverride ?? true;

const _workerPool = CONFIG.workers;
const _enabledWorkers = () => _workerPool.filter(w => !w.disabled);

// Worker health controller (initialized after eventLog is available)
let workerHealth = null;

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

// Token pool for API direct — managed by lib/token-pool.mjs
const TOKEN_POOL = buildTokenPool(_workerPool);
// Token health manager: unified state machine for per-token health
const tokenHealthManager = createTokenHealthManager({
  tokenPool: TOKEN_POOL,
  ...CONFIG.tokenHealth,
  eventLog: null,  // bound later via setEventLog() after eventLog is initialized
  log: console.log,
});

const tokenPoolManager = createTokenPoolManager(TOKEN_POOL, { healthManager: tokenHealthManager });
const { getNextToken, setTokenCooldown, getTokenCooldownMs, waitForTokenCooldown, captureUnifiedRateHeaders, getUnifiedRateLimits, getTokenRoutingSnapshot, markTokenAuthError, clearTokenAuthError } = tokenPoolManager;

// ── Token refresher: auto-refresh OAuth tokens on 401 + proactive pre-expiry ──
const tokenRefresher = createTokenRefresher({
  tokenPool: TOKEN_POOL,
  configPath: join(__dirname, "proxy.config.json"),
  ...CONFIG.tokenRefresh,
  claudeBin: CLAUDE_BIN,
});

// ── Token health probe: periodic lightweight probes to verify token validity ──
const tokenHealthProbe = createTokenHealthProbe({
  tokenPool: TOKEN_POOL,
  apiBase: ANTHROPIC_API_BASE,
  apiVersion: ANTHROPIC_API_VERSION,
  modelIds: ANTHROPIC_MODEL_IDS,
  intervalMs: CONFIG.tokenHealth.healthyProbeMs,
  tokenRefresher,
  captureUnifiedRateHeaders,
  setTokenCooldown,
  markTokenAuthError,
  clearTokenAuthError,
  healthManager: tokenHealthManager,
  log: console.log,
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

let storageBackend = null;
let cacheStatsStore = null;
let sessionStatsStore = null;
let workerStatsStore = null;
let workerStatsSaveTimer = null;

function scheduleWorkerStatsPersist() {
  if (!workerStatsStore) return;
  if (workerStatsSaveTimer) return;
  workerStatsSaveTimer = setTimeout(() => {
    workerStatsSaveTimer = null;
    workerStatsStore.save(workerStats);
  }, 1000);
  if (workerStatsSaveTimer.unref) workerStatsSaveTimer.unref();
}

function recordWorkerRequest(workerName) {
  const w = workerStats.traffic[workerName];
  if (w) { w.requests++; w.lastReqAt = Date.now(); }
  scheduleWorkerStatsPersist();
}
function recordWorkerError(workerName, category, detail) {
  const w = workerStats.traffic[workerName];
  if (w) w.errors++;
  if (workerStats.errors[category] !== undefined) workerStats.errors[category]++;
  else workerStats.errors.other++;
  workerStats.recentErrors.push({ ts: Date.now(), worker: workerName, category, detail: (detail || "").slice(0, 200) });
  if (workerStats.recentErrors.length > 100) workerStats.recentErrors.shift();
  if (category && category !== "rate_limit") {
    workerHealth?.recordFailure(workerName, category);
  }
  scheduleWorkerStatsPersist();
}

function computeWorkerWindowStats(windowMs = 60 * 60 * 1000) {
  return metricsController?.computeWorkerWindowStats(windowMs) || { windowMs, traffic: {}, samples: 0 };
}

function seedWorkerStatsFromHistory() {
  return metricsController?.seedWorkerStatsFromHistory() || false;
}

// Cache stats: prompt caching eligibility + TTFT comparison
function recordCacheCandidate(count) {
  cacheStatsStore?.recordCacheCandidate(count);
}
function recordCacheApplied(count) {
  cacheStatsStore?.recordCacheApplied(count);
}
function recordCacheKey(cacheKeyHash) {
  if (!cacheStatsStore) return { seen: false };
  return cacheStatsStore.recordCacheKey(cacheKeyHash);
}
function recordCacheTtft(ttftMs, cached) {
  cacheStatsStore?.recordCacheTtft(ttftMs, cached);
}
function getCacheStats() {
  return cacheStatsStore?.getCacheStats?.() || {
    candidates: 0,
    applied: 0,
    hits: 0,
    misses: 0,
    hitRate: "0%",
    lastHitAt: null,
    lastHitIso: null,
    ttftCachedAvg: null,
    ttftUncachedAvg: null,
    recentKeys: 0,
  };
}

function getSessionIdForStats(req) {
  return req?.headers?.["x-session-id"] || "";
}

// load balance mode managed by WorkerHealthController

// Worker routing — managed by lib/worker-router.mjs (initialized after workerHealth + sessionAffinity)
let workerRouter = null; // set after module init below
// Forward declarations to bridge with workerRouter (set after initialization)
let getNextWorker, workerAcquire, workerRelease;

function markWorkerLimited(workerName, errText = "") {
  workerHealth?.markLimited(workerName, errText);
}

function markWorkerRecovered(workerName, reason = "cooldown_expired") {
  workerHealth?.markRecovered(workerName, reason);
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
  return workerHealth?.isHealthy(name);
}

// Health check timer: every HEALTH_CHECK_MS, try to recover limited workers
setInterval(() => {
  workerHealth?.tick();
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
    const liveToken = tokenRefresher?.getActiveToken(worker.name) || worker.token;
    env.CLAUDE_CODE_OAUTH_TOKEN = liveToken;
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
  redis = await createRedisClient(CONFIG.redis);
  console.log("[Redis] Connected and ready");
} catch (err) {
  console.warn(`[Redis] Connection failed: ${err.message} — running in memory-only mode`);
  redis = null;
}

// Unified storage backend (Redis-first, local fallback)
const CACHE_KEY_MAX_ENTRIES = CONFIG.cacheControl?.keyMaxEntries ?? 5000;
const storageController = createStorageController({
  redis,
  storageConfig: { backend: CONFIG.storage?.backend || "redis" },
  cacheConfig: { keyMaxEntries: CACHE_KEY_MAX_ENTRIES },
  sessionConfig: CONFIG.sessionStats,
});
await storageController.init();
storageBackend = storageController.storage;
cacheStatsStore = storageController.cacheStats;
workerStatsStore = storageController.workerStatsStore;
sessionStatsStore = storageController.sessionStats;

// Seed worker stats from storage snapshot if available
const storedWorkerStats = workerStatsStore.get();
if (storedWorkerStats?.traffic) {
  for (const [name, stats] of Object.entries(storedWorkerStats.traffic)) {
    if (!workerStats.traffic[name]) {
      workerStats.traffic[name] = { requests: 0, errors: 0, lastReqAt: null };
    }
    workerStats.traffic[name].requests = stats.requests || stats.r || 0;
    workerStats.traffic[name].errors = stats.errors || stats.e || 0;
    workerStats.traffic[name].lastReqAt = stats.lastReqAt || stats.last || null;
  }
}
if (storedWorkerStats?.errors) {
  workerStats.errors = { ...workerStats.errors, ...storedWorkerStats.errors };
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
tokenHealthManager.setEventLog?.(eventLog);
const tokenTracker = createTokenTracker({ redis });

// Worker health controller: rate-limit cooldown + circuit breaker
workerHealth = createWorkerHealthController({
  workers: _workerPool,
  primaryWorker: PRIMARY_WORKER,
  healthCheckMs: HEALTH_CHECK_MS,
  loadBalanceEnabled: LOAD_BALANCE_ENABLED,
  circuitFailThreshold: CONFIG.workerHealth?.circuitFailThreshold ?? 3,
  circuitOpenMs: CONFIG.workerHealth?.circuitOpenMs ?? 60_000,
  circuitWindowMs: CONFIG.workerHealth?.circuitWindowMs ?? 60_000,
  eventLog,
});

// Metrics store: persistent time-series data for dashboard charts
const metricsStore = createMetricsStore({ redis });

// ── Auto-heal manager: request-level auth recovery for CLI workers ──
const autoHeal = createAutoHealManager({
  enabled: CONFIG.autoHeal?.enabled ?? true,
  cooldownMs: CONFIG.autoHeal?.cooldownMs,
  circuitFailThreshold: CONFIG.autoHeal?.circuitFailThreshold,
  circuitOpenMs: CONFIG.autoHeal?.circuitOpenMs,
  tokenRefresher,
  tokenPool: TOKEN_POOL,
  eventLog,
  workerHealth, // unified circuit breaker
});

// System reaper: periodic cleanup of orphan OS processes
const systemReaper = createSystemReaper(CONFIG.systemReaper);

// Session affinity: sticky routing for conversation sessions
const sessionAffinity = createSessionAffinity({ ttlMs: CONFIG.sessionAffinity?.ttlMs ?? 30 * 60 * 1000 });

// Worker router: least-connections with session affinity tiebreaker
workerRouter = createWorkerRouter({
  workerPool: _workerPool,
  primaryWorker: PRIMARY_WORKER,
  getWorkerHealth: () => workerHealth,
  getSessionAffinity: () => sessionAffinity,
  workerStats,
  getUnifiedRateLimits,
});
getNextWorker = workerRouter.getNextWorker;
workerAcquire = workerRouter.workerAcquire;
workerRelease = workerRouter.workerRelease;
const _activeConns = workerRouter.getActiveConnections();

// Worker state: runtime disable/enable with graceful drain
const workerState = createWorkerState({
  workerPool: _workerPool,
  configPath: join(__dirname, "proxy.config.json"),
  getActiveConns: (name) => _activeConns.get(name) || 0,
  drainTimeoutMs: 60_000,
  eventLog,
  log: (msg) => console.log(`[${ts()}] ${msg}`),
});

// Warm worker pool: pre-spawns CLI processes to eliminate 2-5s cold start
const warmPool = createWarmPool({
  maxWarmPerKey: WARM_POOL_SIZE,
  maxWarmAgeMs: WARM_POOL_MAX_AGE_MS,
  enabled: WARM_POOL_ENABLED,
  buildArgs: (model, isStream) => buildCliArgs(null, model, null, isStream),
  buildEnv: (worker) => workerEnv(worker),
  log: (msg) => console.log(`[${ts()}] ${msg}`),
});

function _getWorkerTokenReason(worker) {
  const now = Date.now();
  if (worker.disabled) return worker.disabledReason || "disabled";
  if (!worker.token && !worker.refreshToken) return "no token";
  if (worker.expiresAt && worker.expiresAt > 0 && worker.expiresAt <= now) return "expired";
  return null;
}

const metricsController = createMetricsController({
  metricsStore,
  queue,
  registry,
  rateLimiter,
  tokenTracker,
  sessionStatsStore,
  cacheStatsStore,
  workerHealth,
  autoHeal,
  config: CONFIG,
  workerStats,
  sessionAffinity,
  systemReaper,
  getUnifiedRateLimits,
  tokenRefresher,
  activeConnections: _activeConns,
  getWorkerTokenReason: _getWorkerTokenReason,
  tokenHealthProbe,
  getTokenRoutingSnapshot: () => getTokenRoutingSnapshot(tokenHealthProbe?.getResults),
  tokenHealthManager,
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
    workerStats: {
      traffic: Object.fromEntries(
        Object.entries(workerStats.traffic).map(([name, stats]) => [
          name,
          { requests: stats.requests, errors: stats.errors, lastReqAt: stats.lastReqAt || null },
        ])
      ),
    },
    sessionAffinity: sessionAffinity.getStats(),
    systemReaper: systemReaper.getStats(),
    cache: getCacheStats(),
    warmPool: warmPool.status(),
    tokenProbe: tokenHealthProbe.getResults(),
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

// ── Format converter wrappers: bind config to extracted pure functions ──
const _cacheConfig = Object.freeze({ ...CONFIG.cacheControl });
function extractPrompt(messages) { return _extractPrompt(messages, MAX_PROMPT_CHARS); }
function buildCacheContext(args) { return _buildCacheContext({ ...args, cacheConfig: _cacheConfig }); }
function buildAnthropicSystemBlocks(systemText, cacheCtx) { return _buildAnthropicSystemBlocks(systemText, cacheCtx, _cacheConfig); }

function getSessionIdFromRequest(req, body) {
  return req?.headers?.["x-session-id"] || body?.session_id || "";
}

// CLI runner — extracted to lib/cli-runner.mjs (initialized after all deps are ready, see below)

// Worker routing delegated to workerRouter (initialized below)
function getWorkerByName(name) { return workerRouter?.getWorkerByName(name) || null; }
function getAlternateWorker(excludeName) { return workerRouter?.getAlternateWorker(excludeName) || null; }

function getAllLimitedStatus() {
  return workerHealth?.getAllLimitedStatus() || null;
}

function formatLimitNotice(resetAt) {
  if (!resetAt) return `[Claude limit reached — switching to ${FALLBACK_API.name} fallback]`;
  const t = new Date(resetAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `[Claude limit reached — switching to ${FALLBACK_API.name} fallback until ${t}]`;
}

// Fallback client — initialized lazily after eventLog/tokenTracker are ready
let fallbackClient = null;
function streamFromFallbackApi(messages, model, reqId, source, res) {
  if (!fallbackClient) {
    fallbackClient = createFallbackClient({
      fallbackApi: FALLBACK_API,
      timeoutMs: FALLBACK_TIMEOUT_MS,
      sseChunk,
      log: (msg) => console.log(`[${ts()}] ${msg}`),
      recordWorkerError,
      tokenTracker,
      eventLog,
      sseBroadcast,
    });
  }
  return fallbackClient.streamFromFallbackApi(messages, model, reqId, source, res);
}
function fetchFallbackSync(messages, model, reqId, source) {
  if (!fallbackClient) {
    fallbackClient = createFallbackClient({
      fallbackApi: FALLBACK_API,
      timeoutMs: FALLBACK_TIMEOUT_MS,
      sseChunk,
      log: (msg) => console.log(`[${ts()}] ${msg}`),
      recordWorkerError,
      tokenTracker,
      eventLog,
      sseBroadcast,
    });
  }
  return fallbackClient.fetchFallbackSync(messages, model, reqId, source);
}

// Anthropic client — initialized lazily after all dependencies are ready
let anthropicClient = null;
function getAnthropicClient() {
  if (!anthropicClient) {
    anthropicClient = createAnthropicClient({
      apiBase: ANTHROPIC_API_BASE,
      apiVersion: ANTHROPIC_API_VERSION,
      modelIds: ANTHROPIC_MODEL_IDS,
      maxPromptTokens: MAX_PROMPT_TOKENS,
      defaultMaxTokens: CONFIG.anthropic.defaultMaxTokens,
      rateLimitRetryMs: CONFIG.retry.rateLimitRetryMs,
      serverErrorRetryMs: CONFIG.retry.serverErrorRetryMs,
      syncTimeoutMs: SYNC_TIMEOUT_MS,
      cacheConfig: _cacheConfig,
      tokenRefresher,
      captureUnifiedRateHeaders,
      setTokenCooldown,
      recordWorkerError,
      recordCacheTtft,
      getCacheStats,
      sseChunk,
      sseToolCallStartChunk,
      sseToolCallDeltaChunk,
      sseFinishChunk,
      convertToolsToAnthropic,
      convertMessagesToAnthropic,
      tokenTracker,
      eventLog,
      sseBroadcast,
      markTokenAuthError,
      clearTokenAuthError,
      healthManager: tokenHealthManager,
      log: console.log,
    });
  }
  return anthropicClient;
}
function streamFromAnthropicDirect(body, model, reqId, source, res, release, tokenEntry, cacheCtx) {
  return getAnthropicClient().streamFromAnthropicDirect(body, model, reqId, source, res, release, tokenEntry, cacheCtx);
}
function callAnthropicDirect(body, model, reqId, source, tokenEntry, cacheCtx) {
  return getAnthropicClient().callAnthropicDirect(body, model, reqId, source, tokenEntry, cacheCtx);
}
function streamAnthropicNative(body, reqId, source, res, release, tokenEntry, cacheCtx) {
  return getAnthropicClient().streamAnthropicNative(body, reqId, source, res, release, tokenEntry, cacheCtx);
}
function callAnthropicNative(body, reqId, source, tokenEntry, cacheCtx) {
  return getAnthropicClient().callAnthropicNative(body, reqId, source, tokenEntry, cacheCtx);
}

// ============================================================
// Extracted modules — initialized after all dependencies are available
// ============================================================

const cliRunner = createCliRunner({
  getNextWorker,
  workerAcquire,
  workerRelease,
  getAlternateWorker: (name) => workerRouter?.getAlternateWorker(name) || null,
  sessionAffinity,
  recordWorkerRequest,
  recordWorkerError,
  isRateLimitError,
  markWorkerLimited,
  warmPool,
  registry,
  eventLog,
  retryPolicy,
  autoHeal,
  classifyCliError,
  workerEnv,
  syncTimeoutMs: SYNC_TIMEOUT_MS,
  maxRetries: MAX_RETRIES,
  config: CONFIG,
});

const adminRoutes = createAdminRoutes({
  config: CONFIG,
  queue,
  registry,
  workerHealth,
  autoHeal,
  sessionAffinity,
  systemReaper,
  warmPool,
  eventLog,
  tokenTracker,
  metricsStore,
  metricsController,
  workerStats,
  workerState,
  tokenRefresher,
  tokenPool: TOKEN_POOL,
  modelMap: MODEL_MAP,
  redis,
  getCacheStats,
  sendJson,
  sendError,
  readBody,
  staticDir: __dirname,
  port: PORT,
  maxBodyBytes: MAX_BODY_BYTES,
  getSseClients: () => sseClients,
  setSseClients: (s) => { sseClients = s; },
});

const requestHandler = createRequestHandler({
  config: CONFIG,
  queue,
  rateLimiter,
  sessionAffinity,
  eventLog,
  tokenTracker,
  autoHeal,
  tokenPool: TOKEN_POOL,
  workerPool: _workerPool,
  modelPriority: MODEL_PRIORITY,
  resolveModel,
  getNextToken,
  waitForTokenCooldown,
  getNextWorker,
  workerAcquire,
  workerRelease,
  getAlternateWorker: (name) => workerRouter?.getAlternateWorker(name) || null,
  extractPrompt,
  buildCacheContext,
  recordCacheCandidate,
  recordCacheApplied,
  recordCacheKey,
  getCacheStats,
  recordWorkerRequest,
  recordWorkerError,
  isRateLimitError,
  markWorkerLimited,
  isWorkerHealthy,
  getAllLimitedStatus: () => workerHealth?.getAllLimitedStatus() || null,
  formatLimitNotice,
  streamFromAnthropicDirect,
  callAnthropicDirect,
  streamAnthropicNative,
  callAnthropicNative,
  streamFromFallbackApi,
  fetchFallbackSync,
  cliRunner,
  sseChunk,
  sseBroadcast,
  sendJson,
  sendError,
  readBody,
  identifySource,
  getSessionIdForStats: (req) => getSessionIdForStats(req),
  sessionStatsStore,
  registry,
  buildUsage,
  completionResponse,
  completionResponseWithTools,
  heartbeatByModel: HEARTBEAT_BY_MODEL,
  defaultHeartbeatMs: DEFAULT_HEARTBEAT_MS,
  streamTimeoutMs: STREAM_TIMEOUT_MS,
  maxBodyBytes: MAX_BODY_BYTES,
  quickFailMs: CONFIG.retry.quickFailMs,
  maxRateWaitMs: CONFIG.retry.maxRateWaitMs,
  serverErrorRetryMs: CONFIG.retry.serverErrorRetryMs,
  allowExplicitTokenOverride: ALLOW_EXPLICIT_TOKEN_OVERRIDE,
  useCliAgents: USE_CLI_AGENTS,
  enabledWorkers: _enabledWorkers,
  classifyCliError,
});

// ============================================================
// Utilities
// ============================================================

function ts() {
  return new Date().toISOString();
}

function classifyErrorCategory(type = "", status = 500) {
  const t = String(type).toLowerCase();
  if (t.includes("auth") || t.includes("unauthorized")) return "auth";
  if (t.includes("rate") || t.includes("queue")) return "rate_limit";
  if (t.includes("timeout")) return "timeout";
  if (t.includes("upstream") || t.includes("api")) return "upstream";
  if (status === 401) return "auth";
  if (status === 429 || status === 503) return "rate_limit";
  if (status === 504) return "timeout";
  return "internal";
}

function sendError(res, status, { message, type = "internal_error", ...extra } = {}, extraHeaders = {}) {
  const category = classifyErrorCategory(type, status);
  sendJson(res, status, {
    error: {
      message,
      type,
      category,
      code: category,
      ...extra,
    },
  }, extraHeaders);
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
    return sendError(res, 401, { message: "Unauthorized", type: "unauthorized" });
  }

  try {
    if (url.pathname === "/v1/messages" && req.method === "POST") {
      // Native Anthropic /v1/messages — direct pass-through, no format conversion
      await requestHandler.handleAnthropicMessages(req, res);
    } else if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      await requestHandler.handleCompletions(req, res);
    } else if (url.pathname === "/v1/models" && req.method === "GET") {
      adminRoutes.handleModels(req, res);
    } else if (url.pathname === "/health" && req.method === "GET") {
      adminRoutes.handleHealth(req, res);
    } else if (url.pathname === "/metrics" && req.method === "GET") {
      await adminRoutes.handleMetrics(req, res);
    } else if (url.pathname === "/rate-limits" && req.method === "GET") {
      await adminRoutes.handleMetrics(req, res); // backward compat
    } else if (url.pathname === "/zombies" && req.method === "GET") {
      adminRoutes.handleZombies(req, res);
    } else if (url.pathname === "/zombies" && req.method === "POST") {
      await adminRoutes.handleKillZombie(req, res);
    } else if (url.pathname === "/system-reaper" && req.method === "GET") {
      adminRoutes.handleSystemReaper(req, res);
    } else if (url.pathname === "/system-reaper" && req.method === "POST") {
      await adminRoutes.handleSystemReaperSweep(req, res);
    } else if (url.pathname === "/warm-pool" && req.method === "GET") {
      adminRoutes.handleWarmPool(req, res);
    } else if (url.pathname === "/events" && req.method === "GET") {
      adminRoutes.handleEvents(req, res, url);
    } else if (url.pathname === "/metrics/history" && req.method === "GET") {
      adminRoutes.handleMetricsHistory(req, res, url);
    } else if (url.pathname === "/stream" && req.method === "GET") {
      adminRoutes.handleSSEStream(req, res);
    } else if (url.pathname === "/token-refresh" && req.method === "POST") {
      await adminRoutes.handleTokenRefresh(req, res);
    } else if (url.pathname.match(/^\/workers\/([^/]+)\/disable$/) && req.method === "POST") {
      const workerName = url.pathname.match(/^\/workers\/([^/]+)\/disable$/)[1];
      await adminRoutes.handleWorkerDisable(req, res, workerName);
    } else if (url.pathname.match(/^\/workers\/([^/]+)\/enable$/) && req.method === "POST") {
      const workerName = url.pathname.match(/^\/workers\/([^/]+)\/enable$/)[1];
      await adminRoutes.handleWorkerEnable(req, res, workerName);
    } else if (url.pathname === "/workers" && req.method === "GET") {
      adminRoutes.handleWorkersList(req, res);
    } else if (url.pathname === "/dashboard/proxy" || url.pathname === "/dashboard/proxy/") {
      await adminRoutes.handleProxyDashboard(req, res);
    } else if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
      await adminRoutes.handlePortal(req, res);
    } else {
      sendError(res, 404, { message: "Not found", type: "not_found" });
    }
  } catch (err) {
    console.error(`[${ts()}] UNHANDLED ${err.message}`);
    sendError(res, 500, { message: "Internal server error", type: "internal_error" });
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
  tokenHealthProbe.destroy();

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

  // Restore worker traffic counts across restarts (best-effort)
  seedWorkerStatsFromHistory();

  metricsStore.startSampler(gatherMetricsSnapshot);
  tokenRefresher.start();
  tokenHealthProbe.start();

  // Pre-warm worker pool: spawn processes for the most common configs
  if (WARM_POOL_ENABLED) {
    const prewarmConfigs = [];
    const enabled = _enabledWorkers();
    const pool = enabled.length > 0 ? enabled : _workerPool;
    for (const worker of pool) {
      // Pre-warm sync sonnet (most common: batch labeler, general queries)
      prewarmConfigs.push({ model: "sonnet", isStream: false, worker, count: 1 });
      // Pre-warm stream sonnet (most common streaming config)
      prewarmConfigs.push({ model: "sonnet", isStream: true, worker, count: 1 });
    }
    warmPool.prewarm(prewarmConfigs);
    console.log(`[WarmPool] Pre-warmed ${prewarmConfigs.length} worker(s) across ${pool.length} CLI router(s)`);
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
