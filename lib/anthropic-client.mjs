/**
 * Anthropic Direct API client — streaming and synchronous calls.
 * Extracted from server.mjs. Uses dependency injection for all external state.
 */

import { request as httpsRequest } from "node:https";
import { trimAnthropicMessages, buildAnthropicSystemBlocks, injectCacheBreakpoints } from "./format-converter.mjs";

/**
 * Create an Anthropic API client.
 *
 * @param {object} deps
 * @param {string} deps.apiBase - Anthropic API base URL
 * @param {string} deps.apiVersion - Anthropic API version header
 * @param {object} deps.modelIds - { sonnet, opus, haiku } -> full model ID
 * @param {number} deps.maxPromptTokens - Max prompt tokens for context guard
 * @param {number} deps.syncTimeoutMs - Timeout for sync requests
 * @param {object} deps.cacheConfig - Cache config for system blocks
 * @param {number} deps.defaultMaxTokens - Default max_tokens for requests
 * @param {number} deps.rateLimitRetryMs - Default retry delay for 429 errors
 * @param {number} deps.serverErrorRetryMs - Default retry delay for 500/529 errors
 * @param {object} deps.tokenRefresher - Token refresher instance
 * @param {function} deps.captureUnifiedRateHeaders - Rate header capture
 * @param {function} deps.setTokenCooldown - Set 429 cooldown
 * @param {function} deps.recordWorkerError - Error recorder
 * @param {function} deps.recordCacheTtft - Cache TTFT recorder
 * @param {function} deps.getCacheStats - Get cache stats
 * @param {function} deps.sseChunk - SSE chunk formatter
 * @param {function} deps.sseToolCallStartChunk - SSE tool call start formatter
 * @param {function} deps.sseToolCallDeltaChunk - SSE tool call delta formatter
 * @param {function} deps.sseFinishChunk - SSE finish chunk formatter
 * @param {function} deps.convertToolsToAnthropic - Tool format converter
 * @param {function} deps.convertMessagesToAnthropic - Message format converter
 * @param {object} deps.tokenTracker - Token tracker instance
 * @param {object} deps.eventLog - Event log instance
 * @param {function} deps.sseBroadcast - SSE broadcast function
 * @param {function} deps.log - Logger
 */
export function createAnthropicClient(deps) {
  const {
    apiBase,
    apiVersion,
    modelIds,
    maxPromptTokens,
    defaultMaxTokens = 16384,
    rateLimitRetryMs = 30000,
    serverErrorRetryMs = 2000,
    syncTimeoutMs,
    cacheConfig,
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
    healthManager,
    log,
  } = deps;

  const ts = () => new Date().toISOString();

  function streamFromAnthropicDirect(body, model, reqId, source, res, release, tokenEntry, cacheCtx) {
    const anthropicModel = modelIds[model] || modelIds.sonnet;
    const anthropicTools = body.tools ? convertToolsToAnthropic(body.tools) : [];
    const { system, messages } = convertMessagesToAnthropic(body.messages);
    const trimmed = trimAnthropicMessages(system, messages, maxPromptTokens);
    if (trimmed.truncated) {
      log(`[${ts()}] CONTEXT_TRUNCATED reqId=${reqId} beforeChars=${trimmed.beforeChars} afterChars=${trimmed.afterChars}`);
    }

    const requestBody = {
      model: anthropicModel,
      max_tokens: body.max_tokens || defaultMaxTokens,
      stream: true,
      messages: trimmed.messages,
    };
    if (trimmed.system) {
      const systemBlocks = buildAnthropicSystemBlocks(trimmed.system, cacheCtx, cacheConfig);
      if (systemBlocks) requestBody.system = systemBlocks;
    }
    if (anthropicTools.length > 0) requestBody.tools = anthropicTools;
    if (body.tool_choice) {
      if (body.tool_choice === "auto") requestBody.tool_choice = { type: "auto" };
      else if (body.tool_choice === "none") requestBody.tool_choice = { type: "none" };
      else if (body.tool_choice === "required") requestBody.tool_choice = { type: "any" };
      else if (body.tool_choice?.type === "function") {
        requestBody.tool_choice = { type: "tool", name: body.tool_choice.function.name };
      }
    }
    // Inject cache breakpoints on tools and conversation history
    if (cacheConfig?.enabled !== false) {
      injectCacheBreakpoints(requestBody);
    }

    const bodyStr = JSON.stringify(requestBody);
    if (cacheCtx) {
      log(
        `[${ts()}] CACHE_APPLY reqId=${reqId} model=${model} applied=${cacheCtx.appliedCount} ` +
        `prefixChars=${cacheCtx.systemPrefix?.length || 0} toolsHash=${cacheCtx.toolsHash} ` +
        `cache_key_hash=${cacheCtx.cacheKeyHash} reason=${cacheCtx.reason}`
      );
    }
    const authHeaderName = tokenEntry.type === "oauth_flat" ? "authorization" : "x-api-key";
    const liveToken = tokenRefresher.getActiveToken(tokenEntry.name) || tokenEntry.token;
    const authHeaderValue = tokenEntry.type === "oauth_flat" ? `Bearer ${liveToken}` : liveToken;
    log(
      `[${ts()}] ANTHROPIC_STREAM reqId=${reqId} model=${anthropicModel} ` +
      `tools=${anthropicTools.length} msgs=${messages.length} auth=${tokenEntry.type} token=${tokenEntry.name} src=${source}`
    );
    eventLog.push("anthropic_direct", {
      reqId, model: anthropicModel, tools: anthropicTools.length, source, auth: tokenEntry.type, token: tokenEntry.name,
    });

    const requestStart = Date.now();
    let firstTokenAt = null;
    const cacheApplied = cacheCtx?.appliedCount > 0;
    let retried = false; // track 401 retry to prevent infinite loop

    const safeWrite = (data) => { if (!res.writableEnded) res.write(data); };
    const safeEnd = () => { if (!res.writableEnded) res.end(); };
    let released = false;
    const doRelease = () => { if (!released) { released = true; release(); } };

    const url = new URL(`${apiBase}/v1/messages`);
    const headers = {
      "content-type": "application/json",
      "anthropic-version": apiVersion,
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
            let retryMs = rateLimitRetryMs;
            if (retryHeader) {
              const sec = Number(retryHeader);
              if (!Number.isNaN(sec)) retryMs = Math.max(retryMs, sec * 1000);
            }
            setTokenCooldown(tokenEntry, retryMs, "anthropic_429");
          }

          if (apiRes.statusCode === 401 || apiRes.statusCode === 403) {
            const label = apiRes.statusCode === 403 ? "auth revoked" : "auth expired";
            recordWorkerError(tokenEntry.name, "auth_expired", `${apiRes.statusCode}: ${errBody.slice(0, 100)}`);
            markTokenAuthError?.(tokenEntry.name);
            healthManager?.reportError(tokenEntry.name, apiRes.statusCode, "auth_error");
            // 401/403 with no content sent → refresh token and retry once
            tokenRefresher.handleAuthError(tokenEntry).then(result => {
              if (result.refreshed && !retried) {
                retried = true;
                log(`[${ts()}] STREAM_${apiRes.statusCode}_RETRY reqId=${reqId} token=${tokenEntry.name} — retrying with refreshed token`);
                streamFromAnthropicDirect(body, model, reqId + "-retry", source, res, release, tokenEntry, cacheCtx);
                return;
              }
              log(`[${ts()}] ANTHROPIC_${apiRes.statusCode} reqId=${reqId} token=${tokenEntry.name} refreshed=${result.refreshed} retried=${retried}`);
              eventLog.push("error", { reqId, mode: "anthropic_direct", model, source, status: apiRes.statusCode });
              safeWrite(sseChunk(reqId, `[Anthropic API error: HTTP ${apiRes.statusCode} — ${label}]`));
              safeWrite(sseFinishChunk(reqId, "stop"));
              safeWrite("data: [DONE]\n\n");
              safeEnd();
              doRelease();
            }).catch(err => {
              console.error(`[${ts()}] TOKEN_REFRESH_FAIL token=${tokenEntry.name} err=${err.message}`);
              safeWrite(sseChunk(reqId, `[Anthropic API error: HTTP ${apiRes.statusCode}]`));
              safeWrite(sseFinishChunk(reqId, "stop"));
              safeWrite("data: [DONE]\n\n");
              safeEnd();
              doRelease();
            });
            return; // handled async
          }

          // 500/529 server errors — report to health manager + backoff retry once (stream)
          if ((apiRes.statusCode === 500 || apiRes.statusCode === 529) && !retried) {
            healthManager?.reportError(tokenEntry.name, apiRes.statusCode, "server_error");
            retried = true;
            log(`[${ts()}] STREAM_${apiRes.statusCode}_RETRY reqId=${reqId} token=${tokenEntry.name} — backoff ${serverErrorRetryMs}ms then retry`);
            eventLog.push("retry", { reqId, model, source, reason: "server_error", status: apiRes.statusCode, delay: serverErrorRetryMs });
            setTimeout(() => {
              streamFromAnthropicDirect(body, model, reqId + "-retry", source, res, release, tokenEntry, cacheCtx);
            }, serverErrorRetryMs);
            return;
          }

          // Report other errors to health manager
          if (apiRes.statusCode >= 500) {
            healthManager?.reportError(tokenEntry.name, apiRes.statusCode, "server_error");
          }

          log(`[${ts()}] ANTHROPIC_ERROR reqId=${reqId} status=${apiRes.statusCode} body=${errBody.slice(0, 500)}`);
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
          const trimmedLine = line.trim();
          if (!trimmedLine || !trimmedLine.startsWith("data: ")) continue;
          let ev;
          try { ev = JSON.parse(trimmedLine.slice(6)); } catch { continue; }

          if (ev.type === "message_start") {
            inputTokens = ev.message?.usage?.input_tokens || 0;
          } else if (ev.type === "content_block_start") {
            const block = ev.content_block;
            if (block?.type === "tool_use") {
              toolCallIndex++;
              toolCalls.push({ index: toolCallIndex, id: block.id, name: block.name, arguments: "" });
              safeWrite(sseToolCallStartChunk(reqId, toolCallIndex, block.id, block.name));
            }
          } else if (ev.type === "content_block_delta") {
            if (ev.delta?.type === "text_delta" && ev.delta.text) {
              if (!firstTokenAt) {
                firstTokenAt = Date.now();
                const ttftMs = firstTokenAt - requestStart;
                try {
                  recordCacheTtft(ttftMs, cacheApplied);
                  const cacheStats = getCacheStats();
                  log(
                    `[${ts()}] CACHE_TTFT reqId=${reqId} model=${model} cached=${cacheApplied} ` +
                    `ttftMs=${ttftMs} cachedAvg=${cacheStats.ttftCachedAvg ?? "n/a"} uncachedAvg=${cacheStats.ttftUncachedAvg ?? "n/a"}`
                  );
                } catch (ttftErr) {
                  log(`[${ts()}] CACHE_TTFT reqId=${reqId} ttftMs=${ttftMs} (stats unavailable: ${ttftErr.message})`);
                }
              }
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
        }
      });

      apiRes.on("end", () => {
        healthManager?.reportSuccess(tokenEntry.name);
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
        log(`[${ts()}] ANTHROPIC_STREAM_ERR reqId=${reqId} err=${err.message}`);
        safeWrite(sseChunk(reqId, `[Anthropic stream error: ${err.message}]`));
        safeWrite("data: [DONE]\n\n");
        safeEnd();
        doRelease();
      });
    });

    res.on("close", () => {
      if (!apiReq.destroyed) {
        log(`[${ts()}] CLIENT_DISCONNECT reqId=${reqId} — aborting Anthropic API request`);
        apiReq.destroy();
      }
      doRelease();
    });

    apiReq.on("error", (err) => {
      log(`[${ts()}] ANTHROPIC_NET_ERR reqId=${reqId} err=${err.message}`);
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

  function callAnthropicDirect(body, model, reqId, source, tokenEntry, cacheCtx) {
    return new Promise((resolve, reject) => {
      const anthropicModel = modelIds[model] || modelIds.sonnet;
      const anthropicTools = body.tools ? convertToolsToAnthropic(body.tools) : [];
      const { system, messages } = convertMessagesToAnthropic(body.messages);
      const trimmed = trimAnthropicMessages(system, messages, maxPromptTokens);
      if (trimmed.truncated) {
        log(`[${ts()}] CONTEXT_TRUNCATED reqId=${reqId} beforeChars=${trimmed.beforeChars} afterChars=${trimmed.afterChars}`);
      }

      const requestBody = {
        model: anthropicModel,
        max_tokens: body.max_tokens || defaultMaxTokens,
        messages: trimmed.messages,
      };
      if (trimmed.system) {
        const systemBlocks = buildAnthropicSystemBlocks(trimmed.system, cacheCtx, cacheConfig);
        if (systemBlocks) requestBody.system = systemBlocks;
      }
      if (anthropicTools.length > 0) requestBody.tools = anthropicTools;
      // Inject cache breakpoints on tools and conversation history
      if (cacheConfig?.enabled !== false) {
        injectCacheBreakpoints(requestBody);
      }

      const bodyStr = JSON.stringify(requestBody);
      const authHeaderName = tokenEntry.type === "oauth_flat" ? "authorization" : "x-api-key";
      const liveTokenSync = tokenRefresher.getActiveToken(tokenEntry.name) || tokenEntry.token;
      const authHeaderValue = tokenEntry.type === "oauth_flat" ? `Bearer ${liveTokenSync}` : liveTokenSync;
      log(
        `[${ts()}] ANTHROPIC_SYNC reqId=${reqId} model=${anthropicModel} ` +
        `tools=${anthropicTools.length} auth=${tokenEntry.type} token=${tokenEntry.name} src=${source}`
      );

      const url = new URL(`${apiBase}/v1/messages`);
      const hdrs = {
        "content-type": "application/json",
        "anthropic-version": apiVersion,
        ...(tokenEntry.type === "oauth_flat" ? { "anthropic-beta": "oauth-2025-04-20" } : {}),
        "content-length": String(Buffer.byteLength(bodyStr)),
      };
      hdrs[authHeaderName] = authHeaderValue;

      const timer = setTimeout(() => {
        apiReq.destroy();
        reject(new Error(`Anthropic API timeout after ${syncTimeoutMs}ms`));
      }, syncTimeoutMs);

      const apiReq = httpsRequest(url, { method: "POST", headers: hdrs }, (apiRes) => {
        captureUnifiedRateHeaders(apiRes, tokenEntry);
        let resBody = "";
        apiRes.on("data", (d) => { resBody += d.toString(); });
        apiRes.on("end", () => {
          clearTimeout(timer);

          if (apiRes.statusCode === 429) {
            const retryHeader = apiRes.headers["retry-after"];
            let retryMs = rateLimitRetryMs;
            if (retryHeader) {
              const sec = Number(retryHeader);
              if (!Number.isNaN(sec)) retryMs = Math.max(retryMs, sec * 1000);
            }
            setTokenCooldown(tokenEntry, retryMs, "anthropic_429");
            const err = new Error(`Anthropic 429: ${resBody.slice(0, 200)}`);
            err.statusCode = 429;
            return reject(err);
          }

          if (apiRes.statusCode === 401 || apiRes.statusCode === 403) {
            recordWorkerError(tokenEntry.name, "auth_expired", `${apiRes.statusCode}: ${resBody.slice(0, 100)}`);
            markTokenAuthError?.(tokenEntry.name);
            tokenRefresher.handleAuthError(tokenEntry).then(result => {
              if (result.refreshed) clearTokenAuthError?.(tokenEntry.name);
              const err = new Error(`Anthropic ${apiRes.statusCode}: ${resBody.slice(0, 200)}`);
              err.statusCode = apiRes.statusCode;
              err.refreshed = result.refreshed;
              reject(err);
            }).catch(refreshErr => {
              const err = new Error(`Anthropic ${apiRes.statusCode}: ${resBody.slice(0, 200)}`);
              err.statusCode = apiRes.statusCode;
              err.refreshed = false;
              reject(err);
            });
            return;
          }

          if (apiRes.statusCode === 500 || apiRes.statusCode === 529) {
            healthManager?.reportError(tokenEntry.name, apiRes.statusCode, "server_error");
            log(`[${ts()}] ANTHROPIC_SYNC_SERVER_ERROR reqId=${reqId} status=${apiRes.statusCode}`);
            const err = new Error(`Anthropic API HTTP ${apiRes.statusCode}`);
            err.statusCode = apiRes.statusCode;
            err.isServerError = true;
            return reject(err);
          }

          if (apiRes.statusCode !== 200) {
            log(`[${ts()}] ANTHROPIC_SYNC_ERROR reqId=${reqId} status=${apiRes.statusCode} body=${resBody.slice(0, 500)}`);
            const err = new Error(`Anthropic API HTTP ${apiRes.statusCode}`);
            err.statusCode = apiRes.statusCode;
            return reject(err);
          }

          healthManager?.reportSuccess(tokenEntry.name);
          try {
            const json = JSON.parse(resBody);
            const content = json.content?.map(b => b.type === "text" ? b.text : "").join("") || "";
            const toolCallsList = (json.content || []).filter(b => b.type === "tool_use").map(b => ({
              id: b.id,
              type: "function",
              function: { name: b.name, arguments: JSON.stringify(b.input) },
            }));
            const usage = {
              prompt_tokens: json.usage?.input_tokens || 0,
              completion_tokens: json.usage?.output_tokens || 0,
              total_tokens: (json.usage?.input_tokens || 0) + (json.usage?.output_tokens || 0),
            };
            resolve({ content, toolCalls: toolCallsList, usage, stopReason: json.stop_reason });
          } catch (parseErr) {
            reject(parseErr);
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
   * Native Anthropic streaming — pipes SSE events directly to client in Anthropic format.
   * Preserves tool_use, thinking, cache_control, metadata, etc.
   */
  function streamAnthropicNative(body, reqId, source, res, release, tokenEntry, cacheCtx) {
    const rawModel = body.model || "claude-sonnet-4-20250514";
    const anthropicModel = modelIds[rawModel] || modelIds[Object.keys(modelIds).find(k => rawModel.includes(k))] || rawModel;

    // Apply system cache_control if not already present
    const systemBlocks = (() => {
      if (!body.system) return undefined;
      if (typeof body.system === "string") {
        return buildAnthropicSystemBlocks(body.system, cacheCtx, cacheConfig);
      }
      // Already array — check if cache_control exists
      const hasCC = Array.isArray(body.system) && body.system.some(b => b.cache_control);
      if (hasCC) return body.system;
      // Flatten to text and apply cache_control
      const text = body.system.map(b => b.text || "").join("\n");
      return buildAnthropicSystemBlocks(text, cacheCtx, cacheConfig);
    })();

    // Context guard: trim messages if too long
    const systemText = (() => {
      if (!body.system) return null;
      if (typeof body.system === "string") return body.system;
      if (Array.isArray(body.system)) return body.system.map(b => b.text || "").join("\n");
      return null;
    })();
    const trimmed = trimAnthropicMessages(systemText, body.messages, maxPromptTokens);
    if (trimmed.truncated) {
      log(`[${ts()}] CONTEXT_TRUNCATED reqId=${reqId} beforeChars=${trimmed.beforeChars} afterChars=${trimmed.afterChars}`);
    }

    const requestBody = {
      ...body,
      model: anthropicModel,
      stream: true,
      messages: trimmed.messages,
    };
    if (systemBlocks) requestBody.system = systemBlocks;
    // Inject cache breakpoints on tools and conversation history
    if (cacheConfig?.enabled !== false) {
      injectCacheBreakpoints(requestBody);
    }

    const bodyStr = JSON.stringify(requestBody);
    const authHeaderName = tokenEntry.type === "oauth_flat" ? "authorization" : "x-api-key";
    const liveToken = tokenRefresher.getActiveToken(tokenEntry.name) || tokenEntry.token;
    const authHeaderValue = tokenEntry.type === "oauth_flat" ? `Bearer ${liveToken}` : liveToken;

    log(`[${ts()}] ANTHROPIC_NATIVE_STREAM reqId=${reqId} model=${anthropicModel} token=${tokenEntry.name} src=${source}`);

    const requestStart = Date.now();
    let firstTokenAt = null;
    const cacheApplied = cacheCtx?.appliedCount > 0;
    let retried = false;

    const safeWrite = (data) => { if (!res.writableEnded) res.write(data); };
    const safeEnd = () => { if (!res.writableEnded) res.end(); };
    let released = false;
    const doRelease = () => { if (!released) { released = true; release(); } };

    const url = new URL(`${apiBase}/v1/messages`);
    const headers = {
      "content-type": "application/json",
      "anthropic-version": apiVersion,
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
            let retryMs = rateLimitRetryMs;
            if (retryHeader) {
              const sec = Number(retryHeader);
              if (!Number.isNaN(sec)) retryMs = Math.max(retryMs, sec * 1000);
            }
            setTokenCooldown(tokenEntry, retryMs, "anthropic_429");
          }
          if ((apiRes.statusCode === 401 || apiRes.statusCode === 403) && !retried) {
            recordWorkerError(tokenEntry.name, "auth_expired", `${apiRes.statusCode}: ${errBody.slice(0, 100)}`);
            markTokenAuthError?.(tokenEntry.name);
            healthManager?.reportError(tokenEntry.name, apiRes.statusCode, "auth_error");
            tokenRefresher.handleAuthError(tokenEntry).then(result => {
              if (result.refreshed) {
                clearTokenAuthError?.(tokenEntry.name);
                retried = true;
                streamAnthropicNative(body, reqId + "-retry", source, res, release, tokenEntry, cacheCtx);
                return;
              }
              // Forward error in Anthropic format
              res.writeHead(apiRes.statusCode, { "content-type": "application/json" });
              safeWrite(errBody || JSON.stringify({ type: "error", error: { type: "permission_error", message: "Token revoked or expired" } }));
              safeEnd();
              doRelease();
            }).catch(() => {
              res.writeHead(apiRes.statusCode, { "content-type": "application/json" });
              safeWrite(errBody);
              safeEnd();
              doRelease();
            });
            return;
          }
          // 500/529 server errors — backoff retry once (native stream)
          if ((apiRes.statusCode === 500 || apiRes.statusCode === 529) && !retried) {
            healthManager?.reportError(tokenEntry.name, apiRes.statusCode, "server_error");
            retried = true;
            log(`[${ts()}] NATIVE_STREAM_${apiRes.statusCode}_RETRY reqId=${reqId} token=${tokenEntry.name} — backoff ${serverErrorRetryMs}ms then retry`);
            eventLog.push("retry", { reqId, model: rawModel, source, reason: "server_error", status: apiRes.statusCode, delay: serverErrorRetryMs });
            setTimeout(() => {
              streamAnthropicNative(body, reqId + "-retry", source, res, release, tokenEntry, cacheCtx);
            }, serverErrorRetryMs);
            return;
          }
          // Report other server errors to health manager
          if (apiRes.statusCode >= 500) {
            healthManager?.reportError(tokenEntry.name, apiRes.statusCode, "server_error");
          }
          // Forward Anthropic error as-is
          res.writeHead(apiRes.statusCode, { "content-type": "application/json" });
          safeWrite(errBody);
          safeEnd();
          doRelease();
        });
        return;
      }

      // Success — pipe SSE events directly, parsing only for token tracking
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      });

      let inputTokens = 0;
      let outputTokens = 0;
      let buf = "";

      apiRes.on("data", (chunk) => {
        const raw = chunk.toString();
        // Forward raw SSE data directly to client
        safeWrite(raw);

        // Parse for tracking
        buf += raw;
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine || !trimmedLine.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(trimmedLine.slice(6));
            if (ev.type === "message_start") {
              inputTokens = ev.message?.usage?.input_tokens || 0;
              if (!firstTokenAt) {
                firstTokenAt = Date.now();
                const ttftMs = firstTokenAt - requestStart;
                try { recordCacheTtft(ttftMs, cacheApplied); } catch { /* ignore */ }
              }
            } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
              if (!firstTokenAt) {
                firstTokenAt = Date.now();
                try { recordCacheTtft(firstTokenAt - requestStart, cacheApplied); } catch { /* ignore */ }
              }
              sseBroadcast("chunk", { reqId, model: rawModel, source, text: ev.delta.text, worker: tokenEntry.name });
            } else if (ev.type === "message_delta") {
              outputTokens = ev.usage?.output_tokens || outputTokens;
            }
          } catch { /* non-JSON line */ }
        }
      });

      apiRes.on("end", () => {
        healthManager?.reportSuccess(tokenEntry.name);
        tokenTracker.record(reqId, rawModel, inputTokens, outputTokens);
        eventLog.push("complete", { reqId, mode: "anthropic_native", model: rawModel, source, inputTokens, outputTokens });
        sseBroadcast("complete", { reqId, model: rawModel, source, inputTokens, outputTokens, worker: tokenEntry.name });
        safeEnd();
        doRelease();
      });

      apiRes.on("error", (err) => {
        log(`[${ts()}] ANTHROPIC_NATIVE_STREAM_ERR reqId=${reqId} err=${err.message}`);
        safeEnd();
        doRelease();
      });
    });

    res.on("close", () => {
      if (!apiReq.destroyed) apiReq.destroy();
      doRelease();
    });

    apiReq.on("error", (err) => {
      log(`[${ts()}] ANTHROPIC_NATIVE_NET_ERR reqId=${reqId} err=${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      safeWrite(JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } }));
      safeEnd();
      doRelease();
    });

    apiReq.write(bodyStr);
    apiReq.end();
  }

  /**
   * Native Anthropic sync call — returns full Anthropic JSON response.
   */
  function callAnthropicNative(body, reqId, source, tokenEntry, cacheCtx) {
    return new Promise((resolve, reject) => {
      const rawModel = body.model || "claude-sonnet-4-20250514";
      const anthropicModel = modelIds[rawModel] || modelIds[Object.keys(modelIds).find(k => rawModel.includes(k))] || rawModel;

      const systemBlocks = (() => {
        if (!body.system) return undefined;
        if (typeof body.system === "string") {
          return buildAnthropicSystemBlocks(body.system, cacheCtx, cacheConfig);
        }
        const hasCC = Array.isArray(body.system) && body.system.some(b => b.cache_control);
        if (hasCC) return body.system;
        const text = body.system.map(b => b.text || "").join("\n");
        return buildAnthropicSystemBlocks(text, cacheCtx, cacheConfig);
      })();

      const systemText = (() => {
        if (!body.system) return null;
        if (typeof body.system === "string") return body.system;
        if (Array.isArray(body.system)) return body.system.map(b => b.text || "").join("\n");
        return null;
      })();
      const trimmed = trimAnthropicMessages(systemText, body.messages, maxPromptTokens);

      const requestBody = { ...body, model: anthropicModel, messages: trimmed.messages };
      delete requestBody.stream;
      if (systemBlocks) requestBody.system = systemBlocks;
      // Inject cache breakpoints on tools and conversation history
      if (cacheConfig?.enabled !== false) {
        injectCacheBreakpoints(requestBody);
      }

      const bodyStr = JSON.stringify(requestBody);
      const authHeaderName = tokenEntry.type === "oauth_flat" ? "authorization" : "x-api-key";
      const liveToken = tokenRefresher.getActiveToken(tokenEntry.name) || tokenEntry.token;
      const authHeaderValue = tokenEntry.type === "oauth_flat" ? `Bearer ${liveToken}` : liveToken;

      log(`[${ts()}] ANTHROPIC_NATIVE_SYNC reqId=${reqId} model=${anthropicModel} token=${tokenEntry.name} src=${source}`);

      const url = new URL(`${apiBase}/v1/messages`);
      const hdrs = {
        "content-type": "application/json",
        "anthropic-version": apiVersion,
        ...(tokenEntry.type === "oauth_flat" ? { "anthropic-beta": "oauth-2025-04-20" } : {}),
        "content-length": String(Buffer.byteLength(bodyStr)),
      };
      hdrs[authHeaderName] = authHeaderValue;

      const timer = setTimeout(() => {
        apiReq.destroy();
        reject(new Error(`Anthropic API timeout after ${syncTimeoutMs}ms`));
      }, syncTimeoutMs);

      const apiReq = httpsRequest(url, { method: "POST", headers: hdrs }, (apiRes) => {
        captureUnifiedRateHeaders(apiRes, tokenEntry);
        let resBody = "";
        apiRes.on("data", (d) => { resBody += d.toString(); });
        apiRes.on("end", () => {
          clearTimeout(timer);

          if (apiRes.statusCode === 429) {
            const retryHeader = apiRes.headers["retry-after"];
            let retryMs = rateLimitRetryMs;
            if (retryHeader) {
              const sec = Number(retryHeader);
              if (!Number.isNaN(sec)) retryMs = Math.max(retryMs, sec * 1000);
            }
            setTokenCooldown(tokenEntry, retryMs, "anthropic_429");
          }

          if (apiRes.statusCode === 401 || apiRes.statusCode === 403) {
            recordWorkerError(tokenEntry.name, "auth_expired", `${apiRes.statusCode}`);
            markTokenAuthError?.(tokenEntry.name);
            healthManager?.reportError(tokenEntry.name, apiRes.statusCode, "auth_error");
            tokenRefresher.handleAuthError(tokenEntry).then(result => {
              if (result.refreshed) clearTokenAuthError?.(tokenEntry.name);
              const err = new Error(`Anthropic ${apiRes.statusCode}`);
              err.statusCode = apiRes.statusCode;
              err.refreshed = result.refreshed;
              err.anthropicBody = resBody;
              reject(err);
            }).catch(() => {
              const err = new Error(`Anthropic ${apiRes.statusCode}`);
              err.statusCode = apiRes.statusCode;
              err.refreshed = false;
              err.anthropicBody = resBody;
              reject(err);
            });
            return;
          }

          // 500/529 server errors
          if (apiRes.statusCode === 500 || apiRes.statusCode === 529) {
            healthManager?.reportError(tokenEntry.name, apiRes.statusCode, "server_error");
            const err = new Error(`Anthropic API HTTP ${apiRes.statusCode}`);
            err.statusCode = apiRes.statusCode;
            err.isServerError = true;
            err.anthropicBody = resBody;
            return reject(err);
          }

          // Return the raw Anthropic response with status code
          try {
            const json = JSON.parse(resBody);
            json._statusCode = apiRes.statusCode;
            const inputTokens = json.usage?.input_tokens || 0;
            const outputTokens = json.usage?.output_tokens || 0;
            if (apiRes.statusCode === 200) {
              healthManager?.reportSuccess(tokenEntry.name);
              tokenTracker.record(reqId, rawModel, inputTokens, outputTokens);
              eventLog.push("complete", { reqId, mode: "anthropic_native_sync", model: rawModel, source, inputTokens, outputTokens });
              sseBroadcast("complete", { reqId, model: rawModel, source, inputTokens, outputTokens, worker: tokenEntry.name });
            }
            resolve(json);
          } catch {
            resolve({ _statusCode: apiRes.statusCode, _raw: resBody });
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

  return Object.freeze({
    streamFromAnthropicDirect,
    callAnthropicDirect,
    streamAnthropicNative,
    callAnthropicNative,
  });
}
