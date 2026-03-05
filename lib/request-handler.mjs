/**
 * Request handler — handleCompletions + handleApiDirect.
 * Contains the main request processing logic including CLI stream pipeline (pipeStream).
 * All dependencies injected via createRequestHandler factory.
 */

import { randomUUID } from "node:crypto";

function ts() {
  return new Date().toISOString();
}

/**
 * @param {object} deps
 * @param {object}  deps.config - CONFIG object
 * @param {object}  deps.queue
 * @param {object}  deps.rateLimiter
 * @param {object}  deps.sessionAffinity
 * @param {object}  deps.eventLog
 * @param {object}  deps.tokenTracker
 * @param {object}  deps.autoHeal
 * @param {Array}   deps.tokenPool
 * @param {object}  deps.workerPool
 * @param {object}  deps.modelMap
 * @param {object}  deps.modelPriority
 * @param {function} deps.resolveModel
 * @param {function} deps.getNextToken
 * @param {function} deps.waitForTokenCooldown
 * @param {function} deps.getNextWorker
 * @param {function} deps.workerAcquire
 * @param {function} deps.workerRelease
 * @param {function} deps.getAlternateWorker
 * @param {function} deps.extractPrompt
 * @param {function} deps.buildCacheContext
 * @param {function} deps.recordCacheCandidate
 * @param {function} deps.recordCacheApplied
 * @param {function} deps.recordCacheKey
 * @param {function} deps.getCacheStats
 * @param {function} deps.recordWorkerRequest
 * @param {function} deps.recordWorkerError
 * @param {function} deps.isRateLimitError
 * @param {function} deps.markWorkerLimited
 * @param {function} deps.isWorkerHealthy
 * @param {function} deps.getAllLimitedStatus
 * @param {function} deps.formatLimitNotice
 * @param {function} deps.streamFromAnthropicDirect
 * @param {function} deps.callAnthropicDirect
 * @param {function} deps.streamFromFallbackApi
 * @param {function} deps.fetchFallbackSync
 * @param {object}  deps.cliRunner - createCliRunner instance
 * @param {function} deps.sseChunk
 * @param {function} deps.sseBroadcast
 * @param {function} deps.sendJson
 * @param {function} deps.sendError
 * @param {function} deps.readBody
 * @param {function} deps.getSessionIdForStats
 * @param {object}  deps.sessionStatsStore
 * @param {object}  deps.registry
 * @param {object}  deps.buildUsage
 * @param {function} deps.completionResponse
 * @param {function} deps.completionResponseWithTools
 * @param {object}  deps.heartbeatByModel
 * @param {number}  deps.defaultHeartbeatMs
 * @param {number}  deps.streamTimeoutMs
 * @param {number}  deps.maxBodyBytes
 * @param {boolean} deps.allowExplicitTokenOverride
 * @param {boolean} deps.useCliAgents
 * @param {function} deps.enabledWorkers
 * @param {function} deps.classifyCliError
 */
export function createRequestHandler(deps) {
  const {
    config, queue, rateLimiter, sessionAffinity, eventLog, tokenTracker,
    autoHeal, tokenPool, workerPool, modelPriority, resolveModel,
    getNextToken, waitForTokenCooldown, getNextWorker, workerAcquire,
    workerRelease, getAlternateWorker, extractPrompt, buildCacheContext,
    recordCacheCandidate, recordCacheApplied, recordCacheKey, getCacheStats,
    recordWorkerRequest, recordWorkerError, isRateLimitError, markWorkerLimited,
    isWorkerHealthy, getAllLimitedStatus, formatLimitNotice,
    streamFromAnthropicDirect, callAnthropicDirect, streamFromFallbackApi,
    fetchFallbackSync, cliRunner, sseChunk, sseBroadcast, sendJson, sendError,
    readBody, getSessionIdForStats, sessionStatsStore, registry, buildUsage,
    completionResponse, completionResponseWithTools, heartbeatByModel,
    defaultHeartbeatMs, streamTimeoutMs, maxBodyBytes,
    allowExplicitTokenOverride, useCliAgents, enabledWorkers, classifyCliError,
  } = deps;

  async function handleApiDirect(body, model, stream, source, req, res) {
    const priority = modelPriority[model] || "normal";
    const estTokens = Math.min(Math.ceil(JSON.stringify(body.messages).length / 4), 5000);
    const reqId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const cacheCtx = buildCacheContext({ body, model, source, req, applyCacheControl: true });
    recordCacheCandidate(cacheCtx.candidateCount);
    recordCacheApplied(cacheCtx.appliedCount);
    const cacheSeen = recordCacheKey(cacheCtx.cacheKeyHash);
    sessionStatsStore?.record(getSessionIdForStats(req), cacheSeen.seen).catch?.(() => {});
    console.log(
      `[${ts()}] CACHE_CTX reqId=${reqId} src=${source} tenant=${cacheCtx.tenant} model=${model} ` +
      `candidate=${cacheCtx.candidateCount} applied=${cacheCtx.appliedCount} ` +
      `hit=${cacheSeen.seen ? "hit" : "miss"} hitRate=${getCacheStats().hitRate} ` +
      `cache_key_hash=${cacheCtx.cacheKeyHash} reason=${cacheCtx.reason}`
    );

    let release;
    try {
      release = await queue.acquire(source, priority);
    } catch (err) {
      return sendError(res, 503, {
        message: `Queue full: ${err.message}`,
        type: "queue_full",
        retry_after_ms: 10000,
      }, { "retry-after": "10" });
    }

    let rateWaitTotal = 0;
    while (true) {
      const rateCheck = rateLimiter.check(model, estTokens);
      if (rateCheck.ok) break;
      if (rateWaitTotal >= 300000) {
        release();
        return sendError(res, 503, { message: "Rate limit wait exceeded", type: "rate_limit_timeout" });
      }
      const sleepMs = Math.min(rateCheck.waitMs, 5000);
      await new Promise(r => setTimeout(r, sleepMs));
      rateWaitTotal += sleepMs;
    }

    rateLimiter.record(model, estTokens);

    const requestedTokenRaw = req.headers["x-token-name"] ?? body.tokenName;
    let tokenEntry = null;
    if (allowExplicitTokenOverride && requestedTokenRaw !== undefined && requestedTokenRaw !== null) {
      const requestedTokenName = String(requestedTokenRaw).trim();
      if (requestedTokenName) {
        tokenEntry = tokenPool.find(t => t.name === requestedTokenName) || null;
      }
    }
    if (!tokenEntry) tokenEntry = getNextToken();
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

      streamFromAnthropicDirect(body, model, reqId, source, res, release, tokenEntry, cacheCtx);
    } else {
      try {
        const result = await callAnthropicDirect(body, model, reqId, source, tokenEntry, cacheCtx);
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
        if ((err.statusCode === 401 || err.statusCode === 403) && err.refreshed) {
          console.log(`[${ts()}] RETRY_AFTER_REFRESH reqId=${reqId} token=${tokenEntry.name}`);
          try {
            const retryResult = await callAnthropicDirect(body, model, reqId + "-retry", source, tokenEntry, cacheCtx);
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
          }
        }
        release();
        console.error(`[${ts()}] TOOL_REQ_ERROR reqId=${reqId} src=${source} ${err.message}`);
        eventLog.push("error", { reqId, mode: "anthropic_direct", model, source, error: err.message });
        sseBroadcast("error", { reqId, model, source, worker: tokenEntry.name, error: err.message });
        sendError(res, 500, { message: err.message, type: "anthropic_api_error" });
      }
    }
  }

  async function handleCompletions(req, res) {
    const source = deps.identifySource(req);

    let rawBody;
    try {
      rawBody = await readBody(req, maxBodyBytes);
    } catch (err) {
      return sendError(res, 413, { message: err.message || "Payload too large", type: "payload_too_large" });
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return sendError(res, 400, { message: "Invalid JSON body", type: "invalid_request" });
    }

    const { messages, model: rawModel = "claude-code", stream = false } = body;
    if (!messages || !Array.isArray(messages)) {
      return sendError(res, 400, { message: "messages array required", type: "invalid_request" });
    }

    if (!useCliAgents && tokenPool.length > 0) {
      return handleApiDirect(body, resolveModel(rawModel), stream, source, req, res);
    }

    const { prompt, systemPrompt } = extractPrompt(messages);
    if (!prompt) {
      return sendError(res, 400, { message: "No user message found", type: "invalid_request" });
    }

    const sessionKey = sessionAffinity.deriveKey({
      source,
      sessionId: req.headers["x-session-id"] || "",
      systemPrompt: systemPrompt || "",
    });

    const model = resolveModel(rawModel);
    const cacheCtx = buildCacheContext({ body, model, source, req, applyCacheControl: false });
    recordCacheCandidate(cacheCtx.candidateCount);
    recordCacheApplied(cacheCtx.appliedCount);
    const cacheSeen = recordCacheKey(cacheCtx.cacheKeyHash);
    sessionStatsStore?.record(getSessionIdForStats(req), cacheSeen.seen).catch?.(() => {});

    const priority = modelPriority[model] || "normal";
    const estTokens = Math.min(Math.ceil(prompt.length / 4), 5000);
    const reqId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    console.log(
      `[${ts()}] CACHE_CTX reqId=${reqId} src=${source} tenant=${cacheCtx.tenant} model=${model} ` +
      `candidate=${cacheCtx.candidateCount} applied=${cacheCtx.appliedCount} ` +
      `hit=${cacheSeen.seen ? "hit" : "miss"} hitRate=${getCacheStats().hitRate} ` +
      `cache_key_hash=${cacheCtx.cacheKeyHash} reason=${cacheCtx.reason}`
    );

    let release;
    try {
      release = await queue.acquire(source, priority);
    } catch (err) {
      console.log(`[${ts()}] QUEUE_FULL src=${source} model=${model} ${err.message}`);
      return sendError(res, 503, {
        message: `Queue full, try again shortly: ${err.message}`,
        type: "queue_full",
        retry_after_ms: 10000,
      }, { "retry-after": "10" });
    }

    let rateWaitTotal = 0;
    const MAX_RATE_WAIT_MS = 300000;
    while (true) {
      const rateCheck = rateLimiter.check(model, estTokens);
      if (rateCheck.ok) break;
      if (rateWaitTotal >= MAX_RATE_WAIT_MS) {
        release();
        console.log(`[${ts()}] RATE_TIMEOUT src=${source} model=${model} waited ${rateWaitTotal}ms`);
        return sendError(res, 503, {
          message: `Rate limit wait exceeded ${MAX_RATE_WAIT_MS}ms`,
          type: "rate_limit_timeout",
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
        "x-accel-buffering": "no",
      });
      res.flushHeaders();
      if (res.socket) {
        res.socket.setNoDelay(true);
      }
      res.write(":proxy-accepted\n\n");

      const allLimited = getAllLimitedStatus();
      if (allLimited) {
        const notice = formatLimitNotice(allLimited.nextReset);
        res.write(sseChunk(reqId, notice));
        streamFromFallbackApi(messages, model, reqId, source, res);
        return;
      }

      const QUICK_FAIL_MS = 5000;
      const retryPoolBase = enabledWorkers();
      const retryPool = retryPoolBase.length > 0 ? retryPoolBase : [...workerPool];
      const MAX_STREAM_RETRIES = retryPool.length;
      const inputEstimate = Math.ceil(prompt.length / 4);
      const originalMessages = messages;
      let retryCount = 0;
      const triedRouters = new Set();
      let activeProc = null;

      res.on("close", () => {
        if (activeProc && !activeProc.killed) {
          console.log(`[${ts()}] CLIENT_DISCONNECT reqId=${reqId} — killing CLI pid=${activeProc.pid}`);
          try { activeProc.kill("SIGTERM"); } catch { /* ignore */ }
        }
      });

      function pipeStream(workerOverride, isRetry) {
        const worker = workerOverride || getNextWorker(sessionKey);
        sessionAffinity.assign(sessionKey, worker.name);
        triedRouters.add(worker.name);
        console.log(`[${ts()}] CLIROUTER obj=${worker.name} bin=${worker.bin} reqId=${reqId} model=${model} src=${source}${isRetry ? ` RETRY#${retryCount}` : ""}`);
        recordWorkerRequest(worker.name);
        workerAcquire(worker.name);
        const proc = cliRunner.spawnCliStream(prompt, model, systemPrompt, worker);
        activeProc = proc;
        cliRunner.trackStreamProc(proc, reqId, model, source, worker);

        let buffer = "";
        let stderrBuf = "";
        let sentContent = false;
        let reqTokens = { input: 0, output: 0 };
        let outputChars = 0;

        proc.stderr.on("data", (d) => { stderrBuf += d.toString(); });

        const FIRST_BYTE_WARN_MS = 8_000;
        const firstByteTimer = setTimeout(() => {
          console.log(`[${ts()}] SLOW_SPAWN pid=${proc.pid} reqId=${reqId} model=${model} router=${worker.name} elapsed=${FIRST_BYTE_WARN_MS}ms — no stdout yet (possible macOS dialog or slow startup)`);
          eventLog.push("timeout", { kind: "slow_spawn", pid: proc.pid, reqId, model, source, elapsed: FIRST_BYTE_WARN_MS });
        }, FIRST_BYTE_WARN_MS);

        const heartbeatMs = heartbeatByModel[model] || defaultHeartbeatMs;
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
          console.log(`[${ts()}] STREAM_TIMEOUT pid=${proc.pid} reqId=${reqId} model=${model} age=${streamTimeoutMs}ms`);
          try { proc.kill("SIGTERM"); } catch { /* ignore */ }
        }, streamTimeoutMs);

        const FAST_KEEPALIVE_MS = 5_000;
        const SLOW_KEEPALIVE_MS = 30_000;
        let keepaliveMs = FAST_KEEPALIVE_MS;
        let keepaliveInterval = setInterval(() => {
          if (!res.writableEnded) {
            try { res.write(":keepalive\n\n"); } catch { /* ignore */ }
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
          clearTimeout(firstByteTimer);
          resetHeartbeat();
          slowDownKeepalive();
          buffer += data.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const ev = JSON.parse(line);
              const canWrite = !res.writableEnded;
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

        proc.on("close", async (code) => {
          clearTimeout(firstByteTimer);
          clearTimeout(heartbeatTimer);
          clearTimeout(execTimer);
          clearInterval(keepaliveInterval);
          workerRelease(worker.name);

          if (code !== 0 && !sentContent) {
            const rateErr = isRateLimitError(code, stderrBuf) || isRateLimitError(code, buffer);
            const classification = classifyCliError({
              exitCode: code,
              stderr: stderrBuf,
              stdout: buffer,
              err: { isRateLimit: rateErr },
            });
            if (classification.healable && config.autoHeal?.enabled !== false) {
              const healResult = await autoHeal.heal(worker.name, classification.reason, reqId);
              if (healResult?.success && retryCount < MAX_STREAM_RETRIES) {
                retryCount++;
                console.log(`[${ts()}] AUTO_HEAL_RETRY reqId=${reqId} worker=${worker.name} reason=${classification.reason} -> retrying (attempt ${retryCount}/${MAX_STREAM_RETRIES})`);
                pipeStream(worker, true);
                return;
              }
              const alt = getAlternateWorker(worker.name);
              if (alt && retryCount < MAX_STREAM_RETRIES) {
                retryCount++;
                console.log(`[${ts()}] AUTO_HEAL_FALLBACK reqId=${reqId} worker=${worker.name} -> ${alt.name} (attempt ${retryCount}/${MAX_STREAM_RETRIES})`);
                pipeStream(alt, true);
                return;
              }
            }
          }

          const elapsed = Date.now() - proc._spawnedAt;
          if (code !== 0 && !sentContent && elapsed < QUICK_FAIL_MS && retryCount < MAX_STREAM_RETRIES) {
            const untried = retryPool.find(
              (w) => !triedRouters.has(w.name) && isWorkerHealthy(w.name)
            );
            const alt = untried || getAlternateWorker(worker.name);
            if (alt) {
              retryCount++;
              console.log(`[${ts()}] STREAM_RETRY reqId=${reqId} failedRouter=${worker.name} code=${code} elapsed=${elapsed}ms -> retrying on ${alt.name} (attempt ${retryCount}/${MAX_STREAM_RETRIES})`);
              recordWorkerError(worker.name, "stream_retry", `code=${code} elapsed=${elapsed}ms`);
              eventLog.push("retry", { reqId, model, source, failedWorker: worker.name, retryWorker: alt.name, code, elapsed, retryCount });
              pipeStream(alt, true);
              return;
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
            console.log(`[${ts()}] ALL_CLI_FAILED reqId=${reqId} retryCount=${retryCount} -> falling back to ${config.fallback.name}`);
            streamFromFallbackApi(originalMessages, model, reqId, source, res);
            return;
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
          if (!sentContent && retryCount < MAX_STREAM_RETRIES) {
            const untried = retryPool.find(
              (w) => !triedRouters.has(w.name) && isWorkerHealthy(w.name)
            );
            const alt = untried || getAlternateWorker(worker.name);
            if (alt) {
              retryCount++;
              console.log(`[${ts()}] STREAM_RETRY reqId=${reqId} failedRouter=${worker.name} error=${err.message} -> retrying on ${alt.name} (attempt ${retryCount}/${MAX_STREAM_RETRIES})`);
              pipeStream(alt, true);
              return;
            }
          }
          release();
          console.log(`[${ts()}] ALL_CLI_FAILED reqId=${reqId} error=${err.message} -> falling back to ${config.fallback.name}`);
          streamFromFallbackApi(originalMessages, model, reqId, source, res);
        });
      }

      pipeStream(null, false);
    } else {
      // Sync path
      try {
        const allLimited = getAllLimitedStatus();
        if (allLimited) {
          const notice = formatLimitNotice(allLimited.nextReset);
          try {
            const fbResult = await fetchFallbackSync(messages, model, reqId, source);
            release();
            const combined = fbResult ? `${notice}\n\n${fbResult}` : notice;
            sendJson(res, 200, completionResponse(reqId, combined, model));
            return;
          } catch (err) {
            release();
            const retrySec = allLimited.nextReset ? Math.max(0, Math.round((allLimited.nextReset - Date.now()) / 1000)) : null;
            return sendError(res, 503, {
              message: `Claude limit reached; retry after ${retrySec ?? "unknown"}s`,
              type: "rate_limited",
              retry_after_sec: retrySec,
            });
          }
        }
        const result = await cliRunner.runCli(prompt, model, systemPrompt, reqId, source, sessionKey);
        release();
        const syncInputTokens = Math.ceil(prompt.length / 4);
        const syncOutputTokens = Math.ceil(result.length / 4);
        tokenTracker.record(reqId, model, syncInputTokens, syncOutputTokens);
        eventLog.push("complete", {
          reqId, mode: "sync", model, source,
          inputTokens: syncInputTokens, outputTokens: syncOutputTokens,
        });
        sendJson(res, 200, completionResponse(reqId, result, model, buildUsage({
          inputTokens: syncInputTokens,
          outputTokens: syncOutputTokens,
        })));
      } catch (err) {
        if (err.isRateLimit) {
          const allLimited = getAllLimitedStatus();
          const notice = formatLimitNotice(allLimited?.nextReset);
          try {
            const fbResult = await fetchFallbackSync(messages, model, reqId, source);
            release();
            const combined = fbResult ? `${notice}\n\n${fbResult}` : notice;
            sendJson(res, 200, completionResponse(reqId, combined, model));
            return;
          } catch (fbErr) {
            release();
            const retrySec = allLimited?.nextReset ? Math.max(0, Math.round((allLimited.nextReset - Date.now()) / 1000)) : null;
            return sendError(res, 503, {
              message: `Claude limit reached; retry after ${retrySec ?? "unknown"}s`,
              type: "rate_limited",
              retry_after_sec: retrySec,
            });
          }
        }
        release();
        eventLog.push("error", { reqId, mode: "sync", model, source, error: err.message });
        console.error(`[${ts()}] ERROR src=${source} ${err.message}`);
        sendError(res, 500, { message: err.message, type: "internal_error" });
      }
    }
  }

  /**
   * Native Anthropic /v1/messages handler.
   * Accepts and returns Anthropic format directly — no OpenAI conversion.
   * Supports streaming, tool_use, cache_control, thinking, metadata pass-through.
   */
  async function handleAnthropicMessages(req, res) {
    const source = deps.identifySource(req);

    let rawBody;
    try {
      rawBody = await readBody(req, maxBodyBytes);
    } catch (err) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: err.message || "Payload too large" } }));
      return;
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } }));
      return;
    }

    if (!body.messages || !Array.isArray(body.messages)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages array required" } }));
      return;
    }

    // Resolve model shorthand
    const rawModel = body.model || "claude-sonnet-4-20250514";
    const model = resolveModel(rawModel) || rawModel;
    const stream = body.stream || false;

    // Token pool required for Anthropic direct
    if (tokenPool.length === 0) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "No API tokens configured" } }));
      return;
    }

    const priority = modelPriority[model] || "normal";
    const estTokens = Math.min(Math.ceil(JSON.stringify(body.messages).length / 4), 5000);
    const reqId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const cacheCtx = buildCacheContext({ body: { ...body, messages: body.messages }, model, source, req, applyCacheControl: true });
    recordCacheCandidate(cacheCtx.candidateCount);
    recordCacheApplied(cacheCtx.appliedCount);
    const cacheSeen = recordCacheKey(cacheCtx.cacheKeyHash);
    sessionStatsStore?.record(getSessionIdForStats(req), cacheSeen.seen).catch?.(() => {});

    console.log(
      `[${ts()}] ANTHROPIC_NATIVE reqId=${reqId} src=${source} model=${model} stream=${stream} ` +
      `cache_applied=${cacheCtx.appliedCount} reason=${cacheCtx.reason}`
    );

    let release;
    try {
      release = await queue.acquire(source, priority);
    } catch (err) {
      res.writeHead(529, { "content-type": "application/json", "retry-after": "10" });
      res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: `Queue full: ${err.message}` } }));
      return;
    }

    let rateWaitTotal = 0;
    while (true) {
      const rateCheck = rateLimiter.check(model, estTokens);
      if (rateCheck.ok) break;
      if (rateWaitTotal >= 300000) {
        release();
        res.writeHead(529, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Rate limit wait exceeded" } }));
        return;
      }
      const sleepMs = Math.min(rateCheck.waitMs, 5000);
      await new Promise(r => setTimeout(r, sleepMs));
      rateWaitTotal += sleepMs;
    }

    rateLimiter.record(model, estTokens);

    // Token selection
    const requestedTokenRaw = req.headers["x-token-name"];
    let tokenEntry = null;
    if (allowExplicitTokenOverride && requestedTokenRaw) {
      tokenEntry = tokenPool.find(t => t.name === String(requestedTokenRaw).trim()) || null;
    }
    if (!tokenEntry) tokenEntry = getNextToken();
    await waitForTokenCooldown(tokenEntry);
    recordWorkerRequest(tokenEntry.name);

    eventLog.push("request", { reqId, mode: stream ? "anthropic_native_stream" : "anthropic_native_sync", model, source, worker: tokenEntry.name });
    sseBroadcast("request", { reqId, mode: "anthropic_native", model, source, worker: tokenEntry.name });

    if (stream) {
      deps.streamAnthropicNative(body, reqId, source, res, release, tokenEntry, cacheCtx);
    } else {
      try {
        const result = await deps.callAnthropicNative(body, reqId, source, tokenEntry, cacheCtx);
        release();
        const statusCode = result._statusCode || 200;
        const responseBody = { ...result };
        delete responseBody._statusCode;
        delete responseBody._raw;
        if (result._raw) {
          res.writeHead(statusCode, { "content-type": "application/json" });
          res.end(result._raw);
        } else {
          res.writeHead(statusCode, { "content-type": "application/json" });
          res.end(JSON.stringify(responseBody));
        }
      } catch (err) {
        if ((err.statusCode === 401 || err.statusCode === 403) && err.refreshed) {
          try {
            const retryResult = await deps.callAnthropicNative(body, reqId + "-retry", source, tokenEntry, cacheCtx);
            release();
            const responseBody = { ...retryResult };
            delete responseBody._statusCode;
            delete responseBody._raw;
            res.writeHead(retryResult._statusCode || 200, { "content-type": "application/json" });
            res.end(JSON.stringify(responseBody));
            return;
          } catch { /* fall through */ }
        }
        release();
        const statusCode = err.statusCode || 500;
        if (err.anthropicBody) {
          res.writeHead(statusCode, { "content-type": "application/json" });
          res.end(err.anthropicBody);
        } else {
          res.writeHead(statusCode, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } }));
        }
      }
    }
  }

  return Object.freeze({
    handleApiDirect,
    handleCompletions,
    handleAnthropicMessages,
  });
}
