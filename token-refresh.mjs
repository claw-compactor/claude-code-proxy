/**
 * token-refresh.mjs — OAuth Token Auto-Refresh Module
 *
 * Manages OAuth token lifecycle for the Anthropic proxy:
 *   - Detects 401 auth errors and triggers immediate refresh
 *   - Proactively refreshes tokens before expiry (5-min buffer)
 *   - Persists new tokens to proxy.config.json + macOS Keychain
 *   - Coalesces concurrent refresh requests (mutex per token)
 *   - Exponential backoff on refresh failures
 *   - Exposes status for /metrics + dashboard
 */

import { request as httpsRequest } from "node:https";
import { readFile, writeFile, rename } from "node:fs/promises";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// ── Constants ──
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

const DEFAULT_PROACTIVE_MARGIN_MS = 300_000; // 5 min before expiry
const DEFAULT_MAX_BACKOFF_MS = 300_000;      // 5 min max
const PROACTIVE_CHECK_INTERVAL_MS = 60_000;  // check every 60s
const MAX_HISTORY = 20;

// ── Helpers ──
function ts() {
  return new Date().toISOString();
}

function humanDuration(ms) {
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  const s = Math.floor((ms % 60_000) / 1000);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function backoffMs(errorCount, maxMs) {
  const base = Math.min(Math.pow(2, errorCount) * 5000, maxMs);
  const jitter = Math.random() * base * 0.3;
  return Math.round(base + jitter);
}

// ── OAuth HTTP Call ──
function callOAuthRefresh(refreshToken) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
      scope: OAUTH_SCOPES,
    });

    const url = new URL(OAUTH_TOKEN_URL);
    const options = {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    };

    const req = httpsRequest(options, (res) => {
      let body = "";
      res.on("data", (d) => { body += d.toString(); });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode === 200 && data.access_token) {
            resolve({
              accessToken: data.access_token,
              refreshToken: data.refresh_token || refreshToken,
              expiresIn: data.expires_in || 28800,
              organization: data.organization || null,
              account: data.account || null,
            });
          } else {
            reject(new Error(`OAuth refresh failed: HTTP ${res.statusCode} — ${body.slice(0, 300)}`));
          }
        } catch (err) {
          reject(new Error(`OAuth response parse error: ${err.message}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy(new Error("OAuth refresh timeout (15s)"));
    });
    req.write(payload);
    req.end();
  });
}

// ── Keychain Operations ──
function readKeychain() {
  try {
    const raw = execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
      { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeKeychain(data) {
  try {
    const json = JSON.stringify(data);
    execSync(`security delete-generic-password -s "${KEYCHAIN_SERVICE}" 2>/dev/null || true`, {
      stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
    });
    execSync(`security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "" -w '${json.replace(/'/g, "'\\''")}'`, {
      stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
    });
    return true;
  } catch (err) {
    console.error(`[${ts()}] TOKEN_REFRESH keychain write failed: ${err.message}`);
    return false;
  }
}

// ── Factory ──
export function createTokenRefresher({ tokenPool, configPath, proactiveMarginMs, maxBackoffMs, log }) {
  const margin = proactiveMarginMs ?? DEFAULT_PROACTIVE_MARGIN_MS;
  const maxBack = maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const logger = log || console;

  // Per-token mutable state (keyed by token name)
  const _states = new Map();
  const _liveTokens = new Map(); // tokenName -> current access token (no pool mutation)

  // Concurrent refresh coalescing (keyed by token name)
  const _pendingRefreshes = new Map();

  // Proactive timer handle
  let _proactiveTimer = null;

  // ── Initialize state for each token ──
  function initStates() {
    for (const entry of tokenPool) {
      if (entry.type !== "oauth_flat") continue;

      // Try loading refresh token + expiry from keychain
      let refreshToken = null;
      let expiresAt = 0;

      const keychainData = readKeychain();
      if (keychainData?.claudeAiOauth) {
        const oauth = keychainData.claudeAiOauth;
        // Only use keychain data if the access token prefix matches
        if (entry.token && oauth.accessToken && entry.token.slice(0, 20) === oauth.accessToken.slice(0, 20)) {
          refreshToken = oauth.refreshToken || null;
          expiresAt = oauth.expiresAt || 0;
        }
      }

      // Try loading from proxy.config.json (if refreshToken field exists)
      if (!refreshToken) {
        try {
          const configRaw = execSync(`cat "${configPath}"`, { encoding: "utf-8", timeout: 2000 });
          const config = JSON.parse(configRaw);
          const worker = (config.workers || []).find(w => w.name === entry.name);
          if (worker?.refreshToken) {
            refreshToken = worker.refreshToken;
            expiresAt = worker.expiresAt || expiresAt;
          }
        } catch { /* ignore */ }
      }

      _states.set(entry.name, {
        name: entry.name,
        currentAccessToken: entry.token,
        refreshToken,
        expiresAt,
        lastRefreshAt: null,
        lastRefreshResult: null,
        lastRefreshError: null,
        refreshCount: 0,
        consecutiveErrors: 0,
        authErrorCount: 0,
        isRefreshing: false,
        history: [],
      });
    }
  }

  // ── Core: Refresh a specific token ──
  async function refreshToken(tokenName) {
    const state = _states.get(tokenName);
    if (!state) throw new Error(`Token ${tokenName} not found in refresher`);
    if (!state.refreshToken) throw new Error(`No refresh token for ${tokenName}`);

    logger.log(`[${ts()}] TOKEN_REFRESH_START token=${tokenName}`);

    const result = await callOAuthRefresh(state.refreshToken);
    const newExpiresAt = Date.now() + result.expiresIn * 1000;

    // Create new state (immutable replacement)
    const newState = {
      ...state,
      currentAccessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: newExpiresAt,
      lastRefreshAt: Date.now(),
      lastRefreshResult: "success",
      lastRefreshError: null,
      refreshCount: state.refreshCount + 1,
      consecutiveErrors: 0,
      authErrorCount: 0,
      isRefreshing: false,
      history: [
        { ts: Date.now(), result: "success", expiresAt: newExpiresAt },
        ...state.history.slice(0, MAX_HISTORY - 1),
      ],
    };
    _states.set(tokenName, newState);

    // Store live token in internal map (avoid mutating TOKEN_POOL directly)
    _liveTokens.set(tokenName, result.accessToken);

    // Persist to disk + keychain (fire-and-forget)
    persistToken(tokenName, result.accessToken, result.refreshToken, newExpiresAt).catch(err => {
      logger.error(`[${ts()}] TOKEN_REFRESH persist failed for ${tokenName}: ${err.message}`);
    });

    logger.log(
      `[${ts()}] TOKEN_REFRESH_OK token=${tokenName} ` +
      `expiresIn=${humanDuration(newExpiresAt - Date.now())} ` +
      `org=${result.organization?.name || "-"} ` +
      `count=${newState.refreshCount}`
    );

    return { refreshed: true, newToken: result.accessToken };
  }

  // ── Persist to config + keychain ──
  async function persistToken(tokenName, accessToken, refreshTok, expiresAt) {
    // 1. Update proxy.config.json
    try {
      const raw = await readFile(configPath, "utf-8");
      const config = JSON.parse(raw);
      const worker = (config.workers || []).find(w => w.name === tokenName);
      if (worker) {
        const updated = {
          ...config,
          workers: config.workers.map(w =>
            w.name === tokenName
              ? { ...w, token: accessToken, refreshToken: refreshTok, expiresAt }
              : w
          ),
        };
        const tmpPath = join(dirname(configPath), `.proxy.config.${randomUUID().slice(0, 8)}.tmp`);
        await writeFile(tmpPath, JSON.stringify(updated, null, 2) + "\n");
        await rename(tmpPath, configPath);
        logger.log(`[${ts()}] TOKEN_REFRESH persisted to config for ${tokenName} (atomic write)`);
      }
    } catch (err) {
      logger.error(`[${ts()}] TOKEN_REFRESH config write failed: ${err.message}`);
    }

    // 2. Update macOS Keychain
    try {
      const keychainData = readKeychain() || {};
      const updatedKeychain = {
        ...keychainData,
        claudeAiOauth: {
          ...(keychainData.claudeAiOauth || {}),
          accessToken,
          refreshToken: refreshTok,
          expiresAt,
        },
      };
      writeKeychain(updatedKeychain);
      logger.log(`[${ts()}] TOKEN_REFRESH persisted to keychain for ${tokenName}`);
    } catch (err) {
      logger.error(`[${ts()}] TOKEN_REFRESH keychain update failed: ${err.message}`);
    }
  }

  // ── Public: Handle 401 auth error ──
  function handleAuthError(tokenEntry) {
    const state = _states.get(tokenEntry.name);
    if (!state) {
      return Promise.resolve({ refreshed: false, newToken: null });
    }

    // Increment auth error count
    const updated = { ...state, authErrorCount: state.authErrorCount + 1 };
    _states.set(tokenEntry.name, updated);

    // Coalesce concurrent 401s — share one refresh promise
    const existing = _pendingRefreshes.get(tokenEntry.name);
    if (existing) {
      logger.log(`[${ts()}] TOKEN_REFRESH coalescing 401 for ${tokenEntry.name}`);
      return existing;
    }

    if (!state.refreshToken) {
      logger.error(`[${ts()}] TOKEN_REFRESH no refresh_token for ${tokenEntry.name} — cannot auto-refresh`);
      return Promise.resolve({ refreshed: false, newToken: null });
    }

    const promise = refreshToken(tokenEntry.name)
      .catch(err => {
        const s = _states.get(tokenEntry.name);
        if (s) {
          const failState = {
            ...s,
            lastRefreshResult: "error",
            lastRefreshError: err.message,
            consecutiveErrors: s.consecutiveErrors + 1,
            isRefreshing: false,
            history: [
              { ts: Date.now(), result: "error", error: err.message },
              ...s.history.slice(0, MAX_HISTORY - 1),
            ],
          };
          _states.set(tokenEntry.name, failState);

          // Schedule retry with backoff
          const waitMs = backoffMs(failState.consecutiveErrors, maxBack);
          logger.error(
            `[${ts()}] TOKEN_REFRESH_FAIL token=${tokenEntry.name} ` +
            `err=${err.message} retryIn=${humanDuration(waitMs)}`
          );
        }
        return { refreshed: false, newToken: null };
      })
      .finally(() => {
        _pendingRefreshes.delete(tokenEntry.name);
      });

    _pendingRefreshes.set(tokenEntry.name, promise);
    return promise;
  }

  // ── Public: Get active (possibly refreshed) token value ──
  function getActiveToken(tokenName) {
    // Prefer _liveTokens (set on refresh), fall back to _states
    const live = _liveTokens.get(tokenName);
    if (live) return live;
    const state = _states.get(tokenName);
    return state ? state.currentAccessToken : null;
  }

  // ── Public: Get status for /metrics + dashboard ──
  function getStatus() {
    const result = {};
    for (const [name, state] of _states) {
      const expiresInMs = Math.max(0, state.expiresAt - Date.now());
      result[name] = {
        expiresAt: state.expiresAt,
        expiresInMs,
        expiresInHuman: state.expiresAt > 0 ? humanDuration(expiresInMs) : "unknown",
        lastRefreshAt: state.lastRefreshAt,
        lastRefreshResult: state.lastRefreshResult,
        lastRefreshError: state.lastRefreshError,
        refreshCount: state.refreshCount,
        consecutiveErrors: state.consecutiveErrors,
        authErrorCount: state.authErrorCount,
        isRefreshing: state.isRefreshing || _pendingRefreshes.has(name),
        hasRefreshToken: !!state.refreshToken,
        history: state.history.slice(0, 10),
      };
    }
    return result;
  }

  // ── Proactive refresh timer ──
  function proactiveCheck() {
    for (const [name, state] of _states) {
      if (!state.refreshToken) continue;
      if (state.expiresAt <= 0) continue; // unknown expiry
      if (_pendingRefreshes.has(name)) continue; // already refreshing

      const remaining = state.expiresAt - Date.now();
      if (remaining < margin && remaining > -60_000) {
        // Within margin — proactively refresh (but not if expired >1min ago, let 401 handler deal)
        logger.log(`[${ts()}] TOKEN_REFRESH_PROACTIVE token=${name} remaining=${humanDuration(remaining)}`);
        const entry = tokenPool.find(t => t.name === name);
        if (entry) handleAuthError(entry);
      }
    }
  }

  function start() {
    if (_proactiveTimer) return;
    _proactiveTimer = setInterval(proactiveCheck, PROACTIVE_CHECK_INTERVAL_MS);
    _proactiveTimer.unref();
    logger.log(`[${ts()}] TOKEN_REFRESH proactive timer started (interval=${PROACTIVE_CHECK_INTERVAL_MS}ms, margin=${margin}ms)`);
  }

  function destroy() {
    if (_proactiveTimer) {
      clearInterval(_proactiveTimer);
      _proactiveTimer = null;
    }
  }

  // ── Initialize ──
  initStates();

  const initialTokenCount = [..._states.values()].filter(s => s.refreshToken).length;
  logger.log(`[${ts()}] TOKEN_REFRESH initialized: ${_states.size} token(s), ${initialTokenCount} with refresh capability`);
  for (const [name, state] of _states) {
    if (state.expiresAt > 0) {
      const remaining = state.expiresAt - Date.now();
      logger.log(`[${ts()}] TOKEN_REFRESH token=${name} expires=${humanDuration(remaining)} (${new Date(state.expiresAt).toISOString()})`);
    }
  }

  return Object.freeze({
    getActiveToken,
    handleAuthError,
    getStatus,
    start,
    destroy,
  });
}
