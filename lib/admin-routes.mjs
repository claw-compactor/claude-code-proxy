/**
 * Admin routes — /health, /metrics, /events, /zombies, /models, dashboard, etc.
 * All dependencies injected via createAdminRoutes factory.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

function ts() {
  return new Date().toISOString();
}

/**
 * @param {object} deps
 * @param {object} deps.config - CONFIG object
 * @param {object} deps.queue
 * @param {object} deps.registry
 * @param {object} deps.workerHealth
 * @param {object} deps.autoHeal
 * @param {object} deps.sessionAffinity
 * @param {object} deps.systemReaper
 * @param {object} deps.warmPool
 * @param {object} deps.eventLog
 * @param {object} deps.tokenTracker
 * @param {object} deps.metricsStore
 * @param {object} deps.metricsController
 * @param {object} deps.workerStats
 * @param {object} deps.workerState
 * @param {object} deps.tokenRefresher
 * @param {Array}  deps.tokenPool
 * @param {object} deps.modelMap
 * @param {object} deps.redis
 * @param {function} deps.getCacheStats
 * @param {function} deps.sendJson
 * @param {function} deps.sendError
 * @param {function} deps.readBody
 * @param {string} deps.staticDir - __dirname for HTML files
 * @param {number} deps.port
 * @param {number} deps.maxBodyBytes
 * @param {Set}    deps.getSseClients - getter for SSE clients set
 * @param {function} deps.setSseClients - setter for SSE clients set
 */
export function createAdminRoutes({
  config,
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
  tokenPool,
  modelMap,
  redis,
  getCacheStats,
  sendJson,
  sendError,
  readBody,
  staticDir,
  port,
  maxBodyBytes,
  getSseClients,
  setSseClients,
}) {
  function getWorkerTokenReason(worker) {
    const now = Date.now();
    if (worker.disabled) return worker.disabledReason || "disabled";
    if (!worker.token && !worker.refreshToken) return "no token";
    if (worker.expiresAt && worker.expiresAt > 0 && worker.expiresAt <= now) return "expired";
    return null;
  }

  function handleModels(req, res) {
    const models = Object.keys(modelMap).map((id) => ({
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
    const workers = config.workers.map((w) => {
      const h = workerHealth.getState(w.name);
      const until = h.limitedUntil || null;
      const healState = autoHeal.getWorkerState(w.name);
      return {
        name: w.name,
        bin: w.bin,
        disabled: !!w.disabled,
        disabledReason: w.disabledReason || null,
        tokenReason: getWorkerTokenReason(w),
        limited: !!h.limited,
        limitedAt: h.limitedAt || null,
        limitedAgoSec: h.limited ? Math.round((Date.now() - h.limitedAt) / 1000) : null,
        limitedUntil: until,
        limitedUntilIso: until ? new Date(until).toISOString() : null,
        limitedRemainingSec: h.limited && until ? Math.max(0, Math.round((until - Date.now()) / 1000)) : null,
        autoHeal: {
          cooldownUntil: healState.cooldownUntil || null,
          cooldownRemainingSec: healState.cooldownUntil ? Math.max(0, Math.round((healState.cooldownUntil - Date.now()) / 1000)) : null,
          circuitState: healState.circuitState,
          circuitOpenUntil: healState.circuitOpenUntil || null,
          circuitRemainingSec: healState.circuitOpenUntil ? Math.max(0, Math.round((healState.circuitOpenUntil - Date.now()) / 1000)) : null,
        },
      };
    });
    sendJson(res, 200, {
      status: "ok",
      version: config.dashboard.version,
      claude_bin: config.workers[0]?.bin || "claude",
      port,
      redis: redis ? { connected: redis.isReady() } : { connected: false },
      cliRouters: workers,
      primaryRouter: config.routing.primaryWorker,
      queue: { active: qs.active, queued: qs.totalQueued, max: qs.maxConcurrent, sources: qs.sourceCount, activeBySource: qs.activeBySource },
      processes: { tracked: rs.total, byMode: rs.byMode, liveTokens: rs.liveTokens },
      tokens: tokenTracker.getTotals(),
      sessionAffinity: sessionAffinity.getStats(),
      cache: getCacheStats(),
      workerStats,
      autoHeal: autoHeal.getStats(),
      dashboard: config.dashboard,
      portal: config.portal,
    });
  }

  async function handleMetrics(req, res) {
    const url = new URL(req.url, `http://0.0.0.0:${port}`);
    const payload = await metricsController.buildMetricsResponse(url);
    sendJson(res, 200, payload);
  }

  function handleSystemReaper(req, res) {
    sendJson(res, 200, {
      stats: systemReaper.getStats(),
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
      body = await readBody(req, maxBodyBytes);
    } catch (err) {
      return sendError(res, 413, { message: err.message || "Payload too large", type: "payload_too_large" });
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return sendError(res, 400, { message: "Invalid JSON body", type: "invalid_request" });
    }
    const { pid } = parsed;
    if (!pid) return sendError(res, 400, { message: "pid required", type: "invalid_request" });
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
      return sendError(res, 400, { message: `Invalid window. Use: ${validWindows.join(", ")}`, type: "invalid_request" });
    }
    const points = metricsStore.query(window);
    sendJson(res, 200, { window, points, count: points.length, bufferSize: metricsStore.getBufferSize() });
  }

  async function handlePortal(req, res) {
    try {
      const html = await readFile(join(staticDir, "portal.html"), "utf-8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      sendError(res, 500, { message: "Portal file not found: " + err.message, type: "internal_error" });
    }
  }

  async function handleProxyDashboard(req, res) {
    try {
      const html = await readFile(join(staticDir, "dashboard.html"), "utf-8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      sendError(res, 500, { message: "Dashboard file not found: " + err.message, type: "internal_error" });
    }
  }

  function handleSSEStream(req, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    });
    res.write("event: connected\ndata: {}\n\n");

    const clients = getSseClients();
    setSseClients(new Set([...clients, res]));
    console.log(`[${ts()}] SSE_CLIENT connected (${getSseClients().size} total)`);

    req.on("close", () => {
      const current = getSseClients();
      setSseClients(new Set([...current].filter((c) => c !== res)));
      console.log(`[${ts()}] SSE_CLIENT disconnected (${getSseClients().size} total)`);
    });
  }

  async function handleTokenRefresh(req, res) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const { tokenName } = JSON.parse(Buffer.concat(chunks).toString());
    const entry = tokenPool.find(t => t.name === tokenName);
    if (!entry) return sendError(res, 404, { message: `Token ${tokenName} not found`, type: "not_found" });
    const result = await tokenRefresher.handleAuthError(entry);
    sendJson(res, 200, { result, status: tokenRefresher.getStatus() });
  }

  async function handleWorkerDisable(req, res, workerName) {
    const chunks = []; for await (const c of req) chunks.push(c);
    let reason = "manual";
    try { const b = JSON.parse(Buffer.concat(chunks).toString()); reason = b.reason || reason; } catch { /* no body is ok */ }
    const result = await workerState.disable(workerName, reason);
    sendJson(res, result.error ? 404 : 200, result);
  }

  async function handleWorkerEnable(req, res, workerName) {
    const result = await workerState.enable(workerName);
    sendJson(res, result.error ? 404 : 200, result);
  }

  function handleWorkersList(req, res) {
    sendJson(res, 200, { workers: workerState.getAll() });
  }

  return Object.freeze({
    getWorkerTokenReason,
    handleModels,
    handleHealth,
    handleMetrics,
    handleSystemReaper,
    handleSystemReaperSweep,
    handleWarmPool,
    handleZombies,
    handleKillZombie,
    handleEvents,
    handleMetricsHistory,
    handlePortal,
    handleProxyDashboard,
    handleSSEStream,
    handleTokenRefresh,
    handleWorkerDisable,
    handleWorkerEnable,
    handleWorkersList,
  });
}
