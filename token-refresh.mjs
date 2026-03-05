/**
 * token-refresh.mjs — OAuth Token Auto-Refresh Module
 *
 * Manages OAuth token lifecycle for the Anthropic proxy:
 *   - **Startup parallel refresh**: immediately refreshes all expired/near-expiry tokens concurrently
 *   - **Aggressive proactive refresh**: checks every 30s, refreshes at 50% lifetime remaining
 *   - **Keychain fallback**: re-reads keychain for fresh refresh tokens when OAuth fails
 *   - **CLI credential extraction**: last-resort `claude auth status` to recover tokens
 *   - Coalesces concurrent refresh requests (mutex per token)
 *   - Exponential backoff on refresh failures (max 5 min)
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

const DEFAULT_PROACTIVE_MARGIN_MS = 3_600_000;  // 1 hour before expiry (was 5 min)
const DEFAULT_MAX_BACKOFF_MS = 300_000;          // 5 min max backoff
const PROACTIVE_CHECK_INTERVAL_MS = 30_000;      // check every 30s (was 60s)
const EXPIRED_RETRY_INTERVAL_MS = 120_000;       // retry expired tokens every 2 min
const MAX_HISTORY = 20;
const DEFAULT_TOKEN_LIFETIME_MS = 28_800_000;    // 8 hours (typical OAuth token)

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
            const err = new Error(`OAuth refresh failed: HTTP ${res.statusCode} — ${body.slice(0, 300)}`);
            err.statusCode = res.statusCode;
            err.isInvalidGrant = body.includes("invalid_grant");
            reject(err);
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

/**
 * Try to extract fresh credentials from keychain (may have been updated by
 * `claude auth login` or another process).
 */
function tryRecoverRefreshTokenFromKeychain(tokenName) {
  try {
    const keychainData = readKeychain();
    if (keychainData?.claudeAiOauth?.refreshToken) {
      return keychainData.claudeAiOauth.refreshToken;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Last resort: try `claude auth status` to check if CLI has fresh credentials.
 * Returns { accessToken, refreshToken, expiresAt } or null.
 */
function tryExtractFromCli(claudeBin) {
  try {
    const bin = claudeBin || "claude";
    const output = execSync(`${bin} auth status --json 2>/dev/null || true`, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!output) return null;
    const data = JSON.parse(output);
    if (data.authenticated && data.oauthAccessToken) {
      return {
        accessToken: data.oauthAccessToken,
        refreshToken: data.oauthRefreshToken || null,
        expiresAt: data.expiresAt || 0,
      };
    }
  } catch { /* ignore */ }
  return null;
}

// ── Factory ──
export function createTokenRefresher({ tokenPool, configPath, proactiveMarginMs, maxBackoffMs, claudeBin, log }) {
  const margin = proactiveMarginMs ?? DEFAULT_PROACTIVE_MARGIN_MS;
  const maxBack = maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const logger = log || console;

  // Per-token mutable state (keyed by token name)
  const _states = new Map();
  const _liveTokens = new Map(); // tokenName -> current access token (no pool mutation)

  // Concurrent refresh coalescing (keyed by token name)
  const _pendingRefreshes = new Map();

  // Per-token backoff tracking: tokenName -> nextRetryAt (ms)
  const _nextRetryAt = new Map();

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
        invalidGrant: false,
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
      invalidGrant: false,
      history: [
        { ts: Date.now(), result: "success", expiresAt: newExpiresAt },
        ...state.history.slice(0, MAX_HISTORY - 1),
      ],
    };
    _states.set(tokenName, newState);

    // Clear backoff on success
    _nextRetryAt.delete(tokenName);

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

  // ── Internal: attempt refresh with fallback credential recovery ──
  async function attemptRefreshWithRecovery(tokenName) {
    const state = _states.get(tokenName);
    if (!state) return { refreshed: false, newToken: null };

    try {
      return await refreshToken(tokenName);
    } catch (err) {
      // If invalid_grant, try to recover a fresh refresh token
      if (err.isInvalidGrant) {
        logger.log(`[${ts()}] TOKEN_REFRESH invalid_grant for ${tokenName} — attempting keychain recovery`);

        // Try 1: Re-read keychain for potentially updated refresh token
        const keychainRefresh = tryRecoverRefreshTokenFromKeychain(tokenName);
        if (keychainRefresh && keychainRefresh !== state.refreshToken) {
          logger.log(`[${ts()}] TOKEN_REFRESH found different refresh token in keychain for ${tokenName}`);
          const newState = { ...state, refreshToken: keychainRefresh, invalidGrant: false };
          _states.set(tokenName, newState);
          try {
            return await refreshToken(tokenName);
          } catch (err2) {
            logger.error(`[${ts()}] TOKEN_REFRESH keychain recovery failed for ${tokenName}: ${err2.message}`);
          }
        }

        // Try 2: Extract from CLI auth status
        logger.log(`[${ts()}] TOKEN_REFRESH attempting CLI credential extraction for ${tokenName}`);
        const cliCreds = tryExtractFromCli(claudeBin);
        if (cliCreds?.refreshToken && cliCreds.refreshToken !== state.refreshToken) {
          logger.log(`[${ts()}] TOKEN_REFRESH found CLI credentials for ${tokenName}`);
          const newState = { ...state, refreshToken: cliCreds.refreshToken, invalidGrant: false };
          _states.set(tokenName, newState);
          try {
            return await refreshToken(tokenName);
          } catch (err3) {
            logger.error(`[${ts()}] TOKEN_REFRESH CLI recovery failed for ${tokenName}: ${err3.message}`);
          }
        }

        // Mark as invalid_grant for status reporting
        const failState = _states.get(tokenName);
        if (failState) {
          _states.set(tokenName, { ...failState, invalidGrant: true });
        }
      }
      throw err; // re-throw for caller to handle
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

    const promise = attemptRefreshWithRecovery(tokenEntry.name)
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
          _nextRetryAt.set(tokenEntry.name, Date.now() + waitMs);
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
      const retryAt = _nextRetryAt.get(name) || null;
      const retryInMs = retryAt ? Math.max(0, retryAt - Date.now()) : null;
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
        invalidGrant: state.invalidGrant || false,
        nextRetryAt: retryAt,
        nextRetryInMs: retryInMs,
        nextRetryInHuman: retryInMs != null ? humanDuration(retryInMs) : null,
        history: state.history.slice(0, 10),
      };
    }
    return result;
  }

  // ── Proactive refresh timer (aggressive) ──
  function proactiveCheck() {
    const refreshPromises = [];

    for (const [name, state] of _states) {
      if (!state.refreshToken) continue;
      if (_pendingRefreshes.has(name)) continue; // already refreshing

      // Check backoff: skip if we're in backoff period
      const retryAt = _nextRetryAt.get(name);
      if (retryAt && Date.now() < retryAt) continue;

      const remaining = state.expiresAt > 0 ? state.expiresAt - Date.now() : -Infinity;
      const isExpired = remaining <= 0;
      const isNearExpiry = remaining > 0 && remaining < margin;

      // Compute dynamic margin: refresh at 50% remaining lifetime
      // e.g., 8h token → refresh after 4h (when 4h remaining)
      const lifetime = state.lastRefreshAt && state.expiresAt > state.lastRefreshAt
        ? state.expiresAt - state.lastRefreshAt
        : DEFAULT_TOKEN_LIFETIME_MS;
      const halfLifeRemaining = lifetime * 0.5;
      const isHalfLife = remaining > 0 && remaining < halfLifeRemaining;

      const shouldRefresh = isExpired || isNearExpiry || isHalfLife;

      if (shouldRefresh) {
        const reason = isExpired ? "expired" : isNearExpiry ? "near_expiry" : "half_life";
        logger.log(
          `[${ts()}] TOKEN_REFRESH_PROACTIVE token=${name} ` +
          `reason=${reason} remaining=${remaining > 0 ? humanDuration(remaining) : "expired"}`
        );
        const entry = tokenPool.find(t => t.name === name);
        if (entry) {
          refreshPromises.push(handleAuthError(entry));
        }
      }
    }

    // All refreshes run concurrently (Promise.allSettled = parallel)
    if (refreshPromises.length > 0) {
      Promise.allSettled(refreshPromises).then(results => {
        const succeeded = results.filter(r => r.status === "fulfilled" && r.value?.refreshed).length;
        const failed = results.length - succeeded;
        if (succeeded > 0 || failed > 0) {
          logger.log(`[${ts()}] TOKEN_REFRESH_PROACTIVE_BATCH total=${results.length} ok=${succeeded} fail=${failed}`);
        }
      });
    }
  }

  // ── Startup: immediately refresh all expired/near-expiry tokens in parallel ──
  async function startupRefresh() {
    const urgent = [];
    for (const [name, state] of _states) {
      if (!state.refreshToken) continue;
      const remaining = state.expiresAt > 0 ? state.expiresAt - Date.now() : -Infinity;
      // Refresh if: expired, unknown expiry, or within margin
      if (remaining <= 0 || state.expiresAt <= 0 || remaining < margin) {
        const entry = tokenPool.find(t => t.name === name);
        if (entry) {
          const reason = state.expiresAt <= 0 ? "unknown_expiry" : remaining <= 0 ? "expired" : "near_expiry";
          logger.log(`[${ts()}] TOKEN_REFRESH_STARTUP token=${name} reason=${reason} remaining=${remaining > 0 ? humanDuration(remaining) : "expired"}`);
          urgent.push({ entry, name });
        }
      }
    }

    if (urgent.length === 0) {
      logger.log(`[${ts()}] TOKEN_REFRESH_STARTUP no tokens need immediate refresh`);
      return;
    }

    logger.log(`[${ts()}] TOKEN_REFRESH_STARTUP refreshing ${urgent.length} token(s) in parallel`);
    const results = await Promise.allSettled(
      urgent.map(({ entry }) => handleAuthError(entry))
    );

    const succeeded = results.filter(r => r.status === "fulfilled" && r.value?.refreshed).length;
    const failed = results.length - succeeded;
    logger.log(`[${ts()}] TOKEN_REFRESH_STARTUP done: ok=${succeeded} fail=${failed}`);
  }

  function start() {
    if (_proactiveTimer) return;

    // Immediate parallel refresh of all expired/near-expiry tokens
    startupRefresh().catch(err => {
      logger.error(`[${ts()}] TOKEN_REFRESH_STARTUP error: ${err.message}`);
    });

    // Start periodic proactive check
    _proactiveTimer = setInterval(proactiveCheck, PROACTIVE_CHECK_INTERVAL_MS);
    _proactiveTimer.unref();
    logger.log(
      `[${ts()}] TOKEN_REFRESH proactive timer started ` +
      `(interval=${PROACTIVE_CHECK_INTERVAL_MS}ms, margin=${humanDuration(margin)}, halfLife=50%)`
    );
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
  const expiredCount = [..._states.values()].filter(s => s.expiresAt > 0 && s.expiresAt < Date.now()).length;
  logger.log(
    `[${ts()}] TOKEN_REFRESH initialized: ${_states.size} token(s), ` +
    `${initialTokenCount} with refresh capability, ${expiredCount} expired`
  );
  for (const [name, state] of _states) {
    if (state.expiresAt > 0) {
      const remaining = state.expiresAt - Date.now();
      logger.log(
        `[${ts()}] TOKEN_REFRESH token=${name} ` +
        `expires=${remaining > 0 ? humanDuration(remaining) : "EXPIRED " + humanDuration(-remaining) + " ago"} ` +
        `(${new Date(state.expiresAt).toISOString()})`
      );
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
