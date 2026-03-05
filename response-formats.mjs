/**
 * response-formats.mjs — OpenAI-compatible response formatting
 *
 * Pure functions for constructing:
 *   - SSE chunks (text, tool calls, finish)
 *   - Completion responses (with/without tools)
 *   - Anthropic ↔ OpenAI format conversions
 *
 * No side effects, no shared state.
 */

// ── SSE Chunks ──

export function sseChunk(id, content, finishReason = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "claude-code",
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  })}\n\n`;
}

export function sseToolCallStartChunk(id, index, callId, name) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "claude-code",
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index, id: callId, type: "function", function: { name, arguments: "" } }],
      },
      finish_reason: null,
    }],
  })}\n\n`;
}

export function sseToolCallDeltaChunk(id, index, argsDelta) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "claude-code",
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index, function: { arguments: argsDelta } }],
      },
      finish_reason: null,
    }],
  })}\n\n`;
}

export function sseFinishChunk(id, finishReason) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "claude-code",
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  })}\n\n`;
}

// ── Completion Responses ──

const DEFAULT_USAGE = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
});

function normalizeUsage(usage) {
  const merged = { ...DEFAULT_USAGE, ...(usage || {}) };
  if (!merged.prompt_tokens) {
    merged.prompt_tokens =
      (merged.input_tokens || 0) +
      (merged.cache_creation_input_tokens || 0) +
      (merged.cache_read_input_tokens || 0);
  }
  if (!merged.completion_tokens) merged.completion_tokens = merged.output_tokens || 0;
  if (!merged.total_tokens) merged.total_tokens = merged.prompt_tokens + merged.completion_tokens;
  return merged;
}

export function completionResponse(id, content, model, usage) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: normalizeUsage(usage),
  };
}

export function completionResponseWithTools(id, content, toolCalls, model, usage) {
  const message = { role: "assistant", content: content || null };
  if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls.map(tc => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls && toolCalls.length > 0 ? "tool_calls" : "stop",
    }],
    usage: normalizeUsage(usage),
  };
}

// ── Anthropic ↔ OpenAI Format Conversion ──

export function convertToolsToAnthropic(openaiTools) {
  if (!openaiTools || !Array.isArray(openaiTools)) return [];
  return openaiTools
    .filter(t => t.type === "function" && t.function)
    .map(t => ({
      name: t.function.name,
      description: t.function.description || "",
      input_schema: t.function.parameters || { type: "object", properties: {} },
    }));
}

export function convertMessagesToAnthropic(openaiMessages) {
  let system;
  const rawMsgs = [];

  for (const msg of openaiMessages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      system = system ? `${system}\n\n${text}` : text;
      continue;
    }

    if (msg.role === "user") {
      const content = typeof msg.content === "string"
        ? [{ type: "text", text: msg.content }]
        : Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content) }];
      rawMsgs.push({ role: "user", content });
      continue;
    }

    if (msg.role === "assistant") {
      const content = [];
      if (msg.content) {
        if (typeof msg.content === "string") {
          if (msg.content) content.push({ type: "text", text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
              content.push({ type: "text", text: block.text });
            }
          }
        } else {
          const text = JSON.stringify(msg.content);
          if (text) content.push({ type: "text", text });
        }
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let input = {};
          try {
            input = typeof tc.function?.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : (tc.function?.arguments || {});
          } catch { /* use empty object */ }
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function?.name || "unknown",
            input,
          });
        }
      }
      if (content.length > 0) rawMsgs.push({ role: "assistant", content });
      continue;
    }

    if (msg.role === "tool") {
      rawMsgs.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        }],
      });
      continue;
    }
  }

  // Merge consecutive same-role messages (Anthropic requires alternating roles)
  const messages = [];
  for (const msg of rawMsgs) {
    const prev = messages[messages.length - 1];
    if (prev && prev.role === msg.role) {
      const prevContent = Array.isArray(prev.content)
        ? prev.content : [{ type: "text", text: String(prev.content) }];
      const newContent = Array.isArray(msg.content)
        ? msg.content : [{ type: "text", text: String(msg.content) }];
      prev.content = [...prevContent, ...newContent];
    } else {
      messages.push({
        ...msg,
        content: Array.isArray(msg.content) ? [...msg.content] : msg.content,
      });
    }
  }

  return { system, messages };
}
