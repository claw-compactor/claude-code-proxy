/**
 * Token Health Probe — periodic lightweight API calls to verify token validity.
 * Sends max_tokens:1 requests to detect 401/429 before real traffic hits them.
 */

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

/**
 * @param {object} opts
 * @param {Array} opts.tokenPool - Array of { name, token, type }
 * @param {string} opts.apiBase - Anthropic API base URL
 * @param {string} opts.apiVersion - Anthropic API version
 * @param {object} opts.modelIds - Model ID mappings
 * @param {number} opts.intervalMs - Probe interval (default 300000 = 5 min)
 * @param {object} opts.tokenRefresher - Token refresher instance
 * @param {function} opts.captureUnifiedRateHeaders - Rate header capture
 * @param {function} opts.setTokenCooldown - Set cooldown on 429
 * @param {function} opts.log - Logger
 */
export function createTokenHealthProbe({
  tokenPool,
  apiBase,
  apiVersion,
  modelIds,
  intervalMs = 300_000,
  tokenRefresher,
  captureUnifiedRateHeaders,
  setTokenCooldown,
  log = console.log,
}) {
  let _timer = null;
  let _startupTimer = null;
  const _results = new Map(); // tokenName -> { status, lastProbeAt, latencyMs, error }

  function probeToken(tokenEntry) {
    return new Promise((resolve) => {
      const startAt = Date.now();
      const model = modelIds.haiku || "claude-haiku-4-5-20251001";
      const liveToken = tokenRefresher?.getActiveToken(tokenEntry.name) || tokenEntry.token;
      const authHeaderName = tokenEntry.type === "oauth_flat" ? "authorization" : "x-api-key";
      const authHeaderValue = tokenEntry.type === "oauth_flat" ? `Bearer ${liveToken}` : liveToken;

      const bodyStr = JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      });

      const url = new URL(`${apiBase}/v1/messages`);
      const headers = {
        "content-type": "application/json",
        "anthropic-version": apiVersion,
        ...(tokenEntry.type === "oauth_flat" ? { "anthropic-beta": "oauth-2025-04-20" } : {}),
        "content-length": String(Buffer.byteLength(bodyStr)),
      };
      headers[authHeaderName] = authHeaderValue;

      const timer = setTimeout(() => {
        try { req.destroy(); } catch { /* ignore */ }
        resolve({ status: "timeout", latencyMs: Date.now() - startAt });
      }, 15_000);

      const doRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = doRequest(url, { method: "POST", headers }, (res) => {
        captureUnifiedRateHeaders?.(res, tokenEntry);
        let body = "";
        res.on("data", (d) => { body += d.toString(); });
        res.on("end", () => {
          clearTimeout(timer);
          const latencyMs = Date.now() - startAt;

          if (res.statusCode === 200) {
            resolve({ status: "verified", latencyMs, statusCode: 200 });
          } else if (res.statusCode === 401) {
            // Trigger proactive refresh
            tokenRefresher?.handleAuthError(tokenEntry).then(r => {
              log(`[TokenProbe] 401 on ${tokenEntry.name} — refresh ${r.refreshed ? "OK" : "FAILED"}`);
            }).catch(() => {});
            resolve({ status: "auth_error", latencyMs, statusCode: 401 });
          } else if (res.statusCode === 429) {
            const retryHeader = res.headers["retry-after"];
            let retryMs = 30_000;
            if (retryHeader) {
              const sec = Number(retryHeader);
              if (!Number.isNaN(sec)) retryMs = Math.max(retryMs, sec * 1000);
            }
            setTokenCooldown?.(tokenEntry, retryMs, "probe_429");
            resolve({ status: "rate_limited", latencyMs, statusCode: 429, retryMs });
          } else {
            resolve({ status: "error", latencyMs, statusCode: res.statusCode, body: body.slice(0, 200) });
          }
        });
      });

      req.on("error", (err) => {
        clearTimeout(timer);
        resolve({ status: "network_error", latencyMs: Date.now() - startAt, error: err.message });
      });

      req.write(bodyStr);
      req.end();
    });
  }

  async function probeAll() {
    for (const entry of tokenPool) {
      try {
        const result = await probeToken(entry);
        _results.set(entry.name, {
          ...result,
          lastProbeAt: Date.now(),
        });
        log(`[TokenProbe] ${entry.name}: ${result.status} (${result.latencyMs}ms)`);
      } catch (err) {
        _results.set(entry.name, {
          status: "probe_error",
          error: err.message,
          lastProbeAt: Date.now(),
        });
      }
    }
  }

  function start() {
    if (_timer || _startupTimer) return;
    // First probe after 30s delay (let startup finish)
    _startupTimer = setTimeout(() => {
      _startupTimer = null;
      probeAll();
      _timer = setInterval(probeAll, intervalMs);
    }, 30_000);
  }

  function destroy() {
    if (_startupTimer) {
      clearTimeout(_startupTimer);
      _startupTimer = null;
    }
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
  }

  function getResults() {
    const result = {};
    for (const [name, data] of _results) {
      result[name] = { ...data };
    }
    return result;
  }

  return Object.freeze({
    probeAll,
    probeToken,
    start,
    destroy,
    getResults,
  });
}
