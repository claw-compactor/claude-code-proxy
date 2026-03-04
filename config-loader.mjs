/**
 * Config Loader — single source of truth for proxy configuration.
 *
 * Priority (highest → lowest):
 *   1. Environment variable override (for debugging only)
 *   2. openclaw.json shared values (model aliases, fallback config)
 *   3. proxy.config.json file values (proxy-specific: workers, queue, rate limits)
 *   4. Hardcoded defaults (last resort)
 *
 * Shared values from openclaw.json (single source of truth):
 *   - Model alias → Anthropic model ID mapping
 *   - Fallback API config (minimax-local)
 *   - Proxy auth token (provider apiKey)
 *
 * Usage:
 *   import { loadConfig } from "./config-loader.mjs";
 *   const CONFIG = loadConfig();
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "proxy.config.json");
const OPENCLAW_HOME = join(process.env.HOME || "", ".openclaw");
const OPENCLAW_JSON = join(OPENCLAW_HOME, "openclaw.json");

/**
 * Read a nested path from an object.
 * e.g. get(obj, "queue.maxConcurrent") → obj.queue.maxConcurrent
 */
function get(obj, path) {
  return path.split(".").reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

/**
 * Resolve a value with env override.
 * @param {object} file  - Parsed proxy.config.json
 * @param {string} path  - Dot-separated path into file (e.g. "queue.maxConcurrent")
 * @param {string} envKey - Environment variable name to check first
 * @param {*} fallback   - Hardcoded default if both file and env are missing
 * @param {function} [parse] - Optional parser (parseInt, JSON.parse, etc.)
 */
function resolve(file, path, envKey, fallback, parse) {
  const envVal = process.env[envKey];
  if (envVal !== undefined && envVal !== "") {
    return parse ? parse(envVal) : envVal;
  }
  const fileVal = get(file, path);
  if (fileVal !== undefined) {
    return fileVal;
  }
  return fallback;
}

const toInt = (v) => parseInt(v, 10);
const toBool = (v) => v === "true" || v === "1";
const toJSON = (v) => JSON.parse(v);

/**
 * Load shared config from ~/.openclaw/openclaw.json.
 * Returns parsed object or empty object if unavailable.
 * This is the gateway's authoritative config — we only read shared values.
 */
function loadOpenclawConfig() {
  try {
    const raw = readFileSync(OPENCLAW_JSON, "utf-8");
    const parsed = JSON.parse(raw);
    console.log(`[Config] Loaded shared config: ${OPENCLAW_JSON}`);
    return parsed;
  } catch (err) {
    console.warn(
      `[Config] openclaw.json not available (${err.code || err.message}), ` +
      `using proxy.config.json only`
    );
    return {};
  }
}

/**
 * Extract the minimax-local (or other) fallback provider from openclaw.json.
 * Looks for any provider that is NOT "claude-code".
 */
function extractFallbackFromOpenclaw(oc) {
  const providers = get(oc, "models.providers") || {};
  for (const [name, provider] of Object.entries(providers)) {
    if (name === "claude-code") continue;
    const firstModel = (provider.models || [])[0];
    if (provider.baseUrl && firstModel) {
      return {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey || "none",
        model: firstModel.id,
        name,
      };
    }
  }
  return null;
}

/**
 * Parse SOURCE_CONCURRENCY_LIMITS from "key:val,key:val" string format.
 */
function parseSourceLimits(raw) {
  const limits = {};
  for (const part of raw.split(",").filter(Boolean)) {
    const [src, max] = part.split(":");
    if (src && max) limits[src.trim()] = parseInt(max.trim(), 10);
  }
  return limits;
}

/**
 * Validate that proxy config and openclaw.json agree on shared values.
 * Logs warnings (non-fatal) for any drift detected.
 */
function validateCrossConfig(oc, proxyFile, resolved) {
  if (!oc || Object.keys(oc).length === 0) return;

  const warnings = [];

  // Check: proxy authToken matches openclaw provider apiKey
  const ocApiKey = get(oc, "models.providers.claude-code.apiKey");
  if (ocApiKey && resolved.authToken !== ocApiKey) {
    warnings.push(
      `AUTH_DRIFT: openclaw.json apiKey="${ocApiKey}" ≠ proxy authToken="${resolved.authToken}"`
    );
  }

  // Check: proxy port matches openclaw provider baseUrl
  const ocBaseUrl = get(oc, "models.providers.claude-code.baseUrl") || "";
  const portMatch = ocBaseUrl.match(/:(\d+)/);
  if (portMatch && parseInt(portMatch[1], 10) !== resolved.port) {
    warnings.push(
      `PORT_DRIFT: openclaw.json baseUrl port=${portMatch[1]} ≠ proxy port=${resolved.port}`
    );
  }

  // Check: cron model references exist in openclaw allowlist
  try {
    const cronPath = join(OPENCLAW_HOME, "cron", "jobs.json");
    const cronData = JSON.parse(readFileSync(cronPath, "utf-8"));
    const allowlist = Object.keys(get(oc, "agents.defaults.models") || {});
    for (const job of (cronData.jobs || [])) {
      const model = get(job, "payload.model");
      if (model && allowlist.length > 0 && !allowlist.includes(model)) {
        warnings.push(
          `CRON_MODEL_MISSING: job "${job.name}" model="${model}" not in allowlist [${allowlist.join(", ")}]`
        );
      }
    }
  } catch {
    // cron/jobs.json may not exist — that's fine
  }

  if (warnings.length > 0) {
    console.warn(`[Config] ⚠️  Cross-config drift detected:`);
    for (const w of warnings) console.warn(`  - ${w}`);
  } else {
    console.log(`[Config] ✅ Cross-config validation OK`);
  }
}

/**
 * Load and validate configuration.
 * Returns a frozen config object.
 */
export function loadConfig() {
  let file = {};

  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    file = JSON.parse(raw);
    console.log(`[Config] Loaded ${CONFIG_PATH}`);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(`[FATAL] Config file not found: ${CONFIG_PATH}`);
      console.error(`[FATAL] Create proxy.config.json or set all required env vars.`);
      process.exit(78); // EX_CONFIG
    }
    console.error(`[FATAL] Failed to parse ${CONFIG_PATH}: ${err.message}`);
    process.exit(78);
  }

  // --- Load shared config from openclaw.json ---
  const oc = loadOpenclawConfig();

  // --- Resolve all values with env override support ---

  const workers = resolve(file, "workers", "WORKERS", [], toJSON);
  const port = resolve(file, "server.port", "CLAUDE_PROXY_PORT", 8403, toInt);
  // Auth token: openclaw.json provider apiKey is authoritative
  const ocAuthToken = get(oc, "models.providers.claude-code.apiKey");
  const authToken = resolve(file, "server.authToken", "PROXY_AUTH_TOKEN", ocAuthToken || "local-proxy");

  const primaryWorker = resolve(file, "routing.primaryWorker", "PRIMARY_WORKER", "1");
  const useCliAgents = resolve(file, "routing.useCliAgents", "USE_CLI_AGENTS", true, toBool);
  const healthCheckMs = resolve(file, "routing.healthCheckMs", "HEALTH_CHECK_MS", 600000, toInt);

  const maxConcurrent = resolve(file, "queue.maxConcurrent", "MAX_CONCURRENT", 20, toInt);
  const maxQueueTotal = resolve(file, "queue.maxQueueTotal", "MAX_QUEUE_TOTAL", 200, toInt);
  const maxQueuePerSource = resolve(file, "queue.maxQueuePerSource", "MAX_QUEUE_PER_SOURCE", 50, toInt);
  const queueTimeoutMs = resolve(file, "queue.queueTimeoutMs", "QUEUE_TIMEOUT_MS", 300000, toInt);

  // Source concurrency: env is "key:val,key:val" string, file is object
  let sourceConcurrencyLimits;
  if (process.env.SOURCE_CONCURRENCY_LIMITS) {
    sourceConcurrencyLimits = parseSourceLimits(process.env.SOURCE_CONCURRENCY_LIMITS);
  } else {
    sourceConcurrencyLimits = get(file, "queue.sourceConcurrencyLimits") || {};
  }
  const defaultSourceConcurrency = resolve(file, "queue.defaultSourceConcurrency", "DEFAULT_SOURCE_CONCURRENCY", 0, toInt);

  const streamTimeoutMs = resolve(file, "timeouts.streamTimeoutMs", "STREAM_TIMEOUT_MS", 7200000, toInt);
  const syncTimeoutMs = resolve(file, "timeouts.syncTimeoutMs", "SYNC_TIMEOUT_MS", 1800000, toInt);

  const maxRetries = resolve(file, "retry.maxRetries", "MAX_RETRIES", 3, toInt);
  const retryBaseMs = resolve(file, "retry.retryBaseMs", "RETRY_BASE_MS", 2000, toInt);

  const maxProcessAgeMs = resolve(file, "process.maxProcessAgeMs", "MAX_PROCESS_AGE_MS", 7200000, toInt);
  const maxIdleMs = resolve(file, "process.maxIdleMs", "MAX_IDLE_MS", 3600000, toInt);
  const reaperIntervalMs = resolve(file, "process.reaperIntervalMs", "REAPER_INTERVAL_MS", 15000, toInt);

  const warmPoolEnabled = resolve(file, "warmPool.enabled", "WARM_POOL_ENABLED", true, toBool);
  const warmPoolSize = resolve(file, "warmPool.size", "WARM_POOL_SIZE", 2, toInt);
  const warmPoolMaxAgeMs = resolve(file, "warmPool.maxAgeMs", "WARM_POOL_MAX_AGE_MS", 300000, toInt);

  const sessionAffinityTtlMs = resolve(file, "sessionAffinity.ttlMs", "SESSION_AFFINITY_TTL_MS", 30 * 60 * 1000, toInt);

  const cacheControl = {
    enabled: resolve(file, "cacheControl.enabled", "CACHE_CONTROL_ENABLED", true, toBool),
    systemPrefixChars: resolve(file, "cacheControl.systemPrefixChars", "CACHE_CONTROL_SYSTEM_PREFIX_CHARS", 1200, toInt),
    minSystemPrefixChars: resolve(file, "cacheControl.minSystemPrefixChars", "CACHE_CONTROL_MIN_SYSTEM_PREFIX_CHARS", 200, toInt),
    keyMaxEntries: resolve(file, "cacheControl.keyMaxEntries", "CACHE_CONTROL_KEY_MAX_ENTRIES", 5000, toInt),
  };

  const rateLimits = get(file, "rateLimits") || {
    sonnet: { requestsPerMin: 57, tokensPerMin: 190000 },
    opus: { requestsPerMin: 28, tokensPerMin: 57000 },
    haiku: { requestsPerMin: 95, tokensPerMin: 380000 },
  };

  const anthropicApiBase = resolve(file, "anthropic.apiBase", "ANTHROPIC_API_BASE", "https://api.anthropic.com");
  const anthropicApiVersion = resolve(file, "anthropic.apiVersion", "ANTHROPIC_API_VERSION", "2023-06-01");
  // Model IDs: proxy.config.json is authoritative for Anthropic model IDs.
  // These are the actual Anthropic API model strings (e.g., "claude-sonnet-4-6").
  const anthropicModels = {
    sonnet: resolve(file, "anthropic.models.sonnet", "ANTHROPIC_SONNET_MODEL", "claude-sonnet-4-6"),
    opus: resolve(file, "anthropic.models.opus", "ANTHROPIC_OPUS_MODEL", "claude-opus-4-6"),
    haiku: resolve(file, "anthropic.models.haiku", "ANTHROPIC_HAIKU_MODEL", "claude-haiku-4-5-20251001"),
  };

  // Fallback API: openclaw.json provider definitions are authoritative
  let fallback;
  if (process.env.FALLBACK_API_URL) {
    fallback = {
      baseUrl: process.env.FALLBACK_API_URL,
      apiKey: process.env.FALLBACK_API_KEY || "none",
      model: process.env.FALLBACK_MODEL || "default",
      name: process.env.FALLBACK_NAME || "fallback",
    };
  } else {
    const ocFallback = extractFallbackFromOpenclaw(oc);
    fallback = get(file, "fallback") || ocFallback || {
      baseUrl: "http://172.28.216.81:8080/v1",
      apiKey: "none",
      model: "MiniMax-M2.5-Q8_0-00001-of-00006.gguf",
      name: "minimax-local",
    };
  }

  const maxPromptChars = resolve(file, "limits.maxPromptChars", "MAX_PROMPT_CHARS", 50000, toInt);
  const maxPromptTokens = resolve(file, "limits.maxPromptTokens", "MAX_PROMPT_TOKENS", 190000, toInt);
  const maxBodyBytes = resolve(file, "limits.maxBodyBytes", "MAX_BODY_BYTES", 5_000_000, toInt);

  const systemReaper = {
    intervalMs: resolve(file, "systemReaper.intervalMs", "SYSTEM_REAPER_INTERVAL_MS", 300000, toInt),
    shellMaxAgeSec: resolve(file, "systemReaper.shellMaxAgeSec", "SYSTEM_REAPER_SHELL_MAX_AGE", 1800, toInt),
    proxyIdleThresholdSec: resolve(file, "systemReaper.proxyIdleThresholdSec", "SYSTEM_REAPER_PROXY_IDLE", 600, toInt),
    cliMinAgeSec: resolve(file, "systemReaper.cliMinAgeSec", "SYSTEM_REAPER_CLI_MIN_AGE", 300, toInt),
    helperMinAgeSec: resolve(file, "systemReaper.helperMinAgeSec", "SYSTEM_REAPER_HELPER_MIN_AGE", 1800, toInt),
  };

  const heartbeat = {
    opus: resolve(file, "heartbeat.opus", null, 1800000, toInt),
    sonnet: resolve(file, "heartbeat.sonnet", null, 1200000, toInt),
    haiku: resolve(file, "heartbeat.haiku", null, 600000, toInt),
    default: resolve(file, "heartbeat.default", null, 1200000, toInt),
  };

  const dashboard = {
    version: resolve(file, "dashboard.version", null, "0.7.0"),
    refreshMs: resolve(file, "dashboard.refreshMs", null, 2000, toInt),
    historyRefreshMs: resolve(file, "dashboard.historyRefreshMs", null, 10000, toInt),
    reaperRefreshMs: resolve(file, "dashboard.reaperRefreshMs", null, 30000, toInt),
    eventsLimit: resolve(file, "dashboard.eventsLimit", null, 100, toInt),
  };

  const portal = {
    openclawPort: resolve(file, "portal.openclawPort", null, 8877, toInt),
    healthPollMs: resolve(file, "portal.healthPollMs", null, 5000, toInt),
    iframeTimeoutMs: resolve(file, "portal.iframeTimeoutMs", null, 8000, toInt),
  };

  // --- Validation ---

  if (!Array.isArray(workers) || workers.length === 0) {
    console.error(`[FATAL] No workers configured in proxy.config.json or WORKERS env var.`);
    process.exit(78);
  }
  for (const w of workers) {
    if (!w.bin) {
      console.error(`[FATAL] Worker "${w.name || "?"}" missing "bin" field.`);
      process.exit(78);
    }
  }
  if (port < 1 || port > 65535 || isNaN(port)) {
    console.error(`[FATAL] Invalid port: ${port}`);
    process.exit(78);
  }
  if (maxConcurrent < 1) {
    console.error(`[FATAL] maxConcurrent must be >= 1, got ${maxConcurrent}`);
    process.exit(78);
  }

  // Assign default worker names if missing
  const normalizedWorkers = workers.map((w, i) => ({
    ...w,
    name: w.name || String(i + 1),
  }));

  // --- Cross-config drift validation ---
  validateCrossConfig(oc, file, { port, authToken });

  const config = {
    server: { port, authToken },
    workers: normalizedWorkers,
    routing: { primaryWorker, useCliAgents, healthCheckMs },
    queue: {
      maxConcurrent,
      maxQueueTotal,
      maxQueuePerSource,
      queueTimeoutMs,
      sourceConcurrencyLimits,
      defaultSourceConcurrency,
    },
    timeouts: { streamTimeoutMs, syncTimeoutMs },
    retry: { maxRetries, retryBaseMs },
    process: { maxProcessAgeMs, maxIdleMs, reaperIntervalMs },
    warmPool: { enabled: warmPoolEnabled, size: warmPoolSize, maxAgeMs: warmPoolMaxAgeMs },
    sessionAffinity: { ttlMs: sessionAffinityTtlMs },
    cacheControl,
    rateLimits,
    anthropic: { apiBase: anthropicApiBase, apiVersion: anthropicApiVersion, models: anthropicModels },
    fallback,
    limits: { maxPromptChars, maxPromptTokens, maxBodyBytes },
    systemReaper,
    heartbeat,
    dashboard,
    portal,
  };

  // Deep freeze to prevent accidental mutation
  function deepFreeze(obj) {
    Object.freeze(obj);
    for (const val of Object.values(obj)) {
      if (val && typeof val === "object" && !Object.isFrozen(val)) {
        deepFreeze(val);
      }
    }
    return obj;
  }

  return deepFreeze(config);
}
