/**
 * Format conversion & caching helpers.
 * Pure functions extracted from server.mjs — no side effects, no module state.
 */

import { createHash } from "node:crypto";

/**
 * Extract prompt and system prompt from OpenAI-format messages array.
 * Truncates from the front (keeps recent messages) to fit maxPromptChars.
 */
export function extractPrompt(messages, maxPromptChars) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { prompt: "", systemPrompt: null };
  }

  const coerceContentToText = (content) => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
          continue;
        }
        if (typeof block.text === "string") {
          parts.push(block.text);
        }
      }
      return parts.join("");
    }
    if (content && typeof content === "object" && typeof content.text === "string") {
      return content.text;
    }
    return JSON.stringify(content);
  };

  let systemPrompt = null;
  const systemMsg = messages.find((m) => m.role === "system" || m.role === "developer");
  if (systemMsg) {
    systemPrompt = coerceContentToText(systemMsg.content);
  }

  const allParts = [];
  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") continue;
    const text = coerceContentToText(msg.content);
    if (msg.role === "user") allParts.push(text);
    else if (msg.role === "assistant") allParts.push(`[Previous assistant]: ${text}`);
  }

  let totalLen = 0;
  const kept = [];
  for (let i = allParts.length - 1; i >= 0; i--) {
    const part = allParts[i];
    if (totalLen + part.length > maxPromptChars && kept.length > 0) {
      kept.unshift("[... earlier conversation history truncated ...]");
      break;
    }
    totalLen += part.length;
    kept.unshift(part);
  }

  return { prompt: kept.join("\n\n"), systemPrompt };
}

// ── Cache-control helpers (Anthropic prompt caching) ──

export function normalizeText(text, opts = {}) {
  const raw = String(text || "");
  if (!opts.normalizeSystemPrefix) return raw;
  let normalized = raw.replace(/\r\n/g, "\n");
  if (opts.debounceWhitespace) {
    normalized = normalized
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
  }
  return normalized.trim();
}

export function normalizeTextForKey(text, opts = {}) {
  const base = normalizeText(text, opts);
  if (!opts.normalizeSystemPrefix) return base;
  if (!opts.debounceWhitespace) return base;
  return base.replace(/\s+/g, " ").trim();
}

export function stableStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function hashString(str) {
  return createHash("sha256").update(str).digest("hex").slice(0, 16);
}

export function buildCacheKey({ tenant, sessionId, model, systemPrefixHash, toolsHash }) {
  return `t:${tenant}|s:${sessionId || "none"}|m:${model}|sp:${systemPrefixHash}|th:${toolsHash}`;
}

export function splitSystemForCache(systemText, opts = {}) {
  const {
    systemPrefixChars = 1200,
    minSystemPrefixChars = 200,
    normalizeSystemPrefix = true,
    debounceWhitespace = true,
  } = opts;
  const normOpts = { normalizeSystemPrefix, debounceWhitespace };
  const normalized = normalizeText(systemText, normOpts);
  const keyNormalized = normalizeTextForKey(systemText, normOpts);
  if (!normalized) return { normalized: "", prefix: "", suffix: "", cacheable: false, keyPrefix: "" };
  const prefixLen = Math.min(systemPrefixChars, normalized.length);
  if (prefixLen < minSystemPrefixChars) {
    return { normalized, prefix: "", suffix: normalized, cacheable: false, keyPrefix: "" };
  }
  const prefix = normalized.slice(0, prefixLen);
  const suffix = normalized.slice(prefixLen);
  const keyPrefix = keyNormalized ? keyNormalized.slice(0, Math.min(prefixLen, keyNormalized.length)) : "";
  return { normalized, prefix, suffix, cacheable: true, keyPrefix };
}

/**
 * Build cache context for a request (used by both CLI and API direct paths).
 */
export function buildCacheContext({ body, model, source, req, applyCacheControl, cacheConfig = {} }) {
  const {
    enabled: cacheControlEnabled = true,
    systemPrefixChars = 1200,
    minSystemPrefixChars = 200,
    normalizeSystemPrefix = true,
    debounceWhitespace = true,
    sessionScope = "x-session-id",
  } = cacheConfig;

  const tenant = req?.headers?.["x-tenant-id"] || req?.headers?.["x-openclaw-tenant"] || source || "unknown";
  const sessionId = sessionScope === "none"
    ? ""
    : (req?.headers?.["x-session-id"] || body?.session_id || "");
  const systemPrompt = (() => {
    const systemMsg = (body?.messages || []).find((m) => m.role === "system" || m.role === "developer");
    if (!systemMsg) return "";
    return typeof systemMsg.content === "string" ? systemMsg.content : JSON.stringify(systemMsg.content);
  })();
  const splitOpts = { systemPrefixChars, minSystemPrefixChars, normalizeSystemPrefix, debounceWhitespace };
  const { normalized, prefix, suffix, cacheable, keyPrefix } = splitSystemForCache(systemPrompt, splitOpts);
  const toolsSchema = body?.tools ? stableStringify(body.tools) : "";
  const toolsHash = toolsSchema ? hashString(toolsSchema) : "none";
  const systemPrefixHash = keyPrefix ? hashString(keyPrefix) : "none";
  const cacheKey = buildCacheKey({ tenant, sessionId, model, systemPrefixHash, toolsHash });
  const cacheKeyHash = hashString(cacheKey);
  const candidateCount = prefix ? 1 : 0;
  const appliedCount = applyCacheControl && cacheControlEnabled && cacheable ? 1 : 0;
  let reason = "ok";
  if (!cacheControlEnabled) reason = "cache_control_disabled";
  else if (!normalized) reason = "no_system";
  else if (!cacheable) reason = "system_prefix_too_short";
  else if (!applyCacheControl) reason = "cache_control_not_applied";
  if (sessionScope === "none") reason = `${reason}|session_scope=none`;
  return {
    tenant,
    sessionId,
    systemNormalized: normalized,
    systemPrefix: prefix,
    systemSuffix: suffix,
    cacheableSystem: cacheable,
    cacheKey,
    cacheKeyHash,
    candidateCount,
    appliedCount,
    toolsHash,
    reason,
  };
}

export function buildAnthropicSystemBlocks(systemText, cacheCtx, cacheConfig = {}) {
  if (!systemText) return null;
  const {
    enabled: cacheControlEnabled = true,
    systemPrefixChars = 1200,
    minSystemPrefixChars = 200,
    normalizeSystemPrefix = true,
    debounceWhitespace = true,
  } = cacheConfig;
  const splitOpts = { systemPrefixChars, minSystemPrefixChars, normalizeSystemPrefix, debounceWhitespace };
  const { normalized, prefix, suffix, cacheable } = splitSystemForCache(systemText, splitOpts);
  if (cacheControlEnabled && cacheable && cacheCtx?.appliedCount > 0 && prefix) {
    const blocks = [{ type: "text", text: prefix, cache_control: { type: "ephemeral" } }];
    if (suffix) blocks.push({ type: "text", text: suffix });
    return blocks;
  }
  return [{ type: "text", text: normalized }];
}

/**
 * Inject cache_control breakpoints on tools and conversation messages.
 * Up to 4 breakpoints total (Anthropic limit): system (handled elsewhere) + tools + messages.
 *
 * Strategy:
 * - Last tool definition: caches all tools (rarely change within a session)
 * - Second-to-last user message: caches conversation history prefix
 *
 * Skips injection if cache_control already present on the target.
 *
 * @param {object} requestBody - Mutable Anthropic request body
 * @param {object} opts - { injectTools: true, injectMessages: true }
 */
export function injectCacheBreakpoints(requestBody, opts = {}) {
  const { injectTools = true, injectMessages = true } = opts;
  let injected = 0;

  // 1. Inject on last tool definition
  if (injectTools && Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
    const lastTool = requestBody.tools[requestBody.tools.length - 1];
    if (!lastTool.cache_control) {
      requestBody.tools = [
        ...requestBody.tools.slice(0, -1),
        { ...lastTool, cache_control: { type: "ephemeral" } },
      ];
      injected++;
    }
  }

  // 2. Inject on second-to-last message's last content block (conversation history cache)
  if (injectMessages && Array.isArray(requestBody.messages) && requestBody.messages.length >= 2) {
    // Find the second-to-last user or assistant message
    const targetIdx = requestBody.messages.length - 2;
    const targetMsg = requestBody.messages[targetIdx];
    if (targetMsg && Array.isArray(targetMsg.content) && targetMsg.content.length > 0) {
      const lastBlock = targetMsg.content[targetMsg.content.length - 1];
      if (!lastBlock.cache_control) {
        const newContent = [
          ...targetMsg.content.slice(0, -1),
          { ...lastBlock, cache_control: { type: "ephemeral" } },
        ];
        requestBody.messages = [
          ...requestBody.messages.slice(0, targetIdx),
          { ...targetMsg, content: newContent },
          ...requestBody.messages.slice(targetIdx + 1),
        ];
        injected++;
      }
    } else if (targetMsg && typeof targetMsg.content === "string" && targetMsg.content.length > 0) {
      // Convert string content to array with cache_control
      requestBody.messages = [
        ...requestBody.messages.slice(0, targetIdx),
        {
          ...targetMsg,
          content: [{ type: "text", text: targetMsg.content, cache_control: { type: "ephemeral" } }],
        },
        ...requestBody.messages.slice(targetIdx + 1),
      ];
      injected++;
    }
  }

  return injected;
}

export function buildUsage({ inputTokens = 0, outputTokens = 0, cacheCreation = 0, cacheRead = 0 } = {}) {
  const totalInput = inputTokens + cacheCreation + cacheRead;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
    prompt_tokens: totalInput,
    completion_tokens: outputTokens,
    total_tokens: totalInput + outputTokens,
  };
}

// --- Anthropic context guard (approximate token count) ---

export function contentCharLen(block) {
  if (!block) return 0;
  if (block.type === "text") return (block.text || "").length;
  if (block.type === "tool_result") return String(block.content || "").length;
  if (block.type === "tool_use") return (block.name || "").length + JSON.stringify(block.input || {}).length;
  try { return JSON.stringify(block).length; } catch { return 0; }
}

export function estimateAnthropicChars(system, messages) {
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

export function trimAnthropicMessages(system, messages, maxTokens, charsPerToken = 3) {
  const maxChars = Math.floor(maxTokens * charsPerToken);
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
