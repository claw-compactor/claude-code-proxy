/**
 * Fallback API client — last-resort model when all CLI workers fail.
 * Forwards requests to an OpenAI-compatible HTTP endpoint.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * Create a fallback client bound to a specific API config.
 *
 * @param {object} opts
 * @param {object} opts.fallbackApi - { baseUrl, apiKey, model, name }
 * @param {number} opts.timeoutMs - Request timeout in ms (default 15000)
 * @param {function} opts.sseChunk - SSE chunk formatter
 * @param {function} opts.log - Logger function
 * @param {function} opts.recordWorkerError - Error recorder
 * @param {function} opts.tokenTracker - Token tracker instance
 * @param {function} opts.eventLog - Event log instance
 * @param {function} opts.sseBroadcast - SSE broadcast function
 */
export function createFallbackClient({
  fallbackApi,
  timeoutMs = 15_000,
  sseChunk,
  log = console.log,
  recordWorkerError = () => {},
  tokenTracker = null,
  eventLog = null,
  sseBroadcast = () => {},
}) {
  const fb = fallbackApi;

  function streamFromFallbackApi(messages, model, reqId, source, res) {
    const url = new URL(`${fb.baseUrl}/chat/completions`);
    const isHttps = url.protocol === "https:";
    const doRequest = isHttps ? httpsRequest : httpRequest;

    const body = JSON.stringify({
      model: fb.model,
      messages,
      stream: true,
    });

    log(`FALLBACK reqId=${reqId} api=${fb.name} model=${fb.model} src=${source}`);
    eventLog?.push("fallback", { reqId, model, source, fallbackApi: fb.name, fallbackModel: fb.model });

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
            log(`FALLBACK_ERROR reqId=${reqId} status=${apiRes.statusCode} body=${errBody.slice(0, 200)}`);
            recordWorkerError("fallback", errBody.includes("Context size") ? "context_overflow" : "api_error", `HTTP ${apiRes.statusCode} ${errBody.slice(0, 100)}`);
            safeWrite(sseChunk(reqId, `[Fallback ${fb.name} error: HTTP ${apiRes.statusCode}]`));
            safeWrite(sseChunk(reqId, null, "stop"));
            safeWrite("data: [DONE]\n\n");
            safeEnd();
          });
          return;
        }

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
          tokenTracker?.record(reqId, fb.model, 0, Math.ceil(outputChars / 4));
          eventLog?.push("complete", { reqId, mode: "fallback", model: fb.model, source, exitCode: 0, outputChars });
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
      log(`FALLBACK_TIMEOUT reqId=${reqId} waited=${timeoutMs}ms`);
      recordWorkerError("fallback", "timeout", `timeout ${timeoutMs}ms`);
      safeWrite(sseChunk(reqId, `[Fallback ${fb.name} timeout after ${timeoutMs}ms]`));
      safeWrite(sseChunk(reqId, null, "stop"));
      safeWrite("data: [DONE]\n\n");
      safeEnd();
      try { apiReq.destroy(new Error("fallback timeout")); } catch { /* ignore */ }
    }, timeoutMs);

    apiReq.on("error", (err) => {
      clearTimeout(fallbackTimer);
      log(`FALLBACK_NET_ERROR reqId=${reqId} err=${err.message}`);
      safeWrite(sseChunk(reqId, `[Fallback ${fb.name} unreachable: ${err.message}]`));
      safeWrite(sseChunk(reqId, null, "stop"));
      safeWrite("data: [DONE]\n\n");
      safeEnd();
    });

    apiReq.write(body);
    apiReq.end();
  }

  function fetchFallbackSync(messages, model, reqId, source) {
    const url = new URL(`${fb.baseUrl}/chat/completions`);
    const isHttps = url.protocol === "https:";
    const doRequest = isHttps ? httpsRequest : httpRequest;

    const body = JSON.stringify({
      model: fb.model,
      messages,
      stream: false,
    });

    log(`FALLBACK_SYNC reqId=${reqId} api=${fb.name} model=${fb.model} src=${source}`);
    eventLog?.push("fallback", { reqId, mode: "sync", model, source, fallbackApi: fb.name, fallbackModel: fb.model });

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
              log(`FALLBACK_SYNC_ERROR reqId=${reqId} status=${apiRes.statusCode} body=${buf.slice(0, 200)}`);
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

      const fallbackTimer = setTimeout(() => {
        log(`FALLBACK_SYNC_TIMEOUT reqId=${reqId} waited=${timeoutMs}ms`);
        try { apiReq.destroy(new Error("fallback sync timeout")); } catch { /* ignore */ }
        reject(new Error(`Fallback sync timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      apiReq.on("error", (err) => {
        clearTimeout(fallbackTimer);
        log(`FALLBACK_SYNC_NET_ERROR reqId=${reqId} err=${err.message}`);
        reject(err);
      });

      apiReq.write(body);
      apiReq.end();
    });
  }

  return Object.freeze({
    streamFromFallbackApi,
    fetchFallbackSync,
  });
}
